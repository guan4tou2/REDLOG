import IPStatusCard from './components/IPStatusCard'

export default function App(): JSX.Element {
  return (
    <div className="h-screen flex flex-col">
      {/* Title bar drag region */}
      <div
        className="h-10 flex items-center px-4 select-none shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-redlog-accent font-bold text-sm tracking-wider">REDLOG</span>
        <span className="text-neutral-600 text-xs ml-2">v0.1.0</span>
      </div>

      {/* Dashboard */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider">
          Network Status
        </h2>
        <IPStatusCard />

        <h2 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mt-6">
          Engagement
        </h2>
        <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 text-neutral-500 text-sm">
          No active engagement — configure in <code className="text-neutral-400">~/.redlog/config.yaml</code>
        </div>
      </div>
    </div>
  )
}
