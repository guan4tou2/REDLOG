import { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut, dialog, screen, session, shell, protocol } from 'electron'
import { electronApp, is } from '@electron-toolkit/utils'
import path from 'path'
import { homedir } from 'os'
import { createMainWindow, createOverlayWindow } from './windows'
import { loadOverlayPosition, saveOverlayPosition } from './services/overlay-position'
import { createTray, setTrayRecording } from './tray'
import { AlertRuntime, type IPStatusShape } from './services/alert-runtime'
import yaml from 'js-yaml'
import { loadConfig, saveConfig, snapshotScope, isAgentTailerEnabled, RedLogConfig } from '../core/config'
import { diffSecurityConfig, describeOpsecDelta } from './config-audit'
import { initDB, closeDB, getProjectDir } from '../core/db/index'
import { insertEvent, queryEvents, queryEventById, getLootCount, type RedLogEvent } from '../core/db/events'
import {
  createBookmark, updateBookmark, getBookmark, listBookmarks, deleteBookmark
} from '../core/db/bookmarks'
import { getActiveBrowserTab, setCdpPort, configureCdpMonitor, stopCdpMonitor } from './services/cdp-connector'
import { QUICK_MARK_ACCELERATOR, HUD_PASSTHROUGH_ACCELERATOR } from '../core/shortcuts'
import fs from 'fs'
import { eventBus } from '../core/event-bus'
import { ScreenshotAgent } from './services/screenshot-agent'
import { LootDetector, listLootRules } from '../core/loot-detector'
import { startAnchorLoop, stopAnchorLoop, verifyRandomSample } from '../core/chain-anchor'
import { startNtpLoop, stopNtpLoop } from '../core/clock'
import { configureRedaction, redactFields } from '../core/redaction'
import { runScopeRecompute, queryScopeViolationRows, countActiveScopeViolations, queryLastScopeRecompute } from '../core/scope-recompute-run'
import { getVisibilitySignals, resetVisibilitySignalsCache } from '../core/visibility-signals'
import { alertFloorFor } from '../core/alert'
import type { ScopeSnapshot } from '../core/alert/policies'
import { sweepRetention, sweepLoggedTier, sweepBodyStore, sweepBookmarks, sweepArtifactStore } from '../core/retention'
import { resetBodiesDirCache } from '../core/http-body-store'
import {
  listProjects, createProject, openProject, deleteProject, renameProject,
  getProjectDir as getProjectPath, ProjectMeta
} from '../core/project-manager'
import { startApiServer, stopApiServer, configureApi, getApiToken, setAppVersion, getApiPort, setCastProbe, onApiProjectOpen, onApiProjectClose } from '../core/api-server'
import {
  killAllTerminals, setTerminalWindow, configureTerminal, configureTerminalProxy, recoverOrphanSessions, discoverShells,
  getCastPosition
} from './terminal-manager'
import { detectHooks, detectHooksAsync, getCachedHooks, getCaptureHookPath, invalidateHooksCache as invalidateHooksDetectCache, installHook, uninstallHook } from '../core/hooks-manager'
import { listWslDistros, getNetworkMode, installHook as wslInstallHook, uninstallHook as wslUninstallHook, runDiagnostics as wslRunDiagnostics } from '../core/wsl-manager'
import { configureClipboardMonitor, startClipboardMonitor, stopClipboardMonitor } from './clipboard-monitor'
import { configureFileWatcher, stopFileWatcher } from './services/file-watcher'
import { configureProcessMonitor, stopProcessMonitor } from './services/process-monitor'
import { configureConnectionMonitor, stopConnectionMonitor } from './services/connection-monitor'
import { configurePowershellTranscript, stopPowershellTranscript } from './services/powershell-transcript'
import { configureAgentTailer, stopAgentTailer } from './services/agent-tailer'
import { configureOpsecMonitor, startOpsecMonitor, stopOpsecMonitor, setVpnAdapters, OpsecStateDelta } from './services/opsec-state'
import { initPlugins } from '../core/plugins'
import { configureIngest, ingestEvent } from '../core/ingest'
import { resetCausesResolver } from '../core/causes-resolver'
import { setTailerContributionSink, type TailerLike } from '../core/plugins/tailer-registry'
import { registerAdapter as registerTailerAdapter, unregisterAdapter as unregisterTailerAdapter, registerSessionId, getRegisteredSessions, type TailerAdapter } from './services/tailer-host'
import { getCaptureHealth, invalidateHooksCache, noteSampleBroken, noteSampleOk, clearSampleBroken, configureCaptureHealth, configureManagedProxyHealth, noteDbError } from '../core/capture-health'
import { launchBrowser, stopBrowser, isBrowserRunning, detectBrowser, DEFAULT_BROWSER } from './services/browser-launcher'
import { managedHttpProxy, type ManagedProxyStatus } from './services/managed-http-proxy'
import { isManagedLoopbackProxy } from '../core/managed-proxy-url'
import { detectLink } from './services/network-info'
import { checkForUpdates, setUpdaterAirgap } from './services/updater'
import { anchorBeforeRestart } from '../core/update-anchor'
import { isInsideDir } from '../core/paths'
import { contentSecurityPolicy } from '../core/csp'
import { backfillCastIndex, closeCastIndex } from '../core/cast-index'
import { closeHttpBodyIndex } from '../core/http-body-index'
import { replaySpoolDirectory } from '../core/spool-replay'
import { registerContextMenuIpc } from './context-menu'
import { registerClipboardIpc } from './ipc/clipboard'
import { registerDataExportIpc } from './ipc/data-export'
import {
  registerOverlayIpc, setOverlayPassThrough, stopOverlayMouseTracking,
  configureOverlayState, handleIpExposedChange, startOverlayMouseTracking,
  applyOverlayPassThrough, applyOverlayOpacity, isOverlayPassThrough
} from './ipc/overlay'
import { registerTerminalIpc } from './ipc/terminal'
import { registerPluginsIpc } from './ipc/plugins'
import { registerOperatorsIpc } from './ipc/operators'
import { registerEventsIpc } from './ipc/events'
import { registerChainIpc } from './ipc/chain'
import { registerMarkersIpc, MARKER_TEXT_FIELDS } from './ipc/markers'
import { registerViewsIpc } from './ipc/views'
import { registerTargetContextIpc } from './ipc/target-context'
import type { IpcContext } from './ipc/types'

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
// v0.6.89 P1-A: read-path chain sampling. Runs periodically while a project
// is open to catch chain tampering silently — the on-demand verify button is
// too easy to skip. Cleared in stopProject so a project switch stops the loop.
let chainSampleTimer: ReturnType<typeof setInterval> | null = null
/** v0.13.0: periodic logged-tier retention sweep. See DESIGN-logged-tier-
 *  retention.md §5.1 — 24h default cadence. `stopProject` clears on
 *  project close so the timer doesn't fire against a closed DB. */
