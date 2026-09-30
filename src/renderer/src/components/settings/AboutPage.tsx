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
    </div>
  )
}
