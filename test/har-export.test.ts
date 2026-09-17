import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RedLogEvent } from '../src/core/db/events'

// Mock the three external dependencies har-export.ts uses.
// The mock factories run before the module is imported, so the module picks up
// the stubs.

const mockQueryEvents = vi.fn<() => RedLogEvent[]>().mockReturnValue([])
const mockReadBody = vi.fn().mockReturnValue(null)
const mockRedactEventsForExport = vi.fn<(events: RedLogEvent[]) => RedLogEvent[]>().mockImplementation((events) => events)

vi.mock('../src/core/db/events', () => ({
  queryEvents: mockQueryEvents
}))

vi.mock('../src/core/http-body-store', () => ({
  readBody: mockReadBody
}))

vi.mock('../src/core/redact-export', () => ({
  redactEventsForExport: mockRedactEventsForExport
}))

const { exportHar } = await import('../src/core/har-export')

// Helpers to build realistic events
let nextId = 0
function makeRequestEvent(flowId: string, overrides?: Record<string, unknown>): RedLogEvent {
  return {
    id: `req-${++nextId}`,
    timestamp: Date.now(),
    engagementId: 'eng-1',
    sessionId: 'sess-1',
    operatorId: 'op-1',
    agentType: 'scanner',
    hostname: 'test-host',
    sourceIP: '10.0.0.1',
    targetId: 'target-1',
    data: {
      subtype: 'http_request_start',
      flow_id: flowId,
      method: 'GET',
      url: 'https://example.com/api?key=val&foo=bar',
      http_version: 'HTTP/1.1',
      request_headers: [['Host', 'example.com'], ['User-Agent', 'RedLog']],
      cookies: [{ name: 'session', value: 'abc123' }],
      ...overrides
    },
    createdAt: Date.now()
  }
}

function makeResponseEvent(flowId: string, overrides?: Record<string, unknown>): RedLogEvent {
  return {
    id: `resp-${++nextId}`,
    timestamp: Date.now() + 100,
    engagementId: 'eng-1',
    sessionId: 'sess-1',
    operatorId: 'op-1',
    agentType: 'scanner',
    hostname: 'test-host',
    sourceIP: '10.0.0.1',
    targetId: 'target-1',
    data: {
      subtype: 'http_response',
      flow_id: flowId,
      status: 200,
      http_version: 'HTTP/1.1',
      content_type: 'application/json',
      content_length: 42,
      duration_ms: 150,
      response_headers: [['Content-Type', 'application/json']],
      set_cookies: [{ name: 'token', value: 'xyz', path: '/', domain: '.example.com', httponly: true, secure: true }],
      response_body: { data: '{"ok":true}', encoding: 'text', size: 11 },
      timing: { send_ms: 2, wait_ms: 100, receive_ms: 48, connect_ms: 10, tls_ms: 5 },
      ...overrides
    },
    createdAt: Date.now() + 100
  }
}

