// Spec 075 T012 (second half): the `capture` object `/api/status` and
// `/api/capture` return, pinned as a SHAPE. External callers read it — the
// agent skill (`redlog_status`), `redlog-cli status`, scripts — so Phase 3
// (T034) adds `capture.v`, `overall` and `statuses` BESIDE these fields and
// marks the old ones deprecated for one minor version; it does not rename or
// drop them. If this file fails after Phase 2, an old field changed meaning.
//
// Like test/api-route-guards.test.ts, `http.createServer` is intercepted and
// the request handler is called with an in-memory request: no port is bound
// (this sandbox refuses `listen`). Machine facts are fixed by mocking
// `detectHooks`, so the shape does not depend on what is installed here.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import fs from 'fs'
import os from 'os'
import path from 'path'

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apistatus-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
let handler: Handler | null = null
vi.spyOn(http, 'createServer').mockImplementation(((h: Handler) => {
  handler = h
  return { listen: (_p: number, _h: string, cb: () => void) => { cb() }, address: () => ({ port: 6660 }), on: () => {}, close: () => {} }
}) as never)

const { initDB, closeDB } = await import('../src/core/db/index')
const api = await import('../src/core/api-server')
const ch = await import('../src/core/capture-health')
const hooksMod = await import('../src/core/hooks-manager')
const pluginsIndex = await import('../src/core/plugins/index')
const { insertEvent } = await import('../src/core/db/events')

let projectDir: string
let token: string

function get(url: string): Promise<{ status: number; json: Record<string, any> }> {
  const req = Readable.from([]) as unknown as http.IncomingMessage
  Object.assign(req, {
    method: 'GET', url,
    headers: { host: '127.0.0.1:6660', authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' }
  })
  return new Promise((resolve) => {
    let status = 200
    const res = {
      headersSent: false, setHeader: () => {},
      writeHead(s: number) { status = s; this.headersSent = true; return this },
      end(data?: string | Buffer) { resolve({ status, json: JSON.parse(data === undefined ? 'null' : String(data)) }) }
    } as unknown as http.ServerResponse
    handler!(req, res)
  })
}

beforeAll(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apistatus-db-'))
  initDB(projectDir)
  api.configureApi({ engagementId: 'eng-1', operatorId: 'op-primary', operatorName: 'Primary' })
  await api.startApiServer(0)
  api.onApiProjectOpen()
  token = api.getApiToken()
  const active = (id: string) => ({ manifest: { id }, source: 'bundled', status: 'active' }) as never
  vi.spyOn(pluginsIndex, 'listPlugins').mockReturnValue([active('pack-host-monitors'), active('pack-windows-output')])
  ch.invalidateHooksCache()
  vi.spyOn(hooksMod, 'detectHooks').mockReturnValue([
    { id: 'shell-zsh', name: 'Zsh Shell', description: '', agentType: 'shell', installed: true, available: true, installMethod: 'shell-source', hookFile: '' }
  ] as never)
  insertEvent('shell', { subtype: 'command_start', command: 'id', shell: 'zsh', source: 'auto-relay' }, { operatorId: 'op' })
})

afterAll(async () => {
  api.stopApiServer()
  try { (await import('../src/core/http-body-index')).closeHttpBodyIndex() } catch { /* not opened */ }
  closeDB()
  vi.restoreAllMocks()
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
})

const keys = (o: object): string[] => Object.keys(o).sort()

describe('GET /api/status and /api/capture: the capture payload shape (Spec 075 T012)', () => {
  it('/api/status carries ip, eventCount, scopeViolations and capture', async () => {
    const r = await get('/api/status')
    expect(r.status).toBe(200)
    expect(keys(r.json)).toEqual(['capture', 'eventCount', 'ip', 'scopeViolations'])
    expect(typeof r.json.eventCount).toBe('number')
  })

  it('/api/capture is the same object as /api/status.capture', async () => {
    ch.invalidateHooksCache()
    const [a, b] = [await get('/api/status'), await get('/api/capture')]
    expect(b.json).toEqual(a.json.capture)
  })

  it('capture has exactly the old fields, with their types', async () => {
    ch.invalidateHooksCache()
    const c = (await get('/api/status')).json.capture
    // `undefined` fields (lastDbError, lastSampleBroken, managedHttpProxy) are not in JSON.
    expect(keys(c)).toEqual(['checkedAt', 'dbErrorFirstAt', 'dbErrorTotal', 'hasRecorded', 'lastEventAt', 'sources', 'unattributedSpool', 'verdict'])
    expect(['healthy', 'partial', 'dark']).toContain(c.verdict)
    expect(c.hasRecorded).toBe(true)
    expect(typeof c.lastEventAt).toBe('number')
    expect(typeof c.checkedAt).toBe('number')
    expect(c.dbErrorTotal).toBe(0)
    expect(c.dbErrorFirstAt).toBeNull()
    expect(c.unattributedSpool).toBeNull()
    expect(Array.isArray(c.sources)).toBe(true)
  })

  it('every source row has id, lastEventAt and one of four states; the terminal row carries the own-shell fields', async () => {
    ch.invalidateHooksCache()
    const c = (await get('/api/status')).json.capture
    for (const s of c.sources) {
      expect(typeof s.id).toBe('string')
      expect(['ready', 'unset', 'off', 'error']).toContain(s.state)
      expect(s).toHaveProperty('lastEventAt')
    }
    const terminal = c.sources.find((s: { id: string }) => s.id === 'terminal')
    expect(keys(terminal)).toEqual(['hookId', 'id', 'installed', 'lastEventAt', 'ownShellLastEventAt', 'ownShellName', 'ownShellOutputAt', 'state'])
    expect(terminal).toMatchObject({ id: 'terminal', hookId: 'shell-zsh', installed: true, state: 'ready', ownShellName: 'zsh' })
    const mitm = c.sources.find((s: { id: string }) => s.id === 'mitmproxy')
    expect(keys(mitm)).toEqual(['hookId', 'id', 'lastEventAt', 'state']) // no mitmproxy hook in the fixture: installed is absent, not false
    expect(mitm.hookId).toBe('mitmproxy')
  })

  it('a managed proxy status rides along as managedHttpProxy, old field names intact', async () => {
    ch.configureManagedProxyHealth(() => ({
      state: 'failed', url: null, error: 'port in use',
      errorReason: { code: 'port-in-use', address: '127.0.0.1:8080', holder: null }
    }))
    try {
      const c = (await get('/api/capture')).json
      expect(c.verdict).toBe('partial')
      expect(c.managedHttpProxy).toEqual({
        state: 'failed', url: null, error: 'port in use',
        errorReason: { code: 'port-in-use', address: '127.0.0.1:8080', holder: null }
      })
    } finally { ch.configureManagedProxyHealth(() => undefined) }
  })
})
