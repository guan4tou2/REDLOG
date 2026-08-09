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
