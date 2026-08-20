import { useState, useEffect, useRef } from 'react'
import { useI18n, type Locale } from '../i18n'
import { toast, toastDeferred } from './Toast'
import { raiseIssue, clearIssue } from '../lib/issues'
import { confirm as confirmDialog } from './ConfirmDialog'
import { setLastVerifyResult, type FullVerifyResult as CachedFullVerifyResult } from '../lib/verifyResultCache'
import WslPanel from './WslPanel'
import { DEFAULT_CDP_PORT } from '../lib/defaults'
import { applyDensity, resolveDensity, storedDensity } from '../lib/density'
import { formatDateTime } from '../lib/time'

// The Wi-Fi-name toggle only means anything on macOS (where the SSID is gated
// behind Location Services). Windows/Linux read the SSID directly, so the
// control is hidden there.
const isMacOS = (window as { redlog?: { platform?: string } }).redlog?.platform === 'darwin'
const isWindows = (window as { redlog?: { platform?: string } }).redlog?.platform === 'win32'

interface ConfigState {
  engagement: { id: string; name: string }
  operator: { id: string; name: string }
  network: { whitelist: string[]; blacklist: string[]; checkInterval: number; providers?: string[]; confirmations?: number; ipMode?: 'dns' | 'http' | 'auto'; showWifiName?: boolean; vpnAdapters?: Array<{ name: string; pattern: string; enabled: boolean }> }
  scope: { warnOnViolation?: boolean; targets: string[]; excludeTargets: string[]; scopeFile: string }
  screenshot: { quality: number }
  overlay?: { showMarkButton: boolean; showInDock?: boolean; flashOnExposed?: boolean; scale?: number; emphasizeExternalIp?: boolean; passThrough?: boolean; passThroughOpacity?: number }
  clipboard?: { enabled: boolean; pollMs?: number; storePreview?: boolean }
  fileWatcher?: { enabled: boolean; watchPaths?: string[]; ignorePatterns?: string[] }
  processMonitor?: { enabled: boolean; pollMs?: number; ignoreCommands?: string[] }
  browser?: {
    binary: string
    proxy: string
    cdpPort: number
    isolateProfile: boolean
    ignoreCertErrors: boolean
    startUrl: string
    extraArgs: string[]
  }
  deconfliction?: {
    enabled: boolean
    url: string
    secret: string
    events: string[]
    subtypes: string[]
    includeData: boolean
  }
  // v0.7.7 U1: Settings ▸ AI Agents surface for the built-in Claude Code
  // tailer. v0.8.0 will expand this into a list of installed tailer
  // plugins; the shape here (enabled + emitThinking) stays the "default"
  // per-plugin knob set going forward.
  agentTailer?: {
    enabled: boolean
    emitThinking?: boolean
  }
}

interface ManualStep {
  label: string
  command?: string
}

interface HookInfo {
  id: string
  name: string
  description: string
  agentType: string
  installed: boolean
  available: boolean
  installMethod: 'claude-settings' | 'shell-source' | 'manual'
  hookFile: string
  manualSteps?: ManualStep[]
}

const LOCALE_LABELS: Record<Locale, string> = {
  'en': 'English',
  'zh-TW': '繁體中文'
}

