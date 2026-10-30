/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __APP_BUILD__: string

interface TerminalCastState {
  recording: boolean
  castTruncated: boolean
  paused: boolean
  recordingReason?: 'no-project' | 'recording-failed'
  recordingError?: string
}

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
type ExportSubset = import('../../core/export-plan').ExportSubset
type ExportRequest = import('../../core/export-plan').ExportRequest
type ExportAttachmentRow = import('../../core/export-attachments').ExportAttachment
/** One picked file's outcome from `artifacts:add` (core/artifacts.ts). */
type ArtifactAddOutcome =
  | { ok: true; stored: string; sha256: string; bytes: number; originalPath: string; mtime: number; duplicate: boolean; eventId: string | null; relatedCommands: number }
  | { ok: false; error: 'not-a-file' | 'unreadable' | 'too-large' | 'no-space' | 'copy-failed'; originalPath: string; bytes?: number; detail?: string }
interface ArtifactAddResponse { canceled: boolean; results: ArtifactAddOutcome[] }
interface ResolvedExportPlan {
  id: string
  fingerprint: string
  expiresAt: number
  snapshot: ExportSnapshot
  request: import('../../core/export-plan').NormalizedExportRequest
  /** The boundary this plan was resolved against, so the menu can name it
   *  rather than guess at it. */
  scopeSnapshot: { targets: string[]; excludeTargets: string[]; personalDomains: string[] }
  capabilities: {
    snapshot: boolean
    boundedSubset: boolean
    scopeMasking: boolean
    piiScrubbing: boolean
    attachments: boolean
  }
  counts: {
    exchanges?: number
    examined: number
    included: number
    excludedDoNotExport: number
    excludedPersonal: number
    outOfScopeHttpFlows?: number
    maskedOutOfScope: number
    sanitized: number
    attachmentsIncluded: number
    attachmentsMissing: number
    attachmentsUnattributed: number
    attachmentsExcludedByOperator: number
    unsupported: number
    truncatedOutputs?: number
    pauseWindows?: number
    partialHttpFlows?: number
  }
  attachments: ExportAttachmentRow[]
}
type ExportPlanResponse = { ok: true; plan: ResolvedExportPlan } | { ok: false; error: string }
type ExportPlanResult = { ok: true; planId: string; fingerprint: string; artifactPath: string; counts: ResolvedExportPlan['counts']; warnings: string[]; delivery: import('../../core/export-delivery').ExportDelivery } | { ok: false; error: string; planId?: string; fingerprint?: string }



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

