// @vitest-environment jsdom
//
// Spec 037: the first-run screen stops at "open the timeline" no longer. Once
// the built-in terminal has proved RedLog records, the next step is the
// terminal the operator actually works in — and "installed" is not the same as
// "recording", so the flow only says connected after a command carrying a
// per-attempt nonce arrives from outside the built-in terminal.
//
// Everything the screen talks to is mocked here: preflight, hooks.install, the
// live event stream, the managed proxy, WSL. The locale is pinned to zh-TW
// because the spec fixes the Traditional Chinese copy.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ default: () => <div data-testid="terminal" /> }))

import { FirstRunView } from '../src/renderer/src/components/FirstRunView'

type Preflight = RuntimePreflight
type Ev = { id: string; timestamp: number; agentType: string; data: Record<string, unknown> }

function preflight(over: Partial<Preflight> & { missing?: Array<'python3' | 'curl' | 'mitmdump'> } = {}): Preflight {
  const missing = new Set(over.missing ?? [])
  const platform = over.platform ?? 'darwin'
  const checks: Preflight['checks'] = platform === 'win32'
    ? [
        { id: 'powershell', found: true, neededFor: ['shell-powershell'] },
        { id: 'pwsh', found: false, neededFor: ['shell-powershell'] },
        { id: 'mitmdump', found: !missing.has('mitmdump'), neededFor: ['mitmproxy'] }
      ]
    : [
        { id: 'python3', found: !missing.has('python3'), neededFor: ['shell-zsh', 'shell-bash'], ...(missing.has('python3') ? { remediation: 'brew install python' } : {}) },
        { id: 'curl', found: !missing.has('curl'), neededFor: ['shell-zsh', 'shell-bash'], ...(missing.has('curl') ? { remediation: 'brew install curl' } : {}) },
        { id: 'zsh', found: true, neededFor: ['shell-zsh'] },
        { id: 'bash', found: true, neededFor: ['shell-bash'] },
        { id: 'mitmdump', found: !missing.has('mitmdump'), neededFor: ['mitmproxy'], ...(missing.has('mitmdump') ? { remediation: 'uv tool install mitmproxy' } : {}) }
      ]
  return {
    platform,
    shell: over.shell === undefined ? { name: 'zsh', hookId: 'shell-zsh' } : over.shell,
    checks
  }
}

// Counting `listeners.length` was racy. Several components on this screen
// subscribe to the same batch stream, and HttpCaptureStep in particular
// subscribes only after an async status check resolves — so a subscription
// unrelated to the assertion could land between reading the count and
// checking it, and the delta came out wrong. These helpers reason about the
// subscriptions that existed at a chosen moment, by identity. The assertions
// are directional - it unsubscribed, it subscribed - because an exact count
// over a shared array is wrong however it is taken: two components can drop
// their subscriptions in the same window and neither fact is what the test
// is about.
const snapshot = (): Set<(evs: Ev[]) => void> => new Set(listeners)
/** How many of `taken` are still subscribed. */
const survivorsOf = (taken: Set<(evs: Ev[]) => void>): number =>
  listeners.filter((l) => taken.has(l)).length
/** How many subscriptions have appeared since `taken`. */
const arrivalsSince = (taken: Set<(evs: Ev[]) => void>): number =>
  listeners.filter((l) => !taken.has(l)).length

const RUNNING: ManagedProxyStatus = { state: 'running', url: 'http://127.0.0.1:8080', caPath: '/home/op/.mitmproxy/mitmproxy-ca-cert.pem' }
const HTTP_EVENT: Ev = { id: 'h1', timestamp: 10, agentType: 'scanner', data: { subtype: 'http_request_start', flow_id: 'f1', url: 'http://example.test/' } }
const BUILTIN: Ev = { id: 'b1', timestamp: 1, agentType: 'shell', data: { subtype: 'command_end', source: 'builtin-terminal', command: 'id' } }

let listeners: Array<(evs: Ev[]) => void>
type Report = { scheme: 'http' | 'https'; nonce?: string; userAgent?: string; rejected?: boolean; receivedAt: number }
let verifyListeners: Array<(r: Report) => void>
let bridge: {
  preflight: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  runtimeInstall: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  commandEvidence: ReturnType<typeof vi.fn>
  proxyStatus: ReturnType<typeof vi.fn>
  proxyStart: ReturnType<typeof vi.fn>
  launch: ReturnType<typeof vi.fn>
  verifyInBrowser: ReturnType<typeof vi.fn>
  configSave: ReturnType<typeof vi.fn>
  listDistros: ReturnType<typeof vi.fn>
  wslInstall: ReturnType<typeof vi.fn>
}

