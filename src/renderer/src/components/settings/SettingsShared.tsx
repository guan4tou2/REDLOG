import { useState } from 'react'
import { useI18n } from '../../i18n'

// The Wi-Fi-name toggle only means anything on macOS (where the SSID is gated
// behind Location Services). Windows/Linux read the SSID directly, so the
// control is hidden there.
export const isMacOS = (window as { redlog?: { platform?: string } }).redlog?.platform === 'darwin'
export const isWindows = (window as { redlog?: { platform?: string } }).redlog?.platform === 'win32'

export interface ConfigState {
  engagement: { id: string; name: string }
  operator: { id: string; name: string }
  network: { whitelist: string[]; blacklist: string[]; checkInterval: number; providers?: string[]; confirmations?: number; ipMode?: 'dns' | 'http' | 'auto'; showWifiName?: boolean; vpnAdapters?: Array<{ name: string; pattern: string; enabled: boolean }> }
  scope: { warnOnViolation?: boolean; targets: string[]; excludeTargets: string[]; scopeFile: string }
  screenshot: { quality: number; intervalSec?: number; diffThreshold?: number; captureOnCommand?: boolean }
  // Size-pressure eviction budgets (bytes; 0 = unbounded). Distinct from the
  // SINGULAR `screenshot` above, which is capture cadence/quality. These drive
  // sweepBodyStore / sweepArtifactStore (src/core/retention.ts): coldest
  // out-of-scope files are evicted first, in-scope evidence is pinned.
  screenshots?: { maxBytes?: number }
  terminal?: { castStoreMaxBytes?: number }
  httpBodies?: { maxBytes?: number }
  overlay?: { showMarkButton?: boolean; showInDock?: boolean; flashOnExposed?: boolean; scale?: number; emphasizeExternalIp?: boolean; passThrough?: boolean; passThroughOpacity?: number }
  clipboard?: { enabled: boolean; pollMs?: number; storePreview?: boolean }
  fileWatcher?: { enabled: boolean; watchPaths?: string[]; ignorePatterns?: string[] }
  processMonitor?: { enabled: boolean; pollMs?: number; ignoreCommands?: string[] }
  connectionMonitor?: { enabled: boolean; pollMs?: number }
  transcriptTailer?: { enabled: boolean }
  browser?: {
    binary: string
    proxy: string
    cdpPort: number
    isolateProfile: boolean
    ignoreCertErrors: boolean
    startUrl: string
    extraArgs: string[]
  }
  // v0.7.7 U1: Settings > AI Agents surface for the built-in Claude Code
  // tailer. v0.8.0 will expand this into a list of installed tailer
  // plugins; the shape here (enabled + emitThinking) stays the "default"
  // per-plugin knob set going forward.
  agentTailer?: {
    enabled: boolean
    emitThinking?: boolean
  }
  retention?: {
    loggedTier?: { keepDays?: number }
  }
}

export interface ManualStep {
  label: string
  command?: string
}

export interface HookInfo {
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

export function FieldGroup({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-redlog-text-dim uppercase tracking-wider">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

export function Field({ label, value, onChange, type = 'text' }: {
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

export function ListField({ label, items, onChange, placeholder }: {
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
              <button onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-redlog-text-dim hover:text-red-400">&times;</button>
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

export function VpnAdaptersField({ config, setConfig }: { config: ConfigState; setConfig: (c: ConfigState) => void }): JSX.Element {
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
              <button onClick={() => remove(i)} className="text-redlog-text-faint hover:text-red-400 text-xs">&times;</button>
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
