import { getDB, getReadonlyDB } from './index'
import type { EventCausalChain, EventCausalEdge, RedLogEvent } from './event-types'
import { rowToEvent } from './event-types'
import { _getCachedEventCount, _setCachedEventCount } from './event-write'
import {
  decodeCursor, buildPerArmCursorWhere, toQueryPage,
  TIER_RANK_CHAINED, TIER_RANK_LOGGED, CANONICAL_ORDER,
  type QueryPage, type CursorKey
} from '../query-page'
import type { ExportSnapshot } from '../export-plan'
import { evaluateScope, type ScopePolicy } from '../scope-evaluator'
import { searchHttpBodyEventIds } from '../http-body-index'
import type { ParsedQuery, QueryCondition } from '../query/contract'
import { toFtsMatch } from '../query/fts-match'

/** Operator-selected predicates shared by investigation surfaces. Scope rules
 * are attached by trusted main-process code when `inScopeOnly` is requested. */
export interface EventFilter {
  targetId?: string
  agentType?: string
  since?: number
  before?: number
  inScopeOnly?: boolean
  scope?: ScopePolicy
  hidePersonal?: boolean
  personalDomains?: string[]
  /** Spec 038: `chained` reads the chained tier only; absent reads both. */
  tier?: 'chained'
}

const scopeActive = (filter: EventFilter): boolean =>
  !!filter.inScopeOnly && !!filter.scope && (filter.scope.targets.length > 0 || filter.scope.excludeTargets.length > 0)
const personalActive = (filter: EventFilter): boolean =>
  !!filter.hidePersonal && !!filter.personalDomains?.length

/** The targets the scope and personal predicates decide over: every target
 *  in the project, or only those of `ids` when the rows are already named.
 *  Each target's decision is the same either way, so the answer for those
 *  rows is too. Spec 038: a check of 100 live rows scanned every target of
 *  the project, once per tier arm, which a busy second of batches could not
 *  afford (research R10). */
function candidateTargets(ids?: string[]): string[] {
  const db = getReadonlyDB()
  const named = ids ? ' AND id IN (SELECT value FROM json_each(?))' : ''
  const params = ids ? [JSON.stringify(ids), JSON.stringify(ids)] : []
  const rows = db.prepare(`
    SELECT target_id FROM events WHERE target_id IS NOT NULL AND target_id <> ''${named}
    UNION
    SELECT target_id FROM events_logged WHERE target_id IS NOT NULL AND target_id <> ''${named}
  `).all(...params) as Array<{ target_id: string }>
  return rows.map((row) => row.target_id)
}

function inScopeTargetIds(filter: EventFilter, candidates: string[]): string[] {
  const { targets, excludeTargets } = filter.scope ?? { targets: [], excludeTargets: [] }
  return candidates.filter((target) => {
    const decision = evaluateScope(target, { targets, excludeTargets })
    return decision.status === 'in-scope' || decision.status === 'no-scope'
  })
}

function personalTargetIds(filter: EventFilter, candidates: string[]): string[] {
  return candidates.filter((target) =>
    evaluateScope(target, { targets: [], excludeTargets: filter.personalDomains ?? [] }).status === 'excluded')
}

/** Scope and personal traffic over a target column: untargeted rows always
 *  pass. The tier arms apply it to rows, the HTTP flow page to flow heads. */
function appendTargetPolicy(
  filter: EventFilter, column: string, conditions: string[], params: unknown[], ids?: string[]
): void {
  const byScope = scopeActive(filter)
  const byPersonal = personalActive(filter)
  if (!byScope && !byPersonal) return
  const candidates = candidateTargets(ids)
  if (byScope) {
    conditions.push(`(${column} IS NULL OR ${column} = '' OR ${column} IN (SELECT value FROM json_each(?)))`)
    params.push(JSON.stringify(inScopeTargetIds(filter, candidates)))
  }
  const personal = byPersonal ? personalTargetIds(filter, candidates) : []
  if (personal.length) {
    conditions.push(`(${column} IS NULL OR ${column} = '' OR ${column} NOT IN (SELECT value FROM json_each(?)))`)
    params.push(JSON.stringify(personal))
  }
}

/** Target identity is `target_id`, compared lowercased (SPEC-target-identity):
 *  the Targets page groups `LOWER(target)`, so every filter has to match a
 *  target in any casing or the two counts part. NOCASE folds ASCII, which is
 *  what hostnames (IDN as punycode) and addresses are. The one place a target
 *  is compared, so no reader can compare it another way. */
export function targetPredicate(column: string): string {
  return `${column} = ? COLLATE NOCASE`
}

/** The one evaluator of the shared filter. `arm` is the tier whose SQL this
 *  is: a filter can exclude a whole tier, so a caller building both arms from
 *  one call could not express it. Required so that a new caller cannot forget.
 *  `ids`: the caller's WHERE already restricts the rows to these. */
function appendEventFilter(
  filter: EventFilter,
  conditions: string[],
  params: unknown[],
  arm: 'chained' | 'logged',
  alias = '',
  ids?: string[]
): void {
  const col = (name: string): string => alias ? `${alias}.${name}` : name
  // "Chained only" leaves the logged arm nothing. It is a predicate like the
  // rest, so the arm still runs and its count is an honest 0.
  if (filter.tier === 'chained' && arm === 'logged') conditions.push('0 = 1')
  if (filter.agentType) { conditions.push(`${col('agent_type')} = ?`); params.push(filter.agentType) }
  if (filter.since != null) { conditions.push(`${col('timestamp')} >= ?`); params.push(filter.since) }
  if (filter.before != null) { conditions.push(`${col('timestamp')} <= ?`); params.push(filter.before) }
  if (filter.targetId) { conditions.push(targetPredicate(col('target_id'))); params.push(filter.targetId) }
  appendTargetPolicy(filter, col('target_id'), conditions, params, ids)
}

