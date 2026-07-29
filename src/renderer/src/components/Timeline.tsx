import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'

const MIN_LANE_H = 36
const LABEL_W = 92
const BASE_TRACK_W = 2000
const LANES = ['shell', 'dns', 'pivot', 'screenshot', 'clipboard', 'file_transfer', 'credential_use', 'c2_checkin', 'marker', 'loot', 'system'] as const
type LaneId = (typeof LANES)[number]

const LANE_COLORS: Record<LaneId, string> = {
  shell: '#22c55e',
  dns: '#14b8a6',
  pivot: '#0ea5e9',
  screenshot: '#3b82f6',
  clipboard: '#a855f7',
  file_transfer: '#a78bfa',
  credential_use: '#eab308',
  c2_checkin: '#f43f5e',
  marker: '#ef4444',
  loot: '#f97316',
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
    case 'marker':
      return `${(d.severity as string || 'info').toUpperCase()}: ${d.title}`
    case 'loot': {
      const m = (d.matches as Array<{ type: string; confidence: string }>)?.[0]
      return m ? `Loot: ${m.type.replace(/_/g, ' ')} (${m.confidence})` : `Loot: ${d.count ?? 0} detected`
    }
    default:
      return `${event.agentType}: ${d.subtype || ''}`
  }
}

