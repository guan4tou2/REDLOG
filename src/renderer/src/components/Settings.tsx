import { useState, useEffect } from 'react'

interface ConfigState {
  engagement: { id: string; name: string }
  operator: { id: string; name: string }
  network: { vpnIPs: string[]; dailyIPs: string[]; checkInterval: number }
  scope: { enforcement: string; targets: string[]; excludeTargets: string[] }
}

export default function Settings(): JSX.Element {
  const [config, setConfig] = useState<ConfigState | null>(null)
  const [tab, setTab] = useState<'general' | 'network' | 'scope' | 'data'>('general')
  const [saved, setSaved] = useState(false)
  const [cdpPort, setCdpPort] = useState('9222')
  const [exportResult, setExportResult] = useState<string | null>(null)

  useEffect(() => {
    window.redlog.config.get().then((c) => setConfig(c as ConfigState))
  }, [])

  if (!config) return <div className="p-4 text-zinc-500">Loading...</div>

  const tabs = [
    { id: 'general' as const, label: 'General' },
    { id: 'network' as const, label: 'Network / VPN' },
    { id: 'scope' as const, label: 'Scope' },
    { id: 'data' as const, label: 'Data' }
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-redlog-border shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              tab === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
        {saved && <span className="ml-auto text-green-400 text-xs">Config saved to ~/.redlog/config.yaml</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tab === 'general' && (
          <>
            <FieldGroup title="Engagement">
              <Field label="ID" value={config.engagement.id} onChange={(v) => setConfig({ ...config, engagement: { ...config.engagement, id: v } })} />
              <Field label="Name" value={config.engagement.name} onChange={(v) => setConfig({ ...config, engagement: { ...config.engagement, name: v } })} />
            </FieldGroup>
            <FieldGroup title="Operator">
              <Field label="ID" value={config.operator.id} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, id: v } })} />
              <Field label="Name" value={config.operator.name} onChange={(v) => setConfig({ ...config, operator: { ...config.operator, name: v } })} />
            </FieldGroup>
          </>
        )}

        {tab === 'network' && (
          <>
            <FieldGroup title="VPN Detection">
              <ListField
                label="VPN IPs (green when matched)"
                items={config.network.vpnIPs}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, vpnIPs: items } })}
                placeholder="e.g. 10.8.0.0/24"
              />
              <ListField
                label="Daily IPs (red when matched = no VPN)"
                items={config.network.dailyIPs}
                onChange={(items) => setConfig({ ...config, network: { ...config.network, dailyIPs: items } })}
                placeholder="e.g. 114.24.97.0/24"
              />
            </FieldGroup>
            <FieldGroup title="Polling">
              <Field
                label="Check interval (seconds)"
                value={String(config.network.checkInterval)}
                onChange={(v) => setConfig({ ...config, network: { ...config.network, checkInterval: parseInt(v) || 10 } })}
                type="number"
              />
            </FieldGroup>
          </>
        )}

        {tab === 'data' && (
          <>
            <FieldGroup title="Chrome DevTools Protocol">
              <div className="space-y-2">
                <Field
                  label="CDP Port"
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
                  Test Connection
                </button>
                <p className="text-[10px] text-zinc-600">
                  Launch Chrome: google-chrome --remote-debugging-port=9222
                </p>
              </div>
            </FieldGroup>
            <FieldGroup title="Export All Data">
              <button
                onClick={async () => {
                  const path = await window.redlog.data.exportJson()
                  setExportResult(path ? `Saved to: ${path}` : 'Export failed')
                  setTimeout(() => setExportResult(null), 5000)
                }}
                className="px-3 py-1.5 bg-zinc-800 text-zinc-300 text-xs rounded hover:bg-zinc-700"
              >
                Export JSON Dump
              </button>
              {exportResult && <p className="text-[10px] text-zinc-400 font-mono mt-1 break-all">{exportResult}</p>}
              <p className="text-[10px] text-zinc-600">
                Exports all events, quickmarks, and config as a single JSON file.
              </p>
            </FieldGroup>
          </>
        )}

        {tab === 'scope' && (
          <>
            <FieldGroup title="Scope Enforcement">
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
            <FieldGroup title="In-Scope Targets">
              <ListField
                label="Targets (IPs, CIDRs, *.domain)"
                items={config.scope.targets}
                onChange={(items) => setConfig({ ...config, scope: { ...config.scope, targets: items } })}
                placeholder="e.g. 192.168.1.0/24 or *.example.com"
              />
            </FieldGroup>
            <FieldGroup title="Excluded Targets">
              <ListField
                label="Exclude from scope"
                items={config.scope.excludeTargets}
                onChange={(items) => setConfig({ ...config, scope: { ...config.scope, excludeTargets: items } })}
                placeholder="e.g. 10.0.0.1"
              />
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
            Save & Apply
          </button>
          <span className="text-zinc-600 text-[10px]">Requires restart to apply network/scope changes</span>
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
