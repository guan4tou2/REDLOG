import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let anchor: typeof import('../src/core/chain-anchor')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const evMod = await import('../src/core/db/events')
  anchor = await import('../src/core/chain-anchor')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  insertEventRaw = evMod.insertEvent
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const insertEvent: typeof import('../src/core/db/events').insertEvent = (agentType, data, opts) =>
  insertEventRaw(agentType, data, { operatorId: 'test-op', ...opts })

const describeDB = dbAvailable ? describe : describe.skip

describeDB('chain-anchor', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-anchor-'))
    initDB(tmpDir)
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('computeChainHead is null with no events, valid with events', () => {
    expect(anchor.computeChainHead()).toBeNull()

    insertEvent('shell', { command: 'ls' })
    insertEvent('shell', { command: 'pwd' })

    const head = anchor.computeChainHead()
    expect(head).not.toBeNull()
    expect(head!.eventCount).toBe(2)
    expect(head!.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(head!.headEventId).toBeTruthy()
  })

  it('anchorNow with no calendars returns failed anchor', async () => {
    insertEvent('shell', { command: 'ls' })
    const result = await anchor.anchorNow([])
    expect(result).not.toBeNull()
    expect(result!.status).toBe('failed')
    expect(result!.calendarReceipts).toEqual([])
  })

  it('anchorNow returns null when no events', async () => {
    const result = await anchor.anchorNow([])
    expect(result).toBeNull()
  })

  it('listAnchors returns anchors newest first', async () => {
    insertEvent('shell', { command: 'a' })
    await anchor.anchorNow([])
    insertEvent('shell', { command: 'b' })
    await anchor.anchorNow([])

    const list = anchor.listAnchors()
    expect(list.length).toBe(2)
    expect(list[0].eventCount).toBeGreaterThanOrEqual(list[1].eventCount)
  })

  it('verifyLatestAnchor detects intact vs missing', async () => {
    insertEvent('shell', { command: 'a' })
    await anchor.anchorNow([])
    insertEvent('shell', { command: 'b' })

    const v = anchor.verifyLatestAnchor()
    expect(v.anchor).not.toBeNull()
    expect(v.currentHead).toMatch(/^[0-9a-f]{64}$/)
    expect(v.ok).toBe(true)
  })

  it('verifyChainFull passes on a clean chain and reports zero anomalies', () => {
    insertEvent('shell', { command: 'a' })
    insertEvent('shell', { command: 'b' })
    insertEvent('shell', { command: 'c' })
    const r = anchor.verifyChainFull()
    expect(r.ok).toBe(true)
    expect(r.walked).toBe(3)
    expect(r.brokenAtEventId).toBeNull()
    expect(r.clockAnomalies).toEqual([])
  })

  describe('buildOtsBundle', () => {
    it('composes MAGIC + version + op + digest + timestamp', () => {
      const digestHex = 'a'.repeat(64) // 32 bytes
      const receiptB64 = Buffer.from('receipt-bytes').toString('base64')
      const buf = anchor.buildOtsBundle(digestHex, receiptB64)
      // Bundle must start with the OpenTimestamps magic prefix.
      expect(buf.subarray(0, 8).toString('hex')).toBe('004f70656e54696d')
      // Total length = 31 (magic) + 2 (version/op) + 32 (digest) + 13 (receipt)
      expect(buf.length).toBe(31 + 2 + 32 + Buffer.from('receipt-bytes').length)
      // Digest bytes appear at the right offset (after magic + 2 opcode bytes).
      expect(buf.subarray(33, 65).toString('hex')).toBe(digestHex)
    })

    it('throws when the head hash is not 32 bytes', () => {
      // 30-byte hex → not SHA-256 sized.
      const shortHex = 'a'.repeat(60)
      expect(() => anchor.buildOtsBundle(shortHex, '')).toThrow(/32 bytes/)
    })
  })

  describe('lookup edge cases', () => {
    it('getAnchorById returns null for an unknown id', () => {
      expect(anchor.getAnchorById('nope-nope-nope')).toBeNull()
    })

    it('verifyLatestAnchor reports ok:false when no anchor exists yet', () => {
      insertEvent('shell', { command: 'x' })
      const v = anchor.verifyLatestAnchor()
      expect(v.ok).toBe(false)
      expect(v.anchor).toBeNull()
      expect(v.currentHead).toMatch(/^[0-9a-f]{64}$/)
    })

    it('computeChainHead(maxEvents=0) returns null even when events exist', () => {
      insertEvent('shell', { command: 'a' })
      insertEvent('shell', { command: 'b' })
      expect(anchor.computeChainHead(0)).toBeNull()
    })

    it('computeChainHead(maxEvents=1) yields the first event only', () => {
      insertEvent('shell', { command: 'a' })
      insertEvent('shell', { command: 'b' })
      const h = anchor.computeChainHead(1)
      expect(h?.eventCount).toBe(1)
      expect(h?.hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('listAnchors with limit=0 returns an empty array', async () => {
      insertEvent('shell', { command: 'a' })
      await anchor.anchorNow([])
      expect(anchor.listAnchors(0)).toEqual([])
    })
  })
})
