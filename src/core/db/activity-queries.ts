import { readActivitySnapshot } from './dataset-snapshot'
import { bodySearchCoverage, type BodySearchCoverage } from '../http-body-index'
import { createHash } from 'node:crypto'
import { getReadonlyDB } from './index'
import { rowToEvent, type RedLogEvent } from './event-types'
import { compileEventSelection, HOUSEKEEPING_SQL } from './event-queries'
import { activityKey, activityId, activityClassification } from '../activity-projection'
import { QUERY_FIELDS, type ParsedQuery } from '../query/contract'
import { EVENT_TIER_RANK, eventOrderAfter, eventOrderBy, type EventOrderColumns } from '../event-order'
import type { ActivityRequest, ActivityPage, ActivityMembersRequest, ActivityMembersPage, ActivitySnapshot, ActivitySummary } from '../activity-contract'
import { compareCodeUnits } from '../code-unit-order'

const registered = new WeakSet<object>()
const indexed = new WeakMap<object, ActivitySnapshot>()
const PREVIEW = 20
const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => compareCodeUnits(a, b)).map(([k, v]) => [k, stable(v)]))
  return value
}
function validateParsed(parsed: ParsedQuery): void {
  if (!parsed || typeof parsed.text !== 'string' || !Array.isArray(parsed.conditions) || parsed.conditions.some(c => !c || !QUERY_FIELDS.includes(c.field) || typeof c.value !== 'string' || !c.value)) throw new Error('Invalid Activity query')
}
function register(): ReturnType<typeof getReadonlyDB> {
  const db = getReadonlyDB()
  if (!registered.has(db)) {
    // A row whose `data` is not an object has no activity key to compute. One
    // such row must not take the whole page with it: the projection is
    // read-only, the row is already in the chain, and failing the query
    // repairs nothing — an operator who cannot open Activity cannot see the
    // other 500 rows either. Treat the payload as empty and let the row fall
    // under its generic classification. The chain keeps the original bytes.
    const asObject = (raw: unknown): Record<string, unknown> => {
      try {
        const v = JSON.parse(String(raw)) as unknown
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
      } catch { return {} }
    }
    db.function('redlog_activity_key_v1', { deterministic: true }, (id, project, binding, agent, raw) => {
      const data = asObject(raw)
      const key = activityKey({ id: String(id), engagementId: String(project), sessionId: String(binding), agentType: String(agent), data })
      return `${JSON.parse(key)[1]}:${activityId(key)}`
    })
    db.function('redlog_activity_class_v1', { deterministic: true }, (agent, raw) => JSON.stringify(activityClassification({ agentType: String(agent), data: asObject(raw) })))
    db.function('redlog_activity_digest_v1', { deterministic: true }, raw => fingerprint(String(raw)))
    // Connection-local derived index. Closing a project drops it; original rows
    // and hashes are never changed, and no cache enters an evidence bundle.
    // `hk`: the row is RedLog plumbing (HOUSEKEEPING_SQL), so a browse that
    // excludes housekeeping counts it as context, never as a match.
    //
    // activity_groups_v1 holds each Activity's aggregates over every projected
    // row, kept current as rows are projected. Reading a page used to group
    // the whole projection on every call — O(project) per call, 1.3–1.7 s at
    // 80k rows on the main thread, and a burst of live capture queued behind
    // it. A page now reads this table, and recomputes from the projection only
    // the groups that gained rows after the request's snapshot, so a frozen
    // cursor page still sees exactly the rows of its snapshot.
    db.exec(`CREATE TEMP TABLE activity_projection_v1 (
      tier TEXT NOT NULL, _row INTEGER NOT NULL, id TEXT NOT NULL, engagement_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, ak TEXT NOT NULL, role TEXT NOT NULL, digest TEXT NOT NULL,
      classification TEXT NOT NULL, hk INTEGER NOT NULL, tier_rank INTEGER NOT NULL, PRIMARY KEY(tier,_row)
    ); CREATE INDEX activity_projection_key_v1 ON activity_projection_v1(ak,timestamp,_row,tier_rank); CREATE INDEX activity_projection_id_v1 ON activity_projection_v1(id);
    CREATE TEMP TABLE activity_groups_v1 (
      engagement_id TEXT NOT NULL, ak TEXT NOT NULL, source_count INTEGER NOT NULL, hk_count INTEGER NOT NULL,
      first_at INTEGER, last_at INTEGER, start_at INTEGER, sort_at INTEGER, has_begin INTEGER, has_result INTEGER,
      has_interrupted INTEGER, conflict INTEGER, anchor_id TEXT, PRIMARY KEY(engagement_id,ak)
    ); CREATE INDEX activity_groups_sort_v1 ON activity_groups_v1(engagement_id,sort_at DESC,ak DESC)`)
    registered.add(db)
  }
  return db
}

