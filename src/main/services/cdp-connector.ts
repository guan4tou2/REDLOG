import http from 'http'
import WebSocket from 'ws'
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'
import { noteDbError } from '../../core/capture-health'
import { extractTarget } from '../../core/target-extractor'

// ─────────────────────────────────────────────────────────────────────────────
// CDP connector — v0.6.92 W-project browser producer
//
// Two capture surfaces layered on the same underlying Chrome DevTools Protocol
// endpoint (port 9222 by default):
//
//   1. Tab-list HTTP poll  (unchanged from earlier releases)
//      Cheap 3s poll against `/json`; emits `http_navigation` events when a
//      tab's URL changes.
//
//   2. Per-tab WebSocket   (new in v0.6.92)
//      For each open page tab we open a WebSocket to its
//      `webSocketDebuggerUrl` and subscribe to Runtime + Log events. That
//      surfaces the same console the operator would see in DevTools —
//      `console.error`, `console.warn`, uncaught exceptions with stack
//      traces, and browser log entries (network warnings, deprecation
//      notices) — as `agent_type='browser'` events on the Timeline.
//
// The WS lifecycle is driven by the poll: each cycle we compare `currentIds`
// against `wsByTabId`, opening for new tabs and closing sockets whose tabs
// disappeared. Skips noisy URLs (chrome://, about:blank) so we don't spam the
// timeline with startup pages. Uses `chrome-extension://` scheme skip too —
// the DevTools attaches to extension backgrounds and we don't want their
// noise in a red-team log.
// ─────────────────────────────────────────────────────────────────────────────

interface BrowserTab {
  id: string
  title: string
  url: string
  type: string
  webSocketDebuggerUrl?: string
}

interface BrowserContext {
  url: string | null
  title: string | null
  connected: boolean
}

let cdpPort = 9222
let lastContext: BrowserContext = { url: null, title: null, connected: false }

// Per-tab last-seen URL so we only emit an event when navigation actually
// changed. Chrome DevTools' /json endpoint is polled — no WebSocket subscription
// keeps the HTTP-poll dependency footprint at zero (using core http only).
const lastTabUrls = new Map<string, string>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let engagementId = ''
let operatorId = ''

// Open WebSocket sessions keyed by tab id. Each carries the tab URL at the
// time of open so we can attach `url`/`host` to console events without asking
// CDP again. Values are torn down on tab close (see reconcileWebSockets).
interface TabSession {
  ws: WebSocket
  url: string
  host: string
  // Console-event dedup ring: [signature, first-seen-ms]. React dev-mode
  // slams the same warning 100+ times in a burst; we drop identical
  // (level, message, source, line) within 500ms.
  recentEvents: Map<string, number>
}
const wsByTabId = new Map<string, TabSession>()
// Per-session request id counter for CDP JSON-RPC calls.
let cdpMsgId = 1

// Max string sizes for browser events. Console spam can dump 200 KB per
// message; a 2 KB truncated message + 100-line stack still tells the operator
// what happened without exploding the DB.
const MAX_MSG_BYTES = 2048
const MAX_STACK_LINES = 100
const DEDUP_WINDOW_MS = 500

// URLs that would just be noise on the timeline. blank/new-tab, in-browser
// settings, dev-tools protocol pages, and the tab-created placeholder.
function isNoisyUrl(u: string): boolean {
  if (!u) return true
  if (u === 'about:blank' || u === 'about:newtab') return true
  return /^(chrome|edge|brave|about|devtools|view-source|chrome-extension):/i.test(u)
}

export function setCdpPort(port: number): void {
  cdpPort = port
}

export function configureCdpMonitor(opts: { engagementId?: string; operatorId?: string; enabled?: boolean }): void {
  if (opts.engagementId !== undefined) engagementId = opts.engagementId
  if (opts.operatorId !== undefined) operatorId = opts.operatorId
  if (opts.enabled) startCdpMonitor()
  else if (opts.enabled === false) stopCdpMonitor()
}

export function startCdpMonitor(): void {
  if (pollTimer) return
  // 3s cadence — fast enough to catch a click-through page load, slow enough to
  // stay negligible against CDP's HTTP endpoint. If no browser is running the
  // poll fails silently.
  pollTimer = setInterval(pollNavigations, 3000)
}

export function stopCdpMonitor(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  lastTabUrls.clear()
  closeAllTabSockets()
}

function closeAllTabSockets(): void {
  for (const [, sess] of wsByTabId) {
    try { sess.ws.close() } catch { /* already closing */ }
  }
  wsByTabId.clear()
}

