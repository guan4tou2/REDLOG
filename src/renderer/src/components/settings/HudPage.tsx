import { useEffect } from 'react'
import { FieldGroup, isMacOS, type ConfigState } from './SettingsShared'

export default function HudPage({
  config, setConfig, t
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  // Pass-through is stored by overlay:setPassThrough whichever control changed
  // it — this box, the HUD button, ⌘⇧P, the menu bar — so mirror the change.
  useEffect(() => window.redlog?.overlay?.onPassThroughChanged?.((on) => {
    setConfig({ ...config, overlay: { ...config.overlay, passThrough: on } })
  }), [config, setConfig])
  const setPassThrough = (on: boolean): void => {
    setConfig({ ...config, overlay: { ...config.overlay, passThrough: on } })
    window.redlog.overlay.setPassThrough(on)
  }
  return (
    <>
      <FieldGroup title={t('settings.overlayGroup')}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.overlay?.showMarkButton !== false}
            onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, showMarkButton: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.overlayShowMark')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.overlayShowMarkHint')}</p>
        <label className="flex items-center gap-2 cursor-pointer mt-2">
          <input
            type="checkbox"
            checked={config.overlay?.flashOnExposed !== false}
            onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, flashOnExposed: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.overlayFlashExposed')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.overlayFlashExposedHint')}</p>

        <div className="mt-3">
          <label className="text-xs text-redlog-text-dim block mb-1">{t('settings.overlayScale')}</label>
          {(() => {
            const stops = [
              { v: 0.75, k: 'settings.overlayScale.xs' },
              { v: 0.85, k: 'settings.overlayScale.small' },
              { v: 1.0, k: 'settings.overlayScale.normal' },
              { v: 1.25, k: 'settings.overlayScale.large' },
              { v: 1.5, k: 'settings.overlayScale.xlarge' },
              { v: 1.75, k: 'settings.overlayScale.xxl' }
            ]
            const cur = config.overlay?.scale ?? 1.0
            const snap = (raw: number): number => {
              let best = stops[0].v
              for (const s of stops) { if (Math.abs(raw - s.v) < Math.abs(raw - best)) best = s.v }
              return best
            }
            const nearest = stops.reduce((a, b) => Math.abs(cur - a.v) < Math.abs(cur - b.v) ? a : b)
            return (
              <div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={stops[0].v}
                    max={stops[stops.length - 1].v}
                    step="0.05"
                    value={cur}
                    onChange={(e) => {
                      const v = snap(parseFloat(e.target.value))
                      setConfig({ ...config, overlay: { ...config.overlay, scale: v } })
                    }}
                    className="accent-red-600 flex-1"
                    list="hud-scale-stops"
                  />
                  <span className="text-xs text-redlog-text-dim font-mono tabular-nums w-14 text-right">{t(nearest.k)}</span>
                </div>
                <datalist id="hud-scale-stops">
                  {stops.map((s) => <option key={s.v} value={s.v} />)}
                </datalist>
                <div className="flex justify-between px-0.5 mt-0.5">
                  {stops.map((s) => (
                    <span
                      key={s.v}
                      className={`text-xs cursor-pointer ${Math.abs(cur - s.v) < 0.01 ? 'text-red-400' : 'text-redlog-text-faint hover:text-redlog-text-dim'}`}
                      onClick={() => setConfig({ ...config, overlay: { ...config.overlay, scale: s.v } })}
                    >{t(s.k)}</span>
                  ))}
                </div>
              </div>
            )
          })()}
          <p className="text-xs text-redlog-text-faint mt-1">{t('settings.overlayScaleHint')}</p>
        </div>

        <label className="flex items-center gap-2 cursor-pointer mt-3">
          <input
            type="checkbox"
            checked={config.overlay?.emphasizeExternalIp === true}
            onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, emphasizeExternalIp: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.overlayEmphasizeIp')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.overlayEmphasizeIpHint')}</p>

        <label className="flex items-center gap-2 cursor-pointer mt-3">
          <input
            type="checkbox"
            checked={config.overlay?.passThrough === true}
            onChange={(e) => setPassThrough(e.target.checked)}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.overlayPassThrough')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.overlayPassThroughHint')}</p>
        {config.overlay?.passThrough === true && (
          <div className="mt-2 flex items-center gap-3 pl-6">
            <span className="text-xs text-redlog-text-dim">{t('settings.overlayPassThroughOpacity')}</span>
            <input
              type="range"
              min="0.1"
              max="0.9"
              step="0.05"
              value={config.overlay?.passThroughOpacity ?? 0.4}
              onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, passThroughOpacity: parseFloat(e.target.value) } })}
              className="accent-red-600 w-40"
            />
            <span className="text-xs text-redlog-text-dim font-mono tabular-nums w-10">{Math.round((config.overlay?.passThroughOpacity ?? 0.4) * 100)}%</span>
          </div>
        )}

        {isMacOS && (
          <>
            <label className="flex items-center gap-2 cursor-pointer mt-2">
              <input
                type="checkbox"
                checked={config.overlay?.showInDock !== false}
                onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, showInDock: e.target.checked } })}
                className="accent-red-600"
              />
              <span className="text-xs text-redlog-text">{t('settings.overlayShowInDock')}</span>
            </label>
            <p className="text-xs text-redlog-text-faint">{t('settings.overlayShowInDockHint')}</p>
          </>
        )}
      </FieldGroup>
    </>
  )
}
