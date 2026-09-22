/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ProjectMeta {
  id: string
  name: string
  createdAt: number
  lastOpened: number
  path: string
  dbSize?: number
}

interface ExportSnapshot {
  chainedMaxRowId: number
  loggedMaxRowId: number
  takenAt: number
}

type ExportFormat = 'json' | 'ndjson' | 'bundle' | 'har' | 'timeline'
type ExportSubset = { kind: 'all' } | { kind: 'time-range'; since: number; before: number; targetId?: string }
interface ExportRequest {
  format: ExportFormat
  subset?: ExportSubset
  sharing?: boolean
  maskOutOfScope?: boolean
  scopeOnly?: boolean
  scrubPii?: boolean
}
interface ResolvedExportPlan {
  id: string
  fingerprint: string
  expiresAt: number
  snapshot: ExportSnapshot
  request: Required<Omit<ExportRequest, 'subset'>> & { subset: ExportSubset }
  capabilities: {
    snapshot: boolean
    boundedSubset: boolean
    scopeMasking: boolean
    piiScrubbing: boolean
    attachments: boolean
  }
  counts: {
    examined: number
    included: number
    excludedDoNotExport: number
    excludedPersonal: number
    excludedBlacklist: number
    maskedOutOfScope: number
    sanitized: number
    attachmentsIncluded: number
    attachmentsMissing: number
    attachmentsUnattributed: number
    unsupported: number
  }
}
type ExportPlanResponse = { ok: true; plan: ResolvedExportPlan } | { ok: false; error: string }
type ExportPlanResult = { ok: true; planId: string; fingerprint: string; artifactPath: string; counts: ResolvedExportPlan['counts']; warnings: string[] } | { ok: false; error: string; planId?: string; fingerprint?: string }

interface ExportPreview {
  total: number
  included: number
  dropped: number
  personalDropped: number
  blacklisted: number
  outOfScope: number
  inScope: number
  sanitized: number
  doNotExportCount: number
  hasScope: boolean
  sharing: boolean
  withBodyRefs: number
  screenshotEvents: number
  snapshot: ExportSnapshot
}

interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  ipSafety: 'safe' | 'exposed' | 'unknown'
  lastCheck: number
  error: string | null
    link?: { type: 'wifi' | 'wired' | 'unknown'; name: string }
}

interface RedLogEvent {
  id: string
  timestamp: number
  engagementId: string
  sessionId: string
  operatorId: string
  agentType: string
  hostname: string
  sourceIP: string | null
  targetId: string | null
  data: Record<string, unknown>
  hash?: string
  createdAt: number
  monotonicNs?: string | null
  ntpOffsetMs?: number | null
  tier: 'chained' | 'logged'
}

interface BookmarkContext {
  browserUrl?: string
  browserTitle?: string
  externalIP?: string
  lastCommand?: string
}

interface SavedTimelineViewState {
  timeStart?: number
  timeEnd?: number
  zoom?: number
  hiddenLanes?: string[]
  filterQuery?: string
}

interface SavedTimelineView {
  id: string
  name: string
  createdAt: number
  state: SavedTimelineViewState
}

interface Bookmark {
  id: string
  title: string
  url: string | null
  note: string
  context: BookmarkContext
  createdAt: number
}

interface BrowserTabInfo {
  url: string | null
  title: string | null
  connected: boolean
  /** Port the connector is polling — quote this in setup guidance. */
  port: number
}

interface WslDistro {
  name: string
  state: 'Running' | 'Stopped' | 'Installing' | 'Converting'
  version: number
  isDefault: boolean
  shells: string[]
  hookStatus: {
    bash: 'installed' | 'not-installed' | 'no-shell'
    zsh: 'installed' | 'not-installed' | 'no-shell'
  }
}

interface WslDiagnosticResult {
  distro: string
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }>
}

