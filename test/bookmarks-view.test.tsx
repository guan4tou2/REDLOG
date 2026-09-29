// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
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
