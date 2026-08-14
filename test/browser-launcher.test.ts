import { describe, it, expect } from 'vitest'
import { buildArgs, DEFAULT_BROWSER } from '../src/main/services/browser-launcher'

const PROFILE = '/tmp/proj/browser-profile'

describe('browser launcher args', () => {
  it('routes through the proxy and does not exempt loopback', () => {
    const args = buildArgs(DEFAULT_BROWSER, PROFILE)
    expect(args).toContain('--proxy-server=http://127.0.0.1:8080')
    // Chrome bypasses the proxy for localhost by default, which would hide
    // traffic to a local target from mitmproxy.
    expect(args).toContain('--proxy-bypass-list=<-loopback>')
  })

  it('omits proxy flags entirely when no proxy is configured', () => {
    const args = buildArgs({ ...DEFAULT_BROWSER, proxy: '' }, PROFILE)
    expect(args.some((a) => a.startsWith('--proxy'))).toBe(false)
  })

  it('enables CDP on the configured port so QuickMarks can read the tab', () => {
    const args = buildArgs({ ...DEFAULT_BROWSER, cdpPort: 9333 }, PROFILE)
    expect(args).toContain('--remote-debugging-port=9333')
  })

  it('omits CDP when the port is zero', () => {
    const args = buildArgs({ ...DEFAULT_BROWSER, cdpPort: 0 }, PROFILE)
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false)
  })

  it('isolates the profile so proxy flags never touch the daily browser', () => {
    const args = buildArgs(DEFAULT_BROWSER, PROFILE)
    expect(args).toContain(`--user-data-dir=${PROFILE}`)
    expect(args).toContain('--no-first-run')
  })

  it('leaves the real profile alone when isolation is off', () => {
    const args = buildArgs({ ...DEFAULT_BROWSER, isolateProfile: false }, PROFILE)
    expect(args.some((a) => a.startsWith('--user-data-dir'))).toBe(false)
  })

  it('puts the start URL last so it is treated as the target, not a flag value', () => {
    const args = buildArgs({ ...DEFAULT_BROWSER, startUrl: 'https://example.com' }, PROFILE)
    expect(args[args.length - 1]).toBe('https://example.com')
  })

  it('drops empty extra args instead of passing a bare empty string', () => {
    const args = buildArgs({ ...DEFAULT_BROWSER, extraArgs: ['--foo', '', '  '.trim()] }, PROFILE)
    expect(args).toContain('--foo')
    expect(args).not.toContain('')
  })

  // ignoreCertErrors defaults ON: the whole point of the launcher is routing
  // through mitmproxy, whose CA the isolated profile does not trust.
  it('accepts the intercepting proxy CA by default', () => {
    expect(buildArgs(DEFAULT_BROWSER, PROFILE)).toContain('--ignore-certificate-errors')
  })

  it('leaves cert validation intact when the operator turns it off', () => {
    const args = buildArgs({ ...DEFAULT_BROWSER, ignoreCertErrors: false }, PROFILE)
    expect(args).not.toContain('--ignore-certificate-errors')
  })

  it('omits the start URL when none is configured', () => {
    expect(buildArgs(DEFAULT_BROWSER, PROFILE).some((a) => !a.startsWith('--'))).toBe(false)
  })

  it('keeps the start URL last even with extra args configured', () => {
    const args = buildArgs(
      { ...DEFAULT_BROWSER, extraArgs: ['--incognito'], startUrl: 'https://example.com' },
      PROFILE
    )
    expect(args[args.length - 1]).toBe('https://example.com')
    expect(args).toContain('--incognito')
  })

  it('a fully stripped-down config produces no flags at all', () => {
    const args = buildArgs(
      { binary: '', proxy: '', cdpPort: 0, isolateProfile: false, ignoreCertErrors: false, startUrl: '', extraArgs: [] },
      PROFILE
    )
    expect(args).toEqual([])
  })
})
