// @vitest-environment jsdom
//
// "Load more" still out when the operator picks a trigger: its page belongs
// to the previous trigger's cursor, and it was appended to the new trigger's
// list when it landed — screenshots of another trigger under the filter.
// The live path is pinned beside it: a new screenshot joins the top of the
// list, and a partial list still says more is available.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { I18nProvider } from '../src/renderer/src/i18n'
import { ScreenshotsView } from '../src/renderer/src/components/ScreenshotsView'

const shot = (id: string, trigger: string) => ({
  id, timestamp: 1_000_000 + Number(id.replace(/\D/g, '')), agentType: 'screenshot', targetId: null,
  data: { filename: `${id}.png`, filePath: `/x/${id}.png`, trigger, sha256: `sha-${id}`.padEnd(64, '0') }
})
const all = [shot('s3', 'manual'), shot('s2', 'periodic'), shot('s1', 'manual')]

let listeners: Set<(events: unknown[]) => void>
function install(queryScreenshotPage: ReturnType<typeof vi.fn>): void {
  listeners = new Set()
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryScreenshotPage, onNewBatch: (cb: (events: unknown[]) => void) => { listeners.add(cb); return () => listeners.delete(cb) } },
    screenshot: { deleteFile: vi.fn(async () => ({ ok: true })) },
    artifacts: { reveal: vi.fn(async () => true) }
  }
}
const rows = (): HTMLElement[] => screen.queryAllByRole('button', { name: /^Screenshot at/ })
beforeEach(() => { window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en') })
afterEach(() => cleanup())

it('drops a "load more" page that belonged to the trigger chosen before', async () => {
  let answerMore!: (page: unknown) => void
  const query = vi.fn(async ({ trigger, cursor }: { trigger?: string | null; cursor?: string }) => {
    if (cursor) return new Promise((resolve) => { answerMore = resolve })
    return trigger
      ? { items: all.filter((s) => s.data.trigger === trigger), hasMore: false, nextCursor: null }
      : { items: all, hasMore: true, nextCursor: 'n' }
  })
  install(query)
  render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
  await screen.findByTestId('screenshot-list')
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(query).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'n' })))
  fireEvent.click(screen.getByRole('button', { name: /periodic/ }))
  await waitFor(() => expect(rows()).toHaveLength(1))
  await act(async () => { answerMore({ items: [shot('s0', 'manual')], hasMore: false, nextCursor: null }) })
  expect(rows()).toHaveLength(1)
  expect(screen.queryByText(/s0\.png/)).toBeNull()
})

it('puts a live screenshot at the top and keeps saying the list is partial', async () => {
  install(vi.fn(async () => ({ items: all, hasMore: true, nextCursor: 'n' })))
  render(<I18nProvider><ScreenshotsView onNavigate={() => {}} /></I18nProvider>)
  await screen.findByTestId('screenshot-list')
  expect(rows()).toHaveLength(3)
  act(() => { for (const cb of listeners) cb([shot('s9', 'manual')]) })
  expect(rows()).toHaveLength(4)
  expect(rows()[0].textContent).toContain('s9.png')
  expect(screen.getByTestId('screenshots-summary').textContent).toMatch(/more/i)
})
