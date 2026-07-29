import http from 'http'
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'
import { extractTarget } from '../../core/target-extractor'

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
// keeps the dependency footprint at zero (using core http only).
const lastTabUrls = new Map<string, string>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let engagementId = ''
let operatorId = ''

// URLs that would just be noise on the timeline. blank/new-tab, in-browser
// settings, dev-tools protocol pages, and the tab-created placeholder.
function isNoisyUrl(u: string): boolean {
  if (!u) return true
  if (u === 'about:blank' || u === 'about:newtab') return true
  return /^(chrome|edge|brave|about|devtools|view-source):/i.test(u)
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
}

async function pollNavigations(): Promise<void> {
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
    } catch { /* additive; never break polling */ }
  }
  // Forget closed tabs so their id can be reused without spuriously suppressing.
  for (const id of lastTabUrls.keys()) if (!currentIds.has(id)) lastTabUrls.delete(id)
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
