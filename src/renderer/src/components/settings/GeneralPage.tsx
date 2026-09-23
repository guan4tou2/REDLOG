import { useState, useEffect } from 'react'
import { useI18n, type Locale } from '../../i18n'
import { usePersistentState } from '../../lib/usePersistentState'
import { toast } from '../Toast'
import { applyDensity, resolveDensity, storedDensity } from '../../lib/density'
import { storedShowAllPages, setShowAllPages } from '../../lib/showAllPages'
import { FieldGroup, Field, type ConfigState } from './SettingsShared'

const LOCALE_LABELS: Record<Locale, string> = {
  'en': 'English',
  'zh-TW': '繁體中文'
}

export default function GeneralPage({
  config, setConfig
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
}): JSX.Element {
  const { t, locale, setLocale } = useI18n()

  return (
    <>
      <FieldGroup title={t('settings.engagement')}>
        <Field label={t('settings.id')} value={config.engagement.id} onChange={() => {}} readOnly />
        <Field label={t('settings.name')} value={config.engagement.name} onChange={(v) => setConfig({ ...config, engagement: { ...config.engagement, name: v } })} />
      </FieldGroup>
      <FieldGroup title={t('settings.operatorGroup')}>
        <Field label={t('settings.id')} value={config.operator.id} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, id: v } })} />
        <Field label={t('settings.name')} value={config.operator.name} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, name: v } })} />
      </FieldGroup>
      {/* Was "Team Profile Sync", two buttons. The import half duplicated
          the one on the project picker, which is where you actually want
          it — you seed a config when creating the project, not after.
          The export half stays: deleting it would leave an import that
          consumes files nothing can produce. */}
      <FieldGroup title={t('settings.handoffProfile')}>
        <button
          onClick={async () => {
            const p = await window.redlog.config.exportProfile()
            if (p) toast(t('toast.profileExported'), { type: 'success', why: p })
          }}
          className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover self-start"
        >{t('settings.exportProfile')}</button>
        <p className="text-xs text-redlog-text-faint">{t('settings.handoffProfileHint')}</p>
      </FieldGroup>
      <FieldGroup title={t('settings.language')}>
        <div className="flex gap-2">
          {(Object.keys(LOCALE_LABELS) as Locale[]).map((l) => (
            <button
              key={l}
              onClick={() => setLocale(l)}
              className={`px-3 py-1.5 text-xs rounded ${
                locale === l
                  ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
                  : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
              }`}
            >
              {LOCALE_LABELS[l]}
            </button>
          ))}
        </div>
      </FieldGroup>
      <FieldGroup title={t('settings.uiScale')}>
        <UiScaleControl t={t} />
      </FieldGroup>
      <FieldGroup title={t('settings.disclosure')}>
        <ShowAllPagesControl t={t} />
      </FieldGroup>
    </>
  )
}

// Per-user UI zoom. Persisted to localStorage and applied to `document.body`
// via a CSS var (`--app-zoom`), which body's zoom rule in index.css consumes.
// Not part of engagement config: it's a personal viewing preference and
// shouldn't sync across teammates on the same project.
const UI_SCALE_KEY = 'redlog-app-zoom'
// Shifted down one step when the type scale gained its 13px floor: 1.1 used to
// be "normal" because 1.0 rendered text too small to read comfortably. It no
// longer does, so 1.0 is normal again and the ladder has room at the top.
const UI_SCALE_OPTIONS: Array<{ value: number; labelKey: string }> = [
  { value: 0.9, labelKey: 'settings.uiScale.small' },
  { value: 1.0, labelKey: 'settings.uiScale.normal' },
  { value: 1.15, labelKey: 'settings.uiScale.large' },
  { value: 1.3, labelKey: 'settings.uiScale.xlarge' }
]
function UiScaleControl({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [scale, setScale] = usePersistentState<number>(UI_SCALE_KEY, 1, {
    parse: (raw) => {
      const parsed = parseFloat(raw || '')
      return Number.isFinite(parsed) && parsed >= 0.9 && parsed <= 1.5 ? parsed : 1
    }
  })
  useEffect(() => {
    document.body.style.setProperty('--app-zoom', String(scale))
    // usePersistentState already mirrors `scale` into UI_SCALE_KEY; this effect
    // only carries the side-effects that must ride the same value change.
    // A bigger zoom means fewer rows on screen, so it implies tight density —
    // unless the operator has picked a density themselves (SS3).
    applyDensity(resolveDensity(scale, storedDensity()))
  }, [scale])
  return (
    <div className="flex gap-2 items-center">
      {UI_SCALE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setScale(opt.value)}
          className={`px-3 py-1.5 text-xs rounded ${
            Math.abs(scale - opt.value) < 0.01
              ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
              : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
          }`}
        >{t(opt.labelKey)}</button>
      ))}
      <span className="text-xs text-redlog-text-faint ml-2 font-mono">{Math.round(scale * 100)}%</span>
    </div>
  )
}

/** SS22's escape hatch. Per project, because switching projects reloads the same
 *  origin — a global preference would turn disclosure off for every future
 *  engagement after one tick here. */
function ShowAllPagesControl({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    void window.redlog.project.active().then((p) => {
      const id = (p as { id?: string } | null)?.id ?? null
      setProjectId(id)
      setOn(storedShowAllPages(id))
    })
  }, [])
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-xs text-redlog-text cursor-pointer">
        <input
          type="checkbox"
          data-testid="show-all-pages"
          checked={on}
          disabled={!projectId}
          onChange={(e) => {
            setOn(e.target.checked)
            if (projectId) setShowAllPages(projectId, e.target.checked)
          }}
          className="accent-redlog-accent"
        />
        {t('settings.showAllPages')}
      </label>
      <p className="text-xs text-redlog-text-faint">{t('settings.showAllPagesHint')}</p>
    </div>
  )
}
