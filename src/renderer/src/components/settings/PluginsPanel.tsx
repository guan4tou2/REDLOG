import { useState, useEffect } from 'react'
import { toast, toastDeferred } from '../Toast'
import { FieldGroup } from './SettingsShared'

interface PluginView {
  id: string
  name: string
  version: string
  description: string
  author: string
  source: 'bundled' | 'user'
  tier: 'declarative' | 'privileged'
  status: 'active' | 'needs-consent' | 'hash-changed' | 'disabled' | 'error'
  capabilities: string[]
  contributes: string[]
  error?: string
}

// SS10: two levels, not four. This page used to hold sub-tabs for installed
// and marketplace, and the marketplace held its own for publishers and
// revocations — three levels below a second-level tab, when the standard
// allows two.
//
// The marketplace is now gone rather than flattened. Browsing a registry,
// trusting publishers by fingerprint, and reading revocation lists are the
// machinery of distributing capture code, and distribution is not what this
// product is for. What stays is the part an operator needs to answer "is
// anything capturing that I did not put there" — the installed list.
export default function PluginsPanel({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmGrant, setConfirmGrant] = useState<PluginView | null>(null)

  const api = (window.redlog as unknown as { plugins: {
    list: () => Promise<PluginView[]>
    reload: () => Promise<PluginView[]>
    openFolder: () => Promise<string>
    setEnabled: (id: string, enabled: boolean) => Promise<PluginView[]>
    grant: (id: string) => Promise<{ ok: boolean; error?: string; plugins: PluginView[] }>
    revoke: (id: string) => Promise<PluginView[]>
  } }).plugins

  useEffect(() => { api.list().then(setPlugins) }, [])

  const doReload = async (): Promise<void> => { setBusy('*'); setPlugins(await api.reload()); setBusy(null) }
  const toggle = async (p: PluginView, enabled: boolean): Promise<void> => {
    // Enabling is the recoverable direction and takes effect at once.
    if (enabled) {
      setBusy(p.id); setPlugins(await api.setEnabled(p.id, true)); setBusy(null)
      return
    }
    // Disabling stops a capture source and writes `system.config_changed`, so
    // SS10 gives it a window and defers the *write*, not just the undo: the
    // list shows the plugin as disabled immediately, but nothing is persisted
    // until the eight seconds are up. An operator who catches their own
    // mistake inside the window leaves no trace of it in the audit log —
    // which is the point, since that log is evidence.
    setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: 'disabled' } : x)))
    toastDeferred(
      t('plugins.disabled', { name: p.name }),
      () => { void api.setEnabled(p.id, false).then(setPlugins) },
      {
        type: 'warning',
        why: t('plugins.disabledWhy'),
        revert: () => setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: p.status } : x)))
      }
    )
  }
  const grant = async (p: PluginView): Promise<void> => {
    setBusy(p.id); setConfirmGrant(null)
    const r = await api.grant(p.id)
    setPlugins(r.plugins); setBusy(null)
    if (r.ok) toast(t('plugins.granted'), 'success')
    else {
      toast(t('plugins.grantFailed', { name: p.id }), {
        type: 'error',
        why: t('plugins.grantFailedWhy'),
        detail: r.error
      })
    }
  }
  const revoke = async (p: PluginView): Promise<void> => { setBusy(p.id); setPlugins(await api.revoke(p.id)); setBusy(null) }

  const STATUS_STYLE: Record<PluginView['status'], string> = {
    active: 'bg-green-900/50 text-green-400',
    'needs-consent': 'bg-amber-900/50 text-amber-400',
    'hash-changed': 'bg-amber-900/50 text-amber-400',
    disabled: 'bg-redlog-elevated text-redlog-text-dim',
    error: 'bg-red-900/50 text-red-400'
  }

  return (
    <FieldGroup title={t('settings.plugins')}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <p className="text-xs text-redlog-text-faint flex-1 pr-3">{t('plugins.hint')}</p>
        <button onClick={() => api.openFolder()}
          className="px-2.5 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover shrink-0"
          title={t('plugins.openFolderHint')}>
          {t('plugins.openFolder')}
        </button>
        <button onClick={doReload} disabled={busy === '*'}
          className="px-2.5 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover shrink-0">
          {busy === '*' ? '…' : t('plugins.reload')}
        </button>
      </div>

      {plugins.length === 0 && (
        <p className="text-xs text-redlog-text-faint py-3">{t('plugins.empty')}</p>
      )}

      <div className="space-y-2">
        {plugins.map((p) => {
          const privileged = p.tier === 'privileged'
          const needsConsent = p.status === 'needs-consent' || p.status === 'hash-changed'
          return (
            <div key={p.id} className="rounded border border-redlog-border bg-redlog-surface/50">
              <div className="flex items-start justify-between p-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-redlog-text">{p.name}</span>
                    <span className="text-xs text-redlog-text-dim">v{p.version}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_STYLE[p.status]}`}>
                      {t(`plugins.status.${p.status}`)}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${privileged ? 'bg-red-950/60 text-red-300' : 'bg-green-950/60 text-green-300'}`}>
                      {privileged ? t('plugins.tier.privileged') : t('plugins.tier.declarative')}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim">{p.source}</span>
                  </div>
                  {p.description && <p className="text-xs text-redlog-text-dim mt-0.5">{p.description}</p>}
                  {p.contributes.length > 0 && (
                    <p className="text-xs text-redlog-text-faint mt-1">{t('plugins.contributes')}: {p.contributes.join(', ')}</p>
                  )}
                  {privileged && p.capabilities.length > 0 && (
                    <p className="text-xs text-amber-500/80 mt-0.5">{t('plugins.capabilities')}: {p.capabilities.join(', ')}</p>
                  )}
                  {p.status === 'error' && p.error && <p className="text-xs text-red-400 mt-0.5">{p.error}</p>}
                </div>

                <div className="ml-3 shrink-0 flex flex-col gap-1 items-end">
                  {/* declarative (or already-trusted privileged): enable/disable */}
                  {p.status !== 'error' && !needsConsent && (
                    <button
                      disabled={busy === p.id}
                      onClick={() => toggle(p, p.status === 'disabled')}
                      className={`px-3 py-1 text-xs rounded ${
                        p.status === 'disabled' ? 'bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover' : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
                      }`}
                    >
                      {busy === p.id ? '…' : p.status === 'disabled' ? t('plugins.enable') : t('plugins.disable')}
                    </button>
                  )}
                  {/* privileged awaiting consent */}
                  {needsConsent && (
                    <button
                      disabled={busy === p.id}
                      onClick={() => setConfirmGrant(p)}
                      className="px-3 py-1 text-xs rounded bg-amber-600/80 text-redlog-on-warn hover:bg-amber-600"
                    >
                      {t('plugins.review')}
                    </button>
                  )}
                  {/* trusted privileged: allow revoke */}
                  {privileged && p.status === 'active' && (
                    <button onClick={() => revoke(p)} disabled={busy === p.id}
                      className="px-3 py-1 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:bg-red-900/30 hover:text-red-400">
                      {t('plugins.revoke')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-redlog-text-faint mt-3">{t('plugins.dir')}</p>

      {/* trust consent dialog for red-tier code plugins */}
      {confirmGrant && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmGrant(null)}>
          <div className="bg-redlog-surface border border-red-900/50 rounded-lg p-4 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-red-400 mb-1">{t('plugins.consentTitle')}</h3>
            <p className="text-xs text-redlog-text-dim mb-2">
              {t('plugins.consentBody', { name: confirmGrant.name })}
            </p>
            <div className="bg-redlog-bg border border-redlog-border rounded p-2 mb-2">
              <p className="text-xs text-redlog-text-dim mb-1">{t('plugins.capabilities')}:</p>
              <ul className="text-xs text-amber-400 space-y-0.5">
                {confirmGrant.capabilities.length === 0 && <li className="text-redlog-text-dim">&mdash;</li>}
                {confirmGrant.capabilities.map((c) => <li key={c}>&bull; {c}</li>)}
              </ul>
            </div>
            <p className="text-xs text-redlog-text-dim mb-3">{t('plugins.consentWarn')}</p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setConfirmGrant(null)} className="px-3 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover">
                {t('common.cancel')}
              </button>
              <button onClick={() => grant(confirmGrant)} className="px-3 py-1 text-xs rounded bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover">
                {t('plugins.grantRun')}
              </button>
            </div>
          </div>
        </div>
      )}
    </FieldGroup>
  )
}
