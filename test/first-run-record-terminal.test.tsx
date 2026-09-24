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
    checks,
    legacyHooks: over.legacyHooks ?? []
  }
}

const BUILTIN: Ev = { id: 'b1', timestamp: 1, agentType: 'shell', data: { subtype: 'command_end', source: 'builtin-terminal', command: 'id' } }

let listeners: Array<(evs: Ev[]) => void>
let bridge: {
  preflight: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  proxyStatus: ReturnType<typeof vi.fn>
  proxyStart: ReturnType<typeof vi.fn>
  launch: ReturnType<typeof vi.fn>
  configSave: ReturnType<typeof vi.fn>
  listDistros: ReturnType<typeof vi.fn>
  wslInstall: ReturnType<typeof vi.fn>
}

function install(opts: { rows?: Ev[]; pre?: Preflight; proxy?: ManagedProxyStatus; distros?: WslDistro[] } = {}): void {
  listeners = []
  bridge = {
    preflight: vi.fn(async () => opts.pre ?? preflight()),
    install: vi.fn(async () => ({ success: true, message: 'ok' })),
    query: vi.fn(async () => opts.rows ?? [BUILTIN]),
    proxyStatus: vi.fn(async () => opts.proxy ?? { state: 'stopped', url: null }),
    proxyStart: vi.fn(async () => ({ state: 'running', url: 'http://127.0.0.1:8080' })),
    launch: vi.fn(async () => ({ ok: true })),
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
    httpCapture: { status: bridge.proxyStatus, start: bridge.proxyStart, stop: vi.fn(async () => ({ state: 'stopped', url: null })) },
    browser: { launch: bridge.launch },
    config: { get: async () => ({ httpCapture: { port: 8080, routeTerminals: false } }), save: bridge.configSave },
    clipboard: { writeText: vi.fn(async () => true), readText: async () => '' },
    wsl: { listDistros: bridge.listDistros, installHook: bridge.wslInstall }
  }
}

