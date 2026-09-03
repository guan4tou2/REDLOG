import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

// startApiServer writes the primary token/port under ~/.redlog; back them up so a
// local run doesn't disturb a RedLog instance the developer has open.
const RC = path.join(os.homedir(), '.redlog')
const TOKEN_PATH = path.join(RC, 'api-token')
const PORT_PATH = path.join(RC, 'api-port')
const readIf = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const restore = (p: string, v: string | null): void => { try { v === null ? fs.rmSync(p, { force: true }) : fs.writeFileSync(p, v, { mode: 0o600 }) } catch { /* */ } }

describeDB('api-server', () => {
  let tmpDir: string
  let base: string
  let authHeaders: Record<string, string>
  let savedToken: string | null
  let savedPort: string | null

  beforeAll(async () => {
    savedToken = readIf(TOKEN_PATH)
    savedPort = readIf(PORT_PATH)
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

  afterAll(() => {
    api.stopApiServer()
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    restore(TOKEN_PATH, savedToken)
    restore(PORT_PATH, savedPort)
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
})
