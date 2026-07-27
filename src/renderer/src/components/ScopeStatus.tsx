import { useState, useEffect } from 'react'

export function ScopeStatus(): JSX.Element {
  const [violations, setViolations] = useState<Array<{ target: string; command: string; timestamp: number }>>([])
  const [configured, setConfigured] = useState(false)
  const [chainLen, setChainLen] = useState(0)

  useEffect(() => {
    window.redlog.scope.isConfigured().then(setConfigured)
    window.redlog.scope.getViolations().then(setViolations)
    window.redlog.chain.length().then(setChainLen)

    const unsub = window.redlog.events.onNew((event) => {
      if (event.agentType === 'system' && (event.data as Record<string, unknown>)?.subtype === 'scope_violation') {
        window.redlog.scope.getViolations().then(setViolations)
      }
      window.redlog.chain.length().then(setChainLen)
    })
    return unsub
  }, [])

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold text-white">Scope & Evidence</h2>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-zinc-300 text-sm font-medium">Scope Monitor</span>
          {configured ? (
            <span className="text-green-400 text-xs bg-green-400/10 px-2 py-0.5 rounded">ACTIVE</span>
          ) : (
            <span className="text-zinc-500 text-xs bg-zinc-800 px-2 py-0.5 rounded">NOT SET</span>
          )}
        </div>
        {configured && violations.length === 0 && (
          <p className="text-green-400 text-xs">All commands within scope</p>
        )}
        {violations.length > 0 && (
          <div className="text-red-400 text-sm">
            {violations.length} scope violation{violations.length > 1 ? 's' : ''} detected
          </div>
        )}
        {!configured && (
          <p className="text-zinc-500 text-xs">
            Add scope targets in Settings → Scope tab
          </p>
        )}
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
        <div className="flex items-center justify-between">
          <span className="text-zinc-300 text-sm font-medium">Evidence Log</span>
          <span className="text-zinc-500 text-xs">{chainLen} entries</span>
        </div>
      </div>

      {violations.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm text-zinc-400">Recent Violations</h3>
          {violations.slice(0, 10).map((v, i) => (
            <div key={i} className="bg-red-900/20 border border-red-800/30 rounded p-2">
              <div className="text-red-300 text-xs font-mono">{v.target}</div>
              <div className="text-zinc-500 text-xs truncate">{v.command}</div>
              <div className="text-zinc-600 text-xs">{new Date(v.timestamp).toLocaleTimeString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
