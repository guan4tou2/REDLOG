// Spec 071 Phase 2, after the adversarial review of 3910075a/0ea8d210.
//
// The pause rule the review ruled for (spec 071 FR-082 修訂 2026-11-13):
//   - a LIVE door (API, in-process) is judged by receipt time, as on main: if
//     recording is paused now the item is refused. A producer's own time is a
//     claim, not a fact, and a rule that trusted it wrote paused content under
//     a slow producer clock (P8), a delayed relay chunk (P12) and a clock that
//     stepped back (P1).
//   - the SPOOL drain does not run while paused. After a resume or a reopen it
//     refuses a file only when its source time, if usable, lies inside a pause
//     this project RECORDED (an unresumed one ends at the reopen); everything
//     else is written at receipt, as on main.
// And for every file the drain touches: the gap row is committed before a
// file is removed or moved; a file of another project, or whose owner cannot
// be read, is never deleted; a read error is retried, not condemned.
//
// Probe numbers are the reviewer's (P1–P12).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { requires } from './helpers/requires'

const sqlite = requires('better-sqlite3')

let db: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let ing: typeof import('../src/core/ingest')
let busMod: typeof import('../src/core/event-bus')
let drain: typeof import('../src/core/spool-drain')
if (sqlite.ok) {
  db = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  ing = await import('../src/core/ingest')
  busMod = await import('../src/core/event-bus')
  drain = await import('../src/core/spool-drain')
}

const ENG = 'eng-A'
const OP = 'op-A'
const id = { engagementId: ENG, operatorId: OP }
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0)
const SEC = 1000
const API = { source: 'api', mapper: { id: 'identity', version: '1' } }

