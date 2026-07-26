import { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import IPStatusCard from './components/IPStatusCard'
import TerminalPanel from './components/Terminal'
import TimelinePanel from './components/Timeline'
import EventMarker from './components/EventMarker'
import Settings from './components/Settings'
import ProjectPicker from './components/ProjectPicker'
import { TargetView } from './components/TargetView'
import { ScopeStatus } from './components/ScopeStatus'
import { LootPanel } from './components/LootPanel'
import { ReportExport } from './components/ReportExport'
import { SearchPanel } from './components/SearchPanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FindingsView } from './components/FindingsView'

type View = 'dashboard' | 'terminal' | 'timeline' | 'screenshots' | 'targets' | 'scope' | 'loot' | 'findings' | 'export' | 'settings' | 'search'

const VIEW_KEYS: View[] = ['dashboard', 'terminal', 'timeline', 'screenshots', 'targets', 'scope', 'loot', 'findings', 'export', 'settings']

export default function App(): JSX.Element {
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [view, setView] = useState<View>('terminal')
  const [showMarker, setShowMarker] = useState(false)

  useEffect(() => {
    window.redlog.project.active().then((p) => {
      if (p) setProject(p)
    })
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
    return <ProjectPicker onProjectOpen={(p) => { setProject(p); setView('terminal') }} />
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Title bar */}
      <div
        className="h-10 flex items-center px-4 select-none shrink-0 border-b border-redlog-border"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-redlog-accent font-bold text-sm tracking-wider pl-16">REDLOG</span>
        <span className="text-neutral-600 text-xs ml-2">v0.1.0</span>
        <span className="text-zinc-500 text-xs ml-3 font-mono">{project.name}</span>
        <div className="ml-auto flex gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => setShowMarker(true)}
            className="px-2 py-1 text-[10px] bg-redlog-accent/20 text-redlog-accent rounded hover:bg-redlog-accent/30"
            title="Ctrl+Shift+M"
          >
            + Mark
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        <Sidebar active={view} onNavigate={(v) => setView(v as View)} />

        <div className="flex-1 min-w-0">
          <ErrorBoundary label={view}>
            {view === 'dashboard' && <DashboardView onNavigate={(v) => setView(v as View)} />}
            {view === 'terminal' && <SplitTerminal />}
            {view === 'timeline' && <TimelinePanel />}
            {view === 'screenshots' && <ScreenshotsView />}
            {view === 'targets' && <TargetView />}
            {view === 'scope' && <ScopeStatus />}
            {view === 'loot' && <LootPanel />}
            {view === 'findings' && <FindingsView />}
            {view === 'export' && <ReportExport />}
            {view === 'settings' && <Settings />}
            {view === 'search' && <SearchPanel />}
          </ErrorBoundary>
        </div>
      </div>

      <StatusBar />
      {showMarker && <EventMarker onClose={() => setShowMarker(false)} />}
    </div>
  )
}

function SplitTerminal(): JSX.Element {
  const [splitHeight, setSplitHeight] = useState(200)
  const [showTimeline, setShowTimeline] = useState(true)
  const [dragging, setDragging] = useState(false)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    const startY = e.clientY
    const startH = splitHeight

    const onMove = (ev: MouseEvent): void => {
      const container = document.getElementById('split-container')
      if (!container) return
      const containerH = container.getBoundingClientRect().height
      const newH = startH - (ev.clientY - startY)
      setSplitHeight(Math.max(100, Math.min(containerH - 200, newH)))
    }
    const onUp = (): void => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [splitHeight])

  return (
    <div id="split-container" className="flex flex-col h-full">
      <div className={`flex-1 min-h-0 ${showTimeline ? '' : 'h-full'}`}>
        <TerminalPanel />
      </div>
      {showTimeline && (
        <>
          <div
            onMouseDown={onMouseDown}
            className={`h-1 shrink-0 cursor-row-resize flex items-center justify-center group ${
              dragging ? 'bg-red-500/30' : 'bg-zinc-800 hover:bg-zinc-700'
            }`}
          >
            <div className="w-8 h-0.5 bg-zinc-600 rounded group-hover:bg-zinc-400" />
          </div>
          <div style={{ height: splitHeight }} className="shrink-0 overflow-hidden">
            <TimelinePanel />
          </div>
        </>
      )}
      <div className="h-6 shrink-0 flex items-center px-2 bg-zinc-950 border-t border-zinc-800">
        <button
          onClick={() => setShowTimeline(!showTimeline)}
          className="text-[10px] text-zinc-500 hover:text-zinc-300"
        >
          {showTimeline ? '▾ Hide Timeline' : '▸ Show Timeline'}
        </button>
      </div>
    </div>
  )
}

