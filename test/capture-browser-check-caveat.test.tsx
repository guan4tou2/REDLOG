// @vitest-environment jsdom
//
// RedLog's capture browser now trusts the managed proxy's CA by its key
// (capture-browser-ca-pin.test.ts), so an HTTPS check it passes no longer
// needs the CA in the OS trust store. That check still proves HTTPS capture
// works in that browser; it says nothing about curl, a scanner or the
// operator's own browser. Until the pin, only `ignoreCertErrors` made that so,
// and the card's caveat keyed on it alone, so a pinned check would have read as
// "the machine trusts the CA".

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { HttpCaptureStep } from '../src/renderer/src/components/HttpCaptureStep'
import type { HttpVerifyReport } from '../src/core/http-verify'

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

async function mount(): Promise<(r: HttpVerifyReport) => void> {
  let deliver: (r: HttpVerifyReport) => void = () => {}
  ;(window as unknown as { redlog: unknown }).redlog = {
    runtime: {
      preflight: vi.fn(async () => ({ platform: 'win32', checks: [{ id: 'mitmdump', found: true }] }))
    },
    httpCapture: {
      status: vi.fn(async () => ({ state: 'running', url: 'http://127.0.0.1:6661' })),
      start: vi.fn(),
      verifyInBrowser: vi.fn(async () => ({ ok: true })),
      onVerify: (cb: (r: HttpVerifyReport) => void) => { deliver = cb; return () => {} }
    },
    config: { get: async () => ({}) },
    clipboard: { writeText: vi.fn(async () => true) },
    app: { openExternal: vi.fn(async () => undefined) }
  }
  render(<I18nProvider><HttpCaptureStep onPrepare={() => {}} /></I18nProvider>)
  await screen.findByTestId('first-run-http-checks')
  return (r) => act(() => deliver(r))
}

const httpsFrom = (userAgent: string): HttpVerifyReport => ({
  scheme: 'https',
  nonce: screen.getByTestId('first-run-http').dataset.nonce,
  userAgent,
  receivedAt: Date.now()
})

afterEach(() => { cleanup(); localStorage.clear() })

describe('an HTTPS check, now that the capture browser trusts the CA by itself', () => {
  it('from the capture browser says it does not show other tools trust the CA', async () => {
    localStorage.setItem('redlog-locale', 'en')
    const deliver = await mount()
    screen.getByRole('button', { name: 'RedLog capture browser' }).click()
    ;(await screen.findByTestId('first-run-http-verify-browser')).click()
    await waitFor(() => expect(window.redlog.httpCapture.verifyInBrowser).toHaveBeenCalled())
    deliver(httpsFrom(CHROME))
    expect(screen.getByTestId('first-run-http-check-https').dataset.verified).toBe('true')
    expect(screen.getByTestId('first-run-http-check-https-caveat')).toBeTruthy()
    expect(screen.getByTestId('first-run-http-status').dataset.caTrust).toBe('unproven')
  })

  it('from the operator\'s own browser carries no such caveat', async () => {
    localStorage.setItem('redlog-locale', 'en')
    const deliver = await mount()
    ;(await screen.findByTestId('first-run-http-verify-own')).click()
    await waitFor(() => expect(window.redlog.app.openExternal).toHaveBeenCalled())
    deliver(httpsFrom(CHROME))
    expect(screen.getByTestId('first-run-http-check-https').dataset.verified).toBe('true')
    expect(screen.queryByTestId('first-run-http-check-https-caveat')).toBeNull()
    expect(screen.getByTestId('first-run-http-status').dataset.caTrust).toBe('proven')
  })
})
