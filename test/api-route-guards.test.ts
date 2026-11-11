import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Route-level answers to the request shapes a probe of a running instance got
// wrong. The other API suites bind a port, which this sandbox refuses
// (`listen EPERM`); here `http.createServer` is intercepted and its request
// handler is called directly with an in-memory request and response, so the
// whole handleRequest path runs — Host gate, token, routing, body read — with
// no socket. What this cannot see is anything below the handler: the 20 MiB
// read cap tearing the socket down, and real header parsing.

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apiguard-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

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
const { listBookmarks } = await import('../src/core/db/bookmarks')
const { eventBus } = await import('../src/core/event-bus')
const { insertEvent } = await import('../src/core/db/events')

let projectDir: string
let token: string
const lootCalls: string[] = []

interface Reply { status: number; body: string; json: () => Record<string, unknown> }

function call(method: string, url: string, body?: string): Promise<Reply> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as http.IncomingMessage
  Object.assign(req, {
    method, url,
    headers: { host: '127.0.0.1:6660', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' }
  })
  return new Promise((resolve) => {
    let status = 200
    const res = {
      headersSent: false,
      setHeader: () => {},
      writeHead(s: number) { status = s; this.headersSent = true; return this },
      end(data?: string | Buffer) {
        const text = data === undefined ? '' : String(data)
        resolve({ status, body: text, json: () => JSON.parse(text) })
      }
    } as unknown as http.ServerResponse
    handler!(req, res)
  })
}

beforeAll(async () => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apiguard-db-'))
  initDB(projectDir)
  api.configureApi({
    engagementId: 'eng-1', operatorId: 'op-primary', operatorName: 'Primary',
    lootDetector: { scan: (text: string) => { lootCalls.push(text); throw new Error(`boom at ${projectDir}/secret.db: SQLITE_CORRUPT`) } }
  })
  await api.startApiServer(0)
  api.onApiProjectOpen()
  token = api.getApiToken()
  expect(handler).not.toBeNull()
})

afterAll(async () => {
  api.stopApiServer()
  try { (await import('../src/core/http-body-index')).closeHttpBodyIndex() } catch { /* not opened */ }
  closeDB()
  fs.rmSync(projectDir, { recursive: true, force: true })
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
})

describe('POST /api/recording needs an explicit action', () => {
  it.each(['not json', '', '[]', '"pause"', '5', 'null', '{}', '{"action":"stop"}'])(
    'body %j is a 400 and recording does not change', async (body) => {
      eventBus.resume('api')
      const r = await call('POST', '/api/recording', body)
      expect(r.status).toBe(400)
      expect(eventBus.paused).toBe(false)
    })

  it('named actions still work', async () => {
    eventBus.resume('api')
    expect((await call('POST', '/api/recording', '{"action":"pause"}')).json()).toEqual({ recording: false })
    expect((await call('POST', '/api/recording', '{"action":"toggle"}')).json()).toEqual({ recording: true })
    expect((await call('POST', '/api/recording', '{"action":"resume"}')).json()).toEqual({ recording: true })
  })
})

describe('a JSON body must be an object', () => {
  const ROUTES = ['/api/events', '/api/marker', '/api/bookmarks', '/api/loot/scan', '/api/http-verify',
    '/api/terminal/replay', '/api/sanitize', '/api/session/register', '/api/recording']

  it.each(ROUTES)('null on %s is a 400 with a fixed message, not a 500 with internals', async (route) => {
    const r = await call('POST', route, 'null')
    expect(r.status).toBe(400)
    expect(r.json()).toEqual({ error: 'JSON body must be an object' })
  })

  it.each(['[{"title":"x","agent_type":"shell","data":{}}]', '"a string"', '42'])(
    '%s stores no event, marker or bookmark', async (body) => {
      const events = getEventCount(), marks = listBookmarks().length
      for (const route of ['/api/events', '/api/marker', '/api/bookmarks']) {
        expect((await call('POST', route, body)).status, route).toBe(400)
      }
      expect(getEventCount()).toBe(events)
      expect(listBookmarks().length).toBe(marks)
    })

  it('a body nested 10 000 levels deep is a 400 on every route', async () => {
    const deep = '{"data":' + '{"a":'.repeat(10_000) + '1' + '}'.repeat(10_000) + '}'
    for (const route of ROUTES) {
      const r = await call('POST', route, deep)
      expect(r.status, route).toBe(400)
      expect(r.body).not.toContain('call stack')
    }
  })
})

describe('a 500 does not carry internal error text', () => {
  it('a throwing handler answers a generic body', async () => {
    const r = await call('POST', '/api/loot/scan', '{"text":"x"}')
    expect(lootCalls).toEqual(['x'])
    expect(r.status).toBe(500)
    expect(r.json()).toEqual({ error: 'internal error' })
    expect(r.body).not.toContain('SQLITE')
    expect(r.body).not.toContain(projectDir)
  })
})

