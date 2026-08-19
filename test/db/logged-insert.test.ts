import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.13.0: the logged-tier insert path (docs/DESIGN-two-tier-chain.md §4.2).
// insertEvent dispatches to `events` or `events_logged` based on
// classifyTier. Logged rows skip the chain machinery — no hash, no
// signature, no prev_hash cache mutation, no clock-anomaly detector, no
// dedup window. This test locks that contract end-to-end against a real
// SQLite DB.

let initDB: typeof import('../../src/core/db/index').initDB
let closeDB: typeof import('../../src/core/db/index').closeDB
let getDB: typeof import('../../src/core/db/index').getDB
let events: typeof import('../../src/core/db/events')
let ops: typeof import('../../src/core/db/operators')

let dbAvailable = false
try {
  const dbMod = await import('../../src/core/db/index')
  events = await import('../../src/core/db/events')
  ops = await import('../../src/core/db/operators')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getDB = dbMod.getDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('insertEvent — two-tier dispatch (v0.13.0)', () => {
  let tmpDir: string
  let operatorId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-tier-'))
    initDB(tmpDir)
    // Every insertEvent requires a resolved operator; primary operator
    // is created lazily by the app but tests need it up front.
    const op = ops.ensurePrimaryOperator('test-op', 'Test Operator', 'test-token-' + Math.random())
    operatorId = op.id
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('shell.command_start lands in events (chained tier)', () => {
    const ev = events.insertEvent('shell', {
      subtype: 'command_start',
      command: 'ls /tmp'
    }, { operatorId, engagementId: 'test' })
    expect(ev).not.toBeNull()
    expect(ev!.hash).toBeTruthy()
    expect(ev!.tier).toBeUndefined()  // chained arm doesn't stamp tier — rowToEvent defaults it

    const db = getDB()
    const chainedRows = db.prepare('SELECT id FROM events').all() as Array<{ id: string }>
    const loggedRows = db.prepare('SELECT id FROM events_logged').all() as Array<{ id: string }>
    expect(chainedRows.map((r) => r.id)).toContain(ev!.id)
    expect(loggedRows).toHaveLength(0)
  })

  it('dns.dns_query lands in events_logged with hash/signature/prev_hash all null', () => {
    const ev = events.insertEvent('dns', {
      subtype: 'dns_query',
      query_name: 'example.test',
      query_type: 'A'
    }, { operatorId, engagementId: 'test' })
    expect(ev).not.toBeNull()
    expect(ev!.hash).toBeUndefined()
    expect(ev!.signature).toBeNull()
    expect(ev!.prevHash).toBeNull()
    expect(ev!.monotonicNs).toBeNull()
    expect(ev!.ntpOffsetMs).toBeNull()
    expect(ev!.tier).toBe('logged')

    const db = getDB()
    const chainedRows = db.prepare('SELECT id FROM events').all() as Array<{ id: string }>
    const loggedRows = db.prepare('SELECT id FROM events_logged').all() as Array<{ id: string }>
    expect(chainedRows).toHaveLength(0)  // no chained rows written
    expect(loggedRows.map((r) => r.id)).toContain(ev!.id)
  })

  it('logged insert does NOT bump the chain event count', () => {
    events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { operatorId })
    const beforeCount = events.getEventCount()
    // Interleave 5 logged rows.
    for (let i = 0; i < 5; i++) {
      events.insertEvent('dns', { subtype: 'dns_query', query_name: `x${i}.test` }, { operatorId })
    }
    const afterCount = events.getEventCount()
    expect(afterCount).toBe(beforeCount)  // chain count unchanged
    // But the `all` tier count reflects them.
    expect(events.getEventCount({ tier: 'all' })).toBe(beforeCount + 5)
    expect(events.getEventCount({ tier: 'logged' })).toBe(5)
  })

  it('chain integrity survives interleaved logged inserts', () => {
    // Sequence: chained A → 3× logged → chained B. The chained arm's
    // prev_hash for B must be A's hash — the logged rows in between must
    // not perturb the chain cache.
    const a = events.insertEvent('shell', {
      subtype: 'command_start', command: 'first'
    }, { operatorId })
    for (let i = 0; i < 3; i++) {
      events.insertEvent('dns', { subtype: 'dns_query', query_name: `mid${i}.test` }, { operatorId })
    }
    const b = events.insertEvent('shell', {
      subtype: 'command_start', command: 'second'
    }, { operatorId })
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b!.prevHash).toBe(a!.hash)  // ← the invariant
  })

  it('queryEvents union returns both tiers in a single time-sorted result', () => {
    const now = Date.now()
    // Alternating writes should come back interleaved by timestamp.
    events.insertEvent('shell', { subtype: 'command_start', command: 'a' }, { operatorId })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'b.test' }, { operatorId })
    events.insertEvent('shell', { subtype: 'command_start', command: 'c' }, { operatorId })
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'd.test' }, { operatorId })

    const all = events.queryEvents({ limit: 100 })
    expect(all).toHaveLength(4)
    // Sorted newest-first; timestamps within the same millisecond may
    // tie, so check both tiers are represented.
    const tiers = new Set(all.map((e) => e.tier))
    expect(tiers.has('chained')).toBe(true)
    expect(tiers.has('logged')).toBe(true)

    const chainedOnly = events.queryEvents({ limit: 100, tier: 'chained' })
    expect(chainedOnly).toHaveLength(2)
    expect(chainedOnly.every((e) => e.tier === 'chained')).toBe(true)

    const loggedOnly = events.queryEvents({ limit: 100, tier: 'logged' })
    expect(loggedOnly).toHaveLength(2)
    expect(loggedOnly.every((e) => e.tier === 'logged')).toBe(true)
  })

  it('queryEventById finds rows in either table (chained-first on tie)', () => {
    const chained = events.insertEvent('shell', {
      subtype: 'command_start', command: 'find me'
    }, { operatorId })
    const logged = events.insertEvent('dns', {
      subtype: 'dns_query', query_name: 'also.test'
    }, { operatorId })
    expect(events.queryEventById(chained!.id)?.tier).toBe('chained')
    expect(events.queryEventById(logged!.id)?.tier).toBe('logged')
    expect(events.queryEventById('nonexistent-id')).toBeNull()
  })

  it('operatorId is required even for logged inserts', () => {
    expect(() => events.insertEvent('dns', { subtype: 'dns_query', query_name: 'x' }, {}))
      .toThrow(/operatorId is required/)
  })
})