// HOUSEKEEPING_SQL (below) hides RedLog's plumbing rows, which still land in
// the chain for audit integrity but are not the operator's activity. It is the
// one housekeeping rule: the Timeline's pages, counts and live admission all
// apply it here (spec 038), so no renderer copy can drift from it.
/**
 * What counts as the operator having DONE something, as opposed to the app
 * talking to itself.
 *
 * A new, positive predicate rather than a widening of HOUSEKEEPING_SQL, which
 * the Timeline mirrors — `system.ip_verdict` must stay visible there, and it is
 * exactly the row that makes the negative version useless here: the alert
 * runtime starts on every project open and the IP policy emits its first
 * verdict unconditionally (even offline, as `unknown`), so a chained
 * non-housekeeping row lands on a virgin project within seconds. Defining
 * evidence as "not housekeeping" would dismiss the first-run screen before
 * anything had been captured, and unlock a search page with nothing to find.
 *
 * `shell.session_end` is excluded for the same reason: a pty exiting, or an
 * orphaned session being recovered at startup, is the app tidying up.
 */
export const EVIDENCE_SQL = `
  agent_type NOT IN ('system', 'cleanup')
  AND NOT (agent_type = 'shell' AND subtype IN ('session_start','session_end'))
  AND NOT (agent_type = 'terminal' AND subtype = 'session_start')
  AND NOT (
    agent_type = 'shell' AND subtype IN ('command_start','command','command_end')
    AND (json_extract(data,'$.command') LIKE '%shell-bash-hook.sh%' OR json_extract(data,'$.command') LIKE '%shell-zsh-hook.zsh%' OR json_extract(data,'$.command') LIKE '%shell-hook.ps1%')
  )
`

/** The subtypes the HTTP history page actually renders. Exported so a caller
 *  asking "does this project have HTTP traffic" cannot drift from what that
 *  page queries and unlock an empty screen — `scanner:connection` is a scanner
 *  row and is NOT one of these. */
export const HTTP_FLOW_SUBTYPES = ['http_request_start', 'http_response'] as const

// Null-safe on purpose: the ingest stores a missing subtype as NULL, and
// `NOT (NULL)` is NULL, which a WHERE drops. Without the COALESCEs, a shell,
// system or terminal row with no subtype, or a command row with no command,
// was hidden as though it were housekeeping.
export const HOUSEKEEPING_SQL = `
  NOT (
    (agent_type = 'system' AND COALESCE(subtype, '') IN ('api_started','session_start'))
    OR (agent_type = 'shell' AND COALESCE(subtype, '') = 'session_start')
    OR (agent_type = 'terminal' AND COALESCE(subtype, '') = 'session_start')
    OR (agent_type = 'shell' AND COALESCE(subtype, '') IN ('command_start','command','command_end') AND (COALESCE(json_extract(data,'$.command'), '') LIKE '%shell-bash-hook.sh%' OR COALESCE(json_extract(data,'$.command'), '') LIKE '%shell-zsh-hook.zsh%' OR COALESCE(json_extract(data,'$.command'), '') LIKE '%shell-hook.ps1%'))
  )
`

/** `tier` here picks which arms run, a wider choice than the shared filter's
 *  "chained only", so it replaces that field rather than extending it. */
export interface EventQueryOptions extends Omit<EventFilter, 'tier'> {
  limit?: number
  since?: number
  // Time-range upper bound: return events strictly older than this wall-clock
  // timestamp. Pagination uses `beforeCreatedAt` because wall-clock time can
  // regress on NTP correction.
  before?: number
  // Preferred pager anchor — created_at is monotonic within a run (Date.now
  // at write instant, but callers can't rewind DB insertion order) so walking
  // strictly older rows works even under wall-clock backwards jump. v0.6.87
  // audit A1.
  beforeCreatedAt?: number
  // When true, drop RedLog's own housekeeping rows (api_started, shell
  // session_start, hook-source command_start) at the SQL
  // layer. Previously Timeline fetched 200 rows and filtered them to ~30
  // visible client-side, which meant the pager marked itself "all loaded"
  // when fewer than 200 came back — but the visible count was tiny.
  excludeHousekeeping?: boolean
  /** v0.13.0: which tier(s) to include. Default `all` — the operator's
   *  Timeline shows both tiers. `chained` is what the auditor view and
   *  the bundle verifier consume; `logged` is available for
   *  logged-tier-only queries (rare — mostly a debug affordance). */
  tier?: 'all' | 'chained' | 'logged'
  snapshot?: ExportSnapshot
}

export interface HttpFlowPage {
  items: RedLogEvent[]
  flowCount: number
  hasMore: boolean
  nextCursor: string | null
}

function encodeHttpFlowCursor(startTs: number, flowId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, startTs, flowId })).toString('base64url')
}

function decodeHttpFlowCursor(value?: string | null): { startTs: number; flowId: string } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Record<string, unknown>
    return parsed.v === 1 && Number.isSafeInteger(parsed.startTs) && typeof parsed.flowId === 'string'
      ? { startTs: parsed.startTs as number, flowId: parsed.flowId }
      : null
  } catch { return null }
}

/** Page complete HTTP flows, never individual rows. Shared time and target
 * predicates apply to the request start (or earliest surviving flow row when
 * capture began mid-flow); all request/response rows for selected flows return. */