interface RedLogAPI {
  platform: string
  app: {
    checkForUpdates: () => Promise<void>
    anchorForRestart?: (opts?: { toVersion?: string }) => Promise<import('../../core/update-anchor').RestartAnchorResult>
    openExternal: (url: string) => Promise<void>
  }
  ui: {
    contextMenu: (
      items: Array<{ id?: string; label?: string; enabled?: boolean; type?: 'separator' }>
    ) => Promise<string | null>
  }
  clipboard: {
    writeText: (text: string) => Promise<boolean>
    readText: () => Promise<string>
  }
  project: {
    list: () => Promise<ProjectMeta[]>
    create: (name: string, initialConfig?: Partial<RedLogConfigPartial>) => Promise<ProjectMeta>
    open: (id: string) => Promise<ProjectMeta | null>
    delete: (id: string) => Promise<boolean>
    active: () => Promise<{ id: string; name: string; createdAt: number } | null>
    close: () => Promise<boolean>
    rename: (id: string, name: string) => Promise<{ ok: boolean; name?: string; error?: string }>
  }
  ip: {
    getStatus: () => Promise<IPStatus>
    onStatus: (cb: (status: IPStatus) => void) => () => void
  }
  config: {
    get: () => Promise<unknown>
    save: (config: unknown) => Promise<boolean>
    exportProfile: () => Promise<string | null>
    importProfile: () => Promise<unknown | null>
  }
  targetContext: {
    get: () => Promise<string | null>
    set: (target: string | null) => Promise<{ ok: boolean; target: string | null }>
    onChange: (cb: (target: string | null) => void) => () => void
  }
  hookConfig: {
    get: () => Promise<{ excludedPaths: string[]; watchPaths?: string[] }>
    save: (cfg: { excludedPaths?: string[]; watchPaths?: string[] }) => Promise<boolean>
    pickPath: () => Promise<string | null>
  }
  events: {
    query: (opts: import('../../core/db/events').EventQueryOptions) => Promise<RedLogEvent[]>
    queryPage: (opts: import('../../core/db/events').EventFilter & { limit?: number; cursor?: string | null }) => Promise<{
      items: RedLogEvent[]
      hasMore: boolean
      nextCursor: string | null
    }>
    queryHttpFlowPage: (opts: import('../../core/db/events').EventFilter & { limit?: number; cursor?: string | null }) => Promise<import('../../core/db/events').HttpFlowPage>
    /** v0.13.0: optional tier. Omitted (or 'chained') = the chained/audit
     *  count — every existing caller means this. 'logged' returns the
     *  supporting-evidence count. 'all' returns both summed. */
    getCount: (tier: import('../../core/db/events').EventTierFilter) => Promise<number>
    /** v0.14.3 §9.5: timestamp of the newest logged-tier row, or null
     *  if none have been written. Drives the CaptureHealthCard "last
     *  fed" freshness readout without pulling row bodies. */
    getLatestLoggedTs: () => Promise<number | null>
    search: (query: string, limit?: number, opts?: import('../../core/db/events').EventFilter) => Promise<RedLogEvent[]>
    runQuery: (
      req: import('../../core/db/events').EventQueryRequest
    ) => Promise<import('../../core/db/events').EventQueryResult>
    toolCounterparts: (
      keys: import('../../core/db/events').ToolPairKey[]
    ) => Promise<RedLogEvent[]>
    searchPage: (opts: import('../../core/db/events').EventFilter & { query: string; limit?: number; cursor?: string | null }) => Promise<{
      items: RedLogEvent[]
      hasMore: boolean
      nextCursor: string | null
    }>
    distinctAgentTypes: () => Promise<string[]>
    /** §9/§14-4c: per-target counts + first/last-seen, aggregated in SQL over
     *  the whole timeline (both tiers) — replaces a capped client-side rollup. */
    aggregateTargets: () => Promise<import('../../core/db/events').TargetAggregate[]>
    queryTargetPage: (opts: { targetId: string; limit?: number; cursor?: string | null }) => Promise<{
      items: RedLogEvent[]
      hasMore: boolean
      nextCursor: string | null
    }>
    queryScreenshotPage: (opts: { limit?: number; cursor?: string | null; trigger?: string | null }) => Promise<{
      items: RedLogEvent[]
      hasMore: boolean
      nextCursor: string | null
    }>
    /** §10: distinct hosts across the timeline for ⌘K host search. */
    distinctHosts: () => Promise<import('../../core/db/events').HostAggregate[]>
    hostChain?: (host: string, opts?: { chainLimit?: number }) => Promise<import('../../core/db/events').HostCausalChain | null>
    /** Full-text search inside terminal recordings — see src/core/cast-index.ts. */
    searchCasts: (query: string, limit?: number) => Promise<Array<{
      castRel: string; tMs: number; off: number; len: number; snippet: string
    }>>
    castIndexStatus: () => Promise<{ total: number; indexed: number; pending: number }>
    readCastRange: (castRel: string, off: number, len: number) => Promise<{
      text: string; bytes: number; truncated: boolean
    } | null>
    queryByFlowId: (flowId: string) => Promise<RedLogEvent[]>
    getById: (ids: string[]) => Promise<RedLogEvent[]>
    causalChain: (anchorId: string, opts?: { maxDepth?: number; eventLimit?: number }) => Promise<import('../../core/db/events').EventCausalChain>
    onNewBatch: (cb: (events: RedLogEvent[]) => void) => () => void
    logSecretRevealed: (sourceEventId: string, fields: string[]) => Promise<{ ok: boolean } | null>
    toggleDoNotExport: (eventId: string) => Promise<boolean | null>
    isDoNotExport: (eventId: string) => Promise<boolean>
  }
  httpBody: {
    read: (ref: { sha256: string; size: number; file: string; encoding: 'text' | 'base64' }) => Promise<string | null>
  }
  marker: {
    create: (data: Record<string, unknown>) => Promise<RedLogEvent>
    /** Append a correction. Never mutates the marker — see core/marker-amend.ts. */
    amend: (markerId: string, changes: { title?: string; severity?: string; notes?: string }) =>
      Promise<{ ok: true; event: RedLogEvent } | { ok: false; error: string; detail?: string }>
    amendments: (ids: string[]) => Promise<RedLogEvent[]>
    onShortcut: (cb: () => void) => () => void
  }
  screenshot: {
    capture: (causeEventId?: string) => Promise<string | null>
    deleteFile: (eventId: string, filePath: string) => Promise<{ ok: boolean; error?: string }>
    /** 2d batch-delete: subset of these screenshot ids that a marker cites. */
    markerReferenced: (ids: string[]) => Promise<string[]>
  }
  scope: {
    getViolations: () => Promise<Array<{
      id: string; target: string; command: string; timestamp: number
      sourceTs?: number; distance: string; judged: 'live' | 'retroactive'; cleared: boolean
    }>>
    getViolationCount: () => Promise<number>
    isConfigured: () => Promise<boolean>
    /** The newest scope_recomputed summary, or null. The Scope banner is a
     *  projection of this row, which is why it needs no dismissal state. */
    getLastRecompute: () => Promise<Record<string, unknown> | null>
  }
  chain: {
    length: () => Promise<number>
    anchors: () => Promise<ChainAnchorInfo[]>
    anchorNow: () => Promise<ChainAnchorInfo | null>
    verify: (opts?: { full?: boolean }) => Promise<{ ok: boolean; anchor: ChainAnchorInfo | null; currentHead: string | null; walked?: number; brokenAtEventId?: string | null; brokenReason?: string | null; clockAnomalies?: Array<{ eventId: string; reason: string }>; anchorMatchesWalkedHead?: boolean }>
    upgrade: (id?: string) => Promise<ChainAnchorInfo | { upgraded: number; scanned: number } | null>
  }
  loot: {
    getCount: () => Promise<number>
  }
  bookmarks: {
    list: () => Promise<Bookmark[]>
    get: (id: string) => Promise<Bookmark | null>
    create: (data: { title: string; url?: string; note?: string }) => Promise<Bookmark>
    update: (id: string, data: Partial<Bookmark>) => Promise<Bookmark | null>
    delete: (id: string) => Promise<boolean>
  }
  // v0.6.96 Clean-3: preload always exports views (v0.6.90 D); the `?` was
  // a leftover from the first day when the shim was optional. Types now
  // reflect reality.
  views: {
    list: () => Promise<SavedTimelineView[]>
    save: (data: { name: string; state: SavedTimelineViewState }) => Promise<SavedTimelineView>
    delete: (id: string) => Promise<boolean>
  }
  cdp: {
    getTab: () => Promise<BrowserTabInfo>
    setPort: (port: number) => Promise<boolean>
  }
  browser: {
    detect: () => Promise<string | null>
    status: () => Promise<{ running: boolean }>
    launch: () => Promise<BrowserLaunchResult>
    stop: () => Promise<{ stopped: boolean }>
  }
  data: {
    resolveExportPlan: (request: ExportRequest) => Promise<ExportPlanResponse>
    executeExportPlan: (input: { planId: string }) => Promise<ExportPlanResult>
    revealPath: (target: string) => Promise<boolean>
  }
  visibility: {
    /** §22 disclosure signals, or null with no project open. */
    signals: () => Promise<{
      evidenceSeen: boolean
      transcriptSeen: boolean
      targetCount: 0 | 1 | 2
      lootSeen: boolean
      screenshotSeen: boolean
      bookmarkSeen: boolean
      httpFlowSeen: boolean
      loggedEver: boolean
    } | null>
  }
  recording: {
    get: () => Promise<boolean>
    toggle: () => Promise<boolean>
    onChange: (cb: (recording: boolean) => void) => () => void
  }
  terminal: {
    spawn: (id: string, cols: number, rows: number, shellId?: string) =>
      Promise<{ pid: number; shell: string; shellLabel: string; hookSourced: boolean; recording: boolean; castTruncated: boolean }>
    shells: () => Promise<Array<{ id: string; label: string; flavour: 'powershell' | 'posix' | 'none' }>>
    rediscoverShells: () => Promise<Array<{ id: string; label: string; flavour: 'powershell' | 'posix' | 'none' }>>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    list: () => Promise<Array<{
      id: string; pid: number; lastActivity: number
      /** 2b per-pane chip: open cast stream and under the size cap. */
      recording: boolean; castBytes: number; castTruncated: boolean; castStartedAt: number | null
    }>>
    onData: (id: string, cb: (data: string) => void) => () => void
    onExit: (id: string, cb: (exitCode: number) => void) => () => void
    onCastState: (id: string, cb: (state: { recording: boolean; castTruncated: boolean }) => void) => () => void
    replay: (eventId: string) => Promise<{ ok: boolean; command?: string; exitCode?: number; durationSec?: number; text?: string; bytes?: number; error?: string }>
    replaySession: (eventId: string) => Promise<{ ok: boolean; text?: string; bytes?: number; truncated?: boolean; castPath?: string; events?: Array<[number, 'o', string]>; error?: string }>
    /** A discriminated union, not a bag of optionals: the handler returns
     *  either `{ ok: false, error }` or `{ ok: true, events, … }`, and it
     *  never returns `ok: true` without events. Typing it as
     *  `{ ok: boolean; events?: … }` meant `if (!r.ok) return` narrowed
     *  nothing, so the caller was handed `events: … | undefined` for a field
     *  `replayStore.open` requires — TS2322, which is how main stopped
     *  compiling. */
    replayAtTime: (atMs: number) => Promise<
      | { ok: true; events: Array<[number, 'o', string]>; truncated?: boolean; seekMs?: number }
      | { ok: false; error: string }
    >
  }
  overlay: {
    toggle: () => void
    hide: () => void
    show: () => void
    isVisible: () => Promise<boolean>
    onVisibilityChanged: (cb: (visible: boolean) => void) => () => void
    setExpanded?: (expanded: boolean) => void
    moveToCorner: (corner: 'tl' | 'tr' | 'bl' | 'br') => void
    autosize?: (height: number, width?: number) => void
    quickMark?: () => void
    instantMark?: () => Promise<{ ok: boolean; id?: string }>
    /** §8: turn HUD click-through ON from the action row (main owns the exits). */
    setPassThrough?: (on: boolean) => void
    mouseEnter?: () => void
    mouseLeave?: () => void
  }
  operators: {
    list: () => Promise<OperatorInfo[]>
    /** Returns { id, name, signerPubKey, tokenPath } — or { error, id } if the
     *  DB write failed. tokenPath points at the written ~/.redlog/tokens file;
     *  the raw token is never returned to the renderer (§10). */
    create: (name: string) => Promise<
      { id: string; name: string; signerPubKey: string | null; tokenPath: string }
      | { error: string; id: string }
      | null
    >
    /** Rotates the token, rewrites the token file; returns { id, tokenPath }. */
    rotateToken: (id: string) => Promise<{ id: string; tokenPath: string } | null>
    revoke: (id: string) => Promise<boolean>
    rename: (id: string, name: string) => Promise<boolean>
    pubKey: (id: string) => Promise<string | null>
  }
  hooks: {
    detect: () => Promise<HookInfo[]>
    install: (hookId: string) => Promise<{ success: boolean; error?: string; message?: string }>
    uninstall: (hookId: string) => Promise<{ success: boolean; error?: string; message?: string }>
  }
  plugins: {
    list: () => Promise<unknown[]>
    eventTypes: () => Promise<PluginEventType[]>
    reload: () => Promise<unknown>
    openFolder: () => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<unknown>
    grant: (id: string) => Promise<unknown>
    revoke: (id: string) => Promise<unknown>
  }
  pivots: {
    getActive: () => Promise<unknown[]>
    onChange: (cb: (pivots: Array<{ via: string; tool: string; route?: string; ts: number }>) => void) => () => void
  }
  clock: {
    status: () => Promise<{ offsetMs: number | null; lastQuery: unknown }>
  }
  capture: {
    health: () => Promise<CaptureHealthInfo | null>
  }
  wsl: {
    listDistros: () => Promise<WslDistro[]>
    getNetworkMode: () => Promise<'mirrored' | 'nat' | 'not-configured'>
    installHook: (distro: string, shell: string) => Promise<{ success: boolean; message: string }>
    uninstallHook: (distro: string, shell: string) => Promise<{ success: boolean; message: string }>
    runDiagnostics: (distro: string) => Promise<WslDiagnosticResult>
  }
}

