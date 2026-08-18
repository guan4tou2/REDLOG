// IPSignalProducer — Self alarm producer.
//
// Polls the operator's external egress address on a fixed cadence and
// dispatches an `IPChangeSignal` when the address changes (or on the
// first successful poll). Classification is NOT this producer's job —
// it hands the raw observation to the AlertBus and the IPPolicy decides
// safe/exposed/off_profile/etc.
//
// The producer holds two pieces of state that don't belong on the bus:
//   • the last stable address (so a re-poll returning the same value
//     doesn't re-emit — the bus's IPPolicy also dedups, but doing it here
//     saves the per-tick round trip)
//   • the N-in-a-row confirmation counter for a NEW candidate address
//     (CGNAT and load-balanced VPN pools return a different address from
//     one poll to the next; the confirmation window keeps the badge from
//     flickering safe↔exposed on every read)
//
// Fetch strategy is the same as the retired ip-monitor.ts — DNS lookup
// against OpenDNS/Google's resolver-facing hosts (quieter on the wire,
// immune to public IP-echo rate limits), HTTP fallback for networks that
// block the outbound DNS.

import os from 'os'
import { Resolver } from 'dns/promises'
import type { AlertBus, IPChangeSignal } from '../../../core/alert'

export type IPMode = 'dns' | 'http' | 'auto'

const DNS_LOOKUPS: Array<{ server: string; host: string; type: 'A' | 'TXT' }> = [
  { server: '208.67.222.222', host: 'myip.opendns.com', type: 'A' },
  { server: '216.239.32.10', host: 'o-o.myaddr.l.google.com', type: 'TXT' }
]

const DEFAULT_IP_PROVIDERS = [
  'https://api.ipify.org?format=json',
  'https://ipinfo.io/json',
  'https://api.my-ip.io/v2/ip.json'
]

const DEFAULT_CONFIRMATIONS = 3

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
    } catch { /* try next */ }
  }
  throw new Error('All DNS resolvers failed')
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
    } catch { /* try next */ }
  }
  throw new Error('All IP providers failed')
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
        if (iface.address.startsWith('169.254.')) continue  // link-local
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

export interface IPProducerConfig {
  checkIntervalSec: number
  providers: string[]
  confirmations: number
  ipMode: IPMode
}

const DEFAULT_CONFIG: IPProducerConfig = {
  checkIntervalSec: 10,
  providers: [...DEFAULT_IP_PROVIDERS],
  confirmations: DEFAULT_CONFIRMATIONS,
  ipMode: 'auto'
}

/** Live state the producer exposes to callers that need to render "what's
 *  the badge saying right now?" — e.g. the compat `ip:getStatus` IPC. This
 *  is redundant with what BadgeSurface holds; the producer maintains it
 *  because BadgeSurface only sees emitted verdicts, not the raw address /
 *  internal IP / last-error text. */
export interface IPProducerState {
  external: string | null   // stable value; a settling candidate does NOT overwrite this
  internal: string | null
  lastCheck: number
  error: string | null
  settling: boolean
  stale: boolean            // last check errored — verdict should decay to unknown
  link: { type: 'wifi' | 'wired' | 'unknown'; name: string }
}

export class IPSignalProducer {
  readonly name = 'ip-signal-producer'
  private cfg: IPProducerConfig = { ...DEFAULT_CONFIG }
  private timer: ReturnType<typeof setInterval> | null = null
  private pendingIP: string | null = null
  private pendingCount = 0
  private state: IPProducerState = {
    external: null,
    internal: null,
    lastCheck: 0,
    error: null,
    settling: false,
    stale: false,
    link: { type: 'unknown', name: '' }
  }
  private checking = false
  /** Fired after every check completes — even when the address didn't
   *  change. Main subscribes so the StatusBar/HUD `ip:status` push still
   *  fires when only `lastCheck`/`link` shifts (which the badge doesn't
   *  care about, but the UI does). */
  private stateListeners = new Set<(s: IPProducerState) => void>()

  constructor(private bus: AlertBus) {}

  onCheck(fn: (s: IPProducerState) => void): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  configure(next: Partial<IPProducerConfig>): void {
    if (typeof next.checkIntervalSec === 'number' && next.checkIntervalSec > 0) {
      this.cfg.checkIntervalSec = next.checkIntervalSec
    }
    if (next.providers?.length) this.cfg.providers = next.providers
    if (typeof next.confirmations === 'number' && next.confirmations > 0) {
      this.cfg.confirmations = next.confirmations
    }
    if (next.ipMode) this.cfg.ipMode = next.ipMode
    // Re-arm the timer if it's running so the new interval takes effect.
    if (this.timer) { this.stop(); this.start() }
  }

  setLink(link: IPProducerState['link']): void {
    this.state.link = link
  }

  getState(): IPProducerState {
    return { ...this.state }
  }

  start(): void {
    void this.check()
    this.timer = setInterval(() => { void this.check() }, this.cfg.checkIntervalSec * 1000)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private fetchExternalIP(): Promise<string> {
    if (this.cfg.ipMode === 'dns') return getExternalIPviaDNS()
    if (this.cfg.ipMode === 'http') return getExternalIPviaHTTP(this.cfg.providers)
    return getExternalIPviaDNS().catch(() => getExternalIPviaHTTP(this.cfg.providers))
  }

  private async check(): Promise<void> {
    if (this.checking) return
    this.checking = true
    let external: string | null = null
    let error: string | null = null
    try {
      external = await this.fetchExternalIP()
    } catch (err) {
      error = err instanceof Error ? err.message : 'unknown IP fetch error'
    }
    const internal = getInternalIP()
    const now = Date.now()

    if (error) {
      // Stale read — keep last stable external. Producers don't classify —
      // IPPolicy sees `stale: true` and returns `unknown`.
      this.state = { ...this.state, internal, lastCheck: now, error, settling: false, stale: true }
    } else {
      const settled = this.state.external
      if (external === settled) {
        // Same address as the stable value — drop any half-confirmed candidate.
        this.pendingIP = null
        this.pendingCount = 0
        this.state = { ...this.state, internal, lastCheck: now, error: null, settling: false, stale: false }
      } else {
        // Different. Confirm N-in-a-row before promoting.
        this.pendingCount = external === this.pendingIP ? this.pendingCount + 1 : 1
        this.pendingIP = external
        const promote = settled === null || this.pendingCount >= this.cfg.confirmations
        if (promote) {
          this.pendingIP = null
          this.pendingCount = 0
          this.state = {
            external, internal, lastCheck: now,
            error: null, settling: false, stale: false,
            link: this.state.link
          }
        } else {
          // Keep the stable external in state — the badge doesn't flicker.
          // `settling: true` tells IPPolicy to add the modifier without
          // changing the base verdict.
          this.state = { ...this.state, internal, lastCheck: now, error: null, settling: true, stale: false }
        }
      }
    }
    // Emit every tick — IPPolicy dedups verdicts, so an unchanged address
    // costs one bus.dispatch + one policy no-op. The per-tick emit is
    // what lets the StatusBar/HUD refresh `lastCheck`/`link` without a
    // separate polling loop.
    this.dispatch()
    this.checking = false
  }

  private dispatch(): void {
    const signal: IPChangeSignal = {
      kind: 'ip_change',
      timestamp: this.state.lastCheck,
      external: this.state.external,
      internal: this.state.internal,
      settling: this.state.settling,
      stale: this.state.stale,
      link: this.state.link
    }
    this.bus.dispatch(signal)
    for (const l of this.stateListeners) {
      try { l(this.state) } catch { /* listener bug — drop */ }
    }
  }
}
