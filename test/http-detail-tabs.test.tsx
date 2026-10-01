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
    httpBody: { read: vi.fn(async () => null) }
  }
}

const draw = (data: Record<string, unknown>): void => {
  render(<I18nProvider><HttpDetail data={data} eventId="self" /></I18nProvider>)
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

  it('swaps on click', async () => {
    bridge(RESPONSE)
    draw(REQUEST)
    fireEvent.click(await screen.findByTestId('http-tab-response'))
    await waitFor(() => expect(screen.getByText(/RESPONSE-BODY-MARKER/)).toBeTruthy())
    expect(screen.queryByText(/REQUEST-BODY-MARKER/)).toBeNull()
  })
})

describe('a flow with only one half', () => {
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
