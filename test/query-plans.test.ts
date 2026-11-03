import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  // The test above passes for a probe that reads the whole bucket: its plan is
  // "SEARCH events USING INDEX idx_events_type_ts (agent_type=?)", which has no
  // SCAN and no sort and still filters every shell row by json_extract. The
  // probes that did this on a 198k-row project took 5-6 s per Capture Health
  // read. So this one runs the REAL probes and asserts the plan reaches the
  // discriminating column, not just an index.
  it('every Capture Health probe seeks on its discriminator instead of filtering a bucket', async () => {
    const hooksMod = await import('../src/core/hooks-manager')
    const healthMod = await import('../src/core/capture-health')
    const pluginsIndex = await import('../src/core/plugins/index')
    const hook = (id: string, extra: Record<string, unknown> = {}) => ({
      id, name: id, description: '', agentType: 'shell', installed: true, available: true,
      installMethod: 'shell-source' as const, hookFile: '', ...extra
    })
    healthMod.invalidateHooksCache()
    vi.spyOn(hooksMod, 'detectHooks').mockReturnValue([
      hook('shell-zsh'), hook('shell-bash'),
      hook('transparent-proxy.mitmproxy-transparent', { agentType: 'scanner', emits: ['http_request_start', 'http_response'], installed: false }),
      hook('pcap-capture.pcap-tcpdump', { agentType: 'scanner', emits: ['packet_flow', 'pcap_segment'], installed: false }),
      hook('c2-tailers.sliver', { agentType: 'scanner', emits: ['c2_checkin'], installed: false })
    ])
    vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue(
      ['pack-host-monitors', 'pack-windows-output'].map((id) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never)
    )

    const db = getDB()
    const realPrepare = db.prepare.bind(db)
    const seen: Array<{ sql: string; params: unknown[] }> = []
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = realPrepare(sql)
      if (!sql.startsWith('SELECT timestamp AS t')) return stmt
      const get = stmt.get.bind(stmt)
      stmt.get = ((...params: unknown[]) => { seen.push({ sql, params }); return get(...params) }) as typeof stmt.get
      return stmt
    }) as typeof db.prepare)
    healthMod.getCaptureHealth(Date.now())
    vi.restoreAllMocks()

    expect(seen.length, 'the probes were not captured').toBeGreaterThan(40)
    // Known residuals, by SQL substring: the regular-proxy probe is a NOT IN
    // over a bucket that is mostly its own rows (it stops at the first), and the
    // other two have no discriminating column an index could serve.
    const residual = ["NOT IN ('connection'", "'file-watcher'", 'producer_heartbeat']
    let checked = 0
    for (const { sql, params } of seen) {
      const detail = plan(sql, ...params)
      expect(detail, sql).not.toContain('SCAN')
      expect(detail, sql).not.toContain('TEMP B-TREE')
      if (residual.some((r) => sql.includes(r))) continue
      checked++
      expect(sql, 'no IN list: it is not an index seek').not.toMatch(/ IN \(/)
      const where = sql.slice(sql.indexOf(' WHERE '))
      // SQLite prints an indexed expression as `<expr>`, so the seek on the
      // discriminator reads `(<expr>=? ...)`; a plan that only reaches
      // `agent_type=?` is the bucket walk this test exists to refuse.
      if (where.includes("'$.agent'") || where.includes("'$.shell'") || where.includes("= 'transparent'")) {
        expect(detail, sql).toContain('<expr>=?')
      } else if (where.includes('subtype = ')) {
        expect(detail, sql).toContain('subtype=?')
      }
      // The captured-output probe is the one whose fallback still looks like a
      // seek: without its own index it uses the own-shell one, matches on
      // `<expr>=? AND subtype=?`, and then reads every command_end of that
      // shell to find a captured one. Name the index it must reach.
      if (where.includes("'$.output_disposition'")) expect(detail, sql).toContain('_own_shell_output_ts')
      else if (where.includes("'$.shell'")) expect(detail, sql).toContain('_own_shell_ts')
      else if (where.includes("= 'transparent'")) expect(detail, sql).toContain('_transparent_proxy_ts')
      else if (where.includes("'$.agent'")) expect(detail, sql).toContain('_agent_kind_ts')
    }
    expect(checked, 'the allow-list swallowed the probes').toBeGreaterThan(30)
  })

  it('opening a project twice leaves each Capture Health index defined once', () => {
    const names = ['agent_kind_ts', 'own_shell_ts', 'own_shell_output_ts', 'transparent_proxy_ts']
    const count = (): Array<{ name: string }> => getDB()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx\\_events%\\_ts' ESCAPE '\\'`)
      .all() as Array<{ name: string }>
    const before = count()
    for (const table of ['events', 'events_logged']) {
      for (const n of names) expect(before.filter((i) => i.name === `idx_${table}_${n}`), `${table} ${n}`).toHaveLength(1)
    }
    closeDB()
    initDB(tmpDir)
    expect(count()).toEqual(before)
  })
})
