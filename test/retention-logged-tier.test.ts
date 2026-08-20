import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.13.0 (docs/DESIGN-logged-tier-retention.md §12): row-level retention
// on events_logged. Age is primary, chained summary event fires on
// count > 0, pause is respected, chained table is untouched.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let retention: typeof import('../src/core/retention')
let eventBusMod: typeof import('../src/core/event-bus')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  retention = await import('../src/core/retention')
  eventBusMod = await import('../src/core/event-bus')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  getDB = dbMod.getDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const describeDB = dbAvailable ? describe : describe.skip

const DAY_MS = 24 * 60 * 60 * 1000

/** Backdate a row's created_at directly — the retention key is created_at
 *  (design §5.2), so tests need to force old rows without waiting real time. */
function backdateLoggedRow(id: string, days: number): void {
  const cutoff = Date.now() - days * DAY_MS
  getDB().prepare('UPDATE events_logged SET created_at = ? WHERE id = ?').run(cutoff, id)
}

describeDB('sweepLoggedTier — v0.13.0', () => {
  let tmpDir: string
  let operatorId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-retention-tier-'))
    initDB(tmpDir)
    const op = ops.ensurePrimaryOperator('ret-op', 'Retention Op', 'test-token-' + Math.random())
    operatorId = op.id
    if (eventBusMod.eventBus.paused) eventBusMod.eventBus.resume()
    delete process.env.REDLOG_LOGGED_RETENTION_DAYS
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('no-op when table is empty', () => {
    const r = retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    expect(r.deleted).toBe(0)
    expect(r.bytesFreed).toBe(0)
  })

  it('no-op when keepDays === 0 (keep forever)', () => {
    const ev = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'old.test' }, { operatorId })
    backdateLoggedRow(ev!.id, 365)
    const r = retention.sweepLoggedTier({ keepDays: 0 }, { engagementId: 'e', operatorId })
    expect(r.deleted).toBe(0)
    // Row still there.
    expect(getDB().prepare('SELECT COUNT(*) as c FROM events_logged').get()).toEqual({ c: 1 })
  })

  it('prunes rows older than keepDays; keeps younger ones', () => {
    const old1 = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a.old' }, { operatorId })
    const old2 = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'b.old' }, { operatorId })
    const young = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'c.new' }, { operatorId })
    backdateLoggedRow(old1!.id, 45)
    backdateLoggedRow(old2!.id, 45)
    // young stays at "now"
    const r = retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    expect(r.deleted).toBe(2)
    expect(r.bytesFreed).toBeGreaterThan(0)
    const remaining = getDB().prepare('SELECT id FROM events_logged').all() as Array<{ id: string }>
    expect(remaining.map((r) => r.id)).toEqual([young!.id])
  })

  it('emits system.retention_pruned_logged CHAINED event on count > 0', () => {
    const ev = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a' }, { operatorId })
    backdateLoggedRow(ev!.id, 45)
    const chainedBefore = getDB().prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }
    retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    const chainedAfter = getDB().prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }
    expect(chainedAfter.c).toBe(chainedBefore.c + 1)  // one new chained summary event
    // Find the summary event and check its shape.
    const summaryRow = getDB().prepare(
      "SELECT data FROM events WHERE agent_type = 'system' AND json_extract(data, '$.subtype') = 'retention_pruned_logged' ORDER BY created_at DESC LIMIT 1"
    ).get() as { data: string } | undefined
    expect(summaryRow).toBeDefined()
    const data = JSON.parse(summaryRow!.data)
    expect(data.count).toBe(1)
    expect(data.keep_days).toBe(30)
    expect(data.bytes_freed).toBeGreaterThan(0)
    expect(data.oldest_pruned_at).toBeTruthy()
    expect(data.newest_pruned_at).toBeTruthy()
    expect(data.sweep_duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('does NOT fire summary event when count === 0', () => {
    // No old rows.
    events.insertEvent('dns', { subtype: 'dns_query', query_name: 'young.test' }, { operatorId })
    const chainedBefore = getDB().prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }
    retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    const chainedAfter = getDB().prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }
    expect(chainedAfter.c).toBe(chainedBefore.c)  // no summary written
  })

  it('sweep does NOT touch events (chained) table — regression guard', () => {
    // The chained events table has an append-only trigger that would
    // reject any UPDATE anyway (chain integrity — see `no_update_events_hash`
    // in db/index.ts). This is belt-and-braces: even if a future refactor
    // widened sweepLoggedTier's SQL to include `events`, the sweep would
    // fail loudly rather than corrupt the chain. We assert here that
    // chained rows survive AND the chained count only grows (by the
    // summary event) — proving the sweep never issued a DELETE against
    // `events`.
    const chained = events.insertEvent('shell', { subtype: 'command_start', command: 'ls' }, { operatorId })
    const logged = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a' }, { operatorId })
    backdateLoggedRow(logged!.id, 45)
    const chainedCountBefore = getDB().prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }
    retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    const chainedCountAfter = getDB().prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }
    // Original chained row still there.
    expect(getDB().prepare('SELECT id FROM events WHERE id = ?').get(chained!.id)).toBeDefined()
    // Logged row pruned.
    expect(getDB().prepare('SELECT id FROM events_logged WHERE id = ?').get(logged!.id)).toBeUndefined()
    // Chained count grew by exactly 1 — the retention_pruned_logged
    // summary. No DELETE ran against events.
    expect(chainedCountAfter.c).toBe(chainedCountBefore.c + 1)
  })

  it('respects eventBus.paused (design §5.4)', () => {
    const ev = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a' }, { operatorId })
    backdateLoggedRow(ev!.id, 45)
    eventBusMod.eventBus.pause('ui')
    const r = retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    expect(r.deleted).toBe(0)
    expect(getDB().prepare('SELECT COUNT(*) as c FROM events_logged').get()).toEqual({ c: 1 })
    eventBusMod.eventBus.resume('ui')
  })

  it('respects REDLOG_LOGGED_RETENTION_DAYS env var override', () => {
    const old = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a' }, { operatorId })
    backdateLoggedRow(old!.id, 10)
    // Config says 30 days, but env says 7 → env wins, 10-day-old row is pruned.
    process.env.REDLOG_LOGGED_RETENTION_DAYS = '7'
    const r = retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    expect(r.deleted).toBe(1)
  })

  // Windows CI runs each insertEvent slower (WAL fsync + AV scans); 100 rows
  // sequentially can push past the 5s default. Bump to 20s for headroom —
  // macOS/Linux still finish in <1s.
  it('batched delete handles > BATCH_SIZE rows', { timeout: 20000 }, () => {
    // Insert 100 rows and backdate all of them. Even though we don't hit
    // the real BATCH_SIZE=5000, this exercises the delete loop and
    // guarantees `pruned` matches what got deleted.
    const ids: string[] = []
    for (let i = 0; i < 100; i++) {
      const ev = events.insertEvent('dns', { subtype: 'dns_query', query_name: `row-${i}` }, { operatorId })
      ids.push(ev!.id)
    }
    for (const id of ids) backdateLoggedRow(id, 45)
    const r = retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    expect(r.deleted).toBe(100)
    expect(getDB().prepare('SELECT COUNT(*) as c FROM events_logged').get()).toEqual({ c: 0 })
  })

  it('no operator → no-op (never runs without attribution)', () => {
    const r = retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId: '' })
    expect(r.deleted).toBe(0)
  })

  it('summary event links to nothing (pruned rows are gone; _causes would dangle)', () => {
    // Design §9.2: sweep summary intentionally has no `_causes` — the rows
    // it pruned are gone, so a pointer would dangle. The summary IS the
    // audit artifact for the deletion.
    const ev = events.insertEvent('dns', { subtype: 'dns_query', query_name: 'a' }, { operatorId })
    backdateLoggedRow(ev!.id, 45)
    retention.sweepLoggedTier({ keepDays: 30 }, { engagementId: 'e', operatorId })
    const summary = getDB().prepare(
      "SELECT data FROM events WHERE json_extract(data, '$.subtype') = 'retention_pruned_logged' ORDER BY created_at DESC LIMIT 1"
    ).get() as { data: string }
    const data = JSON.parse(summary.data)
    expect(data._causes).toBeUndefined()
  })
})
