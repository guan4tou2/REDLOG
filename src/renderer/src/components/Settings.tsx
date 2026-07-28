import { useState, useEffect } from 'react'
import { useI18n, type Locale } from '../i18n'
import { toast } from './Toast'

interface ConfigState {
  engagement: { id: string; name: string }
  operator: { id: string; name: string }
  network: { vpnIPs: string[]; dailyIPs: string[]; checkInterval: number }
  scope: { enforcement: string; targets: string[]; excludeTargets: string[]; scopeFile: string }
  screenshot: { quality: number }
}

const LOCALE_LABELS: Record<Locale, string> = {
  'en': 'English',
  'zh-TW': '繁體中文'
}

export default function Settings(): JSX.Element {
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [tab, setTab] = useState<'general' | 'network' | 'scope' | 'data'>('general')
  const [saved, setSaved] = useState(false)
  const [cdpPort, setCdpPort] = useState('9222')
  const [exportResult, setExportResult] = useState<string | null>(null)
  const { t, locale, setLocale } = useI18n()

  useEffect(() => {
    window.redlog.config.get().then((c) => setConfig(c as ConfigState))
  }, [])

  if (!config) return <div className="p-4 text-zinc-500">{t('settings.loading')}</div>

  const tabs = [
    { id: 'general' as const, label: t('settings.general') },
    { id: 'network' as const, label: t('settings.networkVpn') },
    { id: 'scope' as const, label: t('settings.scope') },
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

        {tab === 'network' && (
          <>
            <FieldGroup title={t('settings.vpnDetection')}>
              <ListField
                label={t('settings.vpnIps')}
                items={config.network.vpnIPs}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, vpnIPs: items } })}
                placeholder={t('settings.vpnIpPlaceholder')}
              />
              <ListField
                label={t('settings.dailyIps')}
                items={config.network.dailyIPs}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, dailyIPs: items } })}
                placeholder={t('settings.dailyIpPlaceholder')}
              />
            </FieldGroup>
            <FieldGroup title={t('settings.polling')}>
              <Field
                label={t('settings.checkInterval')}
                value={String(config.network.checkInterval)}
                onChange={(v) => setConfig({ ...config, network: { ...config.network, checkInterval: parseInt(v) || 10 } })}
                type="number"
              />
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
