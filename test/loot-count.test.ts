import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  dbAvailable = true
} catch { /* better-sqlite3 not compiled */ }
const describeDB = dbAvailable ? describe : describe.skip

describeDB('getLootCount', () => {
  let tmpDir: string
  let operatorId: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-lootcount-'))
    initDB(tmpDir)
    operatorId = ops.ensurePrimaryOperator('loot-op', 'Loot Op', 'tok-' + Math.random()).id
  })
  afterEach(() => { closeDB(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  // The sidebar, the Dashboard and the Loot page title all say how much loot
  // there is. One detection that found two secrets is two findings (Spec 031),
  // and the page already counts them that way.
  it('counts secrets, not detection events', () => {
    events.insertEvent('loot', {
      subtype: 'credential_detected',
      matches: [
        { type: 'aws_access_key', confidence: 'high', preview: 'AKIA...' },
        { type: 'private_key_header', confidence: 'high', preview: '-----BEGIN RSA PRIVATE KEY-----' }
      ]
    }, { operatorId, targetId: '10.0.0.1' })
    events.insertEvent('loot', {
      subtype: 'credential_detected',
      matches: [{ type: 'jwt', confidence: 'medium', preview: 'eyJ...' }]
    }, { operatorId })
    expect(events.getLootCount()).toBe(3)
  })
})
