import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RedLogEvent } from '../src/core/db/events'

// #489: a large binary response has no preview, so the event carries only
// `response_body_ref`. Scope masking looks for preview fields to mask, found
// none, and used to leave the ref in place; exportHar then read the body. This
// runs the real redaction and the real HAR builder, and stubs only the data
// sources, so the assertion is on what a HAR reader would actually receive.

const mockQueryEvents = vi.fn<() => RedLogEvent[]>()
const mockReadBody = vi.fn<(ref: unknown) => string | null>()

vi.mock('../src/core/db/events', () => ({ queryEvents: mockQueryEvents, queryEventById: vi.fn() }))
vi.mock('../src/core/http-body-store', () => ({
  readBodyForDelivery: mockReadBody,
  BODY_REF_FIELDS: ['request_body_ref', 'response_body_ref', 'ws_body_ref', 'tcp_body_ref']
}))
vi.mock('../src/core/http-body-index', () => ({ eventIdsReferencingBody: () => [] }))
vi.mock('../src/core/sanitize', () => ({ getSanitizedFields: () => ({}) }))

const { exportHar } = await import('../src/core/har-export')

const REF = { sha256: 'c'.repeat(64), file: `${'c'.repeat(64)}.body`, size: 4_000_000, encoding: 'base64' }
// Built at run time: a literal base64 string here reads to secret scanners as a credential.
const SECRET = Buffer.from('OUT-OF-SCOPE-BODY').toString('base64')

function flow(targetId: string | null): RedLogEvent[] {
  const base = { engagementId: 'e', sessionId: 's', operatorId: 'o', agentType: 'scanner', hostname: 'h', sourceIP: '10.0.0.1', createdAt: 1 }
  return [
    { ...base, id: 'req', timestamp: 1, targetId, data: { subtype: 'http_request_start', flow_id: 'f', method: 'GET', url: 'https://x.test/blob' } },
    // No response_body, no response_body_preview: only the pointer.
    { ...base, id: 'resp', timestamp: 2, targetId, data: { subtype: 'http_response', flow_id: 'f', status: 200, content_type: 'application/octet-stream', response_body_ref: REF } }
  ] as unknown as RedLogEvent[]
}

describe('exportHar and a body that has only a body-store ref (#489)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadBody.mockImplementation(() => SECRET)
  })
  const scope = { targets: ['in.test'], excludeTargets: [] }

  it('does not deliver the body of an out-of-scope event', () => {
    mockQueryEvents.mockReturnValue(flow('out.test'))
    const har = exportHar({ scope })
    expect(har).not.toContain(SECRET)
    expect(mockReadBody).not.toHaveBeenCalled()
    expect(JSON.parse(har).log.entries[0].response.content.text).toBeUndefined()
  })

  it('does not deliver the body of an event with no target when a scope is set', () => {
    mockQueryEvents.mockReturnValue(flow(null))
    expect(exportHar({ scope })).not.toContain(SECRET)
    expect(mockReadBody).not.toHaveBeenCalled()
  })

  it('still delivers the body of an in-scope event', () => {
    mockQueryEvents.mockReturnValue(flow('in.test'))
    expect(exportHar({ scope })).toContain(SECRET)
  })
})
