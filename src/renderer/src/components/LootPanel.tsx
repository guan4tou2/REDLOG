import { useState, useMemo, useCallback } from 'react'
import { useLivePagedQuery } from '../hooks/useLivePagedQuery'
import { useI18n } from '../i18n/I18nContext'
import { LoadingSpinner } from './Feedback'
import { Gem, ChevronDown, ChevronRight, Search } from 'lucide-react'
import { Button } from './Button'
import { EmptyState } from './EmptyState'
import { formatDateTime } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'
import { useInfiniteScroll } from '../lib/useInfiniteScroll'
import { ListFooter } from './ListFooter'
import { toEventFilter, useSharedFilter } from '../lib/FilterContext'
import { EmptyByConstructionNotice } from './FilterNotice'
import { EventContentReader } from './EventContentReader'

interface LootEvent {
  id: string
  timestamp: number
  targetId: string | null
  source: string | null
  matches: Array<{ type: string; confidence: string; preview: string }>
  /** The event whose text produced the hit (`_causes`); null when none was
   *  recorded — API scans keep no source text. */
  sourceEventId: string | null
  /** Matches the event stored, before any filter. */
  stored: number
  /** How many new values the event found, when that was more than it could
   *  store (#695: an event keeps at most 500); null when it stored them all. */
  found: number | null
  /** The line the first hit sits on, as stored: where the reader opens. Taken
   *  before any filter, so narrowing the list does not move an open reader. */
  hit: string
}

const PAGE_SIZE = 200

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** A detected type by name; a type this build has no name for keeps its stored
 *  one rather than a made-up word. */
function lootTypeLabel(type: string, t: Translate): string {
  const key = `loot.type.${type}`
  const named = t(key)
  return named === key ? type.replace(/_/g, ' ') : named
}

function lootConfidenceLabel(confidence: string, t: Translate): string {
  const key = `loot.confidence.${confidence}`
  const named = t(key)
  return named === key ? confidence : named
}

const lootKey = (event: LootEvent): string => event.id
const isLootBatch = (events: RedLogEvent[]): boolean => events.some((evt) => evt.agentType === 'loot')

function projectLootEvent(e: { id: string; timestamp: number; targetId?: string | null; data: Record<string, unknown> }): LootEvent {
  const matches = (e.data.matches as LootEvent['matches']) ?? []
  const causes = Array.isArray(e.data._causes) ? e.data._causes.filter((c): c is string => typeof c === 'string' && c.length > 0) : []
  return {
    id: e.id,
    timestamp: e.timestamp,
    targetId: e.targetId ?? null,
    source: (e.data.source as string) ?? null,
    matches,
    sourceEventId: causes[0] ?? null,
    stored: matches.length,
    found: e.data.matches_truncated === true && typeof e.data.matches_total === 'number' ? e.data.matches_total : null,
    hit: typeof matches[0]?.preview === 'string' ? matches[0].preview : ''
  }
}

