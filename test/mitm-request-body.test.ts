// What the mitmproxy addon sends for a request body. The body is recorded once
// (`request_body`, with `request_body_preview` beside it); a JSON body is not
// also parsed into `params`, which let the target or tester choose how deep the
// event's own data nests.
//
// The Python is the real addon under test/fixtures/mitm-request-payload.py, run
// with whatever `python3` is on PATH (CI: 3.11, where json.loads overflows its
// recursion limit at about 1,000 levels).
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { runAddonRequests } from './helpers/addon-request-payload'
import { jsonDepthExceeds } from '../src/core/api-request'

const JSON_TYPE = 'application/json'
const send = (contentType: string, body: string | Buffer, url?: string) => {
  const out = runAddonRequests([{ contentType, body: Buffer.from(body), url }])
  const result = out.results[0]
  if (!('data' in result)) throw new Error(`addon (python ${out.python}) sent nothing: ${result.error}`)
  return result.data
}

describe('mitmproxy addon: JSON request bodies', () => {
  it('sends the body as request_body and request_body_preview and does not parse it into params', () => {
    const text = JSON.stringify({ user: 'alice', roles: ['a', 'b'], nested: { k: 'v' } })
    const data = send(JSON_TYPE, text)
    expect(data.request_body).toEqual({
      data: text, encoding: 'text', size: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'), truncated: false, content_type: JSON_TYPE
    })
    expect(data.request_body_preview).toBe(text)
    expect(data.params).toBeUndefined()
  })

  it('keeps the first 4096 characters as the preview and the whole body in request_body', () => {
    const text = JSON.stringify({ head: 'HEADWORD', pad: 'x'.repeat(6000), tail: 'TAILWORD' })
    const data = send(JSON_TYPE, text)
    expect((data.request_body as { data: string }).data).toBe(text)
    expect(data.request_body_preview).toBe(`${text.slice(0, 4096)}...[truncated, ${text.length} total]`)
    expect(JSON.stringify(data.params ?? {})).not.toContain('TAILWORD')
  })

  it('leaves params.query and params.body_form as they were', () => {
    expect(send(JSON_TYPE, '{"a":1}', 'http://10.0.0.5:8080/api/items?page=2').params).toEqual({ query: { page: '2' } })
    expect(send('application/x-www-form-urlencoded', 'q=openssh&page=2').params).toEqual({ body_form: { q: 'openssh', page: '2' } })
  })

  it('still gives a body that is not JSON its raw preview, which is the preview text', () => {
    const text = '{"user": '
    const data = send(JSON_TYPE, text)
    expect(data.params).toEqual({ body_raw: text })
    expect(data.request_body_preview).toBe(text)
  })

  it('classifies a valid integer longer than Python converts as JSON, not as a raw body', () => {
    // json.loads alone raises ValueError past 4,300 digits; the addon's parse
    // never converts a number, so the answer is the one for valid JSON.
    const text = `[${'9'.repeat(5000)}]`
    expect(send(JSON_TYPE, text).params).toBeUndefined()
    expect(send(JSON_TYPE, '[1,]').params).toEqual({ body_raw: '[1,]' })
  })

  it('sends a body nested 2,000 levels deep, flat in the event', () => {
    const text = '['.repeat(2000) + ']'.repeat(2000)
    const data = send(JSON_TYPE, text)
    expect((data.request_body as { data: string }).data).toBe(text)
    expect(data.request_body_preview).toBe(text)
    expect(data.params).toBeUndefined()
    // The loopback API refuses an event nested past 64 levels.
    expect(jsonDepthExceeds(JSON.stringify({ agent_type: 'scanner', data }))).toBe(false)
  })

  it('still sends the event when json.loads overflows its recursion limit', () => {
    // A million levels overflows json.loads on every Python we run under, so
    // this reaches the RecursionError path whichever version is installed.
    const text = '['.repeat(1_000_000) + ']'.repeat(1_000_000)
    const data = send(JSON_TYPE, text)
    expect((data.request_body as { size: number }).size).toBe(2_000_000)
    expect(data.params).toBeUndefined()
  }, 30000)
})
