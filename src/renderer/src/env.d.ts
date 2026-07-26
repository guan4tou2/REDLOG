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
  vpnStatus: 'connected' | 'disconnected' | 'unknown'
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

interface RedLogAPI {
  project: {
    list: () => Promise<ProjectMeta[]>
    create: (name: string) => Promise<ProjectMeta>
    open: (id: string) => Promise<ProjectMeta | null>
    delete: (id: string) => Promise<boolean>
    active: () => Promise<{ id: string; name: string } | null>
    onOpened: (cb: (project: { id: string; name: string }) => void) => () => void
  }
  ip: {
    getStatus: () => Promise<IPStatus>
    onStatus: (cb: (status: IPStatus) => void) => () => void
  }
  config: {
    get: () => Promise<unknown>
    save: (config: unknown) => Promise<boolean>
  }
  terminal: {
    create: (cols: number, rows: number) => Promise<string>
    write: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    destroy: (id: string) => void
    onData: (cb: (id: string, data: string) => void) => () => void
    onExit: (cb: (id: string, code: number) => void) => () => void
  }
  events: {
    query: (opts: Record<string, unknown>) => Promise<RedLogEvent[]>
    getCount: () => Promise<number>
    search: (query: string, limit?: number) => Promise<RedLogEvent[]>
    onNew: (cb: (event: RedLogEvent) => void) => () => void
  }
  marker: {
    create: (data: Record<string, unknown>) => Promise<RedLogEvent>
  }
  screenshot: {
    capture: () => Promise<string | null>
    getPath: (filename: string) => Promise<string>
    read: (filePath: string) => Promise<string | null>
  }
  scope: {
    getViolations: () => Promise<Array<{ target: string; command: string; timestamp: number }>>
    getViolationCount: () => Promise<number>
    isConfigured: () => Promise<boolean>
    onCheck: (cb: (result: { target: string; command: string; inScope: boolean; violation: boolean }) => void) => () => void
  }
  chain: {
    length: () => Promise<number>
    verify: () => Promise<{ valid: boolean; totalEntries: number; breakAt: number | null; details: string }>
  }
  loot: {
    getCount: () => Promise<number>
    scan: (text: string) => Promise<Array<{ type: string; value: string; line: string; confidence: string }>>
  }
  session: {
    health: () => Promise<{ sessionMinutes: number; fatigueLevel: 'green' | 'yellow' | 'red'; lastBreakMinutesAgo: number; breaksDue: boolean }>
    recordBreak: () => Promise<boolean>
    onBreakReminder: (cb: (status: { sessionMinutes: number; breaksDue: boolean }) => void) => () => void
    onFatigue: (cb: (status: { sessionMinutes: number; fatigueLevel: string }) => void) => () => void
  }
  shipper: {
    queueSize: () => Promise<number>
  }
  report: {
    export: (format: 'html' | 'json') => Promise<string | null>
  }
  plugins: {
    list: () => Promise<Array<{ name: string; version: string; description: string; enabled: boolean }>>
    enabled: () => Promise<Array<{ name: string; version: string; description: string }>>
    toggle: (name: string, enabled: boolean) => Promise<boolean>
  }
  emergency: {
    onPause: (cb: () => void) => () => void
    onResume: (cb: () => void) => () => void
  }
  overlay?: {
    setExpanded: (expanded: boolean) => void
  }
}

declare global {
  interface Window {
    redlog: RedLogAPI
  }
}
