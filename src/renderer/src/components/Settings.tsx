import { useState, useEffect, useRef } from 'react'
import { useI18n, type Locale } from '../i18n'
import { toast } from './Toast'

// The Wi-Fi-name toggle only means anything on macOS (where the SSID is gated
// behind Location Services). Windows/Linux read the SSID directly, so the
// control is hidden there.
const isMacOS = (window as { redlog?: { platform?: string } }).redlog?.platform === 'darwin'

interface ConfigState {
  engagement: { id: string; name: string }
  operator: { id: string; name: string }
  network: { whitelist: string[]; blacklist: string[]; checkInterval: number; providers?: string[]; confirmations?: number; ipMode?: 'dns' | 'http' | 'auto'; showWifiName?: boolean; vpnAdapters?: Array<{ name: string; pattern: string; enabled: boolean }> }
  scope: { warnOnViolation?: boolean; targets: string[]; excludeTargets: string[]; scopeFile: string }
  screenshot: { quality: number }
  overlay?: { showMarkButton: boolean; showInDock?: boolean; flashOnExposed?: boolean; scale?: number; emphasizeExternalIp?: boolean }
  clipboard?: { enabled: boolean; pollMs?: number; storePreview?: boolean }
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
  const [tab, setTab] = useState<'general' | 'team' | 'network' | 'scope' | 'data' | 'hooks' | 'plugins'>('general')
  const [saved, setSaved] = useState(false)
  const [cdpPort, setCdpPort] = useState('9222')
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

  if (!config) return <div className="p-4 text-zinc-500">{t('settings.loading')}</div>

