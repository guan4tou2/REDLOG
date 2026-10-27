// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { BookmarksView } from '../src/renderer/src/components/BookmarksView'
import { formatDateTime } from '../src/renderer/src/lib/time'

// The bookmark detail pane against a stubbed bridge. A bookmark made while the
// IP read was not current records the address as `lastKnownExternalIP`, and
// the pane must say that it is the last one read, and when, rather than show
// it under the plain IP label. A bookmark with `externalIP`, which is every
// row written before this change, reads as it always has.

const readAt = Date.UTC(2026, 8, 29, 6, 30, 5)
const marks = [
  { id: 'cur', title: 'Current mark', url: null, note: '', createdAt: readAt + 60_000,
    context: { externalIP: '203.0.113.7' } },
  { id: 'old', title: 'Stale mark', url: null, note: '', createdAt: readAt + 90_000,
    context: { lastKnownExternalIP: { address: '198.51.100.4', readAt } } }
]

beforeEach(() => {
  window.localStorage.setItem('redlog-locale', 'en')
  ;(window as unknown as { redlog: unknown }).redlog = {
    bookmarks: {
      list: async () => marks,
      get: async (id: string) => marks.find((m) => m.id === id) ?? null,
      create: async () => null, update: async () => null, delete: async () => true
    },
    cdp: { getTab: async () => ({ url: null, title: null, connected: false }) },
    app: { openExternal: async () => {} }
  }
})
afterEach(() => { cleanup(); window.localStorage.clear() })

const openMark = async (title: string): Promise<void> => {
  render(<I18nProvider><BookmarksView /></I18nProvider>)
  fireEvent.click(await screen.findByText(title))
}

describe('the IP a bookmark shows', () => {
  it('shows a stale address as the last known one, with when it was read', async () => {
    await openMark('Stale mark')
    const row = await screen.findByTestId('bookmark-last-known-ip')
    expect(row.textContent).toContain('Last known IP:')
    expect(row.textContent).toContain('198.51.100.4')
    expect(row.textContent).toContain(`(read ${formatDateTime(readAt, { seconds: true })})`)
    expect(screen.queryByText('IP:')).toBeNull()
  })

  it('shows a current address, and every row written before, under the plain IP label', async () => {
    await openMark('Current mark')
    expect(await screen.findByText('IP:')).toBeTruthy()
    expect(screen.getByText('203.0.113.7')).toBeTruthy()
    expect(screen.queryByTestId('bookmark-last-known-ip')).toBeNull()
  })
})

describe('empty bookmarks', () => {
  it('shows one empty state with the custody boundary and can open the form', async () => {
    window.redlog.bookmarks.list = vi.fn(async () => [])
    render(<I18nProvider><BookmarksView /></I18nProvider>)
    const capture = await screen.findByRole('button', { name: 'Quick Capture' })
    expect(screen.queryByText('Click + Capture to bookmark the current page')).toBeNull()
    expect(screen.getByText(/not chained, not signed/)).toBeTruthy()
    fireEvent.click(capture)
    expect(await screen.findByRole('textbox', { name: /Title/i })).toBeTruthy()
  })
})

it('returns to the narrow list without losing search, selection, scroll or an editing draft', async () => {
  let width = 600
  let resized = () => {}
  vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(()=>width)
  vi.stubGlobal('ResizeObserver',class {
    constructor(callback:()=>void) { resized=callback }
    observe() {} disconnect() {}
  })
  window.redlog.bookmarks.list = vi.fn(async()=>[...marks,...Array.from({length:8},(_,i)=>({...marks[0],id:`extra-${i}`,title:`Other ${i}`}))])
  try {
    render(<I18nProvider><BookmarksView /></I18nProvider>)
    const search = await screen.findByPlaceholderText('Search bookmarks (title / URL / note)')
    fireEvent.change(search,{target:{value:'mark'}})
    const list = screen.getByRole('listbox')
    list.scrollTop=48; fireEvent.scroll(list)
    fireEvent.click(screen.getByText('Current mark'))
    fireEvent.click(await screen.findByRole('button',{name:'Edit',exact:true}))
    const note=screen.getByRole('textbox',{name:'Note'})
    fireEvent.change(note,{target:{value:'unsaved draft'}})
    fireEvent.click(screen.getByRole('button',{name:'Back to bookmarks'}))
    expect((search as HTMLInputElement).value).toBe('mark')
    expect(list.scrollTop).toBe(48)
    fireEvent.click(screen.getByText('Current mark'))
    expect((screen.getByRole('textbox',{name:'Note'}) as HTMLTextAreaElement).value).toBe('unsaved draft')
    act(() => { width=1200; resized() })
    expect(screen.queryByRole('button',{name:'Back to bookmarks'})).toBeNull()
    expect((screen.getByRole('textbox',{name:'Note'}) as HTMLTextAreaElement).value).toBe('unsaved draft')
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals() }
})

it('does not report a pending or failed bookmark read as an empty collection, and can retry', async () => {
  let rejectRead!: (error: Error) => void
  const list = vi.fn(() => new Promise<Bookmark[]>((_resolve, reject) => { rejectRead = reject }))
  window.redlog.bookmarks.list = list
  render(<I18nProvider><BookmarksView /></I18nProvider>)
  expect(screen.getByRole('status').textContent).toContain('Loading')
  expect(screen.queryByText('No bookmarks yet')).toBeNull()
  await act(async () => rejectRead(new Error('synthetic bookmark read failure')))
  expect(screen.getByRole('alert').textContent).toContain('synthetic bookmark read failure')
  expect(screen.queryByText('No bookmarks yet')).toBeNull()
  list.mockImplementation(async () => marks)
  fireEvent.click(screen.getByRole('button', { name: 'Retry', exact: true }))
  expect(await screen.findByText('Current mark')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})
