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

  it('masks a target\'s own X-RedLog-Truncated header in the last position when its value is not the addon\'s count', () => {
    const s = secret('tv')
    expect(applied({ response_headers: [['Accept', '*/*'], ['X-RedLog-Truncated', s]] }).response_headers).toEqual([['Accept', M], ['X-RedLog-Truncated', M]])
  })

  it('masks an X-RedLog-Truncated header with the addon\'s wording when it is not the last entry', () => {
    expect(applied({ response_headers: [['X-RedLog-Truncated', '60 total, showing 50'], ['Accept', '*/*']] }).response_headers).toEqual([['X-RedLog-Truncated', M], ['Accept', M]])
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

  it('keeps scheme, host, path and the names of valued parameters, repeats included; masks every value', () => {
    const s = secret('q')
    expect(url(`https://out.test/a/b?api_key=${s}&x=1&x=2&&y=3`)).toBe(`https://out.test/a/b?api_key=${ENC}&x=${ENC}&x=${ENC}&&y=${ENC}`)
    expect(new URL(String(url(`https://out.test/?api_key=${s}`))).searchParams.get('api_key')).toBe(M)
  })

  it('masks a query piece with no value whole, alone or among others, because ?debug= cannot be told from ?<secret>=', () => {
    const s = secret('tok')
    expect(url(`https://out.test/cb?${s}=`)).toBe(`https://out.test/cb?${ENC}`)
    expect(url(`https://out.test/cb?c2VjcmV0${s}==`)).toBe(`https://out.test/cb?${ENC}`)
    expect(url(`https://out.test/cb?${s}`)).toBe(`https://out.test/cb?${ENC}`)
    expect(url(`https://out.test/cb?a=1&${s}=&flag`)).toBe(`https://out.test/cb?a=${ENC}&${ENC}&${ENC}`)
    expect(url(`https://out.test/cb?=${s}`)).toBe(`https://out.test/cb?${ENC}`)
    expect(url(`https://out.test/cb?k=${s}==`)).toBe(`https://out.test/cb?k=${ENC}`)
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

  it('treats a data:, javascript: or vbscript: URL, and a scheme holding a control character, as all content', () => {
    expect(url(`data:text/html,${secret('d')}`)).toBe(M)
    expect(url(`javascript:alert('${secret('j')}')`)).toBe(M)
    expect(url(`vbscript:msgbox("${secret('v')}")`)).toBe(M)
    expect(url(`java\tscript:alert('${secret('t')}')`)).toBe(M)
    expect(url(`  JavaScript:alert('${secret('c')}')`)).toBe(M)
    expect(url(`ja\u0001va:x?k=${secret('x')}`)).toBe(M)
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

  it('masks HTTPS and SVCB answer data, which carries ech= and key values', () => {
    const s = secret('ech')
    for (const type of ['HTTPS', 'SVCB']) {
      const answer = { name: 'out.test', type, ttl: 60, data: `1 . alpn=h2 ech=${s}` }
      expect(applied({ subtype: 'dns_response', answers: [answer] }).answers).toEqual([{ ...answer, data: M }])
    }
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

  it('masks the URL in a scope_violation action, keeping the method and the scanner prefix', () => {
    const s = secret('sv')
    expect(applied({ subtype: 'scope_violation', target: 'out.test', source: 'http', action: `POST https://out.test/p?k=${s}#${s}` }).action)
      .toBe(`POST https://out.test/p?k=${ENC}`)
    expect(applied({ subtype: 'scope_violation', target: 'out.test', source: 'scanner', action: `WS client wss://out.test/ws?k=${s}` }).action)
      .toBe(`WS client wss://out.test/ws?k=${ENC}`)
    expect(mask({ subtype: 'scope_violation', target: 'out.test', source: 'scanner', action: 'TCP client out.test' })).toBeNull()
    expect(mask({ subtype: 'scope_violation', target: 'out.test', source: 'dns', action: 'A out.test' })).toBeNull()
  })

  it('masks the URL in an agent tool\'s scope_violation action when the tool input is a URL, and nothing else', () => {
    const s = secret('at')
    const violation = (action: string): Record<string, unknown> => ({ subtype: 'scope_violation', target: 'out.test', source: 'agent_tool', action })
    expect(applied(violation(`WebFetch https://out.test/p/q?k=${s}`)).action).toBe(`WebFetch https://out.test/p/q?k=${ENC}`)
    expect(JSON.stringify(applied(violation(`WebFetch https://out.test/p/q?k=${s}`)))).not.toContain(s)
    expect(mask(violation(`Bash curl -s out.test/?k=${s}`))).toBeNull()
    expect(mask(violation('Bash'))).toBeNull()
  })

  it('masks a scope_violation action whose source it does not know, whole', () => {
    const s = secret('src')
    expect(applied({ subtype: 'scope_violation', target: 'out.test', source: 'future_source', action: `X ${s}` }).action).toBe(M)
    expect(applied({ subtype: 'scope_violation', target: 'out.test', action: `X ${s}` }).action).toBe(M)
  })

  describe('loot matches', () => {
    const matches = (value: unknown): unknown => applied({ subtype: 'credential_detected', matches: value, count: 1 }).matches

    it('masks the preview and keeps type, confidence, plugin provenance and count', () => {
      const s = secret('loot')
      const item = { type: 'jwt', confidence: 'high', preview: `token=${s}`, plugin_id: 'p.one', pattern_name: 'jwt-ish' }
      const out = applied({ subtype: 'credential_detected', matches: [item], count: 1 })
      expect(out).toMatchObject({ matches: [{ ...item, preview: M }], count: 1 })
    })

    it('masks the value of a key it does not know, beside an empty preview or with none', () => {
      const s = secret('lk')
      expect(matches([{ type: 'jwt', preview: '', value: s, line: s }])).toEqual([{ type: 'jwt', preview: '', value: M, line: M }])
      expect(matches([{ type: 'jwt', value: s }])).toEqual([{ type: 'jwt', value: M }])
      expect(matches([{ type: 'jwt', nested: { v: s } }])).toEqual([{ type: 'jwt', nested: M }])
      expect(matches([{ type: { v: s }, confidence: 'high' }])).toEqual([{ type: M, confidence: 'high' }])
    })

    it('leaves a match with nothing in it alone', () => {
      expect(mask({ subtype: 'credential_detected', matches: [{ type: 'jwt', confidence: 'high', preview: '' }] })).toBeNull()
    })

    it('masks a non-object item, or a matches that is not an array, whole', () => {
      const s = secret('ln')
      expect(matches([{ type: 'jwt', preview: 'x' }, s])).toBe(M)
      expect(matches([null])).toBe(M)
      expect(matches([[s]])).toBe(M)
      expect(matches('x')).toBe(M)
      expect(matches({ type: 'jwt', preview: s })).toBe(M)
    })
  })

  it('masks URLs inside a description and keeps the sentence around them', () => {
    const s = secret('desc')
    expect(applied({ subtype: 'download', tool: 'curl', url: `https://out.test/f.zip?k=${s}`, description: `↓ curl: https://out.test/f.zip?k=${s}` }))
      .toMatchObject({ url: `https://out.test/f.zip?k=${ENC}`, description: `↓ curl: https://out.test/f.zip?k=${ENC}` })
    expect(applied({ subtype: 'x', description: `a "https://out.test/?k=${s}" and http://out.test/b?q=${s} end` }).description)
      .toBe(`a "https://out.test/?k=${ENC}" and http://out.test/b?q=${ENC} end`)
    expect(mask({ subtype: 'bearer_token', description: 'Bearer token → out.test' })).toBeNull()
  })

  describe('where a URL in a description ends', () => {
    const desc = (text: string): unknown => applied({ subtype: 'x', description: text }).description

    it('at a closing bracket the URL did not open, keeping the bracket', () => {
      const s = secret('br')
      expect(desc(`see (https://out.test/p?tok=${s}) here`)).toBe(`see (https://out.test/p?tok=${ENC}) here`)
      expect(desc(`[https://out.test/p?tok=${s}]`)).toBe(`[https://out.test/p?tok=${ENC}]`)
      expect(desc(`{https://out.test/p?tok=${s}}`)).toBe(`{https://out.test/p?tok=${ENC}}`)
      expect(desc(`<https://out.test/p?tok=${s}>`)).toBe(`<https://out.test/p?tok=${ENC}>`)
      expect(desc(`https://out.test/wiki/A_(b)?tok=${s}) end`)).toBe(`https://out.test/wiki/A_(b)?tok=${ENC}) end`)
      expect(desc(`http://[::1]/p?tok=${s}] end`)).toBe(`http://[::1]/p?tok=${ENC}] end`)
    })

    it('at a quote that stands before the URL, keeping it; a quote with no partner stays in the URL and is masked', () => {
      const s = secret('qt')
      for (const q of ['"', "'", '`']) expect(desc(`a ${q}https://out.test/?k=${s}${q} b`)).toBe(`a ${q}https://out.test/?k=${ENC}${q} b`)
      expect(desc(`https://out.test/?q=it's-${s} b`)).toBe(`https://out.test/?q=${ENC} b`)
    })

    it('at full-width and CJK punctuation and at non-ASCII spaces, keeping the text after', () => {
      const s = secret('cjk')
      expect(desc(`網址 https://out.test/p?x=${s}，中文`)).toBe(`網址 https://out.test/p?x=${ENC}，中文`)
      for (const p of ['。', '；', '：', '！', '？', '）', '】', '」', '』', '、', ' ', '　']) {
        expect(desc(`https://out.test/p?x=${s}${p}後`)).toBe(`https://out.test/p?x=${ENC}${p}後`)
      }
    })

    it('without the sentence punctuation that ends it', () => {
      const s = secret('tp')
      for (const p of ['.', ',', ';', ':', '!', '?']) expect(desc(`see https://out.test/p?x=${s}${p} then`)).toBe(`see https://out.test/p?x=${ENC}${p} then`)
      expect(desc(`end https://out.test/p?x=${s}...`)).toBe(`end https://out.test/p?x=${ENC}...`)
      expect(desc(`(see https://out.test/p?x=${s}).`)).toBe(`(see https://out.test/p?x=${ENC}).`)
    })

    it('at whitespace after a fragment, which is dropped', () => {
      expect(desc(`go https://out.test/p#${secret('fr')} rest`)).toBe('go https://out.test/p rest')
    })

    it('masks two URLs in one string and keeps every byte between them', () => {
      const s = secret('two')
      expect(desc(`1: https://out.test/a?k=${s}, 2: (http://out.test/b?q=${s})。`))
        .toBe(`1: https://out.test/a?k=${ENC}, 2: (http://out.test/b?q=${ENC})。`)
    })

    it('returns a string with no :// as it came', () => {
      const text = `plain text, no scheme? ${secret('n')}`
      expect(scopeMaskReplacements({ subtype: 'x', description: text }, 'out.test', scope)).toBeNull()
      expect(desc(text)).toBe(text)
    })
  })

  describe('mitmproxy error text', () => {
    const err = (error: string, subtype = 'http_error'): unknown => applied({ subtype, error }).error

    it('keeps an exact content-free message as it is', () => {
      for (const e of ['Connection killed.', 'Client disconnected.', 'Connection closed by peer.', 'Connection killed by block_global.',
        'Connection killed by block_private.', 'unknown', 'error']) {
        expect(mask({ subtype: 'http_error', error: e }), e).toBeNull()
        expect(mask({ subtype: 'tcp_end', error: e }), e).toBeNull()
      }
    })

    it('keeps the class of a message that begins with one and replaces the rest', () => {
      const s = secret('err')
      const cases: Array<[string, string]> = [
        [`Server TLS handshake failed. ${s}`, `Server TLS handshake failed. ${M}`],
        [`Client TLS handshake failed. The client may not trust the proxy's certificate for ${s}`, `Client TLS handshake failed. ${M}`],
        [`Certificate verify failed: ${s}`, `Certificate verify failed: ${M}`],
        [`HTTP/1 protocol error: ${s}`, `HTTP/1 protocol error: ${M}`],
        [`HTTP/2 protocol error: ${s}`, `HTTP/2 protocol error: ${M}`],
        [`Connection killed: ${s}`, `Connection killed: ${M}`],
        [`Cannot parse HTTP response: Bad HTTP response line: b'${s}'`, `Cannot parse HTTP response: ${M}`],
        [`Bad HTTP request line: b'${s}'`, `Bad HTTP request line: ${M}`],
        [`Invalid header line: b'X: ${s}'`, `Invalid header line: ${M}`],
        [`unexpected server response: b'${s}'`, `unexpected server response: ${M}`],
        [`peer closed connection without sending complete message body (received 3 bytes, expected ${s})`, `peer closed connection without sending complete message body ${M}`],
        [`Connect call failed ('${s}', 443)`, `Connect call failed ${M}`],
        [`[Errno 61] Connect call failed ('${s}', 443)`, `Connect call failed ${M}`]
      ]
      for (const [input, output] of cases) {
        expect(err(input), input).toBe(output)
        expect(err(input, 'tcp_end'), input).toBe(output)
      }
    })

    it('keeps only the class when server-quoted bytes follow it, whatever they say', () => {
      const s = secret('q')
      expect(err(`HTTP/1 protocol error: Connection closed by peer. b'${s}'`)).toBe(`HTTP/1 protocol error: ${M}`)
      expect(err(`Connection killed.${s}`)).toBe(`Connection killed. ${M}`)
      expect(err(`[Errno 61] Connect call failed`)).toBe('Connect call failed')
    })

    it('masks a message that only mentions a class later in its text, or names none, whole', () => {
      const s = secret('m')
      expect(err(`${s} Connection killed.`)).toBe(M)
      expect(err(`server said: HTTP/1 protocol error: ${s}`)).toBe(M)
      expect(err(`errors: ${s}`)).toBe(M)
      expect(err(`Connection killed by ${s}.`)).toBe(M)
      expect(err(`[Errno 61] ${s}`)).toBe(M)
      expect(err(`something new: ${s}`, 'tcp_end')).toBe(M)
      expect(err('Server disconnected')).toBe(M)
      expect(err('TLS handshake failed')).toBe(M)
    })
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
