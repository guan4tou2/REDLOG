import { useState, useEffect } from 'react'

interface TargetEntry {
  target: string
  commands: string[]
  firstSeen: number
  lastSeen: number
  inScope: boolean | null
  eventCount: number
}

export function TargetView(): JSX.Element {
  const [targets, setTargets] = useState<TargetEntry[]>([])
  const [filter, setFilter] = useState<'all' | 'in_scope' | 'out_scope'>('all')

  useEffect(() => {
    loadTargets()
    const unsub = window.redlog.events.onNew((evt) => {
      if (evt.data?.detectedTarget) loadTargets()
    })
    return unsub
  }, [])

  async function loadTargets(): Promise<void> {
    const events = await window.redlog.events.query({ agentType: 'terminal' })
    const map = new Map<string, TargetEntry>()
    for (const evt of events) {
      const t = evt.data?.detectedTarget as string | undefined
      if (!t) continue
      const existing = map.get(t)
      if (existing) {
        existing.commands.push(evt.data.command as string)
        existing.lastSeen = Math.max(existing.lastSeen, evt.timestamp)
        existing.firstSeen = Math.min(existing.firstSeen, evt.timestamp)
        existing.eventCount++
      } else {
        map.set(t, {
          target: t,
          commands: [evt.data.command as string],
          firstSeen: evt.timestamp,
          lastSeen: evt.timestamp,
          inScope: null,
          eventCount: 1
        })
      }
    }
    setTargets(Array.from(map.values()).sort((a, b) => b.lastSeen - a.lastSeen))
  }

  const filtered = targets.filter((t) => {
    if (filter === 'in_scope') return t.inScope === true
    if (filter === 'out_scope') return t.inScope === false
    return true
  })

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Targets ({targets.length})</h2>
        <div className="flex gap-1">
          {(['all', 'in_scope', 'out_scope'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 text-xs rounded ${
                filter === f
                  ? 'bg-red-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
              }`}
            >
              {f === 'all' ? 'All' : f === 'in_scope' ? 'In Scope' : 'Out of Scope'}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-zinc-500 text-sm">No targets detected yet. Run commands in the terminal to auto-catalog targets.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <div key={t.target} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-white font-mono text-sm">{t.target}</span>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500 text-xs">{t.eventCount} cmds</span>
                  {t.inScope === false && (
                    <span className="text-red-400 text-xs bg-red-400/10 px-1.5 py-0.5 rounded">OUT</span>
                  )}
                </div>
              </div>
              <div className="mt-1 text-zinc-500 text-xs">
                First: {new Date(t.firstSeen).toLocaleTimeString()} · Last: {new Date(t.lastSeen).toLocaleTimeString()}
              </div>
              <div className="mt-2 space-y-0.5 max-h-24 overflow-y-auto">
                {t.commands.slice(-5).map((cmd, i) => (
                  <div key={i} className="text-zinc-400 text-xs font-mono truncate">{cmd}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
