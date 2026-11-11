// @vitest-environment jsdom
//
// Enter that picks an input-method candidate (Zhuyin, Pinyin, Kana…) is the
// IME's, not a submit. Each field here submits on Enter; during composition
// it must not, and outside composition it still must. lib/ime.ts is the one
// check they all use.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import NetworkPage from '../src/renderer/src/components/settings/NetworkPage'
import { ListField, type ConfigState } from '../src/renderer/src/components/settings/SettingsShared'
import { EventContentReader } from '../src/renderer/src/components/EventContentReader'
import { parseScopeInput } from '../src/renderer/src/lib/scopeInput'
import { isComposing } from '../src/renderer/src/lib/ime'

const addons: Array<{ calls: string[] }> = []
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
    calls: string[] = []
    constructor() { addons.push(this) }
    findNext(): boolean { this.calls.push('next'); return true }
    findPrevious(): boolean { this.calls.push('prev'); return true }
    clearDecorations(): void {}
    onDidChangeResults(): { dispose(): void } { return { dispose() {} } }
  }
}))

const composing = { key: 'Enter', isComposing: true }
const plain = { key: 'Enter' }

beforeEach(() => {
  addons.length = 0
  window.localStorage.setItem('redlog-locale', 'en')
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

describe('isComposing', () => {
  it('reads a React event, a DOM event and the 229 keyCode', () => {
    expect(isComposing({ nativeEvent: { isComposing: true } })).toBe(true)
    expect(isComposing({ isComposing: true })).toBe(true)
    expect(isComposing({ keyCode: 229 })).toBe(true)
    expect(isComposing({ keyCode: 13, isComposing: false, nativeEvent: { isComposing: false } })).toBe(false)
  })
})

describe('Enter during IME composition does not submit', () => {
  it('Terminal buffer search', async () => {
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
    const { default: TerminalView } = await import('../src/renderer/src/components/TerminalView')
    render(<I18nProvider><TerminalView /></I18nProvider>)
    await waitFor(() => expect(addons.length).toBeGreaterThan(0))
    fireEvent.click(screen.getByRole('button', { name: 'Search buffer' }))
    const input = screen.getByPlaceholderText(/Search terminal buffer/)
    fireEvent.change(input, { target: { value: 'root' } })
    const typed = addons[0].calls.length
    fireEvent.keyDown(input, composing)
    expect(addons[0].calls.length).toBe(typed)
    fireEvent.keyDown(input, plain)
    expect(addons[0].calls.slice(typed)).toEqual(['next'])
  })

  it('saved-content Find', async () => {
    const ref = { projectId: 'p', eventId: 'e', field: 'stdout', version: 'v' }
    const find = vi.fn(async () => ({ ok: true, value: { match: null, hasMore: false, nextCursor: null } }))
    ;(window as unknown as { redlog: unknown }).redlog = { content: {
      list: vi.fn(async () => ({ ok: true, value: [{ field: 'stdout', status: 'available', ref, bytes: 4, format: 'utf8', capture: 'unknown' }] })),
      read: vi.fn(async () => ({ ok: true, value: { offset: 0, end: 4, total: 4, text: 'head', format: 'utf8', hasMore: false, nextCursor: null } })),
      find
    } }
    render(<I18nProvider><EventContentReader projectId="p" eventId="e" /></I18nProvider>)
    await screen.findByText('head', { selector: 'pre' })
    const box = screen.getByRole('searchbox')
    fireEvent.change(box, { target: { value: 'needle' } })
    fireEvent.keyDown(box, composing)
    expect(find).not.toHaveBeenCalled()
    fireEvent.keyDown(box, plain)
    await waitFor(() => expect(find).toHaveBeenCalledTimes(1))
  })

  it('Settings ▸ Network: add a VPN adapter pattern', () => {
    const config = { engagement: { id: 'p1' }, network: { whitelist: [], blacklist: [], checkInterval: 60 } } as unknown as ConfigState
    const setConfig = vi.fn()
    render(<I18nProvider><NetworkPage config={config} setConfig={setConfig} t={(k: string) => k} /></I18nProvider>)
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Corp' } })
    const pattern = screen.getByPlaceholderText('Regex pattern')
    fireEvent.change(pattern, { target: { value: '^corp' } })
    fireEvent.keyDown(pattern, composing)
    expect(setConfig).not.toHaveBeenCalled()
    fireEvent.keyDown(pattern, plain)
    expect(setConfig).toHaveBeenCalledTimes(1)
    expect(setConfig.mock.calls[0][0].network.vpnAdapters.at(-1)).toEqual({ name: 'Corp', pattern: '^corp', enabled: true })
  })

  it('Settings list field: add an entry (single-line input)', () => {
    const onChange = vi.fn()
    render(<I18nProvider><ListField label="Personal" items={[]} onChange={onChange} placeholder="entry" /></I18nProvider>)
    const input = screen.getByPlaceholderText('entry')
    fireEvent.change(input, { target: { value: 'me.test' } })
    fireEvent.keyDown(input, composing)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(input, plain)
    expect(onChange).toHaveBeenCalledWith(['me.test'])
  })

  it('Settings list field: add a scope entry (⌘/Ctrl+Enter in the textarea)', () => {
    const onChange = vi.fn()
    render(<I18nProvider><ListField label="Targets" items={[]} onChange={onChange} placeholder="scope" parse={parseScopeInput} /></I18nProvider>)
    const box = screen.getByPlaceholderText('scope')
    fireEvent.change(box, { target: { value: 'a.test' } })
    fireEvent.keyDown(box, { ...composing, ctrlKey: true })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { ...plain, ctrlKey: true })
    expect(onChange).toHaveBeenCalledWith(['a.test'])
  })
})
