import { app, BrowserWindow, ipcMain, Tray, globalShortcut, dialog, screen } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
import path from 'path'
import { homedir } from 'os'
import { createMainWindow, createOverlayWindow } from './windows'
import { createTray, setTrayRecording } from './tray'
import { IPMonitor, IPStatus } from '../core/ip-monitor'
import yaml from 'js-yaml'
import { loadConfig, saveConfig, loadScopeFile, RedLogConfig } from '../core/config'
import { initDB, closeDB, getProjectDir } from '../core/db/index'
import { insertEvent, queryEvents, getEventCount, searchEvents, queryScopeFilteredEvents } from '../core/db/events'
import {
  createQuickMark, updateQuickMark, getQuickMark, listQuickMarks, deleteQuickMark
} from '../core/db/findings'
import { getActiveBrowserTab, setCdpPort } from './services/cdp-connector'
import fs from 'fs'
import { eventBus } from '../core/event-bus'
import { ScreenshotAgent } from './services/screenshot-agent'
import { ScopeMonitor } from '../core/scope-monitor'
import { LootDetector } from '../core/loot-detector'
import { getChainLength } from '../core/evidence-chain'
import { anchorNow, listAnchors, startAnchorLoop, stopAnchorLoop, verifyLatestAnchor, verifyChainFull } from '../core/chain-anchor'
import { startNtpLoop, stopNtpLoop, getNtpOffsetMs, getLastNtpQuery } from '../core/clock'
import { configureRedaction } from '../core/redaction'
import { exportBundle } from '../core/bundle-export'
import { configureDeconfliction, getDeconflictionConfig, notifyDeconfliction, testWebhook } from '../core/deconfliction'
import {
  listProjects, createProject, openProject, deleteProject,
  getProjectDir as getProjectPath, ProjectMeta
} from '../core/project-manager'
import { startApiServer, stopApiServer, configureApi, getApiToken } from '../core/api-server'
import {
  listOperators, createOperator, updateOperatorToken, revokeOperator,
  deleteOperator, renameOperator, generateToken, slugifyOperatorId
} from '../core/db/operators'
import {
  spawnTerminal, writeTerminal, resizeTerminal, killTerminal,
  listTerminals, killAllTerminals, setTerminalWindow, configureTerminal
} from './terminal-manager'
import { detectHooks, installHook, uninstallHook } from '../core/hooks-manager'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let activeProject: ProjectMeta | null = null
let forceQuit = false
let overlayMouseInside = false
let overlayTrackingInterval: ReturnType<typeof setInterval> | null = null

function startOverlayMouseTracking(): void {
  if (overlayTrackingInterval) clearInterval(overlayTrackingInterval)
  overlayTrackingInterval = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return
    const point = screen.getCursorScreenPoint()
    const bounds = overlayWindow.getBounds()
    const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
                   point.y >= bounds.y && point.y <= bounds.y + bounds.height
    if (inside && !overlayMouseInside) {
      overlayMouseInside = true
      overlayWindow.setIgnoreMouseEvents(false)
      overlayWindow.webContents.send('overlay:interactive', true)
    } else if (!inside && overlayMouseInside) {
      overlayMouseInside = false
      overlayWindow.setIgnoreMouseEvents(true, { forward: true })
      overlayWindow.webContents.send('overlay:interactive', false)
    }
  }, 50)
}

function stopOverlayMouseTracking(): void {
  if (overlayTrackingInterval) {
    clearInterval(overlayTrackingInterval)
    overlayTrackingInterval = null
  }
}

function toggleRecording(): boolean {
  if (eventBus.paused) eventBus.resume()
  else eventBus.pause()
  const recording = !eventBus.paused
  mainWindow?.webContents.send('recording:changed', recording)
  overlayWindow?.webContents.send('recording:changed', recording)
  return recording
}

const WINDOW_STATE_PATH = path.join(homedir(), '.redlog', 'window-state.json')

function loadWindowState(): { bounds?: Electron.Rectangle; isMaximized?: boolean } | null {
  try { return JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, 'utf-8')) } catch { return null }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? undefined : win.getBounds()
    fs.mkdirSync(path.dirname(WINDOW_STATE_PATH), { recursive: true })
    fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify({ bounds, isMaximized }))
  } catch {}
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function debouncedSaveWindowState(win: BrowserWindow): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => saveWindowState(win), 500)
}