export function LootPanel({ onOpenInTimeline, projectId, active = true }: {
  onOpenInTimeline?: (eventId: string, ts: number) => void
  /** Without it a row opens to its actions only, with no source content. */
  projectId?: string
  /** False while the page is kept hidden behind another one. */
  active?: boolean
}): JSX.Element {
  // Filter by loot type; null = show all. Chips appear at the top with counts.
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Rows opened in place. Opening a row reads it; the Timeline is a button inside it.
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggleOpen = useCallback((id: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next }), [])
  const { t } = useI18n()
  const { filter: sharedFilter } = useSharedFilter()

  // A shared-filter change must not leave rows from the previous predicate
  // visible while its replacement query is in flight. A live refresh re-reads
  // the pages already loaded and keeps the last known evidence visible until
  // the replacement succeeds; a transient read failure must not blank it.
  // Loot holds only loot rows: a Type chip for anything else asks nothing.
  const lootRead = useLivePagedQuery<LootEvent>({
    key: JSON.stringify(sharedFilter),
    enabled: !sharedFilter.agentType || sharedFilter.agentType === 'loot',
    fetch: async (cursor) => {
      const page = await window.redlog.events.queryPage({
        ...toEventFilter(sharedFilter),
        agentType: 'loot',
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {})
      })
      return { rows: page.items.map(projectLootEvent), nextCursor: page.hasMore ? page.nextCursor : null }
    },
    live: { affects: isLootBatch, intervalMs: 1000 },
    rowKey: lootKey
  })
  const lootEvents = lootRead.rows
  const loading = lootRead.state.phase === 'loading'
  const { hasMore, loadingMore: loadingOlder, loadMore: loadOlder, retry } = lootRead
  const loadError = lootRead.state.phase === 'failed' ? 'initial' : lootRead.moreFailed ? 'older' : null

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
  const needle = query.trim().toLowerCase()
  const fullList = useMemo(() => lootEvents.map((le) => ({
    ...le,
    matches: le.matches.filter((m) => (!typeFilter || m.type === typeFilter)
      && (!needle || [m.type.replace(/_/g, ' '), m.type, m.preview, le.source ?? '', le.targetId ?? ''].some((v) => v.toLowerCase().includes(needle))))
  })).filter((le) => le.matches.length > 0), [lootEvents, typeFilter, needle])

  // §9: page the rows so a large haul doesn't mount all at once. `visibleList`
  // stays the name the render uses; it's now the windowed slice.
  // A live refresh is the same question: it must not shrink the window back to
  // the first page and take an open row (and its reader) with it.
  const paged = useInfiniteScroll(fullList, undefined, JSON.stringify([sharedFilter, typeFilter, needle]))
  const visibleList = paged.visible

  // Same keys as every other list (§9): Enter opens the row in place, ⌘↩ goes
  // to the Timeline. Nav spans the rendered rows. Keys typed inside an open
  // row's reader are the reader's, not the list's (see the container below).
  const listNav = useListKeyboard({
    count: visibleList.length,
    onActivate: (i) => { const le = visibleList[i]; if (le) toggleOpen(le.id) },
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
    <div className="p-pad space-y-4 overflow-auto h-full">
      {/* Stitch 03: a section heading with the page's count (the Evidence tabs
          carry none for loot), and what a hit is and is not, beneath it. */}
      <section data-testid="loot-disclaimer" className="text-xs">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-redlog-text">
            {t('loot.sectionTitle')}
            <span data-testid="loot-count" className="ml-1.5 font-mono text-xs tabular-nums text-redlog-text-faint">{visibleMatchCount}</span>
          </h2>
          <span data-testid="loot-completeness" className="text-xs text-redlog-text-faint">
            {t(hasMore ? 'loot.recentSubset' : lootEvents.some((le) => le.found !== null) ? 'loot.partialEvents' : 'loot.complete')}
          </span>
        </div>
        <p className="mt-0.5 font-medium text-amber-300">{t('loot.disclaimerTitle')}</p>
        <p className="mt-0.5 text-redlog-text-dim">{t('loot.disclaimerBody')}</p>
      </section>

      {lootEvents.length > 0 && (() => {
        const typeCounts = new Map<string, number>()
        for (const le of lootEvents) for (const m of le.matches) typeCounts.set(m.type, (typeCounts.get(m.type) ?? 0) + 1)
        const types = [...typeCounts.entries()].sort((x, y) => y[1] - x[1])
        const total = types.reduce((n, [, c]) => n + c, 0)
        return (
          <div data-testid="loot-toolbar" className="flex flex-wrap items-center justify-between gap-3 rounded border border-redlog-border bg-redlog-surface p-2">
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-1 text-xs text-redlog-text-faint">{t('loot.typeFilter')}</span>
              {[{ id: null as string | null, label: t('loot.allTypes'), count: total }, ...types.map(([id, count]) => ({ id: id as string | null, label: lootTypeLabel(id, t), count }))].map((chip) => (
                <button
                  key={chip.id ?? 'all'}
                  type="button"
                  aria-pressed={typeFilter === chip.id}
                  onClick={() => setTypeFilter(chip.id === null || typeFilter === chip.id ? null : chip.id)}
                  className={`px-2 py-0.5 text-xs font-mono rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 ${
                    typeFilter === chip.id ? 'bg-red-500/20 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover'
                  }`}
                >
                  <span className={chip.id ? (typeColor[chip.id] || '') : ''}>{chip.label}</span> <span className="text-redlog-text-faint">·{chip.count}</span>
                </button>
              ))}
            </div>
            <label className="relative">
              <span className="sr-only">{t('loot.searchLabel')}</span>
              <Search size={14} aria-hidden className="pointer-events-none absolute left-2 top-1.5 text-redlog-text-faint" />
              <input
                data-testid="loot-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('loot.searchPlaceholder')}
                className="w-56 rounded border border-redlog-border bg-redlog-bg py-1 pl-7 pr-2 text-xs text-redlog-text placeholder-redlog-muted focus:border-red-500/40 focus:outline-none"
              />
            </label>
          </div>
        )
      })()}
      {needle && hasMore && <p data-testid="loot-search-scope" className="text-xs text-redlog-text-faint">{t('loot.searchLoadedOnly')}</p>}

      {loadError === 'initial' && lootEvents.length === 0 ? (
        <div data-testid="loot-load-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <div>{t('loot.loadFailed')}</div>
          <button type="button" onClick={retry} className="mt-2 rounded border border-red-400/40 px-2 py-1 hover:bg-red-500/10">
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
        <div className="space-y-2 min-w-0" {...listNav.containerProps} aria-label={t('loot.title', { count: paged.total })}
          onKeyDown={(e) => { if (!(e.target as HTMLElement).closest?.('[data-loot-detail]')) listNav.containerProps.onKeyDown(e) }}>
          {visibleList.length === 0 && (
            // Same three-part shape as the no-loot state (§5-4): what would be
            // here, why it is not, and the one action that changes that. A
            // filter that hides every hit used to leave a single grey line.
            <EmptyState
              icon={Gem}
              title={t('loot.noMatches')}
              reason={t('loot.noMatchesReason')}
              action={{ label: t('loot.clearFilter'), onClick: () => { setTypeFilter(null); setQuery('') } }}
            />
          )}
          {visibleList.map((le, i) => {
            const rowProps = listNav.itemProps(i)
            return (
            <div
              key={le.id || i}
              {...rowProps}
              ref={(el) => rowProps.ref(el)}
              onClick={() => { rowProps.onClick(); toggleOpen(le.id) }}
              aria-expanded={open.has(le.id)}
              className={`bg-redlog-surface border border-redlog-border rounded-lg p-3 cursor-pointer hover:bg-redlog-elevated/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 transition-colors ${rowProps['aria-selected'] ? 'border-redlog-accent/50' : ''}`}
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
                  <span data-testid="loot-items"> · {le.found !== null
                    ? t('loot.itemsOfTotal', { count: le.stored, total: le.found })
                    : t('loot.items', { count: le.matches.length })}</span>
                </div>
                <span aria-hidden className="shrink-0 text-redlog-text-faint">{open.has(le.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
              </div>
              {le.matches.map((m, j) => (
                <div key={j} className="border-t border-redlog-border pt-1 mt-1 first:border-0 first:pt-0 first:mt-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-mono ${typeColor[m.type] || 'text-redlog-text-dim'}`}>
                      {lootTypeLabel(m.type, t)}
                    </span>
                    <span className={`text-xs px-1 rounded ${
                      m.confidence === 'high' ? 'bg-red-400/10 text-red-400' : 'bg-yellow-400/10 text-yellow-400'
                    }`}>
                      {lootConfidenceLabel(m.confidence, t)}
                    </span>
                  </div>
                  <div title={open.has(le.id) ? undefined : m.preview} className={`text-redlog-text-dim text-xs font-mono mt-0.5 ${open.has(le.id) ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'truncate'}`}>{m.preview}</div>
                </div>
              ))}
              {open.has(le.id) && (
                <div
                  data-testid="loot-detail"
                  data-loot-detail
                  className="mt-3 min-w-0 cursor-auto space-y-2 border-t border-redlog-border pt-2"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // One layer per Escape: an expanded reader closes itself
                    // first; next the row closes, and focus goes back to it.
                    if (e.key !== 'Escape' || e.defaultPrevented) return
                    e.preventDefault()
                    const row = (e.currentTarget.closest('[role="option"]') as HTMLElement | null)
                    toggleOpen(le.id)
                    row?.focus({ preventScroll: true })
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs italic text-redlog-text-faint">{t('loot.hitNotProof')}</span>
                    {onOpenInTimeline && (
                      <Button size="compact" data-testid="loot-locate" onClick={() => onOpenInTimeline(le.id, le.timestamp)}>{t('loot.openInTimeline')} →</Button>
                    )}
                  </div>
                  {projectId && (le.sourceEventId
                    ? <EventContentReader projectId={projectId} eventId={le.sourceEventId} active={active} find={le.hit || undefined} />
                    : <p data-testid="loot-no-source" role="status" className="text-xs text-redlog-text-dim">{t('content.status.not-captured')}</p>)}
                </div>
              )}
            </div>
            )
          })}
          <ListFooter shown={paged.shown} total={paged.total} sentinelRef={paged.sentinelRef} />
          {loadError === 'initial' && (
            <div data-testid="loot-load-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <div>{t('loot.loadFailed')}</div>
              <button type="button" onClick={retry} className="mt-2 rounded border border-red-400/40 px-2 py-1 hover:bg-red-500/10">
                {t('common.retry')}
              </button>
            </div>
          )}
          {loadError === 'older' && (
            <div data-testid="loot-load-error" role="alert" className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              <div>{t('loot.loadOlderFailed')}</div>
              <button type="button" onClick={retry} className="mt-2 rounded border border-red-400/40 px-2 py-1 hover:bg-red-500/10">
                {t('common.retry')}
              </button>
            </div>
          )}
          {hasMore && loadError !== 'older' && (
            <button type="button" onClick={loadOlder} disabled={loadingOlder} className="w-full rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300 hover:bg-amber-500/10 disabled:text-redlog-text-faint">
              {loadingOlder ? t('loot.loadingOlder') : t('loot.loadOlder')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
