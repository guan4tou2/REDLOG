import { useState, useEffect } from 'react'
import { toast } from './Toast'

interface WslPanelProps {
  t: (key: string, vars?: Record<string, string | number>) => string
}

export default function WslPanel({ t }: WslPanelProps): JSX.Element {
  const [distros, setDistros] = useState<WslDistro[]>([])
  const [networkMode, setNetworkMode] = useState<'mirrored' | 'nat' | 'not-configured'>('not-configured')
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [diagnostics, setDiagnostics] = useState<WslDiagnosticResult | null>(null)

  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const [ds, nm] = await Promise.all([
        window.redlog.wsl.listDistros(),
        window.redlog.wsl.getNetworkMode()
      ])
      setDistros(ds)
      setNetworkMode(nm)
    } catch {
      setDistros([])
    }
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])

  const handleInstall = async (distro: string, shell: 'bash' | 'zsh'): Promise<void> => {
    const key = `${distro}-${shell}-install`
    setActionBusy(key)
    try {
      const result = await window.redlog.wsl.installHook(distro, shell)
      toast(result.message, result.success ? 'success' : 'error')
      if (result.success) await refresh()
    } catch (e) {
      toast(`Install failed: ${(e as Error).message}`, 'error')
    }
    setActionBusy(null)
  }

  const handleUninstall = async (distro: string, shell: 'bash' | 'zsh'): Promise<void> => {
    const key = `${distro}-${shell}-uninstall`
    setActionBusy(key)
    try {
      const result = await window.redlog.wsl.uninstallHook(distro, shell)
      toast(result.message, result.success ? 'success' : 'error')
      if (result.success) await refresh()
    } catch (e) {
      toast(`Uninstall failed: ${(e as Error).message}`, 'error')
    }
    setActionBusy(null)
  }

  const handleDiagnose = async (distro: string): Promise<void> => {
    const key = `${distro}-diag`
    setActionBusy(key)
    try {
      const result = await window.redlog.wsl.runDiagnostics(distro)
      setDiagnostics(result)
    } catch (e) {
      toast(`Diagnostics failed: ${(e as Error).message}`, 'error')
    }
    setActionBusy(null)
  }

  if (loading) {
    return (
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-wider">{t('settings.wsl.title')}</h3>
        <p className="text-xs text-redlog-text-dim">{t('common.loading')}</p>
      </div>
    )
  }

  // If no distros found, show a minimal message
  if (distros.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-wider">{t('settings.wsl.title')}</h3>
          <button
            onClick={refresh}
            className="px-2.5 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover"
          >
            {t('settings.wsl.refresh')}
          </button>
        </div>
        <p className="text-xs text-redlog-text-dim">{t('settings.wsl.noDistros')}</p>
      </div>
    )
  }

  const hookStatusLabel = (status: 'installed' | 'not-installed' | 'no-shell'): string => {
    switch (status) {
      case 'installed': return t('settings.wsl.installed')
      case 'not-installed': return t('settings.wsl.notInstalled')
      case 'no-shell': return t('settings.wsl.noShell')
    }
  }

  const hookStatusColor = (status: 'installed' | 'not-installed' | 'no-shell'): string => {
    switch (status) {
      case 'installed': return 'bg-green-900/50 text-green-400'
      case 'not-installed': return 'bg-redlog-elevated text-redlog-text-dim'
      case 'no-shell': return 'bg-redlog-elevated/50 text-redlog-text-faint'
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-wider">{t('settings.wsl.title')}</h3>
        <button
          onClick={refresh}
          className="px-2.5 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover"
        >
          {t('settings.wsl.refresh')}
        </button>
      </div>

      {/* Network mode banner */}
      {networkMode === 'mirrored' && (
        <div className="px-3 py-2 rounded border border-green-900/50 bg-green-950/30 text-xs text-green-400">
          {t('settings.wsl.networkMirrored')}
        </div>
      )}
      {networkMode === 'nat' && (
        <div className="px-3 py-2 rounded border border-amber-900/50 bg-amber-950/30 space-y-1">
          <p className="text-xs text-amber-400">{t('settings.wsl.networkNat')}</p>
          <p className="text-xs text-amber-500/80">{t('settings.wsl.natFix')}</p>
        </div>
      )}
      {networkMode === 'not-configured' && (
        <div className="px-3 py-2 rounded border border-amber-900/50 bg-amber-950/20 space-y-1">
          <p className="text-xs text-amber-400/80">{t('settings.wsl.networkNotConfigured')}</p>
          <p className="text-xs text-amber-500/70">{t('settings.wsl.natFix')}</p>
        </div>
      )}

      {/* Distro cards */}
      <div className="space-y-2">
        {distros.map((distro) => {
          const isStopped = distro.state !== 'Running'
          return (
            <div
              key={distro.name}
              className={`rounded border ${
                isStopped
                  ? 'border-redlog-border bg-redlog-surface/30 opacity-75'
                  : 'border-redlog-border bg-redlog-surface/50'
              }`}
            >
              <div className="p-3">
                {/* Header: name, state badge, default badge */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-redlog-text">{distro.name}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    distro.state === 'Running'
                      ? 'bg-green-900/50 text-green-400'
                      : 'bg-redlog-elevated text-redlog-text-dim'
                  }`}>
                    {distro.state === 'Running' ? t('settings.wsl.running') : t('settings.wsl.stoppedBadge')}
                  </span>
                  {distro.isDefault && (
                    <span className="text-xs bg-redlog-elevated text-redlog-text-dim px-1.5 py-0.5 rounded">
                      {t('settings.wsl.default')}
                    </span>
                  )}
                  <span className="text-xs text-redlog-text-faint">WSL {distro.version}</span>
                </div>

                {/* Stopped message */}
                {isStopped && (
                  <p className="text-xs text-redlog-text-dim mt-2">{t('settings.wsl.stopped')}</p>
                )}

                {/* Shell hook status and controls for running distros */}
                {!isStopped && (
                  <div className="mt-2 space-y-1.5">
                    {/* Detected shells */}
                    {distro.shells.length > 0 && (
                      <p className="text-xs text-redlog-text-dim">
                        Shells: {distro.shells.join(', ')}
                      </p>
                    )}

                    {/* Hook status per shell */}
                    {(['bash', 'zsh'] as const).map((shell) => {
                      const status = distro.hookStatus[shell]
                      if (status === 'no-shell') return null
                      const installKey = `${distro.name}-${shell}-install`
                      const uninstallKey = `${distro.name}-${shell}-uninstall`
                      return (
                        <div key={shell} className="flex items-center gap-2">
                          <span className="text-xs text-redlog-text-dim w-10">{shell}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded ${hookStatusColor(status)}`}>
                            {hookStatusLabel(status)}
                          </span>
                          {status === 'not-installed' && (
                            <button
                              disabled={actionBusy === installKey}
                              onClick={() => handleInstall(distro.name, shell)}
                              className="px-2.5 py-0.5 text-xs rounded bg-red-600/80 text-white hover:bg-red-600 disabled:opacity-50"
                            >
                              {actionBusy === installKey ? t('settings.wsl.installing') : t('settings.wsl.install')}
                            </button>
                          )}
                          {status === 'installed' && (
                            <button
                              disabled={actionBusy === uninstallKey}
                              onClick={() => handleUninstall(distro.name, shell)}
                              className="px-2.5 py-0.5 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:bg-red-900/30 hover:text-red-400 disabled:opacity-50"
                            >
                              {actionBusy === uninstallKey ? '...' : t('settings.wsl.uninstall')}
                            </button>
                          )}
                        </div>
                      )
                    })}

                    {/* Diagnose button */}
                    <div className="pt-1">
                      <button
                        disabled={actionBusy === `${distro.name}-diag`}
                        onClick={() => handleDiagnose(distro.name)}
                        className="px-2.5 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover disabled:opacity-50"
                      >
                        {actionBusy === `${distro.name}-diag` ? '...' : t('settings.wsl.diagnose')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Diagnostics result panel */}
      {diagnostics && (
        <div className="rounded border border-redlog-border bg-redlog-surface/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-redlog-text">
              {t('settings.wsl.diagTitle', { distro: diagnostics.distro })}
            </h4>
            <button
              onClick={() => setDiagnostics(null)}
              className="text-xs text-redlog-text-dim hover:text-redlog-text"
            >
              ×
            </button>
          </div>
          <div className="space-y-1">
            {diagnostics.checks.map((check, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`shrink-0 w-4 text-center ${
                  check.status === 'pass' ? 'text-green-400'
                    : check.status === 'fail' ? 'text-red-400'
                    : 'text-amber-400'
                }`}>
                  {check.status === 'pass' ? '+' : check.status === 'fail' ? 'x' : '!'}
                </span>
                <span className="text-redlog-text-dim">{check.name}:</span>
                <span className="text-redlog-text">{check.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