const ipMonitor = new IPMonitor()
const screenshotAgent = new ScreenshotAgent()
const scopeMonitor = new ScopeMonitor()
const lootDetector = new LootDetector()

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
    safeIPs: config.network.safeIPs,
    exposedIPs: config.network.exposedIPs,
    checkInterval: config.network.checkInterval
  })
  screenshotAgent.configure({ engagementId, operatorId, quality: config.screenshot.quality })

  let scopeTargets = config.scope.targets
  if (config.scope.scopeFile) {
    const loaded = loadScopeFile(config.scope.scopeFile)
    if (loaded.length > 0) scopeTargets = [...scopeTargets, ...loaded]
  }
  scopeMonitor.configure({
    enforcement: config.scope.enforcement,
    targets: scopeTargets,
    excludeTargets: config.scope.excludeTargets,
    engagementId,
    operatorId
  })
  lootDetector.configure({ engagementId, operatorId })
  configureRedaction(config.redaction)
  configureDeconfliction(config.deconfliction)

  configureTerminal({ engagementId, operatorId, maxCastBytes: config.terminal?.maxCastBytes })

  ipMonitor.start()

  configureApi({
    engagementId,
    operatorId,
    operatorName: config.operator.name,
    configLoader: {
      getConfig: () => loadConfig(projectDir),
      getTargets: () => config.scope.targets
    },
    lootDetector: lootDetector,
    screenshotAgent: screenshotAgent,
    ipMonitor: ipMonitor,
    scopeMonitor: scopeMonitor
  })
  startApiServer(6660).then((port) => {
    insertEvent('system', { subtype: 'api_started', port, token: getApiToken().slice(0, 8) + '...' }, { engagementId, operatorId })
  })

  insertEvent('system', { subtype: 'session_start' }, { engagementId, operatorId })

  startAnchorLoop()
  startNtpLoop()

  if (!overlayWindow) {
    overlayWindow = createOverlayWindow()
    startOverlayMouseTracking()
    if (tray) {
      tray.destroy()
      tray = createTray(mainWindow!, overlayWindow, toggleRecording)
      setTrayRecording(tray, !eventBus.paused)
    }
  }

}

