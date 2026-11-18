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

// The row, in the prototype's order: time | kind glyph | content | target |
// result | source. The target is the anchor's own, already on the item.
it('lays a row out as time, kind, content, target, result and source', async () => {
  mount([summary('a', { result: { exitCode: 0 }, anchor: ev('a', { timestamp: Date.now(), targetId: '10.10.10.5', data: { command: 'nmap 10.10.10.5', subtype: 'command_end', exit_code: 0 } }) })])
  const row = await screen.findByTestId('activity-row')
  const cells = Array.from(row.children).map((el) => el.getAttribute('data-testid') ?? el.tagName.toLowerCase())
  expect(cells).toEqual(['time', 'activity-kind', 'activity-content', 'activity-target', 'activity-result', 'activity-row-source'])
  const target = screen.getByTestId('activity-target')
  expect(target.textContent).toBe('10.10.10.5')
  expect(target.getAttribute('title')).toBe('10.10.10.5')
  expect(target.className).toContain('truncate')
  expect(screen.getByTestId('activity-result').textContent).toBe('0')
})

it('leaves the target empty, and the result position empty, when there is none to show', async () => {
  mount([summary('a', { state: 'unknown' })])
  await screen.findByTestId('activity-row')
  const target = screen.getByTestId('activity-target')
  expect(target.textContent).toBe('')
  expect(target.getAttribute('title')).toBeNull()
  expect(screen.getByTestId('activity-result').textContent).toBe('')
})

// The glyph comes from the activity's kind, never from comparing event types.
it('chooses the glyph by the kind of activity', async () => {
  const kinds = { command: '$', http: '→', tool: '◇', message: '◇', event: '·' } as const
  mount(Object.keys(kinds).map((kind) => summary(kind, { kind })))
  await screen.findAllByTestId('activity-row')
  expect(screen.getAllByTestId('activity-kind').map((g) => g.textContent)).toEqual(Object.values(kinds))
  for (const g of screen.getAllByTestId('activity-kind')) expect(g.getAttribute('role')).toBe('img')
})

// Narrow, the target column goes first; the others keep their place.
it('collapses the target column first when the list is narrow', async () => {
  mount([summary('a')])
  const row = await screen.findByTestId('activity-row')
  expect(row.closest('[data-testid="activity-list"]')?.className).toMatch(/(^|\s)@container(\s|$)/)
  expect(screen.getByTestId('activity-target').className).toMatch(/(^|\s)hidden(\s|$)/)
  expect(screen.getByTestId('activity-target').className).toContain('@min-[720px]:block')
})

// Export always exports the current view; the expanded row no longer offers a
// choice of scope. What it keeps: read (primary), locate, the events around
// it, and the source-event count.
it('offers no export scope in the expanded row, and keeps its four things', async () => {
  api.activityPage.mockResolvedValue({ items: [summary('a', { sourceCount: 3 })], hasMore: false, nextCursor: null, totalGroups: 1, totalMatches: 3, snapshot: {} })
  api.activityMembers.mockResolvedValue({ items: [], hasMore: false, nextCursor: null, sourceCount: 0, matchedCount: 0, snapshot: {} })
  api.query.mockResolvedValue([])
  ;(window as any).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: { onNewBatch: () => () => {}, ...api },
    content: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), read: vi.fn() }
  }
  render(<ActivityResults onOpen={vi.fn()} request={{ parsed: { text: '', conditions: [], tokens: [] } } as any} />)
  ;(await screen.findByTestId('activity-row')).click()
  const box = await screen.findByTestId('activity-summary')
  expect(box.querySelector('select')).toBeNull()
  expect(box.textContent).not.toContain('activity.export.')
  expect(screen.getByTestId('activity-read').className).toContain('bg-redlog-accent')
  expect(screen.getByTestId('activity-locate')).toBeTruthy()
  expect(screen.getByTestId('activity-around-toggle')).toBeTruthy()
  expect(screen.getByTestId('activity-summary-meta').textContent).toBe('activity.summary.sources {"count":3}')
})

// A row keeps one height whatever its result says: the result cell cannot
// wrap; a short word shows and the full sentence is its title and name.
it('keeps the result on one line, with the full state as its title and accessible name', async () => {
  mount([summary('a', { result: { exitCode: null } })])
  await screen.findByTestId('activity-row')
  const cell = screen.getByTestId('activity-result')
  expect(cell.className).toContain('whitespace-nowrap')
  expect(cell.className).not.toContain('leading-tight')
  expect(cell.getAttribute('title')).toBe('activity.result.ended')
  expect(cell.querySelector('[aria-hidden="true"]')?.textContent).toBe('activity.result.endedShort')
  expect(cell.querySelector('.sr-only')?.textContent).toBe('activity.result.ended')
})
