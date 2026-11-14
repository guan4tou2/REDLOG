// The whole-artifact grep below covers the HTTP rows only; rows derived from
// them (scope_violation, loot, file_transfer, http_error text, DNS answers) are
// covered by test/scope-mask-http-fields.test.ts alone, not by this grep.
// This file runs the PREBUILT export worker (out/main/export-worker.js): after
// changing src/, run `npm run build:export-worker`, or the first test fails.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
import { initDB, closeDB, getDB } from '../src/core/db/index'
import { extractBodyToSidecar } from '../src/core/http-body-store'
import { registerDataExportIpc } from '../src/main/ipc/data-export'
import { exportHar } from '../src/core/har-export'
import { addExportEvent } from './helpers/export-fixtures'
import type { IpcContext } from '../src/main/ipc/types'

// The leak this closes: with "mask out of scope" on, an out-of-scope row's
// bodies were masked while its `params` (a login form's password), its
// headers (Authorization, Cookie), its cookie lists and its URL query went out
// in clear. Every export path is run for real — the IPC handlers and the
// export worker the app uses — and the whole artifact is searched, not chosen
// fields. Each secret is built at run time, once per host, so an in-scope
// copy of the same row shows what masking must leave untouched.

const SECRET_KINDS = ['query', 'auth', 'cookie', 'jar', 'formfield', 'json', 'bigform', 'bigbody', 'setcookie', 'location', 'respbody'] as const
type Kind = typeof SECRET_KINDS[number]
const run = crypto.randomBytes(4).toString('hex')
const secret = (kind: Kind, host: string): string => ['sv', kind, host.split('.')[0], run].join('-')

function flows(host: string): Array<[string, Record<string, unknown>]> {
  const s = (k: Kind) => secret(k, host)
  const p = host.split('.')[0]
  const form = `username=alice&password=${s('formfield')}`
  const big = { data: `${s('bigbody')}&pad=${'x'.repeat(5000)}`, encoding: 'text', size: 5030, sha256: '', truncated: false, content_type: 'application/x-www-form-urlencoded' }
  const bigRow: Record<string, unknown> = {
    subtype: 'http_request_start', flow_id: `${p}-big`, method: 'POST', url: `https://${host}/upload`, path: '/upload', host, port: 443, scheme: 'https',
    request_headers: [['Content-Type', 'application/x-www-form-urlencoded']],
    params: { body_form: { password: s('bigform'), pad: 'x' } }, request_body: big
  }
  extractBodyToSidecar(bigRow, 'request_body')
  expect(bigRow.request_body_ref, 'the fixture body went to the sidecar').toBeTruthy()
  return [
    [`${p}-login-req`, {
      subtype: 'http_request_start', flow_id: `${p}-login`, method: 'POST', url: `https://${host}/login?api_key=${s('query')}&next=&x=1&x=2`, path: '/login', host, port: 443, scheme: 'https',
      source_addr: '127.0.0.1:50000', http_version: 'HTTP/1.1',
      request_headers: [['Host', host], ['Authorization', `Bearer ${s('auth')}`], ['Cookie', `sid=${s('cookie')}`], ['Cookie', 'theme=dark'], ['Content-Type', 'application/x-www-form-urlencoded']],
      cookies: [{ name: 'sid', value: s('jar') }, { name: 'theme', value: 'dark' }],
      params: { query: { api_key: s('query'), next: '', x: ['1', '2'] }, body_form: { username: 'alice', password: s('formfield') } },
      request_body_preview: form, request_body: { data: form, encoding: 'text', size: form.length, sha256: 'a'.repeat(64), truncated: false }
    }],
    [`${p}-login-resp`, {
      subtype: 'http_response', flow_id: `${p}-login`, method: 'POST', url: `https://${host}/login?api_key=${s('query')}&next=&x=1&x=2`, status: 302, content_length: 10, content_type: 'text/html', duration_ms: 3,
      response_headers: [['Set-Cookie', `session=${s('setcookie')}; Path=/; HttpOnly`], ['Location', `https://${host}/home?code=${s('location')}`], ['X-RedLog-Truncated', '60 total, showing 50']],
      set_cookies: [{ name: 'session', value: s('setcookie'), path: '/', httponly: true }],
      response_preview: s('respbody'), response_body: { data: s('respbody'), encoding: 'text', size: 10 }
    }],
    [`${p}-json-req`, {
      subtype: 'http_request_start', flow_id: `${p}-json`, method: 'POST', url: `https://${host}/api`, path: '/api', host,
      request_headers: [['Content-Type', 'application/json']], params: { body_json: { token: s('json') } },
      request_body: { data: JSON.stringify({ token: s('json') }), encoding: 'text', size: 40 }
    }],
    [`${p}-big-req`, bigRow]
  ]
}

