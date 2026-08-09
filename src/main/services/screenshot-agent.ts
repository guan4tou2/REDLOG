import { desktopCapturer, screen } from 'electron'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import { insertEvent } from '../../core/db/events'
import { eventBus } from '../../core/event-bus'
import { noteDbError } from '../../core/capture-health'
import { getProjectDir } from '../../core/db/index'

export class ScreenshotAgent {
  private lastHash = ''
  private engagementId = 'default'
  private operatorId = ''
  private quality = 85
  private intervalSec = 0
  private timer: ReturnType<typeof setInterval> | null = null
  // Perceptual hash of the last stored frame (dHash — 64-bit). SHA-256 catches
  // only byte-identical duplicates, which almost never trigger for a live
  // desktop (a moving mouse cursor / ticking clock changes the JPEG bytes even
  // when the operator sees no change). dHash compares an 8x8 downsampled
  // grayscale bitmap, so cursor/clock jitter falls under the threshold and
  // the frame is skipped — the .cast stream still has the raw bytes if
  // needed.
  private lastDHash: bigint | null = null
  // Hamming distance below which two frames count as visually identical. 5
  // out of 64 bits is empirically forgiving: mouse cursor moved but no window
  // changed = ~2-3, one line of new terminal output = ~6-10.
  private static readonly DHASH_SKIP_THRESHOLD = 5

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

  async captureNow(trigger: string, causeEventId?: string): Promise<string | null> {
    if (!this.operatorId) return null
    // Manual captures always land — user intent overrides pause.
    // Ambient triggers (periodic, idle) skip while recording is paused.
    if (trigger !== 'manual' && eventBus.paused) return null
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

      if (trigger !== 'manual') {
        // First-pass exact-bytes dedup (rare hit, but zero-cost).
        if (dedupKey === this.lastHash) return null
        // Perceptual dedup — only for automatic triggers (periodic / idle).
        // Manual captures always land regardless of similarity.
        const dHash = this.computeDHash(image)
        if (this.lastDHash != null) {
          const dist = ScreenshotAgent.hammingDistance(dHash, this.lastDHash)
          if (dist < ScreenshotAgent.DHASH_SKIP_THRESHOLD) return null
        }
        this.lastDHash = dHash
      }
      this.lastHash = dedupKey

      const dir = path.join(getProjectDir(), 'screenshots')
      fs.mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `${ts}_${trigger}.jpg`
      const filepath = path.join(dir, filename)
      // v0.6.97 D: 4K JPEGs at quality=80 land 800KB-1.5MB — writeFileSync
      // blocks the main thread for 5-15ms per shot (measured on APFS SSD).
      // With the 10s periodic timer that's not visible, but a burst (idle
      // trigger + marker + manual back-to-back) stacks into a jank spike.
      // fs.promises.writeFile off-loads the syscall to libuv's thread pool.
      await fs.promises.writeFile(filepath, jpeg)

      const evt = insertEvent('screenshot', {
        trigger,
        filePath: filepath,
        filename,
        size: jpeg.length,
        width,
        height,
        sha256,
        hash: dedupKey,
        // v0.6.89 `_causes`: EventMarker (⌘⇧M) passes the marker event id so
        // focus chain walks link marker→screenshot→(later screenshot_deleted).
        ...(causeEventId ? { _causes: [causeEventId] } : {})
        // v0.9.5: the pause gate now lives in insertEvent, so the local
        // ambient-vs-manual check above needs to carry through to it —
        // otherwise a manual capture while paused writes the JPEG to disk and
        // then silently drops its event row, leaving an orphan file.
      }, {
        engagementId: this.engagementId,
        operatorId: this.operatorId,
        bypassPause: trigger === 'manual'
      })
      if (evt) eventBus.publish(evt, { bypassPause: trigger === 'manual' })

      return filepath
    } catch (e) {
      // Screenshot capture failure — forward to capture-health so a persistent
      // failure (permission denied / disk full / display asleep) surfaces on
      // StatusBar rather than silently swallowing (v0.6.86).
      noteDbError('screenshot', e)
      return null
    }
  }

  // dHash (difference hash) — compare each pixel against its right-hand
  // neighbor in an 8x9 grayscale downsample, produce a 64-bit signature.
  // Small visual changes (mouse cursor, one-line terminal scroll) shift a
  // handful of bits; a whole new window shifts dozens. Cheap enough to run
  // every tick even at 30s cadence.
  private computeDHash(image: Electron.NativeImage): bigint {
    // resize returns a fresh nativeImage; toBitmap returns BGRA row-major.
    const small = image.resize({ width: 9, height: 8, quality: 'good' })
    const buf = small.toBitmap()
    // Build a hash by walking each row and comparing pixel i to pixel i+1.
    // Result: 8 rows × 8 bits = 64 bits total.
    let hash = 0n
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const i = (row * 9 + col) * 4
        const j = (row * 9 + col + 1) * 4
        // Sum-of-channels stand-in for luminance — perfect luma would use
        // 0.299R + 0.587G + 0.114B, but for a difference comparison the
        // exact weighting doesn't matter.
        const a = buf[i] + buf[i + 1] + buf[i + 2]
        const b = buf[j] + buf[j + 1] + buf[j + 2]
        hash = (hash << 1n) | (a > b ? 1n : 0n)
      }
    }
    return hash
  }

  private static hammingDistance(a: bigint, b: bigint): number {
    let x = a ^ b
    let count = 0
    while (x > 0n) {
      count += Number(x & 1n)
      x >>= 1n
    }
    return count
  }
}
