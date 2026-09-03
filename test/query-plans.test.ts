import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// v0.9.8: locks in the two index-dependent hot paths. Both were found by
// profiling at 50k rows, and both regress silently — the queries stay correct,
// they just get slow, which no functional test would notice.

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let getDB: typeof import('../src/core/db/index').getDB

let dbAvailable = false
try {
  const m = await import('../src/core/db/index')
  initDB = m.initDB; closeDB = m.closeDB; getDB = m.getDB
  dbAvailable = true
} catch { /* better-sqlite3 not built for this Node */ }

const describeDB = dbAvailable ? describe : describe.skip
let tmpDir: string

const plan = (sql: string, ...p: unknown[]): string =>
  (getDB().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as Array<{ detail: string }>)
    .map((r) => r.detail).join(' | ')

describeDB('query plans', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-plan-'))
    initDB(tmpDir)
  })
  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('the composite (agent_type, timestamp) index exists', () => {
    const idx = getDB().prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'`)
      .all() as Array<{ name: string }>
    expect(idx.map((i) => i.name)).toContain('idx_events_type_ts')
  })

  it("insertEvent's dedup window is served by an index, not a table scan", () => {
    // Before the composite index this planned as "SEARCH USING
    // idx_events_type" + "USE TEMP B-TREE FOR ORDER BY" — every shell row
    // pulled into a sort to find 20, on every single insert. 2.8 ms at 50k
    // rows; the whole insert was 2.7 ms of which this was nearly all.
    const p = plan(
      `SELECT id, agent_type, data FROM events WHERE agent_type IN ('shell','agent') AND timestamp >= ? ORDER BY timestamp DESC LIMIT 20`, 0
    )
    expect(p).toContain('idx_events_type_ts')
    expect(p, 'must not fall back to a full table scan').not.toContain('SCAN events')
  })

  it('reading a marker\'s amendments narrows on agent_type before touching JSON', () => {
    // json_extract cannot be indexed here, so the only thing standing between
    // this and a full-table JSON parse per row is the agent_type predicate
    // resolving first. Asserted as the ABSENCE of a scan rather than by naming
    // an index: SQLite may legitimately prefer a different one as indexes are
    // added, and a green-to-red flip for a change that made nothing slower
    // teaches the team to delete the assertion.
    const p = plan(
      `SELECT id FROM events WHERE agent_type = 'marker'
         AND json_extract(data, '$.subtype') = 'amended'
         AND json_extract(data, '$.markerId') IN (?)`, 'x'
    )
    expect(p, 'must not fall back to a full table scan').not.toContain('SCAN events')
  })

  it("the recompute's candidate scan narrows on agent_type before parsing rows", () => {
    // Phase A exists so a scope save does not JSON-parse every row in the
    // project on the main thread while capture continues. json_extract cannot
    // be indexed, so the agent_type predicate resolving first is the whole
    // cost bound. Asserted as the absence of a scan rather than by naming an
    // index — a later index can legitimately win the plan.
    for (const table of ['events', 'events_logged']) {
      const p = plan(
        `SELECT json_extract(data, '$.detectedTarget') AS k, COUNT(*) AS n
         FROM ${table}
         WHERE agent_type = ? AND json_extract(data, '$.subtype') IN (?)
           AND json_extract(data, '$.detectedTarget') IS NOT NULL
         GROUP BY k`, 'shell', 'command_start'
      )
      expect(p, `${table} candidate scan fell back to a full table scan`).not.toContain(`SCAN ${table}`)
    }
  })

  it('reading standing violations stays inside the system bucket', () => {
    const p = plan(
      `SELECT id, timestamp, data FROM events
       WHERE agent_type = 'system'
         AND json_extract(data, '$.subtype') IN ('scope_violation','scope_cleared')
       ORDER BY created_at ASC, rowid ASC`
    )
    expect(p).not.toContain('SCAN events')
  })

  it('the chain prev-row lookup is index-driven, not an OR fallback', () => {
    // v0.9.8. The equivalent OR form
    //   created_at < ? OR (created_at = ? AND rowid < ?)
    // reads as index-friendly and even reports the same top-level plan, but
    // SQLite cannot drive a single index scan from an OR across two different
    // predicates — it degraded into reading the events table, and that pages
    // in the whole `data` column. Measured on a real 131k-event / 151 MB
    // engagement: 39.5 ms per lookup versus 0.006 ms for the row-value form,
    // and verifyRandomSample makes one per sampled row. That one query was the
    // whole of a 3.7 s freeze at project open and a 1.8 s one every 5 minutes.
    const p = plan(
      `SELECT hash FROM events WHERE (created_at, rowid) < (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT 1`, 0, 0
    )
    expect(p).toContain('idx_events_created_at')
    expect(p, 'ordering must come from the index').not.toContain('TEMP B-TREE')
  })

  it('the chain-head count is served by the partial index, not a table scan', () => {
    // COUNT(*) WHERE hash IS NOT NULL planned as a bare SCAN, which means
    // paging the entire data column to count rows. 43 ms per call on the same
    // database; verifyLatestAnchor pays it on every chain-status request.
    const p = plan(`SELECT COUNT(*) AS c FROM events WHERE hash IS NOT NULL`)
    expect(p).toContain('idx_events_hashed')
  })

  it("capture-health's freshness probes use the index and stop early", () => {
    // MAX(timestamp) is an aggregate: SQLite must visit every row matching the
    // WHERE clause. Most of these predicates carry a json_extract() no index
    // can serve, so each probe scanned the whole agent_type bucket — eleven of
    // them, 23 ms per call, on every agent status request. ORDER BY + LIMIT 1
    // walks newest-first and stops at the first match.
    const p = plan(
      `SELECT timestamp AS t FROM events WHERE agent_type = 'shell' AND json_extract(data,'$.source') = 'builtin-terminal' ORDER BY timestamp DESC LIMIT 1`
    )
    expect(p).toContain('idx_events_type_ts')
    expect(p, 'ordering must come from the index, not a sort').not.toContain('TEMP B-TREE')
  })
})
