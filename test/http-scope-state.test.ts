import { describe, expect, it } from 'vitest'
import { httpScopeState } from '../src/renderer/src/lib/scope'
import { countOutOfScopeHttpFlows } from '../src/core/export-plan'
import type { RedLogEvent } from '../src/core/db/event-types'
const policy = { targets: ['*.example.test'], excludeTargets: ['private.example.test'] }
describe('HTTP scope display and frozen preview', () => {
  it('distinguishes unset, unknown, included and excluded without treating empty as outside', () => {
    expect(httpScopeState('https://a.example.test/', policy)).toBe('in-scope')
    expect(httpScopeState('https://private.example.test/', policy)).toBe('out-of-scope')
    expect(httpScopeState('https://other.test/', policy)).toBe('out-of-scope')
    expect(httpScopeState('broken URL', policy)).toBe('unknown')
    expect(httpScopeState('https://a.example.test/', null)).toBe('unknown')
    expect(httpScopeState('https://other.test/', { targets: [], excludeTargets: [] })).toBe('no-scope')
  })
  it('counts a request/response exchange once, independently of masking', () => {
    const rows = [
      ['f1', 'http_request_start', 'https://other.test/'], ['f1', 'http_response', 'https://other.test/'],
      ['f2', 'http_request_start', 'https://a.example.test/'], ['f3', 'http_response', 'bad url']
    ].map(([flow_id, subtype, url], i) => ({ id: String(i), data: { flow_id, subtype, url } }) as RedLogEvent)
    expect(countOutOfScopeHttpFlows(rows, policy)).toBe(1)
    expect(countOutOfScopeHttpFlows(rows, { targets: [], excludeTargets: [] })).toBe(0)
  })
})
