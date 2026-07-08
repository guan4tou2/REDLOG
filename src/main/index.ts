import { app, BrowserWindow, ipcMain, Tray } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
import { createMainWindow, createOverlayWindow } from './windows'
import { createTray } from './tray'
import { IPMonitor, IPStatus } from './services/ip-monitor'
import { loadConfig } from './services/config'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
const ipMonitor = new IPMonitor()

function broadcastIPStatus(status: IPStatus): void {
  mainWindow?.webContents.send('ip:status', status)
  overlayWindow?.webContents.send('ip:status', status)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.redlog')

  const config = loadConfig()

  ipMonitor.configure({
    allowedIPs: config.network.allowedIPs,
    checkInterval: config.network.checkInterval
  })

  mainWindow = createMainWindow()
  overlayWindow = createOverlayWindow()
  tray = createTray(mainWindow, overlayWindow)

  ipcMain.handle('ip:getStatus', () => ipMonitor.status)
  ipcMain.handle('config:get', () => config)
  ipcMain.on('overlay:setExpanded', (_e, expanded: boolean) => {
    if (!overlayWindow) return
    overlayWindow.setSize(420, expanded ? 200 : 44)
  })

  ipMonitor.on('status', broadcastIPStatus)
  ipMonitor.start()

  app.on('activate', () => {
    mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  ipMonitor.stop()
  tray?.destroy()
})
