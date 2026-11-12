// Spec 071 T011 / T012 (US3): what the hook-spool drain does with a file it
// will not write, and with what earlier versions left behind.
//
// Before: anything that threw — a payload that would not parse, but also a
// database that was busy for a moment — was renamed `*.bad` and never looked at
// again, and nothing in any record said so. A file the open project could not
// claim was renamed `*.unattributed` in place.
//
// Now the two are told apart:
//   - invalid: never worth retrying. Planned into the quarantine as
//     `<reason>--<name>` with a `.why` beside it — under the project it names,
//     or `_unknown/` when that cannot be read — counted in a chained
//     `system.capture_gap` in the open project, and moved only once that row
//     is committed (applySpoolLosses; the drain does this).
//   - failed: not written, or not read, this time. The file stays where it is
//     and is tried again later, less often each time.
// A `.bad` or `.unattributed` an earlier version left is moved into quarantine
// once (`legacy-bad`, `no-project`). Each quarantine directory is bounded
// (FR-066); see test/pause-spool-review.test.ts for what happens past the bound.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'
import { replaySpoolDirectory, applySpoolActions, summarizeUnattributedSpool, clearUnattributedSpool } from '../src/core/spool-replay'

const sqlite = requires('better-sqlite3')

let db: typeof import('../src/core/db/index')
let ops: typeof import('../src/core/db/operators')
let ingestMod: typeof import('../src/core/ingest')
let drain: typeof import('./helpers/spool-drain-as-main')
if (sqlite.ok) {
  db = await import('../src/core/db/index')
  ops = await import('../src/core/db/operators')
  ingestMod = await import('../src/core/ingest')
  drain = await import('./helpers/spool-drain-as-main')
}

const ACTIVE = { engagementId: 'eng-q', operatorId: 'op-q' }
const HOUR = 3600_000

