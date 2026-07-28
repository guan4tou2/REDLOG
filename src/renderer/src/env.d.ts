/// <reference types="vite/client" />

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
}

interface QuickMarkContext {
  browserUrl?: string
  browserTitle?: string
  externalIP?: string
  lastCommand?: string
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
  project: {
    list: () => Promise<ProjectMeta[]>
    create: (name: string, initialConfig?: Partial<RedLogConfigPartial>) => Promise<ProjectMeta>
    open: (id: string) => Promise<ProjectMeta | null>
    delete: (id: string) => Promise<boolean>
    active: () => Promise<{ id: string; name: string } | null>
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
  events: {
    query: (opts: Record<string, unknown>) => Promise<RedLogEvent[]>
    getCount: () => Promise<number>
    search: (query: string, limit?: number) => Promise<RedLogEvent[]>
    onNew: (cb: (event: RedLogEvent) => void) => () => void
  }
  marker: {
    create: (data: Record<string, unknown>) => Promise<RedLogEvent>
    onShortcut: (cb: () => void) => () => void
  }
  screenshot: {
    capture: () => Promise<string | null>
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
    verify: (opts?: { full?: boolean }) => Promise<{ ok: boolean; anchor: ChainAnchorInfo | null; currentHead: string | null }>
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
  cdp: {
    getTab: () => Promise<BrowserTabInfo>
    setPort: (port: number) => Promise<boolean>
  }
  data: {
    exportJson: () => Promise<string | null>
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
  }
  overlay: {
    toggle: () => void
    hide: () => void
    show: () => void
    isVisible: () => Promise<boolean>
    onVisibilityChanged: (cb: (visible: boolean) => void) => () => void
    setExpanded?: (expanded: boolean) => void
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
  network?: { safeIPs?: string[]; exposedIPs?: string[]; checkInterval?: number }
  scope?: { enforcement?: string; targets?: string[]; excludeTargets?: string[]; scopeFile?: string | null }
  screenshot?: { quality?: number }
}

declare global {
  interface Window {
    redlog: RedLogAPI
  }
}
