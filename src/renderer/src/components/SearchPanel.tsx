import { useState, useCallback, useRef, useEffect } from 'react'
import { useListKeyboard } from '../lib/useListKeyboard'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'
import { CastResults, type CastHit } from './CastResults'
import { isMarkerAmendment, foldMarker, groupAmendments, amendedFields, type MarkerFold } from '../lib/markerFold'
import { useSharedFilter } from '../lib/FilterContext'
import { hostInScope } from '../lib/scope'

const TYPE_COLORS: Record<string, string> = {
  shell: 'text-green-400',
  screenshot: 'text-blue-400',
  clipboard: 'text-yellow-400',
  file_transfer: 'text-purple-400',
  marker: 'text-red-400',
  loot: 'text-orange-400',
  system: 'text-redlog-text-dim'
}

function eventSummary(e: RedLogEvent, fold?: MarkerFold): string {
  const d = e.data
  if (e.agentType === 'shell') return `$ ${(d.command as string)?.slice(0, 120) || ''}`
  if (e.agentType === 'screenshot') return `Screenshot (${d.trigger})`
  if (e.agentType === 'clipboard') return `Clipboard: ${(d.content as string)?.slice(0, 80) || ''}`
  if (e.agentType === 'marker') {
    if (isMarkerAmendment(e)) return `↻ ${amendedFields(e).join(' · ')}`
    const eff = fold?.effective
    return `[${eff?.severity ?? d.severity}] ${eff?.title ?? d.title}`
  }
  if (e.agentType === 'file_transfer') return `${d.direction}: ${d.filename || d.localPath || d.remotePath}`
  if (e.agentType === 'loot') return `Loot: ${d.type} (${d.confidence})`
  return `${e.agentType}: ${d.subtype || JSON.stringify(d).slice(0, 60)}`
}

/** Fold every marker in a result page against the amendments fetched for it. */
function buildFolds(rows: RedLogEvent[], amendments: RedLogEvent[]): Map<string, MarkerFold> {
  const byMarker = groupAmendments(amendments)
  const out = new Map<string, MarkerFold>()
  if (byMarker.size === 0) return out
  for (const e of rows) {
    if (e.agentType !== 'marker' || isMarkerAmendment(e)) continue
    const mine = byMarker.get(e.id)
    if (mine) out.set(e.id, foldMarker(e, mine))
  }
  return out
}

/** Compose rather than replace: the hover has to reveal the full DISPLAYED
 *  value (§9), and for a corrected marker it also carries the title the search
 *  actually matched on — otherwise a hit on the old wording looks like a
 *  mismatch. */
function hoverTitle(
  e: RedLogEvent,
  fold: MarkerFold | undefined,
  t: (k: string, v?: Record<string, string | number>) => string
): string {
  const shown = eventSummary(e, fold)
  if (!fold) return shown
  return `${shown}\n${t('search.amendedOriginalTitle', { title: String(e.data.title ?? '') })}`
}

/** Resolve orphaned amendments back to their original markers, then build
 *  folds for all markers in the result set. Returns the (possibly adjusted)
 *  rows and the fold map. */
async function resolveAndFold(
  rawItems: RedLogEvent[]
): Promise<{ rows: RedLogEvent[]; newFolds: Map<string, MarkerFold> }> {
  const markerIds = new Set(
    rawItems.filter((e) => e.agentType === 'marker' && !isMarkerAmendment(e)).map((e) => e.id)
  )
  const orphaned = rawItems
    .filter(isMarkerAmendment)
    .map((e) => String((e.data as Record<string, unknown>).markerId ?? ''))
    .filter((id) => id && !markerIds.has(id))

  let rows = rawItems
  if (orphaned.length > 0) {
    const originals = (await window.redlog.events.getById([...new Set(orphaned)])) ?? []
    for (const o of originals) markerIds.add(o.id)
    const seen = new Set<string>()
    rows = rawItems.flatMap((e) => {
      if (!isMarkerAmendment(e)) return [e]
      const id = String((e.data as Record<string, unknown>).markerId ?? '')
      const original = originals.find((o) => o.id === id)
      if (!original || seen.has(id)) return []
      seen.add(id)
      return [original]
    })
  }

  const amendments = markerIds.size > 0
    ? (await window.redlog.marker.amendments([...markerIds])) ?? []
    : []
  const newFolds = buildFolds(rows, amendments)
  return { rows, newFolds }
}