  const tabs = [
    { id: 'general' as const, label: t('settings.general') },
    { id: 'team' as const, label: t('settings.team') },
    { id: 'network' as const, label: t('settings.networkIp') },
    { id: 'scope' as const, label: t('settings.scope') },
    { id: 'hooks' as const, label: t('settings.hooks') },
    { id: 'plugins' as const, label: t('settings.plugins') },
    { id: 'data' as const, label: t('settings.data') }
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-redlog-border shrink-0">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              tab === tb.id ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
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
            <FieldGroup title="Language">
              <div className="flex gap-2">
                {(Object.keys(LOCALE_LABELS) as Locale[]).map((l) => (
                  <button
                    key={l}
                    onClick={() => setLocale(l)}
                    className={`px-3 py-1.5 text-xs rounded ${
                      locale === l
                        ? 'bg-red-600 text-white'
                        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                    }`}
                  >
                    {LOCALE_LABELS[l]}
                  </button>
                ))}
              </div>
            </FieldGroup>
          </>
        )}

        {tab === 'team' && (
          <>
            <McpPanel t={t} />
            <OperatorsPanel t={t} />
            <DeconflictionPanel t={t} config={config} setConfig={setConfig} />
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
                <label className="block text-[11px] text-zinc-400 mb-1">{t('settings.ipMode')}</label>
                <div className="flex gap-1">
                  {(['auto', 'dns', 'http'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setConfig({ ...config, network: { ...config.network, ipMode: m } })}
                      className={`px-3 py-1 text-[10px] rounded transition-colors ${
                        (config.network.ipMode ?? 'auto') === m ? 'bg-red-600/80 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                      }`}
                    >
                      {t(`settings.ipMode.${m}`)}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-zinc-600 mt-1">{t('settings.ipModeHint')}</p>
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
                    <span className="text-[11px] text-zinc-300">{t('settings.showWifiName')}</span>
                  </label>
                  <p className="text-[10px] text-zinc-600 mt-1">{t('settings.showWifiNameHint')}</p>
                </div>
              )}
              <Field
                label={t('settings.checkInterval')}
                value={String(config.network.checkInterval)}
                onChange={(v) => setConfig({ ...config, network: { ...config.network, checkInterval: parseInt(v) || 60 } })}
                type="number"
              />
              <p className="text-[10px] text-amber-600/80">{t('settings.pollingOpsecHint')}</p>
              <Field
                label={t('settings.confirmations')}
                value={String(config.network.confirmations ?? 3)}
                onChange={(v) => setConfig({ ...config, network: { ...config.network, confirmations: Math.max(1, parseInt(v) || 3) } })}
                type="number"
              />
              <p className="text-[10px] text-zinc-600">{t('settings.confirmationsHint')}</p>
              <ListField
                label={t('settings.ipProviders')}
                items={config.network.providers ?? []}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, providers: items } })}
                placeholder="https://ip.internal.example/json"
              />
              <p className="text-[10px] text-zinc-600">{t('settings.ipProvidersHint')}</p>
            </FieldGroup>
            <VpnAdaptersField config={config} setConfig={setConfig} />
          </>
        )}

        {tab === 'data' && (
          <>
            <FieldGroup title={t('settings.screenshotQuality')}>
              <Field
                label={t('settings.jpegQuality')}
                value={String(config.screenshot?.quality ?? 85)}
                onChange={(v) => setConfig({ ...config, screenshot: { ...config.screenshot, quality: Math.min(100, Math.max(1, parseInt(v) || 85)) } })}
                type="number"
              />
              <p className="text-[10px] text-zinc-600">
                {t('settings.qualityHint')}
              </p>
            </FieldGroup>
            <FieldGroup title={t('settings.overlayGroup')}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.overlay?.showMarkButton !== false}
                  onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, showMarkButton: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-zinc-300">{t('settings.overlayShowMark')}</span>
              </label>
              <p className="text-[10px] text-zinc-600">{t('settings.overlayShowMarkHint')}</p>
              <label className="flex items-center gap-2 cursor-pointer mt-2">
                <input
                  type="checkbox"
                  checked={config.overlay?.flashOnExposed !== false}
                  onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, showMarkButton: config.overlay?.showMarkButton !== false, flashOnExposed: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-zinc-300">{t('settings.overlayFlashExposed')}</span>
              </label>
              <p className="text-[10px] text-zinc-600">{t('settings.overlayFlashExposedHint')}</p>

              <div className="mt-3">
                <label className="text-[10px] text-zinc-500 block mb-1">{t('settings.overlayScale')}</label>
                <div className="flex gap-1.5">
                  {[
                    { v: 0.85, k: 'small' },
                    { v: 1.0, k: 'normal' },
                    { v: 1.25, k: 'large' },
                    { v: 1.5, k: 'xlarge' }
                  ].map(({ v, k }) => {
                    const cur = config.overlay?.scale ?? 1.0
                    const active = Math.abs(cur - v) < 0.01
                    return (
                      <button
                        key={k}
                        onClick={() => setConfig({ ...config, overlay: { ...config.overlay, showMarkButton: config.overlay?.showMarkButton !== false, scale: v } })}
                        className={`px-3 py-1 text-[10px] rounded ${active ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
                      >
                        {t(`settings.overlayScale.${k}`)}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[10px] text-zinc-600 mt-1">{t('settings.overlayScaleHint')}</p>
              </div>

              <label className="flex items-center gap-2 cursor-pointer mt-3">
                <input
                  type="checkbox"
                  checked={config.overlay?.emphasizeExternalIp === true}
                  onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, showMarkButton: config.overlay?.showMarkButton !== false, emphasizeExternalIp: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-zinc-300">{t('settings.overlayEmphasizeIp')}</span>
              </label>
              <p className="text-[10px] text-zinc-600">{t('settings.overlayEmphasizeIpHint')}</p>

              {isMacOS && (
                <>
                  <label className="flex items-center gap-2 cursor-pointer mt-2">
                    <input
                      type="checkbox"
                      checked={config.overlay?.showInDock !== false}
                      onChange={(e) => setConfig({ ...config, overlay: { ...config.overlay, showMarkButton: config.overlay?.showMarkButton !== false, showInDock: e.target.checked } })}
                      className="accent-red-600"
                    />
                    <span className="text-xs text-zinc-300">{t('settings.overlayShowInDock')}</span>
                  </label>
                  <p className="text-[10px] text-zinc-600">{t('settings.overlayShowInDockHint')}</p>
                </>
              )}
            </FieldGroup>
            <FieldGroup title={t('settings.clipboardGroup')}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.clipboard?.enabled === true}
                  onChange={(e) => setConfig({ ...config, clipboard: { ...config.clipboard, enabled: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-zinc-300">{t('settings.clipboardEnable')}</span>
              </label>
              <p className="text-[10px] text-zinc-600">{t('settings.clipboardEnableHint')}</p>
              {config.clipboard?.enabled && (
                <label className="flex items-center gap-2 cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    checked={config.clipboard?.storePreview === true}
                    onChange={(e) => setConfig({ ...config, clipboard: { ...config.clipboard, enabled: true, storePreview: e.target.checked } })}
                    className="accent-red-600"
                  />
                  <span className="text-xs text-zinc-300">{t('settings.clipboardStorePreview')}</span>
                </label>
              )}
              {config.clipboard?.enabled && (
                <p className="text-[10px] text-zinc-600">{t('settings.clipboardStorePreviewHint')}</p>
              )}
            </FieldGroup>
            <FieldGroup title={t('settings.updateGroup')}>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => window.redlog.app.checkForUpdates()}
                  className="px-3 py-1 text-[11px] rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                >
                  {t('settings.checkUpdate')}
                </button>
                <span className="text-[10px] text-zinc-600 font-mono">v{__APP_VERSION__}</span>
              </div>
              <p className="text-[10px] text-zinc-600">{t('settings.checkUpdateHint')}</p>
            </FieldGroup>
            <BrowserPanel t={t} config={config} setConfig={setConfig} />
            <FieldGroup title={t('settings.cdp')}>
              <div className="space-y-2">
                <Field
                  label={t('settings.cdpPort')}
                  value={cdpPort}
                  onChange={(v) => setCdpPort(v)}
                  type="number"
                />
                <button
                  onClick={async () => {
                    await window.redlog.cdp.setPort(parseInt(cdpPort) || 9222)
                    const tab = await window.redlog.cdp.getTab()
                    alert(tab.connected ? `Connected: ${tab.title}\n${tab.url}` : 'Not connected. Launch Chrome with:\n--remote-debugging-port=' + cdpPort)
                  }}
                  className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
                >
                  {t('settings.testConnection')}
                </button>
                <p className="text-[10px] text-zinc-600">
                  {t('settings.cdpHint')}
                </p>
              </div>
            </FieldGroup>
            <FieldGroup title={t('settings.exportAll')}>
              <button
                onClick={async () => {
                  const path = await window.redlog.data.exportJson()
                  setExportResult(path ? t('settings.savedTo', { path }) : t('settings.exportFailed'))
                  setTimeout(() => setExportResult(null), 5000)
                }}
                className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
              >
                {t('settings.exportJson')}
              </button>
              {exportResult && <p className="text-[10px] text-zinc-400 font-mono mt-1 break-all">{exportResult}</p>}
              <p className="text-[10px] text-zinc-600">
                {t('settings.exportHint')}
              </p>
            </FieldGroup>
            <FieldGroup title={t('settings.scopeExport')}>
              <button
                onClick={async () => {
                  const p = await (window.redlog.data as { exportScopeFiltered: () => Promise<string | null> }).exportScopeFiltered()
                  setExportResult(p ? t('settings.savedTo', { path: p }) : t('settings.exportFailed'))
                  if (p) toast(t('toast.scopeExported'), 'success')
                  setTimeout(() => setExportResult(null), 5000)
                }}
                className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
              >
                {t('settings.exportScopeJson')}
              </button>
              <p className="text-[10px] text-zinc-600">
                {t('settings.scopeExportHint')}
              </p>
            </FieldGroup>
            <IntegrityPanel t={t} />
            <FieldGroup title={t('settings.profileSync')}>
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    const path = await window.redlog.config.exportProfile()
                    if (path) toast(t('toast.profileExported'), 'success')
                  }}
                  className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
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
                  className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
                >
                  {t('settings.importProfile')}
                </button>
              </div>
              <p className="text-[10px] text-zinc-600">
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
                <span className="text-xs text-zinc-300">{t('settings.warnOnViolation')}</span>
              </label>
              <p className="text-[10px] text-zinc-600 mt-1 leading-relaxed">{t('settings.warnOnViolationHint')}</p>
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
              <p className="text-[10px] text-zinc-600">
                {t('settings.scopeFileHint')}
              </p>
            </FieldGroup>
          </>
        )}
        {tab === 'hooks' && (
          <HooksPanel hooks={hooks} setHooks={setHooks} hookLoading={hookLoading} setHookLoading={setHookLoading} t={t} />
        )}
        {tab === 'plugins' && <PluginsPanel t={t} />}
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
            className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded transition-colors"
          >
            {t('settings.save')}
          </button>
          <span className="text-zinc-600 text-[10px]">{t('settings.autoSaveHint')}</span>
        </div>
      </div>
    </div>
  )
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; type?: string
}): JSX.Element {
  return (
    <div>
      <label className="text-[11px] text-zinc-500 block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-red-500"
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
    setHookLoading(hook.id)
    const hooksApi = (window.redlog as { hooks: { install: (id: string) => Promise<{ success: boolean; message: string }>; uninstall: (id: string) => Promise<{ success: boolean; message: string }> } }).hooks
    const result = hook.installed
      ? await hooksApi.uninstall(hook.id)
      : await hooksApi.install(hook.id)
    toast(result.message, result.success ? 'success' : 'error')
    const updated = await (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect()
    setHooks(updated)
    setHookLoading(null)
  }

  return (
    <>
      <FieldGroup title={t('settings.hooksDetected')}>
        <p className="text-[10px] text-zinc-600 mb-2">
          {t('settings.hooksHint')}
        </p>
        {hooks.length === 0 && (
          <p className="text-zinc-500 text-xs">{t('common.loading')}</p>
        )}
        <div className="space-y-2">
          {hooks.map((hook) => {
            const isManual = hook.available && hook.installMethod === 'manual'
            const hasSteps = isManual && !!hook.manualSteps?.length
            const isOpen = expanded === hook.id
            return (
              <div
                key={hook.id}
                className={`rounded border ${
                  hook.available ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-800 bg-zinc-900/20 opacity-50'
                }`}
              >
                <div className="flex items-center justify-between p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-zinc-200">{hook.name}</span>
                      {hook.installed && (
                        <span className="text-[9px] bg-green-900/50 text-green-400 px-1.5 py-0.5 rounded">
                          {t('settings.hookActive')}
                        </span>
                      )}
                      {isManual && (
                        <span className="text-[9px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
                          {t('settings.hookManual')}
                        </span>
                      )}
                      {!hook.available && (
                        <span className="text-[9px] bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">
                          {t('settings.hookNotFound')}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-zinc-500 mt-0.5">{hook.description}</p>
                  </div>
                  {hook.available && hook.installMethod !== 'manual' && (
                    <button
                      disabled={hookLoading === hook.id}
                      onClick={() => handleToggle(hook)}
                      className={`px-3 py-1 text-[10px] rounded ml-3 transition-colors ${
                        hook.installed
                          ? 'bg-zinc-800 text-zinc-400 hover:bg-red-900/30 hover:text-red-400'
                          : 'bg-red-600/80 text-white hover:bg-red-600'
                      } ${hookLoading === hook.id ? 'opacity-50' : ''}`}
                    >
                      {hookLoading === hook.id ? '...' : hook.installed ? t('settings.hookDisable') : t('settings.hookEnable')}
                    </button>
                  )}
                  {hasSteps && (
                    <button
                      onClick={() => setExpanded(isOpen ? null : hook.id)}
                      className="px-3 py-1 text-[10px] rounded ml-3 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors shrink-0"
                    >
                      {isOpen ? t('settings.hookHideSetup') : t('settings.hookShowSetup')}
                    </button>
                  )}
                </div>
                {hasSteps && isOpen && (
                  <div className="border-t border-zinc-800 px-3 py-2.5 space-y-2.5">
                    {hook.manualSteps!.map((step, i) => (
                      <div key={i}>
                        <p className="text-[10px] text-zinc-400 leading-relaxed">
                          <span className="text-zinc-500">{i + 1}.</span> {step.label}
                        </p>
                        {step.command && (
                          <div className="flex items-center gap-2 mt-1">
                            <code className="flex-1 min-w-0 truncate bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[10px] text-zinc-300 font-mono">
                              {step.command}
                            </code>
                            <button
                              onClick={() => copy(step.command!)}
                              className="text-[10px] px-2 py-1 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors shrink-0"
                            >
                              {t('settings.hookCopy')}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    <p className="text-[9px] text-zinc-600 pt-0.5">{t('settings.hookManualNote')}</p>
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
    setBusy(p.id); setPlugins(await api.setEnabled(p.id, enabled)); setBusy(null)
  }
  const grant = async (p: PluginView): Promise<void> => {
    setBusy(p.id); setConfirmGrant(null)
    const r = await api.grant(p.id)
    setPlugins(r.plugins); setBusy(null)
    toast(r.ok ? t('plugins.granted') : (r.error ?? 'Failed'), r.ok ? 'success' : 'error')
  }
  const revoke = async (p: PluginView): Promise<void> => { setBusy(p.id); setPlugins(await api.revoke(p.id)); setBusy(null) }

  const STATUS_STYLE: Record<PluginView['status'], string> = {
    active: 'bg-green-900/50 text-green-400',
    'needs-consent': 'bg-amber-900/50 text-amber-400',
    'hash-changed': 'bg-amber-900/50 text-amber-400',
    disabled: 'bg-zinc-800 text-zinc-500',
    error: 'bg-red-900/50 text-red-400'
  }

  return (
    <FieldGroup title={t('settings.plugins')}>
      <div className="flex items-center justify-between mb-2 gap-2">
        <p className="text-[10px] text-zinc-600 flex-1 pr-3">{t('plugins.hint')}</p>
        <button onClick={() => api.openFolder()}
          className="px-2.5 py-1 text-[10px] rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 shrink-0"
          title={t('plugins.openFolderHint')}>
          {t('plugins.openFolder')}
        </button>
        <button onClick={doReload} disabled={busy === '*'}
          className="px-2.5 py-1 text-[10px] rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 shrink-0">
          {busy === '*' ? '…' : t('plugins.reload')}
        </button>
      </div>

      {plugins.length === 0 && (
        <p className="text-[10px] text-zinc-600 py-3">{t('plugins.empty')}</p>
      )}

      <div className="space-y-2">
        {plugins.map((p) => {
          const privileged = p.tier === 'privileged'
          const needsConsent = p.status === 'needs-consent' || p.status === 'hash-changed'
          return (
            <div key={p.id} className="rounded border border-zinc-700 bg-zinc-900/50">
              <div className="flex items-start justify-between p-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-zinc-200">{p.name}</span>
                    <span className="text-[9px] text-zinc-500">v{p.version}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${STATUS_STYLE[p.status]}`}>
                      {t(`plugins.status.${p.status}`)}
                    </span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${privileged ? 'bg-red-950/60 text-red-300' : 'bg-green-950/60 text-green-300'}`}>
                      {privileged ? t('plugins.tier.privileged') : t('plugins.tier.declarative')}
                    </span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">{p.source}</span>
                  </div>
                  {p.description && <p className="text-[10px] text-zinc-500 mt-0.5">{p.description}</p>}
                  {p.contributes.length > 0 && (
                    <p className="text-[9px] text-zinc-600 mt-1">{t('plugins.contributes')}: {p.contributes.join(', ')}</p>
                  )}
                  {privileged && p.capabilities.length > 0 && (
                    <p className="text-[9px] text-amber-500/80 mt-0.5">{t('plugins.capabilities')}: {p.capabilities.join(', ')}</p>
                  )}
                  {p.status === 'error' && p.error && <p className="text-[9px] text-red-400 mt-0.5">{p.error}</p>}
                </div>

                <div className="ml-3 shrink-0 flex flex-col gap-1 items-end">
                  {/* declarative (or already-trusted privileged): enable/disable */}
                  {p.status !== 'error' && !needsConsent && (
                    <button
                      disabled={busy === p.id}
                      onClick={() => toggle(p, p.status === 'disabled')}
                      className={`px-3 py-1 text-[10px] rounded ${
                        p.status === 'disabled' ? 'bg-red-600/80 text-white hover:bg-red-600' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
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
                      className="px-3 py-1 text-[10px] rounded bg-amber-600/80 text-white hover:bg-amber-600"
                    >
                      {t('plugins.review')}
                    </button>
                  )}
                  {/* trusted privileged: allow revoke */}
                  {privileged && p.status === 'active' && (
                    <button onClick={() => revoke(p)} disabled={busy === p.id}
                      className="px-3 py-1 text-[10px] rounded bg-zinc-800 text-zinc-400 hover:bg-red-900/30 hover:text-red-400">
                      {t('plugins.revoke')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <p className="text-[9px] text-zinc-600 mt-3">{t('plugins.dir')}</p>

      {/* trust consent dialog for 🔴 code plugins */}
      {confirmGrant && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmGrant(null)}>
          <div className="bg-zinc-900 border border-red-900/50 rounded-lg p-4 max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-red-400 mb-1">{t('plugins.consentTitle')}</h3>
            <p className="text-[11px] text-zinc-400 mb-2">
              {t('plugins.consentBody', { name: confirmGrant.name })}
            </p>
            <div className="bg-zinc-950 border border-zinc-800 rounded p-2 mb-2">
              <p className="text-[10px] text-zinc-500 mb-1">{t('plugins.capabilities')}:</p>
              <ul className="text-[10px] text-amber-400 space-y-0.5">
                {confirmGrant.capabilities.length === 0 && <li className="text-zinc-500">—</li>}
                {confirmGrant.capabilities.map((c) => <li key={c}>• {c}</li>)}
              </ul>
            </div>
            <p className="text-[10px] text-zinc-500 mb-3">{t('plugins.consentWarn')}</p>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setConfirmGrant(null)} className="px-3 py-1 text-[10px] rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700">
                {t('common.cancel')}
              </button>
              <button onClick={() => grant(confirmGrant)} className="px-3 py-1 text-[10px] rounded bg-red-600 text-white hover:bg-red-500">
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
    binary: '', proxy: 'http://127.0.0.1:8080', cdpPort: 9222,
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
      <p className="text-[10px] text-zinc-600">{t('settings.browserHint')}</p>
      <Field label={t('settings.browserBinary')} value={b.binary} onChange={(v) => patch({ binary: v })} />
      <p className="text-[10px] text-zinc-600 font-mono break-all">
        {detected ? t('settings.browserDetected', { path: detected }) : t('settings.browserNotFound')}
      </p>
      <Field label={t('settings.browserProxy')} value={b.proxy} onChange={(v) => patch({ proxy: v })} />
      <Field
        label={t('settings.cdpPort')}
        value={String(b.cdpPort)}
        onChange={(v) => patch({ cdpPort: parseInt(v) || 9222 })}
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
        <span className="text-[11px] text-zinc-400">{t('settings.browserIsolate')}</span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={b.ignoreCertErrors}
          onChange={(e) => patch({ ignoreCertErrors: e.target.checked })}
          className="accent-red-600"
        />
        <span className="text-[11px] text-zinc-400">{t('settings.browserIgnoreCert')}</span>
      </label>
      <button
        onClick={async () => {
          const r = await window.redlog.browser.launch()
          toast(r.ok ? t('browser.launched') : (r.error || t('browser.failed')), r.ok ? 'success' : 'error')
        }}
        className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
      >
        {t('browser.launch')}
      </button>
    </FieldGroup>
  )
}

function IntegrityPanel({ t }: { t: (key: string) => string }): JSX.Element {
  const [anchors, setAnchors] = useState<ChainAnchorInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null)

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
      toast(`Anchored (${ok}/${result.calendarReceipts.length} calendars)`, ok > 0 ? 'success' : 'error')
      await reload()
    } else {
      toast(t('settings.integrityNoAnchors'), 'error')
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
    }
    setTimeout(() => setVerifyMsg(null), 8000)
  }

  const statusColor = (s: string): string => {
    switch (s) {
      case 'complete': return 'bg-green-900/60 text-green-300'
      case 'partial': return 'bg-yellow-900/60 text-yellow-300'
      case 'failed': return 'bg-red-900/60 text-red-300'
      default: return 'bg-zinc-800 text-zinc-400'
    }
  }
  const statusLabel = (s: string): string => t(`settings.integrityStatus${s.charAt(0).toUpperCase() + s.slice(1)}`)

  return (
    <FieldGroup title={t('settings.integrity')}>
      <p className="text-[10px] text-zinc-600">{t('settings.integrityHint')}</p>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={handleAnchor}
          disabled={busy}
          className="px-3 py-1.5 bg-red-600/80 text-white text-xs rounded hover:bg-red-600 disabled:opacity-50"
        >
          {busy ? t('settings.integrityAnchoring') : t('settings.integrityAnchorNow')}
        </button>
        <button
          onClick={handleVerify}
          className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
        >
          {t('settings.integrityVerify')}
        </button>
        <button
          onClick={async () => {
            const r = await window.redlog.chain.upgrade() as { upgraded: number; scanned: number } | null
            if (r) toast(`Upgraded ${r.upgraded}/${r.scanned} anchors`, r.upgraded > 0 ? 'success' : 'info')
            await reload()
          }}
          className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
        >
          {t('settings.integrityUpgradeAll')}
        </button>
      </div>
      {verifyMsg && <p className="text-[10px] text-zinc-300 font-mono">{verifyMsg}</p>}
      {anchors.length === 0 ? (
        <p className="text-[10px] text-zinc-500">{t('settings.integrityNoAnchors')}</p>
      ) : (
        <div className="space-y-1 max-h-[240px] overflow-y-auto">
          {anchors.map((a) => (
            <div key={a.id} className="p-2 rounded border border-zinc-700 bg-zinc-900/50">
              <div className="flex items-center gap-2 text-xs">
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${statusColor(a.status)}`}>
                  {statusLabel(a.status)}
                </span>
                <span className="text-zinc-500 font-mono tabular-nums text-[10px]">
                  {new Date(a.createdAt).toLocaleString()}
                </span>
                <span className="text-zinc-500 text-[10px]">
                  {t('settings.integrityEvents').replace('{{n}}', String(a.eventCount))}
                </span>
              </div>
              <p className="text-[10px] text-zinc-500 font-mono mt-1 break-all">
                <span className="text-zinc-600">{t('settings.integrityHeadHash')}: </span>{a.headHash.slice(0, 32)}...
              </p>
              <div className="flex flex-wrap gap-1 mt-1">
                {a.calendarReceipts.map((r, i) => (
                  <span
                    key={i}
                    title={r.ok
                      ? `${r.calendar} — ${r.upgradedBytes ?? r.receiptB64?.length ?? 0} B ${r.upgraded ? '(UPGRADED)' : '(pending)'}`
                      : `${r.calendar} — ${r.error}`}
                    className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${
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
  const [creds, setCreds] = useState<{ token: string; endpoint: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.redlog.mcp.info().then(setInfo).catch(() => setInfo(null))
  }, [])

  const setup = async (): Promise<void> => {
    setBusy(true)
    const r = await window.redlog.mcp.setupToken()
    setBusy(false)
    if (r) {
      setCreds({ token: r.token, endpoint: r.endpoint })
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
      <p className="text-[10px] text-zinc-600">{t('settings.mcpHint')}</p>

      {info ? (
        <p className="text-[10px] text-emerald-400 font-mono">
          ● {t('settings.mcpLive', { endpoint: info.endpoint })}
        </p>
      ) : (
        <p className="text-[10px] text-zinc-500">{t('settings.mcpOffline')}</p>
      )}

      <button
        onClick={setup}
        disabled={busy || !info}
        className="px-3 py-1.5 bg-red-600/80 text-white text-xs rounded hover:bg-red-600 disabled:opacity-50"
      >
        {busy ? '…' : info?.hasToken ? t('settings.mcpRotate') : t('settings.mcpSetup')}
      </button>

      {creds && httpCmd && (
        <div className="mt-2 p-3 rounded border border-red-900/50 bg-red-950/30 space-y-2">
          <p className="text-[11px] text-red-300">{t('settings.mcpCreated')}</p>
          <div className="flex items-start gap-1">
            <code className="flex-1 bg-black/40 text-zinc-200 text-[10px] font-mono px-2 py-1.5 rounded break-all">{httpCmd}</code>
            <button onClick={() => copy(httpCmd)} className="px-2 py-1.5 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700 shrink-0">{t('settings.mcpCopy')}</button>
          </div>
        </div>
      )}

      {stdioCmd && (
        <details className="mt-1">
          <summary className="text-[10px] text-zinc-600 cursor-pointer">{t('settings.mcpStdio')}</summary>
          <div className="flex items-start gap-1 mt-1">
            <code className="flex-1 bg-black/40 text-zinc-400 text-[10px] font-mono px-2 py-1.5 rounded break-all">{stdioCmd}</code>
            <button onClick={() => copy(stdioCmd)} className="px-2 py-1.5 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700 shrink-0">{t('settings.mcpCopy')}</button>
          </div>
          <p className="text-[10px] text-zinc-600 mt-1">{t('settings.mcpStdioHint')}</p>
        </details>
      )}
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
      <p className="text-[10px] text-zinc-600">{t('settings.deconflictionHint')}</p>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={dc.enabled}
          onChange={(e) => { patch({ enabled: e.target.checked }); setExpanded(e.target.checked) }}
          className="accent-red-600"
        />
        <span className="text-xs text-zinc-300">{t('settings.deconflictionEnable')}</span>
      </label>
      {(expanded || dc.enabled) && (
        <div className="space-y-2 pl-4 border-l border-zinc-800">
          <Field
            label={t('settings.deconflictionUrl')}
            value={dc.url}
            onChange={(v) => patch({ url: v })}
          />
          <div>
            <label className="text-[11px] text-zinc-500 block mb-1">{t('settings.deconflictionSecret')}</label>
            <div className="flex gap-1">
              <input
                type={secretVisible ? 'text' : 'password'}
                value={dc.secret}
                onChange={(e) => patch({ secret: e.target.value })}
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-red-500"
              />
              <button
                onClick={() => setSecretVisible(!secretVisible)}
                className="px-2 py-1 bg-zinc-800 text-zinc-400 text-[10px] rounded hover:bg-zinc-700"
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
            <span className="text-[11px] text-zinc-400">{t('settings.deconflictionIncludeData')}</span>
          </label>
          <button
            onClick={handleTest}
            disabled={!dc.url || testing}
            className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700 disabled:opacity-50"
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
  const [pendingToken, setPendingToken] = useState<{ id: string; token: string; note: string } | null>(null)
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
      setPendingToken({ id: result.operator.id, token: result.token, note: t('settings.operatorCreated') })
      await reload()
    } else {
      toast(t('settings.exportFailed'), 'error')
    }
  }

  const handleRotate = async (id: string): Promise<void> => {
    setBusy(id + ':rotate')
    const result = await window.redlog.operators.rotate(id)
    setBusy(null)
    if (result) {
      setPendingToken({ id, token: result.token, note: t('settings.operatorRotated') })
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
    if (!confirm(t('settings.operatorDeleteConfirm'))) return
    setBusy(id + ':delete')
    await window.redlog.operators.delete(id)
    setBusy(null)
    await reload()
  }

  return (
    <FieldGroup title={t('settings.operators')}>
      <p className="text-[10px] text-zinc-600">{t('settings.operatorsHint')}</p>

      <div className="space-y-1">
        {operators.map((op) => (
          <div
            key={op.id}
            className={`flex items-center gap-2 p-2 rounded border text-xs ${
              op.revokedAt ? 'border-zinc-800 bg-zinc-900/20 opacity-60' : 'border-zinc-700 bg-zinc-900/50'
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-zinc-200 font-medium truncate">{op.name}</span>
                {op.isPrimary && (
                  <span className="text-[9px] bg-red-900/60 text-red-300 px-1.5 py-0.5 rounded">
                    {t('settings.operatorPrimary')}
                  </span>
                )}
                {op.revokedAt && (
                  <span className="text-[9px] bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">
                    {t('settings.operatorRevoked')}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-zinc-500 font-mono truncate">{op.id}</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                disabled={busy === op.id + ':rotate'}
                onClick={() => handleRotate(op.id)}
                className="px-2 py-1 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700 disabled:opacity-50"
              >
                {busy === op.id + ':rotate' ? '...' : t('settings.operatorRotate')}
              </button>
              {!op.isPrimary && !op.revokedAt && (
                <button
                  disabled={busy === op.id + ':revoke'}
                  onClick={() => handleRevoke(op.id)}
                  className="px-2 py-1 text-[10px] bg-zinc-800 text-zinc-400 rounded hover:bg-red-900/30 hover:text-red-400 disabled:opacity-50"
                >
                  {busy === op.id + ':revoke' ? '...' : t('settings.operatorRevoke')}
                </button>
              )}
              {!op.isPrimary && (
                <button
                  disabled={busy === op.id + ':delete'}
                  onClick={() => handleDelete(op.id)}
                  className="px-2 py-1 text-[10px] bg-zinc-800 text-zinc-500 rounded hover:bg-red-900/30 hover:text-red-400 disabled:opacity-50"
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
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-red-500"
        />
        <button
          onClick={handleAdd}
          disabled={busy === 'add' || !newName.trim()}
          className="px-3 py-1 bg-red-600/80 text-white text-[10px] rounded hover:bg-red-600 disabled:opacity-50"
        >
          {busy === 'add' ? '...' : t('settings.operatorAdd')}
        </button>
      </div>

      {pendingToken && (
        <div className="mt-2 p-3 rounded border border-red-900/50 bg-red-950/30 space-y-2">
          <p className="text-[11px] text-red-300">{pendingToken.note}</p>
          <div className="flex items-center gap-1">
            <code className="flex-1 bg-black/40 text-zinc-200 text-[10px] font-mono px-2 py-1.5 rounded truncate">
              {pendingToken.token}
            </code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(pendingToken.token)
                toast(t('toast.copied'), 'success')
              }}
              className="px-2 py-1.5 text-[10px] bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700"
            >
              {t('settings.operatorTokenCopy')}
            </button>
            <button
              onClick={() => setPendingToken(null)}
              className="px-2 py-1.5 text-[10px] bg-red-600/80 text-white rounded hover:bg-red-600"
            >
              {t('settings.operatorTokenClose')}
            </button>
          </div>
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
      <label className="text-[11px] text-zinc-500 block mb-1">{label}</label>
      <div className="flex gap-1 mb-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addItem()}
          placeholder={placeholder}
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-red-500"
        />
        <button onClick={addItem} className="px-2 py-1 bg-zinc-800 text-zinc-400 text-xs rounded hover:bg-zinc-700">+</button>
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {items.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1 bg-zinc-800 text-zinc-300 text-[10px] font-mono px-2 py-0.5 rounded">
              {item}
              <button onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-zinc-500 hover:text-red-400">×</button>
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
      <p className="text-[10px] text-zinc-600 -mt-1 mb-2">{t('settings.vpnAdaptersHint')}</p>
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
              <span className="text-[11px] text-zinc-300">{a.name}</span>
            </label>
            <span className="text-[9px] text-zinc-600 font-mono truncate max-w-[140px]" title={a.pattern}>{a.pattern}</span>
            {!builtinPatterns.has(a.pattern) && (
              <button onClick={() => remove(i)} className="text-zinc-600 hover:text-red-400 text-[10px]">×</button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 pt-2 border-t border-zinc-800">
        <p className="text-[10px] text-zinc-500 mb-1">{t('settings.vpnAddCustom')}</p>
        <div className="flex gap-1">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('settings.vpnNamePlaceholder')}
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-red-500"
          />
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
            placeholder={t('settings.vpnPatternPlaceholder')}
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-red-500"
          />
          <button onClick={addCustom} className="px-2 py-1 bg-zinc-800 text-zinc-400 text-xs rounded hover:bg-zinc-700">+</button>
        </div>
      </div>
    </FieldGroup>
  )
}
