// @vitest-environment jsdom
//
// The Capture Health card used to say two things about HTTP at once: a line
// reading "Managed HTTP proxy is listening" above a mitmproxy row reading
// "idle". Both were true and neither answered the operator's question. This
// proves the card now speaks once, and that the state it could never express —
// proxy up, nothing ever captured — is on screen and explained.

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'

const mitm = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'mitmproxy',
  hookId: 'mitmproxy',
  installed: true,
  state: 'idle',
  lastEventAt: null,
  ...over
})

function draw(sources: Record<string, unknown>[], managedHttpProxy?: Record<string, unknown>): HTMLElement {
  const capture = {
    verdict: 'partial',
    recording: false,
    sources,
    lastEventAt: null,
    checkedAt: 1,
    ...(managedHttpProxy ? { managedHttpProxy } : {})
  }
  const { container } = render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={() => {}} />
    </I18nProvider>
  )
  return container
}

describe('the mitmproxy row on the Capture Health card', () => {
  beforeEach(() => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      config: { get: async () => ({}), save: async () => true },
      hooks: { install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) }
    }
  })
  afterEach(() => cleanup())

  it('says the proxy is up and has captured nothing, and why that happens', () => {
    const el = draw([mitm()], { state: 'running', url: 'http://127.0.0.1:6661' })
    expect(el.querySelector('[data-testid="capture-state-mitmproxy"]')?.textContent)
      .toMatch(/listening, nothing captured/)
    const why = el.querySelector('[data-testid="capture-http-listening"]')
    expect(why, 'the operator cannot act on a status word alone').toBeTruthy()
    expect(why?.textContent).toMatch(/CA is trusted/)
  })

  it('no longer carries a second, separate sentence about the same proxy', () => {
    // "Managed HTTP proxy is listening" over a row reading "idle".
    const text = draw([mitm()], { state: 'running', url: null }).textContent ?? ''
    expect(text).not.toMatch(/Managed HTTP proxy/)
  })

  it('drops the explanation once traffic has actually come through', () => {
    const el = draw([mitm({ state: 'active', lastEventAt: Date.now() })], { state: 'running', url: null })
    // The card is an exception report, so a working source leaves the compact
    // view entirely — and takes the amber warning with it.
    expect(el.querySelector('[data-testid="capture-row-mitmproxy"]')).toBeNull()
    expect(el.querySelector('[data-testid="capture-http-listening"]')).toBeNull()
    // It is still listed, correctly, in the full inventory.
    fireEvent.click(within(el).getByText(/all sources/))
    expect(el.querySelector('[data-testid="capture-state-mitmproxy"]')?.textContent).toMatch(/capturing/)
  })

  it('reports a missing mitmdump as not installed, and still shows a start failure', () => {
    const absent = draw([mitm()], { state: 'unavailable', url: null, error: 'spawn mitmdump ENOENT' })
    expect(absent.querySelector('[data-testid="capture-state-mitmproxy"]')?.textContent)
      .toMatch(/not installed/)

    const failed = draw([mitm()], { state: 'failed', url: null, error: '127.0.0.1:6661 is already in use by BurpSuite.exe' })
    expect(failed.querySelector('[data-testid="capture-state-mitmproxy"]')?.textContent).toMatch(/failed/)
    // The reason has to survive the removal of the line that used to carry it.
    expect(failed.textContent).toMatch(/already in use by BurpSuite\.exe/)
  })
})