function install(opts: { rows?: Ev[]; pre?: Preflight; proxy?: ManagedProxyStatus; distros?: WslDistro[] } = {}): void {
  listeners = []
  verifyListeners = []
  bridge = {
    preflight: vi.fn(async () => opts.pre ?? preflight()),
    install: vi.fn(async () => ({ success: true, message: 'ok' })),
    runtimeInstall: vi.fn(async () => ({ success: true, message: 'ok' })),
    query: vi.fn(async () => opts.rows ?? [BUILTIN]),
    commandEvidence: vi.fn(async () => {
      const commands = (opts.rows ?? [BUILTIN]).filter(e => e.agentType === 'shell' && ['command_start', 'command', 'command_end'].includes(String(e.data.subtype)))
      return { builtin: commands.some(e => e.data.source === 'builtin-terminal'), external: commands.some(e => e.data.source !== 'builtin-terminal') }
    }),
    proxyStatus: vi.fn(async () => opts.proxy ?? { state: 'stopped', url: null }),
    proxyStart: vi.fn(async () => ({ state: 'running', url: 'http://127.0.0.1:8080' })),
    launch: vi.fn(async () => ({ ok: true })),
    verifyInBrowser: vi.fn(async () => ({ ok: true })),
    configSave: vi.fn(async () => true),
    listDistros: vi.fn(async () => opts.distros ?? []),
    wslInstall: vi.fn(async () => ({ success: true, message: 'ok' }))
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: opts.pre?.platform ?? 'darwin',
    events: {
      query: bridge.query,
      commandEvidence: bridge.commandEvidence,
      onNewBatch: (cb: (evs: Ev[]) => void) => { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb) } }
    },
    runtime: { preflight: bridge.preflight, install: bridge.runtimeInstall, cancelInstall: vi.fn(async () => true) },
    hooks: { install: bridge.install, detect: vi.fn(async () => [
      { id: 'shell-zsh', available: (opts.pre?.platform ?? 'darwin') !== 'win32', installed: false },
      { id: 'shell-bash', available: (opts.pre?.platform ?? 'darwin') !== 'win32', installed: false },
      { id: 'shell-powershell', available: opts.pre?.platform === 'win32', installed: false }
    ]) },
    app: { openExternal: vi.fn(async () => {}) },
    httpCapture: {
      status: bridge.proxyStatus,
      start: bridge.proxyStart,
      stop: vi.fn(async () => ({ state: 'stopped', url: null })),
      verifyInBrowser: bridge.verifyInBrowser,
      onVerify: (cb: (r: Report) => void) => { verifyListeners.push(cb); return () => { verifyListeners = verifyListeners.filter((l) => l !== cb) } }
    },
    browser: { launch: bridge.launch },
    config: { get: async () => ({ httpCapture: { port: 8080, routeTerminals: false } }), save: bridge.configSave },
    clipboard: { writeText: vi.fn(async () => true), readText: async () => '' },
    wsl: { listDistros: bridge.listDistros, installHook: bridge.wslInstall }
  }
}

function emit(evs: Ev[]): void {
  act(() => { for (const l of listeners) l(evs) })
}

/** The nonce this attempt would accept. The per-tool commands that used to
 *  carry it are now the fallback shown once a check has not landed. */
async function shownNonce(): Promise<string> {
  await screen.findByTestId('first-run-http-checks')
  const card = await screen.findByTestId('first-run-http')
  const nonce = card.getAttribute('data-nonce')
  expect(nonce, 'card has no attempt nonce').toBeTruthy()
  return nonce!
}

/** What the mitmproxy addon reports when a check request reaches it. */
async function report(r: Omit<Report, 'receivedAt'>): Promise<void> {
  await waitFor(() => expect(verifyListeners.length).toBeGreaterThan(0))
  act(() => { for (const l of verifyListeners) l({ ...r, receivedAt: Date.now() }) })
}

function draw(): { onNavigate: ReturnType<typeof vi.fn> } {
  const onNavigate = vi.fn()
  render(
    <I18nProvider>
      <FirstRunView onNavigate={onNavigate} renderCaptureCard={() => <div />} />
    </I18nProvider>
  )
  return { onNavigate }
}

beforeEach(() => { localStorage.setItem('redlog-locale', 'zh-TW') })
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear() })

