// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { useState } from 'react'
import { I18nProvider } from '../src/renderer/src/i18n'
import WslPanel from '../src/renderer/src/components/WslPanel'
import HooksPanel from '../src/renderer/src/components/settings/HooksPanel'
import type { HookInfo } from '../src/renderer/src/components/settings/SettingsShared'

const hook = { id: 'shell-zsh', name: 'Zsh', available: true, installed: false, builtin: true, installMethod: 'shell-source', description: '', hookFile: '' } as HookInfo
function Panel(): JSX.Element {
  const [hooks, setHooks] = useState<HookInfo[]>([])
  return <I18nProvider><HooksPanel hooks={hooks} setHooks={setHooks} t={k => k} /></I18nProvider>
}
afterEach(cleanup)
describe('settings source connection', () => {
  it('reads on entry and starts the shared terminal verification only after connect', async () => {
    const install = vi.fn(async () => ({ success: true }))
    Object.assign(window, { redlog: {
      platform: 'darwin', hooks: { detect: vi.fn(async () => [hook]), install, terminalPolicy: async () => null },
      runtime: { preflight: async () => ({ checks: [], shell: { hookId: 'shell-zsh', name: 'zsh' } }) },
      events: { onNewBatch: () => () => {} }
    } })
    render(<Panel />)
    await screen.findByText('Zsh')
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('hook-connect-shell-zsh'))
    await waitFor(() => expect(install).toHaveBeenCalledWith('shell-zsh'))
    await screen.findByTestId('record-terminal-command')
    expect(screen.queryByTestId('record-terminal-verified')).toBeNull()
    expect(screen.getByTestId('record-terminal-flow').getAttribute('data-phase')).toBe('waiting-for-activation')
  })
  it('shows a failed detection with retry instead of an endless loading state', async () => {
    const detect = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([hook])
    Object.assign(window, { redlog: { platform: 'darwin', hooks: { detect, terminalPolicy: async () => null } } })
    render(<Panel />)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByTestId('hooks-read-retry'))
    await screen.findByText('Zsh')
    expect(detect).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

it('keeps the WSL activation attempt mounted while its installed state refreshes', async () => {
  let finishRefresh!: (value: unknown) => void
  const distro = { name: 'Kali', state: 'Running', version: 2, isDefault: true, shells: ['zsh'], hookStatus: { zsh: 'not-installed', bash: 'no-shell' } }
  const listDistros = vi.fn().mockResolvedValueOnce([distro]).mockImplementationOnce(() => new Promise(r => { finishRefresh = r }))
  const installHook = vi.fn(async () => ({ success: true }))
  Object.assign(window, { redlog: { platform: 'win32', wsl: { listDistros, getNetworkMode: async () => 'mirrored', installHook }, events: { onNewBatch: () => () => {} } } })
  render(<I18nProvider><WslPanel t={k => k} /></I18nProvider>)
  fireEvent.click(await screen.findByText('settings.shellConnect'))
  await screen.findByTestId('record-terminal-command')
  await waitFor(() => expect(listDistros).toHaveBeenCalledTimes(2))
  await act(async () => finishRefresh([{ ...distro, hookStatus: { zsh: 'installed', bash: 'no-shell' } }]))
  await screen.findByText('settings.shellVerify')
  expect(screen.getByTestId('record-terminal-command')).toBeTruthy()
  expect(installHook).toHaveBeenCalledTimes(1)
})
