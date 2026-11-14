import { useTimelineLive } from '../hooks/useTimelineLive'
import { useTimelineInspector } from '../hooks/useTimelineInspector'
import { useTimelineViewport, useTimelineZoom } from '../hooks/useTimelineViewport'
import { useTimelinePages } from '../hooks/useTimelinePages'
import { useTimelineDerived } from '../hooks/useTimelineDerived'
import { Button } from './Button'
import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { readSelectedEventId, writeSelectedEventId } from '../lib/selectedEvent'
import { useI18n } from '../i18n'
import { useTimelinePan } from '../hooks/useTimelinePan'
import { useTimelineSummary } from '../hooks/useTimelineSummary'
import { usePanelHeight } from '../hooks/usePanelHeight'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { EVENT_NOTE_SAVED } from './timeline/EventNoteField'
import { useRevalidateOnFocus } from '../hooks/useRevalidateOnFocus'
import { DETAIL_LAYOUT_EVENT, setDetailLayout, storedDetailLayout, type DetailLayout } from '../lib/detailLayout'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'
import { escapeBelongsAbove } from '../lib/escapeLayer'
import { useSharedFilter, toEventFilter, describeActiveConditions } from '../lib/FilterContext'
import { windowAround } from '../lib/timeRangeInput'
import { LoadingSpinner } from './Feedback'
import { getLastVerifyResult, VERIFY_UPDATED_EVENT, type FullVerifyResult } from '../lib/verifyResultCache'
import { BrokenChainBanner, FocusChainBadge } from './timeline/TimelineStatusStrips'
import { TimelineToolbar } from './timeline/TimelineToolbar'
import { TimelineEventLog } from './timeline/TimelineEventLog'
import { TimelineLanesHeader, laneCountText } from './timeline/TimelineLanesHeader'
import { FollowBadge, NowLine } from './timeline/TimelineClock'
import { TimelineEventInspector } from './timeline/TimelineEventInspector'
import { TimelineDetailBar } from './timeline/TimelineDetailBar'
import { KEY_OWNING_CONTROLS, resolveTimelineKey } from '../lib/timelineKeys'
import { Rows3 } from 'lucide-react'
import { formatTime } from '../lib/time'
import { usePersistentState } from '../lib/usePersistentState'
import { parseTimelineMode, type TimelineMode } from '../lib/timelineMode'
import { pairedToolHalf } from '../lib/toolPairing'
import { nextSelection } from '../lib/timelineSelection'
import { computeMaxZoom, buildClusters, filterVisibleClusters, clusterBadgeSize, SINGLE_DOT_PX, MARK_HIT_PX, type TimelineCluster } from '../lib/timelineGeometry'
import { buildTimeMap, computeDomainBounds, computeBins, densestRun, placeRulerMarkers, tickLabelAlign, type TimeMap } from '../lib/timelineTimeMap'
import { binRange, densityAreaPath, dragMinimapWindow, peakBin, type MinimapWindow, type WindowGrip } from '../lib/minimapWindow'
import { buildSessionBands, type SessionBand } from '../lib/timelineSessionBands'
import { mapMatchesToDrawn, STANDARD_ROW, computeWindowSlice, type ViewportWindow } from '../lib/timelineFilters'
import {
  appendedFrom, drawnEvents, unfinishedCommands, toolPairs, laneIndex, singleTrack, swimRows, trackGap, laneGap,
  timestampExtent, latestDisplay, displayStamps, collapsibleTurnCount, effectsIndex, foldIndex,
  observationStanding as observationStandingOf, badgeIndex, sessionBoundaries, drawnMatchIndex, rowsById
} from '../lib/timelineIncremental'
import { mergeSortedRows } from '../lib/timelineMerge'
import { TimelineHelpModal } from './TimelineHelpModal'
import { QueryReadout } from './QueryReadout'
import { parseQuery } from '../../../core/query/contract'
import { formatGap } from '../lib/timelineEvents'
import {
  isMarkerAmendment,
  AMENDABLE_FIELDS, type MarkerValues
} from '../lib/markerFold'
import { isHookSource } from '../lib/housekeeping'
import { isMac } from '../lib/platform'
import { useContributeExport } from '../lib/exportScope'
import {
  LANES, LANE_LABEL_KEYS, type LaneId, BANDS, type BandId, BAND_OF, LANE_COLORS,
  type PluginEventType, type DotShape, IO_MARK_COLOR,
  displayTs, toLane, binarySearchInsert,
  axisLabel, ioMark, dotShape, shapeTitle, ioTitle,
  subagentIndentPx, SESSION_BAND_LABEL_COLOR
} from '../lib/timelineDomain'
import { eventTitle } from '../lib/eventTitle'

const MIN_LANE_H = 36
// A dot is 9px. A lane taller than this is empty space either side of it, and
// on a half-screen window the old `available / rows` division handed every
// band 168px to draw nine pixels in — 159px of nothing per row, four rows
// deep, while the list under it showed six lines.
const MAX_LANE_H = 44
// Wide enough for an indented lane label: the column carries a caret, a band
// name, and under it a dot plus a lane name at a 24px indent. At 92px that
// left ~60px for the name and every label past six characters rendered as an
// ellipsis ("Artifa…", "Scree…", "Clipb…") — a row of labels nobody can read
// is a label column that is not doing its job.
const LABEL_W = 132
// Axis row height: the lanes' 28px, or the ruler's taller one that also holds
// the two marker chip rows under the tick labels.
const AXIS_H_LANES = 28
const AXIS_H_RULER = 48
// Zoom 1 (100%) is the whole loaded span fitted to the window (Stitch 05;
// user decision 2026-11-08). It used to be max(2000px, container): on any
// window narrower than 2000px, 100% was already zoomed in, the 重點視窗 covered
// half the density strip and 重設全貌 did not show the whole. Zooming out past
// the fit only added blank track, so 1 is also the floor.
const MIN_ZOOM = 1
// Track width before the container has been measured: the first frame, and
// any host without ResizeObserver layout (jsdom). The old fixed width.
const UNMEASURED_TRACK_W = 2000
// v0.11.6 (V7): a stretch with no events longer than this collapses to GAP_PX.
// Ten minutes is long enough that nothing routine trips it and short enough to
// catch a coffee break; the fixed width has to stay wide enough to draw a
// legible break marker in.
const GAP_MIN_MS = 10 * 60_000
const GAP_PX = 48
// Browsers cap element width well above this; the ceiling exists so a
// pathological zoom can't allocate a track nothing can scroll.
const MAX_TRACK_W = 400_000
const NO_ROWS: readonly RedLogEvent[] = []

// Read defensively — this runs at module load, before the preload bridge
// is guaranteed present (e.g. in tests). Default to mac styling, as App does.
const isMacPlatform = isMac

// A switch rather than a code→key lookup table, so every key appears inside a
// literal t() call: test/i18n-keys.test.ts can only see those, and a table of
// key STRINGS would leave all four unchecked — which is exactly how a key that
// renders as `marker.amendErr.notFound` to the operator gets shipped.
function amendErrorWhy(code: string, t: (k: string) => string): string | undefined {
  switch (code) {
    case 'not-found': return t('marker.amendErr.notFound')
    case 'not-a-marker': return t('marker.amendErr.notAMarker')
    case 'invalid-changes': return t('marker.amendErr.invalidChanges')
    case 'no-active-project': return t('marker.amendErr.noActiveProject')
    default: return undefined
  }
}

interface TimelinePanelProps {
  focusEventId?: string
  focusTs?: number
  onDropMarker?: (ts: number) => void
  onOpenInActivity?: (eventId: string, ts: number) => void
  tierChip?: boolean
}

type SharedFilterSlice = Pick<ReturnType<typeof useSharedFilter>, 'filter' | 'personalDomains' | 'setTimeRange'>

/** The shared filter's provider changes its value on every live batch (it
 *  counts targets as they arrive), and the App re-creates its callbacks on
 *  every render of its own. Neither is a reason to re-render this panel: it
 *  takes the three filter values it reads, and the callbacks through a ref,
 *  and renders when one of those, or a prop, actually changes. */
export default function TimelinePanel(props: TimelinePanelProps = {}): JSX.Element {
  const { filter, personalDomains, setTimeRange } = useSharedFilter()
  const latest = useRef(props)
  latest.current = props
  const has = { drop: !!props.onDropMarker, inActivity: !!props.onOpenInActivity }
  const onDropMarker = useMemo(() => (has.drop ? (ts: number) => latest.current.onDropMarker?.(ts) : undefined), [has.drop])
  const onOpenInActivity = useMemo(() => (has.inActivity ? (id: string, ts: number) => latest.current.onOpenInActivity?.(id, ts) : undefined), [has.inActivity])
  const shared = useMemo<SharedFilterSlice>(() => ({ filter, personalDomains, setTimeRange }), [filter, personalDomains, setTimeRange])
  return (
    <TimelinePanelView
      focusEventId={props.focusEventId} focusTs={props.focusTs} tierChip={props.tierChip}
      onDropMarker={onDropMarker} onOpenInActivity={onOpenInActivity}
      shared={shared}
    />
  )
}

