import crypto from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { scopeMaskReplacements } from '../src/core/scope-sanitize'

// The fields an out-of-scope HTTP-family row carries besides its bodies:
// headers, cookies, the addon's parsed `params`, the URL's query. Names and
// metadata stay; every value the target or the tool sent is the marker.
// Secrets are assembled at run time so no literal reads as a credential.

const M = '[redacted: out of scope]'
const ENC = encodeURIComponent(M)
const U = '[redacted: no target — scope unclassified]'
const secret = (label: string): string => [label, 'x', crypto.randomBytes(6).toString('hex')].join('-')
const scope = { targets: ['in.test'], excludeTargets: [] }
const mask = (data: Record<string, unknown>, target: string | null = 'out.test') => scopeMaskReplacements(data, target, scope)
const applied = (data: Record<string, unknown>, target: string | null = 'out.test'): Record<string, unknown> => ({ ...data, ...(mask(data, target) ?? {}) })

describe('headers', () => {
  it('keeps every name in order, duplicates included, and masks every value', () => {
    const a = secret('auth'), c1 = secret('c1'), c2 = secret('c2')
    const out = applied({ subtype: 'http_request_start', request_headers: [['Host', 'out.test'], ['Authorization', `Bearer ${a}`], ['Cookie', c1], ['Cookie', c2]] })
    expect(out.request_headers).toEqual([['Host', M], ['Authorization', M], ['Cookie', M], ['Cookie', M]])
    expect(JSON.stringify(out)).not.toMatch(new RegExp(`${a}|${c1}|${c2}`))
  })

  it("keeps the addon's own truncation entry, but only as the last entry in its own wording", () => {
    const s = secret('t')
    const headers = [['X-RedLog-Truncated', s], ['Location', `https://in.test/?k=${s}`], ['X-RedLog-Truncated', '120 total, showing 100']]
    expect(applied({ response_headers: headers }).response_headers).toEqual([['X-RedLog-Truncated', M], ['Location', M], ['X-RedLog-Truncated', '120 total, showing 100']])
  })

  it('masks an unknown shape whole: an object, a malformed entry', () => {
    const s = secret('h')
    expect(applied({ request_headers: { Authorization: s } }).request_headers).toBe(M)
    expect(applied({ request_headers: [['Accept', '*/*'], { name: 'X-Key', value: s }] }).request_headers).toBe(M)
    expect(applied({ request_headers: [['A', 'b', s]] }).request_headers).toBe(M)
    expect(applied({ response_headers: s }).response_headers).toBe(M)
  })
})

describe('cookies', () => {
  it('keeps request cookie names, masks their values', () => {
    const s = secret('sid')
    expect(applied({ cookies: [{ name: 'sid', value: s }, { name: 'theme', value: 'dark' }] }).cookies)
      .toEqual([{ name: 'sid', value: M }, { name: 'theme', value: M }])
  })

  it('keeps Set-Cookie names and attributes, masks the value and any key it does not know', () => {
    const s = secret('set')
    expect(applied({ set_cookies: [{ name: 'session', value: s, path: '/', domain: 'out.test', expires: 'x', max_age: '60', secure: true, httponly: true, samesite: 'lax', extra: s }] }).set_cookies)
      .toEqual([{ name: 'session', value: M, path: '/', domain: 'out.test', expires: 'x', max_age: '60', secure: true, httponly: true, samesite: 'lax', extra: M }])
  })

  it('masks an unknown cookie shape whole', () => {
    expect(applied({ cookies: { sid: secret('o') } }).cookies).toBe(M)
    expect(applied({ set_cookies: [{ value: secret('n') }] }).set_cookies).toBe(M)
    expect(applied({ cookies: ['sid=' + secret('s')] }).cookies).toBe(M)
  })
})

describe('params', () => {
  it('replaces the whole parsed copy: query, form, JSON, multipart, raw', () => {
    const s = secret('p')
    for (const params of [{ query: { k: s } }, { body_form: { username: 'alice', password: s } }, { body_json: { token: s } }, { body_multipart: { f: s } }, { body_raw: s }]) {
      expect(applied({ params }).params).toBe(M)
    }
  })
})

