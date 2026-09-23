import { useId, useState } from 'react'
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
  scope: { warnOnViolation?: boolean; targets: string[]; excludeTargets: string[]; scopeFile: string; personalDomains?: string[] }
  screenshot: { quality: number; intervalSec?: number; diffThreshold?: number; captureOnCommand?: boolean }
  overlay?: { showMarkButton?: boolean; showInDock?: boolean; flashOnExposed?: boolean; scale?: number; emphasizeExternalIp?: boolean; passThrough?: boolean; passThroughOpacity?: number }
  clipboard?: { enabled: boolean; pollMs?: number; storePreview?: boolean }
  fileWatcher?: { enabled: boolean; watchPaths?: string[]; ignorePatterns?: string[] }
  processMonitor?: { enabled: boolean; pollMs?: number; ignoreCommands?: string[] }
  connectionMonitor?: { enabled: boolean; pollMs?: number }
  powershellTranscript?: { enabled: boolean }
  browser?: {
    binary: string
    proxy: string
    cdpPort: number
    isolateProfile: boolean
    ignoreCertErrors: boolean
    startUrl: string
    extraArgs: string[]
  }
  httpCapture?: { port: number; routeTerminals?: boolean }
  // v0.7.7 U1: Settings > AI Agents surface for the built-in Claude Code
  // tailer. v0.8.0 will expand this into a list of installed tailer
  // plugins; the shape here (enabled + emitThinking) stays the "default"
  // per-plugin knob set going forward.
  agentTailer?: {
    enabled: boolean
    emitThinking?: boolean
  }
  // Mirrors RedLogConfig['retention'] (Spec 028). The Settings page edits the
  // size budgets (bytes; 0 = unbounded) and the logged-tier age.
  retention?: {
    loggedTier?: { keepDays?: number }
    casts?: { maxBytes?: number }
    screenshots?: { maxBytes?: number }
    httpBodies?: { maxBytes?: number }
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

export function Field({ label, value, onChange, type = 'text', readOnly = false }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; readOnly?: boolean
}): JSX.Element {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="text-xs text-redlog-text-dim block mb-1">{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-redlog-surface border border-redlog-border rounded px-2 py-1.5 text-xs font-mono focus:outline-none ${readOnly ? 'text-redlog-text-dim cursor-not-allowed' : 'text-redlog-text focus:border-red-500'}`}
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
