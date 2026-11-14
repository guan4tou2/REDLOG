// A bundle exported with "mask out of scope" on: no out-of-scope header,
// cookie, parameter, query or page value in any file it carries, and both
// verifiers — tools/redlog-verify.py, which a recipient runs, and the app's
// verifyBundleDir — still accept it. A masked row is a transformed row: its
// id is listed in manifest.evidence.transformedEventIds, its original hash is
// kept, and the verifiers check the rows around it, as for a masked body.
//
// Keys are generated at run time into a temporary directory; nothing here is a
// real credential. Secrets are assembled at run time for the same reason.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initDB, closeDB, bindDBEngagement, getDB } from '../src/core/db/index'
import * as events from '../src/core/db/events'
import * as ops from '../src/core/db/operators'
import { exportBundle } from '../src/core/bundle-export'
import { verifyBundleDir } from '../src/core/bundle-verify'
import { VERIFY_EXIT, type VerifyCategory } from '../src/core/evidence-rules'

const VERIFIER = path.resolve(__dirname, '..', 'tools', 'redlog-verify.py')
const python = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0) ?? null
const hasCryptography = python
  ? spawnSync(python, ['-I', '-c', 'import cryptography.hazmat.primitives.asymmetric.ed25519']).status === 0
  : false
const CATEGORY_BY_EXIT = Object.fromEntries(Object.entries(VERIFY_EXIT).map(([k, v]) => [v, k])) as Record<number, VerifyCategory>

const run = crypto.randomBytes(4).toString('hex')
const secret = (kind: string, host: string): string => ['sv', kind, host.split('.')[0], run].join('-')
const KINDS = ['query', 'auth', 'cookie', 'jar', 'password', 'setcookie', 'location', 'title', 'navq', 'console'] as const
const M = '[redacted: out of scope]'

let root = ''
let bundle = ''
const keysEnv = process.env.REDLOG_KEYS_DIR
const ids: Record<string, string> = {}

function record(host: string): void {
  const s = (k: typeof KINDS[number]) => secret(k, host)
  const p = host.split('.')[0]
  const ins = (type: string, data: Record<string, unknown>) => events.insertEvent(type, data, { operatorId: 'mask-op', targetId: host })!
  ids[`${p}-req`] = ins('scanner', {
    subtype: 'http_request_start', flow_id: `${p}-f`, method: 'POST', url: `https://${host}/login?api_key=${s('query')}`, path: '/login', host,
    request_headers: [['Authorization', `Bearer ${s('auth')}`], ['Cookie', `sid=${s('cookie')}`]],
    cookies: [{ name: 'sid', value: s('jar') }], params: { body_form: { username: 'alice', password: s('password') } }
  }).id
  ids[`${p}-resp`] = ins('scanner', {
    subtype: 'http_response', flow_id: `${p}-f`, method: 'POST', url: `https://${host}/login?api_key=${s('query')}`, status: 302,
    response_headers: [['Set-Cookie', `session=${s('setcookie')}`], ['Location', `https://${host}/home?code=${s('location')}`]],
    set_cookies: [{ name: 'session', value: s('setcookie'), path: '/' }]
  }).id
  // Chained rows, so events.jsonl carries masked rows too.
  ids[`${p}-nav`] = ins('http_navigation', { subtype: 'navigation', url: `https://${host}/search?q=${s('navq')}`, prev_url: null, title: s('title'), host, tab_id: 't', description: `→ ${host}` }).id
  ids[`${p}-console`] = ins('browser', { subtype: 'console_error', level: 'error', url: `https://${host}/`, host, tab_id: 't', message: s('console') }).id
}

