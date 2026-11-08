import { operationPairKey, sourceSessionKey } from '../../../core/operation-pair-key'
import type { RedLogEvent } from '../../../core/db/event-types'
import { isMarkerAmendment } from './markerFold'
import { isCollapsibleAgentTurn } from './timelineEvents'
import { LANES, type LaneId, BAND_OF, toLane, type PluginEventType } from './timelineDomain'

/**
 * Spec 038 (research R5): the rows the query layer matched, as the rows the
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
  const endByCommand = new Map<string, RedLogEvent>()
  const rowBySession = new Map<string, string>()
  for (const e of drawn) {
    const key = operationPairKey(e)
    if (e.agentType === 'shell' && e.data?.subtype === 'command_end' && key) endByCommand.set(key, e)
    const session = sourceSessionKey(e)
    if (e.agentType === 'agent' && session && !rowBySession.has(session)) rowBySession.set(session, e.id)
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
      const key = operationPairKey(e)
      const end = key ? endByCommand.get(key) : undefined
      if (end && end.data.command === e.data.command) lit.add(end.id)
      else hiddenByCollapse += 1
      continue
    }
    if (isCollapsibleAgentTurn(e)) {
      const key = sourceSessionKey(e)
      const row = key ? rowBySession.get(key) : undefined
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

/** Walk the viewport window newest-first. Returns the newest `cap` visible
 *  events (newest first) and how many the window holds in all, so the card
 *  rail can say "latest 50 of N" without a second pass over a different
 *  definition of "in the window". `collect:false` only counts. */
function scanWindow(
  events: readonly RedLogEvent[],
  isVisible: (e: RedLogEvent) => boolean,
  vp: ViewportWindow,
  cap: number,
  collect: boolean
): { items: RedLogEvent[]; total: number } {
  const widthPx = (vp.width / 100) * vp.trackW
  const wholeTrackVisible = widthPx <= 0 || (vp.left <= 0.01 && vp.width >= 99.99)
  const items: RedLogEvent[] = []
  let total = 0
  const take = (e: RedLogEvent): void => {
    total++
    if (collect && items.length < cap) items.push(e)
  }

  if (wholeTrackVisible || vp.timeSpan <= 0) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (isVisible(events[i])) take(events[i])
    }
    return { items, total }
  }

  const from = vp.fromX((vp.left / 100) * vp.trackW)
  const to = vp.fromX(((vp.left + vp.width) / 100) * vp.trackW)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!isVisible(e)) continue
    const d = vp.displayTs(e)
    if (d > to) continue
    // `events` is in `timestamp` order, but a marker shows at its own
    // `atTimestamp`. A backdated marker before the window says nothing about
    // the rows after it, so only a row shown at its own time may end the scan.
    if (d < from) { if (d === e.timestamp) break; continue }
    take(e)
  }
  if (total > 0) return { items, total }
  // Nothing inside the window: the nearest events before its trailing edge.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (isVisible(e) && vp.displayTs(e) <= to) take(e)
  }
  return { items, total }
}

function visibilityOf(
  hiddenLanes: ReadonlySet<LaneId>,
  pluginTypes: PluginEventType[] | undefined,
  matched: ReadonlySet<string> | null
): (e: RedLogEvent) => boolean {
  // The `/` search used to DIM non-matches and leave them in place. On a half
  // screen beside a terminal that is not a filter: a dirb run puts 920 rows
  // in the list and all 920 still take their space, so searching `backup`
  // left the operator scrolling the same distance looking for a shade of
  // grey. Non-matches are removed; the panel says how many and opens them.
  return (e) =>
    !hiddenLanes.has(toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes))
    && (matched === null || matched.has(e.id))
}

/**
 * The newest `cap` events in the current viewport, OLDEST FIRST — the card
 * rail reads top to bottom like the time axis. When the whole track is
 * visible or the windowed search yields nothing, falls back to the nearest
 * events before the viewport's trailing edge.
 */
export function computeRecentEvents(
  events: readonly RedLogEvent[],
  hiddenLanes: ReadonlySet<LaneId>,
  pluginTypes: PluginEventType[] | undefined,
  vp: ViewportWindow,
  cap = 50,
  /** `/` search results. Non-null means the list shows only these. */
  matched: ReadonlySet<string> | null = null
): RedLogEvent[] {
  return scanWindow(events, visibilityOf(hiddenLanes, pluginTypes, matched), vp, cap, true).items.reverse()
}

/** How many events the same window holds, uncapped — the N in "latest 50 of N". */
export function countWindowEvents(
  events: readonly RedLogEvent[],
  hiddenLanes: ReadonlySet<LaneId>,
  pluginTypes: PluginEventType[] | undefined,
  vp: ViewportWindow,
  matched: ReadonlySet<string> | null = null
): number {
  return scanWindow(events, visibilityOf(hiddenLanes, pluginTypes, matched), vp, 0, false).total
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
 *
 * Hiding is checked here rather than relying on the lane having no row,
 * because a collapsed band's row would otherwise re-absorb the events of a
 * lane the operator hid — collapsing the band would silently undo the hide.
 */
/** The one row of the standard Timeline: every loaded event on a single track,
 * in time order. Lane hiding is an advanced-mode filter and is deliberately not
 * applied here: the standard view has no lane rows to bring a hidden lane back
 * with, so honouring it would make events vanish with no way to restore them.
 * The setting itself is kept for when the swim lanes are shown again. */
export const STANDARD_ROW = 'standard'
export function singleTrackEvents(events: readonly RedLogEvent[], displayTs: (e: RedLogEvent) => number): RedLogEvent[] {
  return [...events].sort((a, b) => displayTs(a) - displayTs(b))
}

export function distributeRowEvents(
  events: readonly RedLogEvent[],
  visibleRows: readonly string[],
  collapsedBands: ReadonlySet<string>,
  pluginTypes: PluginEventType[] | undefined,
  hiddenLanes: ReadonlySet<LaneId>
): Record<string, RedLogEvent[]> {
  const map: Record<string, RedLogEvent[]> = {}
  for (const r of visibleRows) map[r] = []
  for (const e of events) {
    const lane = toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)
    if (hiddenLanes.has(lane)) continue
    const key = collapsedBands.has(BAND_OF[lane]) ? BAND_OF[lane] : lane
    const bucket = map[key]
    if (bucket) bucket.push(e)
  }
  return map
}
