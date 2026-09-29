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
  query: ReturnType<typeof vi.fn>
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
    query: vi.fn(async () => opts.rows ?? [BUILTIN]),
    proxyStatus: vi.fn(async () => opts.proxy ?? { state: 'stopped', url: null }),
    proxyStart: vi.fn(async () => ({ state: 'running', url: 'http://127.0.0.1:8080' })),
    launch: vi.fn(async () => ({ ok: true })),
    verifyInBrowser: vi.fn(async () => ({ ok: true })),
    configSave: vi.fn(async () => true),
    listDistros: vi.fn(async () => opts.distros ?? []),
    wslInstall: vi.fn(async () => ({ success: true, message: 'ok' }))
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      query: bridge.query,
      onNewBatch: (cb: (evs: Ev[]) => void) => { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb) } }
    },
    runtime: { preflight: bridge.preflight },
    hooks: { install: bridge.install },
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
    expect(await screen.findByText('重新啟動 HTTP 擷取')).toBeTruthy()
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
    const missing = await screen.findByTestId('first-run-missing-deps')
    expect(screen.getByTestId('first-run-commands').contains(missing)).toBe(true)
    fireEvent.click(await screen.findByText('重新啟動 HTTP 擷取'))
    await waitFor(() => expect(bridge.proxyStart).toHaveBeenCalled())
  })

  it('verifies HTTP from a request alone, with no shell event, and leaves Commands pending', async () => {
    install({ rows: [], proxy: RUNNING })
    draw()
    await screen.findByText('127.0.0.1:8080')
    await report({ scheme: 'http', nonce: await shownNonce(), userAgent: 'curl/8.5.0' })
    expect((await screen.findByTestId('first-run-http-status')).textContent).toBe('✓ 已驗證')
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
    await report({ scheme: 'http', nonce: await shownNonce() })
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
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    const blocked = await screen.findByTestId('record-terminal-missing')
    expect(blocked.textContent).toContain('curl')
    expect(blocked.textContent).not.toContain('python3')
    expect(blocked.textContent).toContain('brew install curl')
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

    emit([{ id: 'x4', timestamp: 5, agentType: 'shell', data: { subtype: 'command_start', command: `echo ${nonce}` } }])
    expect((await screen.findByTestId('record-terminal-verified')).textContent).toContain('Zsh 已連線')
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

  it('stops listening once verified', async () => {
    install()
    draw()
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    const cmd = (await screen.findByTestId('record-terminal-command')).textContent ?? ''
    const before = snapshot()
    emit([{ id: 'x', timestamp: 5, agentType: 'shell', data: { subtype: 'command_end', command: cmd } }])
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
    const el = await screen.findByTestId('first-run-missing-deps')
    expect(el.textContent).toContain('python3')
    expect(el.textContent).toContain('brew install python')
    expect(el.textContent).not.toContain('curl')
  })

  it('shows the waiting state, not a dependency complaint, when everything is present', async () => {
    install({ rows: [], pre: preflight() })
    draw()
    await waitFor(() => expect(bridge.preflight).toHaveBeenCalled())
    expect(screen.queryByTestId('first-run-missing-deps')).toBeNull()
    expect(screen.getByTestId('first-run-commands-quick').textContent).toContain('echo redlog-ok')
  })
})

describe('first run: HTTP(S) card', () => {
  it('when mitmdump is missing, says so with the copyable install command and re-probes on return', async () => {
    install({ pre: preflight({ missing: ['mitmdump'] }), proxy: { state: 'unavailable', url: null } })
    draw()
    const card = await screen.findByTestId('first-run-http')
    expect(card.textContent).toContain('HTTP(S)')
    await waitFor(() => expect(card.textContent).toContain('mitmproxy 尚未安裝'))
    expect(card.textContent).toContain('uv tool install mitmproxy')
    // No re-check button: mitmproxy may have been installed in a terminal
    // while RedLog was in the background, and coming back asks again.
    expect(card.textContent).not.toContain('重新檢查')
    const before = bridge.preflight.mock.calls.length
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(bridge.preflight.mock.calls.length).toBeGreaterThan(before))
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
    // The CA stays behind a link until asked for.
    expect(card.textContent).not.toContain('mitmproxy-ca-cert.pem')
    fireEvent.click(screen.getByText('HTTPS 憑證'))
    expect(card.textContent).toContain('/home/op/.mitmproxy/mitmproxy-ca-cert.pem')

    const nonce = await shownNonce()
    fireEvent.click(screen.getByTestId('first-run-http-verify-browser'))
    await waitFor(() => expect(bridge.verifyInBrowser).toHaveBeenCalledWith(nonce))
  })
})