const TimelinePanelView = memo(function TimelinePanelView({ focusEventId, focusTs, onDropMarker, onOpenInActivity, tierChip = true, shared }: TimelinePanelProps & { shared: SharedFilterSlice }): JSX.Element {
  // Spec 038: the shared filter is applied where the events are stored, for
  // every page, count and live row. Nothing below filters on it again.
  const { filter: sharedFilter, personalDomains, setTimeRange: setSharedTimeRange } = shared
  const eventFilter = useMemo(() => toEventFilter(sharedFilter), [sharedFilter])
  const eventFilterRef = useRef(eventFilter)
  eventFilterRef.current = eventFilter
  const [rawEvents, setEvents] = useState<RedLogEvent[]>([])
  // v0.9.3 U3: agent-session collapse toggle. When on, hide per-turn agent
  // subtypes (user_message / assistant_message / tool_call / tool_result /
  // thinking / compact_summary) — leaving transcript_snapshot + session_end
  // so a 500-turn Claude session shows as 2-4 dots instead of drowning the
  // agent lane. Per-project persisted; default off (existing operators
  // don't lose visibility on upgrade). Toggle chip in the header + `?`
  // cheatsheet lists it.
  const [collapseAgentTurns, setCollapseAgentTurns] = usePersistentState<boolean>(
    'redlog-timeline-collapse-agent', false,
    { parse: (raw) => raw === '1', serialize: (v) => (v ? '1' : '0') }
  )
  // Hide command_start once its matching command_end lands — the end has the
  // exit code + duration, so the start would just be a duplicate row.
  // v0.9.3: also drops per-turn agent events when the collapse toggle is on.
  // The tier is not decided here (spec 038): "Chained only" is a shared-filter
  // condition, so a logged row never reaches rawEvents under it.
  //
  // This and every structure derived from the rows below goes through
  // `useTimelineDerived`: a live flush appends rows, and each structure folds in
  // only those (lib/timelineIncremental) instead of walking every loaded row
  // again. A flush that lands in the middle rebuilds, with the same result.
  const events = useTimelineDerived(drawnEvents, rawEvents, collapseAgentTurns).out
  // Starts with no end in what is loaded: "running or unknown", not failed.
  const unfinishedIds = useTimelineDerived(unfinishedCommands, rawEvents).out
  // Count of hidden agent turns to surface on the chip so the operator
  // knows the toggle is doing something (else the empty agent lane looks
  // like a bug).
  const collapsibleTurns = useTimelineDerived(collapsibleTurnCount, rawEvents)
  const hiddenAgentTurnCount = collapseAgentTurns ? collapsibleTurns : 0
  // A tool_call and its tool_result are two separate chained events (each
  // independently hashed + timestamped, so the chain records real call→return
  // latency and order). That makes the exchange easy to audit but splits it
  // across two dots. This index maps tool_use_id → each half in the loaded set
  // so the detail panel can show the other half inline (see pairedToolHalf).
  // Keyed on rawEvents so it still finds a result the agent-turn collapse hides;
  // a partner not yet paged in is simply absent — a graceful no-op.
  const toolPairByUseId = useTimelineDerived(toolPairs, rawEvents)
  const { selectedEvent, selectedRef, setSelectedEvent, detailOpen, setDetailOpen, readerMode, setReader } = useTimelineInspector()
  // A selection made in another view that is older than the drawn range: it is
  // loaded back to and opened exactly like an explicit "open in Timeline".
  const [restoreFocusId, setRestoreFocusId] = useState<string | undefined>(undefined)
  const [dneFlag, setDneFlag] = useState(false)
  // §6: the Inspector is a separate layer from the selection. They used to be
  // the same state, so an operator could not walk the timeline by keyboard
  // without a panel covering a third of it — and closing the panel lost their
  // place entirely. Clicking a dot still opens both; arrows move the ring
  // alone, and Enter opens the panel on whatever the ring is on.
  // Selecting shows the bar; the Inspector body is `detailOpen`, opened on
  // purpose (double-click, Enter, the bar's Details) or by arriving from
  // another page. It is only ever open while something is selected.

  // The one contiguous range the panel draws: every admitted row from the
  // newest down to `pageCursor`, the keyset position the next page starts at.
  // A shared-filter change starts a new generation; a reply to an older one
  // is dropped, so rows for the old filter never land under the new one.
  // First to last loaded row, for the toolbar's "whole session" span. A loop,
  // not Math.max(...rows): a spread of a large page overflows the call stack.
  const loadedExtent = useTimelineDerived(timestampExtent, rawEvents)
  const loadedBounds = useMemo(
    () => (loadedExtent.n < 2 ? null : { lo: loadedExtent.lo, hi: loadedExtent.hi }),
    [loadedExtent]
  )
  const loadedSpanMs = loadedBounds ? loadedBounds.hi - loadedBounds.lo : null
  // First and last row the filter admits across the whole project (069 B,
  // `events:span`), asked with the total. Rows that arrive live after the
  // answer widen it from the loaded bounds rather than re-asking. Null while
  // pending or after a failure, and the toolbar then falls back to the loaded
  // span once nothing older is left to load.
  const generationRef = useRef(0)
  const { total, projectBounds, requestTotal, admitCount } = useTimelineSummary(eventFilterRef, generationRef)
  const projectSpanMs = useMemo(() => {
    if (!projectBounds) return null
    const first = loadedBounds ? Math.min(projectBounds.first, loadedBounds.lo) : projectBounds.first
    const last = loadedBounds ? Math.max(projectBounds.last, loadedBounds.hi) : projectBounds.last
    return last - first
  }, [projectBounds, loadedBounds])
  // "N of M": M counted over the same predicates as the pages. Pending until
  // it arrives, failed (with retry) rather than guessed.
  const [liveError, setLiveError] = useState<{ ids: RedLogEvent[] } | null>(null)
  const [outsideFilter, setOutsideFilter] = useState(false)
  // v0.11.6 (V7). Off by default: a compressed axis is not proportional, and
  // for an audit tool that has to be an explicit, visible choice.
  const [compressGaps, setCompressGaps] = useState(false)
  const [containerH, setContainerH] = useState(0)
  // v0.11.6 (V8): the track's base width follows the container, so the
  // observer has to report width as well as height.
  const [containerW, setContainerW] = useState(0)
  // The track scroller's visible width, the width zoom 1 fits (see below).
  const [scrollerW, setScrollerW] = useState(0)
  // v0.6.91 S4: persisted zoom. Clamped to [MIN_ZOOM, 6] so a garbage value in
  // storage — or one saved when zoom could go below the fit — can't produce a
  // broken layout.
  const [zoom, setZoom] = useTimelineZoom(MIN_ZOOM)
  const [cluster, setCluster] = useState<{ x: number; y: number; events: RedLogEvent[] } | null>(null)
  // The cluster popover is drawn on the track column and placed from the
  // lanes' box (see the popover below).
  const trackColumnRef = useRef<HTMLDivElement>(null)
  const lanesAreaRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x0: number; x1: number; w: number } | null>(null)
  // Where to put the view once a zoom from the minimap has re-rendered: a time
  // for a drag-to-zoom across the strip, a track fraction for a resized 重點視窗.
  // A 重點視窗 resize in progress. The zoom lands on release; until then this is
  // the outline the operator is dragging.
  const [winDrag, setWinDrag] = useState<MinimapWindow | null>(null)
  // Cluster-item click needs a two-frame handshake: bump zoom so the events
  // split into distinct dots, then center on the picked one after re-render.
  // We can't scroll synchronously because TRACK_W hasn't grown yet.
  // v0.6.91 S4: hidden-lane visibility now persists across mounts so an
  // operator who solo'd "shell" doesn't lose that filter after a reload.
  // Stored as a JSON array of lane ids; unknown ids (renamed lanes from an
  // old release) are dropped silently.
  // Which capture-group bands are collapsed to a single aggregate row (§6).
  // Default: all collapsed, so the timeline opens as three or four bands
  // instead of up to eighteen lanes. The operator expands the one they are
  // working in. Persisted per project.
  // Default all bands collapsed; the per-project stored set (if any) is loaded
  // when the project id resolves, in the effect below.
  const [collapsedBands, setCollapsedBands] = useState<Set<BandId>>(() => new Set(BANDS.map((b) => b.id)))
  const bandsLoadedFor = useRef<string | null>(null)
  const [hiddenLanes, setHiddenLanes] = useState<Set<LaneId>>(() => new Set())
  const [showJson, setShowJson] = useState(false)
  // v0.9.3 U2: keyboard-shortcut cheatsheet modal. Every hotkey RedLog has
  // added since v0.6.90 was previously invisible unless a teammate told you.
  // `?` opens; Escape or click-outside closes.
  const [showHelp, setShowHelp] = useState(false)
  // The two horizontal splits, both drag-resizable, both remembered. The log
  // was the one that could not be dragged — the panel a three-day engagement
  // spends all day reading, frozen at 22vh while the detail panel below it
  // moved freely.
  // Bottom or beside. The stored size is keyed per layout: 320px of height and
  // 320px of width are not the same request, and one number serving both meant
  // switching gave you a pane sized for the other axis.
  // A narrow pane has no room beside the list: below 960px the pane docks at
  // the bottom, as HTTP History's does, and the stored choice comes back when
  // the pane is wide again.
  const [preferredLayout, setPreferredLayout] = useState<DetailLayout>(storedDetailLayout)
  const [splitRef, splitWidth] = useContainerWidth<HTMLDivElement>()
  const compactSplit = splitWidth !== null && splitWidth < 960
  const layout: DetailLayout = compactSplit ? 'bottom' : preferredLayout
  useEffect(() => {
    const onChange = (): void => setPreferredLayout(storedDetailLayout())
    window.addEventListener(DETAIL_LAYOUT_EVENT, onChange)
    return () => window.removeEventListener(DETAIL_LAYOUT_EVENT, onChange)
  }, [])
  const detailPanel = usePanelHeight(
    layout === 'right' ? 'redlog-timeline-detail-w' : 'redlog-timeline-detail-h',
    layout === 'right' ? { axis: 'x', min: 280, maxRatio: 0.6 } : {}
  )
  // Detail panel container. Reset scroll to top on every selectedEvent change
  // so a cluster-popover click always lands you on the new item's title —
  // otherwise the panel keeps whatever scroll offset the prior event left
  // (with JSON expanded the title easily scrolls off screen).
  const detailPanelRef = useRef<HTMLDivElement | null>(null)
  const [operatorNames, setOperatorNames] = useState<Record<string, string>>({})
  // v0.6.89.5: focus chain / broken-chain state.
  //
  // `focusChain` (feature 2) is a set of every event id in the causal
  // component of the anchor — null means the filter is off. Persisted as
  // just the anchor id so a stale set can't leak across mounts.
  // `verifyResult` (feature 5) is the last full-chain-verify outcome; read
  // from the module cache on mount and refreshed via a window event.
  const [focusChain, setFocusChain] = useState<Set<string> | null>(null)
  const [focusAnchorId, setFocusAnchorId] = useState<string | null>(null)
  // `excluded`: chain links the shared filter does not admit. They stay out
  // of the drawn range, like every other excluded row, and the badge says so.
  const [focusMeta, setFocusMeta] = useState<{ loading: boolean; truncated: boolean; unavailable: number; failed: boolean; excluded?: number }>({
    loading: false, truncated: false, unavailable: 0, failed: false
  })
  // Project state is keyed by project id. The `__global__` sentinel covers
  // first-run and test screens where no project is active.
  const [projectIdForKeys, setProjectIdForKeys] = useState<string | null>(null)
  // Project-scoped band-collapse load (placed AFTER projectIdForKeys is
  // declared — its dep array evaluates during render, so an earlier placement
  // is a temporal-dead-zone crash the e2e caught).
  useEffect(() => {
    if (!projectIdForKeys) return
    if (bandsLoadedFor.current === projectIdForKeys) return
    bandsLoadedFor.current = projectIdForKeys
    try {
      const raw = localStorage.getItem(`redlog-timeline-collapsed-bands:${projectIdForKeys}`)
      if (raw === null) { setCollapsedBands(new Set(BANDS.map((b) => b.id))); return }
      const arr = JSON.parse(raw)
      setCollapsedBands(new Set((Array.isArray(arr) ? arr : []).filter((b): b is BandId => BANDS.some((x) => x.id === b))))
    } catch { setCollapsedBands(new Set(BANDS.map((b) => b.id))) }
  }, [projectIdForKeys])

  // Spec 069 FR-008: "standard" is a single sequential list; "lanes" adds the
  // swim-lane track above it. Selection, zoom and hidden lanes live above this
  // switch, so changing mode never discards them. Remembered per project.
  const [timelineMode, setTimelineMode] = useState<TimelineMode>('standard')
  // v0.6.91 W1: the `/` box. Persisted per project; empty string means "no
  // filter". Declared here because the load effect below restores it.
  const [filterQuery, setFilterQuery] = useState('')
  // What the operator typed this visit is never overwritten by what is
  // restored: the project's stored settings arrive asynchronously (one IPC
  // round trip, seconds late under a capture burst), and applying them after
  // the operator had started typing replaced the box with the stored query, or
  // restored a focus anchor whose chain then cleared the box.
  const queryTouchedRef = useRef(false)
  const filterQueryRef = useRef(filterQuery)
  filterQueryRef.current = filterQuery
  const typeFilterQuery = useCallback((value: string): void => {
    queryTouchedRef.current = true
    setFilterQuery(value)
  }, [])
  // How this mount was opened, decided once: later prop changes in the same
  // mount are navigation inside the panel, not a new arrival.
  const arrivalRef = useRef<{ kind: 'plain' | 'focus-id' | 'focus-ts'; id?: string }>(
    focusEventId ? { kind: 'focus-id', id: focusEventId } : { kind: focusTs ? 'focus-ts' : 'plain' }
  )
  // A stored query held back on a focus arrival (it may dim the event the
  // operator jumped to). While set, the box is untouched and an empty box does
  // not erase the stored value; the operator's first non-empty input clears it.
  const heldQueryRef = useRef<string | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])
  const settingsLoadedFor = useRef<string | null>(null)
  useEffect(() => {
    // v0.6.100 F5: fall back to `__global__` sentinel when there's no active
    // project (or the call rejects). Anything downstream that reads
    // `projectIdForKeys` gets a stable key rather than a persistent-write
    // dead zone.
    window.redlog.project.active()
      .then((p) => setProjectIdForKeys(p?.id ?? '__global__'))
      .catch(() => setProjectIdForKeys('__global__'))
  }, [])
  useEffect(() => {
    if (!projectIdForKeys) return
    if (settingsLoadedFor.current === projectIdForKeys) return
    settingsLoadedFor.current = projectIdForKeys
    const load = <T,>(base: string, decode: (s: string) => T, apply: (v: T) => void): void => {
      try {
        const stored = localStorage.getItem(`${base}:${projectIdForKeys}`)
        if (stored !== null) apply(decode(stored))
      } catch { /* ignore */ }
    }
    load('redlog-timeline-mode', parseTimelineMode, setTimelineMode)
    load('redlog-timeline-focus-anchor', (s) => s, (anchor) => { if (!filterQueryRef.current) setFocusAnchorId(anchor) })
    load('redlog-timeline-filter-query', (s) => s, (stored) => {
      if (queryTouchedRef.current) return
      const { kind, id: focusId } = arrivalRef.current
      if (!stored || kind === 'plain') { setFilterQuery(stored); return }
      heldQueryRef.current = stored
      if (kind !== 'focus-id' || !focusId) return
      // A return visit (goBack) arrives with the id too: keep the query when
      // the event it focuses is one the query matches. Same parse and request
      // shape as the box itself; unparsable or a failed check is "no match".
      const outcome = stored.trim() ? parseQuery(stored) : null
      if (!outcome?.ok) return
      window.redlog.events.matchIds({
        ids: [focusId], parsed: outcome.parsed, filter: eventFilterRef.current, excludeHousekeeping: true
      }).then((hit) => {
        if (!aliveRef.current || heldQueryRef.current !== stored || queryTouchedRef.current) return
        if (!hit.includes(focusId)) return
        heldQueryRef.current = null
        setFilterQuery(stored)
      }).catch(() => { /* stays held: box empty, stored value kept */ })
    })
    load('redlog-timeline-hidden-lanes', (s) => {
      try {
        const arr = JSON.parse(s)
        return new Set((Array.isArray(arr) ? arr : []).filter((l): l is LaneId => LANES.includes(l as LaneId)))
      } catch { return new Set<LaneId>() }
    }, setHiddenLanes)
  }, [projectIdForKeys])
  const [verifyResult, setVerifyResult] = useState<FullVerifyResult | null>(() => getLastVerifyResult())
  const [verifyDismissed, setVerifyDismissed] = useState(false)
  useEffect(() => {
    const onUpdate = (): void => {
      setVerifyResult(getLastVerifyResult())
      setVerifyDismissed(false)
    }
    window.addEventListener(VERIFY_UPDATED_EVENT, onUpdate)
    return () => window.removeEventListener(VERIFY_UPDATED_EVENT, onUpdate)
  }, [])
  useEffect(() => {
    if (!projectIdForKeys) return
    try {
      const scoped = `redlog-timeline-focus-anchor:${projectIdForKeys}`
      if (focusAnchorId) localStorage.setItem(scoped, focusAnchorId)
      else localStorage.removeItem(scoped)
    } catch { /* ignore */ }
  }, [focusAnchorId, projectIdForKeys])

  // v0.6.91 W1: inline `/` search — dims events whose title / command / URL /
  // host / operator doesn't substring-match the query. Persisted so the
  // filter survives a reload; empty string means "no filter".
  // The target is not a Timeline control (spec 038): it is the shared
  // filter's target_id, set by the FilterBar or by the Targets page, and the
  // pages above never return a row outside it.

  useEffect(() => {
    if (!projectIdForKeys) return
    if (heldQueryRef.current !== null) {
      if (!filterQuery) return
      heldQueryRef.current = null
    }
    try {
      const scoped = `redlog-timeline-filter-query:${projectIdForKeys}`
      if (filterQuery) localStorage.setItem(scoped, filterQuery)
      else localStorage.removeItem(scoped)
    } catch { /* ignore */ }
  }, [filterQuery, projectIdForKeys])
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // v0.6.91 W2: follow mode — auto-scrolls the track's right edge to keep the
  // newest event visible while enabled. On by default; the header badge
  // reflects "🔴 LIVE" vs "⏸ Xm behind" state. The badge keeps its own
  // one-second clock (FollowBadge): it used to tick here and re-render the
  // whole panel every second for one label.
  const [followMode, setFollowMode] = usePersistentState<boolean>(
    'redlog-timeline-follow-mode', true,
    { parse: (raw) => raw !== '0', serialize: (v) => (v ? '1' : '0') }
  )

  // v0.6.91 S3: dashed vertical dividers + faint bands for shell.session_end
  // and system.recording_paused/resumed pairs. Toggle persisted; default on
  // because it's the primary visual anchor when reviewing a multi-terminal
  // engagement.
  const [sessionDividers, setSessionDividers] = usePersistentState<boolean>(
    'redlog-timeline-session-dividers', true,
    { parse: (raw) => raw !== '0', serialize: (v) => (v ? '1' : '0') }
  )

  // The display zone is not a Timeline setting (spec 038): it is chosen in
  // Settings ▸ General and `lib/time`'s formatters print in it. This view is
  // unmounted while Settings is open, so it prints the new zone on return.

  // ⌘F focuses the in-page filter (§5.7, §10). `/` still does too — it is the
  // chord this view taught first and there is no reason to take it away — but
  // ⌘F is the one an operator arrives already knowing.
  useEffect(() => {
    const onFind = (): void => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    window.addEventListener('redlog:find-in-page', onFind)
    return () => window.removeEventListener('redlog:find-in-page', onFind)
  }, [])

  // ⌘K → an operator → filter this view to what that person did. The palette
  // cannot reach into the Timeline's filter state, so it asks by event. The
  // pick arrives as the recorded operator id and becomes the query contract's
  // `operator:` condition (spec 038 FR-009); names change, ids do not.
  useEffect(() => {
    const onFilterOperator = (e: Event): void => {
      const id = (e as CustomEvent<string>).detail
      if (id) typeFilterQuery(`operator:${id}`)
    }
    window.addEventListener('redlog:filter-operator', onFilterOperator)
    // §10: ⌘K host search lands the operator on the Timeline with that host
    // as quoted text: a phrase, so `10.0.0.5:8080` is never read as a field.
    const onFilterHost = (e: Event): void => {
      const host = (e as CustomEvent<string>).detail
      if (host) typeFilterQuery(`"${host.replace(/"/g, '')}"`)
    }
    window.addEventListener('redlog:filter-host', onFilterHost)
    return () => {
      window.removeEventListener('redlog:filter-operator', onFilterOperator)
      window.removeEventListener('redlog:filter-host', onFilterHost)
    }
  }, [])

  // v0.6.91 W1 mutual exclusion: enabling either dim mode clears the other.
  useEffect(() => {
    if (!filterQuery) return
    if (focusAnchorId) setFocusAnchorId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery])

  // Plugin-registered event types (agent_type → lane/color/label mapping).
  // Previously event-registry.ts was a dead facade — plugin events were all
  // bucketed into `system`. Timeline now queries `plugins.eventTypes()` on
  // mount so a plugin advertising `{ agentType: 'burp', lane: 'scanner' }`
  // will render its rows in the scanner lane with the plugin's colour.
  const [pluginTypes, setPluginTypes] = useState<PluginEventType[]>([])
  useEffect(() => {
    void window.redlog.plugins.eventTypes()
      .then((types) => setPluginTypes(types.map((type) => ({
        agentType: type.agentType,
        label: type.label ?? type.agentType,
        lane: type.lane,
        pluginId: type.pluginId ?? 'unknown'
      }))))
      .catch(() => {})
  }, [])

  // On new selection: snap the detail panel back to the top, collapse the JSON
  // dump, and read the selected event's do-not-export flag. (This effect also
  // used to re-mask revealed secrets; in-app masking was removed in §10, so
  // there is nothing left to re-mask.)
  useEffect(() => {
    setShowJson(false)
    setDneFlag(false)
    if (detailPanelRef.current) detailPanelRef.current.scrollTop = 0
    const id = selectedEvent?.id
    if (id) {
      // A late reply belongs to the event it was asked for, not the one
      // selected by the time it lands.
      window.redlog.events.isDoNotExport(id)
        .then((v) => { if (selectedRef.current?.id === id) setDneFlag(v) })
        .catch(() => { /* the switch stays off: unknown is not excluded */ })
    }
  }, [selectedEvent?.id])


  // Known operator ids, held in a ref so the event guard below reads the
  // CURRENT set. It used to read the `operatorNames` state, which the []-dep
  // effect captured empty on first render — so `!operatorNames[id]` was always
  // true and every incoming event fired an operators.list() IPC + a full
  // TimelinePanel re-render, bypassing the events:new-batch throttle during a
  // 200 evt/s capture.
  const knownOperatorsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    // An id the list did not have when it was last read is asked about again
    // at most every few seconds, not on every batch: a row stamped with an
    // operator the list does not carry re-read it, and re-rendered the panel,
    // once per batch of a burst.
    const asked = new Map<string, number>()
    const load = (): void => {
      window.redlog.operators.list().then((ops) => {
        const map: Record<string, string> = {}
        ops.forEach((op) => { map[op.id] = op.name })
        knownOperatorsRef.current = new Set(Object.keys(map))
        setOperatorNames((prev) => {
          const keys = Object.keys(map)
          return keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === map[k]) ? prev : map
        })
      }).catch(() => {})
    }
    load()
    const unsub = window.redlog.events.onNewBatch((events) => {
      let unknown = false
      const now = Date.now()
      for (const e of events) {
        if (!e.operatorId || knownOperatorsRef.current.has(e.operatorId) || now - (asked.get(e.operatorId) ?? -Infinity) < 5000) continue
        asked.set(e.operatorId, now)
        unknown = true
      }
      if (unknown) load()
    })
    return unsub
  }, [])

  const operatorLabel = useCallback((id: string): string => operatorNames[id] || id, [operatorNames])
  // With a single operator the column is the same string on every row — only
  // worth the horizontal space once a second identity shows up.
  const showOperator = Object.keys(operatorNames).length > 1
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const eventsMapRef = useRef(new Map<string, RedLogEvent>())
  // v0.6.95 P1-12: sorted-by-eventCompare array kept in lockstep with the map.
  // Full re-sort of 100k events per flush was 1.7M comparisons; sorted-insert
  // makes an in-order arrival O(1) (push-to-end) and a genuine out-of-order
  // insert O(log n) find + O(n) shift. Kept as a ref (not state) because the
  // memoized `events` still comes from setEvents — sortedRef is just the
  // storage backing that setEvents call.
  const sortedRef = useRef<RedLogEvent[]>([])
  const { didPan, handleMouseDown } = useTimelinePan(scrollRef, () => setCluster(null))
  const didScrollToNow = useRef(false)
  const { t } = useI18n()

  const laneLabels = useMemo(
    () => Object.fromEntries(LANES.map((id) => [id, t(LANE_LABEL_KEYS[id])])) as Record<LaneId, string>,
    [t]
  )

  // The track exists only once there are events: every early return below
  // (loading, failed, empty, all filtered) is `events.length === 0`. Observing
  // on mount alone ran while the spinner was up, found no elements, and never
  // measured anything — so the track sat at UNMEASURED_TRACK_W for good.
  const trackMounted = events.length > 0
  useEffect(() => {
    if (!trackMounted || !containerRef.current) return
    const ro = new ResizeObserver(([entry]) => {
      setContainerH(entry.contentRect.height)
      setContainerW(entry.contentRect.width)
    })
    ro.observe(containerRef.current)
    // The width zoom 1 fits is what the scroller shows, not the wrapper: the
    // lane column's vertical scrollbar sits between them. Fitting the wrapper
    // left the track a scrollbar wider than the view, so at 100% the view was
    // never "whole", follow mode read as scrolled away and the rail fell back
    // to a viewport slice (#650's e2e: a marker missing from the rail).
    const scroller = scrollRef.current
    const so = scroller ? new ResizeObserver(() => setScrollerW(scroller.clientWidth)) : null
    if (scroller && so) so.observe(scroller)
    return () => { ro.disconnect(); so?.disconnect() }
  }, [trackMounted])

  // A lane with no events is dead vertical space — most engagements only ever
  // touch three or four of them. Keep the filter chip so the operator can see
  // the lane exists, but don't give it a row until something lands in it.
  // v0.6.95 P1-12: keyed on pluginTypes too — a plugin-registered event lane
  // has to appear without waiting for an unrelated change.
  const lanesOf = useTimelineDerived(laneIndex, events, pluginTypes)
  const populatedLanes = lanesOf.populated

  // Rows per lane among what is loaded, for the lane headers and the panel
  // title. Not a project total: `hasMore` says older pages are unfetched.
  const laneCounts = lanesOf.counts

  // The lane an event's row is keyed on: its band's id when that band is
  // collapsed, otherwise the lane itself.
  const rowKeyOf = useCallback(
    (lane: LaneId): string => (timelineMode === 'standard' ? STANDARD_ROW : collapsedBands.has(BAND_OF[lane]) ? BAND_OF[lane] : lane),
    [collapsedBands, timelineMode]
  )

  // The rows actually rendered, in band order. A band with any populated lane
  // always contributes its own row, then — when expanded — its populated
  // lanes beneath it. Empty bands contribute nothing, exactly as empty lanes
  // did.
  //
  // The band row is unconditional because it is the grouping the operator
  // navigates by: expanding used to REPLACE "Commands" with its lanes, so the
  // category vanished at the moment it gained children.
  //
  // A hidden lane keeps its row, struck through and empty. Dropping the row
  // meant the only control that could restore the lane was the one that had
  // just removed itself from the screen, which needed a second "+N" control
  // elsewhere to undo it — two numbers deep in a 92px column, neither legible.
  // Hiding is for the lane's dots, which are the noise; the row is the label
  // that says it is off, and clicking it again is the way back.
  const visibleRows = useMemo(() => {
    // Standard mode: one track for everything (Spec 069 FR-008).
    if (timelineMode === 'standard') return populatedLanes.size > 0 ? [STANDARD_ROW] : []
    const rows: string[] = []
    for (const band of BANDS) {
      const popLanes = band.lanes.filter((l) => populatedLanes.has(l))
      if (popLanes.length === 0) continue
      rows.push(band.id)
      if (!collapsedBands.has(band.id)) rows.push(...popLanes)
    }
    return rows
  }, [populatedLanes, collapsedBands, timelineMode])

  // Still keyed on individual lanes; retained for the zoom-ceiling scan below.
  const visibleLanes = useMemo(
    () => LANES.filter((l) => populatedLanes.has(l) && !hiddenLanes.has(l)),
    [populatedLanes, hiddenLanes]
  )

  // Lane height is clamped, not divided.
  //
  // Dividing the container by the row count meant the lanes took whatever
  // space existed whether they could use it or not: measured at 960x1032, the
  // four collapsed bands got 168px each to draw a 9px dot in, so two thirds of
  // the Timeline was lane padding and the list showed six rows. Clamped, the
  // same window gives the lanes 172px total and the list twenty-four rows —
  // and nothing is lost, because nothing was being drawn in the difference.
  //
  // The floor still wins over the ceiling when rows are expanded past what
  // fits: the container scrolls, which is what it did before.
  const laneH = useMemo(() => {
    // Standard mode is one row: it takes the tallest lane and the rest of the
    // panel goes to the card rail. Not derived from `containerH`, because in
    // this mode the measured wrapper is sized to its content (below).
    if (timelineMode === 'standard') return MAX_LANE_H
    if (visibleRows.length === 0) return MIN_LANE_H
    const axisH = 28
    const available = containerH - axisH
    const shareOut = Math.floor(available / visibleRows.length)
    return Math.min(MAX_LANE_H, Math.max(MIN_LANE_H, shareOut))
  }, [containerH, visibleRows.length, timelineMode])

  // Spec 038 (research R1): pages come from the shared-filter page query, on
  // its keyset cursor (timestamp, rowid, tier). The old pager walked
  // `created_at` so a late row with an older wall-clock could not be skipped;
  // a keyset never skips a row past its cursor, and a row that lands inside
  // the drawn range arrives on the live channel below.
  const MATCH_CHUNK = 1000

  const mergeRows = (rows: RedLogEvent[]): void => {
    sortedRef.current = mergeSortedRows(sortedRef.current, eventsMapRef.current, rows)
  }
  // The first page after a reset is published at once: the panel would
  // otherwise show "no events" for the frame between the spinner and the rows.
  const publishNowRef = useRef(true)

  // A selection the new filter excludes is cleared and said to be excluded,
  // never left showing as if it matched.
  const checkSelection = (gen: number): void => {
    const sel = selectedRef.current
    if (!sel || eventsMapRef.current.has(sel.id)) return
    window.redlog.events.matchIds({ ids: [sel.id], filter: eventFilterRef.current, excludeHousekeeping: true })
      .then((ids) => {
        if (gen !== generationRef.current || ids.includes(sel.id)) return
        setSelectedEvent(null)
        setDetailOpen(false)
        setOutsideFilter(true)
      })
      .catch(() => { if (gen === generationRef.current) setLiveError({ ids: [] }) })
  }

  const { pageCursorRef, pageCursor, hasMore, loading, loadError, loadFirstPage, loadMore, acceptPage } = useTimelinePages(eventFilterRef, generationRef, {
    reset: gen => {
      eventsMapRef.current = new Map()
      sortedRef.current = []
      publishNowRef.current = true
      setEvents([])
      setLiveError(null)
      setOutsideFilter(false)
      requestTotal(gen)
    },
    // Later pages share the live pacer: paging a large project in (zoom 1
    // reaches the left edge on every layout) renders as often as the pacer
    // allows, not once per page.
    rows: rows => {
      mergeRows(rows)
      if (!publishNowRef.current) { publishLive.schedule(); return }
      publishNowRef.current = false
      setEvents([...sortedRef.current])
    },
    ready: checkSelection
  })

  // A publish renders synchronously, rows and total together, so the pacer
  // can time it and it costs one render.
  const publishLive = useTimelineLive(eventFilterRef, generationRef, eventsMapRef, sortedRef, {
    publish: setEvents, count: admitCount, commit: (updates) => flushSync(updates),
    failed: batch => setLiveError(batch ? { ids: batch } : null)
  })
  const admitLiveRef = publishLive.admit

  const { timeStart, timeEnd, ticks } = useMemo(() => computeDomainBounds(events), [events])


  // The standard ruler runs the full width: it has no label column to leave
  // room for. The swim lanes keep theirs.
  const labelW = timelineMode === 'standard' ? 0 : LABEL_W
  const axisH = timelineMode === 'standard' ? AXIS_H_RULER : AXIS_H_LANES
  const baseTrackW = scrollerW > 0 ? scrollerW : containerW > 0 ? Math.max(1, containerW - labelW) : UNMEASURED_TRACK_W
  const TRACK_W = Math.min(MAX_TRACK_W, Math.round(baseTrackW * zoom))
  const timeSpan = timeEnd - timeStart
  // v0.11.6 (AUDIT V7): optional idle-gap compression.
  //
  // Time on the track is strictly linear, which is honest but wastes the
  // screen: a two-hour lunch takes the same width as two hours of contact, so
  // thirty minutes of dense work gets squeezed into a tenth of the track while
  // most of it shows nothing. Zooming in to read the burst then scrolls the
  // context off the sides.
  //
  // With compression on, any stretch longer than GAP_MIN_MS with no events
  // collapses to a fixed GAP_PX, drawn with a break marker so the discontinuity
  // is visible rather than implied. Everything else keeps its proportion.
  //
  // Off by default. A compressed axis is no longer proportional, and for an
  // audit tool "the gap you are looking at is not to scale" has to be the
  // operator's explicit choice, announced on screen.
  // Every drawn row in display order (the standard track), and its display
  // times, already sorted: the time map and the minimap read these.
  const standardTrack = useTimelineDerived(singleTrack, events)
  const trackStamps = useTimelineDerived(displayStamps, standardTrack)
  const timeMap = useMemo<TimeMap>(() => buildTimeMap({
    displayTimestamps: trackStamps,
    timeStart, timeEnd, timeSpan, trackW: TRACK_W,
    compressGaps, gapMinMs: GAP_MIN_MS, gapPx: GAP_PX
  }), [compressGaps, trackStamps, timeStart, timeEnd, timeSpan, TRACK_W])

  const toX = useCallback((ts: number) => timeMap.toX(ts), [timeMap])
  const fromX = useCallback((px: number) => timeMap.fromX(px), [timeMap])

  const totalH = visibleRows.length * laneH

  const swimLaneRows = useTimelineDerived(swimRows, events, visibleRows, collapsedBands, pluginTypes, hiddenLanes)
  const rowEvents = useMemo(
    () => timelineMode === 'standard' ? { [STANDARD_ROW]: standardTrack } : swimLaneRows,
    [timelineMode, standardTrack, swimLaneRows]
  )

  // Spec 038 US3: the box is read by the query contract — the same parse,
  // conditions and text matching as Search — and the persistence layer says
  // which drawn rows match. Nothing typed here removes a row: the rest stay
  // drawn, dimmed, so a match keeps its context (FR-004). Debounced so a held
  // key or a fast typist does not query per character.
  const [filterQueryDebounced, setFilterQueryDebounced] = useState(filterQuery)
  useEffect(() => {
    const id = window.setTimeout(() => setFilterQueryDebounced(filterQuery), 120)
    return () => window.clearTimeout(id)
  }, [filterQuery])
  const parseOutcome = useMemo(
    () => (filterQueryDebounced.trim() ? parseQuery(filterQueryDebounced) : null),
    [filterQueryDebounced]
  )
  const parsedQuery = parseOutcome?.ok ? parseOutcome.parsed : null
  const filterKey = JSON.stringify(eventFilter)
  const queryKey = parsedQuery ? `${JSON.stringify(parsedQuery)}|${filterKey}` : null

  // Which loaded rows the query matches, checked by id and cached per query
  // and filter, so each new page or live row is asked about once.
  // `asked` is the row array whose every id has been asked about (or is being
  // asked about), so a flush that appended to it asks about the new rows only;
  // `inflight` holds the answer back until every check under way has replied.
  type MatchCache = { key: string | null; checked: Map<string, boolean>; hits: Set<string>; asked: readonly RedLogEvent[] | null; inflight: number }
  const freshMatchCache = (key: string | null): MatchCache => ({ key, checked: new Map(), hits: new Set(), asked: null, inflight: 0 })
  const matchCacheRef = useRef<MatchCache>(freshMatchCache(null))
  const [matchedIds, setMatchedIds] = useState<Set<string> | null>(null)
  const [boxState, setBoxState] = useState<'idle' | 'matching' | 'matched' | 'failed'>('idle')
  const [boxRetry, setBoxRetry] = useState(0)
  useEffect(() => {
    if (!parsedQuery || !queryKey) {
      matchCacheRef.current = freshMatchCache(null)
      setMatchedIds(null)
      setBoxState('idle')
      return
    }
    if (matchCacheRef.current.key !== queryKey) {
      matchCacheRef.current = freshMatchCache(queryKey)
      setMatchedIds(null)
    }
    const cache = matchCacheRef.current
    // A publish with no new match keeps the set it has: under a live burst
    // every flush asks about its rows, and most of them do not match.
    const publish = (): void => {
      if (cache.inflight > 0) return
      setMatchedIds((prev) => (prev && prev.size === cache.hits.size ? prev : new Set(cache.hits)))
      setBoxState('matched')
    }
    const from = cache.asked ? appendedFrom(cache.asked, rawEvents) : -1
    const unchecked = (from >= 0
      ? rawEvents.slice(from).filter((e) => !cache.checked.has(e.id))
      : rawEvents.filter((e) => !cache.checked.has(e.id))).map((e) => e.id)
    cache.asked = rawEvents
    if (unchecked.length === 0) { publish(); return }
    // Rows appended to an answered set are checked without taking the answer
    // back to "matching": the rows already drawn are still answered.
    if (from < 0 || cache.checked.size === 0) setBoxState('matching')
    cache.inflight++
    void (async () => {
      for (let i = 0; i < unchecked.length; i += MATCH_CHUNK) {
        const ids = unchecked.slice(i, i + MATCH_CHUNK)
        const hit = new Set(await window.redlog.events.matchIds({
          ids, parsed: parsedQuery, filter: eventFilterRef.current, excludeHousekeeping: true
        }))
        if (matchCacheRef.current !== cache) return
        for (const id of ids) {
          cache.checked.set(id, hit.has(id))
          if (hit.has(id)) cache.hits.add(id)
        }
      }
      cache.inflight--
      if (matchCacheRef.current === cache) publish()
    })().catch(() => { if (matchCacheRef.current === cache) setBoxState('failed') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, rawEvents, boxRetry])

  // How many matches lie past the drawn range, counted from the page cursor
  // with the same predicates, and the nearest of them to load back to.
  const [earlier, setEarlier] = useState<
    { state: 'none' } | { state: 'pending' } | { state: 'ok'; count: number; nearestId: string | null } | { state: 'failed' }
  >({ state: 'none' })
  const [earlierRetry, setEarlierRetry] = useState(0)
  useEffect(() => {
    if (!parsedQuery || !hasMore || !pageCursor) { setEarlier({ state: 'none' }); return }
    let stale = false
    setEarlier({ state: 'pending' })
    const req = { parsed: parsedQuery, filter: eventFilterRef.current, cursor: pageCursor, excludeHousekeeping: true }
    Promise.all([window.redlog.events.count(req), window.redlog.events.runQuery({ ...req, limit: 1 })])
      .then(([count, nearest]) => {
        if (!stale) setEarlier({ state: 'ok', count, nearestId: nearest.items[0]?.id ?? null })
      })
      .catch(() => { if (!stale) setEarlier({ state: 'failed' }) })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, hasMore, pageCursor, earlierRetry])

  // Kept across flushes only while there is an answer to map; otherwise they
  // follow an empty array and cost nothing.
  const drawnForMatches = useTimelineDerived(drawnMatchIndex, matchedIds ? events : NO_ROWS)
  const loadedForMatches = useTimelineDerived(rowsById, matchedIds ? rawEvents : NO_ROWS)
  const boxLit = useMemo(
    () => (matchedIds
      ? mapMatchesToDrawn(matchedIds, rawEvents, events, { drawn: drawnForMatches.index, loadedById: loadedForMatches.byId })
      : null),
    [matchedIds, rawEvents, events, drawnForMatches, loadedForMatches]
  )
  // Dimming follows only a live answer: an unparsable input, a failed check,
  // or a query whose first answer has not arrived dims nothing.
  const filterMatches = parsedQuery && boxState !== 'failed' && boxLit ? boxLit.lit : null



  // v0.6.89.5: reverse-effects index (feature 1) — `effectsById[causeId] =
  // [effectEventId, ...]`. Built once per events change; O(N × avg-causes).
  // Also the badges index (feature 3) so every dot render is O(1). The
  // broken-at id from the last full verify (feature 5) participates in the
  // badge set so the `⛓️‍💥` badge lights up on the offending row.
  const brokenAtId = verifyDismissed ? null : (verifyResult?.brokenAtEventId ?? null)
  const effectsById = useTimelineDerived(effectsIndex, events)
  // ── What each marker says now (design turn 8b) ─────────────────────────
  //
  // TDZ contract, and it is not theoretical — the e2e has caught this exact
  // mistake twice in this file (see the `collapsedBands` note above). A hook's
  // dependency array evaluates during render, so nothing ABOVE this point may
  // name `foldById` or `titleOf`; every consumer is below.
  //
  // One walk of `events`, whose body is a type test — the marker lane is a
  // rounding error next to a scan's traffic, and this memo runs on every flush.
  const foldById = useTimelineDerived(foldIndex, events)

  // The one place a marker's displayed text is decided. Every consumer calls
  // this rather than `eventTitle` so a corrected finding never shows the words
  // the operator retracted — and so the amendment row itself reads as the
  // correction it is rather than as a second finding.
  const titleOf = useCallback((e: RedLogEvent): string => {
    if (isMarkerAmendment(e)) {
      const d = e.data as Record<string, unknown>
      const original = eventsMapRef.current.get(String(d.markerId))
      const fields = AMENDABLE_FIELDS.filter((f) => d[f] !== undefined)
        .map((f) => t(`marker.field.${f}`)).join('、')
      const of = original ? eventTitle(original, t) : String(d.markerId ?? '')
      return t('marker.amendmentRow', { title: of, fields })
    }
    const fold = foldById.get(e.id)
    if (!fold) return unfinishedIds.has(e.id) ? `${eventTitle(e, t)} · ${t('timeline.command.unfinished')}` : eventTitle(e, t)
    return `${fold.effective.severity.toUpperCase()}: ${fold.effective.title}`
  }, [foldById, t, unfinishedIds])

  // The ruler's two markers. [Focus] is the selected event's instant, [Latest]
  // the newest loaded one; both are track x positions from the same `toX` the
  // dots use, so zoom and pan move them with the dots. A selection outside the
  // loaded domain gets no marker rather than one pinned to an edge.
  const latestShown = useTimelineDerived(latestDisplay, events)
  const rulerLatestTs = Number.isFinite(latestShown) ? latestShown : null
  const rulerFocusTs = selectedEvent ? displayTs(selectedEvent) : null
  const rulerMarkers = useMemo(() => placeRulerMarkers({
    focusX: rulerFocusTs !== null && rulerFocusTs >= timeStart && rulerFocusTs <= timeEnd ? toX(rulerFocusTs) : null,
    latestX: rulerLatestTs !== null ? toX(rulerLatestTs) : null,
    trackW: TRACK_W
  }), [rulerFocusTs, rulerLatestTs, timeStart, timeEnd, toX, TRACK_W])

  // The follow badge and the [Latest] marker do the same thing: scroll to the
  // newest edge and take follow mode back.
  const resumeFollow = useCallback(() => {
    const el = scrollRef.current
    if (el && TRACK_W > 0) el.scrollLeft = Math.max(0, TRACK_W - el.clientWidth)
    setFollowMode(true)
  }, [TRACK_W, setFollowMode])

  // The hover suffix that says a finding has been corrected. Empty for
  // everything else, so it composes into an existing title without a branch.
  const amendSuffix = useCallback((e: RedLogEvent): string => {
    const fold = foldById.get(e.id)
    return fold ? ` · ${t('marker.amendedTimes', { count: fold.amendCount })}` : ''
  }, [foldById, t])
  const amendCountOf = useCallback((id: string) => foldById.get(id)?.amendCount, [foldById])

  // Which violations no longer stand. Both are read from the rows themselves —
  // a `scope_cleared` naming one, or a newer violation covering the same source
  // event — so a withdrawn violation looks withdrawn on the track without the
  // original row being touched. Same slot and same TDZ contract as the fold
  // memos above: nothing higher may name these.
  const observationStanding = useTimelineDerived(observationStandingOf, events)

  const badgesById = useTimelineDerived(badgeIndex, events, brokenAtId, observationStanding.cleared, observationStanding.superseded)

  // Project-wide causal focus. The old implementation walked only the 200 rows
  // currently loaded in Timeline, so an ordinary unpaged cause looked like a
  // broken chain. The backend now traverses both tiers; returned rows are
  // merged into the existing ordered store before the focus set is applied.
  useEffect(() => {
    if (!focusAnchorId) {
      setFocusChain(null)
      setFocusMeta({ loading: false, truncated: false, unavailable: 0, failed: false })
      return
    }
    let cancelled = false
    setFocusChain(null)
    setFocusMeta({ loading: true, truncated: false, unavailable: 0, failed: false })
    void window.redlog.events.causalChain(focusAnchorId).then(async (result) => {
      if (cancelled) return
      if (!result.anchorFound) {
        setFocusChain(null)
        setFocusMeta({ loading: false, truncated: false, unavailable: 0, failed: true })
        return
      }
      // The chain spans the project; only the links the shared filter admits
      // join the drawn range (spec 038 FR-004).
      const fresh = result.events.filter((event) => !eventsMapRef.current.has(event.id))
      const admitted = new Set<string>()
      for (let i = 0; i < fresh.length; i += MATCH_CHUNK) {
        const ids = fresh.slice(i, i + MATCH_CHUNK).map((event) => event.id)
        const hit = await window.redlog.events.matchIds({ ids, filter: eventFilterRef.current, excludeHousekeeping: true })
        for (const id of hit) admitted.add(id)
      }
      if (cancelled) return
      let changed = false
      for (const event of fresh) {
        if (!admitted.has(event.id)) continue
        eventsMapRef.current.set(event.id, event)
        binarySearchInsert(sortedRef.current, event)
        changed = true
      }
      if (changed) setEvents([...sortedRef.current])
      setFocusChain(new Set(result.events.map((event) => event.id)))
      setFocusMeta({
        loading: false,
        truncated: result.truncated,
        unavailable: result.unavailableCauseIds.length,
        failed: false,
        excluded: fresh.length - admitted.size
      })
    }).catch(() => {
      if (cancelled) return
      setFocusChain(null)
      setFocusMeta({ loading: false, truncated: false, unavailable: 0, failed: true })
    })
    return () => { cancelled = true }
  }, [focusAnchorId])

  useEffect(() => {
    if (!focusChain) return
    if (filterQuery) setFilterQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusChain])

  // v0.6.91 S4: persist zoom, hidden lanes, and selected-event id so a
  // Timeline reload lands the operator back where they were.

  useEffect(() => {
    // v0.6.99 A: hidden-lanes is per-project. An operator who solo'd "shell"
    // for triage on Project A shouldn't carry that into Project B's fresh
    // open. Zoom right below stays global — it's a UI density preference,
    // not project state.
    if (!projectIdForKeys) return
    try {
      localStorage.setItem(`redlog-timeline-mode:${projectIdForKeys}`, timelineMode)
      localStorage.setItem(`redlog-timeline-hidden-lanes:${projectIdForKeys}`, JSON.stringify([...hiddenLanes]))
      localStorage.setItem(`redlog-timeline-collapsed-bands:${projectIdForKeys}`, JSON.stringify([...collapsedBands]))
    } catch { /* ignore */ }
  }, [hiddenLanes, collapsedBands, timelineMode, projectIdForKeys])
  // Set once the restore below has had its one attempt. Declared before the
  // save effect, which reads it.
  const initialFocusRestoreRef = useRef(false)
  useEffect(() => {
    try {
      if (selectedEvent?.id) writeSelectedEventId(selectedEvent.id)
      // Nothing is selected on mount, so clearing then erased the id the
      // restore was about to read: clear only once the restore has run.
      else if (initialFocusRestoreRef.current) writeSelectedEventId(null)
    } catch { /* ignore */ }
  }, [selectedEvent])
  // On first successful load, if no explicit prop-driven focus is in play,
  // restore the previously-selected event by id. Bail after one attempt so we
  // don't fight the operator's later clicks.
  useEffect(() => {
    if (initialFocusRestoreRef.current) return
    if (loading || events.length === 0) return
    initialFocusRestoreRef.current = true
    if (focusEventId || focusTs || selectedEvent) return
    try {
      const id = readSelectedEventId()
      if (!id) return
      const evt = eventsMapRef.current.get(id)
      if (evt) { setSelectedEvent(evt); setDetailOpen(true) } else setRestoreFocusId(id)
    } catch { /* ignore */ }
  }, [loading, events, focusEventId, focusTs, selectedEvent])

  // Collapse events that fall within ~14px of each other on the same lane into a
  // single clickable marker (with a count) so dense bursts stay legible. Zooming
  // in widens the track, so clusters naturally split apart into individual dots.
  const CLUSTER_PX = 14

  // v0.11.6 (AUDIT V13): the zoom ceiling follows event density.
  //
  // It was a flat 6. A burst of thousands of events inside one second — a
  // scanner run, an agent tool loop — collapses into a single cluster, and no
  // amount of zooming could pull it apart: the popup lists 50 and the rest
  // were unreachable through the UI entirely. The events were in the chain and
  // in the export, just not viewable.
  //
  // The ceiling now comes from the tightest gap between two events in the same
  // lane: enough zoom to put CLUSTER_PX between them. Sparse projects keep a
  // ceiling near 6 (nothing to gain); a dense burst raises it as far as that
  // burst needs. Virtualisation (v0.11.1) means a wider track costs no extra
  // DOM, which is what makes this affordable.
  // The gap is kept per flush (lib/timelineIncremental): between consecutive
  // display times on the one standard track, or within each lane, in order.
  const standardGap = useTimelineDerived(trackGap, standardTrack).min
  const swimGap = useTimelineDerived(laneGap, events, pluginTypes).min
  const maxZoom = useMemo(() => computeMaxZoom({
    // One track in standard mode, so the tightest gap is between ANY two events.
    tightestGap: timelineMode === 'standard' ? standardGap : swimGap,
    timeSpan,
    clusterPx: CLUSTER_PX,
    maxTrackW: MAX_TRACK_W,
    baseTrackW
  }), [standardGap, swimGap, timeSpan, timelineMode, baseTrackW])
  // The wheel handler is bound once and reads this through a ref rather than
  // re-binding on every density change.
  const maxZoomRef = useRef(maxZoom)
  useEffect(() => { maxZoomRef.current = maxZoom }, [maxZoom])
  // A lone event's dot as the track draws it, so clustering merges exactly the
  // marks that would overlap (severity enlarges a dot, a subagent turn indents it).
  const singleMark = useCallback((e: RedLogEvent) => ({
    w: Math.round(SINGLE_DOT_PX * dotShape(e, foldById.get(e.id)?.effective.severity).scale),
    dx: subagentIndentPx(e)
  }), [foldById])
  const clusters = useMemo(
    () => buildClusters(visibleRows, rowEvents, toX, laneH, CLUSTER_PX, pluginTypes, singleMark),
    [visibleRows, rowEvents, toX, laneH, pluginTypes, singleMark]
  )

  // Only terminal ends and recording pauses make a band; the domain moves on
  // every flush, so the bands are re-placed from those few rows.
  const boundaryRows = useTimelineDerived(sessionBoundaries, events)
  const sessionBands = useMemo<SessionBand[]>(() => {
    if (!sessionDividers) return []
    return buildSessionBands(boundaryRows, toX, {
      termLabel: (id) => t('timeline.boundaries.termLabelFmt', { id }),
      pausedLabel: t('timeline.boundaries.pausedLabel')
    }, timeEnd)
  }, [boundaryRows, sessionDividers, toX, t, timeEnd])

  // Density minimap: event counts over the full range, binned into fixed cells.
  const bins = useMemo(() => computeBins(trackStamps, timeStart, timeEnd), [trackStamps, timeStart, timeEnd])
  const dense = useMemo(() => densestRun(bins, timeStart, timeEnd), [bins, timeStart, timeEnd])
  const denseBins = useMemo(
    () => (dense ? binRange(dense.start, dense.end, timeStart, timeEnd, bins.N) : null),
    [dense, timeStart, timeEnd, bins.N]
  )
  const densestLabel = dense
    ? t(hasMore ? 'timeline.densestLoaded' : 'timeline.densest', {
      // HH:MM, as the prototype; a stretch inside one minute would read
      // "15:46 ~ 15:46", so it gets seconds instead.
      ...(formatTime(dense.start) === formatTime(dense.end)
        ? { from: formatTime(dense.start, { seconds: true }), to: formatTime(dense.end, { seconds: true }) }
        : { from: formatTime(dense.start), to: formatTime(dense.end) })
    })
    : ''

  // Keep the minimap's "current viewport" window in sync with the scroll/zoom.
  // v0.11.1: render only the clusters near the viewport.
  //
  // Every cluster across the whole track was in the DOM regardless of where
  // the operator was looking. The track is baseTrackW * zoom wide — 12000px
  // at max zoom — while the window shows around 1200px, so ~90% of the nodes
  // existed purely to be scrolled past. Each is an absolutely-positioned div
  // with a child, and dimmed ones stay in the tree at opacity 0.15, so
  // filtering costs nothing that dimming was already paying for.
  //
  // x is computed in the clusters memo, so this is a numeric filter over an
  // array — far cheaper than the DOM nodes it removes. The buffer is one
  // viewport on each side, which is what stops nodes popping in during a drag
  // and covers the gap between a scroll event and this state landing.
  const { view, atRightEdge, updateView, afterLayout, pendingView, pendingCenterTs, pendingZoomAnchor } = useTimelineViewport(
    scrollRef, { width: TRACK_W, start: timeStart, end: timeEnd, map: timeMap },
    { hasMore, loading, loadMore }, { enabled: followMode, revision: events }
  )
  const visibleClusters = useMemo(
    () => filterVisibleClusters(clusters, TRACK_W, view.left, view.width),
    [clusters, view.left, view.width, TRACK_W]
  )

  // Drag across the minimap to zoom the main view to that window; click to jump.
  const onMinimapDown = useCallback((e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const w = rect.width
    const clamp = (v: number): number => Math.max(0, Math.min(v, w))
    const startX = clamp(e.clientX - rect.left)
    setCluster(null)
    const onMove = (me: MouseEvent): void => setDrag({ x0: startX, x1: clamp(me.clientX - rect.left), w })
    const onUp = (ue: MouseEvent): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setDrag(null)
      const el = scrollRef.current
      if (!el) return
      const endX = clamp(ue.clientX - rect.left)
      const span = (timeEnd - timeStart) || 1
      if (Math.abs(endX - startX) > 4) {
        const f0 = Math.min(startX, endX) / w
        const frac = Math.max(0.01, Math.abs(endX - startX) / w)
        pendingView.current = { t0: timeStart + f0 * span }
        setZoom(Math.max(MIN_ZOOM, Math.min(maxZoomRef.current, el.clientWidth / (baseTrackW * frac))))
      } else {
        const t = fromX((startX / w) * TRACK_W)
        el.scrollLeft = Math.max(0, Math.min(((t - timeStart) / span) * TRACK_W - el.clientWidth / 2, TRACK_W - el.clientWidth))
        updateView()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    setDrag({ x0: startX, x1: startX, w })
  }, [timeStart, timeEnd, TRACK_W, updateView])

  // 重點視窗: the viewport frame on the minimap is a handle, not just a readout.
  // Dragging its body pans the track live; dragging a grip resizes it, and the
  // zoom that fits the new width lands on release (re-zooming on every mouse
  // move would re-layout the whole track per frame). It works in track
  // fractions, the same units the frame is drawn in.
  const onWindowDown = useCallback((grip: WindowGrip, e: React.MouseEvent) => {
    if (e.button !== 0) return
    // The strip under the window drags-to-zoom; this gesture is the window's.
    e.stopPropagation()
    e.preventDefault()
    const strip = (e.currentTarget as HTMLElement).closest('[data-testid="timeline-minimap"]') as HTMLElement | null
    const el = scrollRef.current
    if (!strip || !el || TRACK_W <= 0) return
    const w = strip.getBoundingClientRect().width || 1
    const startX = e.clientX
    const start: MinimapWindow = { left: view.left / 100, width: Math.min(1, view.width / 100) }
    // The narrowest window the zoom limit can show.
    const minWidth = Math.min(1, el.clientWidth / (baseTrackW * maxZoomRef.current))
    setCluster(null)
    let last = start
    const onMove = (me: MouseEvent): void => {
      last = dragMinimapWindow(start, grip, (me.clientX - startX) / w, minWidth)
      if (grip === 'move') {
        el.scrollLeft = last.left * TRACK_W
        updateView()
      } else {
        setWinDrag(last)
      }
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (grip === 'move') return
      setWinDrag(null)
      if (Math.abs(last.width - start.width) < 1e-4 && Math.abs(last.left - start.left) < 1e-4) return
      const next = Math.max(MIN_ZOOM, Math.min(maxZoomRef.current, el.clientWidth / (baseTrackW * Math.max(last.width, 1e-4))))
      if (Math.abs(next - zoom) < 1e-6) {
        // Same zoom (already at a limit): nothing re-renders to place the view.
        el.scrollLeft = last.left * TRACK_W
        updateView()
        return
      }
      pendingView.current = { frac: last.left }
      setZoom(next)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [TRACK_W, view.left, view.width, baseTrackW, zoom, updateView])

  // v0.11.4 (AUDIT V5): the list follows the viewport.
  //
  // It used to be "the last 50 events, always" — unrelated to where the
  // operator had scrolled. Pan back three hours to investigate something and
  // the list underneath still showed what happened thirty seconds ago, which
  // is a break in the middle of the one workflow the panel exists to support.
  //
  // Falls back to the tail when the whole track is on screen or the viewport
  // has not been measured yet, which is also what the operator wants while
  // following live.
  const vp: ViewportWindow = useMemo(() => ({
    left: view.left, width: view.width, trackW: TRACK_W, fromX, displayTs, timeSpan
  }), [view.left, view.width, TRACK_W, fromX, timeSpan])

  // The `/` search removes non-matches from the list rather than dimming
  // them. Dimming was not a filter on a half-screen window — a dirb run puts
  // 920 rows here and all 920 kept their space, so searching for `backup`
  // meant scrolling the same distance looking for a shade of grey.
  //
  // `showAllDespiteQuery` is the way back, and it is never implicit. The
  // interesting thing is sometimes a stack trace inside a 404 body that no
  // query would have matched, and a filter that hides without saying how much
  // is a filter that loses evidence quietly.
  // Annotated events never fold. Read once per project and again whenever a
  // note is written, which is the only thing that changes the set.
  const [annotatedIds, setAnnotatedIds] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const read = (): void => {
      void window.redlog.events.annotatedIds()
        .then((ids) => setAnnotatedIds(new Set(ids)))
        .catch(() => { /* a note that cannot be read only costs a fold */ })
    }
    read()
    window.addEventListener(EVENT_NOTE_SAVED, read)
    return () => window.removeEventListener(EVENT_NOTE_SAVED, read)
  }, [])

  // Has the command→traffic join resolved anything at all? Re-read on focus:
  // the operator may have installed `lsof`, or turned a pack on, and come
  // back.
  const [attribution, setAttribution] = useState({ attempted: 0, resolved: 0 })
  const readAttribution = useCallback(() => {
    void window.redlog.events.attributionStats().then(setAttribution).catch(() => {})
  }, [])
  useEffect(readAttribution, [readAttribution])
  useRevalidateOnFocus(readAttribution)
  // Said only when there is something it should have resolved: traffic has
  // arrived, the join has been asked, and it has never once answered.
  const attributionBlind = attribution.attempted > 0 && attribution.resolved === 0

  const [showAllDespiteQuery, setShowAllDespiteQuery] = useState(false)
  const toggleShowAll = useCallback(() => setShowAllDespiteQuery((v) => !v), [])
  useEffect(() => { setShowAllDespiteQuery(false) }, [queryKey])
  const queryActive = filterMatches !== null && !showAllDespiteQuery
  // The rail shows the newest 50 and says "of N" with the same window rule, and
  // the hidden-by-query count is the difference of two real, uncapped totals
  // rather than of two capped slices. One walk of the window yields all three;
  // this runs on every scroll frame.
  const windowSlice = useMemo(
    () => computeWindowSlice(events, hiddenLanes, pluginTypes, vp, 50, queryActive ? filterMatches : null),
    [events, hiddenLanes, pluginTypes, vp, queryActive, filterMatches]
  )
  const recentEvents = windowSlice.recent
  const windowTotal = windowSlice.total
  const hiddenByQuery = queryActive ? windowSlice.totalAll - windowSlice.total : 0

  const sliceExportRequest = useMemo<ExportRequest>(() => {
    const since = Math.round(fromX((view.left / 100) * TRACK_W))
    const before = Math.round(fromX(((view.left + view.width) / 100) * TRACK_W))
    return { format: 'timeline', subset: { kind: 'selection', projection: 'events', excludeHousekeeping: true,
      filter: { ...eventFilter, since: Math.max(since, eventFilter.since ?? since), before: Math.min(before, eventFilter.before ?? before) } } }
  }, [eventFilter, fromX, view.left, view.width, TRACK_W])
  useContributeExport({ label: t('timeline.exportSlice'), request: sliceExportRequest })

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        setCluster(null)
        const cursorX = e.clientX - el.getBoundingClientRect().left
        pendingZoomAnchor.current = { frac: (el.scrollLeft + cursorX) / TRACK_W, cursorX }
        // Proportional zoom: a trackpad pinch (macOS sends it as ctrl+wheel) fires
        // many small events — a fixed step per event slammed straight to the limit
        // and felt like nothing happened. Scaling by deltaY makes pinch smooth and
        // still gives a mouse wheel a reasonable step.
        setZoom((prev) => Math.min(maxZoomRef.current, Math.max(MIN_ZOOM, prev * Math.exp(-e.deltaY * 0.002))))
      } else if (e.deltaY !== 0) {
        // v0.9.4 P0-2: while the lane stack overflows its container, deltaY
        // has to drive the vertical axis or the newly-scrollable lanes are
        // unreachable by wheel; shift+wheel keeps the horizontal scroll that
        // deltaY does otherwise (dragging and the minimap also still pan).
        // With no vertical overflow — the common case — behaviour is
        // unchanged.
        const outer = containerRef.current
        if (outer && !e.shiftKey && outer.scrollHeight > outer.clientHeight + 1) return
        e.preventDefault()
        el.scrollLeft += e.deltaY
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [TRACK_W])

  // On open, jump the viewport to the present so the newest activity is in view
  // rather than the oldest. Runs once, after the first events have loaded and the
  // track has a real width. Manual pan/zoom afterwards is left untouched.
  // Reset the "already scrolled" flag whenever the caller changes what we
  // should scroll to. Prior behaviour set the ref once at first-open and
  // never cleared it — so a second click on a Loot item (after coming back
  // to Timeline) would silently short-circuit (audit finding P0 #7).
  // The lane track is a fresh element each time the swim lanes are shown, so
  // it starts unscrolled and needs placing again.
  useEffect(() => { didScrollToNow.current = false }, [focusEventId, focusTs, timelineMode])

  // Jumping from Search, Loot or Targets hands over an event to open. Opening
  // it is not a property of the lane track: the standard mode draws none, so
  // this must not wait for one to exist.
  const wantedFocusId = focusEventId ?? restoreFocusId
  const focusSelectedRef = useRef<string | null>(null)
  useEffect(() => {
    if (loading || !wantedFocusId || focusSelectedRef.current === wantedFocusId) return
    const focused = events.find((e) => e.id === wantedFocusId)
    if (!focused) return
    focusSelectedRef.current = wantedFocusId
    setSelectedEvent(focused)
    setDetailOpen(true)
  }, [loading, wantedFocusId, events])

  useEffect(() => {
    if (loading || didScrollToNow.current) return
    const el = scrollRef.current
    if (!el || el.clientWidth === 0) return
    // Centre a focused event; otherwise land on the present, latest activity in view.
    const focused = focusEventId ? events.find((e) => e.id === focusEventId) : null
    if (focused) {
      el.scrollLeft = Math.max(0, Math.min(toX(focused.timestamp) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    } else if (focusTs) {
      // no matching event (e.g. jumped from a bookmark) — centre on its time
      el.scrollLeft = Math.max(0, Math.min(toX(focusTs) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    } else {
      el.scrollLeft = Math.max(0, Math.min(toX(Date.now()) - el.clientWidth + 80, TRACK_W - el.clientWidth))
    }
    didScrollToNow.current = true
  }, [loading, toX, TRACK_W, focusEventId, focusTs, events, timelineMode])

  // After a cursor-anchored zoom re-renders with the new TRACK_W, restore the
  // scroll so the timestamp that was under the pointer stays under the pointer.
  useLayoutEffect(afterLayout, [afterLayout, loading])

  const toggleBand = useCallback((band: BandId) => {
    setCollapsedBands((prev) => {
      const next = new Set(prev)
      if (next.has(band)) next.delete(band); else next.add(band)
      return next
    })
  }, [])

  const toggleLane = useCallback((lane: LaneId) => {
    setHiddenLanes((prev) => {
      const next = new Set(prev)
      if (next.has(lane)) next.delete(lane)
      else if (next.size < LANES.length - 1) next.add(lane)
      return next
    })
  }, [])

  // Alt/Option-click a lane chip: solo that lane (hide every other populated
  // lane). Alt-click again on the same solo'd lane: show all. Audit #4 —
  // reviewing an engagement typically starts with "show only shell", which
  // took 13 clicks before.
  const soloLane = useCallback((lane: LaneId, populated: Set<LaneId>) => {
    setHiddenLanes((prev) => {
      const others = new Set<LaneId>()
      for (const l of populated) if (l !== lane) others.add(l)
      // If already solo'd (this lane is the ONLY visible one), toggle back
      // to show all — otherwise apply the solo.
      const isSolo = !prev.has(lane) && [...populated].every((l) => l === lane || prev.has(l))
      return isSolo ? new Set() : others
    })
  }, [])

  // One keydown listener for the Timeline's global single-key surface. This
  // replaced four separate window listeners that each re-implemented the "am I
  // typing?" guard and independently handled Escape — with the detail panel,
  // help modal and focus mode all open, one Escape press fired all three.
  // resolveTimelineKey (pure, unit-tested in test/timeline-keys.test.ts) makes
  // the precedence explicit and unambiguous: a modal wins, then focus mode,
  // then the detail panel; a second Escape peels the next layer.
  // Anchor priority for `f`: the selected event, else the last-hovered dot.
  const hoveredEventRef = useRef<RedLogEvent | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && escapeBelongsAbove(e)) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      const inField = tag === 'input' || tag === 'textarea' || !!el?.isContentEditable
      const action = resolveTimelineKey(e, {
        inField,
        ownsKeys: !!el?.matches?.(KEY_OWNING_CONTROLS),
        hasDetail: detailOpen && !!selectedEvent,
        helpOpen: showHelp,
        focusActive: focusAnchorId !== null,
        hasSelection: !!selectedEvent
      })
      if (action === 'none') return
      switch (action) {
        case 'focus-filter':
          e.preventDefault()
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
          break
        case 'toggle-help':
          e.preventDefault()
          setShowHelp((s) => !s)
          break
        case 'close-help':
          e.preventDefault()
          setShowHelp(false)
          break
        case 'exit-focus':
          setFocusAnchorId(null)
          break
        case 'close-detail':
          setDetailOpen(false)
          setShowJson(false)
          break
        case 'clear-selection':
          setSelectedEvent(null)
          break
        case 'toggle-detail':
          // Enter on a focused control belongs to that control: the dots and
          // cards open the body themselves, the bar's buttons just act.
          if (el?.closest('button, a, select, summary, [role="button"]')) return
          e.preventDefault()
          setDetailOpen((v) => !v)
          break
        case 'nav-prev':
        case 'nav-next':
        case 'nav-lane-prev':
        case 'nav-lane-next':
        case 'nav-lane-up':
        case 'nav-lane-down':
        case 'nav-state-prev':
        case 'nav-state-next':
        case 'nav-first':
        case 'nav-last': {
          e.preventDefault()
          const next = nextSelection<string>(action, selectedEvent, {
            events,
            hiddenLanes,
            pluginTypes,
            laneOrder: visibleRows,
            laneOf: (ev) => rowKeyOf(toLane(ev.agentType, ev.data?.subtype as string | undefined, pluginTypes)),
            tsOf: displayTs
          })
          if (next) {
            setSelectedEvent(next)
            // Walking off the visible window follows the selection.
            const scroller = scrollRef.current
            if (scroller) {
              const x = toX(displayTs(next))
              if (x < scroller.scrollLeft + 8 || x > scroller.scrollLeft + scroller.clientWidth - 8) {
                scroller.scrollLeft = Math.max(0, Math.min(x - scroller.clientWidth / 2, TRACK_W - scroller.clientWidth))
              }
            }
          }
          break
        }
        case 'zoom-in':
        case 'zoom-out':
        case 'zoom-reset': {
          e.preventDefault()
          // Anchored on the selected event, not the viewport centre (§6): the
          // thing the operator is looking at is the thing that should hold
          // still. With nothing selected, fall back to the centre.
          const el = scrollRef.current
          if (el) {
            const anchorX = selectedEvent
              ? toX(displayTs(selectedEvent)) - el.scrollLeft
              : el.clientWidth / 2
            pendingZoomAnchor.current = {
              frac: (el.scrollLeft + anchorX) / TRACK_W,
              cursorX: anchorX
            }
          }
          setZoom((prev) => action === 'zoom-reset'
            ? 1
            : Math.min(maxZoomRef.current, Math.max(MIN_ZOOM, prev * (action === 'zoom-in' ? 1.4 : 1 / 1.4))))
          break
        }
        case 'toggle-focus': {
          // toggle off if `f` is pressed again on the same anchor.
          const anchor = selectedEvent ?? hoveredEventRef.current
          if (!anchor) return
          e.preventDefault()
          setFocusAnchorId((cur) => (cur === anchor.id ? null : anchor.id))
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedEvent, detailOpen, showHelp, focusAnchorId, events, hiddenLanes, pluginTypes, toX, TRACK_W, visibleRows, rowKeyOf])

  // Helper: scroll the track so the given event is centred in the viewport.
  // Used by the cause/effect chips (feature 1) and any other jump-to-event
  // interaction; it uses `displayTs` so a marker with an override timestamp
  // still lands under its rendered position instead of its wall-clock one.
  const scrollToTs = useCallback((ts: number) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, Math.min(toX(ts) - el.clientWidth / 2, TRACK_W - el.clientWidth))
  }, [toX, TRACK_W])

  const scrollToEvent = useCallback((evt: RedLogEvent) => {
    scrollToTs(displayTs(evt))
  }, [scrollToTs])

  // Stepping walks the list's own order, because that is the order the
  // operator was reading when they opened the pane. The lane arrows (← →)
  // stay lane-scoped and mean something different on purpose: one follows a
  // single producer, this follows time.
  const stepIndex = useMemo(
    () => (selectedEvent ? recentEvents.findIndex((e) => e.id === selectedEvent.id) : -1),
    [recentEvents, selectedEvent]
  )
  const stepTo = useCallback((delta: -1 | 1) => {
    if (stepIndex < 0) return
    const next = recentEvents[stepIndex + delta]
    if (!next) return
    setSelectedEvent(next)
    scrollToEvent(next)
  }, [recentEvents, stepIndex, scrollToEvent])

  // A click selects and shows the bar; it never opens the body. A double-click
  // is two clicks, so the second (`detail` 2+) only keeps the selection and
  // leaves the toggle-off to a deliberate single click (`detail` 1). A click
  // with no count is the keyboard's, and never toggles off.
  //
  // The first click can change the layout under the pointer (the selected card
  // grows, a dot loses its raised z-index), so the second click and the
  // double-click may land on a neighbour. A double-click therefore means the
  // event the FIRST click landed on.
  const firstClick = useRef<{ evt: RedLogEvent; at: number } | null>(null)
  const firstClickTarget = (evt: RedLogEvent): RedLogEvent => {
    const first = firstClick.current
    return first && Date.now() - first.at < 700 ? first.evt : evt
  }
  const pickEvent = useCallback((evt: RedLogEvent, detail: number) => {
    if (detail > 1) { setSelectedEvent(firstClickTarget(evt)); return }
    if (detail === 1) firstClick.current = { evt, at: Date.now() }
    if (selectedRef.current?.id !== evt.id) { setSelectedEvent(evt); return }
    if (detail === 1) { setSelectedEvent(null); setDetailOpen(false) }
  }, [])
  // Double-click opens; Enter toggles the body on the event it is pressed on.
  const openEventBody = useCallback((evt: RedLogEvent, how: 'dblclick' | 'key') => {
    const target = how === 'dblclick' ? firstClickTarget(evt) : evt
    if (how === 'key' && detailOpen && selectedRef.current?.id === target.id) { setDetailOpen(false); return }
    setSelectedEvent(target)
    setDetailOpen(true)
  }, [detailOpen])

  const copyEventJson = useCallback(() => {
    if (!selectedEvent) return
    // §10: no masked variant. The data is already on the operator's own
    // machine — masking it here protected nothing and cost a step, and the
    // "did I remember to hit Reveal?" question meant a copied JSON could be
    // silently incomplete. The redaction boundary that matters is layer 4, on
    // the way *out*: bundle export and the blue-team webhook both
    // redact in src/core, independently of anything the renderer shows.
    void writeClipboard(JSON.stringify(selectedEvent, null, 2)).then((ok) =>
      toast(ok ? t('toast.copied') : t('toast.copyFailed'), ok ? 'success' : 'error')
    )
  }, [selectedEvent, t])

  // Write a correction. No confirm dialog and no undo toast: the spec makes
  // this first-level with no undo, because an undo that quietly removed the
  // amendment would be an edit wearing another name. Amend again instead.
  const handleAmend = useCallback(async (markerId: string, changes: Partial<MarkerValues>) => {
    const res = await window.redlog.marker.amend(markerId, changes)
    if (res?.ok) {
      toast(t('marker.amendSaved'), 'success')
      return
    }
    // §9: what happened, why, one action — never the raw error as the headline.
    const why = amendErrorWhy(res?.error ?? 'invalid-changes', t)
    toast(t('marker.amendFailed'), {
      type: 'error',
      why,
      detail: res && 'detail' in res ? res.detail : undefined,
      action: { label: t('marker.amendRetry'), onClick: () => void handleAmend(markerId, changes) }
    })
  }, [t])

  // A marker is almost always older than the correction that names it, and the
  // panel pages newest-first 200 rows at a time — so the row this amendment
  // revises is usually not loaded. Fetch it by id rather than telling the
  // operator the chain is broken.
  const resolveReferencedEvent = useCallback(async (eventId: string) => {
    const known = eventsMapRef.current.get(eventId)
    if (known) { setSelectedEvent(known); setDetailOpen(true); scrollToEvent(known); return }
    try {
      const [fetched] = (await window.redlog.events.getById([eventId])) ?? []
      if (!fetched) return
      // A referenced row the shared filter excludes (an amended marker older
      // than the time range, say) opens in the detail panel but is never
      // drawn: the track holds admitted rows only (spec 038 FR-004).
      const admitted = await window.redlog.events.matchIds({
        ids: [fetched.id], filter: eventFilterRef.current, excludeHousekeeping: true
      })
      setSelectedEvent(fetched)
      setDetailOpen(true)
      if (!admitted.includes(fetched.id)) { setOutsideFilter(true); return }
      eventsMapRef.current.set(fetched.id, fetched)
      binarySearchInsert(sortedRef.current, fetched)
      setEvents([...sortedRef.current])
      requestAnimationFrame(() => scrollToEvent(fetched))
    } catch (err) {
      toast(t('timeline.referenceFailed'), {
        type: 'error',
        detail: err instanceof Error ? err.message : String(err),
        action: { label: t('common.retry'), onClick: () => { void resolveReferencedEvent(eventId) } }
      })
    }
  }, [scrollToEvent, t])

  // Spec 038 (research R6): reach an admitted event older than the drawn
  // range by paging back to it, 1,000 rows a request, keeping the one
  // contiguous range the axis and minimap assume. It checks admission first,
  // so an event the filter excludes is said to be excluded instead of paged
  // for; it shows how far it has come, and Esc stops it, keeping what loaded.
  const [loadBack, setLoadBack] = useState<
    { state: 'loading'; loaded: number } | { state: 'cancelled' } | { state: 'failed'; eventId: string } | null
  >(null)
  const loadBackCancelRef = useRef(false)
  // `quiet`: a remembered selection may be stale (filtered out, deleted); that is
  // not worth a banner the operator never asked for.
  const loadBackTo = useCallback(async (eventId: string, quiet = false): Promise<void> => {
    const select = (evt: RedLogEvent): void => {
      setSelectedEvent(evt)
      setDetailOpen(true)
      requestAnimationFrame(() => scrollToEvent(evt))
    }
    const known = eventsMapRef.current.get(eventId)
    if (known) { select(known); return }
    const gen = generationRef.current
    const filter = eventFilterRef.current
    loadBackCancelRef.current = false
    setLoadBack({ state: 'loading', loaded: 0 })
    let loaded = 0
    // The pages go to the pacer. However this ends — found, stopped, failed —
    // what loaded is drawn now: the selection is placed on the drawn range,
    // and a stop or a failure says it kept what it loaded.
    const drawLoaded = (): void => { if (loaded > 0 && gen === generationRef.current) publishLive.flush() }
    try {
      const admitted = await window.redlog.events.matchIds({ ids: [eventId], filter, excludeHousekeeping: true })
      if (!admitted.includes(eventId)) { setLoadBack(null); if (!quiet) setOutsideFilter(true); return }
      while (!eventsMapRef.current.has(eventId) && pageCursorRef.current) {
        const from = pageCursorRef.current
        const page = await window.redlog.events.queryPage({ ...filter, excludeHousekeeping: true, limit: 1000, cursor: from })
        if (loadBackCancelRef.current) { drawLoaded(); return }
        if (gen !== generationRef.current) { setLoadBack(null); return }
        // Another page landed first; ask again from where the range now ends.
        if (!acceptPage(page, gen, from)) continue
        loaded += page.items.length
        setLoadBack({ state: 'loading', loaded })
        if (!page.hasMore) break
      }
      setLoadBack(null)
      drawLoaded()
      const evt = eventsMapRef.current.get(eventId)
      if (evt) select(evt)
    } catch {
      drawLoaded()
      if (!loadBackCancelRef.current && gen === generationRef.current) setLoadBack(quiet ? null : { state: 'failed', eventId })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToEvent, acceptPage])

  useEffect(() => {
    if (loadBack?.state !== 'loading') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      loadBackCancelRef.current = true
      setLoadBack({ state: 'cancelled' })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [loadBack?.state])

  // "Open in Timeline" from Search, Loot or the Transcript names an event;
  // one older than the drawn range is loaded back to rather than missed.
  const focusLoadBackRef = useRef<string | null>(null)
  useEffect(() => {
    if (!wantedFocusId || loading || focusLoadBackRef.current === wantedFocusId) return
    focusLoadBackRef.current = wantedFocusId
    if (!eventsMapRef.current.has(wantedFocusId)) void loadBackTo(wantedFocusId, !focusEventId)
  }, [wantedFocusId, loading, loadBackTo])

  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner label={t('common.loading')} />
      </div>
    )
  }

  // A read that failed is a failure, never an empty timeline (FR-010).
  if (loadError && rawEvents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div data-testid="timeline-load-failed" role="alert" className="flex flex-col items-center gap-2 text-center px-8 max-w-md">
          <p className="text-sm text-red-300">{t('timeline.loadFailed')}</p>
          <p className="text-xs text-redlog-text-faint font-mono break-all">{loadError}</p>
          <button onClick={() => loadFirstPage()} className="text-xs text-red-300 underline hover:text-red-200">
            {t('common.retry')}
          </button>
        </div>
      </div>
    )
  }

  // Rows are held but the agent-turn collapse hides every one (FR-015): they
  // are events, folded out of view, not a project that recorded nothing.
  if (rawEvents.length > 0 && events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div data-testid="timeline-all-folded" role="status" className="flex flex-col items-center gap-2 text-center px-8">
          <p className="text-sm text-redlog-text-dim">{t('timeline.allFolded', { count: hiddenAgentTurnCount })}</p>
          <button onClick={() => setCollapseAgentTurns(false)} className="text-xs text-redlog-text-dim underline hover:text-redlog-text">
            {t('timeline.showAgentTurns')}
          </button>
        </div>
      </div>
    )
  }

  // Nothing admitted by the filter is not the same as an empty project: say
  // which conditions are narrowing it. Personal traffic is one of them once
  // personal domains are set, though FilterContext's badge count leaves it
  // out (Constitution II).
  const activeConditions = describeActiveConditions(sharedFilter, t, { personalDomains })
  if (events.length === 0 && activeConditions.length > 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div data-testid="timeline-empty-filtered" className="flex flex-col items-center gap-2 text-center px-8">
          <p className="text-sm text-redlog-text-dim">{t('timeline.emptyFiltered')}</p>
          <ul className="text-xs text-redlog-text-faint font-mono">
            {activeConditions.map((label) => <li key={label}>{label}</li>)}
          </ul>
        </div>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center px-8">
          <div className="w-16 h-16 rounded-full bg-redlog-surface border border-redlog-border flex items-center justify-center">
            <Rows3 size={24} strokeWidth={1.5} aria-hidden className="text-redlog-muted" />
          </div>
          <p className="text-sm text-redlog-text-dim">{t('timeline.noEvents')}</p>
          <p className="text-xs text-redlog-text-faint">{t('timeline.noEventsDesc')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full relative">
      {/* v0.6.89.5 feature 5: broken-chain top banner. Sticks above the header
          so it can't be missed. Dismiss hides for the current mount only —
          the module cache still holds the result, so re-opening Timeline (or
          another verify producing the same brokenAt) brings it back. */}
      <BrokenChainBanner result={verifyResult} dismissed={verifyDismissed} onDismiss={() => setVerifyDismissed(true)} t={t} />
      <TimelineHelpModal open={showHelp} onClose={() => setShowHelp(false)} isMac={isMacPlatform} t={t} />
      {/* v0.6.89.5 feature 2: focus-chain badge (top-right). Only rendered
          while focus mode is active. Anchored on the wrapper so it floats
          above the minimap without shifting layout. */}
      <FocusChainBadge size={focusChain?.size ?? 0} active={!!focusChain} meta={focusMeta} onExit={() => setFocusAnchorId(null)} t={t} />
      {/* The toolbar renders what it is given; the follow badge and the panel's
          own view toggles close over panel state, so they come in as slots. */}
      <TimelineToolbar
        t={t}
        timeRange={sharedFilter.timeRange}
        setTimeRange={setSharedTimeRange}
        hasMore={hasMore}
        loadedCount={rawEvents.length}
        loadedSpanMs={loadedSpanMs}
        projectSpanMs={projectSpanMs}
        total={total}
        onRetryTotal={() => requestTotal(generationRef.current)}
        onLoadMore={loadMore}
        zoom={zoom}
        onZoomOut={() => setZoom((z) => Math.max(MIN_ZOOM, z - 0.25))}
        onZoomIn={() => setZoom((z) => Math.min(maxZoom, z + 0.25))}
        onResetZoom={() => setZoom(1)}
        anchorTs={selectedEvent?.timestamp ?? null}
        mode={timelineMode}
        onModeChange={setTimelineMode}
        filterQuery={filterQuery}
        onFilterQueryChange={typeFilterQuery}
        searchInputRef={searchInputRef}
        onHelp={() => setShowHelp(true)}
        attributionBlind={attributionBlind}
        lanes={populatedLanes}
        followBadge={
          <FollowBadge
            latestTs={events.length > 0 ? events[events.length - 1].timestamp : 0}
            isLive={atRightEdge && followMode}
            onPause={() => setFollowMode(false)}
            onResume={() => resumeFollow()}
            t={t}
          />
        }
        moreItems={
          <>
            <button
              role="menuitemcheckbox"
              aria-checked={collapseAgentTurns}
              onClick={() => setCollapseAgentTurns((v) => !v)}
              title={collapseAgentTurns
                ? t('timeline.collapseAgent.hidden', { count: hiddenAgentTurnCount })
                : t('timeline.collapseAgent.hint')}
              className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono text-redlog-text hover:bg-white/5"
            >
              <span>{t('timeline.collapseAgent.label')}</span>
              <span className={collapseAgentTurns ? 'text-lime-300' : 'text-redlog-text-faint'}>{collapseAgentTurns ? '✓' : ''}</span>
            </button>
            {(timeMap.gaps.length > 0 || compressGaps) && (
              <button
                role="menuitemcheckbox"
                aria-checked={compressGaps}
                onClick={() => {
                  const el = scrollRef.current
                  if (el) pendingCenterTs.current = fromX(el.scrollLeft + el.clientWidth / 2)
                  setCompressGaps((v) => !v)
                }}
                title={t('timeline.compressGaps.hint')}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono text-redlog-text hover:bg-white/5"
              >
                <span>{t('timeline.compressGaps.label')}{compressGaps && timeMap.gaps.length > 0 ? ` (${timeMap.gaps.length})` : ''}</span>
                <span className={compressGaps ? 'text-cyan-300' : 'text-redlog-text-faint'}>{compressGaps ? '✓' : ''}</span>
              </button>
            )}
            <div className="border-t border-redlog-border/50 my-0.5" />
            <button
              role="menuitemcheckbox"
              aria-checked={sessionDividers}
              onClick={() => setSessionDividers((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono text-redlog-text hover:bg-white/5"
            >
              <span>⋮ {t('timeline.boundaries.toggle')}</span>
              <span className={sessionDividers ? 'text-redlog-cyan' : 'text-redlog-text-faint'}>{sessionDividers ? '✓' : ''}</span>
            </button>
          </>
        }
      />

      {/* Spec 038: what the panel could not do, said where the operator is
          looking. A failed read is never shown as fewer rows (FR-010), and a
          row the filter excludes is never shown as if it matched (FR-004). */}
      {((loadError && rawEvents.length > 0) || liveError || outsideFilter || parseOutcome || loadBack) && (
        <div className="px-4 py-1 border-b border-redlog-border/80 flex flex-col gap-0.5 text-xs shrink-0">
          {/* The filter box (spec 038 US3): how the input was read, whether it
              is still being checked, whether the check failed, and how many
              matches lie past what is drawn. */}
          <QueryReadout outcome={parseOutcome} testId="timeline-query" unparsableTitle={t('timeline.queryUnparsable')} />
          {parsedQuery && boxState === 'matching' && (
            <span data-testid="timeline-query-matching" role="status" className="text-redlog-text-faint">{t('timeline.matching')}</span>
          )}
          {parsedQuery && boxState === 'failed' && (
            <div role="alert" data-testid="timeline-query-failed" className="text-red-300">
              {t('timeline.queryFailed')}{' '}
              <button
                onClick={() => { matchCacheRef.current = freshMatchCache(null); setBoxRetry((n) => n + 1) }}
                className="underline hover:text-red-200"
              >{t('common.retry')}</button>
            </div>
          )}
          {parsedQuery && boxState === 'matched' && (
            <span data-testid="timeline-match-count" className="sr-only" aria-live="polite">
              {t('timeline.matchCount', { count: matchedIds?.size ?? 0 })}
            </span>
          )}
          {parsedQuery && (boxLit?.hiddenByCollapse ?? 0) > 0 && (
            <span className="text-redlog-text-faint">{t('timeline.hiddenByCollapse', { count: boxLit?.hiddenByCollapse ?? 0 })}</span>
          )}
          {parsedQuery && earlier.state === 'ok' && earlier.count > 0 && earlier.nearestId && !loadBack && (
            <button
              data-testid="timeline-earlier-matches"
              onClick={() => { if (earlier.nearestId) void loadBackTo(earlier.nearestId) }}
              className="self-start text-cyan-300 underline decoration-dotted hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/70 rounded"
            >{t('timeline.earlierMatches', { count: earlier.count })}</button>
          )}
          {parsedQuery && earlier.state === 'failed' && (
            <div role="alert" data-testid="timeline-earlier-failed" className="text-red-300">
              {t('timeline.earlierFailed')}{' '}
              <button onClick={() => setEarlierRetry((n) => n + 1)} className="underline hover:text-red-200">{t('common.retry')}</button>
            </div>
          )}
          {loadBack?.state === 'loading' && (
            <span data-testid="timeline-loadback-progress" role="status" className="text-redlog-text-dim">
              {t('timeline.loadingBack', { count: loadBack.loaded })}
            </span>
          )}
          {loadBack?.state === 'cancelled' && (
            <span data-testid="timeline-loadback-cancelled" role="status" className="text-redlog-text-dim flex items-center gap-2">
              {t('timeline.loadBackCancelled')}
              <button onClick={() => setLoadBack(null)} aria-label={t('common.cancel')} className="text-redlog-text-faint hover:text-redlog-text leading-none">×</button>
            </span>
          )}
          {loadBack?.state === 'failed' && (
            <div role="alert" data-testid="timeline-loadback-failed" className="text-red-300">
              {t('timeline.loadBackFailed')}{' '}
              <button
                onClick={() => { const id = loadBack.eventId; setLoadBack(null); void loadBackTo(id) }}
                className="underline hover:text-red-200"
              >{t('common.retry')}</button>
            </div>
          )}
          {loadError && rawEvents.length > 0 && (
            <div role="alert" data-testid="timeline-page-failed" className="text-red-300">
              {t('timeline.pageFailed')}{' '}
              <Button size="compact" level="quiet" className="ml-1" onClick={loadMore} >{t('common.retry')}</Button>
            </div>
          )}
          {liveError && (
            <div role="alert" data-testid="timeline-live-failed" className="text-amber-300">
              {t('timeline.liveAdmissionFailed')}{' '}
              <button
                onClick={() => {
                  const batch = liveError.ids
                  setLiveError(null)
                  if (batch.length > 0) void admitLiveRef.current(batch).catch(() => {})
                  else loadFirstPage()
                }}
                className="underline hover:text-amber-200"
              >{t('common.retry')}</button>
            </div>
          )}
          {outsideFilter && (
            <div role="status" data-testid="timeline-outside-filter" className="text-redlog-text-dim flex items-center gap-2">
              <span>{t('timeline.outsideFilter')}</span>
              <button
                onClick={() => setOutsideFilter(false)}
                aria-label={t('common.cancel')}
                className="text-redlog-text-faint hover:text-redlog-text leading-none"
              >×</button>
            </div>
          )}
        </div>
      )}

      {/* Density minimap. Drag to zoom to a window, click to jump; the bright
          frame marks the current viewport.
          It is an overview of what is LOADED, not of the engagement — the bins
          are built from the paged set, and the pager fetches backwards from
          the newest row. So while `hasMore` is true, the emptiness at the left
          edge is the page boundary, not silence in the record. This strip's
          one irreplaceable job is showing gaps, and it was drawing a gap that
          was really an unread page: the operator could not tell "nothing
          happened here" from "not fetched yet", on the one surface that
          exists to answer exactly that. It now says which it is: the ⋮ at the
          strip's left edge and the strip's own tooltip, beside the toolbar's
          "N of M" line. The caption row that used to sit above the strip
          repeated the ruler's span and was removed (2026-11-14). */}
      <div className="shrink-0 border-b border-redlog-border/80 bg-redlog-bg/40 px-1 pt-0.5">
        <div
          data-testid="timeline-minimap"
          className="relative h-8 cursor-crosshair select-none overflow-hidden"
          onMouseDown={onMinimapDown}
          title={hasMore ? t('timeline.minimapPartialHint') : t('timeline.minimapHint')}
        >
          {hasMore && (
            <span
              data-testid="minimap-partial"
              aria-hidden="true"
              className="absolute left-0.5 top-0 z-10 text-xs leading-4 text-redlog-warn pointer-events-none"
            >&#8942;</span>
          )}
          <svg
            className="absolute inset-x-0 bottom-0 h-7 w-full pointer-events-none"
            viewBox="0 0 800 28"
            preserveAspectRatio="none"
            aria-hidden
          >
            <path data-testid="minimap-area" className="text-redlog-cyan/30" fill="currentColor" d={densityAreaPath(bins.counts, bins.max, 800, 28)} />
            {denseBins && (
              <>
                <path data-testid="minimap-dense-area" className="text-redlog-cyan/70" fill="currentColor" d={densityAreaPath(bins.counts, bins.max, 800, 28, denseBins)} />
                <line
                  className="text-redlog-danger"
                  stroke="currentColor"
                  strokeDasharray="2,2"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  x1={((peakBin(bins.counts, denseBins) + 0.5) / bins.N) * 800}
                  x2={((peakBin(bins.counts, denseBins) + 0.5) / bins.N) * 800}
                  y1="0"
                  y2="28"
                />
              </>
            )}
          </svg>
          {/* The densest stretch is named on the highlight itself, not in a
              caption row: hover reads it, and assistive technology gets it as
              the highlight's name. Drawn under the window, and a press on it
              still reaches the strip's drag-to-zoom. */}
          {dense && denseBins && (
            <div
              data-testid="minimap-densest"
              role="img"
              aria-label={densestLabel}
              title={densestLabel}
              className="absolute inset-y-0"
              style={{ left: `${(denseBins[0] / bins.N) * 100}%`, width: `${((denseBins[1] - denseBins[0] + 1) / bins.N) * 100}%` }}
            />
          )}
          {/* 重點視窗 — the viewport. Body pans, grips resize (onWindowDown). */}
          <div
            data-testid="minimap-window"
            className="absolute inset-y-0 flex items-center justify-between rounded-sm border border-redlog-cyan/60 bg-redlog-elevated/50 cursor-move"
            style={{ left: `${view.left}%`, width: `${Math.max(1, view.width)}%` }}
            onMouseDown={(e) => onWindowDown('move', e)}
            title={t('timeline.minimap.windowHint')}
          >
            {/* The grips draw 8px wide; the ::after takes the grab past 27
                CSS px. A wide frame reaches inward 19px, which is all that is
                left at the strip's edge (the outside is clipped there, and
                the whole-span view sits on both edges); a narrow frame reaches
                only outward, so its body can still be grabbed to pan. */}
            <span
              data-testid="minimap-window-start"
              className={`relative h-full w-2 shrink-0 flex items-center justify-center cursor-ew-resize after:absolute after:inset-y-0 ${view.width >= 25 ? 'after:-left-[10px] after:-right-[19px]' : 'after:right-0 after:-left-[19px]'}`}
              onMouseDown={(e) => onWindowDown('start', e)}
            ><span className="w-1 h-4 rounded-full bg-redlog-cyan" /></span>
            {view.width >= 12 && (
              <span className="px-1 rounded-sm bg-redlog-bg/80 text-xs text-redlog-text font-mono pointer-events-none whitespace-nowrap overflow-hidden">
                {t('timeline.minimap.window')}
              </span>
            )}
            <span
              data-testid="minimap-window-end"
              className={`relative h-full w-2 shrink-0 flex items-center justify-center cursor-ew-resize after:absolute after:inset-y-0 ${view.width >= 25 ? 'after:-left-[19px] after:-right-[10px]' : 'after:left-0 after:-right-[19px]'}`}
              onMouseDown={(e) => onWindowDown('end', e)}
            ><span className="w-1 h-4 rounded-full bg-redlog-cyan" /></span>
          </div>
          {winDrag && (
            <div
              data-testid="minimap-window-preview"
              className="absolute inset-y-0 border border-dashed border-redlog-text/60 bg-white/10 pointer-events-none"
              style={{ left: `${winDrag.left * 100}%`, width: `${winDrag.width * 100}%` }}
            />
          )}
          {drag && (
            <div
              className="absolute inset-y-0 bg-white/15 border border-white/50 pointer-events-none"
              style={{ left: `${(Math.min(drag.x0, drag.x1) / drag.w) * 100}%`, width: `${(Math.abs(drag.x1 - drag.x0) / drag.w) * 100}%` }}
            />
          )}
        </div>
      </div>

      {/* Timeline + event list split */}
      {/* The layout switch is this one flex direction. Column puts the pane
          under the list across the full width; row puts it beside, and the
          list keeps its height. One pane in one place in the DOM either way —
          rendering it twice would be two panes to keep in step and only one
          of them ever tested. */}
      <div ref={splitRef} data-testid="timeline-split" data-layout={layout} className={`flex-1 min-h-0 flex ${layout === 'right' ? 'flex-row' : 'flex-col'}`}>
      <div ref={trackColumnRef} className="relative flex-1 min-w-0 min-h-0 flex flex-col">
        {/* Swim lanes — one row of everything in standard mode (FR-008). */}
        {/* v0.9.4 P0-2: scrolls vertically. The lane labels are a sibling of
            the track, so the overflow has to live on this shared parent —
            putting it on the track alone would slide the lanes out from
            under their labels. 18 lanes x the 36px floor overflows a 1080p
            window, and the old `overflow-hidden` clipped the tail of the
            stack (scope / process / system) with no scrollbar and no hint. */}
        {/* Capped at its own content. Clamping laneH is only half the fix: a
            `flex-1` box still takes every spare pixel and pads the lanes out
            inside it, which is the 159px-of-nothing-per-row the measurement
            found. With a max-height flexbox freezes this box at its content
            and hands the remainder to the list below, which is where rows are
            actually read. */}
        {/* The measured box and the capped box have to be different elements.
            `containerH` feeds `laneH`, which feeds this `maxHeight` — observing
            the capped box made that a loop reading its own output, and it
            settled wherever the first frame happened to land. Adding the band
            heading row was enough to push it somewhere the first lane sat
            scrolled off the top under the track's horizontal scrollbar. The
            wrapper is never capped, so it reports the space that is actually
            available and the loop is cut. */}
        {timelineMode === 'lanes' && (
          <TimelineLanesHeader
            activeLanes={laneCounts.size}
            start={timeStart}
            end={timeEnd}
            partial={hasMore}
            onCollapse={() => setTimelineMode('standard')}
            t={t}
          />
        )}
        {/* Standard mode: sized to the ruler and its one row, so the card rail
            sits right under it (Stitch 05) instead of a block of empty track. */}
        <div ref={containerRef} className={`${timelineMode === 'standard' ? 'flex-none' : 'flex-1'} min-h-0 flex flex-col`}>
        <div
          data-testid="timeline-lane-scroll"
          className="min-h-0 flex overflow-x-hidden overflow-y-auto"
          style={{ maxHeight: visibleRows.length * laneH + axisH }}
          // The cluster popover is placed outside this scroller; a vertical
          // scroll would leave it beside the wrong dot.
          onScroll={() => setCluster(null)}
        >
          {/* Lane labels. The standard ruler has none; the swim lanes keep
              this as the scroller's first child (the geometry suite reads it). */}
          {timelineMode !== 'standard' && (
          <div className="shrink-0 border-r border-redlog-border/60 bg-redlog-bg/50" style={{ width: LABEL_W }}>
            <div className="h-7 border-b border-redlog-border/60" />
            {visibleRows.map((rowKey) => {
              const band = BANDS.find((b) => b.id === rowKey)
              if (band) {
                // The band row, rendered whether or not the band is expanded.
                // Collapsed, the track draws its lanes' dots here and the count
                // says how many lanes are folded into them; expanded, the lanes
                // are listed below and counting them again is noise.
                const expanded = !collapsedBands.has(band.id)
                const popCount = band.lanes.filter((l) => populatedLanes.has(l)).length
                return (
                  <button
                    key={rowKey}
                    data-testid={`timeline-band-${rowKey}`}
                    onClick={() => toggleBand(band.id)}
                    className="w-full flex items-center gap-1.5 px-2 border-b border-redlog-border/30 font-mono text-xs text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:bg-white/[0.04]"
                    style={{ height: laneH }}
                    title={t(expanded ? 'timeline.band.collapseHint' : 'timeline.band.expandHint', { band: t(`timeline.band.${band.id}`) })}
                    aria-expanded={expanded}
                  >
                    <span className="text-redlog-text-faint w-2 shrink-0">{expanded ? '▾' : '▸'}</span>
                    <span title={t(`timeline.band.${band.id}`)} className="text-redlog-text truncate">{t(`timeline.band.${band.id}`)}</span>
                    {!expanded && <span className="text-redlog-text-faint tabular-nums ml-auto shrink-0">{popCount}</span>}
                  </button>
                )
              }
              const id = rowKey as LaneId
              // A lane row, indented under the band heading above it. The whole
              // row is the lane's hide/solo control, carrying the gestures the
              // header chips used to. Hidden reads as struck through, the way
              // the chips did, and clicking it again brings the dots back.
              const hidden = hiddenLanes.has(id)
              return (
                <button
                  key={rowKey}
                  data-testid={`timeline-lane-${rowKey}`}
                  onClick={(e) => { if (e.altKey) soloLane(id, populatedLanes); else toggleLane(id) }}
                  title={t('timeline.laneChipHint', { lane: laneLabels[id] })}
                  aria-pressed={!hidden}
                  className={`w-full flex items-center gap-1.5 pl-6 pr-2 border-b border-redlog-border/30 font-mono text-xs text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:bg-white/[0.04] ${
                    hidden ? 'opacity-40 line-through' : ''
                  }`}
                  style={{ height: laneH }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[id] }} />
                  <span title={laneLabels[id]} className="text-redlog-text-dim truncate">{laneLabels[id]}</span>
                  <span className="ml-auto shrink-0 pl-1 text-redlog-text-faint tabular-nums">{laneCountText(laneCounts.get(id) ?? 0, hasMore, t)}</span>
                </button>
              )
            })}
          </div>
          )}

          {/* Scrollable track */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-x-auto overflow-y-hidden cursor-grab"
            onMouseDown={handleMouseDown}
            onScroll={updateView}
            onDoubleClick={(e) => {
              // §6: double-clicking empty track frames the five minutes either
              // side of that instant — the question "what happened around
              // here" asked with the bluntest possible gesture.
              const target = e.target as HTMLElement | null
              if (target?.closest('[data-timeline-popup]')) return
              if (target?.closest('[data-timeline-event]')) return
              if (target?.closest('[data-timeline-marker]')) return
              const el = scrollRef.current
              if (!el || timeSpan <= 0) return
              const rect = el.getBoundingClientRect()
              const cursorX = e.clientX - rect.left
              const ts = fromX(el.scrollLeft + cursorX)
              const targetSpan = 10 * 60_000
              const next = Math.min(maxZoomRef.current, Math.max(MIN_ZOOM, (timeSpan / targetSpan)))
              pendingZoomAnchor.current = { frac: (el.scrollLeft + cursorX) / TRACK_W, cursorX }
              setZoom(next)
              void ts
            }}
            onContextMenu={(e) => {
              // v0.6.87 C1 dropped a marker on the bare right-click. Two
              // problems, both from §10. The renderer's `preventDefault` does
              // not reach the main process's own `context-menu` event, so a
              // right-click over selected text both dropped a marker and
              // opened the copy menu — and that marker was already hashed into
              // the chain by the time the menu appeared. And a chained event
              // is not something a stray right-click should be able to write.
              // It is a menu item now: right-click offers it, a click takes it.
              if (!onDropMarker) return
              const target = e.target as HTMLElement | null
              if (target?.closest('[data-timeline-popup]')) return
              if (target?.closest('[data-timeline-event]')) return
              if (target?.closest('[data-timeline-marker]')) return
              e.preventDefault()
              const el = scrollRef.current
              if (!el || timeSpan <= 0) return
              const rect = el.getBoundingClientRect()
              const trackX = (e.clientX - rect.left) + el.scrollLeft
              const ts = Math.round(fromX(trackX))
              void window.redlog.ui.contextMenu([
                { id: 'drop-marker', label: t('timeline.dropMarkerHere', { time: formatTime(ts, { seconds: true }) }) }
              ]).then((picked) => {
                if (picked === 'drop-marker') onDropMarker(ts)
              })
            }}
          >
            <div style={{ width: TRACK_W, position: 'relative' }}>
              {/* Time axis */}
              {/* Clipped: nothing on the axis may widen the track past TRACK_W,
                  or 100% scrolls. The end labels align inward (tickLabelAlign). */}
              <div className="border-b border-redlog-border/60 relative bg-redlog-bg/30 overflow-hidden" style={{ height: axisH }}>
                {ticks.map((ts, i) => {
                  const align = tickLabelAlign(toX(ts), TRACK_W)
                  return (
                  <span
                    key={ts}
                    data-testid="timeline-axis-label"
                    data-align={align}
                    // The end labels hang inward from their tick (tickLabelAlign)
                    // and keep 4px off the pane's edge, where the axis clips.
                    className={`absolute whitespace-nowrap text-xs text-redlog-text-faint font-mono tabular-nums ${
                      align === 'center' ? '-translate-x-1/2' : align === 'end' ? '-translate-x-full pr-1' : 'pl-1'
                    }`}
                    style={{ left: toX(ts), top: timelineMode === 'standard' ? 2 : 6 }}
                  >
                    {/* v0.11.4 (AUDIT V6): a multi-day engagement showed several
                        identical "09:11" ticks with nothing to separate them. Once
                        the span crosses a day, the first tick and every tick that
                        lands on a new date carry the date too. */}
                    {axisLabel(ts, i, ticks, timeSpan)}
                  </span>
                  )
                })}
                {/* The ruler's markers. The wrapper ignores the pointer so a
                    pan or a double-click starting here reaches the track; only
                    the [Latest] chip is a target. */}
                {timelineMode === 'standard' && (
                  <div className="absolute inset-0 pointer-events-none">
                    {rulerMarkers.focus && rulerFocusTs !== null && (
                      <span
                        data-testid="timeline-marker-focus"
                        data-timeline-marker
                        className={`absolute h-3.5 px-1 flex items-center whitespace-nowrap font-mono tabular-nums text-xs leading-none text-redlog-text border-redlog-accent ${
                          rulerMarkers.focus.align === 'start' ? 'border-l-2' : 'border-r-2 -translate-x-full'
                        }`}
                        style={{ left: rulerMarkers.focus.x, top: 20 }}
                      >
                        {formatTime(rulerFocusTs, { seconds: true })} {t('timeline.marker.focus')}
                      </span>
                    )}
                    {rulerMarkers.latest && rulerLatestTs !== null && (
                      <button
                        type="button"
                        data-testid="timeline-marker-latest"
                        data-timeline-marker
                        onClick={() => { if (!didPan.current) resumeFollow() }}
                        // The chip draws 14px tall; the ::after reaches 13px up
                        // (never down, where the axis clips and the dots sit),
                        // for a 27 CSS px target.
                        className={`absolute h-3.5 px-1 flex items-center whitespace-nowrap font-mono tabular-nums text-xs leading-none text-redlog-text-dim hover:text-redlog-text pointer-events-auto cursor-pointer border-redlog-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim after:absolute after:inset-x-0 after:bottom-0 after:-top-[13px] ${
                          rulerMarkers.latest.align === 'start' ? 'border-l' : 'border-r -translate-x-full'
                        }`}
                        style={{ left: rulerMarkers.latest.x, top: 20 + rulerMarkers.latest.row * 14 }}
                      >
                        {formatTime(rulerLatestTs, { seconds: true })} {t('timeline.marker.latest')}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Lanes area */}
              <div
                ref={lanesAreaRef}
                data-testid={timelineMode === 'standard' ? 'timeline-standard-track' : undefined}
                style={{ height: totalH, position: 'relative' }}
              >
                {visibleRows.map((_, i) => (
                  <div
                    key={i}
                    className="absolute w-full border-b border-redlog-border/30"
                    style={{
                      top: i * laneH,
                      height: laneH,
                      backgroundColor: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.008)'
                    }}
                  />
                ))}
                {ticks.map((ts) => (
                  <div
                    key={ts}
                    className="absolute top-0 border-l border-redlog-border/25"
                    style={{ left: toX(ts), height: totalH }}
                  />
                ))}
                {/* v0.6.91 S3: session boundary bands. Rendered before the
                    current-time line and the broken-chain band so those
                    stronger overlays win. Paused-recording bands use a
                    diagonal stripe fill; terminal bands are a flat tint. */}
                {sessionBands.map((b) => {
                  const w = Math.max(0, b.x1 - b.x0)
                  if (w <= 0) return null
                  const bg = b.kind === 'paused'
                    ? 'repeating-linear-gradient(45deg, rgba(148,163,184,0.10) 0 6px, transparent 6px 12px)'
                    : 'rgba(99, 102, 241, 0.02)'
                  const border = b.kind === 'paused' ? 'rgba(148,163,184,0.35)' : 'rgba(99,102,241,0.30)'
                  return (
                    <div key={b.id} className="absolute top-0 pointer-events-none" style={{ left: b.x0, width: w, height: totalH }}>
                      <div className="absolute inset-0" style={{ background: bg }} />
                      <div className="absolute inset-y-0 left-0 border-l border-dashed" style={{ borderColor: border }} />
                      <div className="absolute inset-y-0 right-0 border-l border-dashed" style={{ borderColor: border }} />
                      {/* v0.11.7 (V11): stagger by row so concurrent sessions
                          don't stack their labels, and drop the label entirely
                          when the band is too narrow to hold it — a 60px label
                          bleeding out of a 4px band is worse than none. */}
                      {w >= 34 && (
                        <span
                          className="absolute text-xs font-mono px-1 rounded-b bg-redlog-surface/80 whitespace-nowrap"
                          style={{ left: 2, top: b.row * 12, color: b.kind === 'paused' ? SESSION_BAND_LABEL_COLOR.paused : SESSION_BAND_LABEL_COLOR.session }}
                        >{b.label}</span>
                      )}
                    </div>
                  )
                })}
                  {/* v0.11.6 (V7): compressed stretches get a visible break —
                      a hatched band and a duration label. A discontinuity the
                      operator can't see is worse than the wasted space it
                      replaced, because every later reading of the axis would
                      be silently wrong. */}
                  {(compressGaps ? timeMap.gaps : []).map((g) => (
                    <div
                      key={g.from}
                      className="absolute top-0 border-x border-dashed border-redlog-border/50"
                      style={{
                        left: g.x, width: GAP_PX, height: totalH,
                        background: 'repeating-linear-gradient(45deg, rgba(120,120,130,0.10) 0 4px, transparent 4px 8px)'
                      }}
                      title={t('timeline.gapSkipped', { d: formatGap(g.to - g.from) })}
                    >
                      <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 text-xs text-redlog-text-dim font-mono whitespace-nowrap">
                        ⋯{formatGap(g.to - g.from)}
                      </span>
                    </div>
                  ))}
                {/* Current time line */}
                <NowLine timeStart={timeStart} timeEnd={timeEnd} toX={toX} height={totalH} />
                {/* v0.6.89.5 feature 5: red-tinted band behind every event
                    that landed AFTER the broken-chain event. Rendered before
                    the dots so it sits underneath but above the lane
                    background. */}
                {brokenAtId && (() => {
                  const brokenEvt = eventsMapRef.current.get(brokenAtId)
                  if (!brokenEvt) return null
                  const x0 = toX(displayTs(brokenEvt))
                  return (
                    <div
                      className="absolute top-0 bg-red-500/5 border-l border-red-500/30 pointer-events-none"
                      style={{ left: x0, width: Math.max(0, TRACK_W - x0), height: totalH }}
                    />
                  )
                })()}
                {/* Event markers — single dot, or a counted cluster when dense.
                    Windowed to the viewport plus a screen either side (v0.11.1). */}
                {visibleClusters.map((c) => {
                  const single = c.events.length === 1
                  const evt = c.events[0]
                  const sel = single && selectedEvent?.id === evt.id
                  // v0.11.4: severity / scope raise the base size and change
                  // the shape. Clusters keep their own sizing — the popup
                  // lists members individually, so per-event emphasis there
                  // would fight the count glyph.
                  const marks = single ? dotShape(evt, foldById.get(evt.id)?.effective.severity) : { shape: 'circle' as DotShape, scale: 1 }
                  // The mark's size comes from the clustering (c.w), which
                  // merged every pair of marks that would have overlapped. A
                  // badge is as tall as it always was and widens for digits.
                  const dot = single ? c.w : clusterBadgeSize(c.events.length)
                  // 27, not 24: the dot is a button, and 24 CSS px renders at
                  // 21.6 device px under `body { zoom: 0.9 }`. The visual dot
                  // keeps its own size (`dot`); this is only the transparent
                  // hit area around it, so a small dot is still easy to click.
                  // Its width (c.hitW) stops halfway to a closer neighbour, so
                  // one mark's hit area never covers the next mark.
                  const hit = Math.max(MARK_HIT_PX, dot + 8)
                  const hitW = c.hitW
                  // v0.6.89.5: filter dimming. Focus-chain and filter query
                  // are mutually exclusive (enforced by the effects above), so
                  // at most one branch fires. A cluster is "active" (not
                  // dimmed) if ANY event in it is in the active set.
                  let dimmed = false
                  if (focusChain) {
                    dimmed = !c.events.some((e) => focusChain.has(e.id))
                  } else if (filterMatches) {
                    // The shared filter never reaches here: rows it excludes
                    // are not loaded. Only the filter box dims.
                    dimmed = !c.events.some((e) => filterMatches.has(e.id))
                  }
                  // FR-018: a dimmed dot says so to assistive technology too,
                  // not only by its opacity.
                  const notMatching = dimmed && !!filterMatches && !focusChain
                  // In-chain event also gets a slim ring in the anchor's lane
                  // colour so operators can see the chain trail at a glance.
                  const anchorEvt = focusAnchorId ? eventsMapRef.current.get(focusAnchorId) : null
                  const inChain = focusChain && c.events.some((e) => focusChain.has(e.id))
                  const chainRingColor = anchorEvt
                    ? LANE_COLORS[toLane(anchorEvt.agentType, anchorEvt.data?.subtype as string | undefined, pluginTypes)]
                    : LANE_COLORS[c.lane]
                  // Badge overlay — only for single-event clusters (multi-dot
                  // clusters are already crowded; the operator can click into
                  // them and see badges in the popover row).
                  const badges = single ? badgesById.get(evt.id) : undefined
                  const badgeTitle = badges && badges.length
                    ? '\n' + badges.map((b) => `${b.icon} ${b.reasonKey ? t(b.reasonKey) : b.reason ?? ''}`).join('\n')
                    : ''
                  // v0.7.7 U2: nudge subagent (Task-tool) events right by a
                  // few pixels so a burst of parallel subagent turns visibly
                  // hangs off its parent main-thread turn rather than
                  // clobbering it. Only applies to single-event dots
                  // (clusters already visually distinct via count label).
                  const indent = c.dx
                  // v0.11.6 (AUDIT V9): a real button, not a div.
                  //
                  // These were plain divs with a click handler — no role, no
                  // label, unreachable by keyboard and invisible to a screen
                  // reader. The ↑/↓ walk only engaged after a mouse click had
                  // already selected something, so a keyboard-only operator
                  // could not reach the track at all.
                  //
                  // Roving tabindex: only the selected dot (or the first one,
                  // when nothing is selected) is a tab stop, so Tab moves past
                  // the track in one press rather than through every visible
                  // node, and ↑/↓ walks from there — the same model the
                  // existing keyboard handler already implements.
                  const isTabStop = single && (sel || (!selectedEvent && c === visibleClusters[0]))
                  // Every dot is the same grey and its shape is severity, so
                  // its type is said in words: on hover (title) and to the
                  // keyboard (accessible name). A cluster names each type it
                  // holds.
                  const typeName = [...new Set(c.events.map((e) => laneLabels[toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes)]))].join('、')
                  return (
                    <button
                      key={c.key}
                      type="button"
                      data-timeline-event
                      tabIndex={isTabStop ? 0 : -1}
                      aria-label={`${single
                        ? `${formatTime(evt.timestamp, { seconds: true })} ${typeName} · ${titleOf(evt)}${shapeTitle(evt, t, foldById.get(evt.id)?.effective.severity)}${amendSuffix(evt)}`
                        : `${t('timeline.events', { count: c.events.length })} · ${typeName}`}${notMatching ? ` · ${t('timeline.notMatching')}` : ''}`}
                      aria-disabled={dimmed || undefined}
                      aria-pressed={sel || undefined}
                      className="absolute cursor-pointer flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 rounded"
                      style={{
                        left: c.x - hitW / 2 + indent,
                        top: c.y - hit / 2,
                        width: hitW,
                        height: hit,
                        zIndex: sel ? 10 : 2,
                        opacity: dimmed ? 0.15 : 1,
                        // v0.11.4 (AUDIT V10): a filtered-out dot was still
                        // clickable — it only lost opacity, keeping its full
                        // hit box. Clicking "nothing" and getting a detail
                        // panel for an event the filter had just excluded read
                        // as the filter being broken.
                        pointerEvents: dimmed ? 'none' : undefined,
                        transition: 'opacity 120ms ease'
                      }}
                      title={single
                        ? `${formatTime(evt.timestamp, { seconds: true })} — ${typeName} · ${titleOf(evt)}${badgeTitle}${shapeTitle(evt, t, foldById.get(evt.id)?.effective.severity)}${amendSuffix(evt)}${ioTitle(ioMark(evt), t)}`
                        : `${c.events.length} ${t('timeline.title')} · ${formatTime(c.events[0].timestamp, { seconds: true })} · ${typeName}`}
                      onMouseEnter={() => { if (single) hoveredEventRef.current = evt }}
                      onMouseLeave={() => { if (single && hoveredEventRef.current === evt) hoveredEventRef.current = null }}
                      onClick={(e) => {
                        // The tail of a pan, not a click on this dot. A
                        // keyboard Enter/Space activation never pans, so it
                        // never hits this.
                        if (didPan.current) return
                        if (!single) { setCluster({ x: c.x, y: c.y, events: c.events }); return }
                        pickEvent(evt, e.detail)
                      }}
                      onDoubleClick={() => { if (single && !didPan.current) openEventBody(evt, 'dblclick') }}
                      onKeyDown={(e) => {
                        // Enter opens (or closes) the body on this dot; the
                        // native click it would also fire is not wanted.
                        if (e.key !== 'Enter' || !single || e.metaKey || e.ctrlKey || e.altKey) return
                        e.preventDefault()
                        e.stopPropagation()
                        openEventBody(evt, 'key')
                      }}
                    >
                      <div
                        data-timeline-mark
                        className={dimmed ? 'shrink-0 flex items-center justify-center' : 'shrink-0 flex items-center justify-center transition-transform hover:scale-125'}
                        style={{
                          width: c.w, height: dot,
                          // diamond = a square turned 45°; ring = hollow.
                          borderRadius: !single ? 5 : marks.shape === 'diamond' ? 2 : '50%',
                          backgroundColor: marks.shape === 'ring' ? 'transparent' : LANE_COLORS[c.lane],
                          border: marks.shape === 'ring'
                            ? `2.5px solid ${LANE_COLORS[c.lane]}`
                            : single ? undefined : '1px solid rgba(0,0,0,0.45)',
                          // §6: 2px brand-red outer ring, dot at 1.3×. The ring
                          // used to take the lane's colour, which since the
                          // lanes went neutral would have made a keyboard move
                          // almost invisible — the one thing it must not be.
                          transform: sel
                            ? `${marks.shape === 'diamond' ? 'rotate(45deg) ' : ''}scale(1.3)`
                            : marks.shape === 'diamond' ? 'rotate(45deg)' : undefined,
                          boxShadow: sel
                            ? `0 0 0 2px #121214, 0 0 0 4px #d75f63, 0 0 12px #d75f6360`
                            : inChain
                              ? `0 0 0 1.5px ${chainRingColor}, 0 0 8px ${chainRingColor}80`
                              : `0 0 6px ${LANE_COLORS[c.lane]}40`
                        }}
                      >
                        {!single && <span style={{ fontSize: 11, fontWeight: 800, color: 'rgba(0,0,0,0.78)', lineHeight: 1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{c.events.length}</span>}
                      </div>
                      {/* v0.9.6 (T3): I/O texture on single shell command_end
                          dots. A 3px notch = output exists on disk; amber =
                          nothing was captured (distinct from "printed
                          nothing", which gets no notch at all). Clusters are
                          skipped — the popup lists members individually. */}
                      {single && (() => {
                        const m = ioMark(evt)
                        if (!m.io && !m.fail) return null
                        return (
                          <>
                            {m.fail && (
                              <span
                                style={{
                                  position: 'absolute', width: dot + 5, height: dot + 5,
                                  borderRadius: '50%', border: '1.5px solid #ef4444',
                                  pointerEvents: 'none'
                                }}
                              />
                            )}
                            {m.io && (
                              <span
                                style={{
                                  position: 'absolute',
                                  left: hitW / 2 + dot / 2 - 3, top: hit / 2 + dot / 2 - 3,
                                  width: 3, height: 3, borderRadius: '50%',
                                  background: IO_MARK_COLOR[m.io],
                                  pointerEvents: 'none'
                                }}
                              />
                            )}
                          </>
                        )
                      })()}
                      {/* Feature 3: single-badge bubble at top-right. Only the
                          first badge shows here to keep the dot readable; the
                          rest surface in the tooltip and in the detail panel. */}
                      {single && badges && badges.length > 0 && (
                        <span
                          className="absolute -top-0.5 -right-0.5 rounded-full bg-redlog-bg/95 border border-amber-500/60 text-xs leading-none flex items-center justify-center pointer-events-none"
                          style={{ width: 12, height: 12 }}
                        >
                          {badges[0].icon}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
        </div>
        {/* Cluster contents popover. Drawn here, on the track column, not in
            the lanes: the track's scrollers clip vertically, and the standard
            track is one 44px row, so a list drawn inside it showed its header
            and nothing under it. Positioned from the lanes' on-screen box, so
            it follows a horizontal scroll (which re-renders through
            `updateView`). */}
        {cluster && (() => {
          // Popover width + cap: cluster popovers used to render EVERY event
          // in a burst (audit P2 — a 3000-event mitmproxy scan filled the
          // list with 3000 <button>s). Cap at 50 with a "+N more" footer;
          // operator can zoom in to see individually.
          const POPUP_W = 240
          const POPUP_MAX_H = 210
          const MAX_ITEMS = 50
          const capped = cluster.events.slice(0, MAX_ITEMS)
          const overflow = cluster.events.length - capped.length
          // The lanes' offset inside the column, in CSS px. Both rects are in
          // the same (zoomed) space; `k` takes their difference back to CSS
          // px under `body { zoom }`, and is 1 where layout is not measured.
          const col = trackColumnRef.current
          const lanes = lanesAreaRef.current
          let ox = 0
          let oy = 0
          if (col && lanes) {
            const cr = col.getBoundingClientRect()
            const lr = lanes.getBoundingClientRect()
            const k = cr.width > 0 ? col.offsetWidth / cr.width : 1
            ox = (lr.left - cr.left) * k
            oy = (lr.top - cr.top) * k
          }
          const colW = col?.clientWidth ?? 0
          const colH = col?.clientHeight ?? 0
          const px = ox + cluster.x
          const py = oy + cluster.y
          const left = Math.max(4, Math.min(px + 10, colW - POPUP_W - 4))
          const top = py + 12 + POPUP_MAX_H > colH && py - POPUP_MAX_H - 4 >= 0
            ? py - POPUP_MAX_H - 4
            : py + 12
          return (
                  <div className="absolute z-30" data-timeline-popup style={{ left, top, width: POPUP_W }}>
                    <div className="rounded-md border border-redlog-border bg-redlog-surface/95 shadow-xl max-h-[210px] overflow-y-auto">
                      <div className="flex items-center justify-between px-2 py-1 border-b border-redlog-border sticky top-0 bg-redlog-surface/95">
                        <span className="text-xs text-redlog-text-dim font-mono">{cluster.events.length} {t('timeline.title')}</span>
                        <button type="button" aria-label={t('common.close')} className="min-w-7 min-h-7 -my-1 -mr-1 flex items-center justify-center text-redlog-text-dim hover:text-redlog-text text-xs leading-none" onClick={() => setCluster(null)}>×</button>
                      </div>
                      {capped.map((evt) => (
                        <button
                          key={evt.id}
                          className="w-full min-h-7 text-left px-2 py-1 hover:bg-white/5 flex items-center gap-2"
                          onClick={() => {
                            setSelectedEvent(evt)
                            setCluster(null)
                            // Zoom based on cluster time span rather than a hardcoded 8×
                            // so a 500-event burst in 1s and a 5-event burst in 30min
                            // both split into distinct dots. Aim for CLUSTER_PX * count
                            // pixels across the cluster's span at the new zoom.
                            const evs = cluster.events
                            const first = evs[0].timestamp
                            const last = evs[evs.length - 1].timestamp
                            const spanMs = Math.max(1, last - first)
                            const spanRatio = spanMs / Math.max(1, timeSpan)
                            const neededTrackW = (evs.length + 1) * CLUSTER_PX / Math.max(spanRatio, 0.001)
                            const spanZoom = neededTrackW / baseTrackW
                            const targetZoom = Math.max(zoom, Math.min(maxZoom, spanZoom))
                            if (Math.abs(targetZoom - zoom) > 0.01) {
                              pendingCenterTs.current = evt.timestamp
                              setZoom(targetZoom)
                            } else {
                              const sc = scrollRef.current
                              if (sc) sc.scrollLeft = Math.max(0, Math.min(toX(displayTs(evt)) - sc.clientWidth / 2, TRACK_W - sc.clientWidth))
                            }
                          }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[toLane(evt.agentType, evt.data?.subtype as string | undefined, pluginTypes)] }} />
                          <span className="text-redlog-text-faint font-mono text-xs tabular-nums shrink-0">{formatTime(evt.timestamp, { seconds: true })}</span>
                          <span title={titleOf(evt)} className="text-redlog-text text-xs truncate">{titleOf(evt)}</span>
                        </button>
                      ))}
                      {overflow > 0 && (
                        <div className="px-2 py-1 text-xs text-redlog-text-dim border-t border-redlog-border sticky bottom-0 bg-redlog-surface/95">
                          {t('timeline.clusterMoreItems', { count: overflow })}
                        </div>
                      )}
                    </div>
                  </div>
          )
        })()}

        {/* No split handle between the track and the rail any more: the
            standard track is one row sized to its content and the rail takes
            the rest, and swim lanes hide the rail (2026-11-08). */}
        {/* Swim lanes hide the list (Stitch 05; user decision 2026-11-08): the
            selected event opens in the detail pane, and the two strips only
            the log could say stay under the lanes. */}
        <TimelineEventLog
          hiddenByQuery={hiddenByQuery}
          annotatedIds={annotatedIds}
          showingAll={showAllDespiteQuery && filterMatches !== null}
          onToggleHidden={toggleShowAll}
          stripsOnly={timelineMode === 'lanes'}
          events={recentEvents}
          total={windowTotal}
          selectedId={selectedEvent?.id ?? null}
          detailOpen={detailOpen}
          pluginTypes={pluginTypes}
          showOperator={showOperator}
          operatorLabel={operatorLabel}
          titleOf={titleOf}
          amendSuffix={amendSuffix}
          amendCountOf={amendCountOf}
          onSelect={pickEvent}
          onOpen={openEventBody}
          t={t}
        />
        {selectedEvent && (
          <TimelineDetailBar
            event={selectedEvent}
            pluginTypes={pluginTypes}
            titleOf={titleOf}
            onStep={stepIndex >= 0 ? stepTo : undefined}
            canStepPrev={stepIndex > 0}
            canStepNext={stepIndex >= 0 && stepIndex < recentEvents.length - 1}
            onOpenInActivity={onOpenInActivity}
            bodyOpen={detailOpen}
            onToggleBody={() => setDetailOpen((v) => !v)}
            onOpenReader={() => { setReader('expanded'); setDetailOpen(true) }}
            t={t}
          />
        )}
      </div>

      {/* Enhanced detail panel — height is drag-resizable; the handle at the
          top edge sets height in px (persisted to localStorage). Falling back
          to the CSS `max-h-[45vh]` when the operator hasn't dragged. */}
      {selectedEvent && detailOpen && (
        <>
          {/* 4px hit strip on the edge the pane grows from. */}
          <div
            data-testid="timeline-detail-resize"
            className={`shrink-0 bg-redlog-elevated/50 hover:bg-red-500/40 transition-colors relative ${
              layout === 'bottom' ? 'h-1 cursor-row-resize' : 'w-1 cursor-col-resize'
            }`}
            title={t('timeline.resizeDetailPanel')}
            onMouseDown={(e) => {
              const box = detailPanelRef.current?.getBoundingClientRect()
              detailPanel.beginResize(e, layout === 'bottom' ? box?.height ?? 320 : box?.width ?? 440)
            }}
            onDoubleClick={detailPanel.reset}
          >
            <div className={`absolute rounded bg-redlog-elevated-hover/50 pointer-events-none ${
              layout === 'bottom'
                ? 'left-1/2 top-0 -translate-x-1/2 h-1 w-8'
                : 'top-1/2 left-0 -translate-y-1/2 w-1 h-8'
            }`} />
          </div>
        <div
          ref={detailPanelRef}
          data-testid="timeline-detail-body"
          className={`shrink-0 border-redlog-border/50 px-4 pb-3 bg-redlog-surface/80 overflow-y-auto ${
            layout === 'bottom'
              ? `border-t${detailPanel.px == null ? ' max-h-[45vh]' : ''}`
              : 'border-l h-full'
          }`}
          style={detailPanel.px == null
            ? (layout === 'right' ? { width: 440 } : undefined)
            : (layout === 'bottom' ? { height: detailPanel.px } : { width: detailPanel.px })}
        >
          <TimelineEventInspector
            event={selectedEvent}
            pluginTypes={pluginTypes}
            tierChip={tierChip}
            doNotExport={dneFlag}
            onToggleDoNotExport={() => {
              const id = selectedEvent.id
              // The switch moves only on the written value; null is a refusal.
              const failed = (detail?: string): void => { toast(t('timeline.doNotExportFailed'), { type: 'error', detail }) }
              window.redlog.events.toggleDoNotExport(id)
                .then((v) => {
                  if (v === null) { failed(); return }
                  if (selectedRef.current?.id === id) setDneFlag(v)
                })
                .catch((err: unknown) => failed(err instanceof Error ? err.message : String(err)))
            }}
            onAround={() => setSharedTimeRange(windowAround(selectedEvent.timestamp))}
            operatorLabel={operatorLabel}
            titleOf={titleOf}
            badges={badgesById.get(selectedEvent.id)}
            effects={effectsById.get(selectedEvent.id)}
            fold={foldById.get(selectedEvent.id)}
            paired={pairedToolHalf(selectedEvent, toolPairByUseId)}
            unfinished={unfinishedIds.has(selectedEvent.id)}
            allLoaded={!hasMore}
            focusChainOn={!!focusChain}
            showJson={showJson}
            lookup={(id) => eventsMapRef.current.get(id)}
            onJump={(e) => { setSelectedEvent(e); setDetailOpen(true); scrollToEvent(e) }}
            reader={{ mode: readerMode, setMode: setReader }}
            layout={layout}
            onToggleLayout={compactSplit ? undefined : () => setDetailLayout(preferredLayout === 'bottom' ? 'right' : 'bottom')}
            onClose={() => setDetailOpen(false)}
            onSelect={(e) => { setSelectedEvent(e); setDetailOpen(true) }}
            onResolve={(id) => void resolveReferencedEvent(id)}
            scrollToTs={scrollToTs}
            onAmend={(id, changes) => void handleAmend(id, changes)}
            t={t}
          />
        </div>
        </>
      )}
      </div>
    </div>
  )
})
