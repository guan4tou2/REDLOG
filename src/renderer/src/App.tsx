import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import IPStatusCard from './components/IPStatusCard'
import TimelinePanel from './components/Timeline'
import EventMarker from './components/EventMarker'
import Settings from './components/Settings'
import ProjectPicker from './components/ProjectPicker'
import { TargetView } from './components/TargetView'
import { ScopeStatus } from './components/ScopeStatus'
import { LootPanel } from './components/LootPanel'
import { SearchPanel } from './components/SearchPanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { QuickMarksView } from './components/FindingsView'
import { ToastContainer } from './components/Toast'
import { ConfirmDialogContainer } from './components/ConfirmDialog'
import { toast } from './components/Toast'
import { useI18n } from './i18n'

type View = 'dashboard' | 'timeline' | 'screenshots' | 'targets' | 'scope' | 'loot' | 'marks' | 'settings' | 'search'

const VIEW_KEYS: View[] = ['dashboard', 'timeline', 'screenshots', 'targets', 'scope', 'loot', 'marks', 'settings']

export default function App(): JSX.Element {
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [view, setView] = useState<View>('dashboard')
  const [showMarker, setShowMarker] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.project.active().then((p) => {
      if (p) setProject(p)
    })
  }, [])

  useEffect(() => {
    return window.redlog.marker.onShortcut(() => setShowMarker(true))
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!project) return
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
        e.preventDefault()
        setShowMarker(true)
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault()
        setView('search')
        return
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key)
        if (num >= 1 && num <= VIEW_KEYS.length) {
          e.preventDefault()
          setView(VIEW_KEYS[num - 1])
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [project])

  if (!project) {
    return (
      <>
        <ProjectPicker onProjectOpen={(p) => { setProject(p); setView('dashboard') }} />
        <ToastContainer />
        <ConfirmDialogContainer />
      </>
    )
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Title bar */}
      <div
        className="h-10 flex items-center px-4 select-none shrink-0 border-b border-redlog-border bg-redlog-bg"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2 pl-16">
          <span className="text-red-500 font-bold text-[13px] tracking-[0.2em]">{t('app.title')}</span>
          <span className="text-zinc-800 text-[10px] font-mono">v0.1</span>
        </div>
        <span className="text-zinc-600 text-[11px] ml-4 font-mono">{project.name}</span>
        <div className="ml-auto flex gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => setShowMarker(true)}
            className="px-2.5 py-1 text-[10px] font-medium bg-red-500/10 text-red-400 rounded-md hover:bg-red-500/20 border border-red-500/15 transition-colors"
            title="Ctrl+Shift+M"
          >
            {t('app.mark')}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        <Sidebar active={view} onNavigate={(v) => setView(v as View)} />

        <div className="flex-1 min-w-0">
          <ErrorBoundary label={view}>
            {view === 'dashboard' && <DashboardView onNavigate={(v) => setView(v as View)} />}
            {view === 'timeline' && <TimelinePanel />}
            {view === 'screenshots' && <ScreenshotsView />}
            {view === 'targets' && <TargetView />}
            {view === 'scope' && <ScopeStatus />}
            {view === 'loot' && <LootPanel />}
            {view === 'marks' && <QuickMarksView />}
            {view === 'settings' && <Settings />}
            {view === 'search' && <SearchPanel />}
          </ErrorBoundary>
        </div>
      </div>

      <StatusBar />
      {showMarker && <EventMarker onClose={() => setShowMarker(false)} />}
      <ToastContainer />
      <ConfirmDialogContainer />
    </div>
  )
}

