import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { usePivots } from '../lib/usePivots'
import { formatFreshness } from '../lib/time'

export default function IPStatusCard(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const pivots = usePivots()
  const [, setTick] = useState(0)
  const { t } = useI18n()

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
        <p className="text-redlog-text-dim">{t('ip.checking')}</p>
      </div>
    )
  }

  const safety = status.ipSafety
  const STATUS_CONFIG = {
    safe: { indicator: 'bg-green-500', label: t('ip.safeIp'), color: 'text-green-400' },
    exposed: { indicator: 'bg-redlog-danger', label: t('ip.exposedIp'), color: 'text-red-400' },
    unknown: { indicator: 'bg-yellow-500', label: t('ip.unknownIp'), color: 'text-yellow-400' }
  }
  const cfg = STATUS_CONFIG[safety]

  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span className={`w-3 h-3 rounded-full ${cfg.indicator} ${safety === 'exposed' ? 'animate-pulse' : ''}`} />
        <span className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</span>
        <span className="ml-auto text-xs text-redlog-text-dim">{status.lastCheck ? formatFreshness(status.lastCheck, t) : '—'}</span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-redlog-text-dim mb-1">{t('ip.externalIp')}</p>
          <p className="text-lg font-mono text-redlog-text">{status.externalIP ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs text-redlog-text-dim mb-1">{t('ip.internalIp')}</p>
          <p className="text-lg font-mono text-redlog-text">{status.internalIP ?? '—'}</p>
        </div>
      </div>

      {pivots.length > 0 && (() => {
        const chain = [...pivots].sort((a, b) => a.ts - b.ts)
        const Arrow = (): JSX.Element => <span className="text-cyan-500/50 text-sm shrink-0">→</span>
        const Pill = ({ top, sub, tone }: { top: string; sub: string; tone: 'ext' | 'pivot' | 'int' }): JSX.Element => {
          const c = tone === 'ext'
            ? 'bg-redlog-elevated/60 border-redlog-border/50 text-redlog-text'
            : tone === 'pivot'
              ? 'bg-cyan-500/10 border-cyan-400/30 text-cyan-200'
              : 'bg-green-500/10 border-green-400/30 text-green-300'
          return (
            <span className={`inline-flex flex-col items-start px-2 py-1 rounded border ${c} shrink-0 max-w-[140px]`}>
              <span title={top} className="text-xs font-mono font-medium truncate max-w-[124px]">{top}</span>
              <span className="text-xs text-redlog-text-dim uppercase tracking-wide">{sub}</span>
            </span>
          )
        }
        return (
          <div className="pt-2 border-t border-redlog-border">
            <p className="text-xs text-cyan-400/80 font-medium uppercase tracking-wider mb-2">⇄ {t('overlay.topology')}</p>
            {/* our host outward: internal → external egress → pivot hops */}
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill top={status.internalIP ?? t('overlay.internalNet')} sub={t('overlay.internalNet')} tone="int" />
              <Arrow />
              <Pill top={status.externalIP ?? '—'} sub={t('ip.externalIp')} tone="ext" />
              {chain.map((p) => (
                <span key={p.via + p.ts} className="flex items-center gap-1.5">
                  <Arrow />
                  <Pill top={p.route ? `${p.via} (${p.route})` : p.via} sub={p.tool} tone="pivot" />
                </span>
              ))}
            </div>
          </div>
        )
      })()}

      {safety === 'exposed' && (
        <p className="text-xs text-red-400/90 flex items-start gap-1.5">
          <span className="shrink-0">⚠</span>
          <span>{t('ip.exposedHint')}</span>
        </p>
      )}

      {safety === 'unknown' && (
        <p className="text-xs text-yellow-500/90 flex items-start gap-1.5">
          <span className="shrink-0">ⓘ</span>
          <span>{t('ip.safetyHint')}</span>
        </p>
      )}

      {status.error && (
        <p className="text-xs text-red-400 mt-2">{status.error}</p>
      )}
    </div>
  )
}
