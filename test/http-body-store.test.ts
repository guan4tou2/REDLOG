import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// http-body-store uses getProjectDir from the DB module; use the same
// conditional-import guard as other DB-backed test suites.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let store: typeof import('../src/core/http-body-store')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  store = await import('../src/core/http-body-store')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('http-body-store', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-body-'))
    initDB(tmpDir)
    store.resetBodiesDirCache()
  })

  afterEach(() => {
    closeDB()
    store.resetBodiesDirCache()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('storeBody', () => {
    it('writes a text body to disk and returns a valid BodyRef', () => {
      const data = 'Hello, RedLog!'
      const sha256 = crypto.createHash('sha256').update(Buffer.from(data, 'utf-8')).digest('hex')

      const ref = store.storeBody({
        data,
        encoding: 'text',
        size: data.length,
        sha256
      })

      expect(ref).not.toBeNull()
      expect(ref!.sha256).toBe(sha256)
      expect(ref!.encoding).toBe('text')
      expect(ref!.file).toBe(`${sha256}.body`)

      // Verify file was written
      const bodiesDir = path.join(tmpDir, 'http-bodies')
      expect(fs.existsSync(path.join(bodiesDir, ref!.file))).toBe(true)
    })

    it('writes a base64 body and stores the decoded bytes', () => {
      const raw = 'binary payload \x00\x01\x02'
      const b64 = Buffer.from(raw).toString('base64')
      const sha256 = crypto.createHash('sha256').update(Buffer.from(raw)).digest('hex')

      const ref = store.storeBody({
        data: b64,
        encoding: 'base64',
        size: raw.length,
        sha256
      })

      expect(ref).not.toBeNull()
      expect(ref!.encoding).toBe('base64')
      // Verify the stored file contains the raw bytes, not the base64 string
      const filePath = path.join(tmpDir, 'http-bodies', ref!.file)
      const stored = fs.readFileSync(filePath)
      expect(stored.toString()).toBe(raw)
    })

    it('returns null for empty data', () => {
      expect(store.storeBody({ data: '', encoding: 'text', size: 0, sha256: 'x' })).toBeNull()
    })

    it('deduplicates by sha256 (same content writes once)', () => {
      const data = 'dedupe test'
      const sha256 = crypto.createHash('sha256').update(Buffer.from(data, 'utf-8')).digest('hex')
      const body = { data, encoding: 'text' as const, size: data.length, sha256 }

      const ref1 = store.storeBody(body)
      const ref2 = store.storeBody(body)

      expect(ref1!.file).toBe(ref2!.file)
      // Only one file on disk
      const bodiesDir = path.join(tmpDir, 'http-bodies')
      const files = fs.readdirSync(bodiesDir).filter(f => f.endsWith('.body'))
      expect(files).toHaveLength(1)
    })
  })

  describe('readBody', () => {
    it('round-trips a text body', () => {
      const data = 'round trip text'
      const sha256 = crypto.createHash('sha256').update(Buffer.from(data, 'utf-8')).digest('hex')
      const ref = store.storeBody({ data, encoding: 'text', size: data.length, sha256 })!

      const result = store.readBody(ref)
      expect(result).toBe(data)
    })

    it('round-trips a base64 body', () => {
      const raw = Buffer.from([0xff, 0xfe, 0x00, 0x42])
      const b64 = raw.toString('base64')
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex')
      const ref = store.storeBody({ data: b64, encoding: 'base64', size: raw.length, sha256 })!

      const result = store.readBody(ref)
      expect(result).toBe(b64)
    })

    it('returns null for a non-existent file', () => {
      const ref = { sha256: 'a'.repeat(64), size: 10, file: 'nonexistent.body', encoding: 'text' as const }
      expect(store.readBody(ref)).toBeNull()
    })

    it('rejects path-traversal attempts', () => {
      // A malicious ref.file that tries to escape the bodies directory
      const ref = { sha256: 'a'.repeat(64), size: 10, file: '../../../etc/passwd', encoding: 'text' as const }
      expect(store.readBody(ref)).toBeNull()
    })
  })

  describe('shouldExternalize', () => {
    it('returns false for undefined or empty body', () => {
      expect(store.shouldExternalize(undefined)).toBe(false)
      expect(store.shouldExternalize({ data: '' })).toBe(false)
    })

    it('returns false for a body below the inline threshold (4096)', () => {
      expect(store.shouldExternalize({ data: 'x'.repeat(4096) })).toBe(false)
    })

    it('returns true for a body above the inline threshold', () => {
      expect(store.shouldExternalize({ data: 'x'.repeat(4097) })).toBe(true)
    })
  })

  describe('extractBodyToSidecar', () => {
    it('externalizes a large request_body and replaces it with a ref', () => {
      const bigData = 'x'.repeat(5000)
      const sha256 = crypto.createHash('sha256').update(Buffer.from(bigData, 'utf-8')).digest('hex')
      const data: Record<string, unknown> = {
        request_body: {
          data: bigData,
          encoding: 'text',
          size: bigData.length,
          sha256
        }
      }

      store.extractBodyToSidecar(data, 'request_body')

      expect(data.request_body).toBeUndefined()
      expect(data.request_body_ref).toBeDefined()
      const ref = data.request_body_ref as { sha256: string; file: string }
      expect(ref.sha256).toBe(sha256)
    })

    it('leaves a small body inline (no externalization)', () => {
      const smallData = 'tiny'
      const data: Record<string, unknown> = {
        response_body: {
          data: smallData,
          encoding: 'text',
          size: smallData.length,
          sha256: 'irrelevant'
        }
      }

      store.extractBodyToSidecar(data, 'response_body')

      // Body stays inline
      expect(data.response_body).toBeDefined()
      expect(data.response_body_ref).toBeUndefined()
    })

    it('maps field names to correct ref fields', () => {
      const bigData = 'x'.repeat(5000)
      const sha256 = crypto.createHash('sha256').update(Buffer.from(bigData, 'utf-8')).digest('hex')
      const makeBody = () => ({ data: bigData, encoding: 'text' as const, size: bigData.length, sha256 })

      for (const [field, refField] of [
        ['request_body', 'request_body_ref'],
        ['response_body', 'response_body_ref'],
        ['ws_body', 'ws_body_ref'],
        ['tcp_body', 'tcp_body_ref']
      ] as const) {
        const data: Record<string, unknown> = { [field]: makeBody() }
        store.extractBodyToSidecar(data, field)
        expect(data[refField], `${field} -> ${refField}`).toBeDefined()
        expect(data[field], `${field} should be removed`).toBeUndefined()
      }
    })

    it('preserves the truncated flag on the ref', () => {
      const bigData = 'x'.repeat(5000)
      const sha256 = crypto.createHash('sha256').update(Buffer.from(bigData, 'utf-8')).digest('hex')
      const data: Record<string, unknown> = {
        request_body: {
          data: bigData,
          encoding: 'text',
          size: bigData.length,
          sha256,
          truncated: true
        }
      }

      store.extractBodyToSidecar(data, 'request_body')

      const ref = data.request_body_ref as { truncated?: boolean }
      expect(ref.truncated).toBe(true)
    })

    it('is a no-op when the field is absent', () => {
      const data: Record<string, unknown> = { other: 'stuff' }
      store.extractBodyToSidecar(data, 'request_body')
      expect(data).toEqual({ other: 'stuff' })
    })
  })
})
