// HTTP(S) capture verification (#220).
//
// "HTTP capture works" used to mean "some HTTP event arrived", and the capture
// browser makes its own requests the moment it starts (#182), so the check
// could pass before the operator's client had sent anything. It also could not
// tell HTTP from HTTPS, or a CA file on disk from a client that trusts it.
//
// A check is now a request for a per-attempt nonce on a reserved host. The
// mitmproxy addon answers it itself — `.invalid` never resolves, so nothing
// leaves the machine — and reports it here instead of recording it as traffic.
// Background requests cannot carry the nonce, so they cannot verify anything.
// An HTTPS request only reaches the addon if the client completed a TLS
// handshake with RedLog's CA; one that refuses the certificate is reported as
// a rejection.

export const VERIFY_HOST = 'redlog.verify.invalid'

export type VerifyScheme = 'http' | 'https'

export interface HttpVerifyReport {
  scheme: VerifyScheme
  /** absent on a rejection: the TLS handshake failed before any request */
  nonce?: string
  userAgent?: string
  /** the client refused RedLog's certificate for the verification host */
  rejected?: boolean
  receivedAt: number
}

const NONCE_RE = /^[A-Za-z0-9-]{8,64}$/

export function isVerifyNonce(v: unknown): v is string {
  return typeof v === 'string' && NONCE_RE.test(v)
}

export function newVerifyNonce(random: () => number = Math.random): string {
  let out = ''
  while (out.length < 12) out += Math.floor(random() * 36).toString(36)
  return `rv-${out.slice(0, 12)}`
}

export function verifyUrl(scheme: VerifyScheme, nonce: string): string {
  return `${scheme}://${VERIFY_HOST}/${nonce}`
}

/** A URL on the verification host. Used to keep checks out of the record. */
export function isVerifyUrl(url: string): boolean {
  try { return new URL(url).hostname === VERIFY_HOST } catch { return false }
}

/** Validate what the addon posted. Anything malformed is dropped rather than
 *  shown: a check that cannot be matched to an attempt proves nothing. */
export function parseVerifyReport(body: unknown, now: number = Date.now()): HttpVerifyReport | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.scheme !== 'http' && b.scheme !== 'https') return null
  const userAgent = typeof b.user_agent === 'string' ? b.user_agent.slice(0, 200) : undefined
  if (b.rejected === true) {
    // Only HTTPS has a handshake to refuse.
    return b.scheme === 'https' ? { scheme: 'https', rejected: true, receivedAt: now } : null
  }
  if (!isVerifyNonce(b.nonce)) return null
  return { scheme: b.scheme, nonce: b.nonce, ...(userAgent ? { userAgent } : {}), receivedAt: now }
}

/** A short name for the client that sent a check, for "verified via …". */
export function clientLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'unknown client'
  const m = /^(curl|Wget|python-requests|python-urllib3|Python-urllib|Go-http-client|node-fetch|axios|undici|PowerShell)[/ ]?([\d.]*)/i.exec(userAgent)
  if (m) return m[2] ? `${m[1]}/${m[2]}` : m[1]
  if (/HeadlessChrome|Chrome\/|Chromium\/|Edg\//.test(userAgent)) return 'Chromium'
  if (/Firefox\//.test(userAgent)) return 'Firefox'
  return userAgent.split(/[\s(]/)[0].slice(0, 40) || 'unknown client'
}
