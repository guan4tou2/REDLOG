import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const STATUS_COLORS: Record<string, string> = {
  '2': 'text-green-400',
  '3': 'text-blue-400',
  '4': 'text-amber-400',
  '5': 'text-red-400'
}

// ---------------------------------------------------------------------------
// Sitemap tree data structure
// ---------------------------------------------------------------------------

interface SitemapNode {
  name: string
  fullPath: string
  children: Map<string, SitemapNode>
  flows: HttpFlow[]
  methods: Set<string>
  statuses: Set<number>
}

function buildSitemapTree(flows: HttpFlow[]): Map<string, SitemapNode> {
  const roots = new Map<string, SitemapNode>()

  for (const f of flows) {
    let host: string
    let pathname: string
    let query: string
    try {
      const u = new URL(f.url)
      host = u.host
      pathname = u.pathname
      query = u.search
    } catch {
      host = f.host || '(unknown)'
      pathname = f.url
      query = ''
    }

    if (!roots.has(host)) {
      roots.set(host, { name: host, fullPath: host, children: new Map(), flows: [], methods: new Set(), statuses: new Set() })
    }
    const hostNode = roots.get(host)!
    hostNode.flows.push(f)
    hostNode.methods.add(f.method)
    if (f.status !== null) hostNode.statuses.add(f.status)

    const segments = pathname.split('/').filter(Boolean)
    let current = hostNode
    let builtPath = host

    for (const seg of segments) {
      builtPath += '/' + seg
      if (!current.children.has(seg)) {
        current.children.set(seg, { name: seg, fullPath: builtPath, children: new Map(), flows: [], methods: new Set(), statuses: new Set() })
      }
      const child = current.children.get(seg)!
      child.flows.push(f)
      child.methods.add(f.method)
      if (f.status !== null) child.statuses.add(f.status)
      current = child
    }

    if (query) {
      const qKey = query
      if (!current.children.has(qKey)) {
        current.children.set(qKey, { name: qKey, fullPath: builtPath + qKey, children: new Map(), flows: [], methods: new Set(), statuses: new Set() })
      }
      const qNode = current.children.get(qKey)!
      qNode.flows.push(f)
      qNode.methods.add(f.method)
      if (f.status !== null) qNode.statuses.add(f.status)
    }
  }

  return roots
}

