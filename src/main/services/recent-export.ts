import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { ExportDelivery } from '../../core/export-delivery'

type SavedDelivery = Omit<ExportDelivery, 'availability'>
interface Receipt extends SavedDelivery { projectId: string; projectDir: string }

/** One main-owned receipt per project on this machine. Never stored in the
 *  project, where importing a folder could grant access to someone else's path. */
export class RecentExportStore {
  private memory = new Map<string, Receipt>()
  constructor(private readonly dir?: string) {}

  private key(projectId: string, projectDir: string): string {
    return createHash('sha256').update(JSON.stringify([projectId, path.resolve(projectDir)])).digest('hex')
  }

  get(projectId: string, projectDir: string): ExportDelivery | null {
    const key = this.key(projectId, projectDir)
    let value: unknown = this.memory.get(key)
    if (this.dir) {
      try { value = JSON.parse(fs.readFileSync(path.join(this.dir, `${key}.json`), 'utf8')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new Error('recent-export-unreadable')
      }
    }
    if (value === undefined && !this.dir) return null
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recent-export-invalid')
    const receipt = value as Receipt
    if (receipt.projectId !== projectId || receipt.projectDir !== path.resolve(projectDir)
      || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt <= 0
      || typeof receipt.artifactPath !== 'string' || !path.isAbsolute(receipt.artifactPath)
      || !['json', 'ndjson', 'bundle', 'har', 'timeline'].includes(receipt.format)) {
      throw new Error('recent-export-invalid')
    }
    let availability: ExportDelivery['availability'] = 'available'
    try {
      const stat = fs.statSync(receipt.artifactPath)
      if (!stat.isFile() && !stat.isDirectory()) availability = 'unavailable'
    } catch (error) {
      availability = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable'
    }
    return { artifactPath: receipt.artifactPath, format: receipt.format, completedAt: receipt.completedAt, availability }
  }

  remember(projectId: string, projectDir: string, delivery: SavedDelivery): void {
    const key = this.key(projectId, projectDir)
    const receipt: Receipt = { artifactPath: delivery.artifactPath, format: delivery.format, completedAt: delivery.completedAt, projectId, projectDir: path.resolve(projectDir) }
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const temp = path.join(this.dir, `${key}.${randomUUID()}.tmp`)
      try {
        fs.writeFileSync(temp, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
        fs.renameSync(temp, path.join(this.dir, `${key}.json`))
      } catch (error) {
        try { fs.unlinkSync(temp) } catch { /* no uncommitted file left */ }
        throw error
      }
    }
    this.memory.set(key, receipt)
  }
}
