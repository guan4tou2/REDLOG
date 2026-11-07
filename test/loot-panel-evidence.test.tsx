// @vitest-environment jsdom
//
// Spec 069 T019: loot reads in place. A row opens to its detail, the Timeline
// is a button inside it, and the page says a rule match is not proof.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { LootPanel } from '../src/renderer/src/components/LootPanel'

const loot = (id: string, type: string, preview: string, ts: number) => ({
  id, timestamp: ts, agentType: 'loot', targetId: '10.0.0.5',
  data: { source: 'shell', matches: [{ type, confidence: 'high', preview }] }
})
const events = [loot('l1', 'jwt', 'eyJ-first-token', 3), loot('l2', 'generic_api_key', 'AKIA-second-key', 2), loot('l3', 'jwt', 'eyJ-third-token', 1)]
const onOpen = vi.fn()
function mount(): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryPage: vi.fn(async () => ({ items: events, hasMore: false, nextCursor: null })), onNewBatch: () => () => {} }
  }
  render(<I18nProvider><LootPanel onOpenInTimeline={onOpen} /></I18nProvider>)
}
beforeEach(() => { window.localStorage.setItem('redlog-locale', 'en'); onOpen.mockReset() })
afterEach(() => cleanup())

it('says a hit is a pattern match, not proof the credential works', async () => {
  mount()
  expect((await screen.findByTestId('loot-disclaimer')).textContent).toContain('does not mean the credential works')
})

it('opens a row in place instead of leaving for the Timeline, and locates from inside it', async () => {
  mount()
  fireEvent.click(await screen.findByText('eyJ-first-token'))
  expect(onOpen).not.toHaveBeenCalled()
  const detail = screen.getByTestId('loot-detail')
  expect(detail.textContent).toContain('not proof')
  fireEvent.click(screen.getByTestId('loot-locate'))
  expect(onOpen).toHaveBeenCalledWith('l1', 3)
  fireEvent.click(screen.getByText('eyJ-first-token'))
  expect(screen.queryByTestId('loot-detail')).toBeNull()
})

it('filters by type with an All chip that undoes it, and searches the loaded rows', async () => {
  mount()
  await screen.findByText('eyJ-first-token')
  fireEvent.click(screen.getByRole('button', { name: /Generic API key/ }))
  expect(screen.queryByText('eyJ-first-token')).toBeNull()
  expect(screen.getByText('AKIA-second-key')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /^All/ }))
  expect(screen.getByText('eyJ-first-token')).toBeTruthy()
  fireEvent.change(screen.getByTestId('loot-search'), { target: { value: 'third' } })
  expect(screen.queryByText('eyJ-first-token')).toBeNull()
  expect(screen.getByText('eyJ-third-token')).toBeTruthy()
  fireEvent.change(screen.getByTestId('loot-search'), { target: { value: 'zzz' } })
  fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
  expect(screen.getByText('eyJ-first-token')).toBeTruthy()
})
