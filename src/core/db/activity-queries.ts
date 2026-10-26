import { createHash } from 'node:crypto'
import { getReadonlyDB } from './index'
import { rowToEvent, type RedLogEvent } from './event-types'
import { compileEventSelection } from './event-queries'
import { activityKey, activityId, activityClassification } from '../activity-projection'
import { QUERY_FIELDS, type ParsedQuery } from '../query/contract'
import type { ActivityRequest, ActivityPage, ActivityMembersRequest, ActivityMembersPage, ActivitySnapshot, ActivitySummary } from '../activity-contract'

const registered = new WeakSet<object>()
const indexed = new WeakMap<object, ActivitySnapshot>()
const PREVIEW = 20
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]))
  return value
}
function validateParsed(parsed: ParsedQuery): void {
  if (!parsed || typeof parsed.text !== 'string' || !Array.isArray(parsed.conditions) || parsed.conditions.some(c => !c || !QUERY_FIELDS.includes(c.field) || typeof c.value !== 'string' || !c.value)) throw new Error('Invalid Activity query')
}
function register(): ReturnType<typeof getReadonlyDB> {
  const db = getReadonlyDB()
  if (!registered.has(db)) {
    db.function('redlog_activity_key_v1', { deterministic: true }, (id, project, binding, agent, raw) => {
      const data = JSON.parse(String(raw)) as Record<string, unknown>
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Event payload')
      const key = activityKey({ id: String(id), engagementId: String(project), sessionId: String(binding), agentType: String(agent), data })
      return `${JSON.parse(key)[1]}:${activityId(key)}`
    })
    db.function('redlog_activity_class_v1', { deterministic: true }, (agent, raw) => JSON.stringify(activityClassification({ agentType: String(agent), data: JSON.parse(String(raw)) as Record<string, unknown> })))
    db.function('redlog_activity_digest_v1', { deterministic: true }, raw => fingerprint(String(raw)))
    // Connection-local derived index. Closing a project drops it; original rows
    // and hashes are never changed, and no cache enters an evidence bundle.
    db.exec(`CREATE TEMP TABLE activity_projection_v1 (
      tier TEXT NOT NULL, _row INTEGER NOT NULL, id TEXT NOT NULL, engagement_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, ak TEXT NOT NULL, role TEXT NOT NULL, digest TEXT NOT NULL,
      classification TEXT NOT NULL, PRIMARY KEY(tier,_row)
    ); CREATE INDEX activity_projection_key_v1 ON activity_projection_v1(ak,timestamp,id); CREATE INDEX activity_projection_id_v1 ON activity_projection_v1(id)`)
    registered.add(db)
  }
  return db
}
function snapshot(db: ReturnType<typeof getReadonlyDB>, old?: ActivitySnapshot): ActivitySnapshot {
  if (old && (!Number.isSafeInteger(old.chainedMaxRowId) || old.chainedMaxRowId < 0 || !Number.isSafeInteger(old.loggedMaxRowId) || old.loggedMaxRowId < 0 || !Number.isFinite(old.takenAt))) throw new Error('Invalid Activity dataset snapshot')
  const read = (table: string, max?: number): { max: number; count: number; tail: string | null } => {
    const where = max == null ? '' : ' WHERE rowid <= ?'
    const row = db.prepare(`SELECT COALESCE(MAX(rowid),0) AS max,COUNT(*) AS count FROM ${table}${where}`).get(...(max == null ? [] : [max])) as { max: number; count: number }
    const tail = row.max ? (db.prepare(`SELECT id FROM ${table} WHERE rowid=?`).get(row.max) as { id: string }).id : null
    return { ...row, tail }
  }
  const chained = read('events', old?.chainedMaxRowId), logged = read('events_logged', old?.loggedMaxRowId)
  if (old && (chained.count !== old.chainedCount || logged.count !== old.loggedCount || chained.tail !== old.chainedTailId || logged.tail !== old.loggedTailId)) throw new Error('Activity dataset changed by retention; refresh the query')
  return old ?? { chainedMaxRowId: chained.max, loggedMaxRowId: logged.max, chainedCount: chained.count, loggedCount: logged.count, chainedTailId: chained.tail, loggedTailId: logged.tail, takenAt: Date.now() }
}
interface Cursor {
  v: 1; kind: 'groups' | 'members'; q: string; s: ActivitySnapshot; p: ParsedQuery; body: string
  ts: number; key: string; toolSession?: ActivityPage['toolSession']
}
function decode(raw: string, kind: Cursor['kind'], q: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor
    if (c.v !== 1 || c.kind !== kind || c.q !== q || !Number.isSafeInteger(c.ts) || typeof c.key !== 'string' || !c.s || typeof c.body !== 'string') throw new Error()
    validateParsed(c.p)
    return c
  } catch { throw new Error('Invalid Activity cursor or changed query/project') }
}
const encode = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url')
function requestKey(req: ActivityRequest, ref?: string): string {
  validateParsed(req.parsed)
  if (typeof req.projectId !== 'string' || !req.projectId) throw new Error('Activity query requires a project')
  const fields = ['targetId', 'agentType', 'since', 'before', 'inScopeOnly', 'scope', 'hidePersonal', 'personalDomains', 'tier']
  if (Object.keys(req.filter ?? {}).some(key => !fields.includes(key))) throw new Error('Unsupported Activity Event filter')
  const af = req.activityFilter ?? {}
  const supported = ['actions', 'providers', 'sessions', 'states', 'toolActions']
  if (Object.keys(af).some(key => !supported.includes(key)) || Object.values(af).some(value => !Array.isArray(value) || value.some(item => typeof item !== 'string' || !item))) throw new Error('Unsupported Activity filter')
  const enums: Record<string, readonly string[]> = {
    actions: ['command', 'network', 'conversation', 'evidence', 'security', 'system', 'other'],
    states: ['call-only', 'result-only', 'paired', 'interrupted', 'conflicted', 'unknown'],
    toolActions: ['execute', 'file-read', 'file-write', 'search', 'browse', 'custom', 'unknown']
  }
  for (const [name, values] of Object.entries(af)) {
    if (enums[name] && values?.some((value: string) => !enums[name].includes(value))) throw new Error('Unsupported Activity filter value')
  }
  return fingerprint(stable([req.projectId, req.parsed, req.filter ?? {}, af, req.excludeHousekeeping ?? false, ref ?? null]))
}
function setup(req: ActivityRequest, kind: Cursor['kind'], ref?: string): {
  db: ReturnType<typeof getReadonlyDB>; boundary: ActivitySnapshot; cursor: Cursor | null; q: string
  sql: string; params: unknown[]; resolved: ParsedQuery; body: string; toolSession?: ActivityPage['toolSession']
} {
  const db = register(), q = requestKey(req, ref), cursor = req.cursor ? decode(req.cursor, kind, q) : null
  if (cursor && req.snapshot && fingerprint(req.snapshot) !== fingerprint(cursor.s)) throw new Error('Activity cursor snapshot changed')
  const boundary = snapshot(db, cursor?.s ?? req.snapshot)
  const selection = compileEventSelection({ ...req, snapshot: boundary, parsed: cursor?.p ?? req.parsed })
  const bodyIds = selection.bodyMatchIds.length ? (db.prepare(`SELECT id FROM events WHERE rowid<=? AND id IN (SELECT value FROM json_each(?)) UNION SELECT id FROM events_logged WHERE rowid<=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(boundary.chainedMaxRowId, JSON.stringify(selection.bodyMatchIds), boundary.loggedMaxRowId, JSON.stringify(selection.bodyMatchIds)) as { id: string }[]).map(r => r.id) : []
  const body = fingerprint(bodyIds)
  if (cursor && cursor.body !== body) throw new Error('Activity search index coverage changed; refresh the query')
  return { db, boundary, cursor, q, sql: selection.sql, params: selection.params, resolved: selection.resolved, body, toolSession: cursor?.toolSession ?? selection.toolSession }
}
function syncProjection(db: ReturnType<typeof getReadonlyDB>): void {
  const before = indexed.get(db)
  let boundary: ActivitySnapshot
  try {
    if (before) snapshot(db, before)
    boundary = snapshot(db)
  } catch {
    // Retention can remove/reuse rowids; discard this derived index rather
    // than attaching a replacement row to a stale Activity.
    db.exec('DELETE FROM temp.activity_projection_v1')
    indexed.delete(db)
    boundary = snapshot(db)
  }
  const prior = indexed.get(db)
  for (const [table, tier, max, oldMax] of [
    ['events', 'chained', boundary.chainedMaxRowId, prior?.chainedMaxRowId ?? 0],
    ['events_logged', 'logged', boundary.loggedMaxRowId, prior?.loggedMaxRowId ?? 0]
  ] as const) {
    if (max <= oldMax) continue
    db.prepare(`WITH keyed AS MATERIALIZED (
      SELECT e.*,redlog_activity_key_v1(id,engagement_id,session_id,agent_type,data) AS ak,e.rowid AS _row
      FROM ${table} e WHERE rowid>? AND rowid<=?
    ) INSERT INTO temp.activity_projection_v1
      SELECT ?,_row,id,engagement_id,timestamp,ak,
        CASE WHEN substr(ak,1,6)='event:' THEN 'member'
          WHEN subtype IN ('command_start','tool_call','http_request_start') THEN 'begin'
          WHEN subtype IN ('command_end','tool_result','http_response','http_error') THEN 'result'
          WHEN subtype='tool_interrupted' THEN 'interrupted' ELSE 'member' END,
        redlog_activity_digest_v1(data),redlog_activity_class_v1(agent_type,data) FROM keyed`).run(oldMax, max, tier)
  }
  indexed.set(db, boundary)
}
function sourceEvent(db: ReturnType<typeof getReadonlyDB>, row: Record<string, unknown>): RedLogEvent {
  const table = row.tier === 'logged' ? 'events_logged' : 'events'
  return rowToEvent({ ...(db.prepare(`SELECT * FROM ${table} WHERE rowid=? AND id=?`).get(row._row, row.id) as Record<string, unknown>), tier: row.tier })
}
function ctes(req: ActivityRequest, s: ReturnType<typeof setup>): { sql: string; params: unknown[] } {
  syncProjection(s.db)
  const sql = `WITH hit_ids AS MATERIALIZED (${s.sql}), projected AS MATERIALIZED (
    SELECT p.*,h.id IS NOT NULL AS matched FROM temp.activity_projection_v1 p LEFT JOIN hit_ids h ON h.id=p.id
    WHERE p.engagement_id=? AND ((p.tier='chained' AND p._row<=?) OR (p.tier='logged' AND p._row<=?))
  ),
  grouped AS (
    SELECT p.ak,SUM(p.matched) AS matched_count,COUNT(*) AS source_count,
      MIN(p.timestamp) AS first_at,MAX(p.timestamp) AS last_at,
      MIN(CASE WHEN role='begin' THEN p.timestamp END) AS start_at,
      MAX(role='begin') AS has_begin,MAX(role='result') AS has_result,MAX(role='interrupted') AS has_interrupted,
      CASE WHEN MIN(CASE WHEN role='begin' THEN digest END)<>MAX(CASE WHEN role='begin' THEN digest END)
        OR MIN(CASE WHEN role IN ('result','interrupted') THEN digest END)<>MAX(CASE WHEN role IN ('result','interrupted') THEN digest END) THEN 1 ELSE 0 END AS conflict
    FROM projected p GROUP BY p.ak HAVING SUM(p.matched)>0
  ), anchors AS (
    SELECT g.*,MIN(p.id) AS anchor_id FROM grouped g JOIN projected p ON p.ak=g.ak
      AND p.timestamp=COALESCE(g.start_at,g.first_at) AND (g.has_begin=0 OR p.role='begin') GROUP BY g.ak
  ), states AS (SELECT *,CASE WHEN conflict=1 THEN 'conflicted' WHEN has_interrupted=1 THEN 'interrupted'
    WHEN has_begin=1 AND has_result=1 THEN 'paired' WHEN has_begin=1 THEN 'call-only'
    WHEN has_result=1 THEN 'result-only' ELSE 'unknown' END AS pairing_state FROM anchors),
  filtered AS (SELECT g.* FROM states g JOIN projected p ON p.id=g.anchor_id WHERE ${activityPredicates(req).sql})`
  return { sql, params: [...s.params, req.projectId, s.boundary.chainedMaxRowId, s.boundary.loggedMaxRowId, ...activityPredicates(req).params] }
}
function activityPredicates(req: ActivityRequest): { sql: string; params: unknown[] } {
  const af = req.activityFilter ?? {}, where: string[] = [], params: unknown[] = []
  const columns: Record<string, string> = { actions: "json_extract(classification,'$.action')", providers: "json_extract(classification,'$.provider')", sessions: "json_extract(classification,'$.sourceSession')", toolActions: "json_extract(classification,'$.toolAction')", states: 'pairing_state' }
  for (const [name, values] of Object.entries(af)) if (values?.length) { where.push(`${columns[name]} IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(values)) }
  return { sql: where.join(' AND ') || '1=1', params }
}
function pageLimit(value: number | undefined, max: number): number {
  const n = value ?? 50
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Activity page limit must be 1–${max}`)
  return n
}

function readActivity<T>(db: ReturnType<typeof getReadonlyDB>, read: () => T): T {
  try { return db.transaction(read)() }
  catch (error) {
    // A failed read rolls back TEMP inserts too. Never retain an in-memory
    // high-water mark for rows that SQLite rolled back.
    indexed.delete(db)
    db.exec('DELETE FROM temp.activity_projection_v1')
    throw error
  }
}

export function queryActivityPage(request: ActivityRequest): ActivityPage {
  const db = register()
  return readActivity(db, () => {
    const limit = pageLimit(request.limit, 100), s = setup(request, 'groups'), c = ctes(request, s)
    const past = s.cursor ? 'WHERE (sort_at < ? OR (sort_at=? AND ak < ?))' : ''
    const rows = db.prepare(`${c.sql}, counted AS (SELECT *,COALESCE(start_at,first_at) AS sort_at,COUNT(*) OVER() AS total_groups,SUM(matched_count) OVER() AS total_matches FROM filtered)
      ,paged AS (SELECT * FROM counted ${past} ORDER BY sort_at DESC,ak DESC LIMIT ?)
      SELECT paged.*,anchor.*,
      (SELECT json_group_array(id) FROM (SELECT p.id FROM projected p WHERE p.ak=paged.ak ORDER BY p.timestamp,p.id LIMIT ${PREVIEW})) AS source_ids,
      (SELECT json_group_array(id) FROM (SELECT m.id FROM projected m WHERE m.ak=paged.ak AND m.matched=1 ORDER BY m.timestamp,m.id LIMIT ${PREVIEW})) AS matched_ids
      FROM paged JOIN projected anchor ON anchor.id=paged.anchor_id ORDER BY paged.sort_at DESC,paged.ak DESC`).all(...c.params, ...(s.cursor ? [s.cursor.ts, s.cursor.ts, s.cursor.key] : []), limit + 1) as Array<Record<string, unknown>>
    if (!rows.length && s.cursor) throw new Error('Activity cursor no longer references a page')
    const hasMore = rows.length > limit
    const picked = rows.slice(0, limit)
    const items: ActivitySummary[] = picked.map(row => {
      const anchor = sourceEvent(db, row), key = activityKey(anchor), sourceIds = JSON.parse(String(row.source_ids)) as string[], matchedIds = JSON.parse(String(row.matched_ids)) as string[]
      return {
        id: activityId(key), key, projectId: request.projectId, kind: JSON.parse(key)[1], state: row.pairing_state, ...activityClassification(anchor), anchor,
        firstAt: row.first_at, lastAt: row.last_at, matchedCount: row.matched_count, sourceCount: row.source_count, contextCount: Number(row.source_count) - Number(row.matched_count),
        sourcePreview: { ids: sourceIds, hasMore: Number(row.source_count) > sourceIds.length }, matchedPreview: { ids: matchedIds, hasMore: Number(row.matched_count) > matchedIds.length }
      } as ActivitySummary
    })
    const last = picked.at(-1)
    const nextCursor = hasMore && last ? encode({ v: 1, kind: 'groups', q: s.q, s: s.boundary, p: s.resolved, body: s.body, ts: Number(last.sort_at), key: String(last.ak), toolSession: s.toolSession }) : null
    return { items, hasMore, nextCursor, totalGroups: Number(rows[0]?.total_groups ?? 0), totalMatches: Number(rows[0]?.total_matches ?? 0), snapshot: s.boundary, ...(s.toolSession ? { toolSession: s.toolSession } : {}) }
  })
}

export function queryActivityMembers(request: ActivityMembersRequest): ActivityMembersPage {
  const db = register()
  return readActivity(db, () => {
    if (!request.snapshot) throw new Error('Activity source context requires the confirmed snapshot')
    if (!request.ref || request.ref.projectId !== request.projectId || typeof request.ref.key !== 'string' || request.ref.id !== activityId(request.ref.key)) throw new Error('Invalid Activity source reference')
    const limit = pageLimit(request.limit, 200), s = setup(request, 'members', request.ref.id), c = ctes(request, s)
    const past = s.cursor ? 'AND (p.timestamp>? OR (p.timestamp=? AND p.id>?))' : ''
    const rows = db.prepare(`${c.sql} SELECT p.*,
      f.source_count,f.matched_count FROM projected p JOIN filtered f ON f.ak=p.ak
      WHERE p.ak=? ${past} ORDER BY p.timestamp,p.id LIMIT ?`).all(...c.params, `${JSON.parse(request.ref.key)[1]}:${request.ref.id}`, ...(s.cursor ? [s.cursor.ts, s.cursor.ts, s.cursor.key] : []), limit + 1) as Array<Record<string, unknown>>
    if (!rows.length) throw new Error('Activity source unavailable in this query snapshot')
    const hasMore = rows.length > limit, picked = rows.slice(0, limit), last = picked.at(-1)!
    return {
      items: picked.map(row => ({ event: sourceEvent(db, row), matched: row.matched === 1 })), hasMore,
      nextCursor: hasMore ? encode({ v: 1, kind: 'members', q: s.q, s: s.boundary, p: s.resolved, body: s.body, ts: Number(last.timestamp), key: String(last.id), toolSession: s.toolSession }) : null,
      sourceCount: Number(rows[0].source_count), matchedCount: Number(rows[0].matched_count), snapshot: s.boundary
    }
  })
}
