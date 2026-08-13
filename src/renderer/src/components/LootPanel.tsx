import { useState, useEffect, useMemo } from 'react'
import { useI18n } from '../i18n'
import { LoadingSpinner, EmptyState } from './Feedback'
import { ICON } from '../lib/icons'
import { emptyStateFor } from '../lib/emptyState'
import { toast } from './Toast'
import { SplitPane } from './SplitPane'

interface LootEvent {
  id: string
  timestamp: number
  targetId: string | null
  source: string | null
  matches: Array<{ type: string; confidence: string; preview: string }>
}

export function LootPanel({ onOpenInTimeline, onEmptyAction }: {
  onOpenInTimeline?: (eventId: string, ts: number) => void
  onEmptyAction?: (target: string) => void
}): JSX.Element {
  const [lootEvents, setLootEvents] = useState<LootEvent[]>([])
  const [loading, setLoading] = useState(true)
  // Filter by loot type; null = show all. Chips appear at the top with counts.
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  // Selected event → shown in the detail pane (full, copyable values). null =
  // nothing picked yet. Addresses audit C1: the list preview is truncated, so
  // the detail pane is where the operator reads and copies the whole value.
  const [selectedId, setSelectedId] = useState<string | null>(null)
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

  // Empty state fills the whole view — nothing to split yet.
  if (lootEvents.length === 0) {
    const es = emptyStateFor('loot', { captureDark: false })
    return (
      <div className="p-4 h-full overflow-auto">
        <EmptyState
          icon={ICON.loot}
          title={t(es.titleKey)}
          subtitle={t(es.subtitleKey)}
          action={es.action && es.action.target !== 'doc'
            ? { label: t(es.action.labelKey), onClick: () => onEmptyAction?.(es.action!.target) }
            : undefined}
        />
      </div>
    )
  }

  const selected = visibleList.find((le) => le.id === selectedId) ?? null

  return (
    <SplitPane id="loot-list-detail" direction="horizontal" defaultSize={440} min={300} max={680} otherMin={320}>
      {/* Left: the loot list. Cards now SELECT (→ detail pane) rather than jump;
          the jump moved into the detail pane alongside the full, copyable value. */}
      <div className="p-4 space-y-4 overflow-auto h-full">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{t('loot.title', { count: visibleMatchCount })}</h2>
          <button
            onClick={async () => {
              const p = await (window.redlog.data as { exportLoot?: () => Promise<string | null> }).exportLoot?.()
              if (p) toast(t('toast.exportedTo', { path: p }), 'success')
              else toast(t('toast.exportFailed'), 'error')
            }}
            className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
            title={t('loot.exportHint')}
          >{t('loot.export')}</button>
        </div>

        {/* Filter + dedup chips (only when there's enough loot to matter) */}
        {(() => {
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

        <div className="space-y-2">
          {visibleList.length === 0 && (
            <p className="text-zinc-600 text-xs">{t('loot.noMatches')}</p>
          )}
          {visibleList.map((le, i) => {
            const isSel = selectedId === le.id
            return (
              <div
                key={le.id || i}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(le.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(le.id) } }}
                className={`bg-zinc-900 border rounded-lg p-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors ${
                  isSel ? 'border-cyan-500/60 bg-zinc-900/60' : 'border-zinc-800 hover:border-cyan-500/40 hover:bg-zinc-900/60'
                }`}
                title={t('loot.selectHint')}
              >
                <div className="text-zinc-500 text-xs mb-2">
                  <span className="text-zinc-400 tabular-nums">{new Date(le.timestamp).toLocaleString()}</span>
                  {le.source && (
                    <span> · {t('loot.from')} <span className="text-zinc-300 font-mono">{le.source}</span></span>
                  )}
                  <span> · {t('loot.items', { count: le.matches.length })}</span>
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
            )
          })}
        </div>
      </div>

      <LootDetail le={selected} typeColor={typeColor} onOpenInTimeline={onOpenInTimeline} />
    </SplitPane>
  )
}

// The detail pane: the full, un-truncated, copyable value for the selected loot
// event (audit C1 — the list preview is `truncate` and had no copy affordance).
function LootDetail({ le, typeColor, onOpenInTimeline }: {
  le: LootEvent | null
  typeColor: Record<string, string>
  onOpenInTimeline?: (eventId: string, ts: number) => void
}): JSX.Element {
  const { t } = useI18n()
  if (!le) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-zinc-600 text-sm gap-2 p-4">
        <span aria-hidden className="text-2xl opacity-30">{ICON.loot}</span>
        <span>{t('loot.selectPrompt')}</span>
      </div>
    )
  }
  const copy = (value: string): void => {
    navigator.clipboard.writeText(value)
      .then(() => toast(t('loot.copied'), 'success'))
      .catch(() => toast(t('loot.copyFailed'), 'error'))
  }
  return (
    <div className="h-full overflow-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-zinc-500 text-xs min-w-0">
          <div className="text-zinc-300 tabular-nums">{new Date(le.timestamp).toLocaleString()}</div>
          {le.source && <div className="truncate">{t('loot.from')} <span className="text-zinc-300 font-mono">{le.source}</span></div>}
          {le.targetId && <div className="truncate">{t('loot.target')} <span className="text-zinc-300 font-mono">{le.targetId}</span></div>}
        </div>
        {onOpenInTimeline && (
          <button
            onClick={() => onOpenInTimeline(le.id, le.timestamp)}
            className="shrink-0 text-xs text-cyan-400/90 hover:text-cyan-300 whitespace-nowrap px-2 py-1 rounded hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/40"
            title={t('loot.openInTimelineHint')}
          >{t('loot.openInTimeline')} {ICON.openInTimeline}</button>
        )}
      </div>
      {le.matches.map((m, j) => (
        <div key={j} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-mono ${typeColor[m.type] || 'text-zinc-400'}`}>{m.type.replace(/_/g, ' ')}</span>
            <span className={`text-xs px-1 rounded ${m.confidence === 'high' ? 'bg-red-400/10 text-red-400' : 'bg-yellow-400/10 text-yellow-400'}`}>{m.confidence}</span>
            <button
              onClick={() => copy(m.preview)}
              className="ml-auto text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
              title={t('loot.copyHint')}
            >{t('loot.copy')}</button>
          </div>
          {/* Full value — selectable + wrapped, no truncation. */}
          <pre className="text-xs text-zinc-200 font-mono whitespace-pre-wrap break-all select-text bg-zinc-900/60 rounded border border-zinc-800/60 px-2 py-1.5 max-h-64 overflow-auto">{m.preview}</pre>
        </div>
      ))}
    </div>
  )
}
