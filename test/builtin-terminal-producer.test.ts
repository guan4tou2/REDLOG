// Spec 071 T026 (FR-012): for a row that carries `_ingest`, "is this the
// built-in terminal's recording" is the receiver's word, not the row's.
//
// The built-in terminal's recordings are named by its session rows
// (`session_start` / `session_end`, `castPath`), and those are written by
// RedLog's own code: main/terminal-manager.ts, in-process. A row that says
// `source: 'builtin-terminal'` is the producer's own word — any holder of the
// API token could post one, and a spool file could carry one. Before this,
// such a row was taken as the terminal's recording wherever a cast is read:
//   - /api/terminal/replay and the IPC replay took the newest session_start
//     for the recording id, so a later forged one replaced the real cast;
//   - the IPC session replay and replay-at-time read `castPath` from it;
//   - orphan recovery on project open opened its `castPath` (anywhere on
//     disk: recovery has no containment check) and hashed the file into a new
//     in-process row.
// Now a stamped session row is the terminal's only when its `_ingest.producer`
// is `in-process`. Rows written before 071 carry no stamp and keep today's
// reading of `data.source`.
//
// No port: the API half calls the route's handler with `http.createServer`
// intercepted, as test/api-route-guards.test.ts does.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bt-producer-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('../src/core/cast-index', () => ({ indexCast: vi.fn(async () => undefined), castIndexStatus: vi.fn(), searchCasts: vi.fn(), backfillCastIndex: vi.fn(), readIndexedCastRange: vi.fn() }))

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
let handler: Handler | null = null
vi.spyOn(http, 'createServer').mockImplementation(((h: Handler) => {
  handler = h
  return { listen: (_p: number, _h: string, cb: () => void) => { cb() }, address: () => ({ port: 6661 }), on: () => {}, close: () => {} }
}) as never)

const { initDB, closeDB, getDB } = await import('../src/core/db/index')
const api = await import('../src/core/api-server')
const { ingestEvent, _resetIngest } = await import('../src/core/ingest')
const { queryBuiltinTerminalSessionStart, queryBuiltinTerminalSessions } = await import('../src/core/db/events')
const { registerTerminalIpc } = await import('../src/main/ipc/terminal')
const { configureTerminal, recoverOrphanSessions } = await import('../src/main/terminal-manager')

const ENG = 'eng-bt'
const OP = 'op-primary'
const ids = { engagementId: ENG, operatorId: OP }
let token = ''
let project = ''
let casts = ''
const ipc = new Map<string, (_e: unknown, ...args: unknown[]) => Promise<Record<string, unknown>>>()

function call(url: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  Object.assign(req, { method: 'POST', url, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:6661', authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  return new Promise((resolve) => {
    let status = 200
    const res = {
      headersSent: false, setHeader: () => {},
      writeHead(s: number) { status = s; this.headersSent = true; return this },
      end(data?: string | Buffer) { resolve({ status, json: data === undefined ? {} : JSON.parse(String(data)) }) }
    } as unknown as http.ServerResponse
    handler!(req, res)
  })
}

