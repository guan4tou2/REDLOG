import type { ExportRequest } from '../../../core/export-plan'
import { sourceSessionKey } from '../../../core/operation-pair-key'
import { useEffect, useRef, useState } from 'react'
import type { ActivityPage, ActivityRequest, ActivitySummary } from '../../../core/activity-contract'
import type { BodySearchCoverage } from '../../../core/http-body-index'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { eventTitle } from '../lib/eventTitle'
import { formatDate, formatTime } from '../lib/time'
import { Button } from './Button'
import { activityResultLabel } from '../lib/commandStatus'
import { ActivityReader } from './ActivityReader'

const ROW_GRID = 'grid grid-cols-[72px_96px_minmax(0,1fr)_24px] gap-x-3 items-start'

export function SearchCoverage({ coverage }: { coverage?: BodySearchCoverage }): JSX.Element | null {
  const { t } = useI18n()
  if (!coverage) return null
  const describe=(counts:Partial<BodySearchCoverage>):string[] => (['missing','limited','pending','binary','failed','unsupported'] as const)
    .filter(status=>(counts[status]??0)>0).map(status=>t(`activity.coverage.${status}`,{count:counts[status]??0}))
  const issues=coverage.sources?.flatMap(source=>{
    const states=describe(source)
    if(!states.length)return []
    const label=source.kind==='ai-raw'?t('content.field.ai_raw'):source.kind==='artifact'?t('content.field.artifact'):t('activity.coverage.body')
    return [`${label}: ${states.join(' · ')}`]
  })??describe(coverage)
  if (!issues.length) return null
  return <p role="status" className="mb-2 text-xs text-amber-300">{issues.join(' · ')}</p>
}

