// Spec 071 T032 (US1, SC-003): restart equivalence.
//
// The same items, delivered three ways, give the same rows:
//   live      every item posted to /api/events while the app runs;
//   restart   the same, with the app restarted part-way (a fresh module graph
//             and the database reopened from disk: helpers/ingest-delivery.ts);
//   handoff   every item spooled while the app was down, then drained.
//
// SC-003 names what must be identical: `target_id`, `_causes`, `engagement_id`,
// `operator_id` and `_ingest.target_via`. `target_via` does not exist yet
// (T023/T024, FR-010); the other four are compared for every row, primary and derived,
// `_causes` by the position of the row each id names (ids are minted per row).
// Live against restart — the same door — is compared on the whole row except
// what a row's identity, its place in the chain and its receipt make
// different: id, hash, prev_hash, signature, monotonic_ns, created_at, the
// session the process opened, and the receiver's per-row `_ingest.event_id`.
// Live against handoff is the door comparison, T036's.
//
// Every item carries `source_timestamp`, as the hooks send it, so `timestamp`
// is the observation's in all three and is compared too.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import { causesByPosition, interceptHttp, openRuntime, storedRows, type Item, type StoredRow } from './helpers/ingest-delivery'

const sqlite = requires('better-sqlite3')
// Each delivery loads a fresh module graph (helpers/ingest-delivery.ts); a cold
// one takes seconds on a slow runner.
const SLOW = 60_000

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-restart-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
afterAll(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0)
const at = (i: number): number => T0 + i * 1000

/** An engagement's worth of capture: commands with targets and without, an
 *  HTTP flow, and a pivot whose start and end each derive a companion. */
const ITEMS: Item[] = [
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', terminalId: 't1', pid: 11, command_id: 'c1' } },
  { agent_type: 'shell', data: { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', terminalId: 't1', pid: 11, command_id: 'c1', exit_code: 0, stdout: '22/tcp open\n' } },
  { agent_type: 'scanner', data: { subtype: 'http_request_start', flow_id: 'f1', method: 'GET', url: 'http://10.0.0.5/', host: '10.0.0.5' } },
  { agent_type: 'scanner', data: { subtype: 'http_response', flow_id: 'f1', status_code: 200, url: 'http://10.0.0.5/', host: '10.0.0.5' } },
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'sshuttle -r user@10.0.0.6 10.10.0.0/16', terminalId: 't1', pid: 12, command_id: 'c2' } },
  { agent_type: 'shell', data: { subtype: 'command_end', command: 'sshuttle -r user@10.0.0.6 10.10.0.0/16', terminalId: 't1', pid: 12, command_id: 'c2', exit_code: 0, duration_sec: 5 } },
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'whoami', terminalId: 't2', pid: 13, command_id: 'c3' } },
  { agent_type: 'shell', data: { subtype: 'command_end', command: 'whoami', terminalId: 't2', pid: 13, command_id: 'c3', exit_code: 0, stdout: 'kali\n' } }
].map((item, i) => ({ ...item, data: { ...item.data, source_timestamp: at(i) } }))

/** What SC-003 holds equal, per row — and, to say which row it is, its kind,
 *  its command, and a chunk's command id, number and label. */
const sc003 = (rows: StoredRow[]) => {
  const causes = causesByPosition(rows)
  return rows.map((r) => ({
    kind: `${r.table}:${String(r.row.agent_type)}.${String(r.data.subtype)}`, command: r.data.command,
    ...(r.data.subtype === 'command_output' ? { chunk: `${String(r.data.command_id)}#${String(r.data.seq)}`, unattributed: r.data.unattributed } : {}),
    target_id: r.row.target_id, engagement_id: r.row.engagement_id, operator_id: r.row.operator_id, _causes: causes(r)
  }))
}

/** Background jobs: two commands whose end says a job keeps printing (one
 *  filed under the engagement's current target, one under the target its own
 *  text names), one whose end does not, then their late chunks — a resend and
 *  one after the final row among them. The current target changes from A to B
 *  before the first chunk, so a chunk filed by the global target instead of its
 *  command's shows. */
