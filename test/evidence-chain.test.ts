import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// evidence-chain depends on the native better-sqlite3 module; use the same
// conditional-import guard as the rest of the DB-backed test suites.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let insertEventRaw: typeof import('../src/core/db/events').insertEvent
let getChainLength: typeof import('../src/core/evidence-chain').getChainLength

let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  const evMod = await import('../src/core/db/events')
  const ecMod = await import('../src/core/evidence-chain')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  insertEventRaw = evMod.insertEvent
  getChainLength = ecMod.getChainLength
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }

const insertEvent: typeof import('../src/core/db/events').insertEvent = (agentType, data, opts) =>
  insertEventRaw(agentType, data, { operatorId: 'test-op', ...opts })

const describeDB = dbAvailable ? describe : describe.skip

describeDB('evidence-chain', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-chain-'))
    initDB(tmpDir)
  })

  afterEach(() => {
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 0 when no events exist', () => {
    expect(getChainLength()).toBe(0)
  })

  it('counts events that have a non-null hash', () => {
    insertEvent('shell', { command: 'ls' })
    insertEvent('shell', { command: 'pwd' })
    insertEvent('dns', { query: 'example.com' })

    const len = getChainLength()
    expect(len).toBe(3)
  })

  it('increments as new events are inserted', () => {
    expect(getChainLength()).toBe(0)
    insertEvent('shell', { command: 'a' })
    expect(getChainLength()).toBe(1)
    insertEvent('shell', { command: 'b' })
    expect(getChainLength()).toBe(2)
  })
})
