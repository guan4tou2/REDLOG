import { useEffect, useRef, useState, useCallback } from 'react'
import { Timeline, DataSet } from 'vis-timeline/standalone'
import 'vis-timeline/styles/vis-timeline-graph2d.min.css'

const GROUPS = [
  { id: 'terminal', content: 'Terminal', className: 'lane-terminal' },
  { id: 'screenshot', content: 'Screenshot', className: 'lane-screenshot' },
  { id: 'clipboard', content: 'Clipboard', className: 'lane-clipboard' },
  { id: 'file_transfer', content: 'Files', className: 'lane-file' },
  { id: 'marker', content: 'Markers', className: 'lane-marker' },
  { id: 'loot', content: 'Loot', className: 'lane-loot' },
  { id: 'system', content: 'System', className: 'lane-system' }
]

const TYPE_COLORS: Record<string, string> = {
  terminal: '#22c55e',
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
    case 'terminal':
      if (d.subtype === 'command') return `$ ${(d.command as string).slice(0, 100)}`
      if (d.subtype === 'session_start') return `Session started (${d.shell})`
      if (d.subtype === 'session_end') return `Session ended (exit ${d.exitCode})`
      return 'Terminal event'
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

function toTimelineItem(event: RedLogEvent): {
  id: string; start: Date; group: string; content: string;
  className: string; title: string; type: string
} {
  const group = GROUPS.find((g) => g.id === event.agentType) ? event.agentType : 'system'
  const color = TYPE_COLORS[group] || '#737373'
  return {
    id: event.id,
    start: new Date(event.timestamp),
    group,
    content: '',
    className: `item-${group}`,
    title: `${new Date(event.timestamp).toLocaleTimeString()} — ${eventTitle(event)}${event.targetId ? ` → ${event.targetId}` : ''}`,
    type: 'point'
  }
}

export default function TimelinePanel(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const timelineRef = useRef<Timeline | null>(null)
  const itemsRef = useRef<DataSet<{ id: string; start: Date; group: string; content: string; className: string; title: string; type: string }> | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<RedLogEvent | null>(null)
  const [eventCount, setEventCount] = useState(0)
  const eventsMapRef = useRef(new Map<string, RedLogEvent>())

  const initTimeline = useCallback((events: RedLogEvent[]) => {
    if (!containerRef.current) return

    const items = new DataSet(events.map(toTimelineItem))
    itemsRef.current = items
    events.forEach((e) => eventsMapRef.current.set(e.id, e))
    setEventCount(events.length)

    const groups = new DataSet(GROUPS)

    const now = new Date()
    const oneHourAgo = new Date(now.getTime() - 3600000)

    const tl = new Timeline(containerRef.current, items, groups, {
      height: '100%',
      start: events.length > 0 ? new Date(events[events.length - 1].timestamp - 60000) : oneHourAgo,
      end: events.length > 0 ? new Date(events[0].timestamp + 60000) : now,
      zoomMin: 5000,
      zoomMax: 86400000,
      stack: false,
      showCurrentTime: true,
      orientation: { axis: 'top' },
      margin: { item: 2 },
      tooltip: { followMouse: true, overflowMethod: 'flip' }
    })

    tl.on('select', (props: { items: string[] }) => {
      if (props.items.length > 0) {
        const evt = eventsMapRef.current.get(props.items[0])
        setSelectedEvent(evt || null)
      } else {
        setSelectedEvent(null)
      }
    })

    timelineRef.current = tl
  }, [])

  useEffect(() => {
    window.redlog.events.query({ limit: 1000 }).then((events) => {
      initTimeline(events)
    })

    const unsub = window.redlog.events.onNew((event) => {
      eventsMapRef.current.set(event.id, event)
      setEventCount((c) => c + 1)
      if (itemsRef.current) {
        try { itemsRef.current.add(toTimelineItem(event)) } catch { /* dup */ }
      }
    })

    return () => {
      unsub()
      timelineRef.current?.destroy()
      timelineRef.current = null
    }
  }, [initTimeline])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-redlog-border shrink-0">
        <span className="text-xs text-neutral-400">Attack Timeline</span>
        <span className="text-xs text-neutral-600">({eventCount} events)</span>
        <div className="ml-auto flex gap-1">
          {GROUPS.slice(0, 5).map((g) => (
            <span
              key={g.id}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ color: TYPE_COLORS[g.id], backgroundColor: `${TYPE_COLORS[g.id]}15` }}
            >
              {g.content}
            </span>
          ))}
        </div>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 vis-dark" />

      {selectedEvent && (
        <div className="shrink-0 border-t border-redlog-border p-3 bg-zinc-900 max-h-40 overflow-auto">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono" style={{ color: TYPE_COLORS[selectedEvent.agentType] || '#737373' }}>
              {selectedEvent.agentType}
            </span>
            <span className="text-[10px] text-zinc-500">
              {new Date(selectedEvent.timestamp).toLocaleString()}
            </span>
          </div>
          <p className="text-xs text-zinc-300 mt-1 font-mono">{eventTitle(selectedEvent)}</p>
          {selectedEvent.targetId && (
            <p className="text-[10px] text-zinc-500 mt-0.5">Target: {selectedEvent.targetId}</p>
          )}
        </div>
      )}
    </div>
  )
}