export function queryHttpFlowPage(opts: EventFilter & { limit?: number; cursor?: string | null }): HttpFlowPage {
  // Flows are recorded in the logged tier only, so "chained only" leaves
  // this view nothing by construction (spec 038 FR-012); the panel says so.
  if (opts.tier === 'chained') return { items: [], flowCount: 0, hasMore: false, nextCursor: null }
  const db = getReadonlyDB()
  const limit = Math.max(1, opts.limit ?? 200)
  const cursor = decodeHttpFlowCursor(opts.cursor)
  const where: string[] = []
  const params: unknown[] = []
  if (opts.targetId) { where.push(targetPredicate('target_id')); params.push(opts.targetId) }
  if (opts.since != null) { where.push('start_ts >= ?'); params.push(opts.since) }
  if (opts.before != null) { where.push('start_ts <= ?'); params.push(opts.before) }
  appendTargetPolicy(opts, 'target_id', where, params)
  if (cursor) {
    where.push('(start_ts < ? OR (start_ts = ? AND flow_id < ?))')
    params.push(cursor.startTs, cursor.startTs, cursor.flowId)
  }
  const outerWhere = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const heads = db.prepare(`
    WITH flow_heads AS (
      SELECT json_extract(data, '$.flow_id') AS flow_id,
             COALESCE(
               MIN(CASE WHEN subtype = 'http_request_start' THEN timestamp END),
               MIN(timestamp)
             ) AS start_ts,
             COALESCE(
               MAX(CASE WHEN subtype = 'http_request_start' THEN target_id END),
               MAX(target_id)
             ) AS target_id
        FROM events_logged
       WHERE agent_type = 'scanner'
         AND subtype IN ('http_request_start', 'http_response')
         AND json_extract(data, '$.flow_id') IS NOT NULL
       GROUP BY json_extract(data, '$.flow_id')
    )
    SELECT flow_id, start_ts FROM flow_heads ${outerWhere}
    ORDER BY start_ts DESC, flow_id DESC LIMIT ?
  `).all(...params, limit + 1) as Array<{ flow_id: string; start_ts: number }>
  const hasMore = heads.length > limit
  const pageHeads = heads.slice(0, limit)
  if (pageHeads.length === 0) return { items: [], flowCount: 0, hasMore: false, nextCursor: null }
  const flowIds = pageHeads.map((row) => row.flow_id)
  const rows = db.prepare(`
    SELECT *, 'logged' AS tier FROM events_logged
     WHERE agent_type = 'scanner'
       AND subtype IN ('http_request_start', 'http_response')
       AND json_extract(data, '$.flow_id') IN (SELECT value FROM json_each(?))
     ORDER BY timestamp DESC, rowid DESC
  `).all(JSON.stringify(flowIds)) as Array<Record<string, unknown>>
  const last = pageHeads[pageHeads.length - 1]
  return {
    items: rows.map(rowToEvent),
    flowCount: pageHeads.length,
    hasMore,
    nextCursor: hasMore ? encodeHttpFlowCursor(last.start_ts, last.flow_id) : null
  }
}

export function queryEvents(opts: EventQueryOptions): RedLogEvent[] {
  // Heavy read: route through the cached read-only handle so a large timeline
  // scan doesn't serialise capture writes on the read-write connection.
  const db = getReadonlyDB()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.beforeCreatedAt) {
    conditions.push('created_at < ?')
    params.push(opts.beforeCreatedAt)
  }
  if (opts.excludeHousekeeping) {
    conditions.push(HOUSEKEEPING_SQL)
  }

  const limit = opts.limit ?? 200
  const tier = opts.tier ?? 'all'
  const snap = opts.snapshot

  // Per-arm WHERE: the shared filter for that tier, the shared conditions,
  // and an optional rowid upper bound from ExportSnapshot — ensures preview
  // and execute see the same dataset.
  const chainedConds: string[] = []
  const chainedParams: unknown[] = []
  const loggedConds: string[] = []
  const loggedParams: unknown[] = []
  const { tier: _arms, ...filterOpts } = opts
  appendEventFilter(filterOpts, chainedConds, chainedParams, 'chained')
  appendEventFilter(filterOpts, loggedConds, loggedParams, 'logged')
  chainedConds.push(...conditions)
  chainedParams.push(...params)
  loggedConds.push(...conditions)
  loggedParams.push(...params)
  if (snap) {
    chainedConds.push('rowid <= ?')
    chainedParams.push(snap.chainedMaxRowId)
    loggedConds.push('rowid <= ?')
    loggedParams.push(snap.loggedMaxRowId)
  }
  const chainedWhere = chainedConds.length ? `WHERE ${chainedConds.join(' AND ')}` : ''
  const loggedWhere = loggedConds.length ? `WHERE ${loggedConds.join(' AND ')}` : ''

  const chainedSelect = `
    SELECT rowid AS _row,
           id, timestamp, engagement_id, session_id, operator_id, agent_type,
           hostname, source_ip, target_id, data, hash, prev_hash, created_at,
           monotonic_ns, ntp_offset_ms, signature, 'chained' AS tier
    FROM events ${chainedWhere}
  `
  const loggedSelect = `
    SELECT rowid AS _row,
           id, timestamp, engagement_id, session_id, operator_id, agent_type,
           hostname, source_ip, target_id, data,
           NULL AS hash, NULL AS prev_hash, created_at,
           NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature,
           'logged' AS tier
    FROM events_logged ${loggedWhere}
  `

  let sql: string
  let bind: unknown[]
  if (tier === 'chained') {
    sql = `${chainedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?`
    bind = [...chainedParams, limit]
  } else if (tier === 'logged') {
    sql = `${loggedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?`
    bind = [...loggedParams, limit]
  } else {
    sql = `SELECT * FROM (
             SELECT * FROM (${chainedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?)
             UNION ALL
             SELECT * FROM (${loggedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?)
           ) ORDER BY timestamp DESC, _row DESC LIMIT ?`
    bind = [...chainedParams, limit, ...loggedParams, limit, limit]
  }

  const rows = db.prepare(sql).all(...bind) as Array<Record<string, unknown>>
  return rows.map(rowToEvent)
}

/** What a parsed query contributes to each tier's WHERE. Prepared once and
 *  shared by the page, the count and the id match, so none of them can read
 *  one query a second way. */
interface PreparedQuery {
  conditions: QueryCondition[]
  /** FTS MATCH expression for the free text, or null when there is none. */
  match: string | null
  /** Event ids whose indexed HTTP body matches the text, as JSON. */
  bodyIdsJson: string | null
  toolSession?: ToolSessionResolution
}

const isEmptyQuery = (parsed: ParsedQuery): boolean =>
  parsed.conditions.length === 0 && parsed.text.trim() === ''

