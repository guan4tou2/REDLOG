import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import * as yaml from 'js-yaml'
import { DEFAULT_BROWSER } from './browser-defaults'
import { loadYamlDocument } from './yaml-document'
import { mkdirPrivate, writePrivateFileAtomic } from './private-fs'
import { CONFIG_INVALID_TAG } from './config-invalid'

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
    activeTarget?: string | null
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
    /** OPSEC air-gap. When true RedLog makes NO outbound network requests of
     *  its own: OpenTimestamps anchoring, NTP time-sync, the GitHub update
     *  check and the external-IP lookup are all suppressed. Capture and the
     *  local API (127.0.0.1) are unaffected. The chain still hashes + signs;
     *  it just is not anchored to a public calendar until you leave air-gap.
     *  Default false. Set it before an engagement that requires egress
     *  containment or must not be attributable by periodic third-party calls. */
    offline: boolean
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
    /** Hosts/IPs that are never part of any engagement — personal traffic,
     *  localhost, update CDNs. Same syntax as excludeTargets (IP, CIDR,
     *  *.domain). On export these rows are DROPPED entirely (not masked):
     *  they should not appear in any deliverable or merge pack. */
    personalDomains: string[]
    scopeFile: string | null
  }
  screenshot: {
    quality: number
    /** Periodic auto-capture interval in seconds. 0 = disabled. Deduped
     *  against the previous frame's SHA-256 (see ScreenshotAgent), so a
     *  30s interval on an idle screen doesn't produce 120 dupes/hour. */
    intervalSec: number
    /** Perceptual-diff threshold for AUTOMATIC captures (periodic/idle): a
     *  frame whose dHash Hamming distance from the last stored frame is BELOW
     *  this is treated as "no visible change" and skipped. Higher = only store
     *  bigger changes; `0` = disable perceptual dedup and store every
     *  non-byte-identical frame. Manual captures ignore it entirely. Default 5
     *  (mouse/clock jitter ≈2-3 bits, one new terminal line ≈6-10). */
    diffThreshold?: number
    /** Capture a screenshot when a shell command finishes, linked to that
     *  command via `_causes` — so a report's "this command produced this
     *  screen" is automatic, not a manual ⌘⇧M. Off by default: it only earns
     *  its keep for GUI-heavy work (Burp, a browser), and the perceptual dedup
     *  still skips a command that changed nothing visible. Terminal output is
     *  better read from the `.cast` recording (searchable text) than a JPEG. */
    captureOnCommand?: boolean
  }
  // `overlay` is gone: the HUD's settings are machine-wide now
  // (src/core/hud-prefs.ts). An old config.yaml may still carry the block; it
  // is read once to seed them and otherwise ignored.
  terminal: {
    /** Maximum physical cast-part bytes; capacity rotates, never stops capture.
     *  Store-wide cleanup lives under `retention.casts`. */
    maxCastBytes: number
  }
  /** Clipboard monitor tuning. Whether it runs is the Host monitors pack
   *  (`packs.hostMonitors`, Spec 035) — clipboard is sensitive, off by default. */
  clipboard: {
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
  httpCapture: {
    /** Port owned by RedLog's managed regular-mode mitmdump process. */
    port: number
    /** Address it binds. Loopback by default, so the proxy is reachable only
     *  from this machine. Widen it (a LAN address, or `0.0.0.0`) to point a
     *  victim VM, a phone, a container or a NAT'd WSL distro at the capture —
     *  and read the warning in Settings first: a proxy on the engagement
     *  network is reachable by anything else on it too. */
    listenHost: string
    routeTerminals: boolean
  }
  redaction: {
    allowlist: string[]
    denylist: string[]
    entropyThreshold: number
    minLength: number
  }
  /** v0.6.92 W-project: file-watcher (chokidar). Opt-in — file activity is
   *  noisy without a well-scoped watchPaths list. Emits `file_transfer`
   *  events with subtype `file_created/modified/deleted`. */
  fileWatcher?: {
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
    pollMs?: number
    ignoreCommands?: string[]
  }
  /** Connection-level network capture (DESIGN-core-and-capture.md §2.1).
   *  Polls the socket table for established connections; no payload, no root.
   *  Off by default — it is capture the operator opts into, and it shells out
   *  every pollMs. */
  connectionMonitor?: {
    pollMs?: number
  }
  /** Optional capture, one switch per pack (Spec 035): Host monitors (process,
   *  connection, file, clipboard), AI agents (transcript tailers), Windows
   *  output (PowerShell Start-Transcript follower). A pack runs only when this
   *  is on AND its bundled plugin is active (core/capture-packs.ts). All off by
   *  default. The members' own `enabled` keys were removed and are not read. */
  packs?: {
    hostMonitors?: boolean
    windowsOutput?: boolean
  }
  /** Per-member opt-outs inside a pack that is on. A pack is a PRESET, not an
   *  atom: "Host monitors" bundles four sources, and the clipboard is not like
   *  the other three. It samples whatever the operator copies anywhere on the
   *  machine for the length of the engagement — a password out of their own
   *  vault, a colleague's message, a client's data that was never in scope —
   *  and the other three are why an operator turns the pack on. Making that
   *  all-or-nothing means the answer to "I want process and connection
   *  monitoring but not my clipboard" is "then have neither", and an operator
   *  who wants the three takes the fourth without meaning to.
   *
   *  ABSENT MEANS ON. The pack's switch is the preset; this only records where
   *  the operator has departed from it, so turning a pack on still means what
   *  it has always meant and no existing project changes behaviour. */
  packMembers?: {
    processMonitor?: boolean
    connectionMonitor?: boolean
    fileWatcher?: boolean
    clipboard?: boolean
    powershellTranscript?: boolean
  }
  /** Optional AI capture. Every tool needs its own installed integration,
   * explicit project directory permission and activation boundary. Empty
   * sources never authorize transcript access. */
  agentTailer?: {
    sources?: Partial<Record<import('./agent-capture-policy').AgentKind, import('./agent-capture-policy').AgentCaptureSourceConfig>>
    /** Off by default — thinking blocks are large and mostly meta. Turn on
     *  for engagements where the reasoning transcript is itself audit-
     *  relevant (e.g. AI-safety red-team, tool-use policy compliance). */
    emitThinking?: boolean
  }
  /** Loot detection (Spec 032). */
  loot?: {
    /** Rule ids (`listLootRules()`) not recorded as loot. A rule that is off
     *  still matches for masking — its values are redacted either way. Ships
     *  with the two noisiest built-ins off: `jwt` fires on every bearer header
     *  in HTTP traffic, `generic_api_key` on `password=` in help text and error
     *  messages. */
    disabledRules?: string[]
  }
  /** Every store's retention, one section (Spec 028). Two knobs, the same
   *  names everywhere they apply:
   *  - `keepDays` — age sweep on project open. `0` = keep forever (default for
   *    every store: RedLog is an evidence recorder, "recorded → kept").
   *  - `maxBytes` — size pressure on a file store. When over budget the
   *    coldest UNPINNED files go first; files of an in-scope target are pinned
   *    and never evicted (body-eviction.ts, retention.ts `sweepArtifactStore`).
   *    `0` = unbounded.
   *  For file stores the event row and its sha256 attestation always survive;
   *  only the file goes, with a `system.*_pruned` / `*_evicted` audit row per
   *  deletion. See docs/design/DESIGN-logged-tier-retention.md for the row tier. */
  retention?: {
    /** `.cast` terminal recordings (`casts/`). */
    casts?: { keepDays?: number; maxBytes?: number }
    /** Screenshot images (`screenshots/`). Capture cadence and quality are
     *  the separate `screenshot` section. */
    screenshots?: { keepDays?: number; maxBytes?: number }
    /** Captured HTTP request/response bodies (`http-bodies/`). */
    httpBodies?: { keepDays?: number; maxBytes?: number }
    /** Agent transcript sidecars (`agent-transcripts/`). Kept forever by
     *  default: pruning a sidecar whose source .jsonl still exists used to
     *  re-ingest every historical turn (v0.7.4 F2). */
    agentTranscripts?: { keepDays?: number }
    /** Row-level retention on the events_logged table. The design doc
     *  reserves `maxSizeGb` + `maxRowCount`
     *  ceilings for a follow-up; they are intentionally NOT declared here
     *  so an operator who sets them can't get a silent no-op. See design
     *  doc §7.1 for the second-pass shape. */
    loggedTier?: {
      /** Days to keep. `0` = keep forever (matches cast/screenshot
       *  convention). Default `0` (keep forever) since v0.15 (#91). */
      keepDays?: number
      /** Periodic sweep interval in hours. `0` disables the timer — the
       *  project-open sweep still runs. Default `24`. */
      sweepIntervalHours?: number
    }
    /** Bookmarks (the 書籤 page) are a private notepad, not chained evidence —
     *  yet they store pasted credentials and the captured external IP, so
     *  permanent retention is the wrong default once you accept they are not
     *  a record. Age-based cleanup on project open. `0` (default) = keep
     *  forever, matching the other keep-days; a `system.bookmarks_pruned`
     *  audit row (count only, no content) records each sweep. */
    bookmarks?: {
      keepDays?: number
    }
  }
}

