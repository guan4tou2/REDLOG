// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import { ToastContainer, UNDO_MS } from '../src/renderer/src/components/Toast'
import { I18nProvider } from '../src/renderer/src/i18n'

const capture: CaptureHealthInfo = {
  verdict: 'healthy', recording: true, lastEventAt: Date.now(), checkedAt: Date.now(),
  sources: [{ id: 'shell-hook', hookId: 'zsh', installed: true, lastEventAt: Date.now(), state: 'active' }]
}

function mount(): ReturnType<typeof vi.fn> {
  const uninstall = vi.fn(async () => ({ success: true, message: '' }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    hooks: { detect: vi.fn(async () => []), install: vi.fn(), uninstall },
    config: { get: vi.fn(async () => ({})), save: vi.fn(async () => true) }
  }
  render(
    <I18nProvider>
      <CaptureHealthCard capture={capture} onNavigate={() => {}} onRefresh={() => {}} />
      <ToastContainer />
    </I18nProvider>
  )
  fireEvent.click(screen.getByText(/all sources/i))
  return uninstall
}

const advance = async (ms: number): Promise<void> => {
  await act(async () => { vi.advanceTimersByTime(ms) })
}

// Settings ▸ Hooks holds a removal for the undo window and writes the profile
// only after it closes (SS10). The capture card's "remove" wrote at once, so
// the same hook came off with no way back depending on where it was clicked.
describe('capture card hook removal', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

  it('holds the uninstall for the undo window, showing it removed meanwhile', async () => {
    vi.useFakeTimers()
    const uninstall = mount()
    fireEvent.click(screen.getByText('remove'))
    expect(screen.getByText('install')).toBeTruthy()
    await advance(UNDO_MS - 500)
    expect(uninstall).not.toHaveBeenCalled()
    await advance(1000)
    expect(uninstall).toHaveBeenCalledWith('zsh')
  })

  it('never uninstalls if taken back, and shows the hook installed again', async () => {
    vi.useFakeTimers()
    const uninstall = mount()
    fireEvent.click(screen.getByText('remove'))
    fireEvent.click(screen.getByRole('button', { name: /undo/i }))
    expect(screen.getByText('remove')).toBeTruthy()
    await advance(UNDO_MS * 3)
    expect(uninstall).not.toHaveBeenCalled()
  })
})