describe('first run: Commands and HTTP(S) are set up side by side (#217)', () => {
  it('shows both core captures before any event, each unverified, and asks no "web or hosts" question', async () => {
    install({ rows: [] })
    draw()
    const commands = await screen.findByTestId('first-run-commands')
    const http = await screen.findByTestId('first-run-http')
    expect(commands.textContent).toContain('指令與終端')
    expect(http.textContent).toContain('HTTP(S)')
    expect(screen.getByTestId('first-run-commands-status').textContent).toBe('○ 尚未驗證')
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
    // HTTP is reachable without a shell event having landed first.
    expect(await screen.findByText('啟動 HTTP 擷取')).toBeTruthy()
    // The connect-your-terminal path is offered from the start too.
    expect(screen.getByTestId('first-run-record-terminal').textContent).toBe('記我的 Zsh 終端')
    // No engagement-type choice, and HTTP cannot be waved away as optional.
    expect(screen.queryByTestId('first-run-focus')).toBeNull()
    expect(screen.queryByText('略過')).toBeNull()
    expect(screen.getByTestId('first-run-strip').getAttribute('data-core-ready')).toBe('false')
  })

  it('a missing shell dependency blocks Commands only; HTTP still starts', async () => {
    install({ rows: [], pre: preflight({ missing: ['python3'] }) })
    draw()
    fireEvent.click(await screen.findByTestId('capture-prepare-skip'))
    const missing = await screen.findByTestId('first-run-missing-deps')
    expect(screen.getByTestId('first-run-commands').contains(missing)).toBe(true)
    fireEvent.click(await screen.findByText('啟動 HTTP 擷取'))
    await waitFor(() => expect(bridge.proxyStart).toHaveBeenCalled())
  })

  it('HTTP alone leaves HTTPS verification and Commands pending', async () => {
    install({ rows: [], proxy: RUNNING })
    draw()
    await screen.findByText('127.0.0.1:8080')
    await report({ scheme: 'http', nonce: await shownNonce(), userAgent: 'curl/8.5.0' })
    expect((await screen.findByTestId('first-run-http-status')).textContent).toBe('○ 尚未驗證')
    expect(screen.getByTestId('first-run-commands-status').textContent).toBe('○ 尚未驗證')
    expect(screen.queryByTestId('first-run-core-ready')).toBeNull()
  })

  it('a built-in command verifies Commands and says the own terminal is still not connected', async () => {
    install()
    draw()
    await waitFor(() => expect(screen.getByTestId('first-run-commands-status').textContent).toBe('✓ 已驗證'))
    expect(screen.getByTestId('first-run-commands-verified').textContent).toContain('已收到內建終端的指令。')
    expect(screen.getByTestId('first-run-external-pending').textContent).toBe('你平常用的 Zsh 終端尚未接上。')
  })

  it('an external command verifies Commands without the own-terminal note', async () => {
    install({ rows: [{ id: 'e1', timestamp: 1, agentType: 'shell', data: { subtype: 'command_end', command: 'id' } }] })
    draw()
    await waitFor(() => expect(screen.getByTestId('first-run-commands-status').textContent).toBe('✓ 已驗證'))
    expect(screen.getByTestId('first-run-commands-verified').textContent).toContain('已收到你自己終端的指令。')
    expect(screen.queryByTestId('first-run-external-pending')).toBeNull()
    expect(screen.getByTestId('first-run-start-work')).toBeTruthy()
    expect(screen.queryByTestId('first-run-later')).toBeNull()
  })

  it('does not count session bookkeeping or HTTP rows as a verified command', async () => {
    install({ rows: [
      { id: 's1', timestamp: 1, agentType: 'shell', data: { subtype: 'session_start' } },
      HTTP_EVENT
    ] })
    draw()
    await screen.findByTestId('first-run-commands')
    await waitFor(() => expect(bridge.query).toHaveBeenCalled())
    expect(screen.getByTestId('first-run-commands-status').textContent).toBe('○ 尚未驗證')
  })

  it('says core capture is ready only when both are verified, then offers to start work', async () => {
    install({ proxy: RUNNING })
    const { onNavigate } = draw()
    await waitFor(() => expect(screen.getByTestId('first-run-commands-status').textContent).toBe('✓ 已驗證'))
    expect(screen.queryByTestId('first-run-core-ready')).toBeNull()
    await screen.findByText('127.0.0.1:8080')
    await report({ scheme: 'https', nonce: await shownNonce() })
    expect((await screen.findByTestId('first-run-core-ready')).textContent).toBe('✓ 核心擷取已就緒')
    fireEvent.click(screen.getByTestId('first-run-start-work'))
    expect(onNavigate).toHaveBeenCalledWith('timeline')
  })

  it('lets the operator leave before both are done, saying the Dashboard keeps flagging it', async () => {
    install({ rows: [] })
    const { onNavigate } = draw()
    const footer = await screen.findByTestId('first-run-core-footer')
    expect(footer.textContent).toContain('尚未驗證的核心擷取會一直標示在儀表板上')
    fireEvent.click(screen.getByTestId('first-run-later'))
    expect(onNavigate).toHaveBeenCalledWith('timeline')
  })

  it('names PowerShell on Windows and offers a separate WSL button per the existing WSL install path', async () => {
    install({
      pre: preflight({ platform: 'win32', shell: { name: 'powershell', hookId: 'shell-powershell' } }),
      distros: [{ name: 'Ubuntu', state: 'Running', version: 2, isDefault: true, shells: ['bash', 'zsh'], hookStatus: { bash: 'not-installed', zsh: 'not-installed' } }]
    })
    draw()
    expect((await screen.findByTestId('first-run-record-terminal')).textContent).toBe('記我的 PowerShell 終端')
    const wsl = await screen.findByTestId('first-run-record-wsl')
    expect(wsl.textContent).toBe('記我的 WSL Ubuntu')
    fireEvent.click(wsl)
    await waitFor(() => expect(bridge.wslInstall).toHaveBeenCalledWith('Ubuntu', 'zsh'))
    expect(bridge.install).not.toHaveBeenCalled()
  })

  it('has no WSL button off Windows', async () => {
    install()
    draw()
    await screen.findByTestId('first-run-record-terminal')
    expect(screen.queryByTestId('first-run-record-wsl')).toBeNull()
    expect(bridge.listDistros).not.toHaveBeenCalled()
  })
})

