import { app, BrowserWindow, ipcMain, Tray, globalShortcut } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
import { createMainWindow, createOverlayWindow } from './windows'
import { createTray } from './tray'
import { IPMonitor, IPStatus } from './services/ip-monitor'
import { loadConfig, saveConfig, RedLogConfig } from './services/config'
import { initDB, closeDB } from './db/index'
import { insertEvent, queryEvents, getEventCount } from './db/events'
import { eventBus } from './services/event-bus'
import { TerminalManager } from './agents/terminal-manager'
import { ClipboardMonitor } from './services/clipboard-monitor'
import { ScreenshotAgent } from './services/screenshot-agent'
import { ScopeMonitor } from './services/scope-monitor'
import { LootDetector } from './services/loot-detector'
import { initChain, appendToChain, getChainLength } from './services/evidence-chain'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
const ipMonitor = new IPMonitor()
const terminalManager = new TerminalManager()
const clipboardMonitor = new ClipboardMonitor()
const screenshotAgent = new ScreenshotAgent()
const scopeMonitor = new ScopeMonitor()
const lootDetector = new LootDetector()

function broadcastIPStatus(status: IPStatus): void {
  mainWindow?.webContents.send('ip:status', status)
  overlayWindow?.webContents.send('ip:status', status)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.redlog')

  const config = loadConfig()
  const engagementId = config.engagement.id
  const operatorId = config.operator.id

  initDB(engagementId)

  ipMonitor.configure({
    vpnIPs: config.network.vpnIPs,
    dailyIPs: config.network.dailyIPs,
    checkInterval: config.network.checkInterval
  })
  terminalManager.configure({ engagementId, operatorId })
  clipboardMonitor.configure({ engagementId, operatorId })
  screenshotAgent.configure({
    engagementId,
    operatorId,
    idleDelay: 3,
    quality: 85
  })
  scopeMonitor.configure({
    enforcement: config.scope.enforcement,
    targets: config.scope.targets,
    excludeTargets: config.scope.excludeTargets,
    engagementId,
    operatorId
  })
  lootDetector.configure({ engagementId, operatorId })
  initChain()

  mainWindow = createMainWindow()
  overlayWindow = createOverlayWindow()
  tray = createTray(mainWindow, overlayWindow)

  // --- IP ---
  ipcMain.handle('ip:getStatus', () => ipMonitor.status)
  ipcMain.handle('config:get', () => config)
  ipcMain.handle('config:save', (_e, newConfig: RedLogConfig) => {
    saveConfig(newConfig)
    return true
  })
  ipcMain.on('overlay:setExpanded', (_e, expanded: boolean) => {
    overlayWindow?.setSize(440, expanded ? 210 : 52)
  })
  ipMonitor.on('status', broadcastIPStatus)
  ipMonitor.start()

  // --- Terminal ---
  ipcMain.handle('terminal:create', (_e, cols: number, rows: number) => {
    return terminalManager.create(cols, rows)
  })
  ipcMain.on('terminal:write', (_e, id: string, data: string) => {
    terminalManager.write(id, data)
  })
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => {
    terminalManager.resize(id, cols, rows)
  })
  ipcMain.on('terminal:destroy', (_e, id: string) => {
    terminalManager.destroy(id)
  })
  terminalManager.on('data', (id: string, data: string) => {
    mainWindow?.webContents.send('terminal:data', id, data)
    if (data.length > 20) lootDetector.scan(data)
  })
  terminalManager.on('exit', (id: string, code: number) => {
    mainWindow?.webContents.send('terminal:exit', id, code)
  })
  terminalManager.on('target', (target: string, command: string) => {
    const result = scopeMonitor.checkTarget(target, command)
    mainWindow?.webContents.send('scope:check', { target, command, ...result })
  })

  // --- Events ---
  ipcMain.handle('events:query', (_e, opts) => queryEvents(opts))
  ipcMain.handle('events:getCount', () => getEventCount())
  eventBus.on('event', (event) => {
    mainWindow?.webContents.send('events:new', event)
    try { appendToChain(event.id) } catch { /* chain not ready */ }
  })

  // --- Markers ---
  ipcMain.handle('marker:create', (_e, data: Record<string, unknown>) => {
    const event = insertEvent('marker', {
      title: data.title,
      notes: data.notes,
      severity: data.severity ?? 'info',
      category: data.category ?? 'custom'
    }, { engagementId, operatorId })
    eventBus.publish(event)
    return event
  })

  // --- Screenshots ---
  ipcMain.handle('screenshot:capture', () => screenshotAgent.captureNow('manual'))
  ipcMain.handle('screenshot:getPath', (_e, filename: string) => {
    const { getDataDir } = require('./db/index')
    const path = require('path')
    return path.join(getDataDir(engagementId), 'screenshots', filename)
  })

  // --- Scope ---
  ipcMain.handle('scope:getViolations', () => scopeMonitor.getViolations())
  ipcMain.handle('scope:getViolationCount', () => scopeMonitor.getViolationCount())
  ipcMain.handle('scope:isConfigured', () => scopeMonitor.isConfigured())

  // --- Evidence Chain ---
  ipcMain.handle('chain:length', () => getChainLength())

  // --- Loot ---
  ipcMain.handle('loot:getCount', () => lootDetector.getLootCount())
  ipcMain.handle('loot:scan', (_e, text: string) => lootDetector.scan(text))

  // --- Global shortcut ---
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    mainWindow?.webContents.send('shortcut:marker')
    mainWindow?.show()
    mainWindow?.focus()
  })

  // Start agents
  clipboardMonitor.start()
  screenshotAgent.start()

  insertEvent('system', { subtype: 'session_start' }, { engagementId, operatorId })

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
  globalShortcut.unregisterAll()
  ipMonitor.stop()
  clipboardMonitor.stop()
  screenshotAgent.stop()
  terminalManager.destroyAll()
  closeDB()
  tray?.destroy()
})
