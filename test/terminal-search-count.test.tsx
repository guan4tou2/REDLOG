// @vitest-environment jsdom
//
// The terminal buffer search says how many matches the query has, from the
// addon's own count (it reports only while decorations are on). No query, no
// count; a query that finds nothing says so rather than keeping an old number.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'

type Listener = (e: { resultIndex: number; resultCount: number }) => void
const addons: Array<{ listeners: Listener[]; findResult: boolean; calls: Array<[string, string, unknown]> }> = []

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
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    listeners: Listener[] = []; findResult = true; calls: Array<[string, string, unknown]> = []
    constructor() { addons.push(this) }
    findNext(q: string, o: unknown): boolean { this.calls.push(['next', q, o]); return this.findResult }
    findPrevious(q: string, o: unknown): boolean { this.calls.push(['prev', q, o]); return this.findResult }
    clearDecorations(): void {}
    onDidChangeResults(l: Listener): { dispose(): void } {
      this.listeners.push(l)
      return { dispose: () => { this.listeners = this.listeners.filter((x) => x !== l) } }
    }
  }
}))

beforeEach(() => {
  addons.length = 0
  window.localStorage.setItem('redlog-locale', 'en')
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  ;(window as unknown as { redlog: unknown }).redlog = {
    terminal: {
      list: vi.fn(async () => []), shells: vi.fn(async () => []),
      spawn: vi.fn(async () => ({ pid: 1, recording: true, castTruncated: false, paused: false, hookSourced: false, shell: '/bin/sh' })),
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      onData: () => () => {}, onExit: () => () => {}, onCastState: () => () => {}
    },
    events: { onNewBatch: () => () => {} },
    ui: { contextMenu: vi.fn() }
  }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

async function openSearch(): Promise<HTMLInputElement> {
  const { default: TerminalView } = await import('../src/renderer/src/components/TerminalView')
  render(<I18nProvider><TerminalView /></I18nProvider>)
  await waitFor(() => expect(addons.length).toBeGreaterThan(0))
  fireEvent.click(screen.getByRole('button', { name: 'Search buffer' }))
  return screen.getByPlaceholderText(/Search terminal buffer/) as HTMLInputElement
}
const report = (resultIndex: number, resultCount: number): void => {
  act(() => addons[0].listeners.forEach((l) => l({ resultIndex, resultCount })))
}

it('shows no count until there is a query', async () => {
  await openSearch()
  expect(screen.queryByTestId('terminal-search-count')).toBeNull()
})

it('shows position and total from the addon, searching with decorations on', async () => {
  const input = await openSearch()
  fireEvent.change(input, { target: { value: 'root' } })
  const [, query, opts] = addons[0].calls[0]
  expect(query).toBe('root')
  expect(opts).toHaveProperty('decorations')
  report(1, 7)
  expect(screen.getByTestId('terminal-search-count').textContent).toBe('2 of 7')
  report(-1, 7)
  expect(screen.getByTestId('terminal-search-count').textContent).toBe('7 matches')
})

it('says no matches when the find fails, and drops the count when the query is cleared', async () => {
  const input = await openSearch()
  addons[0].findResult = false
  fireEvent.change(input, { target: { value: 'zzz' } })
  expect(screen.getByTestId('terminal-search-count').textContent).toBe('0 matches')
  fireEvent.change(input, { target: { value: '' } })
  expect(screen.queryByTestId('terminal-search-count')).toBeNull()
})

it('marks a count that hit the addon\'s limit as a floor', async () => {
  const input = await openSearch()
  fireEvent.change(input, { target: { value: 'a' } })
  report(-1, 1000)
  expect(screen.getByTestId('terminal-search-count').textContent).toBe('1000+ matches')
})
