import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { ActivityPage, ActivityRequest, ActivitySummary } from '../../../core/activity-contract'
import type { RedLogEvent } from '../../../core/db/events'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { readSelectedEventId, writeSelectedEventId } from '../lib/selectedEvent'
import { useFocusTrap } from '../lib/useFocusTrap'
import { eventTitle } from '../lib/eventTitle'
import { agentTypeLabel } from '../lib/timelineDomain'
import { formatDateTime, formatTime } from '../lib/time'
import { Button } from './Button'
import { EventContentReader } from './EventContentReader'

type T = (key: string, vars?: Record<string, string | number>) => string

/** What an operator calls the source of an operation: a named provider, else the
 *  event type as the filter's own source list names it. */
export function sourceName(item: ActivitySummary, t: T): string {
  if (item.provider === 'claude-code') return 'Claude Code'
  if (item.provider === 'codex') return 'Codex'
  return item.provider ?? agentTypeLabel(item.anchor.agentType, t)
}

/** The label a source-event tab carries: what the event is, and when. */
function sourceLabel(event: RedLogEvent, t: T): string {
  const subtype = String(event.data.subtype ?? event.agentType)
  const what = subtype === 'command_start' ? t('content.field.command')
    : subtype === 'command_end' ? t('activity.commandResult')
      : subtype === 'tool_call' ? t('content.field.tool_input')
        : subtype === 'tool_result' ? t('content.field.output') : subtype
  return `${what} · ${formatTime(event.timestamp, { seconds: true })}`
}

function Tile({ label, value, mono = false, testid }: { label: string; value: string; mono?: boolean; testid?: string }): JSX.Element {
  return (
    <div data-testid={testid} className="min-w-0 rounded bg-redlog-bg p-2">
      <dt className="text-xs text-redlog-text-faint">{label}</dt>
      <dd title={value} className={`${mono ? 'font-mono ' : ''}m-0 truncate text-xs text-redlog-text`}>{value}</dd>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 py-0.5">
      <dt className="text-redlog-text-faint">{label}</dt>
      <dd className="m-0 break-all text-right font-mono text-redlog-text">{value}</dd>
    </div>
  )
}

/** What the store holds about one event, as stored. The hashes are shown, not
 *  checked: this view cannot say the chain is intact, only what it recorded. */
function EventFacts({ event, t }: { event: RedLogEvent; t: T }): JSX.Element {
  return (
    <>
      <section data-testid="reader-event-info" className="space-y-2 border-t border-redlog-border-subtle pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase text-redlog-text-faint">{t('activity.reader.info')}</h3>
          <span className="font-mono text-xs text-redlog-text-faint">{t('activity.reader.field.session')} {event.sessionId}</span>
        </div>
        <dl className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
          <Tile label={t('activity.reader.field.time')} value={formatDateTime(event.timestamp)} mono />
          <Tile label={t('activity.reader.field.source')} value={agentTypeLabel(event.agentType, t)} />
          {event.targetId && <Tile label={t('activity.reader.field.target')} value={event.targetId} mono />}
          {/* What a finished command carries, when this event is one. Shown as
              stored: an event without them simply has no such tiles. */}
          {typeof event.data.exit_code === 'number' && <Tile label={t('activity.reader.field.exit')} value={String(event.data.exit_code)} mono />}
          {typeof event.data.duration_sec === 'number' && <Tile label={t('activity.reader.field.duration')} value={`${event.data.duration_sec} s`} mono />}
          {typeof event.data.pid === 'number' && <Tile label={t('activity.reader.field.pid')} value={String(event.data.pid)} mono />}
          {typeof event.data.cwd === 'string' && event.data.cwd && <Tile label={t('activity.reader.field.cwd')} value={event.data.cwd} mono />}
        </dl>
      </section>
      <details data-testid="reader-integrity" className="rounded border border-redlog-border bg-redlog-bg text-xs">
        <summary className="flex cursor-pointer items-center justify-between gap-2 p-2 text-redlog-text-faint hover:text-redlog-text">
          <span>{t('activity.reader.integrity')}</span>
          <span className="font-mono">{t('activity.reader.integrityKind')}</span>
        </summary>
        <dl className="space-y-0.5 border-t border-redlog-border-subtle px-3 pb-3 pt-2">
          <Row label={t('activity.reader.field.eventId')} value={event.id} />
          <Row label={t('activity.reader.field.hash')} value={event.hash ?? t('activity.reader.notChained')} />
          {event.hash && <Row label={t('activity.reader.field.prevHash')} value={event.prevHash ?? t('activity.reader.firstInChain')} />}
          <div className="flex flex-wrap items-center justify-between gap-x-3 py-0.5">
            <dt className="text-redlog-text-faint">{t('activity.reader.recordState')}</dt>
            <dd className="m-0 text-right text-redlog-text-dim">{t('activity.reader.integrityNote')}</dd>
          </div>
        </dl>
      </details>
    </>
  )
}

