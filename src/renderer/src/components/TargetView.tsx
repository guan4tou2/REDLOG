import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '../i18n'
import { HudPanel } from './Hud'

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
  const { t } = useI18n()

  useEffect(() => {
    loadTargets()
    const unsub = window.redlog.events.onNew((evt) => {
      if (evt.data?.detectedTarget) loadTargets()
    })
    return unsub
  }, [])

  async function loadTargets(): Promise<void> {
    const events = await window.redlog.events.query({ agentType: 'shell' })
    const map = new Map<string, TargetEntry>()
    for (const evt of events) {
      const tgt = evt.data?.detectedTarget as string | undefined
      if (!tgt) continue
      const existing = map.get(tgt)
      if (existing) {
        existing.commands.push(evt.data.command as string)
        existing.lastSeen = Math.max(existing.lastSeen, evt.timestamp)
        existing.firstSeen = Math.min(existing.firstSeen, evt.timestamp)
        existing.eventCount++
      } else {
        map.set(tgt, {
          target: tgt,
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

  const filtered = targets.filter((tgt) => {
    if (filter === 'in_scope') return tgt.inScope === true
    if (filter === 'out_scope') return tgt.inScope === false
    return true
  })

  const agentIcon: Record<string, string> = {
    shell: 'T', screenshot: 'S', clipboard: 'C',
    file_transfer: 'F', marker: 'M', loot: 'L', system: '!'
  }

  const agentColor: Record<string, string> = {
    shell: 'text-green-400', screenshot: 'text-blue-400', clipboard: 'text-yellow-400',
    file_transfer: 'text-purple-400', marker: 'text-red-400', loot: 'text-orange-400', system: 'text-zinc-400'
  }

  return (
    <div className="p-4 space-y-4 h-full overflow-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{t('targets.title', { count: targets.length })}</h2>
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
              {f === 'all' ? t('targets.all') : f === 'in_scope' ? t('targets.inScope') : t('targets.outOfScope')}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-zinc-500 text-sm">{t('targets.empty')}</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((tgt) => (
            <div key={tgt.target}>
              <HudPanel tone={tgt.inScope === false ? 'red' : selected === tgt.target ? 'cyan' : 'neutral'}>
              <div onClick={() => loadEvidence(tgt.target)} className="p-3 cursor-pointer">
                <div className="flex items-center justify-between">
                  <span className="text-white font-mono text-sm">{tgt.target}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-zinc-500 text-xs">{t('targets.cmds', { count: tgt.eventCount })}</span>
                    {tgt.inScope === false && (
                      <span className="text-red-400 text-xs bg-red-400/10 px-1.5 py-0.5 rounded">{t('targets.out')}</span>
                    )}
                    <span className="text-zinc-600 text-xs">{selected === tgt.target ? '▾' : '▸'}</span>
                  </div>
                </div>
                <div className="mt-1 text-zinc-500 text-xs">
                  {t('targets.first', { time: new Date(tgt.firstSeen).toLocaleTimeString() })} · {t('targets.last', { time: new Date(tgt.lastSeen).toLocaleTimeString() })}
                </div>
              </div>
              </HudPanel>

              {selected === tgt.target && (
                <div className="ml-4 mt-1 border-l-2 border-zinc-800 pl-3 space-y-1 py-2">
                  {evidence.length === 0 ? (
                    <p className="text-zinc-600 text-xs">{t('targets.noEvidence')}</p>
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
                            {e.agentType === 'shell' && (e.data.command as string)}
                            {e.agentType === 'screenshot' && `Screenshot: ${e.data.filename as string}`}
                            {e.agentType === 'clipboard' && `Clipboard: ${(e.data.content as string)?.slice(0, 60) || ''}`}
                            {e.agentType === 'file_transfer' && `${e.data.direction}: ${e.data.filename || e.data.localPath || e.data.remotePath}`}
                            {e.agentType === 'marker' && `[${e.data.severity}] ${e.data.title}`}
                            {e.agentType === 'loot' && `Loot: ${e.data.type} (${e.data.confidence})`}
                            {!['shell', 'screenshot', 'clipboard', 'file_transfer', 'marker', 'loot'].includes(e.agentType) && JSON.stringify(e.data).slice(0, 80)}
                          </span>
                        </div>
                      ))}
                      {evidence.length > 20 && (
                        <p className="text-zinc-600 text-[10px]">{t('targets.andMore', { count: evidence.length - 20 })}</p>
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
