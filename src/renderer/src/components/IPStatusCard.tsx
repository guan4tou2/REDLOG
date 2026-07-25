import { useEffect, useState } from 'react'

function timeAgo(ts: number): string {
  if (!ts) return '—'
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  return `${Math.floor(sec / 60)}m ago`
}

const STATUS_CONFIG = {
  connected: { indicator: 'bg-green-500', label: 'VPN Connected', color: 'text-green-400' },
  disconnected: { indicator: 'bg-red-500', label: 'No VPN — Daily IP', color: 'text-red-400' },
  unknown: { indicator: 'bg-yellow-500', label: 'Unknown IP', color: 'text-yellow-400' }
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

  const vpn = status.vpnStatus
  const cfg = STATUS_CONFIG[vpn]

  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className={`w-3 h-3 rounded-full ${cfg.indicator} ${vpn === 'disconnected' ? 'animate-pulse' : ''}`} />
        <span className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</span>
        <span className="ml-auto text-xs text-neutral-500">{timeAgo(status.lastCheck)}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-neutral-500 mb-1">External IP</p>
          <p className="text-lg font-mono text-neutral-200">{status.externalIP ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs text-neutral-500 mb-1">Internal IP</p>
          <p className="text-lg font-mono text-neutral-200">{status.internalIP ?? '—'}</p>
        </div>
      </div>

      {vpn === 'unknown' && (
        <p className="text-xs text-yellow-500">
          Set vpnIPs / dailyIPs in ~/.redlog/config.yaml to enable VPN detection
        </p>
      )}

      {status.error && (
        <p className="text-xs text-red-400 mt-2">{status.error}</p>
      )}
    </div>
  )
}