type BookmarkContext = import('../../core/db/bookmarks').BookmarkContext

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
    updateStatus: () => Promise<import('../../main/services/update-status').UpdateStatus>
    cancelUpdate: () => Promise<boolean>
    installUpdate: () => Promise<void>
    setAutoUpdateCheck: (on: boolean) => Promise<import('../../main/services/update-status').UpdateStatus>
    takeUpdateOutcome: () => Promise<import('../../main/services/update-marker').UpdateOutcome | null>
    onUpdateOutcomeReady: (cb: () => void) => () => void
    onUpdateStatus: (cb: (status: import('../../main/services/update-status').UpdateStatus) => void) => () => void
    openExternal: (url: string) => Promise<void>
    setQuitText: (text: Record<string, string>) => void
    setTrayText: (text: Record<string, string>) => void
  }
  debug: {
    status: () => Promise<{ enabled: boolean; path: string }>
    set: (on: boolean) => Promise<{ enabled: boolean; path: string }>
    reveal: () => Promise<void>
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
    save: (config: unknown, opts?: { expectProjectId?: string }) => Promise<boolean>
    exportProfile: () => Promise<string | null>
    importProfile: () => Promise<import('../../core/profile-import').ProfileImportResult>
  }
  targetContext: {
    get: () => Promise<string | null>
    set: (target: string | null) => Promise<{ ok: boolean; target: string | null }>
    onChange: (cb: (target: string | null) => void) => () => void
  }
  /** #221: copy operator-picked local files into the project as evidence. */
  artifacts: {
    /** `title`: the picker's title, already translated */
    add: (title?: string) => Promise<ArtifactAddResponse | null>
    /** Files dropped on the window; the main process asks before adding. */
    addDropped: (files: File[], text: { title: string; message: string; confirm: string; cancel: string }) => Promise<ArtifactAddResponse | null>
    /** Show an evidence file in the file manager (never opens it). */
    reveal: (kind: 'artifact' | 'screenshot', file: string) => Promise<boolean>
  }
  agents: {
    sessions: () => Promise<Array<{ agentKind: string; sessionId: string; cwd?: string; recording: boolean }>>,
    /** The AI tools whose local session files RedLog can read, and whether each folder exists here. */
    sources: (roots?: Record<string, string>) => Promise<Array<{ id: string; label: string; root: string; detected: boolean }>>
  }
  hookConfig: {
    get: () => Promise<{ excludedPaths: string[] }>
    save: (cfg: { excludedPaths?: string[] }) => Promise<boolean>
    /** `title`: the picker's title, already translated */
    pickPath: (title?: string) => Promise<string | null>
  }
  content: {
    copySaved: (ref: import('../../core/content-contract').ContentRef) => Promise<import('../../core/content-contract').ContentResult<{bytes:number}>>
    save: (ref: import('../../core/content-contract').ContentRef) => Promise<import('../../core/content-contract').ContentResult<{path:string;bytes:number}|null>>
    anchor: (req: import('../../core/content-contract').ContentAnchorRequest) => Promise<import('../../core/content-contract').ContentResult<import('../../core/content-contract').ContentAnchor>>
    resolveAnchor: (req: import('../../core/content-contract').ContentAnchor) => Promise<import('../../core/content-contract').ContentResult<{ text: string; offset: number }>>

    list: (req: { projectId: string; eventId: string }) => Promise<import('../../core/content-contract').ContentResult<import('../../core/content-contract').ContentDescriptor[]>>
    read: (req: import('../../core/content-contract').ContentReadRequest) => Promise<import('../../core/content-contract').ContentResult<import('../../core/content-contract').ContentWindow>>
    find: (req: import('../../core/content-contract').ContentFindRequest) => Promise<import('../../core/content-contract').ContentResult<import('../../core/content-contract').ContentFindResult>>
  }
  events: {
    commandEvidence: () => Promise<{ builtin: boolean; external: boolean }>
    query: (opts: import('../../core/db/events').EventQueryOptions) => Promise<RedLogEvent[]>
    queryPage: (opts: import('../../core/db/events').EventFilter & { limit?: number; cursor?: string | null; excludeHousekeeping?: boolean }) => Promise<{
      items: RedLogEvent[]
      hasMore: boolean
      nextCursor: string | null
    }>
    queryHttpFlowPage: (opts: import('../../core/db/events').HttpFlowQueryOptions) => Promise<import('../../core/db/events').HttpFlowPage>
    /** v0.13.0: optional tier. Omitted (or 'chained') = the chained/audit
     *  count — every existing caller means this. 'logged' returns the
     *  supporting-evidence count. 'all' returns both summed. */
    getCount: (tier: import('../../core/db/events').EventTierFilter) => Promise<number>
    runQuery: (
      req: import('../../core/db/events').EventQueryRequest
    ) => Promise<import('../../core/db/events').EventQueryResult>
    sourceSessions: (req: import('../../core/source-sessions').SourceSessionRequest) => Promise<import('../../core/source-sessions').SourceSessionPage>
    activityPage: (req: import('../../core/activity-contract').ActivityRequest) => Promise<import('../../core/activity-contract').ActivityPage>
    activityMembers: (req: import('../../core/activity-contract').ActivityMembersRequest) => Promise<import('../../core/activity-contract').ActivityMembersPage>
    /** Spec 038: how many rows a page or a query walks past `cursor`. */
    count: (req: import('../../core/db/events').EventCountRequest) => Promise<number>
    /** Spec 038: which of up to 1000 held ids the filter (and query) admit. */
    matchIds: (req: import('../../core/db/events').EventMatchRequest) => Promise<string[]>
    toolCounterparts: (
      keys: import('../../core/db/events').ToolPairKey[]
    ) => Promise<RedLogEvent[]>
    distinctAgentTypes: () => Promise<string[]>
    /** §9/§14-4c: per-target counts + first/last-seen, aggregated in SQL over
     *  the whole timeline (both tiers) — replaces a capped client-side rollup. */
    aggregateTargets: () => Promise<import('../../core/db/events').TargetAggregate[]>
    queryScreenshotPage: (opts: { limit?: number; cursor?: string | null; trigger?: string | null }) => Promise<{
      items: RedLogEvent[]
      hasMore: boolean
      nextCursor: string | null
    }>
    /** §10: distinct hosts across the timeline for ⌘K host search. */
    distinctHosts: () => Promise<import('../../core/db/events').HostAggregate[]>
    /** Full-text search inside terminal recordings — see src/core/cast-index.ts. */
    searchCasts: (query: string, limit?: number) => Promise<Array<{
      castRel: string; tMs: number; off: number; len: number; snippet: string; version?:string
    }>>
    castIndexStatus: () => Promise<import('../../core/cast-index').BackfillStatus>
    readCastRange: (castRel: string, off: number, len: number, version?:string) => Promise<{
      text: string; bytes: number; truncated: boolean
    } | null>
    queryByFlowId: (flowId: string) => Promise<RedLogEvent[]>
    commandOutput: (commandId: string) => Promise<import('../../core/db/events').CommandOutputPage>
    commandEnds: (commandIds: string[]) => Promise<RedLogEvent[]>
    getById: (ids: string[]) => Promise<RedLogEvent[]>
    causalChain: (anchorId: string, opts?: { maxDepth?: number; eventLimit?: number }) => Promise<import('../../core/db/events').EventCausalChain>
    onNewBatch: (cb: (events: RedLogEvent[]) => void) => () => void
    toggleDoNotExport: (eventId: string) => Promise<boolean | null>
    setNote: (eventId: string, note: string) => Promise<EventNote | null>
    getNote: (eventId: string) => Promise<EventNote | null>
    annotatedIds: () => Promise<string[]>
    attributionStats: () => Promise<{ attempted: number; resolved: number }>
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
    /** `heldFrame`: a screen frame taken when the shortcut fired, before
     *  RedLog came forward; pass it to `screenshot.capture` to use it. */
    onShortcut: (cb: (info: { heldFrame?: string }) => void) => () => void
  }
  screenshot: {
    /** `hideOwnWindows` takes RedLog off screen for the grab; `heldFrame`
     *  claims the frame held by the marker shortcut. */
    capture: (causeEventId?: string, opts?: { heldFrame?: string; hideOwnWindows?: boolean }) => Promise<string | null>
    /** The global screenshot chord fired; whether a frame was stored. */
    onShortcutResult: (cb: (r: { ok: boolean }) => void) => () => void
    deleteFile: (eventId: string, filePath: string) => Promise<{ ok: boolean; error?: string }>
  }
  scope: {
    policy: () => Promise<{ targets: string[]; excludeTargets: string[] } | null>
    getViolations: () => Promise<{
      rows: Array<{
        id: string; target: string; command: string; timestamp: number
        sourceTs?: number; distance: string; judged: 'live' | 'retroactive'; cleared: boolean
      }>
      /** More violation records exist than the page read (Constitution IV). */
      truncated: boolean
    }>
    getViolationCount: () => Promise<number>
    isConfigured: () => Promise<boolean>
    /** Add one target to the scope of the project the caller meant. False: that
     *  project is no longer open, or the write failed. */
    addTarget: (target: string, opts?: { expectProjectId?: string }) => Promise<boolean>
    fileInForce: () => Promise<{ path: string } & ({ ok: true; entries: string[] } | { ok: false; reason: 'unreadable' | 'invalid' }) | null>
    /** The newest scope_recomputed summary, or null. The Scope banner is a
     *  projection of this row, which is why it needs no dismissal state. */
    getLastRecompute: () => Promise<Record<string, unknown> | null>
  }
  chain: {
    length: () => Promise<number>
    anchors: () => Promise<ChainAnchorInfo[]>
    anchorNow: () => Promise<ChainAnchorInfo | null>
    verify: () => Promise<{ ok: boolean; anchor: ChainAnchorInfo | null; currentHead: string | null; walked?: number; brokenAtEventId?: string | null; brokenReason?: string | null; clockAnomalies?: Array<{ eventId: string; reason: string }>; anchorMatchesWalkedHead?: boolean }>
    upgrade: (id?: string) => Promise<ChainAnchorInfo | { upgraded: number; scanned: number } | null>
  }
  loot: {
    getCount: () => Promise<number>
    /** Every loot rule, for the Settings switches (Spec 032). */
    rules: () => Promise<Array<{ id: string; type: string; confidence: 'high' | 'medium' | 'low'; pluginId: string | null; description?: string; stopped?: 'time_limit' }>>
  }
  bookmarks: {
    list: () => Promise<Bookmark[]>
    get: (id: string) => Promise<Bookmark | null>
    create: (data: { title: string; url?: string; note?: string }) => Promise<Bookmark>
    update: (id: string, data: Partial<Bookmark>) => Promise<Bookmark | null>
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
    onExited: (cb: () => void) => () => void
  }
  httpCapture: {
    status: () => Promise<ManagedProxyStatus>
    start: () => Promise<ManagedProxyStatus>
    /** `staleTerminals`: open built-in panes whose environment still names the proxy that just stopped. */
    stop: () => Promise<ManagedProxyStatus & { staleTerminals: number }>
    /** Load the #220 verification page for `nonce` in the capture browser. */
    verifyInBrowser: (nonce: string) => Promise<{ ok: boolean; error?: string }>
    /** Capture checks reported by the mitmproxy addon. */
    onVerify: (cb: (report: import('../../core/http-verify').HttpVerifyReport) => void) => () => void
  }
  data: {
    resolveExportPlan: (request: ExportRequest) => Promise<ExportPlanResponse>
    /** `destDir`: a folder returned by `pickExportDir`; omitted means the project's exports folder. */
    executeExportPlan: (input: { planId: string; destDir?: string }) => Promise<ExportPlanResult>
    /** The project's default exports folder, or null with no project open. */
    recentExport: () => Promise<{ ok: true; delivery: import('../../core/export-delivery').ExportDelivery | null } | { ok: false; error: string }>
    exportDestination: () => Promise<string | null>
    /** System folder picker. Only a folder chosen here is accepted as a destination. */
    pickExportDir: () => Promise<string | null>
    /** Show a finished export in the file manager (inside the project, or a folder picked above). */
    revealExport: (target: string) => Promise<boolean>
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
      scopeViolationSeen: boolean
    } | null>
  }
  recording: {
    get: () => Promise<boolean>
    toggle: () => Promise<boolean>
    onChange: (cb: (recording: boolean) => void) => () => void
  }
  terminal: {
    spawn: (id: string, cols: number, rows: number, shellId?: string) =>
      Promise<{ pid: number; shell: string; shellLabel: string; hookSourced: boolean } & TerminalCastState>
    shells: () => Promise<Array<{ id: string; label: string; flavour: 'powershell' | 'posix' | 'none' }>>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    list: () => Promise<Array<{
      id: string; pid: number; lastActivity: number
      /** 2b per-pane chip: open cast stream; capacity continues in the next part. */
      recording: boolean; castBytes: number; castTruncated: boolean; paused: boolean; castStartedAt: number | null
      recordingReason?: 'no-project' | 'recording-failed'; recordingError?: string
    }>>
    onData: (id: string, cb: (data: string) => void) => () => void
    onExit: (id: string, cb: (exitCode: number) => void) => () => void
    onCastState: (id: string, cb: (state: TerminalCastState) => void) => () => void
    replay: (eventId: string) => Promise<{ ok: boolean; command?: string; exitCode?: number; durationSec?: number; text?: string; bytes?: number; truncated?: boolean; error?: string }>
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
    isVisible: () => Promise<boolean>
    onVisibilityChanged: (cb: (visible: boolean) => void) => () => void
    moveToCorner: (corner: 'tl' | 'tr' | 'bl' | 'br') => void
    setPassThrough: (on: boolean) => void
    onPassThroughChanged: (cb: (on: boolean) => void) => () => void
    autosize?: (height: number, width?: number) => void
    quickMark?: () => void
    /** The project a marker draft belongs to; hand it back as `bind` on save. */
    beginMarker?: () => Promise<string | null>
    addMarker?: (input: { title?: string; notes?: string; at?: number; bind?: string }) => Promise<{ ok: boolean; id?: string; reason?: 'project-changed' }>
    releaseFocus?: () => void
    /** §8: turn HUD click-through ON from the action row (main owns the exits). */
    setPassThrough?: (on: boolean) => void
    mouseEnter?: () => void
    mouseLeave?: () => void
  }
  operators: {
    list: () => Promise<OperatorInfo[]>
  }
  hooks: {
    detect: () => Promise<HookInfo[]>
    install: (hookId: string) => Promise<{ success: boolean; error?: string; message?: string }>
    uninstall: (hookId: string) => Promise<{ success: boolean; error?: string; message?: string }>
    /** Spec 052: what the SHELL will do — the machine's mode and the effective
     *  class lists, defaults with the operator's `redlog class` edits on top. */
    terminalPolicy: () => Promise<{ mode: 'auto' | 'manual'; native: string[]; pty: string[]; app: string }>
    setTerminalApp: (value: string) => Promise<string>
    /** Spec 036: back up the profile, drop the retired source line(s), install the current adapter. */
  }
  runtime: {
    /** Spec 036: runtime dependencies + legacy hook references, answered without spawning processes. */
    preflight: () => Promise<RuntimePreflight>
    /** Run the install a preflight remediation describes (e.g. mitmproxy via uv).
     *  `needsPrereq` is set when the installer itself (uv/brew) is missing. */
    install: (id: RuntimePreflight['checks'][number]['id']) => Promise<{
      success: boolean
      message: string
      needsPrereq?: { command: string; url: string }
      cancelled?: boolean
    }>
    cancelInstall: (id: RuntimePreflight['checks'][number]['id']) => Promise<boolean>
  }
  plugins: {
    /** Catalog only: installing an integration does not enable AI capture. */
    officialAgents: () => Promise<import('../../core/plugins/official-agents').OfficialAgentPlugin[]>
    installOfficialAgent: (agentKind: string) => Promise<import('../../core/plugins/official-agents').OfficialAgentMutation>
    uninstallOfficialAgent: (agentKind: string) => Promise<import('../../core/plugins/official-agents').OfficialAgentMutation>
    list: () => Promise<unknown[]>
    eventTypes: () => Promise<PluginEventType[]>
    reload: () => Promise<unknown>
    testSample: (text: string) => Promise<{
      masked: string; maskedSpans: number; truncated: boolean
      overran: string[]
      loot: Array<{ type: string; confidence: 'high' | 'medium' | 'low'; reported: boolean; pluginId?: string; patternName?: string }>
      target: { host: string | null; pluginId?: string; extractorName?: string }
      tags: Record<string, string>
    }>
    openFolder: () => Promise<void>
    setEnabled: (id: string, enabled: boolean) => Promise<unknown>
    grant: (id: string) => Promise<unknown>
    revoke: (id: string) => Promise<unknown>
  }
  pivots: {
    getActive: () => Promise<unknown[]>
    onChange: (cb: (pivots: Array<{ via: string; tool: string; route?: string; ts: number }>) => void) => () => void
  }
  capture: {
    health: () => Promise<CaptureHealthInfo | null>
    /** Delete the commands set aside with no project (#255) — only those
     *  written no later than `upTo`, the newest the card was showing. */
    clearUnattributedSpool: (upTo: number) => Promise<{ removed: number; failed: number }>
  }
  wsl: {
    listDistros: () => Promise<WslDistro[]>
    getNetworkMode: () => Promise<'mirrored' | 'nat' | 'not-configured'>
    installHook: (distro: string, shell: string) => Promise<{ success: boolean; message: string }>
    uninstallHook: (distro: string, shell: string) => Promise<{ success: boolean; message: string }>
    runDiagnostics: (distro: string) => Promise<WslDiagnosticResult>
  }
}

