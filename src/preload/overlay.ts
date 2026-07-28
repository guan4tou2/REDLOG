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
  overlay: {
    setExpanded: (expanded: boolean) =>
      ipcRenderer.send('overlay:setExpanded', expanded),
    hide: () => ipcRenderer.send('overlay:hide'),
    mouseEnter: () => ipcRenderer.send('overlay:mouseEnter'),
    mouseLeave: () => ipcRenderer.send('overlay:mouseLeave')
  }
})
