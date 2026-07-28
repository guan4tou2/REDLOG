import { useState, useEffect } from 'react'
import { useI18n, type Locale } from '../i18n'
import { toast } from './Toast'

interface ConfigState {
  engagement: { id: string; name: string }
  operator: { id: string; name: string }
  network: { safeIPs: string[]; exposedIPs: string[]; checkInterval: number; providers?: string[]; confirmations?: number }
  scope: { enforcement: string; targets: string[]; excludeTargets: string[]; scopeFile: string }
  screenshot: { quality: number }
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

interface HookInfo {
  id: string
  name: string
  description: string
  agentType: string
  installed: boolean
  available: boolean
  installMethod: 'claude-settings' | 'shell-source' | 'manual'
}

const LOCALE_LABELS: Record<Locale, string> = {
  'en': 'English',
  'zh-TW': '繁體中文'
}

export default function Settings(): JSX.Element {
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [tab, setTab] = useState<'general' | 'team' | 'network' | 'scope' | 'data' | 'hooks'>('general')
  const [saved, setSaved] = useState(false)
  const [cdpPort, setCdpPort] = useState('9222')
  const [exportResult, setExportResult] = useState<string | null>(null)
  const [hooks, setHooks] = useState<HookInfo[]>([])
  const [hookLoading, setHookLoading] = useState<string | null>(null)
  const { t, locale, setLocale } = useI18n()

  useEffect(() => {
    window.redlog.config.get().then((c) => setConfig(c as ConfigState))
  }, [])

  if (!config) return <div className="p-4 text-zinc-500">{t('settings.loading')}</div>

  const tabs = [
    { id: 'general' as const, label: t('settings.general') },
    { id: 'team' as const, label: t('settings.team') },
    { id: 'network' as const, label: t('settings.networkIp') },
    { id: 'scope' as const, label: t('settings.scope') },
    { id: 'hooks' as const, label: t('settings.hooks') },
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
            <OperatorsPanel t={t} />
            <DeconflictionPanel t={t} config={config} setConfig={setConfig} />
          </>
        )}

        {tab === 'network' && (
          <>
            <FieldGroup title={t('settings.ipSafety')}>
              <ListField
                label={t('settings.safeIps')}
                items={config.network.safeIPs}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, safeIPs: items } })}
                placeholder={t('settings.safeIpPlaceholder')}
              />
              <ListField
                label={t('settings.exposedIps')}
                items={config.network.exposedIPs}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, exposedIPs: items } })}
                placeholder={t('settings.exposedIpPlaceholder')}
              />
            </FieldGroup>
            <FieldGroup title={t('settings.polling')}>
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
              <div className="flex gap-2">
                {['warn', 'log'].map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setConfig({ ...config, scope: { ...config.scope, enforcement: mode } })}
                    className={`px-3 py-1.5 text-xs rounded ${
                      config.scope.enforcement === mode
                        ? 'bg-red-600 text-white'
                        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                    }`}
                  >
                    {mode.toUpperCase()}
                  </button>
                ))}
              </div>
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
      </div>

      <div className="px-4 py-3 border-t border-redlog-border shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              await window.redlog.config.save(config)
              setSaved(true)
              setTimeout(() => setSaved(false), 3000)
            }}
            className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs rounded transition-colors"
          >
            {t('settings.saveApply')}
          </button>
          <span className="text-zinc-600 text-[10px]">{t('settings.restartHint')}</span>
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
  useEffect(() => {
    (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect().then(setHooks)
  }, [])

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
          {hooks.map((hook) => (
            <div
              key={hook.id}
              className={`flex items-center justify-between p-3 rounded border ${
                hook.available ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-800 bg-zinc-900/20 opacity-50'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-200">{hook.name}</span>
                  {hook.installed && (
                    <span className="text-[9px] bg-green-900/50 text-green-400 px-1.5 py-0.5 rounded">
                      {t('settings.hookActive')}
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
              {hook.available && hook.installMethod === 'manual' && (
                <span className="text-[9px] text-zinc-600 ml-3">{t('settings.hookManual')}</span>
              )}
            </div>
          ))}
        </div>
      </FieldGroup>
    </>
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
