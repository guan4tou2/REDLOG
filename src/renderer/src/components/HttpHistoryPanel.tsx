import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { hostOutOfScope } from '../lib/scope'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { useI18n } from '../i18n'
import { formatTime } from '../lib/time'
import { useListKeyboard } from '../lib/useListKeyboard'
import { groupFlows, type Activity } from '../lib/httpActivity'

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
  /** First `_causes` entry on the request — the command that produced this. */
  causeEventId: string | null
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

/**
 * The command that produced this flow, if the record links one.
 *
 * Only the *request* can carry that link. A response's `_causes` points at its
 * own request — the api-server pairs the two by `flow_id` — so reading it as
 * parentage gives every flow a unique "parent" and grouping degenerates into
 * one group per connection, which is the shape §3 exists to remove. The unit
 * tests could not catch that, because they hand `causeEventId` in directly;
 * e2e/http-activity-view.spec.ts did, immediately.
 */
function parentCommandOf(
  request: RedLogEvent | null,
  response: RedLogEvent | null
): string | null {
  const causes = request?.data?._causes as string[] | undefined
  if (!Array.isArray(causes) || causes.length === 0) return null
  const self = new Set([request?.id, response?.id].filter(Boolean) as string[])
  return causes.find((c) => !self.has(c)) ?? null
}

// ---------------------------------------------------------------------------
// Activity row — §3's point-or-span
// ---------------------------------------------------------------------------
//
// One line per thing the operator did, not per connection it produced. The
// connections are still all here, one disclosure down; what changed is which
// level the eye lands on. A 40,000-request brute force and a single curl both
// occupy one row, which is the point: they were both one action.

