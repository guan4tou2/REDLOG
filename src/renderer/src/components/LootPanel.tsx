import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useI18n } from '../i18n/I18nContext'
import { LoadingSpinner } from './Feedback'
import { Gem } from 'lucide-react'
import { EmptyState } from './EmptyState'
import { formatDateTime } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'
import { useInfiniteScroll } from '../lib/useInfiniteScroll'
import { ListFooter } from './ListFooter'
import { toEventFilter, useSharedFilter } from '../lib/FilterContext'
import { EmptyByConstructionNotice } from './FilterNotice'

interface LootEvent {
  id: string
  timestamp: number
  targetId: string | null
  source: string | null
  matches: Array<{ type: string; confidence: string; preview: string }>
}

const PAGE_SIZE = 200

function projectLootEvent(e: { id: string; timestamp: number; targetId?: string | null; data: Record<string, unknown> }): LootEvent {
  return {
    id: e.id,
    timestamp: e.timestamp,
    targetId: e.targetId ?? null,
    source: (e.data.source as string) ?? null,
    matches: (e.data.matches as LootEvent['matches']) ?? []
  }
}

export function LootPanel({ onOpenInTimeline }: { onOpenInTimeline?: (eventId: string, ts: number) => void }): JSX.Element {
  const [lootEvents, setLootEvents] = useState<LootEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadError, setLoadError] = useState<'initial' | 'older' | null>(null)
  const nextCursorRef = useRef<string | null>(null)
  const loadSeqRef = useRef(0)
  const loadingOlderRef = useRef(false)
  const hasMoreRef = useRef(false)
  // Filter by loot type; null = show all. Chips appear at the top with counts.
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const { t } = useI18n()
  const { filter: sharedFilter } = useSharedFilter()

  const loadLoot = useCallback(async (append: boolean, clearExisting = false): Promise<void> => {
    if (append && (loadingOlderRef.current || !hasMoreRef.current)) return
    const seq = append ? loadSeqRef.current : ++loadSeqRef.current

    if (sharedFilter.agentType && sharedFilter.agentType !== 'loot') {
      if (!append) {
        setLootEvents([])
        nextCursorRef.current = null
        hasMoreRef.current = false
        setHasMore(false)
        setLoadError(null)
        setLoading(false)
      }
      return
    }

    if (append) {
      loadingOlderRef.current = true
      setLoadingOlder(true)
    }
    else {
      if (clearExisting) {
        setLootEvents([])
        hasMoreRef.current = false
        setHasMore(false)
      }
      setLoading(true)
      setLoadError(null)
      nextCursorRef.current = null
    }

    try {
      const page = await window.redlog.events.queryPage({
        ...toEventFilter(sharedFilter),
        agentType: 'loot',
        limit: PAGE_SIZE,
        ...(append && nextCursorRef.current ? { cursor: nextCursorRef.current } : {})
      })
      if (seq !== loadSeqRef.current) return
      const projected = page.items.map(projectLootEvent)
      setLootEvents((current) => {
        if (!append) return projected
        const byId = new Map(current.map((event) => [event.id, event]))
        for (const event of projected) byId.set(event.id, event)
        return [...byId.values()]
      })
      nextCursorRef.current = page.nextCursor
      hasMoreRef.current = page.hasMore
      setHasMore(page.hasMore)
      setLoadError(null)
    } catch {
      if (seq === loadSeqRef.current) setLoadError(append ? 'older' : 'initial')
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false)
        loadingOlderRef.current = false
        setLoadingOlder(false)
      }
    }
  }, [sharedFilter])

  useEffect(() => {
    // A shared-filter change must not leave rows from the previous predicate
    // visible while its replacement query is in flight.
    void loadLoot(false, true)
    const unsub = window.redlog.events.onNewBatch((events) => {
      if (events.some((evt) => evt.agentType === 'loot')) {
        // A live refresh keeps the last known evidence visible until the
        // replacement succeeds; a transient read failure must not blank it.
        void loadLoot(false)
      }
    })
    return unsub
  }, [loadLoot])

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
  // matches the operator sees, post-filter. Rows are not folded here: the store
  // already keeps one per secret per target (Spec 031), and folding on the
  // preview line merged distinct keys that share a PEM header.
  const fullList = useMemo(() => lootEvents.map((le) => ({
    ...le,
    matches: typeFilter ? le.matches.filter((m) => m.type === typeFilter) : le.matches
  })).filter((le) => le.matches.length > 0), [lootEvents, typeFilter])

  // §9: page the rows so a large haul doesn't mount all at once. `visibleList`
  // stays the name the render uses; it's now the windowed slice.
  const paged = useInfiniteScroll(fullList)
  const visibleList = paged.visible

  // Same keys as every other list (§9). ⌘↩ and Enter both go to the Timeline
  // here: a loot row has no detail panel of its own, so "activate" and "show
  // me where this came from" are the same request. Nav spans the rendered rows.
  const listNav = useListKeyboard({
    count: visibleList.length,
    onActivate: (i) => { const le = visibleList[i]; if (le) onOpenInTimeline?.(le.id, le.timestamp) },
    onJumpToTimeline: (i) => { const le = visibleList[i]; if (le) onOpenInTimeline?.(le.id, le.timestamp) }
  })
  // Header counts the whole haul, not just the loaded window.
  const visibleMatchCount = useMemo(
    () => fullList.reduce((n, le) => n + le.matches.length, 0),
    [fullList]
  )

  if (loading && lootEvents.length === 0 && loadError == null) {
    return (
      <LoadingSpinner />
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-redlog-text">{t('loot.title', { count: visibleMatchCount })}</h2>
          <span data-testid="loot-completeness" className="text-xs text-redlog-text-faint">
            {t(hasMore ? 'loot.recentSubset' : 'loot.complete')}
          </span>
        </div>
      </div>

      {/* Type chips, when there is more than one type to choose between */}
      {lootEvents.length > 0 && (() => {
        const typeCounts = new Map<string, number>()
        for (const le of lootEvents) for (const m of le.matches) typeCounts.set(m.type, (typeCounts.get(m.type) ?? 0) + 1)
        const types = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])
        if (types.length < 2) return null
        return (
          <div className="flex flex-wrap gap-1 items-center">
            {types.map(([type, count]) => (
              <button
                key={type}
                onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                className={`px-2 py-0.5 text-xs font-mono rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 ${
                  typeFilter === type ? 'bg-red-500/20 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover'
                }`}
              >
                <span className={typeColor[type] || ''}>{type.replace(/_/g, ' ')}</span> <span className="text-redlog-text-faint">·{count}</span>
              </button>
            ))}
          </div>
        )
      })()}

      {loadError === 'initial' && lootEvents.length === 0 ? (
        <div data-testid="loot-load-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <div>{t('loot.loadFailed')}</div>
          <button type="button" onClick={() => void loadLoot(false, true)} className="mt-2 rounded border border-red-400/40 px-2 py-1 hover:bg-red-500/10">
            {t('common.retry')}
          </button>
        </div>
      ) : sharedFilter.agentType && sharedFilter.agentType !== 'loot' ? (
        // Spec 038 FR-012: the Type chip is applied and Loot holds only loot
        // rows, so the list is empty by construction, not for want of loot.
        <EmptyByConstructionNotice
          text={t('filter.lootTypeEmpty', { condition: `${t('filter.type')}: ${sharedFilter.agentType}` })}
        />
      ) : lootEvents.length === 0 ? (
        <EmptyState
          icon={Gem}
          title={t('loot.empty')}
          reason={t('loot.emptyReason')}
        />
      ) : (
        // v0.7.1 P1: rendering uses the same `visibleList` that feeds the
        // header count, so what you see and what the header says can never
        // disagree. Each source event keeps its own grouping so the "click
        // card → jump to timeline" flow still lands on a real event id.
        <div className="space-y-2" {...listNav.containerProps} aria-label={t('loot.title', { count: paged.total })}>
          {visibleList.length === 0 && (
            // Same three-part shape as the no-loot state (§5-4): what would be
            // here, why it is not, and the one action that changes that. A
            // filter that hides every hit used to leave a single grey line.
            <EmptyState
              icon={Gem}
              title={t('loot.noMatches')}
              reason={t('loot.noMatchesReason')}
              action={{ label: t('loot.clearFilter'), onClick: () => setTypeFilter(null) }}
            />
          )}
          {visibleList.map((le, i) => {
            const rowProps = listNav.itemProps(i)
            return (
            <div
              key={le.id || i}
              {...rowProps}
              ref={(el) => rowProps.ref(el)}
              onClick={() => { rowProps.onClick(); onOpenInTimeline?.(le.id, le.timestamp) }}
              className={`bg-redlog-surface border border-redlog-border rounded-lg p-3 ${onOpenInTimeline ? 'cursor-pointer hover:border-cyan-500/40 hover:bg-redlog-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors' : ''} ${rowProps['aria-selected'] ? 'border-redlog-accent/50' : ''}`}
              title={onOpenInTimeline ? t('loot.openInTimelineHint') : undefined}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="text-redlog-text-dim text-xs">
                  <span className="text-redlog-text-dim tabular-nums">{formatDateTime(le.timestamp, { seconds: true })}</span>
                  {le.source && (
                    <span> · {t('loot.from')} <span className="text-redlog-text font-mono">{le.source}</span></span>
                  )}
                  {le.targetId && (
                    <span> · {t('loot.target')} <span className="text-redlog-text font-mono">{le.targetId}</span></span>
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
                <div key={j} className="border-t border-redlog-border pt-1 mt-1 first:border-0 first:pt-0 first:mt-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${typeColor[m.type] || 'text-redlog-text-dim'}`}>
                      {m.type.replace(/_/g, ' ')}
                    </span>
                    <span className={`text-xs px-1 rounded ${
                      m.confidence === 'high' ? 'bg-red-400/10 text-red-400' : 'bg-yellow-400/10 text-yellow-400'
                    }`}>
                      {m.confidence}
                    </span>
                  </div>
                  <div title={m.preview} className="text-redlog-text-dim text-xs font-mono mt-0.5 truncate">{m.preview}</div>
                </div>
              ))}
            </div>
            )
          })}
          <ListFooter shown={paged.shown} total={paged.total} sentinelRef={paged.sentinelRef} />
          {loadError === 'initial' && (
            <div data-testid="loot-load-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <div>{t('loot.loadFailed')}</div>
              <button type="button" onClick={() => void loadLoot(false)} className="mt-2 rounded border border-red-400/40 px-2 py-1 hover:bg-red-500/10">
                {t('common.retry')}
              </button>
            </div>
          )}
          {loadError === 'older' && (
            <div data-testid="loot-load-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <div>{t('loot.loadOlderFailed')}</div>
              <button type="button" onClick={() => void loadLoot(true)} className="mt-2 rounded border border-red-400/40 px-2 py-1 hover:bg-red-500/10">
                {t('common.retry')}
              </button>
            </div>
          )}
          {hasMore && loadError !== 'older' && (
            <button type="button" onClick={() => void loadLoot(true)} disabled={loadingOlder} className="w-full rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300 hover:bg-amber-500/10 disabled:text-redlog-text-faint">
              {loadingOlder ? t('loot.loadingOlder') : t('loot.loadOlder')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
