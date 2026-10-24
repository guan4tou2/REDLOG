// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'
import HooksPanel from '../src/renderer/src/components/settings/HooksPanel'
import { isForeignShellHook } from '../src/renderer/src/lib/hookPlatform'
import type { HookInfo } from '../src/renderer/src/components/settings/SettingsShared'

// Spec 060 FR-010 / US4.1: a Mac does not list PowerShell and the WSL bridge
// beside zsh as if setup were missing, and a Windows host does the same for
// the POSIX shells. Anything installed or usable stays where it was.

const hook = (id: string, over: Partial<HookInfo> = {}): HookInfo => ({
  id, name: id, description: '', agentType: 'shell', installed: false, available: true,
  installMethod: 'shell-source', hookFile: '', builtin: true, ...over
}) as HookInfo

describe('isForeignShellHook', () => {
  it('moves Windows-only shells aside on macOS and Linux, only while unusable', () => {
    for (const platform of ['darwin', 'linux']) {
      expect(isForeignShellHook(hook('shell-powershell', { available: false }), platform)).toBe(true)
      expect(isForeignShellHook(hook('shell-wsl', { available: false }), platform)).toBe(true)
      expect(isForeignShellHook(hook('shell-zsh', { available: false }), platform)).toBe(false)
    }
  })

  it('keeps a foreign shell that works or is already installed', () => {
    expect(isForeignShellHook(hook('shell-powershell', { available: true }), 'darwin')).toBe(false)
    expect(isForeignShellHook(hook('shell-powershell', { available: false, installed: true }), 'darwin')).toBe(false)
  })

  it('moves the POSIX shells aside on Windows, and never touches non-shell hooks', () => {
    expect(isForeignShellHook(hook('shell-bash', { available: false }), 'win32')).toBe(true)
    expect(isForeignShellHook(hook('shell-powershell', { available: false }), 'win32')).toBe(false)
    expect(isForeignShellHook(hook('mitmproxy', { available: false }), 'darwin')).toBe(false)
    expect(isForeignShellHook(hook('claude-code', { available: false }), 'win32')).toBe(false)
  })
})

describe('the hooks panel on macOS', () => {
  afterEach(() => cleanup())

  it('lists the native shell first and folds the Windows ones into "other platforms"', () => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      platform: 'darwin',
      hooks: { detect: async () => [], terminalPolicy: async () => null }
    }
    const hooks = [
      hook('shell-zsh', { name: 'Zsh adapter' }),
      hook('shell-powershell', { name: 'PowerShell adapter', available: false }),
      hook('shell-wsl', { name: 'WSL adapter', available: false })
    ]
    render(<HooksPanel hooks={hooks} setHooks={() => {}} t={(k) => k} />)
    const other = screen.getByTestId('hooks-other-platforms')
    expect(within(other).getByText('PowerShell adapter')).toBeTruthy()
    expect(within(other).getByText('WSL adapter')).toBeTruthy()
    expect(within(other).queryByText('Zsh adapter')).toBeNull()
    expect(screen.getByText('Zsh adapter').closest('[data-testid="hooks-other-platforms"]')).toBeNull()
  })

  it('shows no group when nothing is foreign', () => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      platform: 'darwin',
      hooks: { detect: async () => [], terminalPolicy: async () => null }
    }
    render(<HooksPanel hooks={[hook('shell-zsh')]} setHooks={() => {}} t={(k) => k} />)
    expect(screen.queryByTestId('hooks-other-platforms')).toBeNull()
  })
})
