import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { putBody, readBody, resolveRef, resolveExisting, verifyBody, ioDir, stampIoRefs, compressBody, ioStoreSize, MAX_IO_READ_BYTES } from '../src/core/io-store'

// io_ref sidecar store (SPEC-IO-SIDECAR.md step 1). Content-addressed, deduped,
// range-readable, path-guarded. The chain only ever sees the sha256 these
// functions return — so their correctness is what makes verify meaningful.

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-io-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const sha = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

describe('putBody', () => {
  it('stores a body under its sha256 and returns the ref/len/sha256', () => {
    const body = Buffer.from('{"hello":"world"}')
    const r = putBody(dir, body)
    expect(r.sha256).toBe(sha(body))
    expect(r.ref).toBe(r.sha256)
    expect(r.len).toBe(body.length)
    const onDisk = fs.readFileSync(path.join(ioDir(dir), `${r.ref}.bin`))
    expect(onDisk.equals(body)).toBe(true)
  })

  it('dedups identical bodies to a single file (A3)', () => {
    const body = Buffer.from('same bytes')
    const a = putBody(dir, body)
    const b = putBody(dir, body)
    expect(a.ref).toBe(b.ref)
    const files = fs.readdirSync(ioDir(dir)).filter((f) => f.endsWith('.bin'))
    expect(files).toHaveLength(1)
  })

  it('stores distinct bodies separately', () => {
    putBody(dir, Buffer.from('one'))
    putBody(dir, Buffer.from('two'))
    const files = fs.readdirSync(ioDir(dir)).filter((f) => f.endsWith('.bin'))
    expect(files).toHaveLength(2)
  })

  it('leaves no .tmp files behind', () => {
    putBody(dir, Buffer.from('x'))
    const tmp = fs.readdirSync(ioDir(dir)).filter((f) => f.includes('.tmp'))
    expect(tmp).toHaveLength(0)
  })
})

describe('readBody', () => {
  it('round-trips a full body (A1)', () => {
    const body = Buffer.from('x'.repeat(40 * 1024))   // > REDLOG_MAX_BODY inline cap
    const { ref } = putBody(dir, body)
    const got = readBody(dir, ref)
    expect(got).not.toBeNull()
    expect(got!.equals(body)).toBe(true)
  })

  it('reads a byte range [off, off+len)', () => {
    const body = Buffer.from('0123456789')
    const { ref } = putBody(dir, body)
    expect(readBody(dir, ref, 2, 3)!.toString()).toBe('234')
    expect(readBody(dir, ref, 8, 5)!.toString()).toBe('89')   // clamped to EOF
  })

  it('returns null for an out-of-range or empty request', () => {
    const { ref } = putBody(dir, Buffer.from('abc'))
    expect(readBody(dir, ref, 10, 1)).toBeNull()   // off past EOF
    expect(readBody(dir, ref, 0, 0)).toBeNull()    // len <= 0
    expect(readBody(dir, ref, -1, 2)).toBeNull()   // negative off
  })

  it('returns null when the body was pruned (A4 pruned, not tampered)', () => {
    const { ref } = putBody(dir, Buffer.from('gone'))
    fs.unlinkSync(path.join(ioDir(dir), `${ref}.bin`))
    expect(readBody(dir, ref)).toBeNull()
    // ref is still well-formed → caller reads this as pruned, not traversal
    expect(resolveRef(dir, ref)).not.toBeNull()
  })

  it('refuses a whole-body read above the cap (must page instead)', () => {
    const { ref } = putBody(dir, Buffer.from('small'))
    // A range read up to the cap is fine; asking for more than the cap is refused.
    expect(readBody(dir, ref, 0, MAX_IO_READ_BYTES + 1)).toBeNull()
  })
})

describe('path traversal (A7)', () => {
  it('refuses a non-sha256 ref', () => {
    expect(resolveRef(dir, '../../etc/passwd')).toBeNull()
    expect(resolveRef(dir, 'not-a-hash')).toBeNull()
    expect(resolveRef(dir, '')).toBeNull()
    expect(readBody(dir, '../../etc/passwd')).toBeNull()
  })

  it('refuses an uppercase or wrong-length hex ref', () => {
    expect(resolveRef(dir, 'A'.repeat(64))).toBeNull()   // uppercase
    expect(resolveRef(dir, 'a'.repeat(63))).toBeNull()   // too short
    expect(resolveRef(dir, 'a'.repeat(65))).toBeNull()   // too long
  })
})

