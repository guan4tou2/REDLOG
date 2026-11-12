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
/** What `mapMatchesToDrawn` needs to know about the drawn rows. */
export interface DrawnMatchIndex {
  ids: Set<string>
  endByCommand: Map<string, RedLogEvent>
  rowBySession: Map<string, string>
}

/** Fold `drawn[from…]` into `index` (in place; `from` 0 builds one). */
export function indexDrawnForMatches(drawn: readonly RedLogEvent[], from = 0, index: DrawnMatchIndex = {
  ids: new Set(), endByCommand: new Map(), rowBySession: new Map()
}): DrawnMatchIndex {
  for (let i = from; i < drawn.length; i++) {
    const e = drawn[i]
    index.ids.add(e.id)
    const key = operationPairKey(e)
    if (e.agentType === 'shell' && e.data?.subtype === 'command_end' && key) index.endByCommand.set(key, e)
    const session = sourceSessionKey(e)
    if (e.agentType === 'agent' && session && !index.rowBySession.has(session)) index.rowBySession.set(session, e.id)
  }
  return index
}

export function mapMatchesToDrawn(
  matchedIds: ReadonlySet<string>,
  loaded: readonly RedLogEvent[],
  drawn: readonly RedLogEvent[],
  // Kept by the caller across flushes (lib/timelineIncremental): the walk is
  // then over the matches, not over every loaded row. Same answer.
  prepared?: { drawn: DrawnMatchIndex; loadedById: ReadonlyMap<string, RedLogEvent> }
): { lit: Set<string>; hiddenByCollapse: number } {
  const { ids: drawnIds, endByCommand, rowBySession } = prepared?.drawn ?? indexDrawnForMatches(drawn)
  const matchedLoaded: Iterable<RedLogEvent> = prepared
    ? (function* () { for (const id of matchedIds) { const e = prepared.loadedById.get(id); if (e) yield e } })()
    : loaded
  const lit = new Set<string>()
  let hiddenByCollapse = 0
  for (const e of matchedLoaded) {
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

/** What the card rail needs from the viewport window, from one walk of it. */
export interface WindowSlice {
  /** The newest `cap` visible events in the window, OLDEST FIRST. */
  recent: RedLogEvent[]
  /** How many events the window holds under the lane filter alone. */
  totalAll: number
  /** How many it holds under the lane filter and the query's matches; the
   *  same number as `totalAll` when no query is active. */
  total: number
}

// A marker is drawn at its own `atTimestamp`, so it can sit anywhere while the
// array is ordered by `timestamp`. Which events are drawn somewhere other than
// their own time is a property of the array, not of the viewport, so it is
// found once per array rather than once per scroll frame. The Timeline replaces
// its arrays instead of editing them; the length is a guard for anything that
// does not.
const displacedCache = new WeakMap<
  readonly RedLogEvent[],
  { displayTs: ViewportWindow['displayTs']; length: number; indices: number[] }
>()

function displacedIndices(events: readonly RedLogEvent[], displayTs: ViewportWindow['displayTs']): number[] {
  const hit = displacedCache.get(events)
  if (hit && hit.displayTs === displayTs && hit.length === events.length) return hit.indices
  const indices: number[] = []
  for (let i = 0; i < events.length; i++) if (displayTs(events[i]) !== events[i].timestamp) indices.push(i)
  displacedCache.set(events, { displayTs, length: events.length, indices })
  return indices
}

/** First index whose `timestamp` is >= `t` (`strict`: > `t`). */
function boundByTimestamp(events: readonly RedLogEvent[], t: number, strict: boolean): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const ts = events[mid].timestamp
    if (strict ? ts <= t : ts < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function firstAtLeast(sorted: readonly number[], n: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid] < n) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** One rule for what counts, with what it has counted. */
interface Tally {
  passes: (e: RedLogEvent) => boolean
  total: number
  /** False once the early exit has fired for this rule. */
  open: boolean
}

/**
 * Walk the viewport window newest-first. `events` is in `timestamp` order, which
 * is what lets the window's edges be found by bisection instead of by walking
 * back from the newest row past everything the operator has scrolled away from.
 *
 * What counts is exactly what a newest-first walk with an early exit counted:
 * a visible event whose display time is inside [from, to], except that the walk
 * stops at the newest visible event shown at its own time before `from`.
 * A marker is shown at its `atTimestamp`, so a backdated one before the window
 * says nothing about the rows after it, and a marker stored after the window can
 * be drawn inside it; the first is why only an event shown at its own time may
 * end the walk, the second is why events after the window are not skipped
 * wholesale (`displacedIndices`).
 *
 * Two rules are tallied in the one walk because the rail needs both: the lane
 * filter alone, and the lane filter with the query's matches. Each keeps its own
 * early exit, as it did when they were separate walks.
 */
function scanWindow(
  events: readonly RedLogEvent[],
  laneVisible: (e: RedLogEvent) => boolean,
  matched: ReadonlySet<string> | null,
  vp: ViewportWindow,
  cap: number
): WindowSlice {
  const all: Tally = { passes: () => true, total: 0, open: true }
  const query: Tally = matched ? { passes: (e) => matched.has(e.id), total: 0, open: true } : all
  const rules = matched ? [all, query] : [all]
  const items: RedLogEvent[] = []
  const take = (e: RedLogEvent, respectOpen: boolean): void => {
    let counted = false
    for (const r of rules) {
      if ((respectOpen && !r.open) || !r.passes(e)) continue
      r.total++
      if (r === query) counted = true
    }
    if (counted && items.length < cap) items.push(e)
  }
  const done = (): WindowSlice => ({ recent: items.reverse(), totalAll: all.total, total: query.total })

  const widthPx = (vp.width / 100) * vp.trackW
  const wholeTrackVisible = widthPx <= 0 || (vp.left <= 0.01 && vp.width >= 99.99)
  if (wholeTrackVisible || vp.timeSpan <= 0) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (laneVisible(events[i])) take(events[i], false)
    }
    return done()
  }

  const from = vp.fromX((vp.left / 100) * vp.trackW)
  const to = vp.fromX(((vp.left + vp.width) / 100) * vp.trackW)
  // Events before `lo` are earlier than the window and after `hi` later than
  // it, by `timestamp`. A window with no order (NaN edges) bisects nothing.
  const ordered = from <= to
  const lo = ordered ? boundByTimestamp(events, from, false) : 0
  const hi = ordered ? boundByTimestamp(events, to, true) : events.length
  // Written as two negations so a NaN edge admits everything, as it always did.
  const inWindow = (d: number): boolean => !(d > to) && !(d < from)

  // Newest first. After the window: only a marker drawn back inside it.
  if (ordered) {
    const displaced = displacedIndices(events, vp.displayTs)
    const firstAfter = firstAtLeast(displaced, hi)
    for (let j = displaced.length - 1; j >= firstAfter; j--) {
      const e = events[displaced[j]]
      if (laneVisible(e) && inWindow(vp.displayTs(e))) take(e, false)
    }
  }
  // Inside it by `timestamp`; a marker among them may be drawn elsewhere.
  for (let i = hi - 1; i >= lo; i--) {
    const e = events[i]
    if (laneVisible(e) && inWindow(vp.displayTs(e))) take(e, false)
  }
  // Before it, until each rule's early exit.
  for (let i = lo - 1; i >= 0 && (all.open || query.open); i--) {
    const e = events[i]
    if (!laneVisible(e)) continue
    const d = vp.displayTs(e)
    if (d > to) continue
    if (d < from) {
      if (d === e.timestamp) for (const r of rules) if (r.passes(e)) r.open = false
      continue
    }
    take(e, true)
  }

  // A rule that found nothing inside the window answers with the nearest events
  // before its trailing edge instead.
  const empty = rules.filter((r) => r.total === 0)
  if (empty.length === 0) return done()
  if (empty.includes(query)) items.length = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!laneVisible(e) || !(vp.displayTs(e) <= to)) continue
    let counted = false
    for (const r of empty) {
      if (!r.passes(e)) continue
      r.total++
      if (r === query) counted = true
    }
    if (counted && items.length < cap) items.push(e)
  }
  return done()
}

