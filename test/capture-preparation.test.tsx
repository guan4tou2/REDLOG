// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CapturePreparation, RuntimePreparation, preparationChecks } from '../src/renderer/src/components/CapturePreparation'

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
    const missingBoth = preflight()
    missingBoth.checks = missingBoth.checks.map(c => c.id === 'python3' ? { ...c, found: false } : c)
    expect(preparationChecks(missingBoth, 'commands').map(c => c.id)).toEqual(['python3'])
    expect(preparationChecks(missingBoth, 'web').map(c => c.id)).toEqual(['mitmdump'])
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
  it('says commands can be recorded when only the web tool is missing', () => {
    draw()
    expect(screen.getByTestId('capture-prepare-web-only').textContent).toContain('record commands without it')
  })
  it('does not claim commands are unaffected when a shell dependency is missing too', () => {
    const pf = preflight()
    pf.checks = pf.checks.map(c => c.id === 'python3' ? { ...c, found: false } : c)
    draw(pf)
    expect(screen.queryByTestId('capture-prepare-web-only')).toBeNull()
  })
  it('explains what each way out does, so the two are not guessed apart', () => {
    draw()
    const text = screen.getByTestId('capture-prepare-exits').textContent ?? ''
    expect(text).toContain('Continue without installing')
    expect(text).toContain('web traffic stays off')
    expect(text).toContain('Finish later')
    expect(text).toContain('nothing is lost')
  })
  it('offers the prerequisite on the first screen when preflight already says it is needed', () => {
    const pf = preflight()
    pf.checks = pf.checks.map(c => c.id === 'mitmdump' ? { ...c, remediationRequires: { command: 'uv', url: 'https://docs.astral.sh/uv/' } } as typeof c : c)
    draw(pf)
    expect(screen.getByTestId('prepare-prereq-mitmdump')).toBeTruthy()
    expect(screen.queryByTestId('prepare-install-mitmdump')).toBeNull()
    expect(window.redlog.runtime.install).not.toHaveBeenCalled()
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

it('offers a known missing installer before attempting a dependency install', () => {
  const pf = preflight()
  pf.checks.find(c => c.id === 'mitmdump')!.remediationRequires = { command: 'uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' }
  draw(pf)
  const action = screen.getByTestId('prepare-prereq-mitmdump')
  expect(action.textContent).toContain('uv')
  expect(screen.queryByTestId('prepare-install-mitmdump')).toBeNull()
  fireEvent.click(action)
  expect(window.redlog.runtime.install).not.toHaveBeenCalled()
})


it('rechecks on return without unmounting or cancelling an active source installer', async () => {
  const probe = vi.fn(async () => preflight())
  window.redlog.runtime.preflight = probe
  let finish!: (value: { success: boolean; message: string }) => void
  vi.mocked(window.redlog.runtime.install).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  render(<I18nProvider><RuntimePreparation source="web" onClose={() => {}} /></I18nProvider>)
  fireEvent.click(await screen.findByTestId('prepare-install-mitmdump'))
  try {
    await act(async () => { fireEvent(window, new Event('focus')) })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(window.redlog.runtime.cancelInstall).not.toHaveBeenCalled()
  } finally {
    await act(async () => { finish({ success: false, message: 'test download failed' }) })
  }
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000)
  try {
    await act(async () => { fireEvent(window, new Event('focus')) })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(window.redlog.runtime.install).toHaveBeenCalledTimes(1)
    expect(window.redlog.runtime.cancelInstall).not.toHaveBeenCalled()
    expect(screen.getByTestId('prepare-error-mitmdump').textContent).toContain('test download failed')
  } finally { clock.mockRestore() }
})
