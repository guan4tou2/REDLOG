import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, Fragment } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'
import { useSharedFilter, toEventFilter, describeActiveConditions } from '../lib/FilterContext'
import { LoadingSpinner } from './Feedback'
import { getLastVerifyResult, VERIFY_UPDATED_EVENT, type FullVerifyResult } from '../lib/verifyResultCache'
import { resolveTimelineKey } from '../lib/timelineKeys'
import { Rows3 } from 'lucide-react'
import { formatTime, formatTs, type TzMode, type TsStyle } from '../lib/time'
import { usePersistentState } from '../lib/usePersistentState'
import { buildToolPairIndex, pairedToolHalf } from '../lib/toolPairing'
import { nextSelection } from '../lib/timelineSelection'
import { computeMaxZoom, buildClusters, filterVisibleClusters, type TimelineCluster } from '../lib/timelineGeometry'
import { buildTimeMap, computeDomainBounds, computeBins, type TimeMap } from '../lib/timelineTimeMap'
import { buildSessionBands, type SessionBand } from '../lib/timelineSessionBands'
import { buildEffectsIndex, computeViolationStanding, buildFoldIndex, buildBadgeIndex } from '../lib/timelineAnnotations'
import { buildSearchIndex, computeFilterMatches, computeTargetMatches, distributeLaneEvents, distributeRowEvents, computeRecentEvents, computeSliceCount, type ViewportWindow } from '../lib/timelineFilters'
import { TimelineHelpModal } from './TimelineHelpModal'
import { isCollapsibleAgentTurn, filterAgentTurns, collapseCommandPairs, formatGap } from '../lib/timelineEvents'
import {
  isMarkerAmendment,
  AMENDABLE_FIELDS, type MarkerValues
} from '../lib/markerFold'
import { MarkerDetail } from './MarkerDetail'
import { isHookSource } from '../lib/housekeeping'
import { isMac } from '../lib/platform'
import { useContributeExport } from '../lib/exportScope'
import {
  LANES, type LaneId, BANDS, type BandId, BAND_OF, EXTERNAL_ONLY_LANES, LANE_COLORS,
  type PluginEventType, type DotShape, IO_MARK_COLOR,
  displayTs, toLane, eventCompare, binarySearchInsert,
  axisLabel, formatBehind, ioMark, dotShape, shapeTitle, ioTitle,
  subagentIndentPx
} from '../lib/timelineDomain'
import { eventTitle } from '../lib/eventTitle'
import { TierBadge } from './TierBadge'
import { ReplayCommand } from './ReplayCommand'
import { CommandEndDetail, AgentTurnDetail, BrowserConsoleDetail } from './TimelineEventDetails'
import { HttpDetail } from './HttpDetail'

const MIN_LANE_H = 36
const LABEL_W = 92
// v0.11.6 (AUDIT V8): a floor, not a fixed width. The track used to be exactly
// 2000px at zoom 1 regardless of the window, so on a 2560px or 4K display the
// operator got a track narrower than the space available and a band of empty
// panel to its right. It is now max(2000, container) — a wide window shows
// more time instead of more nothing.
const MIN_BASE_TRACK_W = 2000
// v0.11.6 (V7): a stretch with no events longer than this collapses to GAP_PX.
// Ten minutes is long enough that nothing routine trips it and short enough to
// catch a coffee break; the fixed width has to stay wide enough to draw a
// legible break marker in.
const GAP_MIN_MS = 10 * 60_000
const GAP_PX = 48
// Browsers cap element width well above this; the ceiling exists so a
// pathological zoom can't allocate a track nothing can scroll.
const MAX_TRACK_W = 400_000

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