/** A groups cursor is (sort_at, ak), version 1. A members cursor is the last
 *  row's display-order position, version 2: version 1 stood on (timestamp, id),
 *  an order this build no longer reads in, so resuming from one could repeat
 *  or skip rows of that millisecond. It is refused instead. */
interface Cursor {
  v: 1 | 2; kind: 'groups' | 'members'; q: string; s: ActivitySnapshot; p: ParsedQuery; body: string
  ts: number; key: string; row?: number; tier?: 'chained' | 'logged'; matched?: number; toolSession?: ActivityPage['toolSession']
}
const CURSOR_VERSION = { groups: 1, members: 2 } as const
function decode(raw: string, kind: Cursor['kind'], q: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor
    if (c.v !== CURSOR_VERSION[kind] || c.kind !== kind || c.q !== q || !Number.isSafeInteger(c.ts) || typeof c.key !== 'string' || !c.s || typeof c.body !== 'string') throw new Error()
    if (kind === 'members' && (!Number.isSafeInteger(c.row) || (c.tier !== 'chained' && c.tier !== 'logged'))) throw new Error()
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
  sql: string; params: unknown[]; resolved: ParsedQuery; body: string; coverage: BodySearchCoverage | undefined; toolSession?: ActivityPage['toolSession']
} {
  const db = register(), q = requestKey(req, ref), cursor = req.cursor ? decode(req.cursor, kind, q) : null
  if (cursor && req.snapshot && fingerprint(req.snapshot) !== fingerprint(cursor.s)) throw new Error('Activity cursor snapshot changed')
  const boundary = readActivitySnapshot(db, cursor?.s ?? req.snapshot)
  const selection = compileEventSelection({ ...req, snapshot: boundary, parsed: cursor?.p ?? req.parsed })
  const bodyIds = selection.bodyMatchIds.length ? (db.prepare(`SELECT id FROM events WHERE rowid<=? AND id IN (SELECT value FROM json_each(?)) UNION SELECT id FROM events_logged WHERE rowid<=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(boundary.chainedMaxRowId, JSON.stringify(selection.bodyMatchIds), boundary.loggedMaxRowId, JSON.stringify(selection.bodyMatchIds)) as { id: string }[]).map(r => r.id) : []
  const coverage = req.parsed.text.trim() ? bodySearchCoverage(boundary, req.projectId, {parsed:selection.resolved,filter:req.filter}) : undefined
  const body = fingerprint([bodyIds, coverage?.revision ?? null])
  if (cursor && cursor.body !== body) throw new Error('Activity search index coverage changed; refresh the query')
  return { db, boundary, cursor, q, sql: selection.sql, params: selection.params, resolved: selection.resolved, body, coverage, toolSession: cursor?.toolSession ?? selection.toolSession }
}
const PROJECTION = 'temp.activity_projection_v1'
/** A projected row inside the request's dataset snapshot. */
const within = (alias: string): string =>
  `((${alias}.tier='chained' AND ${alias}._row<=@bc) OR (${alias}.tier='logged' AND ${alias}._row<=@bl))`
/** The display order (core/event-order) over a projected row. `tier_rank` is
 *  stored so the key index serves the whole order without a sort. */
const order = (alias: string): EventOrderColumns =>
  ({ timestamp: `${alias}.timestamp`, row: `${alias}._row`, tierRank: `${alias}.tier_rank` })
/** Every aggregate an Activity row shows, over the projected rows `where`
 *  admits, grouped per project and key. The anchor is the earliest Call (or
 *  the earliest row when there is no Call), first in display order on a tie. */
function groupStatsSql(where: string): string {
  return `SELECT s.*,COALESCE(s.start_at,s.first_at) AS sort_at,
    (SELECT a.id FROM ${PROJECTION} a WHERE a.ak=s.ak AND a.engagement_id=s.engagement_id
      AND a.timestamp=COALESCE(s.start_at,s.first_at) AND (s.has_begin=0 OR a.role='begin') AND ${within('a')}
      ORDER BY ${eventOrderBy('ASC', order('a'))} LIMIT 1) AS anchor_id
    FROM (SELECT p.engagement_id,p.ak,COUNT(*) AS source_count,SUM(p.hk) AS hk_count,
      MIN(p.timestamp) AS first_at,MAX(p.timestamp) AS last_at,
      MIN(CASE WHEN p.role='begin' THEN p.timestamp END) AS start_at,
      MAX(p.role='begin') AS has_begin,MAX(p.role='result') AS has_result,MAX(p.role='interrupted') AS has_interrupted,
      CASE WHEN MIN(CASE WHEN p.role='begin' THEN p.digest END)<>MAX(CASE WHEN p.role='begin' THEN p.digest END)
        OR MIN(CASE WHEN p.role IN ('result','interrupted') THEN p.digest END)<>MAX(CASE WHEN p.role IN ('result','interrupted') THEN p.digest END) THEN 1 ELSE 0 END AS conflict
      FROM ${PROJECTION} p WHERE ${where} GROUP BY p.engagement_id,p.ak) s`
}
const GROUP_COLUMNS = 'engagement_id,ak,source_count,hk_count,first_at,last_at,start_at,has_begin,has_result,has_interrupted,conflict,sort_at,anchor_id'

function syncProjection(db: ReturnType<typeof getReadonlyDB>): void {
  const before = indexed.get(db)
  let boundary: ActivitySnapshot
  try {
    if (before) readActivitySnapshot(db, before)
    boundary = readActivitySnapshot(db)
  } catch {
    // Retention can remove/reuse rowids; discard this derived index rather
    // than attaching a replacement row to a stale Activity.
    clearProjection(db)
    boundary = readActivitySnapshot(db)
  }
  const prior = indexed.get(db)
  const oldChained = prior?.chainedMaxRowId ?? 0, oldLogged = prior?.loggedMaxRowId ?? 0
  let grew = false
  for (const [table, tier, max, oldMax] of [
    ['events', 'chained', boundary.chainedMaxRowId, oldChained],
    ['events_logged', 'logged', boundary.loggedMaxRowId, oldLogged]
  ] as const) {
    if (max <= oldMax) continue
    grew = true
    db.prepare(`WITH keyed AS MATERIALIZED (
      SELECT e.*,redlog_activity_key_v1(id,engagement_id,session_id,agent_type,data) AS ak,e.rowid AS _row,
        CASE WHEN ${HOUSEKEEPING_SQL} THEN 0 ELSE 1 END AS hk
      FROM ${table} e WHERE rowid>? AND rowid<=?
    ) INSERT INTO ${PROJECTION}
      SELECT ?,_row,id,engagement_id,timestamp,ak,
        CASE WHEN substr(ak,1,6)='event:' THEN 'member'
          WHEN subtype IN ('command_start','tool_call','http_request_start') THEN 'begin'
          WHEN subtype IN ('command_end','tool_result','http_response','http_error') THEN 'result'
          WHEN subtype='tool_interrupted' THEN 'interrupted' ELSE 'member' END,
        redlog_activity_digest_v1(data),redlog_activity_class_v1(agent_type,data),hk,? FROM keyed`).run(oldMax, max, tier, EVENT_TIER_RANK[tier])
  }
  // Re-aggregate only the Activities that gained a row: the work is the new
  // rows and their groups, not the project.
  if (grew) db.prepare(`INSERT OR REPLACE INTO temp.activity_groups_v1 (${GROUP_COLUMNS})
    SELECT ${GROUP_COLUMNS} FROM (${groupStatsSql(`p.ak IN (SELECT ak FROM ${PROJECTION} WHERE (tier='chained' AND _row>@oc) OR (tier='logged' AND _row>@ol))`)})`)
    .run({ oc: oldChained, ol: oldLogged, bc: boundary.chainedMaxRowId, bl: boundary.loggedMaxRowId })
  indexed.set(db, boundary)
}
function clearProjection(db: ReturnType<typeof getReadonlyDB>): void {
  indexed.delete(db)
  db.exec(`DELETE FROM ${PROJECTION}; DELETE FROM temp.activity_groups_v1`)
}
function sourceEvent(db: ReturnType<typeof getReadonlyDB>, row: Record<string, unknown>): RedLogEvent {
  const table = row.tier === 'logged' ? 'events_logged' : 'events'
  return rowToEvent({ ...(db.prepare(`SELECT * FROM ${table} WHERE rowid=? AND id=?`).get(row._row, row.id) as Record<string, unknown>), tier: row.tier })
}
/** The paired command_end's exit code, for the list row. Only shell commands:
 * a tool_result or http_response has no exit code to show. */
function commandResult(db: ReturnType<typeof getReadonlyDB>, row: Record<string, unknown>, key: string): { exitCode: number | null } | null {
  if (JSON.parse(key)[1] !== 'command' || typeof row.result_id !== 'string') return null
  const hit = db.prepare(`SELECT tier,_row,id FROM ${PROJECTION} WHERE id=? LIMIT 1`).get(row.result_id) as Record<string, unknown> | undefined
  if (!hit) return null
  const end = sourceEvent(db, hit)
  const code = end.data?.exit_code
  const n = typeof code === 'number' ? code : typeof code === 'string' && /^-?\d+$/.test(code) ? Number(code) : NaN
  return { exitCode: Number.isFinite(n) ? n : null }
}

/** Which rows of the snapshot match. With no query and no Event filter every
 *  row matches (or every non-housekeeping row), and the per-group counts
 *  already held are the answer; anything else runs the shared selection. */
type MatchMode = 'all' | 'visible' | 'query'
function matchMode(req: ActivityRequest, s: ReturnType<typeof setup>): MatchMode {
  const f = req.filter ?? {}
  const plain = s.resolved.text === '' && s.resolved.conditions.length === 0 && !s.toolSession
    && !f.targetId && !f.agentType && f.since == null && f.before == null && !f.tier && !f.inScopeOnly && !f.hidePersonal
  return !plain ? 'query' : req.excludeHousekeeping ? 'visible' : 'all'
}
function matchedRow(mode: MatchMode, alias: string): string {
  return mode === 'all' ? '1' : mode === 'visible' ? `(${alias}.hk=0)` : `(${alias}.id IN (SELECT id FROM hit_ids))`
}
interface Built { sql: string; params: unknown[]; named: Record<string, unknown>; mode: MatchMode }
function ctes(req: ActivityRequest, s: ReturnType<typeof setup>, only?: string): Built {
  syncProjection(s.db)
  const mode = matchMode(req, s)
  const onlyGroup = only === undefined ? '' : ' AND ak=@only'
  const onlyRow = only === undefined ? '' : ' AND p.ak=@only'
  const preds = activityPredicates(req)
  const matched = mode === 'all' ? 'SELECT g.*,g.source_count AS matched_count FROM gstats g'
    : mode === 'visible' ? 'SELECT g.*,g.source_count-g.hk_count AS matched_count FROM gstats g'
      : 'SELECT g.*,h.n AS matched_count FROM gstats g JOIN hits h ON h.ak=g.ak'
  const sql = `WITH ${mode === 'query' ? `hit_ids AS MATERIALIZED (${s.sql}),
  hits AS MATERIALIZED (SELECT p.ak,COUNT(*) AS n FROM hit_ids h JOIN ${PROJECTION} p ON p.id=h.id
    WHERE p.engagement_id=@eng AND ${within('p')}${onlyRow} GROUP BY p.ak),` : ''}
  dirty AS MATERIALIZED (SELECT DISTINCT ak FROM ${PROJECTION} WHERE (tier='chained' AND _row>@bc) OR (tier='logged' AND _row>@bl)),
  gstats AS (
    SELECT ${GROUP_COLUMNS} FROM temp.activity_groups_v1 WHERE engagement_id=@eng${onlyGroup} AND ak NOT IN (SELECT ak FROM dirty)
    UNION ALL
    SELECT ${GROUP_COLUMNS} FROM (${groupStatsSql(`p.engagement_id=@eng AND p.ak IN (SELECT ak FROM dirty) AND ${within('p')}${onlyRow}`)})
  ), matched AS (${matched}),
  states AS (SELECT *,CASE WHEN conflict=1 THEN 'conflicted' WHEN has_interrupted=1 THEN 'interrupted'
    WHEN has_begin=1 AND has_result=1 THEN 'paired' WHEN has_begin=1 THEN 'call-only'
    WHEN has_result=1 THEN 'result-only' ELSE 'unknown' END AS pairing_state FROM matched WHERE matched_count>0),
  filtered AS (${preds.params.length
    ? `SELECT g.* FROM states g JOIN ${PROJECTION} p ON p.id=g.anchor_id AND p.engagement_id=@eng AND ${within('p')} WHERE ${preds.sql}`
    : 'SELECT * FROM states'})`
  return {
    sql, mode,
    params: [...(mode === 'query' ? s.params : []), ...preds.params],
    named: { eng: req.projectId, bc: s.boundary.chainedMaxRowId, bl: s.boundary.loggedMaxRowId, ...(only === undefined ? {} : { only }) }
  }
}
function activityPredicates(req: ActivityRequest): { sql: string; params: unknown[] } {
  const af = req.activityFilter ?? {}, where: string[] = [], params: unknown[] = []
  const columns: Record<string, string> = { actions: "json_extract(p.classification,'$.action')", providers: "json_extract(p.classification,'$.provider')", sessions: "json_extract(p.classification,'$.sourceSession')", toolActions: "json_extract(p.classification,'$.toolAction')", states: 'g.pairing_state' }
  for (const [name, values] of Object.entries(af)) if (values?.length) { where.push(`${columns[name]} IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(values)) }
  return { sql: where.join(' AND ') || '1=1', params }
}
function pageLimit(value: number | undefined, max: number): number {
  const n = value ?? 50
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`Activity page limit must be 1–${max}`)
  return n
}

