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
    get: (): Promise<unknown> => ipcRenderer.invoke('config:get'),
    onShowMark: (cb: (show: boolean) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, show: boolean): void => cb(show)
      ipcRenderer.on('overlay:showMark', handler)
      return () => ipcRenderer.removeListener('overlay:showMark', handler)
    },
    onFlashExposed: (cb: (on: boolean) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, on: boolean): void => cb(on)
      ipcRenderer.on('overlay:flashExposed', handler)
      return () => ipcRenderer.removeListener('overlay:flashExposed', handler)
    },
    onScale: (cb: (n: number) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, n: number): void => cb(n)
      ipcRenderer.on('overlay:scale', handler)
      return () => ipcRenderer.removeListener('overlay:scale', handler)
    },
    onEmphasizeIp: (cb: (on: boolean) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, on: boolean): void => cb(on)
      ipcRenderer.on('overlay:emphasizeIp', handler)
      return () => ipcRenderer.removeListener('overlay:emphasizeIp', handler)
    },
    // Pass-through style. Emitted alongside main setting overlay.passThrough
    // so the overlay renderer can dim non-critical UI while keeping the
    // external IP fully readable. Payload is the resolved opacity from
    // config.overlay.passThroughOpacity (falsy → off, restore full opacity).
    onPassThrough: (cb: (on: boolean, opacity: number) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, on: boolean, opacity: number): void => cb(on, opacity)
      ipcRenderer.on('overlay:passThrough', handler)
      return () => ipcRenderer.removeListener('overlay:passThrough', handler)
    }
  },
  overlay: {
    setExpanded: (expanded: boolean) =>
      ipcRenderer.send('overlay:setExpanded', expanded),
    autosize: (height: number, width?: number) => ipcRenderer.send('overlay:autosize', height, width),
    hide: () => ipcRenderer.send('overlay:hide'),
    /** Opens the full marker dialog in the main window (raises + focuses it). */
    quickMark: () => ipcRenderer.send('overlay:quickMark'),
    /** Drops a timestamped marker without touching window focus. */
    instantMark: (): Promise<{ ok: boolean; id?: string }> => ipcRenderer.invoke('overlay:instantMark'),
    mouseEnter: () => ipcRenderer.send('overlay:mouseEnter'),
    mouseLeave: () => ipcRenderer.send('overlay:mouseLeave'),
    onInteractive: (cb: (interactive: boolean) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, v: boolean) => cb(v)
      ipcRenderer.on('overlay:interactive', handler)
      return () => ipcRenderer.removeListener('overlay:interactive', handler)
    }
  }
})