describe('first run: record my terminal', () => {
  it('blocks the install when curl is missing, names curl, and resumes when the operator comes back', async () => {
    install({ pre: preflight({ missing: ['curl'] }) })
    draw()
    fireEvent.click(await screen.findByTestId('capture-prepare-skip'))
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    const blocked = await screen.findByTestId('record-terminal-missing')
    expect(blocked.textContent).toContain('curl')
    expect(blocked.textContent).not.toContain('python3')
    expect(blocked.textContent).toContain('準備缺少的擷取工具')
    expect(bridge.install).not.toHaveBeenCalled()

    // No button for this: the operator went to a terminal, installed curl, and
    // came back. That return is the re-check, and the click that started this
    // flow was already consent to install the hook.
    expect(blocked.textContent).not.toContain('重新檢查')
    bridge.preflight.mockResolvedValue(preflight())
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-zsh'))
  })

  it('installs, shows a nonce command, and verifies only on an external command carrying it', async () => {
    install()
    draw()
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    await waitFor(() => expect(bridge.install).toHaveBeenCalledWith('shell-zsh'))
    const cmdEl = await screen.findByTestId('record-terminal-command')
    const cmd = cmdEl.textContent ?? ''
    expect(cmd).toMatch(/^echo redlog-ok-[a-z0-9]{4,}$/)
    const nonce = cmd.replace('echo ', '')
    expect(screen.getByText('開一個新的終端分頁，貼上：')).toBeTruthy()

    // The built-in terminal is not the terminal being connected.
    emit([{ id: 'x1', timestamp: 2, agentType: 'shell', data: { subtype: 'command_start', source: 'builtin-terminal', command: cmd } }])
    // An external command, but not this attempt's.
    emit([{ id: 'x2', timestamp: 3, agentType: 'shell', data: { subtype: 'command_start', command: 'echo redlog-ok-other' } }])
    // Right nonce, wrong kind of event.
    emit([{ id: 'x3', timestamp: 4, agentType: 'shell', data: { subtype: 'session_start', command: cmd } }])
    expect(screen.queryByTestId('record-terminal-verified')).toBeNull()

    emit([{ id: 'x4', timestamp: 5, agentType: 'shell', data: { subtype: 'command_start', shell: 'zsh', command: `echo ${nonce}` } }])
    expect((await screen.findByTestId('record-terminal-verified')).textContent).toContain('已收到 Zsh 指令')
  })

  it('after 60 s without the event, names the likely reasons and offers another attempt with a new nonce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ pre: preflight() })
    draw()
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    const first = (await screen.findByTestId('record-terminal-command')).textContent

    // By the time the wait expires the operator's machine has changed:
    // python3 went missing.
    bridge.preflight.mockResolvedValue(preflight({
      missing: ['python3']
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const why = await screen.findByTestId('record-terminal-timeout')
    expect(why.textContent).toContain('新的')
    expect(why.textContent).toContain('python3')

    fireEvent.click(screen.getByText('再試一次'))
    // The retry re-runs preflight — which now blocks on python3.
    expect((await screen.findByTestId('record-terminal-missing')).textContent).toContain('python3')
    bridge.preflight.mockResolvedValue(preflight())
    act(() => { window.dispatchEvent(new Event('focus')) })
    const second = (await screen.findByTestId('record-terminal-command')).textContent
    expect(second).not.toBe(first)
  })

  it('accepts the same external canary after timeout without reinstalling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install()
    draw()
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    const command = (await screen.findByTestId('record-terminal-command')).textContent
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    await screen.findByTestId('record-terminal-timeout')
    emit([{ id: 'wrong', timestamp: 2, agentType: 'shell', data: { subtype: 'command_start', shell: 'bash', command } }])
    expect(screen.queryByTestId('record-terminal-verified')).toBeNull()
    emit([{ id: 'late', timestamp: 3, agentType: 'shell', data: { subtype: 'command_start', shell: 'zsh', command } }])
    expect((await screen.findByTestId('record-terminal-verified')).textContent).toContain('已收到 Zsh 指令')
    expect(screen.queryByTestId('record-terminal-timeout')).toBeNull()
    expect(screen.getByTestId('record-terminal-output-command')).toBeTruthy()
    expect(bridge.install).toHaveBeenCalledTimes(1)
  })

  it('follows the picker: after a manual bash choice the entry button no longer says Zsh', async () => {
    // The button's label names the detected shell, but the choice the flow
    // honours is the one the picker holds. When those differ the stale label
    // was the only text left claiming the button records Zsh — everything in
    // the flow itself (install, prerequisites, expected event shell) had
    // already moved to the selection. The selection now replies up so the two
    // can never disagree.
    install({ pre: preflight() })
    draw()
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    await screen.findByTestId('record-terminal-adapters')
    expect(screen.getByTestId('first-run-record-terminal').textContent).toBe('記我的 Zsh 終端')
    fireEvent.click(screen.getByTestId('record-terminal-adapter-shell-bash'))
    await waitFor(() => expect(screen.getByTestId('first-run-record-terminal').textContent).toBe('記我的 Bash 終端'))
  })

  it('stops listening once verified', async () => {
    install()
    draw()
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    const cmd = (await screen.findByTestId('record-terminal-command')).textContent ?? ''
    // Showing the nonce precedes React's passive subscription effect. Let
    // that render settle before delivering the operator's canary event.
    await act(async () => {})
    const before = snapshot()
    emit([{ id: 'x', timestamp: 5, agentType: 'shell', data: { subtype: 'command_end', command: cmd, shell: (await bridge.preflight()).shell?.name === 'powershell' ? 'powershell' : 'zsh' } }])
    await screen.findByTestId('record-terminal-verified')
    // The flow dropped its own subscription. Anything else that subscribed
    // meanwhile is irrelevant to that.
    await waitFor(() => expect(survivorsOf(before)).toBeLessThan(before.size))
  })
})

describe('first run: built-in terminal stuck message comes from preflight', () => {
  it('names the missing dependency without waiting for a timer', async () => {
    install({ rows: [], pre: preflight({ missing: ['python3'] }) })
    draw()
    const el = await screen.findByTestId('capture-prepare')
    expect(el.textContent).toContain('python3')
    expect(screen.getByTestId('prepare-install-python3')).toBeTruthy()
    expect(el.textContent).not.toContain('brew install python')
    expect(el.textContent).not.toContain('curl')
  })

  it('shows the waiting state, not a dependency complaint, when everything is present', async () => {
    install({ rows: [], pre: preflight() })
    draw()
    await waitFor(() => expect(bridge.preflight).toHaveBeenCalled())
    expect(screen.queryByTestId('first-run-missing-deps')).toBeNull()
    expect(await screen.findByTestId('first-run-record-terminal')).toBeTruthy()
    expect(screen.queryByTestId('first-run-commands-quick')).toBeNull()
  })
})

describe('first run: HTTP(S) card', () => {
  it('keeps capture unverified when returning from preparation with a fresh HTTP attempt', async () => {
    install({ proxy: RUNNING })
    draw()
    await report({ scheme: 'https', nonce: await shownNonce() })
    expect(await screen.findByTestId('first-run-core-ready')).toBeTruthy()
    bridge.preflight.mockResolvedValue(preflight({ missing: ['mitmdump'] }))
    bridge.proxyStatus.mockResolvedValue({ state: 'unavailable', url: null })
    act(() => { window.dispatchEvent(new Event('focus')) })
    fireEvent.click(await screen.findByTestId('first-run-http-prepare'))
    await screen.findByTestId('capture-prepare')
    bridge.runtimeInstall.mockImplementationOnce(async () => {
      bridge.preflight.mockResolvedValue(preflight())
      bridge.proxyStatus.mockResolvedValue(RUNNING)
      return { success: true, message: 'ok' }
    })
    fireEvent.click(screen.getByTestId('prepare-install-mitmdump'))
    expect((await screen.findByTestId('first-run-http-status')).textContent).toBe('○ 尚未驗證')
    expect(screen.queryByTestId('first-run-core-ready')).toBeNull()
    expect(screen.getByTestId('first-run-commands-status').textContent).toBe('✓ 已驗證')
  })

  it('when mitmdump is missing, installs it in one click and re-probes on return', async () => {
    install({ pre: preflight({ missing: ['mitmdump'] }), proxy: { state: 'unavailable', url: null } })
    draw()
    fireEvent.click(await screen.findByTestId('first-run-http-prepare'))
    const card = await screen.findByTestId('capture-prepare')
    expect(card.textContent).toContain('mitmproxy')
    // No re-check button: mitmproxy may have been installed in a terminal
    // while RedLog was in the background, and coming back asks again.
    expect(card.textContent).not.toContain('重新檢查')
    const before = bridge.preflight.mock.calls.length
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(bridge.preflight.mock.calls.length).toBeGreaterThan(before))
    const installBtn = await screen.findByTestId('prepare-install-mitmdump')
    bridge.runtimeInstall.mockImplementationOnce(async () => { bridge.preflight.mockResolvedValue(preflight()); return { success: true, message: 'ok' } })
    fireEvent.click(installBtn)
    // The install runs, and on success the card re-checks preflight.
    await waitFor(() => expect(bridge.runtimeInstall).toHaveBeenCalledWith('mitmdump'))
    await waitFor(() => expect(bridge.preflight.mock.calls.length).toBeGreaterThan(1))
    expect(await screen.findByTestId('first-run-http')).toBeTruthy()
    expect(screen.queryByTestId('capture-prepare')).toBeNull()
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
  })

  it('when the installer (uv) is missing, points at it instead of failing again', async () => {
    install({ pre: preflight({ missing: ['mitmdump'] }), proxy: { state: 'unavailable', url: null } })
    bridge.runtimeInstall.mockResolvedValueOnce({
      success: false, message: 'uv required', needsPrereq: { command: 'uv', url: 'https://astral.sh/uv' }
    })
    draw()
    fireEvent.click(await screen.findByTestId('first-run-http-prepare'))
    fireEvent.click(await screen.findByTestId('prepare-install-mitmdump'))
    const prereq = await screen.findByTestId('prepare-prereq-mitmdump')
    expect(prereq.textContent).toContain('安裝 uv')
  })

  it('when running, shows the listen address and the browser check', async () => {
    install({ proxy: { state: 'running', url: 'http://127.0.0.1:8080', caPath: '/home/op/.mitmproxy/mitmproxy-ca-cert.pem' } })
    draw()
    const card = await screen.findByTestId('first-run-http')
    // The address is a field, not a sentence about a field.
    await waitFor(() => expect(card.textContent).toContain('127.0.0.1:8080'))
    // Settings owns the terminal-proxy switch and the trust-store reference;
    // neither belongs on the screen where capture is being proved.
    expect(screen.queryByTestId('first-run-route-terminals')).toBeNull()
    expect(card.textContent).not.toContain('nmap SYN')
    // The default route is the operator's own browser: the listener to copy
    // and the address to open are on the card from the start. The CA's path,
    // fingerprint and trust commands are reference (Spec 060 US2.1) and wait
    // behind the certificate link.
    expect(screen.getByTestId('first-run-http-proxy').textContent).toContain('127.0.0.1:8080')
    expect(screen.getByTestId('first-run-http-own-browser').textContent).toContain('redlog.verify.invalid')
    expect(screen.queryByTestId('first-run-http-ca')).toBeNull()
    expect(card.textContent).not.toContain('mitmproxy-ca-cert.pem')
    fireEvent.click(screen.getByTestId('first-run-http-ca-toggle'))
    // …and they read 1, 2, 3 down the card: proxy, then the CA, then the check.
    const before = (a: HTMLElement, b: HTMLElement): boolean => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(before(screen.getByTestId('first-run-http-proxy'), screen.getByTestId('first-run-http-ca'))).toBe(true)
    expect(before(screen.getByTestId('first-run-http-ca'), screen.getByTestId('first-run-http-own-browser'))).toBe(true)
    expect(card.textContent).toContain('/home/op/.mitmproxy/mitmproxy-ca-cert.pem')
    fireEvent.click(screen.getByText('HTTPS 憑證'))
    expect(card.textContent).not.toContain('mitmproxy-ca-cert.pem')

    const nonce = await shownNonce()
    fireEvent.click(screen.getByRole('button', { name: 'RedLog 擷取瀏覽器' }))
    expect(screen.queryByTestId('first-run-http-own-browser')).toBeNull()
    fireEvent.click(screen.getByTestId('first-run-http-verify-browser'))
    await waitFor(() => expect(bridge.verifyInBrowser).toHaveBeenCalledWith(nonce))
  })
})

