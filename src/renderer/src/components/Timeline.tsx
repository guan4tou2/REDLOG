import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { maskEventData, fieldsWithRedactions, type RedactionSpan } from '../lib/mask'
import { LoadingSpinner } from './Feedback'

const MIN_LANE_H = 36
const LABEL_W = 92
const BASE_TRACK_W = 2000
const LANES = ['shell', 'agent', 'http_navigation', 'scanner', 'dns', 'pivot', 'screenshot', 'clipboard', 'file_transfer', 'credential_use', 'c2_checkin', 'marker', 'loot', 'cleanup', 'scope', 'system'] as const
type LaneId = (typeof LANES)[number]

const LANE_COLORS: Record<LaneId, string> = {
  shell: '#22c55e',
  agent: '#84cc16',
  http_navigation: '#6366f1',
  scanner: '#8b5cf6',
  dns: '#14b8a6',
  pivot: '#0ea5e9',
  screenshot: '#3b82f6',
  clipboard: '#a855f7',
  file_transfer: '#a78bfa',
  credential_use: '#eab308',
  c2_checkin: '#f43f5e',
  marker: '#ef4444',
  loot: '#f97316',
  cleanup: '#dc2626',
  scope: '#ef4444',
  system: '#52525b'
}

function eventTitle(event: RedLogEvent): string {
  const d = event.data
  switch (event.agentType) {
    case 'shell':
      if (d.subtype === 'command_start') return `$ ${(d.command as string).slice(0, 100)}`
      if (d.subtype === 'command_end') return `$ ${(d.command as string).slice(0, 80)} → exit ${d.exit_code}`
      if (d.subtype === 'command' && d.command) return `$ ${(d.command as string).slice(0, 100)}`
      if (d.subtype === 'session_start') return `▸ terminal opened`
      if (d.subtype === 'session_end') return `▪ terminal closed${d.exitCode != null ? ` (exit ${d.exitCode})` : ''}`
      return 'Shell event'
    case 'dns':
      return `DNS ${d.subtype === 'dns_response' ? '⇐' : '⇒'} ${d.dest_host || d.command || ''}`
    case 'http_navigation':
      return `⇢ ${d.host || d.url || ''} ${d.title ? `— ${(d.title as string).slice(0, 60)}` : ''}`.trim()
    case 'scanner':
      return `[${d.subtype || 'req'}] ${d.method || ''} ${d.url || d.host || ''}`.trim()
    case 'screenshot':
      return `Screenshot (${d.trigger})`
    case 'clipboard':
      return `Clipboard: ${(d.content as string)?.slice(0, 60) || ''}...`
    case 'file_transfer':
      return `${d.subtype || d.direction || 'transfer'}: ${d.filename || d.localPath || d.remotePath || ''} ${d.bytes ? `(${d.bytes}B)` : ''}`.trim()
    case 'credential_use':
      return `${d.subtype || 'cred'}: ${d.user_context || '?'} @ ${d.dest_host || d.dest_ip || ''}`
    case 'c2_checkin':
      return `C2 beacon ← ${d.dest_ip || d.dest_host || ''} ${d.bytes ? `(${d.bytes}B)` : ''}`.trim()
    case 'pivot':
      return `Pivot [${d.tool}] ${d.subtype || ''}${d.via ? ` → ${d.via}` : ''}${d.route ? ` (${d.route})` : ''}`.trim()
    case 'cleanup':
      return `⚠ Cleanup [${d.tool}] ${d.subtype || ''}${d.target ? ` → ${d.target}` : ''}`.trim()
    case 'marker':
      return `${(d.severity as string || 'info').toUpperCase()}: ${d.title}`
    case 'loot': {
      const m = (d.matches as Array<{ type: string; confidence: string }>)?.[0]
      return m ? `Loot: ${m.type.replace(/_/g, ' ')} (${m.confidence})` : `Loot: ${d.count ?? 0} detected`
    }
    case 'system':
      if (d.subtype === 'scope_violation') return `⚠ Scope violation: ${d.target || d.command || ''}`
      if (d.subtype === 'ip_transition') return `⇋ ${d.description || 'IP transition'}`
      if (d.subtype === 'opsec_state_changed') return `⇋ OPSEC: ${d.description || 'state changed'}`
      if (d.subtype === 'recording_paused') return `⏸ Recording paused`
      if (d.subtype === 'recording_resumed') return `⏺ Recording resumed`
      if (d.subtype === 'config_changed') return `⚙ ${d.description || 'Config changed'}`
      if (d.subtype === 'browser_launched') return `▸ Browser (${d.proxy ? `proxy ${d.proxy}` : 'no proxy'})`
      if (d.subtype === 'secret_revealed') return `👁 Secret revealed: ${(d.fields as string[])?.join(', ') || 'unknown fields'}`
      return `${event.agentType}: ${d.subtype || ''}`
    default:
      return `${event.agentType}: ${d.subtype || ''}`
  }
}

