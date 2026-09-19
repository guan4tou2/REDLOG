import type { RedLogEvent } from '../../../core/db/event-types'
import { groupAmendments, foldMarker } from './markerFold'
import { eventTitle } from './eventTitle'
import { matchesScopePattern } from './timelineScopeMatch'

/**
 * Pre-built lowercase search bag per event id — nine string coercions,
 * a join and a lowercase per event, done once per event set change
 * (not per keystroke). Returns empty when `query` is blank so the
 * caller can skip the build entirely in idle state.
 */
export function buildSearchIndex(
  events: readonly RedLogEvent[],
  operatorNames: Record<string, string>,
  query: string
): Map<string, string> {
  const idx = new Map<string, string>()
  if (!query.trim()) return idx
  const amendmentsByMarker = groupAmendments(events)
  for (const e of events) {
    const d = e.data as Record<string, unknown> | undefined
    const mine = amendmentsByMarker.get(e.id)
    idx.set(e.id, [
      String(d?.command ?? ''),
      String(d?.url ?? ''),
      String(d?.host ?? ''),
      String(d?.title ?? ''),
      String(d?.subtype ?? ''),
      e.agentType === 'marker' ? String(d?.title ?? '') : '',
      mine ? foldMarker(e, mine).effective.title : '',
      e.operatorId,
      operatorNames[e.operatorId] ?? '',
      eventTitle(e)
    ].join('').toLowerCase())
  }
  return idx
}

/**
 * Subset of event ids whose search bag contains the query string.
 * Returns null when the query is blank (meaning "no filter active").
 */
export function computeFilterMatches(
  searchIndex: Map<string, string>,
  query: string
): Set<string> | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const set = new Set<string>()
  for (const [id, bag] of searchIndex) if (bag.includes(q)) set.add(id)
  return set
}

/**
 * Events that touched the given target — by targetId, detectedTarget,
 * remote_addr, host, dest_ip, dest_host, or target field.
 * Returns null when no target is focused.
 */
export function computeTargetMatches(
  events: readonly RedLogEvent[],
  effectiveTarget: string | null | undefined
): Set<string> | null {
  if (!effectiveTarget) return null
  const t = effectiveTarget.toLowerCase()
  const set = new Set<string>()
  for (const e of events) {
    const d = e.data as Record<string, unknown> | undefined
    const fields = [e.targetId, d?.detectedTarget, d?.remote_addr, d?.host, d?.dest_ip, d?.dest_host, d?.target]
    if (fields.some((v) => typeof v === 'string' && v.toLowerCase() === t)) set.add(e.id)
  }
  return set
}

/**
 * Events matching at least one scope pattern, or lacking a targetId
 * (ambient events always pass). Returns null when scope filter is off.
 */
export function computeScopeMatches(
  events: readonly RedLogEvent[],
  scopeTargets: readonly string[],
  inScopeOnly: boolean
): Set<string> | null {
  if (!inScopeOnly || scopeTargets.length === 0) return null
  const set = new Set<string>()
  for (const e of events) {
    if (!e.targetId) { set.add(e.id); continue }
    if (scopeTargets.some((p) => matchesScopePattern(e.targetId!, p))) set.add(e.id)
  }
  return set
}
