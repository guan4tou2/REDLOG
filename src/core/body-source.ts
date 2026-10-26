import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getProjectDir } from './db/index'
import type { BodyRef } from './http-body-store'
import type { ContentUnavailable } from './content-contract'
export class ContentAccessError extends Error {
  constructor(public status: ContentUnavailable, message: string) { super(message); }
}
export interface ByteSource {
  bytes: number
  digest: string
  format: 'utf8' | 'json' | 'binary'
  read: (offset: number, length: number) => Buffer
}
const verified = new Map<string, {
  signature: string
  format: 'utf8' | 'binary'
}>()
const signature = (s: fs.BigIntStats): string => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
/** Fixed, content-addressed sidecars only. Never follow an Event-supplied link
* outside its body store, and never let cached text stand in for changed bytes. */
export function withVerifiedBody<T>(ref: BodyRef, use: (source: ByteSource) => T, projectDir = getProjectDir()): T {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.file !== ref.sha256 + '.body' || !Number.isSafeInteger(ref.size) || ref.size < 0)
    throw new ContentAccessError('denied', 'Invalid stored body reference')
  const file = path.join(projectDir, 'http-bodies', ref.file)
  let fd: number | undefined
  try {
    const directory = fs.lstatSync(path.dirname(file), { bigint: true })
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new ContentAccessError('denied', 'Stored body directory is not a regular directory')
    const named = fs.lstatSync(file, { bigint: true })
    if (!named.isFile() || named.isSymbolicLink())
      throw new ContentAccessError('denied', 'Stored body is not a regular file')
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const before = fs.fstatSync(fd, { bigint: true }), sig = signature(before)
    if (sig !== signature(named) || before.size !== BigInt(ref.size))
      throw new ContentAccessError('changed', 'Stored body was replaced or resized')
    const read = (offset: number, length: number): Buffer => {
      const buf = Buffer.alloc(Math.min(length, ref.size - offset))
      const n = fs.readSync(fd!, buf, 0, buf.length, offset)
      if (n !== buf.length)
        throw new ContentAccessError('changed', 'Stored body ended before its confirmed boundary')
      return buf
    }
    let cached = verified.get(file)
    if (cached?.signature !== sig) {
      const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true })
      let text = true
      for (let offset = 0; offset < ref.size; offset += 65536) {
        const buf = read(offset, Math.min(65536, ref.size - offset))
        hash.update(buf)
        if (text) {
          try {
            if (buf.includes(0))
              text = false
            else
              decoder.decode(buf, { stream: true })
          }
          catch {
            text = false
          }
        }
      }
      if (text) {
        try {
          decoder.decode()
        }
        catch {
          text = false
        }
      }
      if (hash.digest('hex') !== ref.sha256 || signature(fs.fstatSync(fd, { bigint: true })) !== sig)
        throw new ContentAccessError('changed', 'Stored body no longer matches its recorded hash')
      cached = { signature: sig, format: text ? 'utf8' : 'binary' }
      if (verified.size >= 64)
        verified.delete(verified.keys().next().value!)
      verified.set(file, cached)
    }
    const result = use({ bytes: ref.size, digest: ref.sha256, format: cached.format, read })
    const currentDirectory = fs.lstatSync(path.dirname(file), { bigint: true })
    if (currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory() || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) throw new ContentAccessError('denied', 'Stored body directory changed while reading')
    if (signature(fs.fstatSync(fd, { bigint: true })) !== sig || signature(fs.lstatSync(file, { bigint: true })) !== sig)
      throw new ContentAccessError('changed', 'Stored body changed while reading')
    return result
  }
  catch (error) {
    if (error instanceof ContentAccessError)
      throw error
    const code = (error as NodeJS.ErrnoException).code
    throw new ContentAccessError(code === 'ENOENT' ? 'missing' : code === 'EACCES' || code === 'EPERM' || code === 'ELOOP' ? 'denied' : 'failed', error instanceof Error ? error.message : String(error))
  }
  finally {
    if (fd !== undefined)
      fs.closeSync(fd)
  }
}
