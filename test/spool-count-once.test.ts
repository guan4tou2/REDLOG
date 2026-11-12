// Spec 071 Phase 2, third review (probes A–J). Each test states a rule:
//
//   - a spool file is COUNTED at most once, across drains and restarts: the
//     gap row names the files it counts, and a file a committed row names is
//     not counted again — only its move or removal is retried (A);
//   - one drain shares one quarantine reservation across its slices and the
//     legacy migration (I, J);
//   - one gap row per reason per drain, split only past FILES_PER_ROW names,
//     with per-owner counts in its data (E);
//   - a loss is placed in time only by a usable source time (F);
//   - another project's file that cannot be read is left where it is (G);
//   - a pause between slices commits nothing (H);
//   - a command_end is refused when its output started, or the command
//     started, inside a recorded pause, or its output spans one (B, C);
//   - a pause begun in this session with no resume row yet makes the drain
//     wait, never drop (D); a failed marker write is retried.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import { writeMarkerWithRetry, writePersistedMarkers, recordProjectOpen, MARKER_RETRY_DELAYS_MS } from '../src/core/recording-state-marker'

// Failures reported where capture-write failures are, observed here.
const dbErrors = vi.hoisted(() => [] as string[])
vi.mock('../src/core/capture-health', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/capture-health')>(),
  noteDbError: (source: string) => { dbErrors.push(source) }
}))

const sqlite = requires('better-sqlite3')

let db: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let ing: typeof import('../src/core/ingest')
let busMod: typeof import('../src/core/event-bus')
let drain: typeof import('../src/core/spool-drain')
let replay: typeof import('../src/core/spool-replay')
let recordState: typeof import('../src/core/recording-state')
let plan: typeof import('../src/core/export-plan')
if (sqlite.ok) {
  recordState = await import('../src/core/recording-state')
  plan = await import('../src/core/export-plan')
  db = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  ing = await import('../src/core/ingest')
  busMod = await import('../src/core/event-bus')
  drain = await import('../src/core/spool-drain')
  replay = await import('../src/core/spool-replay')
}

const ENG = 'eng-A'
const OP = 'op-A'
const id = { engagementId: ENG, operatorId: OP }
const other = { engagementId: 'eng-B', operatorId: 'op-B' }
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0)
const SEC = 1000