function toLane(agentType: string, subtype?: string): LaneId {
  // Scope violations are stored under agent_type='system' for historical reasons
  // (the deconfliction webhook filter watches 'system'). Route them into their own
  // lane at render time so they don't drown in the system-lane housekeeping.
  if (agentType === 'system' && subtype === 'scope_violation') return 'scope'
  return LANES.includes(agentType as LaneId) ? (agentType as LaneId) : 'system'
}

// Lifecycle noise kept in the DB for the record but hidden from the timeline so
// it doesn't drown the actual operation. Real user/agent actions still show; only
// the app's own plumbing is suppressed:
//   • system.api_started / session_start — RedLog boot, once per app open
//   • system.deconfliction_test — manual test button in Settings
//   • shell.session_start / session_end — user opened/closed a terminal pane
//   • terminal.session_start — duplicate write-path for the same pane-open event
//   • command_start whose command IS just sourcing the shell hook (the "silent"
//     hook install runs as a real preexec, so the hook itself logs it as a
//     command; that's plumbing, not a user command)
function isHookSource(cmd: unknown): boolean {
  return typeof cmd === 'string' && /shell-preexec-hook\.sh/.test(cmd)
}
function isHousekeeping(e: RedLogEvent): boolean {
  const s = e.data?.subtype as string | undefined
  if (e.agentType === 'system' && (s === 'api_started' || s === 'session_start' || s === 'deconfliction_test')) return true
  // shell.session_start is redundant with session_end (which has the full
  // castPath + duration), and it fires before there's anything to replay.
  // session_end is kept visible so operators can click it and use the
  // "▶ Replay entire session" button — critical when the session ssh'd
  // into a remote host and the local command_end row only shows `ssh`.
  if (e.agentType === 'shell' && s === 'session_start') return true
  if (e.agentType === 'terminal' && s === 'session_start') return true
  if (e.agentType === 'shell' && (s === 'command_start' || s === 'command') && isHookSource(e.data?.command)) return true
  return false
}

