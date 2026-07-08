import { useEffect, useState } from 'react'

function timeAgo(ts: number): string {
  if (!ts) return '—'
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  return `${Math.floor(sec / 60)}m ago`
}

export default function IPStatusCard(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    window.redlog.ip.getStatus().then(setStatus)
    const unsub = window.redlog.ip.onStatus(setStatus)
    const timer = setInterval(() => setTick((t) => t + 1), 1000)
    return () => {
      unsub()
      clearInterval(timer)
    }
  }, [])

  if (!status) {
    return (
      <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4">
        <p className="text-neutral-500">Checking IP...</p>
      </div>
    )
  }

  const safe = status.isAllowed
  const indicator = safe ? 'bg-green-500' : 'bg-red-500'
  const label = safe ? 'VPN OK' : 'IP MISMATCH'

  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className={`w-3 h-3 rounded-full ${indicator} ${safe ? '' : 'animate-pulse'}`} />
        <span className={`text-sm font-semibold ${safe ? 'text-green-400' : 'text-red-400'}`}>
          {label}
        </span>
        <span className="ml-auto text-xs text-neutral-500">{timeAgo(status.lastCheck)}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-neutral-500 mb-1">External IP</p>
          <p className="text-lg font-mono">{status.externalIP ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs text-neutral-500 mb-1">Internal IP</p>
          <p className="text-lg font-mono">{status.internalIP ?? '—'}</p>
        </div>
      </div>

      {status.error && (
        <p className="text-xs text-red-400 mt-2">{status.error}</p>
      )}
    </div>
  )
}
