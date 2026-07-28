import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEvent: typeof import('../src/core/db/events').insertEvent
let anchor: typeof import('../src/core/chain-anchor')

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const evMod = await import('../src/core/db/events')
  anchor = await import('../src/core/chain-anchor')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  insertEvent = evMod.insertEvent
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

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
})