function readActivity<T>(db: ReturnType<typeof getReadonlyDB>, read: () => T): T {
  const mark = indexed.get(db)
  try { return db.transaction(read)() }
  catch (error) {
    // A failed read rolls back its TEMP writes, which returns the projection
    // and the group table to what they held before it. Return the in-memory
    // high-water mark to the same point. Discarding the whole index here made
    // every stale cursor or moved body-index revision re-project the project.
    if (mark) indexed.set(db, mark)
    else indexed.delete(db)
    throw error
  }
}

export function queryActivityPage(request: ActivityRequest): ActivityPage {
  const db = register()
  return readActivity(db, () => {
    const limit = pageLimit(request.limit, 100), s = setup(request, 'groups'), c = ctes(request, s)
    const past = s.cursor ? 'WHERE (sort_at < @cts OR (sort_at=@cts AND ak < @ckey))' : ''
    const rows = db.prepare(`${c.sql}, counted AS (SELECT *,COUNT(*) OVER() AS total_groups,SUM(matched_count) OVER() AS total_matches FROM filtered)
      ,paged AS (SELECT * FROM counted ${past} ORDER BY sort_at DESC,ak DESC LIMIT @lim)
      SELECT paged.*,anchor.*,
      (SELECT json_group_array(id) FROM (SELECT p.id FROM ${PROJECTION} p WHERE p.ak=paged.ak AND p.engagement_id=@eng AND ${within('p')} ORDER BY ${eventOrderBy('ASC', order('p'))} LIMIT ${PREVIEW})) AS source_ids,
      (SELECT json_group_array(id) FROM (SELECT m.id FROM ${PROJECTION} m WHERE m.ak=paged.ak AND m.engagement_id=@eng AND ${within('m')} AND ${matchedRow(c.mode, 'm')} ORDER BY ${eventOrderBy('ASC', order('m'))} LIMIT ${PREVIEW})) AS matched_ids,
      (SELECT r.id FROM ${PROJECTION} r WHERE r.ak=paged.ak AND r.engagement_id=@eng AND ${within('r')} AND r.role='result' ORDER BY ${eventOrderBy('DESC', order('r'))} LIMIT 1) AS result_id
      FROM paged JOIN ${PROJECTION} anchor ON anchor.id=paged.anchor_id AND anchor.engagement_id=@eng AND ${within('anchor')} ORDER BY paged.sort_at DESC,paged.ak DESC`)
      .all(...c.params, { ...c.named, lim: limit + 1, ...(s.cursor ? { cts: s.cursor.ts, ckey: s.cursor.key } : {}) }) as Array<Record<string, unknown>>
    if (!rows.length && s.cursor) throw new Error('Activity cursor no longer references a page')
    const hasMore = rows.length > limit
    const picked = rows.slice(0, limit)
    const items: ActivitySummary[] = picked.map(row => {
      const anchor = sourceEvent(db, row), key = activityKey(anchor), sourceIds = JSON.parse(String(row.source_ids)) as string[], matchedIds = JSON.parse(String(row.matched_ids)) as string[]
      const result = commandResult(db, row, key)
      return {
        id: activityId(key), key, projectId: request.projectId, kind: JSON.parse(key)[1], state: row.pairing_state, ...activityClassification(anchor), anchor,
        firstAt: row.first_at, lastAt: row.last_at, matchedCount: row.matched_count, sourceCount: row.source_count, contextCount: Number(row.source_count) - Number(row.matched_count),
        sourcePreview: { ids: sourceIds, hasMore: Number(row.source_count) > sourceIds.length }, matchedPreview: { ids: matchedIds, hasMore: Number(row.matched_count) > matchedIds.length },
        ...(result ? { result } : {})
      } as ActivitySummary
    })
    const last = picked.at(-1)
    const nextCursor = hasMore && last ? encode({ v: CURSOR_VERSION.groups, kind: 'groups', q: s.q, s: s.boundary, p: s.resolved, body: s.body, ts: Number(last.sort_at), key: String(last.ak), toolSession: s.toolSession }) : null
    return { items, hasMore, nextCursor, bodyCoverage: s.coverage, totalGroups: Number(rows[0]?.total_groups ?? 0), totalMatches: Number(rows[0]?.total_matches ?? 0), snapshot: s.boundary, ...(s.toolSession ? { toolSession: s.toolSession } : {}) }
  })
}

