// @vitest-environment jsdom
//
// Comparing what went out with what came back is the entire reason an
// operator opens an HTTP flow, and both halves were rendering in one column:
// the event's own, then its partner appended underneath. On a 440px pane the
// response body began somewhere below a request that had its own params,
// headers and body, so the comparison was a scroll rather than a glance.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { HttpDetail } from '../src/renderer/src/components/HttpDetail'

const REQUEST = {
  subtype: 'http_request_start',
  flow_id: 'f1',
  method: 'POST',
  url: 'https://10.10.4.12/api/v1/login',
  request_body_preview: 'REQUEST-BODY-MARKER'
}
const RESPONSE = {
  subtype: 'http_response',
  flow_id: 'f1',
  status: 200,
  response_preview: 'RESPONSE-BODY-MARKER'
}

function bridge(partner: Record<string, unknown> | null): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryByFlowId: vi.fn(async () => partner ? [{ id: 'other', data: partner }] : [])
    },
    httpBody: { read: vi.fn(async () => null) },
    content: {
      list: vi.fn(async ({ projectId, eventId }: { projectId: string; eventId: string }) => ({ ok: true, value: [{ field: 'response_body', status: 'available', ref: { projectId, eventId, field: 'response_body', version: 'saved' }, bytes: 42, format: 'utf8', capture: 'unknown' }] })),
      read: vi.fn(async () => ({ ok: true, value: { offset: 0, end: 27, total: 27, text: 'complete paired sidecar END', format: 'utf8', hasMore: false, nextCursor: null } }))
    }
  }
}

const draw = (data: Record<string, unknown>): void => {
  render(<I18nProvider><HttpDetail projectId="project" data={data} eventId="self" /></I18nProvider>)
}

beforeEach(() => localStorage.setItem('redlog-locale', 'zh-TW'))
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

describe('an HTTP flow with both halves', () => {
  it('opens on the half the operator clicked, not always the request', async () => {
    // They selected a response row. Landing them on the request would make
    // them click back to what they asked for.
    bridge(REQUEST)
    draw(RESPONSE)
    await screen.findByTestId('http-tab-response')
    expect(screen.getByTestId('http-tab-response').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/RESPONSE-BODY-MARKER/)).toBeTruthy()
  })

  it('shows one half at a time', async () => {
    bridge(RESPONSE)
    draw(REQUEST)
    await screen.findByTestId('http-tab-request')
    expect(screen.getByText(/REQUEST-BODY-MARKER/)).toBeTruthy()
    expect(screen.queryByText(/RESPONSE-BODY-MARKER/)).toBeNull()
  })

  it('shows the paired full request body and its capture warning, not only a preview', async () => {
    bridge({ ...REQUEST, request_body: { data: 'complete paired request END', encoding: 'text', size: 27, truncated: true } })
    draw(RESPONSE)
    fireEvent.click(await screen.findByTestId('http-tab-request'))
    expect(await screen.findByText('complete paired request END')).toBeTruthy()
    expect(screen.getByText(/已截斷/)).toBeTruthy()
    expect(screen.queryByText('REQUEST-BODY-MARKER')).toBeNull()
  })

  it('can explicitly load the paired response sidecar', async () => {
    bridge({ ...RESPONSE, response_body_ref: { sha256: 'f'.repeat(64), file: 'http-bodies/test.txt', size: 42, encoding: 'text' } })
    draw(REQUEST)
    fireEvent.click(await screen.findByTestId('http-tab-response'))
    fireEvent.click(screen.getByRole('button', { name: '已保存內容' }))
    expect(await screen.findByText('complete paired sidecar END')).toBeTruthy()
    expect(window.redlog.content.list).toHaveBeenCalledWith({ projectId: 'project', eventId: 'other' })
    expect(window.redlog.httpBody.read).not.toHaveBeenCalled()
  })

  it('keeps the selected half readable and offers retry when its partner cannot be queried', async () => {
    bridge(REQUEST)
    vi.mocked(window.redlog.events.queryByFlowId).mockRejectedValueOnce(new Error('read failed'))
    draw(RESPONSE)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/RESPONSE-BODY-MARKER/)).toBeTruthy()
    expect(screen.queryByTestId('http-tab-request')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重試' }))
    expect(await screen.findByTestId('http-tab-request')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('swaps on click', async () => {
    bridge(RESPONSE)
    draw(REQUEST)
    fireEvent.click(await screen.findByTestId('http-tab-response'))
    await waitFor(() => expect(screen.getByText(/RESPONSE-BODY-MARKER/)).toBeTruthy())
    expect(screen.queryByText(/REQUEST-BODY-MARKER/)).toBeNull()
  })
})

describe('a flow with only one half', () => {
  it('shows the complete inline text body without a second load action', () => {
    bridge(null)
    draw({ ...RESPONSE, content_length: 30, response_preview: 'short preview', response_body: { data: 'complete response including END', encoding: 'text', size: 30 } })
    expect(screen.getByText('complete response including END')).toBeTruthy()
    expect(screen.queryByText(/載入完整主體/)).toBeNull()
    expect(window.redlog.httpBody.read).not.toHaveBeenCalled()
  })

  it('keeps binary inline bodies behind the explicit load action', () => {
    bridge(null)
    draw({ ...RESPONSE, response_preview: 'binary preview', response_body: { data: 'AAEC', encoding: 'base64', size: 3 } })
    expect(screen.queryByText('AAEC')).toBeNull()
    expect(screen.getByRole('button', { name: '已保存內容' })).toBeTruthy()
  })

  it('shows an inline request body immediately and preserves its capture truncation warning', () => {
    bridge(null)
    draw({ ...REQUEST, request_body: { data: 'saved request bytes', encoding: 'text', size: 19, truncated: true } })
    expect(screen.getByText('saved request bytes')).toBeTruthy()
    expect(screen.getByText(/已截斷/)).toBeTruthy()
    expect(screen.queryByText(/載入完整主體/)).toBeNull()
  })

  it('draws no tab strip — a single tab asks a question with one answer', async () => {
    // A request whose response has not landed yet. Common, and not a defect.
    bridge(null)
    draw(REQUEST)
    await waitFor(() => expect(screen.getByText(/REQUEST-BODY-MARKER/)).toBeTruthy())
    expect(screen.queryByTestId('http-tab-request')).toBeNull()
    expect(screen.queryByTestId('http-tab-response')).toBeNull()
  })

  it('draws none for a websocket frame either', async () => {
    bridge(null)
    draw({ subtype: 'ws_message', ws_preview: 'WS-MARKER', direction: 'client' })
    await waitFor(() => expect(screen.getByText(/WS-MARKER/)).toBeTruthy())
    expect(screen.queryByTestId('http-tab-request')).toBeNull()
  })
})

it('keeps stream completeness unknown instead of treating an ended response as complete', () => {
  bridge(null)
  draw({ ...RESPONSE, streamed: true, stream_state: 'ended', capture_delivery: 'unknown' })
  expect(screen.getByText('串流使用分段紀錄；完整性未確認。')).toBeTruthy()
})
it('shows known stream loss beside the response', () => {
  bridge(null)
  draw({ ...RESPONSE, streamed: true, stream_state: 'interrupted' })
  expect(screen.getByText('串流中斷，或有區段未排入保存。')).toBeTruthy()
})