describe('url', () => {
  const url = (u: string, field = 'url'): unknown => applied({ subtype: 'http_request_start', [field]: u })[field]

  it('keeps scheme, host and path; masks each query value; keeps names, repeats and empty values', () => {
    const s = secret('q')
    expect(url(`https://out.test/a/b?api_key=${s}&x=1&x=2&empty=&&flag`)).toBe(`https://out.test/a/b?api_key=${ENC}&x=${ENC}&x=${ENC}&empty=&&${ENC}`)
    expect(new URL(String(url(`https://out.test/?api_key=${s}`))).searchParams.get('api_key')).toBe(M)
  })

  it('drops a fragment, including a hash route that carries a query', () => {
    const s = secret('f')
    expect(url(`https://out.test/app#access_token=${s}`)).toBe('https://out.test/app')
    expect(url(`https://out.test/#/cb?code=${s}`)).toBe('https://out.test/')
    expect(url(`https://out.test/p?a=1#${s}`)).toBe(`https://out.test/p?a=${ENC}`)
  })

  it('masks userinfo and path parameters', () => {
    const s = secret('u')
    expect(url(`https://admin:${s}@out.test/x`)).toBe(`https://${ENC}@out.test/x`)
    expect(url(`https://out.test/app;jsessionid=${s}/next`)).toBe(`https://out.test/app;jsessionid=${ENC}/next`)
  })

  it('masks everything after the first ? of a URL that does not parse', () => {
    const s = secret('bad')
    expect(url(`https://out test/x?name=${s}`)).toBe(`https://out test/x?${ENC}`)
    expect(url(`http://[::1/x?name=${s}`)).toBe(`http://[::1/x?${ENC}`)
  })

  it('treats a data: or javascript: URL as all content', () => {
    expect(url(`data:text/html,${secret('d')}`)).toBe(M)
    expect(url(`javascript:alert('${secret('j')}')`)).toBe(M)
  })

  it('masks path, pretty_url and prev_url the same way, and leaves a URL with nothing to mask alone', () => {
    const s = secret('o')
    expect(url(`/login?next=${s}`, 'path')).toBe(`/login?next=${ENC}`)
    expect(url(`https://out.test/?t=${s}`, 'pretty_url')).toBe(`https://out.test/?t=${ENC}`)
    expect(url(`https://out.test/?t=${s}`, 'prev_url')).toBe(`https://out.test/?t=${ENC}`)
    expect(mask({ subtype: 'http_request_start', url: 'https://out.test/plain', path: '/plain', host: 'out.test' })).toBeNull()
  })

  it('does not rewrite a file row\'s path', () => {
    expect(mask({ subtype: 'file_changed', path: '/tmp/notes#1;v=2.txt' })).toBeNull()
  })
})

describe('the rest of an HTTP-family row', () => {
  it('keeps metadata exactly', () => {
    const meta = { subtype: 'http_response', flow_id: 'f', method: 'POST', host: 'out.test', port: 443, scheme: 'https', status: 302, content_length: 3, content_type: 'text/html',
      duration_ms: 5, http_version: 'HTTP/2.0', stream_id: 1, source_addr: '127.0.0.1:5000', pid: 7, streamed: false,
      timing: { send_ms: 1 }, tls: { tls_version: 'TLSv1.3', cert_subject: 'CN=out.test', ja3: 'abc' } }
    expect(mask(meta)).toBeNull()
  })

  it('masks DNS answers that are not names or addresses', () => {
    const s = secret('txt')
    const answers = [{ name: 'out.test', type: 'A', ttl: 60, data: '10.0.0.1' }, { name: 'out.test', type: 'TXT', ttl: 60, data: s }]
    expect(applied({ subtype: 'dns_response', query_name: 'out.test', answers }).answers)
      .toEqual([answers[0], { ...answers[1], data: M }])
    expect(mask({ subtype: 'dns_response', answers: [answers[0]] })).toBeNull()
    expect(applied({ subtype: 'dns_response', answers: 'x' }).answers).toBe(M)
  })

  it('masks a navigation title and a URL-shaped description, and browser console text', () => {
    const s = secret('n')
    const nav = applied({ subtype: 'navigation', url: `https://out.test/?q=${s}`, prev_url: null, title: s, host: 'out.test', description: '→ out.test' })
    expect(nav).toMatchObject({ url: `https://out.test/?q=${ENC}`, title: M, description: '→ out.test', prev_url: null })
    expect(applied({ subtype: 'navigation', host: '', description: `→ https://out.test/?q=${s}` }).description).toBe(`→ https://out.test/?q=${ENC}`)
    const con = applied({ subtype: 'console_error', message: s, stack_trace: s, source: `https://out.test/app.js?v=${s}`, line_number: 3 })
    expect(con).toMatchObject({ message: M, stack_trace: M, source: `https://out.test/app.js?v=${ENC}`, line_number: 3 })
  })

  it('masks a cookie_change row\'s value hashes', () => {
    expect(mask({ subtype: 'cookie_change', domain: 'out.test', cookie_name: 'sid', old_hash: 'a', new_hash: 'b' })).toEqual({ old_hash: M, new_hash: M })
  })

  it('leaves the same keys alone on rows they mean something else on', () => {
    expect(mask({ subtype: 'note', title: 'operator note', message: 'mine', description: 'x', source: 'builtin-terminal' })).toBeNull()
  })
})

describe('which rows', () => {
  const row = { subtype: 'http_request_start', url: `https://out.test/?k=${secret('w')}`, request_headers: [['Authorization', secret('a')]], params: { query: { k: 'v' } } }
  it('touches nothing for an in-scope row, or with masking off', () => {
    expect(scopeMaskReplacements(row, 'in.test', scope)).toBeNull()
    expect(scopeMaskReplacements(row, 'out.test', undefined)).toBeNull()
  })
  it('masks an unclassified row with its own marker, as it does its bodies', () => {
    const out = applied(row, null)
    expect(out.params).toBe(U)
    expect(out.request_headers).toEqual([['Authorization', U]])
    expect(out.url).toBe(`https://out.test/?k=${encodeURIComponent(U)}`)
  })
  it('does not mask a row with no target when the scope has no targets', () => {
    expect(scopeMaskReplacements(row, null, { targets: [], excludeTargets: ['x.test'] })).toBeNull()
  })
})