describe('limit and time query parameters', () => {
  it.each([
    '/api/events?limit=-1', '/api/events?limit=0', '/api/events?limit=abc', '/api/events?since=abc',
    '/api/events/search?q=zz&limit=-1', '/api/anchors?limit=-1', '/api/export/har?limit=-1', '/api/export/har?before=x',
    `/api/http-body/${'a'.repeat(64)}?encoding=hex`
  ])('%s is a 400', async (url) => {
    expect((await call('GET', url)).status).toBe(400)
  })

  it('an over-large limit is clamped to the documented maximum', async () => {
    for (let i = 0; i < 3; i++) insertEvent('marker', { title: `m${i}` }, { engagementId: 'eng-1', operatorId: 'op-primary' })
    const r = await call('GET', '/api/events?limit=99999999')
    expect(r.status).toBe(200)
    expect((r.json() as { count: number }).count).toBeGreaterThan(0)
  })
})

// #695: both ran on the main thread with nothing bounding the input. A 5 MB
// loot scan stalled the app for minutes; a pasted query of thousands of terms
// ran one FTS lookup per term.
describe('input caps on main-thread work', () => {
  it('a loot scan over the cap is a 413 and is never handed to the detector', async () => {
    const before = lootCalls.length
    const r = await call('POST', '/api/loot/scan', JSON.stringify({ text: 'x'.repeat(128 * 1024 + 1) }))
    expect(r.status).toBe(413)
    expect(r.json()).toEqual({ error: 'text exceeds 131072 characters' })
    expect(lootCalls.length).toBe(before)
  })
  it('a loot scan at the cap reaches the detector', async () => {
    const before = lootCalls.length
    await call('POST', '/api/loot/scan', JSON.stringify({ text: 'x'.repeat(128 * 1024) }))
    expect(lootCalls.length).toBe(before + 1)
  })
  it('a search query over 1000 characters is a 400 naming the reason', async () => {
    const r = await call('GET', `/api/events/search?q=${encodeURIComponent('a '.repeat(500) + 'a')}`)
    expect(r.status).toBe(400)
    expect(r.json()).toMatchObject({ reason: 'too-long', token: '1000' })
    expect((await call('GET', `/api/events/search?q=${'a'.repeat(1000)}`)).status).toBe(200)
  })
})

describe('POST /api/marker text limits', () => {
  it('cuts title and notes like the app does', async () => {
    const r = await call('POST', '/api/marker', JSON.stringify({ title: 't'.repeat(1 << 20), notes: 'n'.repeat(1 << 20) }))
    expect(r.status).toBe(201)
    const data = (r.json() as { data: Record<string, string> }).data
    expect(data.title.length).toBe(200)
    expect(data.notes.length).toBe(10_000)
  })
})

describe('POST /api/terminal/replay', () => {
  // A link named as the cast itself was already refused further down (the
  // cast reader lstats each part). A linked FOLDER inside casts/ was not: the
  // name is inside, the part is a regular file, and the bytes were outside.
  it.each([['a linked cast', 'file'], ['a cast inside a linked folder', 'dir']] as const)(
    'refuses %s', async (_label, kind) => {
      const casts = path.join(projectDir, 'casts')
      fs.mkdirSync(casts, { recursive: true })
      const away = fs.mkdtempSync(path.join(FAKE_HOME, 'away-'))
      const outside = path.join(away, 'x.cast')
      fs.writeFileSync(outside, `{"version":2}\n[0.1,"o","OUTSIDE-CANARY"]\n`)
      const name = `${kind}-${path.basename(away)}`
      let castPath: string
      if (kind === 'file') { castPath = path.join(casts, `${name}.cast`); fs.symlinkSync(outside, castPath) }
      else { fs.symlinkSync(away, path.join(casts, name)); castPath = path.join(casts, name, 'x.cast') }
      const ids = { engagementId: 'eng-1', operatorId: 'op-primary' }
      const rec = `rec-${name}`
      insertEvent('shell', { subtype: 'session_start', source: 'builtin-terminal', terminalId: 't1', recordingId: rec, castPath }, ids)
      const end = insertEvent('shell', { subtype: 'command_end', source: 'builtin-terminal', terminalId: 't1', recordingId: rec, command: `id ${name}`, duration_sec: 1, io: { off: 0, len: 200 } }, ids)!
      const r = await call('POST', '/api/terminal/replay', JSON.stringify({ eventId: end.id }))
      expect(r.body).not.toContain('OUTSIDE-CANARY')
      expect(r.status).toBe(403)
    })
})
