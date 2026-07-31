import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { readCastSlice, stripAnsi } from '../src/core/cast-slice'

// Write a minimal asciinema v2 cast: header + a few 'o' events. Each event's
// first element is seconds-from-cast-start; the wall clock is `header.timestamp`.
function writeCast(dir: string, unixSec: number, events: Array<[number, 'o', string]>): string {
  const p = path.join(dir, `t-${Math.floor(unixSec)}.cast`)
  const header = JSON.stringify({ version: 2, width: 80, height: 24, timestamp: unixSec })
  const body = events.map((e) => JSON.stringify(e)).join('\n')
  fs.writeFileSync(p, header + '\n' + body + '\n', 'utf8')
  return p
}

describe('stripAnsi', () => {
  it('drops CSI sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
    expect(stripAnsi('\x1b[1;32mgreen bold\x1b[0m')).toBe('green bold')
  })

  it('drops OSC (title-set etc) sequences', () => {
    expect(stripAnsi('\x1b]0;title\x07plain')).toBe('plain')
  })

  it('leaves innocent text alone', () => {
    expect(stripAnsi('hello world\n$ ls\n')).toBe('hello world\n$ ls\n')
  })
})

describe('readCastSlice', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cast-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when the cast file is missing', () => {
    expect(readCastSlice(path.join(dir, 'missing.cast'), 0, 1)).toBeNull()
  })

  it('returns null when the header cannot be parsed', () => {
    const p = path.join(dir, 'bad.cast')
    fs.writeFileSync(p, 'not json\n[0.1,"o","hi"]\n', 'utf8')
    expect(readCastSlice(p, 0, 1e13)).toBeNull()
  })

  it('slices only events within the wall-clock window', () => {
    const t0 = 1_700_000_000
    const p = writeCast(dir, t0, [
      [0.0, 'o', 'A'],
      [1.0, 'o', 'B'],
      [2.0, 'o', 'C'],
      [3.0, 'o', 'D']
    ])
    // Window 1.0-2.5s from t0 → B and C (endMs is inclusive; startMs strict)
    const startMs = t0 * 1000 + 1000
    const endMs = t0 * 1000 + 2500
    const slice = readCastSlice(p, startMs, endMs)!
    expect(slice.text).toBe('BC')
    expect(slice.events.map((e) => e[2])).toEqual(['B', 'C'])
    expect(slice.castStartMs).toBe(t0 * 1000)
  })

  it('strips ANSI when producing text', () => {
    const t0 = 1_700_000_000
    const p = writeCast(dir, t0, [
      [0.0, 'o', '\x1b[32mgreen\x1b[0m plain'],
      [0.5, 'o', '\x1b]0;title\x07more']
    ])
    const slice = readCastSlice(p, 0, 1e13)!
    expect(slice.text).toBe('green plainmore')
    // raw event bytes preserved for asciinema replay
    expect(slice.events[0][2]).toContain('\x1b[32m')
    expect(slice.bytes).toBeGreaterThan(0)
  })

  it('skips malformed body lines but keeps going', () => {
    const t0 = 1_700_000_000
    const p = path.join(dir, 'mixed.cast')
    fs.writeFileSync(p, [
      JSON.stringify({ version: 2, width: 80, height: 24, timestamp: t0 }),
      'garbage-not-json',
      JSON.stringify([0.1, 'o', 'ok1']),
      JSON.stringify([0.2, 'i', 'ignored-input-event']),   // wrong type — skip
      JSON.stringify([0.3, 'o', 'ok2']),
      ''
    ].join('\n'), 'utf8')
    const slice = readCastSlice(p, 0, 1e13)!
    expect(slice.text).toBe('ok1ok2')
  })

  it('stops walking once we pass endMs (order-preserving)', () => {
    const t0 = 1_700_000_000
    const p = writeCast(dir, t0, [
      [0.0, 'o', 'in'],
      [10.0, 'o', 'out-of-window']
    ])
    const slice = readCastSlice(p, 0, t0 * 1000 + 500)!
    expect(slice.text).toBe('in')
    expect(slice.events).toHaveLength(1)
  })
})
