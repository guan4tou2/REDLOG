import { httpScopeState } from '../lib/scope'
import { useReadState } from '../lib/readState'
import { useLivePagedQuery } from '../hooks/useLivePagedQuery'
import { useRevalidateOnFocus } from '../hooks/useRevalidateOnFocus'
import { LoadingSpinner } from './Feedback'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { X, PanelBottom, PanelRight, ChevronLeft, ChevronRight } from 'lucide-react'
import { useI18n } from '../i18n'
import { formatTime, formatSize } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'
import { usePanelHeight } from '../hooks/usePanelHeight'
import { useKeepScroll } from '../lib/useKeepScroll'
import { DETAIL_LAYOUT_EVENT, setDetailLayout, storedDetailLayout, type DetailLayout } from '../lib/detailLayout'
import { HttpDetail } from './HttpDetail'
import { useContributeExport } from '../lib/exportScope'
import { toEventFilter, useSharedFilter } from '../lib/FilterContext'
import { UnappliedFilterNotice, EmptyByConstructionNotice } from './FilterNotice'
import { Button } from './Button'

/** HTTP flows are recorded by the proxy, which publishes as `scanner`. */
const HTTP_FLOW_AGENT_TYPE = 'scanner'

// §US2 revisited (spec 010): the recent-subset state is a backstop, not the
// resting state. HTTP History auto-follows the cursor to completion, so a
// session of a few thousand flows loads whole without a click — "全部載入".
// The Load More button and the amber subset marker appear only once the loaded
// set passes this cap, the point past which pulling everything into the
// renderer would cost more than the operator asked for; a 40k-request brute
// force stops here and is continued by hand rather than freezing the panel.
// Ten pages of 500 (the flow-query page size below). Exported so the auto-load
// test asserts against the real cap rather than a copy that could drift.
export const AUTO_LOAD_MAX_FLOWS = 5000

interface HttpFlow {
  flowId: string
  method: string
  url: string
  host: string
  status: number | null
  contentType: string
  size: number | null
  durationMs: number | null
  timestamp: number
  requestEventId: string | null
  responseEventId: string | null
  hasRequestBody: boolean
  hasResponseBody: boolean
  httpVersion: string
  streamId: number | null
}

const formatBytes = formatSize

// A status IS a state, so it keeps colour — but only where something is
// wrong. 2xx and 3xx are the expected case and say nothing worth a hue; 4xx
// and 5xx are what the operator is scanning for (§1's state table).
const STATUS_COLORS: Record<string, string> = {
  '2': 'text-redlog-text-dim',
  '3': 'text-redlog-text-dim',
  '4': 'text-redlog-warn',
  '5': 'text-redlog-danger'
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return '' }
}

/** Which columns fit the table's width (CSS px; null = not measured yet).
 *  Time, method, status, host and path always show; type, size and duration
 *  go first, and below that host and path share one cell. */
function httpColumnsFor(width: number | null): { tier: 'wide' | 'medium' | 'narrow'; detail: boolean; hostApart: boolean; count: number } {
  if (width === null || width >= 1000) return { tier: 'wide', detail: true, hostApart: true, count: 8 }
  if (width >= 640) return { tier: 'medium', detail: false, hostApart: true, count: 5 }
  return { tier: 'narrow', detail: false, hostApart: false, count: 4 }
}

const flowKey = (flow: HttpFlow): string => flow.flowId

function isHttpFlowBatch(events: RedLogEvent[]): boolean {
  return events.some((evt) => {
    const sub = evt.data?.subtype as string
    return evt.agentType === HTTP_FLOW_AGENT_TYPE && (sub === 'http_request_start' || sub === 'http_response')
  })
}

function eventsToFlows(events: RedLogEvent[]): HttpFlow[] {
  const flowMap = new Map<string, { request: RedLogEvent | null; response: RedLogEvent | null }>()
  for (const evt of events) {
    const sub = evt.data?.subtype as string
    const fid = evt.data?.flow_id as string
    if (!fid || (sub !== 'http_request_start' && sub !== 'http_response')) continue
    if (!flowMap.has(fid)) flowMap.set(fid, { request: null, response: null })
    const entry = flowMap.get(fid)!
    if (sub === 'http_request_start') entry.request = evt
    else if (!entry.response) entry.response = evt
  }
  return [...flowMap.entries()].map(([flowId, { request, response }]) => {
    const req = request?.data
    const resp = response?.data
    const url = String(req?.url ?? resp?.url ?? '')
    return {
      flowId,
      method: String(req?.method ?? resp?.method ?? ''),
      url,
      // An event without a `host` field still has one in its URL.
      host: String(req?.host ?? resp?.host ?? hostOf(url)),
      status: typeof resp?.status === 'number' ? resp.status : null,
      contentType: String(resp?.content_type ?? ''),
      size: typeof resp?.content_length === 'number' ? resp.content_length : null,
      durationMs: typeof resp?.duration_ms === 'number' ? resp.duration_ms : null,
      timestamp: request?.timestamp ?? response?.timestamp ?? 0,
      requestEventId: request?.id ?? null,
      responseEventId: response?.id ?? null,
      hasRequestBody: !!(req?.request_body || req?.request_body_ref),
      hasResponseBody: !!(resp?.response_body || resp?.response_body_ref),
      httpVersion: String(resp?.http_version ?? req?.http_version ?? ''),
      streamId: typeof resp?.stream_id === 'number' ? resp.stream_id : null
    }
  })
}