function ActivityRow({ activity, t, rowProps, open, onToggle, onOpenInTimeline, outOfScope }: {
  activity: Activity<HttpFlow>
  t: (k: string, vars?: Record<string, string | number>) => string
  rowProps: ReturnType<ReturnType<typeof useListKeyboard>['itemProps']>
  open: boolean
  onToggle: () => void
  onOpenInTimeline?: (eventId: string, ts: number) => void
  outOfScope?: (host: string) => boolean
}): JSX.Element {
  const { statusBuckets: sb, flows } = activity
  const spanSec = Math.round((activity.endMs - activity.startMs) / 1000)
  const jumpId = activity.causeEventId ?? flows[0]?.responseEventId ?? flows[0]?.requestEventId

  return (
    <div className="rounded border border-redlog-border-subtle">
      <div
        {...rowProps}
        ref={(el) => rowProps.ref(el)}
        onClick={() => { rowProps.onClick(); onToggle() }}
        aria-expanded={open}
        data-testid="http-activity-row"
        data-kind={activity.kind}
        className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-redlog-elevated/30 focus-visible:outline-none focus-visible:bg-redlog-elevated/50 rounded"
      >
        {/* Shape carries the point/span distinction, and the label repeats it,
            because shape alone is not an accessible channel (§5.7). */}
        <span
          aria-hidden
          className={`shrink-0 ${activity.kind === 'span'
            ? 'w-4 h-[3px] rounded-sm bg-redlog-cyan'
            : 'w-[7px] h-[7px] rounded-full bg-redlog-cyan'}`}
        />
        <span className="sr-only">{t(`httpHistory.kind.${activity.kind}`)}</span>

        <span
          className={`font-mono truncate max-w-[220px] ${outOfScope?.(activity.host) ? 'text-redlog-text-faint' : 'text-redlog-text'}`}
          title={activity.host}
        >
          {activity.host || t('httpHistory.noHost')}
        </span>
        {outOfScope?.(activity.host) && (
          <span className="shrink-0 font-mono text-xs px-1 rounded bg-redlog-elevated text-redlog-text-faint" title={t('httpHistory.outOfScopeHint')}>
            {t('httpHistory.outOfScope')}
          </span>
        )}

        <span className="font-mono text-redlog-text-dim shrink-0">{activity.methods.join(' ')}</span>

        <span className="font-mono text-redlog-text-dim shrink-0 tabular-nums">
          {t('httpHistory.requestCount', { n: flows.length })}
        </span>

        <span className="flex items-center gap-1 shrink-0 font-mono tabular-nums">
          {(['2', '3', '4', '5'] as const).filter((b) => sb[b]).map((b) => (
            <span key={b} className={STATUS_COLORS[b] ?? 'text-redlog-text-dim'}>{b}xx·{sb[b]}</span>
          ))}
        </span>

        <span className="ml-auto shrink-0 text-redlog-text-faint tabular-nums">
          {formatTime(activity.startMs, { seconds: true })}
          {activity.kind === 'span' && spanSec > 0 && ` +${spanSec}s`}
        </span>

        {activity.causeEventId && (
          <span
            title={t('httpHistory.hasParentCommand')}
            className="shrink-0 text-redlog-text-faint"
          >⌘</span>
        )}

        {jumpId && onOpenInTimeline && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenInTimeline(jumpId, activity.startMs) }}
            title={t('httpHistory.openAtMoment')}
            aria-label={t('httpHistory.openAtMoment')}
            className="shrink-0 text-redlog-text-dim hover:text-redlog-text px-1 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-accent/50"
          >↗</button>
        )}
      </div>

      {open && (
        <ul className="border-t border-redlog-border-subtle divide-y divide-redlog-border-subtle/50">
          {flows.map((f) => {
            const path = (() => {
              try { const u = new URL(f.url); return u.pathname + (u.search || '') } catch { return f.url }
            })()
            const sc = f.status !== null ? STATUS_COLORS[String(f.status)[0]] : undefined
            return (
              <li key={f.flowId} className="flex items-center gap-2 px-2 py-1 text-xs font-mono">
                <span className="text-redlog-text-dim shrink-0 w-12">{f.method}</span>
                <span className={`shrink-0 w-8 tabular-nums ${sc ?? 'text-redlog-text-faint'}`}>{f.status ?? '—'}</span>
                <span className="text-redlog-text truncate flex-1" title={f.url}>{path}</span>
                <span className="text-redlog-text-faint shrink-0 tabular-nums">
                  {formatTime(f.timestamp, { seconds: true })}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
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

function SitemapTreeNode({ node, depth, onOpenInTimeline, outOfScope }: {
  node: SitemapNode
  depth: number
  onOpenInTimeline?: (eventId: string, ts: number) => void
  outOfScope?: (host: string) => boolean
}): JSX.Element {
  const { t } = useI18n()
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
        <span className="w-3 text-xs text-redlog-text-faint flex-shrink-0 flex items-center">
          {hasChildren
            ? (expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />)
            : '·'}
        </span>
        <span
          title={node.fullPath}
          className={`text-xs font-mono truncate ${
            depth === 0
              ? (outOfScope?.(node.name) ? 'text-redlog-text-faint font-semibold' : 'text-redlog-accent font-semibold')
              : 'text-redlog-text'
          }`}
        >
          {depth === 0 ? node.name : '/' + node.name}
        </span>
        {depth === 0 && outOfScope?.(node.name) && (
          <span className="shrink-0 font-mono text-xs px-1 rounded bg-redlog-elevated text-redlog-text-faint" title={t('httpHistory.outOfScopeHint')}>
            {t('httpHistory.outOfScope')}
          </span>
        )}
        <span className="flex-shrink-0 flex items-center gap-1 ml-auto">
          {methodArr.map(m => (
            <span key={m} className={`text-xs font-mono px-1 rounded ${
              m === 'GET' ? 'text-green-500/70 bg-green-900/20'
                : m === 'POST' ? 'text-amber-500/70 bg-amber-900/20'
                  : m === 'PUT' || m === 'PATCH' ? 'text-blue-500/70 bg-blue-900/20'
                    : m === 'DELETE' ? 'text-red-500/70 bg-red-900/20'
                      : 'text-redlog-text-dim/70 bg-redlog-elevated/40'
            }`}>{m}</span>
          ))}
          {statusArr.length > 0 && statusArr.length <= 3 && statusArr.map(s => (
            <span key={s} className={`text-xs font-mono ${STATUS_COLORS[String(s)[0]] ?? 'text-redlog-text-dim'}`}>
              {s}
            </span>
          ))}
          <span className="text-xs text-redlog-text-faint font-mono min-w-[24px] text-right">
            {uniqueFlowCount}
          </span>
        </span>
      </div>
      {expanded && sortedChildren.map(child => (
        <SitemapTreeNode
          key={child.fullPath}
          node={child}
          depth={depth + 1}
          outOfScope={outOfScope}
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
  // §3: the activity is the row, not the connection. 'flows' is still here
  // as an explicit escape hatch, because a record has to let you get at the
  // raw thing — it is just no longer what you land on.
  const [viewMode, setViewMode] = useState<'activity' | 'flows' | 'sitemap'>('activity')
  const [openActivity, setOpenActivity] = useState<string | null>(null)
  // §7a: mark out-of-scope (non-attack) hosts. Scope comes from project config;
  // an empty allow list means nothing is "out of scope" (no rule to violate),
  // so the marker never appears on an unscoped engagement.
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const [excludeTargets, setExcludeTargets] = useState<string[]>([])
  useEffect(() => {
    window.redlog.config.get().then((c) => {
      const s = (c as { scope?: { targets?: string[]; excludeTargets?: string[] } } | null)?.scope
      setScopeTargets(s?.targets ?? [])
      setExcludeTargets(s?.excludeTargets ?? [])
    }).catch(() => {})
  }, [])
  const outOfScope = useCallback(
    (host: string) => hostOutOfScope(host, scopeTargets, excludeTargets),
    [scopeTargets, excludeTargets]
  )

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
        streamId: typeof resp?.stream_id === 'number' ? resp.stream_id : null,
        causeEventId: parentCommandOf(request, response)
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

  const filtered = useMemo(() => {
    let list = flows
    if (filterTextDebounced) {
      const q = filterTextDebounced.toLowerCase()
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
  }, [flows, filterTextDebounced, methodFilter, statusFilter, sortCol, sortAsc])

  // §9 虛擬列表: window the flow table so a 10k-flow proxy session keeps ~30
  // <tr> mounted, not 10k. Rows are single-line and uniform, so a fixed size
  // needs no per-row measurement. Infinite-scroll (which kept every loaded row
  // mounted) is replaced by this.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 12
  })

  // The same keys as every other list (§9). This view arrived from another
  // branch without them and the contract test did not notice, because it
  // named its five files by hand — see test/list-keyboard.test.tsx.
  // Nav spans the whole filtered list; onScrollToIndex lets the hook reach a
  // row the virtualizer hasn't mounted yet.
  const rowNav = useListKeyboard({
    count: filtered.length,
    onActivate: (i) => {
      const f = filtered[i]
      const id = f?.responseEventId ?? f?.requestEventId
      if (id) onOpenInTimeline?.(id, f.timestamp)
    },
    onJumpToTimeline: (i) => {
      const f = filtered[i]
      const id = f?.responseEventId ?? f?.requestEventId
      if (id) onOpenInTimeline?.(id, f.timestamp)
    },
    onEscape: () => { setMethodFilter(null); setStatusFilter(null) },
    onScrollToIndex: (i) => rowVirtualizer.scrollToIndex(i)
  })

  const activities = useMemo(() => groupFlows(filtered), [filtered])

  const activityNav = useListKeyboard({
    count: activities.length,
    onActivate: (i) => {
      const a = activities[i]
      if (a) setOpenActivity((cur) => (cur === a.id ? null : a.id))
    },
    onJumpToTimeline: (i) => {
      const a = activities[i]
      const id = a?.causeEventId ?? a?.flows[0]?.responseEventId ?? a?.flows[0]?.requestEventId
      if (id && a) onOpenInTimeline?.(id, a.startMs)
    },
    onEscape: () => setOpenActivity(null)
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
        <span className="text-xs text-redlog-text-dim font-mono tabular-nums">
          {t('httpHistory.counts', { activities: activities.length, flows: filtered.length })}
        </span>

        <div className="flex items-center gap-0.5 ml-3 bg-redlog-elevated/60 rounded p-0.5">
          <button
            onClick={() => setViewMode('activity')}
            data-http-view="activity"
            aria-pressed={viewMode === 'activity'}
            className={`text-xs font-mono px-2 py-0.5 rounded ${viewMode === 'activity' ? 'bg-redlog-elevated-hover text-redlog-text' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          >{t('httpHistory.viewActivity')}</button>
          <button
            onClick={() => setViewMode('flows')}
            data-http-view="flows"
            aria-pressed={viewMode === 'flows'}
            className={`text-xs font-mono px-2 py-0.5 rounded ${viewMode === 'flows' ? 'bg-redlog-elevated-hover text-redlog-text' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          >{t('httpHistory.viewFlows')}</button>
          <button
            onClick={() => setViewMode('sitemap')}
            data-http-view="sitemap"
            aria-pressed={viewMode === 'sitemap'}
            className={`text-xs font-mono px-2 py-0.5 rounded ${viewMode === 'sitemap' ? 'bg-redlog-elevated-hover text-redlog-text' : 'text-redlog-text-dim hover:text-redlog-text'}`}
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
          className={`text-xs font-mono px-1.5 py-0.5 rounded ${!methodFilter ? 'bg-indigo-600/30 text-indigo-300' : 'text-redlog-text-dim hover:text-redlog-text'}`}
        >{t('httpHistory.filterAll')}</button>
        {methods.map(m => (
          <button
            key={m}
            onClick={() => setMethodFilter(methodFilter === m ? null : m)}
            className={`text-xs font-mono px-1.5 py-0.5 rounded ${methodFilter === m ? 'bg-indigo-600/30 text-indigo-300' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          >{m}</button>
        ))}
        <span className="w-px h-3 bg-redlog-elevated-hover/60 mx-1" />
        {['2', '3', '4', '5'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            className={`text-xs font-mono px-1.5 py-0.5 rounded ${statusFilter === s ? 'bg-indigo-600/30 text-indigo-300' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          >{s}xx</button>
        ))}
      </div>

      {viewMode === 'activity' ? (
        <div className="flex-1 overflow-auto p-2 space-y-1" {...activityNav.containerProps}>
          {activities.length === 0 ? (
            <p className="text-xs text-redlog-text-faint px-1 py-2">{t('httpHistory.empty')}</p>
          ) : activities.map((a, i) => (
            <ActivityRow
              key={a.id}
              activity={a}
              t={t}
              rowProps={activityNav.itemProps(i)}
              open={openActivity === a.id}
              onToggle={() => setOpenActivity((cur) => (cur === a.id ? null : a.id))}
              onOpenInTimeline={onOpenInTimeline}
              outOfScope={outOfScope}
            />
          ))}
        </div>
      ) : viewMode === 'flows' ? (
        <div ref={scrollRef} className="flex-1 overflow-auto">
          <table className="w-full text-xs font-mono">
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
              {(() => {
                const items = rowVirtualizer.getVirtualItems()
                const padTop = items.length ? items[0].start : 0
                const padBottom = items.length ? rowVirtualizer.getTotalSize() - items[items.length - 1].end : 0
                return (
                  <>
                    {padTop > 0 && <tr aria-hidden="true"><td colSpan={8} style={{ height: padTop, padding: 0, border: 0 }} /></tr>}
                    {items.map((vi) => {
                const f = filtered[vi.index]
                const rowIndex = vi.index
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
                    style={{ height: 29 }}
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
                    {padBottom > 0 && <tr aria-hidden="true"><td colSpan={8} style={{ height: padBottom, padding: 0, border: 0 }} /></tr>}
                  </>
                )
              })()}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="flex items-center justify-center py-12 text-redlog-text-faint text-sm">
              {flows.length === 0 ? t('httpHistory.empty') : t('httpHistory.noMatch')}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto py-1">
          {sitemapTree.size === 0 ? (
            <div className="flex items-center justify-center py-12 text-redlog-text-faint text-sm">
              {flows.length === 0 ? t('httpHistory.empty') : t('httpHistory.noMatch')}
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
                  outOfScope={outOfScope}
                />
              ))
          )}
        </div>
      )}
    </div>
  )
}