const PAGE_SIZE = 100

interface SearchPanelProps {
  onOpenInTimeline?: (eventId: string, ts: number) => void
}

export function SearchPanel({ onOpenInTimeline }: SearchPanelProps = {}): JSX.Element {
  const { filter: sharedFilter, scopeTargets, scopeExcludeTargets } = useSharedFilter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RedLogEvent[]>([])
  const [folds, setFolds] = useState<Map<string, MarkerFold>>(new Map())
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const effectiveTypeFilter = sharedFilter.agentType ?? typeFilter
  const [castHits, setCastHits] = useState<CastHit[]>([])
  const [castPending, setCastPending] = useState(0)
  const [knownTypes, setKnownTypes] = useState<string[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const { t } = useI18n()

  const filtered = sharedFilter.inScopeOnly
    ? results.filter((event) => !event.targetId || hostInScope(event.targetId, scopeTargets, scopeExcludeTargets))
    : results
  const listNav = useListKeyboard({
    count: filtered.length,
    onActivate: (i) => { const e = filtered[i]; if (e) onOpenInTimeline?.(e.id, e.timestamp) },
    onJumpToTimeline: (i) => { const e = filtered[i]; if (e) onOpenInTimeline?.(e.id, e.timestamp) },
    onEscape: () => setTypeFilter(null)
  })

  const buildSearchOpts = useCallback(() => {
    const opts: { agentType?: string; since?: number; before?: number } = {}
    if (effectiveTypeFilter) opts.agentType = effectiveTypeFilter
    if (sharedFilter.timeRange?.since) opts.since = sharedFilter.timeRange.since
    if (sharedFilter.timeRange?.before) opts.before = sharedFilter.timeRange.before
    return opts
  }, [effectiveTypeFilter, sharedFilter.timeRange])

  const doSearch = useCallback((q: string) => {
    if (q.length < 1) {
      setResults([])
      setCastHits([])
      setSearched(false)
      setHasMore(false)
      setNextCursor(null)
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setSearching(true)
    const seq = ++searchSeqRef.current
    const opts = buildSearchOpts()
    window.redlog.events.searchPage({
      query: q, limit: PAGE_SIZE, ...opts
    }).then(async (page) => {
      if (ac.signal.aborted || seq !== searchSeqRef.current) return
      const { rows, newFolds } = await resolveAndFold(page.items)
      setFolds(newFolds)
      setResults(rows)
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
      setSearching(false)
      setSearched(true)
    }).catch(() => {
      if (seq !== searchSeqRef.current) return
      setSearching(false)
    })
    const castSeq = seq
    window.redlog.events.searchCasts(q, 50)
      .then((r) => { if (castSeq === searchSeqRef.current) setCastHits(r ?? []) })
      .catch(() => { if (castSeq === searchSeqRef.current) setCastHits([]) })
  }, [buildSearchOpts])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    const opts = buildSearchOpts()
    try {
      const page = await window.redlog.events.searchPage({
        query: queryRef.current, limit: PAGE_SIZE, cursor: nextCursor, ...opts
      })
      const { rows, newFolds } = await resolveAndFold(page.items)
      setResults((prev) => [...prev, ...rows])
      setFolds((prev) => {
        const merged = new Map(prev)
        for (const [k, v] of newFolds) merged.set(k, v)
        return merged
      })
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor, loadingMore, buildSearchOpts])

  useEffect(() => {
    window.redlog.events.castIndexStatus()
      .then((s) => setCastPending(s?.pending ?? 0))
      .catch(() => { /* older main process; treat as fully indexed */ })
  }, [])

  useEffect(() => {
    (window.redlog.events as { distinctAgentTypes?: () => Promise<string[]> })
      .distinctAgentTypes?.()
      .then((types) => setKnownTypes(types ?? []))
      .catch(() => {})
  }, [results])

  useEffect(() => {
    if (query.length >= 1) doSearch(query)
  }, [effectiveTypeFilter, sharedFilter.timeRange])

  const onChange = useCallback((val: string) => {
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 300)
  }, [doSearch])

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="relative mb-3 shrink-0">
        <input
          value={query}
          data-testid="search-input"
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('search.placeholder')}
          autoFocus
          className="w-full bg-redlog-elevated border border-redlog-border rounded-lg px-4 py-2.5 text-sm text-redlog-text font-mono focus:outline-none focus:border-red-500 placeholder-redlog-text-faint"
        />
        {searching && (
          <span className="absolute right-3 top-3 text-redlog-text-dim text-xs animate-pulse">...</span>
        )}
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {!searched && !searching && (
          <div className="text-redlog-text-faint text-sm text-center mt-8">
            {t('search.hint')}
          </div>
        )}
        {searched && typeFilter && (
          <div className="text-redlog-text-dim text-xs mb-2">
            <button onClick={() => setTypeFilter(null)} className="text-redlog-text-dim hover:text-redlog-text underline">{t('search.clearFilter')}</button>
          </div>
        )}
        {searched && results.length === 0 && castHits.length === 0 && (
          <div className="text-redlog-text-faint text-sm text-center mt-8">
            {t('search.noResults', { query })}
            {castPending > 0 && (
              <p className="text-xs text-amber-500/80 mt-2" role="status">
                {t('castSearch.stillIndexing', { pending: castPending })}
              </p>
            )}
          </div>
        )}
        {searched && knownTypes.length > 1 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {knownTypes.map((type) => {
              const count = results.filter((e) => e.agentType === type).length
              return (
                <button
                  key={type}
                  onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                  className={`px-2 py-0.5 text-xs font-mono rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 ${
                    typeFilter === type ? 'bg-red-500/20 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated-hover'
                  }`}
                >
                  <span className={TYPE_COLORS[type] || ''}>{type}</span>
                  {count > 0 && <span className="text-redlog-text-faint"> ·{count}</span>}
                </button>
              )
            })}
          </div>
        )}
        {results.length > 0 && (() => {
          return (
          <>
            <div className="text-redlog-text-dim text-xs mb-2">
              {t('search.loaded', { count: filtered.length })}
            </div>
            <div className="space-y-1" {...listNav.containerProps} aria-label={t('search.resultsLabel', { count: filtered.length })}>
              {filtered.map((e, i) => {
                const rowProps = listNav.itemProps(i)
                return (
                <button
                  key={e.id}
                  {...rowProps}
                  ref={(el) => rowProps.ref(el)}
                  onClick={() => { rowProps.onClick(); onOpenInTimeline?.(e.id, e.timestamp) }}
                  disabled={!onOpenInTimeline}
                  className="w-full text-left flex items-start gap-2 px-3 py-2 rounded hover:bg-redlog-elevated/50 text-xs disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
                  title={onOpenInTimeline ? t('search.openInTimeline') : undefined}
                >
                  <span className={`font-mono font-bold w-12 shrink-0 ${TYPE_COLORS[e.agentType] || 'text-redlog-text-dim'}`}>
                    {e.agentType.slice(0, 6)}
                  </span>
                  <span
                    title={hoverTitle(e, folds.get(e.id), t)}
                    className="text-redlog-text font-mono flex-1 min-w-0 truncate"
                  >
                    {eventSummary(e, folds.get(e.id))}
                  </span>
                  {folds.get(e.id) && (
                    <span
                      data-testid="marker-amend-count"
                      className="text-redlog-text-dim font-mono tabular-nums shrink-0 ml-1"
                      title={t('marker.amendedTimesHint')}
                    >
                      {t('marker.amendedTimes', { count: folds.get(e.id)!.amendCount })}
                    </span>
                  )}
                  <span className="text-redlog-text-faint shrink-0 ml-2">
                    {formatTime(e.timestamp, { seconds: true })}
                  </span>
                  {e.targetId && (
                    <span className="text-redlog-text-dim shrink-0 ml-1">→ {e.targetId}</span>
                  )}
                </button>
                )
              })}
            </div>
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="mt-2 w-full text-xs text-blue-400 hover:text-blue-300 disabled:text-redlog-text-faint py-2"
              >
                {loadingMore ? t('search.loading') : t('search.loadMore')}
              </button>
            )}
          </>
        )})()}

        {searched && (
          <CastResults
            hits={castHits}
            pending={castPending}
            onOpenAt={onOpenInTimeline ? (tMs) => onOpenInTimeline('', tMs) : undefined}
          />
        )}
      </div>
    </div>
  )
}