sqlite.describe('the spool drain counts each file once (review round 3)', () => {
  let dir = ''
  let spool = ''
  let keys = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR
  const bus = (): typeof import('../src/core/event-bus').eventBus => busMod.eventBus
  const at = (ms: number): void => { vi.setSystemTime(ms) }
  const marker = (subtype: 'recording_paused' | 'recording_resumed', ms: number): void => {
    events.insertEvent('system', { subtype, source: 'ui' }, { ...id, occurredAt: ms })
  }
  const pause = (ms: number): void => { at(ms); bus().pause('ui'); marker('recording_paused', ms) }
  const resume = (ms: number): void => { at(ms); bus().resume('ui'); marker('recording_resumed', ms) }
  const rows = (): Array<{ type: string; subtype: string; t: number; data: Record<string, unknown> }> =>
    (db.getDB().prepare(`SELECT agent_type, subtype, timestamp, data FROM events WHERE agent_type <> 'system' OR subtype = 'capture_gap'
      UNION ALL SELECT agent_type, subtype, timestamp, data FROM events_logged`).all() as Array<{ agent_type: string; subtype: string; timestamp: number; data: string }>)
      .map((r) => ({ type: r.agent_type, subtype: r.subtype, t: r.timestamp, data: JSON.parse(r.data) as Record<string, unknown> }))
  const commands = (): string[] => rows().filter((r) => r.type === 'shell').map((r) => `${r.subtype}:${String(r.data.command)}`)
  const gapRows = (): Array<{ t: number; data: Record<string, unknown> }> => rows().filter((r) => r.subtype === 'capture_gap' && r.type === 'system')
  const gaps = (): Array<Record<string, unknown>> => gapRows().map((r) => r.data)
  /** A producer's own record of a loss, replayed from the spool. */
  const producerGaps = (): Array<Record<string, unknown>> => rows().filter((r) => r.subtype === 'capture_gap' && r.type === 'scanner').map((r) => r.data)
  const put = (name: string, body: string | object, mtime?: number): string => {
    const f = path.join(spool, name)
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body))
    if (mtime !== undefined) fs.utimesSync(f, mtime / 1000, mtime / 1000)
    return f
  }
  const ls = (d: string): string[] => { try { return fs.readdirSync(d).sort() } catch { return [] } }
  const walk = (d: string): string[] => ls(d).flatMap((n) => fs.statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)).map((m) => `${n}/${m}`) : [n])
  const files = (): string[] => walk(spool).filter((n) => !n.endsWith('.why'))
  const forbidden = (n: number): object => ({ agent_type: 'system', data: { subtype: 'config_changed', n }, _identity: id })
  const shell = (subtype: string, command: string, extra: Record<string, unknown> = {}): object =>
    ({ agent_type: 'shell', data: { subtype, command, terminalId: `t-${command}`, pid: 1, ...extra }, _identity: id })
  /** Opens the project as main does: the database, then `system.session_start`. */
  const sessionStart = (): void => { events.insertEvent('system', { subtype: 'session_start' }, id) }
  const open = (start = true): void => {
    db.initDB(dir)
    db.bindDBEngagement(ENG)
    ing._resetIngest()
    if (start) sessionStart()
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-once-db-'))
    spool = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-once-spool-'))
    keys = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-once-keys-'))
    process.env.REDLOG_KEYS_DIR = keys
    open(false)
    ops.createOperator({ id: OP, name: 'P', token: ops.generateToken(), isPrimary: true })
    sessionStart()
  })
  afterEach(async () => {
    if (bus().paused) bus().resume('ui')
    vi.useRealTimers()
    // Windows cannot remove a directory that still holds an open database.
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    db.closeDB()
    for (const d of [dir, spool, keys]) {
      for (const f of walk(d)) { try { fs.chmodSync(path.join(d, f), 0o600) } catch { /* gone */ } }
      fs.rmSync(d, { recursive: true, force: true })
    }
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  // ── Item 1: counted once ────────────────────────────────────────────────

  sqlite.it('A: a file whose move keeps failing is counted by one row, across drains and a restart; the move is retried', () => {
    // A file where the quarantine directory should be: every move fails.
    fs.writeFileSync(path.join(spool, 'quarantine'), 'not a directory')
    put('0001.json', forbidden(1))
    for (let i = 0; i < 3; i++) {
      at(T0 + i * 31 * SEC)
      expect(drain.drainSpoolOnce(spool, id)!.outcomes['0001.json']).toBe('deferred')
    }
    db.closeDB()
    open()
    at(T0 + 120 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'kind-not-allowed', skipped_units: 1, files: ['0001.json'] })])
    expect(files()).toEqual(['0001.json', 'quarantine'])
    // The obstacle goes: the next drain moves it, and still counts nothing new.
    fs.rmSync(path.join(spool, 'quarantine'))
    at(T0 + 150 * SEC)
    expect(drain.drainSpoolOnce(spool, id)!.outcomes['0001.json']).toBe('quarantined')
    expect(files()).toEqual([`quarantine/${ENG}/kind-not-allowed--0001.json`])
    expect(gaps()).toHaveLength(1)
  })

  sqlite.it('A: a counted file is not offered to the pipeline again', () => {
    fs.writeFileSync(path.join(spool, 'quarantine'), 'not a directory')
    let tries = 0
    ing.configureIngest({ terminalLifecycle: { prepare: () => { tries++; throw new Error('pipeline down') }, recorded: () => undefined } })
    put('0001.json', shell('command_start', 'never-lands'))
    let t = T0
    for (let i = 0; i < 8; i++) { at(t); drain.drainSpoolOnce(spool, id); t += 31 * 60 * SEC }
    ing.configureIngest({ terminalLifecycle: null })
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'failed', files: ['0001.json'] })])
    // Five tries to fail, then counted; after that, no more writes are tried.
    expect(tries).toBe(5)
  })

  sqlite.it('one reason past FILES_PER_ROW names is split into parts, each naming its own files', () => {
    const n = drain.FILES_PER_ROW + 1
    for (let i = 0; i < n; i++) put(`${String(i).padStart(4, '0')}.json`, forbidden(i))
    drain.drainSpoolOnce(spool, id)
    const g = gaps()
    expect(g.map((r) => [r.reason, r.skipped_units, r.part, r.parts, (r.files as string[]).length]))
      .toEqual([['kind-not-allowed', drain.FILES_PER_ROW, 1, 2, drain.FILES_PER_ROW], ['kind-not-allowed', 1, 2, 2, 1]])
    expect(new Set([...(g[0].files as string[]), ...(g[1].files as string[])]).size).toBe(n)
  })

  // ── Item 2: one ledger per drain ────────────────────────────────────────

  sqlite.it('I: the quarantine bound holds for a drain made of many slices', () => {
    for (let n = 0; n < 6; n++) put(`${String(n).padStart(4, '0')}.json`, forbidden(n))
    const session = new drain.SpoolDrainSession(id)
    let after = ''
    for (;;) {
      const r = drain.drainSpoolOnce(spool, id, 2, after, { quarantineMaxFiles: 2 }, session)
      if (!r || r.last === null) break
      after = r.last
    }
    session.commit()
    expect(ls(path.join(spool, 'quarantine', ENG)).filter((n) => !n.endsWith('.why'))).toHaveLength(2)
    expect(gaps()).toEqual([expect.objectContaining({ skipped_units: 6, quarantined: 2, content_not_kept: 4 })])
  })

  sqlite.it('I: the quarantine bound holds for a drain of total Infinity, as main starts it', () => {
    for (let n = 0; n < 6; n++) put(`${String(n).padStart(4, '0')}.json`, forbidden(n))
    let session: InstanceType<typeof drain.SpoolDrainSession> | null = null
    replay.startSpoolDrain({
      drainOnce: (limit, after) => {
        if (after === '') session = new drain.SpoolDrainSession(id)
        return drain.drainSpoolOnce(spool, id, limit, after, { quarantineMaxFiles: 2 }, session ?? undefined)?.last ?? null
      },
      finish: () => { session?.commit(); session = null },
      total: 200, slice: 2, isCurrent: () => true,
      schedule: (next) => next(),
      repeat: () => undefined
    })
    expect(ls(path.join(spool, 'quarantine', ENG)).filter((n) => !n.endsWith('.why'))).toHaveLength(2)
    expect(gaps()).toEqual([expect.objectContaining({ skipped_units: 6, quarantined: 2 })])
  })

  sqlite.it('J: the legacy migration and the replay share the quarantine room', () => {
    put('old.json.bad', JSON.stringify({ agent_type: 'shell', data: {}, _identity: id }))
    put('0001.json', forbidden(1))
    drain.drainSpoolOnce(spool, id, Infinity, '', { quarantineMaxFiles: 1 })
    expect(ls(path.join(spool, 'quarantine', ENG)).filter((n) => !n.endsWith('.why'))).toHaveLength(1)
  })

  // ── Item 6: one row per reason, owners in its data ──────────────────────

  sqlite.it('E: one malformed row per drain, whoever the files belong to, with per-owner counts', () => {
    put('0001.json', '{', T0 - 3600e3)
    put('0002.json', { agent_type: 'shell', _identity: id }, T0 - 3600e3)
    drain.drainSpoolOnce(spool, id)
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'malformed', skipped_units: 2, by_owner: { this: 1, unknown: 1 } })])
  })

  // ── Item 7: a loss is placed only by a usable time ──────────────────────

  sqlite.it('F: a source time the row rule rejects does not place a loss', () => {
    at(T0 + 100 * SEC)
    put('0001.json', { agent_type: 'system', data: { subtype: 'config_changed', source_timestamp: 1_700_000_000 }, _identity: id })
    drain.drainSpoolOnce(spool, id)
    const [row] = gapRows()
    expect({ t: row.t, started: row.data.gap_started_at, ended: row.data.gap_ended_at, rejected: row.data._source_time_rejected })
      .toEqual({ t: T0 + 100 * SEC, started: T0 + 100 * SEC, ended: T0 + 100 * SEC, rejected: undefined })
  })

  // ── Item 5: another project's file stays ────────────────────────────────

  sqlite.it('G: another project\'s file that cannot be read stays where it is, uncounted, however long', () => {
    if (process.platform === 'win32') return // chmod 000 does not stop the owner reading on Windows
    const f = put('0001.json', { agent_type: 'shell', data: { subtype: 'command_start', command: 'B-evidence' }, _identity: other })
    fs.chmodSync(f, 0o000)
    let t = T0
    for (let i = 0; i < 8; i++) { at(t); drain.drainSpoolOnce(spool, id); t += 31 * 60 * SEC }
    expect(files()).toEqual(['0001.json'])
    expect(gaps()).toEqual([])
  })

  sqlite.it('G: a truncated file belongs to the project its text names', () => {
    const old = T0 - 3600e3
    put('0001.json', `{"agent_type":"shell","_identity":{"engagementId":"${other.engagementId}","operatorId":"op-B"},"data":{"comm`, old)
    put('0002.json', `{"agent_type":"shell","_identity":{"engagementId":"${ENG}","operatorId":"${OP}"},"data":{"comm`, old)
    drain.drainSpoolOnce(spool, id)
    expect(files()).toEqual(['0001.json', `quarantine/${ENG}/malformed--0002.json`])
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'malformed', skipped_units: 1, files: ['0002.json'] })])
    expect(gaps()[0].by_owner).toBeUndefined()
  })

  // ── Probe H: a pause between slices ─────────────────────────────────────

  sqlite.it('H: a pause between slices commits nothing — no row, no file dropped — until a drain after it', () => {
    pause(T0 + 10 * SEC)
    resume(T0 + 20 * SEC)
    at(T0 + 30 * SEC)
    put('0001.json', shell('command_start', 'in-pause', { source_timestamp: T0 + 15 * SEC }))
    put('0002.json', shell('command_start', 'after', { source_timestamp: T0 + 25 * SEC }))
    const session = new drain.SpoolDrainSession(id)
    drain.drainSpoolOnce(spool, id, 1, '', {}, session)
    pause(T0 + 31 * SEC)
    expect(drain.drainSpoolOnce(spool, id, 1, '0001.json', {}, session)).toBeNull()
    expect(session.commit()).toEqual({ '0001.json': 'deferred' })
    expect(gaps()).toEqual([])
    expect(files()).toEqual(['0001.json', '0002.json'])
    resume(T0 + 40 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'paused', skipped_units: 1, files: ['0001.json'] })])
    expect(commands()).toEqual(['command_start:after'])
    expect(files()).toEqual([])
  })

  // ── Item 3: command_end ─────────────────────────────────────────────────

  sqlite.it('B: output that started inside a recorded pause is refused, even with a missing or rejected source time', () => {
    pause(T0 + 10 * SEC)
    resume(T0 + 20 * SEC)
    at(T0 + 30 * SEC)
    put('0001.json', shell('command_end', 'future-end', { exit_code: 0, stdout: 'x', output_started_at: T0 + 12 * SEC, source_timestamp: T0 + 30 * SEC + 5 * 60 * SEC }))
    put('0002.json', shell('command_end', 'no-end', { exit_code: 0, stdout: 'x', output_started_at: T0 + 12 * SEC }))
    put('0003.json', shell('command_end', 'after', { exit_code: 0, stdout: 'x', output_started_at: T0 + 21 * SEC, source_timestamp: T0 + 25 * SEC }))
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['command_end:after'])
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'paused', skipped_units: 2 })])
  })

  sqlite.it('B: output that began before a recorded pause and ended after it is refused whole', () => {
    pause(T0 + 10 * SEC)
    resume(T0 + 20 * SEC)
    at(T0 + 30 * SEC)
    put('0001.json', shell('command_end', 'spans', { exit_code: 0, stdout: 'x', output_started_at: T0 + 5 * SEC, source_timestamp: T0 + 25 * SEC }))
    put('0002.json', shell('command_end', 'before', { exit_code: 0, stdout: 'x', output_started_at: T0 + 2 * SEC, source_timestamp: T0 + 8 * SEC }))
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['command_end:before'])
  })

  sqlite.it('C: without output_started_at, a start derived from the end less the duration inside a pause is refused', () => {
    pause(T0 + 10 * SEC)
    resume(T0 + 20 * SEC)
    at(T0 + 30 * SEC)
    put('0001.json', shell('command_start', 'typed-in-pause', { source_timestamp: T0 + 12 * SEC }))
    put('0002.json', shell('command_end', 'typed-in-pause', { exit_code: 0, duration_sec: 13, source_timestamp: T0 + 25 * SEC }))
    put('0003.json', shell('command_end', 'short', { exit_code: 0, duration_sec: 3, source_timestamp: T0 + 25 * SEC }))
    // Known limit: nothing places its start, so it is written.
    put('0004.json', shell('command_end', 'no-duration', { exit_code: 0, source_timestamp: T0 + 25 * SEC }))
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['command_end:short', 'command_end:no-duration'])
  })

  // ── Item 8: the boundary ────────────────────────────────────────────────

  sqlite.it('a pause is [pause, resume): the moment of the pause is paused, the moment of the resume is not', () => {
    pause(T0 + 10 * SEC)
    resume(T0 + 20 * SEC)
    at(T0 + 30 * SEC)
    put('0001.json', shell('command_start', 'at-pause', { source_timestamp: T0 + 10 * SEC }))
    put('0002.json', shell('command_start', 'at-resume', { source_timestamp: T0 + 20 * SEC }))
    put('0003.json', shell('command_start', 'just-before', { source_timestamp: T0 + 10 * SEC - 1 }))
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['command_start:at-resume', 'command_start:just-before'])
  })

  // ── Item 4: a pause with no resume row yet ──────────────────────────────

  sqlite.it('D: a resume whose marker is not written yet makes the drain wait, not drop; it drains once the marker lands', () => {
    pause(T0 + 10 * SEC)
    at(T0 + 20 * SEC)
    bus().resume('ui') // the marker write failed
    at(T0 + 30 * SEC)
    put('0001.json', shell('command_start', 'after-resume', { source_timestamp: T0 + 25 * SEC }))
    put('0002.json', shell('command_start', 'no-time'))
    put('0003.json', shell('command_start', 'before-pause', { source_timestamp: T0 + 5 * SEC }))
    put('0004.json', { agent_type: 'scanner', data: { subtype: 'capture_gap', reason: 'queue-full', skipped_units: 3, gap_started_at: T0 + 22 * SEC, gap_ended_at: T0 + 23 * SEC }, _identity: id })
    const first = drain.drainSpoolOnce(spool, id)!
    expect(first.outcomes).toEqual({ '0001.json': 'deferred', '0002.json': 'deferred', '0003.json': 'ingested', '0004.json': 'deferred' })
    expect(gaps()).toEqual([])
    // The retried marker lands at the toggle's own time.
    marker('recording_resumed', T0 + 20 * SEC)
    at(T0 + 40 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['command_start:before-pause', 'command_start:after-resume', 'command_start:no-time'])
    expect(gaps()).toEqual([])
    expect(producerGaps()).toEqual([expect.objectContaining({ reason: 'queue-full', skipped_units: 3 })])
    expect(files()).toEqual([])
  })

  sqlite.it('D: a queue gap and a spool file agree about when a recorded pause ends', () => {
    pause(T0 + 10 * SEC)
    resume(T0 + 20 * SEC)
    at(T0 + 30 * SEC)
    // Wholly inside the pause: not a loss. Reaching past its end: kept, and says so.
    put('0001.json', { agent_type: 'scanner', data: { subtype: 'capture_gap', reason: 'queue-full', skipped_units: 3, gap_started_at: T0 + 11 * SEC, gap_ended_at: T0 + 19 * SEC }, _identity: id })
    put('0002.json', { agent_type: 'scanner', data: { subtype: 'capture_gap', reason: 'queue-full', skipped_units: 4, gap_started_at: T0 + 15 * SEC, gap_ended_at: T0 + 25 * SEC }, _identity: id })
    drain.drainSpoolOnce(spool, id)
    expect(producerGaps()).toEqual([expect.objectContaining({ skipped_units: 4, overlaps_pause: true })])
  })

  // ── Review round 4 (72fff4d0) ───────────────────────────────────────────

  sqlite.it('R1: a lost resume between two pauses of this session makes the stretch unknown until the next resume; the late marker resolves it', () => {
    pause(T0 + 1 * SEC)
    at(T0 + 10 * SEC); bus().resume('ui') // the resume marker is not written
    pause(T0 + 30 * SEC)
    resume(T0 + 40 * SEC)
    at(T0 + 50 * SEC)
    put('0001.json', shell('command_start', 'recorded-between', { source_timestamp: T0 + 20 * SEC }))
    put('0002.json', shell('command_start', 'in-second-pause', { source_timestamp: T0 + 35 * SEC }))
    put('0003.json', shell('command_start', 'after', { source_timestamp: T0 + 45 * SEC }))
    expect(drain.drainSpoolOnce(spool, id)!.outcomes).toEqual({ '0001.json': 'deferred', '0002.json': 'deferred', '0003.json': 'ingested' })
    expect(gaps()).toEqual([])
    // The retried resume lands at its own time; the record reads P R P R.
    marker('recording_resumed', T0 + 10 * SEC)
    at(T0 + 60 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['command_start:after', 'command_start:recorded-between'])
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'paused', intentional: true, files: ['0002.json'] })])
  })

  sqlite.it('R2: while a pause marker is being retried, times from its toggle on wait; once it lands they are judged', () => {
    let fail = true
    const queue: Array<() => void> = []
    at(T0 + 1 * SEC)
    bus().pause('ui')
    writeMarkerWithRetry({
      at: T0 + 1 * SEC,
      write: (retry) => { if (fail) throw new Error('disk full'); marker('recording_paused', retry ? T0 + 1 * SEC : Date.now()) },
      onError: () => undefined,
      schedule: (retry) => { queue.push(retry) },
      isCurrent: () => true
    })
    resume(T0 + 10 * SEC)
    at(T0 + 20 * SEC)
    put('0001.json', shell('command_end', 'secret-in-pause', { source_timestamp: T0 + 5 * SEC, stdout: 'PAUSED' }))
    put('0002.json', shell('command_start', 'before', { source_timestamp: T0 + 500 }))
    expect(drain.drainSpoolOnce(spool, id)!.outcomes).toEqual({ '0001.json': 'deferred', '0002.json': 'ingested' })
    fail = false
    queue.shift()!()
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual(['command_start:before'])
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'paused', intentional: true, files: ['0001.json'] })])
  })

  sqlite.it('R3: a pause closed only by the reopen is refused as a loss whose pause end is unknown, and shows in Known Gaps', () => {
    pause(T0 + 1 * SEC)
    at(T0 + 10 * SEC); bus().resume('ui') // the resume marker never lands before the quit
    at(T0 + 20 * SEC)
    put('0001.json', shell('command_start', 'recorded-after-resume', { source_timestamp: T0 + 15 * SEC }))
    expect(drain.drainSpoolOnce(spool, id)!.outcomes).toEqual({ '0001.json': 'deferred' })
    db.closeDB()
    at(T0 + 3600 * SEC)
    open()
    marker('recording_resumed', T0 + 3600 * SEC + 5) // the reopen's marker
    at(T0 + 3601 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'pause-end-unknown', intentional: false, skipped_units: 1, quarantined: 1 })])
    // Not written to the record, but kept.
    expect(commands()).toEqual([])
    expect(files()).toEqual([`quarantine/${ENG}/pause-end-unknown--0001.json`])
    const all = gapRows().map((r) => ({ agentType: 'system', data: r.data })) as unknown as Parameters<typeof plan.countCaptureGaps>[0]
    expect(plan.countCaptureGaps(all)).toEqual([{ reason: 'pause-end-unknown', gaps: 1, skippedUnits: 1, unknownAmount: 0 }])
  })

  sqlite.it('R3: a pause carried across a reopen and resumed later: before the reopen is a loss, after it a pause', () => {
    pause(T0 + 1 * SEC)
    db.closeDB()
    at(T0 + 3600 * SEC)
    open() // still paused: the record already says so, no marker
    resume(T0 + 3700 * SEC)
    at(T0 + 3800 * SEC)
    put('0001.json', shell('command_start', 'before-reopen', { source_timestamp: T0 + 15 * SEC }))
    put('0002.json', shell('command_start', 'after-reopen', { source_timestamp: T0 + 3650 * SEC }))
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual([])
    expect(gaps().map((g) => [g.reason, g.intentional, g.files])).toEqual([
      ['pause-end-unknown', false, ['0001.json']],
      ['paused', true, ['0002.json']]
    ])
  })

  sqlite.it('R1: in an earlier session, a second pause with no resume between is a loss whose pause end is unknown', () => {
    pause(T0 + 1 * SEC)
    at(T0 + 10 * SEC); bus().resume('ui') // lost
    pause(T0 + 30 * SEC)
    resume(T0 + 40 * SEC)
    db.closeDB()
    at(T0 + 3600 * SEC)
    open()
    put('0001.json', shell('command_start', 'between', { source_timestamp: T0 + 20 * SEC }))
    put('0002.json', shell('command_start', 'second-pause', { source_timestamp: T0 + 35 * SEC }))
    drain.drainSpoolOnce(spool, id)
    expect(gaps().map((g) => [g.reason, g.intentional, g.files])).toEqual([
      ['pause-end-unknown', false, ['0001.json']],
      ['paused', true, ['0002.json']]
    ])
  })

  // ── Review round 5 (ed4498db) ───────────────────────────────────────────

  sqlite.it('F1: a pause left open by the previous open, no reopen marker, then a pause and resume in this open: this open\'s recording waits in this open', () => {
    pause(T0 + 1 * SEC)
    db.closeDB()
    bus().resume('ui') // the process restarts: not paused
    at(T0 + 3600 * SEC)
    open() // session_start; the reopen's resume marker was not written
    pause(T0 + 3700 * SEC)
    resume(T0 + 3710 * SEC)
    at(T0 + 3720 * SEC)
    put('0001.json', shell('command_start', 'before-the-reopen', { source_timestamp: T0 + 15 * SEC }))
    put('0002.json', shell('command_start', 'this-open-before-pause', { source_timestamp: T0 + 3650 * SEC }))
    const run = drain.drainSpoolOnce(spool, id)!
    expect(run.outcomes).toEqual({ '0001.json': 'quarantined', '0002.json': 'deferred' })
    expect(gaps().map((g) => [g.reason, g.files])).toEqual([['pause-end-unknown', ['0001.json']]])
  })

  sqlite.it('F6: a pause carried through an earlier open is split at that open\'s session_start', () => {
    pause(T0 + 1 * SEC)
    db.closeDB()
    at(T0 + 3600 * SEC)
    open() // still paused: no marker
    resume(T0 + 3700 * SEC)
    db.closeDB()
    at(T0 + 7200 * SEC)
    open()
    put('0001.json', shell('command_start', 'before-second-open', { source_timestamp: T0 + 15 * SEC }))
    put('0002.json', shell('command_start', 'paused-in-second-open', { source_timestamp: T0 + 3650 * SEC }))
    drain.drainSpoolOnce(spool, id)
    expect(gaps().map((g) => [g.reason, g.intentional, g.files])).toEqual([
      ['pause-end-unknown', false, ['0001.json']],
      ['paused', true, ['0002.json']]
    ])
  })

  sqlite.it('F6: a marker still pending for another project\'s database does not hold this one back', () => {
    at(T0 + 1 * SEC)
    writeMarkerWithRetry({ at: T0 + 1 * SEC, write: () => { throw new Error('disk full') }, onError: () => undefined, schedule: () => undefined, isCurrent: () => true })
    db.closeDB()
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-once-dbB-'))
    try {
      at(T0 + 10 * SEC)
      db.initDB(dirB); db.bindDBEngagement(other.engagementId); ing._resetIngest()
      ops.createOperator({ id: other.operatorId, name: 'B', token: ops.generateToken(), isPrimary: true })
      at(T0 + 20 * SEC)
      put('0001.json', { ...shell('command_start', 'in-b', { source_timestamp: T0 + 15 * SEC }), _identity: other })
      expect(drain.drainSpoolOnce(spool, other)!.outcomes).toEqual({ '0001.json': 'ingested' })
    } finally {
      try { db.closeDB() } catch { /* closed */ }
      open()
      fs.rmSync(dirB, { recursive: true, force: true })
    }
  })

  sqlite.it('F2: a pause marker that never landed before the quit is written at the next open, at its own time, and its stretch is judged', () => {
    at(T0 + 1 * SEC)
    bus().pause('ui')
    const record = { subtype: 'recording_paused' as const, at: T0 + 1 * SEC, data: { subtype: 'recording_paused', source: 'ui' } }
    writeMarkerWithRetry({ at: record.at, record, write: () => { throw new Error('disk full') }, onError: () => undefined, schedule: () => undefined, isCurrent: () => true })
    const kept = path.join(dir, 'recording-markers-pending.json')
    expect(fs.existsSync(kept)).toBe(true)
    resume(T0 + 10 * SEC)
    at(T0 + 20 * SEC)
    put('0001.json', shell('command_end', 'secret-in-pause', { source_timestamp: T0 + 5 * SEC, stdout: 'PAUSED' }))
    db.closeDB()
    at(T0 + 3600 * SEC)
    open()
    writePersistedMarkers({
      write: (m) => { events.insertEvent('system', m.data, { ...id, occurredAt: m.at }) },
      onError: () => undefined, schedule: () => undefined, isCurrent: () => true
    })
    expect(fs.existsSync(kept)).toBe(false)
    at(T0 + 3601 * SEC)
    drain.drainSpoolOnce(spool, id)
    expect(commands()).toEqual([])
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'paused', intentional: true, files: ['0001.json'] })])
  })

  sqlite.it('F2: a carried marker that fails again at the open stays on disk, and its stretch waits', () => {
    const record = { subtype: 'recording_paused' as const, at: T0 + 1 * SEC, data: { subtype: 'recording_paused', source: 'ui' } }
    fs.writeFileSync(path.join(dir, 'recording-markers-pending.json'), JSON.stringify([record]))
    resume(T0 + 10 * SEC)
    at(T0 + 20 * SEC)
    put('0001.json', shell('command_end', 'secret-in-pause', { source_timestamp: T0 + 5 * SEC, stdout: 'PAUSED' }))
    writePersistedMarkers({ write: () => { throw new Error('disk full') }, onError: () => undefined, schedule: () => undefined, isCurrent: () => true })
    expect(drain.drainSpoolOnce(spool, id)!.outcomes).toEqual({ '0001.json': 'deferred' })
    expect(fs.existsSync(path.join(dir, 'recording-markers-pending.json'))).toBe(true)
  })

  sqlite.it('F3: a file of unknown owner moved in a slice, then a pause before the commit, is put back and counted once later', () => {
    put('0001.json', '{"agent_type":"shell","data":{"comm', T0 - 3600e3)
    const session = new drain.SpoolDrainSession(id)
    drain.drainSpoolOnce(spool, id, 1, '', {}, session)
    pause(T0 + 10 * SEC)
    expect(session.commit()).toEqual({ '0001.json': 'deferred' })
    expect(files()).toEqual(['0001.json'])
    expect(gaps()).toEqual([])
    resume(T0 + 20 * SEC)
    drain.drainSpoolOnce(spool, id)
    drain.drainSpoolOnce(spool, id)
    expect(gaps()).toEqual([expect.objectContaining({ reason: 'malformed', files: ['0001.json'] })])
    expect(files()).toEqual(['quarantine/_unknown/malformed--0001.json'])
  })

  sqlite.it('F4: a queue gap with no start whose end falls in a stretch not known yet waits', () => {
    pause(T0 + 1 * SEC)
    at(T0 + 10 * SEC); bus().resume('ui') // resume marker not written
    at(T0 + 20 * SEC)
    put('0001.json', { agent_type: 'scanner', data: { subtype: 'capture_gap', reason: 'queue-full', gap_ended_at: T0 + 5 * SEC, skipped_units: 7 }, _identity: id })
    expect(drain.drainSpoolOnce(spool, id)!.outcomes).toEqual({ '0001.json': 'deferred' })
  })

  // ── Review round 6 (88e12692) ───────────────────────────────────────────

  const pendingPath = (): string => path.join(dir, 'recording-markers-pending.json')
  /** Main's open, after the database: session_start, carried markers, the
   *  open's own marker. `fail` decides which marker writes throw. */
  const recordOpen = (log: string[] = [], fail: (data: Record<string, unknown>) => boolean = () => false): string[] => {
    recordProjectOpen({
      sessionStart: () => { log.push('session_start'); sessionStart() },
      write: (data, occurredAt) => {
        if (fail(data)) throw new Error('disk full')
        log.push(`${String(data.subtype)}@${occurredAt ?? 'now'}`)
        events.insertEvent('system', data, occurredAt === undefined ? id : { ...id, occurredAt })
      },
      paused: bus().paused, onError: () => undefined, schedule: () => undefined, isCurrent: () => true
    })
    return log
  }

  sqlite.it('G1: a pending-marker file that cannot be parsed is kept aside, reported, and leaves this open unknown', () => {
    resume(T0 + 1 * SEC)
    db.closeDB()
    const broken = '[{"subtype":"recording_paused","at":' + String(T0 + 5 * SEC)
    fs.writeFileSync(pendingPath(), broken)
    at(T0 + 3600 * SEC)
    open(false)
    dbErrors.length = 0
    recordOpen()
    put('0001.json', shell('command_start', 'some-time', { source_timestamp: T0 + 20 * SEC }))
    put('0002.json', shell('command_start', 'no-time'))
    at(T0 + 3601 * SEC)
    expect(drain.drainSpoolOnce(spool, id)!.outcomes).toEqual({ '0001.json': 'deferred', '0002.json': 'deferred' })
    expect(dbErrors).toContain('recording-marker')
    expect(fs.readFileSync(`${pendingPath()}.unreadable`, 'utf8')).toBe(broken)
    // A later marker that fails is kept under the normal name; the set-aside bytes stay.
    const record = { subtype: 'recording_paused' as const, at: T0 + 3700 * SEC, data: { subtype: 'recording_paused', source: 'ui' } }
    writeMarkerWithRetry({ at: record.at, record, write: () => { throw new Error('disk full') }, onError: () => undefined, schedule: () => undefined, isCurrent: () => true })
    expect(fs.readFileSync(`${pendingPath()}.unreadable`, 'utf8')).toBe(broken)
    expect(JSON.parse(fs.readFileSync(pendingPath(), 'utf8'))).toEqual([expect.objectContaining({ at: T0 + 3700 * SEC })])
  })

  sqlite.it('G1: an entry that does not check is not dropped silently', () => {
    db.closeDB()
    fs.writeFileSync(pendingPath(), JSON.stringify([{ subtype: 'recording_paused', at: 1_700_000, data: {} }]))
    at(T0 + 3600 * SEC)
    open(false)
    dbErrors.length = 0
    recordOpen()
    put('0001.json', shell('command_start', 'x', { source_timestamp: T0 + 20 * SEC }))
    expect(drain.drainSpoolOnce(spool, id)!.outcomes).toEqual({ '0001.json': 'deferred' })
    expect(dbErrors).toContain('recording-marker')
    expect(fs.existsSync(`${pendingPath()}.unreadable`)).toBe(true)
  })

  sqlite.it('G2: a carried marker writes only its checked fields, whatever else the file says', () => {
    db.closeDB()
    fs.writeFileSync(pendingPath(), JSON.stringify([{ subtype: 'recording_paused', at: T0 + 5 * SEC, data: { subtype: 'config_changed', source: 'ui', extra: 'x' } }]))
    at(T0 + 3600 * SEC)
    open(false)
    recordOpen()
    const written = (db.getDB().prepare(`SELECT subtype, timestamp, data FROM events WHERE agent_type = 'system' AND subtype IN ('recording_paused', 'config_changed')`).all() as Array<{ subtype: string; timestamp: number; data: string }>)
      .map((r) => ({ subtype: r.subtype, t: r.timestamp, extra: (JSON.parse(r.data) as Record<string, unknown>).extra }))
    expect(written).toEqual([{ subtype: 'recording_paused', t: T0 + 5 * SEC, extra: undefined }])
  })

  sqlite.it('G3: the open decides its marker from a carried marker still waiting, not only from the chain', () => {
    resume(T0 + 1 * SEC)
    db.closeDB()
    fs.writeFileSync(pendingPath(), JSON.stringify([{ subtype: 'recording_paused', at: T0 + 100 * SEC, data: { subtype: 'recording_paused', source: 'ui' } }]))
    at(T0 + 3600 * SEC)
    open(false)
    expect(recordState.lastRecordingMarker()).toBe('recording_paused')
    const log = recordOpen([], (data) => data.subtype === 'recording_paused')
    expect(log).toEqual(['session_start', 'recording_resumed@now'])
  })

  sqlite.it('G5: the open writes session_start, then carried markers at their own time, then its own marker', () => {
    db.closeDB()
    fs.writeFileSync(pendingPath(), JSON.stringify([{ subtype: 'recording_paused', at: T0 + 5 * SEC, data: { subtype: 'recording_paused', source: 'ui' } }]))
    at(T0 + 3600 * SEC)
    open(false)
    expect(recordOpen()).toEqual(['session_start', `recording_paused@${T0 + 5 * SEC}`, 'recording_resumed@now'])
    expect(fs.existsSync(pendingPath())).toBe(false)
  })

  sqlite.it('G4: a drain whose project closes puts back the files of unknown owner it moved', () => {
    put('0001.json', '{"agent_type":"shell","data":{"comm', T0 - 3600e3)
    const session = new drain.SpoolDrainSession(id)
    drain.drainSpoolOnce(spool, id, 1, '', {}, session)
    expect(files()).toEqual(['quarantine/_unknown/malformed--0001.json'])
    expect(session.abandon()).toEqual({ '0001.json': 'deferred' })
    expect(files()).toEqual(['0001.json'])
    expect(gaps()).toEqual([])
  })

  sqlite.it('R6: a pause record that cannot be read leaves everything unknown, and says so', () => {
    const reported: string[] = []
    const pauses = recordState.recordedPauses(() => { throw new Error('database is locked') }, (source) => { reported.push(source) })
    expect([recordState.stateAt(pauses, 0), recordState.stateAt(pauses, T0)]).toEqual(['unknown', 'unknown'])
    expect(reported).toEqual(['recording-state'])
  })

  sqlite.it('R7: a file whose owner cannot be read and cannot be moved is counted by no project; once moved, by one', () => {
    fs.writeFileSync(path.join(spool, 'quarantine'), 'not a directory')
    put('0001.json', '{"agent_type":"shell","data":{"comm', T0 - 3600e3)
    drain.drainSpoolOnce(spool, id)
    expect(gaps()).toEqual([])
    db.closeDB()
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-once-dbB-'))
    try {
      db.initDB(dirB); db.bindDBEngagement(other.engagementId); ing._resetIngest()
      ops.createOperator({ id: other.operatorId, name: 'B', token: ops.generateToken(), isPrimary: true })
      drain.drainSpoolOnce(spool, other)
      expect(gaps()).toEqual([])
      fs.rmSync(path.join(spool, 'quarantine'))
      drain.drainSpoolOnce(spool, other)
      expect(gaps()).toEqual([expect.objectContaining({ reason: 'malformed', by_owner: { this: 0, unknown: 1 }, files: ['0001.json'] })])
      expect(files()).toEqual(['quarantine/_unknown/malformed--0001.json'])
      db.closeDB()
      open()
      drain.drainSpoolOnce(spool, id)
      expect(gaps()).toEqual([])
    } finally {
      try { db.closeDB() } catch { /* closed */ }
      open()
      fs.rmSync(dirB, { recursive: true, force: true })
    }
  })
})

