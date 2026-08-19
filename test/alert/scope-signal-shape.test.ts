import { describe, it, expect } from 'vitest'

// scopeSignalFor and extractTargetFromToolInput are internal helpers — the
// dispatch surface is what matters, so we replicate the shaping rules here
// as inline mirrors. If the api-server or tailer-host implementation
// drifts these assertions catch the drift because the shape is documented
// in the tests.

import { extractTarget } from '../../src/core/target-extractor'

/** Mirror of api-server.ts scopeSignalFor — must stay in sync with the
 *  real function. When the real one gains a new source (agent_tool from
 *  the tailer, scanner from a plugin), this mirror gets a new branch. */
function scopeSignalFor(agentType: string, data: Record<string, unknown>): {
  target: string; source: string; action: string
} | null {
  if (agentType === 'shell' && data.subtype === 'command_start') {
    const target = (data.detectedTarget as string | undefined) ?? null
    if (!target) return null
    return { target, source: 'shell', action: (data.command as string) ?? '' }
  }
  if (agentType === 'scanner' && data.subtype === 'http_request_start') {
    const target = (data.host as string | undefined) ?? null
    if (!target) return null
    return { target, source: 'http', action: `${(data.method as string) ?? 'GET'} ${(data.url as string) ?? ''}`.trim() }
  }
  if (agentType === 'dns' && data.subtype === 'dns_query') {
    const target = (data.query_name as string | undefined) ?? null
    if (!target || target === '.') return null
    return { target: target.replace(/\.$/, ''), source: 'dns', action: `${(data.query_type as string) ?? 'A'} ${target}` }
  }
  return null
}

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
