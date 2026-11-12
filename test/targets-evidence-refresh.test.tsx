// @vitest-environment jsdom
//
// A target's evidence while events arrive. A live row that could not be
// checked against the target (matchIds failed) made the page re-read its first
// page and replace the list with it, so the older events the operator had
// loaded went away and "Load more" came back. A "Load more" still out when the
// target was closed and opened again was appended to the fresh list.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { FilterProvider } from '../src/renderer/src/lib/FilterContext'
import { I18nProvider } from '../src/renderer/src/i18n'
import { installTimelineBridge, makeEvent, page, deferred, type TimelineBridge } from './helpers/timeline-bridge'

const T0 = 1_700_000_000_000
const cmd = (id: string, ts: number, command: string) => makeEvent(id, ts, 'shell', { targetId: 'a.test', data: { subtype: 'command_end', command } })

let b: TimelineBridge
beforeEach(() => {
  window.localStorage.setItem('redlog-locale', 'en')
  b = installTimelineBridge()
  const r = (window as unknown as { redlog: Record<string, Record<string, unknown>> }).redlog
  r.events.aggregateTargets = async () => [{ target: 'a.test', eventCount: 3, firstSeen: T0, lastSeen: T0 + 2 }]
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

const open = async (): Promise<void> => {
  render(<I18nProvider><FilterProvider><TargetView /></FilterProvider></I18nProvider>)
  fireEvent.click(await screen.findByText('a.test'))
}

it('keeps the older events it loaded when a live row has to be re-read', async () => {
  let head = [cmd('e2', T0 + 2, 'newest-cmd')]
  b.queryPage.mockImplementation(async (req: { cursor?: string }) => req.cursor === 'c1'
    ? page([cmd('e1', T0 + 1, 'older-cmd')])
    : page(head, true, 'c1'))
  await open()
  await screen.findByText(/newest-cmd/)
  fireEvent.click(screen.getByRole('button', { name: /Load more/ }))
  await screen.findByText(/older-cmd/)

  head = [cmd('e3', T0 + 3, 'live-cmd'), cmd('e2', T0 + 2, 'newest-cmd')]
  b.matchIds.mockRejectedValueOnce(new Error('busy'))
  act(() => b.emitBatch([cmd('e3', T0 + 3, 'live-cmd')]))
  await screen.findByText(/live-cmd/)
  expect(screen.getByText(/older-cmd/)).toBeTruthy()
  expect(screen.getByText('3 / 3 events')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Load more/ })).toBeNull()
})

it('drops a "load more" reply from before the target was closed and opened again', async () => {
  const more = deferred<ReturnType<typeof page>>()
  b.queryPage.mockImplementation(async (req: { cursor?: string }) => req.cursor === 'c1'
    ? more.promise
    : page([cmd('e2', T0 + 2, 'newest-cmd')], true, 'c1'))
  await open()
  await screen.findByText(/newest-cmd/)
  fireEvent.click(screen.getByRole('button', { name: /Load more/ }))
  fireEvent.click(screen.getByText('a.test'))
  fireEvent.click(screen.getByText('a.test'))
  await screen.findByText(/newest-cmd/)
  await act(async () => { more.resolve(page([cmd('stale', T0 + 1, 'stale-older-cmd')])) })
  await waitFor(() => expect(screen.getByText('1 / 3 events')).toBeTruthy())
  expect(screen.queryByText(/stale-older-cmd/)).toBeNull()
})
