import { app, BrowserWindow, ipcMain, Tray, globalShortcut } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
import path from 'path'
import { createMainWindow, createOverlayWindow } from './windows'
import { createTray } from './tray'
import { IPMonitor, IPStatus } from './services/ip-monitor'
import { loadConfig, saveConfig, RedLogConfig } from './services/config'
import { initDB, closeDB, getProjectDir } from './db/index'
import { insertEvent, queryEvents, getEventCount, searchEvents } from './db/events'
import fs from 'fs'
import { eventBus } from './services/event-bus'
import { TerminalManager } from './agents/terminal-manager'
import { ClipboardMonitor } from './services/clipboard-monitor'
import { ScreenshotAgent } from './services/screenshot-agent'
import { ScopeMonitor } from './services/scope-monitor'
import { LootDetector } from './services/loot-detector'
import { initChain, appendToChain, getChainLength } from './services/evidence-chain'
import { FileTransferTracker } from './services/file-transfer-tracker'
import {
  listProjects, createProject, openProject, deleteProject,
  getProjectDir as getProjectPath, ProjectMeta
} from './services/project-manager'
import { startApiServer, stopApiServer, configureApi, getApiToken } from './services/api-server'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let activeProject: ProjectMeta | null = null

const ipMonitor = new IPMonitor()
const terminalManager = new TerminalManager()
const clipboardMonitor = new ClipboardMonitor()
const screenshotAgent = new ScreenshotAgent()
const scopeMonitor = new ScopeMonitor()
const lootDetector = new LootDetector()
const fileTransferTracker = new FileTransferTracker()

function broadcastIPStatus(status: IPStatus): void {
  mainWindow?.webContents.send('ip:status', status)
  overlayWindow?.webContents.send('ip:status', status)
}

function startProject(project: ProjectMeta): void {
  activeProject = project
  const projectDir = getProjectPath(project)
  const config = loadConfig(projectDir)
  saveConfig(projectDir, config)
  const engagementId = config.engagement.id
  const operatorId = config.operator.id

  initDB(projectDir)

  ipMonitor.configure({
    vpnIPs: config.network.vpnIPs,
    dailyIPs: config.network.dailyIPs,
    checkInterval: config.network.checkInterval
  })
  terminalManager.configure({ engagementId, operatorId })
  clipboardMonitor.configure({ engagementId, operatorId })
  screenshotAgent.configure({ engagementId, operatorId, idleDelay: 3, quality: 85 })
  scopeMonitor.configure({
    enforcement: config.scope.enforcement,
    targets: config.scope.targets,
    excludeTargets: config.scope.excludeTargets,
    engagementId,
    operatorId
  })
  lootDetector.configure({ engagementId, operatorId })
  fileTransferTracker.configure({
    engagementId,
    operatorId,
    watchDirs: ['~/Downloads'],
    alertThreshold: 52428800
  })
  initChain()

  ipMonitor.start()
  clipboardMonitor.start()
  screenshotAgent.start()
  fileTransferTracker.start()
  scopeMonitor.startDns()

  configureApi({
    engagementId,
    operatorId,
    lootDetector: lootDetector,
    screenshotAgent: screenshotAgent,
    ipMonitor: ipMonitor,
    scopeMonitor: scopeMonitor
  })
  startApiServer(6660).then((port) => {
    insertEvent('system', { subtype: 'api_started', port, token: getApiToken().slice(0, 8) + '...' }, { engagementId, operatorId })
  })

  insertEvent('system', { subtype: 'session_start' }, { engagementId, operatorId })

  if (!overlayWindow) {
    overlayWindow = createOverlayWindow()
  }

  mainWindow?.webContents.send('project:opened', {
    id: project.id,
    name: project.name
  })
}

