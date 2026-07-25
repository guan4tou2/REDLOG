import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import IPStatusCard from './components/IPStatusCard'
import TerminalPanel from './components/Terminal'
import TimelinePanel from './components/Timeline'
import EventMarker from './components/EventMarker'
import { TargetView } from './components/TargetView'
import { ScopeStatus } from './components/ScopeStatus'
import { LootPanel } from './components/LootPanel'
import { ReportExport } from './components/ReportExport'

type View = 'dashboard' | 'terminal' | 'timeline' | 'screenshots' | 'targets' | 'scope' | 'loot' | 'export'

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('terminal')
  const [showMarker, setShowMarker] = useState(false)
  const [eventCount, setEventCount] = useState(0)

  useEffect(() => {
    window.redlog.events.getCount().then(setEventCount)
    return window.redlog.events.onNew(() => {
      setEventCount((c) => c + 1)
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
        e.preventDefault()
        setShowMarker(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="h-screen flex flex-col">
      {/* Title bar */}
      <div
        className="h-10 flex items-center px-4 select-none shrink-0 border-b border-redlog-border"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-redlog-accent font-bold text-sm tracking-wider pl-16">REDLOG</span>
        <span className="text-neutral-600 text-xs ml-2">v0.1.0</span>
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
        <Sidebar active={view} onNavigate={(v) => setView(v as View)} eventCount={eventCount} />

        <div className="flex-1 min-w-0">
          {view === 'dashboard' && <DashboardView />}
          {view === 'terminal' && <TerminalPanel />}
          {view === 'timeline' && <TimelinePanel />}
          {view === 'screenshots' && <ScreenshotsView />}
          {view === 'targets' && <TargetView />}
          {view === 'scope' && <ScopeStatus />}
          {view === 'loot' && <LootPanel />}
          {view === 'export' && <ReportExport />}
        </div>
      </div>

      {showMarker && <EventMarker onClose={() => setShowMarker(false)} />}
    </div>
  )
}

function DashboardView(): JSX.Element {
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [chainLen, setChainLen] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)

  useEffect(() => {
    window.redlog.events.getCount().then(setEventCount)
    window.redlog.loot.getCount().then(setLootCount)
    window.redlog.chain.length().then(setChainLen)
    window.redlog.scope.getViolationCount().then(setScopeViolations)
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

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Status" value="Recording" color="text-green-400" />
        <StatCard label="Hotkey" value="⌘⇧M" sub="Add marker" />
      </div>

      <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mt-6">
        Engagement
      </h2>
      <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 text-neutral-500 text-sm">
        Configure in <code className="text-neutral-400">~/.redlog/config.yaml</code>
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

  useEffect(() => {
    window.redlog.events.query({ agentType: 'screenshot', limit: 50 }).then(setScreenshots)
    return window.redlog.events.onNew((event) => {
      if (event.agentType === 'screenshot') {
        setScreenshots((prev) => [event, ...prev].slice(0, 50))
      }
    })
  }, [])

  return (
    <div className="p-4 overflow-auto h-full">
      <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mb-3">
        Screenshots ({screenshots.length})
      </h2>
      {screenshots.length === 0 ? (
        <p className="text-neutral-600 text-sm">Screenshots will appear here when captured</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {screenshots.map((s) => (
            <div key={s.id} className="rounded border border-redlog-border overflow-hidden bg-redlog-surface">
              <div className="aspect-video bg-neutral-900 flex items-center justify-center text-neutral-700 text-xs">
                {(s.data.filename as string) ?? 'screenshot'}
              </div>
              <div className="px-2 py-1">
                <p className="text-[10px] text-neutral-500">
                  {new Date(s.timestamp).toLocaleTimeString()} — {s.data.trigger as string}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
