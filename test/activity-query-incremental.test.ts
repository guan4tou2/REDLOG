import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB, closeDB, getDB, getReadonlyDB } from '../src/core/db/index'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
import { parseQuery } from '../src/core/query/contract'
import { queryActivityPage, queryActivityMembers } from '../src/core/db/activity-queries'
import type { ActivityRequest, ActivityPage } from '../src/core/activity-contract'

// The Activity page used to group the whole projection on every call: O(rows)
// per call, 1.3–1.7 s warm at 80k rows, on the main thread, while live
// capture queued behind it. It now reads per-Activity aggregates kept as rows
// are projected, and recomputes only the Activities that gained rows after the
// request's snapshot. These tests hold the two halves of that:
//   - the answer is exactly what the selection-driven path gives (a filter
//     that admits every row forces that path), including frozen cursor pages
//     read after late rows arrived, and housekeeping excluded;
//   - an unfiltered page does not scan or group the projection.

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-activity-inc-')); initDB(dir) })
afterEach(() => { closeHttpBodyIndex(); closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

function add(id: string, ts: number, type: string, data: Record<string, unknown>, opts: { tier?: 'chained' | 'logged'; project?: string } = {}): void {
  const table = opts.tier === 'logged' ? 'events_logged' : 'events'
  getDB().prepare(`INSERT INTO ${table} (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,source_ip,target_id,data,created_at${table === 'events' ? ',hash,prev_hash' : ''})
    VALUES (?,?,?,?,?,?,?,'host',NULL,NULL,?,?${table === 'events' ? ", 'fixture-hash', NULL" : ''})`).run(
    id, ts, opts.project ?? 'eng', 'binding', 'operator', type, String(data.subtype ?? ''), JSON.stringify(data), ts)
}
function request(extra: Partial<ActivityRequest> = {}): ActivityRequest {
  const parsed = parseQuery(''); if (!parsed.ok) throw new Error('bad fixture query')
  return { projectId: 'eng', parsed: parsed.parsed, ...extra }
}
/** Admits every row, and is not "no filter", so it takes the selection path. */
const EVERY_ROW = { since: -1 }

let n = 0
function seed(count: number, base = 0): void {
  for (let i = 0; i < count; i++) {
    const k = (base + i) % 7, ts = 1000 + base + i
    if (k === 0) add(`s${base + i}`, ts, 'shell', { subtype: 'command_start', terminalId: 't1', command_id: `c${(base + i) >> 1}`, command: 'id' })
    else if (k === 1) add(`e${base + i}`, ts, 'shell', { subtype: 'command_end', terminalId: 't1', command_id: `c${(base + i - 1) >> 1}`, command: 'id', exit_code: 0 })
    else if (k === 2) add(`q${base + i}`, ts, 'scanner', { subtype: 'http_request_start', flow_id: `f${(base + i) % 5}` }, { tier: 'logged' })
    else if (k === 3) add(`r${base + i}`, ts, 'scanner', { subtype: 'http_response', flow_id: `f${(base + i) % 5}`, status: (base + i) % 3 }, { tier: 'logged' })
    else if (k === 4) add(`h${base + i}`, ts, 'shell', { subtype: 'session_start', terminalId: 't1' }) // housekeeping
    else if (k === 5) add(`t${base + i}`, ts, 'agent', { subtype: 'tool_result', agent: 'claude-code', session_id: 'conv', tool_use_id: `u${(base + i) % 4}`, output: String(base + i) })
    else add(`m${base + i}`, ts, 'marker', { title: `m${n++}` }, { project: (base + i) % 2 ? 'eng' : 'other' })
  }
}
/** Everything a page says except the cursor, whose request fingerprint
 *  legitimately differs between the two requests. */
const shape = (p: ActivityPage) => ({ items: p.items, totalGroups: p.totalGroups, totalMatches: p.totalMatches, hasMore: p.hasMore, snapshot: { ...p.snapshot, takenAt: 0 } })
function pages(req: ActivityRequest, late?: () => void): ActivityPage[] {
  const out: ActivityPage[] = []
  let page = queryActivityPage({ ...req, limit: 7 })
  late?.()
  for (;;) {
    out.push(page)
    if (!page.nextCursor) return out
    page = queryActivityPage({ ...req, limit: 7, cursor: page.nextCursor })
  }
}

describe('Activity grouping kept per Activity', () => {
  for (const excludeHousekeeping of [false, true]) {
    it(`answers exactly as the selection path does${excludeHousekeeping ? ' with housekeeping excluded' : ''}`, () => {
      seed(120)
      const fast = pages(request({ excludeHousekeeping }))
      const general = pages(request({ excludeHousekeeping, filter: EVERY_ROW }))
      expect(fast.length).toBeGreaterThan(3)
      expect(fast.map(shape)).toEqual(general.map(shape))
      // The fixture's session_start rows are housekeeping: excluding them must
      // drop their Activities, or this case compares nothing new.
      if (excludeHousekeeping) expect(fast[0].totalGroups).toBeLessThan(queryActivityPage(request()).totalGroups)
    })
  }

  for (const filter of [undefined, EVERY_ROW]) {
    it(`keeps frozen pages exact when Activities gain rows after the snapshot${filter ? ' (selection path)' : ''}`, () => {
      seed(80)
      // The reference is read before any late row exists, so nothing in it
      // went through the recompute of Activities changed after a snapshot.
      const before = pages(request({ filter }))
      // Late rows land in Activities already on later pages (tool u0..u3,
      // HTTP f0..f4) and add new ones; a read projects them.
      seed(40, 80)
      expect(queryActivityPage(request({ filter })).snapshot.chainedCount).toBeGreaterThan(before[0].snapshot.chainedCount)
      const frozen: ActivityPage[] = []
      let page = queryActivityPage({ ...request({ filter }), snapshot: before[0].snapshot, limit: 7 })
      for (;;) {
        frozen.push(page)
        if (!page.nextCursor) break
        page = queryActivityPage({ ...request({ filter }), limit: 7, cursor: page.nextCursor })
      }
      expect(frozen.length).toBeGreaterThan(3)
      expect(frozen.map(shape)).toEqual(before.map(shape))
    })
  }

  it('opens an Activity\'s members the same way on both paths', () => {
    seed(60)
    const page = queryActivityPage(request({ excludeHousekeeping: true }))
    for (const a of page.items.slice(0, 5)) {
      const fast = queryActivityMembers({ ...request({ excludeHousekeeping: true }), snapshot: page.snapshot, ref: a, matchesFirst: true, limit: 200 })
      const general = queryActivityMembers({ ...request({ excludeHousekeeping: true, filter: EVERY_ROW }), snapshot: page.snapshot, ref: a, matchesFirst: true, limit: 200 })
      expect({ ...fast, nextCursor: null }).toEqual({ ...general, nextCursor: null })
      expect(fast.sourceCount).toBe(a.sourceCount)
    }
  })

  it('keeps the projection through a failed read instead of re-projecting the project', () => {
    // A stale cursor, a body-index revision that moved under live capture, or
    // a project switch fails one read. That used to delete the whole derived
    // index, so the next read re-projected every row — 2.3 s at 80k rows.
    seed(30)
    const page = queryActivityPage(request({ limit: 5 }))
    const projected = (): number => (getReadonlyDB().prepare('SELECT COUNT(*) AS n FROM temp.activity_projection_v1').get() as { n: number }).n
    const held = projected()
    expect(held).toBeGreaterThan(0)
    seed(5, 30)
    expect(() => queryActivityPage(request({ limit: 5, cursor: 'not-a-cursor' }))).toThrow(/cursor/)
    expect(projected()).toBe(held)
    // The rows the failed read projected were rolled back with it; the next
    // read projects them again rather than skipping them.
    const next = queryActivityPage(request({ limit: 5 }))
    expect(projected()).toBe(held + 5)
    expect(next.totalGroups).toBeGreaterThan(page.totalGroups)
  })

  it('reads an unfiltered page without scanning or grouping the projection', () => {
    seed(50)
    queryActivityPage(request())
    seed(5, 50)
    const db = getReadonlyDB()
    const prepare = db.prepare.bind(db)
    const seen: Array<{ sql: string; args: unknown[] }> = []
    ;(db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = prepare(sql)
      if (!sql.includes('source_ids')) return stmt
      const all = stmt.all.bind(stmt)
      ;(stmt as unknown as { all: (...a: unknown[]) => unknown }).all = (...args: unknown[]) => { seen.push({ sql, args }); return all(...args) }
      return stmt
    }
    try {
      for (const excludeHousekeeping of [false, true]) queryActivityPage(request({ excludeHousekeeping }))
    } finally { (db as unknown as { prepare: unknown }).prepare = prepare }
    expect(seen).toHaveLength(2)
    for (const { sql, args } of seen) {
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map(r => r.detail)
      // Aliases of the projection in the page SQL: p, a, m, r, anchor, q.
      const scans = plan.filter(d => /^SCAN (p|a|m|r|anchor|q|projected)\b/.test(d))
      expect(scans, plan.join(' | ')).toEqual([])
      expect(plan.join(' | ')).not.toContain('MATERIALIZE projected')
    }
  })
})
