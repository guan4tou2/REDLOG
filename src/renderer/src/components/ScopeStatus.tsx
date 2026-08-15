import { useState, useEffect } from 'react'
import { SEVERITY_CLASS, scopeSeverity, worstSeverity } from '../lib/alertSeverity'
import { useI18n } from '../i18n'
import { LoadingSpinner } from './Feedback'
import { ICON } from '../lib/icons'
import { toast } from './Toast'

export function ScopeStatus({ onOpenInTimeline }: { onOpenInTimeline?: (ts: number) => void } = {}): JSX.Element {
  const [violations, setViolations] = useState<Array<{
    target: string
    command: string
    timestamp: number
    reason: 'excluded_target' | 'adjacent_subnet' | 'adjacent_domain' | 'unrelated'
    authority: 'fact' | 'inferred'
  }>>([])
  const [configured, setConfigured] = useState(false)
  // G-D1: the denominator. "3 violations" alone cannot tell a client 3-out-of-250
  // from 3-out-of-5, and RedLog's deliverable is "provably stayed in scope".
  const [adherence, setAdherence] = useState<Awaited<ReturnType<NonNullable<typeof window.redlog.scope.adherenceSummary>>>>(null)
  const [chainLen, setChainLen] = useState(0)
  const [loading, setLoading] = useState(true)
  const { t } = useI18n()

  useEffect(() => {
    Promise.all([
      window.redlog.scope.isConfigured().then(setConfigured),
      window.redlog.scope.getViolations().then(setViolations),
      window.redlog.scope.adherenceSummary?.().then(setAdherence).catch(() => {}),
      window.redlog.chain.length().then(setChainLen)
    ]).then(() => setLoading(false))

    const unsub = window.redlog.events.onNew((event) => {
      if (event.agentType === 'system' && (event.data as Record<string, unknown>)?.subtype === 'scope_violation') {
        window.redlog.scope.getViolations().then(setViolations)
        window.redlog.scope.adherenceSummary?.().then(setAdherence).catch(() => {})
      }
      window.redlog.chain.length().then(setChainLen)
    })
    return unsub
  }, [])

  if (loading) {
    return (
      <LoadingSpinner />
    )
  }

  return (
    <div className="p-4 space-y-4 overflow-auto h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{t('scope.title')}</h2>
        {violations.length > 0 && (
          <button
            onClick={async () => {
              const p = await (window.redlog.data as { exportViolations?: () => Promise<string | null> }).exportViolations?.()
              if (p) toast(t('toast.exportedTo', { path: p }), 'success')
              else toast(t('toast.exportFailed'), 'error')
            }}
            className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
            title={t('scope.exportHint')}
          >{t('scope.export')}</button>
        )}
        <button
          onClick={async () => {
            const p = await window.redlog.data.exportAdherence?.()
            if (p) toast(t('toast.exportedTo', { path: p }), 'success')
            else toast(t('toast.exportFailed'), 'error')
          }}
          className="px-2.5 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
          title={t('scope.exportAdherenceHint')}
        >{t('scope.exportAdherence')}</button>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-zinc-300 text-sm font-medium">{t('scope.monitor')}</span>
          {configured ? (
            <span className="text-green-400 text-xs bg-green-400/10 px-2 py-0.5 rounded">{t('scope.active')}</span>
          ) : (
            <span className="text-zinc-500 text-xs bg-zinc-800 px-2 py-0.5 rounded">{t('scope.notSet')}</span>
          )}
        </div>
        {configured && violations.length === 0 && (
          <p className="text-green-400 text-xs">{t('scope.allInScope')}</p>
        )}
        {violations.length > 0 && (
          <div className={`${SEVERITY_CLASS[worstSeverity(violations.map((v) => scopeSeverity(v.reason)))].text} text-sm`}>
            {t('scope.violations', { count: violations.length })}
          </div>
        )}
        {configured && adherence && adherence.totals.targets > 0 && (
          <div className="pt-2 border-t border-zinc-800 space-y-1">
            <p className="text-zinc-300 text-xs font-mono">{adherence.summary}</p>
            <p className="text-zinc-600 text-xs">{t('scope.adherenceHint', { actions: adherence.totals.actions })}</p>
            {/* Re-classification runs against the CURRENT scope. If the scope was
                edited mid-engagement the counts describe the work as judged by
                today's list — a caveat, said out loud rather than swallowed. */}
            {adherence.scopeChanges > 0 && (
              <p className="text-orange-400/90 text-xs">{t('scope.adherenceScopeChanged', { n: adherence.scopeChanges })}</p>
            )}
            {/* G-D2: which document this scope came from. The digest is what
                lets a reviewer join the report to the authorisation file they
                were handed, instead of taking the path on trust. */}
            {adherence.provenance && !adherence.provenance.error && (
              <p className="text-zinc-600 text-xs font-mono break-all">
                {t('scope.provenance', {
                  entries: adherence.provenance.entries,
                  digest: adherence.provenance.digest.slice(0, 12)
                })}
              </p>
            )}
            {/* A scope file that parses to nothing contributes no targets and
                said nothing about it — "scope active" with an empty document
                reads exactly like a correctly loaded one. */}
            {adherence.provenance && adherence.provenance.entries === 0 && (
              <p className="text-orange-400/90 text-xs">
                {adherence.provenance.error
                  ? t('scope.provenanceUnreadable', { path: adherence.provenance.path })
                  : t('scope.provenanceEmpty', { path: adherence.provenance.path })}
              </p>
            )}
          </div>
        )}
        {!configured && (
          <div className="flex flex-col items-center py-6 gap-2">
            <div className="w-12 h-12 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
              <span className="text-xl text-zinc-600">{ICON.scope}</span>
            </div>
            <p className="text-zinc-500 text-xs">
              {t('scope.hint')}
            </p>
          </div>
        )}
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
        <div className="flex items-center justify-between">
          <span className="text-zinc-300 text-sm font-medium">{t('scope.evidenceLog')}</span>
          <span className="text-zinc-500 text-xs">{t('scope.entries', { count: chainLen })}</span>
        </div>
      </div>

      {violations.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm text-zinc-400">{t('scope.recentViolations')}</h3>
          {/* G-C1: every violation used to render in the same red, so "you touched
              a host the client explicitly forbade" and "you touched a neighbour
              of one you were allowed" were visually identical. Colour is the
              shared severity scale; a dashed border marks the §3 inferences. */}
          {violations.slice(0, 10).map((v, i) => {
            const sev = scopeSeverity(v.reason)
            const inferred = v.authority === 'inferred'
            const tint = sev === 'critical'
              ? 'bg-red-900/20 border-red-800/30 hover:bg-red-900/30 disabled:hover:bg-red-900/20'
              : sev === 'warn'
                ? 'bg-orange-900/15 border-orange-800/30 hover:bg-orange-900/25 disabled:hover:bg-orange-900/15'
                : 'bg-zinc-800/30 border-zinc-700/40 hover:bg-zinc-800/50 disabled:hover:bg-zinc-800/30'
            return (
              <button
                key={i}
                onClick={() => onOpenInTimeline?.(v.timestamp)}
                disabled={!onOpenInTimeline}
                className={`w-full text-left ${tint} ${inferred ? 'border-dashed' : ''} border rounded p-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 disabled:cursor-default transition-colors`}
                title={onOpenInTimeline ? t('scope.openInTimeline') : undefined}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`${sev === 'critical' ? 'text-red-300' : sev === 'warn' ? 'text-orange-300' : 'text-zinc-400'} text-xs font-mono`}>{v.target}</span>
                  <span className="text-3xs uppercase tracking-wide text-zinc-500">{t(`scope.reason.${v.reason}`)}</span>
                </div>
                <div className="text-zinc-500 text-xs truncate">{v.command}</div>
                <div className="text-zinc-600 text-xs">{new Date(v.timestamp).toLocaleTimeString()}</div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
