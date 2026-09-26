import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The addon implemented `dns_message`, which mitmproxy does not dispatch: its
// DNS layer declares `dns_request`, `dns_response` and `dns_error` and nothing
// else (verified against mitmproxy 12.2.3). So the handler was never called
// and DNS capture recorded nothing — while the proxy itself answered queries
// correctly, which is why the only symptom was an empty timeline, and an empty
// timeline reads as "the target made no lookups".
//
// A hook whose name does not match is invisible: no error, no warning, just
// silence. This pins the names the addon must expose so the next rename shows
// up here instead of in a bundle with no DNS in it.
const ADDON = readFileSync(join(__dirname, '..', 'hooks', 'mitmproxy-addon.py'), 'utf-8')

const defines = (name: string): boolean =>
  new RegExp(`^\\s{4}def ${name}\\s*\\(`, 'm').test(ADDON)

describe('the mitmproxy addon exposes the hooks mitmproxy actually calls', () => {
  it('handles DNS by request and response, not by a single message hook', () => {
    expect(defines('dns_request')).toBe(true)
    expect(defines('dns_response')).toBe(true)
  })

  it('still answers the HTTP hooks it has always used', () => {
    for (const hook of ['request', 'response', 'error', 'websocket_message', 'tcp_message']) {
      expect(defines(hook), `addon lost its ${hook} hook`).toBe(true)
    }
  })

  // #220: capture checks. `http_connect` has to accept the CONNECT for the
  // verification host itself — under the default eager strategy mitmproxy
  // otherwise dials it upstream, fails to resolve `.invalid`, and the client
  // never reaches the TLS handshake the HTTPS check exists to test (verified
  // against mitmdump 11.0.2). `tls_failed_client` is how a refused
  // certificate is reported.
  it('answers capture checks itself and keeps them out of the record', () => {
    expect(defines('http_connect')).toBe(true)
    expect(defines('tls_failed_client')).toBe(true)
    expect(ADDON).toContain('VERIFY_HOST = "redlog.verify.invalid"')
    const body = (name: string): string => ADDON.slice(ADDON.indexOf(`    def ${name}(`), ADDON.indexOf(`    def ${name}(`) + 300)
    // The check is answered before anything is recorded, and the response and
    // error hooks drop it.
    expect(body('request')).toMatch(/_answer_verification\(flow\)[\s\S]*return/)
    expect(body('response')).toContain('VERIFY_HOST')
    expect(body('error')).toContain('VERIFY_HOST')
  })

  it('routes a DNS request to the query path and a response to the response path', () => {
    // Cheap structural check: each hook body delegates to the right helper, so
    // a future edit cannot cross them over without this failing.
    const body = (name: string): string => {
      const start = ADDON.indexOf(`    def ${name}(`)
      expect(start, `no ${name} hook`).toBeGreaterThan(-1)
      return ADDON.slice(start, start + 400)
    }
    expect(body('dns_request')).toContain('_dns_query')
    expect(body('dns_response')).toContain('_dns_response')
  })
})
