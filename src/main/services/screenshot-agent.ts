import { desktopCapturer, screen } from 'electron'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { insertEvent } from '../db/events'
import { eventBus } from './event-bus'
import { getProjectDir } from '../db/index'

export class ScreenshotAgent {
  private interval: ReturnType<typeof setInterval> | null = null
  private lastHash = ''
  private engagementId = 'default'
  private operatorId = 'operator-1'
  private idleDelay = 3000
  private minInterval = 1000
  private lastCapture = 0
  private quality = 85

  configure(opts: {
    engagementId?: string
    operatorId?: string
    idleDelay?: number
    quality?: number
  }): void {
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
    if (opts.idleDelay) this.idleDelay = opts.idleDelay * 1000
    if (opts.quality) this.quality = opts.quality
  }

  start(): void {
    this.interval = setInterval(() => this.maybeCapture(), 2000)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  async captureNow(trigger: string): Promise<string | null> {
    return this.capture(trigger)
  }

  private async maybeCapture(): Promise<void> {
    const now = Date.now()
    if (now - this.lastCapture < this.minInterval) return

    const { powerMonitor } = await import('electron')
    const idleTime = powerMonitor.getSystemIdleTime()
    if (idleTime * 1000 < this.idleDelay) return

    await this.capture('idle')
  }

  private async capture(trigger: string): Promise<string | null> {
    try {
      const display = screen.getPrimaryDisplay()
      const { width, height } = display.size

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height }
      })
      if (!sources.length) return null

      const image = sources[0].thumbnail
      const jpeg = image.toJPEG(this.quality)

      const hash = crypto.createHash('sha256').update(jpeg).digest('hex').slice(0, 16)
      if (hash === this.lastHash) return null
      this.lastHash = hash
      this.lastCapture = Date.now()

      const dir = path.join(getProjectDir(), 'screenshots')
      fs.mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `${ts}_${trigger}.jpg`
      const filepath = path.join(dir, filename)
      fs.writeFileSync(filepath, jpeg)

      const evt = insertEvent('screenshot', {
        trigger,
        path: filepath,
        filename,
        size: jpeg.length,
        width,
        height,
        hash
      }, { engagementId: this.engagementId, operatorId: this.operatorId })
      eventBus.publish(evt)

      return filepath
    } catch {
      return null
    }
  }
}
