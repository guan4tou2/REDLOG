// Content-Security-Policy for the two renderer entries (index.html + overlay.html).
// RedLog is a local SPA: src/main/windows.ts already denies window-open and any
// navigation off its own origin. CSP is the other half of that hardening — it
// caps what the *loaded* document may fetch or execute, so a captured link or an
// evidence body (an HTTP body, an agent transcript) rendered into the DOM can't
// pull remote script or exfiltrate. Delivered as a response header from main
// (session.webRequest.onHeadersReceived), NOT a <meta> tag, so prod and dev can
// differ: prod (file://) is locked to 'self'; dev must additionally permit the
// Vite dev server, its HMR websocket, its inline React-Refresh preamble, and
// eval-based transforms. Kept as a pure function (no electron imports) so the
// policy is unit-testable without booting a window.

// The privileged scheme screenshots are served on (see the protocol.handle in
// src/main/index.ts). Thumbnails load as <img src="redlog-screenshot://…">, so
// img-src has to name it.
const SCREENSHOT_SCHEME = 'redlog-screenshot:'

// Production: strict. No remote origin is reachable at all. 'unsafe-inline'
// survives for STYLE only — React's style={{…}} props and xterm's DOM renderer
// both write inline style attributes and there is no build-time nonce for them;
// it does NOT apply to script, so injected markup still can't execute. img-src
// adds data: (inline icons) and the screenshot scheme.
function prodCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${SCREENSHOT_SCHEME}`,
    "font-src 'self' data:",
    "media-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'"
  ].join('; ')
}

// Development: NOT a security boundary — it exists only so HMR works. Vite
// injects an inline module preamble (React Refresh), uses eval for some
// transforms, and opens a websocket back to the dev server. The http/ws origins
// are derived from the URL main was handed rather than hardcoding 5173, because
// electron-vite may bind a different port.
function devCsp(rendererUrl: string | undefined): string {
  let httpOrigin = 'http://localhost:*'
  let wsOrigin = 'ws://localhost:*'
  try {
    const u = new URL(rendererUrl ?? '')
    httpOrigin = u.origin
    wsOrigin = `ws://${u.host}`
  } catch { /* fall back to localhost wildcards */ }
  return [
    `default-src 'self' ${httpOrigin}`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${httpOrigin}`,
    `style-src 'self' 'unsafe-inline' ${httpOrigin}`,
    `img-src 'self' data: blob: ${SCREENSHOT_SCHEME} ${httpOrigin}`,
    `font-src 'self' data: ${httpOrigin}`,
    `connect-src 'self' ${httpOrigin} ${wsOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

/** The CSP header value for the renderer. `rendererUrl` is
 *  process.env.ELECTRON_RENDERER_URL (only set, and only used, in dev). */
export function contentSecurityPolicy(opts: { dev: boolean; rendererUrl?: string }): string {
  return opts.dev ? devCsp(opts.rendererUrl) : prodCsp()
}