function readAll(dir: string): string {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => fs.readFileSync(path.join(d.parentPath, d.name), 'latin1')).join('\n')
}
const rows = (file: string): Array<Record<string, any>> => fs.readFileSync(path.join(bundle, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-scope-mask-bundle-'))
  process.env.REDLOG_KEYS_DIR = path.join(root, 'keys')
  const dir = path.join(root, 'project')
  fs.mkdirSync(dir, { recursive: true })
  initDB(dir); bindDBEngagement('default')
  ops.createOperator({ id: 'mask-op', name: 'mask-op', token: ops.generateToken(), isPrimary: true })
  events.insertEvent('shell', { subtype: 'command_start', command: 'id' }, { operatorId: 'mask-op' })
  record('in.test')
  record('out.test')
  bundle = exportBundle('default', { outRoot: path.join(root, 'out'), scope: { targets: ['in.test'], excludeTargets: [] }, maskOutOfScope: true }).outDir
}, 60_000)
afterAll(() => {
  closeDB()
  if (keysEnv === undefined) delete process.env.REDLOG_KEYS_DIR
  else process.env.REDLOG_KEYS_DIR = keysEnv
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a scope-masked bundle', () => {
  it('carries no out-of-scope value in any file, and keeps the names and hosts', () => {
    const all = readAll(bundle)
    for (const k of KINDS) {
      expect(all, `${k} left the machine`).not.toContain(secret(k, 'out.test'))
      expect(all, `${k} in scope is untouched`).toContain(secret(k, 'in.test'))
    }
    const logged = rows('events_logged.jsonl')
    const req = JSON.parse(logged.find((r) => r.id === ids['out-req'])!.data)
    expect(req.params).toBe(M)
    expect(req.request_headers).toEqual([['Authorization', M], ['Cookie', M]])
    expect(req.cookies).toEqual([{ name: 'sid', value: M }])
    expect(req.url).toBe(`https://out.test/login?api_key=${encodeURIComponent(M)}`)
    expect(req.host).toBe('out.test')
    const resp = JSON.parse(logged.find((r) => r.id === ids['out-resp'])!.data)
    expect(resp.response_headers).toEqual([['Set-Cookie', M], ['Location', M]])
    expect(resp.set_cookies).toEqual([{ name: 'session', value: M, path: '/' }])
    const chained = rows('events.jsonl')
    const nav = JSON.parse(chained.find((r) => r.id === ids['out-nav'])!.data)
    expect(nav).toMatchObject({ title: M, url: `https://out.test/search?q=${encodeURIComponent(M)}`, host: 'out.test', description: '→ out.test' })
    expect(JSON.parse(chained.find((r) => r.id === ids['out-console'])!.data).message).toBe(M)
  })

  it('declares the masked rows transformed and leaves the in-scope rows as stored', () => {
    const m = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'))
    expect(m.evidence.kind).toBe('projection')
    for (const key of ['out-req', 'out-resp', 'out-nav', 'out-console']) expect(m.evidence.transformedEventIds).toContain(ids[key])
    for (const key of ['in-req', 'in-resp', 'in-nav', 'in-console']) expect(m.evidence.transformedEventIds).not.toContain(ids[key])
    const db = getDB()
    const storedData = (id: string): string => ((db.prepare('SELECT data FROM events WHERE id = ?').get(id) ?? db.prepare('SELECT data FROM events_logged WHERE id = ?').get(id)) as { data: string }).data
    const delivered = [...rows('events.jsonl'), ...rows('events_logged.jsonl')]
    for (const key of ['in-req', 'in-resp', 'in-nav', 'in-console']) expect(delivered.find((r) => r.id === ids[key])!.data).toBe(storedData(ids[key]))
  })

  it('is accepted by both verifiers', { timeout: 30_000 }, () => {
    // Without `cryptography` the Python side cannot check a signature, so both
    // sides judge the chain alone, as test/evidence-vectors.test.ts does.
    const ts = verifyBundleDir(bundle, { hashOnly: python !== null && !hasCryptography })
    expect(ts.category, ts.problems.join('\n')).toBe('verified')
    expect(ts.seal).toBe('sealed')
    if (python) {
      const r = spawnSync(python, ['-I', VERIFIER, ...(hasCryptography ? [] : ['--hash-only']), bundle], { encoding: 'utf8' })
      expect(CATEGORY_BY_EXIT[r.status ?? -1], r.stdout + r.stderr).toBe(ts.category)
      expect(r.stdout).toMatch(/Seal\s+: SEALED/)
    }
  })
})