function stopProject(): void {
  stopApiServer()
  ipMonitor.stop()
  clipboardMonitor.stop()
  screenshotAgent.stop()
  fileTransferTracker.stop()
  scopeMonitor.stopDns()
  terminalManager.destroyAll()
  closeDB()
  activeProject = null
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.redlog')

  mainWindow = createMainWindow()
  tray = createTray(mainWindow, null)

  // --- Project management ---
  ipcMain.handle('project:list', () => listProjects())
  ipcMain.handle('project:create', (_e, name: string) => {
    const project = createProject(name)
    startProject(project)
    return project
  })
  ipcMain.handle('project:open', (_e, id: string) => {
    const project = openProject(id)
    if (!project) return null
    startProject(project)
    return project
  })
  ipcMain.handle('project:delete', (_e, id: string) => deleteProject(id))
  ipcMain.handle('project:active', () => activeProject ? { id: activeProject.id, name: activeProject.name } : null)

  // --- IP ---
  ipcMain.handle('ip:getStatus', () => ipMonitor.status)
  ipcMain.handle('config:get', () => {
    if (!activeProject) return null
    return loadConfig(getProjectPath(activeProject))
  })
  ipcMain.handle('config:save', (_e, newConfig: RedLogConfig) => {
    if (!activeProject) return false
    const projectDir = getProjectPath(activeProject)
    saveConfig(projectDir, newConfig)
    ipMonitor.configure({
      vpnIPs: newConfig.network.vpnIPs,
      dailyIPs: newConfig.network.dailyIPs,
      checkInterval: newConfig.network.checkInterval
    })
    scopeMonitor.configure({
      enforcement: newConfig.scope.enforcement,
      targets: newConfig.scope.targets,
      excludeTargets: newConfig.scope.excludeTargets
    })
    scopeMonitor.stopDns()
    scopeMonitor.startDns()
    screenshotAgent.configure({ idleDelay: 3, quality: 85 })
    return true
  })
  ipcMain.on('overlay:setExpanded', (_e, expanded: boolean) => {
    overlayWindow?.setSize(440, expanded ? 210 : 52)
  })
  ipMonitor.on('status', broadcastIPStatus)

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
  fileTransferTracker.on('large-transfer', (info: { path: string; size: number; sha256: string }) => {
    mainWindow?.webContents.send('file:large-transfer', info)
  })
  terminalManager.on('transfer', (transfer: { direction: string; remotePath: string; remoteHost: string }, command: string) => {
    const evt = insertEvent('file_transfer', {
      ...transfer,
      command,
      method: command.split(/\s+/)[0]
    }, { engagementId: activeProject ? loadConfig(getProjectPath(activeProject)).engagement.id : 'default', operatorId: 'operator-1' })
    eventBus.publish(evt)
  })

  // --- Events ---
  ipcMain.handle('events:query', (_e, opts) => queryEvents(opts))
  ipcMain.handle('events:getCount', () => getEventCount())
  ipcMain.handle('events:search', (_e, query: string, limit?: number) => searchEvents(query, limit))
  eventBus.on('event', (event) => {
    mainWindow?.webContents.send('events:new', event)
    try { appendToChain(event.id) } catch { /* chain not ready */ }
    if (event.agentType === 'clipboard' && typeof event.data?.content === 'string') {
      lootDetector.scan(event.data.content as string)
    }
  })

  // --- Markers ---
  ipcMain.handle('marker:create', (_e, data: Record<string, unknown>) => {
    if (!activeProject) return null
    const config = loadConfig(getProjectPath(activeProject))
    const event = insertEvent('marker', {
      title: data.title,
      notes: data.notes,
      severity: data.severity ?? 'info',
      category: data.category ?? 'custom'
    }, { engagementId: config.engagement.id, operatorId: config.operator.id })
    eventBus.publish(event)
    return event
  })

  // --- Screenshots ---
  ipcMain.handle('screenshot:capture', () => screenshotAgent.captureNow('manual'))
  ipcMain.handle('screenshot:getPath', (_e, filename: string) => {
    return path.join(getProjectDir(), 'screenshots', filename)
  })
  ipcMain.handle('screenshot:read', (_e, filePath: string) => {
    try {
      const screenshotDir = path.join(getProjectDir(), 'screenshots')
      const resolved = path.resolve(filePath)
      if (!resolved.startsWith(screenshotDir)) return null
      const data = fs.readFileSync(resolved)
      return `data:image/jpeg;base64,${data.toString('base64')}`
    } catch { return null }
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
  stopProject()
  tray?.destroy()
})