export const DEFAULT_CONFIG: RedLogConfig = {
  engagement: {
    id: 'default',
    activeTarget: null
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
    offline: false,
    showWifiName: false,
    vpnAdapters: DEFAULT_VPN_ADAPTERS
  },
  scope: {
    warnOnViolation: true,
    targets: [],
    excludeTargets: [],
    personalDomains: ['127.0.0.0/8', '::1', 'localhost'],
    scopeFile: null
  },
  screenshot: {
    quality: 85,
    intervalSec: 0,
    diffThreshold: 5,
    captureOnCommand: false
  },
  terminal: {
    maxCastBytes: 50 * 1024 * 1024
  },
  clipboard: {
    pollMs: 1500,
    storePreview: false
  },
  browser: { ...DEFAULT_BROWSER, extraArgs: [] },
  httpCapture: {
    routeTerminals: false,
    // Not 8080: that is Burp Suite's default listener, and Burp is running on
    // most machines this product is installed on, so the old default
    // guaranteed a bind failure on first use. 6661 sits next to the RedLog
    // API's 6660. An operator who has already set a port keeps it.
    port: 6661,
    listenHost: '127.0.0.1'
  },
  redaction: {
    allowlist: [],
    denylist: [],
    entropyThreshold: 4.5,
    minLength: 20
  },
  fileWatcher: {
    watchPaths: [],
    ignorePatterns: []
  },
  processMonitor: {
    pollMs: 500,
    ignoreCommands: []
  },
  connectionMonitor: {
    pollMs: 2000
  },
  packs: {
    hostMonitors: false,
    windowsOutput: false
  },
  agentTailer: {
    emitThinking: false
  },
  loot: {
    disabledRules: ['jwt', 'generic_api_key']
  },
  retention: {
    // v0.13.0→v0.15: default changed from 30 to 0 (keep forever) — #91.
    // 30d silently dropped traffic evidence; RedLog's positioning as an
    // evidence-chain tool means "recorded → kept" is the safe default.
    // Operators who need disk-pressure relief set keepDays in Settings.
    loggedTier: {
      keepDays: 0,
      sweepIntervalHours: 24
    },
    bookmarks: {
      keepDays: 0
    },
    casts: { keepDays: 0, maxBytes: 0 },
    screenshots: { keepDays: 0, maxBytes: 0 },
    httpBodies: { keepDays: 0, maxBytes: 0 },
    agentTranscripts: { keepDays: 0 }
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

/** The config a new project starts with: the loaded defaults, the engagement
 *  id seeded from the project, and what the create card sent. Sections are
 *  merged field by field; `scope.personalDomains` is ADDED to the defaults
 *  (loopback, localhost) rather than replacing them, so the card can send the
 *  operator's own IP in the same call (Spec 037). */
export function mergeInitialConfig(config: RedLogConfig, projectId: string, initial?: Partial<RedLogConfig>): RedLogConfig {
  const personal = [...(config.scope.personalDomains ?? [])]
  for (const d of initial?.scope?.personalDomains ?? []) if (!personal.includes(d)) personal.push(d)
  return {
    ...config,
    // The id is always the project's own. A caller-supplied one gave two
    // projects the same engagement id, which every event row and the spool's
    // attribution boundary rely on being distinct.
    engagement: { ...config.engagement, ...initial?.engagement, id: projectId },
    operator: { ...config.operator, ...initial?.operator },
    network: { ...config.network, ...initial?.network },
    scope: { ...config.scope, ...initial?.scope, personalDomains: personal },
    screenshot: { ...config.screenshot, ...initial?.screenshot }
  }
}

/** A copy of the defaults nobody else holds. A loaded config is its caller's
 *  to change (targetContext:set assigns `engagement.activeTarget` and saves),
 *  so it must never be, or contain, DEFAULT_CONFIG's own objects: a shallow
 *  copy, or a section the file leaves unset, would carry that change into
 *  every later load in the process. */
const defaults = (): RedLogConfig => structuredClone(DEFAULT_CONFIG)

/** What is on disk, in the three cases a caller has to tell apart.
 *
 *  `absent` is a project that has never been opened: the defaults ARE its
 *  config. `invalid` is a file that is there and cannot be used — a typo, a
 *  merge marker, a list or a scalar at the top, an empty file, something that
 *  is not a file. Its defaults would be a different engagement (`engagement.id`
 *  `default`, operator `operator-1`, no scope, offline off), so nothing may be
 *  read from it, and above all nothing may be written over it. */
export type ConfigRead =
  | { kind: 'absent'; config: RedLogConfig }
  | { kind: 'ok'; config: RedLogConfig }
  | { kind: 'invalid'; file: string; reason: string }

/** Thrown by `loadConfig` for an `invalid` file. The message carries the tag
 *  the renderer recognises after IPC (core/config-invalid.ts), the file, and a
 *  short reason. */
export class ConfigInvalidError extends Error {
  constructor(readonly file: string, readonly reason: string) {
    super(`${CONFIG_INVALID_TAG} ${file}: ${reason}`)
    this.name = 'ConfigInvalidError'
  }
}

function parseFailure(e: unknown): string {
  if (e instanceof yaml.YAMLException) {
    const line = typeof e.mark?.line === 'number' ? ` (line ${e.mark.line + 1})` : ''
    return `not valid YAML: ${e.reason || 'parse error'}${line}`
  }
  return 'not valid YAML'
}

export function readConfig(projectDir: string): ConfigRead {
  const file = path.join(projectDir, 'config.yaml')
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf-8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return { kind: 'absent', config: defaults() }
    return { kind: 'invalid', file, reason: `cannot be read (${code ?? 'unknown error'})` }
  }
  let parsed: unknown
  try { parsed = loadYamlDocument(raw) } catch (e) { return { kind: 'invalid', file, reason: parseFailure(e) } }
  // An empty file is not "no settings": a save cut off after the truncate
  // leaves exactly this, and its defaults would rebind the engagement id.
  if (parsed === null || parsed === undefined) return { kind: 'invalid', file, reason: 'empty, not a mapping' }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', file, reason: `not a mapping (a ${Array.isArray(parsed) ? 'list' : typeof parsed})` }
  }
  return { kind: 'ok', config: deepMerge(defaults() as unknown as Record<string, unknown>, parsed as Record<string, unknown>) as unknown as RedLogConfig }
}

