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
  overlay: {
    setExpanded: (expanded: boolean) =>
      ipcRenderer.send('overlay:setExpanded', expanded)
  }
})
