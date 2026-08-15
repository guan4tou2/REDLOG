import { EventEmitter } from 'events'
import os from 'os'
import { Resolver } from 'dns/promises'
import { ipInCIDR } from './ip-match'
import type { Authority } from './authority'

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

/** The verdict vocabulary (`ALERT-ROLES.md` A.2). Three states could not encode
 *  the nine reachable cells of the combination matrix, so two of them lied:
 *  `presumed_safe` was reported as `safe` (an inference shown as a fact — the
 *  A-3 false green) and `off_profile` as `unknown` (an observed deviation shown
 *  as missing information). */
export type IPSafety = 'safe' | 'presumed_safe' | 'off_profile' | 'exposed' | 'unknown'

/** §3 tier per verdict (K1). `null` = the verdict makes no claim either way,
 *  which is what `unknown` means. This is what stops a surface from having to
 *  re-derive "is this an inference?" from the verdict name. */
export function verdictAuthority(v: IPSafety): Authority | null {
  if (v === 'presumed_safe') return 'inferred'
  if (v === 'unknown') return null
  return 'fact'
}

export interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  ipSafety: IPSafety
  lastCheck: number
  error: string | null
  /** True while a new address is being confirmed — the displayed one is the last stable read. */
  settling: boolean
  /** A-4 (G-A4): the INTERNAL address against the engagement's expected LAN
   *  segments. `internalIP` was collected and displayed but never judged, so a
   *  laptop that silently reassociated to a guest SSID mid-engagement looked
   *  exactly like one still on the client VLAN. Reuses `classifyIP` with the
   *  lan profile as the whitelist and no blacklist, so only three of the nine
   *  cells are reachable — `safe`, `off_profile`, `unknown`. There is
   *  deliberately no LAN blacklist: "this is my own segment" is what the
   *  profile already says, from the other direction. */
  lanSafety: IPSafety
  /** A-6: the current address matches both the whitelist and the blacklist.
   *  The verdict stays `exposed`; this surfaces the contradictory config. */
  listConflict: boolean
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

  // Declaring a whitelist declares an expectation, so being outside it is an
  // OBSERVED DEVIATION — a fact, not missing information. G-A1 stopped this
  // answering 'safe' (the VPN-dropped-onto-café-NAT false green); G-A2 stops it
  // answering 'unknown', which understated it into the same amber bucket as
  // "nothing is configured at all".
  if (cfg.whitelist.length > 0) {
    return cfg.whitelist.some((cidr) => ipInCIDR(ip, cidr)) ? 'safe' : 'off_profile'
  }

  // Blacklist-only mode: configured but unmatched. This is an INFERENCE — "not
  // obviously you" is not the same statement as "on the list you approved" —
  // and it used to be reported as plain `safe`, i.e. an inference wearing a
  // fact's solid green. It gets its own verdict so the UI can render it as the
  // qualified claim it is.
  if (cfg.blacklist.length > 0) return 'presumed_safe'
  return 'unknown'
}

/** A-6: the address is on BOTH lists. The verdict is `exposed` and that is
 *  correct — the blacklist wins — but the operator has a contradictory config
 *  they will never discover from a red badge that looks like every other red
 *  badge. Reported alongside the verdict rather than as one, because it says
 *  something about the CONFIG, not about where the operator is. */
export function hasListConflict(
  ip: string,
  cfg: { whitelist: string[]; blacklist: string[] }
): boolean {
  return (
    cfg.blacklist.some((cidr) => ipInCIDR(ip, cidr)) &&
    cfg.whitelist.some((cidr) => ipInCIDR(ip, cidr))
  )
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
  private lanProfile: string[] = []
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
    lanSafety: 'unknown',
    lastCheck: 0,
    error: null,
    settling: false,
    listConflict: false,
    consecutiveFailures: 0,
    stale: false
  }

  get status(): IPStatus {
    return { ...this._status }
  }

  configure(opts: {
    whitelist?: string[]
    blacklist?: string[]
    lanProfile?: string[]
    checkInterval?: number
    providers?: string[]
    confirmations?: number
    staleAfter?: number
    ipMode?: IPMode
  }): void {
    if (opts.whitelist) this.whitelist = opts.whitelist
    if (opts.blacklist) this.blacklist = opts.blacklist
    if (opts.lanProfile) this.lanProfile = opts.lanProfile
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

  /** Same classifier, different list. No LAN-specific verdict vocabulary — the
   *  doc predicted the whitelist machinery would serve this, and it does. */
  private classifyLan(ip: string | null): IPSafety {
    if (!ip) return 'unknown'
    return classifyIP(ip, { whitelist: this.lanProfile, blacklist: [] })
  }

  private conflict(ip: string): boolean {
    return hasListConflict(ip, { whitelist: this.whitelist, blacklist: this.blacklist })
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
          listConflict: this.conflict(externalIP),
          internalIP,
          lanSafety: this.classifyLan(internalIP),
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
            listConflict: this.conflict(externalIP),
            lanSafety: this.classifyLan(internalIP),
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
            lanSafety: this.classifyLan(internalIP),
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
      // The internal address is a LOCAL read of the network interfaces — it
      // does not depend on the lookup that just failed. `Promise.all` above
      // discards it along with the rejection, so re-read it here rather than
      // letting a dead internet blank out a fact we still have. It matters
      // more since G-A4: dropping off the client VLAN is MORE likely when the
      // network is misbehaving, which is exactly when the external poll fails.
      // `lanSafety` therefore never goes stale — nothing about it expired.
      const internalIP = getInternalIP()
      this._status = {
        ...this._status,
        ipSafety: stale ? 'unknown' : this._status.ipSafety,
        internalIP,
        lanSafety: this.classifyLan(internalIP),
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
