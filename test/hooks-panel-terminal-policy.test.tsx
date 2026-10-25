// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react'
import HooksPanel from '../src/renderer/src/components/settings/HooksPanel'

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
      'settings.terminalClassNative': 'left alone: {{commands}}',
      'settings.terminalClassPty': 'given a PTY: {{commands}}',
      'settings.terminalClassEditedFromShell': 'Change it from the terminal.'
    } as Record<string, string>)[key] ?? key
  )

const draw = (terminalPolicy?: () => Promise<{ mode: 'auto' | 'manual'; native: string[]; pty: string[] }>): void => {
  ;(window as unknown as { redlog: unknown }).redlog = {
    hooks: {
      detect: async () => [],
      install: async () => ({ success: true, message: '' }),
      uninstall: async () => ({ success: true, message: '' }),
      ...(terminalPolicy ? { terminalPolicy } : {})
    }
  }
  render(
    <HooksPanel hooks={[]} setHooks={() => {}} t={t} />
  )
}

describe('the hooks panel says what the shell will do', () => {
  afterEach(() => cleanup())

  it('names the mode and both class lists', async () => {
    draw(async () => ({ mode: 'manual', native: ['nc', 'vim'], pty: ['ssh'] }))
    await waitFor(() => expect(screen.getByText(/not recording until redlog start/)).toBeTruthy())
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/left alone: nc vim/)
    expect(text).toMatch(/given a PTY: ssh/)
    // The third class is not a list, and saying so beats printing one.
    expect(text).toMatch(/Change it from the terminal/)
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

  it('keeps the current mode visible while tool classifications are expandable', async () => {
    draw(async () => ({ mode: 'manual', native: ['nc', 'vim'], pty: ['ssh'] }))
    const mode = await screen.findByText(/not recording until redlog start/)
    const summary = mode.closest('summary')
    expect(summary).not.toBeNull()
    const details = summary!.closest('details')!
    expect(details.open).toBe(false)
    fireEvent.click(summary!)
    expect(details.open).toBe(true)
    expect(details.textContent).toContain('left alone: nc vim')
    expect(details.textContent).toContain('given a PTY: ssh')
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
