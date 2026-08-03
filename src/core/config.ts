import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

export interface VpnAdapter {
  name: string
  pattern: string
  enabled: boolean
}

export const DEFAULT_VPN_ADAPTERS: VpnAdapter[] = [
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
    vpnAdapters: VpnAdapter[]
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
    /** Periodic auto-capture interval in seconds. 0 = disabled. Deduped
     *  against the previous frame's SHA-256 (see ScreenshotAgent), so a
     *  30s interval on an idle screen doesn't produce 120 dupes/hour. */
    intervalSec: number
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
    /** When true, HUD is permanently click-through — hover-tracking is
     *  disabled, mouse events pass to whatever is behind, and opacity drops
     *  to `passThroughOpacity` so operator SEES it's non-interactive. Useful
     *  when the HUD sits over a target's window and you don't want a stray
     *  drag to steal focus from Burp / a browser. Toggle via Settings ▸ HUD. */
    passThrough: boolean
    /** Opacity while passThrough is on. 0.4 = clearly ghost-mode. */
    passThroughOpacity: number
  }
  terminal: {
    maxCastBytes: number
    /** v0.6.87 B1: `.cast` files auto-delete after this many days on project
     *  open. `0` = keep forever (default; long engagements typically want
     *  everything). Set to e.g. 30 to prevent disk balloon on projects that
     *  spin many terminal sessions. The event row + castSha256 stays in the
     *  chain regardless — only the file is deleted, and a
     *  `system.cast_pruned` event is appended per deletion. */
    castKeepDays?: number
  }
  screenshots?: {
    /** v0.6.87 B2: screenshot .jpg auto-delete after N days on project open.
     *  `0` (default) = keep forever. Event row + sha256 stays; a
     *  `system.screenshot_pruned` audit event is appended per deletion. */
    keepDays?: number
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
  /** Cloud-share bundle backend (spec: docs/CLOUD_SHARE_BUNDLE.md).
   *  Nothing here is auto-populated — the operator BYO-buckets by pointing at
   *  their own redlog-share-worker deploy. Empty endpoint = fall back to the
   *  local file:// stub uploader. */
  cloudShare: {
    /** Base URL of the deployed Worker, e.g. https://redlog-share.acme.workers.dev */
    endpoint: string
    /** Shared bearer set via `wrangler secret put AUTH_TOKEN`. Stored in plain
     *  YAML — same trust model as `deconfliction.secret`. */
    authToken: string
    /** Override the default 100 MB bundle size cap. Operators with big
     *  screenshot / .cast collections trip the cap fast; the Worker
     *  enforces its own MAX_UPLOAD_MB independently, so raising this
     *  client-side value only helps if the backend also allows it. */
    maxBundleBytes?: number
  }
  /** Plugin marketplace overrides. Empty defaults ship the built-in
   *  placeholder (GitHub raw of the example registry). Air-gapped shops
   *  point this at their internal registry mirror. */
  marketplace: {
    /** Registry URL the Settings placeholder + one-click fetch use. */
    defaultRegistryUrl: string
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
    showWifiName: false,
    vpnAdapters: DEFAULT_VPN_ADAPTERS
  },
  scope: {
    warnOnViolation: true,
    targets: [],
    excludeTargets: [],
    scopeFile: null
  },
  screenshot: {
    quality: 85,
    intervalSec: 0
  },
  overlay: {
    showMarkButton: true,
    showInDock: true,
    flashOnExposed: true,
    scale: 1.0,
    emphasizeExternalIp: false,
    passThrough: false,
    passThroughOpacity: 0.4
  },
  terminal: {
    maxCastBytes: 50 * 1024 * 1024,
    castKeepDays: 0
  },
  screenshots: {
    keepDays: 0
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
  },
  cloudShare: {
    endpoint: '',
    authToken: ''
  },
  marketplace: {
    // Default: the example registry hosted from this repo on GitHub raw.
    // Deployers running a private registry override this in config.yaml.
    defaultRegistryUrl: 'https://raw.githubusercontent.com/guan4tou2/REDLOG/main/examples/registry/index.json'
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
