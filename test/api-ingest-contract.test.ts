import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ServerResponse } from 'node:http'
import fs from 'fs'
import path from 'path'
import os from 'os'

// R2-0a: the HTTP half of the ingest contract. POST /api/events is the door
// every external producer uses, so what it answers is part of the interface the
// hooks rely on: a 201 means the row is durably there, a 409 means "do not
// spool this". Pinned so a queue or a stage split behind the route cannot
// change either quietly. See test/ingest-characterization.test.ts for the
// pipeline itself and test/api-server.test.ts for auth, project identity and
// the other routes.
//
// "Recorded" below means an observation of today's behaviour, not an endorsed
// one.

// Same HOME isolation as test/api-server.test.ts: api-server.ts reads the
// global sidecar location from os.homedir() at module scope.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apihome-contract-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let openReadOnlyDB: typeof import('../src/core/db/index').openReadOnlyDB
let getDB: typeof import('../src/core/db/index').getDB
let api: typeof import('../src/core/api-server')
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  initDB = dbMod.initDB; closeDB = dbMod.closeDB; openReadOnlyDB = dbMod.openReadOnlyDB; getDB = dbMod.getDB
  api = await import('../src/core/api-server')
  dbAvailable = true
} catch { /* native module unavailable — skip */ }

const describeDB = dbAvailable ? describe : describe.skip

describeDB('POST /api/events ingest contract', () => {
  let tmpDir: string
  let base: string
  let authHeaders: Record<string, string>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-api-contract-'))
    initDB(tmpDir)
    api.configureApi({ engagementId: 'eng-1', operatorId: 'op-primary', operatorName: 'Primary' })
    const port = await api.startApiServer(0) // mints the primary operator + token
    api.onApiProjectOpen()
    base = `http://127.0.0.1:${port}`
    authHeaders = { Authorization: `Bearer ${api.getApiToken()}`, 'Content-Type': 'application/json' }
  })
  afterAll(async () => {
    api.stopApiServer()
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  })

  const post = (agent_type: string, data: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/api/events`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ agent_type, data }) })
  const count = (): number => (getDB().prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n

  it('answers 409 to the second of two identical commands inside the dedup window', async () => {
    const data = { subtype: 'command_start', command: 'id', terminal_id: 'http-dedup-t1', pid: 4001 }
    const first = await post('shell', data)
    expect(first.status).toBe(201)
    const before = count()
    const second = await post('shell', data)
    expect(second.status).toBe(409)
    expect(count()).toBe(before)
  })

  it('has the row readable through a second read-only connection when the 201 arrives', async () => {
    // The backend acknowledges only after the effect (CT-16). Two observers:
    //  - the server side, at the moment the 201 is written. This one cannot be
    //    fooled by scheduling: the server and this test share an event loop, so
    //    anything the handler defers by a tick would still have run before the
    //    client got to read the reply. Watching the write itself does not
    //    depend on that.
    //  - the client side, when the reply has been read.
    const ackWrites: Array<{ status: number; id: string | null; visible: boolean }> = []
    const realEnd = ServerResponse.prototype.end
    // A fresh connection each time, so what it sees is what is committed to
    // the file and not what the writer's own connection remembers.
    const visibleThroughSecondConnection = (id: string | null): boolean => {
      if (!id) return false
      const reader = openReadOnlyDB()
      try { return reader.prepare('SELECT 1 FROM events WHERE id = ?').get(id) !== undefined } finally { reader.close() }
    }
    ServerResponse.prototype.end = function (this: ServerResponse, ...args: unknown[]): ServerResponse {
      if (this.statusCode === 201 && typeof args[0] === 'string') {
        let id: string | null = null
        try { id = (JSON.parse(args[0]) as { id?: string }).id ?? null } catch { /* not JSON */ }
        ackWrites.push({ status: this.statusCode, id, visible: visibleThroughSecondConnection(id) })
      }
      return (realEnd as (...a: unknown[]) => ServerResponse).apply(this, args)
    } as typeof ServerResponse.prototype.end
    try {
      const response = await post('shell', { subtype: 'command_start', command: 'whoami', terminal_id: 'http-ack-t1', pid: 4002 })
      expect(response.status).toBe(201)
      const body = await response.json() as { id: string; agentType: string; data: Record<string, unknown> }
      expect(body.id).toEqual(expect.any(String))
      // Client side: the id it was handed is already in the file.
      expect(visibleThroughSecondConnection(body.id)).toBe(true)
      // Server side: it was already there when the 201 was written.
      expect(ackWrites).toEqual([{ status: 201, id: body.id, visible: true }])
    } finally {
      ServerResponse.prototype.end = realEnd
    }
  })

  it('answers 409 to a plumbing command and writes nothing (recorded)', async () => {
    // Recorded, not endorsed. ingest() reports `skipped: 'plumbing'`, but the
    // route only distinguishes paused / unrecorded from "everything else",
    // so RedLog's own shell wiring is answered with the dedup message
    // (api-server.ts, the `!result.event` branch). A hook reading 409 as "do
    // not retry" is the behaviour that matters and the one pinned here.
    const before = count()
    const response = await post('shell', { subtype: 'command_start', command: 'source /opt/redlog/shell-bash-hook.sh', terminal_id: 'http-plumb-t1' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Duplicate event (dedup window)' })
    expect(count()).toBe(before)
  })
})
