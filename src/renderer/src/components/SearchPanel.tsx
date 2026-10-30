import { ActivityResults, SearchCoverage } from './ActivityResults'
import type { BodySearchCoverage } from '../../../core/http-body-index'
import { Button } from './Button'
import { eventTitle } from '../lib/eventTitle'
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useListKeyboard } from '../lib/useListKeyboard'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'
import { CastResults, type CastHit } from './CastResults'
import { isMarkerAmendment, foldAllMarkers, amendedFields, type MarkerFold } from '../lib/markerFold'
import { useContributeExport } from '../lib/exportScope'
import { toEventFilter, useSharedFilter } from '../lib/FilterContext'
import { parseQuery, type ParseOutcome } from '../../../core/query/contract'
import { QueryReadout } from './QueryReadout'
import { useReadState } from '../lib/readState'
import { indexStatusOf } from '../lib/castIndexStatus'

// §1 collapsed the timeline's eighteen lane hues into one grey, because a
// colour per category means colour says nothing when something is actually
// wrong. The same map lived here and in TargetView, one hue per event type.
// The type is already written next to the icon; the colour was decoration
// competing with out-of-scope and error for the operator's eye.

function eventSummary(e: RedLogEvent, fold?: MarkerFold): string {
  const d = e.data
  if (e.agentType === 'shell' && ['session_output', 'command_start', 'command_end'].includes(String(d.subtype))) return eventTitle(e)
  if (e.agentType === 'shell') return `$ ${(d.command as string)?.slice(0, 120) || ''}`
  if (e.agentType === 'screenshot') return `Screenshot (${d.trigger})`
  if (e.agentType === 'clipboard') return `Clipboard: ${(d.content as string)?.slice(0, 80) || ''}`
  if (e.agentType === 'marker') {
    if (isMarkerAmendment(e)) return `↻ ${amendedFields(e).join(' · ')}`
    const eff = fold?.effective
    return `[${eff?.severity ?? d.severity}] ${eff?.title ?? d.title}`
  }
  if (e.agentType === 'file_transfer' && d.subtype === 'artifact_added') return eventTitle(e)
  if (e.agentType === 'file_transfer') return `${d.direction}: ${d.filename || d.localPath || d.remotePath}`
  if (e.agentType === 'loot') return `Loot: ${d.type} (${d.confidence})`
  if (e.agentType === 'agent') {
    const body = d.full ?? d.preview ?? d.output ?? d.text
    return body ? `Agent: ${String(body).slice(0, 120)}` : `Agent: ${d.subtype || 'event'}`
  }
  return `${e.agentType}: ${d.subtype || JSON.stringify(d).slice(0, 60)}`
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
const isLateChunk = (e: RedLogEvent): boolean =>
  e.agentType === 'shell' && e.data.subtype === 'command_output' && (e.data.late === true || e.data.streamed === true) && typeof e.data.command_id === 'string'

/** A hit inside what a background command printed after its prompt came back is
 *  a hit on that command. The follow-up rows are hidden from the Timeline, so
 *  opening one would land nowhere; the command is the row that opens. A chunk
 *  whose command cannot be found stays as it is. */
async function foldLateOutputHits(rows: RedLogEvent[]): Promise<RedLogEvent[]> {
  const commandIds = [...new Set(rows.filter(isLateChunk).map((e) => e.data.command_id as string))]
  if (commandIds.length === 0) return rows
  const ends = (await window.redlog.events.commandEnds(commandIds).catch(() => [])) ?? []
  const endByCommand = new Map(ends.map((e) => [String(e.data.command_id), e]))
  const shown = new Set(rows.filter((e) => !isLateChunk(e)).map((e) => e.id))
  return rows.flatMap((e) => {
    if (!isLateChunk(e)) return [e]
    const end = endByCommand.get(e.data.command_id as string)
    if (!end) return [e]
    if (shown.has(end.id)) return []
    shown.add(end.id)
    return [end]
  })
}

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
  // Originals come from the page; amendments only from the fetch, so an
  // amendment that also matched the query is not counted twice.
  const newFolds = foldAllMarkers([...rows.filter((e) => !isMarkerAmendment(e)), ...amendments])
  return { rows: await foldLateOutputHits(rows), newFolds }
}

