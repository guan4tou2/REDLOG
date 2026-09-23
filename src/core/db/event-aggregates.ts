import { getReadonlyDB } from './index'

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