interface RuntimePreflight {
  platform: string
  shell: { name: string; hookId: string } | null
  checks: Array<{
    id: 'python3' | 'curl' | 'mitmdump' | 'zsh' | 'bash' | 'pwsh' | 'powershell'
    found: boolean
    neededFor: string[]
    /** copyable install command, present when missing */
    remediation?: string
    remediationRequires?: { command: string; url: string }
  }>
  /** Windows only, and null when it could not be measured — never "fine".
   *  A Restricted policy stops `$PROFILE` loading, which is the one Windows
   *  failure that leaves the hook installed and the terminal silent. */
  powershell?: { shell: string; policy: string; blocksProfile: boolean } | null
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
  /** for a pack member: its pack's path, which turning the member ON must set
   *  too or the switch reports the opposite of what it did */
  packPath?: string
  lastEventAt: number | null
  /** Can this source record right now. `error` = wired up and its own capture
   *  failed, distinct from `unset` (nothing installed/turned on) and from a DB
   *  write failure. There is no `idle`: how long ago it last recorded is
   *  `lastEventAt`, which is data, not a verdict. */
  state: 'ready' | 'unset' | 'off' | 'error'
  /** Why the capture failed, while the failure is still live. */
  lastError?: { at: number; message: string }
  /** `terminal` only (spec 052): terminals that have enrolled and how many of
   *  them are recording. Absent when none have. */
  enrolled?: { total: number; recording: number }
  /** `terminal` only (spec 052, FR-015): when a command last arrived from a
   *  terminal that is not one of RedLog's own panes, or null if one never
   *  has. An install is finished when this is set, not when a file was
   *  copied. */
  ownShellLastEventAt?: number | null
  /** `terminal` only: when one of them last arrived with its output captured. */
  ownShellOutputAt?: number | null
  /** `terminal` only: the shell that sent that last command. */
  ownShellName?: string | null
  /** E3: a plugin-contributed capture producer (pcap, transparent-proxy, a c2
   *  tailer). Display only — it never drives the recording verdict and, being
   *  optional/manual, is never surfaced as a "problem" to fix. */
  informational?: boolean
  /** Human label for an informational source (the plugin's own name). */
  label?: string
  /** Switched off and listed anyway. Together with a live producer it is the
   *  one combination that means the record is taking data nobody authorised. */
  disabled?: boolean
  /** E3: this plugin producer is heartbeating — the operator has it running. */
  running?: boolean
}