export default function TimelinePanel({ focusEventId, focusTs, focusTarget, onDropMarker, tierChip = true }: { focusEventId?: string; focusTs?: number; focusTarget?: string; onDropMarker?: (ts: number) => void; tierChip?: boolean } = {}): JSX.Element {
  // Spec 033: the shared filter is applied where the events are stored, for
  // every page, count and live row. Nothing below filters on it again.
  const { filter: sharedFilter, activeCount: filterActiveCount } = useSharedFilter()
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
  // v0.14 §9.2: auditor-view state hoisted above the `events` useMemo so
  // the filter can compose in one place. Persistence + per-project scoping
  // lives further down alongside the other filter state (see below).
  const [auditorView, setAuditorView] = useState(false)
  const events = useMemo(
    () => {
      const base = filterAgentTurns(collapseCommandPairs(rawEvents), collapseAgentTurns)
      // When auditor view is on, drop logged-tier rows.
      return auditorView ? base.filter((e) => e.tier !== 'logged') : base
    },
    [rawEvents, collapseAgentTurns, auditorView]
  )
  // Count of logged rows that WOULD be hidden by auditor view — surfaces on
  // the chip so the operator can see how much the filter is doing. Uses
  // rawEvents so the number is stable regardless of the agent-turn collapse.
  const hiddenLoggedCount = useMemo(
    () => rawEvents.reduce((n, e) => n + (e.tier === 'logged' ? 1 : 0), 0),
    [rawEvents]
  )
  // Count of hidden agent turns to surface on the chip so the operator
  // knows the toggle is doing something (else the empty agent lane looks
  // like a bug). Recomputed only when raw events or toggle change.
  const hiddenAgentTurnCount = useMemo(() => {
    if (!collapseAgentTurns) return 0
    return rawEvents.filter(isCollapsibleAgentTurn).length
  }, [rawEvents, collapseAgentTurns])
  // A tool_call and its tool_result are two separate chained events (each
  // independently hashed + timestamped, so the chain records real call→return
  // latency and order). That makes the exchange easy to audit but splits it
  // across two dots. This index maps tool_use_id → each half in the loaded set
  // so the detail panel can show the other half inline (see pairedToolHalf).
  // Keyed on rawEvents so it still finds a result the agent-turn collapse hides;
  // a partner not yet paged in is simply absent — a graceful no-op.
  const toolPairByUseId = useMemo(() => buildToolPairIndex(rawEvents), [rawEvents])
  const [selectedEvent, setSelectedEvent] = useState<RedLogEvent | null>(null)
  const [dneFlag, setDneFlag] = useState(false)
  // §6: the Inspector is a separate layer from the selection. They used to be
  // the same state, so an operator could not walk the timeline by keyboard
  // without a panel covering a third of it — and closing the panel lost their
  // place entirely. Clicking a dot still opens both; arrows move the ring
  // alone, and Enter opens the panel on whatever the ring is on.
  const [detailOpen, setDetailOpen] = useState(false)
  // The one contiguous range the panel draws: every admitted row from the
  // newest down to `pageCursor`, the keyset position the next page starts at.
  // A shared-filter change starts a new generation; a reply to an older one
  // is dropped, so rows for the old filter never land under the new one.
  const [hasMore, setHasMore] = useState(false)
  const pageCursorRef = useRef<string | null>(null)
  const generationRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // "N of M": M counted over the same predicates as the pages. Pending until
  // it arrives, failed (with retry) rather than guessed.
  const [total, setTotal] = useState<{ state: 'pending' } | { state: 'ok'; value: number } | { state: 'failed' }>({ state: 'pending' })
  const recountRef = useRef(false)
  const [liveError, setLiveError] = useState<{ ids: RedLogEvent[] } | null>(null)
  const [outsideFilter, setOutsideFilter] = useState(false)
  // v0.11.6 (V7). Off by default: a compressed axis is not proportional, and
  // for an audit tool that has to be an explicit, visible choice.
  const [compressGaps, setCompressGaps] = useState(false)
  const [containerH, setContainerH] = useState(0)
  // v0.11.6 (V8): the track's base width follows the container, so the
  // observer has to report width as well as height.
  const [containerW, setContainerW] = useState(0)
  // v0.6.91 S4: persisted zoom. Clamped to the same [0.25, 6] range the ± buttons
  // enforce so a garbage value in storage can't produce a broken layout.
  const [zoom, setZoom] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('redlog-timeline-zoom')
      const n = raw ? parseFloat(raw) : NaN
      return Number.isFinite(n) && n >= 0.25 && n <= 6 ? n : 1
    } catch { return 1 }
  })
  const [cluster, setCluster] = useState<{ x: number; y: number; events: RedLogEvent[] } | null>(null)
  const [view, setView] = useState({ left: 0, width: 100 })
  const [drag, setDrag] = useState<{ x0: number; x1: number; w: number } | null>(null)
  const pendingView = useRef<{ t0: number } | null>(null)
  // Cluster-item click needs a two-frame handshake: bump zoom so the events
  // split into distinct dots, then center on the picked one after re-render.
  // We can't scroll synchronously because TRACK_W hasn't grown yet.
  const pendingCenterTs = useRef<number | null>(null)
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
  // Detail-panel height, in px. Persisted to localStorage so operator's chosen
  // size survives reloads. Default `null` = use CSS max-h-[45vh] fallback.
  const [detailPanelPx, setDetailPanelPx] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('redlog-timeline-detail-h')
      const n = raw ? parseInt(raw, 10) : NaN
      return Number.isFinite(n) && n > 80 && n < 2000 ? n : null
    } catch { return null }
  })
  const detailResizing = useRef<{ startY: number; startH: number } | null>(null)
  // Detail panel container. Reset scroll to top on every selectedEvent change
  // so a cluster-popover click always lands you on the new item's title —
  // otherwise the panel keeps whatever scroll offset the prior event left
  // (with JSON expanded the title easily scrolls off screen).
  const detailPanelRef = useRef<HTMLDivElement | null>(null)
  const [operatorNames, setOperatorNames] = useState<Record<string, string>>({})
  // v0.6.89.5: focus chain / anomaly filter / broken-chain state.
  //
  // `focusChain` (feature 2) is a set of every event id in the causal
  // component of the anchor — null means the filter is off. Persisted as
  // just the anchor id so a stale set can't leak across mounts.
  // `anomalyFilter` (feature 4) toggles "dim everything without a badge".
  // These two are mutually exclusive — enabling one clears the other.
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

  const settingsLoadedFor = useRef<string | null>(null)
  const [anomalyFilter, setAnomalyFilter] = useState(false)
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
    load('redlog-timeline-anomaly-filter', (s) => s === '1', setAnomalyFilter)
    load('redlog-timeline-auditor-view', (s) => s === '1', setAuditorView)
    load('redlog-timeline-focus-anchor', (s) => s, setFocusAnchorId)
    load('redlog-timeline-filter-query', (s) => s, setFilterQuery)
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
  useEffect(() => {
    if (!projectIdForKeys) return
    try {
      localStorage.setItem(`redlog-timeline-anomaly-filter:${projectIdForKeys}`, anomalyFilter ? '1' : '0')
    } catch { /* ignore */ }
  }, [anomalyFilter, projectIdForKeys])
  useEffect(() => {
    if (!projectIdForKeys) return
    try {
      localStorage.setItem(`redlog-timeline-auditor-view:${projectIdForKeys}`, auditorView ? '1' : '0')
    } catch { /* ignore */ }
  }, [auditorView, projectIdForKeys])

  // v0.6.91 W1: inline `/` search — dims events whose title / command / URL /
  // host / operator doesn't substring-match the query. Persisted so the
  // filter survives a reload; empty string means "no filter".
  // Target focus: scope the view to one target's activity, arrived at from
  // the Targets list. It reuses the filter-dimming pipeline rather than
  // adding a second axis - the source lanes stay, and everything that did
  // not touch this target dims away. Matched precisely (id or endpoint), so
  // 10.0.0.5 does not also light up 10.0.0.50 the way the text filter would.
  const [targetFocus, setTargetFocus] = useState<string | null>(focusTarget ?? null)
  useEffect(() => { setTargetFocus(focusTarget ?? null) }, [focusTarget])
  const effectiveTarget = sharedFilter.targetId ?? targetFocus

  const [filterQuery, setFilterQuery] = useState('')
  useEffect(() => {
    if (!projectIdForKeys) return
    try {
      const scoped = `redlog-timeline-filter-query:${projectIdForKeys}`
      if (filterQuery) localStorage.setItem(scoped, filterQuery)
      else localStorage.removeItem(scoped)
    } catch { /* ignore */ }
  }, [filterQuery, projectIdForKeys])
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  // v0.6.91 W2: follow mode — auto-scrolls the track's right edge to keep the
  // newest event visible while enabled. On by default; the header badge
  // reflects "🔴 LIVE" vs "⏸ Xm behind" state. `now` state ticks every second
  // just so the "behind" label refreshes without waiting for a new event.
  const [followMode, setFollowMode] = usePersistentState<boolean>(
    'redlog-timeline-follow-mode', true,
    { parse: (raw) => raw !== '0', serialize: (v) => (v ? '1' : '0') }
  )
  const [atRightEdge, setAtRightEdge] = useState(true)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // v0.6.91 S3: dashed vertical dividers + faint bands for shell.session_end
  // and system.recording_paused/resumed pairs. Toggle persisted; default on
  // because it's the primary visual anchor when reviewing a multi-terminal
  // engagement.
  const [sessionDividers, setSessionDividers] = usePersistentState<boolean>(
    'redlog-timeline-session-dividers', true,
    { parse: (raw) => raw !== '0', serialize: (v) => (v ? '1' : '0') }
  )

  // v0.6.91 S7: timezone picker. `projectTz` is filled from
  // config.engagement.timezone when the panel mounts; if unset or invalid,
  // the "Project" option falls back to Local (via formatTs).
  const [tz, setTz] = usePersistentState<TzMode>(
    'redlog-timeline-tz', 'local',
    { parse: (raw) => (raw === 'utc' || raw === 'project' ? raw : 'local') }
  )
  const [projectTz, setProjectTz] = useState<string | null>(null)
  useEffect(() => {
    window.redlog.config.get().then((c) => {
      const cfg = c as { engagement?: { timezone?: string } } | null | undefined
      const tzName = cfg?.engagement?.timezone
      setProjectTz(typeof tzName === 'string' && tzName ? tzName : null)
    }).catch(() => {})
  }, [])

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
  // cannot reach into the Timeline's filter state, so it asks by event.
  useEffect(() => {
    const onFilterOperator = (e: Event): void => {
      const name = (e as CustomEvent<string>).detail
      if (name) setFilterQuery(name)
    }
    window.addEventListener('redlog:filter-operator', onFilterOperator)
    // §10: ⌘K host search lands the operator on the Timeline filtered to that
    // host — the filter box already matches `data.host`, so it's the same path.
    const onFilterHost = (e: Event): void => {
      const host = (e as CustomEvent<string>).detail
      if (host) setFilterQuery(host)
    }
    window.addEventListener('redlog:filter-host', onFilterHost)
    return () => {
      window.removeEventListener('redlog:filter-operator', onFilterOperator)
      window.removeEventListener('redlog:filter-host', onFilterHost)
    }
  }, [])
  // Overflow for the low-frequency view/audit controls (session dividers,
  // timezone, auditor view) so the toolbar row groups by effect instead of
  // listing eight flat toggles (DESIGN-core-and-capture.md §6).
  const [moreOpen, setMoreOpen] = useState(false)

  // v0.6.91 W1 mutual exclusion: enabling any of the three dim modes clears
  // the others. Kept as a set of effects so keyboard, click, and event-listener
  // paths all converge. `focusChain` mutual exclusion with `anomalyFilter`
  // was already handled below — extending with filterQuery here.
  useEffect(() => {
    if (!filterQuery) return
    if (focusAnchorId) setFocusAnchorId(null)
    if (anomalyFilter) setAnomalyFilter(false)
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
    if (selectedEvent?.id) {
      void window.redlog.events.isDoNotExport(selectedEvent.id).then(setDneFlag)
    }
  }, [selectedEvent?.id])

  // Detail-panel drag-to-resize. Handle at the top edge of the panel — drag
  // up to grow, drag down to shrink. Persisted to localStorage so the choice
  // survives across reloads.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const s = detailResizing.current
      if (!s) return
      const dy = s.startY - e.clientY
      const next = Math.max(80, Math.min(window.innerHeight * 0.85, s.startH + dy))
      setDetailPanelPx(next)
    }
    const onUp = (): void => {
      if (!detailResizing.current) return
      detailResizing.current = null
      document.body.classList.remove('timeline-resizing')
      try { if (detailPanelPx != null) localStorage.setItem('redlog-timeline-detail-h', String(Math.round(detailPanelPx))) } catch { /* ignore */ }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [detailPanelPx])

  // Known operator ids, held in a ref so the event guard below reads the
  // CURRENT set. It used to read the `operatorNames` state, which the []-dep
  // effect captured empty on first render — so `!operatorNames[id]` was always
  // true and every incoming event fired an operators.list() IPC + a full
  // TimelinePanel re-render, bypassing the events:new-batch throttle during a
  // 200 evt/s capture.
  const knownOperatorsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const load = (): void => {
      window.redlog.operators.list().then((ops) => {
        const map: Record<string, string> = {}
        ops.forEach((op) => { map[op.id] = op.name })
        knownOperatorsRef.current = new Set(Object.keys(map))
        setOperatorNames(map)
      }).catch(() => {})
    }
    load()
    const unsub = window.redlog.events.onNewBatch((events) => {
      if (events.some((e) => e.operatorId && !knownOperatorsRef.current.has(e.operatorId))) load()
    })
    return unsub
  }, [])

  const operatorLabel = (id: string): string => operatorNames[id] || id
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
  const isDragging = useRef(false)
  const dragStart = useRef({ x: 0, scroll: 0 })
  const didScrollToNow = useRef(false)
  const pendingZoomAnchor = useRef<{ frac: number; cursorX: number } | null>(null)
  const { t } = useI18n()

  const laneLabels: Record<LaneId, string> = useMemo(() => ({
    shell: t('timeline.shell'),
    agent: t('timeline.agent'),
    http_navigation: t('timeline.http'),
    scanner: t('timeline.scanner'),
    browser: t('timeline.browser'),
    dns: t('timeline.dns'),
    pivot: t('timeline.pivot'),
    screenshot: t('timeline.screenshot'),
    clipboard: t('timeline.clipboard'),
    file_transfer: t('timeline.files'),
    credential_use: t('timeline.credentialUse'),
    c2_checkin: t('timeline.c2Checkin'),
    marker: t('timeline.markers'),
    loot: t('timeline.loot'),
    cleanup: t('timeline.cleanup'),
    scope: t('timeline.scope'),
    process: t('timeline.process'),
    system: t('timeline.system')
  }), [t])

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(([entry]) => {
      setContainerH(entry.contentRect.height)
      setContainerW(entry.contentRect.width)
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // A lane with no events is dead vertical space — most engagements only ever
  // touch three or four of them. Keep the filter chip so the operator can see
  // the lane exists, but don't give it a row until something lands in it.
  const populatedLanes = useMemo(() => {
    const seen = new Set<LaneId>()
    for (const e of events) seen.add(toLane(e.agentType, e.data?.subtype as string | undefined, pluginTypes))
    return seen
    // v0.6.95 P1-12: pluginTypes was missing from deps — a plugin-registered
    // event lane wouldn't appear on the filter chip until an unrelated state
    // change re-ran the memo. Same fix applied to `laneEvents` and
    // `recentEvents` below.
  }, [events, pluginTypes])

  // The lane an event's row is keyed on: its band's id when that band is
  // collapsed, otherwise the lane itself.
  const rowKeyOf = useCallback(
    (lane: LaneId): string => (collapsedBands.has(BAND_OF[lane]) ? BAND_OF[lane] : lane),
    [collapsedBands]
  )

  // The rows actually rendered, in band order. A band with any populated lane
  // contributes either one aggregate row (collapsed) or its populated,
  // non-hidden lanes (expanded). Empty bands contribute nothing, exactly as
  // empty lanes did.
  const visibleRows = useMemo(() => {
    const rows: string[] = []
    for (const band of BANDS) {
      const popLanes = band.lanes.filter((l) => populatedLanes.has(l))
      if (popLanes.length === 0) continue
      if (collapsedBands.has(band.id)) rows.push(band.id)
      else for (const l of popLanes) if (!hiddenLanes.has(l)) rows.push(l)
    }
    return rows
  }, [populatedLanes, hiddenLanes, collapsedBands])

  // Still keyed on individual lanes; retained for the zoom-ceiling scan below.
  const visibleLanes = useMemo(
    () => LANES.filter((l) => populatedLanes.has(l) && !hiddenLanes.has(l)),
    [populatedLanes, hiddenLanes]
  )

  const laneH = useMemo(() => {
    if (visibleRows.length === 0) return MIN_LANE_H
    const axisH = 28
    const available = containerH - axisH
    return Math.max(MIN_LANE_H, Math.floor(available / visibleRows.length))
  }, [containerH, visibleRows.length])

  // Spec 033 (research R1): pages come from the shared-filter page query, on
  // its keyset cursor (timestamp, rowid, tier). The old pager walked
  // `created_at` so a late row with an older wall-clock could not be skipped;
  // a keyset never skips a row past its cursor, and a row that lands inside
  // the drawn range arrives on the live channel below.
  const PAGE_ROWS = 200
  const MATCH_CHUNK = 1000
  const totalRef = useRef(total)
  totalRef.current = total
  const selectedRef = useRef<RedLogEvent | null>(null)
  selectedRef.current = selectedEvent

  const mergeRows = (rows: RedLogEvent[]): void => {
    for (const e of rows) {
      if (!eventsMapRef.current.has(e.id)) binarySearchInsert(sortedRef.current, e)
      eventsMapRef.current.set(e.id, e)
    }
  }

  // M for "N of M". A live row admitted while this count is in flight may or
  // may not be in it, so it counts once more instead of guessing.
  const requestTotal = (gen: number): void => {
    recountRef.current = false
    setTotal({ state: 'pending' })
    window.redlog.events.count({ filter: eventFilterRef.current, excludeHousekeeping: true })
      .then((n) => {
        if (gen !== generationRef.current) return
        if (recountRef.current) { requestTotal(gen); return }
        setTotal({ state: 'ok', value: n })
      })
      .catch(() => { if (gen === generationRef.current) setTotal({ state: 'failed' }) })
  }

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

  const loadFirstPage = useCallback((): void => {
    const gen = ++generationRef.current
    eventsMapRef.current = new Map()
    sortedRef.current = []
    pageCursorRef.current = null
    setEvents([])
    setHasMore(false)
    setLoadError(null)
    setLiveError(null)
    setOutsideFilter(false)
    setLoading(true)
    requestTotal(gen)
    window.redlog.events.queryPage({ ...eventFilterRef.current, excludeHousekeeping: true, limit: PAGE_ROWS })
      .then((page) => {
        if (gen !== generationRef.current) return
        mergeRows(page.items)
        setEvents([...sortedRef.current])
        setHasMore(page.hasMore)
        pageCursorRef.current = page.nextCursor
        setLoading(false)
        checkSelection(gen)
      })
      .catch((err: unknown) => {
        if (gen !== generationRef.current) return
        setLoadError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    // Reads only refs and state setters, so one instance serves every generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filterKey = JSON.stringify(eventFilter)
  useEffect(() => { loadFirstPage() }, [filterKey, loadFirstPage])

  const loadMore = useCallback(() => {
    if (loading || !hasMore || !pageCursorRef.current) return
    const gen = generationRef.current
    setLoadError(null)
    setLoading(true)
    window.redlog.events.queryPage({
      ...eventFilterRef.current, excludeHousekeeping: true, limit: PAGE_ROWS, cursor: pageCursorRef.current
    })
      .then((page) => {
        if (gen !== generationRef.current) return
        mergeRows(page.items)
        setEvents([...sortedRef.current])
        setHasMore(page.hasMore)
        pageCursorRef.current = page.nextCursor
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (gen !== generationRef.current) return
        setLoadError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [loading, hasMore])

  const admitLiveRef = useRef<(batch: RedLogEvent[]) => Promise<void>>(async () => {})
  useEffect(() => {
    // v0.6.95 P0-4c + P1-12: batch listener + sorted-insert. Main sends
    // `events:new-batch` with an Array<RedLogEvent> once per frame per burst;
    // this handler folds them into the sorted array in one shot, then does a
    // single setEvents / re-render.
    let scheduled = false
    const flush = (): void => {
      scheduled = false
      // Shallow copy so React sees a new reference and re-renders.
      setEvents([...sortedRef.current])
    }
    // v0.11.7 (AUDIT W19): back off from a per-frame flush once the set is big.
    //
    // Every flush replaces the events array, which invalidates every memo on
    // the panel. Measured at 131,833 events those cost ~65 ms per pass even
    // with the search index gone lazy (laneEvents 18, effectsById 33, maxZoom
    // 11, clusters and bins on top). A requestAnimationFrame schedule asks for
    // that 60 times a second, so during heavy ingest the panel spends every
    // frame recomputing and none of it painting.
    //
    // Under the threshold a frame-accurate flush is imperceptible and worth
    // keeping — a live tail should look live. Over it, coalescing to ~4 Hz
    // costs at most a quarter-second of staleness on a view whose own
    // freshness badge counts in seconds, and hands the frames back.
    const BIG_SET = 5_000
    const SLOW_FLUSH_MS = 250
    const scheduleFlush = (): void => {
      if (scheduled) return
      scheduled = true
      if (sortedRef.current.length > BIG_SET) window.setTimeout(flush, SLOW_FLUSH_MS)
      else requestAnimationFrame(flush)
    }
    // Spec 033 (research R10): every live row is admitted by the persistence
    // layer, over the shared filter and the housekeeping rule, so the rows
    // drawn live are the rows the pages would have returned. The renderer's
    // own housekeeping check is gone: HOUSEKEEPING_SQL is the one rule.
    const admit = async (batch: RedLogEvent[]): Promise<void> => {
      const gen = generationRef.current
      const admitted = new Set<string>()
      for (let i = 0; i < batch.length; i += MATCH_CHUNK) {
        const ids = batch.slice(i, i + MATCH_CHUNK).map((e) => e.id)
        const hit = await window.redlog.events.matchIds({ ids, filter: eventFilterRef.current, excludeHousekeeping: true })
        for (const id of hit) admitted.add(id)
      }
      if (gen !== generationRef.current) return
      let added = 0
      for (const e of batch) {
        if (!admitted.has(e.id)) continue
        // Same id arriving again is either a duplicate broadcast (both channels
        // fire) or an updated payload. Overwrite the map entry but leave the
        // sorted array position alone — id-based sort tiebreak keeps it stable.
        if (!eventsMapRef.current.has(e.id)) {
          added++
          binarySearchInsert(sortedRef.current, e)
        }
        eventsMapRef.current.set(e.id, e)
      }
      setLiveError(null)
      if (added === 0) return
      // Each admitted row is one more of M, so N never passes M.
      if (totalRef.current.state === 'ok') {
        setTotal({ state: 'ok', value: totalRef.current.value + added })
      } else if (totalRef.current.state === 'pending') {
        recountRef.current = true
      }
      scheduleFlush()
    }
    admitLiveRef.current = admit
    const unsubBatch = window.redlog.events.onNewBatch((batch) => {
      if (!batch.length) return
      admit(batch).catch(() => setLiveError({ ids: batch }))
    })
    return () => {
      unsubBatch()
    }
  }, [])

  const { timeStart, timeEnd, ticks } = useMemo(() => computeDomainBounds(events), [events])


  const baseTrackW = Math.max(MIN_BASE_TRACK_W, containerW - LABEL_W)
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
  const timeMap = useMemo<TimeMap>(() => buildTimeMap({
    displayTimestamps: events.map(displayTs),
    timeStart, timeEnd, timeSpan, trackW: TRACK_W,
    compressGaps, gapMinMs: GAP_MIN_MS, gapPx: GAP_PX
  }), [compressGaps, events, timeStart, timeEnd, timeSpan, TRACK_W])

  const toX = useCallback((ts: number) => timeMap.toX(ts), [timeMap])
  const fromX = useCallback((px: number) => timeMap.fromX(px), [timeMap])

  const totalH = visibleRows.length * laneH

  const laneEvents = useMemo(
    () => distributeLaneEvents(events, pluginTypes),
    [events, pluginTypes]
  )

  const rowEvents = useMemo(
    () => distributeRowEvents(events, visibleRows, collapsedBands, pluginTypes),
    [events, visibleRows, collapsedBands, pluginTypes]
  )

  // Debounced so a held key or a fast typist does not run the scan per
  // character. 120 ms sits below the point where the filter feels laggy and
  // above a burst of keystrokes.
  const [filterQueryDebounced, setFilterQueryDebounced] = useState(filterQuery)
  useEffect(() => {
    const id = window.setTimeout(() => setFilterQueryDebounced(filterQuery), 120)
    return () => window.clearTimeout(id)
  }, [filterQuery])

  // v0.6.89.5: reverse-effects index (feature 1) — `effectsById[causeId] =
  // [effectEventId, ...]`. Built once per events change; O(N × avg-causes).
  // Also the badges index (feature 3) so every dot render is O(1). The
  // broken-at id from the last full verify (feature 5) participates in the
  // badge set so the `⛓️‍💥` badge lights up on the offending row.
  // v0.6.91 W1: filter-match set for the `/` search. Case-insensitive substring
  // over any of: data.command / data.url / data.host / data.title / data.subtype,
  // eventTitle (which is what the operator actually sees), and operatorId.
  //
  // (The original note here said this was "cheap for <= 5k events" and that
  // the dim path dominated for larger sets. Measured at 131,833: the index
  // build is 126 ms and dominates everything else on the panel. Hence the
  // early return below.)
  // v0.9.8: the searchable text is built once per event set, not once per
  // keystroke. This used to allocate a nine-element array, join it, lowercase
  // it and call eventTitle() (which slices and replaces) for EVERY event on
  // EVERY character typed — the memo listed `filterQuery` in its deps, so a
  // 100k-event engagement redid all of that between keypresses. Now typing
  // only walks an array of prebuilt strings.
  const searchIndex = useMemo(
    () => buildSearchIndex(events, operatorNames, filterQueryDebounced),
    [events, operatorNames, filterQueryDebounced]
  )


  const filterMatches = useMemo(
    () => computeFilterMatches(searchIndex, filterQueryDebounced),
    [searchIndex, filterQueryDebounced]
  )

  const targetMatches = useMemo(
    () => computeTargetMatches(events, effectiveTarget),
    [events, effectiveTarget]
  )


  const brokenAtId = verifyDismissed ? null : (verifyResult?.brokenAtEventId ?? null)
  const effectsById = useMemo(() => buildEffectsIndex(events), [events])
  // ── What each marker says now (design turn 8b) ─────────────────────────
  //
  // TDZ contract, and it is not theoretical — the e2e has caught this exact
  // mistake twice in this file (see the `collapsedBands` note above). A hook's
  // dependency array evaluates during render, so nothing ABOVE this point may
  // name `foldById` or `titleOf`; every consumer is below. `searchIndex` sits
  // higher and deliberately does its own inline pass instead.
  //
  // One walk of `events`, whose body is a type test — the marker lane is a
  // rounding error next to a scan's traffic, and this memo runs on every flush.
  const foldById = useMemo(() => buildFoldIndex(events), [events])

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
    if (!fold) return eventTitle(e, t)
    return `${fold.effective.severity.toUpperCase()}: ${fold.effective.title}`
  }, [foldById, t])

  // The hover suffix that says a finding has been corrected. Empty for
  // everything else, so it composes into an existing title without a branch.
  const amendSuffix = useCallback((e: RedLogEvent): string => {
    const fold = foldById.get(e.id)
    return fold ? ` · ${t('marker.amendedTimes', { count: fold.amendCount })}` : ''
  }, [foldById, t])

  // Which violations no longer stand. Both are read from the rows themselves —
  // a `scope_cleared` naming one, or a newer violation covering the same source
  // event — so a withdrawn violation looks withdrawn on the track without the
  // original row being touched. Same slot and same TDZ contract as the fold
  // memos above: nothing higher may name these.
  const violationStanding = useMemo(() => computeViolationStanding(events), [events])

  const badgesById = useMemo(
    () => buildBadgeIndex(events, brokenAtId, violationStanding.cleared, violationStanding.superseded),
    [events, brokenAtId, violationStanding]
  )
  const anomalyCount = badgesById.size

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
      // join the drawn range (spec 033 FR-004).
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

  // Mutual exclusion: enabling focus chain implicitly turns anomaly filter off,
  // and vice versa. Done here (rather than at each toggle site) so keyboard
  // shortcuts and clicks stay in sync. Extended in v0.6.91 W1: enabling either
  // also clears the `/` filter query, since three overlapping dim modes are
  // impossible to reason about.
  useEffect(() => {
    if (!focusChain) return
    if (anomalyFilter) setAnomalyFilter(false)
    if (filterQuery) setFilterQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusChain])
  useEffect(() => {
    if (!anomalyFilter) return
    if (focusAnchorId) setFocusAnchorId(null)
    if (filterQuery) setFilterQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anomalyFilter])

  // v0.6.91 S4: persist zoom, hidden lanes, and selected-event id so a
  // Timeline reload lands the operator back where they were.
  useEffect(() => {
    try { localStorage.setItem('redlog-timeline-zoom', String(zoom)) } catch { /* ignore */ }
  }, [zoom])
  useEffect(() => {
    // v0.6.99 A: hidden-lanes is per-project. An operator who solo'd "shell"
    // for triage on Project A shouldn't carry that into Project B's fresh
    // open. Zoom right below stays global — it's a UI density preference,
    // not project state.
    if (!projectIdForKeys) return
    try {
      localStorage.setItem(`redlog-timeline-hidden-lanes:${projectIdForKeys}`, JSON.stringify([...hiddenLanes]))
      localStorage.setItem(`redlog-timeline-collapsed-bands:${projectIdForKeys}`, JSON.stringify([...collapsedBands]))
    } catch { /* ignore */ }
  }, [hiddenLanes, collapsedBands, projectIdForKeys])
  useEffect(() => {
    try {
      if (selectedEvent?.id) localStorage.setItem('redlog-timeline-focus-event', selectedEvent.id)
      else localStorage.removeItem('redlog-timeline-focus-event')
    } catch { /* ignore */ }
  }, [selectedEvent])
  // On first successful load, if no explicit prop-driven focus is in play,
  // restore the previously-selected event by id. Bail after one attempt so we
  // don't fight the operator's later clicks.
  const initialFocusRestoreRef = useRef(false)
  useEffect(() => {
    if (initialFocusRestoreRef.current) return
    if (loading || events.length === 0) return
    initialFocusRestoreRef.current = true
    if (focusEventId || focusTs || selectedEvent) return
    try {
      const id = localStorage.getItem('redlog-timeline-focus-event')
      if (!id) return
      const evt = eventsMapRef.current.get(id)
      if (evt) { setSelectedEvent(evt); setDetailOpen(true) }
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
  const maxZoom = useMemo(() => computeMaxZoom({
    // Per-lane ascending display timestamps — markers sort by their `atTimestamp`.
    laneTimestamps: LANES.map((lane) => laneEvents[lane].map(displayTs)),
    timeSpan,
    clusterPx: CLUSTER_PX,
    maxTrackW: MAX_TRACK_W,
    minBaseTrackW: MIN_BASE_TRACK_W
  }), [laneEvents, timeSpan])
  // The wheel handler is bound once and reads this through a ref rather than
  // re-binding on every density change.
  const maxZoomRef = useRef(maxZoom)
  useEffect(() => { maxZoomRef.current = maxZoom }, [maxZoom])
  const clusters = useMemo(
    () => buildClusters(visibleRows, rowEvents, toX, laneH, CLUSTER_PX, pluginTypes),
    [visibleRows, rowEvents, toX, laneH, pluginTypes]
  )

  const sessionBands = useMemo<SessionBand[]>(() => {
    if (!sessionDividers) return []
    return buildSessionBands(events, toX, {
      termLabel: (id) => t('timeline.boundaries.termLabelFmt', { id }),
      pausedLabel: t('timeline.boundaries.pausedLabel')
    }, timeEnd)
  }, [events, sessionDividers, toX, t, timeEnd])

  // Density minimap: event counts over the full range, binned into fixed cells.
  const bins = useMemo(() => computeBins(events.map(displayTs), timeStart, timeEnd), [events, timeStart, timeEnd])

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
  const visibleClusters = useMemo(
    () => filterVisibleClusters(clusters, TRACK_W, view.left, view.width),
    [clusters, view.left, view.width, TRACK_W]
  )

  const updateView = useCallback(() => {
    const el = scrollRef.current
    if (!el || TRACK_W <= 0) return
    setView({ left: (el.scrollLeft / TRACK_W) * 100, width: Math.min(100, (el.clientWidth / TRACK_W) * 100) })
    // v0.6.91 W2: track "am I at the right edge" so the follow badge can flip
    // between LIVE and behind. 10px slop covers scrollbar rounding and pixel
    // snapping across DPRs.
    setAtRightEdge(el.scrollLeft + el.clientWidth >= TRACK_W - 10)
    // Auto-load-more when scrolled to the earliest edge (audit #3). Was
    // click-driven with a "load more" chip; users hitting the left edge with
    // more history to pull would just see empty space and not realise there
    // was a button.
    if (hasMore && !loading && el.scrollLeft < 80) loadMore()
  }, [TRACK_W, hasMore, loading, loadMore])

  // v0.6.91 W2: follow mode auto-scroll. When enabled AND the operator was
  // at the right edge, snap to the new right edge whenever fresh events land
  // (or the track's virtual width grows). We piggyback on `events` changing
  // rather than the onNew callback so a batch of events arriving in the same
  // frame only produces one scroll write.
  useEffect(() => {
    if (!followMode || !atRightEdge) return
    const el = scrollRef.current
    if (!el || TRACK_W <= 0) return
    el.scrollLeft = Math.max(0, TRACK_W - el.clientWidth)
  }, [events, followMode, atRightEdge, TRACK_W])

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
        setZoom(Math.max(0.25, Math.min(maxZoomRef.current, el.clientWidth / (baseTrackW * frac))))
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

  const recentEvents = useMemo(
    () => computeRecentEvents(events, hiddenLanes, pluginTypes, vp),
    [events, hiddenLanes, pluginTypes, vp]
  )

  const sliceCount = useMemo(() => computeSliceCount(events, vp), [events, vp])
  const sliceExportRequest = useMemo<ExportRequest>(() => ({
    format: 'timeline',
    subset: {
      kind: 'time-range',
      since: Math.round(fromX((view.left / 100) * TRACK_W)),
      before: Math.round(fromX(((view.left + view.width) / 100) * TRACK_W))
    }
  }), [fromX, view.left, view.width, TRACK_W])

  // FR-016: the export is the time range, every event in it. While the shared
  // filter hides some of them here, the label says the filter is not applied,
  // and the drawn count is not offered as the export's size.
  useContributeExport(
    events.length > 0
      ? filterActiveCount > 0
        ? { label: t('timeline.exportSliceUnfiltered'), request: sliceExportRequest }
        : { label: t('timeline.exportSlice'), request: sliceExportRequest, count: sliceCount }
      : null
  )

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
        setZoom((prev) => Math.min(maxZoomRef.current, Math.max(0.25, prev * Math.exp(-e.deltaY * 0.002))))
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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    // Bug: this ran on every mousedown INSIDE the scroll track, including a
    // mousedown that started a click on the cluster popup. It would close
    // the popup + start drag before the popup <button>'s onClick had a
    // chance to fire — the operator saw "click a row in the popup, popup
    // closes, nothing happens" instead of the intended jump.
    // Fix: bail if the mousedown target is inside the cluster popup.
    const target = e.target as HTMLElement | null
    if (target?.closest('[data-timeline-popup]')) return
    setCluster(null)
    isDragging.current = true
    dragStart.current = { x: e.clientX, scroll: scrollRef.current?.scrollLeft ?? 0 }
    document.body.classList.add('timeline-grabbing')
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!isDragging.current || !scrollRef.current) return
      const dx = e.clientX - dragStart.current.x
      scrollRef.current.scrollLeft = dragStart.current.scroll - dx
    }
    const onUp = (): void => {
      isDragging.current = false
      document.body.classList.remove('timeline-grabbing')
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  // On open, jump the viewport to the present so the newest activity is in view
  // rather than the oldest. Runs once, after the first events have loaded and the
  // track has a real width. Manual pan/zoom afterwards is left untouched.
  // Reset the "already scrolled" flag whenever the caller changes what we
  // should scroll to. Prior behaviour set the ref once at first-open and
  // never cleared it — so a second click on a Loot item (after coming back
  // to Timeline) would silently short-circuit (audit finding P0 #7).
  useEffect(() => { didScrollToNow.current = false }, [focusEventId, focusTs])

  useEffect(() => {
    if (loading || didScrollToNow.current) return
    const el = scrollRef.current
    if (!el || el.clientWidth === 0) return
    // Jumping from Loot (or elsewhere) focuses a specific event: select it and
    // centre it. Otherwise land on the present, latest activity in view.
    const focused = focusEventId ? events.find((e) => e.id === focusEventId) : null
    if (focused) {
      setSelectedEvent(focused)
      setDetailOpen(true)
      el.scrollLeft = Math.max(0, Math.min(toX(focused.timestamp) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    } else if (focusTs) {
      // no matching event (e.g. jumped from a bookmark) — centre on its time
      el.scrollLeft = Math.max(0, Math.min(toX(focusTs) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    } else {
      el.scrollLeft = Math.max(0, Math.min(toX(Date.now()) - el.clientWidth + 80, TRACK_W - el.clientWidth))
    }
    didScrollToNow.current = true
  }, [loading, toX, TRACK_W, focusEventId, focusTs, events])

  // After a cursor-anchored zoom re-renders with the new TRACK_W, restore the
  // scroll so the timestamp that was under the pointer stays under the pointer.
  useLayoutEffect(() => {
    const a = pendingZoomAnchor.current
    const el = scrollRef.current
    if (!a || !el) return
    pendingZoomAnchor.current = null
    el.scrollLeft = a.frac * TRACK_W - a.cursorX
  }, [TRACK_W])

  // After a minimap drag-to-zoom re-renders, place the selected window at the
  // left edge; then refresh the viewport indicator whenever the track resizes.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pendingView.current) {
      const { t0 } = pendingView.current
      pendingView.current = null
      const span = (timeEnd - timeStart) || 1
      el.scrollLeft = Math.max(0, Math.min(((t0 - timeStart) / span) * TRACK_W, TRACK_W - el.clientWidth))
    }
    // Cluster-item click scheduled a center-scroll for after zoom re-render.
    if (el && pendingCenterTs.current !== null) {
      const ts = pendingCenterTs.current
      pendingCenterTs.current = null
      el.scrollLeft = Math.max(0, Math.min(toX(ts) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    }
    updateView()
    // v0.11.6 (V7): `timeMap` is in the deps because toggling gap compression
    // changes the ts→px mapping without changing TRACK_W. Without it the
    // scroll position stays put while everything under it moves, which lands
    // the operator on empty track.
  }, [TRACK_W, timeMap, updateView, timeStart, timeEnd, loading])

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
  const showAllLanes = useCallback(() => setHiddenLanes(new Set()), [])

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
      const el = e.target as HTMLElement | null
      const tag = el?.tagName?.toLowerCase()
      const inField = tag === 'input' || tag === 'textarea' || !!el?.isContentEditable
      const action = resolveTimelineKey(e, {
        inField,
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
          e.preventDefault()
          setDetailOpen((v) => !v)
          break
        case 'nav-prev':
        case 'nav-next':
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
          if (next) setSelectedEvent(next)
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
            : Math.min(maxZoomRef.current, Math.max(0.25, prev * (action === 'zoom-in' ? 1.4 : 1 / 1.4))))
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
      // drawn: the track holds admitted rows only (spec 033 FR-004).
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

  // Nothing admitted by the filter is not the same as an empty project: say
  // which conditions are narrowing it.
  if (events.length === 0 && filterActiveCount > 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div data-testid="timeline-empty-filtered" className="flex flex-col items-center gap-2 text-center px-8">
          <p className="text-sm text-redlog-text-dim">{t('timeline.emptyFiltered')}</p>
          <ul className="text-xs text-redlog-text-faint font-mono">
            {describeActiveConditions(sharedFilter, t).map((label) => <li key={label}>{label}</li>)}
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
          <p className="text-xs text-redlog-muted">{t('timeline.noEventsDesc')}</p>
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
      {verifyResult && verifyResult.brokenAtEventId && !verifyDismissed && (
        <div
          data-testid="timeline-broken-chain-banner"
          className="flex items-center gap-2 px-4 py-1.5 border-b border-red-800 bg-red-950/50 text-xs shrink-0"
        >
          <span className="text-red-300 font-mono">
            {t('timeline.brokenChain.banner', {
              brokenAtId: verifyResult.brokenAtEventId.slice(0, 8),
              walked: String(verifyResult.walked ?? 0)
            })}
          </span>
          <button
            onClick={() => setVerifyDismissed(true)}
            className="ml-auto text-xs text-red-300 hover:text-red-100 px-1.5 py-0.5 rounded bg-red-900/40 hover:bg-red-900/60 transition-colors"
          >
            {t('timeline.brokenChain.dismiss')}
          </button>
        </div>
      )}
      <TimelineHelpModal open={showHelp} onClose={() => setShowHelp(false)} isMac={isMacPlatform} t={t} />
      {/* v0.6.89.5 feature 2: focus-chain badge (top-right). Only rendered
          while focus mode is active. Anchored on the wrapper so it floats
          above the minimap without shifting layout. */}
      {(focusChain || focusMeta.loading || focusMeta.failed) && (
        <div
          data-testid="timeline-focus-badge"
          className="absolute z-40 flex items-center gap-2 px-2 py-1 rounded-md border border-cyan-500/50 bg-redlog-bg/95 text-xs font-mono shadow-lg"
          style={{ top: 6, right: 8 }}
        >
          <span className="text-cyan-300">
            {focusMeta.loading
              ? t('timeline.focusChain.loading')
              : focusMeta.failed
                ? t('timeline.focusChain.failed')
                : t('timeline.focusChain.badge', { count: focusChain?.size ?? 0 })}
            {!focusMeta.loading && !focusMeta.failed && focusMeta.unavailable > 0
              ? ` · ${t('timeline.focusChain.unavailable', { count: focusMeta.unavailable })}`
              : ''}
            {!focusMeta.loading && !focusMeta.failed && focusMeta.truncated
              ? ` · ${t('timeline.focusChain.truncated')}`
              : ''}
            {!focusMeta.loading && !focusMeta.failed && (focusMeta.excluded ?? 0) > 0
              ? ` · ${t('timeline.focusChain.outsideFilter', { count: focusMeta.excluded ?? 0 })}`
              : ''}
          </span>
          <button
            onClick={() => setFocusAnchorId(null)}
            className="text-redlog-text-dim hover:text-redlog-text leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-white/10"
            title={t('timeline.focusChain.exit')}
            aria-label={t('timeline.focusChain.exit')}
          >×</button>
        </div>
      )}
      {effectiveTarget && (
        <div
          data-testid="timeline-target-focus-badge"
          className="absolute z-40 flex items-center gap-2 px-2 py-1 rounded-md border border-redlog-accent/50 bg-redlog-bg/95 text-xs font-mono shadow-lg"
          style={{ top: (focusChain || focusMeta.loading || focusMeta.failed) ? 36 : 6, right: 8 }}
        >
          <span className="text-redlog-accent">
            {t('timeline.targetFocus.badge', { target: effectiveTarget, count: targetMatches?.size ?? 0 })}
          </span>
          <button
            onClick={() => { setTargetFocus(null) }}
            className="text-redlog-text-dim hover:text-redlog-text leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-white/10"
            title={t('timeline.targetFocus.exit')}
            aria-label={t('timeline.targetFocus.exit')}
          >×</button>
        </div>
      )}
      {/* Header. `flex-wrap` so that on a narrow window the controls drop to
          a second row instead of squeezing: without it the title broke into
          three lines and the lane chips on the right were clipped at 1440px,
          which is a common laptop width. Title and count never shrink. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 border-b border-redlog-border/80 shrink-0">
        <span className="text-xs font-semibold text-redlog-text tracking-wide shrink-0 whitespace-nowrap">{t('timeline.title')}</span>
        {/* FR-003: while older admitted rows exist, the line says how many
            are drawn of how many there are. N counts the rows held, M the
            rows the same filter admits; a total that failed says so. */}
        <span data-testid="timeline-range-status" className="text-xs text-redlog-text-faint font-mono tabular-nums shrink-0 whitespace-nowrap">
          {!hasMore
            ? t('timeline.events', { count: rawEvents.length })
            : total.state === 'ok'
              ? t('timeline.rangeOfTotal', { shown: rawEvents.length, total: total.value })
              : total.state === 'pending'
                ? t('timeline.rangeTotalPending', { shown: rawEvents.length })
                : (
                  <>
                    {t('timeline.totalUnavailable', { shown: rawEvents.length })}{' '}
                    <button
                      data-testid="timeline-total-retry"
                      onClick={() => requestTotal(generationRef.current)}
                      className="underline hover:text-redlog-text"
                    >{t('common.retry')}</button>
                  </>
                )}
        </span>
        {hasMore && (
          <button onClick={loadMore} className="text-xs text-redlog-text-faint hover:text-redlog-text ml-1 transition-colors">
            {t('timeline.loadMore')}
          </button>
        )}

        {/* v0.9.3 U2: keyboard-shortcut cheatsheet button. Every hotkey we
            shipped (⌘K palette, `/` search, `f` focus chain, right-click
            drop-marker, Alt-click solo, etc.) was invisible without prior
            knowledge — Design-review agent graded discoverability F. This
            makes the affordance visible; the modal itself lists everything. */}
        <button
          onClick={() => setShowHelp(true)}
          className="ml-1 w-5 h-5 flex items-center justify-center text-xs text-redlog-text-dim hover:text-redlog-text bg-redlog-elevated/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
          title={t('timeline.help.hint')}
          aria-label={t('timeline.help.hint')}
        >?</button>

        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            className="w-5 h-5 flex items-center justify-center text-xs text-redlog-text-dim hover:text-redlog-text bg-redlog-elevated/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            title={t('timeline.zoomOut')}
            aria-label={t('timeline.zoomOut')}
          >−</button>
          <button
            onClick={() => setZoom(1)}
            disabled={Math.abs(zoom - 1) < 0.01}
            className="px-1.5 h-5 flex items-center justify-center text-xs text-redlog-text-faint hover:text-redlog-text bg-redlog-elevated/50 rounded font-mono tabular-nums transition-colors disabled:cursor-default disabled:hover:text-redlog-text-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            title={t('timeline.resetZoom')}
            aria-label={t('timeline.resetZoom')}
          >{Math.round(zoom * 100)}% ↺</button>
          <button
            onClick={() => setZoom((z) => Math.min(maxZoom, z + 0.25))}
            className="w-5 h-5 flex items-center justify-center text-xs text-redlog-text-dim hover:text-redlog-text bg-redlog-elevated/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            title={t('timeline.zoomIn')}
            aria-label={t('timeline.zoomIn')}
          >+</button>
        </div>

        {/* v0.6.91 W1: inline `/` filter. Always visible in the header so
            operators can see there's a text filter (previously discoverable
            only by shortcut). Icon prefix + clear button on the right. */}
        <div className="relative flex items-center ml-2">
          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-redlog-text-faint pointer-events-none font-mono">/</span>
          <input
            ref={searchInputRef}
            data-testid="timeline-search-input"
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                if (filterQuery) { setFilterQuery(''); e.preventDefault() }
                else searchInputRef.current?.blur()
              }
            }}
            placeholder={t('timeline.search.placeholder')}
            title={t('timeline.search.hint')}
            className="pl-5 pr-6 py-0.5 h-6 w-[220px] text-xs font-mono bg-redlog-surface/70 border border-redlog-border rounded text-redlog-text placeholder:text-redlog-text-faint focus:outline-none focus:border-redlog-border"
          />
          {filterQuery && (
            <button
              onClick={() => setFilterQuery('')}
              title={t('timeline.search.clear')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-redlog-text-dim hover:text-redlog-text leading-none w-4 h-4 flex items-center justify-center rounded hover:bg-white/10"
            >×</button>
          )}
        </div>

        {/* §27.1: merged LIVE/behind toggle. One button: ● 即時 when live,
            ⏸ 落後 N 分 when behind. Click toggles follow; when resuming from
            behind, also snaps to now. */}
        {(() => {
          const latestTs = events.length > 0 ? events[events.length - 1].timestamp : 0
          const behindMs = Math.max(0, now - latestTs)
          const isLive = atRightEdge && followMode
          const label = isLive
            ? t('timeline.follow.live')
            : t('timeline.follow.behindFmt', { time: formatBehind(behindMs) })
          return (
            <button
              data-testid="timeline-follow-badge"
              onClick={() => {
                if (isLive) {
                  setFollowMode(false)
                } else {
                  const el = scrollRef.current
                  if (el && TRACK_W > 0) el.scrollLeft = Math.max(0, TRACK_W - el.clientWidth)
                  setFollowMode(true)
                }
              }}
              title={isLive ? t('timeline.follow.pauseHint') : t('timeline.follow.resumeHint')}
              className={`whitespace-nowrap text-xs font-mono px-1.5 py-0.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 ${
                isLive
                  ? 'text-emerald-100 bg-emerald-600/40 ring-1 ring-emerald-500/40'
                  : 'text-amber-300 bg-amber-500/10 hover:bg-amber-500/20'
              }`}
            >{label}</button>
          )
        })()}

        {/* Lane filter toggles — click toggles; Alt/Option-click solos the
            lane (hides every other populated lane); solo'd-lane Alt-click
            again shows all. Audit finding #4.
            `overflow-x-auto` + `min-w-0` + `flex-nowrap` means when the
            header narrows the chips scroll horizontally instead of wrapping
            onto a second row — reported when running at 1280 wide with the
            full lane list open. */}
        <div className="ml-auto flex flex-nowrap gap-1 items-center overflow-x-auto min-w-0">
          {/* v0.6.89.5 feature 4: anomaly filter (§27.1: renamed 鏈警示) — dims every event without an
              integrity badge (clock anomaly / recovery / evidence removal /
              anchor failure / chain break). First chip so it's the fastest
              thing to reach when a verify caught something. Disabled at
              opacity 0.25 when there's nothing to filter. Mutually exclusive
              with focus-chain mode (both use dim opacity 0.15). */}
          <button
            data-testid="timeline-anomaly-chip"
            onClick={() => {
              if (anomalyCount === 0) return
              setAnomalyFilter((v) => !v)
            }}
            disabled={anomalyCount === 0}
            className={`shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 ${
              anomalyCount === 0
                ? 'opacity-25 cursor-default text-redlog-text-faint'
                : anomalyFilter
                  ? 'text-amber-200 bg-amber-500/25 ring-1 ring-amber-500/40'
                  : 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20'
            }`}
            title={anomalyCount === 0 ? t('timeline.anomalies.tooltip') : t('timeline.anomalies.tooltip')}
          >
            {t('timeline.anomalies.chip', { count: anomalyCount })}
          </button>
          {/* §27.1: More menu — 隱藏 AI 逐輪, 略過閒置, 工作階段邊界, 稽核檢視, 時區 */}
          <div className="relative shrink-0">
            <button
              data-testid="timeline-more-menu"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              title={t('timeline.more.hint')}
              className="whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
            >⋯ {t('timeline.more.button')}</button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
                <div role="menu" className="absolute top-full right-0 mt-1 z-40 w-56 rounded border border-redlog-border bg-redlog-surface/95 shadow-xl py-1">
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
                    <span className={sessionDividers ? 'text-indigo-300' : 'text-redlog-text-faint'}>{sessionDividers ? '✓' : ''}</span>
                  </button>
                  <button
                    role="menuitemcheckbox"
                    data-testid="timeline-auditor-view-chip"
                    aria-checked={auditorView}
                    disabled={hiddenLoggedCount === 0 && !auditorView}
                    onClick={() => { if (hiddenLoggedCount === 0 && !auditorView) return; setAuditorView((v) => !v) }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono text-redlog-text hover:bg-white/5 disabled:opacity-40 disabled:cursor-default"
                    title={t('timeline.auditorView.tooltip')}
                  >
                    <span>{t('timeline.auditorView.chip', { count: hiddenLoggedCount })}</span>
                    <span className={auditorView ? 'text-emerald-300' : 'text-redlog-text-faint'}>{auditorView ? '✓' : ''}</span>
                  </button>
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <span className="text-xs font-mono text-redlog-text-dim">{t('timeline.tz.tooltip')}</span>
                    <select
                      data-testid="timeline-tz-select"
                      value={tz}
                      onChange={(e) => setTz(e.target.value as TzMode)}
                      className="ml-auto text-xs px-1 py-0.5 rounded font-mono bg-redlog-elevated/60 text-redlog-text border border-redlog-border focus:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
                    >
                      <option value="local">{t('timeline.tz.local')}</option>
                      <option value="utc">{t('timeline.tz.utc')}</option>
                      <option value="project" disabled={!projectTz}>{t('timeline.tz.project')}{projectTz ? ` (${projectTz})` : ''}</option>
                    </select>
                  </div>
                </div>
              </>
            )}
          </div>
          {hiddenLanes.size > 0 && (
            <button
              onClick={showAllLanes}
              className="shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
              title={t('timeline.showAllLanes')}
            >{t('timeline.showAll')}</button>
          )}
          {LANES.map((id) => {
            const empty = !populatedLanes.has(id)
            const hidden = hiddenLanes.has(id)
            const off = empty || hidden
            const externalOnly = EXTERNAL_ONLY_LANES.has(id)
            // A lane that has captured nothing is hidden from the chip row
            // rather than shown dimmed: an empty chip is noise, and the lane
            // reappears the instant a real event lands (populatedLanes shifts).
            // v0.6.97 did this only for external-only lanes (credential_use,
            // c2_checkin); v0.15 extends it to every not-yet-captured lane. A
            // populated lane the operator toggled OFF still renders (struck
            // through) so it can be restored — that's `hidden`, not `empty`.
            if (empty) return null
            return (
              <Fragment key={id}>
              <button
                onClick={(e) => { if (empty) return; if (e.altKey) soloLane(id, populatedLanes); else toggleLane(id) }}
                disabled={empty}
                className={`shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim ${
                  hidden ? 'opacity-30 line-through' : empty ? 'opacity-25 cursor-default' : ''
                }`}
                style={{
                  color: off ? '#6a6a74' : LANE_COLORS[id],
                  backgroundColor: off ? 'transparent' : `${LANE_COLORS[id]}10`
                }}
                title={empty
                  ? externalOnly ? t('timeline.laneExternalOnly', { lane: laneLabels[id] }) : t('timeline.laneEmpty', { lane: laneLabels[id] })
                  : t('timeline.laneChipHint', { lane: laneLabels[id] })}
              >
                {laneLabels[id]}
              </button>
              </Fragment>
            )
          })}
        </div>
      </div>

      {/* Spec 033: what the panel could not do, said where the operator is
          looking. A failed read is never shown as fewer rows (FR-010), and a
          row the filter excludes is never shown as if it matched (FR-004). */}
      {((loadError && rawEvents.length > 0) || liveError || outsideFilter) && (
        <div className="px-4 py-1 border-b border-redlog-border/80 flex flex-col gap-0.5 text-xs shrink-0">
          {loadError && rawEvents.length > 0 && (
            <div role="alert" data-testid="timeline-page-failed" className="text-red-300">
              {t('timeline.pageFailed')}{' '}
              <button onClick={loadMore} className="underline hover:text-red-200">{t('common.retry')}</button>
            </div>
          )}
          {liveError && (
            <div role="alert" data-testid="timeline-live-failed" className="text-amber-300">
              {t('timeline.liveAdmissionFailed')}{' '}
              <button
                onClick={() => {
                  const batch = liveError.ids
                  setLiveError(null)
                  if (batch.length > 0) void admitLiveRef.current(batch).catch(() => setLiveError({ ids: batch }))
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

      {/* Density minimap — overview of the whole engagement. Drag to zoom to a
          window, click to jump. The bright frame marks the current viewport. */}
      <div
        className="relative h-9 border-b border-redlog-border/80 bg-redlog-bg/40 cursor-crosshair select-none shrink-0"
        onMouseDown={onMinimapDown}
        title={t('timeline.minimapHint')}
      >
        <div className="absolute inset-0 flex items-end gap-px px-1 pb-0.5">
          {bins.counts.map((c, i) => (
            <div key={i} className="flex-1 rounded-sm bg-cyan-500/40" style={{ height: c ? `${18 + (c / bins.max) * 72}%` : '0%' }} />
          ))}
        </div>
        <div
          className="absolute inset-y-0 border-x-2 border-cyan-300/70 bg-cyan-300/10 pointer-events-none"
          style={{ left: `${view.left}%`, width: `${Math.max(1, view.width)}%` }}
        />
        {drag && (
          <div
            className="absolute inset-y-0 bg-white/15 border border-white/50 pointer-events-none"
            style={{ left: `${(Math.min(drag.x0, drag.x1) / drag.w) * 100}%`, width: `${(Math.abs(drag.x1 - drag.x0) / drag.w) * 100}%` }}
          />
        )}
      </div>

      {/* Timeline + event list split */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Swim lanes */}
        {/* v0.9.4 P0-2: scrolls vertically. The lane labels are a sibling of
            the track, so the overflow has to live on this shared parent —
            putting it on the track alone would slide the lanes out from
            under their labels. 18 lanes x the 36px floor overflows a 1080p
            window, and the old `overflow-hidden` clipped the tail of the
            stack (scope / process / system) with no scrollbar and no hint. */}
        <div ref={containerRef} className="flex-1 min-h-0 flex overflow-x-hidden overflow-y-auto">
          {/* Lane labels */}
          <div className="shrink-0 border-r border-redlog-border/60 bg-redlog-bg/50" style={{ width: LABEL_W }}>
            <div className="h-7 border-b border-redlog-border/60" />
            {visibleRows.map((rowKey) => {
              const band = BANDS.find((b) => b.id === rowKey)
              if (band) {
                // A collapsed band row: caret + name + how many of its lanes
                // have events, clickable to expand. Dots for its events render
                // in the track at this row, each keeping its lane colour.
                const popCount = band.lanes.filter((l) => populatedLanes.has(l)).length
                return (
                  <button
                    key={rowKey}
                    data-testid={`timeline-band-${rowKey}`}
                    onClick={() => toggleBand(band.id)}
                    className="w-full flex items-center gap-1.5 px-2 border-b border-redlog-border/30 font-mono text-xs text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:bg-white/[0.04]"
                    style={{ height: laneH }}
                    title={t('timeline.band.expandHint', { band: t(`timeline.band.${band.id}`) })}
                    aria-expanded={false}
                  >
                    <span className="text-redlog-text-faint w-2 shrink-0">▸</span>
                    <span title={t(`timeline.band.${band.id}`)} className="text-redlog-text truncate">{t(`timeline.band.${band.id}`)}</span>
                    <span className="text-redlog-text-faint tabular-nums ml-auto">{popCount}</span>
                  </button>
                )
              }
              const id = rowKey as LaneId
              // An expanded lane row: indented under its band, with a caret on
              // the band-owning first lane so the operator can collapse back.
              return (
                <div
                  key={rowKey}
                  className="group flex items-center gap-1.5 pl-4 pr-2 border-b border-redlog-border/30 font-mono text-xs"
                  style={{ height: laneH }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[id] }} />
                  <span title={laneLabels[id]} className="text-redlog-text-dim truncate">{laneLabels[id]}</span>
                  <button
                    onClick={() => toggleBand(BAND_OF[id])}
                    className="ml-auto opacity-0 group-hover:opacity-100 text-redlog-text-faint hover:text-redlog-text text-xs shrink-0"
                    title={t('timeline.band.collapseHint', { band: t(`timeline.band.${BAND_OF[id]}`) })}
                    aria-label={t('timeline.band.collapseHint', { band: t(`timeline.band.${BAND_OF[id]}`) })}
                  >▾</button>
                </div>
              )
            })}
          </div>

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
              const el = scrollRef.current
              if (!el || timeSpan <= 0) return
              const rect = el.getBoundingClientRect()
              const cursorX = e.clientX - rect.left
              const ts = fromX(el.scrollLeft + cursorX)
              const targetSpan = 10 * 60_000
              const next = Math.min(maxZoomRef.current, Math.max(0.25, (timeSpan / targetSpan)))
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
              <div className="h-7 border-b border-redlog-border/60 relative bg-redlog-bg/30">
                {ticks.map((ts, i) => (
                  <span
                    key={ts}
                    className="absolute text-xs text-redlog-text-faint font-mono tabular-nums -translate-x-1/2"
                    style={{ left: toX(ts), top: 6 }}
                  >
                    {/* v0.11.4 (AUDIT V6): a multi-day engagement showed several
                        identical "09:11" ticks with nothing to separate them. Once
                        the span crosses a day, the first tick and every tick that
                        lands on a new date carry the date too. */}
                    {axisLabel(ts, i, ticks, timeSpan, tz, projectTz)}
                  </span>
                ))}
              </div>

              {/* Lanes area */}
              <div style={{ height: totalH, position: 'relative' }}>
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
                          style={{ left: 2, top: b.row * 12, color: b.kind === 'paused' ? '#cbd5e1' : '#a5b4fc' }}
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
                {Date.now() >= timeStart && Date.now() <= timeEnd && (
                  <div className="absolute top-0 w-px bg-red-500/70" style={{ left: toX(Date.now()), height: totalH }} />
                )}
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
                  const dot = single
                    ? Math.round(9 * marks.scale)
                    : Math.min(24, 13 + Math.round(Math.log2(c.events.length) * 3))
                  const hit = Math.max(20, dot + 8)
                  // v0.6.89.5: filter dimming. Focus-chain and anomaly-filter
                  // are mutually exclusive (enforced by the effects above), so
                  // at most one of these is truthy at any time. A cluster is
                  // "active" (not dimmed) if ANY event in it is in the
                  // active set — so a 20-event burst that contains a chain
                  // link doesn't disappear.
                  // v0.6.91 W1: filter query joins focus-chain and anomaly-filter
                  // as the third dim mode. The three are mutually exclusive
                  // (enforced by the effects above), so at most one branch fires.
                  let dimmed = false
                  if (focusChain) {
                    dimmed = !c.events.some((e) => focusChain.has(e.id))
                  } else if (anomalyFilter) {
                    dimmed = !c.events.some((e) => badgesById.has(e.id))
                  } else if (targetMatches || filterMatches) {
                    // Compose: when target focus, text filter, or scope
                    // filter are active, a cluster stays lit only if it
                    // has an event satisfying all active conditions.
                    dimmed = !c.events.some((e) =>
                      (!targetMatches || targetMatches.has(e.id)) &&
                      (!filterMatches || filterMatches.has(e.id)))
                  }
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
                  const indent = single ? subagentIndentPx(evt) : 0
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
                  return (
                    <button
                      key={c.key}
                      type="button"
                      data-timeline-event
                      tabIndex={isTabStop ? 0 : -1}
                      aria-label={single
                        ? `${formatTs(evt.timestamp, tz, projectTz, 'timeSec')} ${titleOf(evt)}${shapeTitle(evt, t, foldById.get(evt.id)?.effective.severity)}${amendSuffix(evt)}`
                        : t('timeline.events', { count: c.events.length })}
                      aria-pressed={sel || undefined}
                      className="absolute cursor-pointer flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 rounded"
                      style={{
                        left: c.x - hit / 2 + indent,
                        top: c.y - hit / 2,
                        width: hit,
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
                        ? `${formatTs(evt.timestamp, tz, projectTz, 'timeSec')} — ${titleOf(evt)}${badgeTitle}${shapeTitle(evt, t, foldById.get(evt.id)?.effective.severity)}${amendSuffix(evt)}${ioTitle(ioMark(evt), t)}`
                        : `${c.events.length} ${t('timeline.title')} · ${formatTs(c.events[0].timestamp, tz, projectTz, 'timeSec')}`}
                      onMouseEnter={() => { if (single) hoveredEventRef.current = evt }}
                      onMouseLeave={() => { if (single && hoveredEventRef.current === evt) hoveredEventRef.current = null }}
                      onClick={() => single ? (sel ? (setSelectedEvent(null), setDetailOpen(false)) : (setSelectedEvent(evt), setDetailOpen(true))) : setCluster({ x: c.x, y: c.y, events: c.events })}
                    >
                      <div
                        className={dimmed ? 'flex items-center justify-center' : 'flex items-center justify-center transition-transform hover:scale-125'}
                        style={{
                          width: dot, height: dot,
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
                        {!single && <span style={{ fontSize: 9, fontWeight: 800, color: 'rgba(0,0,0,0.78)', lineHeight: 1 }}>{c.events.length}</span>}
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
                                  left: hit / 2 + dot / 2 - 3, top: hit / 2 + dot / 2 - 3,
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
                {/* Cluster contents popover */}
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
                  // Viewport-relative clamp: previous impl clamped only to TRACK_W,
                  // so a popover on a wide-zoom track near the right of the visible
                  // scroll port drew off-screen. Clamp against the visible window
                  // (scrollLeft + clientWidth) instead.
                  const el = scrollRef.current
                  const visLeft = el ? el.scrollLeft : 0
                  const visRight = el ? el.scrollLeft + el.clientWidth : TRACK_W
                  const rawLeft = cluster.x + 10
                  const left = Math.max(visLeft + 4, Math.min(rawLeft, visRight - POPUP_W - 4))
                  const top = cluster.y + 12 + POPUP_MAX_H > totalH
                    ? Math.max(0, cluster.y - POPUP_MAX_H - 4)
                    : cluster.y + 12
                  return (
                  <div className="absolute z-30" data-timeline-popup style={{ left, top, width: POPUP_W }}>
                    <div className="rounded-md border border-redlog-border bg-redlog-surface/95 shadow-xl max-h-[210px] overflow-y-auto">
                      <div className="flex items-center justify-between px-2 py-1 border-b border-redlog-border sticky top-0 bg-redlog-surface/95">
                        <span className="text-xs text-redlog-text-dim font-mono">{cluster.events.length} {t('timeline.title')}</span>
                        <button className="text-redlog-text-dim hover:text-redlog-text text-xs leading-none" onClick={() => setCluster(null)}>×</button>
                      </div>
                      {capped.map((evt) => (
                        <button
                          key={evt.id}
                          className="w-full text-left px-2 py-1 hover:bg-white/5 flex items-center gap-2"
                          onClick={() => {
                            setSelectedEvent(evt)
                            setDetailOpen(true)
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
                          <span className="text-redlog-text-faint font-mono text-xs tabular-nums shrink-0">{formatTs(evt.timestamp, tz, projectTz, 'timeSec')}</span>
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
              </div>
            </div>
          </div>
        </div>

        {/* Event log — bottom panel. Sized in vh (was hardcoded 160/180 px)
            so the +1-step hint font from v0.6.56 doesn't push rows off the
            bottom, and so the panel scales with window height. Values chosen
            so the list shows ~5 rows at 900 px tall and ~8 at 1200 px. */}
        <div className="shrink-0 border-t border-redlog-border/60 bg-redlog-bg/50" style={{ height: selectedEvent ? '18vh' : '22vh' }}>
          <div className="px-3 py-1.5 border-b border-redlog-border/40 flex items-center justify-between">
            <span className="text-xs text-redlog-text-dim font-mono uppercase tracking-wider">{t('timeline.title')}</span>
            <span className="text-xs text-redlog-text-faint font-mono tabular-nums">{recentEvents.length}</span>
          </div>
          <div className="overflow-y-auto" style={{ height: `calc(${selectedEvent && detailOpen ? '18vh' : '22vh'} - 32px)` }}>
            {recentEvents.map((evt) => {
              const lane = toLane(evt.agentType, evt.data?.subtype as string | undefined, pluginTypes)
              const isSel = selectedEvent?.id === evt.id
              return (
                <div
                  key={evt.id}
                  className={`flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors text-xs border-b border-redlog-border-subtle/30 ${
                    isSel ? 'bg-redlog-elevated/50' : 'hover:bg-redlog-elevated/20'
                  }`}
                  onClick={() => { if (isSel) { setSelectedEvent(null); setDetailOpen(false) } else { setSelectedEvent(evt); setDetailOpen(true) } }}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[lane] }} />
                  <span className="text-redlog-text-faint font-mono tabular-nums shrink-0 w-16">
                    {formatTs(evt.timestamp, tz, projectTz, 'timeSec')}
                  </span>
                  {/* v0.14 §9.1: per-row tier badge. Icon-only in the row so
                   *  the visual density stays low — the full labeled version
                   *  lives in the detail panel. Reviewer scanning the
                   *  timeline can now spot chained-vs-logged at a glance
                   *  instead of clicking each row to check. */}
                  <TierBadge tier={evt.tier} variant="row" />
                  {showOperator && (
                    <span className="text-redlog-text-dim font-mono shrink-0 max-w-[80px] truncate" title={evt.operatorId}>
                      {operatorLabel(evt.operatorId)}
                    </span>
                  )}
                  <span title={`${titleOf(evt)}${amendSuffix(evt)}`} className="text-redlog-text-dim truncate">{titleOf(evt)}</span>
                  {/* Rendered only for a marker that HAS been corrected (§22:
                      a noun does not appear before its data exists) — most
                      markers never are, and the row is already dense. Never
                      truncated: a count that reads 「已修訂 1…」 is worse than no
                      count, and never in danger red, which would make an
                      ordinary correction read as an alarm. */}
                  {foldById.get(evt.id) && (
                    <span
                      data-testid="marker-amend-count"
                      className="text-redlog-text-dim font-mono tabular-nums shrink-0"
                      title={t('marker.amendedTimesHint')}
                    >
                      {t('marker.amendedTimes', { count: foldById.get(evt.id)!.amendCount })}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Enhanced detail panel — height is drag-resizable; the handle at the
          top edge sets height in px (persisted to localStorage). Falling back
          to the CSS `max-h-[45vh]` when the operator hasn't dragged. */}
      {selectedEvent && detailOpen && (
        <>
          {/* Drag handle — 4px hit strip along the top edge; visual accent on hover. */}
          <div
            className="shrink-0 h-1 cursor-row-resize bg-redlog-elevated/50 hover:bg-red-500/40 transition-colors relative"
            title={t('timeline.resizeDetailPanel')}
            onMouseDown={(e) => {
              e.preventDefault()
              const currentH = detailPanelRef.current?.getBoundingClientRect().height ?? 320
              detailResizing.current = { startY: e.clientY, startH: currentH }
              document.body.classList.add('timeline-resizing')
            }}
            onDoubleClick={() => {
              // Double-click resets to default (CSS 45vh).
              setDetailPanelPx(null)
              try { localStorage.removeItem('redlog-timeline-detail-h') } catch { /* ignore */ }
            }}
          >
            <div className="absolute left-1/2 top-0 -translate-x-1/2 h-1 w-8 rounded bg-redlog-elevated-hover/50 pointer-events-none" />
          </div>
        <div
          ref={detailPanelRef}
          className={`shrink-0 border-t border-redlog-border/50 px-4 py-3 bg-redlog-surface/80 overflow-y-auto${detailPanelPx == null ? ' max-h-[45vh]' : ''}`}
          style={detailPanelPx == null ? undefined : { height: detailPanelPx }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: LANE_COLORS[toLane(selectedEvent.agentType, selectedEvent.data?.subtype as string | undefined, pluginTypes)] }} />
              <span className="text-xs font-mono font-semibold uppercase tracking-wider" style={{ color: LANE_COLORS[toLane(selectedEvent.agentType, selectedEvent.data?.subtype as string | undefined, pluginTypes)] }}>
                {selectedEvent.agentType}
              </span>
              <span className="text-xs font-mono text-redlog-text-dim px-1.5 py-0.5 rounded bg-redlog-elevated/60" title={selectedEvent.operatorId}>
                {operatorLabel(selectedEvent.operatorId)}
              </span>
              <TierBadge tier={selectedEvent.tier} variant="detail" show={tierChip} />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`text-xs font-mono px-1.5 py-0.5 rounded border transition-colors ${
                  dneFlag
                    ? 'border-red-500/60 bg-red-500/15 text-red-300'
                    : 'border-redlog-border/60 bg-redlog-elevated/40 text-redlog-text-dim hover:text-redlog-text hover:border-redlog-border'
                }`}
                title={dneFlag ? t('timeline.doNotExportHint') : t('timeline.doNotExport')}
                onClick={() => {
                  void window.redlog.events.toggleDoNotExport(selectedEvent.id).then((v) => {
                    if (v !== null) setDneFlag(v)
                  })
                }}
              >
                {dneFlag ? t('timeline.doNotExportActive') : t('timeline.doNotExport')}
              </button>
            </div>
          </div>
          <p className="text-xs text-redlog-text mt-1.5 font-mono leading-relaxed">{titleOf(selectedEvent)}</p>
          {/* v0.6.89.5 feature 3: full stacked-row of integrity badges next
              to the title so the operator sees every flag at once (the dot
              overlay only shows the first). Empty when the event has none. */}
          {(() => {
            const badges = badgesById.get(selectedEvent.id)
            if (!badges || badges.length === 0) return null
            return (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {badges.map((b) => (
                  <span
                    key={b.key}
                    className="text-xs px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 font-mono"
                    title={b.reasonKey ? t(b.reasonKey) : b.reason}
                  >
                    {b.icon} {b.reasonKey ? t(b.reasonKey) : b.reason}
                  </span>
                ))}
              </div>
            )
          })()}
          {/* v0.6.89.5 feature 1: `_causes` visualisation. Chips look up the
              cause in the in-memory events map; a click sets that event as
              the new selection and scrolls the track to centre it. A cause
              id not found in the map is a "chain broken" symptom — the T6
              case from the design grill — and gets a red chip so the
              operator can't miss it. */}
          {(() => {
            const causes = (selectedEvent.data as { _causes?: unknown } | undefined)?._causes
            if (!Array.isArray(causes) || causes.length === 0) return null
            return (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className="text-xs text-redlog-text-dim font-mono">
                  {t('timeline.detail.causedBy')}
                </span>
                {(causes as unknown[]).filter((c): c is string => typeof c === 'string').map((cid) => {
                  const cev = eventsMapRef.current.get(cid)
                  if (!cev) {
                    // Two very different situations wore the same red chip. A
                    // cause the panel simply has not paged in yet is normal —
                    // an amendment is always newer than the marker it names, so
                    // this is the DEFAULT path for one — while 「chain broken」 is
                    // the app's most serious claim and must stay rare enough to
                    // be believed. Offer to fetch it instead.
                    // A retroactive violation cites a source event that is days
                    // old and almost never inside the loaded window. Same honest
                    // claim as the amendment case: not loaded, not broken.
                    const srcTs = (selectedEvent.data as Record<string, unknown> | undefined)?.source_ts
                    if (typeof srcTs === 'number' && srcTs > 0) {
                      return (
                        <button
                          key={cid}
                          type="button"
                          onClick={() => scrollToTs(srcTs)}
                          className="text-xs px-1.5 py-0.5 rounded border border-redlog-border bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text font-mono"
                          title={cid}
                        >
                          {t('timeline.detail.causeNotLoaded', { time: formatTs(srcTs, tz, projectTz, 'timeSec') })}
                        </button>
                      )
                    }
                    if (isMarkerAmendment(selectedEvent)) {
                      return (
                        <button
                          key={cid}
                          type="button"
                          onClick={() => void resolveReferencedEvent(cid)}
                          className="text-xs px-1.5 py-0.5 rounded border border-redlog-border bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text font-mono"
                          title={cid}
                        >
                          {t('timeline.detail.causeUnpaged')}
                        </button>
                      )
                    }
                    return (
                      <button
                        key={cid}
                        type="button"
                        onClick={() => void resolveReferencedEvent(cid)}
                        className="text-xs px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:text-amber-100 font-mono"
                        title={cid}
                      >
                        {t('timeline.detail.causeNotFound', { id: cid.slice(0, 8) })}
                      </button>
                    )
                  }
                  const clane = toLane(cev.agentType, cev.data?.subtype as string | undefined, pluginTypes)
                  const cc = LANE_COLORS[clane]
                  return (
                    <button
                      key={cid}
                      onClick={() => { setSelectedEvent(cev); setDetailOpen(true); scrollToEvent(cev) }}
                      className="text-xs px-1.5 py-0.5 rounded font-mono truncate max-w-[280px] hover:brightness-125 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
                      style={{ color: cc, backgroundColor: `${cc}18`, border: `1px solid ${cc}40` }}
                      title={titleOf(cev)}
                    >
                      ◂ {titleOf(cev)}
                    </button>
                  )
                })}
              </div>
            )
          })()}
          {(() => {
            const raw = (selectedEvent.data as { related_commands?: unknown } | undefined)?.related_commands
            if (!Array.isArray(raw) || raw.length === 0) return null
            const candidates = raw.filter((value): value is { event_id: string; method: string; state: string } => {
              if (!value || typeof value !== 'object') return false
              const candidate = value as Record<string, unknown>
              return typeof candidate.event_id === 'string' && typeof candidate.method === 'string'
            })
            if (candidates.length === 0) return null
            return (
              <div className="mt-1 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
                <p className="text-xs text-amber-200 font-mono">{t('timeline.detail.relatedCommands')}</p>
                <p className="text-xs text-redlog-text-dim mt-0.5">{t('timeline.detail.relatedCommandsHint')}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {candidates.map((candidate) => {
                    const related = eventsMapRef.current.get(candidate.event_id)
                    const label = related ? titleOf(related) : candidate.event_id.slice(0, 8)
                    return (
                      <button
                        key={`${candidate.event_id}:${candidate.method}`}
                        type="button"
                        onClick={() => related
                          ? (setSelectedEvent(related), setDetailOpen(true), scrollToEvent(related))
                          : void resolveReferencedEvent(candidate.event_id)}
                        className="text-xs px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:text-amber-100 font-mono"
                        title={`${candidate.method} · ${candidate.state}`}
                      >
                        ≈ {label} · {t(candidate.state === 'recent' ? 'timeline.detail.relatedRecent' : 'timeline.detail.relatedActive')}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })()}
          {/* Effects (reverse map). Capped at 20 chips; overflow footer says
              how many more without rendering thousands of buttons. */}
          {(() => {
            const eff = effectsById.get(selectedEvent.id)
            if (!eff || eff.length === 0) return null
            const CAP = 20
            const shown = eff.slice(0, CAP)
            const more = eff.length - shown.length
            return (
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <span className="text-xs text-redlog-text-dim font-mono">
                  {t('timeline.detail.effects', { count: eff.length })}
                </span>
                {shown.map((eid) => {
                  const ev = eventsMapRef.current.get(eid)
                  if (!ev) return null
                  const elane = toLane(ev.agentType, ev.data?.subtype as string | undefined, pluginTypes)
                  const ec = LANE_COLORS[elane]
                  return (
                    <button
                      key={eid}
                      onClick={() => { setSelectedEvent(ev); setDetailOpen(true); scrollToEvent(ev) }}
                      className="text-xs px-1.5 py-0.5 rounded font-mono truncate max-w-[280px] hover:brightness-125 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
                      style={{ color: ec, backgroundColor: `${ec}18`, border: `1px solid ${ec}40` }}
                      title={titleOf(ev)}
                    >
                      ▸ {titleOf(ev)}
                    </button>
                  )
                })}
                {more > 0 && (
                  <span className="text-xs text-redlog-text-dim font-mono">
                    {t('timeline.detail.effectsMore', { count: more })}
                  </span>
                )}
              </div>
            )
          })()}
          {/* Focus-chain hint bubble (feature 2) — small nudge shown on the
              currently-selected event's detail panel when focus mode is OFF.
              Suppressed entirely once the operator is already in focus mode
              so it doesn't add noise. */}
          {!focusChain && (
            <p className="mt-1 text-xs text-redlog-text-faint font-mono">
              {t('timeline.focusChain.enterHint')}
            </p>
          )}
          {selectedEvent.targetId && (
            <p className="text-xs text-redlog-text-dim mt-1 font-mono">{t('timeline.target', { target: selectedEvent.targetId })}</p>
          )}
          {/* Structured stdout/stderr + metadata for shell command_end. */}
          {selectedEvent.agentType === 'shell'
            && selectedEvent.data?.subtype === 'command_end'
            && (
              <CommandEndDetail data={selectedEvent.data as Record<string, unknown>} />
            )}
          {/* v0.9.2 U1: agent-turn detail. Body text (user_message /
              assistant_message / thinking) shown open by default via
              CollapsibleStream so the operator sees the prompt/response
              on click without another expand. tool_call renders the
              parsed input JSON; tool_result its output stream. */}
          {selectedEvent.agentType === 'agent' && (
            <AgentTurnDetail
              data={selectedEvent.data as Record<string, unknown>}
              paired={pairedToolHalf(selectedEvent, toolPairByUseId)}
              allLoaded={!hasMore}
            />
          )}
          {/* v0.11.2 (T6): scanner and browser events carried their payloads
              all along — mitmproxy sends request params and a 2 KB
              `response_preview`, CDP sends the console message and stack — but
              neither had a detail body, so the only way to read any of it was
              the raw-JSON toggle: unformatted, redaction-masked, in a 120px
              box. Same treatment as shell and agent events now. */}
          {selectedEvent.agentType === 'scanner' && (
            <HttpDetail data={selectedEvent.data as Record<string, unknown>} eventId={selectedEvent.id} />
          )}
          {selectedEvent.agentType === 'browser' && (
            <BrowserConsoleDetail data={selectedEvent.data as Record<string, unknown>} />
          )}
          {selectedEvent.agentType === 'marker' && (
            <MarkerDetail
              key={selectedEvent.id}
              event={selectedEvent}
              fold={foldById.get(selectedEvent.id)}
              linkedScreenshots={(effectsById.get(selectedEvent.id) ?? [])
                .map((id) => eventsMapRef.current.get(id))
                .filter((e): e is RedLogEvent => !!e && e.agentType === 'screenshot')}
              tz={tz}
              projectTz={projectTz}
              operatorLabel={operatorLabel}
              onAmend={(id, changes) => void handleAmend(id, changes)}
              onSelect={(e) => { setSelectedEvent(e); setDetailOpen(true) }}
              onResolveOriginal={(id) => void resolveReferencedEvent(id)}
            />
          )}
          {/* Replay this command: only for shell.command_end from a builtin
              terminal — pulls the stdout window out of the session's .cast
              file instead of storing it in the chain. */}
          {selectedEvent.agentType === 'shell'
            && selectedEvent.data?.subtype === 'command_end'
            && selectedEvent.data?.source === 'builtin-terminal'
            && (
              <ReplayCommand eventId={selectedEvent.id} mode="command" />
            )}
          {/* Session-level replay: for session_start / session_end, replays
              the ENTIRE pty session. Critical when the operator ssh'd into
              a remote host — command_end only shows the local `ssh` line;
              session replay shows every keystroke and screen after that. */}
          {selectedEvent.agentType === 'shell'
            && (selectedEvent.data?.subtype === 'session_start' || selectedEvent.data?.subtype === 'session_end')
            && selectedEvent.data?.source === 'builtin-terminal'
            && (
              <ReplayCommand eventId={selectedEvent.id} mode="session" />
            )}
          {/* Shown as recorded. See copyJson above — layer 3 display masking
              is gone; layer 4 still redacts everything that leaves. */}
          {showJson && (
            <pre className="mt-2 p-3 bg-redlog-bg rounded border border-redlog-border text-xs text-redlog-text-dim font-mono overflow-x-auto leading-relaxed max-h-[120px] overflow-y-auto">
              {JSON.stringify(selectedEvent.data, null, 2)}
            </pre>
          )}
        </div>
        </>
      )}
    </div>
  )
}
