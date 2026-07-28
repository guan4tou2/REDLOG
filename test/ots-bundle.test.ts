import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let anchor: typeof import('../src/core/chain-anchor')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  anchor = await import('../src/core/chain-anchor')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not built */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('buildOtsBundle', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-ots-')); initDB(tmp) })
  afterEach(() => { closeDB(); fs.rmSync(tmp, { recursive: true, force: true }) })

  it('produces a file starting with the standard OTS magic + version + sha256 op + digest', () => {
    const head = 'a'.repeat(64) // 32-byte sha256 as hex
    const receiptB64 = Buffer.from([0x00, 0x11, 0x22]).toString('base64')
    const bundle = anchor.buildOtsBundle(head, receiptB64)

    // Magic: 31 bytes ending in \xbf\x89\xe2\xe8\x84\xe8\x92\x94
    expect(bundle.slice(0, 31).toString('hex')).toBe(
      '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294'
    )
    // Version 0x01
    expect(bundle[31]).toBe(0x01)
    // SHA-256 op tag 0x08
    expect(bundle[32]).toBe(0x08)
    // Next 32 bytes = digest
    expect(bundle.slice(33, 65).toString('hex')).toBe(head)
    // Then the calendar receipt
    expect(bundle.slice(65).toString('hex')).toBe('001122')
  })

  it('rejects a non-32-byte digest', () => {
    expect(() => anchor.buildOtsBundle('ab', '')).toThrow(/32 bytes/)
  })
})