interface CaptureSourceInfo {
  id: string
  installed?: boolean
  /** hook id for hooks.install/uninstall; absent = nothing to install */
  hookId?: string
  /** config switch state; undefined = always on, no switch */
  enabled?: boolean
  /** dotted config path the switch writes */
  configPath?: string
  lastEventAt: number | null
  state: 'active' | 'idle' | 'absent' | 'off'
  /** E3: a plugin-contributed capture producer (pcap, transparent-proxy, a c2
   *  tailer). Display only — it never drives the recording verdict and, being
   *  optional/manual, is never surfaced as a "problem" to fix. */
  informational?: boolean
  /** Human label for an informational source (the plugin's own name). */
  label?: string
}

interface CaptureHealthInfo {
  verdict: 'healthy' | 'partial' | 'dark'
  recording: boolean
  sources: CaptureSourceInfo[]
  lastEventAt: number | null
  checkedAt: number
  lastDbError?: { source: string; at: number; message: string }
  lastSampleBroken?: { at: number; eventId: string; reason: string; eventTimestamp?: number }
  lastSampleOkAt?: number | null
  proxyEnv?: { httpProxy?: string; httpsProxy?: string; noProxy?: string }
}

interface BrowserLaunchResult {
  ok: boolean
  pid?: number
  binary?: string
  args?: string[]
  profileDir?: string
  error?: string
}