function DashboardView({ onNavigate }: { onNavigate: (v: string) => void }): JSX.Element {
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [chainLen, setChainLen] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [config, setConfig] = useState<Record<string, Record<string, unknown>> | null>(null)

  useEffect(() => {
    window.redlog.events.getCount().then(setEventCount)
    window.redlog.loot.getCount().then(setLootCount)
    window.redlog.chain.length().then(setChainLen)
    window.redlog.scope.getViolationCount().then(setScopeViolations)
    window.redlog.config.get().then((c) => setConfig(c as Record<string, Record<string, unknown>>))
  }, [])

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider">
        Network Status
      </h2>
      <IPStatusCard />

      <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mt-6">
        Session Stats
      </h2>
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Events" value={String(eventCount)} />
        <StatCard label="Chain" value={String(chainLen)} sub="evidence entries" />
        <StatCard label="Loot" value={String(lootCount)} color={lootCount > 0 ? 'text-red-400' : undefined} />
        <StatCard
          label="Scope"
          value={scopeViolations > 0 ? String(scopeViolations) : 'OK'}
          color={scopeViolations > 0 ? 'text-red-400' : 'text-green-400'}
        />
      </div>

      {config && (
        <>
          <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mt-6">
            Engagement
          </h2>
          <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div>
                <span className="text-zinc-500">ID:</span>{' '}
                <span className="text-zinc-200 font-mono">{config.engagement?.id as string}</span>
              </div>
              <div>
                <span className="text-zinc-500">Name:</span>{' '}
                <span className="text-zinc-200">{config.engagement?.name as string}</span>
              </div>
              <div>
                <span className="text-zinc-500">Operator:</span>{' '}
                <span className="text-zinc-200">{config.operator?.name as string}</span>
              </div>
              <div>
                <span className="text-zinc-500">Scope:</span>{' '}
                <span className="text-zinc-200">
                  {(config.scope?.targets as string[])?.length || 0} targets,{' '}
                  enforcement: {config.scope?.enforcement as string}
                </span>
              </div>
            </div>
            <button
              onClick={() => onNavigate('settings')}
              className="mt-3 text-[10px] text-red-400 hover:text-red-300"
            >
              Edit in Settings →
            </button>
          </div>
        </>
      )}

      <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mt-6">
        Keyboard Shortcuts
      </h2>
      <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4">
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            ['⌘1', 'Dashboard'],
            ['⌘2', 'Terminal'],
            ['⌘3', 'Timeline'],
            ['⌘4', 'Screenshots'],
            ['⌘5', 'Targets'],
            ['⌘6', 'Scope'],
            ['⌘7', 'Loot'],
            ['⌘8', 'Export'],
            ['⌘9', 'Settings'],
            ['⌘⇧M', 'Add Marker']
          ].map(([key, label]) => (
            <div key={key} className="flex items-center gap-2">
              <kbd className="bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded text-[10px] font-mono">{key}</kbd>
              <span className="text-zinc-500">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, color, sub }: {
  label: string; value: string; color?: string; sub?: string
}): JSX.Element {
  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className={`text-lg font-mono mt-1 ${color ?? 'text-neutral-200'}`}>{value}</p>
      {sub && <p className="text-[10px] text-neutral-600 mt-0.5">{sub}</p>}
    </div>
  )
}

function ScreenshotsView(): JSX.Element {
  const [screenshots, setScreenshots] = useState<RedLogEvent[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    window.redlog.events.query({ agentType: 'screenshot', limit: 50 }).then(setScreenshots)
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

  return (
    <div className="p-4 overflow-auto h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider">
          Screenshots ({screenshots.length})
        </h2>
        <button
          onClick={() => window.redlog.screenshot.capture()}
          className="px-2 py-1 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700"
        >
          Capture Now
        </button>
      </div>
      {screenshots.length === 0 ? (
        <p className="text-neutral-600 text-sm">Screenshots will appear here when captured</p>
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
                    <span className="ml-1 text-zinc-600">({(s.data.diffPercent as number).toFixed(1)}% diff)</span>
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
