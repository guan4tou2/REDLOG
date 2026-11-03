import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { drainInSlices, replaySpoolDirectory } from '../src/core/spool-replay'

// The 30-second spool drain used to replay up to 200 files in one synchronous
// call. At ~20 ms a file through ingest() that is a 4 s block of the main
// thread, and the local API shares it: /api/health stalled for as long as the
// drain ran (#291). The drain now does the same files in the same order, ten at
// a time, and lets the event loop run between slices.

const ACTIVE = { engagementId: 'eng', operatorId: 'op' }

describe('draining the spool in slices', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-spool-slices-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const write = (n: number, engagementId = 'eng'): void => {
    fs.writeFileSync(path.join(dir, `${String(n).padStart(4, '0')}.json`), JSON.stringify({
      agent_type: 'shell', data: { command: `cmd-${n}` }, _identity: { engagementId, operatorId: 'op' }
    }))
  }

  /** A scheduler the test turns by hand, so what runs inside one turn of the
   *  event loop is something it can count. */
  const manualLoop = (): { schedule: (next: () => void) => void; turn: () => boolean; pending: () => number } => {
    const queue: Array<() => void> = []
    return {
      schedule: (next) => { queue.push(next) },
      turn: () => { const next = queue.shift(); if (!next) return false; next(); return true },
      pending: () => queue.length
    }
  }

  /** The drain as index.ts wires it: replaySpoolDirectory, emit recording when
   *  it ran, `turns` counting how many event-loop turns have passed. */
  const harness = (isCurrent: () => boolean = () => true) => {
    const loop = manualLoop()
    const emitted: Array<{ name: string; turn: number }> = []
    let turn = 0
    const drain = drainInSlices({
      drainOnce: (limit, after) => replaySpoolDirectory(dir, ACTIVE, (e) => {
        emitted.push({ name: String(e.data.command), turn })
        return true
      }, limit, after).last,
      total: 200,
      slice: 10,
      isCurrent,
      schedule: loop.schedule
    })
    const run = (): void => { drain(); for (turn++; loop.turn(); turn++) { /* one slice per turn */ } }
    return { drain, loop, emitted, run, turns: () => turn }
  }

  it('replays every file, in order, never more than ten in one turn of the event loop', () => {
    for (let n = 0; n < 200; n++) write(n)
    const h = harness()
    h.run()
    expect(h.emitted.map((e) => e.name)).toEqual(Array.from({ length: 200 }, (_, n) => `cmd-${n}`))
    const perTurn = new Map<number, number>()
    for (const e of h.emitted) perTurn.set(e.turn, (perTurn.get(e.turn) ?? 0) + 1)
    expect(Math.max(...perTurn.values())).toBe(10)
    expect(perTurn.size).toBe(20)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('stops at the total, leaving the rest for the next tick', () => {
    for (let n = 0; n < 230; n++) write(n)
    const h = harness()
    h.run()
    expect(h.emitted).toHaveLength(200)
    expect(fs.readdirSync(dir)).toHaveLength(30)
    h.run()
    expect(h.emitted).toHaveLength(230)
  })

  it('does nothing when called again while a drain is running', () => {
    for (let n = 0; n < 50; n++) write(n)
    const h = harness()
    h.drain()
    expect(h.emitted).toHaveLength(10)
    h.drain()
    h.drain()
    expect(h.emitted).toHaveLength(10)
    expect(h.loop.pending()).toBe(1)
    while (h.loop.turn()) { /* finish the first drain */ }
    expect(h.emitted).toHaveLength(50)
    // Done, so the next tick is free to start again.
    write(50)
    h.drain()
    expect(h.emitted).toHaveLength(51)
  })

  it('stops when the project is no longer current', () => {
    for (let n = 0; n < 100; n++) write(n)
    let current = true
    const h = harness(() => current)
    h.drain()
    h.loop.turn()
    expect(h.emitted).toHaveLength(20)
    current = false
    while (h.loop.turn()) { /* drain what is left */ }
    expect(h.emitted).toHaveLength(20)
    expect(h.loop.pending()).toBe(0)
    // And it is not wedged: once current again the next tick drains the rest.
    current = true
    h.run()
    expect(h.emitted).toHaveLength(100)
  })

  it('stops when the directory is empty or the drain is declined', () => {
    const h = harness()
    h.run()
    expect(h.emitted).toEqual([])

    const loop = manualLoop()
    let calls = 0
    const declined = drainInSlices({ drainOnce: () => { calls++; return null }, total: 200, slice: 10, isCurrent: () => true, schedule: loop.schedule })
    declined()
    expect(calls).toBe(1)
    expect(loop.pending()).toBe(0)
  })

  it('survives a drain that throws, and drains again next tick', () => {
    const loop = manualLoop()
    let calls = 0
    const drain = drainInSlices({
      drainOnce: () => { calls++; throw new Error('disk') },
      total: 200, slice: 10, isCurrent: () => true, schedule: loop.schedule
    })
    drain()
    drain()
    expect(calls).toBe(2)
    expect(loop.pending()).toBe(0)
  })

  it('a file belonging to another project does not hold up the ones behind it', () => {
    // Ten foreign files sort first: a slice that only counted what it replayed
    // would examine the same ten forever.
    for (let n = 0; n < 10; n++) write(n, 'someone-else')
    for (let n = 10; n < 25; n++) write(n)
    const h = harness()
    h.run()
    expect(h.emitted.map((e) => e.name)).toEqual(Array.from({ length: 15 }, (_, n) => `cmd-${n + 10}`))
    expect(fs.readdirSync(dir)).toHaveLength(10)
  })
})
