import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { request, type IncomingMessage } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import fs from 'fs'
import path from 'path'
import os from 'os'

// R3-0: characterization of the loopback API's single entry gate
// (docs/DESIGN-project-runtime.md §3, step R3: "loopback/host/token/size/
// project-identity checks stay in one unskippable entry").
//
// These tests pin what `handleRequest` in src/core/api-server.ts does TODAY, in
// the order it does it, so that splitting the file by capability cannot weaken
// the boundary without a test going red. They are not a statement that every
// pinned behaviour is desirable: the places where today's behaviour looks like a
// gap are marked "TODAY" and are pinned as they are, not as they should be.
//
// Gate order, as read from the source:
//   sidecar self-heal -> Host allowlist (400 `bad host`) -> Origin reflection ->
//   OPTIONS (204) -> GET /api/health (no auth) -> no project (503) ->
//   Bearer token (401) -> route -> 404 `Unknown route`.
//   The 20 MiB body cap lives in `readBody`, which each body-reading route calls.
//
// Not repeated here (see test/api-server.test.ts): the pinned-engagement 409
// before ingest, the `_identity` 409, the in-flight events/marker/bookmarks/
// sanitize project switch (the first block of case 7 below exercises the same
// routes through the table and adds the no-pin and project-closed variants),
// bookmarks on the current route, /api/health without auth, a missing token and
// an invalid token on /api/whoami, and the 401 on /api/http-verify.
//
// Real HTTP against the real server; nothing is mocked. The server binds
// 127.0.0.1 only, and so does every listener this file opens.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let api: typeof import('../src/core/api-server')
let LootDetector: typeof import('../src/core/loot-detector').LootDetector
let getEventCount: typeof import('../src/core/db/events').getEventCount
let queryEvents: typeof import('../src/core/db/events').queryEvents
let listBookmarks: typeof import('../src/core/db/bookmarks').listBookmarks
let getChainLength: typeof import('../src/core/evidence-chain').getChainLength
let dbAvailable = false

// Own HOME before api-server is imported: it resolves ~/.redlog/api-token and
// api-port once at module scope. Same reason and same shape as
// test/api-server.test.ts:30-32.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apientry-'))
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
  listBookmarks = (await import('../src/core/db/bookmarks')).listBookmarks
  getChainLength = (await import('../src/core/evidence-chain')).getChainLength
  dbAvailable = true
} catch {
  // native module unavailable — skip
}

const describeDB = dbAvailable ? describe : describe.skip

// ── The route manifest ────────────────────────────────────────────────────
//
// Every (method, route) `handleRequest` serves, as data. `source` is exactly
// what the source spells: the path literal after `route ===`, or the regex
// source inside `route.match(/…/)`. The scanner test below fails when the
// source and this table disagree in either direction, so a route cannot be
// added, renamed or removed without this table (and the gate checks run over it)
// being looked at.
//
// After R3 moves routes out of api-server.ts, add the new files to
// ROUTE_SOURCES; the table itself should not need to change.
const ROUTE_SOURCES = ['src/core/api-server.ts']

interface RouteRow {
  method: 'GET' | 'POST'
  source: string
  /** A concrete path that reaches the route. */
  probe: string
  /** A body that reaches the route but cannot write anything. */
  body?: string
  /** Status of the authenticated probe (project open). Pinned, but the point is
   *  that it is not the 404 `Unknown route`. */
  authed: number
  /** No project and no token needed (answered before the gate). */
  open?: true
  /** Only exists with REDLOG_E2E=1. */
  e2eOnly?: true
}

const NOT_JSON = 'not json'
const HEX64 = 'a'.repeat(64)

