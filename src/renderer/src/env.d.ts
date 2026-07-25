/// <reference types="vite/client" />

interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  isAllowed: boolean
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
  ip: {
    getStatus: () => Promise<IPStatus>
    onStatus: (cb: (status: IPStatus) => void) => () => void
  }
  config: { get: () => Promise<unknown> }
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
    onNew: (cb: (event: RedLogEvent) => void) => () => void
  }
  marker: {
    create: (data: Record<string, unknown>) => Promise<RedLogEvent>
  }
  screenshot: {
    capture: () => Promise<string | null>
    getPath: (filename: string) => Promise<string>
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
