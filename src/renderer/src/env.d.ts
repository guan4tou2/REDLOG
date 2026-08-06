/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ProjectMeta {
  id: string
  name: string
  createdAt: number
  lastOpened: number
  path: string
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
}

interface QuickMarkContext {
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

interface QuickMark {
  id: string
  title: string
  url: string | null
  note: string
  context: QuickMarkContext
  createdAt: number
}

interface BrowserTabInfo {
  url: string | null
  title: string | null
  connected: boolean
}

interface RedLogAPI {
  platform: string
  app: {
    checkForUpdates: () => Promise<void>
  }
  project: {
    list: () => Promise<ProjectMeta[]>
    create: (name: string, initialConfig?: Partial<RedLogConfigPartial>) => Promise<ProjectMeta>
    open: (id: string) => Promise<ProjectMeta | null>
    delete: (id: string) => Promise<boolean>
    active: () => Promise<{ id: string; name: string; createdAt: number } | null>
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
  hookConfig: {
    get: () => Promise<{ excludedPaths: string[]; watchPaths?: string[] }>
    save: (cfg: { excludedPaths?: string[]; watchPaths?: string[] }) => Promise<boolean>
    pickPath: () => Promise<string | null>
  }
  events: {
    query: (opts: Record<string, unknown>) => Promise<RedLogEvent[]>
    getCount: () => Promise<number>
    search: (query: string, limit?: number) => Promise<RedLogEvent[]>
    onNew: (cb: (event: RedLogEvent) => void) => () => void
    onNewBatch: (cb: (events: RedLogEvent[]) => void) => () => void
  }
  marker: {
    create: (data: Record<string, unknown>) => Promise<RedLogEvent>
    onShortcut: (cb: () => void) => () => void
  }
  screenshot: {
    capture: (causeEventId?: string) => Promise<string | null>
    read: (filePath: string) => Promise<string | null>
  }
  scope: {
    getViolations: () => Promise<Array<{ target: string; command: string; timestamp: number }>>
    getViolationCount: () => Promise<number>
    isConfigured: () => Promise<boolean>
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
  quickmarks: {
    list: () => Promise<QuickMark[]>
    get: (id: string) => Promise<QuickMark | null>
    create: (data: { title: string; url?: string; note?: string }) => Promise<QuickMark>
    update: (id: string, data: Partial<QuickMark>) => Promise<QuickMark | null>
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
    exportJson: () => Promise<string | null>
    exportBundle?: () => Promise<{ outDir: string; manifest: unknown } | null>
    exportScopeFiltered?: () => Promise<string | null>
    exportMarks?: () => Promise<string | null>
    exportLoot?: () => Promise<string | null>
    exportViolations?: () => Promise<string | null>
    exportTimelineSlice?: (from: number, to: number) => Promise<string | null>
    revealPath?: (target: string) => Promise<boolean>
  }
  recording: {
    get: () => Promise<boolean>
    toggle: () => Promise<boolean>
    onChange: (cb: (recording: boolean) => void) => () => void
  }
  terminal: {
    spawn: (id: string, cols: number, rows: number) => Promise<{ pid: number }>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    list: () => Promise<Array<{ id: string; pid: number; lastActivity: number }>>
    onData: (id: string, cb: (data: string) => void) => () => void
    onExit: (id: string, cb: (exitCode: number) => void) => () => void
    replay?: (eventId: string) => Promise<{ ok: boolean; command?: string; exitCode?: number; durationSec?: number; text?: string; bytes?: number; error?: string }>
    replaySession?: (eventId: string) => Promise<{ ok: boolean; text?: string; bytes?: number; truncated?: boolean; castPath?: string; events?: Array<[number, 'o', string]>; error?: string }>
  }
  overlay: {
    toggle: () => void
    hide: () => void
    show: () => void
    isVisible: () => Promise<boolean>
    onVisibilityChanged: (cb: (visible: boolean) => void) => () => void
    setExpanded?: (expanded: boolean) => void
    moveToCorner?: (corner: 'tl' | 'tr' | 'bl' | 'br') => void
  }
  operators: {
    list: () => Promise<OperatorInfo[]>
    create: (name: string) => Promise<{ operator: OperatorInfo; token: string } | null>
    rotate: (id: string) => Promise<{ token: string } | null>
    rename: (id: string, name: string) => Promise<boolean>
    revoke: (id: string) => Promise<boolean>
    delete: (id: string) => Promise<boolean>
  }
  deconfliction: {
    get: () => Promise<DeconflictionConfigInfo>
    test: (cfg: DeconflictionConfigInfo) => Promise<{ ok: boolean; status: number; error?: string }>
  }
  mcp: {
    info: () => Promise<McpInfo | null>
    setupToken: (opts?: { name?: string }) => Promise<{ token: string; port: number; endpoint: string; operatorId: string; name: string } | null>
  }
  capture: {
    health: () => Promise<CaptureHealthInfo | null>
  }
}

interface CaptureSourceInfo {
  id: string
  installed?: boolean
  lastEventAt: number | null
  state: 'active' | 'idle' | 'absent'
}

interface CaptureHealthInfo {
  verdict: 'healthy' | 'partial' | 'dark'
  recording: boolean
  sources: CaptureSourceInfo[]
  lastEventAt: number | null
  checkedAt: number
  lastDbError?: { source: string; at: number; message: string }
  lastSampleBroken?: { at: number; eventId: string; reason: string }
  lastSampleOkAt?: number | null
}

interface McpInfo {
  port: number
  endpoint: string
  stdioPath: string
  hasToken: boolean
  operators?: Array<{ id: string; name: string }>
}

interface BrowserLaunchResult {
  ok: boolean
  pid?: number
  binary?: string
  args?: string[]
  profileDir?: string
  error?: string
}

interface DeconflictionConfigInfo {
  enabled: boolean
  url: string
  secret: string
  events: string[]
  subtypes: string[]
  includeData: boolean
}

interface OperatorInfo {
  id: string
  name: string
  isPrimary: boolean
  createdAt: number
  revokedAt: number | null
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
  network?: { whitelist?: string[]; blacklist?: string[]; safeIPs?: string[]; exposedIPs?: string[]; checkInterval?: number; ipMode?: 'dns' | 'http' | 'auto' }
  scope?: { warnOnViolation?: boolean; targets?: string[]; excludeTargets?: string[]; scopeFile?: string | null }
  screenshot?: { quality?: number }
}

declare global {
  interface Window {
    redlog: RedLogAPI
  }
}