// ---------------------------------------------------------------------------
// Main panel — a flat HTTP log (Burp Proxy > HTTP history), one row per flow.
// Grouping traffic under the command that produced it is the Timeline's job;
// this panel only presents the HTTP record.
// ---------------------------------------------------------------------------

export function HttpHistoryPanel({ onOpenInTimeline, onOpenSettings, active = true }: {
  onOpenInTimeline?: (eventId: string, ts: number) => void
  onOpenSettings?: () => void
  /** False while kept mounted but hidden (as SearchPanel): no export scope,
   *  no list keys, and the scroll offset is kept for the return. */
  active?: boolean
}): JSX.Element {
  const { t } = useI18n()
  const { filter: sharedFilter } = useSharedFilter()
  const scopeRead = useReadState(() => window.redlog.scope.policy())
  useRevalidateOnFocus(scopeRead.retry)
  useEffect(() => window.redlog.events.onNewBatch(events => {
    if (events.some(event => event.data.subtype === 'config_changed' || event.data.subtype === 'scope_recomputed')) scopeRead.retry()
  }), [scopeRead.retry])
  const [filterText, setFilterText] = useState('')
  const [methodFilter, setMethodFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [hostFilter, setHostFilter] = useState<string | null>(null)
  const [sortCol, setSortCol] = useState<'timestamp' | 'status' | 'size' | 'durationMs'>('timestamp')
  const [sortAsc, setSortAsc] = useState(false)
  const [detailEvent, setDetailEvent] = useState<{ id: string; projectId: string; data: Record<string, unknown> } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  // The request the pane was asked for and could not show: a read that failed
  // (retryable) or an event that is no longer there. Never a silent close.
  const [detailFault, setDetailFault] = useState<{ id: string; kind: 'failed' | 'missing' } | null>(null)
  const detailSeq = useRef(0)

  // The detail pane docks under the table or beside it — the SAME choice the
  // Timeline's inspector uses (shared via detailLayout), so switching it in
  // either place moves both. Size is kept per layout and per panel.
  const [preferredLayout, setPreferredLayout] = useState<DetailLayout>(storedDetailLayout)
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const compact = containerWidth !== null && containerWidth < 960
  const layout = compact ? 'bottom' : preferredLayout
  useEffect(() => {
    const onChange = (): void => setPreferredLayout(storedDetailLayout())
    window.addEventListener(DETAIL_LAYOUT_EVENT, onChange)
    return () => window.removeEventListener(DETAIL_LAYOUT_EVENT, onChange)
  }, [])
  const detailPanelRef = useRef<HTMLDivElement | null>(null)
  const detailPanel = usePanelHeight(
    layout === 'right' ? 'redlog-http-detail-w' : 'redlog-http-detail-h',
    layout === 'right' ? { axis: 'x', min: 280, maxRatio: 0.6 } : {}
  )

  const closeDetail = useCallback(() => { detailSeq.current++; setDetailEvent(null); setDetailFault(null); setDetailLoading(false) }, [])
  const readDetail = useCallback((eventId: string) => {
    const mine = ++detailSeq.current
    setDetailLoading(true)
    setDetailFault(null)
    window.redlog.events.getById([eventId]).then(evts => {
      if (mine !== detailSeq.current) return
      const evt = evts?.[0]
      if (evt) setDetailEvent({ id: evt.id, projectId: evt.engagementId, data: evt.data })
      else { setDetailEvent(null); setDetailFault({ id: eventId, kind: 'missing' }) }
      setDetailLoading(false)
    }).catch(() => {
      if (mine !== detailSeq.current) return
      setDetailEvent(null)
      setDetailFault({ id: eventId, kind: 'failed' })
      setDetailLoading(false)
    })
  }, [])
  const openDetailId = detailEvent?.id ?? detailFault?.id ?? null
  const openDetail = useCallback((eventId: string | null) => {
    if (!eventId) return
    if (openDetailId === eventId) { closeDetail(); return }
    readDetail(eventId)
  }, [openDetailId, closeDetail, readDetail])

  // Debounce the filter text: `filtered` (a sort), `activities` (groupFlows) and
  // `sitemapTree` (buildSitemapTree) all derive from it, so recomputing them on
  // every keystroke — even in `flows` view where the tree/activity aren't shown —
  // is wasted work on thousands of rows. The input stays bound to `filterText`
  // for responsiveness; the heavy derivation waits on the debounced value.
  const [filterTextDebounced, setFilterTextDebounced] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setFilterTextDebounced(filterText), 150)
    return () => clearTimeout(id)
  }, [filterText])

  // A changed filter is a new question (reset); the next page of the same one
  // is an append; traffic arriving asks the same question again (a 'head'
  // refresh: the newest page laid over what is loaded — new flows join, a flow
  // whose response just landed is replaced, the pages already followed stay).
  // The rows on screen stay until a new question's answer replaces them, and
  // only the first load shows the full-pane spinner: it replaces the toolbar,
  // so on every later load it unmounted the filter box under the cursor and,
  // with a proxy running, blinked the table and the open request.
  // A type chip this view cannot serve empties it rather than answering with
  // the wrong source type. UnappliedFilterNotice says so on screen; without it
  // the empty list read as "no HTTP traffic was recorded".
  const httpQuery = { ...(methodFilter ? { method: methodFilter } : {}), ...(statusFilter ? { statusPrefix: statusFilter } : {}), ...(hostFilter ? { host: hostFilter } : {}), text: filterTextDebounced }
  const flowRead = useLivePagedQuery<HttpFlow>({
    key: JSON.stringify([sharedFilter.agentType, sharedFilter.targetId, sharedFilter.timeRange, sharedFilter.inScopeOnly, sharedFilter.hidePersonal, sharedFilter.tier, httpQuery]),
    enabled: !sharedFilter.agentType || sharedFilter.agentType === HTTP_FLOW_AGENT_TYPE,
    fetch: async (cursor) => {
      const page = await window.redlog.events.queryHttpFlowPage({
        ...toEventFilter(sharedFilter),
        agentType: HTTP_FLOW_AGENT_TYPE,
        http: httpQuery,
        limit: 500,
        ...(cursor ? { cursor } : {})
      })
      return { rows: eventsToFlows(page.items), nextCursor: page.hasMore ? page.nextCursor : null }
    },
    live: { affects: isHttpFlowBatch, intervalMs: 300 },
    refresh: 'head',
    rowKey: flowKey,
    keepRowsOnReset: true
  })
  const flows = flowRead.rows
  const loading = flowRead.state.phase === 'loading'
  const { loadingMore, hasMore, loadMore } = flowRead
  const loadError = flowRead.state.phase === 'failed' ? flowRead.state.error : flowRead.moreFailed?.error ?? null
  const [loadedOnce, setLoadedOnce] = useState(false)
  useEffect(() => { if (!loading) setLoadedOnce(true) }, [loading])

  // Auto-follow the cursor to completion. Each append grows `flows` and
  // refreshes `hasMore`, re-running this effect until the record is whole or
  // the cap is reached. `loadError` stops the chain so a failed page surfaces
  // its retry (§US3) instead of being re-requested in a tight loop; the live
  // guards on `loading`/`loadingMore` keep only one page in flight.
  const autoFollowPending = hasMore && flows.length < AUTO_LOAD_MAX_FLOWS && !loadError
  // One page in flight, or the gap between pages before the next dispatch. The
  // completeness strip reads this as "loading", so the resting subset marker
  // and Load More button only appear once the cap is actually reached.
  const busy = loading || loadingMore || autoFollowPending

  useEffect(() => {
    if (loading || loadingMore || loadError) return
    if (!hasMore || flows.length >= AUTO_LOAD_MAX_FLOWS) return
    loadMore()
  }, [hasMore, loading, loadingMore, loadError, flows.length, loadMore])

  const methods = useMemo(() => {
    const s = new Set<string>()
    for (const f of flows) if (f.method) s.add(f.method)
    return Array.from(s).sort()
  }, [flows])

  const hosts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const f of flows) {
      const h = f.host || ''
      if (h) counts.set(h, (counts.get(h) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([h]) => h)
  }, [flows])
  // The host menu is built from the flows already narrowed by it, so with a
  // host chosen it held one entry and was not drawn: the filter could only be
  // cleared with "All". It stays while a host is chosen, holding that host.
  const hostOptions = hostFilter && !hosts.includes(hostFilter) ? [hostFilter, ...hosts] : hosts

  const filtered = useMemo(() => {
    let list = flows
    list = [...list].sort((a, b) => {
      const va = a[sortCol] ?? 0
      const vb = b[sortCol] ?? 0
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
    return list
  }, [flows, filterTextDebounced, methodFilter, statusFilter, hostFilter, sortCol, sortAsc])

  // §9 虛擬列表: window the flow table so a 10k-flow proxy session keeps ~30
  // <tr> mounted, not 10k. Rows are single-line and uniform, so a fixed size
  // needs no per-row measurement. Infinite-scroll (which kept every loaded row
  // mounted) is replaced by this.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useKeepScroll(scrollRef, active)
  // The table's own width, not the window's or the panel's: docked beside the
  // detail pane, or beside the Timeline, the table gets a fraction of either.
  const [tableBoxRef, tableWidth] = useContainerWidth<HTMLDivElement>()
  const columns = httpColumnsFor(tableWidth)
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 42,
    overscan: 12
  })

  // The same keys as every other list (§9). This view arrived from another
  // branch without them and the contract test did not notice, because it
  // named its five files by hand — see test/list-keyboard.test.tsx.
  // Nav spans the whole filtered list; onScrollToIndex lets the hook reach a
  // row the virtualizer hasn't mounted yet.
  const rowNav = useListKeyboard({
    count: filtered.length,
    enabled: active,
    onActivate: (i) => {
      const f = filtered[i]
      const id = f?.responseEventId ?? f?.requestEventId
      openDetail(id)
    },
    onJumpToTimeline: (i) => {
      const f = filtered[i]
      const id = f?.responseEventId ?? f?.requestEventId
      if (id) onOpenInTimeline?.(id, f.timestamp)
    },
    onEscape: () => { if (openDetailId) closeDetail(); else { setMethodFilter(null); setStatusFilter(null) } },
    onScrollToIndex: (i) => rowVirtualizer.scrollToIndex(i)
  })

  // Step the open detail to the previous/next flow in the filtered list — the
  // ◀ ▶ the Timeline inspector has, so the operator reads neighbouring requests
  // without going back to the table. The row is scrolled into view so a step
  // past the virtualised window still lands somewhere visible.
  const detailIndex = useMemo(
    () => (openDetailId ? filtered.findIndex((f) => (f.responseEventId ?? f.requestEventId) === openDetailId) : -1),
    [filtered, openDetailId]
  )
  const stepDetail = useCallback((delta: -1 | 1) => {
    if (detailIndex < 0) return
    const target = filtered[detailIndex + delta]
    const id = target?.responseEventId ?? target?.requestEventId
    if (!id) return
    rowVirtualizer.scrollToIndex(detailIndex + delta)
    openDetail(id)
  }, [filtered, detailIndex, rowVirtualizer, openDetail])

  // A shared-filter notice above already says why there are no flows (spec
  // 033 FR-012). "No HTTP traffic captured yet" beside it would claim what
  // this view cannot know under that condition, so it is not shown.
  const emptyExplained = (!!sharedFilter.agentType && sharedFilter.agentType !== HTTP_FLOW_AGENT_TYPE)
    || sharedFilter.tier === 'chained'
  const emptyText = flows.length === 0 ? (emptyExplained || loadError ? null : t('httpHistory.empty')) : t('httpHistory.noMatch')

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(false) }
  }

  const sortArrow = (col: typeof sortCol) =>
    sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : ''
  const ariaSort = (col: typeof sortCol): 'ascending' | 'descending' | 'none' =>
    sortCol === col ? (sortAsc ? 'ascending' : 'descending') : 'none'

  const harExportRequest = useMemo<ExportRequest>(() => ({
    format: 'har',
    subset: { kind: 'selection', projection: 'http', filter: toEventFilter(sharedFilter),
      http: { ...(methodFilter ? { method: methodFilter } : {}), ...(statusFilter ? { statusPrefix: statusFilter } : {}), ...(hostFilter ? { host: hostFilter } : {}), text: filterText } }
  }), [sharedFilter, methodFilter, statusFilter, hostFilter, filterText])
  useContributeExport(active ? { label: t('httpHistory.exportHar'), request: harExportRequest } : null)

  if (loading && !loadedOnce) {
    return (
      <LoadingSpinner label={t('common.loading')} />
    )
  }

  return (
    <div ref={containerRef} data-testid="http-workspace" className="flex flex-col h-full min-w-0 overflow-auto">
      <div className="shrink-0 flex flex-wrap min-w-0 items-center gap-2 px-pad py-2 border-b border-redlog-border-subtle/60 bg-redlog-bg/50">
        <span className="text-sm font-semibold text-redlog-text">{t('httpHistory.title')}</span>
        <span className="text-xs text-redlog-text-dim font-mono tabular-nums">
          {t('httpHistory.counts', { flows: filtered.length })}
        </span>
        {/* The prototype keeps the way to the capture settings in the header.
            An empty history already offers it as the one button of its empty
            state, so it is not drawn twice. */}
        {onOpenSettings && flows.length > 0 && (
          <button type="button" data-testid="http-capture-settings" onClick={onOpenSettings}
            className="min-h-8 text-xs text-redlog-text-dim underline hover:text-redlog-text">{t('httpHistory.captureSettings')}</button>
        )}

        <div className="flex-1" />
        <input
          type="text"
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          placeholder={t('httpHistory.filterPlaceholder')}
          className="text-xs font-mono bg-redlog-surface border border-redlog-border/60 rounded px-2 py-1 text-redlog-text placeholder-redlog-text-faint w-64 min-w-0 max-w-full focus:outline-none focus:border-redlog-accent/50"
        />
      </div>

      <div className="shrink-0 flex flex-wrap min-w-0 items-center gap-1.5 px-pad py-1 border-b border-redlog-border-subtle/40 bg-redlog-bg/30">
        <button
          onClick={() => { setMethodFilter(null); setStatusFilter(null); setHostFilter(null) }}
          aria-pressed={!methodFilter && !statusFilter && !hostFilter}
          className={`text-xs font-mono px-1.5 py-0.5 rounded ${!methodFilter && !statusFilter && !hostFilter ? 'bg-redlog-elevated border border-redlog-border text-redlog-text' : 'border border-transparent text-redlog-text-dim hover:text-redlog-text'}`}
        >{t('httpHistory.filterAll')}</button>
        {methods.map(m => (
          <button
            key={m}
            onClick={() => setMethodFilter(methodFilter === m ? null : m)}
            className={`text-xs font-mono px-1.5 py-0.5 rounded ${methodFilter === m ? 'bg-redlog-elevated border border-redlog-border text-redlog-text' : 'border border-transparent text-redlog-text-dim hover:text-redlog-text'}`}
          >{m}</button>
        ))}
        <span className="w-px h-3 bg-redlog-elevated-hover/60 mx-1" />
        {['2', '3', '4', '5'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            className={`text-xs font-mono px-1.5 py-0.5 rounded ${statusFilter === s ? 'bg-redlog-elevated border border-redlog-border text-redlog-text' : 'border border-transparent text-redlog-text-dim hover:text-redlog-text'}`}
          >{s}xx</button>
        ))}
        {(hosts.length > 1 || hostFilter) && (
          <>
            <span className="w-px h-3 bg-redlog-elevated-hover/60 mx-1" />
            <select
              value={hostFilter ?? ''}
              onChange={e => setHostFilter(e.target.value || null)}
              className="text-xs font-mono bg-redlog-surface border border-redlog-border/60 rounded px-1.5 py-0.5 text-redlog-text-dim focus:outline-none focus:border-redlog-accent/50 max-w-[200px]"
            >
              <option value="">{t('httpHistory.allHosts')}</option>
              {hostOptions.map(h => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {sharedFilter.agentType && sharedFilter.agentType !== HTTP_FLOW_AGENT_TYPE && (
        <UnappliedFilterNotice
          title={t('filter.unappliedTitle', { condition: `${t('filter.type')}: ${sharedFilter.agentType}` })}
          reason={t('filter.unappliedHttpType')}
        />
      )}
      {sharedFilter.tier === 'chained' && (
        <EmptyByConstructionNotice text={t('filter.chainedOnlyHttp')} />
      )}

      <div className="shrink-0 flex flex-wrap items-center gap-2 px-pad py-1 border-b border-redlog-border-subtle/40 text-xs">
        {busy ? (
          // Auto-following to completion: either a page is in flight, or the
          // last one settled and the next is about to be dispatched. Held as
          // one "loading" state (§FR-004) so the Load More button does not
          // flicker into the gap between pages.
          <span data-testid="http-completeness" className="flex items-center gap-1.5 text-redlog-text-dim">
            <span aria-hidden className="animate-spin w-3 h-3 border-2 border-redlog-border border-t-transparent rounded-full" />
            {t('httpHistory.loadingMore')}
          </span>
        ) : !loadError ? (
          // At rest: complete, or — only past AUTO_LOAD_MAX_FLOWS — the capped
          // subset with a manual continue.
          <span data-testid="http-completeness" className={hasMore ? 'text-amber-400' : 'text-emerald-500'}>
            {t(hasMore ? 'httpHistory.recentSubset' : 'httpHistory.complete', { max: AUTO_LOAD_MAX_FLOWS })}
          </span>
        ) : null}
        {hasMore && !busy && (
          <button type="button" onClick={loadMore} className="text-redlog-cyan underline">
            {t('httpHistory.loadMore')}
          </button>
        )}
        {loadError && (
          <span data-testid="http-load-error" role="alert" className="min-w-0 break-words text-red-300">
            {t('httpHistory.loadFailed')}{' '}
            <button type="button" onClick={flowRead.retry} className="underline">{t('common.retry')}</button>
          </span>
        )}
      </div>

      <div data-testid="http-workspace-split" data-layout={layout} className={`flex-1 min-h-48 flex ${layout === 'right' ? 'flex-row' : 'flex-col'}`}>
        <div
          ref={(el) => { scrollRef.current = el; tableBoxRef(el) }}
          data-testid="http-table-scroll"
          data-columns={columns.tier}
          className="flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden"
        >
          {/* Fixed layout: an auto table ignores a cell's max-width, so long
              hosts and paths pushed the columns into each other instead of
              truncating. Narrower, the table drops the low-priority columns
              rather than scrolling sideways. */}
          <table className="w-full table-fixed text-xs font-mono">
            <thead className="sticky top-0 whitespace-nowrap bg-redlog-surface/95 z-10">
              <tr className="text-redlog-text-dim uppercase tracking-wider text-left">
                <th className="pl-pad pr-2 py-1.5 font-medium w-24" aria-sort={ariaSort('timestamp')}>
                  <Button level="quiet" size="compact" onClick={() => toggleSort('timestamp')}>{t('httpHistory.colWhen')}{sortArrow('timestamp')}</Button>
                </th>
                <th className="px-2 py-1.5 font-medium w-20">{t('httpHistory.colMethod')}</th>
                <th className="px-2 py-1.5 font-medium w-24" aria-sort={ariaSort('status')}>
                  <Button level="quiet" size="compact" onClick={() => toggleSort('status')}>{t('httpHistory.colStatus')}{sortArrow('status')}</Button>
                </th>
                {columns.hostApart
                  ? <>
                    <th className={`px-2 py-1.5 font-medium ${columns.tier === 'wide' ? 'w-[25%]' : 'w-[30%]'}`}>{t('httpHistory.colHost')}</th>
                    <th className={`pl-2 ${columns.detail ? 'pr-2' : 'pr-pad'} py-1.5 font-medium`}>{t('httpHistory.colUrl')}</th>
                  </>
                  : <th className={`pl-2 ${columns.detail ? 'pr-2' : 'pr-pad'} py-1.5 font-medium truncate`} title={`${t('httpHistory.colHost')} / ${t('httpHistory.colUrl')}`}>{t('httpHistory.colHost')} / {t('httpHistory.colUrl')}</th>}
                {columns.detail && <>
                  <th className="px-2 py-1.5 font-medium w-28">{t('httpHistory.colType')}</th>
                  <th className="px-2 py-1.5 font-medium w-20 text-right" aria-sort={ariaSort('size')}>
                    <Button level="quiet" size="compact" onClick={() => toggleSort('size')}>{t('httpHistory.colSize')}{sortArrow('size')}</Button>
                  </th>
                  <th className="pl-2 pr-pad py-1.5 font-medium w-20 text-right" aria-sort={ariaSort('durationMs')}>
                    <Button level="quiet" size="compact" onClick={() => toggleSort('durationMs')}>{t('httpHistory.colTime')}{sortArrow('durationMs')}</Button>
                  </th>
                </>}
              </tr>
            </thead>
            <tbody {...rowNav.containerProps}>
              {(() => {
                const items = rowVirtualizer.getVirtualItems()
                const padTop = items.length ? items[0].start : 0
                const padBottom = items.length ? rowVirtualizer.getTotalSize() - items[items.length - 1].end : 0
                return (
                  <>
                    {padTop > 0 && <tr aria-hidden="true"><td colSpan={columns.count} style={{ height: padTop, padding: 0, border: 0 }} /></tr>}
                    {items.map((vi) => {
                const f = filtered[vi.index]
                const rowIndex = vi.index
                const statusClass = f.status !== null
                  ? STATUS_COLORS[String(f.status)[0]] ?? 'text-redlog-text-dim'
                  : 'text-redlog-text-faint'
                // The method is a category, and every row has one. DELETE in
                // particular is the target's verb, not RedLog warning about
                // anything, so red on it spends the colour that has to mean
                // "look here".
                const methodClass = 'text-redlog-text-dim'
                const scopeState = httpScopeState(f.url, scopeRead.state.phase === 'failed' ? null : scopeRead.state.value ?? null)
                const eventId = f.responseEventId ?? f.requestEventId
                const urlPath = (() => {
                  try { return new URL(f.url).pathname + (new URL(f.url).search || '') }
                  catch { return f.url }
                })()
                const rowProps = rowNav.itemProps(rowIndex)
                return (
                  <tr
                    key={f.flowId}
                    {...rowProps}
                    ref={(el) => rowProps.ref(el as unknown as HTMLElement | null)}
                    style={{ height: 42 }}
                    className="border-b border-redlog-border-subtle/30 hover:bg-redlog-elevated/30 cursor-pointer focus-visible:outline-none focus-visible:bg-redlog-elevated/50"
                    onClick={() => { rowProps.onClick(); openDetail(eventId) }}
                  >
                    <td className="pl-pad pr-2 py-1 text-redlog-text-faint tabular-nums truncate" title={formatTime(f.timestamp, { seconds: true })}>{formatTime(f.timestamp, { seconds: true })}</td>
                    <td className={`px-2 py-1 font-semibold truncate ${methodClass}`} title={f.method}>{f.method}</td>
                    <td className={`px-2 py-1 truncate ${statusClass}`} title={String(f.status ?? '—')}>{f.status ?? '—'}</td>
                    <td className={`pl-2 ${columns.hostApart || columns.detail ? 'pr-2' : 'pr-pad'} py-1 text-redlog-text-dim`}>
                      {/* Host apart: host over its scope word. Host and path in
                          one cell: host and scope word share the first line,
                          so the row keeps its fixed 42px for the virtualizer. */}
                      <span className={columns.hostApart ? 'block' : 'flex min-w-0 items-baseline gap-2'}>
                        <span className="block min-w-0 truncate" title={f.host}>{f.host}</span>
                        {/* No scope at all is a fact about the project, not the row: the
                            status bar's scope chip says it on every page. */}
                        {scopeState !== 'in-scope' && scopeState !== 'no-scope' && <span data-testid="http-scope-state" data-scope={scopeState} className={`block shrink-0 text-xs ${scopeState === 'out-of-scope' ? 'text-amber-400' : 'text-redlog-text-faint'}`}>{t(`httpScope.${scopeState}`)}</span>}
                      </span>
                      {!columns.hostApart && <span className="block truncate text-redlog-text" title={f.url}>{urlPath}</span>}
                    </td>
                    {columns.hostApart && <td className={`pl-2 ${columns.detail ? 'pr-2' : 'pr-pad'} py-1 text-redlog-text truncate`} title={f.url}>{urlPath}</td>}
                    {columns.detail && <>
                      <td className="px-2 py-1 text-redlog-text-dim truncate" title={f.contentType}>
                        {f.contentType.replace(/^application\//, '').replace(/;.*/, '')}
                      </td>
                      <td className="px-2 py-1 text-redlog-text-dim text-right truncate" title={f.size !== null ? formatBytes(f.size) : '—'}>{f.size !== null ? formatBytes(f.size) : '—'}</td>
                      <td className="pl-2 pr-pad py-1 text-redlog-text-dim text-right truncate" title={f.durationMs !== null ? `${f.durationMs}ms` : '—'}>{f.durationMs !== null ? `${f.durationMs}ms` : '—'}</td>
                    </>}
                  </tr>
                )
                    })}
                    {padBottom > 0 && <tr aria-hidden="true"><td colSpan={columns.count} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>}
                  </>
                )
              })()}
            </tbody>
          </table>
          {filtered.length === 0 && emptyText && (
            <div className="flex flex-col items-center justify-center gap-3 py-6 text-redlog-text-faint text-sm">
              {emptyText}
              {flows.length === 0 && !filterText && !methodFilter && !statusFilter && !hostFilter
                && !sharedFilter.targetId && !sharedFilter.timeRange && !sharedFilter.inScopeOnly && onOpenSettings && (
                <button type="button" onClick={onOpenSettings} className="min-h-8 text-redlog-text-dim underline hover:text-redlog-text">{t('browser.openSettings')}</button>
              )}
            </div>
          )}
        </div>

        {(detailEvent || detailLoading || detailFault) && (
          <>
            {/* Resize handle on the edge the pane grows from — same as the Timeline. */}
            <div
              data-testid="http-detail-resize"
              className={`shrink-0 bg-redlog-elevated/50 hover:bg-red-500/40 transition-colors relative ${
                layout === 'bottom' ? 'h-1 cursor-row-resize' : 'w-1 cursor-col-resize'
              }`}
              title={t('timeline.resizeDetailPanel')}
              onMouseDown={(e) => {
                const box = detailPanelRef.current?.getBoundingClientRect()
                detailPanel.beginResize(e, layout === 'bottom' ? box?.height ?? 320 : box?.width ?? 440)
              }}
              onDoubleClick={detailPanel.reset}
            >
              <div className={`absolute rounded bg-redlog-elevated-hover/50 pointer-events-none ${
                layout === 'bottom'
                  ? 'left-1/2 top-0 -translate-x-1/2 h-1 w-8'
                  : 'top-1/2 left-0 -translate-y-1/2 w-1 h-8'
              }`} />
            </div>
            <div
              ref={detailPanelRef}
              data-testid="http-detail-panel"
              className={`shrink-0 min-w-0 min-h-0 bg-redlog-surface overflow-auto ${
                layout === 'bottom'
                  ? `border-t border-redlog-border${detailPanel.px == null ? ' max-h-[50%]' : ''}`
                  : 'border-l border-redlog-border h-full'
              }`}
              style={layout === 'right'
                ? { width: Math.min(detailPanel.px ?? 440, Math.max(280, (containerWidth ?? 1000) - 480)) }
                : { ...(detailPanel.px === null ? {} : { height: detailPanel.px }), maxHeight: '65%' }}
            >
              <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-redlog-border-subtle/60 bg-redlog-surface">
                <span className="text-xs font-semibold text-redlog-text">{t('httpHistory.detail')}</span>

                {/* ◀ ▶ step to the previous/next request without returning to the table. */}
                <div className="flex items-center">
                  <button
                    data-testid="http-detail-step-prev"
                    onClick={() => stepDetail(-1)}
                    disabled={detailIndex <= 0}
                    title={t('timeline.stepPrev')}
                    aria-label={t('timeline.stepPrev')}
                    className="text-redlog-text-dim hover:text-redlog-text disabled:opacity-30 disabled:hover:text-redlog-text-dim p-0.5 rounded hover:bg-redlog-elevated/40"
                  ><ChevronLeft size={14} aria-hidden /></button>
                  <button
                    data-testid="http-detail-step-next"
                    onClick={() => stepDetail(1)}
                    disabled={detailIndex < 0 || detailIndex >= filtered.length - 1}
                    title={t('timeline.stepNext')}
                    aria-label={t('timeline.stepNext')}
                    className="text-redlog-text-dim hover:text-redlog-text disabled:opacity-30 disabled:hover:text-redlog-text-dim p-0.5 rounded hover:bg-redlog-elevated/40"
                  ><ChevronRight size={14} aria-hidden /></button>
                </div>

                {detailEvent && onOpenInTimeline && (
                  <button
                    onClick={() => { const d = detailEvent.data; onOpenInTimeline(detailEvent.id, typeof d.timestamp === 'number' ? d.timestamp : Date.now()) }}
                    title={t('common.openAtMoment')}
                    className="text-xs text-redlog-text-dim hover:text-redlog-text font-mono px-1.5 py-0.5 rounded border border-redlog-border/60 hover:bg-redlog-elevated/40"
                  >↗ {t('httpHistory.openInTimeline')}</button>
                )}
                <div className="flex-1" />

                {/* Dock under the table or beside it — the same choice (and store) as the Timeline. */}
                <button
                  data-testid="http-detail-layout-toggle"
                  disabled={compact}
                  onClick={() => setDetailLayout(preferredLayout === 'bottom' ? 'right' : 'bottom')}
                  title={t(layout === 'bottom' ? 'timeline.layoutToRight' : 'timeline.layoutToBottom')}
                  aria-label={t(layout === 'bottom' ? 'timeline.layoutToRight' : 'timeline.layoutToBottom')}
                  aria-pressed={layout === 'right'}
                  className="text-redlog-text-dim hover:text-redlog-text p-0.5 rounded hover:bg-redlog-elevated/40 disabled:opacity-40"
                >
                  {layout === 'bottom'
                    ? <PanelBottom size={14} aria-hidden />
                    : <PanelRight size={14} aria-hidden />}
                </button>
                <button
                  onClick={closeDetail}
                  className="text-redlog-text-dim hover:text-redlog-text p-0.5 rounded hover:bg-redlog-elevated/40"
                  aria-label={t('httpHistory.closeDetail')}
                >
                  <X size={14} />
                </button>
              </div>
              {detailLoading ? (
                <div className="flex items-center justify-center py-6">
                  <div className="animate-spin w-4 h-4 border-2 border-redlog-border border-t-transparent rounded-full" />
                </div>
              ) : detailEvent ? (
                <div className="px-3 py-2">
                  <HttpDetail projectId={detailEvent.projectId} data={detailEvent.data} eventId={detailEvent.id} />
                </div>
              ) : detailFault?.kind === 'failed' ? (
                <div data-testid="http-detail-failed" role="alert" className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-amber-400">
                  <span>{t('httpHistory.detailFailed')}</span>
                  <Button level="quiet" size="compact" onClick={() => readDetail(detailFault.id)}>{t('common.retry')}</Button>
                </div>
              ) : detailFault ? (
                <p data-testid="http-detail-missing" role="status" className="px-3 py-2 text-xs text-redlog-text-dim">{t('httpHistory.detailMissing')}</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