describe('a pause or resume marker that fails to write', () => {
  it('is reported and retried at the toggle\'s own time until it lands', () => {
    const scheduled: number[] = []
    const queue: Array<() => void> = []
    const errors: unknown[] = []
    const tries: boolean[] = []
    writeMarkerWithRetry({
      at: T0,
      write: (retry) => { tries.push(retry); if (tries.length < 3) throw new Error('disk full') },
      onError: (e) => errors.push(e),
      schedule: (retry, ms) => { scheduled.push(ms); queue.push(retry) },
      isCurrent: () => true
    })
    while (queue.length) queue.shift()!()
    expect(tries).toEqual([false, true, true])
    expect(errors).toHaveLength(2)
    expect(scheduled).toEqual(MARKER_RETRY_DELAYS_MS.slice(0, 2))
  })

  it('stops once the project is closed', () => {
    const queue: Array<() => void> = []
    let current = true
    let tries = 0
    writeMarkerWithRetry({
      at: T0,
      write: () => { tries++; throw new Error('disk full') },
      onError: () => undefined,
      schedule: (retry) => { queue.push(retry) },
      isCurrent: () => current
    })
    current = false
    while (queue.length) queue.shift()!()
    expect(tries).toBe(1)
  })
})

describe('the no-project copy', () => {
  it('names the directory the files are in', () => {
    for (const lang of ['en', 'zh-TW']) {
      const strings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', `${lang}.json`), 'utf8')) as Record<string, string>
      expect(strings['capture.unattributedSpoolWhere']).toContain('~/.redlog/pending/quarantine/_no-project')
    }
  })
})
