// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CapturePreparation, preparationChecks } from '../src/renderer/src/components/CapturePreparation'

const preflight = (missing = true): RuntimePreflight => ({
  platform: 'darwin', shell: { name: 'zsh', hookId: 'shell-zsh' },
  checks: [
    { id: 'python3', found: true, neededFor: [] },
    { id: 'curl', found: true, neededFor: [] },
    { id: 'zsh', found: true, neededFor: [] },
    { id: 'bash', found: false, neededFor: [] },
    { id: 'mitmdump', found: !missing, neededFor: ['mitmproxy'], remediation: 'uv tool install mitmproxy' }
  ]
})
const draw = (pf: RuntimePreflight | null = preflight(), failed = false) => {
  const recheck = vi.fn(), skip = vi.fn(), leave = vi.fn()
  const view = render(<I18nProvider><CapturePreparation preflight={pf} failed={failed} onRecheck={recheck} onSkip={skip} onLeave={leave} /></I18nProvider>)
  return { recheck, skip, leave, unmount: view.unmount }
}
beforeEach(() => {
  localStorage.setItem('redlog-locale', 'en')
  ;(window as unknown as { redlog: unknown }).redlog = {
    runtime: { install: vi.fn(async () => ({ success: false, message: 'download unavailable' })), cancelInstall: vi.fn(async () => true) },
    clipboard: { writeText: vi.fn(async () => true) },
    app: { openExternal: vi.fn() }
  }
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('capture preparation', () => {
  it('shows the bounded wait and lets the operator cancel without claiming capture is ready', async () => {
    let finish!: (result: { success: boolean; message: string; cancelled: boolean }) => void
    vi.mocked(window.redlog.runtime.install).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    vi.mocked(window.redlog.runtime.cancelInstall).mockImplementation(async () => {
      finish({ success: false, message: 'Installation cancelled', cancelled: true })
      return true
    })
    const { recheck } = draw()
    fireEvent.click(screen.getByTestId('prepare-install-mitmdump'))
    expect(screen.getByTestId('prepare-install-status-mitmdump').textContent).toContain('15 minutes')
    fireEvent.click(screen.getByTestId('prepare-cancel-mitmdump'))
    expect((await screen.findByTestId('prepare-cancelled-mitmdump')).textContent).toContain('Installation cancelled')
    expect(screen.queryByTestId('prepare-error-mitmdump')).toBeNull()
    expect(window.redlog.runtime.cancelInstall).toHaveBeenCalledWith('mitmdump')
    expect(recheck).not.toHaveBeenCalled()
    expect((screen.getByTestId('prepare-install-mitmdump') as HTMLButtonElement).disabled).toBe(false)
  })

  it('cancels only its pending dependency when leaving preparation', () => {
    vi.mocked(window.redlog.runtime.install).mockImplementation(() => new Promise(() => {}))
    const { unmount } = draw()
    fireEvent.click(screen.getByTestId('prepare-install-mitmdump'))
    unmount()
    expect(window.redlog.runtime.cancelInstall).toHaveBeenCalledExactlyOnceWith('mitmdump')
  })
  it('lists only missing dependencies for the selected capture paths', () => {
    draw()
    expect(screen.getByTestId('prepare-dependency-mitmdump')).toBeTruthy()
    expect(screen.queryByTestId('prepare-dependency-bash')).toBeNull()
    expect(screen.queryByTestId('prepare-dependency-python3')).toBeNull()
    expect(screen.queryByText('uv tool install mitmproxy')).toBeNull()
    expect(preparationChecks({ ...preflight(), platform: 'win32', shell: { name: 'pwsh', hookId: 'shell-powershell' }, checks: [
      { id: 'powershell', found: false, neededFor: [] }, { id: 'pwsh', found: true, neededFor: [] }
    ] })).toEqual([])
  })
  it('keeps failure, manual remedy and retry without advancing', async () => {
    const { recheck } = draw()
    fireEvent.click(screen.getByTestId('prepare-install-mitmdump'))
    const error = await screen.findByTestId('prepare-error-mitmdump')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('download unavailable')
    expect(error.textContent).toContain('uv tool install mitmproxy')
    expect(recheck).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('prepare-install-mitmdump'))
    await waitFor(() => expect(window.redlog.runtime.install).toHaveBeenCalledTimes(2))
  })
  it('rechecks observed readiness after installation instead of trusting exit success', async () => {
    vi.mocked(window.redlog.runtime.install).mockResolvedValue({ success: true, message: 'installed' })
    const { recheck } = draw()
    fireEvent.click(screen.getByTestId('prepare-install-mitmdump'))
    await waitFor(() => expect(recheck).toHaveBeenCalledOnce())
    expect(screen.getByTestId('prepare-dependency-mitmdump')).toBeTruthy()
  })
  it('keeps a rejected IPC visible and leaves an escape to recording or the app', async () => {
    vi.mocked(window.redlog.runtime.install).mockRejectedValue(new Error('installer offline'))
    const { skip, leave } = draw()
    fireEvent.click(screen.getByTestId('prepare-install-mitmdump'))
    expect((await screen.findByTestId('prepare-error-mitmdump')).textContent).toContain('installer offline')
    fireEvent.click(screen.getByTestId('capture-prepare-skip'))
    fireEvent.click(screen.getByTestId('first-run-later'))
    expect(skip).toHaveBeenCalledOnce()
    expect(leave).toHaveBeenCalledOnce()
  })
  it('does not call an unknown or failed preflight prepared', () => {
    const { recheck } = draw(null, true)
    expect(screen.getByTestId('first-run-preflight-failed')).toBeTruthy()
    expect(screen.queryByTestId('prepare-install-mitmdump')).toBeNull()
    fireEvent.click(screen.getByTestId('capture-prepare-retry'))
    expect(recheck).toHaveBeenCalledOnce()
  })
  it('points at the missing installer and preserves the exact manual remediation', async () => {
    vi.mocked(window.redlog.runtime.install).mockResolvedValue({ success: false, message: 'uv is required', needsPrereq: { command: 'uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' } })
    draw()
    fireEvent.click(screen.getByTestId('prepare-install-mitmdump'))
    expect((await screen.findByTestId('prepare-error-mitmdump')).textContent).toContain('uv tool install mitmproxy')
    fireEvent.click(screen.getByTestId('prepare-prereq-mitmdump'))
    expect(window.redlog.app.openExternal).toHaveBeenCalledWith('https://docs.astral.sh/uv/getting-started/installation/')
  })
})
