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
  await screen.findByTestId('terminal-tab')
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

// The page header and its capture dialog are gone: the tab strip is the first
// row, and what a pause, a stop or the size cap leaves out is said by the
// pane's own state where it applies.
it('has no page header and no capture dialog above the tab strip', async () => {
  await mount()
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  expect(screen.queryByTestId('terminal-header')).toBeNull()
  expect(screen.queryByTestId('terminal-about-open')).toBeNull()
  expect(screen.queryByText(/does not mean every shell command output is fully kept/)).toBeNull()
})

it('opens buffer search with the shortcut', async () => {
  await mount()
  fireEvent.keyDown(window, { key: 'f', metaKey: true })
  await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
  expect(screen.getByText('Esc to close')).toBeTruthy()
})

it('says only its title and offers the one button when every tab is closed', async () => {
  await mount()
  fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '×')!)
  const empty = await screen.findByTestId('terminal-empty')
  expect(empty.textContent).toBe('No terminal sessionsNew Terminal')
})

it('in the picker strip, where no tab can be opened, says only that there are none', async () => {
  const { default: TerminalView } = await import('../src/renderer/src/components/TerminalView')
  render(<I18nProvider><TerminalView allowNew={false} /></I18nProvider>)
  const empty = await screen.findByTestId('terminal-empty')
  expect(empty.textContent).toBe('No terminal sessions')
  expect(empty.querySelector('button')).toBeNull()
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