// A shell command_start is only interesting on its own if no command_end ever
// arrives (still-running command). When the pair completes, the end has all the
// signal (exit code + duration), so hide the redundant start. Match on pid+cmd.
// Comparator: primary sort by wall-clock, tiebreak by monotonic_ns when
// two events share the same ms. monotonic_ns comes from Node's process.hrtime
// (or its equivalent) and is captured as a string of digits — compare as
// BigInt so we don't collapse 40-digit values into Number precision. This is
// the audit's P2 ordering fix: without it, two events that landed in the
// same millisecond had no defined order, so a cluster's popover items and
// the pagination anchor could disagree between page loads. Falls back to
// event id (uuid) for a stable final tiebreak.
function eventCompare(a: RedLogEvent, b: RedLogEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  const am = a.monotonicNs, bm = b.monotonicNs
  if (am && bm && am !== bm) {
    try {
      const ai = BigInt(am), bi = BigInt(bm)
      return ai < bi ? -1 : ai > bi ? 1 : 0
    } catch { /* fall through to id */ }
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function collapseCommandPairs(events: RedLogEvent[]): RedLogEvent[] {
  const closed = new Set<string>()
  for (const e of events) {
    if (e.agentType !== 'shell' || e.data?.subtype !== 'command_end') continue
    const key = `${e.data?.pid ?? ''}|${e.data?.command ?? ''}`
    closed.add(key)
  }
  return events.filter((e) => {
    if (e.agentType !== 'shell' || e.data?.subtype !== 'command_start') return true
    const key = `${e.data?.pid ?? ''}|${e.data?.command ?? ''}`
    return !closed.has(key)
  })
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function TimelinePanel({ focusEventId, focusTs }: { focusEventId?: string; focusTs?: number } = {}): JSX.Element {
  const [rawEvents, setEvents] = useState<RedLogEvent[]>([])
  // Hide command_start once its matching command_end lands — the end has the
  // exit code + duration, so the start would just be a duplicate row.
  const events = useMemo(() => collapseCommandPairs(rawEvents), [rawEvents])
  const [selectedEvent, setSelectedEvent] = useState<RedLogEvent | null>(null)
  const [allLoaded, setAllLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [containerH, setContainerH] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [cluster, setCluster] = useState<{ x: number; y: number; events: RedLogEvent[] } | null>(null)
  const [view, setView] = useState({ left: 0, width: 100 })
  const [drag, setDrag] = useState<{ x0: number; x1: number; w: number } | null>(null)
  const pendingView = useRef<{ t0: number } | null>(null)
  // Cluster-item click needs a two-frame handshake: bump zoom so the events
  // split into distinct dots, then center on the picked one after re-render.
  // We can't scroll synchronously because TRACK_W hasn't grown yet.
  const pendingCenterTs = useRef<number | null>(null)
  const [hiddenLanes, setHiddenLanes] = useState<Set<LaneId>>(new Set())
  const [showJson, setShowJson] = useState(false)
  // Layer 3 (four-layer redaction): raw text of an event's redacted spans is
  // hidden by default in the detail view. The reviewer opts into a per-event
  // reveal; each reveal appends a chained system.secret_revealed event so the
  // audit trail shows raw bytes were viewed.
  const [revealedEvents, setRevealedEvents] = useState<Set<string>>(new Set())
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

  // On new selection: snap the detail panel back to the top, collapse the JSON
  // dump, and RE-MASK any previously-revealed events (audit finding #1).
  // Reveal was sticky per-session — leaving and coming back kept everything
  // unmasked, which weakens the mask-by-default contract. Now reveal only
  // applies to the actively-focused event.
  useEffect(() => {
    setShowJson(false)
    setRevealedEvents(new Set())
    if (detailPanelRef.current) detailPanelRef.current.scrollTop = 0
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

  useEffect(() => {
    const load = (): void => {
      window.redlog.operators.list().then((ops) => {
        const map: Record<string, string> = {}
        ops.forEach((op) => { map[op.id] = op.name })
        setOperatorNames(map)
      }).catch(() => {})
    }
    load()
    const unsub = window.redlog.events.onNew((e) => {
      if (e.operatorId && !operatorNames[e.operatorId]) load()
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const operatorLabel = (id: string): string => operatorNames[id] || id
  // With a single operator the column is the same string on every row — only
  // worth the horizontal space once a second identity shows up.
  const showOperator = Object.keys(operatorNames).length > 1
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const eventsMapRef = useRef(new Map<string, RedLogEvent>())
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
    system: t('timeline.system')
  }), [t])

  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(([entry]) => setContainerH(entry.contentRect.height))
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // A lane with no events is dead vertical space — most engagements only ever
  // touch three or four of them. Keep the filter chip so the operator can see
  // the lane exists, but don't give it a row until something lands in it.
  const populatedLanes = useMemo(() => {
    const seen = new Set<LaneId>()
    for (const e of events) seen.add(toLane(e.agentType, e.data?.subtype as string | undefined))
    return seen
  }, [events])

  const visibleLanes = useMemo(
    () => LANES.filter((l) => populatedLanes.has(l) && !hiddenLanes.has(l)),
    [populatedLanes, hiddenLanes]
  )

  const laneH = useMemo(() => {
    if (visibleLanes.length === 0) return MIN_LANE_H
    const axisH = 28
    const available = containerH - axisH
    return Math.max(MIN_LANE_H, Math.floor(available / visibleLanes.length))
  }, [containerH, visibleLanes.length])

  const loadMore = useCallback(() => {
    if (loading || allLoaded) return
    setLoading(true)
    // Pagination anchor: the oldest timestamp we already have. Without this
    // the query kept returning the same latest 200 and the auto-load
    // triggered but never advanced (audit #3 follow-up).
    const oldest = Array.from(eventsMapRef.current.values())
      .reduce((min, e) => (e.timestamp < min ? e.timestamp : min), Number.MAX_SAFE_INTEGER)
    const before = oldest !== Number.MAX_SAFE_INTEGER ? oldest : undefined
    window.redlog.events.query({ limit: 200, before }).then((fetched) => {
      const newOnes = fetched.filter((e) => !eventsMapRef.current.has(e.id) && !isHousekeeping(e))
      if (fetched.length < 200) setAllLoaded(true)
      if (newOnes.length > 0) {
        newOnes.forEach((e) => eventsMapRef.current.set(e.id, e))
        setEvents(Array.from(eventsMapRef.current.values()).sort(eventCompare))
      }
      setLoading(false)
    })
  }, [loading, allLoaded])

  useEffect(() => {
    window.redlog.events.query({ limit: 200 }).then((fetched) => {
      if (fetched.length < 200) setAllLoaded(true)
      fetched.filter((e) => !isHousekeeping(e)).forEach((e) => eventsMapRef.current.set(e.id, e))
      setEvents(Array.from(eventsMapRef.current.values()).sort(eventCompare))
      setLoading(false)
    })
    const unsub = window.redlog.events.onNew((event) => {
      if (isHousekeeping(event)) return
      eventsMapRef.current.set(event.id, event)
      setEvents(Array.from(eventsMapRef.current.values()).sort(eventCompare))
    })
    return unsub
  }, [])

  const { timeStart, timeEnd, ticks } = useMemo(() => {
    if (events.length === 0) {
      const now = Date.now()
      return { timeStart: now - 3600000, timeEnd: now, ticks: [] as number[] }
    }
    const first = events[0].timestamp
    const last = events[events.length - 1].timestamp
    const pad = Math.max((last - first) * 0.05, 60000)
    const s = first - pad
    const e = last + pad
    const span = e - s
    const steps = Math.min(Math.max(Math.floor(span / 300000), 4), 20)
    const step = span / steps
    const ts: number[] = []
    for (let i = 0; i <= steps; i++) ts.push(s + i * step)
    return { timeStart: s, timeEnd: e, ticks: ts }
  }, [events])

  const TRACK_W = Math.round(BASE_TRACK_W * zoom)
  const timeSpan = timeEnd - timeStart
  const toX = useCallback((ts: number) => ((ts - timeStart) / timeSpan) * TRACK_W, [timeStart, timeSpan, TRACK_W])
  const totalH = visibleLanes.length * laneH

  const laneEvents = useMemo(() => {
    const map = Object.fromEntries(LANES.map((l) => [l, [] as RedLogEvent[]])) as Record<LaneId, RedLogEvent[]>
    for (const e of events) map[toLane(e.agentType, e.data?.subtype as string | undefined)].push(e)
    return map
  }, [events])

  // Collapse events that fall within ~14px of each other on the same lane into a
  // single clickable marker (with a count) so dense bursts stay legible. Zooming
  // in widens the track, so clusters naturally split apart into individual dots.
  const CLUSTER_PX = 14
  const clusters = useMemo(() => {
    const out: Array<{ key: string; lane: LaneId; li: number; x: number; y: number; events: RedLogEvent[] }> = []
    visibleLanes.forEach((lane, li) => {
      const evs = laneEvents[lane]
      if (!evs.length) return
      let bucket: RedLogEvent[] = []
      let curBi = NaN
      const flush = (): void => {
        if (!bucket.length) return
        const x = bucket.reduce((a, e) => a + toX(e.timestamp), 0) / bucket.length
        out.push({ key: `${lane}-${bucket[0].id}`, lane, li, x, y: li * laneH + laneH / 2, events: bucket })
        bucket = []
      }
      for (const e of evs) {
        const bi = Math.floor(toX(e.timestamp) / CLUSTER_PX)
        if (bucket.length && bi !== curBi) flush()
        curBi = bi
        bucket.push(e)
      }
      flush()
    })
    return out
  }, [visibleLanes, laneEvents, toX, laneH])

  // Density minimap: event counts over the full range, binned into fixed cells.
  const bins = useMemo(() => {
    const N = 120
    const counts = new Array(N).fill(0)
    const span = (timeEnd - timeStart) || 1
    for (const e of events) {
      let i = Math.floor(((e.timestamp - timeStart) / span) * N)
      i = i < 0 ? 0 : i >= N ? N - 1 : i
      counts[i]++
    }
    return { counts, max: Math.max(1, ...counts), N }
  }, [events, timeStart, timeEnd])

  // Keep the minimap's "current viewport" window in sync with the scroll/zoom.
  const updateView = useCallback(() => {
    const el = scrollRef.current
    if (!el || TRACK_W <= 0) return
    setView({ left: (el.scrollLeft / TRACK_W) * 100, width: Math.min(100, (el.clientWidth / TRACK_W) * 100) })
    // Auto-load-more when scrolled to the earliest edge (audit #3). Was
    // click-driven with a "load more" chip; users hitting the left edge with
    // more history to pull would just see empty space and not realise there
    // was a button.
    if (!allLoaded && !loading && el.scrollLeft < 80) loadMore()
  }, [TRACK_W, allLoaded, loading, loadMore])

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
        setZoom(Math.max(0.25, Math.min(6, el.clientWidth / (BASE_TRACK_W * frac))))
      } else {
        const t = timeStart + (startX / w) * span
        el.scrollLeft = Math.max(0, Math.min(((t - timeStart) / span) * TRACK_W - el.clientWidth / 2, TRACK_W - el.clientWidth))
        updateView()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    setDrag({ x0: startX, x1: startX, w })
  }, [timeStart, timeEnd, TRACK_W, updateView])

  const recentEvents = useMemo(() => {
    const visible = events.filter((e) => !hiddenLanes.has(toLane(e.agentType, e.data?.subtype as string | undefined)))
    return [...visible].reverse().slice(0, 50)
  }, [events, hiddenLanes])

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
        setZoom((prev) => Math.min(6, Math.max(0.25, prev * Math.exp(-e.deltaY * 0.002))))
      } else if (e.deltaY !== 0) {
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
      el.scrollLeft = Math.max(0, Math.min(toX(focused.timestamp) - el.clientWidth / 2, TRACK_W - el.clientWidth))
    } else if (focusTs) {
      // no matching event (e.g. jumped from a quickmark) — centre on its time
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
  }, [TRACK_W, updateView, timeStart, timeEnd, loading])

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

  // Escape closes the event detail panel (audit finding #78). ↑/↓ walk the
  // selected event across the visible list, respecting hidden-lane filters —
  // audit #5. Skips inputs/textareas so typing in the search bar isn't hijacked.
  useEffect(() => {
    if (!selectedEvent) return
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) return
      if (e.key === 'Escape') { setSelectedEvent(null); setShowJson(false); return }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const visible = events.filter((ev) => !hiddenLanes.has(toLane(ev.agentType, ev.data?.subtype as string | undefined)))
        const i = visible.findIndex((ev) => ev.id === selectedEvent.id)
        if (i < 0) return
        const dir = e.key === 'ArrowUp' ? -1 : 1
        const next = visible[i + dir]
        if (next) { e.preventDefault(); setSelectedEvent(next) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedEvent, events, hiddenLanes])

  const copyEventJson = useCallback(() => {
    if (!selectedEvent) return
    // Respect the current mask/reveal state (audit finding #2). If the panel
    // shows a masked view, the clipboard gets the masked view too — a
    // reviewer copying an event to paste into chat / a report shouldn't have
    // to remember to hit Reveal first to know what they're leaking. Click
    // Reveal → then Copy → gets raw. Default (mask) → Copy → gets masked.
    const spans = selectedEvent.data?.redactions as RedactionSpan[] | undefined
    const revealed = revealedEvents.has(selectedEvent.id)
    const shown = revealed || !spans?.length
      ? selectedEvent
      : { ...selectedEvent, data: maskEventData(selectedEvent.data ?? {}, spans) }
    navigator.clipboard.writeText(JSON.stringify(shown, null, 2))
    toast(t(revealed || !spans?.length ? 'toast.copied' : 'toast.copiedMasked'), 'success')
  }, [selectedEvent, revealedEvents, t])

  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingSpinner label={t('common.loading')} />
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center px-8">
          <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <span className="text-2xl text-zinc-700">═</span>
          </div>
          <p className="text-sm text-zinc-500">{t('timeline.noEvents')}</p>
          <p className="text-xs text-zinc-700">{t('timeline.noEventsDesc')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-zinc-800/80 shrink-0">
        <span className="text-[13px] font-semibold text-zinc-200 tracking-wide">{t('timeline.title')}</span>
        <span className="text-[11px] text-zinc-600 font-mono tabular-nums">
          {t('timeline.events', { count: events.length })}
        </span>
        {!allLoaded && (
          <button onClick={loadMore} className="text-xs text-zinc-600 hover:text-zinc-300 ml-1 transition-colors">
            {t('timeline.loadMore')}
          </button>
        )}

        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            className="w-5 h-5 flex items-center justify-center text-[11px] text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            title={t('timeline.zoomOut')}
            aria-label={t('timeline.zoomOut')}
          >−</button>
          <button
            onClick={() => setZoom(1)}
            disabled={Math.abs(zoom - 1) < 0.01}
            className="px-1.5 h-5 flex items-center justify-center text-xs text-zinc-600 hover:text-zinc-300 bg-zinc-800/50 rounded font-mono tabular-nums transition-colors disabled:cursor-default disabled:hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            title={t('timeline.resetZoom')}
            aria-label={t('timeline.resetZoom')}
          >{Math.round(zoom * 100)}% ↺</button>
          <button
            onClick={() => setZoom((z) => Math.min(6, z + 0.25))}
            className="w-5 h-5 flex items-center justify-center text-[11px] text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
            title={t('timeline.zoomIn')}
            aria-label={t('timeline.zoomIn')}
          >+</button>
        </div>

        {/* Lane filter toggles — click toggles; Alt/Option-click solos the
            lane (hides every other populated lane); solo'd-lane Alt-click
            again shows all. Audit finding #4.
            `overflow-x-auto` + `min-w-0` + `flex-nowrap` means when the
            header narrows the chips scroll horizontally instead of wrapping
            onto a second row — reported when running at 1280 wide with the
            full lane list open. */}
        <div className="ml-auto flex flex-nowrap gap-1 items-center overflow-x-auto min-w-0">
          {hiddenLanes.size > 0 && (
            <button
              onClick={showAllLanes}
              className="shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
              title={t('timeline.showAllLanes')}
            >{t('timeline.showAll')}</button>
          )}
          {LANES.map((id) => {
            const empty = !populatedLanes.has(id)
            const hidden = hiddenLanes.has(id)
            const off = empty || hidden
            return (
              <button
                key={id}
                onClick={(e) => { if (empty) return; if (e.altKey) soloLane(id, populatedLanes); else toggleLane(id) }}
                disabled={empty}
                className={`shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded font-mono transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500 ${
                  hidden ? 'opacity-30 line-through' : empty ? 'opacity-25 cursor-default' : ''
                }`}
                style={{
                  color: off ? '#525252' : LANE_COLORS[id],
                  backgroundColor: off ? 'transparent' : `${LANE_COLORS[id]}10`
                }}
                title={empty ? t('timeline.laneEmpty', { lane: laneLabels[id] }) : t('timeline.laneChipHint', { lane: laneLabels[id] })}
              >
                {laneLabels[id]}
              </button>
            )
          })}
        </div>
      </div>

      {/* Density minimap — overview of the whole engagement. Drag to zoom to a
          window, click to jump. The bright frame marks the current viewport. */}
      <div
        className="relative h-9 border-b border-zinc-800/80 bg-zinc-950/40 cursor-crosshair select-none shrink-0"
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
        <div ref={containerRef} className="flex-1 min-h-0 flex overflow-hidden">
          {/* Lane labels */}
          <div className="shrink-0 border-r border-zinc-800/60 bg-zinc-950/50" style={{ width: LABEL_W }}>
            <div className="h-7 border-b border-zinc-800/60" />
            {visibleLanes.map((id) => (
              <div
                key={id}
                className="flex items-center gap-1.5 px-2 border-b border-zinc-800/30 font-mono text-[11px]"
                style={{ height: laneH }}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[id] }} />
                <span className="text-zinc-500 truncate">{laneLabels[id]}</span>
              </div>
            ))}
          </div>

          {/* Scrollable track */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-x-auto overflow-y-hidden cursor-grab"
            onMouseDown={handleMouseDown}
            onScroll={updateView}
          >
            <div style={{ width: TRACK_W, position: 'relative' }}>
              {/* Time axis */}
              <div className="h-7 border-b border-zinc-800/60 relative bg-zinc-950/30">
                {ticks.map((ts) => (
                  <span
                    key={ts}
                    className="absolute text-xs text-zinc-600 font-mono tabular-nums -translate-x-1/2"
                    style={{ left: toX(ts), top: 6 }}
                  >
                    {formatTimeLabel(new Date(ts))}
                  </span>
                ))}
              </div>

              {/* Lanes area */}
              <div style={{ height: totalH, position: 'relative' }}>
                {visibleLanes.map((_, i) => (
                  <div
                    key={i}
                    className="absolute w-full border-b border-zinc-800/30"
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
                    className="absolute top-0 border-l border-zinc-800/25"
                    style={{ left: toX(ts), height: totalH }}
                  />
                ))}
                {/* Current time line */}
                {Date.now() >= timeStart && Date.now() <= timeEnd && (
                  <div className="absolute top-0 w-px bg-red-500/70" style={{ left: toX(Date.now()), height: totalH }} />
                )}
                {/* Event markers — single dot, or a counted cluster when dense */}
                {clusters.map((c) => {
                  const single = c.events.length === 1
                  const evt = c.events[0]
                  const sel = single && selectedEvent?.id === evt.id
                  const dot = single ? 9 : Math.min(24, 13 + Math.round(Math.log2(c.events.length) * 3))
                  const hit = Math.max(20, dot + 8)
                  return (
                    <div
                      key={c.key}
                      className="absolute cursor-pointer flex items-center justify-center"
                      style={{ left: c.x - hit / 2, top: c.y - hit / 2, width: hit, height: hit, zIndex: sel ? 10 : 2 }}
                      title={single
                        ? `${new Date(evt.timestamp).toLocaleTimeString()} — ${eventTitle(evt)}`
                        : `${c.events.length} ${t('timeline.title')} · ${new Date(c.events[0].timestamp).toLocaleTimeString()}`}
                      onClick={() => single ? setSelectedEvent(sel ? null : evt) : setCluster({ x: c.x, y: c.y, events: c.events })}
                    >
                      <div
                        className="flex items-center justify-center transition-transform hover:scale-125"
                        style={{
                          width: dot, height: dot,
                          borderRadius: single ? '50%' : 5,
                          backgroundColor: LANE_COLORS[c.lane],
                          border: single ? undefined : '1px solid rgba(0,0,0,0.45)',
                          boxShadow: sel
                            ? `0 0 0 2px #0a0a0a, 0 0 0 3px ${LANE_COLORS[c.lane]}, 0 0 12px ${LANE_COLORS[c.lane]}60`
                            : `0 0 6px ${LANE_COLORS[c.lane]}40`
                        }}
                      >
                        {!single && <span style={{ fontSize: 9, fontWeight: 800, color: 'rgba(0,0,0,0.78)', lineHeight: 1 }}>{c.events.length}</span>}
                      </div>
                    </div>
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
                    <div className="rounded-md border border-zinc-700 bg-zinc-900/95 shadow-xl max-h-[210px] overflow-y-auto">
                      <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-800 sticky top-0 bg-zinc-900/95">
                        <span className="text-xs text-zinc-400 font-mono">{cluster.events.length} {t('timeline.title')}</span>
                        <button className="text-zinc-500 hover:text-zinc-200 text-xs leading-none" onClick={() => setCluster(null)}>×</button>
                      </div>
                      {capped.map((evt) => (
                        <button
                          key={evt.id}
                          className="w-full text-left px-2 py-1 hover:bg-white/5 flex items-center gap-2"
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
                            const spanZoom = neededTrackW / BASE_TRACK_W
                            const targetZoom = Math.max(zoom, Math.min(6, spanZoom))
                            if (Math.abs(targetZoom - zoom) > 0.01) {
                              pendingCenterTs.current = evt.timestamp
                              setZoom(targetZoom)
                            } else {
                              const sc = scrollRef.current
                              if (sc) sc.scrollLeft = Math.max(0, Math.min(toX(evt.timestamp) - sc.clientWidth / 2, TRACK_W - sc.clientWidth))
                            }
                          }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[toLane(evt.agentType, evt.data?.subtype as string | undefined)] }} />
                          <span className="text-zinc-600 font-mono text-[11px] tabular-nums shrink-0">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                          <span className="text-zinc-300 text-xs truncate">{eventTitle(evt)}</span>
                        </button>
                      ))}
                      {overflow > 0 && (
                        <div className="px-2 py-1 text-[11px] text-zinc-500 border-t border-zinc-800 sticky bottom-0 bg-zinc-900/95">
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
        <div className="shrink-0 border-t border-zinc-800/60 bg-zinc-950/50" style={{ height: selectedEvent ? '18vh' : '22vh' }}>
          <div className="px-3 py-1.5 border-b border-zinc-800/40 flex items-center justify-between">
            <span className="text-xs text-zinc-500 font-mono uppercase tracking-wider">{t('timeline.title')}</span>
            <span className="text-xs text-zinc-600 font-mono tabular-nums">{recentEvents.length}</span>
          </div>
          <div className="overflow-y-auto" style={{ height: `calc(${selectedEvent ? '18vh' : '22vh'} - 32px)` }}>
            {recentEvents.map((evt) => {
              const lane = toLane(evt.agentType, evt.data?.subtype as string | undefined)
              const isSel = selectedEvent?.id === evt.id
              return (
                <div
                  key={evt.id}
                  className={`flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors text-[11px] border-b border-zinc-900/30 ${
                    isSel ? 'bg-zinc-800/50' : 'hover:bg-zinc-800/20'
                  }`}
                  onClick={() => setSelectedEvent(isSel ? null : evt)}
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[lane] }} />
                  <span className="text-zinc-600 font-mono tabular-nums shrink-0 w-16">
                    {new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  {showOperator && (
                    <span className="text-zinc-500 font-mono shrink-0 max-w-[80px] truncate" title={evt.operatorId}>
                      {operatorLabel(evt.operatorId)}
                    </span>
                  )}
                  <span className="text-zinc-400 truncate">{eventTitle(evt)}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Enhanced detail panel — height is drag-resizable; the handle at the
          top edge sets height in px (persisted to localStorage). Falling back
          to the CSS `max-h-[45vh]` when the operator hasn't dragged. */}
      {selectedEvent && (
        <>
          {/* Drag handle — 4px hit strip along the top edge; visual accent on hover. */}
          <div
            className="shrink-0 h-1 cursor-row-resize bg-zinc-800/50 hover:bg-red-500/40 transition-colors relative"
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
            <div className="absolute left-1/2 top-0 -translate-x-1/2 h-1 w-8 rounded bg-zinc-600/50 pointer-events-none" />
          </div>
        <div
          ref={detailPanelRef}
          className={`shrink-0 border-t border-zinc-700/50 px-4 py-3 bg-zinc-900/80 overflow-y-auto${detailPanelPx == null ? ' max-h-[45vh]' : ''}`}
          style={detailPanelPx == null ? undefined : { height: detailPanelPx }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: LANE_COLORS[toLane(selectedEvent.agentType, selectedEvent.data?.subtype as string | undefined)] }} />
              <span className="text-[11px] font-mono font-semibold uppercase tracking-wider" style={{ color: LANE_COLORS[toLane(selectedEvent.agentType, selectedEvent.data?.subtype as string | undefined)] }}>
                {selectedEvent.agentType}
              </span>
              <span className="text-xs font-mono text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-800/60" title={selectedEvent.operatorId}>
                {operatorLabel(selectedEvent.operatorId)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const spans = selectedEvent.data?.redactions as RedactionSpan[] | undefined
                const fields = fieldsWithRedactions(spans)
                if (fields.length === 0) return null
                const revealed = revealedEvents.has(selectedEvent.id)
                return (
                  <button
                    onClick={async () => {
                      const next = new Set(revealedEvents)
                      if (revealed) {
                        next.delete(selectedEvent.id)
                      } else {
                        next.add(selectedEvent.id)
                        // Log the reveal — additive event, never blocks the UI.
                        try { await window.redlog.events.logSecretRevealed(selectedEvent.id, fields) } catch { /* ignore */ }
                      }
                      setRevealedEvents(next)
                    }}
                    title={revealed ? t('timeline.reveal.hideHint') : t('timeline.reveal.showHint', { fields: fields.join(', ') })}
                    className={`text-xs px-2 py-0.5 rounded transition-colors ${revealed ? 'bg-amber-700/60 text-amber-100' : 'bg-amber-900/40 text-amber-400 hover:bg-amber-900/60'}`}
                  >
                    {revealed ? t('timeline.reveal.hide') : t('timeline.reveal.show', { n: spans?.length ?? 0 })}
                  </button>
                )
              })()}
              <button
                onClick={() => setShowJson(!showJson)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${showJson ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
              >
                {t('timeline.fullData')}
              </button>
              <button
                onClick={copyEventJson}
                className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {t('timeline.copyJson')}
              </button>
              <button
                onClick={() => { setSelectedEvent(null); setShowJson(false) }}
                className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors ml-1"
              >
                ✕
              </button>
              <span className="text-xs text-zinc-600 font-mono tabular-nums">{new Date(selectedEvent.timestamp).toLocaleString()}</span>
            </div>
          </div>
          <p className="text-[12px] text-zinc-300 mt-1.5 font-mono leading-relaxed">{eventTitle(selectedEvent)}</p>
          {selectedEvent.targetId && (
            <p className="text-xs text-zinc-500 mt-1 font-mono">{t('timeline.target', { target: selectedEvent.targetId })}</p>
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
          {showJson && (() => {
            const spans = selectedEvent.data?.redactions as RedactionSpan[] | undefined
            const revealed = revealedEvents.has(selectedEvent.id)
            // Mask string fields that have redaction spans unless the reviewer
            // opted into reveal. copyJson still copies the RAW event by design —
            // an operator investigating on their own machine needs the raw
            // bytes; the mask is UX, not the security boundary (that's Layer 4).
            const shown = revealed ? selectedEvent.data : maskEventData(selectedEvent.data ?? {}, spans)
            return (
              <pre className="mt-2 p-3 bg-zinc-950 rounded border border-zinc-800 text-xs text-zinc-400 font-mono overflow-x-auto leading-relaxed max-h-[120px] overflow-y-auto">
                {JSON.stringify(shown, null, 2)}
              </pre>
            )
          })()}
        </div>
        </>
      )}
    </div>
  )
}

// Pulled from the session's asciinema .cast on disk — not from the event
// row. Rendering here keeps the chain event clean (command + exit + duration
// only) while still letting the operator see what actually printed.
function ReplayCommand({ eventId, mode = 'command' }: { eventId: string; mode?: 'command' | 'session' }): JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()
  const load = async (): Promise<void> => {
    setLoading(true)
    try {
      const fn = mode === 'session'
        ? window.redlog.terminal.replaySession
        : window.redlog.terminal.replay
      const r = await fn?.(eventId)
      if (!r) { setError('unsupported'); return }
      if (!r.ok) { setError(r.error ?? 'failed'); return }
      setText(r.text ?? '')
      setExpanded(true)
    } finally {
      setLoading(false)
    }
  }
  const btnLabel = mode === 'session' ? 'timeline.replay.sessionButton' : 'timeline.replay.button'
  if (!expanded) {
    return (
      <button
        onClick={load}
        disabled={loading}
        className="mt-1.5 text-xs px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/40 disabled:opacity-50"
      >{loading ? t('timeline.replay.loading') : t(btnLabel)}</button>
    )
  }
  if (error) return <p className="mt-1.5 text-xs text-red-400">{t('timeline.replay.failed', { error })}</p>
  // Session replays can be huge (whole ssh session); tall + scrollable.
  const heightCls = mode === 'session' ? 'max-h-[400px]' : 'max-h-[200px]'
  return (
    <pre className={`mt-1.5 p-2 bg-zinc-950 rounded border border-zinc-800 text-xs text-zinc-300 font-mono overflow-x-auto leading-relaxed ${heightCls} overflow-y-auto whitespace-pre-wrap`}>
      {text || t('timeline.replay.empty')}
    </pre>
  )
}