const ROUTES: RouteRow[] = [
  { method: 'GET', source: '/api/health', probe: '/api/health', authed: 200, open: true },
  { method: 'GET', source: '/api/whoami', probe: '/api/whoami', authed: 200 },
  { method: 'POST', source: '/api/events/seed', probe: '/api/events/seed', body: NOT_JSON, authed: 404, e2eOnly: true },
  { method: 'POST', source: '/api/events', probe: '/api/events', body: NOT_JSON, authed: 400 },
  { method: 'GET', source: '/api/events', probe: '/api/events?limit=1', authed: 200 },
  { method: 'GET', source: '/api/events/search', probe: '/api/events/search?q=zzznomatch', authed: 200 },
  { method: 'GET', source: '/api/events/count', probe: '/api/events/count', authed: 200 },
  { method: 'GET', source: '/api/export/har', probe: '/api/export/har?limit=1', authed: 200 },
  { method: 'GET', source: String.raw`^\/api\/http-body\/([a-f0-9]{64})$`, probe: `/api/http-body/${HEX64}`, authed: 404 },
  { method: 'POST', source: '/api/marker', probe: '/api/marker', body: NOT_JSON, authed: 400 },
  { method: 'POST', source: '/api/loot/scan', probe: '/api/loot/scan', body: NOT_JSON, authed: 400 },
  { method: 'POST', source: '/api/http-verify', probe: '/api/http-verify', body: NOT_JSON, authed: 400 },
  { method: 'POST', source: '/api/screenshot', probe: '/api/screenshot', authed: 503 },
  { method: 'GET', source: '/api/status', probe: '/api/status', authed: 200 },
  { method: 'GET', source: '/api/capture', probe: '/api/capture', authed: 200 },
  { method: 'GET', source: '/api/config', probe: '/api/config', authed: 200 },
  { method: 'GET', source: '/api/scope', probe: '/api/scope', authed: 200 },
  { method: 'GET', source: '/api/bookmarks', probe: '/api/bookmarks', authed: 200 },
  { method: 'POST', source: '/api/bookmarks', probe: '/api/bookmarks', body: NOT_JSON, authed: 400 },
  { method: 'GET', source: '/api/recording', probe: '/api/recording', authed: 200 },
  // `resume` while recording is already on is a no-op: nothing is written.
  { method: 'POST', source: '/api/recording', probe: '/api/recording', body: '{"action":"resume"}', authed: 200 },
  { method: 'GET', source: '/api/operators', probe: '/api/operators', authed: 200 },
  { method: 'POST', source: '/api/terminal/replay', probe: '/api/terminal/replay', body: NOT_JSON, authed: 400 },
  { method: 'GET', source: '/api/chain', probe: '/api/chain', authed: 200 },
  { method: 'GET', source: '/api/anchors', probe: '/api/anchors', authed: 200 },
  // An empty chain has no head, so this answers 400 without contacting the
  // public OpenTimestamps calendars. The sweep refuses to send it otherwise.
  { method: 'POST', source: '/api/anchors', probe: '/api/anchors', authed: 400 },
  { method: 'POST', source: '/api/export/bundle', probe: '/api/export/bundle', authed: 201 },
  { method: 'POST', source: '/api/sanitize', probe: '/api/sanitize', body: NOT_JSON, authed: 400 },
  { method: 'GET', source: '/api/clock', probe: '/api/clock', authed: 200 },
  { method: 'GET', source: '/api/anchors/verify', probe: '/api/anchors/verify', authed: 200 },
  { method: 'POST', source: '/api/anchors/upgrade-all', probe: '/api/anchors/upgrade-all', authed: 200 },
  // 404s below are the handler's own (`{ anchor: null }`), not `Unknown route`.
  { method: 'POST', source: String.raw`^\/api\/anchors\/([^/]+)\/upgrade$`, probe: '/api/anchors/no-such-anchor/upgrade', authed: 404 },
  { method: 'GET', source: String.raw`^\/api\/anchors\/([^/]+)\/ots$`, probe: '/api/anchors/no-such-anchor/ots', authed: 404 },
  { method: 'POST', source: '/api/session/register', probe: '/api/session/register', body: NOT_JSON, authed: 400 },
  { method: 'GET', source: '/api/session/registered', probe: '/api/session/registered', authed: 200 }
]

// ── Raw HTTP ──────────────────────────────────────────────────────────────
//
// `fetch` will not let a test choose the Host header, and Node's client
// rewrites an empty one. A request written by hand on a socket says exactly
// what the case means.
interface Reply { status: number; headers: Record<string, string>; text: string }

function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = []
  let i = 0
  for (;;) {
    const nl = buf.indexOf('\r\n', i)
    if (nl < 0) break
    const size = parseInt(buf.subarray(i, nl).toString('latin1'), 16)
    if (!size) break
    out.push(buf.subarray(nl + 2, nl + 2 + size))
    i = nl + 2 + size + 2
  }
  return Buffer.concat(out)
}

