// Spec 071 T030 (US1): every door stamps, and says which door it is.
//
// Before credentials (Phase 4) and the contract-1 receiver (Phase 5) there are
// three ways in, and the stamp names the one a row took (FR-005):
//
//   POST /api/events, /api/marker   door legacy-api, producer legacy, auth bearer
//   a file in ~/.redlog/pending     door legacy-handoff, producer legacy-handoff, auth none (FR-069)
//   RedLog's own code               door in-process, producer in-process
//     … and a row the pipeline derives from another (a companion): producer derived
//
// `producer` is the receiver's class for the writer (FR-071, and
// external-event-policy.ts ProducerClass), not the producer's own name. Every
// door removes a caller's receiver-owned keys and says so in `stripped`.
// FR-022: a capture session's `session_start` carries `_ingest`, so the rows
// of a session written by this code can be told from one written by older code.
//
// The API half needs a listening socket and is skipped where binding a port is
// not allowed; a source check beside it holds the route's ingest calls to the
// door in that case too.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { requires } from './helpers/requires'

// api-server.ts reads the global sidecar location from os.homedir() at module
// scope (same isolation as test/api-events-legacy-mapping.test.ts).
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stamp-doors-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

const sqlite = requires('better-sqlite3')
const listen = requires('listen')

let dbMod: typeof import('../src/core/db/index')
let events: typeof import('../src/core/db/events')
let ingestMod: typeof import('../src/core/ingest')
let spool: typeof import('./helpers/spool-drain-as-main')
if (sqlite.ok) {
  dbMod = await import('../src/core/db/index')
  events = await import('../src/core/db/events')
  ingestMod = await import('../src/core/ingest')
  spool = await import('./helpers/spool-drain-as-main')
}

afterAll(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true }))

const ENG = 'eng-doors'
const who = { engagementId: ENG, operatorId: 'op-doors' }
const IN_PROCESS = { v: 1, door: 'in-process', producer: 'in-process', auth: 'in-process', credential: null }
const DERIVED = { ...IN_PROCESS, producer: 'derived' }
const LEGACY_HANDOFF = { v: 1, door: 'legacy-handoff', producer: 'legacy-handoff', auth: 'none', credential: null }
const LEGACY_API = { v: 1, door: 'legacy-api', producer: 'legacy', auth: 'bearer', credential: null }

type Stamp = Record<string, unknown>
function stampsOf(where: string, ...args: unknown[]): Array<{ agent_type: string; subtype: string | null; stamp: Stamp }> {
  const rows = dbMod.getDB().prepare(`SELECT agent_type, subtype, data FROM (
      SELECT agent_type, subtype, data, created_at, rowid AS r, 0 AS t FROM events
      UNION ALL SELECT agent_type, subtype, data, created_at, rowid AS r, 1 AS t FROM events_logged)
    WHERE ${where} ORDER BY t, r`).all(...args) as Array<{ agent_type: string; subtype: string | null; data: string }>
  return rows.map((r) => ({ agent_type: r.agent_type, subtype: r.subtype, stamp: (JSON.parse(r.data) as { _ingest: Stamp })._ingest }))
}
/** The stamp without its per-row id, for comparing doors. */
const door = (s: Stamp): Stamp => { const { event_id: _id, ...rest } = s; return rest }

