import type { ExportRequest } from '../../../core/export-plan'
import { sourceSessionKey } from '../../../core/operation-pair-key'
import { useEffect, useRef, useState } from 'react'
import type { ActivityPage, ActivityRequest, ActivitySummary } from '../../../core/activity-contract'
import type { BodySearchCoverage } from '../../../core/http-body-index'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { eventTitle } from '../lib/eventTitle'
import { formatTime } from '../lib/time'
import { Button } from './Button'
import { EventContentReader } from './EventContentReader'

export function SearchCoverage({ coverage }: { coverage?: BodySearchCoverage }): JSX.Element | null {
  const { t } = useI18n()
  if (!coverage) return null
  const issues = (['missing', 'limited', 'pending', 'binary', 'failed'] as const)
    .filter(status => coverage[status] > 0)
    .map(status => t(`activity.coverage.${status}`, {count: coverage[status]}))
  if (!issues.length) return null
  return <p role="status" className="mb-2 text-xs text-amber-300">{issues.join(' · ')}</p>
}

function ActivitySources({ item, request, snapshot, onOpen, onRefresh }: {
  item: ActivitySummary; request: ActivityRequest; snapshot: ActivityPage['snapshot']; onRefresh: () => void
  onOpen?: (id: string, ts: number) => void
}): JSX.Element {
  const { t } = useI18n()
  const read = useReadState(() => window.redlog.events.activityMembers({ ...request, ref: item, snapshot, limit: 50, matchesFirst: true }), true, [snapshot])
  const [selected, setSelected] = useState<string | null>(null)
  const [visited, setVisited] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const more = async (): Promise<void> => {
    const current = read.state.value
    if (!current?.nextCursor || busy) return
    setBusy(true); setError(null)
    try {
      const next = await window.redlog.events.activityMembers({ ...request, ref: item, snapshot, limit: 50, matchesFirst: true, cursor: current.nextCursor })
      if (live.current) read.update(() => ({ ...next, items: [...current.items, ...next.items] }))
    } catch (e) { if (live.current) setError(String(e)) }
    finally { if (live.current) setBusy(false) }
  }
  const sources = read.state.value?.items ?? []
  const current = sources.find(r => r.event.id === selected)
    ?? sources.find(r => r.matched && ['command_end', 'tool_result', 'http_response'].includes(String(r.event.data.subtype)))
    ?? sources.find(r => r.matched)
    ?? sources[0]
  // Pick once before committing the first source. A later page must not
  // replace the content the operator is already reading.
  useEffect(() => {
    if (!current) return
    if (selected === null) setSelected(current.event.id)
    setVisited(prev => prev.has(current.event.id) ? prev : new Set([...prev, current.event.id]))
  }, [current?.event.id])
  return <div className="p-3 space-y-3 min-w-0 bg-redlog-elevated/40">
    {read.state.phase === 'loading' && <span role="status">{t('search.loading')}</span>}
    {(error || read.state.phase === 'failed') && <div role="alert" className="text-xs text-amber-300">{error ?? (read.state.phase === 'failed' ? read.state.error : '')} <Button onClick={onRefresh}>{t('activity.refresh')}</Button></div>}
    {current && <>
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <select aria-label={t('activity.sourceEvent')} value={current.event.id} onChange={e => setSelected(e.target.value)} className="min-w-0 max-w-full flex-1 bg-redlog-elevated border border-redlog-border rounded px-2 py-1 text-sm">
          {sources.map(r => {
            const subtype = String(r.event.data.subtype ?? r.event.agentType)
            const label = subtype === 'command_start' ? t('content.field.command')
              : subtype === 'command_end' ? t('activity.commandResult')
                : subtype === 'tool_call' ? t('content.field.tool_input')
                  : subtype === 'tool_result' ? t('content.field.output') : subtype
            return <option key={r.event.id} value={r.event.id}>{r.matched ? t('activity.matchLabel') : t('activity.contextLabel')} · {label} · {formatTime(r.event.timestamp, {seconds:true})} · {r.event.id.slice(0,8)}</option>
          })}
        </select>
        {onOpen && <Button onClick={() => onOpen(current.event.id, current.event.timestamp)}>{t('activity.original')}</Button>}
      </div>
      {read.state.value?.hasMore && <Button disabled={busy} onClick={() => void more()}>{t('activity.moreSources')}</Button>}
      {sources.filter(source => visited.has(source.event.id) || source.event.id === current.event.id).map(source =>
        <div key={source.event.id} hidden={source.event.id !== current.event.id}>
          <EventContentReader projectId={request.projectId} eventId={source.event.id} />
        </div>)}
    </>}
  </div>
}

