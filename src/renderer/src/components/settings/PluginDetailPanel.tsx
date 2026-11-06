import { ArrowLeft } from 'lucide-react'
import { Button } from '../Button'
import { PluginSampleTester } from './PluginSampleTester'
import { PluginIcon, TONE_DOT, KIND_LABEL } from './PluginRow'
import { formatDateTime } from '../../lib/time'
import { effectGroups, pluginKind, pluginTone, type OfficialHealth, type OfficialProjectLevel, type PluginView, type PluginViewModel } from '../../lib/pluginViewModel'

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

/** One titled card of the detail. Declared at module scope: a component
 *  defined inside another one is a new type on every render. */
function Card({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }): JSX.Element {
  return (
    <div data-testid={testId} className="rounded border border-redlog-border bg-redlog-surface/50 p-3 space-y-2">
      <h3 className="text-xs font-semibold text-redlog-text border-b border-redlog-border pb-1.5">{title}</h3>
      {children}
    </div>
  )
}

/** Single-column detail for one plugin, in the order the Stitch design gives
 *  it: who it is and what to do with it, how it relates to this project, what
 *  it may do, then the reference data (collapsed). The five axes of Spec 065
 *  are all still here — a status chip must never be the only word on trust,
 *  and «loaded» is not a verdict on install or project — they are only
 *  arranged under those four headings. */
