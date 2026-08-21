import { eventBus } from '../../core/event-bus'
import { queryEvents, insertEvent, type RedLogEvent } from '../../core/db/events'

const NETWORK_TOOLS = new Set([
  'curl', 'wget', 'httpie', 'http', 'nmap', 'nikto', 'sqlmap',
  'ffuf', 'gobuster', 'dirb', 'dirsearch', 'feroxbuster', 'wfuzz',
  'nuclei', 'httpx', 'subfinder', 'amass', 'massdns',
  'testssl.sh', 'sslscan', 'sslyze',
  'hydra', 'medusa', 'patator', 'crackmapexec', 'nxc', 'netexec',
  'responder', 'impacket', 'certipy', 'bloodhound-python',
  'wpscan', 'droopescan', 'joomscan',
  'arjun', 'paramspider', 'gau', 'waybackurls',
  'rustbuster', 'hakrawler', 'katana', 'gospider',
  'python', 'ruby', 'node', 'java', 'go',
])

const CHECK_DELAY_MS = 15_000
const LOOKBACK_MS = 30_000

let timer: ReturnType<typeof setTimeout> | null = null
const pendingChecks = new Map<number, { command: string; spawnedAt: number; pid: number }>()
let cfg: { engagementId: string; operatorId: string } | null = null

function extractBinary(command: string): string {
  const parts = command.split(/[\s/\\]+/)
  const last = parts[parts.length - 1] || ''
  return last.replace(/\.exe$/i, '').toLowerCase()
}

function isNetworkTool(command: string): boolean {
  const bin = extractBinary(command)
  if (NETWORK_TOOLS.has(bin)) return true
  const full = command.toLowerCase()
  if (full.includes('requests') || full.includes('urllib') || full.includes('aiohttp')) return true
  if (full.includes('http.client') || full.includes('net/http')) return true
  return false
}

function onEvent(event: RedLogEvent): void {
  if (event.agentType !== 'process') return
  const sub = event.data?.subtype as string
  if (sub !== 'process_spawn') return

  const command = String(event.data?.command ?? '')
  const pid = event.data?.pid as number ?? 0
  if (!isNetworkTool(command)) return

  pendingChecks.set(pid, { command, spawnedAt: event.timestamp, pid })

  if (!timer) {
    timer = setTimeout(runChecks, CHECK_DELAY_MS)
  }
}

function runChecks(): void {
  timer = null
  if (pendingChecks.size === 0) return

  const now = Date.now()
  const toCheck = [...pendingChecks.values()]
  pendingChecks.clear()

  const oldest = Math.min(...toCheck.map(c => c.spawnedAt))
  const scannerEvents = queryEvents({
    agentType: 'scanner',
    since: oldest - 1000,
    limit: 500,
    tier: 'logged'
  })

  for (const check of toCheck) {
    if (now - check.spawnedAt > LOOKBACK_MS + CHECK_DELAY_MS) continue

    const hasTraffic = scannerEvents.some(e => {
      const ts = e.timestamp
      return ts >= check.spawnedAt - 1000 && ts <= check.spawnedAt + CHECK_DELAY_MS + 5000
    })

    if (!hasTraffic && cfg) {
      try {
        const ev = insertEvent('system', {
          subtype: 'proxy_bypass_suspected',
          pid: check.pid,
          command: check.command.slice(0, 500),
          tool: extractBinary(check.command),
          description: `Network tool "${extractBinary(check.command)}" spawned (pid ${check.pid}) but no proxy traffic was observed`,
          spawned_at: check.spawnedAt
        }, { engagementId: cfg.engagementId, operatorId: cfg.operatorId })
        if (ev) eventBus.publish(ev)
      } catch { /* best-effort */ }
    }
  }
}

export function startProxyBypassDetector(config: { engagementId: string; operatorId: string }): void {
  cfg = config
  eventBus.on('event:process', onEvent)
}

export function stopProxyBypassDetector(): void {
  eventBus.removeListener('event:process', onEvent)
  if (timer) { clearTimeout(timer); timer = null }
  pendingChecks.clear()
  cfg = null
}