export default function Settings(): JSX.Element {
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [tab, setTab] = useState<'general' | 'hud' | 'capture' | 'network' | 'scope' | 'integrations' | 'data' | 'plugins'>('general')
  const [saved, setSaved] = useState(false)
  const [exportResult, setExportResult] = useState<string | null>(null)
  const [hooks, setHooks] = useState<HookInfo[]>([])
  const [hookLoading, setHookLoading] = useState<string | null>(null)
  const { t, locale, setLocale } = useI18n()

  useEffect(() => {
    window.redlog.config.get().then((c) => setConfig(c as ConfigState))
  }, [])

  // Auto-save on every change so toggles apply live to the HUD / event pipeline
  // without a manual "save & apply" click. Debounced 350ms so text-input typing
  // coalesces into a single write instead of one per keystroke. The initial
  // fetch is skipped by tracking whether we've seen a user-driven change.
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!config) return
    if (!dirty.current) { dirty.current = true; return }  // ignore the setConfig from the initial fetch
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.redlog.config.save(config).then(() => {
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      }).catch(() => {})
    }, 350)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])

  if (!config) return <div className="p-4 text-redlog-text-dim">{t('settings.loading')}</div>

  // v0.9.10: ten tabs down to eight, ordered by the question the operator is
  // actually asking rather than by when each feature was added.
  //   identity -> what gets recorded -> what's in bounds -> exposure ->
  //   display -> external tools -> retention -> extensions
  //
  // Two merges:
  //   · AI agent transcripts moved into Capture. It is a passive capture
  //     source exactly like the clipboard, the file watcher and the process
  //     monitor, all of which already live there; on its own it was a tab
  //     holding three checkboxes, which made it look like a subsystem rather
  //     than one source among several.
  //   · Marketplace folded into Plugins as a sub-tab. "What is installed" and
  //     "where to get more" are one task split across two top-level tabs.
  const tabs = [
    { id: 'general' as const, label: t('settings.general') },
    { id: 'capture' as const, label: t('settings.capture') },
    { id: 'scope' as const, label: t('settings.scope') },
    { id: 'network' as const, label: t('settings.networkIp') },
    { id: 'hud' as const, label: t('settings.hud') },
    { id: 'integrations' as const, label: t('settings.integrations') },
    { id: 'data' as const, label: t('settings.data') },
    { id: 'plugins' as const, label: t('settings.plugins') }
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-redlog-border shrink-0">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              tab === tb.id ? 'bg-redlog-elevated text-white' : 'text-redlog-text-dim hover:text-redlog-text'
            }`}
          >
            {tb.label}
          </button>
        ))}
        {saved && <span className="ml-auto text-green-400 text-xs">{t('settings.saved')}</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tab === 'general' && (
          <>
            <FieldGroup title={t('settings.engagement')}>
              <Field label={t('settings.id')} value={config.engagement.id} onChange={(v) => setConfig({ ...config, engagement: { ...config.engagement, id: v } })} />
              <Field label={t('settings.name')} value={config.engagement.name} onChange={(v) => setConfig({ ...config, engagement: { ...config.engagement, name: v } })} />
            </FieldGroup>
            <FieldGroup title={t('settings.operatorGroup')}>
              <Field label={t('settings.id')} value={config.operator.id} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, id: v } })} />
              <Field label={t('settings.name')} value={config.operator.name} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, name: v } })} />
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
          </>
        )}

        {tab === 'integrations' && (
          <>
            <McpPanel t={t} />
            <HookWatchPathsPanel t={t} />
            <OperatorsPanel t={t} />
            <DeconflictionPanel t={t} config={config} setConfig={setConfig} />
            <BrowserPanel t={t} config={config} setConfig={setConfig} />
            <FieldGroup title={t('settings.cdp')}>
              <p className="text-xs text-redlog-text-faint mb-2">
                {t('settings.cdpHint', { port: String(config.browser?.cdpPort ?? DEFAULT_CDP_PORT) })}
              </p>
              <button
                onClick={async () => {
                  // Uses the CDP port from BrowserPanel above (config.browser.
                  // cdpPort) — the previous separate field silently didn't
                  // auto-save so users often set two different ports without
                  // knowing (audit finding P0 #43).
                  const port = config.browser?.cdpPort ?? DEFAULT_CDP_PORT
                  await window.redlog.cdp.setPort(port)
                  const cdpTab = await window.redlog.cdp.getTab()
                  if (cdpTab.connected) toast(t('settings.cdpConnected', { title: cdpTab.title, url: cdpTab.url }), 'success')
                  else {
                    toast(t('settings.cdpNotConnectedTitle'), {
                      type: 'error',
                      why: t('settings.cdpNotConnected', { port: String(port) }),
                      action: { label: t('common.retry'), onClick: () => { void window.redlog.cdp.getTab() } }
                    })
                  }
                }}
                className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
              >
                {t('settings.testConnection')}
              </button>
            </FieldGroup>
          </>
        )}

        {tab === 'network' && (
          <>
            <FieldGroup title={t('settings.ipSafety')}>
              <ListField
                label={t('settings.whitelist')}
                items={config.network.whitelist}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, whitelist: items } })}
                placeholder={t('settings.safeIpPlaceholder')}
              />
              <ListField
                label={t('settings.blacklist')}
                items={config.network.blacklist}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, blacklist: items } })}
                placeholder={t('settings.exposedIpPlaceholder')}
              />
            </FieldGroup>
            <FieldGroup title={t('settings.polling')}>
              <div>
                <label className="block text-xs text-redlog-text-dim mb-1">{t('settings.ipMode')}</label>
                <div className="flex gap-1">
                  {(['auto', 'dns', 'http'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setConfig({ ...config, network: { ...config.network, ipMode: m } })}
                      className={`px-3 py-1 text-xs rounded transition-colors ${
                        (config.network.ipMode ?? 'auto') === m ? 'bg-redlog-elevated text-redlog-text border border-redlog-border' : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
                      }`}
                    >
                      {t(`settings.ipMode.${m}`)}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-redlog-text-faint mt-1">{t('settings.ipModeHint')}</p>
              </div>
              {isMacOS && (
                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={config.network.showWifiName ?? false}
                      onChange={(e) => {
                        const on = e.target.checked
                        setConfig({ ...config, network: { ...config.network, showWifiName: on } })
                        // Trigger the macOS Location Services prompt; once granted,
                        // the OS un-redacts the SSID for the next network poll.
                        if (on && navigator.geolocation) {
                          navigator.geolocation.getCurrentPosition(() => {}, () => {}, { timeout: 10000, maximumAge: 0 })
                        }
                      }}
                      className="accent-red-600"
                    />
                    <span className="text-xs text-redlog-text">{t('settings.showWifiName')}</span>
                  </label>
                  <p className="text-xs text-redlog-text-faint mt-1">{t('settings.showWifiNameHint')}</p>
                </div>
              )}
              <Field
                label={t('settings.checkInterval')}
                value={String(config.network.checkInterval)}
                onChange={(v) => setConfig({ ...config, network: { ...config.network, checkInterval: parseInt(v) || 60 } })}
                type="number"
              />
              <p className="text-xs text-amber-600/80">{t('settings.pollingOpsecHint')}</p>
              <Field
                label={t('settings.confirmations')}
                value={String(config.network.confirmations ?? 3)}
                onChange={(v) => setConfig({ ...config, network: { ...config.network, confirmations: Math.max(1, parseInt(v) || 3) } })}
                type="number"
              />
              <p className="text-xs text-redlog-text-faint">{t('settings.confirmationsHint')}</p>
              <ListField
                label={t('settings.ipProviders')}
                items={config.network.providers ?? []}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, providers: items } })}
                placeholder="https://ip.internal.example/json"
              />
              <p className="text-xs text-redlog-text-faint">{t('settings.ipProvidersHint')}</p>
            </FieldGroup>
            <VpnAdaptersField config={config} setConfig={setConfig} />
          </>
        )}

        {tab === 'hud' && (
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
                  onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, passThrough: e.target.checked } })}
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
        )}

        {tab === 'capture' && (
          <>
            <HooksPanel hooks={hooks} setHooks={setHooks} hookLoading={hookLoading} setHookLoading={setHookLoading} t={t} />
            {isWindows && <WslPanel t={t} />}
            <AgentsPanel t={t} config={config} setConfig={setConfig} />
            <FieldGroup title={t('settings.screenshotQuality')}>
              <Field
                label={t('settings.jpegQuality')}
                value={String(config.screenshot?.quality ?? 85)}
                onChange={(v) => setConfig({ ...config, screenshot: { ...config.screenshot, quality: Math.min(100, Math.max(1, parseInt(v) || 85)) } })}
                type="number"
              />
              <p className="text-xs text-redlog-text-faint">
                {t('settings.qualityHint')}
              </p>
            </FieldGroup>
            <FieldGroup title={t('settings.clipboardGroup')}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.clipboard?.enabled === true}
                  onChange={(e) => setConfig({ ...config, clipboard: { ...config.clipboard, enabled: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-redlog-text">{t('settings.clipboardEnable')}</span>
              </label>
              <p className="text-xs text-redlog-text-faint">{t('settings.clipboardEnableHint')}</p>
              {config.clipboard?.enabled && (
                <label className="flex items-center gap-2 cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    checked={config.clipboard?.storePreview === true}
                    onChange={(e) => setConfig({ ...config, clipboard: { ...config.clipboard, enabled: true, storePreview: e.target.checked } })}
                    className="accent-red-600"
                  />
                  <span className="text-xs text-redlog-text">{t('settings.clipboardStorePreview')}</span>
                </label>
              )}
              {config.clipboard?.enabled && (
                <p className="text-xs text-redlog-text-faint">{t('settings.clipboardStorePreviewHint')}</p>
              )}
            </FieldGroup>
            <FieldGroup title={t('settings.fileWatcherGroup')}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.fileWatcher?.enabled === true}
                  onChange={(e) => setConfig({ ...config, fileWatcher: { ...config.fileWatcher, enabled: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-redlog-text">{t('settings.fileWatcherEnable')}</span>
              </label>
              <p className="text-xs text-redlog-text-faint">{t('settings.fileWatcherEnableHint')}</p>
              {config.fileWatcher?.enabled && (
                <>
                  <ListField
                    label={t('settings.fileWatcherPaths')}
                    items={config.fileWatcher?.watchPaths ?? []}
                    onChange={(items) => setConfig({ ...config, fileWatcher: { ...config.fileWatcher, enabled: true, watchPaths: items } })}
                    placeholder={t('settings.fileWatcherPathsPlaceholder')}
                  />
                  <ListField
                    label={t('settings.fileWatcherIgnore')}
                    items={config.fileWatcher?.ignorePatterns ?? []}
                    onChange={(items) => setConfig({ ...config, fileWatcher: { ...config.fileWatcher, enabled: true, ignorePatterns: items } })}
                    placeholder={t('settings.fileWatcherIgnorePlaceholder')}
                  />
                  <p className="text-xs text-redlog-text-faint">{t('settings.fileWatcherIgnoreHint')}</p>
                </>
              )}
            </FieldGroup>
            <FieldGroup title={t('settings.processMonitorGroup')}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.processMonitor?.enabled === true}
                  onChange={(e) => setConfig({ ...config, processMonitor: { ...config.processMonitor, enabled: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-redlog-text">{t('settings.processMonitorEnable')}</span>
              </label>
              <p className="text-xs text-redlog-text-faint">{t('settings.processMonitorEnableHint')}</p>
              {config.processMonitor?.enabled && (
                <>
                  <ListField
                    label={t('settings.processMonitorIgnore')}
                    items={config.processMonitor?.ignoreCommands ?? []}
                    onChange={(items) => setConfig({ ...config, processMonitor: { ...config.processMonitor, enabled: true, ignoreCommands: items } })}
                    placeholder={t('settings.processMonitorIgnorePlaceholder')}
                  />
                  <p className="text-xs text-redlog-text-faint">{t('settings.processMonitorIgnoreHint')}</p>
                </>
              )}
            </FieldGroup>
          </>
        )}

        {tab === 'data' && (
          <>
            <FieldGroup title={t('settings.screenshotGroup')}>
              <div className="flex items-center gap-2 flex-wrap">
                {[
                  { v: 0, k: 'settings.screenshot.interval.off' },
                  { v: 30, k: 'settings.screenshot.interval.30s' },
                  { v: 60, k: 'settings.screenshot.interval.60s' },
                  { v: 300, k: 'settings.screenshot.interval.5m' }
                ].map((opt) => (
                  <button
                    key={opt.v}
                    onClick={() => setConfig({ ...config, screenshot: { ...config.screenshot, intervalSec: opt.v } })}
                    className={`px-3 py-1 text-xs rounded ${
                      (config.screenshot.intervalSec ?? 0) === opt.v
                        ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
                        : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
                    }`}
                  >{t(opt.k)}</button>
                ))}
              </div>
              <p className="text-xs text-redlog-text-faint mt-2">{t('settings.screenshot.intervalHint')}</p>
            </FieldGroup>
            <FieldGroup title={t('settings.updateGroup')}>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => window.redlog.app.checkForUpdates()}
                  className="px-3 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover transition-colors"
                >
                  {t('settings.checkUpdate')}
                </button>
                <span className="text-xs text-redlog-text-faint font-mono">v{__APP_VERSION__}</span>
              </div>
              <p className="text-xs text-redlog-text-faint">{t('settings.checkUpdateHint')}</p>
            </FieldGroup>
            <FieldGroup title={t('settings.exportAll')}>
              <button
                onClick={async () => {
                  const path = await window.redlog.data.exportJson()
                  setExportResult(path ? t('settings.savedTo', { path }) : t('settings.exportFailed'))
                  setTimeout(() => setExportResult(null), 5000)
                }}
                className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
              >
                {t('settings.exportJson')}
              </button>
              {exportResult && <p className="text-xs text-redlog-text-dim font-mono mt-1 break-all">{exportResult}</p>}
              <p className="text-xs text-redlog-text-faint">
                {t('settings.exportHint')}
              </p>
            </FieldGroup>
            <ExportBundlePanel t={t} />
            <FieldGroup title={t('settings.scopeExport')}>
              <button
                onClick={async () => {
                  const p = await (window.redlog.data as { exportScopeFiltered: () => Promise<string | null> }).exportScopeFiltered()
                  setExportResult(p ? t('settings.savedTo', { path: p }) : t('settings.exportFailed'))
                  if (p) toast(t('toast.scopeExported'), 'success')
                  setTimeout(() => setExportResult(null), 5000)
                }}
                className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
              >
                {t('settings.exportScopeJson')}
              </button>
              <p className="text-xs text-redlog-text-faint">
                {t('settings.scopeExportHint')}
              </p>
            </FieldGroup>
            <CloudSharePanel t={t} />
            <IntegrityPanel t={t} />
            <FieldGroup title={t('settings.profileSync')}>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    const path = await window.redlog.config.exportProfile()
                    if (path) toast(t('toast.profileExported'), 'success')
                  }}
                  className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
                >
                  {t('settings.exportProfile')}
                </button>
                <button
                  onClick={async () => {
                    const profile = await window.redlog.config.importProfile() as Record<string, unknown> | null
                    if (profile) {
                      setConfig(profile as unknown as ConfigState)
                      toast(t('toast.profileImported'), 'success')
                    }
                  }}
                  className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
                >
                  {t('settings.importProfile')}
                </button>
              </div>
              <p className="text-xs text-redlog-text-faint">
                {t('settings.profileHint')}
              </p>
            </FieldGroup>
          </>
        )}

        {tab === 'scope' && (
          <>
            <FieldGroup title={t('settings.scopeEnforcement')}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.scope.warnOnViolation !== false}
                  onChange={(e) => setConfig({ ...config, scope: { ...config.scope, warnOnViolation: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-redlog-text">{t('settings.warnOnViolation')}</span>
              </label>
              <p className="text-xs text-redlog-text-faint mt-1 leading-relaxed">{t('settings.warnOnViolationHint')}</p>
            </FieldGroup>
            <FieldGroup title={t('settings.inScopeTargets')}>
              <ListField
                label={t('settings.targetsLabel')}
                items={config.scope.targets}
                onChange={(items) => setConfig({ ...config, scope: { ...config.scope, targets: items } })}
                placeholder={t('settings.targetsPlaceholder')}
              />
            </FieldGroup>
            <FieldGroup title={t('settings.excludedTargets')}>
              <ListField
                label={t('settings.excludeLabel')}
                items={config.scope.excludeTargets}
                onChange={(items) => setConfig({ ...config, scope: { ...config.scope, excludeTargets: items } })}
                placeholder={t('settings.excludePlaceholder')}
              />
            </FieldGroup>
            <FieldGroup title={t('settings.scopeFile')}>
              <Field
                label={t('settings.scopeFileLabel')}
                value={config.scope.scopeFile || ''}
                onChange={(v) => setConfig({ ...config, scope: { ...config.scope, scopeFile: v } })}
              />
              <p className="text-xs text-redlog-text-faint">
                {t('settings.scopeFileHint')}
              </p>
            </FieldGroup>
          </>
        )}
        {tab === 'plugins' && <PluginsTab t={t} />}
      </div>

      <div className="px-4 py-3 border-t border-redlog-border shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              // Auto-save already writes on every change; this is now a
              // "force save now" escape hatch — useful if the user wants to
              // flush before the 350ms debounce window closes.
              if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
              await window.redlog.config.save(config)
              setSaved(true)
              setTimeout(() => setSaved(false), 1500)
            }}
            className="px-4 py-1.5 bg-redlog-danger text-white hover:bg-redlog-danger-hover text-xs rounded transition-colors"
          >
            {t('settings.save')}
          </button>
          <span className="text-redlog-text-faint text-xs">{t('settings.autoSaveHint')}</span>
        </div>
      </div>
    </div>
  )
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-wider">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; type?: string
}): JSX.Element {
  return (
    <div>
      <label className="text-xs text-redlog-text-dim block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-redlog-surface border border-redlog-border rounded px-2 py-1.5 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
      />
    </div>
  )
}

function HooksPanel({ hooks, setHooks, hookLoading, setHookLoading, t }: {
  hooks: HookInfo[]
  setHooks: (h: HookInfo[]) => void
  hookLoading: string | null
  setHookLoading: (id: string | null) => void
  t: (key: string) => string
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect().then(setHooks)
  }, [])

  const copy = (text: string): void => {
    navigator.clipboard.writeText(text)
    toast(t('toast.copied'), 'success')
  }

  const handleToggle = async (hook: HookInfo): Promise<void> => {
    const hooksApi = (window.redlog as { hooks: { install: (id: string) => Promise<{ success: boolean; message: string }>; uninstall: (id: string) => Promise<{ success: boolean; message: string }> } }).hooks
    // Removing a hook blinds a capture source, and a blind source is only
    // discovered later, in the gap it left in the timeline. §10 defers it:
    // the row reads as uninstalled at once, the profile is not touched until
    // the undo window closes, and an undo inside it leaves no audit entry.
    if (hook.installed) {
      setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, installed: false } : h)))
      toastDeferred(
        t('settings.hookRemoved', { name: hook.id }),
        () => {
          void hooksApi.uninstall(hook.id).then(async (r) => {
            if (!r.success) {
              toast(t('settings.hookUninstallFailed', { name: hook.id }), {
                type: 'error', why: t('settings.hookFailedWhy'), detail: r.message
              })
            }
            setHooks(await (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect())
          })
        },
        {
          type: 'warning',
          why: t('settings.hookRemovedWhy'),
          revert: () => setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, installed: true } : h)))
        }
      )
      return
    }
    setHookLoading(hook.id)
    const result = await hooksApi.install(hook.id)
    if (result.success) toast(result.message, 'success')
    else {
      toast(t('settings.hookInstallFailed', { name: hook.id }), {
        type: 'error',
        why: t('settings.hookFailedWhy'),
        detail: result.message,
        action: { label: t('common.retry'), onClick: () => { void handleToggle(hook) } }
      })
    }
    const updated = await (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect()
    setHooks(updated)
    setHookLoading(null)
  }

  return (
    <>
      <FieldGroup title={t('settings.hooksDetected')}>
        <p className="text-xs text-redlog-text-faint mb-2">
          {t('settings.hooksHint')}
        </p>
        {hooks.length === 0 && (
          <p className="text-redlog-text-dim text-xs">{t('common.loading')}</p>
        )}
        <div className="space-y-2">
          {hooks.map((hook) => {
            const isManual = hook.installMethod === 'manual'
            const hasSteps = isManual && !!hook.manualSteps?.length
            const isOpen = expanded === hook.id
            return (
              <div
                key={hook.id}
                className={`rounded border ${
                  hook.available ? 'border-redlog-border bg-redlog-surface/50'
                    : isManual ? 'border-redlog-border bg-redlog-surface/30 opacity-75'
                    : 'border-redlog-border bg-redlog-surface/20 opacity-50'
                }`}
              >
                <div className="flex items-center justify-between p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-redlog-text">{hook.name}</span>
                      {hook.installed && (
                        <span className="text-xs bg-green-900/50 text-green-400 px-1.5 py-0.5 rounded">
                          {t('settings.hookActive')}
                        </span>
                      )}
                      {isManual && (
                        <span className="text-xs bg-redlog-elevated text-redlog-text-dim px-1.5 py-0.5 rounded">
                          {t('settings.hookManual')}
                        </span>
                      )}
                      {!hook.available && (
                        <span className="text-xs bg-redlog-elevated text-redlog-text-dim px-1.5 py-0.5 rounded">
                          {t('settings.hookNotFound')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-redlog-text-dim mt-0.5">{hook.description}</p>
                  </div>
                  {hook.available && hook.installMethod !== 'manual' && (
                    <button
                      disabled={hookLoading === hook.id}
                      onClick={() => handleToggle(hook)}
                      className={`px-3 py-1 text-xs rounded ml-3 transition-colors ${
                        hook.installed
                          ? 'bg-redlog-elevated text-redlog-text-dim hover:bg-red-900/30 hover:text-red-400'
                          : 'bg-redlog-danger text-white hover:bg-redlog-danger-hover'
                      } ${hookLoading === hook.id ? 'opacity-50' : ''}`}
                    >
                      {hookLoading === hook.id ? '...' : hook.installed ? t('settings.hookDisable') : t('settings.hookEnable')}
                    </button>
                  )}
                  {hasSteps && (
                    <button
                      onClick={() => setExpanded(isOpen ? null : hook.id)}
                      className="px-3 py-1 text-xs rounded ml-3 bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover transition-colors shrink-0"
                    >
                      {isOpen ? t('settings.hookHideSetup') : t('settings.hookShowSetup')}
                    </button>
                  )}
                </div>
                {hasSteps && isOpen && (
                  <div className="border-t border-redlog-border px-3 py-2.5 space-y-2.5">
                    {hook.manualSteps!.map((step, i) => (
                      <div key={i}>
                        <p className="text-xs text-redlog-text-dim leading-relaxed">
                          <span className="text-redlog-text-dim">{i + 1}.</span> {step.label}
                        </p>
                        {step.command && (
                          <div className="flex items-center gap-2 mt-1">
                            <code title={step.command} className="flex-1 min-w-0 truncate bg-redlog-bg border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono">
                              {step.command}
                            </code>
                            <button
                              onClick={() => copy(step.command!)}
                              className="text-xs px-2 py-1 rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover transition-colors shrink-0"
                            >
                              {t('settings.hookCopy')}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    <p className="text-xs text-redlog-text-faint pt-0.5">{t('settings.hookManualNote')}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </FieldGroup>
    </>
  )
}

interface PluginView {
  id: string
  name: string
  version: string
  description: string
  author: string
  source: 'bundled' | 'user'
  tier: 'declarative' | 'privileged'
  status: 'active' | 'needs-consent' | 'hash-changed' | 'disabled' | 'error'
  capabilities: string[]
  contributes: string[]
  error?: string
}

/** v0.9.10: Plugins and Marketplace were separate top-level tabs, but they are
 *  one task — "what do I have" and "what can I get" — and the operator moves
 *  between them constantly while installing something. Sub-tabs keep both a
 *  click away without spending two of the eight top-level slots. */
function PluginsTab({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [sub, setSub] = useState<'installed' | 'marketplace'>('installed')
  return (
    <>
      <div className="flex gap-1 mb-3">
        {([['installed', t('settings.plugins')], ['marketplace', t('settings.marketplace')]] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSub(id)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              sub === id ? 'bg-redlog-elevated-hover text-redlog-text' : 'bg-redlog-surface text-redlog-text-dim hover:text-redlog-text'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {sub === 'installed' ? <PluginsPanel t={t} /> : <MarketplacePanel t={t} />}
    </>
  )
}

function PluginsPanel({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [plugins, setPlugins] = useState<PluginView[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmGrant, setConfirmGrant] = useState<PluginView | null>(null)

  const api = (window.redlog as unknown as { plugins: {
    list: () => Promise<PluginView[]>
    reload: () => Promise<PluginView[]>
    openFolder: () => Promise<string>
    setEnabled: (id: string, enabled: boolean) => Promise<PluginView[]>
    grant: (id: string) => Promise<{ ok: boolean; error?: string; plugins: PluginView[] }>
    revoke: (id: string) => Promise<PluginView[]>
  } }).plugins

  useEffect(() => { api.list().then(setPlugins) }, [])

  const doReload = async (): Promise<void> => { setBusy('*'); setPlugins(await api.reload()); setBusy(null) }
  const toggle = async (p: PluginView, enabled: boolean): Promise<void> => {
    // Enabling is the recoverable direction and takes effect at once.
    if (enabled) {
      setBusy(p.id); setPlugins(await api.setEnabled(p.id, true)); setBusy(null)
      return
    }
    // Disabling stops a capture source and writes `system.config_changed`, so
    // §10 gives it a window and defers the *write*, not just the undo: the
    // list shows the plugin as disabled immediately, but nothing is persisted
    // until the eight seconds are up. An operator who catches their own
    // mistake inside the window leaves no trace of it in the audit log —
    // which is the point, since that log is evidence.
    setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: 'disabled' } : x)))
    toastDeferred(
      t('plugins.disabled', { name: p.name }),
      () => { void api.setEnabled(p.id, false).then(setPlugins) },
      {
        type: 'warning',
        why: t('plugins.disabledWhy'),
        revert: () => setPlugins((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: p.status } : x)))
      }
    )
  }
  const grant = async (p: PluginView): Promise<void> => {
    setBusy(p.id); setConfirmGrant(null)
    const r = await api.grant(p.id)
    setPlugins(r.plugins); setBusy(null)
    if (r.ok) toast(t('plugins.granted'), 'success')
    else {
      toast(t('plugins.grantFailed', { name: p.id }), {
        type: 'error',
        why: t('plugins.grantFailedWhy'),
        detail: r.error
      })
    }
  }
  const revoke = async (p: PluginView): Promise<void> => { setBusy(p.id); setPlugins(await api.revoke(p.id)); setBusy(null) }

  const STATUS_STYLE: Record<PluginView['status'], string> = {
    active: 'bg-green-900/50 text-green-400',
    'needs-consent': 'bg-amber-900/50 text-amber-400',
    'hash-changed': 'bg-amber-900/50 text-amber-400',
    disabled: 'bg-redlog-elevated text-redlog-text-dim',
    error: 'bg-red-900/50 text-red-400'
  }

  return (
    <FieldGroup title={t('settings.plugins')}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <p className="text-xs text-redlog-text-faint flex-1 pr-3">{t('plugins.hint')}</p>
        <button onClick={() => api.openFolder()}
          className="px-2.5 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover shrink-0"
          title={t('plugins.openFolderHint')}>
          {t('plugins.openFolder')}
        </button>
        <button onClick={doReload} disabled={busy === '*'}
          className="px-2.5 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover shrink-0">
          {busy === '*' ? '…' : t('plugins.reload')}
        </button>
      </div>

      {plugins.length === 0 && (
        <p className="text-xs text-redlog-text-faint py-3">{t('plugins.empty')}</p>
      )}

      <div className="space-y-2">
        {plugins.map((p) => {
          const privileged = p.tier === 'privileged'
          const needsConsent = p.status === 'needs-consent' || p.status === 'hash-changed'
          return (
            <div key={p.id} className="rounded border border-redlog-border bg-redlog-surface/50">
              <div className="flex items-start justify-between p-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-redlog-text">{p.name}</span>
                    <span className="text-xs text-redlog-text-dim">v{p.version}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${STATUS_STYLE[p.status]}`}>
                      {t(`plugins.status.${p.status}`)}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${privileged ? 'bg-red-950/60 text-red-300' : 'bg-green-950/60 text-green-300'}`}>
                      {privileged ? t('plugins.tier.privileged') : t('plugins.tier.declarative')}
                    </span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim">{p.source}</span>
                  </div>
                  {p.description && <p className="text-xs text-redlog-text-dim mt-0.5">{p.description}</p>}
                  {p.contributes.length > 0 && (
                    <p className="text-xs text-redlog-text-faint mt-1">{t('plugins.contributes')}: {p.contributes.join(', ')}</p>
                  )}
                  {privileged && p.capabilities.length > 0 && (
                    <p className="text-xs text-amber-500/80 mt-0.5">{t('plugins.capabilities')}: {p.capabilities.join(', ')}</p>
                  )}
                  {p.status === 'error' && p.error && <p className="text-xs text-red-400 mt-0.5">{p.error}</p>}
                </div>

                <div className="ml-3 shrink-0 flex flex-col gap-1 items-end">
                  {/* declarative (or already-trusted privileged): enable/disable */}
                  {p.status !== 'error' && !needsConsent && (
                    <button
                      disabled={busy === p.id}
                      onClick={() => toggle(p, p.status === 'disabled')}
                      className={`px-3 py-1 text-xs rounded ${
                        p.status === 'disabled' ? 'bg-redlog-danger text-white hover:bg-redlog-danger-hover' : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
                      }`}
                    >
                      {busy === p.id ? '…' : p.status === 'disabled' ? t('plugins.enable') : t('plugins.disable')}
                    </button>
                  )}
                  {/* privileged awaiting consent */}
                  {needsConsent && (
                    <button
                      disabled={busy === p.id}
                      onClick={() => setConfirmGrant(p)}
                      className="px-3 py-1 text-xs rounded bg-amber-600/80 text-white hover:bg-amber-600"
                    >
                      {t('plugins.review')}
                    </button>
                  )}
                  {/* trusted privileged: allow revoke */}
                  {privileged && p.status === 'active' && (
                    <button onClick={() => revoke(p)} disabled={busy === p.id}
                      className="px-3 py-1 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:bg-red-900/30 hover:text-red-400">
                      {t('plugins.revoke')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-xs text-redlog-text-faint mt-3">{t('plugins.dir')}</p>

      {/* trust consent dialog for 🔴 code plugins */}
      {confirmGrant && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmGrant(null)}>
          <div className="bg-redlog-surface border border-red-900/50 rounded-lg p-4 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-red-400 mb-1">{t('plugins.consentTitle')}</h3>
            <p className="text-xs text-redlog-text-dim mb-2">
              {t('plugins.consentBody', { name: confirmGrant.name })}
            </p>
            <div className="bg-redlog-bg border border-redlog-border rounded p-2 mb-2">
              <p className="text-xs text-redlog-text-dim mb-1">{t('plugins.capabilities')}:</p>
              <ul className="text-xs text-amber-400 space-y-0.5">
                {confirmGrant.capabilities.length === 0 && <li className="text-redlog-text-dim">—</li>}
                {confirmGrant.capabilities.map((c) => <li key={c}>• {c}</li>)}
              </ul>
            </div>
            <p className="text-xs text-redlog-text-dim mb-3">{t('plugins.consentWarn')}</p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setConfirmGrant(null)} className="px-3 py-1 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover">
                {t('common.cancel')}
              </button>
              <button onClick={() => grant(confirmGrant)} className="px-3 py-1 text-xs rounded bg-redlog-danger text-white hover:bg-redlog-danger-hover">
                {t('plugins.grantRun')}
              </button>
            </div>
          </div>
        </div>
      )}
    </FieldGroup>
  )
}

function BrowserPanel({
  t, config, setConfig
}: {
  t: (key: string, vars?: Record<string, string | number>) => string
  config: ConfigState
  setConfig: (c: ConfigState) => void
}): JSX.Element {
  const b = config.browser ?? {
    binary: '', proxy: 'http://127.0.0.1:8080', cdpPort: DEFAULT_CDP_PORT,
    isolateProfile: true, ignoreCertErrors: true, startUrl: '', extraArgs: []
  }
  const [detected, setDetected] = useState<string | null>(null)

  useEffect(() => {
    window.redlog.browser.detect().then(setDetected).catch(() => setDetected(null))
  }, [])

  const patch = (delta: Partial<typeof b>): void => {
    setConfig({ ...config, browser: { ...b, ...delta } })
  }

  return (
    <FieldGroup title={t('settings.browser')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.browserHint')}</p>
      <Field label={t('settings.browserBinary')} value={b.binary} onChange={(v) => patch({ binary: v })} />
      <p className="text-xs text-redlog-text-faint font-mono break-all">
        {detected ? t('settings.browserDetected', { path: detected }) : t('settings.browserNotFound')}
      </p>
      <Field label={t('settings.browserProxy')} value={b.proxy} onChange={(v) => patch({ proxy: v })} />
      <Field
        label={t('settings.cdpPort')}
        value={String(b.cdpPort)}
        onChange={(v) => patch({ cdpPort: parseInt(v) || DEFAULT_CDP_PORT })}
        type="number"
      />
      <Field label={t('settings.browserStartUrl')} value={b.startUrl} onChange={(v) => patch({ startUrl: v })} />
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={b.isolateProfile}
          onChange={(e) => patch({ isolateProfile: e.target.checked })}
          className="accent-red-600"
        />
        <span className="text-xs text-redlog-text-dim">{t('settings.browserIsolate')}</span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={b.ignoreCertErrors}
          onChange={(e) => patch({ ignoreCertErrors: e.target.checked })}
          className="accent-red-600"
        />
        <span className="text-xs text-redlog-text-dim">{t('settings.browserIgnoreCert')}</span>
      </label>
      <button
        onClick={async () => {
          const r = await window.redlog.browser.launch()
          toast(r.ok ? t('browser.launched') : (r.error || t('browser.failed')), r.ok ? 'success' : 'error')
        }}
        className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
      >
        {t('browser.launch')}
      </button>
    </FieldGroup>
  )
}

interface FullVerifyResult {
  ok: boolean
  walked?: number
  brokenAtEventId?: string | null
  brokenReason?: string | null
  currentHead?: string | null
  anchor?: ChainAnchorInfo | null
  anchorMatchesWalkedHead?: boolean
  clockAnomalies?: Array<{ eventId: string; reason: string }>
  signedCount?: number
  unsignedCount?: number
  badSignatureAtEventId?: string | null
}

// v0.6.94 D: renderer-side wrapper around data:exportBundle. Builds a sanitized
// evidence pack via src/core/bundle-export.ts (same code path as the CLI +
// MCP tool) and surfaces the resulting directory with a Reveal button so the
// operator can zip it up and hand-deliver. Building is synchronous inside the
// main process (walks events.jsonl + hashes screenshots), so the button
// disables itself with a "Building..." label until IPC returns.
function ExportBundlePanel({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ path: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const dataApi = window.redlog.data as { exportBundle?: () => Promise<{ ok?: boolean; outDir?: string; error?: string } | null> }
      if (!dataApi.exportBundle) {
        setError(t('settings.exportFailed'))
        setBusy(false)
        return
      }
      const r = await dataApi.exportBundle()
      if (!r) {
        setError(t('settings.exportFailed'))
      } else if (r.ok === false || !r.outDir) {
        setError(r.error || t('settings.exportFailed'))
      } else {
        setResult({ path: r.outDir })
        toast(t('toast.bundleExported'), 'success')
      }
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleReveal = async (): Promise<void> => {
    if (!result?.path) return
    const dataApi = window.redlog.data as { revealPath?: (p: string) => Promise<boolean> }
    if (dataApi.revealPath) await dataApi.revealPath(result.path)
  }

  return (
    <FieldGroup title={t('settings.exportBundleTitle')}>
      <div className="flex items-center gap-2">
        <button
          data-testid="settings-export-bundle"
          onClick={handleExport}
          disabled={busy}
          className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? t('settings.exportBundleBuilding') : t('settings.exportBundle')}
        </button>
        {result && (
          <button
            onClick={handleReveal}
            className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
          >
            {t('settings.exportBundleReveal')}
          </button>
        )}
      </div>
      {result && (
        <p className="text-xs text-redlog-text-dim font-mono mt-1 break-all">
          {t('settings.savedTo', { path: result.path })}
        </p>
      )}
      {error && (
        <div className="mt-1 text-xs text-red-400 border border-red-900/60 bg-red-950/40 rounded px-2 py-1 break-all">
          {error}
        </div>
      )}
      <p className="text-xs text-redlog-text-faint mt-1">
        {t('settings.exportBundleHint')}
      </p>
    </FieldGroup>
  )
}

function IntegrityPanel({ t }: { t: (key: string) => string }): JSX.Element {
  const [anchors, setAnchors] = useState<ChainAnchorInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null)
  // v0.6.87 E1: rich full-chain verify result, shown as a detail card.
  const [fullVerify, setFullVerify] = useState<FullVerifyResult | null>(null)
  const [verifying, setVerifying] = useState(false)

  const reload = async (): Promise<void> => {
    const list = await window.redlog.chain.anchors()
    setAnchors(list)
  }

  useEffect(() => { reload() }, [])

  const handleAnchor = async (): Promise<void> => {
    setBusy(true)
    const result = await window.redlog.chain.anchorNow()
    setBusy(false)
    if (result) {
      const ok = result.calendarReceipts.filter((r) => r.ok).length
      const total = result.calendarReceipts.length
      if (ok > 0) {
        clearIssue('anchor')
        toast(t('settings.anchored', { ok, total }), 'success')
      } else {
        raiseIssue({
          id: 'anchor', tier: 'attention',
          title: t('settings.anchorFailed'), detail: t('settings.anchorFailedWhy'), view: 'settings'
        })
        toast(t('settings.anchorFailed'), {
          type: 'error',
          why: t('settings.anchorFailedWhy'),
          detail: result.calendarReceipts.map((r) => `${r.url ?? '?'}: ${r.error ?? 'no receipt'}`).join('\n'),
          action: { label: t('common.retry'), onClick: () => { void handleAnchor() } }
        })
      }
      await reload()
    } else {
      toast(t('settings.integrityNoAnchors'), {
        type: 'error',
        why: t('settings.integrityNoAnchorsWhy')
      })
    }
  }

  const handleVerify = async (): Promise<void> => {
    const result = await window.redlog.chain.verify()
    if (!result.anchor) {
      setVerifyMsg(t('settings.integrityVerifiedNone'))
    } else {
      const anchorCount = result.anchor.eventCount
      const currentRow = anchors[0]?.eventCount ?? anchorCount
      const msg = result.ok
        ? t('settings.integrityVerifiedOk').replace('{{n}}', String(anchorCount)).replace('{{m}}', String(Math.max(currentRow, anchorCount)))
        : t('settings.integrityVerifiedBad').replace('{{n}}', String(anchorCount)).replace('{{m}}', String(currentRow))
      setVerifyMsg(msg)
      // A chain that will not verify is the most consequential condition the
      // app can be in, and the old inline message cleared itself after eight
      // seconds — so an operator who looked away lost it entirely (§9).
      if (result.ok) clearIssue('chain')
      else {
        raiseIssue({
          id: 'chain', tier: 'attention',
          title: t('issues.chainBroken'), detail: t('issues.chainBrokenDetail'), view: 'settings'
        })
      }
    }
    setTimeout(() => setVerifyMsg(null), 8000)
  }

  const statusColor = (s: string): string => {
    switch (s) {
      case 'complete': return 'bg-green-900/60 text-green-300'
      case 'partial': return 'bg-yellow-900/60 text-yellow-300'
      case 'failed': return 'bg-red-900/60 text-red-300'
      default: return 'bg-redlog-elevated text-redlog-text-dim'
    }
  }
  const statusLabel = (s: string): string => t(`settings.integrityStatus${s.charAt(0).toUpperCase() + s.slice(1)}`)

  return (
    <FieldGroup title={t('settings.integrity')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.integrityHint')}</p>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={handleAnchor}
          disabled={busy}
          className="px-3 py-1.5 text-xs rounded bg-redlog-danger text-white hover:bg-redlog-danger-hover disabled:opacity-50"
        >
          {busy ? t('settings.integrityAnchoring') : t('settings.integrityAnchorNow')}
        </button>
        <button
          onClick={handleVerify}
          className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
        >
          {t('settings.integrityVerify')}
        </button>
        {/* v0.6.87 E1: full-chain verify. Walks every event, recomputes each
            hash, and checks it against `prev_hash`. Slower than anchor-only
            verify but proves the chain is intact end-to-end — critical for
            delivery / client demo. Shows a detail card with walked count,
            broken-at (if any), current head, and anchor match. */}
        <button
          onClick={async () => {
            setVerifying(true)
            setFullVerify(null)
            const r = await window.redlog.chain.verify({ full: true })
            setVerifying(false)
            setFullVerify(r)
            // v0.6.89.5: publish to the module-level cache so a fresh
            // Timeline mount picks up the broken-chain state without
            // requiring another verify click. Custom event lets an
            // already-mounted Timeline update in place.
            setLastVerifyResult(r as CachedFullVerifyResult | null)
          }}
          disabled={verifying}
          className="px-3 py-1.5 bg-redlog-elevated text-emerald-300 text-xs rounded hover:bg-redlog-elevated-hover disabled:opacity-50"
        >
          {verifying ? t('settings.integrityVerifying') : t('settings.integrityVerifyFull')}
        </button>
        <button
          onClick={async () => {
            const r = await window.redlog.chain.upgrade() as { upgraded: number; scanned: number } | null
            if (r) toast(`Upgraded ${r.upgraded}/${r.scanned} anchors`, r.upgraded > 0 ? 'success' : 'info')
            await reload()
          }}
          className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
        >
          {t('settings.integrityUpgradeAll')}
        </button>
      </div>
      {verifyMsg && <p className="text-xs text-redlog-text font-mono">{verifyMsg}</p>}
      {fullVerify && (
        <div className={`p-3 rounded border text-xs space-y-1 font-mono ${
          fullVerify.ok ? 'border-emerald-800 bg-emerald-950/30' : 'border-red-800 bg-red-950/30'
        }`}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className={fullVerify.ok ? 'text-emerald-400' : 'text-red-400'}>
              {fullVerify.ok ? '✓' : '✗'} {t(fullVerify.ok ? 'settings.integrityFullOk' : 'settings.integrityFullBroken')}
            </span>
          </div>
          <div className="text-redlog-text-dim">
            {t('settings.integrityFullWalked', { n: String(fullVerify.walked ?? 0) })}
          </div>
          {!fullVerify.ok && fullVerify.brokenAtEventId && (
            <>
              <div className="text-red-400 break-all">
                {t('settings.integrityFullBrokenAt')}: {fullVerify.brokenAtEventId}
              </div>
              {fullVerify.brokenReason && (
                <div className="text-redlog-text-dim break-all">
                  {t('settings.integrityFullReason')}: {fullVerify.brokenReason}
                </div>
              )}
            </>
          )}
          {fullVerify.currentHead && (
            <div className="text-redlog-text-dim break-all">
              {t('settings.integrityHeadHash')}: {fullVerify.currentHead.slice(0, 32)}...
            </div>
          )}
          {fullVerify.anchor && (
            <div className={fullVerify.anchorMatchesWalkedHead ? 'text-emerald-400' : 'text-amber-400'}>
              {fullVerify.anchorMatchesWalkedHead
                ? t('settings.integrityFullAnchorMatch')
                : t('settings.integrityFullAnchorMismatch')}
            </div>
          )}
          {fullVerify.clockAnomalies && fullVerify.clockAnomalies.length > 0 && (
            <div className="text-amber-400">
              ⚠ {t('settings.integrityFullClockAnomalies', { n: String(fullVerify.clockAnomalies.length) })}
            </div>
          )}
        </div>
      )}
      {anchors.length === 0 ? (
        <p className="text-xs text-redlog-text-dim">{t('settings.integrityNoAnchors')}</p>
      ) : (
        <div className="space-y-1 max-h-[240px] overflow-y-auto">
          {anchors.map((a) => (
            <div key={a.id} className="p-2 rounded border border-redlog-border bg-redlog-surface/50">
              <div className="flex items-center gap-2 text-xs">
                <span className={`text-xs px-1.5 py-0.5 rounded ${statusColor(a.status)}`}>
                  {statusLabel(a.status)}
                </span>
                <span className="text-redlog-text-dim font-mono tabular-nums text-xs">
                  {formatDateTime(a.createdAt, { seconds: true })}
                </span>
                <span className="text-redlog-text-dim text-xs">
                  {t('settings.integrityEvents').replace('{{n}}', String(a.eventCount))}
                </span>
              </div>
              <p className="text-xs text-redlog-text-dim font-mono mt-1 break-all">
                <span className="text-redlog-text-faint">{t('settings.integrityHeadHash')}: </span>{a.headHash.slice(0, 32)}...
              </p>
              <div className="flex flex-wrap gap-1 mt-1">
                {a.calendarReceipts.map((r, i) => (
                  <span
                    key={i}
                    title={r.ok
                      ? `${r.calendar} — ${r.upgradedBytes ?? r.receiptB64?.length ?? 0} B ${r.upgraded ? '(UPGRADED)' : '(pending)'}`
                      : `${r.calendar} — ${r.error}`}
                    className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                      r.upgraded ? 'bg-blue-900/50 text-blue-300' :
                      r.ok ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
                    }`}
                  >
                    {new URL(r.calendar).hostname.split('.').slice(-3).join('.')}
                    {r.upgraded && ' ✓'}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </FieldGroup>
  )
}