function rawCall(port: number, o: {
  method?: string
  path: string
  /** Header lines written verbatim. */
  headers?: Record<string, string>
  body?: string
  /** `null` writes no Host header at all. Default is the real listener. */
  host?: string | null
  version?: '1.0' | '1.1'
}): Promise<Reply> {
  const lines = [`${o.method ?? 'GET'} ${o.path} HTTP/${o.version ?? '1.1'}`]
  const host = o.host === undefined ? `127.0.0.1:${port}` : o.host
  if (host !== null) lines.push(`Host: ${host}`)
  for (const [k, v] of Object.entries(o.headers ?? {})) lines.push(`${k}: ${v}`)
  if (o.body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(o.body)}`)
  lines.push('Connection: close')
  const text = lines.join('\r\n') + '\r\n\r\n' + (o.body ?? '')
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(text))
    const chunks: Buffer[] = []
    sock.on('data', (c: Buffer) => chunks.push(c))
    sock.on('error', reject)
    sock.on('close', () => {
      const all = Buffer.concat(chunks)
      const split = all.indexOf('\r\n\r\n')
      if (split < 0) { reject(new Error(`no HTTP response (${all.length} bytes)`)); return }
      const head = all.subarray(0, split).toString('latin1').split('\r\n')
      const headers: Record<string, string> = {}
      for (const line of head.slice(1)) {
        const c = line.indexOf(':')
        if (c > 0) headers[line.slice(0, c).toLowerCase()] = line.slice(c + 1).trim()
      }
      const rest = all.subarray(split + 4)
      const bodyBuf = headers['transfer-encoding'] === 'chunked' ? dechunk(rest) : rest
      resolve({ status: Number(head[0].split(' ')[1]), headers, text: bodyBuf.toString('utf8') })
    })
  })
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })
const errorOf = (r: Reply): string | undefined => { try { return JSON.parse(r.text).error } catch { return undefined } }

/** A POST whose body is held open across a state change, then finished. */
async function bodySpanning(port: number, route: string, first: string, rest: string, change: () => void, extra: Record<string, string> = {}): Promise<{ status: number | undefined; text: string }> {
  let finish!: () => void
  const out = new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: {
      ...bearer(api.getApiToken()), 'Content-Type': 'application/json', ...extra
    } }, (res: IncomingMessage) => {
      let text = ''
      res.on('data', (d) => { text += d })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.write(first)
    finish = () => req.end(rest)
  })
  await new Promise((r) => setTimeout(r, 100))
  change()
  finish()
  return out
}

const ENGAGEMENT = { engagementId: 'eng-1', operatorId: 'op-primary', operatorName: 'Primary' }
const SWITCHED = { engagementId: 'eng-2', operatorId: 'op-primary', operatorName: 'Primary' }

// The first describe runs with no database at all: nothing has called initDB,
// so any handler that reached for the project would throw.
describeDB('api entry gate: no project has ever been opened', () => {
  let port: number
  beforeAll(async () => { port = await api.startApiServer(0) })
  afterAll(() => { api.stopApiServer() })

  // Case 9. GET /api/health is answered before the project gate, and before the
  // token. With no database initialised a handler that touched it would throw,
  // so a 200 here is the proof that it does not.
  it('answers /api/health with no token, no project and no database', async () => {
    const r = await rawCall(port, { path: '/api/health' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, projectOpen: false })
  })

  it('answers 503 on every other route, even with a token', async () => {
    for (const row of ROUTES.filter((x) => !x.open)) {
      const r = await rawCall(port, { method: row.method, path: row.probe, headers: bearer(api.getApiToken()), body: row.body })
      expect(r.status, `${row.method} ${row.probe}`).toBe(503)
    }
  })

  it('still refuses a rebinding Host before it says anything about the project', async () => {
    const r = await rawCall(port, { path: '/api/health', host: 'evil.example' })
    expect(r.status).toBe(400)
    expect(r.text).toBe('bad host')
  })
})

describeDB('api entry gate', () => {
  let tmpDir: string
  let port: number
  let token: string
  let regs: string[]

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apientry-db-'))
    initDB(tmpDir)
    const loot = new LootDetector()
    loot.configure({ identity: { projectId: 'proj-1', engagementId: 'eng-1', operatorId: 'op-primary' } })
    regs = []
    api.configureApi({
      ...ENGAGEMENT,
      lootDetector: loot,
      sessionRegistry: { register: (s) => { regs.push(s) }, list: () => regs },
      httpVerifySink: () => { /* the sink is the screen that asked; nothing here */ }
    })
    port = await api.startApiServer(0)
    api.onApiProjectOpen()
    token = api.getApiToken()
  })

  afterAll(async () => {
    api.stopApiServer()
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  })

  // ── 1. the manifest ─────────────────────────────────────────────────────
  describe('route manifest', () => {
    it('lists exactly the routes the source serves', () => {
      const root = path.resolve(__dirname, '..')
      const served: string[] = []
      for (const rel of ROUTE_SOURCES) {
        const src = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n')
        const literal = [...src.matchAll(/\broute === '([^']+)'[^\n]*?req\.method === '([A-Z]+)'/g)]
        const regex = [...src.matchAll(/\broute\.match\(\/(.+?)\/\)\n\s*if \(\w+ && req\.method === '([A-Z]+)'\)/g)]
        // Every dispatch the scanner understood, counted against every one the
        // source contains. A route written some other way (startsWith, a switch,
        // a router table) is not silently skipped: it fails here until the
        // scanner learns the new shape.
        expect(literal.length, `${rel}: a \`route ===\` the scanner could not pair with a method`)
          .toBe((src.match(/\broute === /g) ?? []).length)
        expect(regex.length, `${rel}: a \`route.match(\` the scanner could not pair with a method`)
          .toBe((src.match(/\broute\.match\(/g) ?? []).length)
        expect(src, `${rel}: unrecognised dispatch shape`).not.toMatch(/\broute\.(startsWith|endsWith|includes|indexOf)\(|switch \(route\)|case '\/api/)
        for (const m of literal) served.push(`${m[2]} ${m[1]}`)
        for (const m of regex) served.push(`${m[2]} ${m[1]}`)
      }
      expect([...new Set(served)].sort()).toEqual(ROUTES.map((r) => `${r.method} ${r.source}`).sort())
    })

    // No token -> 401. Evaluated after the project gate, so this is "open, no
    // credentials". `e2eOnly` rows answer the same 401: the 404 is behind auth.
    it.each(ROUTES.filter((r) => !r.open))('401 without a token: $method $probe', async (row) => {
      const r = await rawCall(port, { method: row.method, path: row.probe, body: row.body })
      expect(r.status).toBe(401)
      expect(errorOf(r)).toMatch(/^Unauthorized/)
    })

    // The Host check is first: a rebinding Host is refused on every route, with
    // or without credentials, and before the health route.
    it.each(ROUTES)('400 `bad host` on a rebinding Host: $method $probe', async (row) => {
      for (const headers of [{}, bearer(token)]) {
        const r = await rawCall(port, { method: row.method, path: row.probe, host: 'evil.example', headers, body: row.body })
        expect(r.status).toBe(400)
        expect(r.text).toBe('bad host')
      }
    })

    // An authenticated request reaches a handler. The 404 `Unknown route` is the
    // gate's own answer for a path nothing serves; a row in the table that
    // gets it has been dropped or renamed. The bodies are invalid or inert so
    // nothing is written (the bundle export writes into this test's own temp
    // project; the anchor routes find nothing to send).
    it.each(ROUTES.filter((r) => !r.e2eOnly))('authenticated request is routed: $method $probe', async (row) => {
      if (row.method === 'POST' && row.source === '/api/anchors') {
        // The one route that would leave the machine, if the chain had a head.
        expect(getChainLength(), 'chain must be empty before POST /api/anchors').toBe(0)
      }
      const r = await rawCall(port, { method: row.method, path: row.probe, headers: bearer(token), body: row.body })
      expect(errorOf(r) ?? '').not.toMatch(/^Unknown route/)
      expect(r.status).toBe(row.authed)
    })

    it('does not route the e2e seed door unless REDLOG_E2E=1', async () => {
      const row = ROUTES.find((r) => r.e2eOnly)!
      const before = getEventCount()
      // A body that would insert a row if the door were open.
      const valid = JSON.stringify({ agent_type: 'dns', data: { subtype: 'seed-must-not-land' } })
      expect(process.env.REDLOG_E2E).not.toBe('1')
      const shut = await rawCall(port, { method: 'POST', path: row.probe, headers: bearer(token), body: valid })
      expect(shut.status).toBe(404)
      expect(errorOf(shut)).toBe('not found')
      expect(getEventCount()).toBe(before)

      // Open: the same request is now a real route (invalid JSON, so it still
      // writes nothing). The flag is read per request.
      process.env.REDLOG_E2E = '1'
      try {
        const open = await rawCall(port, { method: 'POST', path: row.probe, headers: bearer(token), body: NOT_JSON })
        expect(open.status).toBe(400)
        expect(errorOf(open)).toBe('invalid or empty JSON body')
      } finally { delete process.env.REDLOG_E2E }
      expect(getEventCount()).toBe(before)
    })
  })

  // ── 2. unknown routes ───────────────────────────────────────────────────
  describe('unknown routes', () => {
    it.each([
      ['GET', '/api/nope'],
      ['GET', '/'],
      ['DELETE', '/api/events'],
      ['PUT', '/api/bookmarks'],
      ['GET', '/api/events/'],
      ['GET', '/api/events/count/'],
      // Encoded characters are not decoded before routing.
      ['GET', '/api/%65vents/count'],
      ['GET', '/api/events/%73eed'],
      // The routes the API deliberately does not have.
      ['GET', '/api/quickmarks'],
      ['GET', '/api/watchpath']
    ])('404 `Unknown route` for %s %s', async (method, p) => {
      const r = await rawCall(port, { method, path: p, headers: bearer(token) })
      expect(r.status).toBe(404)
      expect(errorOf(r)).toBe(`Unknown route: ${method} ${p.split('?')[0]}`)
    })

    // Auth comes before routing, so an unauthenticated probe cannot tell a real
    // route from a missing one.
    it('does not distinguish a missing route from a real one without a token', async () => {
      expect((await rawCall(port, { path: '/api/nope' })).status).toBe(401)
    })
  })

  // ── 3. CORS and OPTIONS ─────────────────────────────────────────────────
  describe('Origin and OPTIONS', () => {
    const REFLECTED = [
      'app://localhost',
      'file://localhost',
      'http://localhost',
      'http://localhost:5173',
      'http://127.0.0.1',
      'http://127.0.0.1:6660',
      'http://[::1]',
      'http://[::1]:6660'
    ]
    const NOT_REFLECTED = [
      'http://evil.example',
      'https://evil.example',
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'http://localhostevil',
      'http://evil.example/localhost',
      'http://evil.example:6660',
      // TODAY: the allowlist is `app|file|http`, so https on a loopback name is
      // not reflected, nor is the opaque `null` origin a file:// page sends.
      'https://localhost',
      'null'
    ]

    it.each(['OPTIONS', 'GET'])('reflects a loopback Origin, with Vary, on %s', async (method) => {
      for (const origin of REFLECTED) {
        const r = await rawCall(port, { method, path: '/api/health', headers: { Origin: origin } })
        expect(r.status, origin).toBe(method === 'OPTIONS' ? 204 : 200)
        expect(r.headers['access-control-allow-origin'], origin).toBe(origin)
        expect(r.headers['vary'], origin).toBe('Origin')
      }
    })

    it.each(['OPTIONS', 'GET'])('does not reflect any other Origin on %s', async (method) => {
      for (const origin of NOT_REFLECTED) {
        const r = await rawCall(port, { method, path: '/api/health', headers: { Origin: origin } })
        expect(r.status, origin).toBe(method === 'OPTIONS' ? 204 : 200)
        expect(r.headers['access-control-allow-origin'], origin).toBeUndefined()
        expect(r.headers['vary'], origin).toBeUndefined()
      }
    })

    it('never answers with a wildcard origin', async () => {
      for (const origin of [undefined, 'http://evil.example', 'http://localhost']) {
        const r = await rawCall(port, { path: '/api/health', headers: origin ? { Origin: origin } : {} })
        expect(r.headers['access-control-allow-origin']).not.toBe('*')
      }
    })

    // The preflight is answered before the project gate and before the token,
    // for any path, including a path nothing serves.
    it('answers OPTIONS 204 with no token, on a protected route and on an unknown one', async () => {
      for (const p of ['/api/events', '/api/sanitize', '/api/nope']) {
        const r = await rawCall(port, { method: 'OPTIONS', path: p })
        expect(r.status, p).toBe(204)
        expect(r.text).toBe('')
        expect(r.headers['access-control-allow-headers']).toBe('Authorization, Content-Type')
      }
    })

    it('refuses a rebinding Host before it answers a preflight', async () => {
      const r = await rawCall(port, { method: 'OPTIONS', path: '/api/events', host: 'evil.example', headers: { Origin: 'http://localhost' } })
      expect(r.status).toBe(400)
      expect(r.text).toBe('bad host')
    })
  })

  // ── 4. Host ─────────────────────────────────────────────────────────────
  describe('Host allowlist', () => {
    it.each([
      ['an empty Host header', ''],
      ['localhost', 'localhost'],
      ['localhost with the listener port', 'localhost:6660'],
      ['127.0.0.1 with a port', '127.0.0.1:6660'],
      ['mixed case', 'LocalHost:6660'],
      // TODAY: the allowlist holds `::1`, which is not a valid Host form.
      ['bare ::1', '::1']
    ])('accepts %s', async (_label, host) => {
      const r = await rawCall(port, { path: '/api/whoami', host, headers: bearer(token) })
      expect(r.status).toBe(200)
    })

    // An HTTP/1.0 request has no Host header at all; the handler reads it as
    // empty and accepts it, the same as the empty header above.
    it('accepts a request with no Host header (HTTP/1.0)', async () => {
      const r = await rawCall(port, { path: '/api/whoami', host: null, version: '1.0', headers: bearer(token) })
      expect(r.status).toBe(200)
    })

    it.each([
      'evil.example',
      'evil.example:6660',
      '127.0.0.1.evil.example',
      '127.0.0.1.evil.example:6660',
      'localhost.evil.example',
      'localhost.evil.example:6660',
      'localhostevil',
      '0.0.0.0',
      '192.168.1.10',
      'localhost@evil.example'
    ])('refuses the DNS-rebinding style Host %s', async (host) => {
      const r = await rawCall(port, { path: '/api/whoami', host, headers: bearer(token) })
      expect(r.status).toBe(400)
      expect(r.text).toBe('bad host')
    })

    // TODAY: the bracketed IPv6 forms are in the allowlist but can never match.
    // The check cuts the header at the first ':' (`[::1]:6660` -> `[`), so a
    // loopback client that says `Host: [::1]:6660` is refused. The safe
    // direction, and unreachable in practice because the server listens on
    // 127.0.0.1 only; pinned so a rewrite of the check does not change it unseen.
    it('refuses a bracketed IPv6 Host, with or without a port', async () => {
      for (const host of ['[::1]', '[::1]:6660']) {
        const r = await rawCall(port, { path: '/api/whoami', host, headers: bearer(token) })
        expect(r.status, host).toBe(400)
        expect(r.text).toBe('bad host')
      }
    })
  })

  // ── 5. Bearer ───────────────────────────────────────────────────────────
  describe('Authorization header', () => {
    const probe = (authorization: string): Promise<Reply> => rawCall(port, { path: '/api/whoami', headers: { Authorization: authorization } })

    it('accepts the project token as `Bearer <token>`', async () => {
      expect((await probe(`Bearer ${token}`)).status).toBe(200)
    })

    it('is case-sensitive about the scheme', async () => {
      for (const scheme of ['bearer', 'BEARER', 'bEARER']) {
        expect((await probe(`${scheme} ${token}`)).status, scheme).toBe(401)
      }
    })

    it('is strictly two parts', async () => {
      for (const value of [
        `Bearer ${token} x`,
        `Bearer  ${token}`,
        `Bearer\t${token}`,
        'Bearer',
        // HTTP trims trailing whitespace, so `Bearer ` is `Bearer` by the time
        // the handler splits it: an empty token cannot be sent as two parts.
        'Bearer ',
        token,
        `Basic ${token}`,
        `Token ${token}`,
        ''
      ]) {
        expect((await probe(value)).status, JSON.stringify(value)).toBe(401)
      }
    })

    // Trailing whitespace on a header value is optional whitespace (RFC 9110)
    // and is stripped by Node's parser before api-server sees it, so a token
    // "with a trailing space" is the same request as the token without. It is
    // not a bypass: the string that is compared is the token itself.
    it('does not see trailing whitespace on the header value', async () => {
      expect((await probe(`Bearer ${token} `)).status).toBe(200)
    })

    it('rejects a token of the wrong length or content', async () => {
      for (const value of [
        token.slice(0, -1),
        `${token}0`,
        token.slice(1),
        token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(),
        'x',
        '0'.repeat(token.length)
      ]) {
        expect((await probe(`Bearer ${value}`)).status, value.slice(0, 8)).toBe(401)
      }
    })

    it('rejects an empty token', async () => {
      expect((await probe('Bearer ')).status).toBe(401)
      expect((await probe('')).status).toBe(401)
    })

    it('rejects a request with no Authorization header', async () => {
      expect((await rawCall(port, { path: '/api/whoami' })).status).toBe(401)
    })
  })

  // ── 6. body size ────────────────────────────────────────────────────────
  describe('request body cap', () => {
    // A valid JSON marker whose body is a little over 20 MiB, streamed in 1 MiB
    // pieces. The body is valid on purpose: if the cap were not there the whole
    // thing would be read and the marker written, so "nothing written" tells
    // the cap from a JSON parse failure. Memory is bounded by the cap (20 MiB
    // buffered server-side) and one reused 1 MiB chunk here.
    it('refuses a body over 20 MiB, writes nothing, and keeps answering', async () => {
      const title = 'oversize-marker-canary'
      const before = getEventCount()
      const chunk = Buffer.alloc(1024 * 1024, 0x61)
      const outcome = await new Promise<{ status?: number; error?: string }>((resolve) => {
        let status: number | undefined
        let error: string | undefined
        const req = request(`http://127.0.0.1:${port}/api/marker`, { method: 'POST', headers: {
          ...bearer(token), 'Content-Type': 'application/json'
        } }, (res) => { status = res.statusCode; res.resume() })
        const closed = new Promise<void>((r) => req.on('close', () => r()))
        req.on('error', (e) => { error = (e as NodeJS.ErrnoException).code ?? e.message })
        closed.then(() => resolve({ status, error }))
        const timer = setTimeout(() => { req.destroy(); resolve({ status, error: 'test timeout' }) }, 20_000)
        closed.then(() => clearTimeout(timer))
        void (async () => {
          try {
            req.write(`{"title":"${title}","notes":"`)
            for (let i = 0; i < 21 && !req.destroyed; i++) {
              if (!req.write(chunk)) await Promise.race([once(req, 'drain'), closed])
            }
            if (!req.destroyed) req.end('"}')
          } catch { /* the server closed on us: that is the point */ }
        })()
      })
      // The oversize body was cut off: no 2xx, and the marker was not recorded.
      expect(outcome.error, JSON.stringify(outcome)).not.toBe('test timeout')
      expect(outcome.status === undefined || outcome.status >= 400, JSON.stringify(outcome)).toBe(true)
      expect(getEventCount()).toBe(before)
      expect(queryEvents({ limit: 50, tier: 'all' }).some((e) => JSON.stringify(e.data).includes(title))).toBe(false)

      // And the server is still there.
      const next = await rawCall(port, { path: '/api/events/count', headers: bearer(token) })
      expect(next.status).toBe(200)
      expect(JSON.parse(next.text).count).toBe(before)
    }, 30_000)

    // The other side of the cap: a body well under it is read and written, so
    // the test above is not passing because /api/marker cannot take a big body.
    it('accepts a large body under the cap', async () => {
      const before = getEventCount()
      const body = JSON.stringify({ title: 'under-cap marker', notes: 'a'.repeat(512 * 1024) })
      const r = await rawCall(port, { method: 'POST', path: '/api/marker', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body })
      expect(r.status).toBe(201)
      expect(getEventCount()).toBe(before + 1)
    })
  })

  // ── 6b. the event payload's shape ───────────────────────────────────────
  //
  // #548: `const data = (body.data || {}) as Record<string, unknown>` was a
  // type assertion, not a check. A caller that posted `"data": "str"` stored a
  // row whose Activity key could not be computed; one such row failed the
  // whole Activity page for the project, permanently (the chain is
  // append-only). The shape is refused here now.
  describe('event payload shape', () => {
    const post = (body: string): Promise<{ status: number; text: string }> =>
      rawCall(port, { method: 'POST', path: '/api/events', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body })

    it.each([
      ['a string', '"str"'],
      ['an array', '[1,2]'],
      ['a number', '42'],
      ['a boolean', 'true']
    ])('refuses data that is %s, and writes nothing', async (_label, json) => {
      const before = getEventCount()
      const r = await post(`{"agent_type":"shell","data":${json}}`)
      expect(r.status).toBe(400)
      expect(errorOf(r)).toBe('data must be a JSON object')
      expect(getEventCount()).toBe(before)
    })

    it('still accepts an object, and a body with no data at all', async () => {
      const before = getEventCount()
      expect((await post(JSON.stringify({ agent_type: 'shell', data: { subtype: 'shape-ok' } }))).status).toBe(201)
      expect((await post(JSON.stringify({ agent_type: 'shell' }))).status).toBe(201)
      expect(getEventCount()).toBe(before + 2)
    })
  })

  // ── 7. project identity across a body read ──────────────────────────────
  //
  // The body read yields, so a project switch can land between the token being
  // checked and the write. TODAY four routes recheck afterwards and five other
  // body-reading routes do not; both halves are pinned, so a refactor that
  // moves a route across the line has to say so.
  describe('project switch while a body is being read', () => {
    const BOUND = [
      // No pinned header here: this is the engagement-snapshot clause of the
      // recheck. api-server.test.ts covers the pinned-header form.
      { route: '/api/events', first: '{"agent_type":"shell",', rest: '"data":{"subtype":"session_output","stdout":"inflight-canary"}}' },
      { route: '/api/marker', first: '{"title":', rest: '"inflight marker"}' },
      { route: '/api/bookmarks', first: '{"title":', rest: '"inflight bookmark"}' },
      { route: '/api/sanitize', first: '{"event_ids":', rest: '[],"dry_run":false}' }
    ]

    it.each(BOUND)('409 and no write for $route when the engagement changes', async ({ route, first, rest }) => {
      const events = getEventCount()
      const marks = listBookmarks().length
      try {
        const r = await bodySpanning(port, route, first, rest, () => api.configureApi(SWITCHED))
        expect(r.status, r.text).toBe(409)
        expect(getEventCount()).toBe(events)
        expect(listBookmarks().length).toBe(marks)
      } finally { api.configureApi(ENGAGEMENT) }
    })

    it.each(BOUND)('409 and no write for $route when the project closes', async ({ route, first, rest }) => {
      const events = getEventCount()
      const marks = listBookmarks().length
      try {
        const r = await bodySpanning(port, route, first, rest, () => api.onApiProjectClose())
        expect(r.status, r.text).toBe(409)
        expect(getEventCount()).toBe(events)
        expect(listBookmarks().length).toBe(marks)
      } finally { api.onApiProjectOpen() }
    })

    // The pinned header is read before the body: a mismatch is answered while
    // the body is still open, and the body is never needed.
    it('refuses a mismatched pinned engagement on /api/events before the body is read', async () => {
      const r = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`http://127.0.0.1:${port}/api/events`, { method: 'POST', headers: {
          ...bearer(token), 'Content-Type': 'application/json', 'X-Redlog-Engagement': 'other-client'
        } }, (res) => { res.resume(); resolve(res.statusCode); req.destroy() })
        req.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e) })
        req.write('{"agent_type":"shell",') // never finished
      })
      expect(r).toBe(409)
    })

    // TODAY: these read a body and then act with no recheck. Each is 2xx or its
    // own error, never 409, after the engagement has changed under it. This is
    // the current boundary, not a recommendation; see the report for which of
    // these write into the project that is open by then.
    const UNBOUND = [
      { route: '/api/loot/scan', first: '{"text":', rest: '"nothing to find here"}', status: 200 },
      { route: '/api/terminal/replay', first: '{"eventId":', rest: '"no-such-event"}', status: 404 },
      { route: '/api/session/register', first: '{"session_id":', rest: '"inflight-session"}', status: 200 },
      { route: '/api/recording', first: '{"action":', rest: '"resume"}', status: 200 },
      { route: '/api/http-verify', first: '{"scheme":"https",', rest: '"nonce":"rv-abcdefgh1234"}', status: 200 }
    ]

    it.each(UNBOUND)('$route has no recheck: answers $status, not 409', async ({ route, first, rest, status }) => {
      const events = getEventCount()
      try {
        const r = await bodySpanning(port, route, first, rest, () => api.configureApi(SWITCHED))
        expect(r.status, r.text).toBe(status)
        expect(getEventCount()).toBe(events)
      } finally { api.configureApi(ENGAGEMENT) }
    })

    it('session registration is accepted across the switch (TODAY)', async () => {
      regs.length = 0
      try {
        const r = await bodySpanning(port, '/api/session/register', '{"session_id":', '"carried-over"}', () => api.configureApi(SWITCHED))
        expect(r.status).toBe(200)
        expect(regs).toEqual(['carried-over'])
      } finally { api.configureApi(ENGAGEMENT) }
    })
  })

  // ── 9 (with the project closed). ────────────────────────────────────────
  describe('project closed', () => {
    beforeAll(() => { api.onApiProjectClose() })
    afterAll(() => { api.onApiProjectOpen() })

    // 503 comes before the token check, so a closed project says the same thing
    // to a caller with the right token and one with none.
    it.each(ROUTES.filter((r) => !r.open))('503 with and without a token: $method $probe', async (row) => {
      for (const headers of [{}, bearer(token)]) {
        const r = await rawCall(port, { method: row.method, path: row.probe, headers, body: row.body })
        expect(r.status).toBe(503)
        expect(errorOf(r)).toMatch(/^No project open/)
      }
    })

    it('answers an unknown route with 503 as well', async () => {
      expect((await rawCall(port, { path: '/api/nope', headers: bearer(token) })).status).toBe(503)
    })

    it('still answers /api/health 200, reporting projectOpen false', async () => {
      const r = await rawCall(port, { path: '/api/health' })
      expect(r.status).toBe(200)
      expect(JSON.parse(r.text)).toMatchObject({ ok: true, projectOpen: false })
    })

    it('answers the preflight, and still refuses a rebinding Host', async () => {
      expect((await rawCall(port, { method: 'OPTIONS', path: '/api/events' })).status).toBe(204)
      const bad = await rawCall(port, { path: '/api/health', host: 'evil.example' })
      expect(bad.status).toBe(400)
      expect(bad.text).toBe('bad host')
    })
  })

  it('reports projectOpen true on /api/health once the project is open', async () => {
    const r = await rawCall(port, { path: '/api/health' })
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, projectOpen: true })
  })

  // ── 8. listen address ───────────────────────────────────────────────────
  describe('listen address', () => {
    const lan = Object.values(os.networkInterfaces()).flat()
      .find((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)?.address

    // A listener on 127.0.0.1 is not reachable on the machine's own LAN
    // address. A listener on 0.0.0.0 would be, and would then answer (at least
    // `bad host`) to the network.
    it.skipIf(!lan)('refuses a connection to the non-loopback IPv4 address', async () => {
      const outcome = await new Promise<string>((resolve) => {
        const s = net.connect({ host: lan!, port })
        const timer = setTimeout(() => { s.destroy(); resolve('unreachable (timeout)') }, 2000)
        s.on('connect', () => { clearTimeout(timer); s.destroy(); resolve('connected') })
        s.on('error', (e) => { clearTimeout(timer); resolve(`unreachable (${(e as NodeJS.ErrnoException).code})`) })
      })
      expect(outcome).toMatch(/^unreachable/)
    })
  })
})

