import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// M1 (UIUX-STANDARD §9 / §14-4c): the Targets page counts are aggregated in
// SQL over the whole timeline, not rolled up client-side from a capped
// query({ limit: 1000 }). The capped path silently dropped targets seen only
// in older events and truncated every count. These tests pin the SQL path:
// both tiers, nulls excluded, correct MIN/MAX, and — the headline — uncapped.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let aggregateTargets: typeof import('../src/core/db/events').aggregateTargets

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const eventsMod = await import('../src/core/db/events')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  insertEventRaw = eventsMod.insertEvent
  aggregateTargets = eventsMod.aggregateTargets
  dbAvailable = true
} catch {
  // better-sqlite3 not compiled for this Node.js version
}

const insertEvent: typeof import('../src/core/db/events').insertEvent = (agentType, data, opts) =>
  insertEventRaw(agentType, data, { operatorId: 'test-op', ...opts })

const describeDB = dbAvailable ? describe : describe.skip

let tmpDir: string

describeDB('aggregateTargets', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tgt-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rolls up counts + first/last-seen per target', () => {
    insertEvent('shell', { command: 'nmap a', detectedTarget: 'a.example.com' })
    insertEvent('shell', { command: 'nmap a2', detectedTarget: 'a.example.com' })
    insertEvent('shell', { command: 'curl b', detectedTarget: 'b.example.com' })
    const rows = aggregateTargets()
    const byTgt = Object.fromEntries(rows.map((r) => [r.target, r]))
    expect(byTgt['a.example.com'].eventCount).toBe(2)
    expect(byTgt['b.example.com'].eventCount).toBe(1)
    expect(byTgt['a.example.com'].lastSeen).toBeGreaterThanOrEqual(byTgt['a.example.com'].firstSeen)
  })

  it('counts across BOTH tiers — a scanner (logged) hit and a shell (chained) hit on the same target sum', () => {
    insertEvent('shell', { command: 'x', detectedTarget: 'dual.example.com' })
    // scanner:http_response routes to events_logged (LOGGED_TIER)
    insertEvent('scanner', { subtype: 'http_response', detectedTarget: 'dual.example.com' })
    const dual = aggregateTargets().find((r) => r.target === 'dual.example.com')
    expect(dual?.eventCount).toBe(2)
  })

  it('excludes events with no detectedTarget', () => {
    insertEvent('shell', { command: 'whoami' })                       // no target
    insertEvent('shell', { command: 'id', detectedTarget: '' })       // empty target
    insertEvent('shell', { command: 'ssh', detectedTarget: 'real.com' })
    const rows = aggregateTargets()
    expect(rows.map((r) => r.target)).toEqual(['real.com'])
  })

  it('orders newest-touched first', () => {
    insertEvent('shell', { command: 'a', detectedTarget: 'first.com' })
    insertEvent('shell', { command: 'b', detectedTarget: 'second.com' })
    const rows = aggregateTargets()
    // second.com was touched last → it leads
    expect(rows[0].target).toBe('second.com')
  })

  it('is uncapped — a target with more than 1000 events reports every one', () => {
    // The whole point of M1: the old client rollup capped at 1000 rows, so a
    // busy target came back short and a target seen only in the dropped tail
    // vanished. Insert one sparse target, then 1100 for a busy one.
    insertEvent('shell', { command: 'seed', detectedTarget: 'sparse.example.com' })
    for (let i = 0; i < 1100; i++) {
      insertEvent('shell', { command: `hit ${i}`, detectedTarget: 'busy.example.com' })
    }
    const rows = aggregateTargets()
    const byTgt = Object.fromEntries(rows.map((r) => [r.target, r]))
    expect(byTgt['busy.example.com'].eventCount).toBe(1100) // a 1000-cap could not
    expect(byTgt['sparse.example.com'].eventCount).toBe(1)  // and would not drop this
  })
})
