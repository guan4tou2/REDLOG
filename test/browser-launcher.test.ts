import { describe, it, expect } from 'vitest'
import { buildArgs } from '../src/main/services/browser-launcher'
import type { BrowserConfig } from '../src/core/browser-defaults'
import { DEFAULT_BROWSER } from '../src/core/browser-defaults'

const PROFILE = '/tmp/proj/browser-profile'

describe('browser launcher args', () => {
  it('routes through the proxy and does not exempt loopback', () => {
    const args = buildArgs(DEFAULT_BROWSER, PROFILE)
    expect(args).toContain('--proxy-server=http://127.0.0.1:6661')
    // Chrome bypasses the proxy for localhost by default, which would hide
    // traffic to a local target from mitmproxy.
    // RedLog's own profile adds only the reserved offline suffix (#182).
    expect(args).toContain('--proxy-bypass-list=<-loopback>;*.redlog-offline.invalid')
    const shared = buildArgs({ ...DEFAULT_BROWSER, isolateProfile: false }, PROFILE)
    expect(shared).toContain('--proxy-bypass-list=<-loopback>')
  })

  it('omits proxy flags entirely when no proxy is configured', () => {
    const args = buildArgs({ ...DEFAULT_BROWSER, proxy: '' }, PROFILE)
    expect(args.some((a) => a.startsWith('--proxy'))).toBe(false)
  })

  it('enables CDP on the configured port so Bookmarks can read the tab', () => {
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
})

// Chrome's own background traffic became the engagement's evidence. On a
// fresh isolated profile, launched and then left alone for 25 seconds with
// nothing navigated to: 47 scanner.http_request_start rows, an 11 MB HTTP
// body index, and three CHAINED credential_use rows tagged MITRE T1078 for
// Chrome's GCM registration against android.clients.google.com. All of it
// ships to the client inside events.jsonl.
describe('the capture browser does not record Chrome talking to Google', () => {
  const cfg = (over: Partial<BrowserConfig> = {}): BrowserConfig => ({
    binary: '/chrome', proxy: '', cdpPort: 0, isolateProfile: true,
    ignoreCertErrors: false, startUrl: '', extraArgs: [], ...over
  })

  it('quiets background networking on RedLog\'s own profile', () => {
    const args = buildArgs(cfg(), '/tmp/profile')
    expect(args).toContain('--disable-background-networking')
    // #182: measured through the capture proxy — without it, unbranded
    // Chromium's testing field-trial config prefetches www.google.com.
    expect(args).toContain('--disable-field-trial-config')
    expect(args).toContain('--disable-component-update')
    expect(args).toContain('--disable-sync')
    expect(args).toContain('--no-pings')
    // The GCM registration that produced the T1078 rows, and the model
    // downloads that produced most of the request volume.
    expect(args.join(' ')).toMatch(/OptimizationGuideModelDownloading/)
  })

  it('sends the services no switch disables to a host that never resolves (#182)', () => {
    const args = buildArgs(cfg({ proxy: 'http://127.0.0.1:6661' }), '/tmp/profile')
    const features = args.find((a) => a.startsWith('--disable-features='))!
    // www.google.com preconnect and the omnibox AI Mode eligibility fetch (/async/folae)
    for (const f of ['PreconnectToSearch', 'AimEnabled', 'AimServerEligibilityEnabled']) expect(features).toContain(f)
    // ListAccounts and GCM check-in go to a reserved host the proxy never sees…
    expect(args).toContain('--gaia-url=https://gaia.redlog-offline.invalid')
    expect(args).toContain('--gcm-checkin-url=https://gcm.redlog-offline.invalid/checkin')
    expect(args).toContain('--proxy-bypass-list=<-loopback>;*.redlog-offline.invalid')
    // …and the HTTP check host is not caught by that bypass.
    expect('redlog.verify.invalid'.endsWith('.redlog-offline.invalid')).toBe(false)
  })

  it('leaves the operator\'s own profile alone', () => {
    // `args` is empty here, and `[].some()` is false whatever the predicate
    // says — so naming two flags asserted nothing, and the test would have
    // kept passing if buildArgs started returning nothing at all. The claim
    // its own name makes is stronger and is the one worth holding: RedLog adds
    // NO argument to a profile the operator chose.
    const args = buildArgs(cfg({ isolateProfile: false }), '/tmp/profile')
    expect(args).toEqual([])
  })

  // An operator pointed at their own profile has chosen their browser's
  // behaviour; we do not rewrite it underneath them.
  it('leaves a non-isolated profile alone', () => {
    const args = buildArgs(cfg({ isolateProfile: false }), '/tmp/profile')
    expect(args).not.toContain('--disable-background-networking')
    expect(args).not.toContain('--disable-sync')
  })

  it('still puts the operator\'s own extraArgs last, so they can override', () => {
    const args = buildArgs(cfg({ extraArgs: ['--enable-features=Foo'] }), '/tmp/profile')
    expect(args.indexOf('--enable-features=Foo'))
      .toBeGreaterThan(args.indexOf('--disable-background-networking'))
  })
})

// With no start URL Chrome opens its New Tab Page, which is a real page load
// against google.com: the promos, the OneGoogle bar, the doodle, the logo
// from gstatic, the omnibox prefetch. Through the capture proxy that is the
// operator's browser fetching Google's homepage furniture, recorded as
// engagement traffic before they have typed anything. Measured: opening
// about:blank instead took a 30s idle launch from 49 captured requests to 25,
// and the HTTP body index from 11 MB to nothing.
describe('the capture browser starts blank', () => {
  const cfg = (over: Partial<BrowserConfig> = {}): BrowserConfig => ({
    binary: '/chrome', proxy: '', cdpPort: 0, isolateProfile: true,
    ignoreCertErrors: false, startUrl: '', extraArgs: [], ...over
  })

  it('opens about:blank rather than the New Tab Page', () => {
    expect(buildArgs(cfg(), '/tmp/p')).toContain('about:blank')
  })

  it('never overrides a start URL the operator set', () => {
    const args = buildArgs(cfg({ startUrl: 'https://target.example/' }), '/tmp/p')
    expect(args).toContain('https://target.example/')
    expect(args).not.toContain('about:blank')
  })

  it('leaves a non-isolated profile to open whatever it normally would', () => {
    expect(buildArgs(cfg({ isolateProfile: false }), '/tmp/p')).not.toContain('about:blank')
  })

  it('emits no empty argument', () => {
    expect(buildArgs(cfg({ isolateProfile: false }), '/tmp/p')).not.toContain('')
  })
})

// ── The operator closes the browser themselves ──────────────────────────────
//
// The ordinary way a capture session ends, and the one way RedLog used to
// miss it. `child.on('exit')` fired and cleared the handle, and told nobody:
// the title-bar control still offered to stop a browser that no longer
// existed, and the CDP monitor kept polling a port that no longer answered
// for the rest of the session.

import { EventEmitter } from 'events'
import { vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number; exitCode: number | null; killed: boolean; unref: () => void; kill: () => void
    }
    child.pid = 4242
    child.exitCode = null
    child.killed = false
    child.unref = (): void => {}
    child.kill = (): void => { child.emit('exit', 0, null) }
    lastChild = child
    return child
  })
}))

