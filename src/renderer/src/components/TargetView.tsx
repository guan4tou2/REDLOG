import { useState, useEffect, useCallback } from 'react'

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
  const [selected, setSelected] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<RedLogEvent[]>([])

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

  const loadEvidence = useCallback(async (target: string) => {
    if (selected === target) {
      setSelected(null)
      setEvidence([])
      return
    }
    setSelected(target)
    const allEvents = await window.redlog.events.query({ limit: 500 })
    const filtered = allEvents.filter((e) => {
      if (e.targetId === target) return true
      if (e.data?.detectedTarget === target) return true
      if (e.agentType === 'scope_violation' && e.data?.target === target) return true
      return false
    })
    setEvidence(filtered.sort((a, b) => b.timestamp - a.timestamp))
  }, [selected])

  const filtered = targets.filter((t) => {
    if (filter === 'in_scope') return t.inScope === true
    if (filter === 'out_scope') return t.inScope === false
    return true
  })

  const agentIcon: Record<string, string> = {
    terminal: 'T',
    screenshot: 'S',
    clipboard: 'C',
    file_transfer: 'F',
    marker: 'M',
    loot: 'L',
    system: '!',
  }

  const agentColor: Record<string, string> = {
    terminal: 'text-green-400',
    screenshot: 'text-blue-400',
    clipboard: 'text-yellow-400',
    file_transfer: 'text-purple-400',
    marker: 'text-red-400',
    loot: 'text-orange-400',
    system: 'text-zinc-400',
  }

  return (
    <div className="p-4 space-y-4 h-full overflow-auto">
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
            <div key={t.target}>
              <div
                onClick={() => loadEvidence(t.target)}
                className={`bg-zinc-900 border rounded-lg p-3 cursor-pointer transition-colors ${
                  selected === t.target ? 'border-red-600' : 'border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-white font-mono text-sm">{t.target}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-500 text-xs">{t.eventCount} cmds</span>
                    {t.inScope === false && (
                      <span className="text-red-400 text-xs bg-red-400/10 px-1.5 py-0.5 rounded">OUT</span>
                    )}
                    <span className="text-zinc-600 text-xs">{selected === t.target ? '▾' : '▸'}</span>
                  </div>
                </div>
                <div className="mt-1 text-zinc-500 text-xs">
                  First: {new Date(t.firstSeen).toLocaleTimeString()} · Last: {new Date(t.lastSeen).toLocaleTimeString()}
                </div>
              </div>

              {selected === t.target && (
                <div className="ml-4 mt-1 border-l-2 border-zinc-800 pl-3 space-y-1 py-2">
                  {evidence.length === 0 ? (
                    <p className="text-zinc-600 text-xs">No evidence linked to this target.</p>
                  ) : (
                    <>
                      <div className="flex gap-2 mb-2">
                        {Object.entries(
                          evidence.reduce<Record<string, number>>((acc, e) => {
                            acc[e.agentType] = (acc[e.agentType] || 0) + 1
                            return acc
                          }, {})
                        ).map(([type, count]) => (
                          <span key={type} className={`text-[10px] ${agentColor[type] || 'text-zinc-400'} bg-zinc-800 px-1.5 py-0.5 rounded`}>
                            {type}: {count}
                          </span>
                        ))}
                      </div>
                      {evidence.slice(0, 20).map((e) => (
                        <div key={e.id} className="flex items-start gap-2 text-xs">
                          <span className={`font-mono font-bold w-4 shrink-0 ${agentColor[e.agentType] || 'text-zinc-400'}`}>
                            {agentIcon[e.agentType] || '?'}
                          </span>
                          <span className="text-zinc-600 w-16 shrink-0">
                            {new Date(e.timestamp).toLocaleTimeString()}
                          </span>
                          <span className="text-zinc-300 truncate">
                            {e.agentType === 'terminal' && (e.data.command as string)}
                            {e.agentType === 'screenshot' && `Screenshot: ${e.data.filename as string}`}
                            {e.agentType === 'clipboard' && `Clipboard: ${(e.data.content as string)?.slice(0, 60) || ''}`}
                            {e.agentType === 'file_transfer' && `${e.data.direction}: ${e.data.filename || e.data.localPath || e.data.remotePath}`}
                            {e.agentType === 'marker' && `[${e.data.severity}] ${e.data.title}`}
                            {e.agentType === 'loot' && `Loot: ${e.data.type} (${e.data.confidence})`}
                            {!['terminal', 'screenshot', 'clipboard', 'file_transfer', 'marker', 'loot'].includes(e.agentType) && JSON.stringify(e.data).slice(0, 80)}
                          </span>
                        </div>
                      ))}
                      {evidence.length > 20 && (
                        <p className="text-zinc-600 text-[10px]">... and {evidence.length - 20} more</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
