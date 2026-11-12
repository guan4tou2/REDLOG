// Spec 071 T008 (RED, US2): the spool decides "was this recorded during a
// pause?" with a different rule from everything else, and gets it wrong both
// ways (docs/records/2026-11-12/root-cause/01-capture-integrity.md F4).
//
// The rules involved:
//   - Pause is a flag in memory (eventBus). It does not survive a restart; the
//     project's record of it is the `system.recording_paused` /
//     `recording_resumed` rows.
//   - main's drain (src/main/index.ts drainSpool) declines to run while the
//     flag is set, and otherwise hands each file to ingest().
//   - ingest() (src/core/ingest.ts, "An asynchronous sender can arrive after
//     the operator resumed") refuses delayed output — command_output,
//     session_output, command_end — whose source time is at or before the
//     LATEST resume: `outputAt <= max(eventBus.resumedAt,
//     lastRecordingResumeTime())`. Before the latest resume is not the same
//     as inside a pause. command_start is not delayed output and is not judged.
//
// (a) Crash while paused. On reopen the flag is clear, the last state row says
//     "paused", and the drain runs before the project-open marker that would
//     write `recording_resumed` (startProjectServices runs inside
//     configApplier.apply, src/main/index.ts ~line 987; the marker is written at
//     ~line 1049, both synchronously in that order). What the hook spooled
//     while the app was down mid-pause is replayed into the chain.
// (b) Before the pause, stuck forever. A command_end the hook spooled while
//     recording, then a pause and a resume: its output_started_at is before
//     the latest resume, so ingest answers `paused`, the drain keeps the file
//     (returns false) and retries it every 30 s, and the command_start already
//     in the record never gets its end.
//
// Phase 2 (T015, as revised 2026-11-13) judges a spool file, after the pause,
// by its usable source time against the RECORDED pause intervals
// (src/core/recording-state.ts, src/core/spool-drain.ts); both tests below were
// `it.fails` until then. The rule itself is property-tested in
// test/pause-interval-property.test.ts, the review's probes in
// test/pause-spool-review.test.ts.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { requires } from './helpers/requires'

const sqlite = requires('better-sqlite3')

let db: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ops: typeof import('../src/core/db/operators')
let ingest: typeof import('../src/core/ingest')
let drain: typeof import('./helpers/spool-drain-as-main')
if (sqlite.ok) {
  db = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ops = await import('../src/core/db/operators')
  ingest = await import('../src/core/ingest')
  drain = await import('./helpers/spool-drain-as-main')
}

const ENG = 'eng-pause'
const OP = 'op-pause'
const T0 = Date.UTC(2026, 10, 12, 9, 0, 0)
const SEC = 1000

