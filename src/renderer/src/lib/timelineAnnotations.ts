import type { RedLogEvent } from '../../../core/db/event-types'
import { violationStanding } from '../../../core/scope-violation-standing'
import { groupAmendments, foldMarker, isMarkerOriginal, type MarkerFold } from './markerFold'
import { computeBadges, type EventBadge } from './timelineDomain'

/**
 * Reverse-effects index: for each cause event id, the list of event ids
 * that name it in their `_causes` array. O(N × avg-causes).
 */
export function buildEffectsIndex(events: readonly RedLogEvent[]): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const e of events) {
    const causes = (e.data as { _causes?: unknown } | undefined)?._causes
    if (!Array.isArray(causes)) continue
    for (const c of causes) {
      if (typeof c !== 'string') continue
      const arr = m.get(c)
      if (arr) arr.push(e.id)
      else m.set(c, [e.id])
    }
  }
  return m
}

export interface ViolationStanding {
  cleared: Set<string>
  superseded: Set<string>
}

/**
 * Fold index: for each original marker, the folded effective values
 * incorporating all its amendments. Skips markers with no amendments.
 */
export function buildFoldIndex(events: readonly RedLogEvent[]): Map<string, MarkerFold> {
  const folds = new Map<string, MarkerFold>()
  const byMarker = groupAmendments(events)
  if (byMarker.size === 0) return folds
  for (const e of events) {
    if (!isMarkerOriginal(e)) continue
    const mine = byMarker.get(e.id)
    if (mine) folds.set(e.id, foldMarker(e, mine))
  }
  return folds
}

/**
 * Badge index: for each event that carries at least one anomaly badge,
 * the list of badges. Events with no badges are omitted from the map.
 */
export function buildBadgeIndex(
  events: readonly RedLogEvent[],
  brokenAtId: string | null,
  cleared: ReadonlySet<string>,
  superseded: ReadonlySet<string>
): Map<string, EventBadge[]> {
  const m = new Map<string, EventBadge[]>()
  for (const e of events) {
    const b = computeBadges(e, brokenAtId, cleared, superseded)
    if (b.length) m.set(e.id, b)
  }
  return m
}

/** Which loaded violations no longer stand, by the recompute's own rule. */
export function computeViolationStanding(events: readonly RedLogEvent[]): ViolationStanding {
  const { cleared, supersededBy } = violationStanding(
    events
      .filter((e) => e.agentType === 'system')
      .map((e) => ({ id: e.id, createdAt: e.createdAt, data: (e.data ?? {}) as Record<string, unknown> }))
  )
  return { cleared, superseded: new Set(supersededBy.keys()) }
}

