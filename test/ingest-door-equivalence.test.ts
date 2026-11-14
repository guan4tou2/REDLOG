// Spec 071 T036 (US1, FR-093): door equivalence.
//
// FR-093: the same content, whichever door it comes in by, is written as the
// same row apart from `_ingest.door`, `_ingest.auth`, `_ingest.credential` and
// the time it was received. The doors there are today:
//   in-process      ingest() as RedLog's own producers call it
//   legacy-api      POST /api/events (the real handler; no port is bound)
//   legacy-handoff  a spool file, drained as main drains it
//
// Each door gets the same items in a fresh project, and every stored row —
// primary and derived, both tiers — is compared with the in-process door's
// row in the same position. Besides FR-093's list, what cannot be the same
// for two rows at all is left out: a row's id, its place in the chain (hash,
// prev_hash, signature, monotonic_ns), its process session, and the
// receiver's per-row `_ingest.event_id` (D4: minted by the receiver when the
// item brings none, which no legacy item does). `created_at` is the receipt
// time; so is a derived row's `timestamp`, which has no source time.
//
// What else differs today is pinned below by name, door by door, as KNOWN
// DIVERGENCE: it is not what FR-093 says, and the report that came with this
// test says why each is not changed here.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requires } from './helpers/requires'
import { causesByPosition, differences, interceptHttp, openRuntime, storedRows, type Item, type StoredRow } from './helpers/ingest-delivery'

const sqlite = requires('better-sqlite3')
// Each delivery loads a fresh module graph (helpers/ingest-delivery.ts); a cold
// one takes seconds on a slow runner.
const SLOW = 60_000

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-doors-eq-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
afterAll(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 10, 14, 10, 0, 0)
const at = (i: number): number => T0 + i * 1000

/** One item of every shape the legacy doors carry: chained and logged,
 *  with a terminal and without, a link, a target, and companions. */
