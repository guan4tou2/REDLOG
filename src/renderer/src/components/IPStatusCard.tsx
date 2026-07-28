import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

function useTimeAgo(): (ts: number) => string {
  const { t } = useI18n()
  return (ts: number): string => {
    if (!ts) return '—'
    const sec = Math.floor((Date.now() - ts) / 1000)
    if (sec < 5) return t('time.justNow')
    if (sec < 60) return t('time.sAgo', { s: sec })
    return t('time.mAgo', { m: Math.floor(sec / 60) })
  }
}

export default function IPStatusCard(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const [, setTick] = useState(0)
  const { t } = useI18n()
  const timeAgo = useTimeAgo()

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
        <p className="text-neutral-500">{t('ip.checking')}</p>
      </div>
    )
  }

  const safety = status.ipSafety
  const STATUS_CONFIG = {
    safe: { indicator: 'bg-green-500', label: t('ip.safeIp'), color: 'text-green-400' },
    exposed: { indicator: 'bg-red-500', label: t('ip.exposedIp'), color: 'text-red-400' },
    unknown: { indicator: 'bg-yellow-500', label: t('ip.unknownIp'), color: 'text-yellow-400' }
  }
  const cfg = STATUS_CONFIG[safety]

  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className={`w-3 h-3 rounded-full ${cfg.indicator} ${safety === 'exposed' ? 'animate-pulse' : ''}`} />
        <span className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</span>
        <span className="ml-auto text-xs text-neutral-500">{timeAgo(status.lastCheck)}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-neutral-500 mb-1">{t('ip.externalIp')}</p>
          <p className="text-lg font-mono text-neutral-200">{status.externalIP ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs text-neutral-500 mb-1">{t('ip.internalIp')}</p>
          <p className="text-lg font-mono text-neutral-200">{status.internalIP ?? '—'}</p>
        </div>
      </div>

      {safety === 'unknown' && (
        <p className="text-xs text-yellow-500">
          {t('ip.safetyHint')}
        </p>
      )}

      {status.error && (
        <p className="text-xs text-red-400 mt-2">{status.error}</p>
      )}
    </div>
  )
}
