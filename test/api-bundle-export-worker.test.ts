import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// #695: POST /api/export/bundle used to digest the logged tier, chain the
// digest event and dump both tiers on the main thread. With a bundle exporter
// configured, the scans run in the export worker (out/main/export-worker.js,
// built by `npm run build:export-worker`) and main only inserts the digest.
// Same no-socket harness as api-route-guards.test.ts.

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apibundle-'))
process.env.HOME = FAKE_HOME
process.env.USERPROFILE = FAKE_HOME
process.env.REDLOG_KEYS_DIR = path.join(FAKE_HOME, 'keys')

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
let handler: Handler | null = null
vi.spyOn(http, 'createServer').mockImplementation(((h: Handler) => {
  handler = h
  return { listen: (_p: number, _h: string, cb: () => void) => { cb() }, address: () => ({ port: 6660 }), on: () => {}, close: () => {} }
}) as never)

// Pass-through spies: they count calls made in THIS thread only. The worker
// runs its own bundled copy of these modules.
vi.mock('../src/core/db/events', async (original) => {
  const m = await original<typeof import('../src/core/db/events')>()
  return { ...m, loggedTierDigest: vi.fn(m.loggedTierDigest) }
})
vi.mock('../src/core/bundle-export', async (original) => {
  const m = await original<typeof import('../src/core/bundle-export')>()
  return { ...m, exportBundle: vi.fn(m.exportBundle) }
})

const { initDB, closeDB, getDB } = await import('../src/core/db/index')
const events = await import('../src/core/db/events')
const bundleExport = await import('../src/core/bundle-export')
const ops = await import('../src/core/db/operators')
const api = await import('../src/core/api-server')
const { createDirectBundleExporter } = await import('../src/core/export-direct-bundle')
const { runExportTask } = await import('../src/main/services/export-runner')
type Task = Parameters<typeof runExportTask>[0]

let dir = ''
let token = ''
const project = () => ({ id: 'p', name: 'bundle', path: dir, createdAt: 1, lastOpened: 1 })

function call(method: string, url: string): Promise<{ status: number; json: () => Record<string, unknown> }> {
  const req = Readable.from([]) as unknown as http.IncomingMessage
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:6660', authorization: `Bearer ${token}` }, socket: { remoteAddress: '127.0.0.1' } })
  return new Promise((resolve) => {
    let status = 200
    const res = {
      headersSent: false, setHeader: () => {},
      writeHead(s: number) { status = s; this.headersSent = true; return this },
      end(data?: string | Buffer) { const text = String(data ?? ''); resolve({ status, json: () => JSON.parse(text) }) }
    } as unknown as http.ServerResponse
    handler!(req, res)
  })
}
function logged(id: string): void {
  getDB().prepare(`INSERT INTO events_logged (id,timestamp,engagement_id,session_id,operator_id,agent_type,subtype,hostname,data,created_at)
    VALUES (?,?,'eng','s','op-primary','scanner','http_request_start','host',?,?)`).run(id, Date.now(), JSON.stringify({ subtype: 'http_request_start', url: `http://example.test/${id}` }), Date.now())
}
function chained(command: string): string {
  return events.insertEvent('shell', { subtype: 'command_start', command }, { engagementId: 'eng', operatorId: 'op-primary' })!.id
}
function lines(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
}
function digestEvents(outDir: string): Array<{ count: number; sha256: string }> {
  return lines(path.join(outDir, 'events.jsonl')).map(r => JSON.parse(r.data as string) as { subtype: string; count: number; sha256: string })
    .filter(d => d.subtype === 'logged_tier_digest')
}
const python = ['python3', 'python'].find(bin => spawnSync(bin, ['--version']).status === 0)

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-apibundle-db-'))
  initDB(dir)
  ops.createOperator({ id: 'op-primary', name: 'Primary', token: ops.generateToken(), isPrimary: true })
  for (let i = 0; i < 4; i++) chained(`echo ${i}`)
  for (let i = 0; i < 5; i++) logged(`logged-${i}`)
  getDB().pragma('wal_checkpoint(TRUNCATE)')
  api.configureApi({ engagementId: 'eng', operatorId: 'op-primary', operatorName: 'Primary' })
  await api.startApiServer(0)
  api.onApiProjectOpen()
  token = api.getApiToken()
})
afterAll(() => {
  api.stopApiServer()
  closeDB()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
})

