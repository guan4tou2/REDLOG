import { describe, it, expect } from 'vitest'
import { isOutOfScope, scopeMaskReplacements } from '../src/core/scope-sanitize'

// PRD A2 — the pure classification + masking, no DB.
describe('isOutOfScope', () => {
  const scope = { targets: ['*.example.com', '10.0.0.0/8'] }
  it('in-scope targets are not out of scope', () => {
    expect(isOutOfScope('admin.example.com', scope)).toBe(false)
    expect(isOutOfScope('10.1.2.3', scope)).toBe(false)
  })
  it('a target matching no scope entry is out of scope', () => {
    expect(isOutOfScope('google.com', scope)).toBe(true)
    expect(isOutOfScope('192.168.1.1', scope)).toBe(true)
  })
  it('no target, or empty/absent scope, is never classified (cannot tell)', () => {
    expect(isOutOfScope(null, scope)).toBe(false)
    expect(isOutOfScope('google.com', { targets: [] })).toBe(false)
    expect(isOutOfScope('google.com', undefined)).toBe(false)
  })
})

describe('scopeMaskReplacements', () => {
  const scope = { targets: ['*.example.com'] }
  it('masks content fields of an out-of-scope event, leaves metadata alone', () => {
    const data = { host: 'google.com', status: 200, output: 'secret bytes', response_preview: 'more' }
    const repl = scopeMaskReplacements(data, 'google.com', scope)
    expect(repl).toEqual({ output: '[redacted: out of scope]', response_preview: '[redacted: out of scope]' })
    // metadata keys are not in the replacement set
    expect(repl && 'host' in repl).toBe(false)
    expect(repl && 'status' in repl).toBe(false)
  })
  it('returns null for an in-scope event', () => {
    expect(scopeMaskReplacements({ output: 'x' }, 'api.example.com', scope)).toBeNull()
  })
  it('returns null when an out-of-scope event carries no content field', () => {
    expect(scopeMaskReplacements({ host: 'google.com', status: 200 }, 'google.com', scope)).toBeNull()
  })
})
