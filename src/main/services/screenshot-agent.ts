import { desktopCapturer, screen } from 'electron'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { insertEvent } from '../db/events'
import { eventBus } from './event-bus'
import { getProjectDir } from '../db/index'

export class ScreenshotAgent {
  private lastHash = ''
  private engagementId = 'default'
  private operatorId = 'operator-1'
  private quality = 85

  configure(opts: {
    engagementId?: string
    operatorId?: string
    quality?: number
  }): void {
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
    if (opts.quality) this.quality = opts.quality
  }

  async captureNow(trigger: string): Promise<string | null> {
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
      const jpegHash = crypto.createHash('sha256').update(jpeg).digest('hex').slice(0, 16)

      if (trigger !== 'manual' && jpegHash === this.lastHash) return null
      this.lastHash = jpegHash

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
        hash: jpegHash
      }, { engagementId: this.engagementId, operatorId: this.operatorId })
      eventBus.publish(evt)

      return filepath
    } catch {
      return null
    }
  }
}
