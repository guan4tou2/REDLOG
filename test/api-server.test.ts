import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { request } from 'node:http'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Integration test for the app-hosted REST server: real HTTP requests against
// a live server backed by a temp SQLite project. Guarded so it skips cleanly when
// better-sqlite3 isn't compiled for the running Node ABI (same pattern as the
// other DB-backed suites).
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let api: typeof import('../src/core/api-server')
let LootDetector: typeof import('../src/core/loot-detector').LootDetector
let getEventCount: typeof import('../src/core/db/events').getEventCount
let queryEvents: typeof import('../src/core/db/events').queryEvents
let dbAvailable = false

// Give this file its own HOME before api-server is imported.
//
// `api-server.ts` resolves the global sidecar (`~/.redlog/api-token`,
// `api-port`) once at module scope from os.homedir(), and `startApiServer`
// writes both. Pointed at the real home that meant two things: vitest runs
// files in parallel, so any other file touching those paths raced this one —
// and `npm test` was reaching into the operator's own RedLog instance. The
// backup/restore below put them back, but a run killed partway through left a
// test token in place of the real one.
//
// Same fix `per-project-token.test.ts` already carries. It has to happen
// before the import, which is why the import below is dynamic.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apihome-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

try {
  const dbMod = await import('../src/core/db/index')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  api = await import('../src/core/api-server')
  LootDetector = (await import('../src/core/loot-detector')).LootDetector
  getEventCount = (await import('../src/core/db/events')).getEventCount
  queryEvents = (await import('../src/core/db/events')).queryEvents
  dbAvailable = true
} catch {
  // native module unavailable — skip
}

const describeDB = dbAvailable ? describe : describe.skip

// The sidecar, inside this file's own home — never the operator's, so there is
// nothing to back up and nothing another worker can race us for.
const RC = path.join(FAKE_HOME, '.redlog')
const TOKEN_PATH = path.join(RC, 'api-token')
const PORT_PATH = path.join(RC, 'api-port')
const readIf = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