function stopProject(): void {
  stopAnchorLoop()
  stopNtpLoop()
  stopApiServer()
  ipMonitor.stop()
  closeDB()
  activeProject = null
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.redlog')

  const savedState = loadWindowState()
  mainWindow = createMainWindow(savedState?.bounds)
  if (savedState?.isMaximized) mainWindow.maximize()

  setTerminalWindow(mainWindow)

  mainWindow.on('resize', () => { if (mainWindow) debouncedSaveWindowState(mainWindow) })
  mainWindow.on('move', () => { if (mainWindow) debouncedSaveWindowState(mainWindow) })
  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      if (mainWindow) saveWindowState(mainWindow)
      mainWindow?.hide()
    }
  })

  tray = createTray(mainWindow, null, toggleRecording)

  // --- Project management ---
  ipcMain.handle('project:list', () => listProjects())
  ipcMain.handle('project:create', (_e, name: string, initialConfig?: Partial<RedLogConfig>) => {
    const project = createProject(name)
    if (initialConfig) {
      const projectDir = getProjectPath(project)
      const config = loadConfig(projectDir)
      const merged = {
        ...config,
        engagement: { ...config.engagement, ...initialConfig.engagement },
        operator: { ...config.operator, ...initialConfig.operator },
        network: { ...config.network, ...initialConfig.network },
        scope: { ...config.scope, ...initialConfig.scope },
        screenshot: { ...config.screenshot, ...initialConfig.screenshot }
      }
      saveConfig(projectDir, merged)
    }
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
      safeIPs: newConfig.network.safeIPs,
      exposedIPs: newConfig.network.exposedIPs,
      checkInterval: newConfig.network.checkInterval
    })
    let targets = newConfig.scope.targets
    if (newConfig.scope.scopeFile) {
      const loaded = loadScopeFile(newConfig.scope.scopeFile)
      if (loaded.length > 0) targets = [...targets, ...loaded]
    }
    scopeMonitor.configure({
      enforcement: newConfig.scope.enforcement,
      targets,
      excludeTargets: newConfig.scope.excludeTargets
    })
    screenshotAgent.configure({ quality: newConfig.screenshot.quality })
    if (newConfig.redaction) configureRedaction(newConfig.redaction)
    if (newConfig.deconfliction) configureDeconfliction(newConfig.deconfliction)
    return true
  })
  ipcMain.on('overlay:setExpanded', (_e, expanded: boolean) => {
    overlayWindow?.setSize(440, expanded ? 210 : 52)
  })
  ipcMain.on('overlay:hide', () => {
    overlayWindow?.hide()
    mainWindow?.webContents.send('overlay:visibilityChanged', false)
  })
  ipcMain.on('overlay:show', () => {
    overlayWindow?.show()
    mainWindow?.webContents.send('overlay:visibilityChanged', true)
  })
  ipcMain.on('overlay:toggle', () => {
    if (overlayWindow?.isVisible()) {
      overlayWindow.hide()
    } else {
      overlayWindow?.show()
    }
    mainWindow?.webContents.send('overlay:visibilityChanged', overlayWindow?.isVisible() ?? false)
  })
  ipcMain.handle('overlay:isVisible', () => {
    return overlayWindow?.isVisible() ?? false
  })
  ipcMain.on('overlay:mouseEnter', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayMouseInside = true
      overlayWindow.setIgnoreMouseEvents(false)
      overlayWindow.webContents.send('overlay:interactive', true)
    }
  })
  ipcMain.on('overlay:mouseLeave', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayMouseInside = false
      overlayWindow.setIgnoreMouseEvents(true, { forward: true })
      overlayWindow.webContents.send('overlay:interactive', false)
    }
  })
  ipMonitor.on('status', broadcastIPStatus)

  // --- Events ---
  ipcMain.handle('events:query', (_e, opts) => queryEvents(opts))
  ipcMain.handle('events:getCount', () => getEventCount())
  ipcMain.handle('events:search', (_e, query: string, limit?: number) => searchEvents(query, limit))
  eventBus.on('event', (event) => {
    mainWindow?.webContents.send('events:new', event)
    notifyDeconfliction(event)
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
    if (event) eventBus.publish(event)
    return event
  })

  // --- Screenshots ---
  ipcMain.handle('screenshot:capture', () => screenshotAgent.captureNow('manual'))
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
  ipcMain.handle('chain:anchors', () => activeProject ? listAnchors() : [])
  ipcMain.handle('chain:anchorNow', async () => activeProject ? await anchorNow() : null)
  ipcMain.handle('chain:verify', (_e, opts?: { full?: boolean }) => {
    if (!activeProject) return { ok: false, anchor: null, currentHead: null }
    return opts?.full ? verifyChainFull() : verifyLatestAnchor()
  })
  ipcMain.handle('deconfliction:get', () => getDeconflictionConfig())
  ipcMain.handle('deconfliction:test', async (_e, cfg) => testWebhook(cfg))

  ipcMain.handle('clock:status', () => ({
    ntpOffsetMs: getNtpOffsetMs(),
    lastQueryAt: getLastNtpQuery(),
    hostWallMs: Date.now()
  }))

  // --- Loot ---
  ipcMain.handle('loot:getCount', () => lootDetector.getLootCount())

  // --- QuickMarks ---
  ipcMain.handle('quickmarks:list', () => listQuickMarks())
  ipcMain.handle('quickmarks:get', (_e, id: string) => getQuickMark(id))
  ipcMain.handle('quickmarks:create', async (_e, data: { title: string; url?: string; note?: string }) => {
    const browser = await getActiveBrowserTab()
    const context = {
      browserUrl: browser.url || undefined,
      browserTitle: browser.title || undefined,
      externalIP: ipMonitor.status.externalIP || undefined
    }
    return createQuickMark({
      title: data.title || browser.title || 'Untitled',
      url: data.url || browser.url || undefined,
      note: data.note,
      context
    })
  })
  ipcMain.handle('quickmarks:update', (_e, id: string, data) => updateQuickMark(id, data))
  ipcMain.handle('quickmarks:delete', (_e, id: string) => deleteQuickMark(id))

  // --- CDP ---
  ipcMain.handle('cdp:getTab', () => getActiveBrowserTab())
  ipcMain.handle('cdp:setPort', (_e, port: number) => { setCdpPort(port); return true })

  // --- Evidence bundle ---
  ipcMain.handle('data:exportBundle', () => {
    if (!activeProject) return null
    const cfg = loadConfig(getProjectPath(activeProject))
    const bundle = exportBundle(cfg.engagement.id)
    return { outDir: bundle.outDir, manifest: bundle.manifest }
  })

  // --- Data Export (minimal JSON dump) ---
  ipcMain.handle('data:exportJson', () => {
    if (!activeProject) return null
    const projectDir = getProjectPath(activeProject)
    const config = loadConfig(projectDir)
    const events = queryEvents({ limit: 100000 })
    const marks = listQuickMarks()
    const data = { config, quickmarks: marks, events, exportedAt: new Date().toISOString() }
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-${ts}.json`)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return filePath
  })

  // --- Config Profile Export/Import ---
  ipcMain.handle('config:exportProfile', async () => {
    if (!activeProject) return null
    const projectDir = getProjectPath(activeProject)
    const config = loadConfig(projectDir)
    const profile = { version: 1, ...config }
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: `redlog-profile-${activeProject.name.replace(/[^a-z0-9]/gi, '-')}.yaml`,
      filters: [
        { name: 'REDLOG Profile', extensions: ['yaml', 'yml'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    const ext = path.extname(result.filePath).toLowerCase()
    if (ext === '.json') {
      fs.writeFileSync(result.filePath, JSON.stringify(profile, null, 2))
    } else {
      fs.writeFileSync(result.filePath, `# REDLOG Profile — share with your team\n${yaml.dump(profile, { lineWidth: 120 })}`)
    }
    return result.filePath
  })

  ipcMain.handle('config:importProfile', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      filters: [
        { name: 'REDLOG Profile', extensions: ['yaml', 'yml', 'json'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null
    try {
      const raw = fs.readFileSync(result.filePaths[0], 'utf-8')
      const ext = path.extname(result.filePaths[0]).toLowerCase()
      const data = ext === '.json' ? JSON.parse(raw) : yaml.load(raw) as Record<string, unknown>
      delete data.version
      return data as Partial<RedLogConfig>
    } catch {
      return null
    }
  })

  // --- Terminal ---
  ipcMain.handle('terminal:spawn', (_e, id: string, cols: number, rows: number) => spawnTerminal(id, cols, rows))
  ipcMain.on('terminal:write', (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.on('terminal:kill', (_e, id: string) => killTerminal(id))
  ipcMain.handle('terminal:list', () => listTerminals())

  // --- Scope-filtered export ---
  ipcMain.handle('data:exportScopeFiltered', () => {
    if (!activeProject) return null
    const projectDir = getProjectPath(activeProject)
    const config = loadConfig(projectDir)
    let scopeTargets = config.scope.targets
    if (config.scope.scopeFile) {
      const loaded = loadScopeFile(config.scope.scopeFile)
      if (loaded.length > 0) scopeTargets = [...scopeTargets, ...loaded]
    }
    const events = queryScopeFilteredEvents(scopeTargets)
    const marks = listQuickMarks()
    const data = {
      engagement: config.engagement,
      operator: config.operator,
      scope: config.scope,
      quickmarks: marks,
      events,
      exportedAt: new Date().toISOString(),
      filtered: true,
      scopeTargets
    }
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-scope-${ts}.json`)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return filePath
  })

  // --- Hooks ---
  ipcMain.handle('hooks:detect', () => detectHooks())
  ipcMain.handle('hooks:install', (_e, hookId: string) => installHook(hookId))
  ipcMain.handle('hooks:uninstall', (_e, hookId: string) => uninstallHook(hookId))

  // --- Recording ---
  ipcMain.handle('recording:get', () => !eventBus.paused)
  ipcMain.handle('recording:toggle', () => toggleRecording())
  eventBus.on('recording', (recording: boolean) => {
    mainWindow?.webContents.send('recording:changed', recording)
    overlayWindow?.webContents.send('recording:changed', recording)
    if (tray) setTrayRecording(tray, recording)
  })

  // --- Operators ---
  ipcMain.handle('operators:list', () => {
    if (!activeProject) return []
    return listOperators().map((op) => ({
      id: op.id, name: op.name, isPrimary: op.isPrimary,
      createdAt: op.createdAt, revokedAt: op.revokedAt
    }))
  })
  ipcMain.handle('operators:create', (_e, name: string) => {
    if (!activeProject) return null
    const trimmed = (name || '').trim()
    if (!trimmed) return null
    const id = slugifyOperatorId(trimmed)
    const token = generateToken()
    try {
      const op = createOperator({ id, name: trimmed, token, isPrimary: false })
      return { operator: { id: op.id, name: op.name, isPrimary: false, createdAt: op.createdAt, revokedAt: null }, token }
    } catch {
      return null
    }
  })
  ipcMain.handle('operators:rotate', (_e, id: string) => {
    if (!activeProject) return null
    const token = generateToken()
    const ok = updateOperatorToken(id, token)
    if (!ok) return null
    const primary = listOperators().find((o) => o.id === id && o.isPrimary)
    if (primary) {
      const tokenPath = path.join(homedir(), '.redlog', 'api-token')
      try { fs.writeFileSync(tokenPath, token, { mode: 0o600 }) } catch {}
    }
    return { token }
  })
  ipcMain.handle('operators:rename', (_e, id: string, name: string) => {
    if (!activeProject) return false
    const trimmed = (name || '').trim()
    if (!trimmed) return false
    return renameOperator(id, trimmed)
  })
  ipcMain.handle('operators:revoke', (_e, id: string) => {
    if (!activeProject) return false
    return revokeOperator(id)
  })
  ipcMain.handle('operators:delete', (_e, id: string) => {
    if (!activeProject) return false
    return deleteOperator(id)
  })

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
  forceQuit = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopOverlayMouseTracking()
  killAllTerminals()
  stopProject()
  tray?.destroy()
})