async function pollNavigations(): Promise<void> {
  // Ambient CDP navigation capture — skip while paused (aligns with
  // clipboard + screenshot ambient gating). Matches the pause semantics
  // an operator expects when clicking "pause recording".
  if (eventBus.paused) return
  let tabs: BrowserTab[]
  try { tabs = await fetchJson<BrowserTab[]>(`http://127.0.0.1:${cdpPort}/json`) } catch { return }
  if (!operatorId || !engagementId) return
  const currentIds = new Set<string>()
  for (const tab of tabs) {
    if (tab.type !== 'page') continue
    currentIds.add(tab.id)
    const url = tab.url || ''
    if (isNoisyUrl(url)) { lastTabUrls.set(tab.id, url); continue }
    const prev = lastTabUrls.get(tab.id)
    if (prev === url) continue
    lastTabUrls.set(tab.id, url)
    // First sighting of a tab (no prev) with a real URL — treat as a navigation
    // too, since RedLog needs the entry point in the log. Suppress the trivial
    // case of a tab that was already at a noisy URL when we first saw it.
    try {
      const targetHost = safeHost(url)
      const detectedTarget = targetHost ? extractTarget(url) : undefined
      const ev = insertEvent('http_navigation', {
        subtype: 'navigation',
        url,
        prev_url: prev ?? null,
        title: tab.title || '',
        host: targetHost,
        tab_id: tab.id,
        mitre_ttp: 'T1071.001',  // Application Layer Protocol: Web Protocols
        description: `→ ${targetHost || url.slice(0, 80)}`
      }, {
        engagementId, operatorId,
        targetId: detectedTarget ?? undefined
      })
      if (ev) eventBus.publish(ev)
    } catch (e) {
      // additive; never break polling — but surface the error to capture-health
      // so a persistently-failing CDP capture path stops being invisible.
      noteDbError('cdp-navigation', e)
    }
  }
  // Reconcile WebSocket subscriptions against current tabs.
  reconcileWebSockets(tabs, currentIds)
  // Forget closed tabs so their id can be reused without spuriously suppressing.
  for (const id of lastTabUrls.keys()) if (!currentIds.has(id)) lastTabUrls.delete(id)
}

function reconcileWebSockets(tabs: BrowserTab[], currentIds: Set<string>): void {
  // Close sockets for tabs that vanished.
  for (const [tabId, sess] of wsByTabId) {
    if (!currentIds.has(tabId)) {
      try { sess.ws.close() } catch { /* */ }
      wsByTabId.delete(tabId)
    }
  }
  // Open sockets for new tabs (page type only, real URL, has debugger URL).
  for (const tab of tabs) {
    if (tab.type !== 'page') continue
    if (isNoisyUrl(tab.url)) continue
    if (!tab.webSocketDebuggerUrl) continue
    if (wsByTabId.has(tab.id)) {
      // URL might have changed since we opened — refresh cached url/host so
      // events attribute correctly. No need to reopen the socket.
      const sess = wsByTabId.get(tab.id)!
      if (sess.url !== tab.url) {
        sess.url = tab.url
        sess.host = safeHost(tab.url) || ''
      }
      continue
    }
    openTabWebSocket(tab)
  }
}

function openTabWebSocket(tab: BrowserTab): void {
  if (!tab.webSocketDebuggerUrl) return
  let ws: WebSocket
  try {
    ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false })
  } catch {
    return
  }
  const sess: TabSession = {
    ws,
    url: tab.url || '',
    host: safeHost(tab.url) || '',
    recentEvents: new Map()
  }
  wsByTabId.set(tab.id, sess)

  ws.on('open', () => {
    // Enable Runtime + Log domains so we get console.* + uncaught exceptions
    // + browser log entries. Two calls, we don't care about responses beyond
    // the fact that they arrive (protocol errors get logged via 'error').
    try {
      ws.send(JSON.stringify({ id: cdpMsgId++, method: 'Runtime.enable' }))
      ws.send(JSON.stringify({ id: cdpMsgId++, method: 'Log.enable' }))
    } catch { /* socket may have closed already */ }
  })

  ws.on('message', (raw) => {
    if (eventBus.paused) return
    let msg: { method?: string; params?: Record<string, unknown> }
    try { msg = JSON.parse(String(raw)) } catch { return }
    if (!msg.method) return
    handleCdpEvent(tab.id, sess, msg.method, msg.params ?? {})
  })

  ws.on('close', () => { wsByTabId.delete(tab.id) })
  ws.on('error', () => {
    // Chrome routinely resets sockets when a tab navigates cross-origin —
    // the poll will re-open on the next cycle. Don't spam the DB error path.
    try { ws.close() } catch { /* */ }
    wsByTabId.delete(tab.id)
  })
}