sqlite.describe('the pause rule and the spool drain after review', () => {
  let dir = ''
  let spool = ''
  let keys = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR
  const bus = (): typeof import('../src/core/event-bus').eventBus => busMod.eventBus
  const at = (ms: number): void => { vi.setSystemTime(ms) }
  const pause = (ms: number): void => { at(ms); bus().pause('ui'); events.insertEvent('system', { subtype: 'recording_paused', source: 'ui' }, id) }
  const resume = (ms: number): void => { at(ms); bus().resume('ui'); events.insertEvent('system', { subtype: 'recording_resumed', source: 'ui' }, id) }
  const rows = (): Array<{ type: string; subtype: string; t: number; data: Record<string, unknown> }> =>
    (db.getDB().prepare(`SELECT agent_type, subtype, timestamp, data FROM events WHERE agent_type <> 'system' OR subtype = 'capture_gap'
      UNION ALL SELECT agent_type, subtype, timestamp, data FROM events_logged`).all() as Array<{ agent_type: string; subtype: string; timestamp: number; data: string }>)
      .map((r) => ({ type: r.agent_type, subtype: r.subtype, t: r.timestamp, data: JSON.parse(r.data) as Record<string, unknown> }))
  const commands = (): string[] => rows().filter((r) => r.type === 'shell').map((r) => String(r.data.command))
  const gaps = (): Array<Record<string, unknown>> => rows().filter((r) => r.subtype === 'capture_gap' && r.type === 'system').map((r) => r.data)
  const put = (name: string, body: string | object, mtime?: number): string => {
    const f = path.join(spool, name)
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body))
    if (mtime !== undefined) fs.utimesSync(f, mtime / 1000, mtime / 1000)
    return f
  }
  const ls = (d: string): string[] => { try { return fs.readdirSync(d).sort() } catch { return [] } }
  const walk = (d: string): string[] => ls(d).flatMap((n) => fs.statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)).map((m) => `${n}/${m}`) : [n])
  const shell = (command: string, extra: Record<string, unknown> = {}, identity: object = id): object =>
    ({ agent_type: 'shell', data: { subtype: 'command_start', command, terminalId: `t-${command}`, pid: 1, ...extra }, _identity: identity })

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-review-db-'))
    spool = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-review-spool-'))
    keys = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-review-keys-'))
    process.env.REDLOG_KEYS_DIR = keys
    db.initDB(dir)
    db.bindDBEngagement(ENG)
    ing._resetIngest()
    ops.createOperator({ id: OP, name: 'P', token: ops.generateToken(), isPrimary: true })
  })
  afterEach(() => {
    if (bus().paused) bus().resume('ui')
    ing.configureIngest({ terminalLifecycle: null })
    vi.useRealTimers()
    db.closeDB()
    for (const d of [dir, spool, keys]) {
      for (const f of walk(d)) { try { fs.chmodSync(path.join(d, f), 0o600) } catch { /* gone */ } }
      fs.rmSync(d, { recursive: true, force: true })
    }
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  // ── Live doors: receipt time ─────────────────────────────────────────────

  sqlite.it('P1: the clock steps back during a pause — a live event is still refused', () => {
    pause(T0 + 10 * SEC)
    at(T0 + 5 * SEC)
    const r = ing.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'cat /secret', terminalId: 't1', pid: 1 }, ...id })
    expect(r.skipped).toBe('paused')
    expect(commands()).toEqual([])
  })

  sqlite.it('P8: a producer clock 30 s slow, 10 s into a pause — refused; after the resume — written', () => {
    pause(T0 + 100 * SEC)
    at(T0 + 110 * SEC)
    const during = ing.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'cat /private/diary', terminalId: 't', pid: 7, source_timestamp: T0 + 80 * SEC }, ...id, envelope: API })
    resume(T0 + 200 * SEC)
    at(T0 + 205 * SEC)
    const after = ing.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'nmap after-resume', terminalId: 't', pid: 8, source_timestamp: T0 + 175 * SEC }, ...id, envelope: API })
    expect({ during: during.skipped, after: !!after.event }).toEqual({ during: 'paused', after: true })
    expect(commands()).toEqual(['nmap after-resume'])
  })

  sqlite.it('P12: a relay chunk stamped 0.5 s before the pause and flushed inside it is refused', () => {
    pause(T0 + 10 * SEC)
    at(T0 + 11 * SEC)
    const bytes = Buffer.from('typed after pause: s3cr3t-password\n')
    const r = ing.ingest({ agentType: 'shell', data: { subtype: 'command_output', command_id: 'c-relay', seq: 1, streamed: true, stream: 'stdout',
      source_timestamp: T0 + 9500, stdout: bytes.toString(), output_body: { data: bytes.toString('base64'), encoding: 'base64', size: bytes.length, sha256: '' }, final: false }, ...id, envelope: API })
    expect(r.skipped).toBe('paused')
    expect(rows().filter((x) => x.type === 'shell')).toEqual([])
  })

  sqlite.it('P7: an item claiming a time before the pause, arriving during it, writes no row and no companion', () => {
    pause(T0 + 10 * SEC)
    at(T0 + 15 * SEC)
    const r = ing.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'ssh -D 1080 root@10.0.0.5', terminalId: 't', pid: 6, source_timestamp: T0 + 9 * SEC }, ...id })
    expect({ event: r.event, companions: r.companions.length }).toEqual({ event: null, companions: 0 })
    expect(rows().filter((x) => x.type !== 'system')).toEqual([])
  })

  sqlite.it('P10: a live door does not reason about an earlier in-process pause by the producer\'s time', () => {
    at(T0 + 10 * SEC); bus().pause('ui'); at(T0 + 20 * SEC); bus().resume('ui')
    at(T0 + 50 * SEC)
    const r = ing.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'claims-to-be-in-the-pause', terminalId: 't', pid: 9, source_timestamp: T0 + 15 * SEC }, ...id })
    expect(!!r.event).toBe(true)
  })

  // ── The spool drain ──────────────────────────────────────────────────────

  sqlite.it('the drain does not run while paused', () => {
    put('0001.json', shell('waits', { source_timestamp: T0 - 60 * SEC }))
    pause(T0 + 10 * SEC)
    expect(drain.drainSpoolOnce(spool, id)).toBeNull()
    expect(ls(spool)).toEqual(['0001.json'])
    resume(T0 + 20 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['waits'])
  })

  sqlite.it('P2: a file whose source time is rejected (seconds; 120 s fast) counts as having none — written after the resume, not refused', () => {
    put('0001.json', shell('nmap 10.0.0.1', { source_timestamp: Math.floor((T0 + SEC) / 1000) }), T0 + SEC)
    put('0002.json', shell('whoami', { source_timestamp: T0 + 122 * SEC }), T0 + 2 * SEC)
    pause(T0 + 30 * SEC)
    expect(drain.drainSpoolOnce(spool, id)).toBeNull()
    resume(T0 + 40 * SEC)
    at(T0 + 50 * SEC)
    const run = drain.drainSpoolOnce(spool, id)!
    expect(run.losses).toEqual([])
    expect(commands().sort()).toEqual(['nmap 10.0.0.1', 'whoami'])
    expect(ls(spool)).toEqual([])
  })

  sqlite.it('P3: a file with no source time is written after the resume, whatever its mtime', () => {
    pause(T0 + 10 * SEC)
    put('0001.json', { agent_type: 'pcap', target_id: '10.0.0.9', data: { subtype: 'port_scan', at: T0 + 8 * SEC }, _identity: id }, T0 + 11 * SEC)
    resume(T0 + 20 * SEC)
    at(T0 + 60 * SEC)
    const run = drain.drainSpoolOnce(spool, id)!
    expect(run.losses).toEqual([])
    expect(rows().filter((r) => r.type === 'pcap')).toHaveLength(1)
  })

  sqlite.it('F6: a loss record a producer spooled is never removed as paused', () => {
    pause(T0 + 10 * SEC)
    resume(T0 + 20 * SEC)
    for (const [n, reason] of [['0001', 'delivery-unconfirmed'], ['0002', 'project-switched']]) {
      put(`${n}.json`, { agent_type: 'scanner', data: { subtype: 'capture_gap', source: 'mitmproxy', reason, skipped_units: 3, source_timestamp: T0 + 15 * SEC, gap_started_at: T0 + 15 * SEC, gap_ended_at: T0 + 15 * SEC }, _identity: id })
    }
    at(T0 + 30 * SEC)
    const run = drain.drainSpoolOnce(spool, id)!
    expect(run.losses).toEqual([])
    expect(rows().filter((r) => r.type === 'scanner' && r.subtype === 'capture_gap').map((r) => r.data.reason).sort()).toEqual(['delivery-unconfirmed', 'project-switched'])
  })

  sqlite.it('F11: a recorded pause with no resume ends at the reopen', () => {
    pause(T0 + 10 * SEC)
    bus().resume('ui') // the process forgets; the record does not (a crash while paused)
    db.closeDB()
    at(T0 + 60 * SEC)
    db.initDB(dir); db.bindDBEngagement(ENG); ing._resetIngest()
    put('0001.json', shell('typed-while-down-and-paused', { source_timestamp: T0 + 30 * SEC }))
    put('0002.json', shell('typed-after-the-reopen', { source_timestamp: T0 + 70 * SEC }))
    at(T0 + 80 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['typed-after-the-reopen'])
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'paused', intentional: true, skipped_units: 1 })])
  })

  sqlite.it('F4: when the gap row cannot be committed, the file it counts stays where it is', () => {
    const forged = put('0001.json', { agent_type: 'system', data: { subtype: 'recording_resumed' }, _identity: id })
    db.bindDBEngagement('eng-someone-else') // every write to ENG is now refused
    const run = drain.drainSpoolOnce(spool, id)!
    db.bindDBEngagement(ENG)
    expect(fs.existsSync(forged), 'a counted file went before its gap row').toBe(true)
    expect(run.outcomes['0001.json']).toBe('deferred')
    // Once the row can be written, it is, and only then is the file moved.
    drain.drainSpoolOnce(spool, id)
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'kind-not-allowed', skipped_units: 1 })])
    expect(fs.existsSync(forged)).toBe(false)
  })

  sqlite.it('F12: one gap row per reason per drain, however many slices it took — and the files go only after it', async () => {
    const { drainInSlices } = await import('../src/core/spool-replay')
    for (let n = 0; n < 25; n++) put(`${String(n).padStart(4, '0')}.json`, { agent_type: 'system', data: { subtype: 'config_changed' }, _identity: id })
    const queue: Array<() => void> = []
    let session: InstanceType<typeof drain.SpoolDrainSession> | null = null
    let movedBeforeFinish = -1
    const tick = drainInSlices({
      drainOnce: (limit, after) => {
        if (after === '') session = new drain.SpoolDrainSession(id)
        return drain.drainSpoolOnce(spool, id, limit, after, {}, session!)?.last ?? null
      },
      finish: () => { movedBeforeFinish = ls(spool).filter((n) => n.endsWith('.json')).length; session?.commit() },
      total: 200, slice: 10, isCurrent: () => true, schedule: (next) => { queue.push(next) }
    })
    tick()
    while (queue.length > 0) queue.shift()!()
    expect(movedBeforeFinish, 'every counted file is still in place until the drain commits').toBe(25)
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'kind-not-allowed', skipped_units: 25 })])
    expect(ls(spool).filter((n) => n.endsWith('.json'))).toEqual([])
  })

  sqlite.it('P4/F5: another project\'s file and a file of unknown owner are never deleted, however full the quarantine', () => {
    put('a.json.unattributed', '{"agent_type":"shell","data":{}}', T0 - 86400e3)
    put('b.json.unattributed', '{"agent_type":"shell","data":{}}', T0 - 86400e3)
    put('c.json', '{"agent_type":"shell","data":{"command":"evidence-of-B"},"_identity":{"engagementId":"eng-B","operatorId":"op-B"', T0 - 3600e3)
    put('d.json', { agent_type: 'shell', _identity: { engagementId: 'eng-B', operatorId: 'op-B' } }, T0 - 3600e3)
    put('e.json', '{', T0 - 3600e3)
    drain.drainSpoolOnce(spool, id, Infinity, '', { quarantineMaxFiles: 1 })
    const everywhere = walk(spool)
    // d names eng-B: deferred for it, in place.
    expect(everywhere).toContain('d.json')
    // c and e cannot say whose they are: one went to _unknown, the other — no
    // room — stayed. Neither is gone.
    expect(everywhere.filter((n) => /(^|\/)(malformed--)?[ce]\.json$/.test(n))).toHaveLength(2)
    expect(everywhere.some((n) => n.startsWith('quarantine/_unknown/'))).toBe(true)
    // The unattributed piles went to their own place and fill no project's bound.
    expect(everywhere.filter((n) => n.startsWith('quarantine/_no-project/') && !n.endsWith('.why'))).toHaveLength(1)
  })

  sqlite.it('F5: only the open project\'s own file is dropped when its quarantine is full — after its gap row', () => {
    put('0001.json', { agent_type: 'marker', data: { subtype: 'finding' }, _identity: id })
    put('0002.json', { agent_type: 'loot', data: { subtype: 'credential' }, _identity: id })
    const run = drain.drainSpoolOnce(spool, id, Infinity, '', { quarantineMaxFiles: 1 })!
    expect(run.outcomes).toEqual({ '0001.json': 'quarantined', '0002.json': 'dropped' })
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'kind-not-allowed', skipped_units: 2, quarantined: 1, content_not_kept: 1 })])
    expect(walk(spool).filter((n) => !n.endsWith('.why'))).toEqual([`quarantine/${ENG}/kind-not-allowed--0001.json`])
  })

  sqlite.it('P5/F9: a read error is retried with back-off, not condemned; restored permissions let the file through', () => {
    if (process.platform === 'win32') return // chmod 000 does not stop the owner reading on Windows
    const f = put('0001.json', shell('id-after-eacces', { source_timestamp: T0 - 60 * SEC }), T0 - 60 * SEC)
    fs.chmodSync(f, 0o000)
    const first = drain.drainSpoolOnce(spool, id)!
    expect({ failed: first.failed, invalid: first.invalid, outcome: first.outcomes['0001.json'] }).toEqual({ failed: 1, invalid: 0, outcome: 'deferred' })
    expect(walk(spool)).toEqual(['0001.json'])
    fs.chmodSync(f, 0o600)
    at(T0 + 10 * 60 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['id-after-eacces'])
  })

  sqlite.it('F7: a file whose write keeps failing is quarantined after a bounded number of tries, with a gap row', () => {
    ing.configureIngest({ terminalLifecycle: { prepare: () => { throw new Error('pipeline down') }, recorded: () => undefined } })
    put('0001.json', shell('never-lands'))
    let t = T0
    for (let i = 0; i < 12; i++) { at(t); drain.drainSpoolOnce(spool, id); t += 31 * 60 * SEC }
    ing.configureIngest({ terminalLifecycle: null })
    expect(walk(spool).filter((n) => !n.endsWith('.why'))).toEqual([`quarantine/${ENG}/failed--0001.json`])
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'failed', skipped_units: 1 })])
  })

  sqlite.it('P11/F7: a throw after the row is committed does not make the file retried', () => {
    ing.configureIngest({ terminalLifecycle: { prepare: () => true, recorded: () => { throw new Error('post-commit bug') } } })
    put('0001.json', shell('id', { source_timestamp: T0 - 60 * SEC }))
    for (const dt of [0, 31, 92, 213, 454]) { at(T0 + dt * SEC); drain.drainSpoolOnce(spool, id) }
    ing.configureIngest({ terminalLifecycle: null })
    expect(ls(spool)).toEqual([])
    expect(commands()).toEqual(['id'])
  })

  sqlite.it('P9/F10: an unparseable file with a future mtime is not "young" — it is set aside and counted', () => {
    put('0001.json', '{"agent_type":', T0 + 86400e3)
    const run = drain.drainSpoolOnce(spool, id)!
    expect(run.outcomes['0001.json']).toBe('quarantined')
    expect(walk(spool).filter((n) => !n.endsWith('.why'))).toEqual(['quarantine/_unknown/malformed--0001.json'])
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'malformed', by_owner: { this: 0, unknown: 1 }, skipped_units: 1 })])
  })

  sqlite.it('F10: every file ends in exactly one outcome, never none', () => {
    pause(T0 + 10 * SEC)
    resume(T0 + 20 * SEC)
    at(T0 + 30 * SEC)
    const files: Record<string, string | object> = {
      'a-written.json': shell('written', { source_timestamp: T0 + 25 * SEC }),
      'b-paused.json': shell('in-pause', { source_timestamp: T0 + 15 * SEC }),
      'c-other.json': shell('theirs', {}, { engagementId: 'eng-B', operatorId: 'op-B' }),
      'd-noproject.json': { agent_type: 'shell', data: { subtype: 'command_start', command: 'nobody' } },
      'e-forged.json': { agent_type: 'system', data: { subtype: 'config_changed' }, _identity: id },
      'f-garbage.json': '{',
      'g-nodata.json': { agent_type: 'shell', _identity: id },
      'h-plumbing.json': shell('_redlog_prompt_command')
    }
    for (const [n, body] of Object.entries(files)) put(n, body, T0 - 3600e3)
    const run = drain.drainSpoolOnce(spool, id)!
    expect(run.outcomes).toEqual({
      'a-written.json': 'ingested', 'b-paused.json': 'dropped', 'c-other.json': 'deferred', 'd-noproject.json': 'quarantined',
      'e-forged.json': 'quarantined', 'f-garbage.json': 'quarantined', 'g-nodata.json': 'quarantined', 'h-plumbing.json': 'ingested'
    })
  })
})