const bg = (command_id: string, seq: number, stdout: string, extra: Record<string, unknown> = {}): Item =>
  ({ agent_type: 'shell', data: { subtype: 'command_output', command_id, late: true, seq, stdout, final: false, captured_by: 'redlog-relay', ...extra } })
const LATE_RAW: Item[] = [
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'sleep 30 &', terminalId: 't1', pid: 21, command_id: 'L1' } },
  { agent_type: 'shell', data: { subtype: 'command_end', command: 'sleep 30 &', terminalId: 't1', pid: 21, command_id: 'L1', exit_code: 0, late_output: true } },
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'nmap -sV 10.0.0.9', terminalId: 't1', pid: 22, command_id: 'L2' } },
  { agent_type: 'shell', data: { subtype: 'command_end', command: 'nmap -sV 10.0.0.9', terminalId: 't1', pid: 22, command_id: 'L2', exit_code: 0, late_output: true } },
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 't1', pid: 23, command_id: 'N1' } },
  { agent_type: 'shell', data: { subtype: 'command_end', command: 'id', terminalId: 't1', pid: 23, command_id: 'N1', exit_code: 0, stdout: 'uid=0\n' } },
  bg('L1', 0, 'bg one\n'), // 6: the first chunk; the target is B from here
  bg('L2', 0, 'bg nmap\n'),
  bg('N1', 0, 'stray\n'), // its command did not say a job would keep printing
  bg('L1', 1, 'bg two\n'),
  bg('L1', 2, 'bg three\n', { final: true }),
  bg('L1', 3, 'after final\n')
]
const LATE: Item[] = LATE_RAW.map((item, i) => ({ ...item, data: { ...item.data, source_timestamp: at(i) } }))
/** The same chunk sent again, as a relay does when our answer was late. */
const RESEND = 10
LATE.splice(RESEND, 0, LATE[9])
const LATE_TARGETS = { 0: 'A', 6: 'B' }

const ROW_IDENTITY = ['id', 'hash', 'prev_hash', 'signature', 'monotonic_ns', 'created_at', 'session_id']
/** The whole row, less what identity, chain position and receipt make different. */
const whole = (rows: StoredRow[]) => {
  const causes = causesByPosition(rows)
  return rows.map((r) => {
    const row = Object.fromEntries(Object.entries(r.row).filter(([k]) => !ROW_IDENTITY.includes(k) && k !== 'data'))
    const { event_id: _id, ...stamp } = r.data._ingest as Record<string, unknown>
    const derived = stamp.producer === 'derived'
    // A derived row has no source time: its `timestamp` is its receipt.
    if (derived) delete row.timestamp
    return { ...row, data: { ...r.data, _causes: causes(r), _ingest: stamp } }
  })
}

