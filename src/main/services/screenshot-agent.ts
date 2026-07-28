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
