import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

export interface RedLogConfig {
  engagement: {
    id: string
    name: string
  }
  operator: {
    id: string
    name: string
  }
  network: {
    /** whitelist — IPs confirmed OK to attack from (VPN/VPS exits) → SAFE */
    whitelist: string[]
    /** blacklist — your own fixed IPs; seeing one means identity leak → EXPOSED */
    blacklist: string[]
    checkInterval: number
    providers: string[]
    confirmations: number
    /** how to fetch the external IP: quiet DNS, HTTP echo, or DNS→HTTP fallback */
    ipMode: 'dns' | 'http' | 'auto'
    /** macOS gates the Wi-Fi SSID behind Location Services; opt in to request it
        so the HUD can show the real network name instead of a generic "Wi-Fi". */
    showWifiName: boolean
  }
  scope: {
    /** Whether to raise a violation event + red badge when a command's target
     *  falls out of scope but shares a root domain with a scope target.
     *  Excluded targets always raise a violation regardless. Default: true. */
    warnOnViolation: boolean
    targets: string[]
    excludeTargets: string[]
    scopeFile: string | null
  }
  screenshot: {
    quality: number
  }
  overlay: {
    showMarkButton: boolean
    /** macOS: keep a Dock icon (opening the HUD otherwise makes the app Dock-less) */
    showInDock: boolean
    /** flash the whole HUD frame while the external IP is EXPOSED (blacklist hit) */
    flashOnExposed: boolean
    /** overall HUD text scale — multiplier applied to every font size + window
     *  padding. 1.0 = default; 0.85 shrinks; 1.25 / 1.5 for higher-DPI eyes. */
    scale: number
    /** bump the external IP an extra ~1.4× on top of `scale`, since it's the
     *  single most important number on the bar for OPSEC glances. */
    emphasizeExternalIp: boolean
  }
  terminal: {
    maxCastBytes: number
  }
  clipboard: {
    /** default off — clipboard is highly sensitive; opt-in per engagement */
    enabled: boolean
    /** poll interval in ms — Electron has no clipboard-change event, so we sample */
    pollMs: number
    /** store the redacted preview (first N chars) alongside hash+length; still
        runs redaction; when false, only hash+length+loot-match-types are stored */
    storePreview: boolean
  }
  browser: {
    binary: string
    proxy: string
    cdpPort: number
    isolateProfile: boolean
    ignoreCertErrors: boolean
    startUrl: string
    extraArgs: string[]
  }
  redaction: {
    allowlist: string[]
    denylist: string[]
    entropyThreshold: number
    minLength: number
  }
  deconfliction: {
    enabled: boolean
    url: string
    secret: string
    events: string[]
    subtypes: string[]
    includeData: boolean
  }
}

const DEFAULT_CONFIG: RedLogConfig = {
  engagement: {
    id: 'default',
    name: 'Default Engagement'
  },
  operator: {
    id: 'operator-1',
    name: 'Operator'
  },
  network: {
    whitelist: [],
    blacklist: [],
    checkInterval: 60,
    providers: [],
    confirmations: 3,
    ipMode: 'auto',
    showWifiName: false
  },
  scope: {
    warnOnViolation: true,
    targets: [],
    excludeTargets: [],
    scopeFile: null
  },
  screenshot: {
    quality: 85
  },
  overlay: {
    showMarkButton: true,
    showInDock: true,
    flashOnExposed: true,
    scale: 1.0,
    emphasizeExternalIp: false
  },
  terminal: {
    maxCastBytes: 50 * 1024 * 1024
  },
  clipboard: {
    enabled: false,
    pollMs: 1500,
    storePreview: false
  },
  browser: {
    binary: '',
    proxy: 'http://127.0.0.1:8080',
    cdpPort: 9222,
    isolateProfile: true,
    ignoreCertErrors: true,
    startUrl: '',
    extraArgs: []
  },
  redaction: {
    allowlist: [],
    denylist: [],
    entropyThreshold: 4.5,
    minLength: 20
  },
  deconfliction: {
    enabled: false,
    url: '',
    secret: '',
    events: ['marker', 'system', 'credential_use', 'c2_checkin'],
    subtypes: ['scope_violation'],
    includeData: false
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
    } else if (source[key] !== undefined) {
      result[key] = source[key]
    }
  }
  return result
}

function migrateConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  const network = parsed.network as Record<string, unknown> | undefined
  if (network) {
    // whitelist (safe/attack IPs): vpnIPs → safeIPs → whitelist
    if (network.vpnIPs && !network.whitelist && !network.safeIPs) { network.whitelist = network.vpnIPs; delete network.vpnIPs }
    if (network.safeIPs && !network.whitelist) { network.whitelist = network.safeIPs; delete network.safeIPs }
    // blacklist (your own IPs): dailyIPs → exposedIPs → blacklist
    if (network.dailyIPs && !network.blacklist && !network.exposedIPs) { network.blacklist = network.dailyIPs; delete network.dailyIPs }
    if (network.exposedIPs && !network.blacklist) { network.blacklist = network.exposedIPs; delete network.exposedIPs }
  }
  // scope.enforcement: 'warn'|'log' → scope.warnOnViolation: boolean.
  // The old 'log' mode was misleading — it didn't actually log, it silently did
  // nothing. Treat both as "warnings on" so existing users get the safer default
  // instead of silently losing the badge; they can turn it off in Settings.
  const scope = parsed.scope as Record<string, unknown> | undefined
  if (scope && 'enforcement' in scope && !('warnOnViolation' in scope)) {
    scope.warnOnViolation = scope.enforcement === 'warn' || scope.enforcement === undefined
    delete scope.enforcement
  }
  return parsed
}

export function loadConfig(projectDir: string): RedLogConfig {
  const configPath = path.join(projectDir, 'config.yaml')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = migrateConfig(yaml.load(raw) as Record<string, unknown>)
    return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed) as unknown as RedLogConfig
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(projectDir: string, config: RedLogConfig): void {
  fs.mkdirSync(projectDir, { recursive: true })
  const configPath = path.join(projectDir, 'config.yaml')
  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }), 'utf-8')
}

export function loadScopeFile(scopeFilePath: string): string[] {
  try {
    const raw = fs.readFileSync(scopeFilePath, 'utf-8')
    const ext = path.extname(scopeFilePath).toLowerCase()

    if (ext === '.json') {
      const data = JSON.parse(raw)
      if (data.target?.scope) {
        return data.target.scope.flatMap((s: { host?: string }) => {
          if (s.host) return [s.host.replace(/^\\Q|\\E$/g, '').replace(/^\.\*/g, '*')]
          return []
        })
      }
      if (Array.isArray(data)) return data.filter((x: unknown) => typeof x === 'string')
      return []
    }

    return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  } catch {
    return []
  }
}