interface EventNote {
  note: string
  createdAt: number
  updatedAt: number
}

interface CaptureHealthInfo {
  verdict: 'healthy' | 'partial' | 'dark'
  /** at least one source has ever produced a real event. NOT the REC switch —
   *  that is `window.redlog.recording`, which decides whether RedLog writes
   *  down what the sources produce. */
  hasRecorded: boolean
  sources: CaptureSourceInfo[]
  lastEventAt: number | null
  checkedAt: number
  lastDbError?: { source: string; at: number; message: string }
  /** write failures in this session, cumulative. `lastDbError` expires so the
   *  verdict can recover; this does not, because the gap in the record does
   *  not either. */
  dbErrorTotal: number
  dbErrorFirstAt: number | null
  /** commands typed while no project was open, set aside because no project
   *  could claim them (#255); null when there are none */
  unattributedSpool: { count: number; oldestAt: number; newestAt: number } | null
  lastSampleBroken?: { at: number; eventId: string; reason: string; eventTimestamp?: number }
  managedHttpProxy?: ManagedProxyStatus
}

interface BrowserLaunchResult {
  ok: boolean
  pid?: number
  binary?: string
  args?: string[]
  profileDir?: string
  error?: string
}

interface ManagedProxyStatus {
  state: 'stopped' | 'starting' | 'running' | 'unavailable' | 'failed'
  url: string | null
  pid?: number
  error?: string
  caPath?: string
  /** The CA file exists. Not a claim that anything trusts it. */
  certReady?: boolean
  caFingerprint?: { sha1: string; sha256: string }
  sourceInstance?: string
  verificationEvidence?: import('../../core/http-verification-evidence').HttpVerificationEvidence | null
  verificationState?: import('../../core/http-verification-evidence').HttpVerificationState
  httpsVerification?: import('../../core/http-verify').HttpVerifyReport
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
  engagement?: { id?: string }
  operator?: { id?: string; name?: string }
  network?: { whitelist?: string[]; blacklist?: string[]; checkInterval?: number; ipMode?: 'dns' | 'http' | 'auto' }
  scope?: { warnOnViolation?: boolean; targets?: string[]; excludeTargets?: string[]; scopeFile?: string | null; personalDomains?: string[] }
  screenshot?: { quality?: number; intervalSec?: number }
  overlay?: {
    autoShow?: boolean
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
