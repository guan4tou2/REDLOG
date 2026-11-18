// @vitest-environment jsdom
//
// The Activity list against the 01-activity prototype (2026-11-18): rows on a
// rule rather than cards in gaps, no column header, one count, a paged list
// that says how much of it is loaded.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ActivityResults } from '../src/renderer/src/components/ActivityResults'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string, v?: Record<string, unknown>) => v ? `${k} ${JSON.stringify(v)}` : k }) }))
vi.mock('../src/renderer/src/components/CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button>{text}</button> }))

const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id, timestamp: 1000, agentType: 'shell', sessionId: `sess-${id}`, targetId: null, hash: `hash-${id}`, prevHash: `prev-${id}`,
  data: { command: id, subtype: 'command_start' }, ...over
})
const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'command', state: 'paired', toolAction: 'unknown', provider: null, firstAt: Date.now(), anchor: ev(id, { timestamp: Date.now() }),
  matchedCount: 1, sourceCount: 1, contextCount: 0, matchedPreview: { ids: [id], hasMore: false }, sourcePreview: { ids: [id], hasMore: false }, ...over
})

let push: (events: unknown[]) => void = () => {}
const api = { activityPage: vi.fn(), activityMembers: vi.fn(), query: vi.fn() }
function mount(items: unknown[], page: Record<string, unknown> = {}): void {
  api.activityPage.mockResolvedValue({ items, hasMore: false, nextCursor: null, totalGroups: items.length, totalMatches: items.length * 2, snapshot: {}, ...page })
  api.activityMembers.mockResolvedValue({ items: [], hasMore: false, nextCursor: null, sourceCount: 0, matchedCount: 0, snapshot: {} })
  api.query.mockResolvedValue([])
  ;(window as any).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: { onNewBatch: (cb: (e: unknown[]) => void) => { push = cb; return () => {} }, ...api },
    content: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), read: vi.fn() }
  }
  render(<ActivityResults request={{ parsed: { text: '', conditions: [], tokens: [] } } as any} />)
}

beforeEach(() => { localStorage.clear(); Object.values(api).forEach((f) => f.mockReset()) })
afterEach(() => cleanup())

it('draws no column header over the rows', async () => {
  mount([summary('a'), summary('b')])
  await screen.findAllByTestId('activity-row')
  for (const key of ['activity.col.time', 'activity.col.source', 'activity.col.content', 'activity.col.view']) {
    expect(screen.queryByText(key), key).toBeNull()
  }
})

it('separates rows by a rule, not by gaps between rounded cards', async () => {
  mount([summary('a'), summary('b')])
  const rows = await screen.findAllByTestId('activity-row')
  for (const row of rows) {
    const line = row.parentElement as HTMLElement
    expect(line.className).toContain('border-b')
    expect(line.className).not.toMatch(/\brounded/)
    expect(line.className).not.toMatch(/\bbg-redlog-surface\b/)
    expect(row.className).not.toMatch(/\brounded/)
    // 36px and the 1px rule: a 37px pitch, without touching the global --row-h.
    expect(row.className).toContain('min-h-9')
    expect(row.className).not.toContain('var(--row-h)')
  }
  expect((rows[0].closest('[data-testid="activity-list"]') as HTMLElement).className).not.toMatch(/\bgap-/)
})

it('counts activities once, not activities and source events', async () => {
  mount([summary('a'), summary('b')])
  await screen.findAllByTestId('activity-row')
  const stats = screen.getByTestId('activity-stats').textContent ?? ''
  expect(stats).toContain('activity.count {"groups":2}')
  expect(stats).not.toContain('matches')
})

it('offers new events as a quiet link, not a bordered button', async () => {
  mount([summary('a')])
  await screen.findByTestId('activity-row')
  act(() => { push([{}, {}, {}]) })
  const link = screen.getByTestId('activity-new-events')
  expect(link.textContent).toBe('workspace.newActivity {"count":3}')
  expect(link.className).not.toMatch(/\bborder\b/)
  expect(link.className).toContain('underline')
})

it('says how much of a paged list is loaded, beside the way to load more', async () => {
  mount([summary('a'), summary('b')], { hasMore: true, nextCursor: 'next', totalGroups: 120 })
  await screen.findAllByTestId('activity-row')
  expect(screen.getByTestId('activity-loaded').textContent).toBe('activity.loaded {"shown":2,"total":120}')
  expect(screen.getByRole('button', { name: 'search.loadMore' })).toBeTruthy()
})

it('says nothing about loading once the whole list is on screen', async () => {
  mount([summary('a'), summary('b')])
  await screen.findAllByTestId('activity-row')
  expect(screen.queryByTestId('activity-loaded')).toBeNull()
})

it('draws the date separator as a rule with the date, not a bordered chip', async () => {
  mount([summary('a')])
  await screen.findByTestId('activity-row')
  const day = screen.getByTestId('activity-day')
  expect(day.textContent).toMatch(/^activity\.today \d{4}-\d{2}-\d{2}/)
  const framed = Array.from(day.querySelectorAll('*')).filter((el) => /(^|\s)(rounded|border)\b/.test(el.getAttribute('class') ?? ''))
  expect(framed).toEqual([])
})
