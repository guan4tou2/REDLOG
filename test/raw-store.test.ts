import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// The raw store is the physical basis of "unified format does not distort the
// record" (docs/DESIGN-plugin-kernel.md §4): the bytes a producer sent are
// kept verbatim and a ref (file, off, len, sha256) points at them. It needs a
// project dir, so it rides the same native-module guard as the other
// DB-backed suites.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let rs: typeof import('../src/core/raw-store')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  rs = await import('../src/core/raw-store')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('raw-store', () => {
  let tmpDir: string
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-raw-'))
    initDB(tmpDir)
    rs.resetRawStoreCache()
  })
  afterAll(() => {
    try { closeDB() } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* */ }
  })

  it('round-trips the exact bytes it was given', () => {
    const payload = Buffer.from('{"host":"10.0.0.5","note":"café ☕"}', 'utf-8')
    const ref = rs.storeRaw(payload, { now: Date.UTC(2026, 0, 2) })
    const back = rs.readRaw(ref)
    expect(back).not.toBeNull()
    expect(back!.equals(payload)).toBe(true)
  })

  it('records the true sha256 of the stored bytes', () => {
    const payload = 'plain string payload'
    const ref = rs.storeRaw(payload, { now: Date.UTC(2026, 0, 2) })
    expect(ref.sha256).toBe(crypto.createHash('sha256').update(Buffer.from(payload, 'utf-8')).digest('hex'))
  })

  it('two appends on the same day share a file and stay separable by offset', () => {
    const now = Date.UTC(2026, 5, 15)
    const a = rs.storeRaw('first', { now })
    const b = rs.storeRaw('second-longer', { now })
    expect(a.file).toBe(b.file)
    expect(b.off).toBe(a.off + a.len)
    expect(rs.readRaw(a)!.toString()).toBe('first')
    expect(rs.readRaw(b)!.toString()).toBe('second-longer')
  })

  it('detects a tampered ref: wrong sha256 reads back as null', () => {
    const ref = rs.storeRaw('trust me', { now: Date.UTC(2026, 0, 2) })
    const forged = { ...ref, sha256: 'deadbeef'.repeat(8) }
    expect(rs.readRaw(forged)).toBeNull()
    // ...but skipping verification returns whatever is on disk.
    expect(rs.readRaw(forged, { verify: false })!.toString()).toBe('trust me')
  })

  it('a pruned (missing) file reads back as null, not a throw', () => {
    const ref = rs.storeRaw('to be pruned', { now: Date.UTC(2026, 0, 3) })
    fs.rmSync(path.join(tmpDir, 'raw', ref.file))
    expect(rs.readRaw(ref)).toBeNull()
  })

  it('classifies JSON vs bytes by the first byte', () => {
    expect(rs.storeRaw('{"a":1}', { now: Date.UTC(2026, 0, 4) }).encoding).toBe('json')
    expect(rs.storeRaw('hello', { now: Date.UTC(2026, 0, 4) }).encoding).toBe('bytes')
  })

  it('isRawRef guards a stored column value before use', () => {
    const ref = rs.storeRaw('x', { now: Date.UTC(2026, 0, 5) })
    expect(rs.isRawRef(ref)).toBe(true)
    expect(rs.isRawRef({ stream: 'cast', ref: '/x' })).toBe(false)
    expect(rs.isRawRef(null)).toBe(false)
  })
})
