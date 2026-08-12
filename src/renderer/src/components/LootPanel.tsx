import { useState, useEffect, useMemo } from 'react'
import { useI18n } from '../i18n'
import { LoadingSpinner, EmptyState } from './Feedback'
import { emptyStateFor } from '../lib/emptyState'
import { toast } from './Toast'

export function LootPanel({ onOpenInTimeline, onEmptyAction }: {
  onOpenInTimeline?: (eventId: string, ts: number) => void
  onEmptyAction?: (target: string) => void
}): JSX.Element {
  const [lootEvents, setLootEvents] = useState<Array<{
    id: string
    timestamp: number
    targetId: string | null
    source: string | null
    matches: Array<{ type: string; confidence: string; preview: string }>
  }>>([])
  const [loading, setLoading] = useState(true)
  // Filter by loot type; null = show all. Chips appear at the top with counts.
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  // Dedup toggle: same (type, preview) captured from two commands used to
  // appear twice — audit finding #18. Default on; a chip toggles it off if
  // the operator wants the raw stream (e.g. verifying detection cadence).
  const [dedupOn, setDedupOn] = useState(true)
  const { t } = useI18n()

  useEffect(() => {
    loadLoot().then(() => setLoading(false))
    const unsub = window.redlog.events.onNew((evt) => {
      if (evt.agentType === 'loot') {
        loadLoot()
      }
    })
    return unsub
  }, [])

  async function loadLoot(): Promise<void> {
    const events = await window.redlog.events.query({ agentType: 'loot' })
    setLootEvents(
      events.map((e) => ({
        id: e.id,
        timestamp: e.timestamp,
        targetId: e.targetId,
        source: (e.data.source as string) ?? null,
        matches: (e.data.matches as Array<{ type: string; confidence: string; preview: string }>) ?? []
      }))
    )
  }

  const typeColor: Record<string, string> = {
    password_hash: 'text-red-400',
    ntlm_hash: 'text-red-400',
    private_key: 'text-red-400',
    aws_key: 'text-orange-400',
    jwt: 'text-yellow-400',
    generic_api_key: 'text-yellow-400',
    database_url: 'text-red-400',
    shadow_entry: 'text-red-400',
    flag: 'text-green-400',
    base64_creds: 'text-orange-400'
  }

  // v0.7.1 P1: derive the visible list here so both the header count and the
  // rendered rows see the same number. Pre-v0.7.1 the header read
  // `loot.getCount()` which is the live-detection in-memory dedup set — empty
  // on a fresh launch even when historical loot events exist. That gave a
  // "戰利品 (0)" header with 2 rows visible. Now the count is exactly the
  // matches the operator sees, post-filter, post-dedup.
  const visibleList = useMemo(() => {
    let list = lootEvents.map((le) => ({
      ...le,
      matches: typeFilter ? le.matches.filter((m) => m.type === typeFilter) : le.matches
    })).filter((le) => le.matches.length > 0)
    if (dedupOn) {
      const seen = new Set<string>()
      list = list.map((le) => ({
        ...le,
        matches: le.matches.filter((m) => {
          const k = `${m.type}|${m.preview}`
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
      })).filter((le) => le.matches.length > 0)
    }
    return list
  }, [lootEvents, typeFilter, dedupOn])
  const visibleMatchCount = useMemo(
    () => visibleList.reduce((n, le) => n + le.matches.length, 0),
    [visibleList]
  )

  if (loading) {
    return (
      <LoadingSpinner />
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{t('loot.title', { count: visibleMatchCount })}</h2>
        {lootEvents.length > 0 && (
          <button
            onClick={async () => {
              const p = await (window.redlog.data as { exportLoot?: () => Promise<string | null> }).exportLoot?.()
              if (p) toast(t('toast.exportedTo', { path: p }), 'success')
              else toast(t('toast.exportFailed'), 'error')
            }}
            className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
            title={t('loot.exportHint')}
          >{t('loot.export')}</button>
        )}
      </div>

      {/* Filter + dedup chips (only when there's enough loot to matter) */}
      {lootEvents.length > 0 && (() => {
        const typeCounts = new Map<string, number>()
        for (const le of lootEvents) for (const m of le.matches) typeCounts.set(m.type, (typeCounts.get(m.type) ?? 0) + 1)
        const types = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])
        if (types.length < 2 && lootEvents.length < 5) return null
        return (
          <div className="flex flex-wrap gap-1 items-center">
            {types.length > 1 && types.map(([type, count]) => (
              <button
                key={type}
                onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                className={`px-2 py-0.5 text-xs font-mono rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 ${
                  typeFilter === type ? 'bg-red-500/20 text-red-300' : 'bg-zinc-800 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700'
                }`}
              >
                <span className={typeColor[type] || ''}>{type.replace(/_/g, ' ')}</span> <span className="text-zinc-600">·{count}</span>
              </button>
            ))}
            <span className="ml-auto text-xs text-zinc-600">
              <label className="cursor-pointer inline-flex items-center gap-1">
                <input type="checkbox" checked={dedupOn} onChange={(e) => setDedupOn(e.target.checked)} className="accent-red-600" />
                {t('loot.dedup')}
              </label>
            </span>
          </div>
        )
      })()}

      {lootEvents.length === 0 ? (() => {
        const es = emptyStateFor('loot', { captureDark: false })
        return (
          <EmptyState
            icon="◆"
            title={t(es.titleKey)}
            subtitle={t(es.subtitleKey)}
            action={es.action && es.action.target !== 'doc'
              ? { label: t(es.action.labelKey), onClick: () => onEmptyAction?.(es.action!.target) }
              : undefined}
          />
        )
      })() : (
        // v0.7.1 P1: rendering uses the same `visibleList` that feeds the
        // header count, so what you see and what the header says can never
        // disagree. Each source event keeps its own grouping so the "click
        // card → jump to timeline" flow still lands on a real event id.
        <div className="space-y-2">
          {visibleList.length === 0 && (
            <p className="text-zinc-600 text-xs">{t('loot.noMatches')}</p>
          )}
          {visibleList.map((le, i) => (
            <div
              key={le.id || i}
              role={onOpenInTimeline ? 'button' : undefined}
              tabIndex={onOpenInTimeline ? 0 : undefined}
              onClick={() => onOpenInTimeline?.(le.id, le.timestamp)}
              onKeyDown={onOpenInTimeline ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenInTimeline(le.id, le.timestamp) } } : undefined}
              className={`bg-zinc-900 border border-zinc-800 rounded-lg p-3 ${onOpenInTimeline ? 'cursor-pointer hover:border-cyan-500/40 hover:bg-zinc-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors' : ''}`}
              title={onOpenInTimeline ? t('loot.openInTimelineHint') : undefined}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="text-zinc-500 text-xs">
                  <span className="text-zinc-400 tabular-nums">{new Date(le.timestamp).toLocaleString()}</span>
                  {le.source && (
                    <span> · {t('loot.from')} <span className="text-zinc-300 font-mono">{le.source}</span></span>
                  )}
                  {le.targetId && (
                    <span> · {t('loot.target')} <span className="text-zinc-300 font-mono">{le.targetId}</span></span>
                  )}
                  <span> · {t('loot.items', { count: le.matches.length })}</span>
                </div>
                {onOpenInTimeline && (
                  <span className="text-xs text-cyan-400/80 whitespace-nowrap shrink-0">
                    {t('loot.openInTimeline')} →
                  </span>
                )}
              </div>
              {le.matches.map((m, j) => (
                <div key={j} className="border-t border-zinc-800 pt-1 mt-1 first:border-0 first:pt-0 first:mt-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${typeColor[m.type] || 'text-zinc-400'}`}>
                      {m.type.replace(/_/g, ' ')}
                    </span>
                    <span className={`text-xs px-1 rounded ${
                      m.confidence === 'high' ? 'bg-red-400/10 text-red-400' : 'bg-yellow-400/10 text-yellow-400'
                    }`}>
                      {m.confidence}
                    </span>
                  </div>
                  <div className="text-zinc-400 text-xs font-mono mt-0.5 truncate">{m.preview}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
