// Which browser proxy URL RedLog owns (Spec 019 FR-007): http on loopback, on
// the capture port. Burp on another port, or a remote proxy, is the operator's
// and is used as typed.
//
// No imports: the renderer bundles this file.

export function isManagedLoopbackProxy(proxyUrl: string, port: number): boolean {
  try {
    const parsed = new URL(proxyUrl)
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      && Number(parsed.port || 80) === port
  } catch {
    return false
  }
}

// FR-008: the capture port is the one source of truth, so moving it moves a
// browser proxy that pointed at the old managed endpoint. Anything else stays.
export function followCapturePort(proxyUrl: string, from: number, to: number): string {
  if (from === to || !isManagedLoopbackProxy(proxyUrl, from)) return proxyUrl
  const parsed = new URL(proxyUrl)
  parsed.port = String(to)
  return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
}