describe('first run: HTTP(S) card reports its own failures (UI/UX audit F6/F7)', () => {
  it('a rejected start shows the failure and offers a retry instead of resetting silently', async () => {
    install()
    bridge.proxyStart.mockRejectedValueOnce(new Error('port 8080 in use'))
    draw()
    // 5 s, not the default 1 s: on a loaded runner the rejected start took
    // just over a second to show, failing main and a PR within minutes.
    fireEvent.click(await screen.findByRole('button', { name: '啟動 HTTP 擷取' }, { timeout: 5000 }))
    const card = await screen.findByTestId('first-run-http', undefined, { timeout: 5000 })
    await waitFor(() => expect(card.textContent).toContain('port 8080 in use'), { timeout: 5000 })
    // The failed attempt now offers Retry, matching the settings control.
    expect(screen.getByTestId('first-run-http-restart').textContent).toBe('重試')
  })

  // The card also polls the proxy's status every 3 s. The poll's answer knows
  // nothing about this start, so taking it whole erased the failure: on a
  // slow runner the poll landed before the assertion above, and the operator
  // saw the message for at most three seconds.
  it('keeps a rejected start\'s failure through the next status poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install()
    bridge.proxyStart.mockRejectedValueOnce(new Error('port 8080 in use'))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: '啟動 HTTP 擷取' }, { timeout: 5000 }))
    const card = await screen.findByTestId('first-run-http')
    await waitFor(() => expect(card.textContent).toContain('port 8080 in use'))
    const polls = bridge.proxyStatus.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(3_100) })
    expect(bridge.proxyStatus.mock.calls.length).toBeGreaterThan(polls)
    expect(card.textContent).toContain('port 8080 in use')
  })

  // The terminal-proxy switch moved to Settings ▸ Browser, which owns every
  // other proxy setting; a global behaviour switch does not belong on the
  // screen where capture is being proved for the first time.

  it('a failed environment check says so, rather than reading as installed', async () => {
    install()
    bridge.preflight.mockRejectedValue(new Error('spawn failed'))
    draw()
    expect(await screen.findByTestId('first-run-preflight-failed')).toBeTruthy()
    fireEvent.click(screen.getByTestId('capture-prepare-skip'))
    expect(await screen.findByTestId('first-run-http-preflight-failed')).not.toBeNull()
  })

  it('Copy says it copied', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ proxy: RUNNING })
    draw()
    const card = await screen.findByTestId('first-run-http')
    // The copyable commands that used to sit on the card unconditionally are
    // now the fallback shown once a check has not landed.
    // The wrapper precedes the async running state which arms the timeout.
    await screen.findByText('127.0.0.1:8080')
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const copy = await waitFor(() => {
      const b = [...card.querySelectorAll('button')].find((el) => el.textContent === '複製')
      expect(b).toBeTruthy()
      return b as HTMLButtonElement
    })
    fireEvent.click(copy)
    await waitFor(() => expect(copy.textContent).toContain('已複製'))
  })
})

