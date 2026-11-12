// @vitest-environment jsdom
//
// The capture card's "Install the shell hook" used to call hooks.install and
// stop there: the file was copied and the card moved on. First run and
// Settings prove the same install with a nonce command typed in a new
// terminal (FR-015). The card now runs that same flow, so the source is not
// reported as connected until a command carrying the nonce arrives.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'

vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))
import { toast } from '../src/renderer/src/components/Toast'

type Ev = { id: string; timestamp: number; agentType: string; data: Record<string, unknown> }
let listeners: Array<(evs: Ev[]) => void>
let install: ReturnType<typeof vi.fn>

function bridge(result: { success: boolean; message: string } = { success: true, message: 'ok' }): void {
  listeners = []
  install = vi.fn(async () => result)
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    config: { get: async () => ({}), save: async () => true },
    runtime: { preflight: async () => ({
      platform: 'darwin', shell: { name: 'zsh', hookId: 'shell-zsh' },
      checks: [
        { id: 'python3', found: true, neededFor: ['shell-zsh'] },
        { id: 'curl', found: true, neededFor: ['shell-zsh'] },
        { id: 'zsh', found: true, neededFor: ['shell-zsh'] }
      ]
    }) },
    hooks: {
      detect: async () => [{ id: 'shell-zsh', name: 'Zsh Shell', available: true, installed: false }],
      install,
      uninstall: async () => ({ success: true, message: '' })
    },
    events: {
      onNewBatch: (cb: (evs: Ev[]) => void) => { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb) } }
    }
  }
}

const emit = (evs: Ev[]): void => { act(() => { for (const l of listeners) l(evs) }) }

function draw(onRefresh = vi.fn()): void {
  const capture = {
    verdict: 'healthy', sources: [{ id: 'terminal', hookId: 'shell-zsh', installed: false, state: 'ready', lastEventAt: Date.now() }],
    lastEventAt: Date.now(), checkedAt: Date.now(), dbErrorTotal: 0, dbErrorFirstAt: null
  }
  render(
    <I18nProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CaptureHealthCard capture={capture as any} onNavigate={() => {}} onRefresh={onRefresh} />
    </I18nProvider>
  )
}

beforeEach(() => { localStorage.setItem('redlog-locale', 'en'); vi.mocked(toast).mockClear() })
afterEach(() => { cleanup(); localStorage.clear() })

describe('the capture card\'s shell hook install', () => {
  it('is not reported connected until the nonce command comes back', async () => {
    bridge()
    const onRefresh = vi.fn()
    draw(onRefresh)
    fireEvent.click(screen.getByText('Install the shell hook'))

    const flow = await screen.findByTestId('record-terminal-flow')
    await waitFor(() => expect(install).toHaveBeenCalledWith('shell-zsh'))
    await waitFor(() => expect(flow.getAttribute('data-phase')).toBe('waiting-for-activation'))
    // Installed, and the card re-reads health — but that is not the end state.
    expect(onRefresh).toHaveBeenCalled()
    expect(screen.queryByTestId('record-terminal-verified')).toBeNull()
    // The install is offered once; the flow is now where it runs.
    expect(screen.queryByText('Install the shell hook')).toBeNull()

    const command = (await screen.findByTestId('record-terminal-command')).textContent ?? ''
    // A command from RedLog's own pane, or one without the nonce, proves nothing.
    emit([{ id: 'b', timestamp: 2, agentType: 'shell', data: { subtype: 'command_end', source: 'builtin-terminal', shell: 'zsh', command } }])
    emit([{ id: 'o', timestamp: 3, agentType: 'shell', data: { subtype: 'command_end', shell: 'zsh', command: 'echo other' } }])
    expect(screen.queryByTestId('record-terminal-verified')).toBeNull()

    emit([{ id: 'e', timestamp: 4, agentType: 'shell', data: { subtype: 'command_end', shell: 'zsh', command } }])
    expect(await screen.findByTestId('record-terminal-verified')).toBeTruthy()
  })

  it('keeps the failure toast when the install fails', async () => {
    bridge({ success: false, message: 'rc file is read-only' })
    draw()
    fireEvent.click(screen.getByText('Install the shell hook'))
    expect(await screen.findByTestId('record-terminal-install-failed')).toBeTruthy()
    expect(toast).toHaveBeenCalledWith('Action failed', expect.objectContaining({ type: 'error', detail: 'rc file is read-only' }))
  })
})