let loggedTierTimer: ReturnType<typeof setInterval> | null = null
let spoolDrainTimer: ReturnType<typeof setInterval> | null = null

function managedProxyPort(config: RedLogConfig): number {
  const port = Number(config.httpCapture?.port ?? 8080)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8080
}

function publishManagedProxyEvent(subtype: 'http_proxy_started' | 'http_proxy_stopped' | 'http_proxy_failed', status: ManagedProxyStatus): void {
  if (!currentEngagementId || !currentOperatorId) return
  ingestEvent('system', {
    subtype,
    source: 'managed-http-proxy',
    state: status.state,
    proxy: status.url,
    pid: status.pid ?? null,
    error: status.error ?? null
  }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
}

async function startManagedHttpCapture(): Promise<ManagedProxyStatus> {
  if (!activeProject) return { state: 'failed', url: null, error: 'No project open' }
  const addonPath = getCaptureHookPath('mitmproxy')
  if (!addonPath) return { state: 'failed', url: null, error: 'mitmproxy capture addon is disabled or missing' }
  const config = loadConfig(getProjectPath(activeProject))
  const before = managedHttpProxy.status().state
  const status = await managedHttpProxy.start({
    addonPath,
    port: managedProxyPort(config),
    caPath: path.join(homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem')
  })
  if (status.state === 'running') {
    if (before !== 'running') publishManagedProxyEvent('http_proxy_started', status)
  } else {
    publishManagedProxyEvent('http_proxy_failed', status)
  }
  return status
}

function stopManagedHttpCapture(record = true): ManagedProxyStatus {
  const before = managedHttpProxy.status()
  const status = managedHttpProxy.stop()
  if (record && before.state === 'running') publishManagedProxyEvent('http_proxy_stopped', status)
  return status
}

configureManagedProxyHealth(() => managedHttpProxy.status())
managedHttpProxy.onStatusChange((next, previous) => {
  if (previous.state === 'running' && next.state === 'failed') {
    publishManagedProxyEvent('http_proxy_failed', next)
  }
})

const SPOOL_IDENTITY_PATH = path.join(homedir(), '.redlog', 'active-identity.json')

function writeSpoolIdentity(engagementId: string, operatorId: string): void {
  try {
    fs.mkdirSync(path.dirname(SPOOL_IDENTITY_PATH), { recursive: true })
    fs.writeFileSync(SPOOL_IDENTITY_PATH, JSON.stringify({ engagementId, operatorId }), { mode: 0o600 })
  } catch { /* best-effort */ }
}

function clearSpoolIdentity(): void {
  try { fs.unlinkSync(SPOOL_IDENTITY_PATH) } catch { /* already gone */ }
}

function readSpoolIdentity(): { engagementId: string; operatorId: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(SPOOL_IDENTITY_PATH, 'utf8'))
    if (typeof raw.engagementId === 'string' && typeof raw.operatorId === 'string') return raw
  } catch { /* missing or malformed */ }
  return null
}