function DashboardView({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [chainLen, setChainLen] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [config, setConfig] = useState<Record<string, Record<string, unknown>> | null>(null)
  const [loading, setLoading] = useState(true)
  const { t } = useI18n()

  useEffect(() => {
    Promise.all([
      window.redlog.events.getCount().then(setEventCount),
      window.redlog.loot.getCount().then(setLootCount),
      window.redlog.chain.length().then(setChainLen),
      window.redlog.scope.getViolationCount().then(setScopeViolations),
      window.redlog.config.get().then((c) => setConfig(c as Record<string, Record<string, unknown>>))
    ]).then(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="p-5 space-y-5 overflow-auto h-full">
        <div className="grid grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-lg bg-redlog-surface border border-redlog-border p-4 h-20 animate-pulse">
              <div className="h-3 w-12 bg-zinc-800 rounded mb-3" />
              <div className="h-5 w-8 bg-zinc-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-5 space-y-5 overflow-auto h-full">
      <section>
        <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-[0.15em] mb-3">
          {t('dashboard.networkStatus')}
        </h2>
        <IPStatusCard />
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-[0.15em]">
            {t('dashboard.sessionStats')}
          </h2>
          <button
            onClick={async () => {
              const path = await window.redlog.data.exportJson()
              if (path) toast(t('toast.exported'), 'success')
              else toast(t('toast.exportFailed'), 'error')
            }}
            className="px-2.5 py-1 text-[10px] bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 hover:text-zinc-300 transition-colors"
          >
            {t('dashboard.exportData')}
          </button>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <StatCard label={t('dashboard.events')} value={String(eventCount)} />
          <StatCard label={t('dashboard.chain')} value={String(chainLen)} sub={t('dashboard.evidenceEntries')} />
          <StatCard label={t('dashboard.loot')} value={String(lootCount)} color={lootCount > 0 ? 'text-red-400' : undefined} accent={lootCount > 0 ? 'red' : undefined} />
          <StatCard
            label={t('dashboard.scope')}
            value={scopeViolations > 0 ? String(scopeViolations) : t('dashboard.scopeOk')}
            color={scopeViolations > 0 ? 'text-red-400' : 'text-emerald-400'}
            accent={scopeViolations > 0 ? 'red' : 'green'}
          />
        </div>
      </section>

      {config && (
        <section>
          <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-[0.15em] mb-3">
            {t('dashboard.engagement')}
          </h2>
          <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card">
            <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
              <div>
                <span className="text-zinc-500 text-xs">{t('dashboard.id')}</span>
                <p className="text-zinc-200 font-mono text-sm mt-0.5">{config.engagement?.id as string}</p>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">{t('dashboard.name')}</span>
                <p className="text-zinc-200 text-sm mt-0.5">{config.engagement?.name as string}</p>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">{t('dashboard.operator')}</span>
                <p className="text-zinc-200 text-sm mt-0.5">{config.operator?.name as string}</p>
              </div>
              <div>
                <span className="text-zinc-500 text-xs">{t('dashboard.scopeLabel')}</span>
                <p className="text-zinc-200 text-sm mt-0.5">
                  {t('dashboard.targets', { count: (config.scope?.targets as string[])?.length || 0, mode: config.scope?.enforcement as string })}
                </p>
              </div>
            </div>
            <button
              onClick={() => onNavigate('settings')}
              className="mt-3 text-[10px] text-red-400/80 hover:text-red-300 transition-colors"
            >
              {t('dashboard.editSettings')}
            </button>
          </div>
        </section>
      )}

      <section>
        <h2 className="text-[11px] font-semibold text-zinc-500 uppercase tracking-[0.15em] mb-3">
          {t('dashboard.shortcuts')}
        </h2>
        <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card">
          <div className="grid grid-cols-2 gap-2.5 text-sm">
            {[
              ['⌘1', t('sidebar.dashboard')],
              ['⌘2', t('sidebar.timeline')],
              ['⌘3', t('sidebar.screens')],
              ['⌘4', t('sidebar.targets')],
              ['⌘5', t('sidebar.scope')],
              ['⌘6', t('sidebar.loot')],
              ['⌘7', t('sidebar.marks')],
              ['⌘8', t('sidebar.settings')],
              ['⌘⇧M', t('dashboard.addMarker')]
            ].map(([key, label]) => (
              <div key={key} className="flex items-center gap-2.5">
                <kbd className="bg-zinc-800/80 text-zinc-400 px-2 py-0.5 rounded text-xs font-mono border border-zinc-700/50">{key}</kbd>
                <span className="text-zinc-500 text-xs">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function StatCard({ label, value, color, sub, accent }: {
  label: string; value: string; color?: string; sub?: string; accent?: 'red' | 'green'
}): JSX.Element {
  const accentColor = accent === 'red' ? 'bg-red-500' : accent === 'green' ? 'bg-emerald-500' : 'bg-zinc-700'
  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card transition-shadow hover:shadow-card-hover relative overflow-hidden">
      <span className={`absolute top-0 left-0 right-0 h-[2px] ${accentColor}`} />
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-medium">{label}</p>
      <p className={`text-lg font-mono mt-1.5 font-semibold tabular-nums ${color ?? 'text-zinc-200'}`}>{value}</p>
      {sub && <p className="text-[10px] text-zinc-600 mt-0.5">{sub}</p>}
    </div>
  )
}

function ScreenshotsView(): JSX.Element {
  const [screenshots, setScreenshots] = useState<RedLogEvent[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.events.query({ agentType: 'screenshot', limit: 50 }).then((s) => {
      setScreenshots(s)
      setLoading(false)
    })
    return window.redlog.events.onNew((event) => {
      if (event.agentType === 'screenshot') {
        setScreenshots((prev) => [event, ...prev].slice(0, 50))
      }
    })
  }, [])

  useEffect(() => {
    screenshots.forEach((s) => {
      if (thumbs[s.id]) return
      const filePath = s.data.filePath as string | undefined
      if (!filePath) return
      window.redlog.screenshot.read(filePath).then((dataUri) => {
        if (dataUri) setThumbs((prev) => ({ ...prev, [s.id]: dataUri }))
      })
    })
  }, [screenshots, thumbs])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-red-500 rounded-full animate-spin-slow" />
      </div>
    )
  }

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-neutral-400 uppercase tracking-wider">
          {t('screenshots.title', { count: screenshots.length })}
        </h2>
        <button
          onClick={() => window.redlog.screenshot.capture()}
          className="px-2 py-1 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700"
        >
          {t('screenshots.captureNow')}
        </button>
      </div>
      {screenshots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
            <span className="text-2xl text-zinc-700">◻</span>
          </div>
          <p className="text-zinc-500 text-sm">{t('screenshots.empty')}</p>
          <p className="text-zinc-700 text-xs">{t('screenshots.emptyDesc')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {screenshots.map((s) => (
            <div
              key={s.id}
              className="rounded border border-redlog-border overflow-hidden bg-redlog-surface cursor-pointer hover:border-zinc-600 transition-colors"
              onClick={() => setExpanded(expanded === s.id ? null : s.id)}
            >
              <div className="aspect-video bg-neutral-900 flex items-center justify-center overflow-hidden">
                {thumbs[s.id] ? (
                  <img src={thumbs[s.id]} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-neutral-700 text-xs">{(s.data.filename as string) ?? '...'}</span>
                )}
              </div>
              <div className="px-2 py-1">
                <p className="text-[10px] text-neutral-500">
                  {new Date(s.timestamp).toLocaleTimeString()} — {s.data.trigger as string}
                  {s.data.diffPercent !== undefined && (
                    <span className="ml-1 text-zinc-600">({t('screenshots.diff', { pct: (s.data.diffPercent as number).toFixed(1) })})</span>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      {expanded && thumbs[expanded] && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center cursor-pointer"
          onClick={() => setExpanded(null)}
        >
          <img src={thumbs[expanded]} alt="" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" />
        </div>
      )}
    </div>
  )
}
