// @vitest-environment jsdom
//
// Spec 069 T019, folded into two layers: each pane's state is said once. A
// pane that records with its hook connected is a dot on its tab and nothing
// else; anything else is a word on the tab and one line in the pane. Each
// pane's state is its own, an ended pane keeps saying what its recording went
// through, and a restarted pane starts with none of the old session's history.

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
  await screen.findByTestId('terminal-tab')
  await waitFor(() => expect(spawn).toHaveBeenCalled())
}
const tabState = (): HTMLElement => screen.getByTestId('terminal-tab-state')
const line = (): string | null => screen.queryByTestId('terminal-recording-gap')?.textContent ?? null
const hooked = (): void => {
  spawn.mockImplementation(async () => ({ pid: 4242, recording: true, castTruncated: false, paused: false, hookSourced: true, shell: '/bin/zsh' }))
}

it('a recording pane with its hook connected is a dot on its tab, with no word and no line', async () => {
  hooked()
  await mount()
  await waitFor(() => expect(tabState().dataset.state).toBe('recording'))
  expect(tabState().textContent).toBe('')
  expect(tabState().getAttribute('title')).toBe('Terminal session is being recorded (.cast)')
  expect(line()).toBeNull()
  expect(screen.queryByTestId('terminal-no-hook')).toBeNull()
  expect(screen.queryByTestId('terminal-tab-hook')).toBeNull()
  expect(screen.queryByTestId('terminal-session-meta')).toBeNull()
})

it('says a missing hook once on the tab and once in the pane', async () => {
  await mount()
  const word = await screen.findByTestId('terminal-tab-hook')
  expect(word.textContent).toBe('command events not connected')
  expect(word.getAttribute('title')).toContain('fish')
  expect(screen.getByTestId('terminal-no-hook').textContent).toContain('NOT being recorded')
  expect(screen.getAllByText(/not connected/)).toHaveLength(1)
})

it('keeps the full directory and the PID on the tab, and a failed exit code on it once', async () => {
  await mount()
  await waitFor(() => expect(screen.getByTestId('terminal-tab').getAttribute('title')).toContain('PID 4242'))
  act(() => batch([{ agentType: 'shell', data: { source: 'builtin-terminal', subtype: 'command_end', terminalId: tid(), cwd: '/home/op/acme', exit_code: 2 } }]))
  const tab = screen.getByTestId('terminal-tab')
  // The full path the shell reported — not its last segment dressed up as ~/.
  expect(tab.getAttribute('title')).toContain('/home/op/acme')
  expect(document.body.textContent).not.toContain('acme')
  expect(screen.getAllByText('✕2')).toHaveLength(1)
})

it('says "not recording" as a word on the tab, no fainter than "recording" was, and one line in the pane', async () => {
  await mount()
  cast('t1', { recording: false })
  expect(tabState().textContent).toBe('no rec')
  expect(tabState().className).toContain('text-amber-300')
  expect(tabState().className).not.toContain('text-redlog-text-faint')
  expect(line()).toBe('No cast recording for this session')
})

it('says a pause and a truncation where they apply, with what they leave out', async () => {
  await mount()
  cast('t1', { recording: false, paused: true })
  expect(tabState().textContent).toBe('paused')
  expect(tabState().getAttribute('title')).toContain('not written while paused')
  expect(line()).toContain('not written while paused')
  expect(screen.getAllByText('paused')).toHaveLength(1)
  cast('t1', { castTruncated: true })
  expect(tabState().textContent).toBe('trunc')
  expect(tabState().getAttribute('title')).toContain('not captured')
  expect(line()).toContain('not captured')
})

it('says a failed recording as failed, not as not recording', async () => {
  await mount()
  cast('t1', { recording: false, recordingReason: 'recording-failed', recordingError: 'disk full' })
  expect(tabState().textContent).toBe('rec failed')
  expect(tabState().getAttribute('title')).toContain('disk full')
})

it('says a pane with no project open is not recorded, and why', async () => {
  await mount()
  cast('t1', { recording: false, recordingReason: 'no-project' })
  expect(tabState().textContent).toBe('no rec')
  expect(line()).toContain('No project is open')
})

// A failed spawn is not a recording failure of a running shell: there is no
// shell. The banner used to say this pane "is usable" anyway.
it('says a shell that did not start did not start, and not that it can be used', async () => {
  spawn.mockReset()
  spawn.mockRejectedValue(new Error('posix_spawnp failed'))
  await mount()
  const banner = await screen.findByTestId('terminal-recording-gap')
  expect(banner.textContent).not.toMatch(/usable/i)
  expect(banner.textContent).toMatch(/did not start/i)
  expect(banner.textContent).toContain('posix_spawnp failed')
})

it('keeps saying a running shell that cannot record is usable', async () => {
  await mount()
  cast('t1', { recording: false, recordingReason: 'recording-failed', recordingError: 'disk full' })
  const banner = screen.getByTestId('terminal-recording-gap')
  expect(banner.textContent).toBe('This pane is usable but is not being recorded: disk full')
})

it('keeps what an ended pane\'s recording went through, instead of only "ended"', async () => {
  await mount()
  cast('t1', { paused: true, recording: false })
  cast('t1', {})
  act(() => exitHandlers.get(tid())!())
  const badge = screen.getByTestId('terminal-ended-recording')
  expect(badge.textContent).toBe('part paused')
  expect(badge.dataset.state).toBe('partly-paused')
  expect(line()).toContain('Session ended')
  expect(line()).toContain('paused for part of this session')
  expect(screen.queryByTestId('terminal-tab-hook')).toBeNull()
  expect(screen.queryByTestId('terminal-no-hook')).toBeNull()
})

it('says a cleanly ended pane ended, on its tab only', async () => {
  await mount()
  cast('t1', {})
  act(() => exitHandlers.get(tid())!())
  expect(screen.getByTestId('terminal-ended').textContent).toBe('Session ended')
  expect(screen.queryByTestId('terminal-ended-recording')).toBeNull()
  expect(line()).toBeNull()
})

it('starts a restarted pane with none of the old session\'s history', async () => {
  await mount()
  cast('t1', { recording: false, recordingReason: 'recording-failed', recordingError: 'x' })
  act(() => exitHandlers.get(tid())!())
  expect(screen.getByTestId('terminal-ended-recording').textContent).toBe('rec failed')
  fireEvent.click(screen.getByRole('button', { name: /Restart/i }))
  await waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(tabState().dataset.state).toBe('recording'))
  expect(screen.queryByTestId('terminal-ended-recording')).toBeNull()
  expect(line()).toBeNull()
})