function emit(evs: Ev[]): void {
  act(() => { for (const l of listeners) l(evs) })
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

describe('first run: after the built-in terminal records a command', () => {
  it('says RedLog works and makes "record my <detected shell> terminal" the primary CTA', async () => {
    install()
    const { onNavigate } = draw()
    expect(await screen.findByText('✓ 已記下這道指令。RedLog 可以正常記錄。接下來可以連接你平常工作的終端。')).toBeTruthy()
    const cta = await screen.findByTestId('first-run-record-terminal')
    expect(cta.textContent).toBe('記我的 Zsh 終端')
    // The timeline is still reachable, but as the secondary text link.
    expect(screen.queryByTestId('first-run-open-timeline')).toBeNull()
    fireEvent.click(screen.getByText('只用 RedLog 內建終端 →'))
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
  it('blocks the install when curl is missing, names curl and its remediation, and re-checks on demand', async () => {
    install({ pre: preflight({ missing: ['curl'] }) })
    draw()
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    const blocked = await screen.findByTestId('record-terminal-missing')
    expect(blocked.textContent).toContain('curl')
    expect(blocked.textContent).not.toContain('python3')
    expect(blocked.textContent).toContain('brew install curl')
    expect(bridge.install).not.toHaveBeenCalled()

    bridge.preflight.mockResolvedValue(preflight())
    fireEvent.click(screen.getByText('重新檢查'))
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

    // By the time the wait expires the operator's machine has changed: python3
    // went missing and a retired hook line is still in .zshrc.
    bridge.preflight.mockResolvedValue(preflight({
      missing: ['python3'],
      legacyHooks: [{ file: '/home/op/.zshrc', line: 12, text: 'source ~/redlog/shell-preexec-hook.sh', hookId: 'shell-zsh' }]
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const why = await screen.findByTestId('record-terminal-timeout')
    expect(why.textContent).toContain('新的')
    expect(why.textContent).toContain('python3')
    expect(why.textContent).toContain('/home/op/.zshrc')

    fireEvent.click(screen.getByText('再試一次'))
    // The retry re-runs preflight — which now blocks on python3.
    expect((await screen.findByTestId('record-terminal-missing')).textContent).toContain('python3')
    bridge.preflight.mockResolvedValue(preflight())
    fireEvent.click(screen.getByText('重新檢查'))
    const second = (await screen.findByTestId('record-terminal-command')).textContent
    expect(second).not.toBe(first)
  })

  it('stops listening once verified', async () => {
    install()
    draw()
    fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
    const cmd = (await screen.findByTestId('record-terminal-command')).textContent ?? ''
    const before = listeners.length
    emit([{ id: 'x', timestamp: 5, agentType: 'shell', data: { subtype: 'command_end', command: cmd } }])
    await screen.findByTestId('record-terminal-verified')
    expect(listeners.length).toBe(before - 1)
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
    expect(screen.getByText('還沒有任何紀錄')).toBeTruthy()
  })
})

describe('first run: optional HTTP card', () => {
  it('when mitmdump is missing, says so with the copyable install command and a re-check', async () => {
    install({ pre: preflight({ missing: ['mitmdump'] }), proxy: { state: 'unavailable', url: null } })
    draw()
    const card = await screen.findByTestId('first-run-http')
    expect(card.textContent).toContain('記錄這場的 HTTP(S) 流量（Web 測試）')
    await waitFor(() => expect(card.textContent).toContain('mitmproxy 尚未安裝'))
    expect(card.textContent).toContain('uv tool install mitmproxy')
    expect(card.textContent).toContain('重新檢查')
  })

  it('when running, shows the listen address, the browser launch, and the accurate routeTerminals limit', async () => {
    install({ proxy: { state: 'running', url: 'http://127.0.0.1:8080', caPath: '/home/op/.mitmproxy/mitmproxy-ca-cert.pem' } })
    draw()
    const card = await screen.findByTestId('first-run-http')
    await waitFor(() => expect(card.textContent).toContain('正在監聽 127.0.0.1:8080'))
    expect(card.textContent).toContain('只影響支援 HTTP_PROXY 的工具（curl、wget、Python/Node HTTP 客戶端）；nmap SYN 掃描、SMB、LDAP、RDP 不會經過這個代理。')
    // The CA stays behind a link until asked for.
    expect(card.textContent).not.toContain('mitmproxy-ca-cert.pem')
    fireEvent.click(screen.getByText('HTTPS 憑證'))
    expect(card.textContent).toContain('/home/op/.mitmproxy/mitmproxy-ca-cert.pem')

    fireEvent.click(screen.getByText('開啟代理瀏覽器'))
    await waitFor(() => expect(bridge.launch).toHaveBeenCalled())
    fireEvent.click(screen.getByTestId('first-run-route-terminals'))
    await waitFor(() => expect(bridge.configSave).toHaveBeenCalledWith(
      expect.objectContaining({ httpCapture: expect.objectContaining({ routeTerminals: true }) })
    ))
  })
})

// Spec 039: "connected" must say what is recorded, and HTTP is verified by the
// first request that reaches RedLog, not by the proxy process running.
async function verifyShell(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('first-run-record-terminal'))
  const cmd = (await screen.findByTestId('record-terminal-command')).textContent ?? ''
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

  it('does not offer redlog-session for PowerShell, which has no such command', async () => {
    install({ pre: preflight({ platform: 'win32', shell: { name: 'powershell', hookId: 'shell-powershell' } }) })
    draw()
    await verifyShell()
    expect(screen.getByTestId('record-terminal-scope').textContent).toContain('不含輸出')
    expect(screen.queryByTestId('record-terminal-session-command')).toBeNull()
    expect(screen.getByTestId('record-terminal-scope').textContent).toContain('內建終端')
  })
})

const RUNNING: ManagedProxyStatus = { state: 'running', url: 'http://127.0.0.1:8080', caPath: '/home/op/.mitmproxy/mitmproxy-ca-cert.pem' }
const HTTP_EVENT: Ev = { id: 'h1', timestamp: 10, agentType: 'scanner', data: { subtype: 'http_request_start', flow_id: 'f1', url: 'http://example.test/' } }

describe('first run: HTTP is verified by the first request (Spec 039)', () => {
  it('waits while the proxy runs and verifies only on an HTTP request event, then stops listening', async () => {
    install({ proxy: RUNNING })
    draw()
    const card = await screen.findByTestId('first-run-http')
    await waitFor(() => expect(card.textContent).toContain('等第一筆 HTTP 請求'))
    const before = listeners.length
    emit([{ id: 's', timestamp: 3, agentType: 'shell', data: { subtype: 'command_end', command: 'curl x' } }])
    emit([{ id: 'n', timestamp: 4, agentType: 'network', data: { subtype: 'connection' } }])
    expect(screen.queryByTestId('first-run-http-verified')).toBeNull()
    emit([HTTP_EVENT])
    expect((await screen.findByTestId('first-run-http-verified')).textContent).toContain('HTTP 擷取已驗證')
    expect(listeners.length).toBe(before - 1)
  })

  it('does not listen while the proxy is not running', async () => {
    install({ proxy: { state: 'stopped', url: null } })
    draw()
    await screen.findByTestId('first-run-http')
    const before = listeners.length
    emit([HTTP_EVENT])
    expect(screen.queryByTestId('first-run-http-verified')).toBeNull()
    fireEvent.click(screen.getByText('開始 HTTP 擷取'))
    await waitFor(() => expect(listeners.length).toBe(before + 1))
  })

  it('after 60 s names concrete reasons and still verifies a late request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ proxy: { ...RUNNING, certReady: false } })
    draw()
    await screen.findByTestId('first-run-http')
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    const why = await screen.findByTestId('first-run-http-timeout')
    expect(why.textContent).toContain('開啟代理瀏覽器')
    expect(why.textContent).toContain('HTTPS')
    expect(why.textContent).toContain('預設關閉')
    emit([HTTP_EVENT])
    expect(await screen.findByTestId('first-run-http-verified')).toBeTruthy()
    expect(screen.queryByTestId('first-run-http-timeout')).toBeNull()
  })
})