const ITEMS: Item[] = [
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', terminalId: 't1', pid: 11, command_id: 'c1' } },
  { agent_type: 'shell', data: { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', terminal_id: 't1', pid: 11, command_id: 'c1', exit_code: 0, stdout: '22/tcp open\n' } },
  { agent_type: 'scanner', data: { subtype: 'http_request_start', flow_id: 'f1', method: 'GET', url: 'http://10.0.0.5/', host: '10.0.0.5' } },
  { agent_type: 'scanner', data: { subtype: 'http_response', flow_id: 'f1', status_code: 200, url: 'http://10.0.0.5/', host: '10.0.0.5' } },
  { agent_type: 'shell', data: { subtype: 'command_start', command: 'sshuttle -r user@10.0.0.6 10.10.0.0/16', terminalId: 't2', pid: 12, command_id: 'c2' } },
  { agent_type: 'dns', data: { subtype: 'dns_query', qname: 'intranet.example.test' } }
].map((item, i) => ({ ...item, data: { ...item.data, source_timestamp: at(i) } }))

const ROW_IDENTITY = ['id', 'hash', 'prev_hash', 'signature', 'monotonic_ns', 'created_at', 'session_id']
function comparable(rows: StoredRow[]): Array<Record<string, unknown>> {
  const causes = causesByPosition(rows)
  return rows.map((r) => {
    const row = Object.fromEntries(Object.entries(r.row).filter(([k]) => !ROW_IDENTITY.includes(k) && k !== 'data'))
    const { event_id: _minted, ...stamp } = r.data._ingest as Record<string, unknown>
    if (stamp.producer === 'derived') delete row.timestamp
    return { kind: `${r.table}:${String(r.row.agent_type)}.${String(r.data.subtype)}`, ...row, data: { ...r.data, _causes: causes(r), _ingest: stamp } }
  })
}

const ALL = ['events:shell.command_start', 'events:shell.command_end', 'events:shell.command_start', 'events:pivot.route_add',
  'events_logged:scanner.http_request_start', 'events_logged:scanner.http_response', 'events_logged:dns.dns_query']

/** FR-093's own list. `credential` is null at every legacy door, so never differs yet. */
const FR093 = ['data._ingest.door', 'data._ingest.auth', 'data._ingest.credential']

sqlite.describe('door equivalence (FR-093)', () => {
  const dirs: string[] = []
  const tmp = (label: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `redlog-doors-eq-${label}-`)); dirs.push(d); return d }
  beforeEach(() => {
    interceptHttp()
    vi.useFakeTimers({ toFake: ['Date'], now: T0 })
  })
  afterEach(() => {
    vi.useRealTimers()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  async function through(door: 'in-process' | 'legacy-api' | 'legacy-handoff', items = ITEMS): Promise<Array<Record<string, unknown>>> {
    const dir = tmp(door)
    const rt = await openRuntime(dir)
    if (door === 'legacy-handoff') {
      vi.setSystemTime(at(items.length) + 60_000)
      rt.spool(items, tmp('spool'))
    } else {
      for (const item of items) {
        vi.setSystemTime(Number(item.data.source_timestamp) + 50)
        if (door === 'legacy-api') await rt.api(item)
        else rt.inProcess(item)
      }
    }
    await rt.close()
    return comparable(await storedRows(dir))
  }

  /** Every path at which `b`'s rows differ from `a`'s, with the row kinds it differs on. */
  function divergence(a: Array<Record<string, unknown>>, b: Array<Record<string, unknown>>): Record<string, string[]> {
    expect(b.map((r) => r.kind), 'the same rows, in the same order').toEqual(a.map((r) => r.kind))
    const out: Record<string, string[]> = {}
    a.forEach((row, i) => {
      for (const p of differences(row, b[i])) (out[p] ??= []).push(String(row.kind))
    })
    return out
  }
  const beyondFr093 = (d: Record<string, string[]>): Record<string, string[]> =>
    Object.fromEntries(Object.entries(d).filter(([p]) => !FR093.includes(p)))

  it('the fixture writes what it says: both tiers, a link, a target, a companion', async () => {
    const rows = await through('in-process')
    expect(rows.map((r) => r.kind)).toEqual([
      'events:shell.command_start', 'events:shell.command_end', 'events:shell.command_start', 'events:pivot.route_add',
      'events_logged:scanner.http_request_start', 'events_logged:scanner.http_response', 'events_logged:dns.dns_query'
    ])
    expect(rows.filter((r) => (r.data as { _causes?: unknown })._causes).length).toBeGreaterThanOrEqual(3)
    expect(rows.filter((r) => r.target_id === '10.0.0.5')).not.toHaveLength(0)
  }, SLOW)

  it('legacy-api against in-process: FR-093\'s fields, and KNOWN DIVERGENCE `_ingest.producer` and the envelope columns', async () => {
    const a = await through('in-process')
    const b = await through('legacy-api')
    const primary = ['events:shell.command_start', 'events:shell.command_end', 'events:shell.command_start',
      'events_logged:scanner.http_request_start', 'events_logged:scanner.http_response', 'events_logged:dns.dns_query']
    expect(Object.keys(divergence(a, b)).filter((p) => FR093.includes(p)).sort()).toEqual(['data._ingest.auth', 'data._ingest.door'])
    expect(beyondFr093(divergence(a, b))).toEqual({
      // The receiver's class for the writer (FR-071): RedLog itself, or the
      // holder of the per-project token.
      'data._ingest.producer': primary,
      // The envelope columns, outside the hash: in-process callers pass none,
      // and a companion takes its primary row's `source` (ingest.ts emitCompanion).
      mapper: primary,
      source: ALL
    })
  }, SLOW)

  it('legacy-handoff against legacy-api: FR-093\'s fields, and KNOWN DIVERGENCE `_ingest.producer`, the `source` column and `recovered_from_spool`', async () => {
    const a = await through('legacy-api')
    const b = await through('legacy-handoff')
    const primary = ['events:shell.command_start', 'events:shell.command_end', 'events:shell.command_start',
      'events_logged:scanner.http_request_start', 'events_logged:scanner.http_response', 'events_logged:dns.dns_query']
    expect(Object.keys(divergence(a, b)).filter((p) => FR093.includes(p)).sort()).toEqual(['data._ingest.auth', 'data._ingest.door'])
    expect(beyondFr093(divergence(a, b))).toEqual({
      'data._ingest.producer': primary,
      // spool-replay.ts adds it to the data of every row it replays: inside
      // the hash, and read by the Timeline (timelineDomain.ts).
      'data.recovered_from_spool': primary,
      // `api` against `spool`, on the companion too.
      source: ALL
    })
  }, SLOW)

  // Latent today: no producer that sets a body `target_id` spools its items
  // (mitmproxy-addon.py spools only a content-free capture_gap; pcap-agent.py
  // drops what it cannot post, T072). Once one does, its row loses the target.
  it('KNOWN DIVERGENCE: a body\'s own `target_id` is the row\'s target through the API, and is not read from a spool file', async () => {
    const items: Item[] = [{ agent_type: 'scanner', target_id: 'app.example.test',
      data: { subtype: 'http_request_start', flow_id: 'f9', method: 'GET', url: 'http://app.example.test/', source_timestamp: at(0) } }]
    const viaIn = await through('in-process', items)
    const viaApi = await through('legacy-api', items)
    const viaSpool = await through('legacy-handoff', items)
    expect([viaIn, viaApi, viaSpool].map((rows) => rows.map((r) => r.target_id))).toEqual([['app.example.test'], ['app.example.test'], [null]])
  }, SLOW)
})