function toLane(agentType: string): LaneId {
  return LANES.includes(agentType as LaneId) ? (agentType as LaneId) : 'system'
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function TimelinePanel(): JSX.Element {
  const [events, setEvents] = useState<RedLogEvent[]>([])
  const [selectedEvent, setSelectedEvent] = useState<RedLogEvent | null>(null)
  const [allLoaded, setAllLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [containerH, setContainerH] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [cluster, setCluster] = useState<{ x: number; y: number; events: RedLogEvent[] } | null>(null)
  const [view, setView] = useState({ left: 0, width: 100 })
  const [drag, setDrag] = useState<{ x0: number; x1: number; w: number } | null>(null)
  const pendingView = useRef<{ t0: number } | null>(null)
  const [hiddenLanes, setHiddenLanes] = useState<Set<LaneId>>(new Set())
  const [showJson, setShowJson] = useState(false)
  const [operatorNames, setOperatorNames] = useState<Record<string, string>>({})

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
    dns: t('timeline.dns'),
    pivot: t('timeline.pivot'),
    screenshot: t('timeline.screenshot'),
    clipboard: t('timeline.clipboard'),
    file_transfer: t('timeline.files'),
    credential_use: t('timeline.credentialUse'),
    c2_checkin: t('timeline.c2Checkin'),
    marker: t('timeline.markers'),
    loot: t('timeline.loot'),
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
    for (const e of events) seen.add(toLane(e.agentType))
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
    window.redlog.events.query({ limit: 200 }).then((fetched) => {
      const newOnes = fetched.filter((e) => !eventsMapRef.current.has(e.id))
      if (newOnes.length === 0) setAllLoaded(true)
      else {
        newOnes.forEach((e) => eventsMapRef.current.set(e.id, e))
        setEvents(Array.from(eventsMapRef.current.values()).sort((a, b) => a.timestamp - b.timestamp))
      }
      setLoading(false)
    })
  }, [loading, allLoaded])

  useEffect(() => {
    window.redlog.events.query({ limit: 200 }).then((fetched) => {
      if (fetched.length < 200) setAllLoaded(true)
      fetched.forEach((e) => eventsMapRef.current.set(e.id, e))
      setEvents(Array.from(eventsMapRef.current.values()).sort((a, b) => a.timestamp - b.timestamp))
      setLoading(false)
    })
    const unsub = window.redlog.events.onNew((event) => {
      eventsMapRef.current.set(event.id, event)
      setEvents(Array.from(eventsMapRef.current.values()).sort((a, b) => a.timestamp - b.timestamp))
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
    for (const e of events) map[toLane(e.agentType)].push(e)
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
  }, [TRACK_W])

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
    const visible = events.filter((e) => !hiddenLanes.has(toLane(e.agentType)))
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
        setZoom((prev) => Math.min(6, Math.max(0.25, prev + (e.deltaY < 0 ? 0.15 : -0.15))))
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
  useEffect(() => {
    if (loading || didScrollToNow.current) return
    const el = scrollRef.current
    if (!el || el.clientWidth === 0) return
    const target = toX(Date.now()) - el.clientWidth + 80
    el.scrollLeft = Math.max(0, Math.min(target, TRACK_W - el.clientWidth))
    didScrollToNow.current = true
  }, [loading, toX, TRACK_W])

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

  const copyEventJson = useCallback(() => {
    if (!selectedEvent) return
    navigator.clipboard.writeText(JSON.stringify(selectedEvent, null, 2))
    toast(t('toast.copied'), 'success')
  }, [selectedEvent, t])

  if (loading && events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-zinc-700 border-t-red-500 rounded-full animate-spin-slow" />
          <span className="text-xs text-zinc-600">{t('common.loading')}</span>
        </div>
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
          <button onClick={loadMore} className="text-[10px] text-zinc-600 hover:text-zinc-300 ml-1 transition-colors">
            {t('timeline.loadMore')}
          </button>
        )}

        {/* Zoom controls */}
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            className="w-5 h-5 flex items-center justify-center text-[11px] text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 rounded transition-colors"
            title={t('timeline.zoomOut')}
          >−</button>
          <button
            onClick={() => setZoom(1)}
            className="px-1.5 h-5 flex items-center justify-center text-[10px] text-zinc-600 hover:text-zinc-300 bg-zinc-800/50 rounded font-mono tabular-nums transition-colors"
            title={t('timeline.resetZoom')}
          >{Math.round(zoom * 100)}%</button>
          <button
            onClick={() => setZoom((z) => Math.min(6, z + 0.25))}
            className="w-5 h-5 flex items-center justify-center text-[11px] text-zinc-500 hover:text-zinc-300 bg-zinc-800/50 rounded transition-colors"
            title={t('timeline.zoomIn')}
          >+</button>
        </div>

        {/* Lane filter toggles */}
        <div className="ml-auto flex gap-1">
          {LANES.map((id) => {
            const empty = !populatedLanes.has(id)
            const hidden = hiddenLanes.has(id)
            const off = empty || hidden
            return (
              <button
                key={id}
                onClick={() => !empty && toggleLane(id)}
                disabled={empty}
                className={`text-[10px] px-1.5 py-0.5 rounded font-mono transition-all ${
                  hidden ? 'opacity-30 line-through' : empty ? 'opacity-25 cursor-default' : ''
                }`}
                style={{
                  color: off ? '#525252' : LANE_COLORS[id],
                  backgroundColor: off ? 'transparent' : `${LANE_COLORS[id]}10`
                }}
                title={empty ? t('timeline.laneEmpty', { lane: laneLabels[id] }) : `${hidden ? 'Show' : 'Hide'} ${laneLabels[id]}`}
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
                    className="absolute text-[10px] text-zinc-600 font-mono tabular-nums -translate-x-1/2"
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
                {cluster && (
                  <div className="absolute z-30" style={{ left: Math.max(0, Math.min(cluster.x + 10, TRACK_W - 236)), top: cluster.y + 12, width: 228 }}>
                    <div className="rounded-md border border-zinc-700 bg-zinc-900/95 shadow-xl max-h-[210px] overflow-y-auto">
                      <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-800 sticky top-0 bg-zinc-900/95">
                        <span className="text-[10px] text-zinc-400 font-mono">{cluster.events.length} {t('timeline.title')}</span>
                        <button className="text-zinc-500 hover:text-zinc-200 text-xs leading-none" onClick={() => setCluster(null)}>×</button>
                      </div>
                      {cluster.events.map((evt) => (
                        <button
                          key={evt.id}
                          className="w-full text-left px-2 py-1 hover:bg-white/5 flex items-center gap-2"
                          onClick={() => { setSelectedEvent(evt); setCluster(null) }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: LANE_COLORS[toLane(evt.agentType)] }} />
                          <span className="text-zinc-600 font-mono text-[9px] tabular-nums shrink-0">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                          <span className="text-zinc-300 text-[10px] truncate">{eventTitle(evt)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Event log — bottom panel */}
        <div className="shrink-0 border-t border-zinc-800/60 bg-zinc-950/50" style={{ height: selectedEvent ? 160 : 180 }}>
          <div className="px-3 py-1.5 border-b border-zinc-800/40 flex items-center justify-between">
            <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">{t('timeline.title')}</span>
            <span className="text-[10px] text-zinc-600 font-mono tabular-nums">{recentEvents.length}</span>
          </div>
          <div className="overflow-y-auto" style={{ height: selectedEvent ? 128 : 148 }}>
            {recentEvents.map((evt) => {
              const lane = toLane(evt.agentType)
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

      {/* Enhanced detail panel */}
      {selectedEvent && (
        <div className="shrink-0 border-t border-zinc-700/50 px-4 py-3 bg-zinc-900/80 max-h-[240px] overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: LANE_COLORS[toLane(selectedEvent.agentType)] }} />
              <span className="text-[11px] font-mono font-semibold uppercase tracking-wider" style={{ color: LANE_COLORS[toLane(selectedEvent.agentType)] }}>
                {selectedEvent.agentType}
              </span>
              <span className="text-[10px] font-mono text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-800/60" title={selectedEvent.operatorId}>
                {operatorLabel(selectedEvent.operatorId)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowJson(!showJson)}
                className={`text-[10px] px-2 py-0.5 rounded transition-colors ${showJson ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
              >
                {t('timeline.fullData')}
              </button>
              <button
                onClick={copyEventJson}
                className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {t('timeline.copyJson')}
              </button>
              <button
                onClick={() => { setSelectedEvent(null); setShowJson(false) }}
                className="text-[10px] text-zinc-600 hover:text-zinc-300 transition-colors ml-1"
              >
                ✕
              </button>
              <span className="text-[10px] text-zinc-600 font-mono tabular-nums">{new Date(selectedEvent.timestamp).toLocaleString()}</span>
            </div>
          </div>
          <p className="text-[12px] text-zinc-300 mt-1.5 font-mono leading-relaxed">{eventTitle(selectedEvent)}</p>
          {selectedEvent.targetId && (
            <p className="text-[10px] text-zinc-500 mt-1 font-mono">{t('timeline.target', { target: selectedEvent.targetId })}</p>
          )}
          {showJson && (
            <pre className="mt-2 p-3 bg-zinc-950 rounded border border-zinc-800 text-[10px] text-zinc-400 font-mono overflow-x-auto leading-relaxed max-h-[120px] overflow-y-auto">
              {JSON.stringify(selectedEvent.data, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