const outSecrets = SECRET_KINDS.map((k) => secret(k, 'out.test'))
const inSecrets = SECRET_KINDS.map((k) => secret(k, 'in.test'))
const NAMES = ['Authorization', 'Cookie', 'Set-Cookie', 'Location', 'Content-Type', 'X-RedLog-Truncated', 'api_key', '"sid"', '"session"', 'out.test', '/login', '/upload']

let dir: string
let stored: Map<string, string>
let handlers: Map<string, (_event: unknown, input?: any) => any>

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-scope-mask-paths-'))
  initDB(dir)
  fs.writeFileSync(path.join(dir, 'config.yaml'), ['engagement:', '  id: eng-1', 'scope:', '  targets:', '    - in.test', '  excludeTargets: []', '  personalDomains: []'].join('\n'))
  const project = { id: 'eng-1', name: 'scope-mask', path: dir, createdAt: 1, lastOpened: 1 }
  handlers = new Map()
  registerDataExportIpc({ handle: (name: string, fn: any) => handlers.set(name, fn) } as never,
    { getActiveProject: () => project, getMainWindow: () => null, getCurrentEngagementId: () => project.id } as IpcContext)
  let t = 1000
  for (const host of ['in.test', 'out.test']) {
    for (const [id, data] of flows(host)) {
      const { subtype, ...rest } = data
      addExportEvent('events_logged', id, t++, { agentType: 'scanner', subtype: subtype as string, targetId: host, data: rest })
    }
  }
  stored = new Map((getDB().prepare('SELECT id, data FROM events_logged').all() as Array<{ id: string; data: string }>).map((r) => [r.id, r.data]))
})
afterAll(() => { closeDB(); fs.rmSync(dir, { recursive: true, force: true }) })

async function exportText(request: Record<string, unknown>): Promise<string> {
  const resolved = await handlers.get('data:resolveExportPlan')!({}, request)
  expect(resolved.ok, JSON.stringify(resolved)).toBe(true)
  const executed = await handlers.get('data:executeExportPlan')!({}, { planId: resolved.plan.id })
  expect(executed.ok, JSON.stringify(executed)).toBe(true)
  return fs.readFileSync(executed.artifactPath, 'utf8')
}

function exportedRows(format: string, text: string): Array<{ id: string; data: Record<string, unknown> }> {
  if (format === 'ndjson') return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return JSON.parse(text).events
}

function expectNoOutOfScopeSecret(text: string): void {
  for (const s of outSecrets) expect(text, `${s} left the machine`).not.toContain(s)
  for (const name of NAMES) expect(text, `${name} should still be named`).toContain(name)
}

describe.each(['json', 'ndjson', 'timeline'])('%s export', (format) => {
  it('with masking on carries no out-of-scope header, cookie, parameter or query value', async () => {
    const text = await exportText({ format, maskOutOfScope: true })
    expectNoOutOfScopeSecret(text)
    for (const s of inSecrets.filter((x) => !x.includes('-bigbody-'))) expect(text).toContain(s)
    const login = exportedRows(format, text).find((e) => e.id === 'out-login-req')!.data
    expect(login.params).toBe('[redacted: out of scope]')
    expect((login.request_headers as string[][]).map(([n]) => n)).toEqual(['Host', 'Authorization', 'Cookie', 'Cookie', 'Content-Type'])
    // `next=` has no value: a query piece with no value is masked whole, alone or among others.
    expect(login.url).toBe(`https://out.test/login?api_key=${encodeURIComponent('[redacted: out of scope]')}&${encodeURIComponent('[redacted: out of scope]')}&x=${encodeURIComponent('[redacted: out of scope]')}&x=${encodeURIComponent('[redacted: out of scope]')}`)
    expect(login.host).toBe('out.test')
    expect(login.path).toBe('/login')
  })

  it('leaves every in-scope row exactly as recorded, and every row with masking off', async () => {
    const masked = exportedRows(format, await exportText({ format, maskOutOfScope: true }))
    const plain = exportedRows(format, await exportText({ format, maskOutOfScope: false }))
    expect(plain).toHaveLength(stored.size)
    for (const e of plain) expect(JSON.stringify(e.data), e.id).toBe(stored.get(e.id))
    const inScope = masked.filter((e) => e.id.startsWith('in-'))
    expect(inScope).toHaveLength(4)
    for (const e of inScope) expect(JSON.stringify(e.data), e.id).toBe(stored.get(e.id))
  })
})