// Spec 039: "connected" must say what is recorded, and HTTP is verified by the
// first request that reaches RedLog, not by the proxy process running.
async function verifyShell(): Promise<HTMLElement> {
  const before = snapshot()
  fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
  const cmd = (await screen.findByTestId('record-terminal-command')).textContent ?? ''
  // Emitting before the flow has subscribed drops the event on the floor —
  // `emit` walks whatever listeners exist at that instant — and the flow then
  // waits for a command that has already been and gone. The subscription is
  // set up in an effect, so it lands a tick after the click: wait for it.
  await waitFor(() => expect(arrivalsSince(before)).toBeGreaterThanOrEqual(1))
  emit([{ id: 'v', timestamp: 9, agentType: 'shell', data: { subtype: 'command_end', command: cmd, shell: (await bridge.preflight()).shell?.name === 'powershell' ? 'powershell' : 'zsh' } }])
  return screen.findByTestId('record-terminal-verified')
}

describe('first run: a verified shell says what it records (Spec 039)', () => {
  it('describes Zsh automatic output and keeps session recording as an optional fallback', async () => {
    install()
    draw()
    await verifyShell()
    const scope = screen.getByTestId('record-terminal-scope')
    expect(scope.textContent).toContain('普通指令的輸出會自動保存')
    expect(scope.textContent).not.toContain('不含輸出')
    expect(screen.getByTestId('record-terminal-session-command').textContent).toBe('redlog-session')
  })

  // #218: "connected" proves the hook. The output check proves output.
  it('verifies output only when the canary text arrives in stdout, and says when only metadata did', async () => {
    install()
    draw()
    await verifyShell()
    const cmd = (await screen.findByTestId('record-terminal-output-command')).textContent ?? ''
    expect(cmd).toMatch(/^printf '%s-%s\\n' redlog-out \S+$/)
    const nonce = cmd.split(' ').at(-1)!
    // The plain hook recorded the line, not what it printed.
    emit([{ id: 'm1', timestamp: 20, agentType: 'shell', data: { subtype: 'command_end', command: `printf '%s-%s\\n' redlog-out ${nonce}`, exit_code: 0 } }])
    expect((await screen.findByTestId('record-terminal-output-metadata-only')).textContent).toContain('只收到指令本身')
    emit([{ id: 'o1', timestamp: 21, agentType: 'shell', data: { subtype: 'command_end', command: cmd, stdout: `redlog-out-${nonce}\n`, captured_by: 'redlog-run' } }])
    expect((await screen.findByTestId('record-terminal-output-verified')).textContent).toContain('redlog-run')
  })

  it('keeps output verification visible while interactive session help stays folded', async () => {
    install()
    draw()
    await verifyShell()
    const details = screen.getByTestId('record-terminal-details')
    expect(details.hasAttribute('hidden')).toBe(true)
    const output = screen.getByTestId('record-terminal-output-check')
    expect(details.contains(output)).toBe(false)
    const cmd = screen.getByTestId('record-terminal-output-command').textContent ?? ''
    const nonce = cmd.split(' ').at(-1)!
    emit([{ id: 'o1', timestamp: 21, agentType: 'shell', data: { subtype: 'command_end', command: cmd, stdout: `redlog-out-${nonce}\n`, captured_by: 'redlog-run' } }])
    await screen.findByTestId('record-terminal-output-verified')
    fireEvent.click(screen.getByTestId('record-terminal-details-toggle'))
    expect(details.hasAttribute('hidden')).toBe(false)
    expect(screen.getByTestId('record-terminal-output-verified')).toBeTruthy()
  })

  it('does not offer redlog-session for PowerShell, which has no such command', async () => {
    install({ pre: preflight({ platform: 'win32', shell: { name: 'powershell', hookId: 'shell-powershell' } }) })
    draw()
    await verifyShell()
    expect(screen.getByTestId('record-terminal-scope').textContent).toContain('不含輸出')
    expect(screen.queryByTestId('record-terminal-session-command')).toBeNull()
    expect(screen.getByTestId('record-terminal-scope').textContent).toContain('內建終端')
  })
})


