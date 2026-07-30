import { app, BrowserWindow, ipcMain, Tray, globalShortcut, dialog, screen, session, shell } from 'electron'
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
import { getActiveBrowserTab, setCdpPort, configureCdpMonitor, stopCdpMonitor } from './services/cdp-connector'
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
import { configureClipboardMonitor, startClipboardMonitor, stopClipboardMonitor } from './clipboard-monitor'
import { configureOpsecMonitor, startOpsecMonitor, stopOpsecMonitor, setVpnAdapters, OpsecStateDelta } from './services/opsec-state'
import { initPlugins, reloadPlugins, listPlugins, listEventTypes, setPluginEnabled, grantPluginTrust, revokePluginTrust, setPluginHost } from '../core/plugins'
import { createPluginHost } from '../core/plugins/host'
import { getCaptureHealth, invalidateHooksCache } from '../core/capture-health'
import { launchBrowser, stopBrowser, isBrowserRunning, detectBrowser, DEFAULT_BROWSER } from './services/browser-launcher'
import { detectLink } from './services/network-info'
import { checkForUpdates } from './services/updater'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let activeProject: ProjectMeta | null = null
// Cached IDs of the currently-open project, so background sources (IP monitor,
// recording toggle) can insert attributed events without re-reading config.yaml
// from disk on every tick. Cleared in stopProject.
let currentEngagementId: string | null = null
let currentOperatorId: string | null = null
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
// A pivot is only shown while it's plausibly still open. RedLog detects pivots
// from the command that creates them (ssh -D/-L/-R, chisel, ligolo…). It closes
// them on two signals, best-to-worst:
//   1. command_end for a foreground tunnel — the shell hook fires it when the
//      ssh/chisel process actually exits, so a Ctrl-C'd SOCKS tunnel drops at
//      once. (A backgrounded `-f`/`&` pivot ends its command instantly while the
//      tunnel lives on, so we ignore near-zero-duration ends.)
//   2. a 30-min recency window — the fallback for backgrounded/remote pivots we
//      can't observe closing; without it a single ssh command would pin a pivot
//      to the HUD forever.
// (PID liveness isn't viable: command_start fires before the process exists, the
// hook's pid is the shell's $$, and -fN self-daemonizes — plus remote/agent-run
// pivots have no PID this host could check.)
const PIVOT_ACTIVE_WINDOW_MS = 30 * 60 * 1000
const PIVOT_FOREGROUND_MIN_SEC = 2
function getActivePivots(): ActivePivot[] {
  try {
    const evs = queryEvents({ agentType: 'pivot', limit: 40 })
    const cutoff = Date.now() - PIVOT_ACTIVE_WINDOW_MS
    // command_end events that closed a foreground tunnel → command text of a pivot
    // that has since exited. Matched by the exact command that opened the pivot.
    const closedCmds = new Set<string>()
    for (const e of queryEvents({ agentType: 'shell', limit: 120 })) {
      const d = (e.data ?? {}) as Record<string, unknown>
      if (d.subtype !== 'command_end') continue
      const cmd = (d.command as string) || ''
      if (cmd && Number(d.duration_sec ?? 0) >= PIVOT_FOREGROUND_MIN_SEC) closedCmds.add(cmd)
    }
    const seen = new Set<string>()
    const out: ActivePivot[] = []
    for (const e of evs) {
      if (e.timestamp < cutoff) continue
      const d = (e.data ?? {}) as Record<string, unknown>
      const via = (d.via as string) || ''
      if (!via || seen.has(via)) continue
      const cmd = (d.command as string) || ''
      if (cmd && closedCmds.has(cmd)) continue // foreground tunnel has since exited
      seen.add(via)
      out.push({ via, tool: String(d.tool ?? 'pivot'), route: d.route as string | undefined, ts: e.timestamp })
      if (out.length >= 5) break
    }
    return out
  } catch { return [] }
}

