import { useId, useState } from 'react'
import { SectionLabel } from '../SectionLabel'
import { useI18n } from '../../i18n'
import { IconButton } from '../IconButton'

// The Wi-Fi-name toggle only means anything on macOS (where the SSID is gated
// behind Location Services). Windows/Linux read the SSID directly, so the
// control is hidden there.
export const isMacOS = (window as { redlog?: { platform?: string } }).redlog?.platform === 'darwin'
export const isWindows = (window as { redlog?: { platform?: string } }).redlog?.platform === 'win32'

export interface ConfigState {
  engagement: { id: string }
  operator: { id: string; name: string }
  network: { whitelist: string[]; blacklist: string[]; checkInterval: number; providers?: string[]; confirmations?: number; ipMode?: 'dns' | 'http' | 'auto'; showWifiName?: boolean; vpnAdapters?: Array<{ name: string; pattern: string; enabled: boolean }> }
  scope: { warnOnViolation?: boolean; targets: string[]; excludeTargets: string[]; scopeFile: string; personalDomains?: string[] }
  screenshot: { quality: number; intervalSec?: number; diffThreshold?: number; captureOnCommand?: boolean }
  overlay?: { showMarkButton?: boolean; showInDock?: boolean; flashOnExposed?: boolean; scale?: number; emphasizeExternalIp?: boolean; passThrough?: boolean; passThroughOpacity?: number }
  clipboard?: { pollMs?: number; storePreview?: boolean }
  fileWatcher?: { watchPaths?: string[]; ignorePatterns?: string[] }
  processMonitor?: { pollMs?: number; ignoreCommands?: string[] }
  connectionMonitor?: { pollMs?: number }
  // Optional capture packs (Spec 035); mirrors RedLogConfig['packs'].
  packs?: { hostMonitors?: boolean; aiAgents?: boolean; windowsOutput?: boolean }
  // Per-member opt-outs inside a pack that is on. Absent means on: the pack
  // switch is the preset, this records where the operator departed from it.
  packMembers?: {
    processMonitor?: boolean
    connectionMonitor?: boolean
    fileWatcher?: boolean
    clipboard?: boolean
    agentTailer?: boolean
    powershellTranscript?: boolean
  }
  browser?: {
    binary: string
    proxy: string
    cdpPort: number
    isolateProfile: boolean
    ignoreCertErrors: boolean
    startUrl: string
    extraArgs: string[]
  }
  httpCapture?: { port: number; listenHost?: string; routeTerminals?: boolean }
  // v0.7.7 U1: Settings > AI Agents surface for the built-in Claude Code
  // tailer. v0.8.0 will expand this into a list of installed tailer
  // plugins; the shape here (enabled + emitThinking) stays the "default"
  // per-plugin knob set going forward.
  agentTailer?: {
    emitThinking?: boolean
  }
  // Mirrors RedLogConfig['loot'] (Spec 032).
  loot?: { disabledRules?: string[] }
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
  installMethod: 'claude-settings' | 'shell-source' | 'powershell-profile' | 'manual'
  hookFile: string
  manualSteps?: ManualStep[]
  /** Shipped with RedLog, rather than contributed by an installed plugin. */
  builtin?: boolean
  /** The steps are an extra, not a setup RedLog needs the operator to do. */
  stepsAreOptional?: boolean
}

