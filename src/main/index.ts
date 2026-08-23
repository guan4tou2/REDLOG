import { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut, dialog, screen, session, shell, protocol } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
import path from 'path'
import { homedir } from 'os'
import { createMainWindow, createOverlayWindow } from './windows'
import { loadOverlayPosition, saveOverlayPosition } from './services/overlay-position'
import { createTray, setTrayRecording } from './tray'
import { AlertRuntime, type IPStatusShape } from './services/alert-runtime'
import yaml from 'js-yaml'
import { loadConfig, saveConfig, loadScopeFile, RedLogConfig } from '../core/config'
import { initDB, closeDB, getProjectDir } from '../core/db/index'
import { insertEvent, queryEvents, queryEventById, queryByFlowId, getEventCount, getLatestLoggedTs, searchEvents, queryScopeFilteredEvents, type RedLogEvent } from '../core/db/events'
import {
  createQuickMark, updateQuickMark, getQuickMark, listQuickMarks, deleteQuickMark
} from '../core/db/findings'
import { getActiveBrowserTab, setCdpPort, configureCdpMonitor, stopCdpMonitor } from './services/cdp-connector'
import { QUICK_MARK_ACCELERATOR, HUD_PASSTHROUGH_ACCELERATOR } from '../core/shortcuts'
import fs from 'fs'
import { eventBus } from '../core/event-bus'
import { ScreenshotAgent } from './services/screenshot-agent'
import { LootDetector } from '../core/loot-detector'
import { getChainLength } from '../core/evidence-chain'
import { anchorNow, listAnchors, startAnchorLoop, stopAnchorLoop, verifyLatestAnchor, verifyChainFullAsync, upgradeAnchor, upgradeAllPending, verifyRandomSample } from '../core/chain-anchor'
import { startNtpLoop, stopNtpLoop, getNtpOffsetMs, getLastNtpQuery } from '../core/clock'
import { configureRedaction } from '../core/redaction'
import { exportBundle } from '../core/bundle-export'
import { sweepRetention, sweepLoggedTier, sweepBodyStore } from '../core/retention'
import { readBody as readHttpBody, resetBodiesDirCache, type BodyRef } from '../core/http-body-store'
import { exportHar } from '../core/har-export'
import {
  listProjects, createProject, openProject, deleteProject, renameProject,
  getProjectDir as getProjectPath, ProjectMeta
} from '../core/project-manager'
import { startApiServer, stopApiServer, configureApi, getApiToken, setAppVersion, getApiPort, setCastProbe, onApiProjectOpen, onApiProjectClose } from '../core/api-server'
import {
  listOperators
} from '../core/db/operators'
import {
  spawnTerminal, writeTerminal, resizeTerminal, killTerminal,
  listTerminals, killAllTerminals, setTerminalWindow, configureTerminal, recoverOrphanSessions,
  getCastPosition
} from './terminal-manager'
import { detectHooks, installHook, uninstallHook, autoUpgradeInstalledHooks } from '../core/hooks-manager'
import { listWslDistros, getNetworkMode, installHook as wslInstallHook, uninstallHook as wslUninstallHook, runDiagnostics as wslRunDiagnostics } from '../core/wsl-manager'
import { configureClipboardMonitor, startClipboardMonitor, stopClipboardMonitor } from './clipboard-monitor'
import { configureFileWatcher, stopFileWatcher } from './services/file-watcher'
import { configureProcessMonitor, stopProcessMonitor } from './services/process-monitor'
import { configureConnectionMonitor, stopConnectionMonitor } from './services/connection-monitor'
import { startProxyBypassDetector, stopProxyBypassDetector } from './services/proxy-bypass-detector'
import { configureAgentTailer, stopAgentTailer } from './services/agent-transcript-tailer'
import { configureOpsecMonitor, startOpsecMonitor, stopOpsecMonitor, setVpnAdapters, OpsecStateDelta } from './services/opsec-state'
import { initPlugins, reloadPlugins, listPlugins, listEventTypes, setPluginEnabled, grantPluginTrust, revokePluginTrust, setPluginHost } from '../core/plugins'
import { createPluginHost } from '../core/plugins/host'
import { setTailerContributionSink, type TailerLike } from '../core/plugins/tailer-registry'
import { registerAdapter as registerTailerAdapter, unregisterAdapter as unregisterTailerAdapter, registerSessionId, getRegisteredSessions, type TailerAdapter } from './services/tailer-host'
import { getCaptureHealth, invalidateHooksCache, noteSampleBroken, noteSampleOk, clearSampleBroken, configureCaptureHealth, noteDbError } from '../core/capture-health'
import { launchBrowser, stopBrowser, isBrowserRunning, detectBrowser, DEFAULT_BROWSER } from './services/browser-launcher'
import { detectLink } from './services/network-info'
import { checkForUpdates } from './services/updater'
import { isInsideDir } from '../core/paths'
import { closeCastIndex } from '../core/cast-index'
import { registerContextMenuIpc } from './context-menu'

// macOS routes ⌘C/⌘V/⌘Q through the application menu, so the default menu has
// to stay there. Windows and Linux don't — and RedLog draws its own title bar
// (titleBarStyle 'hidden'), so Electron's default File/Edit/View menu bar would
// sit inside the client area under it. Dropping it also skips building that
// menu at startup (Electron performance checklist item 8).
if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

// Windows text rendering: DirectComposition improves font clarity on low-DPI
// screens; DirectWrite uses the native font rasterizer for crisper CJK glyphs.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-features', 'DirectComposition,DirectWriteAntiAliasing')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

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
// v0.6.89 P1-A: read-path chain sampling. Runs periodically while a project
// is open to catch chain tampering silently — the on-demand verify button is
// too easy to skip. Cleared in stopProject so a project switch stops the loop.
let chainSampleTimer: ReturnType<typeof setInterval> | null = null
/** v0.13.0: periodic logged-tier retention sweep. See DESIGN-logged-tier-
 *  retention.md §5.1 — 24h default cadence. `stopProject` clears on
 *  project close so the timer doesn't fire against a closed DB. */
let loggedTierTimer: ReturnType<typeof setInterval> | null = null
let spoolDrainTimer: ReturnType<typeof setInterval> | null = null

// While `overlayPassThrough` is on, mouse tracking is disabled entirely —
// the HUD stays ignore-mouse regardless of cursor position. Users who want
// the HUD to never steal a stray click (e.g. it's sitting over Burp) enable
// this in Settings ▸ HUD; the opacity drops so it's clearly ghost-mode.
let overlayPassThrough = false
let overlayPassThroughOpacity = 0.4
/** Set while the external IP is exposed. §8's single sanctioned override of
 *  the operator's own HUD preferences: pass-through off, fully opaque. */
let overlayIpExposed = false

/** §8: 0.85 at rest so the HUD sits over a terminal without hiding it; 1.0
 *  once the cursor is on it, which is also why click-through defaults to off —
 *  the hover response is the affordance that says the thing is interactive. */
const OVERLAY_REST_OPACITY = 0.85

function overlayOpacity(): number {
  // An exposed IP overrides the operator's preference — the one case §8 allows
  // that — so it is never the thing that faded into a screenshot.
  if (overlayIpExposed) return 1
  return overlayMouseInside ? 1 : OVERLAY_REST_OPACITY
}

function applyOverlayOpacity(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  overlayWindow.setOpacity(overlayOpacity())
}

function applyOverlayPassThrough(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  applyOverlayOpacity()
  if (overlayPassThrough) {
    stopOverlayMouseTracking()
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    send(overlayWindow, 'overlay:interactive', false)
    overlayMouseInside = false
  } else {
    startOverlayMouseTracking()
  }
  send(overlayWindow, 'overlay:passThrough', overlayPassThrough, overlayPassThroughOpacity)
}