describe('first run: HTTP(S) card reports its own failures (UI/UX audit F6/F7)', () => {
  it('a rejected start shows the failure and offers a retry instead of resetting silently', async () => {
    install()
    bridge.proxyStart.mockRejectedValueOnce(new Error('port 8080 in use'))
    draw()
    fireEvent.click(await screen.findByRole('button', { name: '重新啟動 HTTP 擷取' }))
    const card = await screen.findByTestId('first-run-http')
    await waitFor(() => expect(card.textContent).toContain('port 8080 in use'))
    // One label for one button: the failure is stated above it, so the control
    // does not have to say "again" in one state and "start" in another.
    expect(screen.getByTestId('first-run-http-restart')).not.toBeNull()
  })

  // The terminal-proxy switch moved to Settings ▸ Browser, which owns every
  // other proxy setting; a global behaviour switch does not belong on the
  // screen where capture is being proved for the first time.

  it('a failed environment check says so, rather than reading as installed', async () => {
    install()
    bridge.preflight.mockRejectedValue(new Error('spawn failed'))
    draw()
    expect(await screen.findByTestId('first-run-http-preflight-failed')).not.toBeNull()
  })

  it('Copy says it copied', async () => {
    install({ pre: preflight({ missing: ['mitmdump'] }) })
    draw()
    const card = await screen.findByTestId('first-run-http')
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
  emit([{ id: 'v', timestamp: 9, agentType: 'shell', data: { subtype: 'command_end', command: cmd } }])
  return screen.findByTestId('record-terminal-verified')
}

describe('first run: a verified shell says what it records (Spec 039)', () => {
  it('names the metadata, says output is not included, and offers redlog-session', async () => {
    install()
    draw()
    await verifyShell()
    const scope = screen.getByTestId('record-terminal-scope')
    expect(scope.textContent).toContain('指令、結束碼、耗時、工作目錄')
    expect(scope.textContent).toContain('不含輸出')
    expect(screen.getByTestId('record-terminal-session-command').textContent).toBe('redlog-session')
  })

  // #218: "connected" proves the hook. The output check proves output.
  it('verifies output only when the canary text arrives in stdout, and says when only metadata did', async () => {
    install()
    draw()
    await verifyShell()
    const cmd = (await screen.findByTestId('record-terminal-output-command')).textContent ?? ''
    expect(cmd).toMatch(/^redlog-run printf '%s-%s\\n' redlog-out \S+$/)
    const nonce = cmd.split(' ').at(-1)!
    // The plain hook recorded the line, not what it printed.
    emit([{ id: 'm1', timestamp: 20, agentType: 'shell', data: { subtype: 'command_end', command: `printf '%s-%s\\n' redlog-out ${nonce}`, exit_code: 0 } }])
    expect((await screen.findByTestId('record-terminal-output-metadata-only')).textContent).toContain('只收到指令本身')
    emit([{ id: 'o1', timestamp: 21, agentType: 'shell', data: { subtype: 'command_end', command: cmd, stdout: `redlog-out-${nonce}\n`, captured_by: 'redlog-run' } }])
    expect((await screen.findByTestId('record-terminal-output-verified')).textContent).toContain('redlog-run')
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
    await waitFor(() => expect(screen.getByTestId('first-run-http-status').textContent).toBe('✓ 已驗證'))
    expect(screen.getByTestId('first-run-http-check-http').textContent).toContain('curl/8.5.0')
    expect(screen.getByTestId('first-run-http-check-https').getAttribute('data-verified')).toBe('false')
    await report({ scheme: 'https', nonce, userAgent: 'curl/8.5.0' })
    await waitFor(() => expect(screen.getByTestId('first-run-http-check-https').getAttribute('data-verified')).toBe('true'))
    await waitFor(() => expect(verifyListeners.length).toBe(0))
  })

  it('shows HTTPS from the capture browser with the caveat that it ignores certificate errors', async () => {
    install({ proxy: RUNNING })
    draw()
    const nonce = await shownNonce()
    await report({ scheme: 'https', nonce, userAgent: 'Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' })
    const https = await screen.findByTestId('first-run-http-check-https')
    await waitFor(() => expect(https.textContent).toContain('Chromium'))
    expect(https.textContent).toContain('忽略憑證錯誤')
    // HTTPS alone is not HTTP: the core step is still open.
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
  })

  it('says when a client refused the certificate', async () => {
    install({ proxy: RUNNING })
    draw()
    await shownNonce()
    await report({ scheme: 'https', rejected: true })
    await waitFor(() => expect(screen.getByTestId('first-run-http-check-https').textContent).toContain('拒絕了 RedLog 的憑證'))
  })

  it('offers terminal checks that never skip certificate verification', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ proxy: RUNNING })
    draw()
    const nonce = await shownNonce()
    // They are the fallback: the browser check is the first offer, and these
    // appear once it has not landed.
    expect(screen.queryByTestId('first-run-http-verify-commands')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const codes = [...screen.getByTestId('first-run-http-verify-commands').querySelectorAll('code')].map((c) => c.textContent ?? '')
    expect(codes).toEqual([
      expect.stringContaining(`-x http://127.0.0.1:8080 http://redlog.verify.invalid/${nonce}`),
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
    await report({ scheme: 'http', nonce: first })
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
    await report({ scheme: 'http', nonce: second })
    await waitFor(() => expect(screen.getByTestId('first-run-http-status').textContent).toBe('✓ 已驗證'))
  })

  it('follows a proxy started from outside the card, and starts listening for it', async () => {
    // The card is on screen from the first frame, beside the app-wide toggle.
    // Read once at mount, it kept offering to start a proxy that was running.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ rows: [], proxy: { state: 'stopped', url: null } })
    draw()
    await screen.findByText('重新啟動 HTTP 擷取')
    bridge.proxyStatus.mockResolvedValue(RUNNING)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500) })
    await screen.findByText('127.0.0.1:8080')
    await report({ scheme: 'http', nonce: await shownNonce() })
    expect((await screen.findByTestId('first-run-http-status')).textContent).toBe('✓ 已驗證')
  })

  it('does not listen while the proxy is not running', async () => {
    install({ proxy: { state: 'stopped', url: null } })
    draw()
    await screen.findByTestId('first-run-http')
    await waitFor(() => expect(bridge.proxyStatus).toHaveBeenCalled())
    expect(verifyListeners.length).toBe(0)
    fireEvent.click(screen.getByText('重新啟動 HTTP 擷取'))
    await waitFor(() => expect(verifyListeners.length).toBeGreaterThanOrEqual(1))
  })

  it('after 60 s names concrete reasons and still verifies a late request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ proxy: { ...RUNNING, certReady: false } })
    draw()
    // `first-run-http` is the section wrapper and is present in every state,
    // so finding it says nothing about whether the proxy has been reported as
    // running yet. The timeout timer is armed by the effect that runs *when*
    // it is (`if (!running || verified) return`), so advancing the clock
    // before that arms nothing and the banner never appears. Wait for the
    // running state, then advance.
    await screen.findByTestId('first-run-http')
    await screen.findByText('127.0.0.1:8080')
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const why = await screen.findByTestId('first-run-http-timeout')
    expect(why.textContent).toContain('用擷取瀏覽器驗證')
    expect(why.textContent).toContain('HTTPS')
    expect(why.textContent).toContain('預設關閉')
    await report({ scheme: 'http', nonce: await shownNonce() })
    await waitFor(() => expect(screen.getByTestId('first-run-http-status').textContent).toBe('✓ 已驗證'))
    expect(screen.queryByTestId('first-run-http-timeout')).toBeNull()
  })
})
