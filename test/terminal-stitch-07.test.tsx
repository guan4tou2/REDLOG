// @vitest-environment jsdom
//
// Stitch 07: the close control is always visible, find opens from anywhere on
// the page, and the capture explanation says what a recording state does not
// mean.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext(): boolean { return false } findPrevious(): boolean { return false } clearDecorations(): void {} onDidChangeResults(): { dispose(): void } { return { dispose() {} } } } }))


const spawn = vi.fn()
function install(): void {
  spawn.mockReset()
  spawn.mockImplementation(async () => ({ pid: 4242, recording: true, castTruncated: false, paused: false, hookSourced: false, shell: '/bin/zsh' }))
  ;(window as unknown as { redlog: unknown }).redlog = {
    terminal: {
      list: vi.fn(async () => []), shells: vi.fn(async () => []), spawn, write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: () => () => {}, onExit: () => () => {}, onCastState: () => () => {}
    },
    events: { onNewBatch: () => () => {} },
    ui: { contextMenu: vi.fn() }
  }
}
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

it('keeps the close control visible at rest, not only on hover', async () => {
  await mount()
  const close = screen.getAllByRole('button').find((b) => b.textContent === '×')!
  expect(close.className).not.toContain('opacity-0')
})

it('names the shortcut in the new-tab and find tooltips', async () => {
  await mount()
  expect(screen.getByRole('button', { name: 'New Terminal' }).getAttribute('title')).toMatch(/\((⌘T|Ctrl\+T)\)$/)
  expect(screen.getByRole('button', { name: 'Search buffer' }).getAttribute('title')).toMatch(/\((⌘F|Ctrl\+F)\)$/)
})

it('opens find from anywhere on the page, not only when the terminal has focus', async () => {
  await mount()
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
  await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
})

it('says in the capture explanation that a recording state is not a promise of full output', async () => {
  await mount()
  fireEvent.click(screen.getByTestId('terminal-about-open'))
  expect((await screen.findByTestId('terminal-about-boundary')).textContent).toMatch(/does not mean every shell command output is fully kept/)
})

it('opens buffer search from the header, and the meta line names the pane PID', async () => {
  await mount()
  await waitFor(() => expect(screen.getByTestId('terminal-meta-pid').textContent).toContain('4242'))
  fireEvent.click(screen.getByTestId('terminal-search-open'))
  await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
  expect(screen.getByText('Esc to close')).toBeTruthy()
})

it('says in the shell menu which shells have a hook and which are a PTY stream only', async () => {
  ;(window as unknown as { redlog: { terminal: { shells: unknown } } }).redlog.terminal.shells = vi.fn(async () => [
    { id: 'zsh', label: 'zsh', flavour: 'posix' }, { id: 'sh', label: '/bin/sh', flavour: 'none' }
  ])
  await mount()
  fireEvent.click(await screen.findByTestId('terminal-shell-menu'))
  const items = screen.getAllByRole('menuitem')
  expect(items[0].textContent).toContain('hook supported')
  expect(items[1].textContent).toContain('PTY stream only')
  expect(items[1].textContent).toContain('not recorded')
})
