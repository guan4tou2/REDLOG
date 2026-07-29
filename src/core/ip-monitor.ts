import { EventEmitter } from 'events'
import os from 'os'
import { Resolver } from 'dns/promises'

export type IPMode = 'dns' | 'http' | 'auto'

// DNS-based external-IP lookup — quieter on the wire than an HTTP GET and
// effectively immune to the rate limits public IP-echo services impose. Queries
// the resolver DIRECTLY (bypassing system DNS), so restrictive networks can
// block it — that's why 'auto' falls back to HTTP.
const DNS_LOOKUPS: Array<{ server: string; host: string; type: 'A' | 'TXT' }> = [
  { server: '208.67.222.222', host: 'myip.opendns.com', type: 'A' },          // OpenDNS resolver1
  { server: '216.239.32.10', host: 'o-o.myaddr.l.google.com', type: 'TXT' }   // Google ns1
]

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

async function getExternalIPviaDNS(): Promise<string> {
  for (const q of DNS_LOOKUPS) {
    try {
      const resolver = new Resolver({ timeout: 3000, tries: 1 })
      resolver.setServers([q.server])
      if (q.type === 'A') {
        const ips = await resolver.resolve4(q.host)
        const ip = ips.find((s) => IPV4_RE.test(s))
        if (ip) return ip
      } else {
        const rows = await resolver.resolveTxt(q.host)
        const ip = rows?.[0]?.join('').replace(/"/g, '').trim()
        if (ip && IPV4_RE.test(ip)) return ip
      }
    } catch { /* try the next resolver */ }
  }
  throw new Error('All DNS resolvers failed')
}

export interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  ipSafety: 'safe' | 'exposed' | 'unknown'
  lastCheck: number
  error: string | null
  /** True while a new address is being confirmed — the displayed one is the last stable read. */
  settling: boolean
  /** active link: Wi-Fi SSID or wired (populated by main, not the monitor) */
  link?: { type: 'wifi' | 'wired' | 'unknown'; name: string }
}

const DEFAULT_IP_PROVIDERS = [
  'https://api.ipify.org?format=json',
  'https://ipinfo.io/json',
  'https://api.my-ip.io/v2/ip.json'
]

// Egress behind CGNAT or a load-balanced pool answers with a different address
// from one poll to the next. Reporting each read straight to the UI makes the
// safety badge flicker between SAFE and EXPOSED, which is the one thing an
// operator has to be able to trust at a glance. Hold a new address until it has
// been seen this many times in a row.
const DEFAULT_CONFIRMATIONS = 3

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0
}

function ipInCIDR(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr
  const [network, bits] = cidr.split('/')
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0
  return (ipToLong(ip) & mask) === (ipToLong(network) & mask)
}

function getInternalIP(): string | null {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return null
}

async function getExternalIPviaHTTP(providers: string[]): Promise<string> {
  for (const url of providers) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)
      if (!res.ok) continue
      const data = await res.json()
      return data.ip ?? data.origin ?? String(data)
    } catch {
      continue
    }
  }
  throw new Error('All IP providers failed')
}

export class IPMonitor extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null
  private whitelist: string[] = []
  private blacklist: string[] = []
  private checkIntervalMs = 10_000
  private providers: string[] = [...DEFAULT_IP_PROVIDERS]
  private confirmations = DEFAULT_CONFIRMATIONS
  private ipMode: IPMode = 'auto'
  private pendingIP: string | null = null
  private pendingCount = 0
  private _status: IPStatus = {
    externalIP: null,
    internalIP: null,
    ipSafety: 'unknown',
    lastCheck: 0,
    error: null,
    settling: false
  }

  get status(): IPStatus {
    return { ...this._status }
  }

  configure(opts: {
    whitelist?: string[]
    blacklist?: string[]
    checkInterval?: number
    providers?: string[]
    confirmations?: number
    ipMode?: IPMode
  }): void {
    if (opts.whitelist) this.whitelist = opts.whitelist
    if (opts.blacklist) this.blacklist = opts.blacklist
    if (opts.checkInterval) this.checkIntervalMs = opts.checkInterval * 1000
    if (opts.providers?.length) this.providers = opts.providers
    if (typeof opts.confirmations === 'number' && opts.confirmations > 0) {
      this.confirmations = opts.confirmations
    }
    if (opts.ipMode) this.ipMode = opts.ipMode
  }

  // Fetch the external IP per the configured mode. 'auto' prefers the quiet DNS
  // path and only falls back to HTTP when DNS is unavailable/blocked.
  private fetchExternalIP(): Promise<string> {
    if (this.ipMode === 'dns') return getExternalIPviaDNS()
    if (this.ipMode === 'http') return getExternalIPviaHTTP(this.providers)
    return getExternalIPviaDNS().catch(() => getExternalIPviaHTTP(this.providers))
  }

  private classify(ip: string): IPStatus['ipSafety'] {
    // Blacklist (your own IP) wins: seeing it means your real identity is
    // leaking, which is the alert that must never be masked by a whitelist hit.
    if (this.blacklist.length > 0 && this.blacklist.some((cidr) => ipInCIDR(ip, cidr))) return 'exposed'
    if (this.whitelist.length > 0 && this.whitelist.some((cidr) => ipInCIDR(ip, cidr))) return 'safe'
    // Blacklist mode: blacklist configured but IP didn't match → behind VPN/tunnel → safe
    if (this.blacklist.length > 0) return 'safe'
    return 'unknown'
  }

  start(): void {
    this.check()
    this.interval = setInterval(() => this.check(), this.checkIntervalMs)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async check(): Promise<void> {
    try {
      const [externalIP, internalIP] = await Promise.all([
        this.fetchExternalIP(),
        Promise.resolve(getInternalIP())
      ])

      const settled = this._status.externalIP
      if (externalIP === settled) {
        // Still on the known address — drop any half-confirmed candidate.
        this.pendingIP = null
        this.pendingCount = 0
        this._status = {
          ...this._status,
          internalIP,
          lastCheck: Date.now(),
          error: null,
          settling: false
        }
      } else {
        this.pendingCount = externalIP === this.pendingIP ? this.pendingCount + 1 : 1
        this.pendingIP = externalIP

        // The very first reading has nothing to flap against, so take it as-is.
        const promote = settled === null || this.pendingCount >= this.confirmations
        if (promote) {
          this.pendingIP = null
          this.pendingCount = 0
          this._status = {
            externalIP,
            internalIP,
            ipSafety: this.classify(externalIP),
            lastCheck: Date.now(),
            error: null,
            settling: false
          }
        } else {
          // Keep showing the last stable address, but say we're unsure.
          this._status = {
            ...this._status,
            internalIP,
            lastCheck: Date.now(),
            error: null,
            settling: true
          }
        }
      }
    } catch (err) {
      this._status = {
        ...this._status,
        lastCheck: Date.now(),
        error: err instanceof Error ? err.message : 'Unknown error'
      }
    }
    this.emit('status', this._status)
  }
}