function SitemapTreeNode({ node, depth, onOpenInTimeline }: {
  node: SitemapNode
  depth: number
  onOpenInTimeline?: (eventId: string, ts: number) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = node.children.size > 0
  const sortedChildren = useMemo(() =>
    Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name)),
    [node.children]
  )

  const uniqueFlowCount = node.flows.length
  const methodArr = Array.from(node.methods)
  const statusArr = Array.from(node.statuses).sort()

  const handleClick = () => {
    if (hasChildren) {
      setExpanded(!expanded)
    } else if (node.flows.length === 1) {
      const f = node.flows[0]
      const eid = f.responseEventId ?? f.requestEventId
      if (eid) onOpenInTimeline?.(eid, f.timestamp)
    }
  }

  return (
    <div>
      <div
        className="flex items-center gap-1 px-1 py-0.5 hover:bg-redlog-elevated/40 cursor-pointer select-none"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={handleClick}
      >
        <span className="w-3 text-[10px] text-redlog-text-faint flex-shrink-0">
          {hasChildren ? (expanded ? '▾' : '▸') : '·'}
        </span>
        <span
          title={node.fullPath}
          className={`text-[11px] font-mono truncate ${depth === 0 ? 'text-redlog-accent font-semibold' : 'text-redlog-text'}`}
        >
          {depth === 0 ? node.name : '/' + node.name}
        </span>
        <span className="flex-shrink-0 flex items-center gap-1 ml-auto">
          {methodArr.map(m => (
            <span key={m} className={`text-[9px] font-mono px-1 rounded ${
              m === 'GET' ? 'text-green-500/70 bg-green-900/20'
                : m === 'POST' ? 'text-amber-500/70 bg-amber-900/20'
                  : m === 'PUT' || m === 'PATCH' ? 'text-blue-500/70 bg-blue-900/20'
                    : m === 'DELETE' ? 'text-red-500/70 bg-red-900/20'
                      : 'text-redlog-text-dim/70 bg-redlog-elevated/40'
            }`}>{m}</span>
          ))}
          {statusArr.length > 0 && statusArr.length <= 3 && statusArr.map(s => (
            <span key={s} className={`text-[9px] font-mono ${STATUS_COLORS[String(s)[0]] ?? 'text-redlog-text-dim'}`}>
              {s}
            </span>
          ))}
          <span className="text-[9px] text-redlog-text-faint font-mono min-w-[24px] text-right">
            {uniqueFlowCount}
          </span>
        </span>
      </div>
      {expanded && sortedChildren.map(child => (
        <SitemapTreeNode
          key={child.fullPath}
          node={child}
          depth={depth + 1}
          onOpenInTimeline={onOpenInTimeline}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function HttpHistoryPanel({ onOpenInTimeline }: {
  onOpenInTimeline?: (eventId: string, ts: number) => void
}): JSX.Element {
  const { t } = useI18n()
  const [flows, setFlows] = useState<HttpFlow[]>([])
  const [loading, setLoading] = useState(true)
  const [filterText, setFilterText] = useState('')
  const [methodFilter, setMethodFilter] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [sortCol, setSortCol] = useState<'timestamp' | 'status' | 'size' | 'durationMs'>('timestamp')
  const [sortAsc, setSortAsc] = useState(false)
  const [viewMode, setViewMode] = useState<'table' | 'sitemap'>('table')

  const loadFlows = useCallback(async () => {
    const events = await window.redlog.events.query({
      agentType: 'scanner',
      limit: 5000,
      tier: 'logged'
    })

    const flowMap = new Map<string, {
      request: RedLogEvent | null
      response: RedLogEvent | null
    }>()

    for (const evt of events) {
      const sub = evt.data?.subtype as string
      const fid = evt.data?.flow_id as string
      if (!fid) continue
      if (sub !== 'http_request_start' && sub !== 'http_response') continue

      if (!flowMap.has(fid)) flowMap.set(fid, { request: null, response: null })
      const entry = flowMap.get(fid)!
      if (sub === 'http_request_start') entry.request = evt
      else entry.response = evt
    }

    const result: HttpFlow[] = []
    for (const [flowId, { request, response }] of flowMap) {
      const req = request?.data
      const resp = response?.data
      result.push({
        flowId,
        method: String(req?.method ?? resp?.method ?? ''),
        url: String(req?.url ?? resp?.url ?? ''),
        host: String(req?.host ?? resp?.host ?? ''),
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
      })
    }

    setFlows(result)
    setLoading(false)
  }, [])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debouncedLoadFlows = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { debounceRef.current = null; loadFlows() }, 300)
  }, [loadFlows])

  useEffect(() => {
    loadFlows()
    const unsub = window.redlog.events.onNew((evt) => {
      const sub = (evt as RedLogEvent).data?.subtype as string
      if ((evt as RedLogEvent).agentType === 'scanner' &&
        (sub === 'http_request_start' || sub === 'http_response')) {
        debouncedLoadFlows()
      }
    })
    return () => { unsub(); if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [loadFlows, debouncedLoadFlows])

  const methods = useMemo(() => {
    const s = new Set<string>()
    for (const f of flows) if (f.method) s.add(f.method)
    return Array.from(s).sort()
  }, [flows])

  const filtered = useMemo(() => {
    let list = flows
    if (filterText) {
      const q = filterText.toLowerCase()
      list = list.filter(f =>
        f.url.toLowerCase().includes(q) ||
        f.host.toLowerCase().includes(q) ||
        f.contentType.toLowerCase().includes(q)
      )
    }
    if (methodFilter) list = list.filter(f => f.method === methodFilter)
    if (statusFilter) {
      list = list.filter(f => f.status !== null && String(f.status).startsWith(statusFilter))
    }

    list = [...list].sort((a, b) => {
      const va = a[sortCol] ?? 0
      const vb = b[sortCol] ?? 0
      return sortAsc ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
    return list
  }, [flows, filterText, methodFilter, statusFilter, sortCol, sortAsc])

  const PAGE_SIZE = 200
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinelRef = useRef<HTMLTableRowElement | null>(null)

  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [filtered])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setVisibleCount(prev => Math.min(prev + PAGE_SIZE, filtered.length))
    }, { rootMargin: '200px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [filtered.length, visibleCount])

  const visibleRows = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])

  // The same keys as every other list (§9). This view arrived from another
  // branch without them and the contract test did not notice, because it
  // named its five files by hand — see test/list-keyboard.test.tsx.
  const rowNav = useListKeyboard({
    count: visibleRows.length,
    onActivate: (i) => {
      const f = visibleRows[i]
      const id = f?.responseEventId ?? f?.requestEventId
      if (id) onOpenInTimeline?.(id, f.timestamp)
    },
    onJumpToTimeline: (i) => {
      const f = visibleRows[i]
      const id = f?.responseEventId ?? f?.requestEventId
      if (id) onOpenInTimeline?.(id, f.timestamp)
    },
    onEscape: () => { setMethodFilter(null); setStatusFilter(null) }
  })

  const sitemapTree = useMemo(() => buildSitemapTree(filtered), [filtered])

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortAsc(!sortAsc)
    else { setSortCol(col); setSortAsc(false) }
  }

  const sortArrow = (col: typeof sortCol) =>
    sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : ''

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-5 h-5 border-2 border-redlog-border border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-redlog-border-subtle/60 bg-redlog-bg/50">
        <span className="text-sm font-semibold text-redlog-text">{t('httpHistory.title')}</span>
        <span className="text-xs text-redlog-text-dim font-mono">{filtered.length}/{flows.length}</span>

        <div className="flex items-center gap-0.5 ml-3 bg-redlog-elevated/60 rounded p-0.5">
          <button
            onClick={() => setViewMode('table')}
            className={`text-[10px] font-mono px-2 py-0.5 rounded ${viewMode === 'table' ? 'bg-redlog-elevated-hover text-redlog-text' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          >{t('httpHistory.viewTable')}</button>
          <button
            onClick={() => setViewMode('sitemap')}
            className={`text-[10px] font-mono px-2 py-0.5 rounded ${viewMode === 'sitemap' ? 'bg-redlog-elevated-hover text-redlog-text' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          >{t('httpHistory.viewSitemap')}</button>
        </div>

        <div className="flex-1" />
        <input
          type="text"
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          placeholder={t('httpHistory.filterPlaceholder')}
          className="text-xs font-mono bg-redlog-surface border border-redlog-border/60 rounded px-2 py-1 text-redlog-text placeholder-redlog-text-faint w-64 focus:outline-none focus:border-redlog-accent/50"
        />
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-redlog-border-subtle/40 bg-redlog-bg/30">
        <button
          onClick={() => setMethodFilter(null)}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${!methodFilter ? 'bg-indigo-600/30 text-indigo-300' : 'text-redlog-text-dim hover:text-redlog-text'}`}
        >{t('httpHistory.filterAll')}</button>
        {methods.map(m => (
          <button
            key={m}
            onClick={() => setMethodFilter(methodFilter === m ? null : m)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${methodFilter === m ? 'bg-indigo-600/30 text-indigo-300' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          >{m}</button>
        ))}
        <span className="w-px h-3 bg-redlog-elevated-hover/60 mx-1" />
        {['2', '3', '4', '5'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${statusFilter === s ? 'bg-indigo-600/30 text-indigo-300' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          >{s}xx</button>
        ))}
      </div>

      {viewMode === 'table' ? (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-redlog-surface/95 z-10">
              <tr className="text-redlog-text-dim uppercase tracking-wider text-left">
                <th className="px-2 py-1.5 font-medium w-16">{t('httpHistory.colMethod')}</th>
                <th className="px-2 py-1.5 font-medium cursor-pointer select-none w-14" onClick={() => toggleSort('status')}>
                  Status{sortArrow('status')}
                </th>
                <th className="px-2 py-1.5 font-medium">{t('httpHistory.colHost')}</th>
                <th className="px-2 py-1.5 font-medium">{t('httpHistory.colUrl')}</th>
                <th className="px-2 py-1.5 font-medium w-28">{t('httpHistory.colType')}</th>
                <th className="px-2 py-1.5 font-medium cursor-pointer select-none w-20 text-right" onClick={() => toggleSort('size')}>
                  Size{sortArrow('size')}
                </th>
                <th className="px-2 py-1.5 font-medium cursor-pointer select-none w-16 text-right" onClick={() => toggleSort('durationMs')}>
                  Time{sortArrow('durationMs')}
                </th>
                <th className="px-2 py-1.5 font-medium cursor-pointer select-none w-20 text-right" onClick={() => toggleSort('timestamp')}>
                  When{sortArrow('timestamp')}
                </th>
              </tr>
            </thead>
            <tbody {...rowNav.containerProps}>
              {visibleRows.map((f, rowIndex) => {
                const statusClass = f.status !== null
                  ? STATUS_COLORS[String(f.status)[0]] ?? 'text-redlog-text-dim'
                  : 'text-redlog-text-faint'
                const methodClass = f.method === 'GET' ? 'text-green-400'
                  : f.method === 'POST' ? 'text-amber-400'
                    : f.method === 'PUT' || f.method === 'PATCH' ? 'text-blue-400'
                      : f.method === 'DELETE' ? 'text-red-400' : 'text-redlog-text-dim'
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
                    className="border-b border-redlog-border-subtle/30 hover:bg-redlog-elevated/30 cursor-pointer focus-visible:outline-none focus-visible:bg-redlog-elevated/50"
                    onClick={() => { rowProps.onClick(); if (eventId) onOpenInTimeline?.(eventId, f.timestamp) }}
                  >
                    <td className={`px-2 py-1 font-semibold ${methodClass}`}>{f.method}</td>
                    <td className={`px-2 py-1 ${statusClass}`}>{f.status ?? '—'}</td>
                    <td className="px-2 py-1 text-redlog-text-dim max-w-[160px] truncate" title={f.host}>{f.host}</td>
                    <td className="px-2 py-1 text-redlog-text max-w-[400px] truncate" title={f.url}>{urlPath}</td>
                    <td className="px-2 py-1 text-redlog-text-dim max-w-[120px] truncate" title={f.contentType}>
                      {f.contentType.replace(/^application\//, '').replace(/;.*/, '')}
                    </td>
                    <td className="px-2 py-1 text-redlog-text-dim text-right">{f.size !== null ? formatBytes(f.size) : '—'}</td>
                    <td className="px-2 py-1 text-redlog-text-dim text-right">{f.durationMs !== null ? `${f.durationMs}ms` : '—'}</td>
                    <td className="px-2 py-1 text-redlog-text-faint text-right tabular-nums">{formatTime(f.timestamp, { seconds: true })}</td>
                  </tr>
                )
              })}
              {visibleCount < filtered.length && (
                <tr ref={sentinelRef}><td colSpan={8} className="text-center py-2 text-redlog-text-faint text-[10px]">Loading more...</td></tr>
              )}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="flex items-center justify-center py-12 text-redlog-text-faint text-sm">
              {flows.length === 0 ? 'No HTTP traffic captured yet' : 'No flows match the current filters'}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto py-1">
          {sitemapTree.size === 0 ? (
            <div className="flex items-center justify-center py-12 text-redlog-text-faint text-sm">
              {flows.length === 0 ? 'No HTTP traffic captured yet' : 'No flows match the current filters'}
            </div>
          ) : (
            Array.from(sitemapTree.values())
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(node => (
                <SitemapTreeNode
                  key={node.fullPath}
                  node={node}
                  depth={0}
                  onOpenInTimeline={onOpenInTimeline}
                />
              ))
          )}
        </div>
      )}
    </div>
  )
}
