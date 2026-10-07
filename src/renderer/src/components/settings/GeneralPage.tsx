import { useState, useEffect } from 'react'
import { useI18n, type Locale } from '../../i18n'
import { usePersistentState } from '../../lib/usePersistentState'
import { useDisplayZone, setDisplayZone } from '../../lib/time'
import { toast } from '../Toast'
import { applyDensity, resolveDensity, storedDensity } from '../../lib/density'
import { UI_SCALE_KEY, UI_SCALE_OPTIONS, DEFAULT_UI_SCALE, parseUiScale, zoomFor } from '../../lib/uiScale'
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
  // The project name is the one name: the title bar and the picker show it, so
  // this field renames the project rather than keeping a second name in config.
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [projectName, setProjectName] = useState('')
  useEffect(() => {
    window.redlog.project.active().then((p) => {
      if (p) { setProject({ id: p.id, name: p.name ?? '' }); setProjectName(p.name ?? '') }
    }).catch(() => {})
  }, [])
  const commitProjectName = async (): Promise<void> => {
    const name = projectName.trim()
    if (!project || !name || name === project.name) { setProjectName(project?.name ?? ''); return }
    const res = await window.redlog.project.rename(project.id, name)
    const final = res.ok ? res.name ?? name : project.name
    setProject({ ...project, name: final })
    setProjectName(final)
    if (res.ok) window.dispatchEvent(new CustomEvent('redlog:project-renamed', { detail: final }))
  }

  return (
    <>
      {/* Two IDs and two names, and the labels alone do not say which reach
          the record. The engagement ID and the operator ID are stamped on
          every event; the two names are display strings, and one of them
          quietly renames the project. That is on the ⓘ rather than under the
          field — four lines of prose here would bury the four inputs. */}
      <FieldGroup title={t('settings.engagement')}>
        <Field label={t('settings.id')} value={config.engagement.id} onChange={() => {}} readOnly hint={t('settings.engagementIdHint')} />
        <Field label={t('settings.name')} value={projectName} onChange={setProjectName} onBlur={() => { void commitProjectName() }} hint={t('settings.engagementNameHint')} />
      </FieldGroup>
      <FieldGroup title={t('settings.operatorGroup')}>
        <Field label={t('settings.id')} value={config.operator.id} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, id: v } })} hint={t('settings.operatorIdHint')} />
        <Field label={t('settings.name')} value={config.operator.name} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, name: v } })} hint={t('settings.operatorNameHint')} />
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
      <div className="flex gap-2">
        {(['local', 'utc'] as const).map((z) => (
          <button
            key={z}
            aria-pressed={zone === z}
            onClick={() => setDisplayZone(z)}
            className={`px-3 py-1.5 text-xs rounded ${
              zone === z
                ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
                : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
            }`}
          >{t(z === 'local' ? 'settings.displayZoneLocal' : 'settings.displayZoneUtc')}</button>
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

