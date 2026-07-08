/// <reference types="vite/client" />

interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  isAllowed: boolean
  lastCheck: number
  error: string | null
}

interface RedLogAPI {
  ip: {
    getStatus: () => Promise<IPStatus>
    onStatus: (callback: (status: IPStatus) => void) => () => void
  }
  config: {
    get: () => Promise<unknown>
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
