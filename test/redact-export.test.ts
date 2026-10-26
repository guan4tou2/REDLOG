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

  it('removes raw stream bytes together with an explicitly sanitized output field', () => {
    mockGetSanitizedFields.mockReturnValue({ stdout: '[sanitized]' })
    const event = mkEvent({ agentType: 'shell', data: { stdout: 'secret', output_body_ref: { sha256: 'raw' }, output_body: { data: 'c2VjcmV0', encoding: 'base64' } } })
    const result = redactEventForExport(event)!
    expect(result.data.stdout).toBe('[sanitized]')
    expect(result.data.output_body_ref).toBeUndefined()
    expect(result.data.output_body).toBeUndefined()
    expect(event.data.output_body_ref).toBeDefined()
  })

  it('scope-masks a raw stream ref even when control-only output has no visible text', () => {
    const event = mkEvent({ agentType: 'shell', targetId: 'outside.test', data: { stdout: '', output_body_ref: { sha256: 'raw' } } })
    const result = redactEventForExport(event, { targets: ['inside.test'], excludeTargets: [], personalDomains: [] })!
    expect(result.data.output_body_ref).toBeUndefined()
    expect(JSON.stringify(result.data)).not.toContain('raw')
  })

  it('returns event unchanged when no opts', () => {
    const e = mkEvent()
    expect(redactEventForExport(e)).toBe(e)
  })

  it('returns event unchanged with empty opts', () => {
    const e = mkEvent()
    expect(redactEventForExport(e, {})).toBe(e)
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

  it('filters out events the operator marked do-not-export', () => {
    const events = [
      mkEvent({ id: 'e1', targetId: '192.168.1.1' }),
      mkEvent({ id: 'e2', targetId: '10.0.0.1' })
    ]
    const result = redactEventsForExport(events, { doNotExportIds: new Set(['e1']) })
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
