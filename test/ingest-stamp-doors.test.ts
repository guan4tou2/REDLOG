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
const LEGACY_API_STAMP = LEGACY_API

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

  // Review B: rows the pipeline derives without going through emitCompanion —
  // the loot row a command's output yields, and the scope_violation its target
  // causes — are derived too (external-event-policy.ts names both as derived).
  it('the loot row a command yields is `derived`', async () => {
    const { LootDetector } = await import('../src/core/loot-detector')
    const loot = new LootDetector()
    loot.configure({ identity: { projectId: 'p', engagementId: ENG, operatorId: who.operatorId } })
    ingestMod.configureIngest({ lootDetector: loot })
    ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_end', command: 'cat creds', terminalId: 't-l', pid: 11, exit_code: 0,
      stdout: 'password=Sup3rS3cretValue!\nAKIAIOSFODNN7EXAMPLE\n' }, ...who })
    const rows = stampsOf(`agent_type = 'loot'`)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((r) => door(r.stamp))).toEqual(rows.map(() => DERIVED))
  })

  it('the scope_violation a command causes is `derived`', async () => {
    const { ChainEmitter } = await import('../src/core/alert/surface')
    const emitter = new ChainEmitter(who)
    ingestMod.configureIngest({ alertRuntime: { dispatchTargetHit: (input) => emitter.handle({
      kind: 'scope', signal: { target: input.target, action: input.action, source: input.source, sourceEventId: input.sourceEventId },
      distance: 'out-of-scope', authority: 'fact', severity: 'warning'
    } as never) } })
    ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_start', command: 'curl https://203.0.113.9/', terminalId: 't-sv', pid: 12 }, ...who })
    const rows = stampsOf(`subtype = 'scope_violation'`)
    expect(rows).toHaveLength(1)
    expect(door(rows[0].stamp)).toEqual(DERIVED)
  })

  // Review A: a row RedLog's code writes on an API caller's behalf carries the
  // API's door. withEntrance is how a route says so for everything it calls.
  it('a row written inside withEntrance(LEGACY_API) — through insertEvent, sync or after an await — is legacy-api', async () => {
    const stampMod = await import('../src/core/ingest/stamp') as unknown as Record<string, unknown>
    const withEntrance = stampMod.withEntrance as <T>(e: unknown, fn: () => T) => T
    expect(typeof withEntrance).toBe('function')
    withEntrance(stampMod.LEGACY_API, () => events.insertEvent('system', { subtype: 'sanitized', n: 1 }, who))
    await withEntrance(stampMod.LEGACY_API, async () => {
      await new Promise((r) => setTimeout(r, 5))
      ingestMod.ingestEvent('screenshot', { trigger: 'api', filename: 'x.jpg' }, who)
    })
    events.insertEvent('system', { subtype: 'sanitized', n: 2 }, who)
    expect(stampsOf(`subtype = 'sanitized' OR agent_type = 'screenshot'`).map((r) => door(r.stamp))).toEqual([LEGACY_API_STAMP, LEGACY_API_STAMP, IN_PROCESS])
  })

  it('a companion of an API row is still `derived`, and its loot row too', async () => {
    const stampMod = await import('../src/core/ingest/stamp')
    const { LootDetector } = await import('../src/core/loot-detector')
    const loot = new LootDetector()
    loot.configure({ identity: { projectId: 'p', engagementId: ENG, operatorId: who.operatorId } })
    ingestMod.configureIngest({ lootDetector: loot })
    ingestMod.ingest({ agentType: 'shell', data: { subtype: 'command_end', command: 'sshuttle -r user@jump 10.10.0.0/16', terminalId: 't-a', pid: 13,
      exit_code: 0, duration_sec: 5, stdout: 'password=An0therS3cretValue!\n' }, ...who, entrance: stampMod.LEGACY_API })
    expect(door(stampsOf(`agent_type = 'shell'`)[0].stamp)).toEqual(LEGACY_API_STAMP)
    const derived = stampsOf(`agent_type IN ('pivot', 'loot')`)
    expect(derived.length).toBeGreaterThanOrEqual(2)
    expect(derived.map((r) => door(r.stamp))).toEqual(derived.map(() => DERIVED))
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

// Review A, without a port: every call api-server.ts makes into code that can
// write a row is made under the API's entrance. "Can write a row" is decided
// from the source: an import whose module calls insertEvent / ingest /
// ingestEvent itself, and the injected collaborators that do. A route added
// later that reaches a writer without saying its door fails here.
describe('every writer the API reaches is reached under the legacy-api entrance (source check)', () => {
  const SRC = path.join(__dirname, '..', 'src', 'core')
  const api = fs.readFileSync(path.join(SRC, 'api-server.ts'), 'utf8')
  const writes = (file: string): boolean => /\b(insertEvent|ingestEvent)\s*\(|\bingest\(\{/.test(fs.readFileSync(file, 'utf8'))
  /** Named imports of api-server.ts from modules that write rows themselves. */
  const writerImports = (): string[] => {
    const out: string[] = []
    for (const m of api.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)) {
      const file = path.join(SRC, `${m[2]}.ts`)
      if (!fs.existsSync(file) || !writes(file)) continue
      for (const name of m[1].split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type '))) out.push(name)
    }
    return out
  }
  /** Imports from writing modules that do not themselves write, each with why. */
  const READ_ONLY: Record<string, string> = {
    queryEvents: 'reads', queryEventById: 'reads', queryBuiltinTerminalSessionStart: 'reads', getEventCount: 'reads', executeEventQuery: 'reads',
    PAUSE_EXEMPT_AGENT_TYPES: 'a constant', listAnchors: 'reads', verifyLatestAnchor: 'reads', getAnchorById: 'reads', buildOtsBundle: 'builds bytes',
    getCaptureHealth: 'reads', getCaptureError: 'reads', noteDbError: 'records an error in memory', LEGACY_API: 'the entrance itself',
    isExternalEventAllowed: 'a predicate', resolveIncomingCauses: 'settles runtime pairs', noteStartEvent: 'notes an id in memory'
  }
  const INJECTED = ['lootDetectorRef.scan', 'screenshotAgentRef.captureNow', 'bundleExporterRef']

  it('names every writer it imports', () => {
    expect(writerImports().filter((n) => !READ_ONLY[n] && n !== 'ingest').sort()).toEqual(
      ['anchorNow', 'exportBundle', 'sanitize', 'upgradeAllPending', 'upgradeAnchor', 'verifyChainFullAsync'])
  })

  it('every call of a writer is inside withEntrance(LEGACY_API, …) on the same line', () => {
    const names = [...writerImports().filter((n) => !READ_ONLY[n] && n !== 'ingest'), ...INJECTED]
    const bad: string[] = []
    api.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line) || /^\s*import\b/.test(line)) return
      for (const name of names) {
        const call = new RegExp(`(?<![\\w.])${name.replace('.', '\\.')}\\??\\.?\\(`)
        if (call.test(line) && !/withEntrance\(LEGACY_API,/.test(line)) bad.push(`${i + 1}: ${line.trim()}`)
      }
    })
    expect(bad).toEqual([])
  })

  it('recording toggled by the API: main writes its pause/resume row with the API entrance', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    expect(api).toMatch(/eventBus\.pause\('api'\)/)
    expect(main).toMatch(/source === 'api' \? LEGACY_API/)
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
    const { LootDetector } = await import('../src/core/loot-detector')
    const loot = new LootDetector()
    loot.configure({ identity: { projectId: 'p', engagementId: ENG, operatorId: 'op-doors' } })
    api.configureApi({ engagementId: ENG, operatorId: 'op-doors', operatorName: 'Doors', lootDetector: loot,
      // Stands in for the screenshot agent: writes its row after an await, as the real one does.
      screenshotAgent: { captureNow: async () => {
        await new Promise((r) => setTimeout(r, 5))
        ingestMod.ingestEvent('screenshot', { trigger: 'api', filename: 'doors.jpg' }, { engagementId: ENG, operatorId: 'op-doors' })
        return '/tmp/doors.jpg'
      } } as never })
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

  const send = (route: string, body: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const post = async (route: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await send(route, body)
    expect(res.status).toBe(201)
    return await res.json() as Record<string, unknown>
  }

  // Review A: every route that can cause a row, and the rows it caused.
  const newRows = async (act: () => Promise<Response>, status: number): Promise<Array<{ agent_type: string; subtype: string | null; stamp: Stamp }>> => {
    const max = (t: string): number => (dbMod.getDB().prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${t}`).get() as { n: number }).n
    const [c, l] = [max('events'), max('events_logged')]
    const res = await act()
    expect(res.status, await res.clone().text()).toBe(status)
    return stampsOf('(t = 0 AND r > ?) OR (t = 1 AND r > ?)', c, l)
  }
  const ROUTES: Array<{ route: string; body: Record<string, unknown>; status: number; kinds: string[] }> = [
    { route: '/api/loot/scan', body: { text: 'password=Th1rdS3cretValue!' }, status: 200, kinds: ['loot'] },
    { route: '/api/screenshot', body: {}, status: 200, kinds: ['screenshot'] },
    { route: '/api/export/bundle', body: {}, status: 201, kinds: ['system', 'system'] }
  ]
  for (const r of ROUTES) {
    it(`${r.route}: every row it causes is legacy-api`, async () => {
      const rows = await newRows(() => send(r.route, r.body), r.status)
      expect(rows.map((x) => x.agent_type)).toEqual(r.kinds)
      expect(rows.map((x) => door(x.stamp))).toEqual(rows.map(() => LEGACY_API))
    })
  }
  it('/api/sanitize: its system.sanitized row is legacy-api', async () => {
    const ev = ingestMod.ingestEvent('shell', { subtype: 'command_start', command: 'cat secret-file', terminalId: 't-z', pid: 14 }, who)!
    const rows = await newRows(() => send('/api/sanitize', { event_ids: [ev.id], fields: ['command'], reason: 'doors' }), 201)
    expect(rows.map((x) => x.subtype)).toContain('sanitized')
    expect(rows.map((x) => door(x.stamp))).toEqual(rows.map(() => LEGACY_API))
  })
  // Not driven here: POST /api/anchors and the upgrade routes need a calendar
  // (their only row is anchor_failed), and POST /api/recording's row is
  // written by main's listener; the source checks above hold all three.

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