describe('POST /api/export/bundle', () => {
  // Runs first: configureApi can set the exporter but not clear it.
  it('without an exporter builds the bundle in-process, as before', async () => {
    const r = await call('POST', '/api/export/bundle')
    expect(r.status).toBe(201)
    expect(bundleExport.exportBundle).toHaveBeenCalledTimes(1)
    expect(events.loggedTierDigest).toHaveBeenCalledTimes(1)
    expect(digestEvents(r.json().outDir as string)).toHaveLength(1)
  })

  it('with an exporter, scans in the worker, inserts the digest here, and stays inside both boundaries', async () => {
    vi.mocked(bundleExport.exportBundle).mockClear(); vi.mocked(events.loggedTierDigest).mockClear()
    const before = { logged: (getDB().prepare('SELECT count(*) AS n FROM events_logged').get() as { n: number }).n }
    let midChained = '', lateChained = ''
    // Rows written between the stages, the way capture would.
    const run = async (task: Task, allowed?: (completed?: boolean) => boolean) => {
      if (task.kind === 'logged-digest') logged('before-digest-task')
      if (task.kind === 'direct-bundle') { logged('before-bundle-task'); lateChained = chained('late') }
      const result = await runExportTask(task, allowed)
      if (task.kind === 'logged-digest') { logged('after-digest-task'); midChained = chained('mid') }
      return result
    }
    api.configureApi({ engagementId: 'eng', operatorId: 'op-primary', bundleExporter: createDirectBundleExporter(run, project) })

    const r = await call('POST', '/api/export/bundle')
    expect(r.status).toBe(201)
    const { outDir, manifest } = r.json() as { outDir: string; manifest: { tiers: { chained: number; logged: number; loggedDigest: { count: number; sha256: string } }; chainHead: { eventCount: number }; evidence: { kind: string } } }
    // Nothing heavy ran on this thread.
    expect(bundleExport.exportBundle).not.toHaveBeenCalled()
    expect(events.loggedTierDigest).not.toHaveBeenCalled()

    // Same name and shape as the in-process bundle.
    expect(path.basename(outDir)).toMatch(/^bundle-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(-\d+)?$/)
    expect(path.dirname(outDir)).toBe(path.join(dir, 'exports'))
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'))).toEqual(manifest)
    expect(fs.readdirSync(path.join(dir, 'exports')).filter(n => n.startsWith('.redlog-export-'))).toEqual([])

    // The digest is of the logged tier as it was when the request arrived.
    const loggedIds = lines(path.join(outDir, 'events_logged.jsonl')).map(r => r.id)
    expect(loggedIds).toHaveLength(before.logged)
    for (const id of ['before-digest-task', 'after-digest-task', 'before-bundle-task']) expect(loggedIds).not.toContain(id)
    expect(manifest.tiers.loggedDigest.count).toBe(before.logged)
    const boundedRowId = (getDB().prepare("SELECT rowid AS r FROM events_logged WHERE id='before-digest-task'").get() as { r: number }).r - 1
    expect(events.loggedTierDigest(boundedRowId)).toMatchObject(manifest.tiers.loggedDigest)

    // The chained digest event is inside the bundle and is the manifest's.
    const ids = lines(path.join(outDir, 'events.jsonl')).map(r => r.id)
    const digests = digestEvents(outDir)
    expect(digests.at(-1)).toMatchObject(manifest.tiers.loggedDigest)
    // Written before the digest event: in. Written after it: out.
    expect(ids).toContain(midChained)
    expect(ids).not.toContain(lateChained)
    expect(manifest.tiers.chained).toBe(ids.length)
    // The last line is the seal main inserted at the worker's request, after
    // `late`; the head describes the delivered chain before it.
    const sealRow = lines(path.join(outDir, 'events.jsonl')).at(-1)!
    expect(JSON.parse(sealRow.data as string).subtype).toBe('export_sealed')
    expect((getDB().prepare('SELECT rowid AS r FROM events WHERE id=?').get(sealRow.id) as { r: number }).r)
      .toBeGreaterThan((getDB().prepare('SELECT rowid AS r FROM events WHERE id=?').get(lateChained) as { r: number }).r)
    expect(manifest.chainHead.eventCount).toBe(ids.length - 1)
    expect(manifest.tiers.logged).toBe(before.logged)
    expect(manifest.evidence.kind).toBe('complete-chain')

    if (python) {
      const v = spawnSync(python, [path.resolve('tools/redlog-verify.py'), '--hash-only', outDir], { encoding: 'utf8' })
      expect(v.status, v.stdout + v.stderr).toBe(0)
    }
  }, 60_000)

  it('serialises concurrent requests so a bundle carries only digests chained before it', async () => {
    const order: string[] = []
    let first = true
    const run = async (task: Task, allowed?: (completed?: boolean) => boolean) => {
      const label = task.kind === 'logged-digest' ? (first ? 'A' : 'B') : ''
      if (task.kind === 'logged-digest') first = false
      order.push(`${task.kind}${label}`)
      // A's digest is slow: without the queue B's digest event lands first,
      // inside A's boundary.
      if (label === 'A') await new Promise(resolve => setTimeout(resolve, 300))
      return runExportTask(task, allowed)
    }
    api.configureApi({ engagementId: 'eng', operatorId: 'op-primary', bundleExporter: createDirectBundleExporter(run, project) })
    const before = new Set(fs.readdirSync(path.join(dir, 'exports')))
    const [a, b] = await Promise.all([call('POST', '/api/export/bundle'), call('POST', '/api/export/bundle')])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(order).toEqual(['logged-digestA', 'direct-bundle', 'logged-digestB', 'direct-bundle'])
    const outA = a.json().outDir as string, outB = b.json().outDir as string
    expect(outA).not.toBe(outB)
    expect(fs.readdirSync(path.join(dir, 'exports')).filter(n => !before.has(n))).toHaveLength(2)
    const priorDigests = 2 // one from each earlier test
    expect(digestEvents(outA)).toHaveLength(priorDigests + 1)
    expect(digestEvents(outB)).toHaveLength(priorDigests + 2)
    for (const r of [a, b]) {
      const manifest = r.json().manifest as { tiers: { loggedDigest: unknown } }
      expect(digestEvents(r.json().outDir as string).at(-1)).toMatchObject(manifest.tiers.loggedDigest as object)
    }
  }, 60_000)

  it('a failing stage answers the generic 500, with the stack only in console.error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    api.configureApi({ engagementId: 'eng', operatorId: 'op-primary', bundleExporter: createDirectBundleExporter(async () => { throw new Error(`boom in ${dir}`) }, project) })
    const r = await call('POST', '/api/export/bundle')
    expect(r.status).toBe(500)
    expect(r.json()).toEqual({ error: 'export failed' })
    expect(error.mock.calls.some(c => String(c[1]).includes('boom in'))).toBe(true)
    error.mockRestore()
  })
})
