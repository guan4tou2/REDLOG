import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'

const MIN_LANE_H = 36
const LABEL_W = 72
const BASE_TRACK_W = 2000
const LANES = ['shell', 'screenshot', 'clipboard', 'file_transfer', 'marker', 'loot', 'system'] as const
type LaneId = (typeof LANES)[number]

const LANE_COLORS: Record<LaneId, string> = {
  shell: '#22c55e',
  screenshot: '#3b82f6',
  clipboard: '#a855f7',
  file_transfer: '#a78bfa',
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
      return 'Shell event'
    case 'screenshot':
      return `Screenshot (${d.trigger})`
    case 'clipboard':
      return `Clipboard: ${(d.content as string)?.slice(0, 60) || ''}...`
    case 'file_transfer':
      return `${d.direction}: ${d.filename || d.localPath || d.remotePath}`
    case 'marker':
      return `${(d.severity as string || 'info').toUpperCase()}: ${d.title}`
    case 'loot':
      return `Loot: ${d.type} (${d.confidence})`
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
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const eventsMapRef = useRef(new Map<string, RedLogEvent>())
  const isDragging = useRef(false)
  const dragStart = useRef({ x: 0, scroll: 0 })
  const { t } = useI18n()

  const laneLabels: Record<LaneId, string> = useMemo(() => ({
    shell: t('timeline.shell'),
    screenshot: t('timeline.screenshot'),
    clipboard: t('timeline.clipboard'),
    file_transfer: t('timeline.files'),
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

  const visibleLanes = useMemo(() => LANES.filter((l) => !hiddenLanes.has(l)), [hiddenLanes])

  const laneH = useMemo(() => {
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
    const map: Record<LaneId, RedLogEvent[]> = {
      shell: [], screenshot: [], clipboard: [], file_transfer: [],
      marker: [], loot: [], system: []
    }
    for (const e of events) map[toLane(e.agentType)].push(e)
    return map
  }, [events])

  const recentEvents = useMemo(() => {
    const visible = events.filter((e) => !hiddenLanes.has(toLane(e.agentType)))
    return [...visible].reverse().slice(0, 50)
  }, [events, hiddenLanes])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setZoom((prev) => Math.min(6, Math.max(0.25, prev + (e.deltaY < 0 ? 0.15 : -0.15))))
    }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
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
            const hidden = hiddenLanes.has(id)
            return (
              <button
                key={id}
                onClick={() => toggleLane(id)}
                className={`text-[10px] px-1.5 py-0.5 rounded font-mono transition-all ${
                  hidden ? 'opacity-30 line-through' : ''
                }`}
                style={{
                  color: hidden ? '#525252' : LANE_COLORS[id],
                  backgroundColor: hidden ? 'transparent' : `${LANE_COLORS[id]}10`
                }}
                title={`${hidden ? 'Show' : 'Hide'} ${laneLabels[id]}`}
              >
                {laneLabels[id]}
              </button>
            )
          })}
        </div>
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
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
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
                {/* Event dots */}
                {visibleLanes.map((lane, li) =>
                  laneEvents[lane].map((evt) => {
                    const x = toX(evt.timestamp)
                    const y = li * laneH + laneH / 2
                    const sel = selectedEvent?.id === evt.id
                    return (
                      <div
                        key={evt.id}
                        className="absolute cursor-pointer transition-transform hover:scale-[1.8]"
                        style={{
                          left: x - 4, top: y - 4, width: 8, height: 8,
                          borderRadius: '50%',
                          backgroundColor: LANE_COLORS[lane],
                          boxShadow: sel
                            ? `0 0 0 2px #0a0a0a, 0 0 0 3px ${LANE_COLORS[lane]}, 0 0 12px ${LANE_COLORS[lane]}60`
                            : `0 0 6px ${LANE_COLORS[lane]}30`,
                          zIndex: sel ? 10 : 1
                        }}
                        title={`${new Date(evt.timestamp).toLocaleTimeString()} — ${eventTitle(evt)}`}
                        onClick={() => setSelectedEvent(sel ? null : evt)}
                      />
                    )
                  })
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
                  <span className="text-zinc-500 font-mono shrink-0 max-w-[80px] truncate" title={evt.operatorId}>
                    {operatorLabel(evt.operatorId)}
                  </span>
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
