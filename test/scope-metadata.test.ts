import { describe, it, expect } from 'vitest'
import {
  scrubUrlQueryParams,
  scrubSensitiveHeaders,
  scrubCookieValues,
  scopeMetadataReplacements
} from '../src/core/scope-sanitize'

// Tests for the "For sharing" metadata masking layer (scope-sanitize.ts wave 2).
// Content-field masking (scopeMaskReplacements) is a separate concern; these
// cover only the metadata-level functions that scrub headers, URLs, cookies, and
// the top-level scopeMetadataReplacements orchestrator.

describe('scrubUrlQueryParams', () => {
  it('scrubs token, key, and password params', () => {
    const url = 'https://example.com/path?token=abc&key=def&password=ghi'
    const result = scrubUrlQueryParams(url)
    expect(result).toContain('token=%5BREDACTED%5D')
    expect(result).toContain('key=%5BREDACTED%5D')
    expect(result).toContain('password=%5BREDACTED%5D')
    expect(result).toContain('/path')
  })

  it('preserves safe params untouched', () => {
    const url = 'https://example.com/search?q=hello&page=2&token=secret'
    const result = scrubUrlQueryParams(url)
    expect(result).toContain('q=hello')
    expect(result).toContain('page=2')
    expect(result).toContain('token=%5BREDACTED%5D')
  })

  it('returns an invalid URL unchanged', () => {
    const bad = 'not-a-url'
    expect(scrubUrlQueryParams(bad)).toBe(bad)
  })

  it('returns a URL with no sensitive params unchanged (same reference)', () => {
    const url = 'https://example.com/ok?page=1&sort=asc'
    expect(scrubUrlQueryParams(url)).toBe(url)
  })
})

describe('scrubSensitiveHeaders', () => {
  describe('redact-all mode', () => {
    it('returns the reason string regardless of input', () => {
      expect(scrubSensitiveHeaders([['Content-Type', 'text/html']], 'redact-all'))
        .toBe('[redacted: out of scope]')
      expect(scrubSensitiveHeaders({ host: 'example.com' }, 'redact-all'))
        .toBe('[redacted: out of scope]')
    })
  })

  describe('scrub-sensitive with array pairs', () => {
    it('scrubs auth headers and preserves content-type', () => {
      const headers = [
        ['Content-Type', 'application/json'],
        ['Authorization', 'Bearer secret-token'],
        ['X-Api-Key', 'key-value']
      ]
      const result = scrubSensitiveHeaders(headers, 'scrub-sensitive') as unknown[][]
      expect(result).toEqual([
        ['Content-Type', 'application/json'],
        ['Authorization', '[REDACTED]'],
        ['X-Api-Key', '[REDACTED]']
      ])
    })
  })

  describe('scrub-sensitive with object', () => {
    it('scrubs auth header values and preserves safe ones', () => {
      const headers = {
        'content-type': 'text/html',
        'authorization': 'Bearer tok',
        'cookie': 'session=abc',
        'x-request-id': '123'
      }
      const result = scrubSensitiveHeaders(headers, 'scrub-sensitive') as Record<string, string>
      expect(result['content-type']).toBe('text/html')
      expect(result['authorization']).toBe('[REDACTED]')
      expect(result['cookie']).toBe('[REDACTED]')
      expect(result['x-request-id']).toBe('123')
    })
  })
})

describe('scrubCookieValues', () => {
  it('replaces cookie values while preserving names and attributes', () => {
    const cookies = [
      { name: 'session', value: 's3cr3t', path: '/' },
      { name: 'lang', value: 'en', httpOnly: true }
    ]
    const result = scrubCookieValues(cookies) as Record<string, unknown>[]
    expect(result).toEqual([
      { name: 'session', value: '[REDACTED]', path: '/' },
      { name: 'lang', value: '[REDACTED]', httpOnly: true }
    ])
  })

  it('returns reason string for non-array input', () => {
    expect(scrubCookieValues('not-an-array')).toBe('[redacted: out of scope]')
    expect(scrubCookieValues(null)).toBe('[redacted: out of scope]')
  })
})

describe('scopeMetadataReplacements', () => {
  describe('out-of-scope', () => {
    it('blanks all metadata, command, and target_id', () => {
      const data = {
        url: 'https://other.com/api',
        host: 'other.com',
        request_headers: [['Authorization', 'Bearer x']],
        response_headers: { 'set-cookie': 'a=b' },
        cookies: [{ name: 'c', value: 'v' }],
        set_cookies: [{ name: 'sc', value: 'sv' }],
        query_name: 'SELECT 1',
        command: 'nmap -sS other.com',
        target_id: '10.0.0.5'
      }
      const result = scopeMetadataReplacements(data, { outOfScope: true })!
      expect(result).not.toBeNull()
      for (const f of ['url', 'host', 'request_headers', 'response_headers', 'cookies', 'set_cookies', 'query_name']) {
        expect(result[f]).toBe('[redacted: out-of-scope metadata]')
      }
      expect(result.command).toBe('[redacted: out-of-scope command]')
      expect(result.target_id).toBe('[redacted: out-of-scope metadata]')
    })
  })

  describe('in-scope with sensitive headers', () => {
    it('scrubs only sensitive header values and credential query params', () => {
      const data = {
        url: 'https://target.com/api?token=secret&page=1',
        request_headers: [
          ['Authorization', 'Bearer tok'],
          ['Accept', 'application/json']
        ],
        response_headers: { 'set-cookie': 'a=b', 'content-type': 'text/html' },
        cookies: [{ name: 'session', value: 'v' }],
        set_cookies: [{ name: 'refresh', value: 'r' }]
      }
      const result = scopeMetadataReplacements(data, { outOfScope: false })!
      expect(result).not.toBeNull()
      // URL: token scrubbed, page preserved
      expect(result.url).toContain('token=%5BREDACTED%5D')
      expect(result.url).toContain('page=1')
      // Request headers: auth scrubbed, accept preserved
      const reqHeaders = result.request_headers as unknown[][]
      expect(reqHeaders).toEqual([
        ['Authorization', '[REDACTED]'],
        ['Accept', 'application/json']
      ])
      // Response headers: set-cookie scrubbed, content-type preserved
      const resHeaders = result.response_headers as Record<string, string>
      expect(resHeaders['set-cookie']).toBe('[REDACTED]')
      expect(resHeaders['content-type']).toBe('text/html')
      // Cookies scrubbed
      expect(result.cookies).toEqual([{ name: 'session', value: '[REDACTED]' }])
      expect(result.set_cookies).toEqual([{ name: 'refresh', value: '[REDACTED]' }])
    })
  })

  describe('in-scope with nothing sensitive', () => {
    it('returns null when no scrubbing is needed', () => {
      const data = {
        url: 'https://target.com/api?page=1',
        host: 'target.com',
        command: 'curl target.com'
      }
      expect(scopeMetadataReplacements(data, { outOfScope: false })).toBeNull()
    })
  })

  describe('out-of-scope with empty data', () => {
    it('returns null when there are no metadata fields to blank', () => {
      expect(scopeMetadataReplacements({}, { outOfScope: true })).toBeNull()
    })
  })
})
