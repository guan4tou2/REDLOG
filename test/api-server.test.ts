import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Integration test for the app-hosted REST/MCP server: real HTTP requests against
// a live server backed by a temp SQLite project. Guarded so it skips cleanly when
// better-sqlite3 isn't compiled for the running Node ABI (same pattern as the
// other DB-backed suites).
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let api: typeof import('../src/core/api-server')
let LootDetector: typeof import('../src/core/loot-detector').LootDetector
let dbAvailable = false
try {
  const dbMod = await import('../src/core/db/index')
  initDB = dbMod.initDB
  closeDB = dbMod.closeDB
  api = await import('../src/core/api-server')
  LootDetector = (await import('../src/core/loot-detector')).LootDetector
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

  // io_ref sidecar (SPEC-IO-SIDECAR.md A1/A2): a posted full body lands in
  // <projectDir>/io/<sha256>.bin, the chained event carries only the digest,
  // and the bytes are retrievable — here straight off disk (the io:read IPC is
  // the renderer-facing equivalent, covered by io-store unit tests).
  it('sidecars a large posted body and keeps only the digest on the event', async () => {
    const bigBody = JSON.stringify({ dump: 'Z'.repeat(40 * 1024) })   // > 16 KB preview cap
    const post = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_type: 'scanner',
        target_id: 'example.test',
        data: {
          subtype: 'http_response',
          url: 'http://example.test/dump',
          status: 200,
          response_preview: bigBody.slice(0, 16384),
          response_body_full: bigBody,
          response_body_ct: 'application/json',
        },
      }),
    })
    expect(post.status).toBe(201)   // POST /api/events answers 201 Created

    // Read the event back: full bytes gone, io ref present (A2).
    const listed = await fetch(`${base}/api/events?agent_type=scanner&limit=10`, { headers: authHeaders })
    const payload = await listed.json() as unknown
    const rows = Array.isArray(payload) ? payload : ((payload as { events?: unknown[] }).events ?? [])
    const ev = (rows as Array<{ data: unknown }>)
      .map((e) => (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as Record<string, unknown>)
      .find((d) => d.subtype === 'http_response' && d.url === 'http://example.test/dump')
    expect(ev, 'sidecarred response event').toBeTruthy()
    expect(ev!.response_body_full, 'raw bytes must not be chained').toBeUndefined()
    const io = ev!.io as { response?: { ref: string; len: number; sha256: string; ct: string } }
    expect(io?.response?.ref).toMatch(/^[0-9a-f]{64}$/)
    expect(io!.response!.len).toBe(Buffer.byteLength(bigBody, 'utf8'))
    expect(io!.response!.ct).toBe('application/json')

    // The bytes really landed in the sidecar and match the digest (A1/A4).
    const onDisk = fs.readFileSync(path.join(tmpDir, 'io', `${io!.response!.ref}.bin`))
    expect(onDisk.toString('utf8')).toBe(bigBody)
  })

  it('does not sidecar a small body (preview is already complete)', async () => {
    const small = JSON.stringify({ ok: true })
    await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_type: 'scanner',
        data: { subtype: 'http_response', url: 'http://example.test/small', status: 200, response_preview: small },
      }),
    })
    const listed = await fetch(`${base}/api/events?agent_type=scanner&limit=20`, { headers: authHeaders })
    const payload = await listed.json() as unknown
    const rows = Array.isArray(payload) ? payload : ((payload as { events?: unknown[] }).events ?? [])
    const ev = (rows as Array<{ data: unknown }>)
      .map((e) => (typeof e.data === 'string' ? JSON.parse(e.data) : e.data) as Record<string, unknown>)
      .find((d) => d.url === 'http://example.test/small')
    expect(ev!.io).toBeUndefined()
  })
})
