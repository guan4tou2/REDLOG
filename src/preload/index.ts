import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('redlog', {
  platform: process.platform,
  app: {
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url)
  },
  ui: {
    // Pops a native menu at the cursor and resolves with the clicked item's id
    // (null if dismissed). Only the renderer knows what a right-click means
    // inside xterm, so it names the entries; the main process owns the actual
    // menu and validates the payload.
    contextMenu: (items: Array<{ id?: string; label?: string; enabled?: boolean; type?: 'separator' }>) =>
      ipcRenderer.invoke('ui:contextMenu', items) as Promise<string | null>
  },
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name: string, initialConfig?: unknown) => ipcRenderer.invoke('project:create', name, initialConfig),
    open: (id: string) => ipcRenderer.invoke('project:open', id),
    delete: (id: string) => ipcRenderer.invoke('project:delete', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('project:rename', id, name),
    active: () => ipcRenderer.invoke('project:active'),
    close: () => ipcRenderer.invoke('project:close')
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
    // v0.13.0: optional tier arg — StatusBar's chained·logged split reads
    // both to show the two-tier row count. Undefined = 'chained' (audit
    // count) preserved for legacy callers.
    getCount: (tier?: import('../core/db/events').EventTierFilter) => ipcRenderer.invoke('events:getCount', tier),
    getLatestLoggedTs: () => ipcRenderer.invoke('events:getLatestLoggedTs') as Promise<number | null>,
    search: (query: string, limit?: number) => ipcRenderer.invoke('events:search', query, limit),
    // Recordings are searched separately from events — see casts:search in
    // main. `status` is not optional decoration: a project whose recordings
    // are still being indexed returns fewer hits than it will in a minute,
    // and this product cannot let that read as "nothing there".
    searchCasts: (query: string, limit?: number) => ipcRenderer.invoke('casts:search', query, limit),
    castIndexStatus: () => ipcRenderer.invoke('casts:status'),
    readCastRange: (castRel: string, off: number, len: number) =>
      ipcRenderer.invoke('casts:readRange', castRel, off, len),
    queryByFlowId: (flowId: string) => ipcRenderer.invoke('events:queryByFlowId', flowId) as Promise<RedLogEvent[]>,
    onNew: (cb: (event: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, event: unknown) => cb(event)
      ipcRenderer.on('events:new', handler)
      return () => ipcRenderer.removeListener('events:new', handler)
    },
    // v0.6.95 P0-4c: batch listener for coalesced deliveries. The main-side
    // event bus buffers incoming events and flushes an Array<RedLogEvent> via
    // this channel each frame (~16 ms), collapsing burst traffic (mitmproxy
    // scans, cast replay) from N IPC hops to one. `events:new` still fires
    // per-event for backward compat with subscribers that don't care to batch.
    onNewBatch: (cb: (events: unknown[]) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, events: unknown[]) => cb(events)
      ipcRenderer.on('events:new-batch', handler)
      return () => ipcRenderer.removeListener('events:new-batch', handler)
    },
    // Layer 3 (four-layer redaction): every time the reviewer reveals raw
    // bytes of a redacted span, we log a chained system.secret_revealed event
    // so the audit trail shows who saw what and when.
    logSecretRevealed: (sourceEventId: string, fields: string[]) =>
      ipcRenderer.invoke('events:logSecretRevealed', sourceEventId, fields)
  },
  httpBody: {
    read: (ref: { sha256: string; size: number; file: string; encoding: 'text' | 'base64' }) =>
      ipcRenderer.invoke('httpBody:read', ref) as Promise<string | null>
  },
  har: {
    export: (opts?: { since?: number; before?: number; targetId?: string; limit?: number }) =>
      ipcRenderer.invoke('har:export', opts) as Promise<string | null>
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
    deleteFile: (eventId: string, filePath: string) => ipcRenderer.invoke('screenshot:deleteFile', eventId, filePath)
    // v0.6.98 B: `read` IPC dropped. v0.6.97 B moved every renderer call site
    // onto the `redlog-screenshot://` custom protocol (streamed direct from
    // disk, no base64 round-trip). Nothing in-tree references screenshot.read
    // any more, and keeping the IPC alive means any future path-traversal
    // regression in the handler is still exploitable via a compromised
    // renderer. The main-process handler is dropped in the same commit.
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
  capture: {
    health: () => ipcRenderer.invoke('capture:health')
  },
  operators: {
    list: () => ipcRenderer.invoke('operators:list'),
    create: (name: string) => ipcRenderer.invoke('operators:create', name),
    rotate: (id: string) => ipcRenderer.invoke('operators:rotate', id),
    rename: (id: string, name: string) => ipcRenderer.invoke('operators:rename', id, name),
    revoke: (id: string) => ipcRenderer.invoke('operators:revoke', id),
    delete: (id: string) => ipcRenderer.invoke('operators:delete', id),
    writeToken: (id: string, token: string) => ipcRenderer.invoke('operators:writeToken', id, token) as Promise<string | null>
  },
  clock: {
    status: () => ipcRenderer.invoke('clock:status')
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
  wsl: {
    listDistros: () => ipcRenderer.invoke('wsl:listDistros'),
    getNetworkMode: () => ipcRenderer.invoke('wsl:getNetworkMode'),
    installHook: (distro: string, shell: string) => ipcRenderer.invoke('wsl:installHook', distro, shell),
    uninstallHook: (distro: string, shell: string) => ipcRenderer.invoke('wsl:uninstallHook', distro, shell),
    runDiagnostics: (distro: string) => ipcRenderer.invoke('wsl:runDiagnostics', distro)
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