describe('first run: HTTP(S) is verified by this check\'s own request (Spec 039, #220)', () => {
  it('ignores ordinary traffic and other checks; verifies only its own nonce, then stops listening', async () => {
    install({ proxy: RUNNING })
    draw()
    const card = await screen.findByTestId('first-run-http')
    await waitFor(() => expect(card.textContent).toContain('127.0.0.1:8080'))
    const nonce = await shownNonce()
    // The capture browser's own background traffic, and a check from another
    // attempt, prove nothing about this one.
    emit([HTTP_EVENT])
    await report({ scheme: 'http', nonce: 'rv-000000000000' })
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')

    await report({ scheme: 'http', nonce, userAgent: 'curl/8.5.0' })
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
    expect(screen.queryByTestId('first-run-http-check-http')).toBeNull()
    expect(screen.getByTestId('first-run-http-check-https').getAttribute('data-verified')).toBe('false')
    await report({ scheme: 'https', nonce, userAgent: 'curl/8.5.0' })
    await waitFor(() => expect(screen.getByTestId('first-run-http-check-https').getAttribute('data-verified')).toBe('true'))
    await waitFor(() => expect(verifyListeners.length).toBe(0))
  })

  it('shows HTTPS from the capture browser, with the caveat only when it is set to ignore certificate errors', async () => {
    // Off by default: the default route trusts the CA, so a pass is a real one.
    install({ proxy: RUNNING })
    draw()
    const nonce = await shownNonce()
    await report({ scheme: 'https', nonce, userAgent: 'Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' })
    const https = await screen.findByTestId('first-run-http-check-https')
    await waitFor(() => expect(https.textContent).toContain('Chromium'))
    expect(https.textContent).not.toContain('忽略憑證錯誤')
    // HTTPS is the principal proof; HTTP is not a prerequisite.
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('✓ 已驗證')
  })

  it('still carries the caveat when the operator turned ignore-certificate-errors on', async () => {
    install({ proxy: RUNNING })
    ;(window as unknown as { redlog: { config: { get: () => Promise<unknown> } } }).redlog.config.get =
      async () => ({ httpCapture: { port: 8080, routeTerminals: false }, browser: { ignoreCertErrors: true } })
    draw()
    const nonce = await shownNonce()
    await report({ scheme: 'https', nonce, userAgent: 'Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' })
    const https = await screen.findByTestId('first-run-http-check-https')
    // 5 s, not the default 1 s: on a loaded macOS runner the verification
    // report took just over a second and failed #391 and #395 in CI.
    await waitFor(() => expect(https.textContent).toContain('忽略憑證錯誤'), { timeout: 5000 })
  })

  it('says when a client refused the certificate', async () => {
    install({ proxy: RUNNING })
    draw()
    await shownNonce()
    await report({ scheme: 'https', rejected: true })
    // The CA is now the current step, so its block opens by itself.
    await waitFor(() => expect(screen.getByTestId('first-run-http-ca')).toBeTruthy())
    await waitFor(() => expect(screen.getByTestId('first-run-http-check-https').textContent).toContain('拒絕了 RedLog 的憑證'))
  })

  it('offers terminal checks that never skip certificate verification', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ proxy: RUNNING })
    draw()
    const nonce = await shownNonce()
    // They are the fallback: the browser check is the first offer, and these
    // appear once it has not landed.
    await screen.findByText('127.0.0.1:8080')
    expect(screen.queryByTestId('first-run-http-verify-commands')).toBeNull()
    fireEvent.click(screen.getByTestId('first-run-http-verify-own'))
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const codes = [...screen.getByTestId('first-run-http-verify-commands').querySelectorAll('code')].map((c) => c.textContent ?? '')
    expect(codes).toEqual([
      expect.stringContaining(`-x http://127.0.0.1:8080 https://redlog.verify.invalid/${nonce}`)
    ])
    for (const c of codes) expect(c).not.toMatch(/\s-k\b|--insecure/)
  })

  it('a new check gets a new nonce, and the old one no longer counts', async () => {
    install({ proxy: RUNNING })
    draw()
    const first = await shownNonce()
    await report({ scheme: 'https', rejected: true })
    fireEvent.click(await screen.findByTestId('first-run-http-retry'))
    const second = await shownNonce()
    expect(second).not.toBe(first)
    await report({ scheme: 'https', nonce: first })
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
    await report({ scheme: 'https', nonce: second })
    await waitFor(() => expect(screen.getByTestId('first-run-http-status').textContent).toBe('✓ 已驗證'))
  })

  it('follows a proxy started from outside the card, and starts listening for it', async () => {
    // The card is on screen from the first frame, beside the app-wide toggle.
    // Read once at mount, it kept offering to start a proxy that was running.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ rows: [], proxy: { state: 'stopped', url: null } })
    draw()
    await screen.findByText('啟動 HTTP 擷取')
    bridge.proxyStatus.mockResolvedValue(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500) })
    await screen.findByText('127.0.0.1:8080')
    await report({ scheme: 'https', nonce: await shownNonce() })
    expect((await screen.findByTestId('first-run-http-status')).textContent).toBe('✓ 已驗證')
  })

  it('does not listen while the proxy is not running', async () => {
    install({ proxy: { state: 'stopped', url: null } })
    draw()
    await screen.findByTestId('first-run-http')
    await waitFor(() => expect(bridge.proxyStatus).toHaveBeenCalled())
    expect(verifyListeners.length).toBe(0)
    fireEvent.click(screen.getByText('啟動 HTTP 擷取'))
    await waitFor(() => expect(verifyListeners.length).toBeGreaterThanOrEqual(1))
  })

  it('after 60 s names concrete reasons and still verifies a late request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ proxy: { ...RUNNING, certReady: false } })
    draw()
    await screen.findByText('127.0.0.1:8080')
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    expect(screen.queryByTestId('first-run-http-timeout')).toBeNull()
    fireEvent.click(screen.getByTestId('first-run-http-verify-own'))
    expect(window.redlog.app.openExternal).toHaveBeenCalledWith(`https://redlog.verify.invalid/${await shownNonce()}`)
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const why = await screen.findByTestId('first-run-http-timeout')
    expect(why.textContent).toContain('用擷取瀏覽器驗證')
    expect(why.textContent).toContain('HTTPS')
    expect(why.textContent).toContain('預設關閉')
    fireEvent.click(screen.getByTestId('first-run-http-verify-own'))
    expect(screen.queryByTestId('first-run-http-timeout')).toBeNull()
    await report({ scheme: 'https', nonce: await shownNonce() })
    await waitFor(() => expect(screen.getByTestId('first-run-http-status').textContent).toBe('✓ 已驗證'))
    expect(screen.queryByTestId('first-run-http-timeout')).toBeNull()
  })

  it('names a paused recording first when the check times out, since no check can pass then', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ proxy: { ...RUNNING } })
    ;(window as unknown as { redlog: { recording: unknown } }).redlog.recording = { get: async () => false, onChange: () => () => {} }
    draw()
    await screen.findByText('127.0.0.1:8080')
    fireEvent.click(screen.getByTestId('first-run-http-verify-own'))
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const why = await screen.findByTestId('first-run-http-timeout')
    expect(why.querySelector('li')?.textContent).toContain('錄製已暫停')
  })
})


