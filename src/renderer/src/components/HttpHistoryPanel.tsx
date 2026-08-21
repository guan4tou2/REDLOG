import { useState, useEffect, useMemo, useCallback } from 'react'
import { useI18n } from '../i18n'

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
        className="flex items-center gap-1 px-1 py-0.5 hover:bg-zinc-800/40 cursor-pointer select-none"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        onClick={handleClick}
      >
        <span className="w-3 text-[10px] text-zinc-600 flex-shrink-0">
          {hasChildren ? (expanded ? '▾' : '▸') : '·'}
        </span>
        <span className={`text-[11px] font-mono truncate ${depth === 0 ? 'text-indigo-400 font-semibold' : 'text-zinc-300'}`}>
          {depth === 0 ? node.name : '/' + node.name}
        </span>
        <span className="flex-shrink-0 flex items-center gap-1 ml-auto">
          {methodArr.map(m => (
            <span key={m} className={`text-[9px] font-mono px-1 rounded ${
              m === 'GET' ? 'text-green-500/70 bg-green-900/20'
                : m === 'POST' ? 'text-amber-500/70 bg-amber-900/20'
                  : m === 'PUT' || m === 'PATCH' ? 'text-blue-500/70 bg-blue-900/20'
                    : m === 'DELETE' ? 'text-red-500/70 bg-red-900/20'
                      : 'text-zinc-500/70 bg-zinc-800/40'
            }`}>{m}</span>
          ))}
          {statusArr.length > 0 && statusArr.length <= 3 && statusArr.map(s => (
            <span key={s} className={`text-[9px] font-mono ${STATUS_COLORS[String(s)[0]] ?? 'text-zinc-500'}`}>
              {s}
            </span>
          ))}
          <span className="text-[9px] text-zinc-600 font-mono min-w-[24px] text-right">
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

  useEffect(() => {
    loadFlows()
    const unsub = window.redlog.events.onNew((evt) => {
      const sub = (evt as RedLogEvent).data?.subtype as string
      if ((evt as RedLogEvent).agentType === 'scanner' &&
        (sub === 'http_request_start' || sub === 'http_response')) {
        loadFlows()
      }
    })
    return unsub
  }, [loadFlows])

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
        <div className="animate-spin w-5 h-5 border-2 border-zinc-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-950/50">
        <span className="text-sm font-semibold text-zinc-300">HTTP History</span>
        <span className="text-xs text-zinc-500 font-mono">{filtered.length}/{flows.length}</span>

        <div className="flex items-center gap-0.5 ml-3 bg-zinc-800/60 rounded p-0.5">
          <button
            onClick={() => setViewMode('table')}
            className={`text-[10px] font-mono px-2 py-0.5 rounded ${viewMode === 'table' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
          >Table</button>
          <button
            onClick={() => setViewMode('sitemap')}
            className={`text-[10px] font-mono px-2 py-0.5 rounded ${viewMode === 'sitemap' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
          >Sitemap</button>
        </div>

        <div className="flex-1" />
        <input
          type="text"
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          placeholder="Filter URL / host / type..."
          className="text-xs font-mono bg-zinc-900 border border-zinc-700/60 rounded px-2 py-1 text-zinc-300 placeholder-zinc-600 w-64 focus:outline-none focus:border-indigo-500/50"
        />
      </div>

      <div className="flex items-center gap-1.5 px-3 py-1 border-b border-zinc-800/40 bg-zinc-950/30">
        <button
          onClick={() => setMethodFilter(null)}
          className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${!methodFilter ? 'bg-indigo-600/30 text-indigo-300' : 'text-zinc-500 hover:text-zinc-300'}`}
        >ALL</button>
        {methods.map(m => (
          <button
            key={m}
            onClick={() => setMethodFilter(methodFilter === m ? null : m)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${methodFilter === m ? 'bg-indigo-600/30 text-indigo-300' : 'text-zinc-500 hover:text-zinc-300'}`}
          >{m}</button>
        ))}
        <span className="w-px h-3 bg-zinc-700/60 mx-1" />
        {['2', '3', '4', '5'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${statusFilter === s ? 'bg-indigo-600/30 text-indigo-300' : 'text-zinc-500 hover:text-zinc-300'}`}
          >{s}xx</button>
        ))}
      </div>

      {viewMode === 'table' ? (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-zinc-900/95 z-10">
              <tr className="text-zinc-500 uppercase tracking-wider text-left">
                <th className="px-2 py-1.5 font-medium w-16">Method</th>
                <th className="px-2 py-1.5 font-medium cursor-pointer select-none w-14" onClick={() => toggleSort('status')}>
                  Status{sortArrow('status')}
                </th>
                <th className="px-2 py-1.5 font-medium">Host</th>
                <th className="px-2 py-1.5 font-medium">URL</th>
                <th className="px-2 py-1.5 font-medium w-28">Type</th>
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
            <tbody>
              {filtered.map(f => {
                const statusClass = f.status !== null
                  ? STATUS_COLORS[String(f.status)[0]] ?? 'text-zinc-400'
                  : 'text-zinc-600'
                const methodClass = f.method === 'GET' ? 'text-green-400'
                  : f.method === 'POST' ? 'text-amber-400'
                    : f.method === 'PUT' || f.method === 'PATCH' ? 'text-blue-400'
                      : f.method === 'DELETE' ? 'text-red-400' : 'text-zinc-400'
                const eventId = f.responseEventId ?? f.requestEventId
                const urlPath = (() => {
                  try { return new URL(f.url).pathname + (new URL(f.url).search || '') }
                  catch { return f.url }
                })()
                return (
                  <tr
                    key={f.flowId}
                    className="border-b border-zinc-800/30 hover:bg-zinc-800/30 cursor-pointer"
                    onClick={() => eventId && onOpenInTimeline?.(eventId, f.timestamp)}
                  >
                    <td className={`px-2 py-1 font-semibold ${methodClass}`}>{f.method}</td>
                    <td className={`px-2 py-1 ${statusClass}`}>{f.status ?? '—'}</td>
                    <td className="px-2 py-1 text-zinc-400 max-w-[160px] truncate" title={f.host}>{f.host}</td>
                    <td className="px-2 py-1 text-zinc-300 max-w-[400px] truncate" title={f.url}>{urlPath}</td>
                    <td className="px-2 py-1 text-zinc-500 max-w-[120px] truncate" title={f.contentType}>
                      {f.contentType.replace(/^application\//, '').replace(/;.*/, '')}
                    </td>
                    <td className="px-2 py-1 text-zinc-500 text-right">{f.size !== null ? formatBytes(f.size) : '—'}</td>
                    <td className="px-2 py-1 text-zinc-500 text-right">{f.durationMs !== null ? `${f.durationMs}ms` : '—'}</td>
                    <td className="px-2 py-1 text-zinc-600 text-right">{new Date(f.timestamp).toLocaleTimeString()}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="flex items-center justify-center py-12 text-zinc-600 text-sm">
              {flows.length === 0 ? 'No HTTP traffic captured yet' : 'No flows match the current filters'}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto py-1">
          {sitemapTree.size === 0 ? (
            <div className="flex items-center justify-center py-12 text-zinc-600 text-sm">
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
