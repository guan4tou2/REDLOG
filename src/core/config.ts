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
    /** Consecutive failed reads before the safety verdict expires to 'unknown'.
     *  Deliberately tighter than `confirmations`: being slow to promote a new
     *  address is safe, being slow to expire an old verdict is not. Default: 2. */
    staleAfter: number
    /** how to fetch the external IP: quiet DNS, HTTP echo, or DNS→HTTP fallback */
    ipMode: 'dns' | 'http' | 'auto'
    /** macOS gates the Wi-Fi SSID behind Location Services; opt in to request it
        so the HUD can show the real network name instead of a generic "Wi-Fi". */
    showWifiName: boolean
    vpnAdapters: VpnAdapter[]
  }
  scope: {
    /** Whether D2 (adjacent) violations raise an event + red badge — a target
     *  that is out of scope but sits in a scope entry's container (same subnet
     *  as a single-IP entry, or same registrable domain). D1 (excluded targets)
     *  always raises regardless; D3 (unrelated) is never raised, only counted.
     *  See `ALERT-ROLES.md` Part B. Default: true. */
    warnOnViolation: boolean
    targets: string[]
    excludeTargets: string[]
    /** Container width for the D2 zone derived from a *single-IP* scope entry:
     *  scope `192.168.1.10` makes `192.168.1.0/24` adjacent at the default 24.
     *  Entries already written as CIDRs are not widened. There is deliberately
     *  no domain-side counterpart — the domain container is the registrable
     *  domain, which is not a tunable (`ALERT-ROLES.md` Part C.4). */
    proximityBits: number
    /** Extra multi-label public suffixes on top of the built-in table, used to
     *  decide "same registrable domain" for D2. Additive; built-ins cannot be
     *  removed. Add one when an engagement sits on a suffix RedLog does not
     *  know (`public-suffix.ts` explains why the table is curated). */
    publicSuffixes: string[]
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
  io?: {
    /** io_ref sidecar bodies (io/<sha256>.bin) auto-delete after N days on
     *  project open. `0` (default) = keep forever, matching cast/screenshot
     *  conventions. The chained digest stays; a `system.io_pruned` audit event
     *  is appended per deletion, so a pruned body verifies as pruned, not
     *  tampered (SPEC-IO-SIDECAR.md). This is the *prune* age of the three-stage
     *  lifecycle (SPEC-SCOPE-AWARE-LIFECYCLE.md Part C). */
    keepDays?: number
    /** Warm stage: compress io bodies (gzip in place → `<sha>.bin.gz`) once they
     *  are older than this many days. `0` (default) = never compress. The
     *  ORIGINAL sha256 is kept, so `redlog-verify` decompresses and re-hashes;
     *  reads decompress transparently. Compression is pure win before prune. */
    warmDays?: number
    /** Size cap for the whole `io/` store, in bytes. `0` (default) = no cap.
     *  When exceeded, rotation compresses then prunes **unpinned**
     *  (out-of-scope / unmarked) bodies first — in-scope + loot/marker-referenced
     *  bodies are pinned and evicted last (SPEC-SCOPE-AWARE-LIFECYCLE.md scope-as-pin).
     *  A body still referenced by any event inside its window is never deleted
     *  (refcount-gated). */
    maxBytes?: number
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
    /** Lowest §3 authority tier to forward. 'inferred' (default) sends both
     *  tiers, labelled; 'fact' holds proximity inferences back so the blue team
     *  is only told about observed rule matches. See `ALERT-ROLES.md` G-C2. */
    authorityFloor: 'inferred' | 'fact'
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
  /** v0.6.92 W-project: file-watcher (chokidar). Opt-in — file activity is
   *  noisy without a well-scoped watchPaths list. Emits `file_transfer`
   *  events with subtype `file_created/modified/deleted`. */
  fileWatcher?: {
    enabled: boolean
    /** Absolute paths + globs; empty = disabled */
    watchPaths?: string[]
    /** Additional gitignore-style patterns on top of the built-in defaults
     *  (node_modules/, .git/, dist/, out/, build/, .DS_Store, *.swp, etc) */
    ignorePatterns?: string[]
  }
  /** v0.6.92 W-project: process-spawn monitor (macOS/Linux ps polling).
   *  Emits `process` events with subtype `process_spawn/process_exit`.
   *  Off by default; polling cadence is a CPU/coverage tradeoff. Windows
   *  is unsupported for now and emits a one-shot system advisory. */
  processMonitor?: {
    enabled: boolean
    pollMs?: number
    ignoreCommands?: string[]
  }
  /** v0.7.2 A: agent transcript tailer. Watches `~/.claude/projects/**`
   *  (and future OpenCode/Codex sidecar paths in v0.8.1+) and emits
   *  per-turn `agent.*` events into the hash chain. On by default —
   *  operators using RedLog with a local Claude Code session almost
   *  always want AI audit coverage; a `.redlog-app-root` marker in the
   *  session's cwd still opts individual repos out. See
   *  src/main/services/agent-transcript-tailer.ts. */
  agentTailer?: {
    enabled: boolean
    /** Off by default — thinking blocks are large and mostly meta. Turn on
     *  for engagements where the reasoning transcript is itself audit-
     *  relevant (e.g. AI-safety red-team, tool-use policy compliance). */
    emitThinking?: boolean
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
    staleAfter: 2,
    ipMode: 'auto',
    showWifiName: false,
    vpnAdapters: DEFAULT_VPN_ADAPTERS
  },
  scope: {
    warnOnViolation: true,
    targets: [],
    excludeTargets: [],
    proximityBits: 24,
    publicSuffixes: [],
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
  io: {
    keepDays: 0,
    warmDays: 0,
    maxBytes: 0
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
    includeData: false,
    authorityFloor: 'inferred'
  },
  cloudShare: {
    endpoint: '',
    authToken: ''
  },
  marketplace: {
    // Default: the example registry hosted from this repo on GitHub raw.
    // Deployers running a private registry override this in config.yaml.
    defaultRegistryUrl: 'https://raw.githubusercontent.com/guan4tou2/REDLOG/main/examples/registry/index.json'
  },
  fileWatcher: {
    enabled: false,
    watchPaths: [],
    ignorePatterns: []
  },
  processMonitor: {
    enabled: false,
    pollMs: 500,
    ignoreCommands: []
  },
  agentTailer: {
    enabled: true,
    emitThinking: false
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
  // scope.enforcement: 'warn' | 'log' | 'block' → scope.warnOnViolation: boolean.
  //
  // Only 'log' meant "stay quiet" — and it was misleading even then, since it
  // did not actually log anything, it silently did nothing. Every other value,
  // including the removed 'block' and anything unrecognised, migrates to
  // warnings ON. That direction matters: 'block' was the STRICTEST setting the
  // old field offered, so mapping it to silence would answer a request for more
  // protection with less, on a config the operator never revisits because they
  // believe it is already handled. An operator who wants quiet can turn it off
  // in Settings; one who is quiet without asking never finds out.
  const scope = parsed.scope as Record<string, unknown> | undefined
  if (scope && 'enforcement' in scope && !('warnOnViolation' in scope)) {
    scope.warnOnViolation = scope.enforcement !== 'log'
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

/** Expand `\Q…\E` literal-quoting, at any position and however many times.
 *  Text outside the quoted runs is returned as-is, escapes intact. */
function expandQuoted(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const q = s.indexOf('\\Q', i)
    if (q === -1) { out += s.slice(i); break }
    out += s.slice(i, q)
    const e = s.indexOf('\\E', q + 2)
    out += e === -1 ? s.slice(q + 2) : s.slice(q + 2, e)
    i = e === -1 ? s.length : e + 2
  }
  return out
}

// Anything still regex-shaped after decoding means the entry was not one of the
// forms Burp emits from its own UI — an operator hand-wrote a pattern.
const REGEX_META = /[\\^$*+?()[\]{}|]/

/** Burp/ZAP hold a scope host as a **regex**, not a hostname. Decode the shapes
 *  those tools actually write into RedLog target syntax:
 *
 *    ^example\.com$          → example.com          (exact host)
 *    \Qexample.com\E         → example.com          (literal-quoted)
 *    .*\.example\.com$       → *.example.com        ("and subdomains")
 *    .*\Qcorp.example.com\E  → *.corp.example.com   (same, literal-quoted)
 *
 *  Anything that still looks like a regex afterwards is handed back UNTOUCHED
 *  rather than dropped or half-converted. Such an entry matches nothing, but it
 *  stays visible in the scope list — a scope target that silently disappears is
 *  the failure with no symptom: the operator sees a scope loaded successfully
 *  and never learns that the hosts they were told to test are missing from it.
 *
 *  Before this, only a `\Q` at position 0 was stripped, so Burp's own
 *  "and subdomains" export (`.*\Qcorp.example.com\E`) landed in the scope list
 *  as `*\Qcorp.example.com` and matched nothing (G-CFG2). */
export function burpHostToTarget(host: string): string {
  let s = host.trim().replace(/^\^/, '').replace(/\$$/, '')

  // Leading `.*` is Burp's "and subdomains"; the `.` or `\.` joining it to the
  // host belongs to the wildcard, not to the name.
  let subdomains = false
  if (s.startsWith('.*')) {
    subdomains = true
    s = s.slice(2).replace(/^\\?\./, '')
  }

  const decoded = expandQuoted(s).replace(/\\\./g, '.')
  if (!decoded || REGEX_META.test(decoded)) return host
  return subdomains ? `*.${decoded}` : decoded
}

export function loadScopeFile(scopeFilePath: string): string[] {
  try {
    const raw = fs.readFileSync(scopeFilePath, 'utf-8')
    const ext = path.extname(scopeFilePath).toLowerCase()

    if (ext === '.json') {
      const data = JSON.parse(raw)
      if (data.target?.scope) {
        return data.target.scope.flatMap((s: { host?: string }) => {
          if (s.host) return [burpHostToTarget(s.host)]
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
