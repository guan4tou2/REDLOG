// Spec 039 / #220: what "HTTP capture works" means.
//
// A running proxy proves only that mitmdump is listening. The proof used to be
// "any HTTP event arrived" — and the capture browser sends its own requests the
// moment it starts (#182), so the check could pass before the operator's client
// had sent anything, and it said nothing about HTTPS.
//
// Now each attempt has a nonce, and only a request for that nonce on the
// reserved verification host counts (core/http-verify.ts). HTTP and HTTPS are
// verified separately, and each says which client sent it: an HTTPS check from
// RedLog's own browser, which ignores certificate errors, is not evidence that
// anything else on the machine trusts the CA.

import { clientLabel, verifyUrl, type HttpVerifyReport, type VerifyScheme } from '../../../core/http-verify'

export interface VerifyAttempt {
  nonce: string
  startedAt: number
  http: HttpVerifyReport | null
  https: HttpVerifyReport | null
  /** a client refused RedLog's certificate for the verification host, during
   *  this attempt and before HTTPS verified */
  rejectedAt: number | null
}

export function newAttempt(nonce: string, now: number = Date.now()): VerifyAttempt {
  return { nonce, startedAt: now, http: null, https: null, rejectedAt: null }
}

/** Fold one report into the attempt. A report for another nonce — an earlier
 *  attempt, another window — changes nothing. */
export function applyVerifyReport(a: VerifyAttempt, r: HttpVerifyReport): VerifyAttempt {
  if (r.rejected) {
    if (a.https || r.receivedAt < a.startedAt) return a
    return { ...a, rejectedAt: r.receivedAt }
  }
  if (r.nonce !== a.nonce) return a
  if (r.scheme === 'http') return a.http ? a : { ...a, http: r }
  return a.https ? a : { ...a, https: r, rejectedAt: null }
}

/** Only RedLog's capture browser is launched with certificate errors ignored,
 *  so an HTTPS check it passed says nothing about the CA being trusted. */
export function httpsProvesTrust(report: HttpVerifyReport, captureBrowserIgnoresCertErrors: boolean): boolean {
  return !(captureBrowserIgnoresCertErrors && clientLabel(report.userAgent) === 'Chromium')
}

/** A check to run from a terminal. No `-k`: an HTTPS check that skips
 *  certificate verification would prove nothing about trust. Windows
 *  PowerShell aliases `curl` to Invoke-WebRequest, so name the real one. */
export function verifyCommand(scheme: VerifyScheme, nonce: string, proxyUrl: string, os: 'win32' | 'darwin' | 'linux'): string {
  const curl = os === 'win32' ? 'curl.exe' : 'curl'
  return `${curl} -sS -x ${proxyUrl} ${verifyUrl(scheme, nonce)}`
}

export type HttpTimeoutReason = 'browser' | 'ca' | 'caRejected' | 'terminalsOff' | 'terminalsNew'

/** Reasons that apply to this machine's state, most likely first. The browser
 *  is always listed: a browser RedLog did not launch does not use the proxy. */
export function httpTimeoutReasons(state: { certReady?: boolean; routeTerminals: boolean; rejected?: boolean }): HttpTimeoutReason[] {
  const reasons: HttpTimeoutReason[] = []
  if (state.rejected) reasons.push('caRejected')
  reasons.push('browser')
  if (state.certReady === false) reasons.push('ca')
  reasons.push(state.routeTerminals ? 'terminalsNew' : 'terminalsOff')
  return reasons
}