function prepareQuery(db: ReturnType<typeof getReadonlyDB>, parsed: ParsedQuery): PreparedQuery {
  // A bare tool-use condition has to choose a session, because the id is
  // unique only within one. Choosing silently would let pair completion join
  // a call from one session to a result from another, so the choice and the
  // sessions not chosen both travel back with the page.
  let conditions = parsed.conditions
  let toolSession: ToolSessionResolution | undefined
  const tool = conditions.find((c) => c.field === 'tool')
  if (tool && !conditions.some((c) => c.field === 'session')) {
    const sessions = sessionsForToolUse(db, tool.value)
    if (sessions.length > 0) {
      const [chosen, ...others] = sessions
      toolSession = { toolUseId: tool.value, sessionId: chosen, otherSessionIds: others }
      conditions = [...conditions, { field: 'session', value: chosen }]
    }
  }
  const match = parsed.text.trim() ? toFtsMatch(parsed.text) : null
  const bodyIdsJson = match ? JSON.stringify(searchHttpBodyEventIds(parsed.text)) : null
  return { conditions, match, bodyIdsJson, ...(toolSession ? { toolSession } : {}) }
}

interface TierWhereInput {
  query?: PreparedQuery
  filter?: EventFilter
  cursor?: CursorKey | null
  excludeHousekeeping?: boolean
  /** Restrict evaluation to these event ids. */
  ids?: string[]
}

/** One tier's WHERE over the alias `e`, for every read that pages, counts or
 *  checks events against the shared filter and a query. */
function buildTierWhere(tier: 'chained' | 'logged', input: TierWhereInput): { where: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  const q = input.query
  if (q?.match) {
    const ftsTable = tier === 'chained' ? 'events_fts' : 'events_logged_fts'
    parts.push(`(e.rowid IN (SELECT rowid FROM ${ftsTable} WHERE ${ftsTable} MATCH ?)
                 OR e.id IN (SELECT value FROM json_each(?)))`)
    params.push(q.match, q.bodyIdsJson)
  }
  if (q) appendConditions(q.conditions, parts, params, tier)
  appendEventFilter(input.filter ?? {}, parts, params, tier, 'e', input.ids)
  if (input.excludeHousekeeping) parts.push(HOUSEKEEPING_SQL)
  if (input.ids) {
    parts.push('e.id IN (SELECT value FROM json_each(?))')
    params.push(JSON.stringify(input.ids))
  }
  if (input.cursor) {
    const c = buildPerArmCursorWhere(input.cursor, tier)
    parts.push(c.sql.replace(/\browid\b/g, 'e.rowid'))
    params.push(...c.params)
  }
  return { where: parts.length ? 'WHERE ' + parts.join(' AND ') : '', params }
}

/** Both tiers' rows through their own WHERE and per-arm limit, merged in
 *  canonical order and cut at `limit + 1` for `hasMore`. */
function queryTierPage(
  db: ReturnType<typeof getReadonlyDB>,
  chained: { where: string; params: unknown[] },
  logged: { where: string; params: unknown[] },
  limit: number
): QueryPage<RedLogEvent> {
  const perArmLimit = limit + 1
  const sql = `
    SELECT * FROM (
      SELECT * FROM (
        SELECT e.rowid AS _row,
               e.id, e.timestamp, e.engagement_id, e.session_id, e.operator_id, e.agent_type,
               e.hostname, e.source_ip, e.target_id, e.data, e.hash, e.prev_hash, e.created_at,
               e.monotonic_ns, e.ntp_offset_ms, e.signature,
               'chained' AS tier, ${TIER_RANK_CHAINED}
        FROM events e
        ${chained.where}
        ORDER BY e.timestamp DESC, e.rowid DESC
        LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT e.rowid AS _row,
               e.id, e.timestamp, e.engagement_id, e.session_id, e.operator_id, e.agent_type,
               e.hostname, e.source_ip, e.target_id, e.data,
               NULL AS hash, NULL AS prev_hash, e.created_at,
               NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature,
               'logged' AS tier, ${TIER_RANK_LOGGED}
        FROM events_logged e
        ${logged.where}
        ORDER BY e.timestamp DESC, e.rowid DESC
        LIMIT ?
      )
    ) ${CANONICAL_ORDER}
    LIMIT ?`

  // No catch. The query paths this replaced returned an empty page when their
  // statement threw, which made a failed query indistinguishable from an
  // engagement in which nothing matched — and only the second licenses "this
  // did not happen". The caller renders the failure; it is not this layer's
  // to hide.
  const rows = db.prepare(sql).all(
    ...chained.params, perArmLimit,
    ...logged.params, perArmLimit,
    limit + 1
  ) as Array<Record<string, unknown>>
  const page = toQueryPage(rows, limit, (row) => ({
    ts: row.timestamp as number,
    row: row._row as number,
    tier: row.tier as 'chained' | 'logged'
  }))
  return { ...page, items: page.items.map(rowToEvent) }
}

export function queryEventsPage(opts: EventFilter & {
  limit?: number
  cursor?: string | null
  /** Drop RedLog's own plumbing rows (`HOUSEKEEPING_SQL`), as the Timeline does. */
  excludeHousekeeping?: boolean
}): QueryPage<RedLogEvent> {
  const db = getReadonlyDB()
  const limit = opts.limit ?? 200
  const cursor: CursorKey | null = opts.cursor ? decodeCursor(opts.cursor) : null
  const input: TierWhereInput = { filter: opts, cursor, excludeHousekeeping: opts.excludeHousekeeping }
  return queryTierPage(db, buildTierWhere('chained', input), buildTierWhere('logged', input), limit)
}

export interface EventCountRequest {
  /** Omitted: count what the filter admits, as `queryEventsPage` pages it. */
  parsed?: ParsedQuery
  filter?: EventFilter
  /** Count strictly past this position, which is where the next page starts. */
  cursor?: string | null
  excludeHousekeeping?: boolean
}

