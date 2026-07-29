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
import { anchorNow, listAnchors, startAnchorLoop, stopAnchorLoop, verifyLatestAnchor, verifyChainFull, upgradeAnchor, upgradeAllPending } from '../core/chain-anchor'
import { startNtpLoop, stopNtpLoop, getNtpOffsetMs, getLastNtpQuery } from '../core/clock'
import { configureRedaction } from '../core/redaction'
import { exportBundle } from '../core/bundle-export'
import { configureDeconfliction, getDeconflictionConfig, notifyDeconfliction, testWebhook } from '../core/deconfliction'
import {
  listProjects, createProject, openProject, deleteProject,
  getProjectDir as getProjectPath, ProjectMeta
} from '../core/project-manager'
import { startApiServer, stopApiServer, configureApi, getApiToken, setAppVersion, getApiPort } from '../core/api-server'
import {
  listOperators, createOperator, updateOperatorToken, revokeOperator,
  deleteOperator, renameOperator, generateToken, slugifyOperatorId
} from '../core/db/operators'
import {
  spawnTerminal, writeTerminal, resizeTerminal, killTerminal,
  listTerminals, killAllTerminals, setTerminalWindow, configureTerminal
} from './terminal-manager'
import { detectHooks, installHook, uninstallHook } from '../core/hooks-manager'
import { initPlugins, reloadPlugins, listPlugins, listEventTypes, setPluginEnabled, grantPluginTrust, revokePluginTrust, setPluginHost } from '../core/plugins'
import { createPluginHost } from '../core/plugins/host'
import { getCaptureHealth, invalidateHooksCache } from '../core/capture-health'
import { launchBrowser, stopBrowser, isBrowserRunning, detectBrowser, DEFAULT_BROWSER } from './services/browser-launcher'

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

// Timers and pty callbacks keep firing while the app tears down, and a
// destroyed BrowserWindow is still non-null — send through here so a quit
// mid-poll can't raise "Object has been destroyed".
function send(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed()) return
  try { win.webContents.send(channel, payload) } catch { /* window tearing down */ }
}

function toggleRecording(): boolean {
  if (eventBus.paused) eventBus.resume()
  else eventBus.pause()
  const recording = !eventBus.paused
  send(mainWindow, 'recording:changed', recording)
  send(overlayWindow, 'recording:changed', recording)
  return recording
}

