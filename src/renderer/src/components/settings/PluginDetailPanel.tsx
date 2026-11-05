import { Button } from '../Button'
import { formatDateTime } from '../../lib/time'
import { effectGroups, type OfficialHealth, type OfficialProjectLevel, type PluginView, type PluginViewModel } from '../../lib/pluginViewModel'

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

/** One sentence for the capture-health axis. «Nothing received» is only ever
 *  neutral here: a fault is a source's own error, never silence. */
function HealthLine({ health, t, id }: { health: OfficialHealth; t: T; id: string }): JSX.Element {
  const testId = `plugin-health-${id}`
  switch (health.kind) {
    case 'error': return <p role="alert" data-testid={testId} className="text-red-400 break-words">{t('plugins.healthAxis.error')}: {health.message}</p>
    case 'received': return <p data-testid={testId}>{t('settings.source.lastReceived', { when: formatDateTime(health.at) })}</p>
    case 'waiting': return <p data-testid={testId} className="text-redlog-text-dim">{t('settings.source.neverReceived')}</p>
    case 'inactive': return <p data-testid={testId} className="text-redlog-text-dim">{t('plugins.healthAxis.inactive')}</p>
    default: return <p data-testid={testId} className="text-redlog-text-dim">{t('plugins.healthAxis.unknown')}</p>
  }
}

/** Single-column detail panel for one plugin. Reads whole diagnosis onto the
 *  screen as five explicit axes — a status chip must never be the only word on
 *  trust, and «loaded» is not a verdict on install or project (Spec 065). */
export default function PluginDetailPanel({ p, vm, t, busy, onEnable, onDisable, onReview, onRevoke, onBack, showBack, officialAxes, onInstall, onRemove, onOpenCaptureSources }:
{
  p: PluginView; vm: PluginViewModel; t: T; busy: boolean
  onEnable: () => void; onDisable: () => void; onReview: () => void; onRevoke: () => void
  onBack?: () => void; showBack: boolean
  /** Official integrations only: project level and capture health (Spec 066). */
  officialAxes?: { level: OfficialProjectLevel; health: OfficialHealth }
  onInstall?: () => void; onRemove?: () => void
  onOpenCaptureSources?: () => void
}): JSX.Element {
  const { trust } = vm
  const official = vm.install.official
  const needsConsent = trust.needsConsent
  return (
    <section aria-label={p.name} data-testid={`plugin-detail-${p.id}`} className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <strong className="text-sm text-redlog-text">{p.name}</strong>
          {p.version && <span className="text-xs text-redlog-text-dim">v{p.version}</span>}
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
            <p>{trust.applicable ? t(`plugins.status.${trust.status}`) : t('plugins.trustAxis.notLoaded')}</p>
            {trust.applicable && p.status === 'error' && p.error && <p role="alert" className="text-red-400 break-words">{p.error}</p>}
            {p.profilesError && <p role="alert" className="text-red-400 break-words">{t('plugins.issue.profilesStale')}: {p.profilesError}</p>}
            {trust.applicable && <div className="flex flex-wrap gap-2 pt-1">
              {trust.canToggle && p.status !== 'error' && !needsConsent && (
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
            </div>}
          </dd>
        </div>

        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.install')}</dt>
          <dd className="mt-0.5 space-y-0.5">
            {official ? (
              <p data-testid={`plugin-install-state-${p.id}`}>{t(`plugins.installState.${official.state}`)}</p>
            ) : (
              <p>{t(`plugins.installOrigin.${vm.install.origin}`)}</p>
            )}
            <p className="text-redlog-text-dim">{t(`plugins.managedBy.${vm.install.managedBy}`)}</p>
            {official && (official.state === 'conflict' || official.state === 'error') && (
              <div className="space-y-1">
                <p role="alert" data-testid={`plugin-install-error-${p.id}`} className="text-red-400 break-words">{official.error}</p>
                <p className="text-redlog-text-dim">{t('plugins.integration.conflictHint')}</p>
              </div>
            )}
            {official && (
              <div className="flex flex-wrap gap-2 pt-1">
                {official.state === 'not-installed' && (
                  <Button level="secondary" type="button" data-testid={`plugin-install-${p.id}`} disabled={busy} onClick={onInstall}>{t('settings.agents.installCapture')}</Button>
                )}
                {official.state === 'installed' && trust.status === 'disabled' && (
                  <Button level="secondary" type="button" data-testid={`plugin-restore-${p.id}`} disabled={busy} onClick={onInstall}>{t('settings.agents.restoreCapture')}</Button>
                )}
                {official.state === 'update-available' && (
                  <Button level="secondary" type="button" data-testid={`plugin-update-${p.id}`} disabled={busy} onClick={onInstall}>{t('settings.agents.updateCapture')}</Button>
                )}
                {(official.state === 'installed' || official.state === 'update-available') && (
                  <Button level="secondary" type="button" data-testid={`plugin-uninstall-${p.id}`} disabled={busy} onClick={onRemove}>{t('settings.agents.removeCapture')}</Button>
                )}
                {(official.state === 'conflict' || official.state === 'error') && (
                  <Button level="quiet" type="button" data-testid={`plugin-open-folder-${p.id}`} onClick={() => { void window.redlog.plugins.openFolder() }}>{t('plugins.openFolder')}</Button>
                )}
              </div>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.project')}</dt>
          <dd className="mt-0.5">
            {officialAxes
              ? <p data-testid={`plugin-project-${p.id}`}>{t(`plugins.projectAxis.${officialAxes.level}`)}</p>
              : <p className="text-redlog-text-dim">{t('plugins.projectAxis.na')}</p>}
            {onOpenCaptureSources && (
              <Button level="secondary" type="button" data-testid={`plugin-open-capture-${p.id}`} onClick={onOpenCaptureSources}>{t('plugins.integration.openCaptureSources')}</Button>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.health')}</dt>
          <dd className="mt-0.5">
            {officialAxes
              ? <HealthLine health={officialAxes.health} t={t} id={p.id} />
              : <p className="text-redlog-text-dim">{t('plugins.healthAxis.na')}</p>}
          </dd>
        </div>

        <div>
          <dt className="text-redlog-text-dim">{t('plugins.axis.effect')}</dt>
          <dd className="mt-0.5">
            {p.notLoaded === true && <p className="text-redlog-text-dim">{t('plugins.effectAxis.notLoaded')}</p>}
            {p.notLoaded !== true && p.report === null && p.apiAhead !== true && <p className="text-redlog-text-dim">{t('plugins.unknownDiagnosis')}</p>}
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