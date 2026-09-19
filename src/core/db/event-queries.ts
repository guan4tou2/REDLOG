import { getDB, getReadonlyDB } from './index'
import type { RedLogEvent } from './event-types'
import { rowToEvent } from './event-types'
import { _getCachedEventCount, _setCachedEventCount } from './event-write'

// SQL predicate that matches the renderer-side `isHousekeeping()` filter in
// Timeline.tsx. Kept in sync manually — both hide RedLog plumbing rows that
// still land in the chain (for audit integrity) but must not show up in the
// operator's view. Pushing this filter into SQL fixes the Load-More pager,
// which was fetching 200 rows and filtering to ~30 client-side, then setting
// `allLoaded=true` because <200 came back — operators saw an empty timeline
// with more history they couldn't reach.
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
    AND (json_extract(data,'$.command') LIKE '%shell-preexec-hook.sh%' OR json_extract(data,'$.command') LIKE '%shell-hook.ps1%')
  )
`

/** The subtypes the HTTP history page actually renders. Exported so a caller
 *  asking "does this project have HTTP traffic" cannot drift from what that
 *  page queries and unlock an empty screen — `scanner:connection` is a scanner
 *  row and is NOT one of these. */
export const HTTP_FLOW_SUBTYPES = ['http_request_start', 'http_response'] as const

const HOUSEKEEPING_SQL = `
  NOT (
    (agent_type = 'system' AND subtype IN ('api_started','session_start'))
    OR (agent_type = 'shell' AND subtype = 'session_start')
    OR (agent_type = 'terminal' AND subtype = 'session_start')
    OR (agent_type = 'shell' AND subtype IN ('command_start','command','command_end') AND (json_extract(data,'$.command') LIKE '%shell-preexec-hook.sh%' OR json_extract(data,'$.command') LIKE '%shell-hook.ps1%'))
  )