interface OperatorInfo {
  id: string
  name: string
  isPrimary: boolean
  createdAt: number
  revokedAt: number | null
  /** ed25519 public key for §5c key display; null if this operator never signed. */
  signerPubKey?: string | null
}

interface CalendarReceiptInfo {
  calendar: string
  ok: boolean
  receiptB64?: string
  error?: string
  submittedAt: number
  upgraded?: boolean
  upgradedAt?: number | null
  upgradedBytes?: number
  /** Present once the calendar returns a browsable receipt. */
  url?: string
}

interface ChainAnchorInfo {
  id: string
  headEventId: string | null
  headHash: string
  eventCount: number
  calendarReceipts: CalendarReceiptInfo[]
  status: 'pending' | 'partial' | 'complete' | 'failed'
  createdAt: number
  completedAt: number | null
}

interface RedLogConfigPartial {
  engagement?: { id?: string; name?: string }
  operator?: { id?: string; name?: string }
  network?: { whitelist?: string[]; blacklist?: string[]; checkInterval?: number; ipMode?: 'dns' | 'http' | 'auto' }
  scope?: { warnOnViolation?: boolean; targets?: string[]; excludeTargets?: string[]; scopeFile?: string | null; personalDomains?: string[] }
  screenshot?: { quality?: number; intervalSec?: number }
  overlay?: {
    showMarkButton?: boolean
    showInDock?: boolean
    flashOnExposed?: boolean
    scale?: number
    emphasizeExternalIp?: boolean
    passThrough?: boolean
    passThroughOpacity?: number
  }
}

/** A plugin-registered event type, as `plugins:eventTypes` returns it. */
interface PluginEventType {
  agentType: string
  label?: string
  lane?: string
  pluginId?: string
}

// This file is a GLOBAL script (no top-level import/export), so the Window
// augmentation belongs at the top level. Wrapped in `declare global` it is
// silently inert here — which is why 252 call sites typecheck as
// "Property 'redlog' does not exist on type 'Window'".
interface Window {
  redlog: RedLogAPI
}
