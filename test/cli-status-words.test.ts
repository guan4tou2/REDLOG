// Spec 075 T012 (first half): what `redlog-cli status` prints TODAY for each
// capture verdict. The CLI turns `dark` into 「⚠ RECORDING NOTHING」 and
// `partial` into 「wired but idle」 — the latter is wrong twice over (a failing
// source is not idle, and the same `partial` also means a proxy that failed
// to start), and it is one of the places Spec 075 T033 replaces with the
// shared status words. This file pins the output so that change is visible;
// T033 edits the expectations on purpose, in the same PR as the CLI.
//
// The CLI talks to `http://127.0.0.1:<port>`, and this sandbox refuses to
// bind a port. So the real script runs in a child process with `http.request`
// replaced, by a --require preload, with a canned reply: everything above the
// network (token read, request path, JSON parse, printing) is the real code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const CLI = path.join(__dirname, '..', 'cli', 'redlog-cli.js')
let home: string
let preload: string

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cli-'))
  fs.mkdirSync(path.join(home, '.redlog'))
  fs.writeFileSync(path.join(home, '.redlog', 'api-token'), 'test-token')
  fs.writeFileSync(path.join(home, '.redlog', 'api-port'), '6660')
  preload = path.join(home, 'fake-http.cjs')
  fs.writeFileSync(preload, `
    const http = require('http'), { EventEmitter } = require('events')
    http.request = (opts, cb) => {
      const req = new EventEmitter()
      req.write = () => {}
      req.end = () => {
        const res = new EventEmitter()
        res.statusCode = 200; res.headers = {}
        cb(res)
        res.emit('data', Buffer.from(process.env.FAKE_BODY))
        res.emit('end')
      }
      return req
    }
  `)
})
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

function status(body: object): string[] {
  const out = execFileSync(process.execPath, ['--require', preload, CLI, 'status'], {
    env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, FAKE_BODY: JSON.stringify(body) },
    encoding: 'utf8'
  })
  return out.split('\n').filter(Boolean)
}

const row = (id: string, state: string, installed?: boolean) => ({ id, state, lastEventAt: null, ...(installed === undefined ? {} : { installed }) })
const payload = (verdict: string, sources = [row('terminal', 'ready', true), row('mitmproxy', 'unset', false), row('screenshot', 'off')]) => ({
  eventCount: 12, scopeViolations: 0, ip: null,
  capture: { verdict, hasRecorded: false, sources, lastEventAt: null, checkedAt: 1, dbErrorTotal: 0, dbErrorFirstAt: null, unattributedSpool: null }
})

describe('redlog-cli status, per capture verdict (Spec 075 T012)', () => {
  it('healthy prints "recording", then one line per source', () => {
    expect(status(payload('healthy'))).toEqual([
      'RedLog Status:',
      '  Events:     12',
      '  Scope:      OK',
      '  Capture:    recording',
      '    - terminal           ready',
      '    - mitmproxy          not installed',
      '    - screenshot         off'
    ])
  })

  it('partial prints "wired but idle" — also for a failing source, which is not idle', () => {
    const lines = status(payload('partial', [row('terminal', 'ready', true), row('screenshot', 'error')]))
    expect(lines[3]).toBe('  Capture:    wired but idle')
    expect(lines.slice(4)).toEqual(['    - terminal           ready', '    - screenshot         error'])
  })

  it('dark prints "⚠ RECORDING NOTHING" — also for a broken chain sample, which is not "nothing"', () => {
    expect(status(payload('dark'))[3]).toBe('  Capture:    ⚠ RECORDING NOTHING')
  })

  it('an unknown verdict falls through to "recording"', () => {
    expect(status(payload('something-else'))[3]).toBe('  Capture:    recording')
  })

  it('a source with installed === false says "not installed" whatever its state', () => {
    const lines = status(payload('healthy', [row('terminal', 'ready', false), row('screenshot', 'error', false)]))
    expect(lines.slice(4)).toEqual(['    - terminal           not installed', '    - screenshot         not installed'])
  })

  it('no capture object, no Capture line', () => {
    expect(status({ eventCount: 0, scopeViolations: 2, ip: null })).toEqual([
      'RedLog Status:', '  Events:     0', '  Scope:      2 violations'
    ])
  })
})
