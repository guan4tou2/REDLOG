import { Button } from '../Button'
import { useEffect } from 'react'
import { useI18n, type Locale } from '../../i18n'
import { usePersistentState } from '../../lib/usePersistentState'
import { useDisplayZone, setDisplayZone } from '../../lib/time'
import { applyDensity, resolveDensity, storedDensity } from '../../lib/density'
import { UI_SCALE_KEY, UI_SCALE_OPTIONS, DEFAULT_UI_SCALE, parseUiScale, zoomFor } from '../../lib/uiScale'
import { FieldGroup } from './SettingsShared'

const LOCALE_LABELS: Record<Locale, string> = {
  'en': 'English',
  'zh-TW': '繁體中文'
}

export default function GeneralPage(): JSX.Element {
  const { t, locale, setLocale } = useI18n()

  return (
    <>
      <FieldGroup title={t('settings.language')}>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(LOCALE_LABELS) as Locale[]).map((l) => (
            <Button size="compact" level="quiet"
              key={l}
              aria-pressed={locale === l}
              onClick={() => setLocale(l)}
            >
              {LOCALE_LABELS[l]}
            </Button>
          ))}
        </div>
        {/* In the language group rather than a group of its own: both say how
            this machine reads the app, and the settings page holds its group
            count (settings-ia test). */}
        <DisplayZoneControl t={t} />
      </FieldGroup>
      <FieldGroup title={t('settings.uiScale')}>
        <UiScaleControl t={t} />
      </FieldGroup>
    </>
  )
}

// Spec 038: the one zone every event time in the app is printed in. It was
// the Timeline's own picker, and no other view followed it. A viewing
// preference of this machine, like the UI scale, so it is not project config,
// and exports stay ISO 8601 whatever it is.
function DisplayZoneControl({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const zone = useDisplayZone()
  return (
    <div className="space-y-1.5 pt-2">
      <p className="text-xs text-redlog-text-dim">{t('settings.displayZone')}</p>
      <div className="flex flex-wrap gap-2">
        {(['local', 'utc'] as const).map((z) => (
          <Button size="compact" level="quiet"
            key={z}
            aria-pressed={zone === z}
            onClick={() => setDisplayZone(z)}
          >{t(z === 'local' ? 'settings.displayZoneLocal' : 'settings.displayZoneUtc')}</Button>
        ))}
      </div>
      <p className="text-xs text-redlog-text-faint">{t('settings.displayZoneHint')}</p>
    </div>
  )
}

// The ladder, its default and its storage key live in lib/uiScale — main.tsx
// applies the same value before first paint, and two copies of a default is
// one copy too many.

function UiScaleControl({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [scale, setScale] = usePersistentState<number>(UI_SCALE_KEY, DEFAULT_UI_SCALE, {
    parse: parseUiScale
  })
  useEffect(() => {
    document.body.style.setProperty('--app-zoom', String(zoomFor(scale)))
    // usePersistentState already mirrors `scale` into UI_SCALE_KEY; this effect
    // only carries the side-effects that must ride the same value change.
    // A bigger zoom means fewer rows on screen, so it implies tight density —
    // unless the operator has picked a density themselves (SS3).
    applyDensity(resolveDensity(scale, storedDensity()))
  }, [scale])
  return (
    <div className="flex flex-wrap gap-2 items-center">
      {UI_SCALE_OPTIONS.map((opt) => (
        <Button size="compact" level="quiet"
          key={opt.value}
          aria-pressed={Math.abs(scale - opt.value) < 0.01}
          onClick={() => setScale(opt.value)}
        >{t(opt.labelKey)}</Button>
      ))}
      <span className="text-xs text-redlog-text-faint ml-2 font-mono">{Math.round(scale * 100)}%</span>
    </div>
  )
}