describeDB('api-server', () => {
  let tmpDir: string
  let base: string
  let authHeaders: Record<string, string>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-api-'))
    initDB(tmpDir)
    const loot = new LootDetector()
    loot.configure({ engagementId: 'eng-1', operatorId: 'op-primary' })
    api.configureApi({ engagementId: 'eng-1', operatorId: 'op-primary', operatorName: 'Primary', lootDetector: loot })
    const port = await api.startApiServer(0) // mints the primary operator + token
    // v0.14.3: since the "early API server start" change (main b3671d9), the
    // server starts before a project is open and every non-/api/health route
    // returns 503 until onApiProjectOpen() flips the gate. Production calls
    // this from the project-open code path; tests have to do it explicitly.
    api.onApiProjectOpen()
    base = `http://127.0.0.1:${port}`
    authHeaders = { Authorization: `Bearer ${api.getApiToken()}` }
  })

  afterAll(async () => {
    api.stopApiServer()
    // A text search opens the HTTP body index; Windows cannot delete it open.
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  })

  it('rejects events pinned to a different engagement before ingest', async () => {
    const before = getEventCount()
    const response = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json', 'X-Redlog-Engagement': 'other-client' },
      body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'session_output', stdout: 'cross-project-canary' } })
    })
    expect(response.status).toBe(409)
    expect(getEventCount()).toBe(before)
  })

  it('rechecks pinned identity after an in-flight body spans a project switch', async () => {
    const before = getEventCount()
    let finish!: () => void
    const response = new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/events`, { method: 'POST', headers: {
        ...authHeaders, 'Content-Type': 'application/json', 'X-Redlog-Engagement': 'eng-1'
      } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.write('{"agent_type":"shell",')
      finish = () => req.end('"data":{"subtype":"session_output","stdout":"inflight-canary"}}')
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 100))
      api.configureApi({ engagementId: 'eng-2', operatorId: 'op-primary', operatorName: 'Primary' })
      finish()
      expect(await response).toBe(409)
      expect(getEventCount()).toBe(before)
    } finally {
      api.configureApi({ engagementId: 'eng-1', operatorId: 'op-primary', operatorName: 'Primary' })
    }
  })

  it('serves bookmarks only on the current route', async () => {
    const c = await fetch(`${base}/api/bookmarks`, {
      method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'B1', url: 'https://x' })
    })
    expect(c.status).toBe(201)
    const nu = await (await fetch(`${base}/api/bookmarks`, { headers: authHeaders })).json()
    expect(Array.isArray(nu.bookmarks)).toBe(true)
    expect(nu.bookmarks.some((m: { title: string }) => m.title === 'B1')).toBe(true)
    expect((await fetch(`${base}/api/quickmarks`, { headers: authHeaders })).status).toBe(404)
  })

  it('serves /api/health without auth', async () => {
    const r = await fetch(`${base}/api/health`)
    expect(r.status).toBe(200)
    expect((await r.json()).ok).toBe(true)
  })

  it('rejects a protected route with no token (401)', async () => {
    const r = await fetch(`${base}/api/whoami`)
    expect(r.status).toBe(401)
  })

  it('rejects an invalid token (401)', async () => {
    const r = await fetch(`${base}/api/whoami`, { headers: { Authorization: 'Bearer not-a-real-token' } })
    expect(r.status).toBe(401)
  })

  it('resolves the operator from a valid bearer token', async () => {
    const r = await fetch(`${base}/api/whoami`, { headers: authHeaders })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.operator.id).toBe('op-primary')
    expect(body.engagementId).toBe('eng-1')
  })

  it('detects loot via POST /api/loot/scan', async () => {
    const r = await fetch(`${base}/api/loot/scan`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'db dump leaked AKIAIOSFODNN7EXAMPLE plus flag{demo}' })
    })
    expect(r.status).toBe(200)
    const findings = (await r.json()).findings as Array<{ type: string }>
    expect(findings.some((f) => f.type === 'aws_key')).toBe(true)
  })

  it('returns an event count for the authed operator', async () => {
    const r = await fetch(`${base}/api/events/count`, { headers: authHeaders })
    expect(r.status).toBe(200)
    expect(typeof (await r.json()).count).toBe('number')
  })

  it('records a command that names a target, and the scope dispatch it triggers', async () => {
    // The path that was broken and that nothing here covered: posting a shell
    // command with a detectable target runs the scope-signal dispatch and the
    // credential producer. Both live past the insert, so an exception there
    // returns 500 and silently stops capture — which only the e2e noticed.
    const r = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_type: 'shell',
        data: { subtype: 'command_start', command: 'mysql -h db.example -u root -p placeholderpw' }
      })
    })
    expect(r.status, await r.text()).toBe(201)

    // And the derived row it produces: a credential use, masked.
    const creds = queryEvents({ limit: 50, tier: 'all' }).filter((e) => e.agentType === 'credential_use')
    expect(creds.length, 'no credential_use event was produced').toBeGreaterThan(0)
    expect(JSON.stringify(creds[0].data)).not.toContain('placeholderpw')
  })

  it('accepts a marker but refuses a marker amendment', async () => {
    // A marker is operator-authored and authoritative, and an amendment claims
    // to be an operator changing what a finding says. Validating a forged one
    // would only make it well-formed — any token holder could still re-title
    // someone else's finding and have the chain record it as their words.
    const marker = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_type: 'marker', data: { title: 'posted by a tool', severity: 'info' } })
    })
    expect(marker.status).toBe(201)
    const markerId = (await marker.json()).id as string

    const before = getEventCount()
    const forged = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_type: 'marker', data: { subtype: 'amended', markerId, title: 'forged' } })
    })
    expect(forged.status).toBe(403)
    expect(getEventCount(), 'a refused amendment must write nothing').toBe(before)
  })

  // Spec 026. The local API is where scripts and external tools search, so it
  // answers the same query language the app does — a condition resolves the
  // field, and a record merely quoting the id is not a match.
  it('searches with the same query language as the app', async () => {
    const { insertEvent } = await import('../src/core/db/event-write')
    const owner = insertEvent('agent', { subtype: 'assistant_message', session_id: 'API-S1', full: 'alpha' },
      { operatorId: 'op-primary', engagementId: 'eng-1' })!
    insertEvent('agent', { subtype: 'assistant_message', session_id: 'API-S2', full: 'this one only mentions API-S1' },
      { operatorId: 'op-primary', engagementId: 'eng-1' })
    const r = await fetch(`${base}/api/events/search?q=${encodeURIComponent('session:API-S1')}`, { headers: authHeaders })
    expect(r.status).toBe(200)
    const body = await r.json() as { events: Array<{ id: string }> }
    expect(body.events.map((e) => e.id)).toEqual([owner.id])
  })

  // Constitution IV: a bounded query says whether it is complete. Without it, a
  // script asking for 2 of 3 matches cannot tell a full page from the answer.
  it('says when there is more, and pages with the cursor', async () => {
    const { insertEvent } = await import('../src/core/db/event-write')
    for (const n of [1, 2, 3]) {
      insertEvent('agent', { subtype: 'assistant_message', session_id: 'PAGE', full: `pagingterm ${n}` },
        { operatorId: 'op-primary', engagementId: 'eng-1' })
    }
    type Page = { events: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null }
    const first = await (await fetch(`${base}/api/events/search?q=pagingterm&limit=2`, { headers: authHeaders })).json() as Page
    expect(first.events).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    const rest = await (await fetch(
      `${base}/api/events/search?q=pagingterm&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      { headers: authHeaders }
    )).json() as Page
    expect(rest.events).toHaveLength(1)
    expect(rest.hasMore).toBe(false)
    expect(new Set([...first.events, ...rest.events].map((e) => e.id)).size).toBe(3)
  })

  it('refuses a cursor it cannot read instead of starting over', async () => {
    const r = await fetch(`${base}/api/events/search?q=pagingterm&cursor=not-a-cursor`, { headers: authHeaders })
    expect(r.status).toBe(400)
  })

  it('rejects a half-typed condition instead of searching for its text', async () => {
    const r = await fetch(`${base}/api/events/search?q=${encodeURIComponent('session:')}`, { headers: authHeaders })
    expect(r.status).toBe(400)
    const body = await r.json() as { error: string; reason?: string }
    expect(body.reason).toBe('empty-condition-value')
  })
})