/**
 * What the card rail shows for the current viewport: the newest `cap` events in
 * it OLDEST FIRST (the rail reads top to bottom like the time axis), and how
 * many the window holds in all, "latest 50 of N". When the whole track is
 * visible, or the window holds nothing, a rule answers with the nearest events
 * before the viewport's trailing edge.
 *
 * `matched` is the `/` search results; non-null means the list shows only
 * these. That used to DIM non-matches and leave them in place. On a half screen
 * beside a terminal that is not a filter: a dirb run puts 920 rows in the list
 * and all 920 still took their space, so searching `backup` left the operator
 * scrolling the same distance looking for a shade of grey. Non-matches are
 * removed; the panel says how many (`totalAll - total`) and opens them.
 */
export function computeWindowSlice(
  events: readonly RedLogEvent[],
  hiddenLanes: ReadonlySet<LaneId>,
  pluginTypes: PluginEventType[] | undefined,
  vp: ViewportWindow,
  cap = 50,
  matched: ReadonlySet<string> | null = null
): WindowSlice {
  // The whole track on screen with nothing hidden and no query — zoom 1, the
  // default, and the live case — is every row: the newest `cap` and the count,
  // without a walk (the walk below gives exactly this).
  const widthPx = (vp.width / 100) * vp.trackW
  const wholeTrackVisible = widthPx <= 0 || (vp.left <= 0.01 && vp.width >= 99.99) || vp.timeSpan <= 0
  if (wholeTrackVisible && !matched && hiddenLanes.size === 0) {
    return { recent: events.slice(Math.max(0, events.length - cap)), totalAll: events.length, total: events.length }
  }
  return scanWindow(
    events,
    (e) => !hiddenLanes.has(toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)),
    matched, vp, cap
  )
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