sqlite.describe('the pause boundary on spool replay', () => {
  let dir = ''
  let spool = ''
  let keys = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR
  const opening = { engagementId: ENG, operatorId: OP }

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pausespool-'))
    spool = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pausespool-q-'))
    keys = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-pausespool-keys-'))
    process.env.REDLOG_KEYS_DIR = keys
    db.initDB(dir)
    db.bindDBEngagement(ENG)
    ingest._resetIngest()
    ops.createOperator({ id: OP, name: 'Pause', token: ops.generateToken(), isPrimary: true })
    events.insertEvent('system', { subtype: 'session_start' }, opening)
  })
  afterEach(() => {
    vi.useRealTimers()
    db.closeDB()
    for (const d of [dir, spool, keys]) fs.rmSync(d, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  const at = (ms: number): void => { vi.setSystemTime(ms) }
  const stateRow = (subtype: 'recording_paused' | 'recording_resumed', ms: number): void => {
    at(ms)
    events.insertEvent('system', { subtype, source: 'operator' }, opening)
  }
  let seq = 0
  const spoolFile = (data: Record<string, unknown>): string => {
    const file = path.join(spool, `${String(++seq).padStart(4, '0')}.json`)
    fs.writeFileSync(file, JSON.stringify({ agent_type: 'shell', data, _identity: { engagementId: ENG, operatorId: OP } }))
    return file
  }
  const shellRows = (): Array<{ subtype: string; timestamp: number }> =>
    db.getDB().prepare(`SELECT subtype, timestamp FROM events WHERE agent_type = 'shell' ORDER BY rowid`).all() as Array<{ subtype: string; timestamp: number }>

  sqlite.it('the copy of main\'s drain still matches src/main/index.ts', () => {
    expect(drain.mainDrainDrift()).toEqual([])
  })

  // (a)
  sqlite.it('a crash during a pause: nothing the hook spooled inside the pause is replayed', () => {
    const pausedAt = T0 + 10 * SEC
    stateRow('recording_paused', pausedAt)
    // Typed while paused, with RedLog down: the hook could not POST, so it
    // spooled both, stamped with when they happened.
    const typedAt = pausedAt + 20 * SEC
    spoolFile({ subtype: 'command_start', command: 'cat /etc/shadow', terminalId: 'tA', pid: 4242, command_id: 'cA', source_timestamp: typedAt })
    spoolFile({ subtype: 'command_end', command: 'cat /etc/shadow', terminalId: 'tA', pid: 4242, command_id: 'cA', exit_code: 0,
      stdout: 'root:*:...\n', output_started_at: typedAt + 100, source_timestamp: typedAt + 2 * SEC })
    // The app was killed while paused and is reopened: the flag is clear.
    db.closeDB()
    at(pausedAt + 60 * SEC)
    db.initDB(dir)
    db.bindDBEngagement(ENG)
    ingest._resetIngest()
    const run = drain.drainSpoolAsMain(spool, opening)
    expect(run).not.toBeNull()
    const insidePause = shellRows().filter((r) => r.timestamp >= pausedAt)
    expect(insidePause, 'shell rows timestamped inside the pause reached the chain').toEqual([])
    // Refused for good, not left to be retried; counted in a chained gap row at
    // the time they were observed (Spec 071 T011/T015). The record shows the
    // pause beginning but not ending — the reopen closed it — so the operator
    // may have resumed: a loss, not an intentional pause, and the content is
    // kept in quarantine (FR-082, review rounds 4–5).
    expect(fs.readdirSync(spool)).toEqual(['quarantine'])
    expect(fs.readdirSync(path.join(spool, 'quarantine', ENG)).filter((n) => !n.endsWith('.why'))).toHaveLength(2)
    const gaps = (db.getDB().prepare(`SELECT timestamp, data, hash FROM events WHERE subtype = 'capture_gap'`).all() as Array<{ timestamp: number; data: string; hash: string | null }>)
    expect(gaps.map((g) => ({ ...JSON.parse(g.data) as Record<string, unknown>, at: g.timestamp, chained: g.hash !== null })))
      .toEqual([expect.objectContaining({ reason: 'pause-end-unknown', intentional: false, skipped_units: 2, quarantined: 2, at: typedAt, chained: true })])
    // And a later drain, after the reopen marker, does not change its mind.
    at(pausedAt + 61 * SEC)
    events.insertEvent('system', { subtype: 'recording_resumed', source: 'project-open' }, opening)
    spoolFile({ subtype: 'command_start', command: 'id', terminalId: 'tA', pid: 4242, command_id: 'cA2', source_timestamp: typedAt + 5 * SEC })
    drain.drainSpoolAsMain(spool, opening)
    expect(shellRows().filter((r) => r.timestamp >= pausedAt)).toEqual([])
  })

  // (b)
  sqlite.it('a command_end observed before a pause is written once recording has resumed', () => {
    // Recorded live: the command starts at T0+1s.
    at(T0 + SEC)
    const start = ingest.ingest({ agentType: 'shell', engagementId: ENG, operatorId: OP,
      data: { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', terminalId: 'tB', pid: 4343, command_id: 'cB', source_timestamp: T0 + SEC } })
    expect(start.event).not.toBeNull()
    // It ends at T0+5s while still recording, but the POST times out and the
    // hook spools the end.
    spoolFile({ subtype: 'command_end', command: 'nmap -sV 10.0.0.5', terminalId: 'tB', pid: 4343, command_id: 'cB', exit_code: 0,
      stdout: '22/tcp open ssh\n', output_started_at: T0 + 1500, source_timestamp: T0 + 5 * SEC })
    // Then a pause and a resume. The drain does not run while paused.
    stateRow('recording_paused', T0 + 10 * SEC)
    stateRow('recording_resumed', T0 + 20 * SEC)
    // Three drain ticks after the resume.
    for (let tick = 1; tick <= 3; tick++) {
      at(T0 + 20 * SEC + tick * 30 * SEC)
      drain.drainSpoolAsMain(spool, opening)
    }
    expect(shellRows().map((r) => r.subtype), 'the command never gets its end').toEqual(['command_start', 'command_end'])
  })
})