describe('HAR export', () => {
  it('masks an out-of-scope entry\'s header, cookie and query values, keeps names, and stays valid HAR', async () => {
    const text = await exportText({ format: 'har' })
    expectNoOutOfScopeSecret(text)
    const M = '[redacted: out of scope]'
    const entries = JSON.parse(text).log.entries as Array<Record<string, any>>
    expect(entries).toHaveLength(6)
    for (const entry of entries) {
      for (const side of [entry.request, entry.response]) {
        expect(typeof side.httpVersion).toBe('string')
        for (const list of [side.headers, side.cookies, side.queryString ?? []]) {
          expect(Array.isArray(list)).toBe(true)
          for (const pair of list) { expect(typeof pair.name).toBe('string'); expect(typeof pair.value).toBe('string') }
        }
      }
      expect(typeof entry.request.url).toBe('string')
      expect(typeof entry.request.method).toBe('string')
      expect(typeof entry.response.status).toBe('number')
      expect(typeof entry.response.redirectURL).toBe('string')
      expect(typeof entry.response.content.mimeType).toBe('string')
      expect(entry.timings).toBeTruthy()
    }
    const login = entries.find((e) => e._redlog.flowId === 'out-login')!
    expect(login.request.url.startsWith('https://out.test/login?')).toBe(true)
    expect(login.request.headers).toEqual(['Host', 'Authorization', 'Cookie', 'Cookie', 'Content-Type'].map((name) => ({ name, value: M })))
    expect(login.request.cookies).toEqual([{ name: 'sid', value: M }, { name: 'theme', value: M }])
    // A query piece with no value is masked whole, alone or among others, so `next=` reads back as the marker's name.
    expect(login.request.queryString).toEqual([{ name: 'api_key', value: M }, { name: M, value: '' }, { name: 'x', value: M }, { name: 'x', value: M }])
    expect(login.request.postData).toBeUndefined()
    expect(login.response.headers).toEqual([{ name: 'Set-Cookie', value: M }, { name: 'Location', value: M }, { name: 'X-RedLog-Truncated', value: '60 total, showing 50' }])
    expect(login.response.cookies).toEqual([{ name: 'session', value: M, path: '/', httpOnly: true }])
    expect(login.response.content.text).toBeUndefined()
    const big = entries.find((e) => e._redlog.flowId === 'out-big')!
    expect(big.request.postData).toBeUndefined()
  })

  it('masks a HAR whose request turned masking off, and its plan and manifest say so', async () => {
    const resolved = await handlers.get('data:resolveExportPlan')!({}, { format: 'har', maskOutOfScope: false })
    expect(resolved.ok, JSON.stringify(resolved)).toBe(true)
    expect(resolved.plan.request.maskOutOfScope).toBe(true)
    const executed = await handlers.get('data:executeExportPlan')!({}, { planId: resolved.plan.id })
    expect(executed.ok, JSON.stringify(executed)).toBe(true)
    expectNoOutOfScopeSecret(fs.readFileSync(executed.artifactPath, 'utf8'))
    expect(executed.artifactPath.endsWith('.har')).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(`${executed.artifactPath}.manifest.json`, 'utf8'))
    expect(manifest.exportPlan.request.maskOutOfScope).toBe(true)
    expect(manifest.exportPlan.id).toBe(resolved.plan.id)
  })

  it('leaves an in-scope entry as it exports without a scope', () => {
    const scoped = JSON.parse(exportHar({ scope: { targets: ['in.test'], excludeTargets: [] } })).log.entries as Array<Record<string, any>>
    const unscoped = JSON.parse(exportHar()).log.entries as Array<Record<string, any>>
    const pick = (list: Array<Record<string, any>>) => list.filter((e) => e._redlog.flowId.startsWith('in-'))
    expect(pick(scoped)).toHaveLength(3)
    expect(JSON.stringify(pick(scoped))).toBe(JSON.stringify(pick(unscoped)))
    expect(JSON.stringify(pick(scoped))).toContain(secret('bigbody', 'in.test'))
  })
})