sqlite.describe('the in-process doors and the spool', () => {
  let dir = ''
  let pending = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stamp-doors-'))
    pending = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stamp-doors-spool-'))
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(ENG)
    ingestMod._resetIngest()
  })
  afterEach(async () => {
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    dbMod.closeDB()
    for (const d of [dir, pending]) fs.rmSync(d, { recursive: true, force: true })
  })

  it('session_start, written the way main writes it on every open, carries the in-process stamp (FR-022)', () => {
    const ev = events.insertEvent('system', { subtype: 'session_start' }, who)!
    expect(door(stampsOf('subtype = ?', 'session_start')[0].stamp)).toEqual(IN_PROCESS)
    expect((ev.data._ingest as Stamp).door).toBe('in-process')
  })

  it('ingestEvent from RedLog\'s own code: in-process', () => {
    ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'whoami', terminalId: 'term-1', pid: 7, source: 'builtin-terminal' }, who)
    expect(door(stampsOf(`agent_type = 'shell'`)[0].stamp)).toEqual(IN_PROCESS)
  })

  it('a companion the pipeline derives is `derived`; the row it came from is not', () => {
    const r = ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'sshuttle -r user@jump 10.10.0.0/16', terminalId: 't-p', pid: 8 }, ...who })
    expect(r.companions.map((c) => c.agentType)).toContain('pivot')
    expect(door(stampsOf(`agent_type = 'shell'`)[0].stamp)).toEqual(IN_PROCESS)
    expect(stampsOf(`agent_type = 'pivot'`).map((s) => door(s.stamp))).toEqual([DERIVED])
  })

  it('a spooled file: legacy-handoff, auth none — and a forged `_ingest` in it is stripped and named', () => {
    const file = (name: string, payload: Record<string, unknown>): void =>
      fs.writeFileSync(path.join(pending, name), JSON.stringify({ ...payload, _identity: who }))
    file('0001.json', { agent_type: 'shell', data: { subtype: 'command_start', command: 'ls', pid: 9, terminalId: 't-s', source_timestamp: Date.now() - 5000 } })
    file('0002.json', { agent_type: 'shell', data: { subtype: 'command_start', command: 'pwd', pid: 10, terminalId: 't-s', source_timestamp: Date.now() - 4000,
      _ingest: { v: 1, door: 'in-process', producer: 'in-process', auth: 'in-process', credential: null } } })
    const run = spool.drainSpoolAsMain(pending, who)
    expect(run?.replayed).toBe(2)
    const got = stampsOf(`agent_type = 'shell'`).map((s) => door(s.stamp))
    expect(got).toEqual([LEGACY_HANDOFF, { ...LEGACY_HANDOFF, stripped: ['_ingest'] }])
  })

  it('the spool\'s own record of what it refused is RedLog writing: in-process', () => {
    fs.writeFileSync(path.join(pending, '0001.json'), JSON.stringify({ agent_type: 'system', data: { subtype: 'recording_resumed' }, _identity: who }))
    spool.drainSpoolAsMain(pending, who)
    const gaps = stampsOf(`subtype = 'capture_gap'`)
    expect(gaps).toHaveLength(1)
    expect(door(gaps[0].stamp)).toEqual(IN_PROCESS)
    expect(stampsOf(`subtype = 'recording_resumed'`)).toEqual([])
  })
})

describe('the API route names its door (source check; holds where no port can be bound)', () => {
  it('every ingest() call in api-server.ts passes the legacy-api entrance', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'api-server.ts'), 'utf8')
    const calls = [...src.matchAll(/\bingest\(\{([\s\S]*?)\}\)/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c, c).toMatch(/\bentrance:\s*LEGACY_API\b/)
  })
})

const describeApi = sqlite.ok ? listen.describe : sqlite.describe

describeApi('POST /api/events and /api/marker: legacy-api, auth bearer', () => {
  let api: typeof import('../src/core/api-server')
  let dir = ''
  let keys = ''
  let base = ''
  let token = ''
  const prevKeys = process.env.REDLOG_KEYS_DIR

  beforeAll(async () => {
    api = await import('../src/core/api-server')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stamp-doors-api-'))
    keys = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-stamp-doors-keys-'))
    process.env.REDLOG_KEYS_DIR = keys
    dbMod.initDB(dir)
    dbMod.bindDBEngagement(ENG)
    ingestMod._resetIngest()
    api.configureApi({ engagementId: ENG, operatorId: 'op-doors', operatorName: 'Doors' })
    const port = await api.startApiServer(0)
    api.onApiProjectOpen()
    base = `http://127.0.0.1:${port}`
    token = api.getApiToken()
  })
  afterAll(async () => {
    api.stopApiServer()
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    dbMod.closeDB()
    for (const d of [dir, keys]) fs.rmSync(d, { recursive: true, force: true })
    if (prevKeys === undefined) delete process.env.REDLOG_KEYS_DIR
    else process.env.REDLOG_KEYS_DIR = prevKeys
  })

  const post = async (route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect(res.status).toBe(201)
    return await res.json() as Record<string, unknown>
  }

  it('an event, with a forged stamp in it', async () => {
    const row = await post('/api/events', { agent_type: 'shell', data: { subtype: 'command_start', command: 'id', terminalId: 'api-t', pid: 11,
      _ingest: { v: 1, door: 'in-process', producer: 'builtin-terminal', auth: 'in-process', credential: null }, _clock_anomaly: { reason: 'forged' } } })
    const stamp = (row.data as { _ingest: Stamp })._ingest
    expect(door(stamp)).toEqual({ ...LEGACY_API, stripped: ['_ingest', '_clock_anomaly'] })
    expect(door(stampsOf('id = ?', row.id)[0].stamp)).toEqual(door(stamp))
  })

  it('a logged-tier event', async () => {
    const row = await post('/api/events', { agent_type: 'dns', data: { subtype: 'dns_query', qname: 'doors.test' } })
    expect(row.tier).toBe('logged')
    expect(door((row.data as { _ingest: Stamp })._ingest)).toEqual(LEGACY_API)
  })

  it('a marker', async () => {
    const row = await post('/api/marker', { title: 'door', notes: 'n' })
    expect(door((row.data as { _ingest: Stamp })._ingest)).toEqual(LEGACY_API)
  })
})