`

export function queryEvents(opts: {
  agentType?: string
  limit?: number
  since?: number
  // Pagination anchor: return events strictly older than this WALL-CLOCK
  // timestamp. Kept for compatibility but the Timeline pager now prefers
  // `beforeCreatedAt` because wall-clock can regress on NTP correction and
  // silently skip a newly-arrived event that landed with an older ts.
  before?: number
  // Preferred pager anchor — created_at is monotonic within a run (Date.now
  // at write instant, but callers can't rewind DB insertion order) so walking
  // strictly older rows works even under wall-clock backwards jump. v0.6.87
  // audit A1.
  beforeCreatedAt?: number
  targetId?: string
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
}): RedLogEvent[] {
  // Heavy read: route through the cached read-only handle so a large timeline
  // scan doesn't serialise capture writes on the read-write connection.
  const db = getReadonlyDB()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.agentType) {
    conditions.push('agent_type = ?')
    params.push(opts.agentType)
  }
  if (opts.since) {
    conditions.push('timestamp >= ?')
    params.push(opts.since)
  }
  if (opts.before) {
    conditions.push('timestamp < ?')
    params.push(opts.before)
  }
  if (opts.beforeCreatedAt) {
    conditions.push('created_at < ?')
    params.push(opts.beforeCreatedAt)
  }
  if (opts.targetId) {
    conditions.push('target_id = ?')
    params.push(opts.targetId)
  }
  if (opts.excludeHousekeeping) {
    conditions.push(HOUSEKEEPING_SQL)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ?? 200
  const tier = opts.tier ?? 'all'

  // v0.13.0: one SELECT per participating tier, UNION ALL, outer ORDER +
  // LIMIT. Both tables carry compatible shape for the columns we return
  // (hash/prev_hash/signature/monotonic_ns/ntp_offset_ms are NULL on
  // logged rows and typed on chained rows). Both `idx_events_ts` and
  // `idx_events_logged_ts` deliver rows already-ordered, so the outer
  // sort is a k-way merge over two sorted inputs.
  // `_row` (SQLite rowid) is a stable insertion-order tie-breaker for rows
  // sharing the same wall-clock `timestamp`. Without it, two inserts landing
  // in the same millisecond come back in indeterminate order — a real flake
  // hit by test/pause-gate.test.ts on faster CI runners.
  const chainedSelect = `
    SELECT rowid AS _row,
           id, timestamp, engagement_id, session_id, operator_id, agent_type,
           hostname, source_ip, target_id, data, hash, prev_hash, created_at,
           monotonic_ns, ntp_offset_ms, signature, 'chained' AS tier
    FROM events ${where}
  `
  const loggedSelect = `
    SELECT rowid AS _row,
           id, timestamp, engagement_id, session_id, operator_id, agent_type,
           hostname, source_ip, target_id, data,
           NULL AS hash, NULL AS prev_hash, created_at,
           NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature,
           'logged' AS tier
    FROM events_logged ${where}
  `

  let sql: string
  let bind: unknown[]
  if (tier === 'chained') {
    sql = `${chainedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?`
    bind = [...params, limit]
  } else if (tier === 'logged') {
    sql = `${loggedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?`
    bind = [...params, limit]
  } else {
    // Push ORDER BY + LIMIT into EACH arm before the UNION. The outer query
    // keeps at most `limit` rows, and the top-`limit` of a merge of two
    // already-sorted inputs is always contained in the top-`limit` of each
    // input — so capping each arm at `limit` rows changes nothing observable
    // while bounding what the union materializes at 2×`limit` instead of
    // (whole `events` + whole `events_logged`). This matters because the only
    // real pager (Timeline loadMore) seeks with `beforeCreatedAt`, so each arm
    // already carries `created_at < ?` in its WHERE; without a per-arm LIMIT,
    // both arms still returned EVERY row older than the cursor (158k+ at
    // scale) just for the outer LIMIT to discard all but 200. With the cap,
    // each arm satisfies its own `ORDER BY timestamp DESC` from idx_events_ts /
    // idx_events_logged_ts and stops after `limit` rows. SQLite forbids
    // ORDER BY/LIMIT on a bare compound member, hence the `SELECT * FROM (...)`
    // wrappers; the outer ORDER + LIMIT is the k-way merge over the two capped,
    // already-sorted arms — same result the single-tier branches above return.
    sql = `SELECT * FROM (
             SELECT * FROM (${chainedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?)
             UNION ALL
             SELECT * FROM (${loggedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?)
           ) ORDER BY timestamp DESC, _row DESC LIMIT ?`
    bind = [...params, limit, ...params, limit, limit]
  }

  const rows = db.prepare(sql).all(...bind) as Array<Record<string, unknown>>
  return rows.map(rowToEvent)
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

/** Of the given screenshot event ids, which are referenced by a marker.
 *
 *  The 2d batch-delete confirmation tiers key on this (design §12 / §28.7): a
 *  batch containing a screenshot some finding points at gets the type-to-confirm
 *  tier, not the one-checkbox tier. Deleting stays audited either way — the
 *  chain records a `system.screenshot_deleted` with `sha256_pre_delete` — so
 *  this only steers the *warning*, it does not gate the delete itself.
 *
 *  The one link that exists runs screenshot→marker: a marker-triggered capture
 *  stamps the screenshot's `_causes` with the marker id (screenshot-agent.ts);
 *  `marker:create` strips `_causes`, so markers never point forward at a shot.
 *  Both types are chained, but the logged arm is queried too for the same
 *  reason queryMarkerAmendments does — "which table is `marker` in" is a fact
 *  about today's classifier, not one to hard-code here.
 *
 *  Returns the referenced subset in the input order; unknown ids and non-marker
 *  causes (e.g. a command-linked capture) are simply absent. */
export function screenshotsReferencedByMarker(screenshotIds: string[]): string[] {
  if (screenshotIds.length === 0) return []
  const db = getReadonlyDB()
  // 1. Pull each screenshot's `_causes` array from the JSON blob. Only rows that
  //    are actually screenshots — a caller passing a stray id gets it dropped,
  //    not mis-attributed.
  const causeIdsByShot = new Map<string, string[]>()
  const allCauseIds = new Set<string>()
  for (let i = 0; i < screenshotIds.length; i += 400) {
    const chunk = screenshotIds.slice(i, i + 400)
    const holes = chunk.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id, json_extract(data, '$._causes') AS causes
         FROM events
        WHERE agent_type = 'screenshot' AND id IN (${holes})`
    ).all(...chunk) as Array<{ id: string; causes: string | null }>
    for (const r of rows) {
      let causes: string[] = []
      if (r.causes) {
        try {
          const parsed = JSON.parse(r.causes)
          if (Array.isArray(parsed)) causes = parsed.filter((c): c is string => typeof c === 'string')
        } catch { /* malformed blob — treat as no references */ }
      }
      causeIdsByShot.set(r.id, causes)
      for (const c of causes) allCauseIds.add(c)
    }
  }
  if (allCauseIds.size === 0) return []
  // 2. Of every referenced id, which are markers. Markers are chained, but check
  //    both tiers so a future reclassification does not silently drop half.
  const markerIds = new Set<string>()
  const causeList = [...allCauseIds]
  for (let i = 0; i < causeList.length; i += 400) {
    const chunk = causeList.slice(i, i + 400)
    const holes = chunk.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT id FROM events         WHERE agent_type = 'marker' AND id IN (${holes})
       UNION ALL
       SELECT id FROM events_logged  WHERE agent_type = 'marker' AND id IN (${holes})`
    ).all(...chunk, ...chunk) as Array<{ id: string }>
    for (const r of rows) markerIds.add(r.id)
  }
  // 3. A screenshot is referenced when any of its causes resolved to a marker.
  return screenshotIds.filter((id) => (causeIdsByShot.get(id) ?? []).some((c) => markerIds.has(c)))
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

export function getLootCount(): number {
  const db = getReadonlyDB()
  const row = db.prepare("SELECT COUNT(*) as count FROM events WHERE agent_type = 'loot'").get() as { count: number }
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

/** FTS5 MATCH treats bare punctuation and operators as syntax. Terminal
 *  searches are full of both — `10.0.0.5`, `-sV`, `/etc/passwd` — so each
 *  term is quoted as a phrase rather than handed through, and only a
 *  trailing `*` is added for the last term (prefix-match while typing). */
function toMatchQuery(raw: string): string | null {
  const terms = raw.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  return terms
    .map((term, i) => {
      const quoted = `"${term.replace(/"/g, '""')}"`
      return i === terms.length - 1 ? `${quoted}*` : quoted
    })
    .join(' ')
}

