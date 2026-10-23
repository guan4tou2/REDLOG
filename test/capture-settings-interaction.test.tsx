// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import BrowserPanel from '../src/renderer/src/components/settings/BrowserPanel'
import ExternalCaptureGroup from '../src/renderer/src/components/settings/ExternalCaptureGroup'
import { I18nProvider } from '../src/renderer/src/i18n'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'

const t = (key: string): string => key
const initial = {
  engagement: { id: 'capture-settings-test' },
  browser: { binary: '', proxy: 'http://127.0.0.1:6661', cdpPort: 9222 },
  httpCapture: { port: 6661, listenHost: '127.0.0.1' }
} as ConfigState
let status: ReturnType<typeof vi.fn>
let start: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>
let detect: ReturnType<typeof vi.fn>
let health: ReturnType<typeof vi.fn>

beforeEach(() => {
  status = vi.fn().mockResolvedValue({ state: 'stopped', url: null })
  start = vi.fn().mockResolvedValue({ state: 'running', url: 'http://127.0.0.1:6661' })
  stop = vi.fn().mockResolvedValue({ state: 'stopped', url: null, staleTerminals: 2 })
  detect = vi.fn().mockResolvedValue([])
  health = vi.fn().mockResolvedValue({ sources: [] })
  Object.assign(window, { redlog: {
    browser: { detect: async () => null }, httpCapture: { status, start, stop },
    hooks: { detect }, capture: { health }
  } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function drawBrowser() {
  const saved = vi.fn()
  function Harness() {
    const [config, setConfig] = useState(initial)
    return <BrowserPanel t={t} config={config} setConfig={next => { saved(next); setConfig(next) }} />
  }
  render(<I18nProvider><Harness /></I18nProvider>)
  return saved
}
function drawExternal() {
  render(<I18nProvider><ExternalCaptureGroup t={t} /></I18nProvider>)
}
const external = { id: 'pcap-capture.tcpdump', name: 'tcpdump', available: true, disabled: false, description: 'tcpdump' }

describe('capture port editing', () => {
  it('keeps partial input until blur, then follows the managed proxy once', async () => {
    const saved = drawBrowser()
    const input = screen.getByLabelText('settings.httpCapturePort') as HTMLInputElement
    for (const value of ['', '7', '77', '777', '7777']) {
      fireEvent.change(input, { target: { value } })
      expect(input.value).toBe(value)
      expect(saved).not.toHaveBeenCalled()
    }
    fireEvent.blur(input)
    expect(saved).toHaveBeenCalledTimes(1)
    expect(saved.mock.calls[0][0]).toMatchObject({ httpCapture: { port: 7777 }, browser: { proxy: 'http://127.0.0.1:7777' } })
  })

  it('preserves invalid drafts and the last valid configuration, then accepts Enter', async () => {
    const saved = drawBrowser()
    const input = screen.getByLabelText('settings.httpCapturePort') as HTMLInputElement
    for (const value of ['', '1023', '65536', '1234.5']) {
      fireEvent.change(input, { target: { value } })
      fireEvent.blur(input)
      expect(input.value).toBe(value)
      expect(input.getAttribute('aria-invalid')).toBe('true')
      const ids = input.getAttribute('aria-describedby')!.split(' ')
      expect(ids.some(id => document.getElementById(id)?.textContent === 'settings.httpCapturePortInvalid')).toBe(true)
      expect(saved).not.toHaveBeenCalled()
    }
    input.focus()
    fireEvent.change(input, { target: { value: '8888' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(saved).toHaveBeenCalledTimes(1)
    expect(saved.mock.calls[0][0].httpCapture.port).toBe(8888)
    expect(input.getAttribute('aria-invalid')).not.toBe('true')
  })

  it('does not replace a custom upstream proxy when the capture port changes', () => {
    const saved = vi.fn()
    render(<I18nProvider><BrowserPanel t={t} config={{ ...initial, browser: { ...initial.browser, proxy: 'http://upstream.test:8080' } }} setConfig={saved} /></I18nProvider>)
    const input = screen.getByLabelText('settings.httpCapturePort')
    fireEvent.change(input, { target: { value: '7777' } })
    fireEvent.blur(input)
    expect(saved.mock.calls.at(-1)?.[0].browser.proxy).toBe('http://upstream.test:8080')
  })
})

describe('capture lifecycle actions', () => {
  it('refreshes an observed starting state so the control does not remain disabled forever', async () => {
    status.mockResolvedValueOnce({ state: 'starting', url: null }).mockResolvedValue({ state: 'running', url: 'http://127.0.0.1:6661' })
    drawBrowser()
    const pending = await screen.findByRole('button', { name: 'httpCapture.starting' })
    expect((pending as HTMLButtonElement).disabled).toBe(true)
    await screen.findByRole('button', { name: 'httpCapture.stop' }, { timeout: 2500 })
    expect(start).not.toHaveBeenCalled()
  })

  it('starts a stopped capture, prevents double start, and stops only after it is running', async () => {
    let finish!: (value: unknown) => void
    start.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    drawBrowser()
    const button = await screen.findByRole('button', { name: 'httpCapture.start' })
    fireEvent.click(button)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(start).toHaveBeenCalledTimes(1)
    await act(async () => finish({ state: 'running', url: 'http://127.0.0.1:6661' }))
    fireEvent.click(await screen.findByRole('button', { name: 'httpCapture.stop' }))
    await screen.findByText('httpCapture.staleTerminals')
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('does not pretend a failed status read is stopped or start a new process on retry', async () => {
    status.mockRejectedValueOnce(new Error('status bridge rejected'))
    drawBrowser()
    await screen.findByText('status bridge rejected')
    expect(screen.getByText('httpCapture.statusUnknown')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    await screen.findByRole('button', { name: 'httpCapture.start' })
    expect(start).not.toHaveBeenCalled()
  })

  it('keeps a rejected start visible and permits retry without an unhandled rejection', async () => {
    start.mockRejectedValueOnce(new Error('start bridge rejected'))
    drawBrowser()
    fireEvent.click(await screen.findByRole('button', { name: 'httpCapture.start' }))
    await screen.findByText('start bridge rejected')
    // The failed reply triggers a status read, not an automatic replay. Wait
    // until that read confirms stopped before issuing another Start.
    fireEvent.click(await screen.findByRole('button', { name: 'httpCapture.start' }))
    await screen.findByRole('button', { name: 'httpCapture.stop' })
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('rechecks actual state after an action rejects instead of presenting the old running state as current', async () => {
    status.mockResolvedValueOnce({ state: 'running', url: 'http://127.0.0.1:6661' }).mockResolvedValue({ state: 'stopped', url: null })
    stop.mockRejectedValueOnce(new Error('stop reply lost'))
    drawBrowser()
    fireEvent.click(await screen.findByRole('button', { name: 'httpCapture.stop' }))
    await screen.findByText('stop reply lost')
    await screen.findByRole('button', { name: 'httpCapture.start' })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('external source facts and failed reads', () => {
  it('keeps foreign setup aside without hiding a live producer', async () => {
    Object.assign(window.redlog, { platform: 'darwin' })
    const foreign = { ...external, id: 'pcap-capture.windows', name: 'Windows capture', platforms: ['win32'],
      manualSteps: [{ label: 'Windows only', command: 'powershell windows.ps1' }] }
    detect.mockResolvedValue([foreign])
    health.mockResolvedValue({ sources: [{ id: foreign.id, state: 'off', running: false }] })
    const { container } = render(<I18nProvider><ExternalCaptureGroup t={t} /></I18nProvider>)
    await screen.findByText(foreign.name)
    expect(container.querySelector('details')?.open).toBe(false)
    expect(container.querySelector('details')?.textContent).toContain(foreign.name)
    expect(container.textContent).not.toContain('powershell windows.ps1')
    health.mockResolvedValue({ sources: [{ id: foreign.id, state: 'ready', running: true }] })
    fireEvent.focus(window)
    await screen.findByText('settings.externalFeeding')
    expect(container.querySelector('details')).toBeNull()
  })

  it.each([false, true])('shows a live producer even when disabled=%s', async disabled => {
    detect.mockResolvedValue([{ ...external, disabled }])
    health.mockResolvedValue({ sources: [{ id: external.id, state: 'ready', lastEventAt: 123, running: true }] })
    drawExternal()
    await screen.findByText(disabled ? 'settings.externalDisabledFeeding' : 'settings.externalFeeding')
    expect(screen.queryByText('settings.externalIdle')).toBeNull()
  })

  it('shows a list read failure instead of hiding the entire section, and retries', async () => {
    detect.mockRejectedValueOnce(new Error('hooks query rejected')).mockResolvedValue([{ ...external }])
    health.mockResolvedValue({ sources: [{ id: external.id, state: 'off', running: false }] })
    drawExternal()
    await screen.findByText('hooks query rejected')
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    await screen.findByText('settings.externalNotRunning')
  })

  it('labels a failed health read unknown rather than stopped, then recovers', async () => {
    detect.mockResolvedValue([{ ...external }])
    health.mockRejectedValueOnce(new Error('health query rejected')).mockResolvedValue({ sources: [{ id: external.id, state: 'ready', running: true }] })
    drawExternal()
    await screen.findByText('health query rejected')
    expect(screen.getByText('settings.externalUnknown')).toBeTruthy()
    expect(screen.queryByText('settings.externalNotRunning')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    await screen.findByText('settings.externalFeeding')
  })

  it('retains the source after a failed refresh without presenting stale running as current', async () => {
    detect.mockResolvedValue([{ ...external }])
    health.mockResolvedValueOnce({ sources: [{ id: external.id, state: 'ready', running: true }] }).mockRejectedValue(new Error('refresh rejected'))
    drawExternal()
    await screen.findByText('settings.externalFeeding')
    fireEvent.focus(window)
    await screen.findByText('refresh rejected')
    expect(screen.getByText(external.name)).toBeTruthy()
    expect(screen.getByText('settings.externalUnknown')).toBeTruthy()
    expect(screen.queryByText('settings.externalFeeding')).toBeNull()
    await waitFor(() => expect(health).toHaveBeenCalledTimes(2))
  })

  // #435: a producer the operator started by hand is asked two questions —
  // is it running, and when did it last deliver. The chip answered the
  // first; the row now answers the second with the same words the other
  // source rows use.
  it('says when a running producer last delivered', async () => {
    detect.mockResolvedValue([{ ...external }])
    health.mockResolvedValue({ sources: [{ id: external.id, state: 'ready', lastEventAt: 1_700_000_000_000, running: true }] })
    drawExternal()
    await screen.findByText('settings.externalFeeding')
    expect(screen.getByTestId(`source-last-${external.id}`).textContent).toContain('settings.source.lastReceived')
  })

  it('says a running producer that has delivered nothing yet', async () => {
    detect.mockResolvedValue([{ ...external }])
    health.mockResolvedValue({ sources: [{ id: external.id, state: 'ready', lastEventAt: null, running: true }] })
    drawExternal()
    await screen.findByText('settings.externalFeeding')
    expect(screen.getByTestId(`source-last-${external.id}`).textContent).toContain('settings.source.neverReceived')
  })

  it('says nothing about a producer that was never started and never delivered', async () => {
    detect.mockResolvedValue([{ ...external }])
    health.mockResolvedValue({ sources: [{ id: external.id, state: 'off', lastEventAt: null, running: false }] })
    drawExternal()
    await screen.findByText('settings.externalNotRunning')
    expect(screen.queryByTestId(`source-last-${external.id}`)).toBeNull()
  })
})
