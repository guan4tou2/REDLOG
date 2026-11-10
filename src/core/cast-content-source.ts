import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import { castParts } from './cast-slice'
import { ContentAccessError, type ByteSource } from './body-source'

interface CastRange { ref: string; off: number; len: number }
interface Projection {
  file: string
  signature: string
  sources: Array<{ file: string; signature: string }>
  bytes: number
  digest: string
}
const projections = new Map<string, Projection>()
const pending = new Map<string, Promise<void>>()
let cacheDir: string | undefined
function statSignature(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}
function signature(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true })
  if (!stat.isFile()) throw new ContentAccessError('denied', 'Recording is not a regular file')
  return statSignature(stat)
}
function key(dir: string, range: CastRange): string {
  return JSON.stringify([dir, range.ref, range.off, range.len])
}
function current(projection: Projection): boolean {
  return projection.signature === signature(projection.file) &&
    projection.sources.every(source => fs.realpathSync(path.dirname(source.file)) === path.dirname(source.file) && signature(source.file) === source.signature)
}
function unavailable(error: unknown): never {
  if (error instanceof ContentAccessError) throw error
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new ContentAccessError('missing', 'Recording is missing')
  throw new ContentAccessError('failed', error instanceof Error ? error.message : String(error))
}

/** A disposable text projection. The cast and evidence rows remain the source. */
export async function prepareCastProjection(dir: string, range: CastRange): Promise<void> {
  const id = key(dir, range)
  try {
    const cached = projections.get(id)
    if (cached && current(cached)) return
  } catch { /* rebuild or surface the current source error below */ }
  if (pending.has(id)) return pending.get(id)!
  const task = project(dir, range, id)
  pending.set(id, task)
  try { await task } finally { pending.delete(id) }
}
async function project(dir: string, range: CastRange, id: string): Promise<void> {
  let output: fs.promises.FileHandle | undefined
  let destination: string | undefined
  try {
    if (!Number.isSafeInteger(range.off) || range.off < 0 || !Number.isSafeInteger(range.len) || range.len < 0)
      throw new ContentAccessError('unsupported', 'Recording has no exact byte range')
    const casts = path.join(fs.realpathSync(dir), 'casts')
    if (fs.lstatSync(casts).isSymbolicLink()) throw new ContentAccessError('denied', 'Recording folder is a link')
    const file = path.resolve(dir, range.ref)
    // Recorded paths may be absolute or project-relative, but must name a direct cast child.
    if (fs.realpathSync(path.dirname(file)) !== casts || !file.endsWith('.cast'))
      throw new ContentAccessError('denied', 'Recording is outside the project')
    const files = castParts(path.join(casts, path.basename(file)))
    const sources: Projection['sources'] = []
    if (!cacheDir) cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-cast-content-'))
    destination = path.join(cacheDir, createHash('sha256').update(id).digest('hex') + '-' + randomUUID() + '.txt')
    output = await fs.promises.open(destination, 'wx', 0o600)
    const hash = createHash('sha256')
    let position = 0, remaining = range.len, bytes = 0
    for (const part of files) {
      const sourceSignature = signature(part)
      const size = fs.statSync(part).size
      if (size > 60 * 1024 * 1024) throw new ContentAccessError('unsupported', 'Recording part exceeds the supported 60 MiB bound')
      if (position + size <= range.off) { sources.push({ file: part, signature: sourceSignature }); position += size; continue }
      if (!remaining) break
      const start = Math.max(0, range.off - position)
      const count = Math.min(size - start, remaining)
      sources.push({ file: part, signature: sourceSignature })
      const fd = fs.openSync(part, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      if (statSignature(fs.fstatSync(fd, { bigint: true })) !== sourceSignature) { fs.closeSync(fd); throw new ContentAccessError('changed', 'Recording was replaced') }
      const input = fs.createReadStream(part, { fd, autoClose: true, start, end: start + count - 1 })
      const lines = readline.createInterface({ input, crlfDelay: Infinity })
      input.on('error', error => lines.emit('error', error))
      try {
        for await (const line of lines) {
          if (!line) continue
          const record: unknown = JSON.parse(line)
          if (!Array.isArray(record)) continue // independently playable part header
          if (record[1] !== 'o') continue
          if (typeof record[2] !== 'string') throw new ContentAccessError('failed', 'Invalid recording output')
          const data = Buffer.from(record[2], 'utf8')
          hash.update(data)
          let written = 0
          while (written < data.length) {
            const count = (await output.write(data, written, data.length - written)).bytesWritten
            if (!count) throw new Error('Recording projection did not advance')
            written += count
          }
          bytes += data.length
        }
      } finally { lines.close(); input.destroy() }
      if (signature(part) !== sourceSignature) throw new ContentAccessError('changed', 'Recording changed during projection')
      remaining -= count
      position += size
    }
    if (remaining) throw new ContentAccessError('missing', 'Recording range is incomplete')
    await output.close(); output = undefined
    if (sources.some(source => fs.realpathSync(path.dirname(source.file)) !== path.dirname(source.file))) throw new ContentAccessError('denied', 'Recording directory changed')
    const previous = projections.get(id)
    if (previous) fs.unlinkSync(previous.file)
    projections.set(id, { file: destination, signature: signature(destination), sources, bytes, digest: hash.digest('hex') })
    destination = undefined
    // Bounded cache. Each entry can be regenerated from the original recording.
    while (projections.size > 8) {
      const oldest = projections.keys().next().value!
      fs.unlinkSync(projections.get(oldest)!.file)
      projections.delete(oldest)
    }
  } catch (error) { unavailable(error) }
  finally {
    await output?.close()
    if (destination) await fs.promises.unlink(destination).catch(() => {})
  }
}
export function withCastProjection<T>(dir: string, range: CastRange, use: (source: ByteSource) => T): T {
  try {
    const projection = projections.get(key(dir, range))
    if (!projection) throw new ContentAccessError('cast-recording', 'Recording text is not prepared')
    if (!current(projection)) throw new ContentAccessError('changed', 'Recording changed; reopen the content')
    const fd = fs.openSync(projection.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      if (statSignature(fs.fstatSync(fd, { bigint: true })) !== projection.signature) throw new ContentAccessError('changed', 'Projection was replaced')
      const result = use({ bytes: projection.bytes, digest: projection.digest, format: 'utf8', read: (offset, length) => {
        const buffer = Buffer.alloc(length)
        if (fs.readSync(fd, buffer, 0, length, offset) !== length) throw new ContentAccessError('changed', 'Recording projection changed')
        return buffer
      } })
      if (!current(projection)) throw new ContentAccessError('changed', 'Recording changed during read')
      return result
    } finally { fs.closeSync(fd) }
  } catch (error) { return unavailable(error) }
}
process.once('exit', () => { if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true }) })