// Timers and pty callbacks keep firing while the app tears down, and a
// destroyed BrowserWindow is still non-null — send through here so a quit
// mid-poll can't raise "Object has been destroyed".
// Rest args, not one payload: `overlay:passThrough` sends (on, opacity) and the
// second was being dropped silently, so the HUD never received the configured
// pass-through opacity and fell back to its default.
function send(win: BrowserWindow | null, channel: string, ...payload: unknown[]): void {
  if (!win || win.isDestroyed()) return
  try { win.webContents.send(channel, ...payload) } catch { /* window tearing down */ }
}

function toggleRecording(): boolean {
  if (eventBus.paused) eventBus.resume('ui')
  else eventBus.pause('ui')
  return !eventBus.paused
}

// The marker fields an operator types or pastes, and therefore the ones that can
// carry a credential — a URL with a session token in its query string is the
// case this list exists for as much as a password in a note. Layer 4 can only mask a field that carries
// detection spans (src/core/sanitize.ts skips an event whose `data.redactions`
// is empty), so every marker producer runs `redactFields` over these before the
// insert — otherwise `redlog-cli sanitize` reports success on a marker note and
// ships the secret anyway.
// MARKER_TEXT_FIELDS imported from ./ipc/markers

// Opens the marker dialog in the main window — shared by the global shortcut,
// the tray menu, and the HUD's "detailed" button. Steals focus by design: the
// operator is about to type a title and notes.
function triggerBookmark(): void {
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
    const event = insertEvent('marker', redactFields({
      title: `HUD mark ${at.toLocaleTimeString()}`,
      notes: '',
      severity: 'info',
      category: 'custom',
      // Distinguishes an un-annotated instant mark from one the operator
      // filled in, so a reviewer knows a bare title is intentional.
      source: 'hud-instant'
    }, MARKER_TEXT_FIELDS), { engagementId: currentEngagementId, operatorId: currentOperatorId })
    if (event) eventBus.publish(event, { bypassPause: true })
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

/** True for an http(s) URL whose host is not loopback, link-local (incl. the
 *  169.254.169.254 cloud-metadata endpoint) or an RFC1918 private range. Gate
 *  for the plugin `net.fetch` egress (SSRF). Hostname-only — does not resolve
 *  DNS, so a name pointing at a private IP is not caught, but the literal
 *  metadata/loopback/private targets an attacker reaches for are. */
function isPublicHttpUrl(u: string): boolean {
  let url: URL
  try { url = new URL(u) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return false
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1]), b = Number(m[2])
    if (a === 0 || a === 127) return false                 // this-host / loopback
    if (a === 10) return false                             // 10/8
    if (a === 169 && b === 254) return false               // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return false       // 172.16/12
    if (a === 192 && b === 168) return false                // 192.168/16
  }
  return true
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
  handleIpExposedChange(status.ipSafety === 'exposed')
}

// Log the security-relevant fields that changed on config:save. Cosmetic changes
// (Dock icon, HUD flash toggle) stay silent — we only record settings that would
// affect enforcement or attribution if silently loosened.
function logConfigDiff(oldCfg: RedLogConfig, newCfg: RedLogConfig): string | null {
  if (!currentEngagementId || !currentOperatorId) return null
  const changed = diffSecurityConfig(oldCfg, newCfg)
  if (Object.keys(changed).length === 0) return null
  try {
    const ev = insertEvent('system', {
      subtype: 'config_changed',
      changed,
      description: `Config changed: ${Object.keys(changed).join(', ')}`
    }, { engagementId: currentEngagementId, operatorId: currentOperatorId })
    if (ev) eventBus.publish(ev)
    // Returned so a scope recompute triggered by this save can cite the row
    // that recorded the change, rather than appearing to happen for no reason.
    return ev?.id ?? null
  } catch { /* additive */ }
  return null
}

// ─── Scope recompute scheduling (design turn 8a) ────────────────────────────
//
// The save is the only door. That is deliberate: TargetView's 〈+ 範圍〉 chip
// widens scope through a toast that defers the write for eight seconds and
// cancels on undo, so hanging the recompute off the click would re-judge the
// corpus for a change the operator then took back.
//
// Three gates, and each exists because of a real edit an operator makes:
//   • trailing debounce — Settings auto-saves on a 350 ms debounce and the
//     scope file is a free-text field, so typing a path produces a save per
//     keystroke burst.
//   • project bail — a queued job must never write into the next project's
//     chain.
//   • hash gate — the run itself skips when the boundary did not actually move.
// StatusBar and Sidebar both ask for the violation count on EVERY captured
// event, so this cannot be a query per event during a scan. Cached, and dropped
// only when a row that could change it lands.
let cachedViolationCount: number | null = null
function activeViolationCount(): number {
  if (cachedViolationCount === null) cachedViolationCount = countActiveScopeViolations()
  return cachedViolationCount
}
function invalidateViolationCount(): void { cachedViolationCount = null }

const SCOPE_COUNT_SUBTYPES = new Set(['scope_violation', 'scope_cleared', 'scope_recomputed'])
eventBus.on('event', (e: RedLogEvent) => {
  if (e.agentType === 'system' && SCOPE_COUNT_SUBTYPES.has(String(e.data?.subtype))) invalidateViolationCount()
})

