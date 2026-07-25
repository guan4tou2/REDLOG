import { useEffect, useState } from 'react'

const TYPE_COLORS: Record<string, string> = {
  terminal: '#22c55e',
  screenshot: '#3b82f6',
  clipboard: '#a855f7',
  marker: '#ef4444',
  system: '#737373'
}

const TYPE_ICONS: Record<string, string> = {
  terminal: '▸',
  screenshot: '◻',
  clipboard: '⎘',
  marker: '◆',
  system: '○'
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false })
}

function eventSummary(event: RedLogEvent): string {
  const d = event.data
  switch (event.agentType) {
    case 'terminal':
      if (d.subtype === 'command') return `$ ${(d.command as string).slice(0, 80)}`
      if (d.subtype === 'session_start') return `Session started (${d.shell})`
      if (d.subtype === 'session_end') return `Session ended (exit ${d.exitCode})`
      return 'Terminal event'
    case 'screenshot':
      return `Screenshot (${d.trigger})`
    case 'clipboard':
      return `Clipboard: ${(d.content as string).slice(0, 60)}...`
    case 'marker':
      return `${(d.severity as string).toUpperCase()}: ${d.title}`
    default:
      return event.agentType
  }
}

export default function TimelinePanel(): JSX.Element {
  const [events, setEvents] = useState<RedLogEvent[]>([])
  const [filter, setFilter] = useState<string | null>(null)

  useEffect(() => {
    window.redlog.events.query({ limit: 500 }).then(setEvents)
    return window.redlog.events.onNew((event) => {
      setEvents((prev) => [event, ...prev].slice(0, 500))
    })
  }, [])

  const filtered = filter ? events.filter((e) => e.agentType === filter) : events

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-redlog-border shrink-0">
        <span className="text-xs text-neutral-400">Timeline</span>
        <span className="text-xs text-neutral-600">({filtered.length} events)</span>
        <div className="ml-auto flex gap-1">
          {['terminal', 'screenshot', 'clipboard', 'marker'].map((type) => (
            <button
              key={type}
              onClick={() => setFilter(filter === type ? null : type)}
              className={`px-2 py-0.5 text-[10px] rounded-full border transition-colors
                ${filter === type
                  ? 'border-current opacity-100'
                  : 'border-neutral-700 opacity-50 hover:opacity-80'
                }`}
              style={{ color: TYPE_COLORS[type] }}
            >
              {TYPE_ICONS[type]} {type}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
            No events yet — start recording
          </div>
        ) : (
          <div className="divide-y divide-neutral-800/50">
            {filtered.map((event) => (
              <div key={event.id} className="flex items-start gap-3 px-3 py-2 hover:bg-neutral-900/50">
                <span
                  className="text-sm mt-0.5 shrink-0"
                  style={{ color: TYPE_COLORS[event.agentType] ?? '#737373' }}
                >
                  {TYPE_ICONS[event.agentType] ?? '○'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-neutral-300 truncate font-mono">
                    {eventSummary(event)}
                  </p>
                  {event.targetId && (
                    <p className="text-[10px] text-neutral-500 mt-0.5">→ {event.targetId}</p>
                  )}
                </div>
                <span className="text-[10px] text-neutral-600 font-mono shrink-0 mt-0.5">
                  {formatTime(event.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
