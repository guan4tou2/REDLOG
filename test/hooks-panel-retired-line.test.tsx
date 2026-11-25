// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, within, fireEvent, waitFor } from '@testing-library/react'
import HooksPanel from '../src/renderer/src/components/settings/HooksPanel'
import { isForeignShellHook } from '../src/renderer/src/lib/hookPlatform'
import type { HookInfo } from '../src/renderer/src/components/settings/SettingsShared'

// #879: the shell's row says which line of which file loads the retired hook,
// and removes it. Found on Windows, where bash is a foreign shell and its row
// is otherwise folded away while it is neither installed nor usable.

const RC = 'C:\\Users\\op\\.bashrc'
const bashRow = (over: Partial<HookInfo> = {}): HookInfo => ({
  id: 'shell-bash', name: 'Bash Shell', description: '', agentType: 'shell', installed: false, available: false,
  installMethod: 'shell-source', hookFile: '', builtin: true, retiredLines: [{ file: RC, line: 3 }], ...over
}) as HookInfo

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars ? `${key} ${JSON.stringify(vars)}` : key

afterEach(() => cleanup())

describe('a shell whose rc loads the retired hook', () => {
  it('is not folded into "other platforms" on Windows', () => {
    expect(isForeignShellHook(bashRow(), 'win32')).toBe(false)
    expect(isForeignShellHook(bashRow({ retiredLines: undefined }), 'win32')).toBe(true)
    expect(isForeignShellHook(bashRow({ retiredLines: [] }), 'win32')).toBe(true)
  })

  it('names the file and line on its row, and the button removes the line and reads the state again', async () => {
    const removeRetiredLines = vi.fn(async () => ({ success: true, message: 'removed' }))
    const detect = vi.fn(async () => [bashRow()])
    ;(window as unknown as { redlog: unknown }).redlog = {
      platform: 'win32',
      hooks: { detect, terminalPolicy: async () => null, removeRetiredLines }
    }
    render(<HooksPanel hooks={[bashRow()]} setHooks={() => {}} t={t} />)

    const notice = screen.getByTestId('hook-retired-shell-bash')
    expect(notice.closest('[data-testid="hooks-other-platforms"]')).toBeNull()
    expect(within(notice).getByRole('status').textContent)
      .toBe(`settings.hookRetiredLine ${JSON.stringify({ file: RC, line: 3 })}`)

    await waitFor(() => expect(detect).toHaveBeenCalledTimes(1))
    fireEvent.click(within(notice).getByRole('button', { name: 'settings.hookRetiredRemove' }))
    await waitFor(() => expect(removeRetiredLines).toHaveBeenCalledWith('shell-bash'))
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(2))
  })

  it('shows nothing of the kind on a row without one', () => {
    ;(window as unknown as { redlog: unknown }).redlog = {
      platform: 'linux',
      hooks: { detect: async () => [], terminalPolicy: async () => null }
    }
    render(<HooksPanel hooks={[bashRow({ available: true, retiredLines: undefined })]} setHooks={() => {}} t={t} />)
    expect(screen.queryByTestId('hook-retired-shell-bash')).toBeNull()
  })
})
