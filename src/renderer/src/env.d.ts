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
