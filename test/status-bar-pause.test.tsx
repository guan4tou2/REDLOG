// @vitest-environment jsdom
//
// The red item in the status bar used to pause capture on the first click. A
// first-time operator clicked it to read about the recording and stopped
// capture (owner decision 2026-11-19): while recording, the first click now
// shows the state, and pausing is the popover's button.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StatusBar from '../src/renderer/src/components/StatusBar'
import { I18nProvider } from '../src/renderer/src/i18n'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues } from '../src/renderer/src/lib/issues'

vi.mock('../src/renderer/src/components/Toast', async (orig) => ({
  ...(await orig<typeof import('../src/renderer/src/components/Toast')>()),
  toast: vi.fn(),
  toastUndo: vi.fn()
}))

const noop = (): void => {}
const toggle = vi.fn(async () => false)

function installBridge(recording: boolean | 'unknown'): void {
  const named: Record<string, Record<string, unknown>> = {
    capture: { health: async () => ({ verdict: 'healthy', hasRecorded: true, sources: [], lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null }) },
    project: { active: async () => ({ name: 'acme-internal', createdAt: Date.now() - 65_000 }) },
    recording: { get: recording === 'unknown' ? async () => { throw new Error('ipc') } : async () => recording, onChange: () => noop, toggle },
    overlay: { isVisible: async () => false, onVisibilityChanged: () => noop },
    ip: { getStatus: async () => null, onStatus: () => noop }
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target ? target[fn] : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({}, { get: (_t, name: string) => area(name) })
}

async function show(recording: boolean | 'unknown', locale = 'en'): Promise<HTMLElement> {
  window.localStorage.setItem('redlog-locale', locale)
  installBridge(recording)
  render(<I18nProvider><StatusBar /></I18nProvider>)
  const want = recording === 'unknown' ? 'unknown' : recording ? 'on' : 'off'
  return waitFor(() => {
    const el = screen.getByTestId('status-bar-recording')
    expect(el.getAttribute('data-recording')).toBe(want)
    return el
  })
}

beforeEach(() => { window.localStorage.clear(); toggle.mockClear(); _resetCaptureHealth(); _resetIssues() })
afterEach(() => { cleanup(); _resetCaptureHealth(); _resetIssues() })

describe('status bar recording item', () => {
  it('while recording, the first click shows the state and pauses nothing', async () => {
    const item = await show(true)
    fireEvent.click(item)
    const pop = await screen.findByTestId('status-bar-recording-popover')
    expect(toggle).not.toHaveBeenCalled()
    expect(pop.textContent).toContain('Recording into acme-internal')
    expect(pop.textContent).toMatch(/\d:\d\d since the project was created/)
    expect(pop.querySelectorAll('button')).toHaveLength(1)
    expect(screen.getByTestId('status-bar-pause').textContent).toContain('Pause recording')
    expect(item.getAttribute('aria-haspopup')).toBe('dialog')
    expect(item.getAttribute('aria-expanded')).toBe('true')
  })

  it('says the same in Traditional Chinese', async () => {
    const item = await show(true, 'zh-TW')
    fireEvent.click(item)
    const pop = await screen.findByTestId('status-bar-recording-popover')
    expect(pop.textContent).toContain('正在錄製到「acme-internal」')
    expect(screen.getByTestId('status-bar-pause').textContent).toContain('暫停錄製')
  })

  it('the popover button is the second step: it pauses once and closes', async () => {
    const item = await show(true)
    fireEvent.click(item)
    fireEvent.click(await screen.findByTestId('status-bar-pause'))
    await waitFor(() => expect(toggle).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('status-bar-recording-popover')).toBeNull()
    expect(document.activeElement).toBe(item)
  })

  it('while paused, one click resumes at once and opens nothing', async () => {
    const item = await show(false)
    fireEvent.click(item)
    await waitFor(() => expect(toggle).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('status-bar-recording-popover')).toBeNull()
    expect(item.getAttribute('aria-haspopup')).toBeNull()
  })

  it('with the state unknown there is no popover and no toggle', async () => {
    const item = await show('unknown')
    fireEvent.click(item)
    expect(screen.queryByTestId('status-bar-recording-popover')).toBeNull()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('moves focus to the button, and Escape closes and returns focus to the item', async () => {
    const item = await show(true)
    item.focus()
    fireEvent.click(item)
    const button = await screen.findByTestId('status-bar-pause')
    await waitFor(() => expect(document.activeElement).toBe(button))
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByTestId('status-bar-recording-popover')).toBeNull()
    expect(document.activeElement).toBe(item)
    expect(item.getAttribute('aria-expanded')).toBe('false')
    expect(toggle).not.toHaveBeenCalled()
  })

  it('a click outside closes it without pausing', async () => {
    const item = await show(true)
    fireEvent.click(item)
    await screen.findByTestId('status-bar-recording-popover')
    const backdrop = document.querySelector('.fixed.inset-0') as HTMLElement
    fireEvent.click(backdrop)
    expect(screen.queryByTestId('status-bar-recording-popover')).toBeNull()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('its tooltip no longer says the click pauses', async () => {
    const item = await show(true)
    await waitFor(() => expect(item.getAttribute('aria-label')).toMatch(/Show recording state/))
  })
})