/** How many rows the page query or the event query walks from `cursor` to
 *  the end, over the same predicates, so "N of M" and "K earlier" can never
 *  disagree with the rows they describe. */
export function countEvents(req: EventCountRequest): number {
  if (req.parsed && isEmptyQuery(req.parsed)) return 0
  const db = getReadonlyDB()
  let cursor: CursorKey | null = null
  if (req.cursor) {
    cursor = decodeCursor(req.cursor)
    // Counting from the start instead would report every row as "earlier".
    if (!cursor) throw new Error('countEvents: unreadable cursor')
  }
  const input: TierWhereInput = {
    query: req.parsed ? prepareQuery(db, req.parsed) : undefined,
    filter: req.filter,
    cursor,
    excludeHousekeeping: req.excludeHousekeeping
  }
  const chained = buildTierWhere('chained', input)
  const logged = buildTierWhere('logged', input)
  const row = db.prepare(`
    SELECT (SELECT COUNT(*) FROM events e ${chained.where})
         + (SELECT COUNT(*) FROM events_logged e ${logged.where}) AS n
  `).get(...chained.params, ...logged.params) as { n: number }
  return row.n
}

export const MATCH_EVENT_IDS_MAX = 1000

export interface EventMatchRequest {
  ids: string[]
  /** Omitted: check the filter only. */
  parsed?: ParsedQuery
  filter?: EventFilter
  excludeHousekeeping?: boolean
}

/** Which of `ids` the filter admits and, with `parsed`, the query matches, in
 *  input order. For surfaces that already hold rows and must dim or admit
 *  them by the same predicates a page would apply. */
export function matchEventIds(req: EventMatchRequest): string[] {
  // Refused, not truncated: a silently shortened answer would dim, or drop,
  // rows the caller never learns were not checked.
  if (req.ids.length > MATCH_EVENT_IDS_MAX) {
    throw new Error(`matchEventIds takes at most ${MATCH_EVENT_IDS_MAX} ids`)
  }
  if (req.ids.length === 0) return []
  if (req.parsed && isEmptyQuery(req.parsed)) return []
  const db = getReadonlyDB()
  const input: TierWhereInput = {
    query: req.parsed ? prepareQuery(db, req.parsed) : undefined,
    filter: req.filter,
    excludeHousekeeping: req.excludeHousekeeping,
    ids: req.ids
  }
  const chained = buildTierWhere('chained', input)
  const logged = buildTierWhere('logged', input)
  const rows = db.prepare(`
    SELECT e.id FROM events e ${chained.where}
    UNION
    SELECT e.id FROM events_logged e ${logged.where}
  `).all(...chained.params, ...logged.params) as Array<{ id: string }>
  const hit = new Set(rows.map((r) => r.id))
  return req.ids.filter((id) => hit.has(id))
}

export function queryScreenshotPage(opts: {
  limit?: number
  cursor?: string | null
  trigger?: string | null
}): QueryPage<RedLogEvent> {
  const db = getReadonlyDB()
  const limit = opts.limit ?? 100
  const cursor: CursorKey | null = opts.cursor ? decodeCursor(opts.cursor) : null

  const baseConds = ["agent_type = 'screenshot'"]
  const baseParams: unknown[] = []

  if (opts.trigger) {
    baseConds.push("json_extract(data, '$.trigger') = ?")
    baseParams.push(opts.trigger)
  }

  const chainedConds = [...baseConds]
  const loggedConds = [...baseConds]
  const chainedParams = [...baseParams]
  const loggedParams = [...baseParams]

  if (cursor) {
    const cc = buildPerArmCursorWhere(cursor, 'chained')
    chainedConds.push(cc.sql)
    chainedParams.push(...cc.params)

    const lc = buildPerArmCursorWhere(cursor, 'logged')
    loggedConds.push(lc.sql)
    loggedParams.push(...lc.params)
  }

  const perArmLimit = limit + 1

  const sql = `
    SELECT * FROM (
      SELECT * FROM (
        SELECT rowid AS _row,
               id, timestamp, engagement_id, session_id, operator_id, agent_type,
               hostname, source_ip, target_id, data, hash, prev_hash, created_at,
               monotonic_ns, ntp_offset_ms, signature,
               'chained' AS tier, ${TIER_RANK_CHAINED}
        FROM events
        WHERE ${chainedConds.join(' AND ')}
        ORDER BY timestamp DESC, rowid DESC
        LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT rowid AS _row,
               id, timestamp, engagement_id, session_id, operator_id, agent_type,
               hostname, source_ip, target_id, data,
               NULL AS hash, NULL AS prev_hash, created_at,
               NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature,
               'logged' AS tier, ${TIER_RANK_LOGGED}
        FROM events_logged
        WHERE ${loggedConds.join(' AND ')}
        ORDER BY timestamp DESC, rowid DESC
        LIMIT ?
      )
    ) ${CANONICAL_ORDER}
    LIMIT ?`

  const bind = [...chainedParams, perArmLimit, ...loggedParams, perArmLimit, limit + 1]
  const rows = db.prepare(sql).all(...bind) as Array<Record<string, unknown>>

  const page = toQueryPage(rows, limit, (row) => ({
    ts: row.timestamp as number,
    row: row._row as number,
    tier: row.tier as 'chained' | 'logged'
  }))

  return { ...page, items: page.items.map(rowToEvent) }
}

// v0.6.96 Bug-2: O(1)-ish lookup by event id. Prior code did
// `queryEvents({ limit: 5000 }).find(e => e.id === X)` for every replay /
// slice request — for events older than the newest 5000, the find returned
// undefined and the caller reported "event not found". The primary-key
// lookup on `id` is a hash index scan, ~µs regardless of table size.
//
// v0.13.0: check chained table first, then logged. Chained wins on the
// (impossible in practice) UUID collision — auditors get the chained
// answer when there's ambiguity.
export function queryEventById(id: string): RedLogEvent | null {
  const db = getDB()
  const chained = db.prepare('SELECT * FROM events WHERE id = ? LIMIT 1').get(id) as
    Record<string, unknown> | undefined
  if (chained) return rowToEvent({ ...chained, tier: 'chained' })
  const logged = db.prepare('SELECT * FROM events_logged WHERE id = ? LIMIT 1').get(id) as
    Record<string, unknown> | undefined
  return logged ? rowToEvent({ ...logged, tier: 'logged' }) : null
}