export default function PluginDetailPanel({ p, vm, t, busy, onEnable, onDisable, onReview, onRevoke, onBack, officialAxes, onInstall, onRemove, onOpenCaptureSources }:
{
  p: PluginView; vm: PluginViewModel; t: T; busy: boolean
  onEnable: () => void; onDisable: () => void; onReview: () => void; onRevoke: () => void
  onBack: () => void
  /** Official integrations only: project level and capture health (Spec 066). */
  officialAxes?: { level: OfficialProjectLevel; health: OfficialHealth }
  onInstall?: () => void; onRemove?: () => void
  onOpenCaptureSources?: () => void
}): JSX.Element {
  const { trust } = vm
  const official = vm.install.official
  const needsConsent = trust.needsConsent
  const kind = pluginKind(p)
  const tone = pluginTone(p)
  const statusLabel = trust.applicable ? t(`plugins.status.${trust.status}`) : t(`plugins.installState.${official?.state ?? 'not-installed'}`)
  return (
    <section aria-label={p.name} data-testid={`plugin-detail-${p.id}`} className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-redlog-border pb-2">
        <Button level="quiet" size="compact" type="button" data-testid={`plugin-back-${p.id}`} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden className="inline mr-1" />{t('plugins.back')}
        </Button>
        <span className="text-xs font-mono text-redlog-text-faint break-all">{p.id}</span>
      </div>

      <div className="rounded border border-redlog-border bg-redlog-surface/50 p-3 space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <PluginIcon kind={kind} tone={tone} size={20} />
            <h2 className="text-sm font-semibold text-redlog-text">{p.name}</h2>
            {p.version && <span className="text-xs font-mono text-redlog-text-dim">v{p.version}</span>}
            <span className="text-xs px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim">{t(KIND_LABEL[kind])}</span>
            {p.tier === 'privileged' && <span className="text-xs px-1.5 py-0.5 rounded bg-red-950/60 text-red-300">{t('plugins.tier.privileged')}</span>}
          </div>
          <p className="flex items-center gap-1.5 text-xs">
            <span aria-hidden className={`w-2 h-2 rounded-full ${TONE_DOT[tone]}`} />
            <span data-testid={`plugin-status-${p.id}`}>{statusLabel}</span>
            {official && <><span className="text-redlog-text-faint">·</span><span data-testid={`plugin-install-state-${p.id}`} className="text-redlog-text-dim">{t(`plugins.installState.${official.state}`)}</span></>}
          </p>
        </div>

        {vm.issues.length > 0 && (
          <ul className="text-xs text-amber-400 space-y-1" data-testid={`plugin-issues-${p.id}`}>
            {vm.issues.map((issue) => <li key={issue.kind}>{t(issue.labelKey)}</li>)}
          </ul>
        )}

        {official && (official.state === 'conflict' || official.state === 'error') && (
          <div className="space-y-1 text-xs">
            <p role="alert" data-testid={`plugin-install-error-${p.id}`} className="text-red-400 break-words">{official.error}</p>
            <p className="text-redlog-text-dim">{t('plugins.integration.conflictHint')}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-2 border-t border-redlog-border/60">
          {onOpenCaptureSources && (
            <Button level="primary" type="button" data-testid={`plugin-open-capture-${p.id}`} onClick={onOpenCaptureSources}>{t('plugins.integration.openCaptureSources')}</Button>
          )}
          {official?.state === 'not-installed' && (
            <Button level="secondary" type="button" data-testid={`plugin-install-${p.id}`} disabled={busy} onClick={onInstall}>{t('settings.agents.installCapture')}</Button>
          )}
          {official?.state === 'installed' && trust.status === 'disabled' && (
            <Button level="secondary" type="button" data-testid={`plugin-restore-${p.id}`} disabled={busy} onClick={onInstall}>{t('settings.agents.restoreCapture')}</Button>
          )}
          {official?.state === 'update-available' && (
            <Button level="secondary" type="button" data-testid={`plugin-update-${p.id}`} disabled={busy} onClick={onInstall}>{t('settings.agents.updateCapture')}</Button>
          )}
          {(official?.state === 'installed' || official?.state === 'update-available') && (
            <Button level="secondary" type="button" data-testid={`plugin-uninstall-${p.id}`} disabled={busy} onClick={onRemove}>{t('settings.agents.removeCapture')}</Button>
          )}
          {(official?.state === 'conflict' || official?.state === 'error') && (
            <Button level="quiet" type="button" data-testid={`plugin-open-folder-${p.id}`} onClick={() => { void window.redlog.plugins.openFolder() }}>{t('plugins.openFolder')}</Button>
          )}
        </div>

        {p.description && <p className="text-xs text-redlog-text-dim bg-redlog-bg border border-redlog-border rounded p-2 break-words">{p.description}</p>}
      </div>

      {officialAxes && (
        <Card title={t('plugins.card.capture')} testId={`plugin-card-capture-${p.id}`}>
          <dl className="text-xs space-y-2">
            <div>
              <dt className="text-redlog-text-dim">{t('plugins.axis.project')}</dt>
              <dd className="mt-0.5"><p data-testid={`plugin-project-${p.id}`}>{t(`plugins.projectAxis.${officialAxes.level}`)}</p></dd>
            </div>
            <div>
              <dt className="text-redlog-text-dim">{t('plugins.axis.health')}</dt>
              <dd className="mt-0.5"><HealthLine health={officialAxes.health} t={t} id={p.id} /></dd>
            </div>
          </dl>
        </Card>
      )}

      <Card title={t('plugins.card.trust')} testId={`plugin-card-trust-${p.id}`}>
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
            <dt className="text-redlog-text-dim">{t('plugins.capabilities')}</dt>
            <dd data-testid={`plugin-capabilities-${p.id}`} className="mt-0.5 space-y-0.5">
              {p.capabilities.length === 0
                ? <p className="text-redlog-text-dim">{t('plugins.noCapabilities')}</p>
                : <ul className="space-y-0.5">{p.capabilities.map((c) => <li key={c} className="text-amber-500/90">&bull; {c}</li>)}</ul>}
              {p.capabilities.length > 0 && <p className="text-redlog-text-faint">{t('plugins.capabilitiesNote')}</p>}
            </dd>
          </div>

          <div>
            <dt className="text-redlog-text-dim">{t('plugins.axis.effect')}</dt>
            <dd className="mt-0.5">
              {p.notLoaded === true && <p className="text-redlog-text-dim">{t('plugins.effectAxis.notLoaded')}</p>}
              {p.notLoaded !== true && p.report === null && p.apiAhead !== true && <p className="text-redlog-text-dim">{t('plugins.unknownDiagnosis')}</p>}
              <ContributionResults p={p} t={t} />
            </dd>
          </div>
        </dl>
      </Card>

      <details data-testid={`plugin-specs-${p.id}`} className="rounded border border-redlog-border bg-redlog-surface/50 p-3 text-xs">
        <summary className="cursor-pointer font-semibold text-redlog-text">{t('plugins.card.specs')}</summary>
        <dl className="mt-2 space-y-1.5">
          <div className="flex justify-between gap-3"><dt className="text-redlog-text-dim">{t('plugins.spec.id')}</dt><dd className="font-mono break-all text-right">{p.id}</dd></div>
          {p.author && <div className="flex justify-between gap-3"><dt className="text-redlog-text-dim">{t('plugins.spec.author')}</dt><dd className="text-right">{p.author}</dd></div>}
          <div className="flex justify-between gap-3"><dt className="text-redlog-text-dim">{t('plugins.axis.install')}</dt><dd className="text-right">{official ? t(`plugins.installState.${official.state}`) : t(`plugins.installOrigin.${vm.install.origin}`)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-redlog-text-dim">{t('plugins.spec.managedBy')}</dt><dd className="text-right">{t(`plugins.managedBy.${vm.install.managedBy}`)}</dd></div>
        </dl>
      </details>

      <details data-testid="plugin-advanced" className="rounded border border-redlog-border bg-redlog-surface/50 px-2 py-2 text-xs">
        <summary className="cursor-pointer font-semibold text-redlog-text">{t('plugins.card.advanced')}</summary>
        <PluginSampleTester t={t} />
      </details>
    </section>
  )
}