/** Same parsed query and EventFilter as raw Search; grouping happens in SQL. */
export function ActivityResults({ request, onOpen, onExportSelection, active = true }: { active?: boolean; onExportSelection?: (subset: ExportRequest['subset'] | null) => void; request: Omit<ActivityRequest, 'projectId'>; onOpen?: (id: string, ts: number) => void }): JSX.Element {
  const { t } = useI18n()
  const project = useReadState(async () => {
    const config = await window.redlog.config.get() as { engagement?: unknown }
    const engagement = config.engagement as { id?: unknown } | undefined
    if (typeof engagement?.id !== 'string' || !engagement.id) throw new Error(t('content.status.denied'))
    return engagement.id
  })
  if (project.state.phase === 'failed') return <div role="alert">{project.state.error} <Button onClick={project.retry}>{t('common.retry')}</Button></div>
  if (!project.state.value) return <span role="status">{t('search.loading')}</span>
  return <ActivityList key={`${project.state.value}:${JSON.stringify(request)}`} active={active} request={{ ...request, projectId: project.state.value }} onOpen={onOpen} onExportSelection={onExportSelection} />
}
function ActivityList({ request, onOpen, onExportSelection, active }: { active: boolean; onExportSelection?: (subset: ExportRequest['subset'] | null) => void; request: ActivityRequest; onOpen?: (id: string, ts: number) => void }): JSX.Element {
  const { t } = useI18n()
  const read = useReadState(() => window.redlog.events.activityPage({ ...request, limit: 50 }))
  const [exportKind,setExportKind] = useState<'activity' | 'session'>('activity')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newEvents, setNewEvents] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const more = async (): Promise<void> => {
    const current = read.state.value
    if (!current?.nextCursor || busy) return
    setBusy(true); setError(null)
    try {
      const next = await window.redlog.events.activityPage({ ...request, cursor: current.nextCursor, limit: 50 })
      if (alive.current) read.update(() => ({ ...next, items: [...current.items, ...next.items] }))
    } catch (e) { if (alive.current) setError(String(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => window.redlog.events.onNewBatch(() => setNewEvents(true)), [])
  const refresh = (): void => { setNewEvents(false); setError(null); read.retry() }
  const page = read.state.value
  const selectedActivity = page?.items.find(item=>item.id===expanded)
  const anchorId = selectedActivity?.anchor.id
  const hasSession = selectedActivity ? sourceSessionKey(selectedActivity.anchor)!==null : false
  useEffect(()=>{
    onExportSelection?.(active && anchorId && page ? {kind:exportKind==='session' && hasSession ? 'session' : 'activity',projectId:request.projectId,anchorEventId:anchorId,snapshot:page.snapshot} : null)
    return ()=>onExportSelection?.(null)
  },[active,anchorId,page?.snapshot,exportKind,hasSession,request.projectId,onExportSelection])
  return <div className="min-w-0" aria-busy={read.state.phase === 'loading' || busy}>
    {newEvents && <Button size="compact" level="quiet" onClick={refresh}>{t('workspace.newActivity')}</Button>}
    {read.state.phase === 'loading' && <span role="status">{t('search.loading')}</span>}
    {(read.state.phase === 'failed' || error) && <div role="alert" className="text-sm text-amber-300 break-words">{error ?? (read.state.phase === 'failed' ? read.state.error : '')} <Button onClick={refresh}>{t('activity.refresh')}</Button></div>}
    {page && <>
      <SearchCoverage coverage={page.bodyCoverage} />
      <p className="text-xs text-redlog-text-dim mb-2">{t('activity.count', { groups: page.totalGroups, matches: page.totalMatches })}</p>
      {page.items.length === 0 && <p className="text-sm text-redlog-text-faint">{t('activity.noMatches')}</p>}
      <div className="divide-y divide-redlog-border">
        {page.items.map(item => <div key={item.id} className="min-w-0">
          <button type="button" data-testid="activity-row" aria-expanded={expanded === item.id} className="w-full text-left py-3 px-2 hover:bg-redlog-elevated focus-visible:outline focus-visible:outline-red-400"
            onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-redlog-text-dim">
              <time className="font-mono">{formatTime(item.firstAt, { seconds: true })}</time>
              <span>{item.provider === 'claude-code' ? 'Claude Code' : item.provider === 'codex' ? 'Codex' : item.provider ?? item.anchor.agentType}</span>
              <span>{t(item.kind === 'tool' ? `activity.tool.${item.toolAction}` : `activity.kind.${item.kind}`)}</span>
              <span>{t('activity.sources', { matches: item.matchedCount, context: item.contextCount })}</span>
            </div>
            <div className="mt-1 font-mono text-sm break-words">{eventTitle(item.anchor)}</div>
          </button>
          {expanded === item.id && <div className="flex justify-end gap-2 py-2"><select aria-label={t('export.preview.subset')} value={exportKind==='session' && hasSession ? 'session' : 'activity'} onChange={e=>setExportKind(e.target.value as 'activity'|'session')} className="bg-redlog-elevated border border-redlog-border rounded px-2 py-1 text-sm"><option value="activity">{t('activity.export.activity')}</option><option value="session" disabled={!hasSession}>{t('activity.export.session')}</option></select></div>}
          {expanded === item.id && <ActivitySources key={item.id} item={item} request={request} snapshot={page.snapshot} onOpen={onOpen} onRefresh={refresh} />}
        </div>)}
      </div>
      {page.hasMore && <Button disabled={busy} onClick={() => void more()}>{t('search.loadMore')}</Button>}
    </>}
  </div>
}
