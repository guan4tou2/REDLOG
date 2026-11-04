import { Button } from '../Button'
import { effectGroups, type PluginView, type PluginViewModel } from '../../lib/pluginViewModel'

type T = (key: string, vars?: Record<string, string | number>) => string

const GROUP_WAITING_KEY: Record<string, string | undefined> = {
  capture: 'plugins.results.captureWaiting',
  terminalProfiles: 'plugins.results.terminalProfilesWaiting'
}

/** The full contribution report, one line per group with every rejected item's
 *  name and reason. Rendered only inside the detail panel, so the list can show
 *  a single anomaly line instead (Spec 065 — "diagnosis is not lost" means the
 *  detail holds it all). */
function ContributionResults({ p, t }: { p: PluginView; t: T }): JSX.Element | null {
  if (p.apiAhead !== true && p.report == null) return null
  const groups = effectGroups(p)
  const tailers = groups.find((g) => g.key === 'tailers')
  const rest = groups.filter((g) => g.key !== 'tailers')
  if (p.apiAhead !== true && groups.length === 0) return null
  return (
    <div data-testid={`plugin-results-${p.id}`} className="mt-1 text-xs space-y-0.5">
      {p.apiAhead === true && <p className="text-amber-500">{t('plugins.apiAhead')}</p>}
      {rest.map((g) => {
        const rejected = g.rejected
        const waitingKey = g.waiting ? GROUP_WAITING_KEY[g.key] : undefined
        return (
          <div key={g.key} data-testid={`plugin-results-${g.key}-${p.id}`}>
            <p className={rejected.length ? 'text-amber-500' : 'text-redlog-text-dim'}>
              {waitingKey ? t(waitingKey) : t(g.labelKey, { accepted: g.accepted, rejected: rejected.length })}
            </p>
            {rejected.map((r) => (
              <p key={`${g.key}-${r.title || r.reason}`} className="text-red-400 pl-3">{r.title ? `${r.title}: ` : ''}{r.reason}</p>
            ))}
          </div>
        )
      })}
      {tailers && (
        <div data-testid={`plugin-results-tailers-${p.id}`}>
          {tailers.rejected.length > 0
            ? <p className="text-red-400">{t(tailers.labelKey, { reason: tailers.rejected[0]?.reason ?? '' })}</p>
            : <p className="text-redlog-text-dim">{t(tailers.labelKey)}</p>}
        </div>
      )}
    </div>
  )
}

/** Single-column detail panel for one plugin. Reads whole diagnosis onto the
 *  screen as five explicit axes — a status chip must never be the only word on
 *  trust, and «loaded» is not a verdict on install or project (Spec 065). */
export default function PluginDetailPanel({ p, vm, t, busy, onEnable, onDisable, onReview, onRevoke, onBack, showBack }:
{
  p: PluginView; vm: PluginViewModel; t: T; busy: boolean
  onEnable: () => void; onDisable: () => void; onReview: () => void; onRevoke: () => void
  onBack?: () => void; showBack: boolean
}): JSX.Element {
  const { trust } = vm
  const needsConsent = trust.needsConsent
  return (
    <section aria-label={p.name} data-testid={`plugin-detail-${p.id}`} className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <strong className="text-sm text-redlog-text">{p.name}</strong>
          <span className="text-xs text-redlog-text-dim">v{p.version}</span>
        </div>
        {showBack && onBack && <Button level="secondary" type="button" data-testid={`plugin-back-${p.id}`} onClick={onBack}>{t('plugins.back')}</Button>}
      </div>

      {vm.issues.length > 0 && (
        <ul className="text-xs text-amber-400 space-y-1" data-testid={`plugin-issues-${p.id}`}>
          {vm.issues.map((issue) => <li key={issue.kind}>{t(issue.labelKey)}</li>)}
        </ul>
      )}

      <dl className="text-xs space-y-2">
        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.trust')}</dt>
          <dd className="mt-0.5 space-y-1">
            <p>{t(`plugins.status.${trust.status}`)}</p>
            {p.status === 'error' && p.error && <p role="alert" className="text-red-400 break-words">{p.error}</p>}
            {p.profilesError && <p role="alert" className="text-red-400 break-words">{t('plugins.issue.profilesStale')}: {p.profilesError}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              {p.status !== 'error' && !needsConsent && (
                <Button level="secondary" type="button" data-testid={`plugin-detail-toggle-${p.id}`} disabled={busy} onClick={trust.status === 'disabled' ? onEnable : onDisable}>
                  {t(trust.status === 'disabled' ? 'plugins.enable' : 'plugins.disable')}
                </Button>
              )}
              {needsConsent && !trust.cannotBeTrusted && (
                <Button level="secondary" type="button" data-testid={`plugin-detail-review-${p.id}`} disabled={busy} onClick={onReview}>{t('plugins.review')}</Button>
              )}
              {trust.canRevoke && (
                <Button level="secondary" type="button" data-testid={`plugin-detail-revoke-${p.id}`} disabled={busy} onClick={onRevoke}>{t('plugins.revoke')}</Button>
              )}
            </div>
          </dd>
        </div>

        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.install')}</dt>
          <dd className="mt-0.5 space-y-0.5">
            <p>{t(`plugins.installOrigin.${vm.install.origin}`)}</p>
            <p className="text-redlog-text-dim">{t(`plugins.managedBy.${vm.install.managedBy}`)}</p>
          </dd>
        </div>

        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.project')}</dt>
          <dd className="mt-0.5">
            <p className="text-redlog-text-dim">{t('plugins.projectAxis.na')}</p>
          </dd>
        </div>

        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.health')}</dt>
          <dd className="mt-0.5">
            <p className="text-redlog-text-dim">{t('plugins.healthAxis.na')}</p>
          </dd>
        </div>

        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.effect')}</dt>
          <dd className="mt-0.5">
            {p.report === null && p.apiAhead !== true && <p className="text-redlog-text-dim">{t('plugins.unknownDiagnosis')}</p>}
            <ContributionResults p={p} t={t} />
            {p.tier === 'privileged' && p.capabilities.length > 0 && (
              <p className="text-xs text-amber-500/80 mt-1">{t('plugins.capabilities')}: {p.capabilities.join(', ')}</p>
            )}
          </dd>
        </div>
      </dl>
    </section>
  )
}