// Spec 071 T007 (RED, US4): the spool is a second door into the record, and it
// does not ask the question the API asks.
//
// POST /api/events refuses `system` from outside — RedLog's own audit lane
// (recording_paused/resumed, config_changed, sanitized, …) — except the
// producer heartbeat (src/core/external-event-policy.ts). The hook spool
// directory (~/.redlog/pending) is writable by the same user, and its drain
// (src/main/index.ts, drainSpool) hands every file straight to ingest() with
// whatever agent_type it names. replaySpoolDirectory checks only that the
// identity names the open project. So a file the API would answer 403 becomes a
// signed, chained row — a forged `recording_resumed` included, which also moves
// lastRecordingResumeTime() and with it the pause gate for delayed output.
//
// Phase 2 (T010) routes the spool through the same per-source kind policy and
// quarantines the file (src/core/spool-drain.ts, `legacy-handoff`); the test
// below was `it.fails` until then.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect } from 'vitest'
import { requires } from './helpers/requires'

const sqlite = requires('better-sqlite3')

let db: typeof import('../src/core/db/index')
let ops: typeof import('../src/core/db/operators')
let policy: typeof import('../src/core/external-event-policy')
let drain: typeof import('./helpers/spool-drain-as-main')
if (sqlite.ok) {
  db = await import('../src/core/db/index')
  ops = await import('../src/core/db/operators')
  policy = await import('../src/core/external-event-policy')
  drain = await import('./helpers/spool-drain-as-main')
}

const ENG = 'eng-spool'
const OP = 'op-spool'

sqlite.describe('a spool file naming a kind the API refuses', () => {
  let dir = ''
  let spool = ''
  let keys = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bypass-'))
    spool = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bypass-spool-'))
    keys = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bypass-keys-'))
    process.env.REDLOG_KEYS_DIR = keys
    db.initDB(dir)
    db.bindDBEngagement(ENG)
    ops.createOperator({ id: OP, name: 'Spool', token: ops.generateToken(), isPrimary: true })
  })
  afterEach(() => {
    db.closeDB()
    for (const d of [dir, spool, keys]) fs.rmSync(d, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  const forged = { subtype: 'recording_resumed', source: 'operator', description: 'Recording resumed' }
  const writeSpool = (): string => {
    const file = path.join(spool, '0001-forged.json')
    fs.writeFileSync(file, JSON.stringify({ agent_type: 'system', data: forged, _identity: { engagementId: ENG, operatorId: OP } }))
    return file
  }
  const chainedForged = (): Array<{ agent_type: string; subtype: string; data: string }> =>
    db.getDB().prepare(`SELECT agent_type, subtype, data FROM events WHERE subtype = 'recording_resumed'`).all() as Array<{ agent_type: string; subtype: string; data: string }>

  sqlite.it('the copy of main\'s drain still matches src/main/index.ts', () => {
    expect(drain.mainDrainDrift()).toEqual([])
  })

  sqlite.it('is a kind POST /api/events refuses', () => {
    expect(policy.isExternalEventAllowed('system', forged)).toBe(false)
  })

  sqlite.it('is not written to the chain by the spool drain', () => {
    const file = writeSpool()
    const run = drain.drainSpoolAsMain(spool, { engagementId: ENG, operatorId: OP })
    expect(chainedForged(), 'a system row the API would refuse reached the chain through the spool').toEqual([])
    // Not written, not deleted: set aside under its reason (T010).
    expect(run?.invalid).toBe(1)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readdirSync(path.join(spool, 'quarantine')).sort()).toEqual(['kind-not-allowed--0001-forged.json', 'kind-not-allowed--0001-forged.json.why'])
  })
})