/** One operation's source events, read one at a time. The first source is
 *  chosen once, and a later page of sources must not replace what is being read. */
function ReaderSources({ item, request, snapshot, active, filtering, onChoose }: {
  item: ActivitySummary; request: ActivityRequest; snapshot: ActivityPage['snapshot']; active: boolean; filtering: boolean
  /** The event currently read, so the actions beside it can act on it. */
  onChoose: (event: RedLogEvent) => void
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
  // The event selected elsewhere (Timeline, another view) wins when it is one of
  // this operation's sources; otherwise the most telling source.
  const shared = readSelectedEventId()
  const current = sources.find(r => r.event.id === selected)
    ?? sources.find(r => r.event.id === shared)
    ?? sources.find(r => r.matched && ['command_end', 'tool_result', 'http_response'].includes(String(r.event.data.subtype)))
    ?? sources.find(r => r.matched)
    ?? sources[0]
  useEffect(() => {
    if (!current) return
    if (selected === null) setSelected(current.event.id)
    writeSelectedEventId(current.event.id)
    onChoose(current.event)
    setVisited(prev => prev.has(current.event.id) ? prev : new Set([...prev, current.event.id]))
  }, [current?.event.id])
  return <div className="space-y-3 min-w-0">
    {read.state.phase === 'loading' && <span role="status">{t('search.loading')}</span>}
    {(error || read.state.phase === 'failed') && <div role="alert" className="text-xs text-amber-300">{error ?? (read.state.phase === 'failed' ? read.state.error : '')} <Button onClick={read.retry}>{t('activity.refresh')}</Button></div>}
    {current && <>
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="text-xs text-redlog-text-dim">{t('activity.reader.sourceEvents')}</span>
        <div role="tablist" aria-label={t('activity.sourceEvent')} className="flex flex-wrap items-center gap-1 rounded border border-redlog-border bg-redlog-bg p-0.5 min-w-0">
          {sources.map(r => {
            const on = r.event.id === current.event.id
            return <button key={r.event.id} type="button" role="tab" aria-selected={on} data-testid="reader-source-tab" data-event-id={r.event.id}
              onClick={() => setSelected(r.event.id)}
              className={`px-2 py-1 rounded text-xs whitespace-nowrap ${on ? 'bg-redlog-elevated text-redlog-text' : 'text-redlog-text-dim hover:text-redlog-text'}`}>
              {filtering && <span className="text-redlog-text-faint">{r.matched ? t('activity.matchLabel') : t('activity.contextLabel')} · </span>}{sourceLabel(r.event, t)}
            </button>
          })}
        </div>
        {read.state.value?.hasMore && <Button size="compact" disabled={busy} onClick={() => void more()}>{t('activity.moreSources')}</Button>}
      </div>
      {sources.filter(source => visited.has(source.event.id) || source.event.id === current.event.id).map(source =>
        <div key={source.event.id} hidden={source.event.id !== current.event.id}>
          <EventContentReader active={active} projectId={request.projectId} eventId={source.event.id} />
        </div>)}
      <EventFacts event={current.event} t={t} />
    </>}
  </div>
}

/** The Reader for one operation: where the rows stop and the reading starts.
 *  One bar says which operation this is and steps to the neighbours; the rest
 *  is the existing saved-content reader, unchanged, inside it. */
export function ActivityReader({ items, index, request, snapshot, active, filtering, hasMore, loading, onStep, onClose, onLocate }: {
  items: ActivitySummary[]; index: number; request: ActivityRequest; snapshot: ActivityPage['snapshot']
  active: boolean; filtering: boolean
  /** More operations exist beyond those loaded; stepping past the last asks for them. */
  hasMore: boolean; loading: boolean
  onStep: (direction: -1 | 1) => void
  onClose: () => void
  onLocate?: (event: RedLogEvent) => void
}): JSX.Element {
  const { t } = useI18n()
  const item = items[index]
  const root = useRef<HTMLDivElement>(null)
  useFocusTrap(root, active)
  // The event read, for the actions beside it. Remembered with its operation, so
  // a step to the next one never offers the previous one's event.
  const [chosen, setChosen] = useState<{ itemId: string; event: RedLogEvent } | null>(null)
  const current = chosen?.itemId === item.id ? chosen.event : null
  const atStart = index <= 0
  const atEnd = index >= items.length - 1 && !hasMore
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60 p-3" role="presentation"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={root} role="dialog" aria-modal="true" aria-label={t('activity.reader.title')} data-testid="activity-reader" tabIndex={-1}
        onKeyDown={e => {
          // An inner expanded reader answers Escape itself and stops it first.
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          // Arrows belong to text being read, typed or chosen from.
          if ((e.target as HTMLElement).closest('pre,input,textarea,select,[role="tab"]')) return
          e.preventDefault()
          if (e.key === 'ArrowUp' ? !atStart : !atEnd) onStep(e.key === 'ArrowUp' ? -1 : 1)
        }}
        className="outline-none w-full max-w-5xl flex flex-col rounded border border-redlog-border bg-redlog-bg shadow-xl min-h-0">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-redlog-border shrink-0">
          <div className="flex items-center gap-2 min-w-0 text-xs">
            <span data-testid="reader-badge" className="px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim shrink-0">
              {sourceName(item, t)}
            </span>
            <time className="font-mono text-redlog-text-dim shrink-0">{formatTime(item.firstAt, { seconds: true })}</time>
            <span data-testid="reader-headline" title={eventTitle(item.anchor, t)} className="font-mono text-redlog-text truncate min-w-0">{eventTitle(item.anchor, t)}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 rounded border border-redlog-border bg-redlog-bg p-0.5">
              <button type="button" data-testid="reader-prev" aria-label={t('activity.reader.prev')} title={t('activity.reader.prev')} disabled={atStart} onClick={() => onStep(-1)}
                className="w-6 h-6 flex items-center justify-center rounded text-redlog-text-dim hover:text-redlog-text disabled:opacity-40"><ChevronUp size={14} aria-hidden /></button>
              <span data-testid="reader-counter" className="text-xs font-mono text-redlog-text-dim px-1">{t('activity.reader.counter', { index: index + 1, total: items.length })}{hasMore ? '+' : ''}</span>
              <button type="button" data-testid="reader-next" aria-label={t('activity.reader.next')} title={t('activity.reader.next')} disabled={atEnd || loading} onClick={() => onStep(1)}
                className="w-6 h-6 flex items-center justify-center rounded text-redlog-text-dim hover:text-redlog-text disabled:opacity-40"><ChevronDown size={14} aria-hidden /></button>
            </div>
            {onLocate && <Button size="compact" data-testid="reader-locate" disabled={!current} onClick={() => current && onLocate(current)}>{t('activity.reader.locate')}</Button>}
            <Button size="compact" level="quiet" data-testid="reader-close" onClick={onClose}><X size={14} aria-hidden className="inline mr-1" />{t('activity.reader.close')}</Button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <ReaderSources key={item.id} item={item} request={request} snapshot={snapshot} active={active} filtering={filtering} onChoose={(event) => setChosen({ itemId: item.id, event })} />
        </div>
      </div>
    </div>
  )
}