describe('stampIoRefs (option B, A2)', () => {
  it('sidecars a posted full body and replaces it with an io ref', () => {
    const body = 'y'.repeat(40 * 1024)
    const data: Record<string, unknown> = {
      subtype: 'http_response',
      response_preview: body.slice(0, 16384),
      response_body_full: body,
      response_body_ct: 'application/json',
    }
    stampIoRefs(data, dir)
    // full bytes are gone from the event; only the ref + preview remain (A2)
    expect(data.response_body_full).toBeUndefined()
    expect(data.response_body_ct).toBeUndefined()
    expect(data.response_preview).toBe(body.slice(0, 16384))
    const io = data.io as { response: { ref: string; len: number; sha256: string; ct: string; truncated: boolean } }
    expect(io.response.sha256).toBe(sha(Buffer.from(body, 'utf8')))
    expect(io.response.ref).toBe(io.response.sha256)
    expect(io.response.len).toBe(Buffer.byteLength(body, 'utf8'))
    expect(io.response.ct).toBe('application/json')
    expect(io.response.truncated).toBe(false)
    // and the bytes really landed in the sidecar
    expect(readBody(dir, io.response.ref)!.toString()).toBe(body)
  })

  it('stamps both request and response slots on the same event', () => {
    const data: Record<string, unknown> = {
      request_body_full: 'req'.repeat(9000),
      response_body_full: 'resp'.repeat(9000),
    }
    stampIoRefs(data, dir)
    const io = data.io as { request: unknown; response: unknown }
    expect(io.request).toBeDefined()
    expect(io.response).toBeDefined()
  })

  it('carries truncated:true through from the addon ceiling flag', () => {
    const data: Record<string, unknown> = {
      response_body_full: 'z'.repeat(1000),
      response_body_full_truncated: true,
    }
    stampIoRefs(data, dir)
    expect((data.io as { response: { truncated: boolean } }).response.truncated).toBe(true)
  })

  it('is a no-op for events with no full-body field (historical/small bodies)', () => {
    const data: Record<string, unknown> = { subtype: 'http_response', response_preview: 'small complete body' }
    stampIoRefs(data, dir)
    expect(data.io).toBeUndefined()
    expect(fs.existsSync(ioDir(dir))).toBe(false)   // nothing written
  })

  it('strips a stray full-body field even when empty, never chaining raw bytes', () => {
    const data: Record<string, unknown> = { request_body_full: '', request_body_ct: 'text/plain' }
    stampIoRefs(data, dir)
    expect(data.request_body_full).toBeUndefined()
    expect(data.request_body_ct).toBeUndefined()
    expect(data.io).toBeUndefined()
  })
})

describe('warm compression (SPEC-SCOPE-AWARE-LIFECYCLE Part C, A4)', () => {
  it('compresses a body in place, reclaiming the raw file but keeping the digest', () => {
    const body = Buffer.from(JSON.stringify({ blob: 'A'.repeat(50 * 1024) }))   // compressible
    const { ref } = putBody(dir, body)
    const rawSize = fs.statSync(path.join(ioDir(dir), `${ref}.bin`)).size
    expect(compressBody(dir, ref)).toBe(true)
    // raw gone, gz present and smaller
    expect(fs.existsSync(path.join(ioDir(dir), `${ref}.bin`))).toBe(false)
    const gzPath = path.join(ioDir(dir), `${ref}.bin.gz`)
    expect(fs.existsSync(gzPath)).toBe(true)
    expect(fs.statSync(gzPath).size).toBeLessThan(rawSize)
    // resolveExisting reports it as compressed
    expect(resolveExisting(dir, ref)).toEqual({ file: gzPath, compressed: true })
  })

  it('reads a warm body back transparently — full and ranged', () => {
    const body = Buffer.from('0123456789'.repeat(2000))
    const { ref } = putBody(dir, body)
    compressBody(dir, ref)
    expect(readBody(dir, ref)!.equals(body)).toBe(true)
    expect(readBody(dir, ref, 5, 5)!.toString()).toBe('56789')
  })

  it('verifies a warm body against its ORIGINAL sha256 (A4)', () => {
    const body = Buffer.from('attested then compressed')
    const { ref } = putBody(dir, body)
    compressBody(dir, ref)
    expect(verifyBody(dir, ref)).toBe(true)
  })

  it('detects tampering of a warm body', () => {
    const { ref } = putBody(dir, Buffer.from('original body'))
    compressBody(dir, ref)
    // overwrite the gz with a valid gzip of different bytes
    const zlib = require('zlib') as typeof import('zlib')
    fs.writeFileSync(path.join(ioDir(dir), `${ref}.bin.gz`), zlib.gzipSync(Buffer.from('tampered')))
    expect(verifyBody(dir, ref)).toBe(false)
  })

  it('putBody dedups against an already-warm body (no raw rewrite)', () => {
    const body = Buffer.from('dedup me')
    const { ref } = putBody(dir, body)
    compressBody(dir, ref)
    putBody(dir, body)   // same bytes, already compressed
    expect(fs.existsSync(path.join(ioDir(dir), `${ref}.bin`))).toBe(false)   // not re-materialized raw
    const files = fs.readdirSync(ioDir(dir)).filter((f) => f.startsWith(ref))
    expect(files).toEqual([`${ref}.bin.gz`])
  })

  it('compressBody is a no-op-true when already warm, false when pruned', () => {
    const { ref } = putBody(dir, Buffer.from('x'))
    compressBody(dir, ref)
    expect(compressBody(dir, ref)).toBe(true)   // idempotent
    fs.unlinkSync(path.join(ioDir(dir), `${ref}.bin.gz`))
    expect(compressBody(dir, ref)).toBe(false)  // gone
  })

  it('ioStoreSize sums raw and warm bodies', () => {
    putBody(dir, Buffer.from('a'.repeat(1000)))
    const { ref } = putBody(dir, Buffer.from('b'.repeat(1000)))
    compressBody(dir, ref)
    expect(ioStoreSize(dir)).toBeGreaterThan(0)
  })
})

describe('verifyBody (A4)', () => {
  it('confirms on-disk bytes match the chained digest', () => {
    const { ref } = putBody(dir, Buffer.from('attested bytes'))
    expect(verifyBody(dir, ref)).toBe(true)
  })

  it('fails when the stored bytes are tampered', () => {
    const { ref } = putBody(dir, Buffer.from('original'))
    fs.writeFileSync(path.join(ioDir(dir), `${ref}.bin`), Buffer.from('tampered'))
    expect(verifyBody(dir, ref)).toBe(false)
  })

  it('fails (not throws) on a pruned or malformed ref', () => {
    expect(verifyBody(dir, 'a'.repeat(64))).toBe(false)   // never written
    expect(verifyBody(dir, 'bad')).toBe(false)
  })
})