/** The config, or the defaults when there is no file. Throws
 *  `ConfigInvalidError` for a file that is there and unusable — it used to
 *  return the defaults, which the open then wrote over the file and every
 *  caller acted on as if they were the operator's settings.
 *
 *  Each caller still reads the file itself; one config view for the open
 *  project is Spec 073. */
export function loadConfig(projectDir: string): RedLogConfig {
  const read = readConfig(projectDir)
  if (read.kind === 'invalid') throw new ConfigInvalidError(read.file, read.reason)
  return read.config
}

/** The config a project open binds to, written back so the file carries every
 *  current section. Called before the open project is closed: a file that
 *  cannot be used throws here with nothing written and nothing stopped. */
export function prepareOpenConfig(projectDir: string): RedLogConfig {
  const config = loadConfig(projectDir)
  saveConfig(projectDir, config)
  return config
}

/** Writes the file and returns its revision (see `readConfigRevision`). */
export function saveConfig(projectDir: string, config: RedLogConfig): string {
  mkdirPrivate(projectDir)
  const configPath = path.join(projectDir, 'config.yaml')
  // Whole or not at all, owner-only like the database beside it (scope,
  // operator and integration settings): a write cut off in place is how an
  // unparseable config.yaml appears in the first place.
  const text = yaml.dump(config, { lineWidth: 120 })
  writePrivateFileAtomic(configPath, text)
  return revisionOf(text)
}