/** Same parsed query and EventFilter as raw Search; grouping happens in SQL. */
export function ActivityResults({ request, onOpen, onExportSelection, onClearQuery, active = true }: { active?: boolean; onClearQuery?: () => void; onExportSelection?: (subset: ExportRequest['subset'] | null) => void; request: Omit<ActivityRequest, 'projectId'>; onOpen?: (id: string, ts: number) => void }): JSX.Element {
  const { t } = useI18n()
  const project = useReadState(async () => {
    const config = await window.redlog.config.get() as { engagement?: unknown }
    const engagement = config.engagement as { id?: unknown } | undefined
    if (typeof engagement?.id !== 'string' || !engagement.id) throw new Error(t('content.status.denied'))
    return engagement.id
  })
  if (project.state.phase === 'failed') return <div role="alert">{project.state.error} <Button onClick={project.retry}>{t('common.retry')}</Button></div>
  if (!project.state.value) return <span role="status">{t('search.loading')}</span>
  return <ActivityList key={`${project.state.value}:${JSON.stringify(request)}`} active={active} request={{ ...request, projectId: project.state.value }} onOpen={onOpen} onExportSelection={onExportSelection} onClearQuery={onClearQuery} />
}
function ActivityList({ request, onOpen, onExportSelection, onClearQuery, active }: { active: boolean; onClearQuery?: () => void; onExportSelection?: (subset: ExportRequest['subset'] | null) => void; request: ActivityRequest; onOpen?: (id: string, ts: number) => void }): JSX.Element {
  const { t } = useI18n()
  const read = useReadState(() => window.redlog.events.activityPage({ ...request, limit: 50 }))
  const [exportKind,setExportKind] = useState<'activity' | 'session'>('activity')
  const [expanded, setExpanded] = useState<string | null>(null)
  // The operation being read in the Reader, by id so a refresh does not move it.
  const [readerId, setReaderId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newEvents, setNewEvents] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  /** Loads the next page; answers the operations it added, for a caller that reads on into them. */
  const more = async (): Promise<ActivitySummary[]> => {
    const current = read.state.value
    if (!current?.nextCursor || busy) return []
    setBusy(true); setError(null)
    try {
      const next = await window.redlog.events.activityPage({ ...request, cursor: current.nextCursor, limit: 50 })
      if (alive.current) read.update(() => ({ ...next, items: [...current.items, ...next.items] }))
      return next.items
    } catch (e) { if (alive.current) setError(String(e)); return [] }
    finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => window.redlog.events.onNewBatch(() => setNewEvents(true)), [])
  const refresh = (): void => { setNewEvents(false); setError(null); read.retry() }
  const page = read.state.value
  const selectedActivity = page?.items.find(item=>item.id===expanded)
  const readerIndex = page && readerId !== null ? page.items.findIndex(item => item.id === readerId) : -1
  // Stepping past the last loaded operation loads the next page, then reads on.
  const step = (direction: -1 | 1): void => {
    if (!page || readerIndex < 0) return
    const next = readerIndex + direction
    if (next >= 0 && next < page.items.length) { setReaderId(page.items[next].id); setExpanded(page.items[next].id); return }
    if (direction === 1 && page.hasMore) {
      void more().then((added) => { if (added.length > 0 && alive.current) { setReaderId(added[0].id); setExpanded(added[0].id) } })
    }
  }
  const anchorId = selectedActivity?.anchor.id
  const hasSession = selectedActivity ? sourceSessionKey(selectedActivity.anchor)!==null : false
  useEffect(()=>{
    onExportSelection?.(active && anchorId && page ? {kind:exportKind==='session' && hasSession ? 'session' : 'activity',projectId:request.projectId,anchorEventId:anchorId,snapshot:page.snapshot} : null)
    return ()=>onExportSelection?.(null)
  },[active,anchorId,page?.snapshot,exportKind,hasSession,request.projectId,onExportSelection])
  return <div className="min-w-0" aria-busy={read.state.phase === 'loading' || busy}>
    {read.state.phase === 'loading' && <span role="status">{t('search.loading')}</span>}
    {(read.state.phase === 'failed' || error) && <div role="alert" className="text-sm text-amber-300 break-words">{error ?? (read.state.phase === 'failed' ? read.state.error : '')} <Button onClick={refresh}>{t('activity.refresh')}</Button></div>}
    {page && (() => {
      // Matched vs context is only a fact once a query splits a group's sources
      // into hits and everything else. With no query every group is 1 matched /
      // 0 context, so the same "命中 1 · 相關 0" would repeat down the whole
      // list and say nothing.
      const filtering = request.parsed.text.trim().length > 0 || request.parsed.conditions.length > 0
      return <>
      <SearchCoverage coverage={page.bodyCoverage} />
      <div data-testid="activity-stats" className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-redlog-text-dim">
        <span>{t('activity.count', { groups: page.totalGroups, matches: page.totalMatches })}
          {filtering && onClearQuery && <button type="button" data-testid="activity-clear-filter" onClick={onClearQuery} className="ml-2 underline hover:text-redlog-text focus-visible:outline focus-visible:outline-red-400">{t('activity.clearFilter')}</button>}
        </span>
        {newEvents && <button type="button" data-testid="activity-new-events" onClick={refresh} className="rounded border border-redlog-border bg-redlog-elevated px-2 py-0.5 text-redlog-text hover:border-redlog-text-dim focus-visible:outline focus-visible:outline-red-400">{t('workspace.newActivity')}</button>}
      </div>
      {page.items.length > 0 && <div aria-hidden="true" className={`${ROW_GRID} px-2 py-1 text-[11px] uppercase text-redlog-text-faint select-none`}>
        <span>{t('activity.col.time')}</span><span>{t('activity.col.source')}</span><span>{t('activity.col.content')}</span><span className="text-right">{t('activity.col.view')}</span>
      </div>}
      {page.items.length === 0 && <p className="text-sm text-redlog-text-faint">{t('activity.noMatches')}</p>}
      <div className="divide-y divide-redlog-border-subtle">
        {page.items.map((item, at) => <div key={item.id} className={expanded === item.id ? "min-w-0 bg-white/[0.012]" : "min-w-0"}>
          {(at === 0 || formatDate(page.items[at - 1].firstAt) !== formatDate(item.firstAt)) && <div data-testid="activity-day" role="separator" className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-redlog-text-dim select-none">
            <span className="rounded border border-redlog-border px-2 py-0.5 font-mono">{formatDate(item.firstAt)}</span><span className="h-px flex-1 bg-redlog-border-subtle" />
          </div>}
          <button type="button" data-testid="activity-row" aria-expanded={expanded === item.id} className={`${ROW_GRID} w-full text-left py-2.5 px-2 hover:bg-redlog-elevated focus-visible:outline focus-visible:outline-red-400`}
            onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
            <time className="font-mono text-xs text-redlog-text-dim">{formatTime(item.firstAt, { seconds: true })}</time>
            <span className="min-w-0 truncate text-xs text-redlog-text-dim" title={item.provider === 'claude-code' ? 'Claude Code' : item.provider === 'codex' ? 'Codex' : item.provider ?? item.anchor.agentType}>{item.provider === 'claude-code' ? 'Claude Code' : item.provider === 'codex' ? 'Codex' : item.provider ?? item.anchor.agentType}</span>
            <span className="min-w-0">
              <span className="block font-mono text-sm break-words">{eventTitle(item.anchor)}</span>
              <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-redlog-text-dim">
                <span>{t(item.kind === 'tool' ? `activity.tool.${item.toolAction}` : `activity.kind.${item.kind}`)}</span>
                {(() => {
                  const r = activityResultLabel(item, t)
                  return r && <span data-testid="activity-result" className={r.tone === 'fail' ? 'text-red-300' : r.tone === 'ok' ? 'text-emerald-300' : 'text-amber-300'}>{r.text}</span>
                })()}
                {filtering && <span>{t('activity.sources', { matches: item.matchedCount, context: item.contextCount })}</span>}
              </span>
            </span>
            <span aria-hidden="true" className={`text-right text-redlog-text-dim transition-transform ${expanded === item.id ? 'rotate-90' : ''}`}>›</span>
          </button>
          {expanded === item.id && <div data-testid="activity-summary" className="px-2 pb-3 space-y-2">
            <p className="text-xs text-redlog-text-dim">{filtering ? t('activity.sources', { matches: item.matchedCount, context: item.contextCount }) : t('activity.summary.sources', { count: item.sourceCount })}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button level="primary" size="compact" data-testid="activity-read" onClick={() => setReaderId(item.id)}>{t('activity.reader.open')}</Button>
              {onOpen && <Button size="compact" data-testid="activity-locate" onClick={() => onOpen(item.anchor.id, item.anchor.timestamp)}>{t('activity.reader.locate')}</Button>}
              <select aria-label={t('export.preview.subset')} value={exportKind==='session' && hasSession ? 'session' : 'activity'} onChange={e=>setExportKind(e.target.value as 'activity'|'session')} className="ml-auto bg-redlog-elevated border border-redlog-border rounded px-2 py-1 text-sm"><option value="activity">{t('activity.export.activity')}</option><option value="session" disabled={!hasSession}>{t('activity.export.session')}</option></select>
            </div>
          </div>}
        </div>)}
      </div>
      {page.hasMore && <Button disabled={busy} onClick={() => void more()}>{t('search.loadMore')}</Button>}
      {readerIndex >= 0 && <ActivityReader items={page.items} index={readerIndex} request={request} snapshot={page.snapshot} active={active} filtering={filtering}
        hasMore={page.hasMore} loading={busy}
        onStep={step} onClose={() => setReaderId(null)}
        // The Reader stays open under the Timeline, so coming back lands where the reading was (#589).
        onLocate={onOpen ? (event) => onOpen(event.id, event.timestamp) : undefined} />}
      </>
    })()}
  </div>
}