// The EADDRINUSE fallback: the requested port is taken, the server moves to an
// ephemeral port, and stays on loopback.
describeDB('api entry gate: port already in use', () => {
  let squatter: net.Server
  let squatterPort: number
  let port: number

  beforeAll(async () => {
    squatter = net.createServer((s) => s.destroy())
    await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve))
    squatterPort = (squatter.address() as net.AddressInfo).port
    port = await api.startApiServer(squatterPort)
  })
  afterAll(async () => {
    api.stopApiServer()
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
    fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  })

  it('moves to another loopback port, and says which', async () => {
    expect(port).not.toBe(squatterPort)
    expect(port).toBeGreaterThan(0)
    expect(api.getApiPort()).toBe(port)
    const r = await rawCall(port, { path: '/api/health' })
    expect(r.status).toBe(200)
    expect(fs.readFileSync(path.join(FAKE_HOME, '.redlog', 'api-port'), 'utf8')).toBe(String(port))
  })

  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)?.address

  it.skipIf(!lan)('the fallback port is not reachable on the non-loopback address either', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const s = net.connect({ host: lan!, port })
      const timer = setTimeout(() => { s.destroy(); resolve('unreachable (timeout)') }, 2000)
      s.on('connect', () => { clearTimeout(timer); s.destroy(); resolve('connected') })
      s.on('error', (e) => { clearTimeout(timer); resolve(`unreachable (${(e as NodeJS.ErrnoException).code})`) })
    })
    expect(outcome).toMatch(/^unreachable/)
  })
})