export function searchEvents(query: string, limit = 100, opts?: { agentType?: string; since?: number; before?: number }): RedLogEvent[] {
  const db = getReadonlyDB()
  const match = toMatchQuery(query)
  if (!match) return []

  const extraConds: string[] = []
  const extraParams: unknown[] = []
  if (opts?.agentType) {
    extraConds.push('e.agent_type = ?')
    extraParams.push(opts.agentType)
  }
  if (opts?.since != null) {
    extraConds.push('e.timestamp >= ?')
    extraParams.push(opts.since)
  }
  if (opts?.before != null) {
    extraConds.push('e.timestamp <= ?')
    extraParams.push(opts.before)
  }

  const whereExtra = extraConds.length ? ' AND ' + extraConds.join(' AND ') : ''

  const chainedSelect = `
    SELECT e.rowid AS _row,
           e.id, e.timestamp, e.engagement_id, e.session_id, e.operator_id, e.agent_type,
           e.hostname, e.source_ip, e.target_id, e.data, e.hash, e.prev_hash, e.created_at,
           e.monotonic_ns, e.ntp_offset_ms, e.signature, 'chained' AS tier
    FROM events e
    JOIN events_fts ON events_fts.rowid = e.rowid
    WHERE events_fts MATCH ?${whereExtra}
  `
  const loggedSelect = `
    SELECT e.rowid AS _row,
           e.id, e.timestamp, e.engagement_id, e.session_id, e.operator_id, e.agent_type,
           e.hostname, e.source_ip, e.target_id, e.data,
           NULL AS hash, NULL AS prev_hash, e.created_at,
           NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature,
           'logged' AS tier
    FROM events_logged e
    JOIN events_logged_fts ON events_logged_fts.rowid = e.rowid
    WHERE events_logged_fts MATCH ?${whereExtra}
  `

  const sql = `SELECT * FROM (
    SELECT * FROM (${chainedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?)
    UNION ALL
    SELECT * FROM (${loggedSelect} ORDER BY timestamp DESC, _row DESC LIMIT ?)
  ) ORDER BY timestamp DESC, _row DESC LIMIT ?`
  const bind = [match, ...extraParams, limit, match, ...extraParams, limit, limit]

  try {
    const rows = db.prepare(sql).all(...bind) as Array<Record<string, unknown>>
    return rows.map(rowToEvent)
  } catch {
    return []
  }
}
