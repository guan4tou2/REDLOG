import { EventEmitter } from 'events'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { insertEvent } from '../db/events'
import { eventBus } from './event-bus'

export class FileTransferTracker extends EventEmitter {
  private watchers: fs.FSWatcher[] = []
  private engagementId = 'default'
  private operatorId = 'operator-1'
  private watchDirs: string[] = []
  private alertThreshold = 52428800 // 50MB
  private seenFiles = new Set<string>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  configure(opts: {
    engagementId?: string
    operatorId?: string
    watchDirs?: string[]
    alertThreshold?: number
  }): void {
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
    if (opts.watchDirs) this.watchDirs = opts.watchDirs
    if (opts.alertThreshold) this.alertThreshold = opts.alertThreshold
  }

  start(): void {
    if (!this.watchDirs.length) return

    for (const dir of this.watchDirs) {
      const resolved = dir.replace(/^~/, process.env.HOME || '')
      if (!fs.existsSync(resolved)) continue

      try {
        const watcher = fs.watch(resolved, { recursive: false }, (eventType, filename) => {
          if (eventType === 'rename' && filename) {
            const filePath = path.join(resolved, filename)
            const existing = this.debounceTimers.get(filePath)
            if (existing) clearTimeout(existing)
            this.debounceTimers.set(filePath, setTimeout(() => {
              this.debounceTimers.delete(filePath)
              if (fs.existsSync(filePath)) this.onFileAdded(filePath)
            }, 2000))
          }
        })
        this.watchers.push(watcher)
      } catch { /* dir may not be watchable */ }
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
  }

  private async onFileAdded(filePath: string): Promise<void> {
    if (this.seenFiles.has(filePath)) return
    this.seenFiles.add(filePath)

    try {
      const stat = fs.statSync(filePath)
      const sha256 = await this.hashFile(filePath)

      const evt = insertEvent('file_transfer', {
        direction: 'download',
        localPath: filePath,
        filename: path.basename(filePath),
        size: stat.size,
        sha256,
        method: 'fs_watch',
        largeFile: stat.size > this.alertThreshold
      }, {
        engagementId: this.engagementId,
        operatorId: this.operatorId
      })
      eventBus.publish(evt)

      if (stat.size > this.alertThreshold) {
        this.emit('large-transfer', {
          path: filePath,
          size: stat.size,
          sha256
        })
      }
    } catch {
      // file may have been moved/deleted before we could process it
    }
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }
}
