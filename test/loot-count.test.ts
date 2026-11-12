import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requires } from './helpers/requires'
import fs from 'fs'
import path from 'path'
import os from 'os'

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let dbAvailable = false
if (requires('better-sqlite3').ok) {
  const dbMod =await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB
  dbAvailable = true
}
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
    expect(events.lootCountIsPartial()).toBe(false)
  })

  // #695: an event that found more than it could store makes the count a
  // lower bound; the count itself still counts what is stored.
  it('says when the count is a lower bound', () => {
    events.insertEvent('loot', {
      subtype: 'credential_detected', count: 1, matches_truncated: true, matches_total: 900,
      matches: [{ type: 'password_hash', confidence: 'high', preview: '$6$...' }]
    }, { operatorId })
    expect(events.getLootCount()).toBe(1)
    expect(events.lootCountIsPartial()).toBe(true)
  })
})
