import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { usePivots } from '../lib/usePivots'
import { ipBadge } from '../lib/ip-badge'
import { SEVERITY_CLASS, ipSeverity } from '../lib/alertSeverity'

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
  const pivots = usePivots()
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

  // G-A3: a verdict whose reading has expired must not present as a live one.
  const badge = ipBadge(status)
  const safety = status.ipSafety
  // G-C1: colour comes from the shared scale; only the LABEL is verdict-specific.
  const sev = SEVERITY_CLASS[badge.severity]
  const LABEL: Record<typeof safety, string> = {
    safe: t('ip.safeIp'),
    presumed_safe: t('ip.presumedSafeIp'),
    off_profile: t('ip.offProfileIp'),
    exposed: t('ip.exposedIp'),
    unknown: t('ip.unknownIp')
  }
  // Only judged when a LAN profile exists — an unconfigured one has nothing to
  // say, and colouring it amber would imply a problem that has not been stated.
  const lanSev = status.lanSafety && status.lanSafety !== 'unknown'
    ? SEVERITY_CLASS[ipSeverity(status.lanSafety)]
    : null
  const cfg = {
    indicator: sev.dot,
    color: sev.text.replace('/80', ''),
    label: badge.reason === 'stale' ? t('ip.staleIp') : LABEL[safety]
  }

  return (
    <div className="rounded-lg bg-redlog-surface border border-redlog-border p-4 space-y-3">
      <div className="flex items-center gap-3">
        <span
          className={badge.qualified
            ? `w-3 h-3 rounded-full border-2 ${cfg.indicator.replace('bg-', 'border-')} bg-transparent`
            : `w-3 h-3 rounded-full ${cfg.indicator} ${safety === 'exposed' ? 'animate-pulse' : ''}`}
        />
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
          {/* G-A4: this value was displayed but never judged, so a laptop that
              reassociated to a guest SSID mid-engagement looked identical to one
              still on the client VLAN. It reads on the SAME severity scale as
              the external verdict — one scale, both questions. */}
          <p className={`text-lg font-mono ${lanSev ? lanSev.text.replace('/80', '') : 'text-neutral-200'}`}>
            {status.internalIP ?? '—'}
          </p>
        </div>
      </div>

      {pivots.length > 0 && (() => {
        const chain = [...pivots].sort((a, b) => a.ts - b.ts)
        const Arrow = (): JSX.Element => <span className="text-cyan-500/50 text-sm shrink-0">→</span>
        const Pill = ({ top, sub, tone }: { top: string; sub: string; tone: 'ext' | 'pivot' | 'int' }): JSX.Element => {
          const c = tone === 'ext'
            ? 'bg-neutral-800/60 border-neutral-600/50 text-neutral-200'
            : tone === 'pivot'
              ? 'bg-cyan-500/10 border-cyan-400/30 text-cyan-200'
              : 'bg-green-500/10 border-green-400/30 text-green-300'
          return (
            <span className={`inline-flex flex-col items-start px-2 py-1 rounded border ${c} shrink-0 max-w-[140px]`}>
              <span className="text-xs font-mono font-medium truncate max-w-[124px]">{top}</span>
              <span className="text-[11px] text-neutral-500 uppercase tracking-wide">{sub}</span>
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

      {badge.reason === 'stale' && (
        <p className="text-xs text-yellow-500/90 flex items-start gap-1.5">
          <span className="shrink-0">⚠</span>
          <span>{t('ip.staleHint', { n: status.consecutiveFailures ?? 0 })}</span>
        </p>
      )}

      {safety === 'off_profile' && (
        <p className="text-xs text-orange-400/90 flex items-start gap-1.5">
          <span className="shrink-0">⚠</span>
          <span>{t('ip.offProfileHint')}</span>
        </p>
      )}

      {status.lanSafety === 'off_profile' && (
        <p className="text-xs text-orange-400/90 flex items-start gap-1.5">
          <span className="shrink-0">⚠</span>
          <span>{t('ip.lanOffProfileHint')}</span>
        </p>
      )}

      {badge.reason === 'presumed' && (
        <p className="text-xs text-neutral-400 flex items-start gap-1.5">
          <span className="shrink-0">≈</span>
          <span>{t('ip.presumedHint')}</span>
        </p>
      )}

      {/* A-6: the verdict above is `exposed` and correct — the blacklist wins —
          but a red badge looks like every other red badge, so the operator
          would never learn their two lists contradict each other. */}
      {status.listConflict && (
        <p className="text-xs text-orange-400/90 flex items-start gap-1.5">
          <span className="shrink-0">⚑</span>
          <span>{t('ip.listConflictHint')}</span>
        </p>
      )}

      {badge.reason === 'settling' && (
        <p className="text-xs text-neutral-400 flex items-start gap-1.5">
          <span className="shrink-0">⋯</span>
          <span>{t('ip.settlingHint')}</span>
        </p>
      )}

      {/* Only for a genuinely unclassifiable address — a decayed verdict is also
          'unknown', but telling the operator to configure lists they already
          configured is the wrong advice for a dropped network. */}
      {safety === 'unknown' && badge.reason === null && (
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
