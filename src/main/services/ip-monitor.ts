import { EventEmitter } from 'events'
import os from 'os'
import { lookupIP, GeoResult } from './geoip'

export interface IPStatus {
  externalIP: string | null
  internalIP: string | null
  vpnStatus: 'connected' | 'disconnected' | 'unknown'
  lastCheck: number
  error: string | null
  geo: GeoResult | null
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
  private vpnIPs: string[] = []
  private dailyIPs: string[] = []
  private checkIntervalMs = 10_000
  private expectedCountry: string | null = null
  private emergencyPause = false
  private _paused = false
  private _status: IPStatus = {
    externalIP: null,
    internalIP: null,
    vpnStatus: 'unknown',
    lastCheck: 0,
    error: null,
    geo: null
  }

  get status(): IPStatus {
    return { ...this._status }
  }

  get isPaused(): boolean {
    return this._paused
  }

  configure(opts: { vpnIPs?: string[]; dailyIPs?: string[]; checkInterval?: number; expectedCountry?: string | null; emergencyPause?: boolean }): void {
    if (opts.vpnIPs) this.vpnIPs = opts.vpnIPs
    if (opts.dailyIPs) this.dailyIPs = opts.dailyIPs
    if (opts.checkInterval) this.checkIntervalMs = opts.checkInterval * 1000
    if (opts.expectedCountry !== undefined) this.expectedCountry = opts.expectedCountry
    if (opts.emergencyPause !== undefined) this.emergencyPause = opts.emergencyPause
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

      let vpnStatus: IPStatus['vpnStatus'] = 'unknown'
      if (this.vpnIPs.length > 0 && this.vpnIPs.some((cidr) => ipInCIDR(externalIP, cidr))) {
        vpnStatus = 'connected'
      } else if (this.dailyIPs.length > 0 && this.dailyIPs.some((cidr) => ipInCIDR(externalIP, cidr))) {
        vpnStatus = 'disconnected'
      } else if (this.vpnIPs.length > 0 || this.dailyIPs.length > 0) {
        vpnStatus = 'unknown'
      }

      let geo: GeoResult | null = null
      try {
        geo = await lookupIP(externalIP, this.expectedCountry)
      } catch { /* geoip not available */ }

      this._status = {
        externalIP,
        internalIP,
        vpnStatus,
        lastCheck: Date.now(),
        error: null,
        geo
      }

      if (this.emergencyPause && vpnStatus === 'disconnected' && !this._paused) {
        this._paused = true
        this.emit('emergency-pause', this._status)
      } else if (vpnStatus === 'connected' && this._paused) {
        this._paused = false
        this.emit('emergency-resume', this._status)
      }
    } catch (err) {
      this._status = {
        ...this._status,
        lastCheck: Date.now(),
        error: err instanceof Error ? err.message : 'Unknown error',
        geo: null
      }
    }
    this.emit('status', this._status)
  }
}
