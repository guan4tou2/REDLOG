import type { RedLogEvent } from '../../../core/db/event-types'
import { groupAmendments, foldMarker } from './markerFold'
import { eventTitle } from './eventTitle'
import { hostInScope } from './scope'
import { LANES, type LaneId, BAND_OF, toLane, type PluginEventType } from './timelineDomain'

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
  excludeTargets: readonly string[],
  inScopeOnly: boolean
): Set<string> | null {
  if (!inScopeOnly || (scopeTargets.length === 0 && excludeTargets.length === 0)) return null
  const set = new Set<string>()
  for (const e of events) {
    if (!e.targetId) { set.add(e.id); continue }
    if (hostInScope(e.targetId, [...scopeTargets], [...excludeTargets])) set.add(e.id)
  }
  return set
}

// ── Viewport windowing ─────────────────────────────────────────────

export interface ViewportWindow {
  /** viewport left edge, 0-100 % */
  left: number
  /** viewport width, 0-100 % */
  width: number
  /** total track width in px */
  trackW: number
  /** pixel → timestamp mapping */
  fromX: (px: number) => number
  /** event → display timestamp */
  displayTs: (e: RedLogEvent) => number
  /** time span of the domain, ms */
  timeSpan: number
}

/**
 * Recent events visible in the current viewport, walking newest-first,
 * capped at `cap`. When the whole track is visible or the windowed
 * search yields nothing, falls back to the nearest events before the
 * viewport's trailing edge.
 */
export function computeRecentEvents(
  events: readonly RedLogEvent[],
  hiddenLanes: ReadonlySet<LaneId>,
  pluginTypes: PluginEventType[] | undefined,
  vp: ViewportWindow,
  cap = 50
): RedLogEvent[] {
  const isVisible = (e: RedLogEvent): boolean =>
    !hiddenLanes.has(toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes))

  const widthPx = (vp.width / 100) * vp.trackW
  const wholeTrackVisible = widthPx <= 0 || (vp.left <= 0.01 && vp.width >= 99.99)

  if (wholeTrackVisible || vp.timeSpan <= 0) {
    const out: RedLogEvent[] = []
    for (let i = events.length - 1; i >= 0 && out.length < cap; i--) {
      if (isVisible(events[i])) out.push(events[i])
    }
    return out
  }

  const from = vp.fromX((vp.left / 100) * vp.trackW)
  const to = vp.fromX(((vp.left + vp.width) / 100) * vp.trackW)
  const inView: RedLogEvent[] = []
  for (let i = events.length - 1; i >= 0 && inView.length < cap; i--) {
    const e = events[i]
    if (!isVisible(e)) continue
    const d = vp.displayTs(e)
    if (d > to) continue
    if (d < from) break
    inView.push(e)
  }
  if (inView.length > 0) return inView
  const nearest: RedLogEvent[] = []
  for (let i = events.length - 1; i >= 0 && nearest.length < cap; i--) {
    const e = events[i]
    if (isVisible(e) && vp.displayTs(e) <= to) nearest.push(e)
  }
  return nearest
}

/**
 * Count of events whose display timestamp falls inside the current viewport.
 * Returns total event count when the whole track is visible.
 */
export function computeSliceCount(
  events: readonly RedLogEvent[],
  vp: Pick<ViewportWindow, 'left' | 'width' | 'trackW' | 'fromX' | 'displayTs'>
): number {
  const widthPx = (vp.width / 100) * vp.trackW
  if (widthPx <= 0 || (vp.left <= 0.01 && vp.width >= 99.99)) return events.length
  const from = vp.fromX((vp.left / 100) * vp.trackW)
  const to = vp.fromX(((vp.left + vp.width) / 100) * vp.trackW)
  let n = 0
  for (const e of events) {
    const d = vp.displayTs(e)
    if (d >= from && d <= to) n++
  }
  return n
}

// ── Lane distribution ───────────────────────────────────────────────

/**
 * Distribute events into per-lane buckets. One pass over the event set.
 */
export function distributeLaneEvents(
  events: readonly RedLogEvent[],
  pluginTypes: PluginEventType[] | undefined
): Record<LaneId, RedLogEvent[]> {
  const map = Object.fromEntries(LANES.map((l) => [l, [] as RedLogEvent[]])) as Record<LaneId, RedLogEvent[]>
  for (const e of events) map[toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)].push(e)
  return map
}

/**
 * Group events by the row they render in. A collapsed band's row
 * absorbs every event from its constituent lanes; hidden lanes'
 * events fall out entirely.
 */
export function distributeRowEvents(
  events: readonly RedLogEvent[],
  visibleRows: readonly string[],
  collapsedBands: ReadonlySet<string>,
  pluginTypes: PluginEventType[] | undefined
): Record<string, RedLogEvent[]> {
  const map: Record<string, RedLogEvent[]> = {}
  for (const r of visibleRows) map[r] = []
  for (const e of events) {
    const lane = toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)
    const key = collapsedBands.has(BAND_OF[lane]) ? BAND_OF[lane] : lane
    const bucket = map[key]
    if (bucket) bucket.push(e)
  }
  return map
}
