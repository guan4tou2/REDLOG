import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('redlog', {
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name: string) => ipcRenderer.invoke('project:create', name),
    open: (id: string) => ipcRenderer.invoke('project:open', id),
    delete: (id: string) => ipcRenderer.invoke('project:delete', id),
    active: () => ipcRenderer.invoke('project:active'),
    onOpened: (cb: (project: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, project: unknown) => cb(project)
      ipcRenderer.on('project:opened', handler)
      return () => ipcRenderer.removeListener('project:opened', handler)
    }
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
  terminal: {
    create: (cols: number, rows: number): Promise<string> =>
      ipcRenderer.invoke('terminal:create', cols, rows),
    write: (id: string, data: string) =>
      ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('terminal:resize', id, cols, rows),
    destroy: (id: string) =>
      ipcRenderer.send('terminal:destroy', id),
    onData: (cb: (id: string, data: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, id: string, data: string) => cb(id, data)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onExit: (cb: (id: string, code: number) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, id: string, code: number) => cb(id, code)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    }
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
    create: (data: Record<string, unknown>) => ipcRenderer.invoke('marker:create', data)
  },
  screenshot: {
    capture: () => ipcRenderer.invoke('screenshot:capture'),
    getPath: (filename: string): Promise<string> =>
      ipcRenderer.invoke('screenshot:getPath', filename),
    read: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke('screenshot:read', filePath)
  },
  scope: {
    getViolations: () => ipcRenderer.invoke('scope:getViolations'),
    getViolationCount: () => ipcRenderer.invoke('scope:getViolationCount'),
    isConfigured: () => ipcRenderer.invoke('scope:isConfigured'),
    onCheck: (cb: (result: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, result: unknown) => cb(result)
      ipcRenderer.on('scope:check', handler)
      return () => ipcRenderer.removeListener('scope:check', handler)
    }
  },
  chain: {
    length: () => ipcRenderer.invoke('chain:length'),
    verify: () => ipcRenderer.invoke('chain:verify')
  },
  loot: {
    getCount: () => ipcRenderer.invoke('loot:getCount'),
    scan: (text: string) => ipcRenderer.invoke('loot:scan', text)
  },
  session: {
    health: () => ipcRenderer.invoke('session:health'),
    recordBreak: () => ipcRenderer.invoke('session:recordBreak'),
    onBreakReminder: (cb: (status: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, s: unknown) => cb(s)
      ipcRenderer.on('session-health:break-reminder', handler)
      return () => ipcRenderer.removeListener('session-health:break-reminder', handler)
    },
    onFatigue: (cb: (status: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, s: unknown) => cb(s)
      ipcRenderer.on('session-health:fatigue', handler)
      return () => ipcRenderer.removeListener('session-health:fatigue', handler)
    }
  },
  shipper: {
    queueSize: () => ipcRenderer.invoke('shipper:queueSize')
  },
  report: {
    export: (format: 'html' | 'json') => ipcRenderer.invoke('report:export', format)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    enabled: () => ipcRenderer.invoke('plugins:enabled'),
    toggle: (name: string, enabled: boolean) => ipcRenderer.invoke('plugins:toggle', name, enabled)
  },
  emergency: {
    onPause: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('emergency:pause', handler)
      return () => ipcRenderer.removeListener('emergency:pause', handler)
    },
    onResume: (cb: () => void) => {
      const handler = () => cb()
      ipcRenderer.on('emergency:resume', handler)
      return () => ipcRenderer.removeListener('emergency:resume', handler)
    }
  }
})
