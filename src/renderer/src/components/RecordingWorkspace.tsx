import { Button, FIELD_FOCUS_RING } from './Button'
import SourceSessionPicker from './SourceSessionPicker'
import type { SourceSession } from '../../../core/source-sessions'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { SearchPanel } from './SearchPanel'
import { useSharedFilter } from '../lib/FilterContext'
import { Search } from 'lucide-react'
import { useCaptureHealthState } from '../lib/useCaptureHealth'
import { HEADER_GUTTER } from '../lib/pageLayout'

/** A capture source that failed, as the event type its rows carry — so the
 *  alert can narrow the list to it. Sources without a single type of their own
 *  are named but not filterable. */
const SOURCE_AGENT_TYPE: Record<string, string> = { terminal: 'shell', mitmproxy: 'http', screenshot: 'screenshot' }

/** A capture source that reports a failure, beside the title: the one thing
 *  about capture this page says that the status bar does not, because it can
 *  narrow the list to that source. Recording state and the project's event
 *  count are the status bar's, on every page. */
function SourceAlert({ onFilter, knownAgentTypes }: { onFilter: (agentType: string) => void; knownAgentTypes: string[] }): JSX.Element | null {
  const { t } = useI18n()
  const { health, status } = useCaptureHealthState()
  const failing = status === 'ok' ? (health?.sources ?? []).filter((s) => s.state === 'error' && !s.informational) : []
  if (failing.length === 0) return null
  const filterable = failing.map((s) => SOURCE_AGENT_TYPE[s.id]).find((at) => at && knownAgentTypes.includes(at))
  return <button type="button" data-testid="activity-source-alert" disabled={!filterable}
    onClick={() => { if (filterable) onFilter(filterable) }}
    className="flex items-center gap-1 rounded border border-redlog-danger/80 bg-redlog-danger/15 px-2 py-0.5 text-xs font-medium text-red-300 hover:bg-redlog-danger/25 disabled:cursor-default">
    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-redlog-danger" />
    {t('activity.status.sourceAlert', { count: failing.length, names: failing.map((s) => s.label ?? s.id).join('、') })}
    {filterable && <span aria-hidden>→</span>}
  </button>
}

/** The kinds the page offers as buttons, each the one event type it filters
 *  to. HTTP is not here: proxy traffic is `scanner`, which also holds
 *  connection and C2 rows, and browser navigation is a type of its own. Every
 *  other source stays in the FilterBar panel's full type list, whose chip shows
 *  it while none of these is pressed. */
const SOURCE_KINDS: ReadonlyArray<{ agentType: string; label: string }> = [
  { agentType: 'shell', label: 'activity.filter.command' },
  { agentType: 'agent', label: 'timeline.agent' },
  { agentType: 'file_transfer', label: 'timeline.files' },
  { agentType: 'marker', label: 'timeline.markers' }
]

const TranscriptView = lazy(() => import('./TranscriptView'))
type Reading = 'activities' | 'io' | 'ai' | 'events'
const READINGS: Reading[] = ['activities', 'io', 'ai', 'events']