// Quick-mark trigger shared by the global shortcut, the tray menu, and the
// overlay button — opens the marker dialog in the main window.
function triggerQuickMark(): void {
  send(mainWindow, 'shortcut:marker')
  mainWindow?.show()
  mainWindow?.focus()
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

// Recent distinct pivot nodes for the overlay — dedup by intermediate node,
// most-recent first, capped. Lets the floating window show the live pivot chain.
interface ActivePivot { via: string; tool: string; route?: string; ts: number }
function getActivePivots(): ActivePivot[] {
  try {
    const evs = queryEvents({ agentType: 'pivot', limit: 40 })
    const seen = new Set<string>()
    const out: ActivePivot[] = []
    for (const e of evs) {
      const d = (e.data ?? {}) as Record<string, unknown>
      const via = (d.via as string) || ''
      if (!via || seen.has(via)) continue
      seen.add(via)
      out.push({ via, tool: String(d.tool ?? 'pivot'), route: d.route as string | undefined, ts: e.timestamp })
      if (out.length >= 5) break
    }
    return out
  } catch { return [] }
}

function broadcastIPStatus(status: IPStatus): void {
  send(mainWindow, 'ip:status', status)
  send(overlayWindow, 'ip:status', status)
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
    whitelist: config.network.whitelist,
    blacklist: config.network.blacklist,
    checkInterval: config.network.checkInterval,
    providers: config.network.providers,
    confirmations: config.network.confirmations
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
  // 🔴 host: runs trusted plugin code in an isolated utility process, serving a
  // capability-scoped API. Wired before initPlugins so trusted plugins start.
  setPluginHost(createPluginHost({
    queryEvents: (a) => queryEvents({ limit: Math.min(Number(a.limit) || 50, 500), type: a.type as string | undefined, target: a.target as string | undefined }),
    searchEvents: (a) => searchEvents(String(a.query ?? ''), Math.min(Number(a.limit) || 20, 200)),
    appendEvent: (pluginId, a) => {
      const ev = insertEvent(String(a.agent_type ?? 'agent'), { ...(a.data as Record<string, unknown>), plugin: pluginId }, { operatorId, engagementId })
      if (ev) eventBus.publish(ev)
      return { ok: !!ev }
    },
    listFindings: () => listQuickMarks(),
    getConfig: () => ({ engagement: config.engagement, scope: config.scope, redaction: config.redaction }),
    fetch: async (a) => {
      const r = await fetch(String(a.url), { method: String(a.method ?? 'GET') })
      return { status: r.status, body: (await r.text()).slice(0, 10_000) }
    }
  }))
  // Load plugins after core config so their 🟢 contributions (loot/redaction/
  // target/event-type/capture) layer on top. 🔴 code plugins only start if the
  // trust gate already passed.
  try {
    const psum = initPlugins()
    if (psum.total > 0) console.log(`[plugins] ${psum.active} active, ${psum.needsConsent} need consent, ${psum.errors} errors`)
  } catch (e) { console.error('[plugins] init failed:', e) }
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
      tray = createTray(mainWindow!, overlayWindow, toggleRecording, triggerQuickMark)
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

// One RedLog at a time. Two instances race for port 6660 and clobber each
// other's ~/.redlog/api-token, which breaks hooks/CLI/MCP and can wedge the UI.
// A second launch just focuses the window that's already open.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  electronApp.setAppUserModelId('com.redlog')
  setAppVersion(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev')

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

  tray = createTray(mainWindow, null, toggleRecording, triggerQuickMark)

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
      whitelist: newConfig.network.whitelist,
      blacklist: newConfig.network.blacklist,
      checkInterval: newConfig.network.checkInterval,
      providers: newConfig.network.providers,
      confirmations: newConfig.network.confirmations
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
    // grow the expanded panel to fit the status grid, the unknown-IP hint, and
    // the pivot topology (chain wraps ~2 nodes per line), so the Mark button at
    // the bottom is never clipped. Generous base + per-pivot headroom.
    const pivotCount = Math.min(getActivePivots().length, 4)
    const extra = pivotCount > 0 ? 40 + pivotCount * 34 : 0
    overlayWindow?.setSize(440, expanded ? 206 + extra : 50)
  })
  ipcMain.on('overlay:hide', () => {
    overlayWindow?.hide()
    send(mainWindow, 'overlay:visibilityChanged', false)
  })
  ipcMain.on('overlay:show', () => {
    overlayWindow?.show()
    send(mainWindow, 'overlay:visibilityChanged', true)
  })
  ipcMain.on('overlay:toggle', () => {
    if (overlayWindow?.isVisible()) {
      overlayWindow.hide()
    } else {
      overlayWindow?.show()
    }
    send(mainWindow, 'overlay:visibilityChanged', overlayWindow?.isVisible() ?? false)
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
    send(mainWindow, 'events:new', event)
    notifyDeconfliction(event)
    // keep the overlay + dashboard pivot views live
    if (event.agentType === 'pivot') {
      const p = getActivePivots()
      send(overlayWindow, 'pivots:changed', p)
      send(mainWindow, 'pivots:changed', p)
    }
  })
  ipcMain.handle('pivots:getActive', () => getActivePivots())

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
  ipcMain.handle('chain:upgrade', async (_e, id?: string) => {
    if (!activeProject) return null
    if (id) return await upgradeAnchor(id)
    return await upgradeAllPending()
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

  // --- Proxied browser ---
  ipcMain.handle('browser:detect', () => detectBrowser())
  ipcMain.handle('browser:status', () => ({ running: isBrowserRunning() }))
  ipcMain.handle('browser:launch', () => {
    if (!activeProject) return { ok: false, error: 'No project open' }
    const projectDir = getProjectPath(activeProject)
    const cfg = loadConfig(projectDir)
    const browserCfg = { ...DEFAULT_BROWSER, ...(cfg.browser ?? {}) }
    const result = launchBrowser(browserCfg, projectDir)

    if (result.ok) {
      setCdpPort(browserCfg.cdpPort)
      const event = insertEvent('system', {
        subtype: 'browser_launched',
        binary: result.binary,
        proxy: browserCfg.proxy || null,
        cdpPort: browserCfg.cdpPort,
        isolatedProfile: browserCfg.isolateProfile,
        pid: result.pid
      }, { engagementId: cfg.engagement.id, operatorId: cfg.operator.id })
      if (event) eventBus.publish(event)
    }
    return result
  })
  ipcMain.handle('browser:stop', () => ({ stopped: stopBrowser() }))

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
  ipcMain.handle('capture:health', () => activeProject ? getCaptureHealth() : null)
  ipcMain.handle('hooks:install', (_e, hookId: string) => { invalidateHooksCache(); return installHook(hookId) })
  ipcMain.handle('hooks:uninstall', (_e, hookId: string) => { invalidateHooksCache(); return uninstallHook(hookId) })

  // --- Plugins ---
  // Serialise LoadedPlugin to a UI-friendly shape (drop absolute dirs/hashes we
  // don't need in the renderer; keep what the panel renders + acts on).
  const pluginView = () => listPlugins().map((p) => ({
    id: p.manifest.id, name: p.manifest.name, version: p.manifest.version,
    description: p.manifest.description ?? '', author: p.manifest.author ?? '',
    source: p.source, tier: p.tier, status: p.status,
    capabilities: p.manifest.capabilities ?? [],
    contributes: Object.keys(p.manifest.contributes ?? {}),
    error: p.error
  }))
  ipcMain.handle('plugins:list', () => pluginView())
  ipcMain.handle('plugins:eventTypes', () => listEventTypes())
  ipcMain.handle('plugins:reload', () => { invalidateHooksCache(); reloadPlugins(); return pluginView() })
  ipcMain.handle('plugins:setEnabled', (_e, id: string, enabled: boolean) => { setPluginEnabled(id, enabled); invalidateHooksCache(); return pluginView() })
  ipcMain.handle('plugins:grant', (_e, id: string) => { const r = grantPluginTrust(id, operatorId); return { ...r, plugins: pluginView() } })
  ipcMain.handle('plugins:revoke', (_e, id: string) => { revokePluginTrust(id); return pluginView() })

  // --- Recording ---
  ipcMain.handle('recording:get', () => !eventBus.paused)
  ipcMain.handle('recording:toggle', () => toggleRecording())
  eventBus.on('recording', (recording: boolean) => {
    send(mainWindow, 'recording:changed', recording)
    send(overlayWindow, 'recording:changed', recording)
    if (tray) setTrayRecording(tray, recording)
  })

  // --- MCP (app-hosted HTTP server) ---
  const MCP_OPERATOR_ID = 'mcp-agent'
  ipcMain.handle('mcp:info', () => {
    if (!activeProject) return null
    const port = getApiPort()
    // In dev the stdio bridge is in the repo; in a packaged app it's unpacked
    // next to resources. HTTP is the recommended transport either way.
    const stdioPath = app.isPackaged
      ? path.join(process.resourcesPath, 'mcp', 'redlog-mcp-server.js')
      : path.join(__dirname, '../../mcp/redlog-mcp-server.js')
    return {
      port,
      endpoint: `http://127.0.0.1:${port}/mcp`,
      stdioPath,
      hasToken: listOperators().some((o) => o.id === MCP_OPERATOR_ID && !o.revokedAt)
    }
  })
  // Mints (or rotates) a dedicated, non-rotating operator token for MCP. Unlike
  // the primary token this survives app restarts, so a registered `claude mcp
  // add` keeps working, and MCP activity is attributed to its own identity.
  ipcMain.handle('mcp:setupToken', () => {
    if (!activeProject) return null
    const token = generateToken()
    const existing = listOperators().find((o) => o.id === MCP_OPERATOR_ID)
    if (existing) updateOperatorToken(MCP_OPERATOR_ID, token)
    else createOperator({ id: MCP_OPERATOR_ID, name: 'MCP agent', token, isPrimary: false })
    return { token, port: getApiPort(), endpoint: `http://127.0.0.1:${getApiPort()}/mcp` }
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

  // --- Quick mark (global shortcut + tray + overlay all route here) ---
  globalShortcut.register('CommandOrControl+Shift+M', triggerQuickMark)
  ipcMain.on('overlay:quickMark', triggerQuickMark)

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
  stopBrowser()
  globalShortcut.unregisterAll()
  stopOverlayMouseTracking()
  killAllTerminals()
  stopProject()
  tray?.destroy()
})
