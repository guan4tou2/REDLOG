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
  readBodyForDelivery: mockReadBody
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

  it('resolves body from a bodyRef via the checked read when inline is absent', () => {
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
  describe('event cap', () => {
    it('does not cap an approved selection, so the file matches the previewed count', () => {
      mockQueryEvents.mockClear()
      exportHar({ includeEventIds: new Set(['a']) })
      expect(mockQueryEvents).toHaveBeenCalledWith(expect.objectContaining({ limit: -1 }))
    })
    it('keeps the cap for an ad-hoc export with no selection, and honours an explicit limit', () => {
      mockQueryEvents.mockClear()
      exportHar()
      expect(mockQueryEvents).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50000 }))
      exportHar({ limit: 7 })
      expect(mockQueryEvents).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 7 }))
    })
  })
})

it('preserves raw SSE segments in order without claiming a complete reconstructed response', () => {
  const req = makeRequestEvent('sse')
  const a = makeResponseEvent('sse', { subtype: 'http_response_chunk', seq: 1, offset: 0, response_body: { data: '5Lit', encoding: 'base64', size: 3 } })
  const b = makeResponseEvent('sse', { subtype: 'http_response_chunk', seq: 2, offset: 3, response_body: { data: '5paH', encoding: 'base64', size: 3 } })
  mockQueryEvents.mockReturnValue([b, req, a])
  const entry = JSON.parse(exportHar()).log.entries[0]
  expect(entry._redlog.incomplete).toBe(true)
  expect(entry._redlog.streamChunks.map((part: { eventId: string }) => part.eventId)).toEqual([a.id, b.id])
  expect(entry._redlog.streamChunks.map((part: { body: { text: string } }) => part.body.text)).toEqual(['5Lit', '5paH'])
  expect(entry.response.content.text).toBeUndefined()
})

it('keeps bidirectional WebSocket messages and binary payloads in their observed order', () => {
  const req = makeRequestEvent('ws')
  const response = makeResponseEvent('ws', { status: 101 })
  const client = makeResponseEvent('ws', { subtype: 'ws_message', message_count: 1, direction: 'client', message_type: 'text', size: 5, ws_body: { data: 'hello', encoding: 'text', size: 5 } })
  const server = makeResponseEvent('ws', { subtype: 'ws_message', message_count: 2, direction: 'server', message_type: 'binary', size: 2, ws_body: { data: 'AP8=', encoding: 'base64', size: 2 } })
  mockQueryEvents.mockReturnValue([server, response, client, req])
  const entry = JSON.parse(exportHar()).log.entries[0]
  expect(entry._redlog.incomplete).toBe(true)
  expect(entry._redlog.webSocketMessages.map((message: { direction: string }) => message.direction)).toEqual(['client', 'server'])
  const binary = entry._redlog.webSocketMessages[1]
  expect(binary.observedSize).toBe(2)
  expect(Buffer.from(binary.body.text, binary.body.encoding)).toEqual(Buffer.from([0, 255]))
})
it('marks a response with known capture truncation incomplete', () => {
  mockQueryEvents.mockReturnValue([makeRequestEvent('cut'), makeResponseEvent('cut', { truncated: true })])
  expect(JSON.parse(exportHar()).log.entries[0]._redlog.incomplete).toBe(true)
})

