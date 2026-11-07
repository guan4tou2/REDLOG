// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { BookmarksView } from '../src/renderer/src/components/BookmarksView'

// Bookmarks are local working notes, not chained events and not in the
// evidence bundle; the page says so once there is something listed (the empty
// state already carries the longer explanation).

const install = (list: unknown[]): void => {
  ;(window as unknown as { redlog: unknown }).redlog = {
    bookmarks: { list: async () => list, get: async () => null, create: async () => null, update: async () => null, delete: async () => true },
    cdp: { getTab: async () => ({ url: null, title: null, connected: false }) },
    app: { openExternal: async () => {} }
  }
}
beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => { cleanup(); window.localStorage.clear() })

describe('the bookmarks scope note', () => {
  it('states local, not on the chain, not in the bundle when bookmarks exist', async () => {
    install([{ id: 'a', title: 'Admin panel', url: null, note: '', createdAt: 1, context: {} }])
    render(<I18nProvider><BookmarksView /></I18nProvider>)
    const note = await screen.findByTestId('bookmarks-scope-note')
    expect(note.textContent).toBe('Bookmarks are local, editable working notes: not chained events, and not exported with the evidence bundle. They hold a title, a URL and a note.')
  })

  it('leaves the empty state to its own explanation', async () => {
    install([])
    render(<I18nProvider><BookmarksView /></I18nProvider>)
    await screen.findByText('No bookmarks yet')
    expect(screen.queryByTestId('bookmarks-scope-note')).toBeNull()
  })
})