function startOverlayMouseTracking(): void {
  if (overlayPassThrough) return
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
      applyOverlayOpacity()
    } else if (!inside && overlayMouseInside) {
      overlayMouseInside = false
      overlayWindow.setIgnoreMouseEvents(true, { forward: true })
      overlayWindow.webContents.send('overlay:interactive', false)
      applyOverlayOpacity()
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
  if (eventBus.paused) eventBus.resume('ui')
  else eventBus.pause('ui')
  const recording = !eventBus.paused
  send(mainWindow, 'recording:changed', recording)
  send(overlayWindow, 'recording:changed', recording)
  return recording
}

// Opens the marker dialog in the main window — shared by the global shortcut,
// the tray menu, and the HUD's "detailed" button. Steals focus by design: the
// operator is about to type a title and notes.
function triggerQuickMark(): void {
  send(mainWindow, 'shortcut:marker')
  mainWindow?.show()
  mainWindow?.focus()
}

// v0.9.7: the HUD's instant mark. Drops a timestamped marker straight into the
// chain without raising the main window — the whole point of a heads-up
// display is that it does not pull the operator out of what they are doing.
// The detailed path above still exists for when a title and notes are worth
// stopping for; this one is for "something just happened, timestamp it".
function triggerInstantMark(): { ok: boolean; id?: string } {
  if (!activeProject || !currentEngagementId || !currentOperatorId) return { ok: false }
  try {
    const at = new Date()
    const event = insertEvent('marker', {
      title: `HUD mark ${at.toLocaleTimeString()}`,
      notes: '',
      severity: 'info',
      category: 'custom',
      // Distinguishes an un-annotated instant mark from one the operator
      // filled in, so a reviewer knows a bare title is intentional.
      source: 'hud-instant'
    }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
    if (event) eventBus.publish(event)
    return { ok: !!event, id: event?.id }
  } catch (e) {
    noteDbError('hud-instant-mark', e)
    return { ok: false }
  }
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

// v0.12.0: single alert runtime replaces the paired IPMonitor + ScopeMonitor.
// Constructed with placeholder ids; real engagement/operator ids land on the
// first `openProjectHandler` call via `alertRuntime.configure(...)`.
const alertRuntime = new AlertRuntime({ engagementId: '', operatorId: '' })
const screenshotAgent = new ScreenshotAgent()
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
  const refresh = (): void => {
    detectLink()
      .then((l) => {
        currentLink = l
        // Push the fresh link into the IP producer so the next IPChangeSignal
        // carries it — IPPolicy's `lanSafety` verdict pathway (ea G-A4)
        // reads from the signal's link.
        alertRuntime.setLink(l)
      })
      .catch(() => {})
  }
  refresh()
  if (linkTimer) clearInterval(linkTimer)
  linkTimer = setInterval(refresh, 20_000)
}

// Broadcast the composed IPStatusShape to renderer + overlay on every producer
// tick. The audit event for a verdict change is written by the ChainEmitter
// surface — the old `system.ip_transition` write here was duplicative and
// caused two rows per real change, so it's gone. `ip:status` stays as an IPC
// name for compat with existing preload code.
function broadcastIPStatus(status: IPStatusShape): void {
  const s = { ...status, link: currentLink }
  send(mainWindow, 'ip:status', s)
  send(overlayWindow, 'ip:status', s)

  // §8: an exposed IP is the one condition allowed to override the operator's
  // own HUD preferences. Pass-through comes off and the window goes fully
  // opaque, because the failure being prevented is an operator working through
  // a HUD they had ghosted and never seeing that their real address is out.
  const exposed = status.ipSafety === 'exposed'
  if (exposed !== overlayIpExposed) {
    overlayIpExposed = exposed
    if (exposed && overlayPassThrough) {
      overlayPassThrough = false
      applyOverlayPassThrough()
    } else {
      applyOverlayOpacity()
    }
  }
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
  check('clipboard.enabled', oldCfg.clipboard?.enabled, newCfg.clipboard?.enabled)
  check('network.checkInterval', oldCfg.network?.checkInterval, newCfg.network?.checkInterval)
  check('network.ipMode', oldCfg.network?.ipMode, newCfg.network?.ipMode)
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
  if (activeProject) stopProject()
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

  // Bring the recording index up to date in the background. Idempotent and
  // cheap when nothing changed — it hashes each cast and skips matches — so
  // running it on every open is what keeps a project that was recorded by an
  // older build, restored from a backup, or written to while RedLog was shut
  // searchable without anyone having to know to ask.
  //
  // Not awaited: a first index of an engagement's worth of recordings takes
  // real time, and holding project-open on it would trade a visible stall for
  // an invisible one. The UI reads `casts:status` and says how much is still
  // pending, which is the honest version of the same information.
  void import('../core/cast-index')
    .then((m) => m.backfillCastIndex(projectDir))
    .catch(() => { /* index is rebuildable; never block opening a project */ })

  screenshotAgent.configure({
    engagementId,
    operatorId,
    quality: config.screenshot.quality,
    intervalSec: config.screenshot.intervalSec ?? 0
  })

  let scopeTargets = config.scope.targets
  if (config.scope.scopeFile) {
    const loaded = loadScopeFile(config.scope.scopeFile)
    if (loaded.length > 0) scopeTargets = [...scopeTargets, ...loaded]
  }
  // v0.12.0: one configure call for the whole alert subsystem. Drops correlation/
  // burst history on every project open (resetOnProjectSwitch) so a stale
  // Combined verdict from the previous engagement can't fire when the new
  // one's first IP tick lands.
  alertRuntime.resetOnProjectSwitch()
  alertRuntime.configure(config, { engagementId, operatorId }, scopeTargets)
  lootDetector.configure({ engagementId, operatorId })
  configureCaptureHealth(config as unknown as Record<string, unknown>)
  configureRedaction(config.redaction)
  // 🔴 host: runs trusted plugin code in an isolated utility process, serving a
  // capability-scoped API. Wired before initPlugins so trusted plugins start.
  setPluginHost(createPluginHost({
    // v0.6.96 Bug-1: was passing `type`/`target` — but queryEvents reads
    // `agentType`/`targetId`, so the filters were silently dropped and plugins
    // got a random 50-row window unrelated to their query. Now the shim
    // renames + preserves the plugin API's field names.
    queryEvents: (a) => queryEvents({
      limit: Math.min(Number(a.limit) || 50, 500),
      agentType: a.type as string | undefined,
      targetId: a.target as string | undefined
    }),
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
  // v0.8.2: wire the `tailers` plugin contribution to the tailer host so
  // bundled plugins can register `TailerAdapter`s via plugin.json instead
  // of hard-coded main-init calls. Duck-typed on the core side to avoid
  // pulling main → services into core; the cast here is safe because the
  // contributor loader already validates `adapter.agentKind: string`.
  {
    const kindByPlugin = new Map<string, string>()
    setTailerContributionSink(
      (pluginId: string, adapter: TailerLike) => {
        kindByPlugin.set(pluginId, adapter.agentKind)
        registerTailerAdapter(adapter as unknown as TailerAdapter)
      },
      (pluginId: string) => {
        const kind = kindByPlugin.get(pluginId)
        if (kind) {
          unregisterTailerAdapter(kind)
          kindByPlugin.delete(pluginId)
        }
      }
    )
  }
  // Load plugins after core config so their 🟢 contributions (loot/redaction/
  // target/event-type/capture) layer on top. 🔴 code plugins only start if the
  // trust gate already passed.
  try {
    const psum = initPlugins()
    if (psum.total > 0) console.log(`[plugins] ${psum.active} active, ${psum.needsConsent} need consent, ${psum.errors} errors`)
  } catch (e) { console.error('[plugins] init failed:', e) }
  setVpnAdapters(config.network.vpnAdapters)

  configureTerminal({ engagementId, operatorId, maxCastBytes: config.terminal?.maxCastBytes })
  // v0.9.6 (T2): core/ can't import main/, so hand the live cast position in.
  setCastProbe(getCastPosition)

  // v0.6.87 B1 + B2: retention sweep for .cast + screenshot files.
  // Both default to 0 (keep forever) so existing installs see no behaviour
  // change. Setting `terminal.castKeepDays` or `screenshots.keepDays` to a
  // positive integer causes the sweep to run on every project open and to
  // append audit events per deletion.
  try {
    // v0.9.4 P0-4: statically imported. This used to be a runtime
    // `require('../core/retention')`, which rollup cannot see through — the
    // module was never bundled and the literal require survived into
    // out/main/index.js, where it resolved against a non-existent out/core/.
    // Every packaged build threw MODULE_NOT_FOUND into the catch below, so
    // castKeepDays / screenshots.keepDays silently did nothing and the
    // cast_pruned / screenshot_pruned audit events were never written. Unit
    // tests missed it because they import core/retention directly.
    const swept = sweepRetention(config, { engagementId, operatorId })
    if (swept.cast > 0 || swept.screenshots > 0 || swept.httpBodies > 0) {
      console.log(`[retention] pruned ${swept.cast} .cast file(s) + ${swept.screenshots} screenshot(s) + ${swept.httpBodies} http body file(s)`)
    }
    // Size-pressure eviction of the body store, after the age sweep — whatever
    // aged out has already gone, so this only reaches live-but-cold bodies.
    const evicted = sweepBodyStore(config, { engagementId, operatorId })
    if (evicted.evicted > 0 || evicted.shortfallBytes > 0) {
      console.log(`[retention] evicted ${evicted.evicted} body file(s) under disk pressure` +
        (evicted.shortfallBytes > 0 ? ` (still ${evicted.shortfallBytes} bytes over budget; in-scope bodies kept)` : ''))
    }
    // v0.13.0: row-level logged-tier sweep (docs/DESIGN-logged-tier-retention.md).
    // Runs on project open AND periodically — see loggedTierTimer below.
    const loggedSwept = sweepLoggedTier(config.retention?.loggedTier, { engagementId, operatorId })
    if (loggedSwept.deleted > 0) {
      console.log(`[retention] pruned ${loggedSwept.deleted} logged-tier row(s), freed ~${(loggedSwept.bytesFreed / 1024 / 1024).toFixed(1)} MB`)
    }
    // Periodic timer — the design doc's §5.1 rationale: cast/screenshot
    // sweep runs only on project open because operators close/reopen
    // during a long engagement, but logged-tier can grow 20-40 GB DURING
    // a nine-hour engagement day. Every N hours we re-sweep in-process.
    const sweepIntervalHours = config.retention?.loggedTier?.sweepIntervalHours ?? 24
    if (sweepIntervalHours > 0) {
      if (loggedTierTimer) clearInterval(loggedTierTimer)
      loggedTierTimer = setInterval(() => {
        if (!currentEngagementId || !currentOperatorId) return
        try {
          const tick = sweepLoggedTier(config.retention?.loggedTier, {
            engagementId: currentEngagementId, operatorId: currentOperatorId
          })
          if (tick.deleted > 0) {
            console.log(`[retention] periodic sweep: ${tick.deleted} logged-tier row(s) pruned, freed ~${(tick.bytesFreed / 1024 / 1024).toFixed(1)} MB`)
          }
        } catch (e) { console.error('[retention] periodic sweep failed:', e) }
      }, sweepIntervalHours * 3600 * 1000)
    }
  } catch (e) { console.error('[retention] sweep failed:', e) }

  // Recover any terminal sessions from a prior app run whose session_end never
  // landed (crash / kill / disk full mid-write). Writes a synthetic session_end
  // tagged recovered=true so the audit chain gets its close signal and the
  // Timeline no longer shows a terminal that "never closed" (v0.6.86 P3).
  try {
    const n = recoverOrphanSessions()
    if (n > 0) console.log(`[terminal] recovered ${n} orphan session(s)`)
  } catch (e) { console.error('[terminal] orphan recovery failed:', e) }

  // v0.6.87 A2: replay shell-hook spool. Any commands run in an external shell
  // while RedLog was closed were spooled to ~/.redlog/pending/*.json — replay
  // them into the current chain now. Newest project owns the recovered rows.
  try {
    const spoolDir = path.join(homedir(), '.redlog', 'pending')
    if (fs.existsSync(spoolDir)) {
      const files = fs.readdirSync(spoolDir).filter((f) => f.endsWith('.json')).sort()
      let replayed = 0
      for (const f of files) {
        const full = path.join(spoolDir, f)
        try {
          const raw = fs.readFileSync(full, 'utf8')
          const payload = JSON.parse(raw)
          const agentType = String(payload?.agent_type || '')
          const data = payload?.data && typeof payload.data === 'object' ? payload.data : null
          if (agentType && data) {
            const ev = insertEvent(agentType, { ...data, recovered_from_spool: true }, { engagementId, operatorId })
            if (ev) { eventBus.publish(ev); replayed++ }
          }
          fs.unlinkSync(full)
        } catch (e) {
          // Malformed spool file — move it aside instead of deleting so we
          // can inspect later.
          try { fs.renameSync(full, full + '.bad') } catch { /* */ }
        }
      }
      if (replayed > 0) console.log(`[hook-spool] replayed ${replayed} spooled event(s)`)
    }
  } catch (e) { console.error('[hook-spool] replay failed:', e) }

  spoolDrainTimer = setInterval(() => {
    if (!currentEngagementId || !currentOperatorId) return
    try {
      const spoolPath = path.join(homedir(), '.redlog', 'pending')
      if (!fs.existsSync(spoolPath)) return
      const files = fs.readdirSync(spoolPath).filter((f) => f.endsWith('.json')).sort().slice(0, 200)
      if (files.length === 0) return
      let count = 0
      for (const f of files) {
        const full = path.join(spoolPath, f)
        try {
          const raw = fs.readFileSync(full, 'utf8')
          const payload = JSON.parse(raw)
          const at = String(payload?.agent_type || '')
          const d = payload?.data && typeof payload.data === 'object' ? payload.data : null
          if (at && d) {
            const ev = insertEvent(at, { ...d, recovered_from_spool: true }, { engagementId: currentEngagementId!, operatorId: currentOperatorId! })
            if (ev) { eventBus.publish(ev); count++ }
          }
          fs.unlinkSync(full)
        } catch { try { fs.renameSync(full, full + '.bad') } catch { /* */ } }
      }
      if (count > 0) console.log(`[hook-spool] drained ${count} spooled event(s)`)
    } catch { /* */ }
  }, 30_000)

  alertRuntime.start()
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

  // v0.6.92 W-project — file watcher + process monitor. Both opt-in; the
  // producers just no-op when disabled so the wiring is unconditional.
  configureFileWatcher({
    enabled: config.fileWatcher?.enabled ?? false,
    watchPaths: config.fileWatcher?.watchPaths ?? [],
    ignorePatterns: config.fileWatcher?.ignorePatterns ?? [],
    engagementId, operatorId
  })
  configureConnectionMonitor({
    enabled: config.connectionMonitor?.enabled ?? false,
    pollMs: config.connectionMonitor?.pollMs,
    engagementId,
    operatorId,
    selfPorts: [getApiPort()]
  })
  configureProcessMonitor({
    enabled: config.processMonitor?.enabled ?? false,
    pollMs: config.processMonitor?.pollMs,
    ignoreCommands: config.processMonitor?.ignoreCommands ?? [],
    engagementId, operatorId
  })
  startProxyBypassDetector({ engagementId, operatorId })
  // v0.7.2 A: Claude Code transcript tailer. Reads `~/.claude/projects/`
  // JSONL sessions, derives per-turn events (user_message / assistant_message
  // / tool_call / tool_result) plus a whole-file sha256 snapshot event
  // stream. Gate uses the same `excludedPaths` / `watchPaths` as the shell
  // hook so policy is consistent across the two ingest paths.
  {
    let excludedPaths: string[] = []
    let watchPaths: string[] = []
    try {
      const cfgPath = path.join(homedir(), '.redlog', 'hook-config.json')
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as { excludedPaths?: string[]; watchPaths?: string[] }
        excludedPaths = raw.excludedPaths ?? []
        watchPaths = raw.watchPaths ?? []
      }
    } catch (e) {
      // A missing or malformed file is expected — the operator may never have
      // opened Settings ▸ Integrations. Anything else gets logged: v0.9.4
      // P0-1 was a ReferenceError swallowed right here for several releases,
      // silently disabling every tailer exclusion while the shell hook (which
      // reads the same file itself) kept the feature looking alive. A gate
      // that fails open must not fail quietly.
      if (!(e instanceof SyntaxError)) {
        console.error('[tailer] hook-config.json unreadable; path exclusions disabled:', e)
      }
    }
    configureAgentTailer({
      enabled: config.agentTailer?.enabled ?? true,
      engagementId, operatorId,
      excludedPaths, watchPaths,
      emitThinking: config.agentTailer?.emitThinking ?? false,
      // v0.12.0: route agent tool_call events through the alert subsystem
      // so a Claude / Codex / OpenCode session hitting an out-of-scope host
      // registers a scope_violation the same way a shell command would.
      scopeDispatch: (input) => alertRuntime.dispatchTargetHit(input)
    })
  }

  configureApi({
    engagementId,
    operatorId,
    operatorName: config.operator.name,
    configLoader: {
      getConfig: () => loadConfig(projectDir),
      getTargets: () => loadConfig(projectDir).scope.targets
    },
    lootDetector: lootDetector,
    screenshotAgent: screenshotAgent,
    alertRuntime,
    sessionRegistry: {
      register: registerSessionId,
      list: getRegisteredSessions
    },
    watchPathManager: {
      addPath: (cwd: string): boolean => {
        const cfgPath = path.join(homedir(), '.redlog', 'hook-config.json')
        try {
          let raw: { excludedPaths?: string[]; watchPaths?: string[] } = { excludedPaths: [], watchPaths: [] }
          try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) } catch { /* new file */ }
          const current = (raw.watchPaths ?? []).map((s: string) => String(s).trim()).filter(Boolean)
          const norm = path.resolve(cwd)
          if (current.some((p: string) => path.resolve(p) === norm)) return false
          current.push(cwd)
          const clean = { excludedPaths: (raw.excludedPaths ?? []).map((s: string) => String(s).trim()).filter(Boolean), watchPaths: current }
          fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
          fs.writeFileSync(cfgPath, JSON.stringify(clean, null, 2) + '\n')
          configureAgentTailer({ excludedPaths: clean.excludedPaths, watchPaths: clean.watchPaths })
          return true
        } catch { return false }
      },
      removePath: (cwd: string): boolean => {
        const cfgPath = path.join(homedir(), '.redlog', 'hook-config.json')
        try {
          let raw: { excludedPaths?: string[]; watchPaths?: string[] } = { excludedPaths: [], watchPaths: [] }
          try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) } catch { return false }
          const norm = path.resolve(cwd)
          const filtered = (raw.watchPaths ?? []).filter((p: string) => path.resolve(p.trim()) !== norm)
          if (filtered.length === (raw.watchPaths ?? []).length) return false
          const clean = { excludedPaths: (raw.excludedPaths ?? []).map((s: string) => String(s).trim()).filter(Boolean), watchPaths: filtered }
          fs.writeFileSync(cfgPath, JSON.stringify(clean, null, 2) + '\n')
          configureAgentTailer({ excludedPaths: clean.excludedPaths, watchPaths: clean.watchPaths })
          return true
        } catch { return false }
      },
      listPaths: (): string[] => {
        const cfgPath = path.join(homedir(), '.redlog', 'hook-config.json')
        try {
          const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
          return (raw.watchPaths ?? []).map((s: string) => String(s).trim()).filter(Boolean)
        } catch { return [] }
      }
    }
  })
  onApiProjectOpen()

  // Silently repair any pre-v0.6.47 shell hook still sitting in ~/.redlog/.
  // If nothing needs upgrading this is a no-op. Emits a system event when
  // it does upgrade so operators see the change in the timeline instead of
  // having a file mutate under them without record.
  try {
    const { upgraded, failed } = autoUpgradeInstalledHooks()
    if (upgraded.length > 0 || failed.length > 0) {
      insertEvent('system', {
        subtype: 'hook_auto_upgrade',
        upgraded,
        failed,
        reason: 'pre-v0.6.47 $$$ pid bug'
      }, { engagementId, operatorId })
    }
  } catch { /* best effort — never block startup */ }

  insertEvent('system', { subtype: 'session_start' }, { engagementId, operatorId })

  startAnchorLoop()
  startNtpLoop()

  // v0.6.89 P1-A: read-path sampling verify. On open, take a big (100)
  // sample immediately so the operator sees an early signal if the chain
  // was tampered with while the app was closed. After that, take a small
  // (50) sample every 5 minutes for continuous silent detection.
  //
  // On a sample failure we (1) surface via capture-health (verdict → dark
  // for the TTL window) and (2) chain a `system.chain_sample_broken` event
  // so the audit trail records the detection itself. Cleared previous
  // broken state on a clean open so a fresh project doesn't inherit the
  // last one's dark verdict.
  clearSampleBroken()
  try {
    const first = verifyRandomSample(100)
    if (!first.ok) {
      // v0.7.6 H3: include the broken row's own timestamp so the Dashboard
      // can tell "6d old pre-tailer historical row" from "fresh regression."
      const brokenRow = first.brokenAtEventId ? queryEventById(first.brokenAtEventId) : null
      noteSampleBroken({
        eventId: first.brokenAtEventId || '',
        reason: first.brokenReason || 'unknown',
        eventTimestamp: brokenRow?.timestamp
      })
      try {
        const ev = insertEvent('system', {
          subtype: 'chain_sample_broken',
          eventId: first.brokenAtEventId,
          reason: first.brokenReason,
          sampled: first.sampled
        }, { engagementId, operatorId })
        if (ev) eventBus.publish(ev)
      } catch { /* noteSampleBroken already surfaces via capture-health */ }
    } else {
      noteSampleOk()
    }
  } catch (e) { console.error('[chain-sample] initial verify failed:', e) }

  if (chainSampleTimer) clearInterval(chainSampleTimer)
  chainSampleTimer = setInterval(() => {
    try {
      const result = verifyRandomSample(50)
      if (!result.ok) {
        const brokenRow = result.brokenAtEventId ? queryEventById(result.brokenAtEventId) : null
        noteSampleBroken({
          eventId: result.brokenAtEventId || '',
          reason: result.brokenReason || 'unknown',
          eventTimestamp: brokenRow?.timestamp
        })
        try {
          const ev = insertEvent('system', {
            subtype: 'chain_sample_broken',
            eventId: result.brokenAtEventId,
            reason: result.brokenReason,
            sampled: result.sampled
          }, { engagementId, operatorId })
          if (ev) eventBus.publish(ev)
        } catch { /* */ }
      } else {
        noteSampleOk()
      }
    } catch { /* transient sqlite errors already surface through DB error path */ }
  }, 5 * 60 * 1000)

  if (!overlayWindow) {
    overlayWindow = createOverlayWindow(loadOverlayPosition())
    // §8: remember where the operator put it, per display. `moved` fires
    // throughout a drag, so debounce to the end of it.
    let moveTimer: ReturnType<typeof setTimeout> | null = null
    overlayWindow.on('moved', () => {
      if (moveTimer) clearTimeout(moveTimer)
      moveTimer = setTimeout(() => { if (overlayWindow) saveOverlayPosition(overlayWindow) }, 400)
    })
    // The overlay joins all Spaces / floats over fullscreen, which flips the app
    // to an accessory on macOS and drops the Dock icon. Re-apply the operator's
    // Dock preference whenever the overlay appears so it isn't silently changed.
    if (process.platform === 'darwin') {
      overlayWindow.on('show', applyDock)
      applyDock()
      setTimeout(applyDock, 250)
    }
    overlayPassThrough = !!config.overlay?.passThrough
    overlayPassThroughOpacity = config.overlay?.passThroughOpacity ?? 0.4
    applyOverlayPassThrough()
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
  if (chainSampleTimer) { clearInterval(chainSampleTimer); chainSampleTimer = null }
  if (loggedTierTimer) { clearInterval(loggedTierTimer); loggedTierTimer = null }
  if (spoolDrainTimer) { clearInterval(spoolDrainTimer); spoolDrainTimer = null }
  onApiProjectClose()
  alertRuntime.stop()
  stopClipboardMonitor()
  stopFileWatcher()
  stopProcessMonitor()
  stopConnectionMonitor()
  stopProxyBypassDetector()
  stopAgentTailer()
  stopCdpMonitor()
  stopOpsecMonitor()
  screenshotAgent.stop()
  closeCastIndex()
  closeDB()
  resetBodiesDirCache()
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

// v0.6.97 B: `redlog-screenshot://` privileged scheme — MUST be registered
// BEFORE app.whenReady() or Chromium won't grant it URL-loading permissions
// (image src, fetch, etc). The `protocol.handle` implementation lives inside
// the ready block below where getProjectDir() is safe to call.
protocol.registerSchemesAsPrivileged([
  { scheme: 'redlog-screenshot', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  electronApp.setAppUserModelId('com.redlog')
  setAppVersion(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev')

  startApiServer(6660).catch((err) => console.error('[api] failed to start:', err))

  // v0.6.97 B: serve screenshots via a custom protocol instead of piping
  // 33%-inflated base64 data URIs through IPC. Renderer uses
  // `<img src="redlog-screenshot://<filename>">` and Chromium streams the
  // bytes directly from disk. Path guarded by `isInsideDir(<project>/screenshots)`
  // so a request for `redlog-screenshot://../../.ssh/id_ed25519` 404s.
  protocol.handle('redlog-screenshot', async (req) => {
    try {
      const url = new URL(req.url)
      // Only take the trailing path segment so `redlog-screenshot://local/foo.jpg`
      // and `redlog-screenshot://foo.jpg` both resolve to <projectDir>/screenshots/foo.jpg.
      // Callers pass basename only; the hostname/segment ordering depends on how
      // Chromium normalises the URL (differs between platforms).
      const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean)
      const basename = segments[segments.length - 1] || decodeURIComponent(url.hostname || '')
      if (!basename || basename.includes('..') || basename.includes('/') || basename.includes('\\')) {
        return new Response('', { status: 400 })
      }
      const screenshotDir = path.join(getProjectDir(), 'screenshots')
      const resolved = path.resolve(screenshotDir, basename)
      if (!isInsideDir(screenshotDir, resolved)) return new Response('', { status: 403 })
      // v0.6.100 F4: async read. With v0.6.98 A lazy-loading, 500 thumbs
      // burst-fire requests as ScreenshotsView scrolls — each 800KB-1.5MB
      // JPEG readFileSync blocked the main thread 5-15ms (same reason
      // v0.6.97 D moved screenshot-agent writes off main). libuv thread
      // pool handles the syscall.
      const buf = await fs.promises.readFile(resolved)
      return new Response(buf, { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    } catch { return new Response('', { status: 404 }) }
  })

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

  // Renderer-requested native menus (the terminal's right-click — xterm owns
  // its own selection, so Chromium's context-menu event sees nothing there).
  registerContextMenuIpc(ipcMain)

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
  ipcMain.handle('project:rename', (_e, id: string, name: string) => {
    const updated = renameProject(id, name)
    // Keep activeProject.name in sync if the renamed project is the current one
    // — main-window title bar reads this on subsequent renders.
    if (updated && activeProject?.id === id) activeProject = { ...activeProject, name: updated.name }
    return updated
  })
  ipcMain.handle('project:active', () => activeProject
    ? { id: activeProject.id, name: activeProject.name, createdAt: activeProject.createdAt }
    : null)
  ipcMain.handle('project:close', () => {
    if (activeProject) stopProject()
    return true
  })

  // --- IP ---
  ipcMain.handle('ip:getStatus', () => alertRuntime.ipStatus())
  ipcMain.handle('config:get', () => {
    if (!activeProject) return null
    return loadConfig(getProjectPath(activeProject))
  })

  // Hook-config lives in ~/.redlog/hook-config.json — outside the project so
  // it applies across every project (user's Claude Code hook is global).
  // The two gates are readable/writable through this IPC pair so the
  // Settings ▸ 整合 panel can maintain the watchPaths whitelist without
  // shelling out.
  const HOOK_CONFIG_PATH = path.join(homedir(), '.redlog', 'hook-config.json')
  ipcMain.handle('hookConfig:get', () => {
    try {
      const raw = fs.readFileSync(HOOK_CONFIG_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      return {
        excludedPaths: Array.isArray(parsed.excludedPaths) ? parsed.excludedPaths : [],
        watchPaths: Array.isArray(parsed.watchPaths) ? parsed.watchPaths : []
      }
    } catch { return { excludedPaths: [], watchPaths: [] } }
  })
  ipcMain.handle('hookConfig:save', (_e, cfg: { excludedPaths?: string[]; watchPaths?: string[] }) => {
    try {
      fs.mkdirSync(path.dirname(HOOK_CONFIG_PATH), { recursive: true })
      const clean: Record<string, string[]> = {
        excludedPaths: (cfg.excludedPaths ?? []).map((s) => String(s).trim()).filter(Boolean),
        watchPaths: (cfg.watchPaths ?? []).map((s) => String(s).trim()).filter(Boolean)
      }
      fs.writeFileSync(HOOK_CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n')
      // Live-reconfigure the tailer so the new gate takes effect immediately
      configureAgentTailer({ excludedPaths: clean.excludedPaths, watchPaths: clean.watchPaths })
      return true
    } catch { return false }
  })
  // Native folder picker for the Settings UI — text input is fine but a
  // real picker matches how operators actually pick engagement folders.
  ipcMain.handle('hookConfig:pickPath', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Pick a folder'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
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
    let targets = newConfig.scope.targets
    if (newConfig.scope.scopeFile) {
      const loaded = loadScopeFile(newConfig.scope.scopeFile)
      if (loaded.length > 0) targets = [...targets, ...loaded]
    }
    alertRuntime.configure(newConfig, {
      engagementId: newConfig.engagement.id,
      operatorId: newConfig.operator.id
    }, targets)
    screenshotAgent.configure({
      quality: newConfig.screenshot.quality,
      intervalSec: newConfig.screenshot.intervalSec ?? 0
    })
    // v0.9.7: refresh the snapshot capture-health reads its on/off switches
    // from, so toggling a source updates the card on the next poll instead of
    // at the next project open.
    configureCaptureHealth(newConfig as unknown as Record<string, unknown>)
    configureTerminal({ engagementId: newConfig.engagement.id, operatorId: newConfig.operator.id, maxCastBytes: newConfig.terminal?.maxCastBytes })
    configureClipboardMonitor({
      enabled: newConfig.clipboard?.enabled ?? false,
      pollMs: newConfig.clipboard?.pollMs ?? 1500,
      storePreview: newConfig.clipboard?.storePreview ?? false,
      engagementId: newConfig.engagement.id, operatorId: newConfig.operator.id, lootDetector
    })
    configureFileWatcher({
      enabled: newConfig.fileWatcher?.enabled ?? false,
      watchPaths: newConfig.fileWatcher?.watchPaths ?? [],
      ignorePatterns: newConfig.fileWatcher?.ignorePatterns ?? [],
      engagementId: newConfig.engagement.id, operatorId: newConfig.operator.id
    })
    configureConnectionMonitor({
      enabled: newConfig.connectionMonitor?.enabled ?? false,
      pollMs: newConfig.connectionMonitor?.pollMs,
      selfPorts: [getApiPort()]
    })
    configureProcessMonitor({
      enabled: newConfig.processMonitor?.enabled ?? false,
      pollMs: newConfig.processMonitor?.pollMs,
      ignoreCommands: newConfig.processMonitor?.ignoreCommands ?? [],
      engagementId: newConfig.engagement.id, operatorId: newConfig.operator.id
    })
    if (newConfig.redaction) configureRedaction(newConfig.redaction)
    setVpnAdapters(newConfig.network.vpnAdapters)
    // The HUD reads its config once at mount — push overlay settings so toggling
    // "show Mark button" takes effect live instead of only after a restart.
    send(overlayWindow, 'overlay:showMark', newConfig.overlay?.showMarkButton !== false)
    send(overlayWindow, 'overlay:flashExposed', newConfig.overlay?.flashOnExposed !== false)
    send(overlayWindow, 'overlay:scale', newConfig.overlay?.scale ?? 1.0)
    send(overlayWindow, 'overlay:emphasizeIp', newConfig.overlay?.emphasizeExternalIp === true)
    overlayPassThrough = !!newConfig.overlay?.passThrough
    overlayPassThroughOpacity = newConfig.overlay?.passThroughOpacity ?? 0.4
    applyOverlayPassThrough()
    return true
  })
  // The renderer measures its own content and reports the exact height it needs
  // (see OverlayApp) — no more guessing, so the panel never clips or leaves a
  // big empty gap. Clamp to sane bounds.
  ipcMain.on('overlay:autosize', (_e, height: number, width?: number) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const cur = overlayWindow.getBounds()
    let disp: Electron.Rectangle
    try { disp = screen.getDisplayNearestPoint({ x: cur.x, y: cur.y }).workArea }
    catch { disp = screen.getPrimaryDisplay().workArea }
    const maxH = disp.height - 20
    const h = Math.max(46, Math.min(maxH, Math.round(Number(height) || 46)))
    const w = width != null
      ? Math.max(380, Math.min(720, Math.round(Number(width))))
      : cur.width
    let x = cur.x
    let y = cur.y
    if (x + w > disp.x + disp.width) x = Math.max(disp.x, disp.x + disp.width - w)
    if (y + h > disp.y + disp.height) y = Math.max(disp.y, disp.y + disp.height - h)
    if (y < disp.y) y = disp.y
    overlayWindow.setBounds({ x, y, width: w, height: h })
    if (process.platform === 'win32') {
      overlayWindow.setOpacity(0.99)
      setImmediate(() => { if (!overlayWindow!.isDestroyed()) overlayWindow!.setOpacity(1) })
    }
  })
  // setExpanded only toggles state now; the height comes from autosize.
  ipcMain.on('overlay:setExpanded', () => { /* height handled by overlay:autosize */ })
  // Snap HUD to one of the four corners of the display it's currently on —
  // driven by the main window's ⌘⌥ arrow shortcuts (audit finding #53). The
  // renderer just sends the compass direction; we compute bounds here so we
  // can pick the right display without asking the renderer to guess.
  ipcMain.on('overlay:moveToCorner', (_e, corner: 'tl' | 'tr' | 'bl' | 'br') => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const b = overlayWindow.getBounds()
    try {
      const disp = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea
      const pad = 16
      const x = corner === 'tl' || corner === 'bl' ? disp.x + pad : disp.x + disp.width - b.width - pad
      const y = corner === 'tl' || corner === 'tr' ? disp.y + pad : disp.y + disp.height - b.height - pad
      overlayWindow.setBounds({ x, y, width: b.width, height: b.height })
      saveOverlayPosition(overlayWindow)
    } catch { /* no display — bail */ }
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
  // Per-tick push — fires every IP check so `lastCheck`/link updates reach the
  // UI even when the verdict doesn't flip. IPPolicy dedup ensures the CHAIN
  // only sees actual verdict changes; this listener is UI-only.
  alertRuntime.onIpTick(() => broadcastIPStatus(alertRuntime.ipStatus()))

  // --- Events ---
  ipcMain.handle('events:query', (_e, opts) => activeProject ? queryEvents(opts) : [])
  ipcMain.handle('events:getCount', (_e, tier?: import('../core/db/events').EventTierFilter) => activeProject ? getEventCount(tier ? { tier } : undefined) : 0)
  ipcMain.handle('events:getLatestLoggedTs', () => activeProject ? getLatestLoggedTs() : null)
  ipcMain.handle('events:search', (_e, query: string, limit?: number) => activeProject ? searchEvents(query, limit) : [])

  // Full-text search over terminal recordings (docs/DESIGN-core-and-capture.md
  // §2.4). Separate from events:search because the two answer different
  // questions and have different completeness: an event either exists or does
  // not, whereas a recording may be on disk and not yet indexed. `casts:status`
  // exists so the UI can say which of those it is, rather than returning zero
  // hits and letting the operator conclude the bytes are missing.
  ipcMain.handle('casts:search', async (_e, query: string, limit?: number) => {
    if (!activeProject) return []
    const { searchCasts } = await import('../core/cast-index')
    return searchCasts(query, limit)
  })
  ipcMain.handle('casts:status', async () => {
    if (!activeProject) return { total: 0, indexed: 0, pending: 0 }
    const { castIndexStatus } = await import('../core/cast-index')
    return castIndexStatus()
  })
  ipcMain.handle('casts:readRange', async (_e, castRel: string, off: number, len: number) => {
    if (!activeProject) return null
    // castRel comes from a search hit, but the hit came from a DB the renderer
    // can reach — so re-derive the path from the project root and refuse
    // anything that escapes it, the same guard the api-server applies to
    // castPath out of event data.
    const castsDir = path.join(getProjectPath(activeProject), 'casts')
    const full = path.resolve(castsDir, castRel)
    if (!isInsideDir(castsDir, full)) return null
    const { readCastRange } = await import('../core/cast-slice')
    return readCastRange(full, off, len)
  })
  ipcMain.handle('events:queryByFlowId', (_e, flowId: string) => activeProject ? queryByFlowId(flowId) : [])
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
  ipcMain.handle('httpBody:read', (_e, ref: BodyRef) => {
    if (!activeProject) return null
    return readHttpBody(ref)
  })

  ipcMain.handle('har:export', (_e, opts?: { since?: number; before?: number; targetId?: string; limit?: number }) => {
    if (!activeProject) return null
    return exportHar(opts)
  })

  // v0.6.95 P0-4c: batch buffer for coalesced IPC deliveries. Every event
  // still fires `events:new` per-event (overlay
  // pivot HUD subscribe to it), but the renderer's Timeline drains
  // `events:new-batch` on a single frame per burst. A 200 evt/s mitmproxy
  // scan collapses from 200 IPC hops to ~12 (60 fps) with one setEvents
  // call per hop instead of one per event.
  let batchBuffer: RedLogEvent[] = []
  let batchScheduled = false
  const flushBatch = (): void => {
    batchScheduled = false
    if (batchBuffer.length === 0) return
    const drained = batchBuffer
    batchBuffer = []
    send(mainWindow, 'events:new-batch', drained)
  }
  eventBus.on('event', (event) => {
    // Per-event channel stays — the overlay HUD and any external subscriber
    // that doesn't want to buffer keeps its existing shape.
    send(mainWindow, 'events:new', event)
    // Batch channel — Timeline listens here and rebuilds once per frame.
    batchBuffer.push(event)
    if (!batchScheduled) {
      batchScheduled = true
      setImmediate(flushBatch)
    }
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
  ipcMain.handle('screenshot:capture', (_e, causeEventId?: string) => screenshotAgent.captureNow('manual', causeEventId))
  // v0.6.98 B: `screenshot:read` handler removed. v0.6.97 B moved every
  // renderer read onto the `redlog-screenshot://` custom protocol, and this
  // IPC had no in-tree callers left. Dropping it shrinks the attack surface
  // — a compromised renderer with `filePath` control can no longer coax a
  // base64-encoded read of any file under `<projectDir>/screenshots/`.
  // Delete only the underlying JPEG. The screenshot EVENT stays in the DB —
  // rewriting it would break the hash chain (which is the whole point of the
  // chain). Emits a system.screenshot_deleted event so the audit trail names
  // when a file was purged, by whom, and its sha256 for later verification.
  ipcMain.handle('screenshot:deleteFile', (_e, eventId: string, filePath: string) => {
    try {
      const screenshotDir = path.join(getProjectDir(), 'screenshots')
      const resolved = path.resolve(filePath)
      if (!isInsideDir(screenshotDir, resolved)) return { ok: false, error: 'path outside project' }
      let sha256: string | null = null
      try { sha256 = require('crypto').createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') } catch { /* file may already be gone */ }
      fs.unlinkSync(resolved)
      if (currentEngagementId && currentOperatorId) {
        const ev = insertEvent('system', {
          subtype: 'screenshot_deleted',
          source_event: eventId,  // v0.6.88: legacy field name (kept for backward compat)
          _causes: [eventId],     // v0.6.89: canonical `_causes` for focus chain walks
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
  ipcMain.handle('scope:getViolations', () => alertRuntime.scopeViolations())
  ipcMain.handle('scope:getViolationCount', () => alertRuntime.scopeViolationCount())
  ipcMain.handle('scope:isConfigured', () => alertRuntime.scopeIsConfigured())

  // --- Evidence Chain ---
  ipcMain.handle('chain:length', () => activeProject ? getChainLength() : 0)
  ipcMain.handle('chain:anchors', () => activeProject ? listAnchors() : [])
  ipcMain.handle('chain:anchorNow', async () => activeProject ? await anchorNow() : null)
  ipcMain.handle('chain:verify', async (_e, opts?: { full?: boolean }) => {
    if (!activeProject) return { ok: false, anchor: null, currentHead: null }
    // v0.6.95 P0-4a: full verify now uses the async variant that yields to
    // the event loop every ASYNC_CHUNK_ROWS rows, so the renderer stays
    // responsive and IPC deliveries keep flowing during a 100k-row walk.
    return opts?.full ? await verifyChainFullAsync() : verifyLatestAnchor()
  })
  ipcMain.handle('chain:upgrade', async (_e, id?: string) => {
    if (!activeProject) return null
    if (id) return await upgradeAnchor(id)
    return await upgradeAllPending()
  })

  ipcMain.handle('clock:status', () => ({
    ntpOffsetMs: getNtpOffsetMs(),
    lastQueryAt: getLastNtpQuery(),
    hostWallMs: Date.now()
  }))

  // --- Loot ---
  ipcMain.handle('loot:getCount', () => lootDetector.getLootCount())

  // --- QuickMarks ---
  ipcMain.handle('quickmarks:list', () => activeProject ? listQuickMarks() : [])
  ipcMain.handle('quickmarks:get', (_e, id: string) => activeProject ? getQuickMark(id) : null)
  ipcMain.handle('quickmarks:create', async (_e, data: { title: string; url?: string; note?: string }) => {
    if (!activeProject) return null
    const browser = await getActiveBrowserTab()
    const context = {
      browserUrl: browser.url || undefined,
      browserTitle: browser.title || undefined,
      externalIP: alertRuntime.ipStatus().externalIP || undefined
    }
    return createQuickMark({
      title: data.title || browser.title || 'Untitled',
      url: data.url || browser.url || undefined,
      note: data.note,
      context
    })
  })
  ipcMain.handle('quickmarks:update', (_e, id: string, data) => activeProject ? updateQuickMark(id, data) : false)
  ipcMain.handle('quickmarks:delete', (_e, id: string) => activeProject ? deleteQuickMark(id) : false)

  // --- Saved Timeline views ---
  // A "view" is a named snapshot of Timeline UI state — zoom, time window,
  // hidden lanes, filter query. Stored per-project so operators reviewing an
  // engagement can jump back to "the credential-dump moment" or "the day-2
  // recon window" without redoing the zoom + filter dance every time.
  //
  // Modelled on the QuickMarks IPC pattern (small JSON payload, list/save/delete)
  // but kept as a flat JSON file rather than a SQLite table — cheap, easy to
  // hand-edit, and there's no query pattern beyond "list all".
  const viewsFile = (): string | null => {
    if (!activeProject) return null
    return path.join(getProjectPath(activeProject), 'views.json')
  }
  const readViews = (): Array<Record<string, unknown>> => {
    const p = viewsFile()
    if (!p || !fs.existsSync(p)) return []
    try { const arr = JSON.parse(fs.readFileSync(p, 'utf-8')); return Array.isArray(arr) ? arr : [] } catch { return [] }
  }
  const writeViews = (views: Array<Record<string, unknown>>): void => {
    const p = viewsFile()
    if (!p) return
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(views, null, 2) + '\n', 'utf-8')
  }
  ipcMain.handle('views:list', () => readViews())
  ipcMain.handle('views:save', (_e, data: { name: string; state: Record<string, unknown> }) => {
    const list = readViews()
    const id = `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const entry = {
      id,
      name: (data.name || 'Untitled').toString().slice(0, 120),
      createdAt: Date.now(),
      state: data.state ?? {}
    }
    list.unshift(entry)
    // Cap at 100 saved views per project — anything more is either forgotten
    // clutter or someone using this as a real database. The list UI would be
    // useless past that anyway.
    if (list.length > 100) list.length = 100
    writeViews(list)
    return entry
  })
  ipcMain.handle('views:delete', (_e, id: string) => {
    const list = readViews()
    const next = list.filter((v) => v.id !== id)
    if (next.length === list.length) return false
    writeViews(next)
    return true
  })

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
    if (!activeProject) return { ok: false, error: 'no-active-project' }
    try {
      const cfg = loadConfig(getProjectPath(activeProject))
      const bundle = exportBundle(cfg.engagement.id)
      return { ok: true, outDir: bundle.outDir, manifest: bundle.manifest }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) }
    }
  })
  // Renderer button "Reveal in Finder / Show in Explorer" wants shell access
  // without exposing the whole Electron shell module to preload. This handler
  // opens the containing directory of an exported bundle/file. Rejects any
  // path that isn't a string — belt+braces against renderer bugs.
  // Operator tokens are written to a file rather than handed to the operator
  // as text to copy (UIUX-STANDARD §10). Two reasons, and the second is the
  // one that matters: a token on the clipboard is a token in every clipboard
  // manager on the machine, and a token the operator pastes into a note is a
  // token in whatever that note gets backed up to. Writing it means there is
  // exactly one copy and the app knows where it is.
  //
  // `~/.redlog/tokens/` sits deliberately outside the project directory, so
  // no bundle export or evidence package can ever sweep it up —
  // those walk the project tree, and a credential is not evidence.

  ipcMain.handle('data:revealPath', async (_e, target: string) => {
    if (typeof target !== 'string' || !target) return false
    try {
      // If `target` is a file, open its parent directory; if it's a directory,
      // open it directly. shell.openPath returns an empty string on success.
      const stat = fs.existsSync(target) ? fs.statSync(target) : null
      const toOpen = stat && stat.isFile() ? path.dirname(target) : target
      const err = await shell.openPath(toOpen)
      return err === ''
    } catch {
      return false
    }
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
  ipcMain.handle('data:exportMarks', () => activeProject ? sliceExport('marks', listQuickMarks()) : null)
  ipcMain.handle('data:exportLoot', () => activeProject ? sliceExport('loot', queryEvents({ agentType: 'loot', limit: 10000 })) : null)
  ipcMain.handle('data:exportViolations', () => activeProject ? sliceExport('scope-violations', queryEvents({ agentType: 'system', limit: 10000 }).filter((e) => e.data?.subtype === 'scope_violation')) : null)
  // v0.6.87 C2: Timeline slice export. Renderer picks a time window (usually
  // the current visible viewport in Timeline) and gets a filtered JSON slice
  // that a bug-bounty writeup can attach as evidence for a specific attack
  // moment. The export includes the surrounding markers/screenshots for
  // context; the operator can trim in a text editor if too much lands.
  ipcMain.handle('data:exportTimelineSlice', (_e, opts: { from: number; to: number }) => {
    if (!activeProject) return null
    const from = Number(opts?.from) || 0
    const to = Number(opts?.to) || Date.now()
    if (to <= from) return null
    const all = queryEvents({ limit: 100000, since: from })
    const slice = all.filter((e) => e.timestamp >= from && e.timestamp <= to)
    return sliceExport(
      `timeline-${new Date(from).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`,
      { window: { fromMs: from, toMs: to }, events: slice }
    )
  })

  // --- Config Profile Export/Import ---
  ipcMain.handle('config:exportProfile', async () => {
    if (!activeProject) return null
    const projectDir = getProjectPath(activeProject)
    const config = loadConfig(projectDir)
    // v0.6.96 Ops-2: also carry saved Timeline views. Team hand-off used to
    // ship scope + operators but leave the current operator's per-project
    // views.json behind — the receiving teammate lost every zoom window +
    // filter combo the sender had bookmarked.
    let views: unknown[] = []
    try {
      const viewsPath = path.join(projectDir, 'views.json')
      if (fs.existsSync(viewsPath)) {
        const raw = JSON.parse(fs.readFileSync(viewsPath, 'utf-8'))
        if (Array.isArray(raw)) views = raw
      }
    } catch { /* views file missing / malformed — just ship an empty list */ }
    const profile = { version: 1, ...config, views }
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
      // v0.6.96 Ops-2: split saved views out of the config payload and merge
      // them into the local views.json. Prior teammate's views are preserved
      // (dedupe by id — imported views win on id collision).
      const incomingViews = Array.isArray(data.views) ? data.views as Array<{ id: string }> : []
      delete data.views
      if (incomingViews.length > 0 && activeProject) {
        try {
          const viewsPath = path.join(getProjectPath(activeProject), 'views.json')
          let existing: Array<{ id: string }> = []
          try {
            if (fs.existsSync(viewsPath)) {
              const raw = JSON.parse(fs.readFileSync(viewsPath, 'utf-8'))
              if (Array.isArray(raw)) existing = raw
            }
          } catch { /* start fresh */ }
          const byId = new Map(existing.map((v) => [v.id, v]))
          for (const v of incomingViews) if (v && v.id) byId.set(v.id, v)
          fs.writeFileSync(viewsPath, JSON.stringify(Array.from(byId.values()), null, 2))
        } catch { /* views merge is best-effort */ }
      }
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
  // Replay a command_end event by slicing its session's .cast file — see
  // api-server /api/terminal/replay for the logic; this IPC surface just
  // forwards to the same function so the UI doesn't need a token round-trip.
  ipcMain.handle('terminal:replay', async (_e, eventId: string) => {
    try {
      const { queryEvents } = await import('../core/db/events')
      const { readCastSlice } = await import('../core/cast-slice')
      const target = queryEventById(eventId)
      if (!target) return { ok: false, error: 'event not found' }
      const td = target.data as Record<string, unknown>
      const tid = td.terminalId as string | undefined
      if (target.agentType !== 'shell' || td.subtype !== 'command_end' || td.source !== 'builtin-terminal' || !tid) {
        return { ok: false, error: 'not a builtin-terminal command_end event' }
      }
      const sess = queryEvents({ agentType: 'shell', limit: 5000 })
        .filter((ev) => ev.data?.subtype === 'session_start' && ev.data.terminalId === tid && ev.timestamp <= target.timestamp)[0]
      const castPath = sess?.data?.castPath as string | undefined
      if (!castPath) return { ok: false, error: 'no cast file for this session' }
      const duration = Number(td.duration_sec ?? 0) * 1000
      const startMs = target.timestamp - Math.max(duration, 100)
      const slice = await readCastSlice(castPath, startMs, target.timestamp)
      if (!slice) return { ok: false, error: 'failed to read cast file' }
      return { ok: true, command: td.command, exitCode: td.exit_code, durationSec: td.duration_sec, text: slice.text, bytes: slice.bytes }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Session-level replay: given a session_start or session_end event, walk
  // the ENTIRE .cast file for that terminal. Used when the operator ssh'd
  // into a remote host and needs to see everything that scrolled by after
  // that — command_end alone only exposes the local `ssh` line.
  ipcMain.handle('terminal:replaySession', async (_e, eventId: string) => {
    try {
      const { queryEvents } = await import('../core/db/events')
      const { readCastSlice } = await import('../core/cast-slice')
      const target = queryEventById(eventId)
      if (!target) return { ok: false, error: 'event not found' }
      const td = target.data as Record<string, unknown>
      const tid = td.terminalId as string | undefined
      const subtype = td.subtype
      if (target.agentType !== 'shell' || (subtype !== 'session_start' && subtype !== 'session_end') || td.source !== 'builtin-terminal' || !tid) {
        return { ok: false, error: 'not a builtin-terminal session event' }
      }
      // For session_end the castPath is on that event itself; for
      // session_start we look up the matching session_end (or use the
      // session_start's own castPath if set).
      let castPath = td.castPath as string | undefined
      if (!castPath) {
        const other = queryEvents({ agentType: 'shell', limit: 5000 })
          .find((ev) => ev.data?.terminalId === tid && (ev.data?.subtype === 'session_start' || ev.data?.subtype === 'session_end') && ev.data?.castPath)
        castPath = other?.data?.castPath as string | undefined
      }
      if (!castPath) return { ok: false, error: 'no cast file for this session' }
      // Slice from 0 to a far future — readCastSlice bounds against the file
      // itself. text captures the whole session, ANSI-stripped.
      const slice = await readCastSlice(castPath, 0, Number.MAX_SAFE_INTEGER)
      if (!slice) return { ok: false, error: 'failed to read cast file' }
      // events carries the raw asciinema frames ([relSec, 'o', bytes]) so the
      // renderer can drive a proper scrubber/player. text is kept for the
      // fallback pre-tag view and copy-to-clipboard flows.
      return { ok: true, castPath, text: slice.text, bytes: slice.bytes, truncated: slice.truncated, events: slice.events }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

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

  // --- WSL ---
  ipcMain.handle('wsl:listDistros', () => listWslDistros())
  ipcMain.handle('wsl:getNetworkMode', () => getNetworkMode())
  ipcMain.handle('wsl:installHook', (_e, distro: string, shell: string) =>
    wslInstallHook(distro, shell as 'bash' | 'zsh'))
  ipcMain.handle('wsl:uninstallHook', (_e, distro: string, shell: string) =>
    wslUninstallHook(distro, shell as 'bash' | 'zsh'))
  ipcMain.handle('wsl:runDiagnostics', (_e, distro: string) =>
    wslRunDiagnostics(distro))

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
  eventBus.on('recording', (recording: boolean, source?: string) => {
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
          description: recording ? 'Recording resumed' : 'Recording paused',
          // v0.9.5: who flipped it. With pause now actually suppressing
          // capture, these two rows are the entire record of the gap.
          source: source || 'unknown'
        }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
        if (ev) eventBus.publish(ev, { bypassPause: true })
      } catch { /* additive */ }
    }
  })

  // --- Operators ---
  ipcMain.handle('operators:list', () => {
    if (!activeProject) return []
    return listOperators().map((op) => ({
      id: op.id, name: op.name, isPrimary: op.isPrimary,
      createdAt: op.createdAt, revokedAt: op.revokedAt
    }))
  })

  // --- Quick mark (global shortcut + tray + overlay all route here) ---
  globalShortcut.register(QUICK_MARK_ACCELERATOR, triggerQuickMark)
  // §8: the way back out of click-through. Without it, turning pass-through on
  // makes the control that turns it off unclickable — the HUD is ghosted, so
  // the button is behind it — and the only escape is Settings, which the
  // operator has to know exists.
  globalShortcut.register(HUD_PASSTHROUGH_ACCELERATOR, () => {
    if (!overlayPassThrough) return
    overlayPassThrough = false
    applyOverlayPassThrough()
    send(mainWindow, 'overlay:passThroughChanged', false)
  })
  ipcMain.on('overlay:quickMark', triggerQuickMark)
  ipcMain.handle('overlay:instantMark', () => triggerInstantMark())

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
  stopApiServer()
  tray?.destroy()
})