function handleCdpEvent(
  tabId: string,
  sess: TabSession,
  method: string,
  params: Record<string, unknown>
): void {
  if (!engagementId || !operatorId) return
  let data: Record<string, unknown> | null = null
  let subtype = ''

  if (method === 'Runtime.consoleAPICalled') {
    const level = String(params.type ?? 'log')  // log/info/warn/error/debug/trace
    const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? []
    const message = args.map((a) => {
      if (a.value !== undefined && a.value !== null) return String(a.value)
      return String(a.description ?? '')
    }).join(' ')
    const stackFrames = params.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number; functionName?: string }> } | undefined
    const firstFrame = stackFrames?.callFrames?.[0]
    subtype = level === 'warning' ? 'console_warn'
      : level === 'error' ? 'console_error'
      : level === 'info' ? 'console_info'
      : level === 'debug' ? 'console_debug'
      : level === 'trace' ? 'console_trace'
      : 'console_log'
    data = {
      subtype,
      level,
      url: sess.url,
      host: sess.host,
      tab_id: tabId,
      message: truncateMessage(message),
      source: firstFrame?.url,
      line_number: firstFrame?.lineNumber,
      column_number: firstFrame?.columnNumber,
      stack_trace: stackFrames ? formatStack(stackFrames.callFrames) : undefined
    }
  } else if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails as {
      text?: string
      exception?: { className?: string; description?: string }
      stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number; functionName?: string }> }
      lineNumber?: number
      columnNumber?: number
      url?: string
    } | undefined
    if (!details) return
    subtype = 'exception'
    const message = details.exception?.description ?? details.text ?? ''
    data = {
      subtype,
      level: 'error',
      url: sess.url,
      host: sess.host,
      tab_id: tabId,
      message: truncateMessage(message),
      exception_class: details.exception?.className,
      source: details.url,
      line_number: details.lineNumber,
      column_number: details.columnNumber,
      stack_trace: details.stackTrace ? formatStack(details.stackTrace.callFrames) : undefined
    }
  } else if (method === 'Log.entryAdded') {
    const entry = params.entry as {
      source?: string
      level?: string
      text?: string
      url?: string
      lineNumber?: number
      stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number; functionName?: string }> }
    } | undefined
    if (!entry) return
    subtype = 'log_entry'
    data = {
      subtype,
      level: entry.level ?? 'info',
      log_source: entry.source,  // 'network', 'deprecation', 'security', …
      url: sess.url,
      host: sess.host,
      tab_id: tabId,
      message: truncateMessage(entry.text ?? ''),
      source: entry.url,
      line_number: entry.lineNumber,
      stack_trace: entry.stackTrace ? formatStack(entry.stackTrace.callFrames) : undefined
    }
  } else {
    return  // ignore other CDP events
  }

  if (!data) return

  // Dedup identical (subtype, message, source, line_number) within DEDUP_WINDOW_MS.
  // React dev warnings + effect loops otherwise flood the DB. Keep the first,
  // drop the burst.
  const sig = `${subtype}|${data.message}|${data.source ?? ''}|${data.line_number ?? ''}`
  const now = Date.now()
  const seen = sess.recentEvents.get(sig)
  if (seen && now - seen < DEDUP_WINDOW_MS) return
  sess.recentEvents.set(sig, now)
  // Sweep entries older than 5s so the map doesn't grow unboundedly.
  if (sess.recentEvents.size > 128) {
    for (const [k, ts] of sess.recentEvents) {
      if (now - ts > 5000) sess.recentEvents.delete(k)
    }
  }

  try {
    const targetHost = sess.host
    const detectedTarget = targetHost ? extractTarget(sess.url) : undefined
    const ev = insertEvent('browser', data, {
      engagementId, operatorId,
      targetId: detectedTarget ?? undefined
    })
    if (ev) eventBus.publish(ev)
  } catch (e) {
    noteDbError('cdp-console', e)
  }
}

function truncateMessage(m: string): string {
  if (!m) return ''
  if (m.length <= MAX_MSG_BYTES) return m
  return m.slice(0, MAX_MSG_BYTES) + `…[+${m.length - MAX_MSG_BYTES}]`
}

function formatStack(frames: Array<{ url?: string; lineNumber?: number; columnNumber?: number; functionName?: string }> | undefined): string | undefined {
  if (!frames || frames.length === 0) return undefined
  const slice = frames.slice(0, MAX_STACK_LINES)
  return slice.map((f) => {
    const fn = f.functionName || '<anonymous>'
    const loc = f.url ? `${f.url}:${f.lineNumber ?? '?'}:${f.columnNumber ?? '?'}` : '(no source)'
    return `  at ${fn} (${loc})`
  }).join('\n')
}

function safeHost(u: string): string | null {
  try { return new URL(u).host } catch { return null }
}

function fetchJson<T>(url: string, timeout = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          reject(new Error('Invalid JSON'))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Timeout'))
    })
  })
}

export async function getActiveBrowserTab(): Promise<BrowserContext> {
  try {
    const tabs = await fetchJson<BrowserTab[]>(`http://127.0.0.1:${cdpPort}/json`)
    const page = tabs.find((t) => t.type === 'page')
    if (page) {
      lastContext = { url: page.url, title: page.title, connected: true }
    } else {
      lastContext = { url: null, title: null, connected: true }
    }
  } catch {
    lastContext = { url: null, title: null, connected: false }
  }
  return lastContext
}