sqlite.describe('restart equivalence (SC-003)', () => {
  const dirs: string[] = []
  const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-restart-${label}-`)); dirs.push(d); return d }
  beforeEach(() => {
    interceptHttp()
    vi.useFakeTimers({ toFake: ['Date'], now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  interface Delivery {
    /** Restart the app before each of these indexes. */
    restartsBefore?: number[]
    /** The engagement's current target, set before the item at each index (and
     *  again on every restart, as main does when a project opens). */
    targets?: Record<number, string>
    /** From this index on, the items wait in the handoff spool and are drained
     *  after one more restart. */
    spoolFrom?: number
    /** The status the API answers an item with, where it is not 201. */
    status?: Record<number, number>
    /** An existing project: post these first, restart, then deliver. */
    dir?: string
  }

  /** Post `items` live, each a little after it was observed, restarting the app
   *  where asked. Every item's receipt time follows its position, so a resend
   *  carries its original's observation time but arrives later. */
  async function live(items: Item[], opts: Delivery = {}): Promise<StoredRow[]> {
    const dir = opts.dir ?? tmp('live')
    let rt = await openRuntime(dir)
    let target: string | null = null
    const spoolFrom = opts.spoolFrom ?? items.length
    for (const [i, item] of items.slice(0, spoolFrom).entries()) {
      if (opts.restartsBefore?.includes(i)) { await rt.close(); rt = await openRuntime(dir); rt.activeTarget(target) }
      if (opts.targets?.[i] !== undefined) { target = opts.targets[i]; rt.activeTarget(target) }
      vi.setSystemTime(at(i) + 50)
      await rt.api(item, opts.status?.[i])
    }
    if (spoolFrom < items.length) {
      // The target the operator set while those items waited.
      for (const [i, t] of Object.entries(opts.targets ?? {})) if (Number(i) >= spoolFrom) target = t
      await rt.close(); rt = await openRuntime(dir); rt.activeTarget(target)
      vi.setSystemTime(at(items.length) + 60_000)
      rt.spool(items.slice(spoolFrom), tmp('spool'))
    }
    await rt.close()
    return storedRows(dir)
  }
  async function handoff(items: Item[]): Promise<StoredRow[]> {
    const dir = tmp('handoff')
    const rt = await openRuntime(dir)
    vi.setSystemTime(at(items.length) + 60_000)
    rt.spool(items, tmp('spool'))
    await rt.close()
    return storedRows(dir)
  }

  it('live and entirely through the handoff spool: the same rows, by SC-003\'s fields', async () => {
    const a = await live(ITEMS)
    const c = await handoff(ITEMS)
    // The fixture does what it says: targets, links and companions are there to compare.
    expect(sc003(a).filter((r) => r.target_id === '10.0.0.5')).not.toHaveLength(0)
    expect(sc003(a).filter((r) => r._causes)).not.toHaveLength(0)
    expect(sc003(a).map((r) => r.kind)).toContain('events:pivot.closed')
    expect(sc003(c)).toEqual(sc003(a))
  }, SLOW)

  it('live, restarted between two commands: the same rows, whole', async () => {
    const a = await live(ITEMS)
    const b = await live(ITEMS, { restartsBefore: [4] })
    expect(whole(b)).toEqual(whole(a))
    expect(new Set(b.map((r) => r.row.session_id)).size, 'the restart opened a second session').toBe(2)
  }, SLOW)

  // The links between a command's rows are kept in memory as the fast path;
  // a restart finds the start in the database instead, by the same identity.
  it('live, restarted inside a command: its end still cites its start, and the rows are the same, whole', async () => {
    const a = await live(ITEMS)
    const b = await live(ITEMS, { restartsBefore: [5] }) // between sshuttle's start and end
    const end = (r: ReturnType<typeof sc003>[number]): boolean => r.kind === 'events:shell.command_end' && r.command === ITEMS[5].data.command
    expect(sc003(a).filter(end).map((r) => r._causes), 'live, the end cites its start').toEqual([['#2']])
    expect(sc003(b)).toEqual(sc003(a))
    expect(whole(b)).toEqual(whole(a))
  }, SLOW)

  it('live, restarted inside an HTTP flow: the response cites its request, as live', async () => {
    const a = await live(ITEMS)
    const b = await live(ITEMS, { restartsBefore: [3] }) // between the request and its response
    const response = sc003(a).find((r) => r.kind === 'events_logged:scanner.http_response')
    expect(response?._causes, 'live, the response cites its request').toEqual([`#${sc003(a).findIndex((r) => r.kind === 'events_logged:scanner.http_request_start')}`])
    expect(sc003(b)).toEqual(sc003(a))
  }, SLOW)

  it('an http_response sent again after a restart does not cite the request a second time', async () => {
    const items = [...ITEMS, { ...ITEMS[3], data: { ...ITEMS[3].data } }]
    const a = await live(items)
    const b = await live(items, { restartsBefore: [3, items.length - 1] })
    const responses = (rows: StoredRow[]) => sc003(rows).filter((r) => r.kind === 'events_logged:scanner.http_response').map((r) => r._causes)
    expect(responses(a), 'live: the first response cites the request, the second nothing').toEqual([[expect.any(String)], undefined])
    expect(sc003(b)).toEqual(sc003(a))
  }, SLOW)

  it('a command_end sent again after a restart does not cite the start a second time', async () => {
    const again = { ...ITEMS[5], data: { ...ITEMS[5].data } }
    const items = [...ITEMS, again]
    const a = await live(items)
    // Restarted inside the command, and again before the resend.
    const b = await live(items, { restartsBefore: [5, items.length - 1] })
    const ends = (rows: StoredRow[]) => sc003(rows).filter((r) => r.kind === 'events:shell.command_end' && r.command === again.data.command).map((r) => r._causes)
    expect(ends(a), 'live: the first end cites the start, the second nothing').toEqual([['#2'], undefined])
    expect(sc003(b)).toEqual(sc003(a))
  }, SLOW)

  describe('background output (late chunks)', () => {
    const status = { [RESEND]: 409 }
    const chunks = (rows: StoredRow[]) => sc003(rows).filter((r) => r.kind === 'events:shell.command_output')

    it('live: each chunk is filed with its command and under its command\'s target; a resend is kept once', async () => {
      const a = chunks(await live(LATE, { targets: LATE_TARGETS, status }))
      expect(a.map((r) => [r.chunk, r.target_id, r.unattributed, r._causes])).toEqual([
        ['L1#0', 'A', undefined, ['#0']],
        ['L2#0', '10.0.0.9', undefined, ['#2']],
        // Not a command that said a job would keep printing: attributed to no
        // command, yet filed under the target that command had, which is what
        // live does (ingest.ts keeps a command's target from its start).
        ['N1#0', 'A', true, undefined],
        ['L1#1', 'A', undefined, ['#0']],
        ['L1#2', 'A', undefined, ['#0']],
        ['L1#3', 'B', true, undefined]
      ])
    }, SLOW)

    it.each([
      ['between the ends and the first chunk', [6]],
      ['between two chunks of one command', [9]],
      ['before the resend', [RESEND]],
      ['between the final chunk and the one after it', [RESEND + 2]],
      ['after every row', [6, 7, 8, 9, RESEND, RESEND + 1, RESEND + 2]]
    ])('restarted %s: the same rows as live', async (_label, restartsBefore) => {
      const a = await live(LATE, { targets: LATE_TARGETS, status })
      const b = await live(LATE, { targets: LATE_TARGETS, status, restartsBefore })
      expect(sc003(b)).toEqual(sc003(a))
    }, SLOW)

    it('the chunks waited in the handoff spool across a restart: the same rows as live', async () => {
      const a = await live(LATE, { targets: LATE_TARGETS, status })
      const b = await live(LATE.filter((_, i) => i !== RESEND), { targets: LATE_TARGETS, spoolFrom: 6 })
      expect(sc003(b)).toEqual(sc003(a))
    }, SLOW)
  })

  it('a command id is the open project\'s: the same id in another project cites nothing there', async () => {
    const first = tmp('first')
    await live(ITEMS.slice(0, 5), { dir: first })
    const other = await live([ITEMS[5]])
    expect(sc003(other).filter((r) => r.kind === 'events:shell.command_end').map((r) => r._causes)).toEqual([undefined])
  }, SLOW)

  // The identity is the command id within the open project, as the memory
  // version keys it: a late chunk carries no terminal, so a terminal cannot be
  // part of the key, and the hooks mint the id from the shell's pid and a
  // nanosecond clock. Whatever live does with one id seen in two terminals, a
  // restart does the same.
  it('one command id ended from another terminal: a restart links it exactly as live does', async () => {
    const items = [ITEMS[4], { ...ITEMS[5], data: { ...ITEMS[5].data, terminalId: 't9' } }]
    const a = await live(items)
    const b = await live(items, { restartsBefore: [1] })
    expect(sc003(b)).toEqual(sc003(a))
  }, SLOW)
})