describe('har-export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRedactEventsForExport.mockImplementation((events) => events)
    nextId = 0
  })

  it('produces a valid HAR 1.2 structure with no events', () => {
    mockQueryEvents.mockReturnValue([])
    const har = JSON.parse(exportHar())

    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('RedLog')
    expect(har.log.entries).toEqual([])
  })

  it('pairs request and response events by flow_id into HAR entries', () => {
    const req = makeRequestEvent('flow-1')
    const resp = makeResponseEvent('flow-1')
    mockQueryEvents.mockReturnValue([req, resp])

    const har = JSON.parse(exportHar())
    expect(har.log.entries).toHaveLength(1)

    const entry = har.log.entries[0]
    expect(entry.request.method).toBe('GET')
    expect(entry.request.url).toBe('https://example.com/api?key=val&foo=bar')
    expect(entry.response.status).toBe(200)
    expect(entry.time).toBe(150)
  })

  it('populates request headers in HAR format', () => {
    mockQueryEvents.mockReturnValue([
      makeRequestEvent('flow-1'),
      makeResponseEvent('flow-1')
    ])

    const har = JSON.parse(exportHar())
    const reqHeaders = har.log.entries[0].request.headers

    expect(reqHeaders).toContainEqual({ name: 'Host', value: 'example.com' })
    expect(reqHeaders).toContainEqual({ name: 'User-Agent', value: 'RedLog' })
  })

  it('populates response headers', () => {
    mockQueryEvents.mockReturnValue([
      makeRequestEvent('flow-1'),
      makeResponseEvent('flow-1')
    ])

    const har = JSON.parse(exportHar())
    const respHeaders = har.log.entries[0].response.headers

    expect(respHeaders).toContainEqual({ name: 'Content-Type', value: 'application/json' })
  })

  it('parses query string from the URL', () => {
    mockQueryEvents.mockReturnValue([
      makeRequestEvent('flow-1'),
      makeResponseEvent('flow-1')
    ])

    const har = JSON.parse(exportHar())
    const qs = har.log.entries[0].request.queryString

    expect(qs).toContainEqual({ name: 'key', value: 'val' })
    expect(qs).toContainEqual({ name: 'foo', value: 'bar' })
  })

  it('handles inline response body in the content field', () => {
    mockQueryEvents.mockReturnValue([
      makeRequestEvent('flow-1'),
      makeResponseEvent('flow-1')
    ])

    const har = JSON.parse(exportHar())
    const content = har.log.entries[0].response.content

    expect(content.text).toBe('{"ok":true}')
    expect(content.mimeType).toBe('application/json')
  })

  it('populates request cookies from the event data', () => {
    mockQueryEvents.mockReturnValue([
      makeRequestEvent('flow-1'),
      makeResponseEvent('flow-1')
    ])

    const har = JSON.parse(exportHar())
    const cookies = har.log.entries[0].request.cookies

    expect(cookies).toContainEqual({ name: 'session', value: 'abc123' })
  })

  it('populates response Set-Cookie with path, domain, httpOnly, secure', () => {
    mockQueryEvents.mockReturnValue([
      makeRequestEvent('flow-1'),
      makeResponseEvent('flow-1')
    ])

    const har = JSON.parse(exportHar())
    const cookies = har.log.entries[0].response.cookies

    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatchObject({
      name: 'token',
      value: 'xyz',
      path: '/',
      domain: '.example.com',
      httpOnly: true,
      secure: true
    })
  })

  it('includes timing details (send, wait, receive, connect, ssl)', () => {
    mockQueryEvents.mockReturnValue([
      makeRequestEvent('flow-1'),
      makeResponseEvent('flow-1')
    ])

    const har = JSON.parse(exportHar())
    const timings = har.log.entries[0].timings

    expect(timings).toEqual({
      send: 2,
      wait: 100,
      receive: 48,
      connect: 10,
      ssl: 5
    })
  })

  it('handles a request without a matching response', () => {
    // Only a request, no response
    mockQueryEvents.mockReturnValue([makeRequestEvent('orphan-flow')])

    const har = JSON.parse(exportHar())
    expect(har.log.entries).toHaveLength(1)

    const entry = har.log.entries[0]
    expect(entry.request.method).toBe('GET')
    expect(entry.response.status).toBe(0) // default when no response
    expect(entry.time).toBe(-1)
  })

  it('skips events without a flow_id', () => {
    const noFlow: RedLogEvent = {
      id: 'no-flow',
      timestamp: Date.now(),
      engagementId: 'eng-1',
      sessionId: 'sess-1',
      operatorId: 'op-1',
      agentType: 'scanner',
      hostname: 'h',
      sourceIP: null,
      targetId: null,
      data: { subtype: 'http_request_start' }, // no flow_id
      createdAt: Date.now()
    }
    mockQueryEvents.mockReturnValue([noFlow])

    const har = JSON.parse(exportHar())
    expect(har.log.entries).toEqual([])
  })

  it('includes postData when a request has an inline body', () => {
    const req = makeRequestEvent('flow-1', {
      request_body: { data: '{"user":"admin"}', encoding: 'text', size: 16 },
      request_headers: [['Content-Type', 'application/json']]
    })
    mockQueryEvents.mockReturnValue([req, makeResponseEvent('flow-1')])

    const har = JSON.parse(exportHar())
    const postData = har.log.entries[0].request.postData

    expect(postData).toBeDefined()
    expect(postData.mimeType).toBe('application/json')
    expect(postData.text).toBe('{"user":"admin"}')
  })

  it('resolves body from a bodyRef via readBody when inline is absent', () => {
    const ref = { sha256: 'a'.repeat(64), size: 5, file: 'abc.body', encoding: 'text' as const }
    mockReadBody.mockReturnValue('hello')

    const req = makeRequestEvent('flow-1', {
      request_body_ref: ref,
      request_headers: [['Content-Type', 'text/plain']]
    })
    mockQueryEvents.mockReturnValue([req, makeResponseEvent('flow-1')])

    const har = JSON.parse(exportHar())
    const postData = har.log.entries[0].request.postData

    expect(postData).toBeDefined()
    expect(postData.text).toBe('hello')
    expect(mockReadBody).toHaveBeenCalled()
  })

  it('sorts entries by startedDateTime', () => {
    const early = makeRequestEvent('flow-early')
    ;(early as { timestamp: number }).timestamp = 1000
    const late = makeRequestEvent('flow-late')
    ;(late as { timestamp: number }).timestamp = 2000

    // Feed them in reverse order
    mockQueryEvents.mockReturnValue([late, early])

    const har = JSON.parse(exportHar())
    expect(har.log.entries).toHaveLength(2)

    const t0 = har.log.entries[0].startedDateTime
    const t1 = har.log.entries[1].startedDateTime
    expect(t0.localeCompare(t1)).toBeLessThanOrEqual(0)
  })

  it('passes through the redact-export pipeline', () => {
    mockRedactEventsForExport.mockImplementation((events) =>
      events.map(e => ({ ...e, data: { ...e.data, url: '[REDACTED]' } }))
    )
    mockQueryEvents.mockReturnValue([
      makeRequestEvent('flow-1'),
      makeResponseEvent('flow-1')
    ])

    const har = JSON.parse(exportHar())
    expect(har.log.entries[0].request.url).toBe('[REDACTED]')
    expect(mockRedactEventsForExport).toHaveBeenCalledTimes(1)
  })

  it('handles headers as an object (not just arrays)', () => {
    const req = makeRequestEvent('flow-1', {
      request_headers: { 'X-Custom': 'value1', Accept: 'text/html' }
    })
    mockQueryEvents.mockReturnValue([req])

    const har = JSON.parse(exportHar())
    const headers = har.log.entries[0].request.headers

    expect(headers).toContainEqual({ name: 'X-Custom', value: 'value1' })
    expect(headers).toContainEqual({ name: 'Accept', value: 'text/html' })
  })
})
