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
    enforcement: string
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
  }
  terminal: {
    maxCastBytes: number
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
    enforcement: 'warn',
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
    flashOnExposed: true
  },
  terminal: {
    maxCastBytes: 50 * 1024 * 1024
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
