// Raw store — the bytes a producer actually sent, kept verbatim.
//
// This is the physical basis of the "unified format does not distort the
// record" guarantee (docs/DESIGN-plugin-kernel.md §4). Every event carries a
// `rawRef` that points here; the envelope's normalised fields are a summary
// of these bytes, never a replacement for them. The chain hashes the envelope,
// the envelope carries the raw sha256, so the raw bytes are attested without
// entering the chain — the same line http-body-store and the .cast recordings
// already draw: bytes live in a sidecar, only their digest is on-chain.
//
// Layout: one append-only file per UTC day under <project>/raw/. A ref is
// (file, off, len, sha256). Append-only files mean a crash mid-write can only
// truncate the tail, never corrupt an earlier ref, and the sha256 lets a
// reader detect even that.
//
// Retention: the raw file for a day is an artefact like a cast or a body
// file. `retention.ts` may prune it; the sha256 stays in the envelope, and a
// pruned ref reads back as "content no longer on disk", not as a missing fact.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getProjectDir } from './db/index'

export interface RawRef {
  /** Discriminator, so `io.stream` consumers can tell this from cast/pcap refs. */
  stream: 'raw'
  /** File name relative to <project>/raw/. */
  file: string
  /** Byte offset of this record inside the file. */
  off: number
  /** Byte length. */
  len: number
  /** sha256 of exactly those bytes. */
  sha256: string
  /** How the producer framed the bytes. `json` when the payload parsed as
   *  JSON at ingest; `bytes` otherwise. Purely informational. */
  encoding: 'json' | 'bytes'
}

let _cachedDir: string | null = null

function rawDir(): string {
  if (_cachedDir && fs.existsSync(_cachedDir)) return _cachedDir
  const dir = path.join(getProjectDir(), 'raw')
  fs.mkdirSync(dir, { recursive: true })
  _cachedDir = dir
  return dir
}

/** Tests and project switches. */
export function resetRawStoreCache(): void {
  _cachedDir = null
}

function fileForNow(now = Date.now()): string {
  const d = new Date(now)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}.raw`
}

/**
 * Append `bytes` verbatim and return a ref to them. Never throws on an empty
 * payload — an empty raw is still a fact ("the producer sent nothing").
 */
export function storeRaw(bytes: Buffer | string, opts: { encoding?: RawRef['encoding']; now?: number } = {}): RawRef {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf-8')
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const file = fileForNow(opts.now)
  const filePath = path.join(rawDir(), file)
  // Offset is the current size; appendFileSync then writes exactly `buf`.
  // Two appends from one process cannot interleave (writes are synchronous
  // on this thread), and RedLog is a single-writer app per project.
  let off = 0
  try { off = fs.statSync(filePath).size } catch { off = 0 }
  fs.appendFileSync(filePath, buf)
  return {
    stream: 'raw',
    file,
    off,
    len: buf.length,
    sha256,
    encoding: opts.encoding ?? (looksLikeJson(buf) ? 'json' : 'bytes')
  }
}

/**
 * Read the bytes a ref points at. Returns null when the file is gone
 * (pruned) or the ref is out of range. When `verify` is on (default) the
 * bytes are re-hashed and a mismatch also yields null — a truncated tail or
 * a swapped file must never read back as the original.
 */
export function readRaw(ref: RawRef, opts: { verify?: boolean } = {}): Buffer | null {
  try {
    const dir = rawDir()
    const filePath = path.resolve(dir, ref.file)
    if (!filePath.startsWith(dir + path.sep) && filePath !== dir) return null
    if (!fs.existsSync(filePath)) return null
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(ref.len)
      const n = fs.readSync(fd, buf, 0, ref.len, ref.off)
      if (n !== ref.len) return null
      if (opts.verify !== false) {
        const sha = crypto.createHash('sha256').update(buf).digest('hex')
        if (sha !== ref.sha256) return null
      }
      return buf
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Structural check so a stored `raw_ref` column can be trusted before use. */
export function isRawRef(v: unknown): v is RawRef {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.stream === 'raw' && typeof r.file === 'string' && typeof r.off === 'number'
    && typeof r.len === 'number' && typeof r.sha256 === 'string'
}

function looksLikeJson(buf: Buffer): boolean {
  if (buf.length === 0) return false
  const c = buf[0]
  return c === 0x7b /* { */ || c === 0x5b /* [ */
}
