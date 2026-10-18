import { useEffect, useState } from 'react'
import { FieldGroup } from './SettingsShared'
import { Button } from '../Button'

// The version and "check for updates" used to live in the title bar, beside
// the project name. They are read once and pressed almost never, and they were
// taking the strip that holds the evidence verbs — the controls an operator
// reaches for while working (docs/UIUX-CONTROLS-AND-COPY.md §2, question 1).
//
// The version stays selectable: a bug report starts with someone copying it.

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
        <div>
          <Button level="secondary" onClick={() => void window.redlog.app.checkForUpdates()}>
            {t('settings.checkUpdate')}
          </Button>
          <p className="text-xs text-redlog-text-faint mt-1.5">{t('settings.checkUpdateHint')}</p>
        </div>
      </FieldGroup>
      {debug && (
        <FieldGroup title={t('settings.debugLog')}>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              data-testid="debug-log-toggle"
              checked={debug.enabled}
              onChange={(e) => void window.redlog.debug.set(e.target.checked).then(setDebug)}
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
