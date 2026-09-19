import { getReadonlyDB } from './index'
import type { RedLogEvent } from './event-types'
import { rowToEvent } from './event-types'

const ALLOWED_NO_TARGET_TYPES = new Set(['marker', 'screenshot'])
const EXCLUDED_NO_TARGET_TYPES = new Set(['clipboard', 'system'])

export function queryScopeFilteredEvents(scopeTargets: string[]): { events: RedLogEvent[]; truncated: boolean } {
  const db = getReadonlyDB()
  const excluded = Array.from(EXCLUDED_NO_TARGET_TYPES)
  const allowedNoTarget = Array.from(ALLOWED_NO_TARGET_TYPES)
  const excludedPlaceholders = excluded.map(() => '?').join(',')
  const allowedPlaceholders = allowedNoTarget.map(() => '?').join(',')
  const PAGE = 50_000
  const allEvents: RedLogEvent[] = []
  let offset = 0
  let truncated = false
  const MAX_ROWS = 500_000

  const where = `
    WHERE (
      target_id IS NOT NULL
      OR agent_type IN (${allowedPlaceholders})
    )
    AND agent_type NOT IN (${excludedPlaceholders})
  `
  const whereParams = [...allowedNoTarget, ...excluded]

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const sql = `
      SELECT * FROM (
        SELECT rowid AS _row,
               id, timestamp, engagement_id, session_id, operator_id, agent_type,
               hostname, source_ip, target_id, data, hash, prev_hash, created_at,
               monotonic_ns, ntp_offset_ms, signature, 'chained' AS tier
        FROM events ${where}
        UNION ALL
        SELECT rowid AS _row,
               id, timestamp, engagement_id, session_id, operator_id, agent_type,
               hostname, source_ip, target_id, data,
               NULL AS hash, NULL AS prev_hash, created_at,
               NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature,
               'logged' AS tier
        FROM events_logged ${where}
      )
      ORDER BY timestamp DESC, _row DESC
      LIMIT ? OFFSET ?
    `
    const rows = db.prepare(sql).all(...whereParams, ...whereParams, PAGE, offset) as Array<Record<string, unknown>>
    const batch = rows.map(rowToEvent)
    if (scopeTargets.length === 0) {
      allEvents.push(...batch)
    } else {
      for (const e of batch) {
        if (e.targetId ? scopeTargets.some((t) => matchTarget(e.targetId!, t)) : ALLOWED_NO_TARGET_TYPES.has(e.agentType)) {
          allEvents.push(e)
        }
      }
    }
    if (batch.length < PAGE) break
    offset += PAGE
    if (offset >= MAX_ROWS) { truncated = true; break }
  }
  return { events: allEvents, truncated }
}

/** One host's rollup for ⌘K host search (UIUX-STANDARD §10). */
export interface HostAggregate {
  host: string
  count: number
  lastSeen: number
}

/**
 * Distinct `data.host` values across both tiers, with a hit count and last-seen.
 * §10: "host 只存在於事件的 data.host JSON 裡… 要讓它全域可搜,需要 DB 端的
 * distinct-host 聚合——那與 §9 目標頁改 SQL 聚合是同一件事." This is that
 * aggregation, shaped for the command palette: busiest hosts first, capped.
 */
export function distinctHosts(limit = 500): HostAggregate[] {
  // Heavy read: two-tier json_extract + GROUP BY aggregate.
  const db = getReadonlyDB()
  const sql = `
    SELECT host, COUNT(*) AS count, MAX(timestamp) AS lastSeen
    FROM (
      SELECT json_extract(data, '$.host') AS host, timestamp FROM events
      UNION ALL
      SELECT json_extract(data, '$.host') AS host, timestamp FROM events_logged
    )
    WHERE host IS NOT NULL AND host != ''
    GROUP BY host
    ORDER BY count DESC, lastSeen DESC
    LIMIT ?
  `
  return db.prepare(sql).all(limit) as HostAggregate[]
}

/** One target's rollup for the Targets page (UIUX-STANDARD §9 / §14-4c). */
export interface TargetAggregate {
  target: string
  eventCount: number
  firstSeen: number
  lastSeen: number
}

/**
 * Per-target counts + first/last-seen, computed in SQL over BOTH tiers — the
 * whole timeline. Keys on `target_id` column (the canonical target identity,
 * see docs/domain/SPEC-target-identity.md), NOT `data.detectedTarget` (which
 * is observation metadata set only by shell enrichment — a strict subset of
 * `target_id`). This ensures the aggregate count matches what
 * `queryEvents({ targetId })` returns for the detail view.
 *
 * Case-insensitive grouping via LOWER() so "Example.COM" and "example.com"
 * merge into one row; the displayed form is the most-recently-seen casing.
 *
 * Scope classification stays in the renderer, which has the project's scope
 * patterns and the stricter CIDR match.
 */
