import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useI18n } from '../i18n'

const LANE_HEIGHT = 36
const LABEL_WIDTH = 72
const LANES = ['shell', 'screenshot', 'clipboard', 'file_transfer', 'marker', 'loot', 'system'] as const
type LaneId = (typeof LANES)[number]

const LANE_COLORS: Record<LaneId, string> = {
  shell: '#22c55e',
  screenshot: '#3b82f6',
  clipboard: '#a855f7',
  file_transfer: '#a78bfa',
  marker: '#ef4444',
  loot: '#f97316',
  system: '#737373'
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
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const eventsMapRef = useRef(new Map<string, RedLogEvent>())
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

  const loadMore = useCallback(() => {
    if (loading || allLoaded) return
    setLoading(true)
    window.redlog.events.query({ limit: 200 }).then((fetched) => {
      const newOnes = fetched.filter((e) => !eventsMapRef.current.has(e.id))
      if (newOnes.length === 0) {
        setAllLoaded(true)
      } else {
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

  const TRACK_W = 2000
  const timeSpan = timeEnd - timeStart

  const toX = useCallback(
    (ts: number) => ((ts - timeStart) / timeSpan) * TRACK_W,
    [timeStart, timeSpan]
  )

  const laneEvents = useMemo(() => {
    const map: Record<LaneId, RedLogEvent[]> = {
      shell: [], screenshot: [], clipboard: [], file_transfer: [],
      marker: [], loot: [], system: []
    }
    for (const e of events) {
      map[toLane(e.agentType)].push(e)
    }
    return map
  }, [events])

  const totalH = LANES.length * LANE_HEIGHT

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-redlog-border shrink-0 bg-redlog-bg">
        <span className="text-sm font-semibold text-zinc-300">{t('timeline.title')}</span>
        <span className="text-[11px] text-zinc-600 font-mono tabular-nums">
          {t('timeline.events', { count: events.length })}
        </span>
        {!allLoaded && (
          <button
            onClick={loadMore}
            className="text-[10px] text-zinc-600 hover:text-zinc-300 ml-1 transition-colors"
          >
            {t('timeline.loadMore')}
          </button>
        )}
        <div className="ml-auto flex gap-1">
          {LANES.map((id) => (
            <span
              key={id}
              className="text-[10px] px-1.5 py-0.5 rounded-sm font-mono"
              style={{ color: LANE_COLORS[id], backgroundColor: `${LANE_COLORS[id]}12` }}
            >
              {laneLabels[id]}
            </span>
          ))}
        </div>
      </div>

      {/* Timeline body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Lane labels (fixed) */}
        <div className="shrink-0 border-r border-redlog-border" style={{ width: LABEL_WIDTH }}>
          <div className="h-6 border-b border-redlog-border" />
          {LANES.map((id) => (
            <div
              key={id}
              className="flex items-center px-2 border-b border-zinc-900/60 font-mono text-[11px] text-zinc-500"
              style={{ height: LANE_HEIGHT }}
            >
              {laneLabels[id]}
            </div>
          ))}
        </div>

        {/* Scrollable track */}
        <div ref={scrollRef} className="flex-1 overflow-x-auto overflow-y-hidden">
          <div style={{ width: TRACK_W, position: 'relative' }}>
            {/* Time axis */}
            <div className="h-6 border-b border-redlog-border relative">
              {ticks.map((ts) => (
                <span
                  key={ts}
                  className="absolute text-[10px] text-zinc-600 font-mono tabular-nums -translate-x-1/2"
                  style={{ left: toX(ts), top: 4 }}
                >
                  {formatTimeLabel(new Date(ts))}
                </span>
              ))}
            </div>

            {/* Swim lanes */}
            <div style={{ height: totalH, position: 'relative' }}>
              {/* Grid lines */}
              {LANES.map((_, i) => (
                <div
                  key={i}
                  className="absolute w-full border-b border-zinc-900/60"
                  style={{ top: (i + 1) * LANE_HEIGHT }}
                />
              ))}
              {/* Vertical grid lines */}
              {ticks.map((ts) => (
                <div
                  key={ts}
                  className="absolute top-0 border-l border-zinc-900/40"
                  style={{ left: toX(ts), height: totalH }}
                />
              ))}

              {/* Current time line */}
              {Date.now() >= timeStart && Date.now() <= timeEnd && (
                <div
                  className="absolute top-0 w-px bg-red-500"
                  style={{ left: toX(Date.now()), height: totalH }}
                />
              )}

              {/* Event dots */}
              {LANES.map((lane, laneIdx) =>
                laneEvents[lane].map((evt) => {
                  const x = toX(evt.timestamp)
                  const y = laneIdx * LANE_HEIGHT + LANE_HEIGHT / 2
                  const isSelected = selectedEvent?.id === evt.id
                  return (
                    <div
                      key={evt.id}
                      className="absolute cursor-pointer transition-transform hover:scale-150"
                      style={{
                        left: x - 4,
                        top: y - 4,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        backgroundColor: LANE_COLORS[lane],
                        boxShadow: isSelected
                          ? `0 0 0 2px #0a0a0a, 0 0 0 4px ${LANE_COLORS[lane]}`
                          : `0 0 4px ${LANE_COLORS[lane]}40`,
                        zIndex: isSelected ? 10 : 1
                      }}
                      title={`${new Date(evt.timestamp).toLocaleTimeString()} — ${eventTitle(evt)}`}
                      onClick={() => setSelectedEvent(selectedEvent?.id === evt.id ? null : evt)}
                    />
                  )
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Detail panel */}
      {selectedEvent && (
        <div className="shrink-0 border-t border-redlog-border p-4 bg-redlog-surface max-h-44 overflow-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: LANE_COLORS[toLane(selectedEvent.agentType)] }}
              />
              <span
                className="text-xs font-mono font-semibold uppercase tracking-wider"
                style={{ color: LANE_COLORS[toLane(selectedEvent.agentType)] }}
              >
                {selectedEvent.agentType}
              </span>
            </div>
            <span className="text-[10px] text-zinc-600 font-mono tabular-nums">
              {new Date(selectedEvent.timestamp).toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-zinc-300 mt-2 font-mono leading-relaxed">
            {eventTitle(selectedEvent)}
          </p>
          {selectedEvent.targetId && (
            <p className="text-[10px] text-zinc-500 mt-1.5 font-mono">
              {t('timeline.target', { target: selectedEvent.targetId })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