/** Reading modes share a query; visited readers retain their own position. */
export default function RecordingWorkspace({ active = true, onOpenInTimeline, onOpenTimeline, externalQuery, requestedReading }: {
  active?: boolean
  requestedReading?: { mode: 'io' | 'ai'; at: number } | null
  /** A query handed in from elsewhere (the Timeline's "open in activity log");
   *  each new `at` replaces the box's text once, and the operator edits on from there. */
  externalQuery?: { text: string; at: number; eventId?: string } | null
  onOpenInTimeline?: (id: string, ts: number) => void
  /** Open the visual Timeline for this project, with no event focused. */
  onOpenTimeline?: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [reading, setReading] = useState<Reading>('activities')
  const [query, setQuery] = useState('')
  const [provider,setProvider]=useState('')
  const [sessions,setSessions]=useState<Record<'io'|'ai',SourceSession|null>>({io:null,ai:null})
  const picked=reading==='io'||reading==='ai' ? sessions[reading] : null
  const effectiveQuery=[query,reading==='ai' && provider ? `provider:${provider}` : '',picked ? `source:${picked.token}` : ''].filter(Boolean).join(' ')
  const [visited, setVisited] = useState<Set<Reading>>(new Set(['activities']))
  const field = useRef<HTMLInputElement>(null)
  // State, not a ref: the list portals its count in, and has to render again
  // once the slot exists.
  const [statsSlot, setStatsSlot] = useState<HTMLDivElement | null>(null)
  // The query an arrival replaced, kept until the located record is left. It is
  // the operator's, only lent to the arrival: a second arrival before leaving
  // keeps the first loan.
  const [locating, setLocating] = useState<{ eventId: string; restore: string } | null>(null)
  const locatingRef = useRef(locating)
  locatingRef.current = locating
  const endLocating = (): void => {
    const lent = locatingRef.current
    if (!lent) return
    setLocating(null)
    setQuery(lent.restore)
  }
  useEffect(() => {
    if (!externalQuery) return
    if (externalQuery.eventId) setLocating({ eventId: externalQuery.eventId, restore: locatingRef.current?.restore ?? query })
    setQuery(externalQuery.text)
    setReading('activities')
  }, [externalQuery?.at]) // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the page is leaving the record: the way back finds the query the
  // operator had.
  useEffect(() => { if (!active) endLocating() }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!requestedReading) return
    setReading(requestedReading.mode)
    setVisited(previous => new Set([...previous, requestedReading.mode]))
  }, [requestedReading])
  const choose = (next: Reading): void => {
    setReading(next)
    setVisited(prev => new Set([...prev, next]))
  }
  useEffect(() => {
    if (!active) return
    const focus = (): void => { field.current?.focus(); field.current?.select() }
    window.addEventListener('redlog:find-in-page', focus)
    return () => window.removeEventListener('redlog:find-in-page', focus)
  }, [active])
  const searching = reading === 'activities' || reading === 'events'
  // The source choice is the filter context's own agent type, not a second
  // state: the FilterBar's chip, every other view and these buttons read one value.
  const { filter, setAgentType, knownAgentTypes } = useSharedFilter()
  return <div className="h-full min-h-0 min-w-0 flex flex-col" data-testid="recording-workspace">
    <div className="flex px-pad pt-3 shrink-0">
    <div className="min-w-0 flex-1 space-y-3">
      {/* Title and the controls that act on the whole page share one row,
          and wrap when the pane is narrow. */}
      <div data-testid="activity-title-row" className="flex flex-wrap items-center gap-2">
        <h1 data-testid="activity-title" className="text-base font-medium text-redlog-text">{t('activity.pageTitle')}</h1>
        <div className="relative min-w-0 flex-1 basis-60">
          <Search size={16} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-redlog-text-faint" />
          <input ref={field} type="search" data-testid="search-input" aria-label={t('search.placeholder')}
            value={query} onChange={e => { setLocating(null); setQuery(e.target.value) }} placeholder={t('search.placeholder')}
            className={`h-8 w-full min-w-0 rounded-lg border border-redlog-border bg-redlog-surface pl-8 pr-3 text-sm focus:border-redlog-accent ${FIELD_FOCUS_RING}`} />
        </div>
        {searching && <div role="group" data-testid="activity-source" aria-label={t('activity.sourceLabel')} className="flex flex-wrap items-center gap-1">
          {SOURCE_KINDS.map(({ agentType, label }) => <Button key={agentType} level="quiet" size="compact" aria-pressed={filter.agentType === agentType}
            onClick={() => setAgentType(filter.agentType === agentType ? null : agentType)}>{t(label)}</Button>)}
        </div>}
        <SourceAlert knownAgentTypes={knownAgentTypes} onFilter={(at) => { setAgentType(at); choose('activities') }} />
      </div>
      <div data-testid="activity-tab-row" className="flex flex-wrap items-center gap-x-2 border-b border-redlog-border">
        <div role="tablist" aria-label={t('activity.view')} className="flex flex-wrap gap-1">
          {READINGS.map((mode, index) => <button key={mode} type="button" role="tab"
            id={`reading-tab-${mode}`} aria-controls={mode === 'activities' || mode === 'events' ? 'reading-panel-search' : `reading-panel-${mode}`} aria-selected={reading === mode}
            tabIndex={reading === mode ? 0 : -1} onClick={() => choose(mode)}
            onKeyDown={e => {
              const next = e.key === 'ArrowRight' ? READINGS[(index + 1) % READINGS.length]
                : e.key === 'ArrowLeft' ? READINGS[(index + READINGS.length - 1) % READINGS.length]
                  : e.key === 'Home' ? READINGS[0] : e.key === 'End' ? READINGS.at(-1) : undefined
              if (next) { e.preventDefault(); choose(next); document.getElementById(`reading-tab-${next}`)?.focus() }
            }}
            className={`px-3 py-2 text-xs border-b-2 ${reading === mode ? 'border-redlog-accent text-redlog-text' : 'border-transparent text-redlog-text-dim hover:text-redlog-text'}`}
          >{t(`workspace.reading.${mode}`)}</button>)}
        </div>
        {/* The activity count lands here (ActivityResults portals it in),
            beside the way to the Timeline, rather than on a row of its own. */}
        <div ref={setStatsSlot} data-testid="activity-stats-slot" className="ml-auto self-center flex items-center" />
        {onOpenTimeline && (
          <button type="button" onClick={onOpenTimeline} data-testid="workspace-open-timeline"
            className="px-3 py-2 text-xs text-redlog-text-dim hover:text-redlog-text"
          >{t('workspace.openTimeline')} ↗</button>
        )}
      </div>
      {(reading==='io'||reading==='ai') && <div className="flex flex-wrap gap-2 pb-2">
        {reading==='ai' && <select aria-label={t('workspace.provider')} value={provider} onChange={e=>{setProvider(e.target.value);setSessions(prev=>({...prev,ai:null}))}} className="rounded border border-redlog-border bg-redlog-elevated px-2 py-1 text-xs">
          <option value="">{t('workspace.allProviders')}</option><option value="claude-code">Claude Code</option><option value="codex">Codex</option>
        </select>}
        <SourceSessionPicker kind={reading==='ai'?'agent':'shell'} provider={reading==='ai'?provider||undefined:undefined} value={sessions[reading]} onChange={session=>setSessions(prev=>({...prev,[reading]:session}))} />
      </div>}
    </div>
    {/* The results below keep a scrollbar gutter; this keeps the same one. */}
    <span aria-hidden data-scroll-gutter className={HEADER_GUTTER} />
    </div>
    <div role="tabpanel" id="reading-panel-search" aria-labelledby={`reading-tab-${reading === 'events' ? 'events' : 'activities'}`}
      hidden={!searching} className={searching ? 'flex-1 min-h-0' : undefined}>
      <SearchPanel browse statsSlot={statsSlot} controlledQuery={query} viewMode={reading === 'events' ? 'events' : 'activities'} onClearQuery={() => { setLocating(null); setQuery('') }} locateEventId={locating?.eventId} onLocateEnd={endLocating} active={active && searching} onOpenInTimeline={onOpenInTimeline} />
    </div>
    {query.trim() && <details className="shrink-0 px-pad pb-2 text-xs text-redlog-text-dim"><summary>{t('workspace.searchCoverage')}</summary><p className="pt-1">{t('workspace.coverageBoundary')}</p></details>}
    {(['io', 'ai'] as const).filter(mode => visited.has(mode)).map(mode => <div key={mode} role="tabpanel"
      id={`reading-panel-${mode}`} aria-labelledby={`reading-tab-${mode}`} hidden={reading !== mode}
      className={reading === mode ? 'flex-1 min-h-0' : undefined}>
      <Suspense fallback={<div role="status" className="p-4 text-xs text-redlog-text-dim">{t('search.loading')}</div>}>
        <TranscriptView reading={mode} active={active && reading === mode} externalQuery={mode===reading ? effectiveQuery : query} sessionExport={sessions[mode] ? {kind:'session',projectId:sessions[mode]!.projectId,anchorEventId:sessions[mode]!.anchorEventId,snapshot:sessions[mode]!.snapshot} : undefined} onOpenInTimeline={onOpenInTimeline} />
      </Suspense>
    </div>)}
  </div>
}
