// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import HooksPanel from '../src/renderer/src/components/settings/HooksPanel'
import type { HookInfo } from '../src/renderer/src/components/settings/SettingsShared'

// Spec 052 T034. Settings has to be able to answer "what will my shell do",
// and answer it from the same place the shell reads — the mode `redlog mode`
// last wrote and the class lists `redlog class` last edited (research.md D7).
//
// A panel that disagrees with the terminal is worse than one that says
// nothing: it tells the operator their `nc` is safe when the shell is about
// to relay it. So the panel reads, and the terminal writes; there is no
// second editor here, because the operator is in the terminal when they find
// out that something went through a relay.

const t = (key: string, vars?: Record<string, string | number>): string =>
  Object.entries(vars ?? {}).reduce(
    (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
    ({
      'settings.hooksBuiltin': 'Built-in',
      'settings.terminalMode': 'New terminals: {{mode}}',
      'settings.terminalMode.auto': 'recording from the first prompt',
      'settings.terminalMode.manual': 'not recording until redlog start',
      'settings.terminalClassEditedFromShell': 'Change it from the terminal.'
    } as Record<string, string>)[key] ?? key
  )

const draw = (terminalPolicy?: () => Promise<object>, hooks: HookInfo[] = []): void => {
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    hooks: {
      detect: async () => hooks,
      setTerminalApp: vi.fn(async (value: string) => value),
      install: vi.fn(async () => ({ success: true, message: '' })),
      uninstall: async () => ({ success: true, message: '' }),
      ...(terminalPolicy ? { terminalPolicy } : {})
    }
  }
  render(
    <HooksPanel hooks={hooks} setHooks={() => {}} t={t} />
  )
}

describe('the hooks panel says what the shell will do', () => {
  afterEach(() => cleanup())

  it('names the mode, and says where the per-tool policy is changed once there are tool cards', async () => {
    draw(async () => ({
      mode: 'manual', native: ['nc', 'vim'], pty: ['ssh'],
      entries: [{ command: 'ssh', mode: 'pty', source: 'profile', profile: 'ssh' }], problems: [],
      profiles: [{ id: 'ssh', name: 'SSH', mode: 'pty', executables: ['ssh'], reason: 'Brings its own TTY.' }]
    }))
    await waitFor(() => expect(screen.getByText(/not recording until redlog start/)).toBeTruthy())
    await screen.findByRole('group', { name: 'SSH' })
    // The note is a statement about the shell, not a list the page edits.
    expect(document.body.textContent ?? '').toMatch(/Change it from the terminal/)
  })

  it('refreshes the actual mode on return without reinstalling a hook', async () => {
    const policy = vi.fn().mockResolvedValueOnce({ mode: 'auto', native: [], pty: [] })
      .mockResolvedValue({ mode: 'manual', native: ['nc'], pty: ['ssh'] })
    draw(policy)
    await screen.findByText(/recording from the first prompt/)
    const install = vi.spyOn(window.redlog.hooks, 'install')
    const detect = vi.spyOn(window.redlog.hooks, 'detect')
    fireEvent(window, new Event('focus'))
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByText(/not recording until redlog start/)
    expect(policy).toHaveBeenCalledTimes(2)
    expect(detect).toHaveBeenCalledTimes(1)
    expect(install).not.toHaveBeenCalled()
  })

  it('saves the terminal app independently of the shell and keeps a failed choice visible', async () => {
    let app = 'all'
    const policy = vi.fn(async () => ({ mode: 'auto' as const, native: [], pty: [], app }))
    draw(policy)
    const select = await screen.findByRole('combobox', { name: 'settings.terminalApp' })
    const save = vi.spyOn(window.redlog.hooks, 'setTerminalApp').mockImplementation(async value => { app = value; return value })
    fireEvent.change(select, { target: { value: 'WarpTerminal' } })
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('WarpTerminal'))
    expect(save).toHaveBeenCalledWith('WarpTerminal')
    save.mockRejectedValueOnce(new Error('disk is read-only'))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } })
    await screen.findByText('disk is read-only')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('WarpTerminal')
    expect(window.redlog.hooks.install).not.toHaveBeenCalled()
  })

  it('keeps the selected control mounted while revalidating on return', async () => {
    let finish!: (value: { mode: 'auto'; native: string[]; pty: string[]; app: string }) => void
    const policy = vi.fn().mockResolvedValueOnce({ mode: 'auto', native: [], pty: [], app: 'WarpTerminal' })
      .mockImplementation(() => new Promise(resolve => { finish = resolve }))
    draw(policy, [{ id: 'shell-zsh', name: 'Zsh', description: '', agentType: 'shell', installed: false, available: true, builtin: true, installMethod: 'shell-source', hookFile: '' }])
    const select = await screen.findByRole('combobox')
    const connect = await screen.findByTestId('hook-connect-shell-zsh')
    let finishHooks!: (value: HookInfo[]) => void
    vi.spyOn(window.redlog.hooks, 'detect').mockImplementationOnce(() => new Promise(resolve => { finishHooks = resolve }))
    select.focus()
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(policy).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('combobox')).toBe(select)
    expect(screen.getByTestId('hook-connect-shell-zsh')).toBe(connect)
    expect((select as HTMLSelectElement).value).toBe('WarpTerminal')
    finish({ mode: 'auto', native: [], pty: [], app: 'WarpTerminal' })
    finishHooks([])
    await waitFor(() => expect(screen.getByRole('combobox')).toBe(select))
  })

  it('omits a one-option App selector when the platform only supports all terminals', async () => {
    draw(async () => ({ mode: 'auto', native: [], pty: [], app: 'all' }))
    ;(window.redlog as unknown as { platform: string }).platform = 'linux'
    await screen.findByText(/recording from the first prompt/)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('does not offer unverified App isolation on Linux and keeps recovery to all available', async () => {
    draw(async () => ({ mode: 'auto', native: [], pty: [], app: 'WarpTerminal' }))
    ;(window.redlog as unknown as { platform: string }).platform = 'linux'
    const select = await screen.findByRole('combobox')
    expect(screen.queryByRole('option', { name: 'VS Code' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Warp' }).hasAttribute('disabled')).toBe(true)
    await screen.findByRole('alert')
    fireEvent.change(select, { target: { value: 'all' } })
    await waitFor(() => expect(window.redlog.hooks.setTerminalApp).toHaveBeenCalledWith('all'))
  })

  it('leaves the note out rather than throwing when the bridge is older', async () => {
    // A renderer can outlive its preload — the running window's bridge may
    // predate this method, and it needs a full reload rather than HMR. The
    // panel is still useful without the note.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    draw(undefined)
    await waitFor(() => expect(screen.getByText('Built-in')).toBeTruthy())
    expect(document.body.textContent).not.toMatch(/New terminals/)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