/** A cast file in the project's casts/ whose one frame says `text`, timed inside the last ten seconds. */
function cast(name: string, text: string): string {
  const file = path.join(casts, name)
  fs.writeFileSync(file, `${JSON.stringify({ version: 2, width: 80, height: 24, timestamp: Math.floor(Date.now() / 1000) - 2 })}\n${JSON.stringify([1, 'o', text])}\n`)
  return file
}
/** POST /api/events: the legacy-api door, what any holder of the token can write. */
async function viaApi(data: Record<string, unknown>): Promise<string> {
  const r = await call('/api/events', { agent_type: 'shell', data })
  expect(r.status, JSON.stringify(r.json)).toBe(201)
  return String(r.json.id)
}
/** A row as code before Spec 071 wrote it: no `_ingest`. */
function preStamp(data: Record<string, unknown>): string {
  const id = crypto.randomUUID()
  getDB().prepare(`INSERT INTO events (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at,hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, Date.now(), ENG, 's-old', OP, 'shell', String(data.subtype), 'h', JSON.stringify(data), Date.now(), `old-${id}`)
  return id
}
const sessionStart = (recordingId: string, castPath: string) =>
  ({ subtype: 'session_start', source: 'builtin-terminal', terminalId: `t-${recordingId}`, recordingId, castPath })
const commandEnd = (recordingId: string) =>
  ({ subtype: 'command_end', source: 'builtin-terminal', terminalId: `t-${recordingId}`, recordingId, command: `id ${recordingId}`, duration_sec: 10, exit_code: 0 })

beforeAll(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bt-producer-'))
  initDB(project)
  api.configureApi({ engagementId: ENG, operatorId: OP, operatorName: 'Primary' })
  await api.startApiServer(0)
  api.onApiProjectOpen()
  token = api.getApiToken()
  const ctx = { getActiveProject: () => ({ id: ENG, name: 'T', path: project, createdAt: 1, lastOpened: 1 }),
    getCurrentEngagementId: () => ENG, getCurrentOperatorId: () => OP }
  registerTerminalIpc({ handle: (n: string, fn: never) => ipc.set(n, fn), on: () => {} } as never, ctx as never)
})
afterAll(async () => {
  api.stopApiServer()
  try { (await import('../src/core/http-body-index')).closeHttpBodyIndex() } catch { /* not opened */ }
  closeDB()
  for (const d of [project, FAKE_HOME]) fs.rmSync(d, { recursive: true, force: true })
})
beforeEach(() => {
  _resetIngest()
  casts = path.join(project, 'casts')
  fs.mkdirSync(casts, { recursive: true })
})

describe('the predicate, in JS and in SQL, for every entrance there is', () => {
  it('only the in-process stamp, or no stamp at all, makes a session row the terminal\'s; the two forms agree', async () => {
    const stamp = await import('../src/core/ingest/stamp')
    const { isBuiltinTerminalRecording, builtinTerminalRecordingSql } = await import('../src/core/ingest/builtin-terminal')
    const at = (entrance: typeof stamp.IN_PROCESS) => ({ source: 'builtin-terminal', _ingest: stamp.ingestStamp(entrance, { tier: 'chained', now: Date.now() }) })
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['in-process', at(stamp.IN_PROCESS), true],
      ['derived', at(stamp.DERIVED), false],
      ['legacy-api', at(stamp.LEGACY_API), false],
      ['legacy-handoff', at(stamp.LEGACY_HANDOFF), false],
      ['no stamp (pre-071)', { source: 'builtin-terminal' }, true],
      ['no stamp, another source', { source: 'zsh' }, false],
      ['in-process, another source', { ...at(stamp.IN_PROCESS), source: 'zsh' }, false],
      ['a null stamp', { source: 'builtin-terminal', _ingest: null }, false]
    ]
    const sql = getDB().prepare(`SELECT CASE WHEN ${builtinTerminalRecordingSql('j')} THEN 1 ELSE 0 END AS ok FROM (SELECT ? AS j)`)
    for (const [label, data, want] of cases) {
      expect(isBuiltinTerminalRecording(data), label).toBe(want)
      expect((sql.get(JSON.stringify(data)) as { ok: number }).ok === 1, `${label} (SQL)`).toBe(want)
    }
  })
})

describe('the session row a recording id names', () => {
  it('a session_start posted to the API does not stand in for the terminal\'s own, though it came later', async () => {
    ingestEvent('shell', sessionStart('rec-a', cast('genuine-a.cast', 'GENUINE-A')), ids)
    await viaApi(sessionStart('rec-a', cast('forged-a.cast', 'FORGED-A')))
    expect(queryBuiltinTerminalSessionStart('rec-a')?.data.castPath).toBe(path.join(casts, 'genuine-a.cast'))
  })

  it('one that only the API or a spool file wrote names no recording', async () => {
    await viaApi(sessionStart('rec-b', cast('forged-b.cast', 'FORGED-B')))
    expect(queryBuiltinTerminalSessionStart('rec-b')).toBeNull()
    expect(queryBuiltinTerminalSessions().map((e) => e.data.recordingId)).not.toContain('rec-b')
  })

  it('a row written before 071 is read as it always was', () => {
    preStamp(sessionStart('rec-old', cast('old.cast', 'OLD')))
    expect(queryBuiltinTerminalSessionStart('rec-old')?.data.castPath).toBe(path.join(casts, 'old.cast'))
    expect(queryBuiltinTerminalSessions().map((e) => e.data.recordingId)).toContain('rec-old')
  })
})

describe('POST /api/terminal/replay and IPC terminal:replay read the terminal\'s cast, never a posted one', () => {
  it('a forged later session_start: both replay the genuine cast', async () => {
    ingestEvent('shell', sessionStart('rec-c', cast('genuine-c.cast', 'GENUINE-C')), ids)
    await viaApi(sessionStart('rec-c', cast('forged-c.cast', 'FORGED-C')))
    const end = await viaApi(commandEnd('rec-c'))
    const viaRoute = await call('/api/terminal/replay', { eventId: end })
    expect(viaRoute.status).toBe(200)
    expect(viaRoute.json.text).toBe('GENUINE-C')
    const viaIpc = await ipc.get('terminal:replay')!(null, end)
    expect(viaIpc).toMatchObject({ ok: true, text: 'GENUINE-C' })
  })

  it('a forged session_start alone: no cast for this recording', async () => {
    await viaApi(sessionStart('rec-d', cast('forged-d.cast', 'FORGED-D')))
    const end = await viaApi(commandEnd('rec-d'))
    expect(await call('/api/terminal/replay', { eventId: end })).toEqual({ status: 404, json: { error: 'no cast file for this recording' } })
    expect(await ipc.get('terminal:replay')!(null, end)).toEqual({ ok: false, error: 'no cast file for this recording' })
  })

  it('rows written before 071 replay as they always did', async () => {
    preStamp(sessionStart('rec-e', cast('old-e.cast', 'OLD-E')))
    const end = preStamp(commandEnd('rec-e'))
    expect((await call('/api/terminal/replay', { eventId: end })).json.text).toBe('OLD-E')
    expect(await ipc.get('terminal:replay')!(null, end)).toMatchObject({ ok: true, text: 'OLD-E' })
  })
})

describe('IPC terminal:replaySession and terminal:replayAtTime', () => {
  it('a session row posted to the API is not a recording to replay', async () => {
    const forged = await viaApi(sessionStart('rec-f', cast('forged-f.cast', 'FORGED-F')))
    expect(await ipc.get('terminal:replaySession')!(null, forged)).toEqual({ ok: false, error: 'not a builtin-terminal session event' })
    const genuine = ingestEvent('shell', sessionStart('rec-g', cast('genuine-g.cast', 'GENUINE-G')), ids)!
    expect(await ipc.get('terminal:replaySession')!(null, genuine.id)).toMatchObject({ ok: true, text: 'GENUINE-G' })
    const old = preStamp(sessionStart('rec-h', cast('old-h.cast', 'OLD-H')))
    expect(await ipc.get('terminal:replaySession')!(null, old)).toMatchObject({ ok: true, text: 'OLD-H' })
  })

  it('the session active at a moment is the newest of the terminal\'s own, not a later posted one', async () => {
    ingestEvent('shell', sessionStart('rec-i', cast('genuine-i.cast', 'GENUINE-I')), ids)
    await new Promise((r) => setTimeout(r, 5))
    await viaApi(sessionStart('rec-j', cast('forged-j.cast', 'FORGED-J')))
    const got = await ipc.get('terminal:replayAtTime')!(null, Date.now())
    expect(got.ok).toBe(true)
    expect((got.events as Array<[number, string, string]>).map((e) => e[2])).toEqual(['GENUINE-I'])
  })
})

describe('orphan recovery on project open', () => {
  let outside = ''
  beforeEach(() => {
    outside = path.join(FAKE_HOME, `outside-${crypto.randomUUID()}.txt`)
    fs.writeFileSync(outside, 'OUTSIDE-CANARY\n')
    configureTerminal({ identity: { projectId: 'p', engagementId: ENG, operatorId: OP } })
  })
  afterEach(() => {
    // Close what this test left open, so the next one counts only its own.
    recoverOrphanSessions()
  })
  const recoveredEnds = (): Array<Record<string, unknown>> =>
    (getDB().prepare(`SELECT data FROM events WHERE subtype = 'session_end'`).all() as Array<{ data: string }>)
      .map((r) => JSON.parse(r.data) as Record<string, unknown>)

  it('does not open, hash or record a file a posted session_start names', async () => {
    await viaApi(sessionStart('rec-k', outside))
    recoverOrphanSessions()
    const ends = recoveredEnds().filter((d) => d.recordingId === 'rec-k')
    expect(ends).toEqual([])
  })

  // Review: the other half of the same query. An end that cites a start
  // closes it; a posted end must not, or the genuine recording is never
  // recovered and its segment hashes never enter the chain.
  it('a session_end posted to the API does not close the terminal\'s own orphaned session', async () => {
    const start = ingestEvent('shell', sessionStart('rec-n', cast('genuine-n.cast', 'GENUINE-N')), ids)!
    await viaApi({ subtype: 'session_end', source: 'builtin-terminal', terminalId: 't-rec-n', recordingId: 'rec-n', _causes: [start.id] })
    expect(recoverOrphanSessions()).toBe(1)
    const ends = recoveredEnds().filter((d) => d.recordingId === 'rec-n' && d.recovered === true)
    expect(ends.map((d) => (d.castSegments as Array<{ path: string }>).map((p) => path.basename(p.path)))).toEqual([['genuine-n.cast']])
  })

  it('an end written before 071 still closes a session written before 071', () => {
    const start = preStamp(sessionStart('rec-o', cast('old-o.cast', 'OLD-O')))
    preStamp({ subtype: 'session_end', source: 'builtin-terminal', terminalId: 't-rec-o', recordingId: 'rec-o', _causes: [start] })
    recoverOrphanSessions()
    expect(recoveredEnds().filter((d) => d.recordingId === 'rec-o' && d.recovered === true)).toEqual([])
  })

  it('still closes the terminal\'s own orphaned session, and one written before 071', () => {
    ingestEvent('shell', sessionStart('rec-l', cast('genuine-l.cast', 'GENUINE-L')), ids)
    preStamp(sessionStart('rec-m', cast('old-m.cast', 'OLD-M')))
    expect(recoverOrphanSessions()).toBe(2)
    const ends = recoveredEnds().filter((d) => d.recordingId === 'rec-l' || d.recordingId === 'rec-m')
    expect(ends.map((d) => [d.recordingId, d.recovered, (d._ingest as Record<string, unknown>).producer]).sort())
      .toEqual([['rec-l', true, 'in-process'], ['rec-m', true, 'in-process']])
  })
})
