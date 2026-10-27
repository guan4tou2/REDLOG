import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { SearchPanel } from './SearchPanel'

const TranscriptView = lazy(() => import('./TranscriptView'))
type Reading = 'activities' | 'io' | 'ai' | 'events'
const READINGS: Reading[] = ['activities', 'io', 'ai', 'events']

/** Reading modes share a query; visited readers retain their own position. */
export default function RecordingWorkspace({ active = true, onOpenInTimeline }: {
  active?: boolean
  onOpenInTimeline?: (id: string, ts: number) => void
}): JSX.Element {
  const { t } = useI18n()
  const [reading, setReading] = useState<Reading>('activities')
  const [query, setQuery] = useState('')
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
  return <div className="h-full min-h-0 min-w-0 flex flex-col" data-testid="recording-workspace">
    <div className="px-4 pt-3 space-y-3 shrink-0">
      <input ref={field} type="search" data-testid="search-input" aria-label={t('search.placeholder')}
        value={query} onChange={e => setQuery(e.target.value)} placeholder={t('search.placeholder')}
        className="w-full min-w-0 rounded border border-redlog-border bg-redlog-elevated px-3 py-2 text-sm focus:outline-none focus:border-redlog-accent" />
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
      </div>
    </div>
    <div role="tabpanel" id="reading-panel-search" aria-labelledby={`reading-tab-${reading === 'events' ? 'events' : 'activities'}`}
      hidden={!searching} className={searching ? 'flex-1 min-h-0' : undefined}>
      <SearchPanel browse controlledQuery={query} viewMode={reading === 'events' ? 'events' : 'activities'} active={active && searching} onOpenInTimeline={onOpenInTimeline} />
    </div>
    {(['io', 'ai'] as const).filter(mode => visited.has(mode)).map(mode => <div key={mode} role="tabpanel"
      id={`reading-panel-${mode}`} aria-labelledby={`reading-tab-${mode}`} hidden={reading !== mode}
      className={reading === mode ? 'flex-1 min-h-0' : undefined}>
      <Suspense fallback={<div role="status" className="p-4 text-xs text-redlog-text-dim">{t('search.loading')}</div>}>
        <TranscriptView reading={mode} active={active && reading === mode} externalQuery={query} onOpenInTimeline={onOpenInTimeline} />
      </Suspense>
    </div>)}
  </div>
}
