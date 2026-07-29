import { contextBridge, ipcRenderer } from 'electron'

export interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  isAllowed: boolean
  lastCheck: number
  error: string | null
}

contextBridge.exposeInMainWorld('redlog', {
  ip: {
    getStatus: (): Promise<IPStatus> => ipcRenderer.invoke('ip:getStatus'),
    onStatus: (callback: (status: IPStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: IPStatus) =>
        callback(status)
      ipcRenderer.on('ip:status', handler)
      return () => ipcRenderer.removeListener('ip:status', handler)
    }
  },
  recording: {
    get: (): Promise<boolean> => ipcRenderer.invoke('recording:get'),
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
  config: {
    get: (): Promise<unknown> => ipcRenderer.invoke('config:get')
  },
  overlay: {
    setExpanded: (expanded: boolean) =>
      ipcRenderer.send('overlay:setExpanded', expanded),
    autosize: (height: number) => ipcRenderer.send('overlay:autosize', height),
    hide: () => ipcRenderer.send('overlay:hide'),
    quickMark: () => ipcRenderer.send('overlay:quickMark'),
    mouseEnter: () => ipcRenderer.send('overlay:mouseEnter'),
    mouseLeave: () => ipcRenderer.send('overlay:mouseLeave'),
    onInteractive: (cb: (interactive: boolean) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, v: boolean) => cb(v)
      ipcRenderer.on('overlay:interactive', handler)
      return () => ipcRenderer.removeListener('overlay:interactive', handler)
    }
  }
})
