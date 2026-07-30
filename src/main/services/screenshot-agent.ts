import { desktopCapturer, screen } from 'electron'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'
import { getProjectDir } from '../../core/db/index'

export class ScreenshotAgent {
  private lastHash = ''
  private engagementId = 'default'
  private operatorId = ''
  private quality = 85
  private intervalSec = 0
  private timer: ReturnType<typeof setInterval> | null = null

  configure(opts: {
    engagementId?: string
    operatorId?: string
    quality?: number
    intervalSec?: number
  }): void {
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
    if (opts.quality) this.quality = opts.quality
    if (opts.intervalSec !== undefined) {
      this.intervalSec = Math.max(0, Math.floor(opts.intervalSec))
      this.applyInterval()
    }
  }

  // Start / stop the periodic loop when settings change. Called on configure
  // and on start/stop; safe to call multiple times. `captureNow('periodic')`
  // stays deduped against lastHash, so an idle screen won't fill the chain.
  private applyInterval(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.intervalSec > 0 && this.operatorId) {
      this.timer = setInterval(() => {
        this.captureNow('periodic').catch(() => { /* transient failure — retry next tick */ })
      }, this.intervalSec * 1000)
    }
  }

  start(): void { this.applyInterval() }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  async captureNow(trigger: string): Promise<string | null> {
    if (!this.operatorId) return null
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
      const sha256 = crypto.createHash('sha256').update(jpeg).digest('hex')
      const dedupKey = sha256.slice(0, 16)

      if (trigger !== 'manual' && dedupKey === this.lastHash) return null
      this.lastHash = dedupKey

      const dir = path.join(getProjectDir(), 'screenshots')
      fs.mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `${ts}_${trigger}.jpg`
      const filepath = path.join(dir, filename)
      fs.writeFileSync(filepath, jpeg)

      const evt = insertEvent('screenshot', {
        trigger,
        filePath: filepath,
        filename,
        size: jpeg.length,
        width,
        height,
        sha256,
        hash: dedupKey
      }, { engagementId: this.engagementId, operatorId: this.operatorId })
      if (evt) eventBus.publish(evt)

      return filepath
    } catch {
      return null
    }
  }
}
