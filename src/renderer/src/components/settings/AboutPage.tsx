import { useEffect, useState } from 'react'
import { FieldGroup } from './SettingsShared'
import { Button } from '../Button'
import { formatDateTime } from '../../lib/time'
import type { UpdateStatus } from '../../../../main/services/update-status'

// The version and "check for updates" used to live in the title bar, beside
// the project name. They are read once and pressed almost never, and they were
// taking the strip that holds the evidence verbs — the controls an operator
// reaches for while working (docs/UIUX-CONTROLS-AND-COPY.md §2, question 1).
//
// The version stays selectable: a bug report starts with someone copying it.

type T = (key: string, vars?: Record<string, string | number>) => string

/** What the last check found, in one sentence. A failed or inapplicable check
 *  is never worded as "up to date". Module scope: a component declared inside
 *  another remounts on every render. */
function stateText(s: UpdateStatus, t: T): string {
  const version = s.targetVersion ?? ''
  switch (s.stage) {
    case 'checking': return t('update.state.checking')
    case 'available': return s.unfinished ? t('update.state.unfinished', { version }) : t('update.state.available', { version })
    case 'downloading':
      return s.progress === null ? t('update.state.downloadingUnknown', { version }) : t('update.state.downloading', { version, percent: s.progress })
    case 'ready': return t('update.state.ready', { version })
    case 'installing': return t('update.state.installing')
    case 'failed': return t('update.state.failed')
    case 'unavailable': return s.result === 'airgap' ? t('update.state.airgap') : t('update.state.noInstaller', { version })
    default: return s.result === 'upToDate' ? t('update.state.upToDate') : t('update.state.notChecked')
  }
}

/** How this install is updated. macOS and Linux are by hand, and each says why
 *  and what to do rather than letting a page opening read as an update. */
function methodText(s: UpdateStatus, platform: string, t: T): string {
  if (s.method === 'in-app') return t('update.method.inApp')
  if (platform === 'darwin') return t('update.method.downloadPageMac')
  if (platform === 'linux') return t('update.method.downloadPageLinux')
  return t('update.method.downloadPage')
}

function UpdateBlock({ t }: { t: T }): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.redlog.app.updateStatus().then((s) => { if (live) setStatus(s) }).catch(() => {})
    const off = window.redlog.app.onUpdateStatus((s) => { if (live) setStatus(s) })
    return () => { live = false; off() }
  }, [])
  if (!status) return null

  const busy = status.stage === 'checking' || status.stage === 'downloading' || status.stage === 'installing'
  const showDownloadPage = status.stage === 'failed' || (status.method === 'download-page' && status.stage === 'available')
    || (status.stage === 'unavailable' && status.result === 'noInstaller')
  return (
    <div className="space-y-1.5" data-testid="update-block">
      <p className="text-xs text-redlog-text-dim" data-testid="update-method">
        {methodText(status, window.redlog.platform, t)}
        {status.packaged ? '' : ` · ${t('update.devBuild')}`}
      </p>
      <p className="text-sm text-redlog-text" role="status" data-testid="update-state">{stateText(status, t)}</p>
      {status.stage === 'unavailable' && status.result === 'airgap' && (
        <p className="text-xs text-redlog-text-faint" data-testid="update-airgap-hint">{t('update.airgapHint')}</p>
      )}
      {status.stage === 'ready' && status.method === 'in-app' && (
        <p className="text-xs text-redlog-text-faint">{t('update.readyHint')}</p>
      )}
      {status.checkedAt !== null && (
        <p className="text-xs text-redlog-text-faint" data-testid="update-checked-at">
          {t('update.checkedAt', { time: formatDateTime(status.checkedAt) })}
        </p>
      )}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          data-testid="update-auto-check"
          checked={status.autoCheck}
          onChange={(e) => {
            // Shown at once, then main's answer replaces it: it owns the flag.
            const on = e.target.checked
            setStatus({ ...status, autoCheck: on })
            void window.redlog.app.setAutoUpdateCheck(on).then(setStatus, () => window.redlog.app.updateStatus().then(setStatus))
          }}
          className="accent-red-600"
        />
        <span className="text-xs text-redlog-text">{t('update.autoCheck')}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button level="secondary" disabled={busy} onClick={() => void window.redlog.app.checkForUpdates()} data-testid="update-check">
          {status.stage === 'checking' ? t('update.checking') : status.stage === 'failed' ? t('update.retry') : t('settings.checkUpdate')}
        </Button>
        {status.stage === 'downloading' && (
          <Button level="secondary" onClick={() => void window.redlog.app.cancelUpdate()} data-testid="update-cancel">
            {t('update.cancel')}
          </Button>
        )}
        {status.stage === 'ready' && status.method === 'in-app' && (
          <Button level="secondary" onClick={() => void window.redlog.app.installUpdate()} data-testid="update-install">
            {t('update.installNow')}
          </Button>
        )}
        {showDownloadPage && (
          <Button level="secondary" onClick={() => void window.redlog.app.openExternal(status.releaseUrl)} data-testid="update-open-page">
            {t('update.openDownloadPage')}
          </Button>
        )}
      </div>
    </div>
  )
}

export default function AboutPage({ t }: {
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  // The switch is machine-wide and lives in main (a flag file the zsh helper
  // also reads), so it is read from there rather than from project config.
  const [debug, setDebug] = useState<{ enabled: boolean; path: string } | null>(null)
  useEffect(() => { void window.redlog.debug.status().then(setDebug) }, [])
  return (
    <div className="space-y-4">
      <FieldGroup title={t('settings.aboutVersion')}>
        <p className="font-mono text-sm text-redlog-text select-text cursor-text">
          RedLog v{__APP_VERSION__}
        </p>
        <UpdateBlock t={t} />
      </FieldGroup>
      {debug && (
        <FieldGroup title={t('settings.debugLog')}>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              data-testid="debug-log-toggle"
              checked={debug.enabled}
              onChange={(e) => {
                // Show the choice at once, then take main's word for it: it
                // is the one that owns the flag file.
                const on = e.target.checked
                setDebug({ ...debug, enabled: on })
                void window.redlog.debug.set(on).then(setDebug, () => window.redlog.debug.status().then(setDebug))
              }}
              className="accent-red-600"
            />
            <span className="text-xs text-redlog-text">{t('settings.debugLogToggle')}</span>
          </label>
          <p className="text-xs text-redlog-text-faint">{t('settings.debugLogHint')}</p>
          <p className="text-xs text-redlog-text-faint font-mono break-all select-text cursor-text" data-testid="debug-log-path">{debug.path}</p>
          <div>
            <Button level="secondary" onClick={() => void window.redlog.debug.reveal()}>
              {t('settings.debugLogReveal')}
            </Button>
          </div>
        </FieldGroup>
      )}
    </div>
  )
}