const RECOMPUTE_DEBOUNCE_MS = 2000
let recomputeTimer: NodeJS.Timeout | null = null
let recomputePending: { projectId: string; before: ScopeSnapshot; configChangedId: string | null } | null = null
let recomputeRunning = false

function scheduleScopeRecompute(before: ScopeSnapshot, configChangedId: string | null): void {
  if (!activeProject) return
  // Coalesce to the EARLIEST before-state of the burst: a→b→c is one boundary
  // move from a to c, and comparing c against b would report the wrong delta.
  if (!recomputePending || recomputePending.projectId !== activeProject.id) {
    recomputePending = { projectId: activeProject.id, before, configChangedId }
  } else if (configChangedId) {
    recomputePending.configChangedId = configChangedId
  }
  if (recomputeTimer) clearTimeout(recomputeTimer)
  recomputeTimer = setTimeout(() => { void runPendingRecompute() }, RECOMPUTE_DEBOUNCE_MS)
}

async function runPendingRecompute(): Promise<void> {
  const job = recomputePending
  recomputeTimer = null
  if (!job || recomputeRunning) return
  // By id, not by object: renaming a project replaces `activeProject` with a
  // fresh object for the same engagement, and a reference test would read that
  // as a project switch and drop the queued recompute.
  if (!activeProject || activeProject.id !== job.projectId) { recomputePending = null; return }
  recomputePending = null
  recomputeRunning = true
  try {
    const config = loadConfig(getProjectPath(activeProject))
    const snap = snapshotScope(config)
    await runScopeRecompute({
      before: job.before,
      after: { targets: snap.targets, excludeTargets: snap.excludeTargets, alertFloor: alertFloorFor(config.scope?.warnOnViolation) },
      engagementId: config.engagement.id,
      operatorId: config.operator.id,
      configChangedEventId: job.configChangedId,
      scopeFile: snap.scopeFile ? { path: snap.scopeFile, sha256: snap.scopeFileSha256, entries: snap.scopeFileEntries } : null
    })
  } catch (e) {
    // A recompute failure must never fail the save that triggered it.
    noteDbError('scope-recompute', e)
  } finally {
    recomputeRunning = false
  }
}