describe('project command proof independent of recent display rows', () => {
  it('keeps historical command proof when only newer markers are displayed', async () => {
    install({ rows: [{ id: 'm1', timestamp: 3, agentType: 'marker', data: { text: 'latest marker' } }] })
    bridge.commandEvidence.mockResolvedValue({ builtin: false, external: true })
    draw()
    await waitFor(() => expect(screen.getByTestId('first-run-commands-status').textContent).toBe('✓ 已驗證'))
    expect(bridge.query).toHaveBeenCalledWith({ limit: 20, excludeHousekeeping: true })
  })

  it('shows a recoverable read failure when historical proof cannot be queried', async () => {
    install()
    bridge.commandEvidence.mockRejectedValueOnce(new Error('database unavailable'))
    draw()
    const failure = await screen.findByTestId('first-run-read-failed')
    expect(screen.getByTestId('first-run-commands-status').textContent).not.toBe('✓ 已驗證')
    fireEvent.click(failure.querySelector('button')!)
    await waitFor(() => expect(screen.getByTestId('first-run-commands-status').textContent).toBe('✓ 已驗證'))
  })
})


describe('external terminal first', () => {
  it('opens the built-in fallback only when requested', async () => {
    install({ rows: [] }); draw()
    await screen.findByTestId('first-run-record-terminal')
    expect(screen.queryByTestId('terminal')).toBeNull()
    fireEvent.click(screen.getByTestId('first-run-builtin-toggle'))
    expect(await screen.findByTestId('terminal')).toBeTruthy()
  })

  it('does not gate shell setup on optional web dependencies', async () => {
    install({ rows: [], pre: preflight({ missing: ['mitmdump'] }) }); draw()
    expect(await screen.findByTestId('first-run-record-terminal')).toBeTruthy()
    expect(screen.queryByTestId('capture-prepare')).toBeNull()
    fireEvent.click(await screen.findByTestId('first-run-http-prepare'))
    expect(await screen.findByTestId('capture-prepare')).toBeTruthy()
  })
})

it('invalidates HTTPS readiness on proxy stop and rejects the old nonce after restart', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  install({ proxy: RUNNING }); draw()
  const oldNonce = await shownNonce()
  await report({ scheme: 'https', nonce: oldNonce })
  await screen.findByTestId('first-run-core-ready')
  bridge.proxyStatus.mockResolvedValue({ state: 'stopped', url: null })
  await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
  expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
  expect(screen.queryByTestId('first-run-core-ready')).toBeNull()
  bridge.proxyStatus.mockResolvedValue(RUNNING)
  await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
  expect(await shownNonce()).not.toBe(oldNonce)
  await report({ scheme: 'https', nonce: oldNonce })
  expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
  await report({ scheme: 'https', nonce: await shownNonce() })
  expect(await screen.findByTestId('first-run-core-ready')).toBeTruthy()
})

it('offers manual shell setup even when the login shell is not supported', async () => {
  install({ rows: [], pre: preflight({ shell: null }) }); draw()
  expect(await screen.findByTestId('first-run-record-terminal')).toBeTruthy()
})

// #340: "verified earlier" is history. Whether capture is on right now is a
// separate fact, and a paused app must not read as a recording one.
describe('first run: verification history is not the current state (#340)', () => {
  const withRecording = (get: () => Promise<boolean>): { push: (on: boolean) => void } => {
    let cb: (on: boolean) => void = () => {}
    ;(window as unknown as { redlog: { recording: unknown } }).redlog.recording = {
      get, onChange: (f: (on: boolean) => void) => { cb = f; return () => { cb = () => {} } }
    }
    return { push: (on) => act(() => cb(on)) }
  }

  it('keeps the verification and says recording is paused right now', async () => {
    install({ rows: [BUILTIN] })
    withRecording(async () => false)
    draw()
    expect((await screen.findByTestId('first-run-commands-paused')).textContent).toContain('暫停')
    expect(screen.getByTestId('first-run-commands-verified')).toBeTruthy()
  })

  it('says nothing about pause while recording is on, and follows a change', async () => {
    install({ rows: [BUILTIN] })
    const rec = withRecording(async () => true)
    draw()
    await screen.findByTestId('first-run-commands-verified')
    expect(screen.queryByTestId('first-run-commands-paused')).toBeNull()
    rec.push(false)
    expect(await screen.findByTestId('first-run-commands-paused')).toBeTruthy()
    rec.push(true)
    await waitFor(() => expect(screen.queryByTestId('first-run-commands-paused')).toBeNull())
  })

  it('does not draw an unanswered state as paused', async () => {
    install({ rows: [BUILTIN] })
    withRecording(() => new Promise<boolean>(() => {}))
    draw()
    await screen.findByTestId('first-run-commands-verified')
    expect(screen.queryByTestId('first-run-commands-paused')).toBeNull()
  })

  it('keeps the verification after more than 20 non-command events', async () => {
    const noise: Ev[] = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, timestamp: 100 + i, agentType: 'marker', data: { subtype: 'marker', text: `m${i}` } }))
    install({ rows: [BUILTIN, ...noise] })
    bridge.query.mockImplementation(async () => noise.slice(0, 20))
    draw()
    expect(await screen.findByTestId('first-run-commands-verified')).toBeTruthy()
  })
})
