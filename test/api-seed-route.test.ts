import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The e2e seed door (`POST /api/events/seed`) exists only when main configured
// test hooks on (src/main/test-hooks.ts). Off — every packaged release build —
// it must be indistinguishable from a route that was never written. Same
// no-socket harness as test/api-route-guards.test.ts: http.createServer is
// intercepted and its handler called with an in-memory request and response.

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apiseed-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
// The switch the route used to read. Set throughout, to show it no longer opens anything.
process.env.REDLOG_E2E = '1'

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
let handler: Handler | null = null
vi.spyOn(http, 'createServer').mockImplementation(((h: Handler) => {
  handler = h
  return {
    listen: (_port: number, _host: string, cb: () => void) => { cb() },
    address: () => ({ port: 6660 }),
    on: () => {},
    close: () => {}
  }
}) as never)

const { initDB, closeDB } = await import('../src/core/db/index')
const api = await import('../src/core/api-server')
const { getEventCount } = await import('../src/core/db/events')

let projectDir: string
let token: string
const ENGAGEMENT = { engagementId: 'eng-1', operatorId: 'op-primary', operatorName: 'Primary' }

interface Reply { status: number; body: string }

function call(method: string, url: string, body: string, authed = true): Promise<Reply> {
  const req = Readable.from([Buffer.from(body)]) as unknown as http.IncomingMessage
  Object.assign(req, {
    method, url,
    headers: { host: '127.0.0.1:6660', 'content-type': 'application/json', ...(authed ? { authorization: `Bearer ${token}` } : {}) },
    socket: { remoteAddress: '127.0.0.1' }
  })
  return new Promise((resolve) => {
    let status = 200
    const res = {
      headersSent: false,
      setHeader: () => {},
      writeHead(s: number) { status = s; this.headersSent = true; return this },
      end(data?: string | Buffer) { resolve({ status, body: data === undefined ? '' : String(data) }) }
    } as unknown as http.ServerResponse
    handler!(req, res)
  })
}

// A row the production route would refuse to let a client write, and that
// therefore lands only through the seed door.
const SEED = JSON.stringify({ agent_type: 'dns', data: { subtype: 'seed-route-probe' } })
// What the same answer looks like for a route that does not exist.
const unknownAnswer = (route: string): Reply => ({ status: 404, body: JSON.stringify({ error: `Unknown route: POST ${route}` }) })

beforeAll(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apiseed-db-'))
  initDB(projectDir)
  api.configureApi(ENGAGEMENT)
  await api.startApiServer(0)
  api.onApiProjectOpen()
  token = api.getApiToken()
  expect(handler).not.toBeNull()
})

afterAll(async () => {
  api.stopApiServer()
  try { (await import('../src/core/http-body-index')).closeHttpBodyIndex() } catch { /* not opened */ }
  closeDB()
  delete process.env.REDLOG_E2E
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
})

describe('POST /api/events/seed with test hooks off', () => {
  it('is off until main turns it on', async () => {
    const before = getEventCount()
    const reply = await call('POST', '/api/events/seed', SEED)
    expect(reply).toEqual(unknownAnswer('/api/events/seed'))
    expect(getEventCount()).toBe(before)
  })

  it('answers exactly like an unknown route, authenticated or not, and writes nothing', async () => {
    api.configureApi({ ...ENGAGEMENT, testHooks: false })
    const before = getEventCount()
    const seed = await call('POST', '/api/events/seed', SEED)
    const nowhere = await call('POST', '/api/events/nowhere', SEED)
    expect(seed).toEqual(unknownAnswer('/api/events/seed'))
    expect(nowhere).toEqual(unknownAnswer('/api/events/nowhere'))
    expect(await call('POST', '/api/events/seed', SEED, false)).toEqual(await call('POST', '/api/events/nowhere', SEED, false))
    expect(getEventCount()).toBe(before)
  })

  it('stays off when a later configureApi does not mention it (engagement switch)', async () => {
    api.configureApi({ ...ENGAGEMENT, testHooks: false })
    api.configureApi(ENGAGEMENT)
    expect(await call('POST', '/api/events/seed', SEED)).toEqual(unknownAnswer('/api/events/seed'))
  })
})

describe('POST /api/events/seed with test hooks on', () => {
  it('writes the row, as the e2e specs rely on', async () => {
    api.configureApi({ ...ENGAGEMENT, testHooks: true })
    try {
      const before = getEventCount()
      const reply = await call('POST', '/api/events/seed', SEED)
      expect(reply.status, reply.body).toBeLessThan(300)
      expect(getEventCount()).toBe(before + 1)
      // Invalid JSON reaches the real handler rather than the unknown-route answer.
      const bad = await call('POST', '/api/events/seed', 'not json')
      expect(bad.status).toBe(400)
    } finally { api.configureApi({ ...ENGAGEMENT, testHooks: false }) }
  })
})
