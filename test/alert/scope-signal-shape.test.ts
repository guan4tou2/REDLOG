import { describe, it, expect } from 'vitest'

// The dispatch surface: which stored rows a scope verdict was ever produced
// for, and what string was judged.
//
// `scopeSignalFor` used to be mirrored here by hand because it was private to
// api-server. It is now imported directly — the mirror had drifted (it was
// missing the ws_message and tcp_message branches entirely), which is the
// failure mode a hand-copied mirror has: it agrees with the code it was copied
// from, not with the code that runs. The tailer's extractor is still mirrored,
// for now, because it remains private.

import { extractTarget } from '../../src/core/target-extractor'
import { scopeSignalFor, SCOPE_ELIGIBLE, SCOPE_KEY_SQL } from '../../src/core/alert/scope-signal'

/** Mirror of tailer-host.ts extractTargetFromToolInput. */
function extractTargetFromToolInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) {
    try { return new URL(trimmed).hostname || null } catch { return null }
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return null
  return extractTarget(trimmed)
}

describe('scopeSignalFor — routes producers to (target, source, action)', () => {
  it('shell command_start', () => {
    const r = scopeSignalFor('shell', {
      subtype: 'command_start',
      detectedTarget: 'example.com',
      command: 'curl https://example.com/'
    })
    expect(r).toEqual({ target: 'example.com', source: 'shell', action: 'curl https://example.com/' })
  })

  it('shell command_end does NOT dispatch', () => {
    const r = scopeSignalFor('shell', { subtype: 'command_end', detectedTarget: 'example.com' })
    expect(r).toBeNull()
  })

  it('shell without detectedTarget skips', () => {
    const r = scopeSignalFor('shell', { subtype: 'command_start', command: 'ls' })
    expect(r).toBeNull()
  })

  it('scanner http_request_start → source=http', () => {
    const r = scopeSignalFor('scanner', {
      subtype: 'http_request_start',
      host: 'api.example.com',
      method: 'POST',
      url: 'https://api.example.com/login'
    })
    expect(r).toEqual({
      target: 'api.example.com',
      source: 'http',
      action: 'POST https://api.example.com/login'
    })
  })

  it('scanner http_response does NOT dispatch (only starts trigger checks)', () => {
    const r = scopeSignalFor('scanner', { subtype: 'http_response', host: 'x.com' })
    expect(r).toBeNull()
  })

  it('dns query strips trailing dot and skips root query', () => {
    expect(scopeSignalFor('dns', { subtype: 'dns_query', query_name: 'example.com.', query_type: 'A' }))
      .toEqual({ target: 'example.com', source: 'dns', action: 'A example.com.' })
    expect(scopeSignalFor('dns', { subtype: 'dns_query', query_name: '.', query_type: 'NS' }))
      .toBeNull()
  })

  it('dns_response does NOT dispatch', () => {
    const r = scopeSignalFor('dns', { subtype: 'dns_response', query_name: 'x.com' })
    expect(r).toBeNull()
  })

  it('unknown agentType returns null', () => {
    expect(scopeSignalFor('marker', {})).toBeNull()
    expect(scopeSignalFor('capture_health', {})).toBeNull()
  })
})

describe('extractTargetFromToolInput — the agent_tool signal shape', () => {
  it('URL string → parsed hostname', () => {
    expect(extractTargetFromToolInput('https://api.example.com/path?q=1')).toBe('api.example.com')
    expect(extractTargetFromToolInput('http://10.0.0.1:8080/')).toBe('10.0.0.1')
  })

  it('empty / whitespace → null', () => {
    expect(extractTargetFromToolInput('')).toBeNull()
    expect(extractTargetFromToolInput('   ')).toBeNull()
  })

  it('absolute file paths never dispatch', () => {
    expect(extractTargetFromToolInput('/etc/hosts')).toBeNull()
    expect(extractTargetFromToolInput('~/notes.md')).toBeNull()
  })

  it('shell-command-shaped input goes through target-extractor', () => {
    // The extractor is host-aware; a target-shaped command should surface.
    // Free text prompts should NOT — target-extractor guards for that.
    expect(extractTargetFromToolInput('curl example.com')).toBe('example.com')
  })

  it('malformed URL returns null rather than throwing', () => {
    expect(extractTargetFromToolInput('https://')).toBeNull()
  })
})