export function aggregateTargets(): TargetAggregate[] {
  const db = getReadonlyDB()
  const sql = `
    SELECT target,
           COUNT(*)       AS eventCount,
           MIN(timestamp) AS firstSeen,
           MAX(timestamp) AS lastSeen
    FROM (
      SELECT target_id AS target, timestamp FROM events
      WHERE target_id IS NOT NULL AND target_id != ''
      UNION ALL
      SELECT target_id AS target, timestamp FROM events_logged
      WHERE target_id IS NOT NULL AND target_id != ''
    )
    GROUP BY LOWER(target)
    ORDER BY lastSeen DESC
  `
  return db.prepare(sql).all() as TargetAggregate[]
}

// An event "touches" a host when its canonical `target_id` is that host, or its
// data carries it as `host` (HTTP/DNS/scanner rows) or `detectedTarget`
// (shell/loot rows key on the derived target). Three `?` per use.
const HOST_MATCH_SQL = `(
  target_id = ?
  OR json_extract(data, '$.host') = ?
  OR json_extract(data, '$.detectedTarget') = ?
)`

// The turning points design 10a's 〈相關〉chain shows for a host — a name
// resolution, a command, loot, a marker, a scope violation — NOT every row that
// touched it (a scan is thousands). command_start/end both pass; folding the
// pair into one line is the renderer's job (collapseCommandPairs), so the
// backend returns the raw turning-point rows.
const CHAIN_TURNING_POINT_SQL = `(
  agent_type IN ('loot', 'marker')
  OR (agent_type = 'dns' AND subtype = 'dns_response')
  OR (agent_type = 'shell' AND subtype IN ('command_start', 'command_end', 'command'))
  OR (agent_type = 'system' AND subtype = 'scope_violation')
)`

export interface HostCausalChain {
  host: string
  /** Every event touching the host, both tiers — the header's "· N 個事件". */
  eventCount: number
  operatorCount: number
  firstSeen: number | null
  lastSeen: number | null
  /** The curated turning-point events, oldest-first. Scope status is deliberately
   *  NOT included — the renderer classifies it from the project scope config
   *  (lib/scope.ts), keeping this query display-agnostic. */
  chain: RedLogEvent[]
}

/** Data backend for the Inspector 〈相關〉panel (design 10a): a host's causal
 *  chain — a header aggregate plus the handful of understanding-changing events
 *  in time order, rather than the full pile of same-host rows. Read-only, both
 *  tiers. v1 keys on target_id / data.host / data.detectedTarget; unifying a
 *  DNS name with its resolved IP (so the resolution shows in the IP's chain
 *  even when the dns row is keyed on the name) is a later enhancement. */
export function hostCausalChain(host: string, opts: { chainLimit?: number } = {}): HostCausalChain {
  const empty: HostCausalChain = { host, eventCount: 0, operatorCount: 0, firstSeen: null, lastSeen: null, chain: [] }
  if (!host) return empty
  const db = getReadonlyDB()
  const chainLimit = opts.chainLimit ?? 200

  const header = db.prepare(`
    SELECT COUNT(*) AS eventCount,
           COUNT(DISTINCT operator_id) AS operatorCount,
           MIN(timestamp) AS firstSeen,
           MAX(timestamp) AS lastSeen
    FROM (
      SELECT operator_id, timestamp, target_id, data FROM events
      UNION ALL
      SELECT operator_id, timestamp, target_id, data FROM events_logged
    )
    WHERE ${HOST_MATCH_SQL}
  `).get(host, host, host) as {
    eventCount: number; operatorCount: number; firstSeen: number | null; lastSeen: number | null
  }

  const chained = `SELECT rowid AS _row, id, timestamp, engagement_id, session_id, operator_id,
    agent_type, hostname, source_ip, target_id, data, hash, prev_hash, created_at,
    monotonic_ns, ntp_offset_ms, signature, 'chained' AS tier
    FROM events WHERE ${HOST_MATCH_SQL} AND ${CHAIN_TURNING_POINT_SQL}`
  const logged = `SELECT rowid AS _row, id, timestamp, engagement_id, session_id, operator_id,
    agent_type, hostname, source_ip, target_id, data, NULL AS hash, NULL AS prev_hash, created_at,
    NULL AS monotonic_ns, NULL AS ntp_offset_ms, NULL AS signature, 'logged' AS tier
    FROM events_logged WHERE ${HOST_MATCH_SQL} AND ${CHAIN_TURNING_POINT_SQL}`
  const rows = db.prepare(`
    SELECT * FROM (${chained} UNION ALL ${logged})
    ORDER BY timestamp ASC, _row ASC
    LIMIT ?
  `).all(host, host, host, host, host, host, chainLimit) as Array<Record<string, unknown>>

  return {
    host,
    eventCount: header?.eventCount ?? 0,
    operatorCount: header?.operatorCount ?? 0,
    firstSeen: header?.firstSeen ?? null,
    lastSeen: header?.lastSeen ?? null,
    chain: rows.map(rowToEvent)
  }
}

export function matchTarget(target: string, pattern: string): boolean {
  const t = target.toLowerCase()
  const p = pattern.toLowerCase()
  if (p.startsWith('*.')) {
    const domain = p.slice(2)
    return t === domain || t.endsWith('.' + domain)
  }
  if (p.includes('/')) {
    return t.startsWith(p.split('/')[0])
  }
  return t === p || t.includes(p)
}
