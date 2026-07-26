import { clipboard } from 'electron'
import crypto from 'crypto'
import { insertEvent } from '../db/events'
import { eventBus } from './event-bus'

export class ClipboardMonitor {
  private interval: ReturnType<typeof setInterval> | null = null
  private lastHash = ''
  private engagementId = 'default'
  private operatorId = 'operator-1'
  private excludeWindows: string[] = []
  private _paused = false
  private redactPatterns: RegExp[] = [
    /(?:password|passwd|pwd)[\s:=]+\S+/gi,
    /(?:api[_-]?key|token|secret|bearer)[\s:=]+\S+/gi,
    /-----BEGIN [\w\s]+ PRIVATE KEY-----/g
  ]

  get paused(): boolean { return this._paused }
  set paused(v: boolean) { this._paused = v }

  configure(opts: { engagementId?: string; operatorId?: string; redactPatterns?: string[]; excludeWindows?: string[] }): void {
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
    if (opts.redactPatterns) {
      this.redactPatterns = opts.redactPatterns.map((p) => new RegExp(p, 'gi'))
    }
    if (opts.excludeWindows) this.excludeWindows = opts.excludeWindows
  }

  start(): void {
    this.lastHash = this.hashContent(clipboard.readText())
    this.interval = setInterval(() => this.check(), 200)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private check(): void {
    if (this._paused) return

    const text = clipboard.readText()
    const hash = this.hashContent(text)
    if (hash === this.lastHash) return
    this.lastHash = hash

    if (!text || text.length === 0) return

    const redacted = this.redact(text)
    const truncated = redacted.length > 10240
    const content = truncated ? redacted.slice(0, 10240) : redacted

    const evt = insertEvent('clipboard', {
      content,
      contentLength: text.length,
      truncated,
      contentHash: hash
    }, { engagementId: this.engagementId, operatorId: this.operatorId })
    eventBus.publish(evt)
  }

  private redact(text: string): string {
    let result = text
    for (const pattern of this.redactPatterns) {
      result = result.replace(pattern, '[REDACTED]')
    }
    return result
  }

  private hashContent(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
  }
}
