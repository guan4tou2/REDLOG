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
  state: 'ready',
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

  it('says a running proxy is running, with nothing to add about traffic', () => {
    // It used to read "listening, nothing captured" with an amber warning
    // beneath it. That graded the operator's traffic, not RedLog's capture: a
    // proxy nobody has sent a request to is working exactly as Burp's
    // listener does. The card has no row for it at all now — nothing is wrong
    // — and the inventory says it plainly.
    const el = draw([mitm()], { state: 'running', url: 'http://127.0.0.1:6661' })
    expect(el.querySelector('[data-testid="capture-row-mitmproxy"]')).toBeNull()
    fireEvent.click(within(el).getByText(/all sources/))
    expect(el.querySelector('[data-testid="capture-state-mitmproxy"]')?.textContent).toMatch(/capturing/)
  })

  it('no longer carries a second, separate sentence about the same proxy', () => {
    // "Managed HTTP proxy is listening" over a row reading "idle".
    const text = draw([mitm()], { state: 'running', url: null }).textContent ?? ''
    expect(text).not.toMatch(/Managed HTTP proxy/)
  })

  it('keeps a working proxy out of the compact view entirely', () => {
    const el = draw([mitm({ state: 'ready', lastEventAt: Date.now() })], { state: 'running', url: null })
    // The card is an exception report, so a working source leaves the compact
    // view entirely.
    expect(el.querySelector('[data-testid="capture-row-mitmproxy"]')).toBeNull()
    // It is still listed, correctly, in the full inventory.
    fireEvent.click(within(el).getByText(/all sources/))
    expect(el.querySelector('[data-testid="capture-state-mitmproxy"]')?.textContent).toMatch(/capturing/)
  })

  it('reports a missing mitmdump as not set up, and still shows a start failure', () => {
    // Missing is not broken: nothing failed, mitmproxy was simply never
    // installed, so it does not take a slot in the exception list. The full
    // inventory still says so, in the one word the state axis now has for it.
    const absent = draw([mitm()], { state: 'unavailable', url: null, error: 'spawn mitmdump ENOENT' })
    expect(absent.querySelector('[data-testid="capture-row-mitmproxy"]')).toBeNull()
    fireEvent.click(within(absent).getByText(/all sources/))
    expect(absent.querySelector('[data-testid="capture-state-mitmproxy"]')?.textContent)
      .toMatch(/not installed/)
    cleanup()

    // A proxy that could not start is on the core line, word and reason — not
    // on a row of its own repeating it.
    const failed = draw([mitm()], { state: 'failed', url: null, error: '127.0.0.1:6661 is already in use by BurpSuite.exe' })
    const core = failed.querySelector('[data-testid="capture-core-http"]')
    expect(core?.textContent).toMatch(/failed/)
    expect(core?.textContent).toMatch(/already in use by BurpSuite\.exe/)
    expect(failed.textContent?.match(/already in use/g)).toHaveLength(1)
  })
})