const revisionOf = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)

/** A content hash of config.yaml as it is on disk: it moves with every write
 *  that changes the file, by any writer — including a hand edit or an older
 *  code path that knows nothing about revisions, which a counter kept by the
 *  saver would miss. A missing file has the revision of an empty one. */
export function readConfigRevision(projectDir: string): string {
  try { return revisionOf(fs.readFileSync(path.join(projectDir, 'config.yaml'), 'utf-8')) } catch { return revisionOf('') }
}

/** The scope actually in force, as one value.
 *
 *  `config.scope.targets` is not it: a project can point at a Burp or ZAP scope
 *  FILE, and what the policy sees is the concatenation. That merge used to be
 *  written out by hand at three call sites in main, which meant three chances
 *  for "the scope" to mean three different things — and the recompute needs a
 *  single answer, because it hashes this to decide whether the boundary moved
 *  at all.
 *
 *  The file's sha256 is carried separately because the path alone cannot say
 *  whether the boundary changed: an operator editing the file on disk moves the
 *  scope without touching the config. */
export interface ScopeInForce {
  targets: string[]
  excludeTargets: string[]
  personalDomains: string[]
  scopeFile: string | null
  scopeFileSha256: string | null
  scopeFileEntries: number
}

/** The one rule for "how many boundaries is this": the config list, then the
 *  scope file's entries that are not already in it. `snapshotScope` and
 *  `readProjectScope` both go through here, so the project picker's count and
 *  the scope the policy enforces cannot drift apart. */