const PAGE_SIZE = 100

function readProjectPage(parsed: import('../../../core/query/contract').ParsedQuery, filter: ReturnType<typeof toEventFilter>, cursor?: string | null): ReturnType<typeof window.redlog.events.runQuery> {
  if(!parsed.text.trim() && !parsed.conditions.length) return window.redlog.events.queryPage({...filter,limit:PAGE_SIZE,...(cursor?{cursor}:{})}).then(page=>({...page,bodyCoverage:undefined,toolSession:undefined}))
  return window.redlog.events.runQuery({parsed,filter,limit:PAGE_SIZE,...(cursor?{cursor}:{})})
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

interface SearchPanelProps {
  onOpenInTimeline?: (eventId: string, ts: number) => void
  active?: boolean
  browse?: boolean
  controlledQuery?: string
  viewMode?: 'events' | 'activities'
}

export function SearchPanel({ onOpenInTimeline, active = true, browse = false, controlledQuery, viewMode }: SearchPanelProps = {}): JSX.Element {
  const { filter: sharedFilter } = useSharedFilter()
  const [query, setQuery] = useState('')
  const [localMode, setMode] = useState<'events' | 'activities'>('events')
  const mode = viewMode ?? localMode
  const [submitted, setSubmitted] = useState('')
  const [bodyCoverage, setBodyCoverage] = useState<BodySearchCoverage | undefined>()
  const [results, setResults] = useState<RedLogEvent[]>([])
  const [folds, setFolds] = useState<Map<string, MarkerFold>>(new Map())
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const effectiveTypeFilter = sharedFilter.agentType ?? typeFilter
  const [castHits, setCastHits] = useState<CastHit[]>([])
  // Index completeness is a read that can fail or not have answered yet, and
  // neither is "fully indexed" (#298): ready / pending / unknown / failed.
  const castStatus = useReadState(() => window.redlog.events.castIndexStatus())
  const castStatusPhase=useRef(castStatus.state.phase)
  castStatusPhase.current=castStatus.state.phase
  const indexStatus = indexStatusOf(castStatus.state)
  const castPending = indexStatus.kind === 'pending'||indexStatus.kind==='partial' ? indexStatus.pending : 0
  // Facets refresh with every result set. A failed read is not "no types".
  const typesRead = useReadState(() => window.redlog.events.distinctAgentTypes(), true, [results])
  const knownTypes = typesRead.state.value ?? []
  const [hasMore, setHasMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [castError, setCastError] = useState<string | null>(null)
  const [castsRestricted, setCastsRestricted] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [toolSession, setToolSession] = useState<{ toolUseId: string; sessionId: string; otherSessionIds: string[] } | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeqRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const { t } = useI18n()
  const parse: ParseOutcome | null = useMemo(() => query.trim() ? parseQuery(query) : null, [query])

  const [operationExport,setOperationExport] = useState<ExportRequest['subset'] | null>(null)
  const exportQuery = controlledQuery ?? query
  const selectedOperation = mode === 'activities' && exportQuery === submitted ? operationExport : null
  const exportRequest = useMemo<ExportRequest>(() => ({ format: 'json', subset: selectedOperation ?? {
    kind: 'selection', projection: 'events', filter: { ...toEventFilter(sharedFilter), ...(effectiveTypeFilter ? { agentType: effectiveTypeFilter } : {}) }, query: exportQuery,
    ...(browse && mode === 'activities' ? { excludeHousekeeping: true } : {})
  } }), [sharedFilter, effectiveTypeFilter, exportQuery, mode, selectedOperation, browse])
  useContributeExport(active ? { label: t(selectedOperation ? `activity.export.${selectedOperation.kind}` : mode === 'activities' ? 'activity.exportMatches' : 'export.current'), request: exportRequest,
    ...(browse || exportQuery.trim() ? {} : { disabledReason: t('export.enterQuery') }) } : null)

  const filtered = results
  const listNav = useListKeyboard({
    count: filtered.length,
    enabled: active && mode === 'events',
    onActivate: (i) => { const e = filtered[i]; if (e) onOpenInTimeline?.(e.id, e.timestamp) },
    onJumpToTimeline: (i) => { const e = filtered[i]; if (e) onOpenInTimeline?.(e.id, e.timestamp) },
    onEscape: () => setTypeFilter(null)
  })

  const buildSearchOpts = useCallback(() => {
    const opts = toEventFilter(sharedFilter)
    if (effectiveTypeFilter) opts.agentType = effectiveTypeFilter
    return opts
  }, [effectiveTypeFilter, sharedFilter.targetId, sharedFilter.timeRange, sharedFilter.inScopeOnly, sharedFilter.hidePersonal, sharedFilter.tier])

  const doSearch = useCallback((q: string) => {
    abortRef.current?.abort()
    ++searchSeqRef.current
    setSearching(false)
    setLoadingMore(false)
    setSubmitted(q)
    setBodyCoverage(undefined)
    setCastsRestricted(false)
    if (q.length < 1 && !browse) {
      setResults([])
      setCastHits([])
      setSearched(false)
      setHasMore(false)
      setNextCursor(null)
      setSearchError(null)
      setCastError(null)
      setLoadMoreError(null)
      setToolSession(null)
      return
    }
    const outcome = parseQuery(q)
    if (!outcome.ok) {
      abortRef.current?.abort()
      setResults([])
      setCastHits([])
      setSearching(false)
      setSearched(false)
      setSearchError(null)
      setToolSession(null)
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setSearching(true)
    setSearched(false)
    setSearchError(null)
    setCastError(null)
    setLoadMoreError(null)
    setResults([])
    setFolds(new Map())
    setToolSession(null)
    setHasMore(false)
    setNextCursor(null)
    const seq = ++searchSeqRef.current
    const opts = buildSearchOpts()
    const eventFilterActive = Boolean(
      opts.targetId || opts.agentType || opts.since != null || opts.before != null || opts.inScopeOnly || opts.hidePersonal || opts.tier || outcome.parsed.conditions.length
    )
    setCastsRestricted(eventFilterActive)
    if (mode === 'events') readProjectPage(outcome.parsed,opts).then(async (page) => {
      if (ac.signal.aborted || seq !== searchSeqRef.current) return
      const { rows, newFolds } = await resolveAndFold(page.items)
      if (ac.signal.aborted || seq !== searchSeqRef.current) return
      setBodyCoverage(page.bodyCoverage)
      setFolds(newFolds)
      setResults(rows)
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
      setToolSession(page.toolSession ?? null)
      setSearching(false)
      setSearched(true)
    }).catch((error: unknown) => {
      if (ac.signal.aborted || seq !== searchSeqRef.current) return
      setSearchError(errorText(error))
      setSearching(false)
      setSearched(true)
    })
    // Cast index rows do not carry target, event type, or project wall-clock
    // metadata. Hiding them while an event filter is active avoids presenting
    // unfiltered transcript matches as if they satisfied that filter.
    setCastHits([])
    if (mode === 'activities') { setSearching(false); setSearched(true) }
    if (!eventFilterActive && outcome.parsed.text.trim()) {
      const castSeq = seq
      window.redlog.events.searchCasts(outcome.parsed.text, 50)
        .then((r) => {
          if (castSeq !== searchSeqRef.current) return
          setCastHits(r ?? [])
          setCastError(null)
          if(castStatusPhase.current==='loaded')castStatus.retry()
        })
        .catch((error: unknown) => {
          if (castSeq !== searchSeqRef.current) return
          setCastHits([])
          setCastError(errorText(error))
        })
    }
  }, [buildSearchOpts, mode, browse])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setLoadMoreError(null)
    const opts = buildSearchOpts()
    const seq = searchSeqRef.current
    try {
      const outcome = parseQuery(queryRef.current)
      if (!outcome.ok) return
      const page = await readProjectPage(outcome.parsed,opts,nextCursor)
      const { rows, newFolds } = await resolveAndFold(page.items)
      if (seq !== searchSeqRef.current) return
      setBodyCoverage(page.bodyCoverage)
      setResults((prev) => [...prev, ...rows])
      setFolds((prev) => {
        const merged = new Map(prev)
        for (const [k, v] of newFolds) merged.set(k, v)
        return merged
      })
      setHasMore(page.hasMore)
      setNextCursor(page.nextCursor)
    } catch (error: unknown) {
      if (seq === searchSeqRef.current) setLoadMoreError(errorText(error))
    } finally {
      if (seq === searchSeqRef.current) setLoadingMore(false)
    }
  }, [nextCursor, loadingMore, buildSearchOpts])


  useEffect(() => {
    // A keystroke's pending search closed over the filter as it was. This
    // search already uses the new one, so the old one must not land after it.
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null }
    if (active && (query.length >= 1 || browse)) doSearch(query)
  }, [effectiveTypeFilter, sharedFilter.targetId, sharedFilter.timeRange, sharedFilter.inScopeOnly, sharedFilter.hidePersonal, sharedFilter.tier, mode, active])

  useEffect(() => () => { abortRef.current?.abort(); ++searchSeqRef.current; if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  const onChange = useCallback((val: string) => {
    setQuery(val)
    setSearching(val.trim().length > 0)
    abortRef.current?.abort(); ++searchSeqRef.current
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 300)
  }, [doSearch])

  useEffect(() => {
    if (active && controlledQuery !== undefined && controlledQuery !== query) onChange(controlledQuery)
  }, [controlledQuery, active])

  return (
    <div className="p-4 h-full flex flex-col">
      {viewMode === undefined && <div className="flex flex-wrap gap-2 mb-3 shrink-0" role="group" aria-label={t('activity.view')}>
        <Button level="quiet" size="compact" aria-pressed={mode === 'activities'} onClick={() => setMode('activities')}>{t('activity.operations')}</Button>
        <Button level="quiet" size="compact" aria-pressed={mode === 'events'} onClick={() => setMode('events')}>{t('activity.rawEvents')}</Button>
      </div>}
      {controlledQuery === undefined && <div className="relative mb-3 shrink-0">
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
      </div>}

      <div data-testid="search-results" className={`flex-1 overflow-auto min-h-0 ${query !== submitted ? 'opacity-50' : ''}`} inert={query !== submitted} aria-busy={query !== submitted || searching}>
        {parse && (
          <div className="mb-2">
            <QueryReadout outcome={parse} testId="search-query" unparsableTitle={t('search.queryUnparsable')} />
          </div>
        )}
        {(browse || mode === 'activities') && (browse || submitted.trim()) && (() => {
          const parsed = parseQuery(submitted)
          return parsed.ok ? <div hidden={mode !== 'activities'}><ActivityResults active={active && mode === 'activities'} onExportSelection={setOperationExport} request={{ parsed: parsed.parsed, filter: buildSearchOpts(), ...(browse ? { excludeHousekeeping: true } : {}) }} onOpen={onOpenInTimeline} /></div> : null
        })()}
        <SearchCoverage coverage={bodyCoverage} />
        {mode === 'events' && toolSession && (
          <div data-testid="search-tool-session" role="status" className="mb-3 rounded border border-redlog-cyan/40 bg-redlog-cyan/10 px-3 py-2 text-xs text-redlog-cyan">
            {t('search.queryToolSession', { tool: toolSession.toolUseId, session: toolSession.sessionId })}
          </div>
        )}
        {mode === 'events' && searchError && (
          <div data-testid="search-error" role="alert" className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            <div className="font-medium">{t('search.failedTitle')}</div>
            <div className="mt-1 text-xs text-redlog-text-dim">{t('search.failedBody')}</div>
            <div className="mt-1 truncate font-mono text-xs text-redlog-text-faint" title={searchError}>{searchError}</div>
            <button type="button" onClick={() => doSearch(queryRef.current)} className="mt-2 text-xs text-red-300 underline hover:text-red-200">
              {t('common.retry')}
            </button>
          </div>
        )}
        {castError && !searchError && searched && (
          <div data-testid="search-partial-warning" role="status" className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <div className="font-medium">{t('search.partialTitle')}</div>
            <div className="mt-1 text-redlog-text-dim">{t('search.partialBody')}</div>
            <button type="button" onClick={() => doSearch(queryRef.current)} className="mt-2 text-xs text-amber-300 underline hover:text-amber-200">
              {t('common.retry')}
            </button>
          </div>
        )}
        {/* Whether the recordings index has been read is not known — either it
            has not answered or it could not. An empty or short output search
            is not authoritative then, and the panel must not read as if it
            were. Results below stay usable. ("pending" has its own wording,
            shown with the recording hits.) */}
        {searched && (indexStatus.kind === 'unknown' || indexStatus.kind === 'failed') && (
          <div data-testid="search-index-status" data-kind={indexStatus.kind} role="status" className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <div className="font-medium">
              {indexStatus.kind === 'failed' ? t('castSearch.statusFailed') : t('castSearch.statusUnknown')}
            </div>
            <div className="mt-1 text-redlog-text-dim">{t('castSearch.statusIncomplete')}</div>
            {indexStatus.kind === 'failed' && indexStatus.error && (
              <div className="mt-1 truncate font-mono text-xs text-redlog-text-faint" title={indexStatus.error}>{indexStatus.error}</div>
            )}
            <button type="button" onClick={castStatus.retry} className="mt-2 text-xs text-amber-300 underline hover:text-amber-200">
              {t('common.retry')}
            </button>
          </div>
        )}
        {searched && indexStatus.kind==='partial' && <p role="status" className="mb-2 text-xs text-amber-300">
          {t('castSearch.coverageFailures',indexStatus)}
        </p>}
        <div hidden={mode !== 'events'}>
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
        {searched && !searchError && results.length === 0 && castHits.length === 0 && (
          <div className="text-redlog-text-faint text-sm text-center mt-8">
            {t('search.noResults', { query })}
            {castPending > 0 && (
              <p className="text-xs text-amber-500/80 mt-2" role="status">
                {t('castSearch.stillIndexing', { pending: castPending })}
              </p>
            )}
          </div>
        )}
        {searched && typesRead.state.phase === 'failed' && (
          <div data-testid="search-types-failed" role="status" className="mb-2 text-xs text-amber-300">
            <span>{t('search.typesFailed')}</span>{' '}
            <button type="button" onClick={typesRead.retry} className="underline hover:text-amber-200">
              {t('common.retry')}
            </button>
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
                  <span className="text-redlog-text-dim">{type}</span>
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
                  <span className="font-mono font-bold w-12 shrink-0 text-redlog-text-dim">
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
              <>
                {loadMoreError && (
                  <div data-testid="search-load-more-error" role="alert" className="mt-2 text-center text-xs text-amber-300">
                    {t('search.loadMoreFailed')}
                  </div>
                )}
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="mt-2 w-full text-xs text-redlog-cyan hover:text-redlog-text disabled:text-redlog-text-faint py-2"
                >
                  {loadingMore ? t('search.loading') : t('search.loadMore')}
                </button>
              </>
            )}
          </>
        )})()}

        </div>
        {searched && castsRestricted && <p role="status" className="mt-3 text-xs text-amber-300">{t('activity.castsRestricted')}</p>}
        {searched && castHits.length === 50 && <p role="status" className="mt-3 text-xs text-amber-300">{t('activity.castLimit')}</p>}
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