let lastChild: (EventEmitter & { kill: () => void }) | null = null

describe('a browser that ends on its own', () => {
  beforeEach(() => { lastChild = null })

  const CFG: BrowserConfig = { ...DEFAULT_BROWSER, binary: process.execPath, isolateProfile: false }

  it('reports it is running, then not, once the window is closed', async () => {
    const m = await import('../src/main/services/browser-launcher')
    expect(m.launchBrowser(CFG, '/tmp/proj').ok).toBe(true)
    expect(m.isBrowserRunning()).toBe(true)

    lastChild!.emit('exit', 0, null)
    expect(m.isBrowserRunning()).toBe(false)
  })

  it('tells its listeners, which is how the UI and the CDP monitor find out', async () => {
    const m = await import('../src/main/services/browser-launcher')
    const heard: string[] = []
    const off = m.onBrowserExit(() => heard.push('exit'))

    m.launchBrowser(CFG, '/tmp/proj')
    expect(heard).toEqual([])
    lastChild!.emit('exit', 0, null)
    expect(heard).toEqual(['exit'])

    off()
    m.launchBrowser(CFG, '/tmp/proj')
    lastChild!.emit('exit', 0, null)
    expect(heard).toEqual(['exit'])
  })

  it('announces the same way when RedLog is the one stopping it', async () => {
    // One path for the UI to listen on, whoever ended it -- otherwise the
    // pressed-the-button case and the closed-the-window case need separate
    // handling, and only one of them would get written.
    const m = await import('../src/main/services/browser-launcher')
    const heard: string[] = []
    const off = m.onBrowserExit(() => heard.push('exit'))
    m.launchBrowser(CFG, '/tmp/proj')

    expect(m.stopBrowser()).toBe(true)
    expect(m.isBrowserRunning()).toBe(false)
    expect(heard).toEqual(['exit'])
    off()
  })

  it('survives a listener that throws, because the others still need telling', async () => {
    const m = await import('../src/main/services/browser-launcher')
    const heard: string[] = []
    const offBad = m.onBrowserExit(() => { throw new Error('boom') })
    const offGood = m.onBrowserExit(() => heard.push('exit'))
    m.launchBrowser(CFG, '/tmp/proj')
    lastChild!.emit('exit', 0, null)
    expect(heard).toEqual(['exit'])
    offBad(); offGood()
  })
})
