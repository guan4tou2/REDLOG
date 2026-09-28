import { describe, it, expect } from 'vitest'
import { createHttpAttempt, matchesHttpAttempt, httpTestCommand } from '../src/renderer/src/lib/httpAttempt'

describe('HTTP attempt evidence', () => {
  it('keeps the address/query, strips fragments, and isolates retries and clients', () => {
    const a = createHttpAttempt('browser', 'https://example.test/a?x=1#part')
    const b = createHttpAttempt('terminal', a.url)
    expect(new URL(a.url).searchParams.get('x')).toBe('1')
    expect(new URL(a.url).hash).toBe('')
    expect(a.protocol).toBe('https')
    expect(b.url).not.toBe(a.url)
    expect(b.client).toBe('terminal')
  })
  it.each(['file:///tmp/x', 'https://user:pass@example.test/', 'bad URL', 'https://example.test/\nfoo'])('rejects unsafe test address %s', (url) => {
    expect(() => createHttpAttempt('browser', url)).toThrow()
  })
  it('requires exact completed scanner response and a valid HTTP status', () => {
    const a = createHttpAttempt('browser', 'https://example.test/')
    const event = { agentType: 'scanner', data: { subtype: 'http_response', url: a.url, status: 404 } }
    expect(matchesHttpAttempt(a, event)).toBe(true)
    for (const changes of [{ subtype: 'http_request_start' }, { url: 'https://example.test/' }, { url: a.url.replace('https:', 'http:') }, { status: 0 }, { status: 600 }, { status: undefined }]) {
      expect(matchesHttpAttempt(a, { ...event, data: { ...event.data, ...changes } })).toBe(false)
    }
    expect(matchesHttpAttempt(a, { ...event, agentType: 'shell' })).toBe(false)
    expect(matchesHttpAttempt(createHttpAttempt('browser', a.url), event)).toBe(false)
  })
  it('creates explicitly proxied, bounded commands without a TLS bypass', () => {
    const a = createHttpAttempt('terminal', "https://example.test/it's?x=$HOME")
    const sh = httpTestCommand(a, 'http://127.0.0.1:8080', 'posix')
    const ps = httpTestCommand(a, 'http://127.0.0.1:8080', 'powershell')
    expect(sh).toContain("--proxy 'http://127.0.0.1:8080' --noproxy ','")
    expect(sh).toContain('--max-time 30 --url')
    expect(sh).toContain("'\"'\"'")
    expect(ps).toMatch(/^curl.exe /)
    expect(ps).toContain("--noproxy ',' --globoff")
    expect(ps).toContain("it''s")
    expect(sh).not.toContain(' -k')
    expect(ps).not.toContain('--insecure')
  })
})
