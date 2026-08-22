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
  connectionMonitor?: { enabled: boolean; pollMs?: number }
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

// The thirteen pages §10 asks for. Declared as a union so a typo in a route
// is a compile error rather than a page that silently never renders.
type SettingsPage =
  | 'hooks' | 'agents' | 'captureControl'
  | 'scope' | 'network' | 'deconfliction'
  | 'integrity'
  | 'operators' | 'plugins'
  | 'general' | 'hud'

export default function Settings(): JSX.Element {
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [tab, setTab] = useState<SettingsPage>('hooks')
  const [pageQuery, setPageQuery] = useState('')
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
  //   · The marketplace is gone entirely. "Where to get more capture code"
  //     serves extensibility; the core is "nothing missing, findable
  //     afterwards" (docs/DESIGN-core-and-capture.md §1). Managing what is
  //     installed stays — acquiring more is not this product's job.
  // §10 / §5.7: a left list of categories with the content on the right.
  //
  // Eight tabs in a single row at 13px was already hard to scan, and two of
  // them ("Integrations", "Data") had drifted into meaning roughly the same
  // thing. Underneath, Plugins held its own sub-tabs and those held publisher
  // and revocation lists — three levels deep inside the second level, which is
  // past the two the standard allows.
  //
  // A left list solves the part a tab row cannot: the categories stay visible
  // while you read a page, it takes group headings, and it has somewhere to
  // put a search box. Twelve pages fit down the side and would not fit
  // across the top, which is why the content could not be split before the
  // container existed.
  //
  // The "export" page is deliberately absent: exporting is an action, not a
  // setting, and it now lives in the shell's one export control (§10).
  const groups: Array<{ heading: string; pages: Array<{ id: SettingsPage; label: string }> }> = [
    {
      heading: t('settings.groupCapture'),
      pages: [
        { id: 'hooks', label: t('settings.pageHooks') },
        { id: 'agents', label: t('settings.pageAgents') },
        { id: 'captureControl', label: t('settings.pageCaptureControl') }
      ]
    },
    {
      heading: t('settings.groupScope'),
      pages: [
        { id: 'scope', label: t('settings.pageScope') },
        { id: 'network', label: t('settings.pageNetwork') },
        { id: 'deconfliction', label: t('settings.pageDeconfliction') }
      ]
    },
    {
      heading: t('settings.groupEvidence'),
      pages: [
        { id: 'integrity', label: t('settings.pageIntegrity') }
      ]
    },
    {
      heading: t('settings.groupCollab'),
      pages: [
        { id: 'operators', label: t('settings.pageOperators') },
        { id: 'plugins', label: t('settings.pagePlugins') }
      ]
    },
    {
      heading: t('settings.groupApp'),
      pages: [
        { id: 'general', label: t('settings.pageGeneral') },
        { id: 'hud', label: t('settings.pageHud') }
      ]
    }
  ]

  const q = pageQuery.trim().toLowerCase()
  const visible = groups
    .map((g) => ({ ...g, pages: g.pages.filter((pg) => !q || pg.label.toLowerCase().includes(q)) }))
    .filter((g) => g.pages.length > 0)

  return (
    <div className="flex h-full">
      <nav
        aria-label={t('settings.categories')}
        className="w-[212px] shrink-0 border-r border-redlog-border flex flex-col overflow-hidden"
      >
        <div className="p-2 border-b border-redlog-border">
          <input
            value={pageQuery}
            onChange={(e) => setPageQuery(e.target.value)}
            placeholder={t('settings.searchPages')}
            aria-label={t('settings.searchPages')}
            className="w-full px-2 py-1.5 bg-redlog-elevated border border-redlog-border rounded text-xs text-redlog-text placeholder-redlog-muted outline-none focus:border-redlog-accent/60"
          />
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {visible.length === 0 && (
            <p className="px-3 py-4 text-xs text-redlog-text-faint text-center">
              {t('settings.noPageMatches', { query: pageQuery })}
            </p>
          )}
          {visible.map((g) => (
            <div key={g.heading} className="mb-2">
              <p className="px-3 pt-1 pb-1 text-xs font-semibold text-redlog-text-faint uppercase tracking-wider">
                {g.heading}
              </p>
              {g.pages.map((pg) => (
                <button
                  key={pg.id}
                  data-settings-page={pg.id}
                  onClick={() => setTab(pg.id)}
                  aria-current={tab === pg.id ? 'page' : undefined}
                  className={`w-full text-left px-3 h-[var(--row-h)] flex items-center text-xs rounded-md transition-colors ${
                    tab === pg.id
                      ? 'bg-redlog-elevated text-redlog-text'
                      : 'text-redlog-text-dim hover:text-redlog-text hover:bg-white/[0.03]'
                  }`}
                >
                  {pg.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        {saved && (
          <p className="px-3 py-2 text-xs text-emerald-400 border-t border-redlog-border">
            {t('settings.saved')}
          </p>
        )}
      </nav>

      {/* The right pane is a column: content scrolls, the save bar stays put
          under it. Making the root a row without this turned that bar into a
          third column and squeezed the content to 35px. */}
      <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-[900px]">
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
            {/* Was "Team Profile Sync", two buttons. The import half duplicated
                the one on the project picker, which is where you actually want
                it — you seed a config when creating the project, not after.
                The export half stays: deleting it would leave an import that
                consumes files nothing can produce. It carries views.json too,
                so it is not merely a copy of config.yaml. */}
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
          </>
        )}

        {(tab === 'agents' || tab === 'network' || tab === 'deconfliction' || tab === 'operators') && (
          <>
            {tab === 'agents' && <McpPanel t={t} />}
            {tab === 'agents' && <HookWatchPathsPanel t={t} />}
            {tab === 'operators' && <OperatorsPanel t={t} />}
            {tab === 'deconfliction' && <DeconflictionPanel t={t} config={config} setConfig={setConfig} />}
            {tab === 'network' && <BrowserPanel t={t} config={config} setConfig={setConfig} />}
            {tab === 'network' && <FieldGroup title={t('settings.cdp')}>
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
            </FieldGroup>}
          </>
        )}

        {tab === 'network' && (
          <>
            <FieldGroup title={t('settings.ipSafety')}>
              {/* Adapter detection used to be its own group. It exists only to
                  answer this group's question — is my traffic where I think it
                  is — and reading it as a separate subject made "am I exposed"
                  look like two unrelated settings instead of one. */}
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
              <VpnAdaptersField config={config} setConfig={setConfig} />
            </FieldGroup>
            {/* Was "Polling", which read as a tuning knob and is why I nearly deleted
                it. It is not: every field here decides what RedLog itself sends
                out to the network and to whom — which resolver or third-party
                echo service learns your address, how often, and from where.
                During an engagement that is OPSEC surface, and §1's operator
                has to be able to see it, not discover it in a packet capture. */}
            <FieldGroup title={t('settings.ownTraffic')}>
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

        {(tab === 'hooks' || tab === 'captureControl') && (
          <>
            <HooksPanel hooks={hooks} setHooks={setHooks} hookLoading={hookLoading} setHookLoading={setHookLoading} t={t} />
            {isWindows && <WslPanel t={t} />}
            <AgentsPanel t={t} config={config} setConfig={setConfig} />
                        {tab === 'captureControl' && <FieldGroup title={t('settings.clipboardGroup')}>
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
            </FieldGroup>}
            {tab === 'captureControl' && <FieldGroup title={t('settings.fileWatcherGroup')}>
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
            </FieldGroup>}
            {tab === 'captureControl' && <FieldGroup title={t('settings.processMonitorGroup')}>
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
            </FieldGroup>}
            {tab === 'captureControl' && <FieldGroup title={t('settings.connectionMonitorGroup')}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.connectionMonitor?.enabled === true}
                  onChange={(e) => setConfig({ ...config, connectionMonitor: { ...config.connectionMonitor, enabled: e.target.checked } })}
                  className="accent-red-600"
                />
                <span className="text-xs text-redlog-text">{t('settings.connectionMonitorEnable')}</span>
              </label>
              <p className="text-xs text-redlog-text-faint">{t('settings.connectionMonitorEnableHint')}</p>
              {/* The blind spot, stated where the operator turns it on — not
                  only in a system event they might scroll past. */}
              <p className="text-xs text-amber-500/80">{t('settings.connectionMonitorSynNote')}</p>
            </FieldGroup>}
          </>
        )}

        {(tab === 'captureControl' || tab === 'integrity' || tab === 'general') && (
          <>
            {tab === 'captureControl' && <FieldGroup title={t('settings.screenshotGroup')}>
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
            
              <Field
                label={t('settings.jpegQuality')}
                value={String(config.screenshot?.quality ?? 85)}
                onChange={(v) => setConfig({ ...config, screenshot: { ...config.screenshot, quality: Math.min(100, Math.max(1, parseInt(v) || 85)) } })}
                type="number"
              />
              <p className="text-xs text-redlog-text-faint">
                {t('settings.qualityHint')}
              </p>
            </FieldGroup>}
                        
            
            {tab === 'integrity' && <IntegrityPanel t={t} />}
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

      <div className="px-4 py-3 border-t border-redlog-border shrink-0 max-w-[900px]">
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
            className="px-4 py-1.5 bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover text-xs rounded transition-colors"
          >
            {t('settings.save')}
          </button>
          <span className="text-redlog-text-faint text-xs">{t('settings.autoSaveHint')}</span>
        </div>
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
                          : 'bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover'
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

// §10: two levels, not four. This page used to hold sub-tabs for installed
// and marketplace, and the marketplace held its own for publishers and
// revocations — three levels below a second-level tab, when the standard
// allows two.
//
// The marketplace is now gone rather than flattened. Browsing a registry,
// trusting publishers by fingerprint, and reading revocation lists are the
// machinery of distributing capture code, and distribution is not what this
// product is for. What stays is the part an operator needs to answer "is
// anything capturing that I did not put there" — the installed list.
function PluginsTab({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }): JSX.Element {
  return <PluginsPanel t={t} />
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
                        p.status === 'disabled' ? 'bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover' : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
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
                      className="px-3 py-1 text-xs rounded bg-amber-600/80 text-redlog-on-warn hover:bg-amber-600"
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
              <button onClick={() => grant(confirmGrant)} className="px-3 py-1 text-xs rounded bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover">
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

// Chain state: anchors, the two-tier counter, and verification. Read-only —
// building the evidence pack itself moved to the shell's export control (§10),
// because it is an action and this page is where you look at the chain.
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
          className="px-3 py-1.5 text-xs rounded bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover disabled:opacity-50"
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
          className="shrink-0 px-3 py-1.5 text-xs rounded bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover disabled:opacity-50"
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
          className="px-3 py-1 text-xs rounded bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover disabled:opacity-50"
        >
          {busy === 'add' ? '...' : t('settings.operatorAdd')}
        </button>
      </div>

      {/* §10: the token is written to a file, not handed over as text to
          copy. A token on the clipboard is a token in every clipboard manager
          on the machine, and one pasted into a note is a token in whatever
          that note syncs to. `~/.redlog/tokens/` sits outside the project
          directory on purpose — bundle export walks the project
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
                  {t('settings.revealInFolder')}
                </button>
                <button
                  onClick={() => setPendingToken(null)}
                  className="px-2 py-1.5 text-xs rounded bg-redlog-danger text-redlog-on-danger hover:bg-redlog-danger-hover"
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
    <div>
      <label className="block text-xs text-redlog-text-dim mb-1">{t('settings.vpnAdapters')}</label>
      <p className="text-xs text-redlog-text-faint mb-2">{t('settings.vpnAdaptersHint')}</p>
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
    </div>
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

