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

/** What SC-003 holds equal, per row. */
const sc003 = (rows: StoredRow[]) => {
  const causes = causesByPosition(rows)
  return rows.map((r) => ({
    kind: `${r.table}:${String(r.row.agent_type)}.${String(r.data.subtype)}`, command: r.data.command,
    target_id: r.row.target_id, engagement_id: r.row.engagement_id, operator_id: r.row.operator_id, _causes: causes(r)
  }))
}

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

  /** Post `items` live, each a little after it was observed, restarting the app before each index in `restartsBefore`. */
  async function live(items: Item[], restartsBefore: number[] = []): Promise<StoredRow[]> {
    const dir = tmp('live')
    let rt = await openRuntime(dir)
    for (const [i, item] of items.entries()) {
      if (restartsBefore.includes(i)) { await rt.close(); rt = await openRuntime(dir) }
      vi.setSystemTime(Number(item.data.source_timestamp) + 50)
      await rt.api(item)
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
    const b = await live(ITEMS, [4])
    expect(whole(b)).toEqual(whole(a))
    expect(new Set(b.map((r) => r.row.session_id)).size, 'the restart opened a second session').toBe(2)
  }, SLOW)

  // KNOWN GAP (SC-003): what links an end to its start is held in memory
  // (causes-resolver.ts: command_id, terminal+pid+command, flow_id), so a
  // restart between a command's start and its end loses the link. Persisting
  // the causal link belongs to O18, which spec.md says has no FR or task yet;
  // no task here will turn this. It pins exactly what differs — the one end row's `_causes`, and the companion it
  // derives, which cites it and so moves with it in no other way.
  it('KNOWN GAP (O18, no task yet): restarted inside a command, its end loses its `_causes`, and nothing else differs', async () => {
    const a = await live(ITEMS)
    const b = await live(ITEMS, [5]) // between ITEMS[4] and ITEMS[5], sshuttle's start and end
    const lost = (r: ReturnType<typeof sc003>[number]): boolean => r.kind === 'events:shell.command_end' && r.command === ITEMS[5].data.command
    expect(sc003(a).filter(lost).map((r) => r._causes), 'live, the end cites its start').toEqual([['#2']])
    expect(sc003(b)).toEqual(sc003(a).map((r) => lost(r) ? { ...r, _causes: undefined } : r))
  }, SLOW)
})
