import { useId, useState } from 'react'
import type { ActivitySummary } from '../../../core/activity-contract'
import type { EventQueryOptions, RedLogEvent } from '../../../core/db/events'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { eventTitle } from '../lib/eventTitle'
import { agentTypeLabel } from '../lib/timelineDomain'
import { formatDateTime } from '../lib/time'
import { AROUND_MINUTES, AROUND_PER_SIDE, aroundQueries, aroundRelation, formatOffset, shapeAround, type AroundWindow } from '../lib/activityAround'
import { Button } from './Button'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const PROVIDERS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

function sourceOf(event: RedLogEvent, t: Translate): string {
  const provider = event.agentType === 'agent' ? event.data?.agent : undefined
  return (typeof provider === 'string' && PROVIDERS[provider]) || agentTypeLabel(event.agentType, t)
}

/** One neighbouring event. Its tie to the operation is named only when a shared
 *  key proves it; otherwise the only thing said is that it was nearby in time. */
function AroundRow({ anchor, event, t }: { anchor: ActivitySummary['anchor']; event: RedLogEvent; t: Translate }): JSX.Element {
  const relation = aroundRelation(anchor, event)
  return <li data-testid="activity-around-event" data-relation={relation ?? 'time'}
    className="grid grid-cols-[4.5rem_7.5rem_minmax(0,1fr)_auto] items-center gap-x-3 px-2 py-1 text-xs">
    <time className="font-mono text-redlog-text-dim" title={formatDateTime(event.timestamp, { seconds: true })}>{formatOffset(event.timestamp - anchor.timestamp)}</time>
    <span className="truncate text-redlog-text-dim">{sourceOf(event, t)}</span>
    <span className="min-w-0 truncate font-mono text-redlog-text" title={eventTitle(event, t)}>{eventTitle(event, t)}</span>
    <span data-testid="activity-around-relation" className={relation ? 'rounded bg-redlog-elevated px-1.5 py-0.5 text-redlog-text' : 'text-redlog-text-faint'}>
      {t(relation ? `activity.around.${relation}` : 'activity.around.time')}
    </span>
  </li>
}

/** Declared at module scope: inside ActivityList it would remount on every render. */
function AroundList({ item, projectId, scope, id }: {
  item: ActivitySummary; projectId: string; scope: Pick<EventQueryOptions, 'inScopeOnly' | 'hidePersonal'>; id: string
}): JSX.Element {
  const { t } = useI18n()
  const read = useReadState<AroundWindow>(async () => {
    // The events bridge answers for whichever project is open. A reply is only
    // read as this operation's neighbours if that is still the project asked about.
    const open = async (): Promise<string | undefined> => ((await window.redlog.config.get()) as { engagement?: { id?: string } }).engagement?.id
    if (await open() !== projectId) throw new Error(t('content.status.denied'))
    const queries = aroundQueries(item, scope)
    const [before, after] = await Promise.all([window.redlog.events.query(queries.before), window.redlog.events.query(queries.after)])
    if (await open() !== projectId || [...before, ...after].some(event => event.engagementId !== projectId)) throw new Error(t('content.status.denied'))
    return shapeAround(item, before, after)
  }, true, [item.id, projectId, scope.inScopeOnly, scope.hidePersonal])
  const around = read.state.value
  const empty = around !== null && around.before.length === 0 && around.after.length === 0
  return <div id={id} data-testid="activity-around" className="min-w-0 rounded border border-redlog-border-subtle bg-redlog-bg">
    {read.state.phase === 'loading' && <span role="status" className="block px-2 py-1 text-xs text-redlog-text-dim">{t('search.loading')}</span>}
    {read.state.phase === 'failed' && <div role="alert" className="px-2 py-1 text-xs text-amber-300">{read.state.error} <Button size="compact" level="quiet" onClick={read.retry}>{t('activity.refresh')}</Button></div>}
    {around && !empty && <ol className="m-0 list-none p-0">
      {around.before.map(event => <AroundRow key={event.id} anchor={item.anchor} event={event} t={t} />)}
      <li aria-current="true" className="px-2 py-0.5 text-xs text-redlog-text-faint">{t('activity.around.this')}</li>
      {around.after.map(event => <AroundRow key={event.id} anchor={item.anchor} event={event} t={t} />)}
    </ol>}
    {empty && <p data-testid="activity-around-empty" className="m-0 px-2 py-1 text-xs text-redlog-text-dim">{t('activity.around.empty', { minutes: AROUND_MINUTES })}</p>}
    {around && (around.moreBefore || around.moreAfter) && <p data-testid="activity-around-more" className="m-0 px-2 py-1 text-xs text-redlog-text-faint">{t('activity.around.more', { count: AROUND_PER_SIDE })}</p>}
  </div>
}

/** What else the project recorded around one operation, from every source:
 *  the nearest few events either side of its anchor, within the same window
 *  the Timeline opens. Read only when asked for. */
export function ActivityAround({ item, projectId, scope = {} }: {
  item: ActivitySummary; projectId: string; scope?: Pick<EventQueryOptions, 'inScopeOnly' | 'hidePersonal'>
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const id = useId()
  return <div className="space-y-2">
    <Button size="compact" level="quiet" data-testid="activity-around-toggle" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>{t('filter.around')}</Button>
    {open && <AroundList item={item} projectId={projectId} scope={scope} id={id} />}
  </div>
}