const dirs: string[] = []
const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-q-${label}-`)); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const put = (dir: string, name: string, body: unknown, mtime?: number): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}
const shell = (command: string, identity: object | null = ACTIVE) => ({
  agent_type: 'shell', data: { subtype: 'command_start', command, terminalId: 't-q', pid: 7 },
  ...(identity ? { _identity: identity } : {})
})
const quarantined = (dir: string, sub: string): string[] => {
  const q = path.join(dir, 'quarantine', sub)
  return fs.existsSync(q) ? fs.readdirSync(q).sort() : []
}
const why = (dir: string, sub: string, name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'quarantine', sub, `${name}.why`), 'utf8')) as Record<string, unknown>

describe('a spool file that can never be written (T011)', () => {
  it('is planned into quarantine under its reason, moved once counted, with a .why beside it, and not looked at again', () => {
    const d = tmp('malformed')
    const file = put(d, '0001.json', '{"agent_type":"shell","data":', Date.now() - HOUR)
    const r = replaySpoolDirectory(d, ACTIVE, () => true)
    expect(r.invalid).toBe(1)
    // Only planned: nothing moves until the gap row that counts it is in.
    expect(fs.existsSync(file)).toBe(true)
    expect(applySpoolActions(r.losses.flatMap((l) => l.files))).toEqual({ '0001.json': 'quarantined' })
    expect(fs.existsSync(file)).toBe(false)
    expect(quarantined(d, '_unknown')).toEqual(['malformed--0001.json', 'malformed--0001.json.why'])
    expect(why(d, '_unknown', 'malformed--0001.json')).toMatchObject({ reason: 'malformed', receiver: expect.any(String), at: expect.any(Number) })
    expect(typeof why(d, '_unknown', 'malformed--0001.json').detail).toBe('string')
    expect(replaySpoolDirectory(d, ACTIVE, () => true).invalid).toBe(0)
  })

  it('keeps a file that may still be being written', () => {
    const d = tmp('young')
    const file = put(d, '0001.json', '{"agent_type":"shell"')
    const first = replaySpoolDirectory(d, ACTIVE, () => true)
    expect({ invalid: first.invalid, failed: first.failed, outcome: first.outcomes['0001.json'] }).toEqual({ invalid: 0, failed: 1, outcome: 'deferred' })
    expect(fs.existsSync(file)).toBe(true)
  })

  it('keeps a just-written file whose mtime reads a moment ahead of the clock', () => {
    const d = tmp('young-ahead')
    put(d, '0001.json', '{"agent_type":"shell"', Date.now() + 500)
    expect(replaySpoolDirectory(d, ACTIVE, () => true).outcomes['0001.json']).toBe('deferred')
  })

  it('quarantines what the emitter refused as invalid in the project it names', () => {
    const d = tmp('refused')
    put(d, '0001.json', shell('id'))
    const r = replaySpoolDirectory(d, ACTIVE, () => ({ outcome: 'invalid', reason: 'kind-not-allowed', detail: 'agent_type "system"' }))
    expect(r.invalid).toBe(1)
    expect(r.losses).toEqual([expect.objectContaining({ reason: 'kind-not-allowed', intentional: false, count: 1, kept: 1, owners: { this: 1, unknown: 0 } })])
    applySpoolActions(r.losses.flatMap((l) => l.files))
    expect(quarantined(d, ACTIVE.engagementId)).toEqual(['kind-not-allowed--0001.json', 'kind-not-allowed--0001.json.why'])
  })
})

describe('a spool file whose write failed (T011)', () => {
  it('stays where it is, is not retried at once, and is retried after a back-off', () => {
    const d = tmp('failed')
    const file = put(d, '0001.json', shell('id'))
    let now = Date.UTC(2026, 10, 12, 10, 0, 0)
    let calls = 0
    const throwing = (): boolean => { calls++; throw new Error('SQLITE_BUSY') }
    const first = replaySpoolDirectory(d, ACTIVE, throwing, Infinity, '', { now: () => now })
    expect({ failed: first.failed, invalid: first.invalid, calls }).toEqual({ failed: 1, invalid: 0, calls: 1 })
    expect(fs.existsSync(file)).toBe(true)
    now += 1000
    expect(replaySpoolDirectory(d, ACTIVE, throwing, Infinity, '', { now: () => now }).last).toBe('0001.json')
    expect(calls).toBe(1)
    now += 10 * 60_000
    const later = replaySpoolDirectory(d, ACTIVE, () => true, Infinity, '', { now: () => now })
    expect(later.replayed).toBe(1)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('the #255 line reads the quarantine (T012)', () => {
  it('a file with no project goes to quarantine/_no-project, and the summary and clear find it there', () => {
    const d = tmp('noproject')
    const t = Date.UTC(2026, 9, 11, 23, 15, 0)
    put(d, '0001.json', shell('id', null), t)
    const r = replaySpoolDirectory(d, ACTIVE, () => true)
    expect(r.unattributed).toBe(1)
    expect(quarantined(d, '_no-project')).toEqual(['no-project--0001.json', 'no-project--0001.json.why'])
    expect(summarizeUnattributedSpool(d)).toEqual({ count: 1, oldestAt: t, newestAt: t })
    expect(clearUnattributedSpool(d, t)).toEqual({ removed: 1, failed: 0 })
    expect(quarantined(d, '_no-project')).toEqual([])
    expect(summarizeUnattributedSpool(d)).toBeNull()
  })
})

sqlite.describe('through the drain, in the open project (T010–T012)', () => {
  let dir = ''
  let spool = ''
  let keys = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR
  beforeEach(() => {
    dir = tmp('db'); spool = tmp('spool'); keys = tmp('keys')
    process.env.REDLOG_KEYS_DIR = keys
    db.initDB(dir)
    db.bindDBEngagement(ACTIVE.engagementId)
    ingestMod._resetIngest()
    ops.createOperator({ id: ACTIVE.operatorId, name: 'Q', token: ops.generateToken(), isPrimary: true })
  })
  afterEach(() => {
    db.closeDB()
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  const gaps = (): Array<Record<string, unknown>> =>
    (db.getDB().prepare(`SELECT data, hash FROM events WHERE agent_type = 'system' AND subtype = 'capture_gap' ORDER BY rowid`).all() as Array<{ data: string; hash: string | null }>)
      .map((r) => ({ ...JSON.parse(r.data) as Record<string, unknown>, chained: r.hash !== null }))

  it('a kind the spool may not write is quarantined and leaves a chained gap row', () => {
    put(spool, '0001.json', { agent_type: 'marker', data: { subtype: 'finding', title: 'forged' }, _identity: ACTIVE })
    drain.drainSpoolAsMain(spool, ACTIVE)
    expect(quarantined(spool, ACTIVE.engagementId)).toEqual(['kind-not-allowed--0001.json', 'kind-not-allowed--0001.json.why'])
    expect(gaps()).toEqual([expect.objectContaining({ subtype: 'capture_gap', reason: 'kind-not-allowed', skipped_units: 1, intentional: false, chained: true })])
    expect(db.getDB().prepare(`SELECT COUNT(*) AS n FROM events WHERE agent_type = 'marker'`).get()).toEqual({ n: 0 })
  })

  it('earlier versions\' .bad and .unattributed files are moved into quarantine once, and counted once', () => {
    const t = Date.UTC(2026, 9, 1, 8, 0, 0)
    put(spool, '0001.json.bad', shell('mine'), t)
    put(spool, '0002.json.bad', '{', t)
    put(spool, '0003.json.bad', shell('theirs', { engagementId: 'eng-other', operatorId: 'op-x' }), t)
    put(spool, '0004.json.unattributed', shell('nobody', null), t)
    drain.drainSpoolAsMain(spool, ACTIVE)
    expect(quarantined(spool, ACTIVE.engagementId)).toEqual(['legacy-bad--0001.json', 'legacy-bad--0001.json.why'])
    expect(quarantined(spool, '_unknown')).toEqual(['legacy-bad--0002.json', 'legacy-bad--0002.json.why'])
    expect(quarantined(spool, '_no-project')).toEqual(['no-project--0004.json', 'no-project--0004.json.why'])
    // Another project's file is that project's to count, when it opens.
    expect(fs.existsSync(path.join(spool, '0003.json.bad'))).toBe(true)
    // One row per reason, naming its files; whose they are is in its numbers.
    expect(gaps()).toEqual([
      expect.objectContaining({ reason: 'legacy-bad', skipped_units: 2, quarantined: 2, by_owner: { this: 1, unknown: 1 }, files: ['0001.json.bad', '0002.json.bad'], chained: true })
    ])
    expect(summarizeUnattributedSpool(spool)).toEqual({ count: 1, oldestAt: t, newestAt: t })
    // Once: a second drain finds nothing left to move or count.
    drain.drainSpoolAsMain(spool, ACTIVE)
    expect(gaps()).toHaveLength(1)
  })
})
