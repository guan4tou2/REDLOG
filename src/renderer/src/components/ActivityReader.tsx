import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { ActivityPage, ActivityRequest, ActivitySummary } from '../../../core/activity-contract'
import type { RedLogEvent } from '../../../core/db/events'
import { useI18n } from '../i18n'
import { useReadState } from '../lib/readState'
import { readSelectedEventId, writeSelectedEventId } from '../lib/selectedEvent'
import { useFocusTrap } from '../lib/useFocusTrap'
import { eventTitle } from '../lib/eventTitle'
import { formatDateTime, formatTime } from '../lib/time'
import { Button } from './Button'
import { EventContentReader } from './EventContentReader'

type T = (key: string, vars?: Record<string, string | number>) => string

/** The label a source-event tab carries: what the event is, and when. */
function sourceLabel(event: RedLogEvent, t: T): string {
  const subtype = String(event.data.subtype ?? event.agentType)
  const what = subtype === 'command_start' ? t('content.field.command')
    : subtype === 'command_end' ? t('activity.commandResult')
      : subtype === 'tool_call' ? t('content.field.tool_input')
        : subtype === 'tool_result' ? t('content.field.output') : subtype
  return `${what} · ${formatTime(event.timestamp, { seconds: true })}`
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): JSX.Element {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 py-1 border-b border-redlog-border-subtle last:border-0">
      <dt className="text-redlog-text-dim">{label}</dt>
      <dd className={`${mono ? 'font-mono ' : ''}text-redlog-text break-all text-right`}>{value}</dd>
    </div>
  )
}

/** What the store holds about one event, as stored. The hashes are shown, not
 *  checked: this view cannot say the chain is intact, only what it recorded. */
function EventFacts({ event, t }: { event: RedLogEvent; t: T }): JSX.Element {
  return (
    <>
      <section data-testid="reader-event-info" className="rounded border border-redlog-border bg-redlog-surface/50 p-3">
        <h3 className="text-xs font-semibold text-redlog-text mb-1">{t('activity.reader.info')}</h3>
        <dl className="text-xs">
          <Row label={t('activity.reader.field.time')} value={formatDateTime(event.timestamp)} mono />
          <Row label={t('activity.reader.field.source')} value={event.agentType} />
          {event.targetId && <Row label={t('activity.reader.field.target')} value={event.targetId} mono />}
          <Row label={t('activity.reader.field.session')} value={event.sessionId} mono />
          <Row label={t('activity.reader.field.eventId')} value={event.id} mono />
        </dl>
      </section>
      <details data-testid="reader-integrity" className="rounded border border-redlog-border bg-redlog-surface/50 p-3 text-xs">
        <summary className="cursor-pointer font-semibold text-redlog-text">{t('activity.reader.integrity')}</summary>
        <p className="text-redlog-text-faint mt-1">{t('activity.reader.integrityNote')}</p>
        <dl className="mt-1">
          <Row label={t('activity.reader.field.hash')} value={event.hash ?? t('activity.reader.notChained')} mono />
          {event.hash && <Row label={t('activity.reader.field.prevHash')} value={event.prevHash ?? t('activity.reader.firstInChain')} mono />}
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
              {item.provider === 'claude-code' ? 'Claude Code' : item.provider === 'codex' ? 'Codex' : item.provider ?? item.anchor.agentType}
            </span>
            <time className="font-mono text-redlog-text-dim shrink-0">{formatTime(item.firstAt, { seconds: true })}</time>
            <span data-testid="reader-headline" title={eventTitle(item.anchor)} className="font-mono text-redlog-text truncate min-w-0">{eventTitle(item.anchor)}</span>
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
