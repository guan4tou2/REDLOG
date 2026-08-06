import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('redlog', {
  platform: process.platform,
  app: {
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url)
  },
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name: string, initialConfig?: unknown) => ipcRenderer.invoke('project:create', name, initialConfig),
    open: (id: string) => ipcRenderer.invoke('project:open', id),
    delete: (id: string) => ipcRenderer.invoke('project:delete', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('project:rename', id, name),
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
  hookConfig: {
    get: () => ipcRenderer.invoke('hookConfig:get') as Promise<{ excludedPaths: string[]; watchPaths?: string[] }>,
    save: (cfg: { excludedPaths?: string[]; watchPaths?: string[] }) => ipcRenderer.invoke('hookConfig:save', cfg) as Promise<boolean>,
    pickPath: () => ipcRenderer.invoke('hookConfig:pickPath') as Promise<string | null>
  },
  events: {
    query: (opts: Record<string, unknown>) => ipcRenderer.invoke('events:query', opts),
    getCount: () => ipcRenderer.invoke('events:getCount'),
    search: (query: string, limit?: number) => ipcRenderer.invoke('events:search', query, limit),
    onNew: (cb: (event: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: unknown) => cb(event)
      ipcRenderer.on('events:new', handler)
      return () => ipcRenderer.removeListener('events:new', handler)
    },
    // Layer 3 (four-layer redaction): every time the reviewer reveals raw
    // bytes of a redacted span, we log a chained system.secret_revealed event
    // so the audit trail shows who saw what and when.
    logSecretRevealed: (sourceEventId: string, fields: string[]) =>
      ipcRenderer.invoke('events:logSecretRevealed', sourceEventId, fields)
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
    capture: (causeEventId?: string) => ipcRenderer.invoke('screenshot:capture', causeEventId),
    deleteFile: (eventId: string, filePath: string) => ipcRenderer.invoke('screenshot:deleteFile', eventId, filePath),
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
  views: {
    list: () => ipcRenderer.invoke('views:list'),
    save: (data: { name: string; state: Record<string, unknown> }) => ipcRenderer.invoke('views:save', data),
    delete: (id: string) => ipcRenderer.invoke('views:delete', id)
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
    exportBundle: () => ipcRenderer.invoke('data:exportBundle'),
    exportScopeFiltered: () => ipcRenderer.invoke('data:exportScopeFiltered'),
    exportMarks: () => ipcRenderer.invoke('data:exportMarks'),
    exportLoot: () => ipcRenderer.invoke('data:exportLoot'),
    exportViolations: () => ipcRenderer.invoke('data:exportViolations'),
    exportTimelineSlice: (from: number, to: number) => ipcRenderer.invoke('data:exportTimelineSlice', { from, to }),
    revealPath: (target: string) => ipcRenderer.invoke('data:revealPath', target)
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
    openFolder: () => ipcRenderer.invoke('plugins:openFolder'),
    setEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
    grant: (id: string) => ipcRenderer.invoke('plugins:grant', id),
    revoke: (id: string) => ipcRenderer.invoke('plugins:revoke', id)
  },
  cloudShare: {
    /** Cheap read — safe to call from every dialog open. */
    preview: () => ipcRenderer.invoke('cloudShare:preview'),
    /** Build the .zip + bundle.json. Fails if reviewedByOperator is false or
     *  the bundle exceeds the size cap. */
    prepare: (engagementId: string, reviewedByOperator: boolean) =>
      ipcRenderer.invoke('cloudShare:prepare', engagementId, reviewedByOperator),
    /** Ships the prepared bundle via the local stub uploader (writes to
     *  ~/.redlog/shares/). v1 has no real HTTPS backend wired to Settings. */
    uploadStub: (zipPath: string, manifestJson: string, expiresIn?: string) =>
      ipcRenderer.invoke('cloudShare:uploadStub', zipPath, manifestJson, expiresIn),
    /** Ships the prepared bundle to a user-deployed redlog-share-worker
     *  (spec §5 wire format). Endpoint + auth token are passed explicitly so
     *  the caller controls when they're in scope — avoids leaking the token
     *  to a stub-only flow. */
    upload: (zipPath: string, manifestJson: string, expiresIn: string | undefined, endpoint: string, authToken: string) =>
      ipcRenderer.invoke('cloudShare:upload', zipPath, manifestJson, expiresIn, endpoint, authToken)
  },
  marketplace: {
    // Fetch the registry index. Optional URL override so operators can point
    // at their own mirror / air-gapped registry via Settings.
    fetchIndex: (url?: string) => ipcRenderer.invoke('marketplace:fetchIndex', url),
    listPublishers: () => ipcRenderer.invoke('marketplace:listPublishers'),
    trustPublisher: (id: string, publicKey: string, homepage?: string, label?: string) =>
      ipcRenderer.invoke('marketplace:trustPublisher', id, publicKey, homepage, label),
    untrustPublisher: (id: string) => ipcRenderer.invoke('marketplace:untrustPublisher', id),
    install: (entryJson: string) => ipcRenderer.invoke('marketplace:install', entryJson),
    // Dev/E2E-only path — main gates this on REDLOG_E2E=1. Bytes are base64
    // so we can hop across the IPC boundary without a Buffer polyfill in the
    // renderer. Never called by production code paths.
    testInstall: (entryJson: string, tarballBytesB64: string) =>
      ipcRenderer.invoke('marketplace:testInstall', entryJson, tarballBytesB64),
    // Dev/E2E-only override for fetchIndex — gated on REDLOG_E2E=1 in main.
    // Pass a JSON-stringified RegistryIndex to install a mock; pass '' to clear.
    testSetIndex: (indexJson: string) =>
      ipcRenderer.invoke('marketplace:testSetIndex', indexJson),
    listVersions: (pluginId: string) => ipcRenderer.invoke('marketplace:listVersions', pluginId),
    rollback: (pluginId: string, versionKey: string) => ipcRenderer.invoke('marketplace:rollback', pluginId, versionKey),
    revocations: () => ipcRenderer.invoke('marketplace:revocations')
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
    setupToken: (opts?: { name?: string }) => ipcRenderer.invoke('mcp:setupToken', opts)
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
    },
    replay: (eventId: string) => ipcRenderer.invoke('terminal:replay', eventId),
    replaySession: (eventId: string) => ipcRenderer.invoke('terminal:replaySession', eventId)
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
    },
    moveToCorner: (corner: 'tl' | 'tr' | 'bl' | 'br') => ipcRenderer.send('overlay:moveToCorner', corner)
  }
})
