import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

export default function StatusBar(): JSX.Element {
  const [ipStatus, setIpStatus] = useState<IPStatus | null>(null)
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [uptime, setUptime] = useState(0)
  const [stamped, setStamped] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    const start = Date.now()
    window.redlog.ip.getStatus().then(setIpStatus)
    window.redlog.events.getCount().then(setEventCount)
    window.redlog.loot.getCount().then(setLootCount)
    window.redlog.scope.getViolationCount().then(setScopeViolations)

    const unsubIp = window.redlog.ip.onStatus(setIpStatus)
    const unsubEvent = window.redlog.events.onNew(() => {
      setEventCount((c) => c + 1)
      window.redlog.loot.getCount().then(setLootCount)
      window.redlog.scope.getViolationCount().then(setScopeViolations)
    })
    const timer = setInterval(() => setUptime(Math.floor((Date.now() - start) / 1000)), 1000)

    return () => { unsubIp(); unsubEvent(); clearInterval(timer) }
  }, [])

  const vpn = ipStatus?.vpnStatus ?? 'unknown'
  const vpnDot = vpn === 'connected' ? 'bg-green-500' : vpn === 'disconnected' ? 'bg-red-500' : 'bg-yellow-500'
  const vpnLabel = vpn === 'connected' ? t('statusBar.vpn') : vpn === 'disconnected' ? t('statusBar.noVpn') : t('statusBar.ipUnknown')

  const hours = Math.floor(uptime / 3600)
  const mins = Math.floor((uptime % 3600) / 60)
  const secs = uptime % 60
  const uptimeStr = hours > 0
    ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${mins}:${String(secs).padStart(2, '0')}`

  return (
    <div className="h-6 bg-zinc-950 border-t border-redlog-border flex items-center px-3 gap-4 text-[10px] font-mono shrink-0 select-none">
      {/* Recording indicator */}
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
        <span className="text-red-400">{t('statusBar.rec')}</span>
        <span className="text-zinc-600">{uptimeStr}</span>
      </div>

      <span className="text-zinc-800">│</span>

      {/* VPN */}
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${vpnDot}`} />
        <span className={vpn === 'connected' ? 'text-green-400' : vpn === 'disconnected' ? 'text-red-400' : 'text-yellow-400'}>
          {vpnLabel}
        </span>
        {ipStatus?.externalIP && (
          <span className="text-zinc-500">{ipStatus.externalIP}</span>
        )}
      </div>

      <span className="text-zinc-800">│</span>

      {/* Scope */}
      <div className="flex items-center gap-1.5">
        {scopeViolations > 0 ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            <span className="text-red-400">{t('statusBar.scopeViolations', { count: scopeViolations })}</span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            <span className="text-green-400">{t('statusBar.scopeOk')}</span>
          </>
        )}
      </div>

      <span className="text-zinc-800">│</span>

      {/* Loot */}
      <div className="flex items-center gap-1.5">
        <span className={`text-xs ${lootCount > 0 ? 'text-yellow-400' : 'text-zinc-600'}`}>◆</span>
        <span className={lootCount > 0 ? 'text-yellow-400' : 'text-zinc-600'}>
          {t('statusBar.loot', { count: lootCount })}
        </span>
      </div>

      {/* Right side */}
      <div className="ml-auto flex items-center gap-3">
        <span className="text-zinc-500">{t('statusBar.events', { count: eventCount })}</span>
        <button
          onClick={async () => {
            const ts = new Date().toLocaleTimeString()
            await window.redlog.quickmarks.create({ title: `Timestamp ${ts}` })
            setStamped(true)
            setTimeout(() => setStamped(false), 1500)
          }}
          className={`transition-colors ${stamped ? 'text-green-400' : 'text-zinc-500 hover:text-red-400'}`}
          title={t('statusBar.timestampTitle')}
        >
          {stamped ? '✓' : '⏱'}
        </button>
        <button
          onClick={() => window.redlog.overlay.toggle()}
          className="text-zinc-600 hover:text-zinc-400 transition-colors"
          title={t('statusBar.toggleOverlay')}
        >
          IP▪
        </button>
      </div>
    </div>
  )
}