// Compress an OpsecStateDelta into a one-line human description for the event
// row. Prioritized: VPN state comes first (biggest OPSEC impact), then MAC
// (randomization signal), then DNS (leak signal), then hostname.
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

  writeSpoolIdentity(engagementId, operatorId)
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
  void backfillCastIndex(projectDir)
    .catch(() => { /* index is rebuildable; never block opening a project */ })

  screenshotAgent.configure({
    engagementId,
    operatorId,
    quality: config.screenshot.quality,
    intervalSec: config.screenshot.intervalSec ?? 0,
    diffThreshold: config.screenshot.diffThreshold ?? 5,
    captureOnCommand: config.screenshot.captureOnCommand ?? false
  })

  invalidateViolationCount()
  resetVisibilitySignalsCache()
  recomputePending = null
  const scopeTargets = snapshotScope(config).targets
  // v0.12.0: one configure call for the whole alert subsystem. Drops correlation/
  // burst history on every project open (resetOnProjectSwitch) so a stale
  // Combined verdict from the previous engagement can't fire when the new
  // one's first IP tick lands.
  alertRuntime.resetOnProjectSwitch()
  alertRuntime.configure(config, { engagementId, operatorId }, scopeTargets)
  lootDetector.configure({ engagementId, operatorId, disabledRules: config.loot?.disabledRules ?? [] })
  configureCaptureHealth(config as unknown as Record<string, unknown>)
  configureRedaction(config.redaction)
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
  configureTerminalProxy(() => {
    const status = managedHttpProxy.status()
    return loadConfig(getProjectDir()).httpCapture?.routeTerminals === true && status.state === 'running' ? status.url : null
  })
  // Capture starts only through an explicit operator action.
  // v0.9.6 (T2): core/ can't import main/, so hand the live cast position in.
  setCastProbe(getCastPosition)
  // The unified ingest() pipeline (used by /api/events and, going forward, the
  // in-process producers) needs the same collaborators the api-server had: the
  // loot detector, the alert runtime for scope dispatch, and the cast probe for
  // bracketing built-in-terminal output.
  configureIngest({
    lootDetector,
    alertRuntime: { dispatchTargetHit: (input) => alertRuntime.dispatchTargetHit(input) },
    castProbe: getCastPosition,
    activeTarget: config.engagement.activeTarget ?? null
  })

  // Retention sweeps for every store under `config.retention` (Spec 028).
  // All default to 0 (keep forever); a positive `keepDays` / `maxBytes` makes
  // the sweep run on every project open and append an audit event per deletion.
  try {
    // v0.9.4 P0-4: statically imported. This used to be a runtime
    // `require('../core/retention')`, which rollup cannot see through — the
    // module was never bundled and the literal require survived into
    // out/main/index.js, where it resolved against a non-existent out/core/.
    // Every packaged build threw MODULE_NOT_FOUND into the catch below, so
    // cast and screenshot keep-days silently did nothing and the
    // cast_pruned / screenshot_pruned audit events were never written. Unit
    // tests missed it because they import core/retention directly.
    const swept = sweepRetention(config, { engagementId, operatorId })
    if (swept.cast > 0 || swept.screenshots > 0 || swept.httpBodies > 0) {
      console.log(`[retention] pruned ${swept.cast} .cast file(s) + ${swept.screenshots} screenshot(s) + ${swept.httpBodies} http body file(s)`)
    }
    const bookmarksPruned = sweepBookmarks(config.retention?.bookmarks, { engagementId, operatorId })
    if (bookmarksPruned > 0) console.log(`[retention] pruned ${bookmarksPruned} bookmark(s)`)
    // Size-pressure eviction of the body store, after the age sweep — whatever
    // aged out has already gone, so this only reaches live-but-cold bodies.
    const evicted = sweepBodyStore(config, { engagementId, operatorId })
    if (evicted.evicted > 0 || evicted.shortfallBytes > 0) {
      console.log(`[retention] evicted ${evicted.evicted} body file(s) under disk pressure` +
        (evicted.shortfallBytes > 0 ? ` (still ${evicted.shortfallBytes} bytes over budget; in-scope bodies kept)` : ''))
    }
    // §3b: same scope-pinned size-pressure eviction for the cast + screenshot
    // stores. Off by default (budget 0); when set, out-of-scope recordings go
    // before in-scope evidence instead of purely by age.
    for (const kind of ['cast', 'screenshot'] as const) {
      const ev = sweepArtifactStore(kind, config, { engagementId, operatorId })
      if (ev.evicted > 0 || ev.shortfallBytes > 0) {
        console.log(`[retention] evicted ${ev.evicted} ${kind} file(s) under disk pressure` +
          (ev.shortfallBytes > 0 ? ` (still ${ev.shortfallBytes} bytes over budget; in-scope ${kind}s kept)` : ''))
      }
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

  // Fill the shell catalog in the background so the picker opens instantly.
  // Not awaited: on Windows it enumerates WSL, and nothing here depends on
  // the answer (#100 is the reason that distinction matters).
  void discoverShells().catch(() => { /* probing is best effort */ })

  // Replay only records belonging to the active engagement. Mismatches remain
  // recoverable on disk and are picked up when their owning project opens.
  const drainSpool = (limit = Number.POSITIVE_INFINITY): void => {
    if (!currentEngagementId || !currentOperatorId) return
    if (eventBus.paused) return
    const emit = ({ agentType, data, engagementId: spoolEngagement, operatorId: spoolOperator }: import('../core/spool-replay').SpoolReplayEvent): boolean => {
      const ev = insertEvent(agentType, data, { engagementId: spoolEngagement, operatorId: spoolOperator })
      if (ev) eventBus.publish(ev)
      return ev !== null
    }
    const replayed = replaySpoolDirectory(path.join(homedir(), '.redlog', 'pending'), {
      engagementId: currentEngagementId,
      operatorId: currentOperatorId
    }, emit, limit).replayed
    if (replayed > 0) console.log(`[hook-spool] replayed ${replayed} spooled event(s)`)
  }
  try { drainSpool() } catch (e) { console.error('[hook-spool] replay failed:', e) }

  spoolDrainTimer = setInterval(() => {
    try { drainSpool(200) } catch { /* next interval retries preserved files */ }
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
  configurePowershellTranscript({
    enabled: config.powershellTranscript?.enabled ?? false,
    engagementId,
    operatorId
  })
  configureProcessMonitor({
    enabled: config.processMonitor?.enabled ?? false,
    pollMs: config.processMonitor?.pollMs,
    ignoreCommands: config.processMonitor?.ignoreCommands ?? [],
    engagementId, operatorId
  })
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
      // Agent transcripts can include unrelated work from the operator's home
      // directory. Capture is therefore opt-in for every project; a partial or
      // hand-written config must never turn it on implicitly.
      enabled: isAgentTailerEnabled(config),
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
      getTargets: () => loadConfig(projectDir).scope.targets,
      getExcludeTargets: () => loadConfig(projectDir).scope?.excludeTargets ?? []
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

  insertEvent('system', { subtype: 'session_start' }, { engagementId, operatorId })

  // OPSEC air-gap: suppress every outbound request RedLog makes of its own —
  // anchoring, NTP sync, and the update check. Capture and the local API are
  // untouched. Record the mode so a timeline that lacks anchors is explained
  // by a choice, not a failure.
  const airgap = config.network?.offline === true
  setUpdaterAirgap(airgap)
  insertEvent('system', { subtype: 'opsec_airgap', enabled: airgap, description: airgap ? 'Air-gap ON — no outbound anchoring / NTP / update / IP lookup' : 'Air-gap OFF' }, { engagementId, operatorId })
  if (!airgap) {
    startAnchorLoop()
    startNtpLoop()
  }

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
    configureOverlayState({
      passThrough: !!config.overlay?.passThrough,
      opacity: config.overlay?.passThroughOpacity ?? 0.4
    })
    if (tray) {
      tray.destroy()
      tray = createTray(mainWindow!, overlayWindow, toggleRecording, triggerBookmark, () => setOverlayPassThrough(!isOverlayPassThrough()))
      setTrayRecording(tray, !eventBus.paused)
    }
  }

}

function stopProject(): void {
  stopManagedHttpCapture(false)
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
  stopPowershellTranscript()
  stopAgentTailer()
  stopCdpMonitor()
  stopOpsecMonitor()
  screenshotAgent.stop()
  closeCastIndex()
  closeHttpBodyIndex()
  // Audit 2026-09-18 P1: finalize all terminal sessions BEFORE closing the DB
  // so session_end events (with cast SHA-256) land in the chain. Without this,
  // terminals survive the project switch with stale identity and their close
  // events race the DB close.
  killAllTerminals()
  closeDB()
  resetBodiesDirCache()
  clearSpoolIdentity()
  activeProject = null
  currentEngagementId = null
  currentOperatorId = null
  resetCausesResolver()
  configureIngest({ activeTarget: null })
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

  // Content-Security-Policy. windows.ts blocks navigation off our own origin;
  // this caps what the loaded document may fetch/execute, so a captured link or
  // an evidence body rendered into the DOM can't pull remote script. Delivered
  // as a header (not a <meta> tag) so prod file:// stays locked to 'self' while
  // dev permits Vite's inline HMR preamble + websocket. Both renderer entries
  // share defaultSession, so one handler covers index.html and overlay.html.
  //
  // Stamps every response and strips any prior CSP first: stamping unconditionally
  // guarantees the document is covered however file:// classifies its request,
  // and a CSP header on the harmless redlog-screenshot image subresource is
  // ignored by the browser. This is the item flagged 'needs runtime validation'
  // — confirm the header is actually delivered on the packaged file:// load
  // (see the verify steps), because the failure mode here is fail-open.
  const csp = contentSecurityPolicy({ dev: is.dev, rendererUrl: process.env['ELECTRON_RENDERER_URL'] })
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const headers: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(details.responseHeaders ?? {})) {
      if (k.toLowerCase() === 'content-security-policy') continue
      headers[k] = Array.isArray(v) ? v : [String(v)]
    }
    headers['Content-Security-Policy'] = [csp]
    cb({ responseHeaders: headers })
  })

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

  tray = createTray(mainWindow, null, toggleRecording, triggerBookmark, () => setOverlayPassThrough(!isOverlayPassThrough()))

  // Renderer-requested native menus (the terminal's right-click — xterm owns
  // its own selection, so Chromium's context-menu event sees nothing there).
  registerContextMenuIpc(ipcMain)
  registerClipboardIpc(ipcMain)

  // Shared context for extracted IPC handler modules.
  const ipcCtx: IpcContext = {
    getActiveProject: () => activeProject,
    getMainWindow: () => mainWindow,
    getOverlayWindow: () => overlayWindow,
    getCurrentEngagementId: () => currentEngagementId,
    getCurrentOperatorId: () => currentOperatorId,
    send,
    triggerBookmark,
    triggerInstantMark
  }
  registerOverlayIpc(ipcMain, ipcCtx)
  registerDataExportIpc(ipcMain, ipcCtx)
  registerTerminalIpc(ipcMain, ipcCtx)
  registerPluginsIpc(ipcMain, ipcCtx)
  registerOperatorsIpc(ipcMain, ipcCtx)
  registerEventsIpc(ipcMain, ipcCtx)
  registerChainIpc(ipcMain, ipcCtx)
  registerMarkersIpc(ipcMain, ipcCtx, screenshotAgent)
  registerViewsIpc(ipcMain, ipcCtx)
  registerTargetContextIpc(ipcMain, ipcCtx)

  // --- Project management ---
  ipcMain.handle('project:list', () => listProjects())
  ipcMain.handle('project:create', (_e, name: string, initialConfig?: Partial<RedLogConfig>) => {
    const project = createProject(name)
    // The engagement is the project. Every new project used to inherit the
    // template's `default` / "Default Engagement", so the dashboard of a
    // project called Review-Engagement announced a different name, and every
    // event carried `engagement_id: default` — the same id for every project
    // on the box. Seed both from what the operator just typed; the advanced
    // setup (or a later edit) still overrides.
    const projectDir = getProjectPath(project)
    const config = loadConfig(projectDir)
    const merged = {
      ...config,
      engagement: { ...config.engagement, id: project.id, name: project.name, ...initialConfig?.engagement },
      operator: { ...config.operator, ...initialConfig?.operator },
      network: { ...config.network, ...initialConfig?.network },
      scope: { ...config.scope, ...initialConfig?.scope },
      screenshot: { ...config.screenshot, ...initialConfig?.screenshot }
    }
    saveConfig(projectDir, merged)
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
  // transcript watch paths apply across every project.
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
    // The project id is the durable attribution boundary used by spool replay
    // and every Event row. Renderer state, imported profiles and direct IPC
    // calls may update other settings, but cannot rename this identity.
    newConfig.engagement.id = oldConfig.engagement.id
    // Active target has a dedicated, audited IPC. A Settings form may have
    // loaded its config before the title-bar target changed; preserving the
    // latest stored value prevents that stale form from silently reverting
    // attribution context on its next auto-save.
    newConfig.engagement.activeTarget = oldConfig.engagement.activeTarget ?? null
    // Captured BEFORE the save so the recompute can say what the boundary was.
    const beforeScope = snapshotScope(oldConfig)
    saveConfig(projectDir, newConfig)
    currentEngagementId = newConfig.engagement.id
    currentOperatorId = newConfig.operator.id
    configureIngest({ activeTarget: newConfig.engagement.activeTarget ?? null })
    // Audit trail — log security-relevant setting changes so a reviewer can see
    // when scope loosened or the IP blacklist changed. Only diffs the fields
    // that affect enforcement or attribution; cosmetic changes stay silent.
    const configChangedId = logConfigDiff(oldConfig, newConfig)
    keepDockIcon = newConfig.overlay?.showInDock !== false
    applyDock()
    const targets = snapshotScope(newConfig).targets
    alertRuntime.configure(newConfig, {
      engagementId: newConfig.engagement.id,
      operatorId: newConfig.operator.id
    }, targets)
    screenshotAgent.configure({
      quality: newConfig.screenshot.quality,
      intervalSec: newConfig.screenshot.intervalSec ?? 0,
      diffThreshold: newConfig.screenshot.diffThreshold ?? 5,
      captureOnCommand: newConfig.screenshot.captureOnCommand ?? false
    })
    // v0.9.7: refresh the snapshot capture-health reads its on/off switches
    // from, so toggling a source updates the card on the next poll instead of
    // at the next project open.
    configureCaptureHealth(newConfig as unknown as Record<string, unknown>)
    if (managedProxyPort(oldConfig) !== managedProxyPort(newConfig) && ['running', 'starting'].includes(managedHttpProxy.status().state)) {
      stopManagedHttpCapture()
      void startManagedHttpCapture()
    }
    // Re-judge what is already recorded against the boundary that now applies.
    // Scheduled rather than awaited: the renderer's save must not wait on a
    // scan, and the debounce collapses an editing burst into one run.
    scheduleScopeRecompute({
      targets: beforeScope.targets,
      excludeTargets: beforeScope.excludeTargets,
      alertFloor: alertFloorFor(oldConfig.scope?.warnOnViolation)
    }, configChangedId)
    configureTerminal({ engagementId: newConfig.engagement.id, operatorId: newConfig.operator.id,
      maxCastBytes: newConfig.terminal?.maxCastBytes })
    lootDetector.configure({ disabledRules: newConfig.loot?.disabledRules ?? [] })
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
    configurePowershellTranscript({ enabled: newConfig.powershellTranscript?.enabled ?? false })
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
    configureOverlayState({
      passThrough: !!newConfig.overlay?.passThrough,
      opacity: newConfig.overlay?.passThroughOpacity ?? 0.4
    })
    return true
  })
  // Per-tick push — fires every IP check so `lastCheck`/link updates reach the
  // UI even when the verdict doesn't flip. IPPolicy dedup ensures the CHAIN
  // only sees actual verdict changes; this listener is UI-only.
  alertRuntime.onIpTick(() => broadcastIPStatus(alertRuntime.ipStatus()))

  // --- Events (extracted to ipc/events.ts) ---

  // Coalesce event bursts into one renderer delivery per event-loop turn.
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
    // 2b/OSCP: opt-in screenshot linked to a finished command (_causes → this
    // event). No-op unless config.screenshot.captureOnCommand is on; the agent
    // owns the flag and the perceptual-dedup skip.
    if (event.agentType === 'shell' && d.subtype === 'command_end') {
      screenshotAgent.onCommandEnd(event.id).catch(() => { /* best-effort */ })
    }
  })
  ipcMain.handle('pivots:getActive', () => getActivePivots())

  // --- Markers + Screenshots (extracted to ipc/markers.ts) ---

  // --- Scope ---
  // Read from the chain, not from the in-process log the alert runtime keeps.
  // That log holds 500 rows and resets on every project switch, so it could
  // never show a retroactive row and would go on counting one that had been
  // withdrawn — the page would contradict the record it exists to show.
  ipcMain.handle('scope:getViolations', () => (activeProject ? queryScopeViolationRows() : []))
  ipcMain.handle('scope:getViolationCount', () => (activeProject ? activeViolationCount() : 0))
  ipcMain.handle('scope:getLastRecompute', () => (activeProject ? queryLastScopeRecompute() : null))
  ipcMain.handle('scope:isConfigured', () => alertRuntime.scopeIsConfigured())

  // §22: which nouns this engagement has the data for. Read-only, and the
  // flags are monotonic, so a mature project costs no queries at all.
  ipcMain.handle('visibility:signals', () => (activeProject ? getVisibilitySignals() : null))

  // --- Evidence Chain + Clock (extracted to ipc/chain.ts) ---

  // --- Loot ---
  ipcMain.handle('loot:getCount', () => activeProject ? getLootCount() : 0)
  ipcMain.handle('loot:rules', () => listLootRules())

  // --- Bookmarks ---
  ipcMain.handle('bookmarks:list', () => activeProject ? listBookmarks() : [])
  ipcMain.handle('bookmarks:get', (_e, id: string) => activeProject ? getBookmark(id) : null)
  ipcMain.handle('bookmarks:create', async (_e, data: { title: string; url?: string; note?: string }) => {
    if (!activeProject) return null
    const browser = await getActiveBrowserTab()
    const context = {
      browserUrl: browser.url || undefined,
      browserTitle: browser.title || undefined,
      externalIP: alertRuntime.ipStatus().externalIP || undefined
    }
    return createBookmark({
      title: data.title || browser.title || 'Untitled',
      url: data.url || browser.url || undefined,
      note: data.note,
      context
    })
  })
  ipcMain.handle('bookmarks:update', (_e, id: string, data) => activeProject ? updateBookmark(id, data) : false)
  ipcMain.handle('bookmarks:delete', (_e, id: string) => activeProject ? deleteBookmark(id) : false)

  // --- Saved Timeline views (extracted to ipc/views.ts) ---

  // --- Proxied browser ---
  ipcMain.handle('httpCapture:status', () => managedHttpProxy.status())
  ipcMain.handle('httpCapture:start', () => startManagedHttpCapture())
  ipcMain.handle('httpCapture:stop', () => stopManagedHttpCapture())
  ipcMain.handle('browser:detect', () => detectBrowser())
  ipcMain.handle('browser:status', () => ({ running: isBrowserRunning() }))
  ipcMain.handle('browser:launch', async () => {
    if (!activeProject) return { ok: false, error: 'No project open' }
    const projectDir = getProjectPath(activeProject)
    const cfg = loadConfig(projectDir)
    const browserCfg = { ...DEFAULT_BROWSER, ...(cfg.browser ?? {}) }
    if (isManagedLoopbackProxy(browserCfg.proxy, managedProxyPort(cfg))) {
      const proxy = await startManagedHttpCapture()
      if (proxy.state !== 'running') {
        return { ok: false, error: proxy.error || 'HTTP capture proxy is not running' }
      }
      browserCfg.proxy = proxy.url ?? browserCfg.proxy
    }
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
      const data = ext === '.json' ? JSON.parse(raw) : yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>
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

  // --- Hooks ---
  ipcMain.handle('hooks:detect', async () => {
    const cached = getCachedHooks()
    if (cached) {
      detectHooksAsync().catch(() => {})
      return cached
    }
    return detectHooksAsync()
  })
  ipcMain.handle('capture:health', () => activeProject ? getCaptureHealth() : null)
  ipcMain.handle('hooks:install', (_e, hookId: string) => { invalidateHooksCache(); invalidateHooksDetectCache(); return installHook(hookId) })
  ipcMain.handle('hooks:uninstall', (_e, hookId: string) => { invalidateHooksCache(); invalidateHooksDetectCache(); return uninstallHook(hookId) })

  // --- WSL ---
  ipcMain.handle('wsl:listDistros', () => listWslDistros())
  ipcMain.handle('wsl:getNetworkMode', () => getNetworkMode())
  ipcMain.handle('wsl:installHook', (_e, distro: string, shell: string) =>
    wslInstallHook(distro, shell as 'bash' | 'zsh'))
  ipcMain.handle('wsl:uninstallHook', (_e, distro: string, shell: string) =>
    wslUninstallHook(distro, shell as 'bash' | 'zsh'))
  ipcMain.handle('wsl:runDiagnostics', (_e, distro: string) =>
    wslRunDiagnostics(distro))

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

  // --- Quick mark (global shortcut + tray + overlay all route here) ---
  globalShortcut.register(QUICK_MARK_ACCELERATOR, triggerBookmark)
  // §8: the way back out of click-through. Without it, turning pass-through on
  // makes the control that turns it off unclickable — the HUD is ghosted, so
  // the button is behind it — and the only escape is Settings, which the
  // operator has to know exists.
  globalShortcut.register(HUD_PASSTHROUGH_ACCELERATOR, () => setOverlayPassThrough(false))

  // --- Updates ---
  ipcMain.handle('app:checkForUpdates', () => checkForUpdates({ manual: true }))
  // 5a: anchor the chain head + mark the expected recording gap before the
  // design's update card sends the operator to quit-and-reinstall.
  ipcMain.handle('app:anchorForRestart', (_e, opts?: { toVersion?: string }) =>
    anchorBeforeRestart({
      fromVersion: app.getVersion(),
      toVersion: opts?.toVersion ?? null,
      engagementId: currentEngagementId ?? 'default'
    }))
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
  stopManagedHttpCapture(false)
  stopBrowser()
  globalShortcut.unregisterAll()
  stopOverlayMouseTracking()
  killAllTerminals()
  stopProject()
  stopApiServer()
  tray?.destroy()
})
