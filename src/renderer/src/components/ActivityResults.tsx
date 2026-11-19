import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ActivityKind, ActivityPage, ActivityRequest, ActivitySummary } from '../../../core/activity-contract'
import type { BodySearchCoverage } from '../../../core/http-body-index'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { eventTitle } from '../lib/eventTitle'
import { foldSystemRuns } from '../lib/activityFolds'
import { formatDate, formatTime } from '../lib/time'
import { Button } from './Button'
import { activityResultLabel } from '../lib/commandStatus'
import { ActivityReader, sourceName } from './ActivityReader'
import { ActivityAround } from './ActivityAround'
import { narrowsEvents } from '../lib/filterNarrowing'

/** time | kind | content | target | result | source (01-activity prototype).
 *  The list is the container; narrow, the target column goes first. */
const ROW_GRID = 'grid grid-cols-[72px_16px_minmax(0,1fr)_104px_72px] @min-[720px]:grid-cols-[72px_16px_minmax(0,1fr)_132px_104px_72px] gap-x-3 items-center'
/** The kind of activity as one leading mark. Chosen by the projection's kind,
 *  not by event type: an HTTP exchange and an AI tool call are kinds already. */
const KIND_GLYPH: Record<ActivityKind, string> = { command: '$', http: '→', tool: '◇', message: '◇', event: '·' }
/** A list row is 36px over a 1px rule, a 37px pitch (01-activity prototype),
 *  a minimum rather than a fixed height so nothing it shows is cut. The
 *  global `--row-h` is other lists'. */
const ROW_BOX = 'min-h-9 py-1 px-3'