function eventCauses(event: RedLogEvent): string[] {
  const raw = (event.data as { _causes?: unknown })._causes
  return Array.isArray(raw)
    ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
}

function queryEventsByIds(ids: string[]): RedLogEvent[] {
  if (ids.length === 0) return []
  const db = getDB()
  const json = JSON.stringify(ids)
  const rows = db.prepare(`
    SELECT id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,
           hostname,source_ip,target_id,data,hash,prev_hash,created_at,
           monotonic_ns,ntp_offset_ms,signature,'chained' AS tier
    FROM events WHERE id IN (SELECT value FROM json_each(?))
    UNION ALL
    SELECT id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,
           hostname,source_ip,target_id,data,NULL AS hash,NULL AS prev_hash,created_at,
           NULL AS monotonic_ns,NULL AS ntp_offset_ms,NULL AS signature,'logged' AS tier
    FROM events_logged WHERE id IN (SELECT value FROM json_each(?))
  `).all(json, json) as Array<Record<string, unknown>>
  return rows.map(rowToEvent)
}

function queryEffectsOf(ids: string[], limit: number): { events: RedLogEvent[]; overflow: boolean } {
  if (ids.length === 0 || limit <= 0) return { events: [], overflow: false }
  const db = getDB()
  const json = JSON.stringify(ids)
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT e.id,e.timestamp,e.engagement_id,e.session_id,e.operator_id,e.agent_type,e.subtype,
             e.hostname,e.source_ip,e.target_id,e.data,e.hash,e.prev_hash,e.created_at,
             e.monotonic_ns,e.ntp_offset_ms,e.signature,'chained' AS tier
      FROM events e
      WHERE EXISTS (
        SELECT 1 FROM json_each(json_extract(e.data, '$._causes')) c
        WHERE c.type = 'text' AND c.value IN (SELECT value FROM json_each(?))
      )
      UNION ALL
      SELECT e.id,e.timestamp,e.engagement_id,e.session_id,e.operator_id,e.agent_type,e.subtype,
             e.hostname,e.source_ip,e.target_id,e.data,NULL AS hash,NULL AS prev_hash,e.created_at,
             NULL AS monotonic_ns,NULL AS ntp_offset_ms,NULL AS signature,'logged' AS tier
      FROM events_logged e
      WHERE EXISTS (
        SELECT 1 FROM json_each(json_extract(e.data, '$._causes')) c
        WHERE c.type = 'text' AND c.value IN (SELECT value FROM json_each(?))
      )
    ) ORDER BY timestamp, created_at, id LIMIT ?
  `).all(json, json, limit + 1) as Array<Record<string, unknown>>
  return { events: rows.slice(0, limit).map(rowToEvent), overflow: rows.length > limit }
}

function hasUnseenCausalNeighbor(
  frontier: RedLogEvent[],
  found: ReadonlyMap<string, RedLogEvent>,
  unavailable: Set<string>
): boolean {
  const parentIds = [...new Set(frontier.flatMap(eventCauses))].filter((id) => !found.has(id))
  const parents = queryEventsByIds(parentIds)
  const parentFound = new Set(parents.map((event) => event.id))
  for (const id of parentIds) if (!parentFound.has(id)) unavailable.add(id)
  if (parents.length > 0) return true

  // At most `found.size` rows can be already known. Asking for one more means
  // any reachable unseen effect must appear before the bound is exhausted.
  const effects = queryEffectsOf(frontier.map((event) => event.id), found.size + 1)
  return effects.overflow || effects.events.some((event) => !found.has(event.id))
}

/** Traverse the causal component around one event across both storage tiers.
 * The result is independent of Timeline pagination and deliberately ignores
 * list filters: hiding linked evidence would make provenance misleading. */
export function queryEventCausalChain(
  anchorId: string,
  opts: { maxDepth?: number; eventLimit?: number } = {}
): EventCausalChain {
  const maxDepth = Math.max(0, Math.min(50, Math.trunc(opts.maxDepth ?? 20)))
  const eventLimit = Math.max(1, Math.min(500, Math.trunc(opts.eventLimit ?? 200)))
  const anchor = queryEventById(anchorId)
  if (!anchor) return { anchorId, anchorFound: false, events: [], edges: [], unavailableCauseIds: [], truncated: false }

  const found = new Map<string, RedLogEvent>([[anchor.id, anchor]])
  const edgeMap = new Map<string, EventCausalEdge>()
  const unavailable = new Set<string>()
  let frontier = [anchor]
  let truncated = false

  for (let depth = 0; frontier.length > 0; depth++) {
    if (depth >= maxDepth) {
      truncated = hasUnseenCausalNeighbor(frontier, found, unavailable)
      break
    }
    const frontierIds = new Set(frontier.map((event) => event.id))
    const parentIds = new Set<string>()
    for (const effect of frontier) {
      for (const causeId of eventCauses(effect)) {
        edgeMap.set(`${causeId}\0${effect.id}`, { causeId, effectId: effect.id })
        if (!found.has(causeId)) parentIds.add(causeId)
      }
    }

    const remaining = eventLimit - found.size
    if (remaining <= 0) {
      truncated = hasUnseenCausalNeighbor(frontier, found, unavailable)
      break
    }
    const parents = queryEventsByIds([...parentIds])
    const parentFound = new Set(parents.map((event) => event.id))
    for (const id of parentIds) if (!parentFound.has(id)) unavailable.add(id)

    const roomAfterParents = Math.max(0, remaining - parents.length)
    const effects = queryEffectsOf([...frontierIds], roomAfterParents)
    if (parents.length > remaining || effects.overflow) truncated = true
    const candidates = [...parents, ...effects.events]
    const next: RedLogEvent[] = []
    for (const event of candidates) {
      for (const causeId of eventCauses(event)) {
        if (frontierIds.has(causeId) || found.has(causeId) || parentIds.has(causeId)) {
          edgeMap.set(`${causeId}\0${event.id}`, { causeId, effectId: event.id })
        }
      }
      if (found.has(event.id)) continue
      if (found.size >= eventLimit) { truncated = true; break }
      found.set(event.id, event)
      next.push(event)
    }
    frontier = next
    if (truncated && found.size >= eventLimit) break
  }

  const events = [...found.values()].sort((a, b) => a.timestamp - b.timestamp || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const visibleIds = new Set(events.map((event) => event.id))
  const edges = [...edgeMap.values()].filter((edge) => visibleIds.has(edge.effectId))
  return {
    anchorId,
    anchorFound: true,
    events,
    edges,
    unavailableCauseIds: [...unavailable].sort(),
    truncated
  }
}

/** Every amendment addressed at any of `markerIds`, oldest first.
 *
 *  Both tables are queried even though `marker` is chained and the logged arm is
 *  expected to come back empty: "which table is this type in" is a fact about
 *  today's classifier, and a reader that hard-codes it silently returns half an
 *  answer the day that changes. The union projects its tier literally because
 *  `rowToEvent` defaults a missing hint to `chained` — a logged row would
 *  otherwise arrive claiming a hash chain it was never part of.
 *
 *  `ORDER BY created_at, _row` is insertion order, not wall clock: the fold's
 *  "the latest correction wins" must mean the one written last, and wall clock
 *  regresses on an NTP correction. */
export function queryMarkerAmendments(markerIds: string[]): RedLogEvent[] {
  if (markerIds.length === 0) return []
  const db = getDB()
  const out: RedLogEvent[] = []
  // SQLITE_MAX_VARIABLE_NUMBER is 999 by default and the ids bind twice (once
  // per arm), so chunk well under half of it.
  for (let i = 0; i < markerIds.length; i += 400) {
    const chunk = markerIds.slice(i, i + 400)
    const holes = chunk.map(() => '?').join(',')
    const where = `WHERE agent_type = 'marker'
                     AND subtype = 'amended'
                     AND json_extract(data, '$.markerId') IN (${holes})`
    const chained = `
      SELECT rowid AS _row,
             id, timestamp, engagement_id, session_id, operator_id, agent_type,
             hostname, source_ip, target_id, data, hash, prev_hash, created_at,
             monotonic_ns, ntp_offset_ms, signature, 'chained' AS tier
      FROM events ${where}
    `
    const logged = `
      SELECT rowid AS _row,
             id, timestamp, engagement_id, session_id, operator_id, agent_type,
             hostname, source_ip, target_id, data,
             NULL AS hash, NULL AS prev_hash, created_at,
             NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature,
             'logged' AS tier
      FROM events_logged ${where}
    `
    const rows = db.prepare(
      `SELECT * FROM (${chained} UNION ALL ${logged}) ORDER BY created_at ASC, _row ASC`
    ).all(...chunk, ...chunk) as Array<Record<string, unknown>>
    for (const r of rows) out.push(rowToEvent(r))
  }
  return out
}

export function queryByFlowId(flowId: string): RedLogEvent[] {
  const db = getDB()
  const rows = db.prepare(
    `SELECT *, 'logged' AS tier FROM events_logged
     WHERE agent_type = 'scanner' AND json_extract(data, '$.flow_id') = ?
     ORDER BY timestamp ASC LIMIT 10`
  ).all(flowId) as Array<Record<string, unknown>>
  return rows.map(rowToEvent)
}

/** Count rows in the chained tier by default. The chain-anchor code path
 *  MUST see chained-only (that count sizes the head hash). v0.13.0 adds
 *  the `tier` option for renderer / capture-health callers that want the
 *  total or the logged-tier row count. */
export function getEventCount(opts?: { tier?: 'chained' | 'logged' | 'all' }): number {
  const tier = opts?.tier ?? 'chained'
  if (tier === 'chained') {
    const cached = _getCachedEventCount()
    if (cached !== null) return cached
    const db = getDB()
    const row = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }
    _setCachedEventCount(row.count)
    return row.count
  }
  const db = getDB()
  if (tier === 'logged') {
    const row = db.prepare('SELECT COUNT(*) as count FROM events_logged').get() as { count: number }
    return row.count
  }
  // 'all'
  const cached = _getCachedEventCount()
  const chained = cached !== null
    ? cached
    : (db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }).count
  const logged = (db.prepare('SELECT COUNT(*) as count FROM events_logged').get() as { count: number }).count
  return chained + logged
}

export function distinctAgentTypes(): string[] {
  const db = getReadonlyDB()
  const rows = db.prepare(
    `SELECT agent_type FROM (
       SELECT DISTINCT agent_type FROM events
       UNION
       SELECT DISTINCT agent_type FROM events_logged
     ) ORDER BY agent_type`
  ).all() as Array<{ agent_type: string }>
  return rows.map((r) => r.agent_type)
}

/** Secrets found, not detection events: one detection can hold several, and
 *  the Loot page counts each one. */
export function getLootCount(): number {
  const db = getReadonlyDB()
  const row = db.prepare(
    "SELECT COALESCE(SUM(json_array_length(data, '$.matches')), 0) as count FROM events WHERE agent_type = 'loot'"
  ).get() as { count: number }
  return row.count
}

// v0.14.3 §9.5: timestamp of the newest logged-tier row, or null if none.
// Powers the CaptureHealthCard "last fed …" freshness readout without pulling
// row bodies — a single SELECT MAX() against events_logged's timestamp index.
export function getLatestLoggedTs(): number | null {
  const db = getDB()
  const row = db.prepare('SELECT MAX(timestamp) as ts FROM events_logged').get() as { ts: number | null }
  return row.ts ?? null
}

export interface EventQueryRequest {
  parsed: ParsedQuery
  filter?: EventFilter
  limit?: number
  cursor?: string | null
  /** Drop RedLog's own plumbing rows, as the Timeline's pages do. */
  excludeHousekeeping?: boolean
}

/**
 * A tool-use ID is unique only within a session — `buildBlocks` has always
 * paired on `${session_id}:${tool_use_id}`. When the operator supplies no
 * session, one is chosen and reported, together with the sessions that were
 * not chosen, so the narrowing is visible rather than silent.
 */
export interface ToolSessionResolution {
  toolUseId: string
  sessionId: string
  otherSessionIds: string[]
}

export interface EventQueryResult extends QueryPage<RedLogEvent> {
  toolSession?: ToolSessionResolution
}

/**
 * Condition predicates, per tier. A condition resolves against its stored
 * field, never against text — `data` is one FTS blob, so an id quoted inside
 * unrelated output is findable there and would otherwise pass as an exact hit.
 */
function appendConditions(
  conditions: QueryCondition[],
  sqlParts: string[],
  params: unknown[],
  tier: 'chained' | 'logged'
): void {
  for (const c of conditions) {
    switch (c.field) {
      case 'event':
        sqlParts.push('e.id = ?')
        params.push(c.value)
        break
      case 'session':
        sqlParts.push("json_extract(e.data, '$.session_id') = ?")
        params.push(c.value)
        break
      case 'transcript':
        // `events` carries an indexed column; `events_logged` has no such
        // column, so the same value is read back out of `data` there.
        if (tier === 'chained') sqlParts.push('e.transcript_uuid = ?')
        else sqlParts.push("json_extract(e.data, '$.transcript_uuid') = ?")
        params.push(c.value)
        break
      case 'tool':
        sqlParts.push("json_extract(e.data, '$.tool_use_id') = ?")
        params.push(c.value)
        break
      case 'operator':
        sqlParts.push('e.operator_id = ?')
        params.push(c.value)
        break
    }
  }
}

/** Sessions containing a tool-use id, newest first. Two tiers, one statement. */
function sessionsForToolUse(db: ReturnType<typeof getReadonlyDB>, toolUseId: string): string[] {
  const rows = db.prepare(`
    SELECT session, MAX(ts) AS ts FROM (
      SELECT json_extract(data, '$.session_id') AS session, timestamp AS ts
      FROM events WHERE json_extract(data, '$.tool_use_id') = ?
      UNION ALL
      SELECT json_extract(data, '$.session_id') AS session, timestamp AS ts
      FROM events_logged WHERE json_extract(data, '$.tool_use_id') = ?
    )
    WHERE session IS NOT NULL
    GROUP BY session
    ORDER BY ts DESC`).all(toolUseId, toolUseId) as Array<{ session: string }>
  return rows.map((r) => r.session)
}

export function executeEventQuery(request: EventQueryRequest): EventQueryResult {
  // Nothing asked, nothing answered. A query with neither text nor conditions
  // would otherwise be an unfiltered read, and a surface that sent one by
  // accident — `""` parses to empty text — would present the whole dataset as
  // its results. A conditions-only query is still a query.
  if (request.parsed.conditions.length === 0 && request.parsed.text.trim() === '') {
    return { items: [], hasMore: false, nextCursor: null }
  }
  const db = getReadonlyDB()
  const limit = request.limit ?? 100
  const cursor: CursorKey | null = request.cursor ? decodeCursor(request.cursor) : null
  const query = prepareQuery(db, request.parsed)
  const input: TierWhereInput = {
    query, filter: request.filter, cursor, excludeHousekeeping: request.excludeHousekeeping
  }
  const page = queryTierPage(db, buildTierWhere('chained', input), buildTierWhere('logged', input), limit)
  return { ...page, ...(query.toolSession ? { toolSession: query.toolSession } : {}) }
}

/** Identifies one tool exchange. Unique only as a pair; see ToolSessionResolution. */
export interface ToolPairKey {
  sessionId: string
  toolUseId: string
}

/**
 * Spec 017: fetch the counterparts for every unpaired tool record on a page in
 * one pass. A page of the agent bucket holds up to 800 records, so completing
 * pairs one lookup at a time is N+1 against the store for a single scroll.
 */
export function fetchToolCounterparts(keys: ToolPairKey[]): RedLogEvent[] {
  if (keys.length === 0) return []
  const db = getReadonlyDB()

  // The keys travel as one JSON array and are joined against, so the statement
  // count is the same for fifty keys as for five. Matching on the two fields
  // separately rather than on a concatenation avoids inventing a separator
  // that an id could itself contain.
  const keysJson = JSON.stringify(keys.map((k) => ({ s: k.sessionId, t: k.toolUseId })))
  const arm = (table: string, extra: string): string => `
    SELECT e.rowid AS _row,
           e.id, e.timestamp, e.engagement_id, e.session_id, e.operator_id, e.agent_type,
           e.hostname, e.source_ip, e.target_id, e.data, ${extra}, e.created_at,
           '${table === 'events' ? 'chained' : 'logged'}' AS tier,
           ${table === 'events' ? TIER_RANK_CHAINED : TIER_RANK_LOGGED}
    FROM ${table} e
    JOIN json_each(?) k
      ON json_extract(k.value, '$.s') = json_extract(e.data, '$.session_id')
     AND json_extract(k.value, '$.t') = json_extract(e.data, '$.tool_use_id')`

  const rows = db.prepare(`
    SELECT * FROM (
      ${arm('events', 'e.hash, e.prev_hash, e.monotonic_ns, e.ntp_offset_ms, e.signature')}
      UNION ALL
      ${arm('events_logged', 'NULL AS hash, NULL AS prev_hash, NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature')}
    ) ${CANONICAL_ORDER}`).all(keysJson, keysJson) as Array<Record<string, unknown>>

  return rows.map(rowToEvent)
}
