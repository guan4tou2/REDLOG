import type { ExportRequest } from '../../../core/export-plan'
import { sourceSessionKey } from '../../../core/operation-pair-key'
import { useEffect, useRef, useState } from 'react'
import type { ActivityPage, ActivityRequest, ActivitySummary } from '../../../core/activity-contract'
import type { BodySearchCoverage } from '../../../core/http-body-index'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { eventTitle } from '../lib/eventTitle'
import { foldSystemRuns } from '../lib/activityFolds'
import { formatDate, formatTime, useDisplayZone, zoneLabel } from '../lib/time'
import { Button } from './Button'
import { activityResultLabel } from '../lib/commandStatus'
import { ActivityReader, sourceName } from './ActivityReader'

const ROW_GRID = 'grid grid-cols-[72px_130px_minmax(0,1fr)_24px] gap-x-3 items-center'

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
  const zone = useDisplayZone()
  const [exportKind,setExportKind] = useState<'activity' | 'session'>('activity')
  const [expanded, setExpanded] = useState<string | null>(null)
  // System-event folds the operator opened, by the first row's id.
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set())
  // The operation being read in the Reader, by id so a refresh does not move it.
  const [readerId, setReaderId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // How many events arrived since this page was read; the banner says the number.
  const [newEvents, setNewEvents] = useState(0)
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
  useEffect(() => window.redlog.events.onNewBatch((events) => setNewEvents((n) => n + (Array.isArray(events) ? events.length : 1))), [])
  const refresh = (): void => { setNewEvents(0); setError(null); read.retry() }
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
        {newEvents > 0 && <button type="button" data-testid="activity-new-events" onClick={refresh} className="flex items-center gap-1.5 rounded border border-redlog-border bg-redlog-elevated px-2 py-0.5 text-redlog-text hover:border-redlog-text-dim focus-visible:outline focus-visible:outline-red-400"><span aria-hidden className="text-emerald-400">↑</span>{t('workspace.newActivity', { count: newEvents })}</button>}
      </div>
      {page.items.length > 0 && <div aria-hidden="true" className={`${ROW_GRID} px-2 py-1 text-xs uppercase text-redlog-text-faint select-none`}>
        <span>{t('activity.col.time')}</span><span>{t('activity.col.source')}</span><span>{t('activity.col.content')}</span>{/* The column is the 24px chevron's; the label may be wider, so it stays on
            one line and reaches left into the gap instead of stacking 檢/視. */}
        <span className="justify-self-end whitespace-nowrap">{t('activity.col.view')}</span>
      </div>}
      {page.items.length === 0 && <p className="text-sm text-redlog-text-faint">{t('activity.noMatches')}</p>}
      <div className="flex flex-col gap-1">
        {(() => {
          const day = (at: number): JSX.Element | null => (at === 0 || formatDate(page.items[at - 1].firstAt) !== formatDate(page.items[at].firstAt))
            ? <div data-testid="activity-day" role="separator" className="flex items-center gap-2 px-2 py-1.5 text-xs text-redlog-text-dim select-none">
              <span className="rounded border border-redlog-border px-2 py-0.5 font-mono">{formatDate(page.items[at].firstAt)}{formatDate(page.items[at].firstAt) === formatDate(Date.now()) && <span className="font-sans text-redlog-text-dim"> ({t('activity.today')})</span>}</span><span className="h-px flex-1 bg-redlog-border-subtle" /><span className="font-mono text-redlog-text-faint">{zoneLabel(zone, t)}</span>
            </div>
            : null
          const row = (item: ActivitySummary, at: number, withDay: boolean): JSX.Element => <div key={item.id} className="min-w-0">
          {withDay && day(at)}
          <div className={`rounded-lg transition-colors ${expanded === item.id ? 'bg-redlog-elevated' : 'bg-redlog-surface hover:bg-redlog-elevated'}`}>
          <button type="button" data-testid="activity-row" aria-expanded={expanded === item.id} className={`${ROW_GRID} w-full text-left py-2.5 px-3 rounded-lg focus-visible:outline focus-visible:outline-red-400`}
            onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
            <time className="font-mono text-xs text-redlog-text-dim">{formatTime(item.firstAt, { seconds: true })}</time>
            {(() => {
              const r = activityResultLabel(item, t)
              const kind = t(item.kind === 'tool' ? `activity.tool.${item.toolAction}` : `activity.kind.${item.kind}`)
              return <>
                {/* Stitch 04: the source as a badge, tinted when the command failed;
                    the kind of activity rides its tooltip. */}
                <span className="min-w-0"><span data-testid="activity-source-badge" title={`${sourceName(item, t)} · ${kind}`}
                  className={`inline-block max-w-full truncate rounded px-1.5 py-0.5 text-xs ${r?.tone === 'fail' ? 'bg-redlog-danger/10 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim'}`}>{sourceName(item, t)}</span></span>
                <span className="flex min-w-0 items-center gap-2 pr-2">
                  <span className="min-w-0 truncate font-mono text-sm text-redlog-text" title={eventTitle(item.anchor, t)}>{eventTitle(item.anchor, t)}</span>
                  {r && <span data-testid="activity-result" className={`shrink-0 text-xs font-medium ${r.tone === 'fail' ? 'text-red-300' : r.tone === 'ok' ? 'text-emerald-300' : 'text-amber-300'}`}>{r.text}</span>}
                  {filtering && <span className="shrink-0 text-xs text-redlog-text-dim">{t('activity.sources', { matches: item.matchedCount, context: item.contextCount })}</span>}
                </span>
              </>
            })()}
            <span aria-hidden="true" className={`text-right text-redlog-text-dim transition-transform ${expanded === item.id ? 'rotate-90' : ''}`}>›</span>
          </button>
          {expanded === item.id && <div data-testid="activity-summary" className="px-2 pb-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button level="primary" size="compact" data-testid="activity-read" onClick={() => setReaderId(item.id)}>{t('activity.reader.open')} ↗</Button>
                {onOpen && <Button size="compact" data-testid="activity-locate" onClick={() => onOpen(item.anchor.id, item.anchor.timestamp)}>{t('activity.reader.locate')}</Button>}
                <select aria-label={t('export.preview.subset')} value={exportKind==='session' && hasSession ? 'session' : 'activity'} onChange={e=>setExportKind(e.target.value as 'activity'|'session')} className="bg-redlog-elevated border border-redlog-border rounded px-2 py-1 text-xs"><option value="activity">{t('activity.export.activity')}</option><option value="session" disabled={!hasSession}>{t('activity.export.session')}</option></select>
              </div>
              <p data-testid="activity-summary-meta" className="flex flex-wrap gap-x-2 text-xs text-redlog-text-faint">
                <span>{filtering ? t('activity.sources', { matches: item.matchedCount, context: item.contextCount }) : t('activity.summary.sources', { count: item.sourceCount })}</span>
                <span>· {t('activity.reader.field.session')} <span className="font-mono">{item.anchor.sessionId}</span></span>
                {typeof item.anchor.data.pid === 'number' && <span>· {t('activity.reader.field.pid')} <span className="font-mono">{item.anchor.data.pid}</span></span>}
              </p>
            </div>
          </div>}
          </div>
        </div>
          // A query asked for these rows; never fold what was searched for.
          return foldSystemRuns(page.items, !filtering).map((seg) => {
            if (seg.kind === 'item') return row(seg.item, seg.at, true)
            // A run holding the open row or the Reader's row stays open.
            const open = openFolds.has(seg.key) || seg.items.some((it) => it.id === expanded || it.id === readerId)
            const toggle = (): void => setOpenFolds((prev) => {
              const next = new Set(prev)
              if (next.has(seg.key)) next.delete(seg.key); else next.add(seg.key)
              return next
            })
            return <div key={`fold:${seg.key}`} className="min-w-0">
              {day(seg.at)}
              <button type="button" data-testid="activity-system-fold" aria-expanded={open} onClick={toggle}
                className={`${ROW_GRID} w-full text-left py-2 px-3 rounded-lg bg-redlog-surface/60 hover:bg-redlog-elevated focus-visible:outline focus-visible:outline-red-400`}>
                <time className="font-mono text-xs text-redlog-text-faint">{formatTime(seg.items[0].firstAt, { seconds: true })}</time>
                <span className="min-w-0"><span className="inline-block rounded px-1.5 py-0.5 text-xs bg-redlog-elevated text-redlog-text-faint">{t('timeline.system')}</span></span>
                <span className="min-w-0 pr-2 text-sm text-redlog-text-dim">{t('activity.systemFold', { count: seg.items.length })}</span>
                <span aria-hidden="true" className={`text-right text-redlog-text-dim transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
              </button>
              {open && <div className="mt-1 flex flex-col gap-1 pl-3 border-l border-redlog-border-subtle">
                {seg.items.map((it, k) => row(it, seg.at + k, false))}
              </div>}
            </div>
          })
        })()}
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
