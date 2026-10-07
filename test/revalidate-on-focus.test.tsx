// @vitest-environment jsdom
//
// Ten "Re-check" buttons existed because RedLog never noticed the machine had
// changed (docs/UIUX-CONTROLS-AND-COPY.md §5). Coming back to the window IS
// the notification: the operator left, installed something, and returned.
//
// The distinction this file pins: re-asking a stale question is automatic, and
// retrying a failed action is not. A probe that threw, or a read that failed,
// keeps its own button — returning to the window says nothing about whether
// that action would succeed now.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { useRevalidateOnFocus } from '../src/renderer/src/hooks/useRevalidateOnFocus'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ default: () => <div data-testid="terminal" /> }))
import { FirstRunView } from '../src/renderer/src/components/FirstRunView'

const focus = (): void => { act(() => { window.dispatchEvent(new Event('focus')) }) }
const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

beforeEach(() => {
  localStorage.setItem('redlog-locale', 'zh-TW')
  setHidden(false)
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('useRevalidateOnFocus', () => {
  it('re-asks when the window comes back, and not more than once per return', () => {
    const cb = vi.fn()
    renderHook(() => useRevalidateOnFocus(cb))
    expect(cb).not.toHaveBeenCalled()   // mount is not a return

    focus()
    expect(cb).toHaveBeenCalledTimes(1)

    // focus and visibilitychange both fire on one return; that is one return.
    setHidden(false)
    focus()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ignores focus while the page is hidden', () => {
    const cb = vi.fn()
    renderHook(() => useRevalidateOnFocus(cb))
    setHidden(true)
    focus()
    expect(cb).not.toHaveBeenCalled()
  })

  it('stops listening once unmounted', () => {
    const cb = vi.fn()
    const { unmount } = renderHook(() => useRevalidateOnFocus(cb, { minIntervalMs: 0 }))
    unmount()
    focus()
    expect(cb).not.toHaveBeenCalled()
  })

  it('calls the latest callback without resubscribing', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ cb }) => useRevalidateOnFocus(cb, { minIntervalMs: 0 }), {
      initialProps: { cb: first }
    })
    rerender({ cb: second })
    focus()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

/** The Windows machine from the F6 fix: the execution policy blocks $PROFILE. */
const winPreflight = (blocks: boolean): RuntimePreflight => ({
  platform: 'win32',
  shell: { name: 'powershell', hookId: 'shell-powershell' },
  checks: [
    { id: 'powershell', found: true, neededFor: ['shell-powershell'] },
    { id: 'pwsh', found: false, neededFor: ['shell-powershell'] },
    { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
  ],
  powershell: { shell: 'powershell', policy: blocks ? 'Restricted' : 'RemoteSigned', blocksProfile: blocks }
})

function install(preflight: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { query: vi.fn(async () => []), onNewBatch: () => () => {} },
    runtime: { preflight, install: vi.fn() },
    hooks: { install: vi.fn(async () => ({ success: true, message: 'ok' })) },
    app: { openExternal: vi.fn(async () => {}) },
    httpCapture: {
      status: vi.fn(async () => ({ state: 'stopped', url: null })),
      start: vi.fn(), stop: vi.fn(), verifyInBrowser: vi.fn(), onVerify: () => () => {}
    },
    browser: { launch: vi.fn() },
    config: { get: async () => ({}), save: vi.fn(async () => true) },
    clipboard: { writeText: vi.fn(async () => true), readText: async () => '' },
    wsl: { listDistros: vi.fn(async () => []), installHook: vi.fn() }
  }
}

describe('first run re-asks by itself', () => {
  it('clears a blocker the operator fixed in a terminal, with no button to press', async () => {
    const preflight = vi.fn(async () => winPreflight(true))
    install(preflight)
    render(<I18nProvider><FirstRunView onNavigate={vi.fn()} renderCaptureCard={() => <div />} /></I18nProvider>)
    await screen.findByTestId('first-run-blocked')

    // The operator goes to a terminal, changes the policy, and comes back.
    preflight.mockResolvedValue(winPreflight(false))
    focus()

    await waitFor(() => expect(screen.queryByTestId('first-run-blocked')).toBeNull())
    expect(await screen.findByTestId('first-run-commands-quick')).toBeTruthy()
  })

  it('has no re-check button on a blocker, because returning is the re-check', async () => {
    install(vi.fn(async () => winPreflight(true)))
    render(<I18nProvider><FirstRunView onNavigate={vi.fn()} renderCaptureCard={() => <div />} /></I18nProvider>)
    const blocked = await screen.findByTestId('first-run-blocked')
    expect(blocked.querySelectorAll("button")).toHaveLength(2)   // copy the command, run it in the terminal
    expect(blocked.textContent).not.toContain('重新檢查')
  })

  it('keeps a retry when the probe itself failed', async () => {
    install(vi.fn(async () => { throw new Error('probe blew up') }))
    render(<I18nProvider><FirstRunView onNavigate={vi.fn()} renderCaptureCard={() => <div />} /></I18nProvider>)
    const failed = await screen.findByTestId('first-run-preflight-failed')
    expect(failed.querySelector('button')).not.toBeNull()
  })
})
