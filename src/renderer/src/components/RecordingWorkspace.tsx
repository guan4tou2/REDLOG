import SourceSessionPicker from './SourceSessionPicker'
import type { SourceSession } from '../../../core/source-sessions'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { SearchPanel } from './SearchPanel'
import { useSharedFilter } from '../lib/FilterContext'
import { useDisplayZone } from '../lib/time'
import { agentTypeLabel } from '../lib/timelineDomain'

/** `UTC` or `Local (UTC+8)`: the zone every time on this page is drawn in. */
function zoneText(zone: 'local' | 'utc', t: (k: string) => string): string {
  if (zone === 'utc') return 'UTC'
  const off = -new Date().getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const hm = `${Math.trunc(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`
  return `${t('filter.localTime')} (UTC${sign}${hm})`
}

const TranscriptView = lazy(() => import('./TranscriptView'))
type Reading = 'activities' | 'io' | 'ai' | 'events'
const READINGS: Reading[] = ['activities', 'io', 'ai', 'events']

/** Reading modes share a query; visited readers retain their own position. */
export default function RecordingWorkspace({ active = true, onOpenInTimeline, onOpenTimeline }: {
  active?: boolean
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
  // The source choice is the shared filter's own agent type, not a second state:
  // the FilterBar's chip, every other view and this select all read one value.
  const { filter, setAgentType, knownAgentTypes } = useSharedFilter()
  const zone = useDisplayZone()
  return <div className="h-full min-h-0 min-w-0 flex flex-col" data-testid="recording-workspace">
    <div className="px-4 pt-3 space-y-3 shrink-0">
      <div>
        <h1 data-testid="activity-title" className="text-base font-medium text-redlog-text">{t('activity.pageTitle')}</h1>
        <p className="text-xs text-redlog-text-dim">{t('activity.pageHint')}</p>
      </div>
      <input ref={field} type="search" data-testid="search-input" aria-label={t('search.placeholder')}
        value={query} onChange={e => setQuery(e.target.value)} placeholder={t('search.placeholder')}
        className="w-full min-w-0 rounded border border-redlog-border bg-redlog-elevated px-3 py-2 text-sm focus:outline-none focus:border-redlog-accent" />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {searching && <select data-testid="activity-source" aria-label={t('activity.sourceLabel')} value={filter.agentType ?? ''} onChange={e => setAgentType(e.target.value || null)}
          className="rounded border border-redlog-border bg-redlog-elevated px-2 py-1 text-xs text-redlog-text-dim">
          <option value="">{t('activity.sourceAll')}</option>
          {knownAgentTypes.map(at => <option key={at} value={at}>{agentTypeLabel(at, t)}</option>)}
        </select>}
        <span data-testid="activity-zone" className="ml-auto text-redlog-text-dim">{t('activity.zone', { zone: zoneText(zone, t) })}</span>
      </div>
      <div role="tablist" aria-label={t('activity.view')} className="flex flex-wrap gap-1 border-b border-redlog-border">
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
        {onOpenTimeline && (
          <button type="button" onClick={onOpenTimeline} data-testid="workspace-open-timeline"
            className="ml-auto px-3 py-2 text-xs text-redlog-text-dim hover:text-redlog-text"
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
    <div role="tabpanel" id="reading-panel-search" aria-labelledby={`reading-tab-${reading === 'events' ? 'events' : 'activities'}`}
      hidden={!searching} className={searching ? 'flex-1 min-h-0' : undefined}>
      <SearchPanel browse controlledQuery={query} viewMode={reading === 'events' ? 'events' : 'activities'} onClearQuery={() => setQuery('')} active={active && searching} onOpenInTimeline={onOpenInTimeline} />
    </div>
    {query.trim() && <details className="shrink-0 px-4 pb-2 text-xs text-redlog-text-dim"><summary>{t('workspace.searchCoverage')}</summary><p className="pt-1">{t('workspace.coverageBoundary')}</p></details>}
    {(['io', 'ai'] as const).filter(mode => visited.has(mode)).map(mode => <div key={mode} role="tabpanel"
      id={`reading-panel-${mode}`} aria-labelledby={`reading-tab-${mode}`} hidden={reading !== mode}
      className={reading === mode ? 'flex-1 min-h-0' : undefined}>
      <Suspense fallback={<div role="status" className="p-4 text-xs text-redlog-text-dim">{t('search.loading')}</div>}>
        <TranscriptView reading={mode} active={active && reading === mode} externalQuery={mode===reading ? effectiveQuery : query} sessionExport={sessions[mode] ? {kind:'session',projectId:sessions[mode]!.projectId,anchorEventId:sessions[mode]!.anchorEventId,snapshot:sessions[mode]!.snapshot} : undefined} onOpenInTimeline={onOpenInTimeline} />
      </Suspense>
    </div>)}
  </div>
}
