// Which browser proxy URL RedLog owns (Spec 019 FR-007): the managed capture
// endpoint. Burp on another port, or a remote proxy, is the operator's and is
// used as typed.
//
// The endpoint is host AND port. It was port alone, with `127.0.0.1` written
// into the mitmdump args, the advertised URL and this matcher, so the proxy
// could only ever be reached from the machine RedLog runs on. That rules out
// the cases a capture proxy is most wanted for — a victim VM, a phone, a lab
// segment, a container — and, on Windows, WSL: a NAT'd distro cannot reach the
// host's loopback, so RedLog offered WSL shells in its own picker while
// binding the proxy where those shells could not see it.
//
// No imports: the renderer bundles this file.

export interface CaptureEndpoint {
  host: string
  port: number
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** A host that only the local machine can reach. `0.0.0.0` and a LAN address
 *  are not: binding there exposes an open proxy on the engagement network. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase())
}

export function managedProxyUrl(endpoint: CaptureEndpoint): string {
  // A bare IPv6 address needs brackets in a URL.
  const host = endpoint.host.includes(':') && !endpoint.host.startsWith('[')
    ? `[${endpoint.host}]`
    : endpoint.host
  return `http://${host}:${endpoint.port}`
}

/** Does this proxy URL point at the endpoint RedLog manages? */
export function isManagedProxy(proxyUrl: string, endpoint: CaptureEndpoint): boolean {
  try {
    const parsed = new URL(proxyUrl)
    if (parsed.protocol !== 'http:') return false
    if (Number(parsed.port || 80) !== endpoint.port) return false
    const a = parsed.hostname.toLowerCase()
    const b = endpoint.host.trim().toLowerCase().replace(/^\[|\]$/g, '')
    // Loopback spellings are interchangeable: a browser configured for
    // `localhost` is pointed at a proxy bound to `127.0.0.1`.
    if (isLoopbackHost(a) && isLoopbackHost(b)) return true
    return a === b
  } catch {
    return false
  }
}

/** Back-compat shim for callers that only know about the port. */
export function isManagedLoopbackProxy(proxyUrl: string, port: number): boolean {
  return isManagedProxy(proxyUrl, { host: '127.0.0.1', port })
}

// FR-008: the capture endpoint is the one source of truth, so moving it moves
// a browser proxy that pointed at the old managed endpoint. Anything else
// stays as the operator typed it.
export function followCaptureEndpoint(
  proxyUrl: string,
  from: CaptureEndpoint,
  to: CaptureEndpoint
): string {
  if (from.host === to.host && from.port === to.port) return proxyUrl
  if (!isManagedProxy(proxyUrl, from)) return proxyUrl
  // Only the port moved, and both spellings of loopback mean the same thing,
  // so keep the one the operator typed: a browser configured for
  // `http://localhost:8080` should read `http://localhost:9090`, not be
  // rewritten to an address they did not choose.
  if (from.host === to.host) {
    try {
      const parsed = new URL(proxyUrl)
      parsed.port = String(to.port)
      return `${parsed.protocol}//${parsed.host}`
    } catch { /* fall through to a rebuild */ }
  }
  return managedProxyUrl(to)
}

/** Back-compat shim: move the port, keeping loopback. */
export function followCapturePort(proxyUrl: string, from: number, to: number): string {
  return followCaptureEndpoint(proxyUrl, { host: '127.0.0.1', port: from }, { host: '127.0.0.1', port: to })
}
