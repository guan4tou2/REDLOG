// @vitest-environment jsdom
//
// Spec 069 T019: the evidence heading and its three tabs. A count appears only
// where it is a total over the project — loot's page counts matches inside
// events, so a second number for it would disagree with the page.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { EvidenceHeader, BOOKMARKS_CHANGED } from '../src/renderer/src/components/EvidenceHeader'

let bookmarks = 2
function install(shots = 14): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { count: vi.fn(async () => shots), onNewBatch: () => () => {} },
    bookmarks: { list: vi.fn(async () => Array.from({ length: bookmarks }, (_, i) => ({ id: `b${i}` }))) }
  }
}
const onNavigate = vi.fn()
const mount = (page: 'screenshots' | 'loot' | 'bookmarks' = 'screenshots'): void => {
  render(<I18nProvider><EvidenceHeader page={page} onNavigate={onNavigate} /></I18nProvider>)
}
beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en'); onNavigate.mockReset(); bookmarks = 2 })
afterEach(() => cleanup())

it('counts screenshots and bookmarks over the project, and gives loot no second number', async () => {
  install(14)
  mount()
  await waitFor(() => expect(screen.getByTestId('tab-count-screenshots').textContent).toBe('14'))
  await waitFor(() => expect(screen.getByTestId('tab-count-bookmarks').textContent).toBe('2'))
  expect(screen.queryByTestId('tab-count-loot')).toBeNull()
  expect(window.redlog.events.count).toHaveBeenCalledWith({ filter: { agentType: 'screenshot' } })
})

it('moves between the three pages by click and by arrow key', async () => {
  install()
  mount('loot')
  fireEvent.click(screen.getByRole('tab', { name: /Bookmarks/ }))
  expect(onNavigate).toHaveBeenCalledWith('bookmarks')
  fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowRight' })
  expect(onNavigate).toHaveBeenLastCalledWith('bookmarks')
  fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowLeft' })
  expect(onNavigate).toHaveBeenLastCalledWith('screenshots')
})

it('re-reads the bookmark count when a bookmark is added or removed', async () => {
  install()
  mount('bookmarks')
  await waitFor(() => expect(screen.getByTestId('tab-count-bookmarks').textContent).toBe('2'))
  bookmarks = 3
  act(() => { window.dispatchEvent(new Event(BOOKMARKS_CHANGED)) })
  await waitFor(() => expect(screen.getByTestId('tab-count-bookmarks').textContent).toBe('3'))
})

it('shows no count for a read that failed, rather than zero', async () => {
  install()
  window.redlog.events.count = vi.fn(async () => { throw new Error('boom') })
  mount()
  await waitFor(() => expect(screen.getByTestId('tab-count-bookmarks').textContent).toBe('2'))
  expect(screen.queryByTestId('tab-count-screenshots')).toBeNull()
})