// #461: entries were built from requests and responses only, so a flow whose
// request and response were never saved — admission refused, the producer
// killed mid-stream, or only its segments approved — vanished from the HAR
// with its approved events in the selection. A HAR entry needs a request and
// a status, and inventing them would be worse than losing the flow, so such a
// flow is kept beside the entries, as observed and nothing more.
describe('a flow with segments but no saved request or response (#461)', () => {
  it('keeps approved SSE chunks without inventing an entry', () => {
    const a = makeResponseEvent('orphan', { subtype: 'http_response_chunk', seq: 1, offset: 0, url: 'https://example.com/events', response_body: { data: 'ZGF0YTog', encoding: 'base64', size: 6 } })
    const b = makeResponseEvent('orphan', { subtype: 'http_response_chunk', seq: 2, offset: 6, url: 'https://example.com/events', response_body: { data: 'MQ==', encoding: 'base64', size: 1 } })
    mockQueryEvents.mockReturnValue([b, a])
    const log = JSON.parse(exportHar({ includeEventIds: new Set([a.id, b.id]) })).log
    expect(log.entries).toEqual([])
    const [flow] = log._redlog.partialFlows
    expect(flow).toMatchObject({ flowId: 'orphan', requestEventId: null, responseEventId: null, incomplete: true, url: 'https://example.com/events' })
    expect(flow.streamChunks.map((c: { eventId: string }) => c.eventId)).toEqual([a.id, b.id])
    expect(flow.streamChunks.map((c: { body: { text: string } }) => c.body.text)).toEqual(['ZGF0YTog', 'MQ=='])
    expect(flow).not.toHaveProperty('request')
    expect(flow).not.toHaveProperty('response')
  })

  it('keeps approved WebSocket messages, their direction, order and binary bytes', () => {
    const server = makeResponseEvent('ws-orphan', { subtype: 'ws_message', message_count: 2, direction: 'server', message_type: 'binary', size: 2, ws_body: { data: 'AP8=', encoding: 'base64', size: 2 } })
    const client = makeResponseEvent('ws-orphan', { subtype: 'ws_message', message_count: 1, direction: 'client', message_type: 'text', size: 2, ws_body: { data: 'hi', encoding: 'text', size: 2 } })
    mockQueryEvents.mockReturnValue([server, client])
    const log = JSON.parse(exportHar({ includeEventIds: new Set([server.id, client.id]) })).log
    expect(log.entries).toEqual([])
    const [flow] = log._redlog.partialFlows
    expect(flow.incomplete).toBe(true)
    expect(flow.webSocketMessages.map((m: { eventId: string; direction: string }) => [m.eventId, m.direction])).toEqual([[client.id, 'client'], [server.id, 'server']])
    expect(Buffer.from(flow.webSocketMessages[1].body.text, 'base64')).toEqual(Buffer.from([0, 255]))
  })

  it('adds no partial-flow field when every flow has a request or response', () => {
    mockQueryEvents.mockReturnValue([makeRequestEvent('f'), makeResponseEvent('f')])
    expect(JSON.parse(exportHar()).log._redlog).toBeUndefined()
  })

  it('keeps a request with chunks and no response as an incomplete entry', () => {
    const req = makeRequestEvent('cut-sse')
    const chunk = makeResponseEvent('cut-sse', { subtype: 'http_response_chunk', seq: 1, offset: 0, response_body: { data: 'eA==', encoding: 'base64', size: 1 } })
    mockQueryEvents.mockReturnValue([chunk, req])
    const log = JSON.parse(exportHar()).log
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]._redlog).toMatchObject({ requestEventId: req.id, responseEventId: null, incomplete: true })
    expect(log.entries[0]._redlog.streamChunks[0].eventId).toBe(chunk.id)
    expect(log._redlog).toBeUndefined()
  })

  it('keeps a WebSocket request with messages and no end as incomplete, in order', () => {
    const req = makeRequestEvent('ws-open')
    const second = makeResponseEvent('ws-open', { subtype: 'ws_message', message_count: 2, direction: 'server', message_type: 'text', size: 1, ws_body: { data: 'b', encoding: 'text', size: 1 } })
    const first = makeResponseEvent('ws-open', { subtype: 'ws_message', message_count: 1, direction: 'client', message_type: 'text', size: 1, ws_body: { data: 'a', encoding: 'text', size: 1 } })
    mockQueryEvents.mockReturnValue([second, req, first])
    const entry = JSON.parse(exportHar()).log.entries[0]
    expect(entry._redlog.incomplete).toBe(true)
    expect(entry._redlog.webSocketMessages.map((m: { eventId: string }) => m.eventId)).toEqual([first.id, second.id])
  })
})
