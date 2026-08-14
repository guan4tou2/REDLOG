import { EventEmitter } from 'events'
import os from 'os'
import { Resolver } from 'dns/promises'
import { ipInCIDR } from './ip-match'

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

export type IPSafety = 'safe' | 'exposed' | 'unknown'

export interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  ipSafety: IPSafety
  lastCheck: number
  error: string | null
  /** True while a new address is being confirmed — the displayed one is the last stable read. */
  settling: boolean
  /** Consecutive failed reads. Reset to 0 by any success. */
  consecutiveFailures: number
  /** The verdict is no longer backed by a current reading: `consecutiveFailures`
   *  reached `staleAfter`, so `ipSafety` has decayed to 'unknown'. The displayed
   *  address is still the last known one. */
  stale: boolean
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

// A verdict outliving the reading it was based on is the same class of lie as the
// A-9 false green: a VPN kill-switch dropping the network is EXACTLY when the
// external-IP lookup starts failing, and until now the badge kept showing the
// last verdict — often green — indefinitely, with only `lastCheck` moving.
//
// Why 2 and not 3, matching `confirmations`: the two thresholds look alike but
// point opposite ways. Being SLOW to promote a new address is safe — you keep
// showing a verdict you verified. Being slow to expire an old one is not: you
// keep showing a verdict you can no longer stand behind. So the decay threshold
// is deliberately tighter than the promotion threshold. One failure can be a
// single provider hiccup; two in a row at the shipped 60s poll means two
// minutes of no contact, which is not a blip.
const DEFAULT_STALE_AFTER = 2

/** Pure IP classification — no side effects, the test seam for the verdict
 *  combination matrix (`ALERT-ROLES.md` Part A). `IPMonitor.classify()` is a
 *  thin delegate; this is the sibling of `scope-monitor.ts` `classifyTarget()`. */
export function classifyIP(
  ip: string,
  cfg: { whitelist: string[]; blacklist: string[] }
): IPSafety {
  // Blacklist (your own IP) wins: seeing it means your real identity is
  // leaking, which is the alert that must never be masked by a whitelist hit.
  if (cfg.blacklist.length > 0 && cfg.blacklist.some((cidr) => ipInCIDR(ip, cidr))) return 'exposed'

  // Declaring a whitelist declares an expectation. Being outside it is never
  // 'safe' — not even when a blacklist is also configured and this address
  // happens to miss it. That fall-through (G-A1) reported the VPN-dropped-onto-
  // café-NAT case as solid green SAFE: whitelist 10.8.0.0/24, blacklist
  // 1.2.3.4 (home), egress 5.6.7.8 — matches neither, yet answered 'safe'.
  // RedLog never blocks, so a wrong green has nothing downstream to catch it.
  if (cfg.whitelist.length > 0) {
    return cfg.whitelist.some((cidr) => ipInCIDR(ip, cidr)) ? 'safe' : 'unknown'
  }

  // Blacklist-only mode: configured but unmatched → behind VPN/tunnel → safe.
  // Strictly this is an inference ("not obviously you"), not an observation;
  // giving it its own verdict is G-A2.
  if (cfg.blacklist.length > 0) return 'safe'
  return 'unknown'
}

function getInternalIP(): string | null {
  const interfaces = os.networkInterfaces()
  let v6Fallback: string | null = null
  let v4Fallback: string | null = null
  const VIRTUAL_RE = /vmware|virtualbox|vbox|hyper-v|docker|veth|br-|virbr/i
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.internal) continue
      if (iface.family === 'IPv4') {
        // Skip link-local (169.254.x.x) — means the adapter has no real connection
        if (iface.address.startsWith('169.254.')) continue
        // Skip virtual adapters — they're not the real egress
        if (VIRTUAL_RE.test(name)) {
          if (!v4Fallback) v4Fallback = iface.address
          continue
        }
        return iface.address
      }
      if (iface.family === 'IPv6' && !iface.address.startsWith('fe80') && !v6Fallback) {
        v6Fallback = iface.address
      }
    }
  }
  return v4Fallback ?? v6Fallback
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
  private staleAfter = DEFAULT_STALE_AFTER
  private ipMode: IPMode = 'auto'
  private pendingIP: string | null = null
  private pendingCount = 0
  private _status: IPStatus = {
    externalIP: null,
    internalIP: null,
    ipSafety: 'unknown',
    lastCheck: 0,
    error: null,
    settling: false,
    consecutiveFailures: 0,
    stale: false
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
    staleAfter?: number
    ipMode?: IPMode
  }): void {
    if (opts.whitelist) this.whitelist = opts.whitelist
    if (opts.blacklist) this.blacklist = opts.blacklist
    if (opts.checkInterval) this.checkIntervalMs = opts.checkInterval * 1000
    if (opts.providers?.length) this.providers = opts.providers
    if (typeof opts.confirmations === 'number' && opts.confirmations > 0) {
      this.confirmations = opts.confirmations
    }
    if (typeof opts.staleAfter === 'number' && opts.staleAfter > 0) {
      this.staleAfter = Math.floor(opts.staleAfter)
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

  private classify(ip: string): IPSafety {
    return classifyIP(ip, { whitelist: this.whitelist, blacklist: this.blacklist })
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

  private checking = false

  private async check(): Promise<void> {
    if (this.checking) return
    this.checking = true
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
        // Re-classify even though the address is unchanged. Two ways this
        // branch used to strand a wrong verdict: (1) a stale decay to 'unknown'
        // never recovered if the network came back on the SAME exit IP — the
        // common case for a VPN blip; (2) editing the safe/exposed lists in
        // Settings did not move the badge until the address happened to change.
        // The verdict is a pure function of (address, lists), so derive it.
        this._status = {
          ...this._status,
          ipSafety: this.classify(externalIP),
          internalIP,
          lastCheck: Date.now(),
          error: null,
          settling: false,
          consecutiveFailures: 0,
          stale: false
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
            settling: false,
            consecutiveFailures: 0,
            stale: false
          }
        } else {
          // Keep showing the last stable address, but say we're unsure.
          this._status = {
            ...this._status,
            internalIP,
            lastCheck: Date.now(),
            error: null,
            settling: true,
            consecutiveFailures: 0,
            stale: false
          }
        }
      }
    } catch (err) {
      // G-A3. The decay is uniform: an `exposed` verdict decays too. Holding a
      // red alarm on a reading we can no longer confirm is the same dishonesty
      // as holding a green one — 'unknown' is what we actually know. The last
      // seen address stays on screen so nothing is lost, only re-labelled.
      const consecutiveFailures = this._status.consecutiveFailures + 1
      const stale = consecutiveFailures >= this.staleAfter
      this._status = {
        ...this._status,
        ipSafety: stale ? 'unknown' : this._status.ipSafety,
        lastCheck: Date.now(),
        error: err instanceof Error ? err.message : 'Unknown error',
        consecutiveFailures,
        stale
      }
    } finally {
      this.checking = false
    }
    this.emit('status', this._status)
  }
}
