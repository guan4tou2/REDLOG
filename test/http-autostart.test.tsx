// @vitest-environment jsdom
//
// HTTP capture starts itself when a project opens
// (docs/UIUX-CONTROLS-AND-COPY.md §5). Command capture never asked permission
// to record; HTTP capture asked because starting it spawns a process and binds
// a port, which is a cost to RedLog and to nothing else on the machine — the
// system proxy settings are never touched, so no traffic moves until the
// operator launches the capture browser or opts terminals in.
//
// Two things must stay true after the button goes away: a failure is still
// visible, and RedLog does not keep trying.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { shouldAutoStartHttpCapture } from '../src/core/http-autostart'
import { HttpCaptureStep } from '../src/renderer/src/components/HttpCaptureStep'

describe('shouldAutoStartHttpCapture', () => {
  it('starts only when mitmproxy is there and nothing is running', () => {
    expect(shouldAutoStartHttpCapture({ mitmdumpOnPath: true, state: 'stopped' })).toBe(true)
  })

  it('does not report a dependency the operator may never need', () => {
    // A machine with no mitmproxy would otherwise write a failure event into
    // every engagement opened on it.
    expect(shouldAutoStartHttpCapture({ mitmdumpOnPath: false, state: 'stopped' })).toBe(false)
  })

  it('leaves every other state alone', () => {
    for (const state of ['running', 'starting', 'failed', 'unavailable'] as const) {
      expect(shouldAutoStartHttpCapture({ mitmdumpOnPath: true, state })).toBe(false)
    }
  })
})

const proxy = (over: Partial<ManagedProxyStatus> = {}): ManagedProxyStatus =>
  ({ state: 'stopped', url: null, ...over }) as ManagedProxyStatus

function mount(status: ManagedProxyStatus, options: { missing?: boolean } = {}): { start: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn> } {
  const start = vi.fn(async () => proxy({ state: 'running', url: 'http://127.0.0.1:8080' }))
  const prepare = vi.fn()
  ;(window as unknown as { redlog: unknown }).redlog = {
    runtime: {
      preflight: vi.fn(async () => ({
        platform: 'linux',
        shell: { name: 'zsh', hookId: 'shell-zsh' },
        checks: [{ id: 'mitmdump', found: !options.missing, neededFor: ['mitmproxy'], remediation: 'uv tool install mitmproxy' }]
      })),
      install: vi.fn()
    },
    httpCapture: {
      status: vi.fn(async () => status),
      start,
      stop: vi.fn(),
      verifyInBrowser: vi.fn(),
      onVerify: () => () => {}
    },
    config: { get: async () => ({}), save: vi.fn(async () => true) },
    clipboard: { writeText: vi.fn(async () => true), readText: async () => '' },
    app: { openExternal: vi.fn() }
  }
  render(<I18nProvider><HttpCaptureStep onPrepare={prepare} /></I18nProvider>)
  return { start, prepare }
}

beforeEach(() => { localStorage.setItem('redlog-locale', 'zh-TW') })
afterEach(() => { cleanup(); localStorage.clear() })

describe('the HTTP card after the start button', () => {
  it('returns missing HTTP tools to the same preparation entry without claiming verification', async () => {
    const { prepare } = mount(proxy({ state: 'unavailable' }), { missing: true })
    ;(await screen.findByTestId('first-run-http-prepare')).click()
    expect(prepare).toHaveBeenCalledOnce()
    expect(window.redlog.runtime.install).not.toHaveBeenCalled()
    expect(screen.getByTestId('first-run-http-status').textContent).toBe('○ 尚未驗證')
  })

  it('never offers to start what opening the project already started', async () => {
    mount(proxy({ state: 'running', url: 'http://127.0.0.1:8080' }))
    await screen.findByTestId('first-run-http-checks')
    expect(screen.queryByText('開始 HTTP 擷取')).toBeNull()
  })

  it('offers Start when stopped, matching the settings control', async () => {
    const { start } = mount(proxy({ state: 'stopped' }))
    const restart = await screen.findByTestId('first-run-http-restart')
    expect(restart.textContent).toBe('啟動 HTTP 擷取')
    expect(screen.queryByText('開始 HTTP 擷取')).toBeNull()
    restart.click()
    await waitFor(() => expect(start).toHaveBeenCalled())
  })

  it('offers Retry after installing the dependency if proxy status is still unavailable', async () => {
    const { start } = mount(proxy({ state: 'unavailable', error: 'mitmdump was missing at project open' }))
    const retry = await screen.findByTestId('first-run-http-restart')
    expect(retry.textContent).toBe('重試')
    retry.click()
    await waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('first-run-http-prepare')).toBeNull()
  })

  it('shows why a failed start failed, beside the restart', async () => {
    mount(proxy({ state: 'failed', error: 'port 8080 held by burpsuite (pid 4412)' }))
    const card = await screen.findByTestId('first-run-http')
    expect(card.textContent).toContain('burpsuite')
    expect(await screen.findByTestId('first-run-http-restart')).toBeTruthy()
  })
})
