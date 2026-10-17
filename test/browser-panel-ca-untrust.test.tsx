// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import BrowserPanel from '../src/renderer/src/components/settings/BrowserPanel'

// The command that takes the CA out again is shown beside the one that trusts
// it on the first-run screen. The settings page is where an operator comes
// back to when the engagement ends, so it has to carry the same command.

const t = (key: string): string => key
const FP = { sha1: 'AA'.repeat(20), sha256: 'BB'.repeat(32) }

const draw = (status: Record<string, unknown>): void => {
  ;(window as unknown as { redlog: unknown }).redlog = {
    browser: { detect: async () => null },
    httpCapture: { status: async () => status }
  }
  render(<I18nProvider><BrowserPanel t={t} config={{} as never} setConfig={() => {}} /></I18nProvider>)
}

afterEach(() => cleanup())

describe('settings: removing the CA trust', () => {
  it('shows the by-fingerprint removal command once the CA has a fingerprint', async () => {
    draw({ state: 'stopped', url: null, certReady: true, caPath: '/home/u/.mitmproxy/mitmproxy-ca-cert.pem', caFingerprint: FP })
    const box = await screen.findByTestId('http-capture-untrust')
    // Whichever OS runs this, the command names the CA by its own fingerprint
    // (Linux uses the first 16 hex digits in the file name it created).
    expect(box.textContent).toMatch(new RegExp(`${FP.sha1}|redlog-mitmproxy-${'aa'.repeat(8)}`))
    expect(box.textContent).toContain('httpCapture.caUntrust')
    // The command that trusts it is there too: the settings page is the only
    // place left to find it once the first-run card is gone.
    expect(box.textContent).toContain('httpCapture.caTrust')
  })

  it('shows nothing without a fingerprint: RedLog does not offer to remove a CA it cannot identify', async () => {
    draw({ state: 'stopped', url: null, certReady: true, caPath: '/home/u/.mitmproxy/mitmproxy-ca-cert.pem' })
    await waitFor(() => expect(screen.getByText('httpCapture.caReady')).toBeTruthy())
    expect(screen.queryByTestId('http-capture-untrust')).toBeNull()
  })

  it('shows the listener address to put in your own browser, only while it is running', async () => {
    draw({ state: 'running', url: 'http://127.0.0.1:6661', certReady: true, caPath: '/home/u/.mitmproxy/mitmproxy-ca-cert.pem' })
    const row = await screen.findByTestId('http-capture-listener')
    expect(row.textContent).toContain('127.0.0.1:6661')
    cleanup()
    draw({ state: 'stopped', url: null })
    await waitFor(() => expect(screen.queryByTestId('http-capture-listener')).toBeNull())
  })
})
