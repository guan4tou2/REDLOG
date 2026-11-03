import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// GET /api/http-body/<sha> must answer to scope the way GET /api/export/har
// does: a token holder cannot read an out-of-scope body by asking for its hash,
// which the events they can already list carry.
//
// Same shape as api-server.test.ts: its own HOME before the dynamic import,
// real HTTP against a live server over a temp project.
let initDB: typeof import('../src/core/db/index').initDB
let closeDB: typeof import('../src/core/db/index').closeDB
let api: typeof import('../src/core/api-server')
let ingest: typeof import('../src/core/ingest').ingest
let dbAvailable = false

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bodyscope-home-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME

try {
  initDB = (await import('../src/core/db/index')).initDB
  closeDB = (await import('../src/core/db/index')).closeDB
  api = await import('../src/core/api-server')
  ingest = (await import('../src/core/ingest')).ingest
  dbAvailable = true
} catch {
  // native module unavailable — skip
}

const describeDB = dbAvailable ? describe : describe.skip

const IN_SCOPE = 'in.scope-test.example'
const OUT_OF_SCOPE = 'out.other-test.example'

describeDB('GET /api/http-body/<sha> scope', () => {
  let tmpDir: string
  let base: string
  let headers: Record<string, string>
  let targets: string[] = []
  let flow = 0

  /** Store one HTTP response with a body large enough to leave the event. */
  function storeBody(text: string, targetId: string | undefined, withPreview = true): string {
    const body = text.padEnd(5000, '.')
    const { event } = ingest({
      agentType: 'scanner',
      data: {
        subtype: 'http_response',
        flow_id: `flow-${++flow}`,
        response_body: { data: body, encoding: 'text', size: body.length, sha256: '' },
        ...(withPreview ? { response_preview: body.slice(0, 64) } : {})
      },
      engagementId: 'eng-1',
      operatorId: 'op-primary',
      ...(targetId ? { targetId } : {})
    })
    const ref = event?.data.response_body_ref as { sha256: string; file: string } | undefined
    if (!ref) throw new Error('the body did not reach the body store')
    return ref.sha256
  }

  const get = (sha: string) => fetch(`${base}/api/http-body/${sha}`, { headers })

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-bodyscope-'))
    initDB(tmpDir)
    api.configureApi({
      engagementId: 'eng-1', operatorId: 'op-primary', operatorName: 'Primary',
      configLoader: { getConfig: () => ({}), getTargets: () => targets }
    })
    const port = await api.startApiServer(0)
    api.onApiProjectOpen()
    base = `http://127.0.0.1:${port}`
    headers = { Authorization: `Bearer ${api.getApiToken()}` }
  })

  afterAll(async () => {
    api.stopApiServer()
    ;(await import('../src/core/http-body-index')).closeHttpBodyIndex()
    closeDB()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  })

  it('serves a body that an in-scope event references', async () => {
    targets = [IN_SCOPE]
    const sha = storeBody('in-scope-only body', IN_SCOPE)
    const res = await get(sha)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: string }).data).toContain('in-scope-only body')
  })

  it('answers 404 for a body that only out-of-scope events reference', async () => {
    targets = [IN_SCOPE]
    const sha = storeBody('out-of-scope-only body', OUT_OF_SCOPE)
    const res = await get(sha)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'body not found' })
  })

  it('serves a body that both an in-scope and an out-of-scope event reference', async () => {
    targets = [IN_SCOPE]
    const sha = storeBody('shared body', OUT_OF_SCOPE)
    expect(storeBody('shared body', IN_SCOPE)).toBe(sha)
    expect((await get(sha)).status).toBe(200)
  })

  it('answers 404 for a body whose only event has no target once targets are configured', async () => {
    targets = [IN_SCOPE]
    const sha = storeBody('untargeted body', undefined)
    expect((await get(sha)).status).toBe(404)
  })

  // The export masks a body through its preview field's reference; an event
  // stored without one is not masked by it, so the route checks the target
  // itself.
  it('answers 404 for an out-of-scope or untargeted body that has no preview field', async () => {
    targets = [IN_SCOPE]
    expect((await get(storeBody('bare out-of-scope body', OUT_OF_SCOPE, false))).status).toBe(404)
    expect((await get(storeBody('bare untargeted body', undefined, false))).status).toBe(404)
    expect((await get(storeBody('bare in-scope body', IN_SCOPE, false))).status).toBe(200)
  })

  it('serves every body when no targets are configured, as the HAR export does', async () => {
    targets = []
    const outside = storeBody('no-scope body for another host', OUT_OF_SCOPE)
    const untargeted = storeBody('no-scope untargeted body', undefined)
    expect((await get(outside)).status).toBe(200)
    expect((await get(untargeted)).status).toBe(200)
  })

  it('refuses out-of-scope and missing bodies with the same response', async () => {
    targets = [IN_SCOPE]
    const hidden = await get(storeBody('hidden body', OUT_OF_SCOPE))
    const missing = await get('0'.repeat(64))
    expect(hidden.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await hidden.text()).toBe(await missing.text())
  })

  it('follows the scope as it changes, with no cached answer', async () => {
    targets = [IN_SCOPE]
    const sha = storeBody('scope moves body', OUT_OF_SCOPE)
    expect((await get(sha)).status).toBe(404)
    targets = [OUT_OF_SCOPE]
    expect((await get(sha)).status).toBe(200)
  })
})
