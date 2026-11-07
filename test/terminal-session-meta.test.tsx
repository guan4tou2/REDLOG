// @vitest-environment jsdom
//
// Spec 069 T019: the terminal page's heading, its capture explanation and the
// state line of the active pane. Each pane's recording and hook state is its
// own, an ended pane keeps saying what its recording went through, and a
// restarted pane starts with none of the old session's history.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    element = document.createElement('div'); cols = 80; rows = 24; options: Record<string, unknown> = {}
    loadAddon(): void {} attachCustomKeyEventHandler(): void {} open(parent: HTMLElement): void { parent.appendChild(this.element) }
    write(): void {} onData(): { dispose(): void } { return { dispose() {} } } onResize(): { dispose(): void } { return { dispose() {} } }
    focus(): void {} dispose(): void {} hasSelection(): boolean { return false }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext(): void {} findPrevious(): void {} } }))

type Cast = { recording: boolean; castTruncated: boolean; paused: boolean; recordingReason?: string; recordingError?: string }
const castHandlers = new Map<string, (s: Cast) => void>()
const exitHandlers = new Map<string, () => void>()
let batch: (events: unknown[]) => void = () => {}
const spawn = vi.fn()

function install(): void {
  castHandlers.clear(); exitHandlers.clear()
  spawn.mockReset()
  spawn.mockImplementation(async () => ({ pid: 4242, recording: true, castTruncated: false, paused: false, hookSourced: false, shell: '/usr/bin/fish' }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    terminal: {
      list: vi.fn(async () => []),
      shells: vi.fn(async () => []), spawn, write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: () => () => {},
      onExit: (id: string, cb: () => void) => { exitHandlers.set(id, cb); return () => {} },
      onCastState: (id: string, cb: (s: Cast) => void) => { castHandlers.set(id, cb); return () => {} }
    },
    events: { onNewBatch: (cb: (e: unknown[]) => void) => { batch = cb; return () => {} } },
    ui: { contextMenu: vi.fn() }
  }
}
const tid = (): string => spawn.mock.calls[spawn.mock.calls.length - 1][0] as string
const cast = (_id: string, s: Partial<Cast>): void => { act(() => castHandlers.get(tid())!({ recording: true, castTruncated: false, paused: false, ...s })) }

beforeEach(() => {
  window.localStorage.setItem('redlog-locale', 'en')
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  install()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

async function mount(): Promise<void> {
  const { default: TerminalView } = await import('../src/renderer/src/components/TerminalView')
  render(<I18nProvider><TerminalView /></I18nProvider>)
  await screen.findByTestId('terminal-session-meta')
  await waitFor(() => expect(spawn).toHaveBeenCalled())
}

it('shows the heading, and the pane\'s recording, hook, directory and exit', async () => {
  await mount()
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Terminal')
  await waitFor(() => expect(screen.getByTestId('terminal-meta-hook').textContent).toContain('not connected'))
  expect(screen.getByTestId('terminal-meta-screen').textContent).toContain('Screen')
  act(() => batch([{ agentType: 'shell', data: { source: 'builtin-terminal', subtype: 'command_end', terminalId: tid(), cwd: '/home/op/acme', exit_code: 2 } }]))
  const meta = screen.getByTestId('terminal-session-meta')
  // The full path the shell reported — not its last segment dressed up as ~/.
  expect(meta.textContent).toContain('/home/op/acme')
  expect(meta.textContent).not.toContain('~/acme')
  expect(meta.textContent).toMatch(/Exit\s*2/)
})

it('says a failed recording as failed, not as not recording', async () => {
  await mount()
  cast('t1', { recording: false, recordingReason: 'recording-failed', recordingError: 'disk full' })
  expect(screen.getByTestId('terminal-meta-screen').textContent).toContain('rec failed')
  expect(screen.getByTestId('terminal-meta-screen').getAttribute('title')).toContain('disk full')
})

it('keeps what an ended pane\'s recording went through, instead of only "ended"', async () => {
  await mount()
  cast('t1', { paused: true, recording: false })
  cast('t1', {})
  act(() => exitHandlers.get(tid())!())
  const screenBadge = screen.getByTestId('terminal-meta-screen').textContent ?? ''
  expect(screenBadge).toContain('Session ended')
  expect(screenBadge).toContain('part paused')
  expect(screen.queryByTestId('terminal-meta-hook')).toBeNull()
})

it('starts a restarted pane with none of the old session\'s history', async () => {
  await mount()
  cast('t1', { recording: false, recordingReason: 'recording-failed', recordingError: 'x' })
  act(() => exitHandlers.get(tid())!())
  expect(screen.getByTestId('terminal-meta-screen').textContent).toContain('rec failed')
  fireEvent.click(screen.getByRole('button', { name: /Restart/i }))
  await waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
  const text = (): string => screen.getByTestId('terminal-meta-screen').textContent ?? ''
  await waitFor(() => expect(text()).not.toContain('Session ended'))
  expect(text()).not.toContain('rec failed')
  expect(screen.getByTestId('terminal-meta-screen').textContent).toContain('rec')
})

it('explains the two capture tracks, and closes with Escape', async () => {
  await mount()
  fireEvent.click(screen.getByTestId('terminal-about-open'))
  const dialog = await screen.findByTestId('terminal-about')
  expect(dialog.textContent).toContain('Screen recording (.cast)')
  expect(dialog.textContent).toContain('Command events (shell hook)')
  expect(dialog.textContent).toContain('independent')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByTestId('terminal-about')).toBeNull()
})
