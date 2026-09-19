import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../src/core/sanitize', () => ({
  getSanitizedFields: vi.fn(() => ({}))
}))

vi.mock('../src/core/scope-sanitize', async () => {
  const actual = await vi.importActual<typeof import('../src/core/scope-sanitize')>('../src/core/scope-sanitize')
  return {
    ...actual,
    isOutOfScope: vi.fn((targetId: string | null, scope: { targets: string[] } | undefined) => {
      if (!scope || !targetId) return false
      return !scope.targets.includes(targetId)
    })
  }
})

import { redactEventForExport, redactEventsForExport, BODY_REF_FOR } from '../src/core/redact-export'
import { getSanitizedFields } from '../src/core/sanitize'
import type { RedLogEvent } from '../src/core/db/events'

const mockGetSanitizedFields = getSanitizedFields as ReturnType<typeof vi.fn>

function mkEvent(overrides: Partial<RedLogEvent> = {}): RedLogEvent {
  return {
    id: 'evt-1',
    agentType: 'http',
    timestamp: 1700000000000,
    targetId: '10.0.0.1',
    operatorId: 'op-alice',
    data: {},
    ...overrides
  } as RedLogEvent
}

describe('redactEventForExport', () => {
  beforeEach(() => {
    mockGetSanitizedFields.mockReturnValue({})
  })

  it('returns event unchanged when no opts', () => {
    const e = mkEvent()
    expect(redactEventForExport(e)).toBe(e)
  })

  it('returns event unchanged with empty opts', () => {
    const e = mkEvent()
    expect(redactEventForExport(e, {})).toBe(e)
  })

  // ── Blacklist exclusion ──

  it('returns null when targetId is in blacklist and maskMetadata is on', () => {
    const e = mkEvent({ targetId: '192.168.1.1' })
    expect(redactEventForExport(e, { maskMetadata: true, blacklist: ['192.168.1.1'] })).toBeNull()
  })

  it('does NOT exclude when maskMetadata is false', () => {
    const e = mkEvent({ targetId: '192.168.1.1' })
    const result = redactEventForExport(e, { maskMetadata: false, blacklist: ['192.168.1.1'] })
    expect(result).not.toBeNull()
  })

  it('does NOT exclude when blacklist is empty', () => {
    const e = mkEvent({ targetId: '192.168.1.1' })
    expect(redactEventForExport(e, { maskMetadata: true, blacklist: [] })).not.toBeNull()
  })

  it('does NOT exclude when targetId is null', () => {
    const e = mkEvent({ targetId: null })
    expect(redactEventForExport(e, { maskMetadata: true, blacklist: ['192.168.1.1'] })).not.toBeNull()
  })

  // ── Layer-4 sanitize ──

  it('applies getSanitizedFields replacements', () => {
    mockGetSanitizedFields.mockReturnValue({ output: '[sanitized]' })
    const e = mkEvent({ data: { output: 'secret stuff' } })
    const result = redactEventForExport(e)!
    expect(result.data.output).toBe('[sanitized]')
    expect(result).not.toBe(e)
  })

  // ── Scope masking ──

  it('masks content fields of out-of-scope events', () => {
    const e = mkEvent({
      targetId: '10.99.99.99',
      data: { output: 'sensitive', request_body: 'payload' }
    })
    const scope = { targets: ['10.0.0.1'] }
    const result = redactEventForExport(e, { scope })!
    expect(result.data.output).toContain('[redacted')
    expect(result.data.request_body).toContain('[redacted')
  })

  it('leaves in-scope events content intact', () => {
    const e = mkEvent({
      targetId: '10.0.0.1',
      data: { output: 'ok data' }
    })
    const result = redactEventForExport(e, { scope: { targets: ['10.0.0.1'] } })!
    expect(result.data.output).toBe('ok data')
  })

  // ── Body ref dropping ──

  it('drops body ref when body field is masked', () => {
    const e = mkEvent({
      targetId: '10.99.99.99',
      data: {
        request_body: 'payload',
        request_body_ref: { sha256: 'abc123', size: 100, file: 'x' }
      }
    })
    const result = redactEventForExport(e, { scope: { targets: ['10.0.0.1'] } })!
    expect(result.data.request_body_ref).toBeUndefined()
  })

  it('keeps body ref when body field is not masked', () => {
    const e = mkEvent({
      targetId: '10.0.0.1',
      data: {
        request_body: 'payload',
        request_body_ref: { sha256: 'abc123', size: 100, file: 'x' }
      }
    })
    const result = redactEventForExport(e, { scope: { targets: ['10.0.0.1'] } })!
    expect(result.data.request_body_ref).toBeDefined()
  })

  // ── Metadata masking ──

  it('blanks metadata for out-of-scope events when maskMetadata is on', () => {
    const e = mkEvent({
      targetId: '10.99.99.99',
      data: { url: 'https://secret.internal/admin', host: 'secret.internal', command: 'nmap -sV 10.99.99.99' }
    })
    const result = redactEventForExport(e, {
      scope: { targets: ['10.0.0.1'] },
      maskMetadata: true
    })!
    expect(result.data.url).toContain('[redacted')
    expect(result.data.host).toContain('[redacted')
    expect(result.data.command).toContain('[redacted')
  })

  it('scrubs only sensitive header values for in-scope events', () => {
    const e = mkEvent({
      targetId: '10.0.0.1',
      data: {
        url: 'https://target.com/api?token=secret123&page=1',
        request_headers: { authorization: 'Bearer xyz', 'content-type': 'application/json' }
      }
    })
    const result = redactEventForExport(e, {
      scope: { targets: ['10.0.0.1'] },
      maskMetadata: true
    })!
    expect(result.data.url).toContain('REDACTED')
    expect(result.data.url).not.toContain('secret123')
    expect(result.data.url).toContain('page=1')
    const hdrs = result.data.request_headers as Record<string, string>
    expect(hdrs.authorization).toBe('[REDACTED]')
    expect(hdrs['content-type']).toBe('application/json')
  })

  it('does not apply metadata masking when maskMetadata is false', () => {
    const e = mkEvent({
      targetId: '10.99.99.99',
      data: { url: 'https://secret.internal', host: 'secret.internal' }
    })
    const result = redactEventForExport(e, {
      scope: { targets: ['10.0.0.1'] },
      maskMetadata: false
    })!
    expect(result.data.url).toBe('https://secret.internal')
  })

  // ── Operator ID scrub ──

  it('replaces operatorId with "operator" when maskMetadata is on', () => {
    const e = mkEvent({ operatorId: 'op-alice' })
    const result = redactEventForExport(e, { maskMetadata: true })!
    expect(result.operatorId).toBe('operator')
  })

  it('preserves operatorId when maskMetadata is off', () => {
    const e = mkEvent({ operatorId: 'op-alice' })
    const result = redactEventForExport(e, { maskMetadata: false })!
    expect(result.operatorId).toBe('op-alice')
  })

  it('skips operatorId scrub when operatorId is falsy', () => {
    const e = mkEvent({ operatorId: null })
    const result = redactEventForExport(e, { maskMetadata: true })!
    expect(result.operatorId).toBeNull()
  })

  // ── Backward compat ──

  it('accepts ScopeForSanitize directly (backward compat)', () => {
    const e = mkEvent({
      targetId: '10.99.99.99',
      data: { output: 'data' }
    })
    const result = redactEventForExport(e, { targets: ['10.0.0.1'] })!
    expect(result.data.output).toContain('[redacted')
  })

  // ── BODY_REF_FOR constant ──

  it('maps all expected body fields to their refs', () => {
    expect(BODY_REF_FOR.request_body).toBe('request_body_ref')
    expect(BODY_REF_FOR.response_body).toBe('response_body_ref')
    expect(BODY_REF_FOR.output).toBe('output_ref')
    expect(BODY_REF_FOR.ws_body).toBe('ws_body_ref')
    expect(BODY_REF_FOR.tcp_body).toBe('tcp_body_ref')
  })
})

describe('redactEventsForExport', () => {
  beforeEach(() => {
    mockGetSanitizedFields.mockReturnValue({})
  })

  it('filters out null (blacklisted) events', () => {
    const events = [
      mkEvent({ id: 'e1', targetId: '192.168.1.1' }),
      mkEvent({ id: 'e2', targetId: '10.0.0.1' })
    ]
    const result = redactEventsForExport(events, { maskMetadata: true, blacklist: ['192.168.1.1'] })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('e2')
  })

  it('returns all when none excluded', () => {
    const events = [mkEvent({ id: 'e1' }), mkEvent({ id: 'e2' })]
    expect(redactEventsForExport(events)).toHaveLength(2)
  })

  it('returns empty array for empty input', () => {
    expect(redactEventsForExport([])).toEqual([])
  })
})