export function FieldGroup({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-2">
      <SectionLabel>{title}</SectionLabel>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

// `hint` is the tooltip on a ⓘ beside the label, not a line of prose under the
// field. Four fields on the General page are labelled ID and 名稱, twice over,
// and the labels alone do not say which of them is stamped on every event and
// which is a display string -- so the operator cannot tell the evidence field
// from the cosmetic one sitting directly beneath it.
export function Field({ label, value, onChange, onBlur, type = 'text', readOnly = false, hint }: {
  label: string; value: string; onChange: (v: string) => void; onBlur?: () => void
  type?: string; readOnly?: boolean; hint?: string
}): JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div>
      <div className="flex items-center gap-1 mb-1">
        <label htmlFor={id} className="text-xs text-redlog-text-dim">{label}</label>
        {hint && (
          <span
            id={hintId}
            title={hint}
            aria-label={hint}
            tabIndex={0}
            className="text-xs leading-none text-redlog-text-faint hover:text-redlog-text cursor-help focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-accent/40 rounded"
          >&#9432;</span>
        )}
      </div>
      <input
        id={id}
        type={type}
        value={value}
        readOnly={readOnly}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        // `cursor-not-allowed` on a read-only field was wrong twice over: it is
        // not disabled, and copying the value is the first thing anyone does
        // with it -- a bug report starts there.
        className={`w-full bg-redlog-surface border border-redlog-border rounded px-2 py-1.5 text-xs font-mono focus:outline-none ${readOnly ? 'text-redlog-text-dim select-text cursor-text' : 'text-redlog-text focus:border-red-500'}`}
      />
    </div>
  )
}

export function ListField({ label, items, onChange, placeholder, parse }: {
  label: string; items: string[]; onChange: (items: string[]) => void; placeholder: string
  /** Spec 037 FR: a field that takes pasted scope splits the text on newline,
   *  comma or space, validates each entry against the scope evaluator, and
   *  shows the rejects inline. An entry the evaluator can never match --
   *  `10.0.0.0/33`, `host:8080`, a URL -- would be stored as a rule that
   *  silently never fires. Fields that are not scope leave this off and keep
   *  the one-entry-per-Enter behaviour. */
  parse?: (text: string) => { valid: string[]; invalid: string[] }
}): JSX.Element {
  const { t } = useI18n()
  const [input, setInput] = useState('')
  const [rejected, setRejected] = useState<string[]>([])

  const addItem = (): void => {
    const trimmed = input.trim()
    if (!trimmed) return
    if (!parse) {
      if (!items.includes(trimmed)) {
        onChange([...items, trimmed])
        setInput('')
      }
      return
    }
    const { valid, invalid } = parse(trimmed)
    const added = valid.filter((entry) => !items.includes(entry))
    if (added.length > 0) onChange([...items, ...added])
    setRejected(invalid)
    // Leave the rejects in the box, and only the rejects: the operator fixes
    // them where they typed them instead of retyping the whole paste.
    setInput(invalid.join(' '))
  }

  return (
    <div>
      <label className="text-xs text-redlog-text-dim block mb-1">{label}</label>
      <div className="flex gap-1 mb-1">
        {/* A validating field takes a paste, and the requirement splits it on
            newlines -- which a single-line <input> sanitises away, gluing the
            last entry of one line to the first of the next. So it gets a
            textarea, and Enter stays a newline: ⌘/Ctrl+Enter or + commits. */}
        {parse ? (
          <textarea
            rows={2}
            value={input}
            onChange={(e) => { setInput(e.target.value); setRejected([]) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addItem() } }}
            placeholder={placeholder}
            className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono resize-y focus:outline-none focus:border-red-500"
          />
        ) : (
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value); setRejected([]) }}
            onKeyDown={(e) => e.key === 'Enter' && addItem()}
            placeholder={placeholder}
            className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
          />
        )}
        <IconButton label={t('common.addItem')} onClick={addItem} className="px-2 py-1 bg-redlog-elevated text-redlog-text-dim text-xs hover:bg-redlog-elevated-hover">+</IconButton>
      </div>
      {rejected.length > 0 && (
        <p data-testid="list-field-rejected" role="alert" className="text-xs text-redlog-warn mb-1 font-mono">
          {t('settings.scopeRejected', { entries: rejected.join(', ') })}
        </p>
      )}
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {items.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-1 bg-redlog-elevated text-redlog-text text-xs font-mono px-2 py-0.5 rounded">
              {item}
              <IconButton label={t('common.removeItem', { item })} onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-redlog-text-dim hover:text-red-400">&times;</IconButton>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
