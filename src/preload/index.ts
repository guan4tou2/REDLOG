import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('redlog', {
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name: string) => ipcRenderer.invoke('project:create', name),
    open: (id: string) => ipcRenderer.invoke('project:open', id),
    delete: (id: string) => ipcRenderer.invoke('project:delete', id),
    active: () => ipcRenderer.invoke('project:active')
  },
  ip: {
    getStatus: () => ipcRenderer.invoke('ip:getStatus'),
    onStatus: (cb: (status: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, s: unknown) => cb(s)
      ipcRenderer.on('ip:status', handler)
      return () => ipcRenderer.removeListener('ip:status', handler)
    }
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config: unknown) => ipcRenderer.invoke('config:save', config)
  },
  events: {
    query: (opts: Record<string, unknown>) => ipcRenderer.invoke('events:query', opts),
    getCount: () => ipcRenderer.invoke('events:getCount'),
    search: (query: string, limit?: number) => ipcRenderer.invoke('events:search', query, limit),
    onNew: (cb: (event: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: unknown) => cb(event)
      ipcRenderer.on('events:new', handler)
      return () => ipcRenderer.removeListener('events:new', handler)
    }
  },
  marker: {
    create: (data: Record<string, unknown>) => ipcRenderer.invoke('marker:create', data),
    onShortcut: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('shortcut:marker', handler)
      return () => ipcRenderer.removeListener('shortcut:marker', handler)
    }
  },
  screenshot: {
    capture: () => ipcRenderer.invoke('screenshot:capture'),
    read: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke('screenshot:read', filePath)
  },
  scope: {
    getViolations: () => ipcRenderer.invoke('scope:getViolations'),
    getViolationCount: () => ipcRenderer.invoke('scope:getViolationCount'),
    isConfigured: () => ipcRenderer.invoke('scope:isConfigured')
  },
  chain: {
    length: () => ipcRenderer.invoke('chain:length')
  },
  loot: {
    getCount: () => ipcRenderer.invoke('loot:getCount')
  },
  quickmarks: {
    list: () => ipcRenderer.invoke('quickmarks:list'),
    get: (id: string) => ipcRenderer.invoke('quickmarks:get', id),
    create: (data: { title: string; url?: string; note?: string }) => ipcRenderer.invoke('quickmarks:create', data),
    update: (id: string, data: Record<string, unknown>) => ipcRenderer.invoke('quickmarks:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('quickmarks:delete', id)
  },
  cdp: {
    getTab: () => ipcRenderer.invoke('cdp:getTab'),
    setPort: (port: number) => ipcRenderer.invoke('cdp:setPort', port)
  },
  data: {
    exportJson: () => ipcRenderer.invoke('data:exportJson')
  },
  recording: {
    get: (): Promise<boolean> => ipcRenderer.invoke('recording:get'),
    toggle: (): Promise<boolean> => ipcRenderer.invoke('recording:toggle'),
    onChange: (cb: (recording: boolean) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, r: boolean) => cb(r)
      ipcRenderer.on('recording:changed', handler)
      return () => ipcRenderer.removeListener('recording:changed', handler)
    }
  },
  overlay: {
    toggle: () => ipcRenderer.send('overlay:toggle'),
    hide: () => ipcRenderer.send('overlay:hide'),
    show: () => ipcRenderer.send('overlay:show')
  }
})
