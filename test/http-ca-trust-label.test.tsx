// @vitest-environment jsdom
//
// P1-3a. An HTTPS report proves the exchange reached the proxy. It does not
// prove the client trusts RedLog's CA — RedLog's own capture browser runs with
// certificate errors ignored, so a pass there says nothing about trust.
//
// `httpsProvesTrust` already knew this (test/http-verification.test.ts:47), and
// the caveat was already rendered under the report. The status label was not:
// it read "✓ Verified" in emerald either way, so the one line most likely to be
// glanced at disagreed with the paragraph beneath it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { HttpCaptureStep } from '../src/renderer/src/components/HttpCaptureStep'

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

function mount(opts: { ignoreCertErrors: boolean }): (report: unknown) => void {
  let deliver: ((report: unknown) => void) | null = null
  const status = { state: 'running', url: 'http://127.0.0.1:8080', caFingerprint: { sha256: 'aa' } }
  ;(window as unknown as { redlog: unknown }).redlog = {
    runtime: {
      preflight: vi.fn(async () => ({
        platform: 'linux',
        shell: { name: 'zsh', hookId: 'shell-zsh' },
        checks: [{ id: 'mitmdump', found: true, neededFor: ['mitmproxy'], remediation: 'uv tool install mitmproxy' }]
      })),
      install: vi.fn()
    },
    httpCapture: {
      status: vi.fn(async () => status),
      start: vi.fn(),
      stop: vi.fn(),
      verifyInBrowser: vi.fn(),
      onVerify: (fn: (report: unknown) => void) => {
        deliver = fn
        return () => { deliver = null }
      }
    },
    config: { get: async () => ({ browser: { ignoreCertErrors: opts.ignoreCertErrors } }), save: vi.fn(async () => true) },
    clipboard: { writeText: vi.fn(async () => true), readText: async () => '' },
    app: { openExternal: vi.fn() }
  }
  render(<I18nProvider><HttpCaptureStep /></I18nProvider>)
  return (report) => deliver?.(report)
}

const nonceOf = (): string => screen.getByTestId('first-run-http').getAttribute('data-nonce') ?? ''

/** Delivers the report against the nonce the card holds right now, retrying
 *  until it sticks. The card resets its attempt when the proxy status or the
 *  CA policy arrives, so a nonce read before that lands belongs to an attempt
 *  that no longer exists. */
async function deliverUntilApplied(
  deliver: (report: unknown) => void,
  expectTrust: 'proven' | 'unproven'
): Promise<HTMLElement> {
  await waitFor(() => {
    deliver({ scheme: 'https', nonce: nonceOf(), userAgent: CHROME_UA, receivedAt: Date.now() })
    expect(screen.getByTestId('first-run-http-status').getAttribute('data-ca-trust')).toBe(expectTrust)
  })
  return screen.getByTestId('first-run-http-status')
}

beforeEach(() => { localStorage.setItem('redlog-locale', 'zh-TW') })
afterEach(() => { cleanup(); localStorage.clear() })

describe('the HTTP card separates capture from CA trust', () => {
  it('does not call a capture-browser check verified when the CA trust was not shown', async () => {
    const deliver = mount({ ignoreCertErrors: true })
    await screen.findByTestId('first-run-http-status')

    const status = await deliverUntilApplied(deliver, 'unproven')
    expect(status.textContent).toBe('◐ 已擷取 · CA 未驗證')
    expect(status.textContent).not.toContain('已驗證')
  })

  it('says verified only when the client is one that does not ignore certificate errors', async () => {
    const deliver = mount({ ignoreCertErrors: false })
    await screen.findByTestId('first-run-http-status')

    const status = await deliverUntilApplied(deliver, 'proven')
    expect(status.textContent).toBe('✓ 已驗證')
  })
})
