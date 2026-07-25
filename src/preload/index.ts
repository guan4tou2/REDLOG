import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('redlog', {
  ip: {
    getStatus: () => ipcRenderer.invoke('ip:getStatus'),
    onStatus: (cb: (status: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, s: unknown) => cb(s)
      ipcRenderer.on('ip:status', handler)
      return () => ipcRenderer.removeListener('ip:status', handler)
    }
  },
  config: {
    get: () => ipcRenderer.invoke('config:get')
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
      ipcRenderer.invoke('screenshot:getPath', filename)
  }
})
