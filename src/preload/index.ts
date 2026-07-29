import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('redlog', {
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name: string, initialConfig?: unknown) => ipcRenderer.invoke('project:create', name, initialConfig),
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
    save: (config: unknown) => ipcRenderer.invoke('config:save', config),
    exportProfile: () => ipcRenderer.invoke('config:exportProfile'),
    importProfile: () => ipcRenderer.invoke('config:importProfile')
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
    length: () => ipcRenderer.invoke('chain:length'),
    anchors: () => ipcRenderer.invoke('chain:anchors'),
    anchorNow: () => ipcRenderer.invoke('chain:anchorNow'),
    verify: (opts?: { full?: boolean }) => ipcRenderer.invoke('chain:verify', opts),
    upgrade: (id?: string) => ipcRenderer.invoke('chain:upgrade', id)
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
  browser: {
    detect: () => ipcRenderer.invoke('browser:detect'),
    status: () => ipcRenderer.invoke('browser:status'),
    launch: () => ipcRenderer.invoke('browser:launch'),
    stop: () => ipcRenderer.invoke('browser:stop')
  },
  data: {
    exportJson: () => ipcRenderer.invoke('data:exportJson'),
    exportScopeFiltered: () => ipcRenderer.invoke('data:exportScopeFiltered')
  },
  hooks: {
    detect: () => ipcRenderer.invoke('hooks:detect'),
    install: (hookId: string) => ipcRenderer.invoke('hooks:install', hookId),
    uninstall: (hookId: string) => ipcRenderer.invoke('hooks:uninstall', hookId)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    eventTypes: () => ipcRenderer.invoke('plugins:eventTypes'),
    reload: () => ipcRenderer.invoke('plugins:reload'),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
    grant: (id: string) => ipcRenderer.invoke('plugins:grant', id),
    revoke: (id: string) => ipcRenderer.invoke('plugins:revoke', id)
  },
  capture: {
    health: () => ipcRenderer.invoke('capture:health')
  },
  operators: {
    list: () => ipcRenderer.invoke('operators:list'),
    create: (name: string) => ipcRenderer.invoke('operators:create', name),
    rotate: (id: string) => ipcRenderer.invoke('operators:rotate', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('operators:rename', id, name),
    revoke: (id: string) => ipcRenderer.invoke('operators:revoke', id),
    delete: (id: string) => ipcRenderer.invoke('operators:delete', id)
  },
  deconfliction: {
    get: () => ipcRenderer.invoke('deconfliction:get'),
    test: (cfg: unknown) => ipcRenderer.invoke('deconfliction:test', cfg)
  },
  mcp: {
    info: () => ipcRenderer.invoke('mcp:info'),
    setupToken: () => ipcRenderer.invoke('mcp:setupToken')
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
  pivots: {
    getActive: (): Promise<Array<{ via: string; tool: string; route?: string; ts: number }>> =>
      ipcRenderer.invoke('pivots:getActive'),
    onChange: (cb: (pivots: Array<{ via: string; tool: string; route?: string; ts: number }>) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, p: Array<{ via: string; tool: string; route?: string; ts: number }>) => cb(p)
      ipcRenderer.on('pivots:changed', handler)
      return () => ipcRenderer.removeListener('pivots:changed', handler)
    }
  },
  terminal: {
    spawn: (id: string, cols: number, rows: number) => ipcRenderer.invoke('terminal:spawn', id, cols, rows),
    write: (id: string, data: string) => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('terminal:kill', id),
    list: () => ipcRenderer.invoke('terminal:list'),
    onData: (id: string, cb: (data: string) => void) => {
      const channel = `terminal:data:${id}`
      const handler = (_e: Electron.IpcRendererEvent, data: string) => cb(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onExit: (id: string, cb: (exitCode: number) => void) => {
      const channel = `terminal:exit:${id}`
      const handler = (_e: Electron.IpcRendererEvent, code: number) => cb(code)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  overlay: {
    toggle: () => ipcRenderer.send('overlay:toggle'),
    hide: () => ipcRenderer.send('overlay:hide'),
    show: () => ipcRenderer.send('overlay:show'),
    isVisible: () => ipcRenderer.invoke('overlay:isVisible'),
    onVisibilityChanged: (cb: (visible: boolean) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, visible: boolean): void => cb(visible)
      ipcRenderer.on('overlay:visibilityChanged', handler)
      return () => ipcRenderer.removeListener('overlay:visibilityChanged', handler)
    }
  }
})
