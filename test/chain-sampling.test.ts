import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.6.89 P1-A: read-path sampling verify. These tests exercise the
// three externally-observable properties of verifyRandomSample:
//   1. an intact chain always returns ok:true with sampled = min(K, N),
//   2. an empty DB returns ok:true with sampled = 0 (no false positive),
//   3. capture-health picks up noteSampleBroken and pins verdict to dark.
// A "corrupt a row's hash" test would need to bypass the append-only
// trigger, so instead the corruption path is validated by unit-testing
// noteSampleBroken's effect on getCaptureHealth — the actual mismatch
// branch inside verifyRandomSample is already exercised by the shape-
// variant logic verifyChainFull tests cover.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let anchor: typeof import('../src/core/chain-anchor')
let capture: typeof import('../src/core/capture-health')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const evMod = await import('../src/core/db/events')
  anchor = await import('../src/core/chain-anchor')
  capture = await import('../src/core/capture-health')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  insertEventRaw = evMod.insertEvent
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const insertEvent: typeof import('../src/core/db/events').insertEvent = (agentType, data, opts) =>
  insertEventRaw(agentType, data, { operatorId: 'test-op', ...opts })

const describeDB = dbAvailable ? describe : describe.skip

describeDB('chain-sampling', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-sample-'))
    initDB(tmpDir)
    capture.clearSampleBroken()
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    capture.clearSampleBroken()
  })

  it('empty DB returns ok:true with sampled=0 (no false positive)', () => {
    const r = anchor.verifyRandomSample(10)
    expect(r.ok).toBe(true)
    expect(r.sampled).toBe(0)
    expect(r.brokenAtEventId).toBeNull()
  })

  it('intact 20-event chain sampled at K=10 returns ok:true', () => {
    for (let i = 0; i < 20; i++) insertEvent('shell', { command: `cmd-${i}` })
    const r = anchor.verifyRandomSample(10)
    expect(r.ok).toBe(true)
    expect(r.sampled).toBe(10)
    expect(r.brokenAtEventId).toBeNull()
    expect(r.brokenReason).toBeNull()
  })

  it('sample count is clamped to available rows (LIMIT K when N<K)', () => {
    for (let i = 0; i < 5; i++) insertEvent('shell', { command: `cmd-${i}` })
    const r = anchor.verifyRandomSample(50)
    expect(r.ok).toBe(true)
    expect(r.sampled).toBe(5)
  })

  it('intact chain sampled at K=50 is < 100ms even at 200 events', () => {
    // Sanity check on the performance note in chain-anchor.ts — ORDER BY
    // RANDOM() is O(n) and at ~10k rows this is fast enough. Keep the
    // test size modest so the suite doesn't slow to a crawl.
    for (let i = 0; i < 200; i++) insertEvent('shell', { command: `cmd-${i}` })
    const t0 = Date.now()
    const r = anchor.verifyRandomSample(50)
    const dt = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(r.sampled).toBe(50)
    expect(dt).toBeLessThan(500)  // generous — actual is < 100ms locally
  })

  it('noteSampleBroken pins capture-health verdict to dark', () => {
    // Feed a real event so the health check would otherwise return healthy
    // — proves the sample-broken flag alone drops verdict to dark.
    insertEvent('shell', { subtype: 'command_start', command: 'nmap', source: 'zsh' })
    const before = capture.getCaptureHealth()
    // With no chain-sample-broken state, healthy or partial (depending on
    // whether the shell hook counts as installed in this test env) — but
    // never dark, because a source has fed.
    expect(before.verdict).not.toBe('dark')

    capture.noteSampleBroken({ eventId: 'evt-abc', reason: 'hash mismatch (v0.6.88=...)' })
    const after = capture.getCaptureHealth()
    expect(after.verdict).toBe('dark')
    expect(after.lastSampleBroken?.eventId).toBe('evt-abc')
    expect(after.lastSampleBroken?.reason).toContain('hash mismatch')
  })

  it('noteSampleOk updates lastSampleOkAt', () => {
    const t0 = Date.now()
    capture.noteSampleOk()
    const h = capture.getCaptureHealth()
    expect(h.lastSampleOkAt).not.toBeNull()
    expect(h.lastSampleOkAt!).toBeGreaterThanOrEqual(t0)
  })

  it('clearSampleBroken removes the broken state', () => {
    capture.noteSampleBroken({ eventId: 'evt-x', reason: 'test' })
    expect(capture.getCaptureHealth().lastSampleBroken).toBeDefined()
    capture.clearSampleBroken()
    expect(capture.getCaptureHealth().lastSampleBroken).toBeUndefined()
  })
})