export function SearchCoverage({ coverage }: { coverage?: BodySearchCoverage }): JSX.Element | null {
  const { t } = useI18n()
  if (!coverage) return null
  const describe=(counts:Partial<BodySearchCoverage>):string[] => (['missing','limited','partial','pending','binary','failed','unsupported'] as const)
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
/** What the list is told about an arrival and about the filter bar. */
interface ActivityListHooks {
  /** The event the operator came from. The activity holding it is opened once
   *  the page answers the request that names it. */
  locateEventId?: string
  /** The located activity was closed: the host gives the operator's own query back. */
  onLocateEnd?: () => void
  /** Clears the filter bar's conditions, when an empty list is theirs to answer for. */
  onClearConditions?: () => void
}

export function ActivityResults({ request, onOpen, onClearQuery, active = true, statsSlot, ...hooks }: { active?: boolean; statsSlot?: HTMLElement | null; onClearQuery?: () => void; request: Omit<ActivityRequest, 'projectId'>; onOpen?: (id: string, ts: number) => void } & ActivityListHooks): JSX.Element {
  const { t } = useI18n()
  const project = useReadState(async () => {
    const config = await window.redlog.config.get() as { engagement?: unknown }
    const engagement = config.engagement as { id?: unknown } | undefined
    if (typeof engagement?.id !== 'string' || !engagement.id) throw new Error(t('content.status.denied'))
    return engagement.id
  })
  if (project.state.phase === 'failed') return <div role="alert">{project.state.error} <Button onClick={project.retry}>{t('common.retry')}</Button></div>
  if (!project.state.value) return <span role="status">{t('search.loading')}</span>
  return <ActivityList key={`${project.state.value}:${JSON.stringify(request)}`} active={active} request={{ ...request, projectId: project.state.value }} onOpen={onOpen} onClearQuery={onClearQuery} statsSlot={statsSlot} {...hooks} />
}
function ActivityList({ request, onOpen, onClearQuery, active, statsSlot, locateEventId, onLocateEnd, onClearConditions }: { active: boolean; statsSlot?: HTMLElement | null; onClearQuery?: () => void; request: ActivityRequest; onOpen?: (id: string, ts: number) => void } & ActivityListHooks): JSX.Element {
  const { t } = useI18n()
  const read = useReadState(() => window.redlog.events.activityPage({ ...request, limit: 50 }))
  const [expanded, setExpanded] = useState<string | null>(null)
  // System-event folds the operator opened, by the first row's id.
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set())
  // The operation being read in the Reader, by id so a refresh does not move it.
  const [readerId, setReaderId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Raw arrivals may not match this query; only promise a fresh read.
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
  // Arriving from a Timeline event. Only the request that names the event
  // counts: the one on screen while the typed query catches up is not it.
  const locating = locateEventId && request.parsed.conditions.some((c) => c.field === 'event' && c.value === locateEventId) ? locateEventId : null
  const located = useRef<string | null>(null)
  const locatedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!locating || !page || locatedFor.current === locating) return
    locatedFor.current = locating
    const holder = page.items.find((item) => item.matchedPreview.ids.includes(locating) || item.sourcePreview.ids.includes(locating) || item.anchor.id === locating)
    if (!holder) return
    located.current = holder.id
    setExpanded(holder.id)
  }, [locating, page])
  // Closing the row is leaving the record; stepping in the Reader moves the
  // open row but does not.
  useEffect(() => {
    if (located.current && expanded === null) { located.current = null; onLocateEnd?.() }
  }, [expanded]) // eslint-disable-line react-hooks/exhaustive-deps
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
      {(() => {
        // The count and what acts on it. With a host row to sit in (the
        // workspace's tab row) it goes there instead of taking a row of its
        // own, and only while this reading is the one shown.
        const stats = <div data-testid="activity-stats" className={`flex flex-wrap items-center gap-2 text-xs text-redlog-text-dim ${statsSlot ? '' : 'mb-2 justify-between'}`}>
          <span>{t('activity.count', { groups: page.totalGroups })}
            {filtering && onClearQuery && <button type="button" data-testid="activity-clear-filter" onClick={onClearQuery} className="ml-2 underline hover:text-redlog-text focus-visible:outline focus-visible:outline-red-400">{t('activity.clearFilter')}</button>}
          </span>
          {newEvents && <button type="button" data-testid="activity-new-events" onClick={refresh} className="underline underline-offset-2 text-redlog-text-dim hover:text-redlog-text focus-visible:outline focus-visible:outline-red-400">{t('activity.refresh')}</button>}
        </div>
        if (!statsSlot) return stats
        return active ? createPortal(stats, statsSlot) : null
      })()}
      {page.items.length === 0 && (() => {
        // Three different empties: the filter bar's conditions emptied it, a
        // typed query matched nothing, or there is nothing recorded to match.
        const narrowed = narrowsEvents(request.filter)
        return <p data-testid="activity-empty" className="text-sm text-redlog-text-faint">
          {t(narrowed ? 'activity.noMatchesFiltered' : filtering ? 'activity.noMatches' : 'activity.empty')}
          {narrowed && onClearConditions && <button type="button" data-testid="activity-clear-conditions" onClick={onClearConditions} className="ml-2 underline hover:text-redlog-text focus-visible:outline focus-visible:outline-red-400">{t('filter.clearAll')}</button>}
        </p>
      })()}
      <div data-testid="activity-list" className="@container flex flex-col">
        {(() => {
          const day = (at: number): JSX.Element | null => (at === 0 || formatDate(page.items[at - 1].firstAt) !== formatDate(page.items[at].firstAt))
            ? <div data-testid="activity-day" role="separator" className="mt-2 flex h-7 items-center gap-3 px-3 font-mono text-xs text-redlog-text-dim select-none">
              <span className="h-px w-4 bg-redlog-border-subtle" /><span>{formatDate(page.items[at].firstAt) === formatDate(Date.now()) && `${t('activity.today')} `}{formatDate(page.items[at].firstAt)}</span><span className="h-px flex-1 bg-redlog-border-subtle" />
            </div>
            : null
          const row = (item: ActivitySummary, at: number, withDay: boolean): JSX.Element => <div key={item.id} className="min-w-0">
          {withDay && day(at)}
          <div className={`border-b border-redlog-border-subtle transition-colors ${expanded === item.id ? 'bg-redlog-elevated' : 'hover:bg-redlog-elevated'}`}>
          <button type="button" data-testid="activity-row" aria-expanded={expanded === item.id} className={`${ROW_GRID} ${ROW_BOX} w-full text-left focus-visible:outline focus-visible:outline-red-400`}
            onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
            <time className="font-mono text-xs text-redlog-text-dim">{formatTime(item.firstAt, { seconds: true })}</time>
            {(() => {
              const r = activityResultLabel(item, t)
              const source = sourceName(item, t)
              const kind = `${source} · ${t(item.kind === 'tool' ? `activity.tool.${item.toolAction}` : `activity.kind.${item.kind}`)}`
              const target = item.anchor.targetId
              return <>
                <span data-testid="activity-kind" role="img" aria-label={kind} title={kind} className="text-center font-mono text-xs text-redlog-text-faint">{KIND_GLYPH[item.kind] ?? '·'}</span>
                <span data-testid="activity-content" className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-sm text-redlog-text" title={eventTitle(item.anchor, t)}>{eventTitle(item.anchor, t)}</span>
                  {filtering && <span className="shrink-0 text-xs text-redlog-text-dim">{t('activity.sources', { matches: item.matchedCount, context: item.contextCount })}</span>}
                </span>
                <span data-testid="activity-target" title={target ?? undefined} className="hidden @min-[720px]:block min-w-0 truncate font-mono text-xs text-redlog-text-dim">{target ?? ''}</span>
                {/* A failure carries a word as well as its colour; success is the
                    code alone; a state not known shows nothing (lib/commandStatus). */}
                <span data-testid="activity-result" title={r?.title} className={`overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-xs ${r?.tone === 'fail' ? 'font-medium text-red-300' : r?.tone === 'neutral' ? 'text-amber-300' : 'text-redlog-text-dim'}`}>
                  {r && r.title && r.title !== r.text ? <><span aria-hidden="true">{r.text}</span><span className="sr-only">{r.title}</span></> : r?.text ?? ''}
                </span>
                <span data-testid="activity-row-source" title={source} className="min-w-0 truncate text-right text-xs text-redlog-text-faint">{source}</span>
              </>
            })()}
          </button>
          {expanded === item.id && <div data-testid="activity-summary" className="px-2 pb-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button level="primary" size="compact" data-testid="activity-read" onClick={() => setReaderId(item.id)}>{t('activity.reader.open')} ↗</Button>
                {onOpen && <Button size="compact" data-testid="activity-locate" onClick={() => onOpen(item.anchor.id, item.anchor.timestamp)}>{t('activity.reader.locate')}</Button>}
              </div>
              {/* Hit counts are on the row while a query is active, and the
                  session and PID are under 事件資訊 in the Reader. With no
                  query the row has no count, so the source count is said here. */}
              {!filtering && <p data-testid="activity-summary-meta" className="text-xs text-redlog-text-faint">{t('activity.summary.sources', { count: item.sourceCount })}</p>}
            </div>
            <ActivityAround item={item} projectId={request.projectId} scope={{ inScopeOnly: request.filter?.inScopeOnly, hidePersonal: request.filter?.hidePersonal }} />
          </div>}
          </div>
        </div>
          // A query asked for these rows; of what it matched only clean scope
          // verdicts fold (src/renderer/src/lib/activityFolds.ts).
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
                className={`${ROW_GRID} ${ROW_BOX} w-full text-left border-b border-redlog-border-subtle hover:bg-redlog-elevated focus-visible:outline focus-visible:outline-red-400`}>
                <time className="font-mono text-xs text-redlog-text-faint">{formatTime(seg.items[0].firstAt, { seconds: true })}</time>
                <span aria-hidden="true" className="text-center font-mono text-xs text-redlog-text-faint">{KIND_GLYPH.event}</span>
                <span className="col-[3/-1] min-w-0 text-sm text-redlog-text-dim">{t('activity.systemFold', { count: seg.items.length })} <span aria-hidden="true" className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span></span>
              </button>
              {open && <div className="flex flex-col pl-3 border-l border-redlog-border-subtle">
                {seg.items.map((it, k) => row(it, seg.at + k, false))}
              </div>}
            </div>
          })
        })()}
      </div>
      {/* A paged list must not look complete: say how much of it is here. */}
      {page.hasMore && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-redlog-text-faint">
        <span data-testid="activity-loaded" className="font-mono">{t('activity.loaded', { shown: page.items.length, total: page.totalGroups })}</span>
        <Button size="compact" disabled={busy} onClick={() => void more()}>{t('search.loadMore')}</Button>
      </div>}
      {readerIndex >= 0 && <ActivityReader items={page.items} index={readerIndex} request={request} snapshot={page.snapshot} active={active} filtering={filtering}
        hasMore={page.hasMore} loading={busy}
        onStep={step} onClose={() => setReaderId(null)}
        // The Reader stays open under the Timeline, so coming back lands where the reading was (#589).
        onLocate={onOpen ? (event) => onOpen(event.id, event.timestamp) : undefined} />}
      </>
    })()}
  </div>
}
