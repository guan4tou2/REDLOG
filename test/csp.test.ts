import { describe, it, expect } from 'vitest'
import { contentSecurityPolicy } from '../src/core/csp'

describe('contentSecurityPolicy — production', () => {
  const csp = contentSecurityPolicy({ dev: false })

  it('locks the default source to self', () => {
    expect(csp).toContain("default-src 'self'")
  })

  it('sets the four hard denies the flagged item requires', () => {
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it('allows the redlog-screenshot scheme and data: for images only', () => {
    expect(csp).toMatch(/img-src[^;]*redlog-screenshot:/)
    expect(csp).toMatch(/img-src[^;]*data:/)
  })

  it('permits inline STYLE but never inline or eval SCRIPT', () => {
    // React style props + xterm DOM renderer need inline styles.
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/)
    // script must stay strict — no inline, no eval, in prod.
    expect(csp).toMatch(/script-src 'self'(;|$)/)
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  })

  it('reaches no remote origin', () => {
    expect(csp).not.toContain('http://')
    expect(csp).not.toContain('https://')
    expect(csp).not.toContain('ws://')
    expect(csp).not.toContain('localhost')
  })
})

describe('contentSecurityPolicy — development', () => {
  const csp = contentSecurityPolicy({ dev: true, rendererUrl: 'http://localhost:5173' })

  it('derives the dev http + websocket origins from the renderer url', () => {
    expect(csp).toMatch(/connect-src[^;]*http:\/\/localhost:5173/)
    expect(csp).toMatch(/connect-src[^;]*ws:\/\/localhost:5173/)
  })

  it('permits the inline HMR preamble and eval transforms', () => {
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/)
  })

  it('honours a non-default vite port', () => {
    const other = contentSecurityPolicy({ dev: true, rendererUrl: 'http://localhost:5199' })
    expect(other).toMatch(/ws:\/\/localhost:5199/)
    expect(other).not.toContain('5173')
  })

  it('falls back to localhost wildcards when no renderer url is set', () => {
    const fallback = contentSecurityPolicy({ dev: true, rendererUrl: undefined })
    expect(fallback).toContain('http://localhost:*')
    expect(fallback).toContain('ws://localhost:*')
  })

  it('still denies object/base/frame-ancestors in dev', () => {
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })
})
