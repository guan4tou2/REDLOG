// @vitest-environment jsdom

// A live loot batch re-read the list from page one and replaced it, so the
// older page the operator had just loaded vanished — and the marker went back
// to "recent subset" — every time a new secret was detected.
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LootPanel } from '../src/renderer/src/components/LootPanel'

const shared = { filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false } }
vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => shared,
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const loot = (id: string, preview: string, timestamp: number) => ({
  id, timestamp, operatorId: 'op', agentType: 'loot', targetId: '10.10.10.10',
  data: { source: 'nmap', matches: [{ type: 'generic_api_key', confidence: 'high', preview }] }
})

afterEach(cleanup)

it('keeps the older pages it loaded across a live refresh, and still says whether the list is whole', async () => {
  let head = [loot('new', 'new secret', 2)]
  const queryPage = vi.fn(async ({ cursor }: { cursor?: string }) => cursor === 'older'
    ? { items: [loot('old', 'old secret', 1)], hasMore: false, nextCursor: null }
    : { items: head, hasMore: true, nextCursor: 'older' })
  const listeners = new Set<(events: unknown[]) => void>()
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryPage, onNewBatch: (cb: (events: unknown[]) => void) => { listeners.add(cb); return () => listeners.delete(cb) } }
  }
  render(<LootPanel />)
  await screen.findByText('new secret')
  fireEvent.click(screen.getByRole('button', { name: 'loot.loadOlder' }))
  await screen.findByText('old secret')
  expect(screen.getByTestId('loot-completeness').textContent).toBe('loot.complete')
  const oldRow = (): HTMLElement => screen.getByText('old secret').closest('[aria-expanded]') as HTMLElement
  fireEvent.click(oldRow())
  expect(oldRow().getAttribute('aria-expanded')).toBe('true')

  head = [loot('live', 'live secret', 3), loot('new', 'new secret', 2)]
  act(() => { for (const cb of listeners) cb([{ id: 'live', agentType: 'loot', data: {} }]) })
  await waitFor(() => expect(screen.getByText('live secret')).toBeTruthy(), { timeout: 3000 })
  expect(oldRow().getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('new secret')).toBeTruthy()
  expect(screen.getByTestId('loot-completeness').textContent).toBe('loot.complete')
})
