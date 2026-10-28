import { useEffect } from 'react'
import { FieldGroup, isMacOS, type ConfigState } from './SettingsShared'
import { CheckRow } from './CheckRow'

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
        <CheckRow
          inputTestId="settings-overlay-autoshow"
          checked={config.overlay?.autoShow !== false}
          onChange={(on) => setConfig({ ...config, overlay: { ...config.overlay, autoShow: on } })}
          label={t('settings.overlayAutoShow')}
        />
        <p className="text-xs text-redlog-text-faint mb-2">
          {isMacOS ? t('settings.overlayAutoShowHint') : t('settings.overlayAutoShowHintTray')}
        </p>
        <CheckRow
          checked={config.overlay?.showMarkButton !== false}
          onChange={(on) => setConfig({ ...config, overlay: { ...config.overlay, showMarkButton: on } })}
          label={t('settings.overlayShowMark')}
        />
        <CheckRow
          checked={config.overlay?.flashOnExposed !== false}
          onChange={(on) => setConfig({ ...config, overlay: { ...config.overlay, flashOnExposed: on } })}
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
            const cur = config.overlay?.scale ?? 1.0
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
                    setConfig({ ...config, overlay: { ...config.overlay, scale: v } })
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
                      onClick={() => setConfig({ ...config, overlay: { ...config.overlay, scale: s.v } })}
                    >{t(s.k)}</button>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>

        <CheckRow
          checked={config.overlay?.emphasizeExternalIp === true}
          onChange={(on) => setConfig({ ...config, overlay: { ...config.overlay, emphasizeExternalIp: on } })}
          label={t('settings.overlayEmphasizeIp')}
        />

        <CheckRow
          checked={config.overlay?.passThrough === true}
          onChange={setPassThrough}
          label={t('settings.overlayPassThrough')}
        />
        <p className="text-xs text-redlog-text-faint">
          {isMacOS ? t('settings.overlayPassThroughHint') : t('settings.overlayPassThroughHintTray')}
        </p>
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
              className="accent-red-600 w-40 h-8"
            />
            <span className="text-xs text-redlog-text-dim font-mono tabular-nums w-10">{Math.round((config.overlay?.passThroughOpacity ?? 0.4) * 100)}%</span>
          </div>
        )}

        {isMacOS && (
          <>
            <CheckRow
              checked={config.overlay?.showInDock !== false}
              onChange={(on) => setConfig({ ...config, overlay: { ...config.overlay, showInDock: on } })}
              label={t('settings.overlayShowInDock')}
            />
            <p className="text-xs text-redlog-text-faint">{t('settings.overlayShowInDockHint')}</p>
          </>
        )}
      </FieldGroup>
    </>
  )
}
