import { EventEmitter } from 'events'
import os from 'os'

export interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  ipSafety: 'safe' | 'exposed' | 'unknown'
  lastCheck: number
  error: string | null
}

const IP_PROVIDERS = [
  'https://api.ipify.org?format=json',
  'https://ipinfo.io/json',
  'https://api.my-ip.io/v2/ip.json'
]

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

async function getExternalIP(): Promise<string> {
  for (const url of IP_PROVIDERS) {
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
  private safeIPs: string[] = []
  private exposedIPs: string[] = []
  private checkIntervalMs = 10_000
  private _status: IPStatus = {
    externalIP: null,
    internalIP: null,
    ipSafety: 'unknown',
    lastCheck: 0,
    error: null
  }

  get status(): IPStatus {
    return { ...this._status }
  }

  configure(opts: { safeIPs?: string[]; exposedIPs?: string[]; checkInterval?: number }): void {
    if (opts.safeIPs) this.safeIPs = opts.safeIPs
    if (opts.exposedIPs) this.exposedIPs = opts.exposedIPs
    if (opts.checkInterval) this.checkIntervalMs = opts.checkInterval * 1000
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
        getExternalIP(),
        Promise.resolve(getInternalIP())
      ])

      let ipSafety: IPStatus['ipSafety'] = 'unknown'
      if (this.safeIPs.length > 0 && this.safeIPs.some((cidr) => ipInCIDR(externalIP, cidr))) {
        ipSafety = 'safe'
      } else if (this.exposedIPs.length > 0 && this.exposedIPs.some((cidr) => ipInCIDR(externalIP, cidr))) {
        ipSafety = 'exposed'
      } else if (this.safeIPs.length > 0 || this.exposedIPs.length > 0) {
        ipSafety = 'unknown'
      }

      this._status = {
        externalIP,
        internalIP,
        ipSafety,
        lastCheck: Date.now(),
        error: null
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
