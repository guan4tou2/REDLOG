import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  it('union paging walks every row once, newest-first, across both tiers', () => {
    // Locks the seek-pager contract that the per-arm LIMIT push-down must not
    // break: seed >PAGE rows alternating tiers, each stamped a distinct,
    // strictly-increasing clock so the `beforeCreatedAt` cursor
    // (created_at < ?) has a clean boundary. Rows can't be UPDATEd after the
    // fact — the `events` table has an immutability trigger — so we advance a
    // fake system clock between inserts instead, which stamps both `timestamp`
    // and `created_at` through the normal insert path. (The real Timeline
    // pager tolerates same-ms write bursts by de-duping on id client-side;
    // here we prove the SQL itself loses no row and invents none, page after
    // page.) monotonic_ns comes from a real hrtime clock, so the chain's
    // clock-anomaly detector is unaffected by the faked wall clock.
    type Ev = ReturnType<typeof events.queryEvents>[number]
    const N = 120
    const PAGE = 50
    const base = 1_700_000_000_000  // fixed epoch; fake timers start Date.now at 0
    const ids: string[] = []
    vi.useFakeTimers()
    try {
      for (let i = 0; i < N; i++) {
        vi.setSystemTime(base + i)  // later insert = newer wall clock
        const ev = i % 2 === 0
          ? events.insertEvent('shell', { subtype: 'command_start', command: `c${i}` }, { operatorId })
          : events.insertEvent('dns', { subtype: 'dns_query', query_name: `q${i}.test` }, { operatorId })
        ids.push(ev!.id)
      }
    } finally {
      vi.useRealTimers()
    }

    // Page with the exact contract the Timeline pager uses.
    const seen: Ev[] = []
    const seenIds = new Set<string>()
    let cursor: number | undefined
    for (;;) {
      const page: Ev[] = events.queryEvents(
        cursor !== undefined ? { limit: PAGE, beforeCreatedAt: cursor } : { limit: PAGE }
      )
      if (page.length === 0) break
      for (const e of page) {
        expect(seenIds.has(e.id)).toBe(false)  // no dupes across pages
        seenIds.add(e.id)
        seen.push(e)
      }
      cursor = page[page.length - 1].createdAt  // oldest row of this page
      if (page.length < PAGE) break
    }

    // Every row exactly once — no gaps, no dupes.
    expect(seen).toHaveLength(N)
    // Strict newest-first order preserved across page boundaries.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i - 1].timestamp).toBeGreaterThan(seen[i].timestamp)
    }
    // Full sequence equals reverse insertion order (newest first).
    expect(seen.map((e) => e.id)).toEqual([...ids].reverse())
    // Both tiers participated.
    const tiers = new Set(seen.map((e) => e.tier))
    expect(tiers.has('chained')).toBe(true)
    expect(tiers.has('logged')).toBe(true)
    // Head page is exactly PAGE rows though 2×PAGE+ exist across both tiers —
    // i.e. each capped arm still supplied enough to fill the merged page.
    expect(events.queryEvents({ limit: PAGE })).toHaveLength(PAGE)
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

  // v0.14.3 §9.5: powers the CaptureHealthCard "last fed" freshness readout.
  it('getLatestLoggedTs returns null on empty logged tier, tracks the newest write', () => {
    expect(events.getLatestLoggedTs()).toBeNull()

    const t0 = Date.now()
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.test' }, { operatorId })
    const t1 = events.getLatestLoggedTs()
    expect(t1).not.toBeNull()
    expect(t1!).toBeGreaterThanOrEqual(t0)

    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'b.test' }, { operatorId })
    const t2 = events.getLatestLoggedTs()
    expect(t2!).toBeGreaterThanOrEqual(t1!)

    // Chained inserts must NOT affect the logged-tier freshness reading —
    // that's the whole point of a per-tier "last fed" number.
    events.insertEvent('shell', { subtype: 'command_start', command: 'noise' }, { operatorId })
    expect(events.getLatestLoggedTs()).toBe(t2)
  })
})
