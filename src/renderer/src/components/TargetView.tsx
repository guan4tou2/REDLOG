import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'

interface TargetEntry {
  target: string
  commands: string[]
  firstSeen: number
  lastSeen: number
  inScope: boolean | null
  eventCount: number
}

// Match a target string against a scope pattern (subset of scope-monitor's rules
// — enough for UI classification, not enforcement). Handles wildcard subdomains
// (`*.example.com`) and CIDR (`10.0.0.0/24`). Anything else is exact-match.
function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o), 0) >>> 0
}
function matchesScope(target: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const bare = pattern.slice(2)
    return target === bare || target.endsWith('.' + bare)
  }
  if (pattern.includes('/')) {
    const [net, bits] = pattern.split('/')
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) return false
    const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0
    return (ipToLong(target) & mask) === (ipToLong(net) & mask)
  }
  return target === pattern
}

export function TargetView(): JSX.Element {
  const [targets, setTargets] = useState<TargetEntry[]>([])
  const [filter, setFilter] = useState<'all' | 'in_scope' | 'out_scope'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<RedLogEvent[]>([])
  // Scope target list from project config — used to compute the inScope column
  // on each target. Empty when config isn't set (in which case every target
  // shows as "in-scope" since there's no rule to violate).
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const { t } = useI18n()

  useEffect(() => {
    // Refresh both on mount and whenever the operator saves settings — the
    // auto-save (v0.6.21) doesn't broadcast, but any nav back to this view
    // will re-mount and pick up the current config.
    window.redlog.config.get().then((c) => {
      const cfg = c as { scope?: { targets?: string[] } } | null
      setScopeTargets(cfg?.scope?.targets ?? [])
    }).catch(() => {})
    loadTargets()
    const unsub = window.redlog.events.onNew((evt) => {
      if (evt.data?.detectedTarget) loadTargets()
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reclassify existing targets whenever scope config changes (e.g. operator
  // added a scope entry after seeing an out-of-scope hit).
  useEffect(() => { if (targets.length > 0) loadTargets() }, [scopeTargets])

  async function loadTargets(): Promise<void> {
    // Include every event type that carries detectedTarget in data — not only
    // shell (audit finding #34). Loot / http_navigation / screenshots can all
    // reference targets and were invisible here before.
    const events = await window.redlog.events.query({ limit: 1000 })
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
    // Classify each target as in-scope / out-of-scope based on the current
    // scope config (audit finding #33 — before this the field was set to null
    // and both filter chips returned empty). If scope is unset, treat every
    // target as in-scope (no rule to violate).
    const list = Array.from(map.values()).sort((a, b) => b.lastSeen - a.lastSeen)
    for (const entry of list) {
      if (scopeTargets.length === 0) { entry.inScope = true; continue }
      entry.inScope = scopeTargets.some((p) => matchesScope(entry.target, p))
    }
    setTargets(list)
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
      // Scope violations are agent_type='system' with subtype='scope_violation';
      // the prior code checked agent_type='scope_violation' which never matched
      // (audit finding P0 #4), so this target's scope hits were invisible.
      if (e.agentType === 'system' && e.data?.subtype === 'scope_violation' && e.data?.target === target) return true
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
    file_transfer: 'text-purple-400', marker: 'text-red-400', loot: 'text-orange-400', system: 'text-redlog-text-dim'
  }

  return (
    <div className="p-4 space-y-4 h-full overflow-auto">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('targets.title', { count: targets.length })}</h2>
          <p className="text-xs text-redlog-text-dim mt-0.5 max-w-xl">{t('targets.subtitle')}</p>
        </div>
        <div className="flex gap-1">
          {(['all', 'in_scope', 'out_scope'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 text-xs rounded ${
                filter === f
                  ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
                  : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
              }`}
            >
              {f === 'all' ? t('targets.all') : f === 'in_scope' ? t('targets.inScope') : t('targets.outOfScope')}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="text-redlog-text-dim text-sm">{t('targets.empty')}</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((tgt) => (
            <div key={tgt.target}>
              <div
                onClick={() => loadEvidence(tgt.target)}
                className={`bg-redlog-surface border rounded-lg p-3 cursor-pointer transition-colors ${
                  selected === tgt.target ? 'border-red-600' : 'border-redlog-border hover:border-redlog-border'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-white font-mono text-sm">{tgt.target}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-redlog-text-dim text-xs">{t('targets.cmds', { count: tgt.eventCount })}</span>
                    {tgt.inScope === false && (
                      <>
                        <span className="text-red-400 text-xs bg-red-400/10 px-1.5 py-0.5 rounded">{t('targets.out')}</span>
                        <button
                          onClick={async (e) => {
                            // One-click round-trip to Settings ▸ Scope: append
                            // this target to config.scope.targets and reload
                            // scope config (audit #36).
                            e.stopPropagation()
                            const cfg = await window.redlog.config.get() as { scope?: { targets?: string[] } } | null
                            const cur = cfg?.scope?.targets ?? []
                            if (cur.includes(tgt.target)) return
                            const next = { ...(cfg ?? {}), scope: { ...(cfg?.scope ?? {}), targets: [...cur, tgt.target] } }
                            await window.redlog.config.save(next as unknown as Parameters<typeof window.redlog.config.save>[0])
                            setScopeTargets((prev) => prev.includes(tgt.target) ? prev : [...prev, tgt.target])
                          }}
                          className="text-xs text-emerald-500 hover:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 px-1.5 py-0.5 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/40"
                          title={t('targets.addToScope')}
                          aria-label={t('targets.addToScope')}
                        >+ 範圍</button>
                      </>
                    )}
                    <span className="text-redlog-text-faint text-xs">{selected === tgt.target ? '▾' : '▸'}</span>
                  </div>
                </div>
                <div className="mt-1 text-redlog-text-dim text-xs">
                  {t('targets.first', { time: formatTime(tgt.firstSeen, { seconds: true }) })} · {t('targets.last', { time: formatTime(tgt.lastSeen, { seconds: true }) })}
                </div>
              </div>

              {selected === tgt.target && (
                <div className="ml-4 mt-1 border-l-2 border-redlog-border pl-3 space-y-1 py-2">
                  {evidence.length === 0 ? (
                    <p className="text-redlog-text-faint text-xs">{t('targets.noEvidence')}</p>
                  ) : (
                    <>
                      <div className="flex gap-2 mb-2">
                        {Object.entries(
                          evidence.reduce<Record<string, number>>((acc, e) => {
                            acc[e.agentType] = (acc[e.agentType] || 0) + 1
                            return acc
                          }, {})
                        ).map(([type, count]) => (
                          <span key={type} className={`text-xs ${agentColor[type] || 'text-redlog-text-dim'} bg-redlog-elevated px-1.5 py-0.5 rounded`}>
                            {type}: {count}
                          </span>
                        ))}
                      </div>
                      {evidence.slice(0, 20).map((e) => (
                        <div key={e.id} className="flex items-start gap-2 text-xs">
                          <span className={`font-mono font-bold w-4 shrink-0 ${agentColor[e.agentType] || 'text-redlog-text-dim'}`}>
                            {agentIcon[e.agentType] || '?'}
                          </span>
                          <span className="text-redlog-text-faint w-16 shrink-0">
                            {formatTime(e.timestamp, { seconds: true })}
                          </span>
                          <span className="text-redlog-text truncate">
                            {e.agentType === 'shell' && (e.data.command as string)}
                            {e.agentType === 'screenshot' && `Screenshot: ${e.data.filename as string}`}
                            {e.agentType === 'clipboard' && `Clipboard: ${(e.data.content as string)?.slice(0, 60) || ''}`}
                            {e.agentType === 'file_transfer' && `${e.data.direction}: ${e.data.filename || e.data.localPath || e.data.remotePath}`}
                            {e.agentType === 'marker' && `[${e.data.severity}] ${e.data.title}`}
                            {e.agentType === 'loot' && (() => { const m = (e.data.matches as Array<{ type: string; confidence: string }>)?.[0]; return m ? `Loot: ${m.type.replace(/_/g, ' ')} (${m.confidence})` : `Loot: ${e.data.count ?? 0} detected` })()}
                            {!['shell', 'screenshot', 'clipboard', 'file_transfer', 'marker', 'loot'].includes(e.agentType) && JSON.stringify(e.data).slice(0, 80)}
                          </span>
                        </div>
                      ))}
                      {evidence.length > 20 && (
                        <p className="text-redlog-text-faint text-xs">{t('targets.andMore', { count: evidence.length - 20 })}</p>
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