function McpPanel({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [info, setInfo] = useState<McpInfo | null>(null)
  const [creds, setCreds] = useState<{ token: string; endpoint: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [agentName, setAgentName] = useState('')

  useEffect(() => {
    window.redlog.mcp.info().then(setInfo).catch(() => setInfo(null))
  }, [])

  const setup = async (): Promise<void> => {
    setBusy(true)
    const r = await window.redlog.mcp.setupToken(agentName.trim() ? { name: agentName.trim() } : undefined)
    setBusy(false)
    if (r) {
      setCreds({ token: r.token, endpoint: r.endpoint, name: r.name })
      window.redlog.mcp.info().then(setInfo)
    }
  }

  const httpCmd = creds
    ? `claude mcp add --transport http redlog ${creds.endpoint} --header "Authorization: Bearer ${creds.token}"`
    : null
  const stdioCmd = info ? `claude mcp add redlog -- node ${info.stdioPath}` : null

  const copy = (text: string): void => {
    navigator.clipboard.writeText(text)
    toast(t('toast.copied'), 'success')
  }

  return (
    <FieldGroup title={t('settings.mcp')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.mcpHint')}</p>

      {info ? (
        <p className="text-xs text-emerald-400 font-mono">
          ● {t('settings.mcpLive', { endpoint: info.endpoint })}
        </p>
      ) : (
        <p className="text-xs text-redlog-text-dim">{t('settings.mcpOffline')}</p>
      )}

      {/* v0.6.87 A3: named MCP operators. Leave blank → single `MCP agent`
          operator (previous default). Type a name → per-agent operator
          (e.g. "Claude Desktop", "OpenCode", "Codex") gets its own token so
          Timeline attribution shows who did what. */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder={t('settings.mcpAgentNamePlaceholder')}
          maxLength={40}
          className="flex-1 px-2 py-1 text-xs font-mono bg-redlog-surface border border-redlog-border rounded focus:outline-none focus:ring-1 focus:ring-red-500/40"
        />
        <button
          onClick={setup}
          disabled={busy || !info}
          className="shrink-0 px-3 py-1.5 text-xs rounded bg-redlog-danger text-white hover:bg-redlog-danger-hover disabled:opacity-50"
        >
          {busy ? '…' : t('settings.mcpSetup')}
        </button>
      </div>

      {info?.operators && info.operators.length > 0 && (
        <div className="text-xs text-redlog-text-dim">
          {t('settings.mcpRegisteredAgents')}: {info.operators.map((o) => o.name).join(' · ')}
        </div>
      )}

      {creds && httpCmd && (
        <div className="mt-2 p-3 rounded border border-red-900/50 bg-red-950/30 space-y-2">
          <p className="text-xs text-red-300">{t('settings.mcpCreated')}</p>
          <div className="flex items-start gap-1">
            <code className="flex-1 bg-black/40 text-redlog-text text-xs font-mono px-2 py-1.5 rounded break-all">{httpCmd}</code>
            <button onClick={() => copy(httpCmd)} className="px-2 py-1.5 text-xs bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover shrink-0">{t('settings.mcpCopy')}</button>
          </div>
        </div>
      )}

      {stdioCmd && (
        <details className="mt-1">
          <summary className="text-xs text-redlog-text-faint cursor-pointer">{t('settings.mcpStdio')}</summary>
          <div className="flex items-start gap-1 mt-1">
            <code className="flex-1 bg-black/40 text-redlog-text-dim text-xs font-mono px-2 py-1.5 rounded break-all">{stdioCmd}</code>
            <button onClick={() => copy(stdioCmd)} className="px-2 py-1.5 text-xs bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover shrink-0">{t('settings.mcpCopy')}</button>
          </div>
          <p className="text-xs text-redlog-text-faint mt-1">{t('settings.mcpStdioHint')}</p>
        </details>
      )}
    </FieldGroup>
  )
}

// v0.7.7 U1: Settings ▸ AI Agents panel. Currently one built-in tailer
// (Claude Code, hard-coded in main); v0.8.0 refactors this into a plugin
// list with per-plugin toggles + `emitThinking` per adapter. For v0.7.7
// the panel controls the single existing tailer via `config.agentTailer`
// and previews the fixed self-exclusion mechanism (`.redlog-app-root`).
function AgentsPanel({
  t, config, setConfig
}: {
  t: (key: string) => string
  config: ConfigState
  setConfig: (c: ConfigState) => void
}): JSX.Element {
  const at = (config.agentTailer ?? { enabled: true, emitThinking: false }) as { enabled: boolean; emitThinking?: boolean }
  const patch = (delta: Partial<typeof at>): void => {
    setConfig({ ...config, agentTailer: { ...at, ...delta } })
  }
  return (
    <FieldGroup title={t('settings.agents')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.agents.hint')}</p>
      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={at.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.agents.enable')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint pl-6">{t('settings.agents.enableHint')}</p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={at.emitThinking ?? false}
            onChange={(e) => patch({ emitThinking: e.target.checked })}
            className="accent-red-600"
            disabled={!at.enabled}
          />
          <span className={`text-xs ${at.enabled ? 'text-redlog-text' : 'text-redlog-text-faint'}`}>
            {t('settings.agents.emitThinking')}
          </span>
        </label>
        <p className="text-xs text-redlog-text-faint pl-6">{t('settings.agents.emitThinkingHint')}</p>
        <p className="text-xs text-redlog-text-faint mt-3 border-t border-redlog-border pt-2">
          {t('settings.agents.selfExclusionHint')}
        </p>
      </div>
    </FieldGroup>
  )
}

function DeconflictionPanel({
  t, config, setConfig
}: {
  t: (key: string) => string
  config: ConfigState
  setConfig: (c: ConfigState) => void
}): JSX.Element {
  const dc = config.deconfliction ?? {
    enabled: false, url: '', secret: '', events: ['marker', 'system', 'credential_use', 'c2_checkin'],
    subtypes: ['scope_violation'], includeData: false
  }
  const [secretVisible, setSecretVisible] = useState(false)
  const [testing, setTesting] = useState(false)
  const [expanded, setExpanded] = useState(dc.enabled)

  const patch = (delta: Partial<typeof dc>): void => {
    setConfig({ ...config, deconfliction: { ...dc, ...delta } })
  }

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    const result = await window.redlog.deconfliction.test(dc)
    setTesting(false)
    toast(
      result.ok ? `OK (HTTP ${result.status})` : `Failed: ${result.error || 'HTTP ' + result.status}`,
      result.ok ? 'success' : 'error'
    )
  }

  return (
    <FieldGroup title={t('settings.deconfliction')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.deconflictionHint')}</p>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={dc.enabled}
          onChange={(e) => { patch({ enabled: e.target.checked }); setExpanded(e.target.checked) }}
          className="accent-red-600"
        />
        <span className="text-xs text-redlog-text">{t('settings.deconflictionEnable')}</span>
      </label>
      {(expanded || dc.enabled) && (
        <div className="space-y-2 pl-4 border-l border-redlog-border">
          <Field
            label={t('settings.deconflictionUrl')}
            value={dc.url}
            onChange={(v) => patch({ url: v })}
          />
          <div>
            <label className="text-xs text-redlog-text-dim block mb-1">{t('settings.deconflictionSecret')}</label>
            <div className="flex gap-1">
              <input
                type={secretVisible ? 'text' : 'password'}
                value={dc.secret}
                onChange={(e) => patch({ secret: e.target.value })}
                className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1.5 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
              />
              <button
                onClick={() => setSecretVisible(!secretVisible)}
                className="px-2 py-1 bg-redlog-elevated text-redlog-text-dim text-xs rounded hover:bg-redlog-elevated-hover"
              >
                {secretVisible ? t('settings.deconflictionHide') : t('settings.deconflictionShow')}
              </button>
            </div>
          </div>
          <ListField
            label={t('settings.deconflictionEvents')}
            items={dc.events}
            onChange={(items) => patch({ events: items })}
            placeholder="marker"
          />
          <ListField
            label={t('settings.deconflictionSubtypes')}
            items={dc.subtypes}
            onChange={(items) => patch({ subtypes: items })}
            placeholder="scope_violation"
          />
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dc.includeData}
              onChange={(e) => patch({ includeData: e.target.checked })}
              className="accent-red-600"
            />
            <span className="text-xs text-redlog-text-dim">{t('settings.deconflictionIncludeData')}</span>
          </label>
          <button
            onClick={handleTest}
            disabled={!dc.url || testing}
            className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover disabled:opacity-50"
          >
            {testing ? '...' : t('settings.deconflictionTest')}
          </button>
        </div>
      )}
    </FieldGroup>
  )
}

function OperatorsPanel({ t }: { t: (key: string) => string }): JSX.Element {
  const [operators, setOperators] = useState<OperatorInfo[]>([])
  const [newName, setNewName] = useState('')
  const [pendingToken, setPendingToken] = useState<{ id: string; note: string; path: string | null } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    const list = await window.redlog.operators.list()
    setOperators(list)
  }

  useEffect(() => { reload() }, [])

  const handleAdd = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    setBusy('add')
    const result = await window.redlog.operators.create(name)
    setBusy(null)
    if (result) {
      setNewName('')
      const written = await window.redlog.operators.writeToken(result.operator.id, result.token)
      setPendingToken({ id: result.operator.id, note: t('settings.operatorCreated'), path: written })
      await reload()
    } else {
      toast(t('settings.operatorCreateFailed'), {
        type: 'error',
        why: t('settings.operatorCreateFailedWhy')
      })
    }
  }

  const handleRotate = async (id: string): Promise<void> => {
    setBusy(id + ':rotate')
    const result = await window.redlog.operators.rotate(id)
    setBusy(null)
    if (result) {
      const written = await window.redlog.operators.writeToken(id, result.token)
      setPendingToken({ id, note: t('settings.operatorRotated'), path: written })
      await reload()
    }
  }

  const handleRevoke = async (id: string): Promise<void> => {
    setBusy(id + ':revoke')
    await window.redlog.operators.revoke(id)
    setBusy(null)
    await reload()
  }

  const handleDelete = async (id: string): Promise<void> => {
    // Use the app's ConfirmDialog instead of native window.confirm() — matches
    // every other destructive action + is themable + not blocking (audit P0 #2).
    if (!await confirmDialog(t('settings.operatorDeleteTitle'), t('settings.operatorDeleteConfirm'), true)) return
    setBusy(id + ':delete')
    await window.redlog.operators.delete(id)
    setBusy(null)
    await reload()
  }

  return (
    <FieldGroup title={t('settings.operators')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.operatorsHint')}</p>

      <div className="space-y-1">
        {operators.map((op) => (
          <div
            key={op.id}
            className={`flex items-center gap-2 p-2 rounded border text-xs ${
              op.revokedAt ? 'border-redlog-border bg-redlog-surface/20 opacity-60' : 'border-redlog-border bg-redlog-surface/50'
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span title={op.name} className="text-redlog-text font-medium truncate">{op.name}</span>
                {op.isPrimary && (
                  <span className="text-xs bg-red-900/60 text-red-300 px-1.5 py-0.5 rounded">
                    {t('settings.operatorPrimary')}
                  </span>
                )}
                {op.revokedAt && (
                  <span className="text-xs bg-redlog-elevated text-redlog-text-dim px-1.5 py-0.5 rounded">
                    {t('settings.operatorRevoked')}
                  </span>
                )}
              </div>
              <p title={op.id} className="text-xs text-redlog-text-dim font-mono truncate">{op.id}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                disabled={busy === op.id + ':rotate'}
                onClick={() => handleRotate(op.id)}
                className="px-2 py-1 text-xs bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover disabled:opacity-50"
              >
                {busy === op.id + ':rotate' ? '...' : t('settings.operatorRotate')}
              </button>
              {!op.isPrimary && !op.revokedAt && (
                <button
                  disabled={busy === op.id + ':revoke'}
                  onClick={() => handleRevoke(op.id)}
                  className="px-2 py-1 text-xs bg-redlog-elevated text-redlog-text-dim rounded hover:bg-red-900/30 hover:text-red-400 disabled:opacity-50"
                >
                  {busy === op.id + ':revoke' ? '...' : t('settings.operatorRevoke')}
                </button>
              )}
              {!op.isPrimary && (
                <button
                  disabled={busy === op.id + ':delete'}
                  onClick={() => handleDelete(op.id)}
                  className="px-2 py-1 text-xs bg-redlog-elevated text-redlog-text-dim rounded hover:bg-red-900/30 hover:text-red-400 disabled:opacity-50"
                >
                  {busy === op.id + ':delete' ? '...' : t('settings.operatorDelete')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-1 pt-1">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder={t('settings.operatorAddName')}
          className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
        />
        <button
          onClick={handleAdd}
          disabled={busy === 'add' || !newName.trim()}
          className="px-3 py-1 text-xs rounded bg-redlog-danger text-white hover:bg-redlog-danger-hover disabled:opacity-50"
        >
          {busy === 'add' ? '...' : t('settings.operatorAdd')}
        </button>
      </div>

      {/* §10: the token is written to a file, not handed over as text to
          copy. A token on the clipboard is a token in every clipboard manager
          on the machine, and one pasted into a note is a token in whatever
          that note syncs to. `~/.redlog/tokens/` sits outside the project
          directory on purpose — bundle export and cloud share walk the project
          tree, and a credential is not evidence. */}
      {pendingToken && (
        <div className="mt-2 p-3 rounded border border-red-900/50 bg-red-950/30 space-y-2">
          <p className="text-xs text-red-300">{pendingToken.note}</p>
          {pendingToken.path ? (
            <>
              <p className="text-xs text-redlog-text-dim">{t('settings.operatorTokenWritten')}</p>
              <div className="flex items-center gap-1">
                <code title={pendingToken.path} className="flex-1 bg-black/40 text-redlog-text-dim text-xs font-mono px-2 py-1.5 rounded truncate">
                  {pendingToken.path}
                </code>
                <button
                  onClick={() => { void window.redlog.data.revealPath?.(pendingToken.path as string) }}
                  className="px-2 py-1.5 text-xs bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover whitespace-nowrap"
                >
                  {t('settings.exportBundleReveal')}
                </button>
                <button
                  onClick={() => setPendingToken(null)}
                  className="px-2 py-1.5 text-xs rounded bg-redlog-danger text-white hover:bg-redlog-danger-hover"
                >
                  {t('settings.operatorTokenClose')}
                </button>
              </div>
            </>
          ) : (
            // The write failed. Falling back to showing the token is worse
            // than losing it — an operator can always rotate — so say what
            // happened and let them retry rather than putting it on screen.
            <div className="flex items-center gap-1">
              <p className="flex-1 text-xs text-redlog-text-dim">{t('settings.operatorTokenWriteFailed')}</p>
              <button
                onClick={() => setPendingToken(null)}
                className="px-2 py-1.5 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover"
              >
                {t('settings.operatorTokenClose')}
              </button>
            </div>
          )}
        </div>
      )}
    </FieldGroup>
  )
}

function ListField({ label, items, onChange, placeholder }: {
  label: string; items: string[]; onChange: (items: string[]) => void; placeholder: string
}): JSX.Element {
  const [input, setInput] = useState('')

  const addItem = (): void => {
    const trimmed = input.trim()
    if (trimmed && !items.includes(trimmed)) {
      onChange([...items, trimmed])
      setInput('')
    }
  }

  return (
    <div>
      <label className="text-xs text-redlog-text-dim block mb-1">{label}</label>
      <div className="flex gap-1 mb-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
          placeholder={placeholder}
          className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
        />
        <button onClick={addItem} className="px-2 py-1 bg-redlog-elevated text-redlog-text-dim text-xs rounded hover:bg-redlog-elevated-hover">+</button>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {items.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1 bg-redlog-elevated text-redlog-text text-xs font-mono px-2 py-0.5 rounded">
              {item}
              <button onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-redlog-text-dim hover:text-red-400">×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

const DEFAULT_VPN_ADAPTERS = [
  { name: 'WireGuard', pattern: 'wireguard|^wg\\d', enabled: true },
  { name: 'OpenVPN (tun/tap)', pattern: '^(tun|tap)\\d|openvpn', enabled: true },
  { name: 'Tailscale', pattern: 'tailscale', enabled: true },
  { name: 'NordVPN', pattern: 'nordlynx|nordvpn', enabled: true },
  { name: 'ProtonVPN', pattern: 'proton', enabled: true },
  { name: 'Cisco AnyConnect', pattern: 'cisco\\s*anyconnect', enabled: true },
  { name: 'Fortinet / FortiClient', pattern: 'fortinet|forticlient', enabled: true },
  { name: 'GlobalProtect', pattern: 'globalprotect', enabled: true },
  { name: 'Juniper / Pulse Secure', pattern: 'juniper|pulse\\s*secure', enabled: true },
  { name: 'IPSec', pattern: '^ipsec', enabled: true },
  { name: 'PPP', pattern: '^ppp', enabled: true },
  { name: 'macOS utun', pattern: '^utun', enabled: true },
]
const builtinPatterns = new Set(DEFAULT_VPN_ADAPTERS.map((a) => a.pattern))

function VpnAdaptersField({ config, setConfig }: { config: ConfigState; setConfig: (c: ConfigState) => void }): JSX.Element {
  const { t } = useI18n()
  const adapters = config.network.vpnAdapters ?? DEFAULT_VPN_ADAPTERS
  const [newName, setNewName] = useState('')
  const [newPattern, setNewPattern] = useState('')

  const update = (list: typeof adapters): void => {
    setConfig({ ...config, network: { ...config.network, vpnAdapters: list } })
  }

  const toggle = (idx: number): void => {
    const next = adapters.map((a, i) => i === idx ? { ...a, enabled: !a.enabled } : a)
    update(next)
  }

  const addCustom = (): void => {
    const name = newName.trim()
    const pattern = newPattern.trim()
    if (!name || !pattern) return
    try { new RegExp(pattern) } catch { return }
    update([...adapters, { name, pattern, enabled: true }])
    setNewName('')
    setNewPattern('')
  }

  const remove = (idx: number): void => {
    update(adapters.filter((_, i) => i !== idx))
  }

  return (
    <FieldGroup title={t('settings.vpnAdapters')}>
      <p className="text-xs text-redlog-text-faint -mt-1 mb-2">{t('settings.vpnAdaptersHint')}</p>
      <div className="space-y-1">
        {adapters.map((a, i) => (
          <div key={i} className="flex items-center gap-2">
            <label className="flex items-center gap-2 flex-1 cursor-pointer">
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={() => toggle(i)}
                className="accent-red-600"
              />
              <span className="text-xs text-redlog-text">{a.name}</span>
            </label>
            <span className="text-xs text-redlog-text-faint font-mono truncate max-w-[140px]" title={a.pattern}>{a.pattern}</span>
            {!builtinPatterns.has(a.pattern) && (
              <button onClick={() => remove(i)} className="text-redlog-text-faint hover:text-red-400 text-xs">×</button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 pt-2 border-t border-redlog-border">
        <p className="text-xs text-redlog-text-dim mb-1">{t('settings.vpnAddCustom')}</p>
        <div className="flex gap-1">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('settings.vpnNamePlaceholder')}
            className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text focus:outline-none focus:border-red-500"
          />
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
            placeholder={t('settings.vpnPatternPlaceholder')}
            className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
          />
          <button onClick={addCustom} className="px-2 py-1 bg-redlog-elevated text-redlog-text-dim text-xs rounded hover:bg-redlog-elevated-hover">+</button>
        </div>
      </div>
    </FieldGroup>
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
function UiScaleControl({ t }: { t: (key: string) => string }): JSX.Element {
  const [scale, setScale] = useState<number>(() => {
    const raw = parseFloat(localStorage.getItem(UI_SCALE_KEY) || '')
    return Number.isFinite(raw) && raw >= 0.9 && raw <= 1.5 ? raw : 1
  })
  useEffect(() => {
    document.body.style.setProperty('--app-zoom', String(scale))
    localStorage.setItem(UI_SCALE_KEY, String(scale))
    // A bigger zoom means fewer rows on screen, so it implies tight density —
    // unless the operator has picked a density themselves (§3).
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

// Exclusion list for the Claude Code hook. Default is "record every Bash
// tool call from Claude" — that's the point of an AI audit trail. Users
// can opt paths OUT here for personal/hobby folders they don't want on the
// chain. Recording state gate (Settings ▸ ...) still applies globally.
function HookWatchPathsPanel({ t }: { t: (k: string, v?: Record<string, string | number>) => string }): JSX.Element {
  const [watchPaths, setWatchPaths] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    window.redlog.hookConfig.get().then((c) => {
      setWatchPaths(c.watchPaths || [])
    }).catch(() => {})
  }, [])
  const commit = async (next: string[]): Promise<void> => {
    setWatchPaths(next)
    setDirty(true)
    await window.redlog.hookConfig.save({ watchPaths: next })
    setDirty(false)
    toast(t('settings.hookWatchPaths.saved'), 'success')
  }
  const addPath = async (p: string): Promise<void> => {
    const clean = p.trim()
    if (!clean) return
    if (watchPaths.includes(clean)) return
    await commit([...watchPaths, clean])
  }
  const removePath = async (p: string): Promise<void> => {
    await commit(watchPaths.filter((x) => x !== p))
  }
  const pickFolder = async (): Promise<void> => {
    const p = await window.redlog.hookConfig.pickPath()
    if (p) await addPath(p)
  }
  return (
    <FieldGroup title={t('settings.hookWatchPaths.title')}>
      <p className="text-xs text-redlog-text-dim mb-3">{t('settings.hookWatchPaths.hint')}</p>
      <div className="space-y-1 mb-2">
        {watchPaths.length === 0 ? (
          <p className="text-xs text-amber-500 font-mono px-2 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded">
            {t('settings.hookWatchPaths.empty')}
          </p>
        ) : watchPaths.map((p) => (
          <div key={p} className="flex items-center gap-2 px-2 py-1 bg-redlog-surface border border-redlog-border rounded">
            <span title={p} className="text-xs font-mono text-redlog-text flex-1 truncate">{p}</span>
            <button
              onClick={() => removePath(p)}
              className="text-xs text-red-400 hover:text-red-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
              title={t('settings.hookWatchPaths.remove')}
              aria-label={t('settings.hookWatchPaths.remove')}
            >✕</button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPath(draft); setDraft('') } }}
          placeholder="C:\\Users\\user\\Desktop\\engagement"
          className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
        />
        <button
          onClick={pickFolder}
          className="px-3 py-1 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
          title={t('settings.hookWatchPaths.pickFolder')}
        >📁 {t('settings.hookWatchPaths.pickFolder')}</button>
        <button onClick={() => { addPath(draft); setDraft('') }} disabled={!draft.trim() || dirty} className="px-3 py-1 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover disabled:opacity-40">+</button>
      </div>
    </FieldGroup>
  )
}

// -------- Cloud share panel --------------------------------------------------
//
// Wraps window.redlog.cloudShare.* — the real work lives in
// src/core/cloud-share.ts + cloud-share-uploader.ts. Two modes: preview
// (cheap, called every render) and the actual build+upload (guarded by a
// mandatory review checkbox — the hard redaction gate from spec §9).

interface CloudSharePreview {
  eventCount: number
  sanitizedEventCount: number
  sanitizedEventCountTotal: number
  /** DEPRECATED — old pre-v0.6.76 field, still populated for compat. */
  approxSizeBytes: number
  rawBytes?: number
  approxCompressedBytes?: number
  screenshotCount: number
  castCount: number
  chainHead: { hash: string; eventCount: number } | null
}
interface CloudShareBundleManifest {
  bundleFormat: number
  createdAt: string
  engagement: { id: string; name?: string }
  zipSha256: string
  zipBytes: number
  contents: {
    eventCount: number
    sanitizedEventCount: number
    sanitizedEventCountTotal: number
    chainHead: { hash: string; eventCount: number } | null
  }
}

function CloudSharePanel({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [preview, setPreview] = useState<CloudSharePreview | null>(null)
  const [previewError, setPreviewError] = useState<string>('')
  // Last failure message from prepare/upload — sticks around so the operator
  // can read it after the transient toast fades. Cleared on next attempt.
  const [lastError, setLastError] = useState<string>('')
  const [reviewed, setReviewed] = useState(false)
  const [expiresIn, setExpiresIn] = useState<'24h' | '7d' | '30d' | '90d' | 'never'>('30d')
  const [busy, setBusy] = useState<'preview' | 'prepare' | 'upload' | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  // "stub" writes to ~/.redlog/shares/ (v1 default). "https" hits a
  // user-deployed redlog-share-worker; both endpoint+token must be set.
  const [mode, setMode] = useState<'stub' | 'https'>('stub')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [endpoint, setEndpoint] = useState<string>('')
  const [authToken, setAuthToken] = useState<string>('')
  const [tokenVisible, setTokenVisible] = useState(false)
  // Client-side bundle-size override. Empty string → uses backend default (100 MB).
  const [maxMbInput, setMaxMbInput] = useState<string>('')

  const api = (window.redlog as unknown as { cloudShare: {
    preview: () => Promise<{ ok: boolean; preview?: CloudSharePreview; error?: string }>
    prepare: (engagementId: string, reviewedByOperator: boolean) =>
      Promise<{ ok: boolean; zipPath?: string; manifest?: CloudShareBundleManifest; error?: string }>
    uploadStub: (zipPath: string, manifestJson: string, expiresIn?: string) =>
      Promise<{ ok: boolean; shareUrl?: string; uploadedAt?: string; expiresAt?: string; error?: string }>
    upload: (zipPath: string, manifestJson: string, expiresIn: string | undefined, endpoint: string, authToken: string) =>
      Promise<{ ok: boolean; shareUrl?: string; uploadedAt?: string; expiresAt?: string; error?: string }>
  } }).cloudShare

  const refreshPreview = async (): Promise<void> => {
    setBusy('preview')
    const r = await api.preview()
    if (r.ok && r.preview) { setPreview(r.preview); setPreviewError('') }
    else setPreviewError(r.error ?? 'preview failed')
    setBusy(null)
  }
  useEffect(() => { refreshPreview() }, [])
  // Load persisted endpoint + token so the operator doesn't retype every session.
  useEffect(() => {
    window.redlog.config.get().then((c) => {
      const cs = (c as { cloudShare?: { endpoint?: string; authToken?: string; maxBundleBytes?: number } }).cloudShare
      if (cs) {
        if (cs.endpoint) { setEndpoint(cs.endpoint); setAdvancedOpen(true); setMode('https') }
        if (cs.authToken) setAuthToken(cs.authToken)
        if (typeof cs.maxBundleBytes === 'number' && cs.maxBundleBytes > 0) {
          setMaxMbInput(String(Math.round(cs.maxBundleBytes / (1024 * 1024))))
        }
      }
    }).catch(() => {})
  }, [])

  // Persist endpoint+token to config.yaml. Debounced so text-input typing
  // doesn't blast one write per keystroke.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistBackend = (nextEndpoint: string, nextToken: string, nextMaxMb: string): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        const c = await window.redlog.config.get() as Record<string, { cloudShare?: unknown } & Record<string, unknown>>
        const parsedMb = parseInt(nextMaxMb, 10)
        const maxBundleBytes = Number.isFinite(parsedMb) && parsedMb > 0 ? parsedMb * 1024 * 1024 : undefined
        const merged = {
          ...c,
          cloudShare: {
            endpoint: nextEndpoint,
            authToken: nextToken,
            ...(maxBundleBytes ? { maxBundleBytes } : {})
          }
        }
        await window.redlog.config.save(merged)
      } catch { /* silent — settings panel already surfaces save failures elsewhere */ }
    }, 350)
  }

  const httpsReady = mode === 'https' && endpoint.trim().length > 0 && authToken.trim().length > 0
  const canUpload = reviewed && busy === null && (mode === 'stub' || httpsReady)

  const upload = async (): Promise<void> => {
    if (!canUpload) return
    setBusy('prepare'); setShareUrl(null); setLastError('')
    const engagementId = 'default' // Bundle-export doesn't split by engagement yet — spec §14 open Q.
    const p = await api.prepare(engagementId, true)
    if (!p.ok || !p.zipPath || !p.manifest) {
      setBusy(null)
      const msg = `${t('cloudShare.prepareFailed')}: ${p.error ?? ''}`
      setLastError(msg)
      toast(t('cloudShare.prepareFailed'), {
        type: 'error',
        why: t('cloudShare.prepareFailedWhy'),
        detail: p.error
      })
      return
    }
    setBusy('upload')
    const u = mode === 'https'
      ? await api.upload(p.zipPath, JSON.stringify(p.manifest), expiresIn, endpoint.trim(), authToken.trim())
      : await api.uploadStub(p.zipPath, JSON.stringify(p.manifest), expiresIn)
    setBusy(null)
    if (u.ok && u.shareUrl) {
      setShareUrl(u.shareUrl)
      toast(t('cloudShare.uploaded'), 'success')
    } else {
      const msg = `${t('cloudShare.uploadFailed')}: ${u.error ?? ''}`
      setLastError(msg)
      toast(t('cloudShare.uploadFailed'), {
        type: 'error',
        why: t('cloudShare.uploadFailedWhy'),
        detail: u.error,
        action: { label: t('common.retry'), onClick: () => { void upload() } }
      })
    }
  }

  const humanBytes = (n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  return (
    <FieldGroup title={t('cloudShare.title')}>
      <p className="text-xs text-redlog-text-faint mb-3">{t('cloudShare.hint')}</p>

      {previewError && <p className="text-xs text-red-400 mb-2">{previewError}</p>}

      {preview && (
        <div className="rounded border border-redlog-border bg-redlog-surface/50 p-3 mb-3">
          <p className="text-xs text-redlog-text-dim mb-2">{t('cloudShare.reviewTitle')}</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-redlog-text">
            <div className="flex justify-between"><span className="text-redlog-text-dim">{t('cloudShare.events')}</span><span className="font-mono">{preview.eventCount}</span></div>
            <div className="flex justify-between"><span className="text-redlog-text-dim">{t('cloudShare.sanitized')}</span><span className="font-mono">{preview.sanitizedEventCountTotal}</span></div>
            <div className="flex justify-between"><span className="text-redlog-text-dim">{t('cloudShare.screenshots')}</span><span className="font-mono">{preview.screenshotCount}</span></div>
            <div className="flex justify-between"><span className="text-redlog-text-dim">{t('cloudShare.casts')}</span><span className="font-mono">{preview.castCount}</span></div>
            <div className="flex justify-between col-span-2"><span className="text-redlog-text-dim">{t('cloudShare.rawBytes')}</span><span className="font-mono">{humanBytes(preview.rawBytes ?? preview.approxSizeBytes)}</span></div>
            <div className="flex justify-between col-span-2"><span className="text-redlog-text-dim">{t('cloudShare.approxCompressed')}</span><span className="font-mono">{preview.approxCompressedBytes !== undefined ? humanBytes(preview.approxCompressedBytes) : '—'}</span></div>
            {preview.approxCompressedBytes !== undefined && (() => {
              const capMb = parseInt(maxMbInput, 10) || 100
              const capBytes = capMb * 1024 * 1024
              return preview.approxCompressedBytes > capBytes ? (
                <p className="col-span-2 text-xs text-red-400 mt-1">
                  {t('cloudShare.capExceedWarning', { cap: capMb })}
                </p>
              ) : null
            })()}
            {preview.chainHead && (
              <div className="flex justify-between col-span-2"><span className="text-redlog-text-dim">{t('cloudShare.chainHead')}</span>
                <span className="font-mono truncate max-w-[280px]" title={preview.chainHead.hash}>{preview.chainHead.hash.slice(0, 24)}… ({preview.chainHead.eventCount})</span></div>
            )}
          </div>
          <button onClick={refreshPreview} disabled={busy === 'preview'}
            className="mt-3 px-2 py-0.5 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover">
            {busy === 'preview' ? '…' : t('cloudShare.refresh')}
          </button>
        </div>
      )}

      <div className="mb-3">
        <label className="text-xs text-redlog-text-dim flex items-center gap-2 mb-2">
          {t('cloudShare.expiresIn')}
          <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as typeof expiresIn)}
            className="bg-redlog-surface border border-redlog-border rounded px-2 py-0.5 text-xs text-redlog-text">
            <option value="24h">24h</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
            <option value="90d">90 days</option>
            <option value="never">{t('cloudShare.never')}</option>
          </select>
        </label>

        <label className="text-xs text-amber-400/90 flex items-start gap-2 cursor-pointer">
          <input data-testid="cloud-share-reviewed" type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)}
            className="mt-0.5 accent-amber-500" />
          <span>{t('cloudShare.gateCheckbox')}</span>
        </label>
      </div>

      <div className="mb-3 rounded border border-redlog-border bg-redlog-bg/40">
        <button data-testid="cloud-share-advanced-toggle" type="button" onClick={() => setAdvancedOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-redlog-text-dim hover:bg-redlog-surface/60">
          <span>{t('cloudShare.advancedTitle')}</span>
          <span className="text-redlog-text-faint">{advancedOpen ? '▾' : '▸'}</span>
        </button>
        {advancedOpen && (
          <div className="px-3 pb-3 pt-1 space-y-2">
            <p className="text-xs text-redlog-text-faint">{t('cloudShare.advancedHint')}</p>
            <label className="block text-xs text-redlog-text-dim">
              {t('cloudShare.endpoint')}
              <input data-testid="cloud-share-endpoint" type="text" value={endpoint}
                onChange={(e) => { setEndpoint(e.target.value); persistBackend(e.target.value, authToken, maxMbInput) }}
                placeholder="https://redlog-share.<acct>.workers.dev"
                className="mt-1 w-full bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono" />
            </label>
            <label className="block text-xs text-redlog-text-dim">
              {t('cloudShare.authToken')}
              <div className="mt-1 flex gap-2">
                <input data-testid="cloud-share-authtoken" type={tokenVisible ? 'text' : 'password'} value={authToken}
                  onChange={(e) => { setAuthToken(e.target.value); persistBackend(endpoint, e.target.value, maxMbInput) }}
                  placeholder={t('cloudShare.authTokenPlaceholder')}
                  className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono" />
                <button type="button" onClick={() => setTokenVisible((v) => !v)}
                  className="px-2 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover">
                  {tokenVisible ? t('cloudShare.hide') : t('cloudShare.show')}
                </button>
              </div>
            </label>
            <div className="flex items-center gap-4 text-xs pt-1">
              <label className="flex items-center gap-1 cursor-pointer">
                <input data-testid="cloud-share-mode-stub" type="radio" name="cloudshare-mode" checked={mode === 'stub'} onChange={() => setMode('stub')}
                  className="accent-redlog-text-dim" />
                <span className={mode === 'stub' ? 'text-redlog-text' : 'text-redlog-text-dim'}>{t('cloudShare.modeStub')}</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input data-testid="cloud-share-mode-https" type="radio" name="cloudshare-mode" checked={mode === 'https'} onChange={() => setMode('https')}
                  className="accent-red-500" />
                <span className={mode === 'https' ? 'text-redlog-text' : 'text-redlog-text-dim'}>{t('cloudShare.modeHttps')}</span>
              </label>
              {mode === 'https' && !httpsReady && (
                <span className="text-amber-400/80">{t('cloudShare.httpsNeedsFields')}</span>
              )}
            </div>
            <label className="block text-xs text-redlog-text-dim pt-1">
              {t('cloudShare.maxBundleMb')}
              <input type="number" min="1" max="10000" value={maxMbInput}
                onChange={(e) => { setMaxMbInput(e.target.value); persistBackend(endpoint, authToken, e.target.value) }}
                placeholder="100"
                className="mt-1 w-32 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono" />
              <span className="ml-2 text-redlog-text-faint">{t('cloudShare.maxBundleMbHint')}</span>
            </label>
          </div>
        )}
      </div>

      {lastError && (
        <div data-testid="cloud-share-inline-error" className="mb-3 rounded border border-red-800/50 bg-red-950/20 p-2 flex items-start gap-2">
          <span className="text-red-400 shrink-0">⚠</span>
          <p className="text-xs text-red-300 font-mono break-all flex-1">{lastError}</p>
          <button data-testid="cloud-share-inline-error-dismiss" onClick={() => setLastError('')} className="text-xs text-red-400 hover:text-red-300 shrink-0">✕</button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button data-testid="cloud-share-button" onClick={upload} disabled={!canUpload}
          className="px-3 py-1.5 bg-redlog-danger text-white hover:bg-redlog-danger-hover text-xs rounded disabled:opacity-40">
          {busy === 'prepare' ? t('cloudShare.preparing')
            : busy === 'upload' ? t('cloudShare.uploading')
              : mode === 'https' ? t('cloudShare.shareHttps') : t('cloudShare.shareStub')}
        </button>
        <span className="text-xs text-redlog-text-faint">
          {mode === 'https' ? t('cloudShare.httpsNote') : t('cloudShare.stubNote')}
        </span>
      </div>

      {shareUrl && (
        <div data-testid="cloud-share-result" className="mt-3 rounded border border-green-800/50 bg-green-950/20 p-3">
          <p className="text-xs text-green-400 mb-1">{t('cloudShare.uploaded')}</p>
          <p data-testid="cloud-share-url" className="text-xs text-redlog-text font-mono break-all">{shareUrl}</p>
          <div className="flex gap-2 mt-2">
            <button onClick={() => navigator.clipboard.writeText(shareUrl)}
              className="px-2 py-0.5 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover">
              {t('cloudShare.copyUrl')}
            </button>
            <button onClick={() => window.redlog.app.openExternal(shareUrl).catch(() => {})}
              className="px-2 py-0.5 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover">
              {t('cloudShare.openUrl')}
            </button>
          </div>
        </div>
      )}
    </FieldGroup>
  )
}

// -------- Marketplace panel ---------------------------------------------------
//
// Thin wrapper around window.redlog.marketplace.*. The heavy lifting (fetch,
// sha256 verify, signature verify, atomic swap, rollback) lives in
// src/core/plugins/marketplace.ts. This panel only decides what to show and
// which IPC to call.
//
// Three sub-tabs:
//   Plugins       — fetch a registry index, install entries.
//   Publishers    — list trusted publishers, add a new one manually (paste
//                   an SPKI base64 pubkey), untrust.
//   Revocations   — surface the local revocation cache so operators can see
//                   why an install is being blocked.

interface RegistryEntryView {
  id: string
  name?: string
  description?: string
  homepage?: string
  publisher: string
  version: string
  tarball: string
  sha256: string
  signature?: string
  sizeKb?: number
  tags?: string[]
}
interface RegistryPublisherAdView {
  id: string
  homepage?: string
  keys: Array<{ label?: string; publicKey: string }>
}
interface RegistryIndexView { updatedAt: number; entries: RegistryEntryView[]; publishers?: RegistryPublisherAdView[] }
interface PublisherKeyView { publicKey: string; label?: string; trustedAt: number; trustedBy?: string }
interface PublisherView { id: string; homepage?: string; keys: PublisherKeyView[] }
interface InstallResultView {
  ok: boolean; pluginId?: string; error?: string
  contentHash?: string; installedDir?: string; rolledBackFrom?: string
  tier?: 'declarative' | 'privileged'; signatureVerified?: boolean
}
interface RevocationsView { updatedAt: number; plugins?: string[]; publishers?: string[] }

function MarketplacePanel({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  const [sub, setSub] = useState<'plugins' | 'publishers' | 'revocations'>('plugins')
  const [registryUrl, setRegistryUrl] = useState<string>('')
  const [defaultRegistryUrl, setDefaultRegistryUrl] = useState<string>('https://raw.githubusercontent.com/guan4tou2/REDLOG/main/examples/registry/index.json')
  useEffect(() => {
    // Load config once so the placeholder + one-click fetch honour any
    // config-defined default. Air-gapped shops override this to point at
    // their internal mirror.
    window.redlog.config.get().then((c) => {
      const url = (c as { marketplace?: { defaultRegistryUrl?: string } }).marketplace?.defaultRegistryUrl
      if (url) setDefaultRegistryUrl(url)
    }).catch(() => {})
  }, [])
  const [index, setIndex] = useState<RegistryIndexView | null>(null)
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [fetchError, setFetchError] = useState<string>('')
  const [installBusy, setInstallBusy] = useState<string | null>(null)
  // Last install failure per plugin id — sticks around like cloud-share's
  // persistent error box so the operator can read it after the toast fades.
  // Keyed so multiple failed installs don't overwrite each other.
  const [installError, setInstallError] = useState<Record<string, string>>({})
  const [publishers, setPublishers] = useState<PublisherView[]>([])
  const [revocations, setRevocations] = useState<RevocationsView | null>(null)

  const api = (window.redlog as unknown as { marketplace: {
    fetchIndex: (url?: string) => Promise<{ ok: boolean; index?: RegistryIndexView; error?: string }>
    listPublishers: () => Promise<PublisherView[]>
    trustPublisher: (id: string, publicKey: string, homepage?: string, label?: string) => Promise<{ ok: boolean; fingerprint?: string; error?: string }>
    untrustPublisher: (id: string) => Promise<{ ok: boolean }>
    install: (entryJson: string) => Promise<InstallResultView>
    revocations: () => Promise<RevocationsView>
  } }).marketplace

  const reloadPublishers = async (): Promise<void> => { setPublishers(await api.listPublishers()) }
  const reloadRevocations = async (): Promise<void> => { setRevocations(await api.revocations()) }
  useEffect(() => { reloadPublishers(); reloadRevocations() }, [])

  const doFetch = async (): Promise<void> => {
    setFetchState('loading'); setFetchError('')
    // Empty box → use the config-declared default (see marketplace.defaultRegistryUrl).
    const url = registryUrl.trim() || defaultRegistryUrl
    const r = await api.fetchIndex(url)
    if (r.ok && r.index) { setIndex(r.index); setFetchState('idle') }
    else { setFetchState('error'); setFetchError(r.error ?? 'unknown error') }
  }

  const doInstall = async (entry: RegistryEntryView): Promise<void> => {
    setInstallBusy(entry.id)
    // Clear a previous failure for this plugin so the box collapses on retry.
    setInstallError((prev) => { const next = { ...prev }; delete next[entry.id]; return next })
    const r = await api.install(JSON.stringify(entry))
    setInstallBusy(null)
    if (r.ok) {
      toast(t('marketplace.installed'), 'success')
      reloadPublishers()
    } else {
      const msg = r.error ?? 'unknown'
      setInstallError((prev) => ({ ...prev, [entry.id]: msg }))
      toast(t('marketplace.installFailed'), {
        type: 'error',
        why: t('marketplace.installFailedWhy'),
        detail: msg,
        action: { label: t('common.retry'), onClick: () => { void install(entry) } }
      })
    }
  }
  const dismissInstallError = (id: string): void => {
    setInstallError((prev) => { const next = { ...prev }; delete next[id]; return next })
  }

  const publisherTrusted = (id: string): boolean => publishers.some((p) => p.id === id)

  // v0.11.0: the registry index is UNTRUSTED input, and this list is the only
  // place that mattered. `index.json` carries no signature RedLog can check —
  // it names publishers and their keys, and nothing more. The real trust
  // boundary is one step later: each tarball's Ed25519 signature verified
  // against a key the operator has pinned.
  //
  // The old "Trust all suggested" button collapsed that boundary. Whoever
  // controlled the index (or the domain, or a MITM without cert pinning) could
  // advertise their own key, get it pinned in one click, and thereafter sign
  // privileged plugins that passed every check. One button undid the whole
  // model.
  //
  // Trusting a key is now per-publisher and shows the fingerprint the operator
  // is supposed to compare against the publisher's own channel — a keypress
  // per key, which is the correct amount of friction for "let this stranger
  // run code in my audit tool".
  const suggestedUntrusted = (index?.publishers ?? []).filter((p) => !publisherTrusted(p.id))
  const [trustingId, setTrustingId] = useState<string | null>(null)
  const trustOne = async (pub: { id: string; homepage?: string; keys: Array<{ publicKey: string; label?: string }> }): Promise<void> => {
    setTrustingId(pub.id)
    try {
      for (const k of pub.keys) {
        await api.trustPublisher(pub.id, k.publicKey, pub.homepage, k.label)
      }
      toast(t('marketplace.publisherTrusted', { id: pub.id }), 'success')
      reloadPublishers()
    } catch (e) {
      toast(t('marketplace.trustFailed', { id: pub.id }), {
        type: 'error',
        why: t('marketplace.trustFailedWhy'),
        detail: String((e as Error)?.message ?? e)
      })
    } finally { setTrustingId(null) }
  }

  return (
    <FieldGroup title={t('settings.marketplace')}>
      <p className="text-xs text-redlog-text-faint mb-2">{t('marketplace.hint')}</p>

      <div className="flex items-center gap-1 mb-3">
        {(['plugins', 'publishers', 'revocations'] as const).map((k) => (
          <button key={k} onClick={() => setSub(k)}
            className={`px-2.5 py-1 text-xs rounded ${sub === k ? 'bg-red-950/60 text-red-300' : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'}`}>
            {t(`marketplace.tab${k[0].toUpperCase()}${k.slice(1)}`)}
          </button>
        ))}
      </div>

      {sub === 'plugins' && (
        <>
          <div className="flex items-center gap-2 mb-3">
            <input type="text" value={registryUrl} onChange={(e) => setRegistryUrl(e.target.value)}
              placeholder={defaultRegistryUrl}
              className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text" />
            <button onClick={doFetch} disabled={fetchState === 'loading'}
              className="px-3 py-1 text-xs bg-redlog-danger text-white hover:bg-redlog-danger-hover rounded disabled:opacity-50">
              {fetchState === 'loading' ? t('marketplace.fetching') : t('marketplace.fetch')}
            </button>
          </div>

          {fetchState === 'error' && (
            <p className="text-xs text-red-400 mb-2">{t('marketplace.fetchFailed')}: {fetchError}</p>
          )}
          {!index && fetchState !== 'error' && (
            <p className="text-xs text-redlog-text-faint">{t('marketplace.indexEmpty')}</p>
          )}
          {index && index.entries.length === 0 && (
            <p className="text-xs text-redlog-text-faint">{t('marketplace.noEntries')}</p>
          )}

          {suggestedUntrusted.length > 0 && (
            <div data-testid="marketplace-suggested-banner" className="mb-3 rounded border border-amber-800/50 bg-amber-950/20 p-3">
              <p className="text-xs text-amber-300 mb-1">
                {t('marketplace.suggestedPublishersTitle', { n: suggestedUntrusted.length })}
              </p>
              <p className="text-xs text-redlog-text-dim mb-2">{t('marketplace.suggestedPublishersHint')}</p>
              <ul className="space-y-1.5">
                {suggestedUntrusted.map((p) => (
                  <li key={p.id} className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p title={p.id} className="text-xs text-redlog-text font-mono truncate">{p.id}</p>
                      {/* The fingerprint is the point of this row: the operator
                          is meant to compare it against the publisher's own
                          site before pinning, not take the registry's word. */}
                      {p.keys.map((k) => (
                        <p key={k.publicKey} className="text-xs text-redlog-text-dim font-mono truncate" title={k.publicKey}>
                          {(k as { fingerprint?: string }).fingerprint ?? k.publicKey.slice(0, 16)}{k.label ? ` · ${k.label}` : ''}
                        </p>
                      ))}
                    </div>
                    <button
                      data-testid={`marketplace-trust-${p.id}`}
                      onClick={() => void trustOne(p)}
                      disabled={trustingId === p.id}
                      className="shrink-0 px-2.5 py-1 text-xs bg-amber-600/80 hover:bg-amber-600 text-white rounded disabled:opacity-50"
                    >
                      {trustingId === p.id ? '…' : t('marketplace.trustThisPublisher')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            {index?.entries.map((e) => {
              const trusted = publisherTrusted(e.publisher)
              const signed = !!e.signature
              return (
                <div key={`${e.id}@${e.version}`} className="rounded border border-redlog-border bg-redlog-surface/50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-redlog-text">{e.name || e.id}</span>
                        <span className="text-xs text-redlog-text-dim">v{e.version}</span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim">{e.publisher}</span>
                        {signed && <span className="text-xs px-1.5 py-0.5 rounded bg-green-950/60 text-green-300">{t('marketplace.signatureVerified')}</span>}
                        {e.sizeKb !== undefined && (
                          <span className="text-xs text-redlog-text-faint">{t('marketplace.sizeKb', { size: e.sizeKb })}</span>
                        )}
                      </div>
                      {e.description && <p className="text-xs text-redlog-text-dim mt-0.5">{e.description}</p>}
                      {!trusted && (
                        <p className="text-xs text-amber-500/80 mt-1">{t('marketplace.publisherUntrusted')}</p>
                      )}
                    </div>
                    <button onClick={() => doInstall(e)} disabled={installBusy === e.id}
                      className="px-3 py-1 text-xs bg-redlog-danger text-white hover:bg-redlog-danger-hover rounded disabled:opacity-50 shrink-0">
                      {installBusy === e.id ? t('marketplace.installing') : t('marketplace.install')}
                    </button>
                  </div>
                  {installError[e.id] && (
                    <div className="mt-2 rounded border border-red-800/50 bg-red-950/20 p-2 flex items-start gap-2">
                      <span className="text-red-400 shrink-0">⚠</span>
                      <p className="text-xs text-red-300 font-mono break-all flex-1">
                        {t('marketplace.installFailed')}: {installError[e.id]}
                      </p>
                      <button onClick={() => dismissInstallError(e.id)} className="text-xs text-red-400 hover:text-red-300 shrink-0">✕</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {sub === 'publishers' && (
        <PublisherEditor t={t} publishers={publishers} api={api} onReload={reloadPublishers} />
      )}

      {sub === 'revocations' && (
        <div>
          <p className="text-xs text-redlog-text-faint mb-2">{t('marketplace.revocationsHint')}</p>
          {(!revocations || ((revocations.plugins?.length ?? 0) === 0 && (revocations.publishers?.length ?? 0) === 0)) && (
            <p className="text-xs text-redlog-text-faint">{t('marketplace.revocationsEmpty')}</p>
          )}
          {revocations && (revocations.plugins?.length ?? 0) > 0 && (
            <div className="mb-3">
              <p className="text-xs text-redlog-text-dim mb-1">{t('marketplace.revokedPlugins')}</p>
              <div className="flex flex-wrap gap-1">
                {revocations.plugins!.map((p) => <span key={p} className="text-xs px-1.5 py-0.5 rounded bg-red-950/50 text-red-300 font-mono">{p}</span>)}
              </div>
            </div>
          )}
          {revocations && (revocations.publishers?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs text-redlog-text-dim mb-1">{t('marketplace.revokedPublishers')}</p>
              <div className="flex flex-wrap gap-1">
                {revocations.publishers!.map((p) => <span key={p} className="text-xs px-1.5 py-0.5 rounded bg-red-950/50 text-red-300 font-mono">{p}</span>)}
              </div>
            </div>
          )}
        </div>
      )}
    </FieldGroup>
  )
}

function PublisherEditor({ t, publishers, api, onReload }: {
  t: (key: string, vars?: Record<string, string | number>) => string
  publishers: PublisherView[]
  api: {
    trustPublisher: (id: string, publicKey: string, homepage?: string, label?: string) => Promise<{ ok: boolean; fingerprint?: string; error?: string }>
    untrustPublisher: (id: string) => Promise<{ ok: boolean }>
  }
  onReload: () => Promise<void>
}): JSX.Element {
  const [draftId, setDraftId] = useState('')
  const [draftKey, setDraftKey] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async (): Promise<void> => {
    if (!draftId.trim() || !draftKey.trim()) return
    setBusy(true)
    const r = await api.trustPublisher(draftId.trim(), draftKey.trim(), undefined, draftLabel.trim() || undefined)
    setBusy(false)
    if (r.ok) {
      toast(`${t('marketplace.publisherAdded')} · fp ${r.fingerprint ?? ''}`, 'success')
      setDraftId(''); setDraftKey(''); setDraftLabel('')
      onReload()
    } else {
      toast(t('marketplace.addPublisherFailed'), {
        type: 'error',
        why: t('marketplace.addPublisherFailedWhy'),
        detail: r.error
      })
    }
  }

  const untrust = async (id: string): Promise<void> => { await api.untrustPublisher(id); onReload() }

  return (
    <div>
      <div className="rounded border border-redlog-border bg-redlog-surface/40 p-3 mb-3">
        <p className="text-xs text-redlog-text-dim mb-2">{t('marketplace.addPublisher')}</p>
        <p className="text-xs text-redlog-text-faint mb-2">{t('marketplace.addPublisherHint')}</p>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <input value={draftId} onChange={(e) => setDraftId(e.target.value)} placeholder={t('marketplace.publisherId')}
            className="bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono" />
          <input value={draftLabel} onChange={(e) => setDraftLabel(e.target.value)} placeholder={t('marketplace.publisherLabel')}
            className="bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text" />
        </div>
        <textarea value={draftKey} onChange={(e) => setDraftKey(e.target.value)}
          placeholder={t('marketplace.publisherPubKey')}
          rows={3}
          className="w-full bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono resize-y" />
        <div className="flex justify-end mt-2">
          <button onClick={add} disabled={busy || !draftId.trim() || !draftKey.trim()}
            className="px-3 py-1 text-xs bg-redlog-danger text-white hover:bg-redlog-danger-hover rounded disabled:opacity-50">
            {t('marketplace.trustPublisher')}
          </button>
        </div>
      </div>

      {publishers.length === 0 && <p className="text-xs text-redlog-text-faint">{t('marketplace.publisherEmpty')}</p>}
      <div className="space-y-2">
        {publishers.map((p) => (
          <div key={p.id} className="rounded border border-redlog-border bg-redlog-surface/50 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-redlog-text font-mono">{p.id}</span>
                  <span className="text-xs text-redlog-text-dim">{p.keys.length} {t('marketplace.publisherKeys')}</span>
                </div>
                {p.homepage && <a href={p.homepage} onClick={(e) => { e.preventDefault(); window.redlog.app.openExternal(p.homepage!) }}
                  className="text-xs text-blue-400 hover:text-blue-300 underline">{p.homepage}</a>}
                <ul className="mt-2 space-y-1">
                  {p.keys.map((k) => (
                    <li key={k.publicKey} className="text-xs text-redlog-text-dim font-mono truncate" title={k.publicKey}>
                      {k.label ? `[${k.label}] ` : ''}{k.publicKey.slice(0, 32)}…
                    </li>
                  ))}
                </ul>
              </div>
              <button onClick={() => untrust(p.id)}
                className="px-2.5 py-1 text-xs bg-redlog-elevated text-redlog-text-dim hover:bg-red-900/60 hover:text-red-300 rounded shrink-0">
                {t('marketplace.untrustPublisher')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
