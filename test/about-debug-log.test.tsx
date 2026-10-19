// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import AboutPage from '../src/renderer/src/components/settings/AboutPage'

const t = (key: string): string => key

function draw(initial: boolean) {
  const state = { enabled: initial, path: '/home/u/.redlog/debug.log' }
  const debug = {
    status: vi.fn(async () => ({ ...state })),
    set: vi.fn(async (on: boolean) => { state.enabled = on; return { ...state } }),
    reveal: vi.fn(async () => {})
  }
  ;(window as unknown as { redlog: unknown }).redlog = { debug, app: { checkForUpdates: vi.fn(), updateStatus: vi.fn(() => new Promise(() => {})), onUpdateStatus: vi.fn(() => () => {}) } }
  ;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = 'test'
  render(<AboutPage t={t} />)
  return debug
}

afterEach(() => cleanup())

describe('settings: debug log switch', () => {
  it('shows the current state and the file path', async () => {
    draw(true)
    const toggle = (await screen.findByTestId('debug-log-toggle')) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(screen.getByTestId('debug-log-path').textContent).toBe('/home/u/.redlog/debug.log')
  })

  it('turns the log on and reflects what main reports back', async () => {
    const debug = draw(false)
    const toggle = (await screen.findByTestId('debug-log-toggle')) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.checked).toBe(true))
    expect(debug.set).toHaveBeenCalledWith(true)
  })

  it('flips at once, before main has answered', async () => {
    const debug = draw(false)
    debug.set.mockImplementation(() => new Promise(() => {})) // never answers
    const toggle = (await screen.findByTestId('debug-log-toggle')) as HTMLInputElement
    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
  })

  it('goes back to what main reports when switching fails', async () => {
    const debug = draw(false)
    debug.set.mockRejectedValueOnce(new Error('disk full'))
    const toggle = (await screen.findByTestId('debug-log-toggle')) as HTMLInputElement
    fireEvent.click(toggle)
    await waitFor(() => expect(debug.status.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(toggle.checked).toBe(false))
  })

  it('reveals the file on request', async () => {
    const debug = draw(false)
    fireEvent.click(await screen.findByText('settings.debugLogReveal'))
    expect(debug.reveal).toHaveBeenCalled()
  })
})