function appendUnique(into: string[], extra: readonly string[]): void {
  for (const t of extra) if (!into.includes(t)) into.push(t)
}

export function snapshotScope(config: RedLogConfig): ScopeInForce {
  const targets = [...(config.scope?.targets ?? [])]
  let scopeFileSha256: string | null = null
  let scopeFileEntries = 0
  const scopeFile = config.scope?.scopeFile || null
  if (scopeFile) {
    const loaded = loadScopeFile(scopeFile)
    scopeFileEntries = loaded.length
    if (loaded.length > 0) {
      // Deduped, order preserved: an entry present in both the config list and
      // the file is one boundary, not two, and a stable order keeps the hash
      // stable across restarts.
      appendUnique(targets, loaded)
      scopeFileSha256 = crypto.createHash('sha256').update(loaded.join('\n')).digest('hex')
    }
  }
  return {
    targets,
    excludeTargets: [...(config.scope?.excludeTargets ?? [])],
    personalDomains: [...(config.scope?.personalDomains ?? [])],
    scopeFile,
    scopeFileSha256,
    scopeFileEntries
  }
}

export type ScopeFileRead =
  | { ok: true; entries: string[] }
  /** `unreadable`: missing or no permission. `invalid`: JSON that does not parse. */
  | { ok: false; reason: 'unreadable' | 'invalid' }

