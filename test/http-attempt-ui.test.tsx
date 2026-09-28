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

import { HttpCaptureStep } from '../src/renderer/src/components/HttpCaptureStep'

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
    httpCapture: { onVerify: () => () => {}, status: bridge.proxyStatus, start: bridge.proxyStart, stop: vi.fn(async () => ({ state: 'stopped', url: null })) },
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
      <HttpCaptureStep />
    </I18nProvider>
  )
  return { onNavigate }
}

beforeEach(() => { localStorage.setItem('redlog-locale', 'zh-TW') })
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear() })

const RUNNING: ManagedProxyStatus = { state: 'running', url: 'http://127.0.0.1:8080', caPath: '/home/op/.mitmproxy/mitmproxy-ca-cert.pem' }
const HTTP_EVENT: Ev = { id: 'h1', timestamp: 10, agentType: 'scanner', data: { subtype: 'http_request_start', flow_id: 'f1', url: 'http://example.test/' } }

async function beginHttp(client = 'browser', url = 'https://example.test/') {
  fireEvent.change(await screen.findByLabelText('驗證來源'), { target: { value: client } })
  fireEvent.change(screen.getByLabelText('已授權的唯讀測試網址'), { target: { value: url } })
  fireEvent.click(screen.getByRole('button', { name: '產生測試' }))
  return (await screen.findByTestId('http-test-url')).textContent!
}
const response = (url: string): Ev => ({ id: 'response', timestamp: Date.now(), agentType: 'scanner', data: { subtype: 'http_response', url, status: 404 } })

describe('first run: HTTP verifies the selected attempt (Spec 040)', () => {
  it('rejects unrelated/request-only traffic and verifies only the selected client/protocol', async () => {
    install({ proxy: RUNNING })
    draw()
    const url = await beginHttp()
    emit([HTTP_EVENT, { ...HTTP_EVENT, data: { ...HTTP_EVENT.data, url } }])
    expect(screen.queryByTestId('http-attempt-verified')).toBeNull()
    emit([response(url)])
    expect((await screen.findByTestId('http-attempt-verified')).textContent).toContain('404')
    expect(screen.getByTestId('http-result-browser-https').textContent).toContain('404')
    expect(screen.getByTestId('http-result-terminal-https').textContent).toContain('尚未測試')
    expect(screen.getByTestId('http-result-browser-http').textContent).toContain('尚未測試')
  })

  it('replaces a retry token; an old response cannot verify the new attempt', async () => {
    install({ proxy: RUNNING })
    draw()
    const old = await beginHttp()
    fireEvent.click(screen.getByRole('button', { name: '產生測試' }))
    const next = screen.getByTestId('http-test-url').textContent!
    expect(next).not.toBe(old)
    emit([response(old)])
    await act(async () => {})
    expect(screen.queryByTestId('http-attempt-verified')).toBeNull()
    emit([response(next)])
    expect(await screen.findByTestId('http-attempt-verified')).toBeTruthy()
  })

  it('times out, keeps listening for this attempt and invalidates on proxy restart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install({ proxy: { ...RUNNING, pid: 11 } })
    draw()
    const url = await beginHttp()
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000) })
    expect(await screen.findByTestId('http-attempt-timeout')).toBeTruthy()
    emit([response(url)])
    expect(await screen.findByTestId('http-attempt-verified')).toBeTruthy()
    bridge.proxyStatus.mockResolvedValue({ ...RUNNING, pid: 12 })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(screen.queryByTestId('http-attempt-verified')).toBeNull()
    expect(screen.queryByTestId('http-test-url')).toBeNull()
  })

  it('does not accept a response if the proxy has stopped before the next status poll', async () => {
    install({ proxy: RUNNING })
    draw()
    const url = await beginHttp()
    bridge.proxyStatus.mockResolvedValue({ state: 'stopped', url: null })
    emit([response(url)])
    await act(async () => {})
    expect(screen.queryByTestId('http-attempt-verified')).toBeNull()
  })

  it('shows status errors and retries without implying capture is ready', async () => {
    install()
    bridge.proxyStatus.mockRejectedValue(new Error('status unavailable'))
    draw()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('status unavailable'))
    bridge.proxyStatus.mockResolvedValue(RUNNING)
    fireEvent.click(screen.getByRole('button', { name: '重新檢查' }))
    expect(await screen.findByLabelText('驗證來源')).toBeTruthy()
  })

  it('shows routing-save failure without pretending the checkbox was saved', async () => {
    install({ proxy: RUNNING })
    draw()
    await screen.findByLabelText('驗證來源')
    bridge.configSave.mockResolvedValue(false)
    fireEvent.click(screen.getByTestId('first-run-route-terminals'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect((screen.getByTestId('first-run-route-terminals') as HTMLInputElement).checked).toBe(false)
  })

  it('shows configuration-load failure and recovers through explicit retry', async () => {
    install({ proxy: RUNNING })
    const original = window.redlog.config.get
    window.redlog.config.get = vi.fn().mockRejectedValue(new Error('configuration unavailable'))
    draw()
    expect((await screen.findByRole('alert')).textContent).toContain('configuration unavailable')
    expect(screen.queryByLabelText('驗證來源')).toBeNull()
    window.redlog.config.get = original
    fireEvent.click(screen.getByRole('button', { name: '重新檢查' }))
    expect(await screen.findByLabelText('驗證來源')).toBeTruthy()
  })

  it('keeps a start rejection visible even after the next successful status poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    install()
    bridge.proxyStart.mockRejectedValue(new Error('proxy start rejected'))
    draw()
    fireEvent.click(await screen.findByText('開始 HTTP 擷取'))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('proxy start rejected'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(screen.getByRole('alert').textContent).toContain('proxy start rejected')
    bridge.proxyStart.mockResolvedValue(RUNNING)
    fireEvent.click(screen.getByText('再試一次'))
    expect(await screen.findByLabelText('驗證來源')).toBeTruthy()
  })

  it('keeps invalid URLs editable and shows failed copy without a false copied confirmation', async () => {
    install({ proxy: RUNNING })
    draw()
    await screen.findByLabelText('驗證來源')
    fireEvent.change(screen.getByLabelText('已授權的唯讀測試網址'), { target: { value: 'file:///tmp/x' } })
    fireEvent.click(screen.getByRole('button', { name: '產生測試' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByTestId('http-test-url')).toBeNull()
    await beginHttp()
    vi.mocked(window.redlog.clipboard.writeText).mockResolvedValue(false)
    const panel = screen.getByTestId('http-verification')
    fireEvent.click(Array.from(panel.querySelectorAll('button')).find((button) => button.textContent === '複製')!)
    expect((await screen.findByRole('alert')).textContent).toContain('複製失敗')
  })

  it('discloses untested system trust and never executes the generated terminal command', async () => {
    install({ proxy: { ...RUNNING, certReady: true } })
    draw()
    await beginHttp('terminal')
    expect(screen.getByTestId('http-test-command').textContent).toContain('--proxy')
    expect(screen.getByText(/不代表系統或其他工具已信任/)).toBeTruthy()
    expect(bridge.launch).not.toHaveBeenCalled()
  })
})
