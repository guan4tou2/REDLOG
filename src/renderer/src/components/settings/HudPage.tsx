import { useEffect, useState } from 'react'
import { FieldGroup, isMacOS } from './SettingsShared'
import { CheckRow } from './CheckRow'
import type { HudPrefs } from '../../../../core/hud-prefs'

export default function HudPage({ t }: {
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  // Machine-wide, so read and written through their own IPC rather than the
  // project autosave. Every control that changes them — this page, the HUD
  // button, ⌘⇧P, the menu bar — announces the result, and this mirrors it.
  const [prefs, setPrefs] = useState<HudPrefs | null>(null)
  useEffect(() => {
    let live = true
    window.redlog.hudPrefs.get().then((p) => { if (live) setPrefs(p) }).catch(() => {})
    const off = window.redlog.hudPrefs.onChanged((p) => setPrefs(p))
    return () => { live = false; off() }
  }, [])
  if (!prefs) return null
  const set = (partial: Partial<HudPrefs>): void => {
    setPrefs({ ...prefs, ...partial })
    window.redlog.hudPrefs.set(partial).then(setPrefs).catch(() => {})
  }
  return (
    <>
      <FieldGroup title={t('settings.overlayGroup')}>
        <CheckRow
          inputTestId="settings-overlay-autoshow"
          checked={prefs.autoShow}
          onChange={(on) => set({ autoShow: on })}
          label={t('settings.overlayAutoShow')}
        />
        <p className="text-xs text-redlog-text-faint mb-2">
          {isMacOS ? t('settings.overlayAutoShowHint') : t('settings.overlayAutoShowHintTray')}
        </p>
        <CheckRow
          checked={prefs.showMarkButton}
          onChange={(on) => set({ showMarkButton: on })}
          label={t('settings.overlayShowMark')}
        />
        <CheckRow
          checked={prefs.flashOnExposed}
          onChange={(on) => set({ flashOnExposed: on })}
          label={t('settings.overlayFlashExposed')}
        />

        <div className="mt-3">
          <label htmlFor="hud-scale" className="text-xs text-redlog-text-dim block mb-1">{t('settings.overlayScale')}</label>
          {(() => {
            const stops = [
              { v: 0.75, k: 'settings.overlayScale.xs' },
              { v: 0.85, k: 'settings.overlayScale.small' },
              { v: 1.0, k: 'settings.overlayScale.normal' },
              { v: 1.25, k: 'settings.overlayScale.large' },
              { v: 1.5, k: 'settings.overlayScale.xlarge' },
              { v: 1.75, k: 'settings.overlayScale.xxl' }
            ]
            const cur = prefs.scale
            const nearest = stops.reduce((a, b) => Math.abs(cur - a.v) < Math.abs(cur - b.v) ? a : b)
            const index = stops.indexOf(nearest)
            return (
              <div className="px-5">
                <input
                  id="hud-scale"
                  type="range"
                  min={0}
                  max={stops.length - 1}
                  step={1}
                  value={index}
                  onChange={(e) => {
                    const v = stops[Number(e.target.value)].v
                    set({ scale: v })
                  }}
                  className="accent-red-600 w-full h-8"
                  list="hud-scale-stops"
                  aria-label={t('settings.overlayScale')}
                  aria-valuetext={t(nearest.k)}
                />
                <datalist id="hud-scale-stops">
                  {stops.map((s, i) => <option key={s.v} value={i} />)}
                </datalist>
                <div className="relative mx-2 h-8 mt-0.5">
                  {stops.map((s, i) => (
                    <button
                      type="button"
                      key={s.v}
                      aria-pressed={index === i}
                      style={{ left: `${i / (stops.length - 1) * 100}%` }}
                      className={`absolute -translate-x-1/2 whitespace-nowrap min-h-8 min-w-8 text-xs ${index === i ? 'text-red-400' : 'text-redlog-text-faint hover:text-redlog-text-dim'}`}
                      onClick={() => set({ scale: s.v })}
                    >{t(s.k)}</button>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>

        <CheckRow
          checked={prefs.emphasizeExternalIp}
          onChange={(on) => set({ emphasizeExternalIp: on })}
          label={t('settings.overlayEmphasizeIp')}
        />

        <CheckRow
          checked={prefs.passThrough}
          onChange={(on) => set({ passThrough: on })}
          label={t('settings.overlayPassThrough')}
        />
        <p className="text-xs text-redlog-text-faint">
          {isMacOS ? t('settings.overlayPassThroughHint') : t('settings.overlayPassThroughHintTray')}
        </p>
        {prefs.passThrough && (
          <div className="mt-2 flex items-center gap-3 pl-6">
            <span id="hud-passthrough-opacity" className="text-xs text-redlog-text-dim">{t('settings.overlayPassThroughOpacity')}</span>
            <input
              type="range"
              aria-labelledby="hud-passthrough-opacity"
              min="0.1"
              max="0.9"
              step="0.05"
              value={prefs.passThroughOpacity}
              onChange={(e) => set({ passThroughOpacity: parseFloat(e.target.value) })}
              className="accent-red-600 w-40 h-8"
            />
            <span className="text-xs text-redlog-text-dim font-mono tabular-nums w-10">{Math.round(prefs.passThroughOpacity * 100)}%</span>
          </div>
        )}

        {isMacOS && (
          <>
            <CheckRow
              checked={prefs.showInDock}
              onChange={(on) => set({ showInDock: on })}
              label={t('settings.overlayShowInDock')}
            />
            <p className="text-xs text-redlog-text-faint">{t('settings.overlayShowInDockHint')}</p>
          </>
        )}
      </FieldGroup>
    </>
  )
}