describe('the eligible set and its SQL mirror', () => {
  // A recompute finds candidate targets with SQL rather than by hydrating and
  // JSON-parsing every row. If the two derive different strings, an allowlist
  // change judges targets the live path never saw — or misses ones it did, and
  // the operator has no way to tell which happened.
  const ROWS: Array<{ agentType: string; data: Record<string, unknown>; sql: string }> = [
    { agentType: 'shell', data: { subtype: 'command_start', detectedTarget: 'evil.example', command: 'curl evil.example' }, sql: 'evil.example' },
    { agentType: 'scanner', data: { subtype: 'http_request_start', host: 'api.target.com', method: 'POST', url: 'https://api.target.com/x' }, sql: 'api.target.com' },
    { agentType: 'scanner', data: { subtype: 'ws_message', host: 'ws.target.com', direction: 'out' }, sql: 'ws.target.com' },
    { agentType: 'scanner', data: { subtype: 'tcp_message', host: '10.0.0.5', direction: 'in' }, sql: '10.0.0.5' },
    // The trailing dot is the case that matters: the DNS producer stores the
    // FQDN form, the live verdict judged the stripped one, and matchesDomain
    // compares exactly — so `evil.example.` and `evil.example` classify
    // differently.
    { agentType: 'dns', data: { subtype: 'dns_query', query_name: 'evil.example.', query_type: 'A' }, sql: 'evil.example' }
  ]

  it('covers exactly the pairs scopeSignalFor answers for', () => {
    const derived = ROWS.map((r) => ({ agentType: r.agentType, subtype: String(r.data.subtype) }))
    expect([...SCOPE_ELIGIBLE].sort((a, b) => (a.agentType + a.subtype).localeCompare(b.agentType + b.subtype)))
      .toEqual(derived.sort((a, b) => (a.agentType + a.subtype).localeCompare(b.agentType + b.subtype)))
    for (const { agentType, data } of ROWS) {
      expect(scopeSignalFor(agentType, data), `${agentType}/${data.subtype} should be eligible`).not.toBeNull()
    }
  })

  it('has a SQL key expression per bucket that derives the judged target', () => {
    // The SQL is applied here in JS form; the DB-level equivalence is asserted
    // against a real SQLite in the recompute suite.
    const apply = (agentType: string, data: Record<string, unknown>): string => {
      const expr = SCOPE_KEY_SQL[agentType]
      expect(expr, `no SQL key for ${agentType}`).toBeTruthy()
      if (agentType === 'shell') return String(data.detectedTarget)
      if (agentType === 'scanner') return String(data.host)
      return String(data.query_name).replace(/\.+$/, '')
    }
    for (const r of ROWS) {
      expect(apply(r.agentType, r.data)).toBe(r.sql)
      expect(scopeSignalFor(r.agentType, r.data)!.target).toBe(r.sql)
    }
  })

  it('returns null for an eligible pair whose target field is missing', () => {
    expect(scopeSignalFor('shell', { subtype: 'command_start', command: 'ls' })).toBeNull()
    expect(scopeSignalFor('scanner', { subtype: 'http_request_start', url: '/x' })).toBeNull()
    expect(scopeSignalFor('dns', { subtype: 'dns_query', query_name: '.' })).toBeNull()
  })

  it('says nothing about rows that carry a host but were never judged', () => {
    // Flagging these for the first time during a recompute would be a new
    // capability, not a consequence of changing the allowlist.
    expect(scopeSignalFor('scanner', { subtype: 'connection', remoteAddr: '10.0.0.9' })).toBeNull()
    expect(scopeSignalFor('shell', { subtype: 'command_end', detectedTarget: 'evil.example' })).toBeNull()
    expect(scopeSignalFor('http_navigation', { url: 'https://evil.example' })).toBeNull()
    expect(scopeSignalFor('agent', { subtype: 'tool_call', target: 'evil.example' })).toBeNull()
  })
})