/** Like `loadScopeFile`, but says WHY nothing came back. An unreadable scope
 *  file used to read as an empty one, so a scope that was silently not
 *  enforced looked the same as a scope file with no entries in it. */
export function readScopeFile(scopeFilePath: string): ScopeFileRead {
  let raw: string
  try { raw = fs.readFileSync(scopeFilePath, 'utf-8') } catch { return { ok: false, reason: 'unreadable' } }
  const ext = path.extname(scopeFilePath).toLowerCase()
  if (ext === '.json') {
    let data: unknown
    try { data = JSON.parse(raw) } catch { return { ok: false, reason: 'invalid' } }
    const d = data as { target?: { scope?: Array<{ host?: string }> } }
    if (d?.target?.scope) {
      return { ok: true, entries: d.target.scope.flatMap((s) => (s.host ? [s.host.replace(/^\\Q|\\E$/g, '').replace(/^\.\*/g, '*')] : [])) }
    }
    if (Array.isArray(data)) return { ok: true, entries: data.filter((x: unknown): x is string => typeof x === 'string') }
    return { ok: true, entries: [] }
  }
  return { ok: true, entries: raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) }
}

export function loadScopeFile(scopeFilePath: string): string[] {
  const r = readScopeFile(scopeFilePath)
  return r.ok ? r.entries : []
}

/** What the project picker may say about a project's scope without opening it.
 *  `unknown` is a first-class answer: it means the scope could not be read
 *  (corrupt config.yaml, unreadable or invalid scope file), which is NOT the
 *  same as `unset`. Any one failure makes the whole answer `unknown` — a count
 *  from the part that did read would look like a total. */
export type ProjectScopeSummary =
  | { state: 'set'; count: number }
  | { state: 'unset' }
  | { state: 'unknown' }

/** Read-only and deliberately not built on `loadConfig` (which throws, and
 *  this answers for every project in the picker) or `snapshotScope` (which
 *  turns an unreadable scope file into an empty one). Writes nothing, opens no
 *  database. */
export function readProjectScope(projectDir: string): ProjectScopeSummary {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(projectDir, 'config.yaml'), 'utf-8')
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { state: 'unset' } : { state: 'unknown' }
  }
  let parsed: unknown
  try { parsed = loadYamlDocument(raw) } catch { return { state: 'unknown' } }
  if (parsed === undefined || parsed === null) return { state: 'unset' }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unknown' }
  const scope = (parsed as { scope?: unknown }).scope
  if (scope === undefined || scope === null) return { state: 'unset' }
  if (typeof scope !== 'object' || Array.isArray(scope)) return { state: 'unknown' }
  const { targets, scopeFile } = scope as { targets?: unknown; scopeFile?: unknown }
  if (targets !== undefined && targets !== null && !Array.isArray(targets)) return { state: 'unknown' }
  const merged = ((targets as unknown[] | undefined) ?? []).filter((t): t is string => typeof t === 'string')
  if (typeof scopeFile === 'string' && scopeFile) {
    const file = readScopeFile(scopeFile)
    if (!file.ok) return { state: 'unknown' }
    appendUnique(merged, file.entries)
  }
  return merged.length > 0 ? { state: 'set', count: merged.length } : { state: 'unset' }
}
