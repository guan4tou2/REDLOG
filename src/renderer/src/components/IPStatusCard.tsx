import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { usePivotRead, type ActivePivot } from '../lib/usePivots'
import { formatFreshness } from '../lib/time'
import { Button } from './Button'
import { useTick } from '../lib/useTick'

/** Relay nodes RedLog has seen in commands. Listed, not drawn as a route: a
 *  detected node says nothing about which node forwards to which, nor that the
 *  channel is up now, so no arrows and no health. Independent of the IP read. */
function PivotNodes({ read }: { read: ReturnType<typeof usePivotRead> }): JSX.Element | null {
  const { t } = useI18n()
  if (read.status === 'loading') return null
  if (read.status === 'error') {
    return <div data-testid="pivot-error" className="pt-2 border-t border-redlog-border flex items-center gap-3 text-xs text-redlog-warn">
      <span>{read.pivots.length ? t('pivot.readFailedStale', { count: read.pivots.length }) : t('pivot.readFailed')}</span>
      <Button size="compact" onClick={read.retry}>{t('common.retry')}</Button>
    </div>
  }
  if (read.pivots.length === 0) return null
  const nodes: ActivePivot[] = read.pivots
  return <div data-testid="pivot-nodes" className="pt-2 border-t border-redlog-border space-y-1.5">
    <p className="text-xs text-redlog-text-dim">{t('pivot.detected', { count: nodes.length })}</p>
    <ul className="space-y-1">
      {nodes.map((p) => <li key={p.via + p.tool + p.ts} data-testid="pivot-node" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-redlog-border bg-redlog-elevated/40 px-2 py-1 text-xs">
        <span className="font-mono text-redlog-text-dim">{p.tool}</span>
        <span className="font-mono text-redlog-text [overflow-wrap:anywhere]">{p.via}</span>
        {p.route && <span className="font-mono text-redlog-text-dim [overflow-wrap:anywhere]">{t('pivot.route', { route: p.route })}</span>}
        <span className="ml-auto text-redlog-text-faint">{t('pivot.lastSeen', { when: formatFreshness(p.ts, t) })}</span>
      </li>)}
    </ul>
    <p className="text-xs text-redlog-text-faint">{t('pivot.unverified')}</p>
  </div>
}

export default function IPStatusCard(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const pivotRead = usePivotRead()
  const [failed, setFailed] = useState(false)
  useTick()
  const { t } = useI18n()

  useEffect(() => {
    window.redlog.ip.getStatus().then(setStatus).catch(() => setFailed(true))
    const unsub = window.redlog.ip.onStatus(setStatus)
    return () => unsub()
  }, [])

  if (!status) {
    return (
      <div data-testid="ip-status-card" className="rounded-lg bg-redlog-surface border border-redlog-border p-4 space-y-3">
        <p className={failed ? 'text-redlog-warn' : 'text-redlog-text-dim'}>{failed ? t('ip.readFailed') : t('ip.checking')}</p>
        <PivotNodes read={pivotRead} />
      </div>
    )
  }

  const safety = status.ipSafety
  const STATUS_CONFIG = {
    safe: { indicator: 'bg-green-500', label: t('ip.safeIp'), color: 'text-green-400', chip: 'border-green-500/40 bg-green-500/10' },
    exposed: { indicator: 'bg-redlog-danger', label: t('ip.exposedIp'), color: 'text-red-400', chip: 'border-redlog-danger/50 bg-redlog-danger/10' },
    unknown: { indicator: 'bg-yellow-500', label: t('ip.unknownIp'), color: 'text-yellow-400', chip: 'border-yellow-500/40 bg-yellow-500/10' }
  }
  const cfg = STATUS_CONFIG[safety]

  return (
    <div data-testid="ip-status-card" className="rounded-lg bg-redlog-surface border border-redlog-border p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-redlog-text">{t('ip.cardTitle')}</span>
        <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-mono ${cfg.chip} ${cfg.color}`}>
          <span className={`w-2 h-2 rounded-full ${cfg.indicator} ${safety === 'exposed' ? 'animate-pulse' : ''}`} />
          {cfg.label}
        </span>
        <span className="ml-auto text-xs font-mono text-redlog-text-dim">{status.lastCheck ? formatFreshness(status.lastCheck, t) : '—'}</span>
      </div>

      <dl className="space-y-2 text-sm">
        <div className="flex items-center justify-between gap-4">
          <dt className="text-redlog-text-dim">{t('ip.externalIp')}</dt>
          <dd className="font-mono text-redlog-text [overflow-wrap:anywhere]">{status.externalIP ?? '—'}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-redlog-text-dim">{t('ip.internalIp')}</dt>
          <dd className="font-mono text-redlog-text [overflow-wrap:anywhere]">{status.internalIP ?? '—'}</dd>
        </div>
      </dl>

      <PivotNodes read={pivotRead} />

      {safety === 'exposed' && (
        <p className="text-xs text-red-400/90 flex items-start gap-1.5">
          <span className="shrink-0">⚠</span>
          <span>{t('ip.exposedHint')}</span>
        </p>
      )}

      {safety === 'unknown' && (
        <p className="text-xs text-yellow-500/90 flex items-start gap-1.5">
          <span className="shrink-0">ⓘ</span>
          <span>{t('ip.safetyHint', { page: t('settings.pageNetwork') })}</span>
        </p>
      )}

      {status.error && (
        <p className="text-xs text-red-400 mt-2">{status.error}</p>
      )}
    </div>
  )
}
