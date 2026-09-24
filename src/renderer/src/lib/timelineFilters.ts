import type { RedLogEvent } from '../../../core/db/event-types'
import { isMarkerAmendment } from './markerFold'
import { isCollapsibleAgentTurn } from './timelineEvents'
import { LANES, type LaneId, BAND_OF, toLane, type PluginEventType } from './timelineDomain'

/**
 * Spec 033 (research R5): the rows the query layer matched, as the rows the
 * Timeline draws. Which rows match is not decided here — the filter box goes
 * through the query contract and `events:matchIds` — only how a match on a
 * row the panel folds away is shown:
 *
 * - a command start hidden behind its end lights the end;
 * - a collapsed agent turn lights a drawn row of its session, or, with none
 *   drawn, is counted as hidden by the collapse rather than lost;
 * - an amendment is drawn as its own row, and also lights its marker, whose
 *   shown title comes from it.
 */
export function mapMatchesToDrawn(
  matchedIds: ReadonlySet<string>,
  loaded: readonly RedLogEvent[],
  drawn: readonly RedLogEvent[]
): { lit: Set<string>; hiddenByCollapse: number } {
  const drawnIds = new Set(drawn.map((e) => e.id))
  const commandKey = (e: RedLogEvent): string => `${e.data?.pid ?? ''}|${e.data?.command ?? ''}`
  const endByCommand = new Map<string, string>()
  const rowBySession = new Map<string, string>()
  for (const e of drawn) {
    if (e.agentType === 'shell' && e.data?.subtype === 'command_end') endByCommand.set(commandKey(e), e.id)
    const session = e.data?.session_id
    if (e.agentType === 'agent' && typeof session === 'string' && !rowBySession.has(session)) rowBySession.set(session, e.id)
  }
  const lit = new Set<string>()
  let hiddenByCollapse = 0
  for (const e of loaded) {
    if (!matchedIds.has(e.id)) continue
    if (drawnIds.has(e.id)) {
      lit.add(e.id)
      const markerId = isMarkerAmendment(e) ? String(e.data?.markerId ?? '') : ''
      if (markerId && drawnIds.has(markerId)) lit.add(markerId)
      continue
    }
    if (e.agentType === 'shell' && e.data?.subtype === 'command_start') {
      const end = endByCommand.get(commandKey(e))
      if (end) lit.add(end)
      continue
    }
    if (isCollapsibleAgentTurn(e)) {
      const row = typeof e.data?.session_id === 'string' ? rowBySession.get(e.data.session_id) : undefined
      if (row) lit.add(row)
      else hiddenByCollapse += 1
    }
  }
  return { lit, hiddenByCollapse }
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