export function queryActivityMembers(request: ActivityMembersRequest): ActivityMembersPage {
  const db = register()
  return readActivity(db, () => {
    if (!request.snapshot) throw new Error('Activity source context requires the confirmed snapshot')
    if (!request.ref || request.ref.projectId !== request.projectId || typeof request.ref.key !== 'string' || request.ref.id !== activityId(request.ref.key)) throw new Error('Invalid Activity source reference')
    const limit = pageLimit(request.limit, 200), s = setup(request, 'members', `${request.ref.id}:${request.matchesFirst === true}`)
    const c = ctes(request, s, `${JSON.parse(request.ref.key)[1]}:${request.ref.id}`)
    const byMatch = request.matchesFirst === true
    if (byMatch && s.cursor && ![0, 1].includes(s.cursor.matched!)) throw new Error('Invalid Activity source cursor')
    const after = eventOrderAfter('ASC', order('p'), { timestamp: '@cts', row: '@crow', tierRank: '@crank' })
    const past = s.cursor ? byMatch ? `AND (p.matched<@cm OR (p.matched=@cm AND ${after}))` : `AND ${after}` : ''
    const rows = db.prepare(`${c.sql} SELECT p.*,f.source_count,f.matched_count
      FROM (SELECT q.*,${matchedRow(c.mode, 'q')} AS matched FROM ${PROJECTION} q WHERE q.ak=@only AND q.engagement_id=@eng AND ${within('q')}) p
      JOIN filtered f ON f.ak=p.ak
      WHERE 1=1 ${past} ORDER BY ${byMatch ? 'p.matched DESC,' : ''}${eventOrderBy('ASC', order('p'))} LIMIT @lim`)
      .all(...c.params, { ...c.named, lim: limit + 1, ...(s.cursor ? { cts: s.cursor.ts, crow: s.cursor.row, crank: EVENT_TIER_RANK[s.cursor.tier!], ...(byMatch ? { cm: s.cursor.matched } : {}) } : {}) }) as Array<Record<string, unknown>>
    if (!rows.length) throw new Error('Activity source unavailable in this query snapshot')
    const hasMore = rows.length > limit, picked = rows.slice(0, limit), last = picked.at(-1)!
    return {
      items: picked.map(row => ({ event: sourceEvent(db, row), matched: row.matched === 1 })), hasMore,
      nextCursor: hasMore ? encode({ v: CURSOR_VERSION.members, kind: 'members', matched: Number(last.matched), q: s.q, s: s.boundary, p: s.resolved, body: s.body, ts: Number(last.timestamp), key: String(last.id), row: Number(last._row), tier: last.tier as 'chained' | 'logged', toolSession: s.toolSession }) : null,
      sourceCount: Number(rows[0].source_count), matchedCount: Number(rows[0].matched_count), snapshot: s.boundary
    }
  })
}