// Active network link (Wi-Fi SSID / wired), read from local system tools. Cached
// and refreshed on a timer so the (blocking-ish) shell-outs never sit on the IP
// broadcast path; the last-known value rides along with every ip:status.
let currentLink: { type: 'wifi' | 'wired' | 'unknown'; name: string } = { type: 'unknown', name: '' }
let linkTimer: ReturnType<typeof setInterval> | null = null

// Whether RedLog keeps a macOS Dock icon. Showing the overlay flips the app to an
// accessory (no Dock icon); this lets the operator choose to keep it (default) or
// run Dock-less. Applied on overlay show and on settings change.
let keepDockIcon = true
function applyDock(): void {
  if (process.platform !== 'darwin') return
  if (keepDockIcon) app.dock?.show()
  else app.dock?.hide()
}
function startLinkMonitor(): void {
  const refresh = (): void => { detectLink().then((l) => { currentLink = l }).catch(() => {}) }
  refresh()
  if (linkTimer) clearInterval(linkTimer)
  linkTimer = setInterval(refresh, 20_000)
}

// Last broadcast state, kept module-level to detect transitions. A change in
// ipSafety (safe/exposed/unknown) or in the externalIP itself is an OPSEC signal
// worth preserving — VPN dropped mid-op, egress switched pools, etc. Only the
// current state was ever in the HUD; now every transition lands in the audit log.
let lastBroadcastSafety: IPStatus['ipSafety'] | null = null
let lastBroadcastIP: string | null = null
function broadcastIPStatus(status: IPStatus): void {
  const s = { ...status, link: currentLink }
  send(mainWindow, 'ip:status', s)
  send(overlayWindow, 'ip:status', s)
  // Record safety/IP transitions (skip the very first broadcast — it's the seed
  // state, not a change; and skip if no project is open yet).
  if (lastBroadcastSafety !== null && currentEngagementId && currentOperatorId) {
    const safetyChanged = status.ipSafety !== lastBroadcastSafety
    const ipChanged = status.externalIP != null && status.externalIP !== lastBroadcastIP
    if (safetyChanged || ipChanged) {
      try {
        const ev = insertEvent('system', {
          subtype: 'ip_transition',
          from_safety: lastBroadcastSafety, to_safety: status.ipSafety,
          from_ip: lastBroadcastIP, to_ip: status.externalIP ?? null,
          description: safetyChanged
            ? `IP safety ${lastBroadcastSafety} → ${status.ipSafety}${ipChanged ? ` (${lastBroadcastIP ?? '?'} → ${status.externalIP})` : ''}`
            : `External IP changed ${lastBroadcastIP} → ${status.externalIP}`
        }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
        if (ev) eventBus.publish(ev)
      } catch { /* audit-additive; never block IP broadcasting */ }
    }
  }
  lastBroadcastSafety = status.ipSafety
  if (status.externalIP != null) lastBroadcastIP = status.externalIP
}

// Log the security-relevant fields that changed on config:save. Cosmetic changes
// (Dock icon, HUD flash toggle) stay silent — we only record settings that would
// affect enforcement or attribution if silently loosened.
function logConfigDiff(oldCfg: RedLogConfig, newCfg: RedLogConfig): void {
  if (!currentEngagementId || !currentOperatorId) return
  const changed: Record<string, { from: unknown; to: unknown }> = {}
  const check = (path: string, from: unknown, to: unknown): void => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changed[path] = { from, to }
  }
  check('scope.warnOnViolation', oldCfg.scope?.warnOnViolation, newCfg.scope?.warnOnViolation)
  check('scope.targets', oldCfg.scope?.targets, newCfg.scope?.targets)
  check('scope.excludeTargets', oldCfg.scope?.excludeTargets, newCfg.scope?.excludeTargets)
  check('scope.scopeFile', oldCfg.scope?.scopeFile, newCfg.scope?.scopeFile)
  check('network.blacklist', oldCfg.network?.blacklist, newCfg.network?.blacklist)
  check('network.whitelist', oldCfg.network?.whitelist, newCfg.network?.whitelist)
  check('engagement.id', oldCfg.engagement?.id, newCfg.engagement?.id)
  check('operator.id', oldCfg.operator?.id, newCfg.operator?.id)
  check('operator.name', oldCfg.operator?.name, newCfg.operator?.name)
  check('deconfliction.endpoint', oldCfg.deconfliction?.endpoint, newCfg.deconfliction?.endpoint)
  if (Object.keys(changed).length === 0) return
  try {
    const ev = insertEvent('system', {
      subtype: 'config_changed',
      changed,
      description: `Config changed: ${Object.keys(changed).join(', ')}`
    }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
    if (ev) eventBus.publish(ev)
  } catch { /* additive */ }
}

// Compress an OpsecStateDelta into a one-line human description for the event
// row. Prioritized: VPN state comes first (biggest OPSEC impact), then MAC
// (randomization signal), then DNS (leak signal), then hostname.
function describeOpsecDelta(d: OpsecStateDelta): string {
  const parts: string[] = []
  if (d.vpn) {
    const added = d.vpn.to.filter((x) => !d.vpn!.from.includes(x))
    const removed = d.vpn.from.filter((x) => !d.vpn!.to.includes(x))
    if (added.length) parts.push(`VPN up: ${added.join(', ')}`)
    if (removed.length) parts.push(`VPN down: ${removed.join(', ')}`)
  }
  if (d.primaryMac) parts.push(`MAC ${d.primaryMac.from ?? '?'} → ${d.primaryMac.to ?? '?'}`)
  if (d.dns) {
    const added = d.dns.to.filter((x) => !d.dns!.from.includes(x))
    const removed = d.dns.from.filter((x) => !d.dns!.to.includes(x))
    if (added.length || removed.length) parts.push(`DNS ${d.dns.from.join(',') || '∅'} → ${d.dns.to.join(',') || '∅'}`)
  }
  if (d.hostname) parts.push(`hostname ${d.hostname.from} → ${d.hostname.to}`)
  return parts.join('; ') || 'OPSEC state changed'
}

function startProject(project: ProjectMeta): void {
  activeProject = project
  const projectDir = getProjectPath(project)
  const config = loadConfig(projectDir)
  saveConfig(projectDir, config)
  keepDockIcon = config.overlay?.showInDock !== false
  applyDock()
  const engagementId = config.engagement.id
  const operatorId = config.operator.id
  currentEngagementId = engagementId
  currentOperatorId = operatorId

  initDB(projectDir)

  ipMonitor.configure({
    whitelist: config.network.whitelist,
    blacklist: config.network.blacklist,
    checkInterval: config.network.checkInterval,
    providers: config.network.providers,
    confirmations: config.network.confirmations,
    ipMode: config.network.ipMode
  })
  screenshotAgent.configure({ engagementId, operatorId, quality: config.screenshot.quality })

  let scopeTargets = config.scope.targets
  if (config.scope.scopeFile) {
    const loaded = loadScopeFile(config.scope.scopeFile)
    if (loaded.length > 0) scopeTargets = [...scopeTargets, ...loaded]
  }
  scopeMonitor.configure({
    warnOnViolation: config.scope.warnOnViolation !== false,
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
  setVpnAdapters(config.network.vpnAdapters)

  configureTerminal({ engagementId, operatorId, maxCastBytes: config.terminal?.maxCastBytes })

  ipMonitor.start()
  startLinkMonitor()
  configureOpsecMonitor((delta, current) => {
    if (!currentEngagementId || !currentOperatorId) return
    try {
      const ev = insertEvent('system', {
        subtype: 'opsec_state_changed',
        changed: delta,
        current: { vpnInterfaces: current.vpnInterfaces, primaryMac: current.primaryMac, hostname: current.hostname, dnsServers: current.dnsServers },
        description: describeOpsecDelta(delta)
      }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
      if (ev) eventBus.publish(ev)
    } catch { /* additive */ }
  })
  startOpsecMonitor()
  configureClipboardMonitor({
    enabled: config.clipboard?.enabled ?? false,
    pollMs: config.clipboard?.pollMs ?? 1500,
    storePreview: config.clipboard?.storePreview ?? false,
    engagementId, operatorId, lootDetector
  })
  startClipboardMonitor()

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
    // The overlay joins all Spaces / floats over fullscreen, which flips the app
    // to an accessory on macOS and drops the Dock icon. Re-apply the operator's
    // Dock preference whenever the overlay appears so it isn't silently changed.
    if (process.platform === 'darwin') {
      overlayWindow.on('show', applyDock)
      applyDock()
      setTimeout(applyDock, 250)
    }
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
  stopClipboardMonitor()
  stopCdpMonitor()
  stopOpsecMonitor()
  closeDB()
  activeProject = null
  currentEngagementId = null
  currentOperatorId = null
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

  // Guarantee a Dock presence on macOS. A CLI-launched dev build (electron-vite)
  // registers as an accessory (UIElement) and gets no Dock icon; force 'regular'
  // so RedLog always shows in the Dock, matching the packaged app.
  if (process.platform === 'darwin') app.dock?.show()

  // Allow the renderer's opt-in geolocation request (Settings ▸ 網路 ▸ show Wi-Fi
  // name). Granting macOS Location Services un-redacts the SSID for `ipconfig`.
  // Nothing else is permitted.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'geolocation')
  })

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
  ipcMain.handle('project:active', () => activeProject
    ? { id: activeProject.id, name: activeProject.name, createdAt: activeProject.createdAt }
    : null)

  // --- IP ---
  ipcMain.handle('ip:getStatus', () => ipMonitor.status)
  ipcMain.handle('config:get', () => {
    if (!activeProject) return null
    return loadConfig(getProjectPath(activeProject))
  })
  ipcMain.handle('config:save', (_e, newConfig: RedLogConfig) => {
    if (!activeProject) return false
    const projectDir = getProjectPath(activeProject)
    const oldConfig = loadConfig(projectDir)
    saveConfig(projectDir, newConfig)
    currentEngagementId = newConfig.engagement.id
    currentOperatorId = newConfig.operator.id
    // Audit trail — log security-relevant setting changes so a reviewer can see
    // when scope loosened or the IP blacklist changed. Only diffs the fields
    // that affect enforcement or attribution; cosmetic changes stay silent.
    logConfigDiff(oldConfig, newConfig)
    keepDockIcon = newConfig.overlay?.showInDock !== false
    applyDock()
    ipMonitor.configure({
      whitelist: newConfig.network.whitelist,
      blacklist: newConfig.network.blacklist,
      ipMode: newConfig.network.ipMode,
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
      warnOnViolation: newConfig.scope.warnOnViolation !== false,
      targets,
      excludeTargets: newConfig.scope.excludeTargets
    })
    screenshotAgent.configure({ quality: newConfig.screenshot.quality })
    configureTerminal({ engagementId: newConfig.engagement.id, operatorId: newConfig.operator.id, maxCastBytes: newConfig.terminal?.maxCastBytes })
    configureClipboardMonitor({
      enabled: newConfig.clipboard?.enabled ?? false,
      pollMs: newConfig.clipboard?.pollMs ?? 1500,
      storePreview: newConfig.clipboard?.storePreview ?? false,
      engagementId: newConfig.engagement.id, operatorId: newConfig.operator.id, lootDetector
    })
    if (newConfig.redaction) configureRedaction(newConfig.redaction)
    if (newConfig.deconfliction) configureDeconfliction(newConfig.deconfliction)
    setVpnAdapters(newConfig.network.vpnAdapters)
    // The HUD reads its config once at mount — push overlay settings so toggling
    // "show Mark button" takes effect live instead of only after a restart.
    send(overlayWindow, 'overlay:showMark', newConfig.overlay?.showMarkButton !== false)
    send(overlayWindow, 'overlay:flashExposed', newConfig.overlay?.flashOnExposed !== false)
    send(overlayWindow, 'overlay:scale', newConfig.overlay?.scale ?? 1.0)
    send(overlayWindow, 'overlay:emphasizeIp', newConfig.overlay?.emphasizeExternalIp === true)
    return true
  })
  // The renderer measures its own content and reports the exact height it needs
  // (see OverlayApp) — no more guessing, so the panel never clips or leaves a
  // big empty gap. Clamp to sane bounds.
  ipcMain.on('overlay:autosize', (_e, height: number, width?: number) => {
    const h = Math.max(46, Math.min(560, Math.round(Number(height) || 46)))
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      const cur = overlayWindow.getBounds()
      // Width scales with content (larger HUD scale + emphasize IP need more
      // horizontal room). Clamp to a sane range and keep the HUD on-screen —
      // if growing wider would push it off the right edge, slide it back.
      const w = width != null
        ? Math.max(380, Math.min(720, Math.round(Number(width))))
        : cur.width
      let x = cur.x
      try {
        const disp = screen.getDisplayNearestPoint({ x: cur.x, y: cur.y }).workArea
        if (x + w > disp.x + disp.width) x = Math.max(disp.x, disp.x + disp.width - w)
      } catch { /* no display info — leave x alone */ }
      overlayWindow.setBounds({ x, y: cur.y, width: w, height: h })
      if (process.platform === 'win32') {
        overlayWindow.setOpacity(0.99)
        setImmediate(() => { if (!overlayWindow!.isDestroyed()) overlayWindow!.setOpacity(1) })
      }
    }
  })
  // setExpanded only toggles state now; the height comes from autosize.
  ipcMain.on('overlay:setExpanded', () => { /* height handled by overlay:autosize */ })
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
  // Four-layer redaction, layer 3 — reveal action logs a chained event so
  // the audit trail shows raw secret bytes were viewed, by whom, when.
  ipcMain.handle('events:logSecretRevealed', (_e, sourceEventId: string, fields: string[]) => {
    if (!currentEngagementId || !currentOperatorId) return { ok: false, error: 'no active project' }
    try {
      const ev = insertEvent('system', {
        subtype: 'secret_revealed',
        source_event: sourceEventId,
        fields: Array.isArray(fields) ? fields : []
      }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
      if (ev) eventBus.publish(ev)
      return { ok: true, id: ev?.id }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  eventBus.on('event', (event) => {
    send(mainWindow, 'events:new', event)
    notifyDeconfliction(event)
    // keep the overlay + dashboard pivot views live — on new pivots, and on the
    // command_end that closes a foreground tunnel so it drops from the HUD at once.
    const d = (event.data ?? {}) as Record<string, unknown>
    if (event.agentType === 'pivot' || (event.agentType === 'shell' && d.subtype === 'command_end')) {
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
  // Delete only the underlying JPEG. The screenshot EVENT stays in the DB —
  // rewriting it would break the hash chain (which is the whole point of the
  // chain). Emits a system.screenshot_deleted event so the audit trail names
  // when a file was purged, by whom, and its sha256 for later verification.
  ipcMain.handle('screenshot:deleteFile', (_e, eventId: string, filePath: string) => {
    try {
      const screenshotDir = path.join(getProjectDir(), 'screenshots')
      const resolved = path.resolve(filePath)
      if (!resolved.startsWith(screenshotDir)) return { ok: false, error: 'path outside project' }
      let sha256: string | null = null
      try { sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') } catch { /* file may already be gone */ }
      fs.unlinkSync(resolved)
      if (currentEngagementId && currentOperatorId) {
        const ev = insertEvent('system', {
          subtype: 'screenshot_deleted',
          source_event: eventId,
          path: path.basename(resolved),
          sha256_pre_delete: sha256
        }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
        if (ev) eventBus.publish(ev)
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
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
      // Start polling the browser for URL changes so every navigation lands in
      // the timeline as an http_navigation event. Silent no-op once the browser
      // exits — the poll fails, no event fires.
      configureCdpMonitor({
        engagementId: cfg.engagement.id,
        operatorId: cfg.operator.id,
        enabled: true
      })
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
  ipcMain.handle('browser:stop', () => { stopCdpMonitor(); return { stopped: stopBrowser() } })

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
  // Per-view slice exports — audit finding #80. Same target directory + naming
  // as the full export so the operator has one place to look. Each returns a
  // path or null (no active project). Callers open the containing dir via
  // shell.openPath after a successful save.
  const sliceExport = (name: string, payload: unknown): string | null => {
    if (!activeProject) return null
    const projectDir = getProjectPath(activeProject)
    const outDir = path.join(projectDir, 'exports')
    fs.mkdirSync(outDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = path.join(outDir, `redlog-${name}-${ts}.json`)
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2))
    return filePath
  }
  ipcMain.handle('data:exportMarks', () => sliceExport('marks', listQuickMarks()))
  ipcMain.handle('data:exportLoot', () => sliceExport('loot', queryEvents({ agentType: 'loot', limit: 10000 })))
  ipcMain.handle('data:exportViolations', () => sliceExport('scope-violations', queryEvents({ agentType: 'system', limit: 10000 }).filter((e) => e.data?.subtype === 'scope_violation')))

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
  // Open the user plugin dir in Finder/Explorer so operators can drop new
  // plugin folders in and reload without hunting for the path.
  ipcMain.handle('plugins:openFolder', async () => {
    const dir = path.join(homedir(), '.redlog', 'plugins')
    try { await require('fs').promises.mkdir(dir, { recursive: true }) } catch { /* ignore */ }
    shell.openPath(dir)
    return dir
  })
  ipcMain.handle('plugins:setEnabled', (_e, id: string, enabled: boolean) => { setPluginEnabled(id, enabled); invalidateHooksCache(); return pluginView() })
  ipcMain.handle('plugins:grant', (_e, id: string) => {
    const opId = activeProject ? loadConfig(getProjectPath(activeProject)).operator.id : 'unknown'
    const r = grantPluginTrust(id, opId); return { ...r, plugins: pluginView() }
  })
  ipcMain.handle('plugins:revoke', (_e, id: string) => { revokePluginTrust(id); return pluginView() })

  // --- Recording ---
  ipcMain.handle('recording:get', () => !eventBus.paused)
  ipcMain.handle('recording:toggle', () => toggleRecording())
  eventBus.on('recording', (recording: boolean) => {
    send(mainWindow, 'recording:changed', recording)
    send(overlayWindow, 'recording:changed', recording)
    if (tray) setTrayRecording(tray, recording)
    // Log the toggle so a reviewer can explain gaps in the timeline — "no events
    // for 20 min" reads very differently as "recording was paused" vs "idle".
    // Bypass the paused gate for this one write: pause events must always land.
    if (currentEngagementId && currentOperatorId) {
      try {
        const ev = insertEvent('system', {
          subtype: recording ? 'recording_resumed' : 'recording_paused',
          description: recording ? 'Recording resumed' : 'Recording paused'
        }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
        if (ev) eventBus.publish(ev, { bypassPause: true })
      } catch { /* additive */ }
    }
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

  // --- Updates ---
  ipcMain.handle('app:checkForUpdates', () => checkForUpdates({ manual: true }))
  // Renderer needs a way to open a URL in the operator's real browser (marks
  // page, plugin homepage, etc.). Only http/https allowed — Electron's
  // openExternal can dispatch file:/// and other schemes with unbounded side
  // effects, and untrusted plugin content might reach this handler.
  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'scheme not allowed' }
      await shell.openExternal(url)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  // Silent check shortly after launch (packaged builds only).
  setTimeout(() => { checkForUpdates().catch(() => {}) }, 5000)

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
