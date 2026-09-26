// Spec 039 / #220: what counts as "HTTP(S) capture works", and which reasons
// apply when it has not.
//
// It used to be "any HTTP event arrived", and the capture browser sends its
// own requests the moment it starts (#182) — so the check could pass before
// the operator's client had sent anything. Now only a request carrying this
// attempt's nonce counts, and HTTP and HTTPS are verified separately.
import { describe, it, expect } from 'vitest'
import {
  applyVerifyReport, httpTimeoutReasons, httpsProvesTrust, newAttempt, verifyCommand
} from '../src/renderer/src/lib/httpVerification'
import {
  clientLabel, isVerifyUrl, newVerifyNonce, parseVerifyReport, verifyUrl, VERIFY_HOST
} from '../src/core/http-verify'

const NONCE = 'rv-abcdef123456'

describe('a verification attempt', () => {
  it('counts only a report for its own nonce', () => {
    const a = newAttempt(NONCE, 100)
    const other = applyVerifyReport(a, { scheme: 'http', nonce: 'rv-somebodyelse', receivedAt: 200 })
    expect(other.http).toBeNull()
    const mine = applyVerifyReport(a, { scheme: 'http', nonce: NONCE, userAgent: 'curl/8.5.0', receivedAt: 200 })
    expect(mine.http?.userAgent).toBe('curl/8.5.0')
    expect(mine.https).toBeNull()
  })

  it('verifies HTTP and HTTPS separately, and keeps the first client for each', () => {
    let a = newAttempt(NONCE, 100)
    a = applyVerifyReport(a, { scheme: 'https', nonce: NONCE, userAgent: 'curl/8.5.0', receivedAt: 150 })
    expect(a.http).toBeNull()
    expect(a.https?.userAgent).toBe('curl/8.5.0')
    a = applyVerifyReport(a, { scheme: 'https', nonce: NONCE, userAgent: 'Mozilla/5.0 Chrome/140', receivedAt: 160 })
    expect(a.https?.userAgent).toBe('curl/8.5.0')
  })

  it('records a certificate rejection during the attempt, and clears it once HTTPS verifies', () => {
    let a = newAttempt(NONCE, 100)
    expect(applyVerifyReport(a, { scheme: 'https', rejected: true, receivedAt: 50 }).rejectedAt).toBeNull()
    a = applyVerifyReport(a, { scheme: 'https', rejected: true, receivedAt: 120 })
    expect(a.rejectedAt).toBe(120)
    a = applyVerifyReport(a, { scheme: 'https', nonce: NONCE, receivedAt: 130 })
    expect(a.rejectedAt).toBeNull()
    expect(applyVerifyReport(a, { scheme: 'https', rejected: true, receivedAt: 140 }).rejectedAt).toBeNull()
  })

  it('does not take an HTTPS check from the capture browser as proof the CA is trusted', () => {
    const chrome = { scheme: 'https' as const, nonce: NONCE, userAgent: 'Mozilla/5.0 (X11) AppleWebKit Chrome/140.0 Safari/537.36', receivedAt: 1 }
    const curl = { scheme: 'https' as const, nonce: NONCE, userAgent: 'curl/8.5.0', receivedAt: 1 }
    expect(httpsProvesTrust(chrome, true)).toBe(false)
    expect(httpsProvesTrust(chrome, false)).toBe(true)
    expect(httpsProvesTrust(curl, true)).toBe(true)
  })
})

describe('the verification request', () => {
  it('is a reserved, non-resolving host with the nonce as the path', () => {
    expect(VERIFY_HOST.endsWith('.invalid')).toBe(true)
    expect(verifyUrl('https', NONCE)).toBe(`https://redlog.verify.invalid/${NONCE}`)
    expect(isVerifyUrl(verifyUrl('http', NONCE))).toBe(true)
    expect(isVerifyUrl('https://example.com/redlog.verify.invalid')).toBe(false)
    expect(isVerifyUrl('not a url')).toBe(false)
  })

  it('mints nonces the addon accepts, and different ones each time', () => {
    const a = newVerifyNonce()
    expect(a).toMatch(/^rv-[a-z0-9]{12}$/)
    expect(newVerifyNonce()).not.toBe(a)
  })

  it('never skips certificate checks in the terminal command', () => {
    for (const os of ['win32', 'darwin', 'linux'] as const) {
      const cmd = verifyCommand('https', NONCE, 'http://127.0.0.1:6661', os)
      expect(cmd, os).not.toMatch(/\s-k\b|--insecure/)
      expect(cmd, os).toContain(`-x http://127.0.0.1:6661 https://redlog.verify.invalid/${NONCE}`)
    }
    // Windows PowerShell aliases `curl` to Invoke-WebRequest.
    expect(verifyCommand('http', NONCE, 'http://127.0.0.1:6661', 'win32')).toMatch(/^curl\.exe /)
  })
})

describe('what the addon reports', () => {
  it('accepts a nonce report and a rejection, and nothing malformed', () => {
    expect(parseVerifyReport({ scheme: 'http', nonce: NONCE, user_agent: 'curl/8.5.0' }, 7))
      .toEqual({ scheme: 'http', nonce: NONCE, userAgent: 'curl/8.5.0', receivedAt: 7 })
    expect(parseVerifyReport({ scheme: 'https', rejected: true }, 7)).toEqual({ scheme: 'https', rejected: true, receivedAt: 7 })
    expect(parseVerifyReport({ scheme: 'http', rejected: true })).toBeNull()
    expect(parseVerifyReport({ scheme: 'http', nonce: 'short' })).toBeNull()
    expect(parseVerifyReport({ scheme: 'http', nonce: 'has spaces in it' })).toBeNull()
    expect(parseVerifyReport({ scheme: 'gopher', nonce: NONCE })).toBeNull()
    expect(parseVerifyReport(null)).toBeNull()
  })

  it('names the client briefly', () => {
    expect(clientLabel('curl/8.5.0')).toBe('curl/8.5.0')
    expect(clientLabel('python-requests/2.32.3')).toBe('python-requests/2.32.3')
    expect(clientLabel('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe('Chromium')
    expect(clientLabel('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe('Firefox')
    expect(clientLabel(undefined)).toBe('unknown client')
  })
})

describe('httpTimeoutReasons', () => {
  it('always names the browser; the CA only when it is not ready; terminals by the routing switch', () => {
    expect(httpTimeoutReasons({ certReady: true, routeTerminals: false })).toEqual(['browser', 'terminalsOff'])
    expect(httpTimeoutReasons({ certReady: false, routeTerminals: true })).toEqual(['browser', 'ca', 'terminalsNew'])
    expect(httpTimeoutReasons({ certReady: undefined, routeTerminals: true })).toEqual(['browser', 'terminalsNew'])
  })

  it('leads with a certificate rejection when one was reported', () => {
    expect(httpTimeoutReasons({ certReady: true, routeTerminals: false, rejected: true })[0]).toBe('caRejected')
  })
})
