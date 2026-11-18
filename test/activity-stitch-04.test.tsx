// @vitest-environment jsdom
//
// Stitch 04: the source and the result on the row, the new-events
// banner says how many arrived, and the Reader's hash section says what it is
// (a stored snapshot) and what it is not (a verification).

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ActivityResults } from '../src/renderer/src/components/ActivityResults'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string, v?: Record<string, unknown>) => v ? `${k} ${JSON.stringify(v)}` : k }) }))
vi.mock('../src/renderer/src/components/CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button>{text}</button> }))

const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id, timestamp: 1000, agentType: 'shell', sessionId: `sess-${id}`, targetId: null, hash: `hash-${id}`, prevHash: `prev-${id}`,
  data: { command: id, subtype: 'command_end', exit_code: 2 }, ...over
})
const summary = (id: string) => ({
  id, kind: 'command', toolAction: 'unknown', provider: null, firstAt: 1000, anchor: ev(id), matchedCount: 1, sourceCount: 1, contextCount: 0, result: { exitCode: 2 }, sourcePreview: { ids: [id], hasMore: false }
})

let push: (events: unknown[]) => void = () => {}
const api = { activityPage: vi.fn(), activityMembers: vi.fn(), query: vi.fn() }
function mount(): void {
  api.activityPage.mockResolvedValue({ items: [summary('a')], hasMore: false, nextCursor: null, totalGroups: 1, totalMatches: 1, snapshot: {} })
  api.activityMembers.mockResolvedValue({ items: [{ event: ev('a'), matched: true }], hasMore: false, nextCursor: null, sourceCount: 1, matchedCount: 1, snapshot: {} })
  ;(window as any).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: { onNewBatch: (cb: (e: unknown[]) => void) => { push = cb; return () => {} }, ...api },
    content: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), read: vi.fn() }
  }
  render(<ActivityResults request={{ parsed: { text: '', conditions: [], tokens: [] } } as any} />)
}

beforeEach(() => { localStorage.clear(); Object.values(api).forEach((f) => f.mockReset()) })
afterEach(() => cleanup())

// 2026-11-18: the 130px badge became a glyph chosen by the activity's kind and
// the source as quiet text at the row's end. A failed command reads as failed
// from its result's word, not from a tinted badge.
it('marks the kind with a glyph, names the source at the end, and says a failure in words', async () => {
  mount()
  const glyph = await screen.findByTestId('activity-kind')
  expect(glyph.textContent).toBe('$')
  expect(glyph.getAttribute('title')).toBe('timeline.shell · activity.kind.command')
  expect(glyph.getAttribute('aria-label')).toBe('timeline.shell · activity.kind.command')
  const row = screen.getByTestId('activity-row')
  expect(screen.queryByTestId('activity-source-badge')).toBeNull()
  expect(screen.getByTestId('activity-row-source').textContent).toBe('timeline.shell')
  expect(screen.getByTestId('activity-result').textContent).toBe('activity.result.failed {"code":2}')
  expect(row.textContent).not.toContain('activity.kind.command')
})

it('counts the events that arrived since the page was read, and a refresh clears the count', async () => {
  mount()
  await screen.findByTestId('activity-row')
  act(() => { push([ev('x'), ev('y')]) })
  act(() => { push([ev('z')]) })
  const banner = screen.getByTestId('activity-new-events')
  expect(banner.textContent).toContain('"count":3')
  fireEvent.click(banner)
  expect(screen.queryByTestId('activity-new-events')).toBeNull()
})

it('says the hash section is a stored snapshot, not a verification', async () => {
  mount()
  fireEvent.click(await screen.findByTestId('activity-row'))
  fireEvent.click(await screen.findByTestId('activity-read'))
  const integrity = await screen.findByTestId('reader-integrity')
  expect(integrity.textContent).toContain('activity.reader.integrity')
  expect(integrity.textContent).toContain('activity.reader.integrityNote')
  expect(integrity.textContent).toContain('hash-a')
  expect(integrity.textContent).toContain('a')
})

it('offers the events around an operation in its expanded row, from the Timeline window, and reads them only when asked', async () => {
  mount()
  api.query.mockImplementation(async (opts: { order?: string }) => opts.order === 'oldest'
    ? [ev('later', { timestamp: 4000, engagementId: 'p', agentType: 'marker', sessionId: 'x', data: { title: 'later-note' } })] : [])
  fireEvent.click(await screen.findByTestId('activity-row'))
  const toggle = await screen.findByTestId('activity-around-toggle')
  expect(api.query).not.toHaveBeenCalled()
  fireEvent.click(toggle)
  const row = await screen.findByTestId('activity-around-event')
  expect(row.textContent).toContain('later-note')
  expect(api.query.mock.calls.map(([opts]) => [opts.since, opts.before, opts.order])).toEqual([[1000 - 300_000, 1000, 'newest'], [1000, 1000 + 300_000, 'oldest']])
})

// The rows were py-2.5 around a 25.6px line, about 49px, then `--row-h`
// cards 4px apart (44px). The 01-activity prototype draws 36px over a 1px
// rule; the height is a minimum, so a row that has more to show still grows
// instead of cutting it.
it('sizes each activity row by the 36px minimum, not by its own padding', async () => {
  mount()
  const row = await screen.findByTestId('activity-row')
  expect(row.className).toContain('min-h-9')
  expect(row.className).not.toMatch(/\bpy-2(\.5)?\b/)
})

// Arriving from a Timeline event: the activity that holds the event is the one
// shown open, the way a click on its row shows it, and it stays the operator's
// to close. The page is told which event it was asked for; it acts only on the
// request that names that event, never on the one still on screen while the
// typed query catches up.
const holding = (id: string, events: string[]) => ({ ...summary(id), matchedPreview: { ids: events, hasMore: false }, sourcePreview: { ids: events, hasMore: false } })
const eventQuery = (id: string) => ({ text: '', conditions: [{ field: 'event', value: id }], tokens: [] })

function mountLocating(over: { items?: unknown[]; request?: unknown; locateEventId?: string; onLocateEnd?: () => void } = {}) {
  api.activityPage.mockResolvedValue({ items: over.items ?? [holding('first', ['first']), holding('second', ['second', 'wanted'])], hasMore: false, nextCursor: null, totalGroups: 2, totalMatches: 2, snapshot: {} })
  api.activityMembers.mockResolvedValue({ items: [], hasMore: false, nextCursor: null, sourceCount: 0, matchedCount: 0, snapshot: {} })
  api.query.mockResolvedValue([])
  ;(window as any).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: { onNewBatch: () => () => {}, ...api },
    content: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), read: vi.fn() }
  }
  return render(<ActivityResults request={(over.request ?? { parsed: eventQuery('wanted') }) as any} locateEventId={over.locateEventId ?? 'wanted'} onLocateEnd={over.onLocateEnd} />)
}

it('opens the activity that holds the located event, not the first one listed', async () => {
  mountLocating()
  const rows = await screen.findAllByTestId('activity-row')
  expect(await screen.findByTestId('activity-summary')).toBeTruthy()
  expect(rows.map((r) => r.getAttribute('aria-expanded'))).toEqual(['false', 'true'])
})

it('opens nothing for a request that does not name the located event', async () => {
  mountLocating({ request: { parsed: { text: '', conditions: [], tokens: [] } } })
  await screen.findAllByTestId('activity-row')
  expect(screen.queryByTestId('activity-summary')).toBeNull()
})

it('says the located record was left when its row is collapsed, once, and not while the Reader steps', async () => {
  const onLocateEnd = vi.fn()
  mountLocating({ onLocateEnd })
  const rows = await screen.findAllByTestId('activity-row')
  await screen.findByTestId('activity-summary')
  fireEvent.click(await screen.findByTestId('activity-read'))
  await screen.findByTestId('activity-reader')
  expect(onLocateEnd).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('reader-close'))
  expect(onLocateEnd).not.toHaveBeenCalled()
  fireEvent.click(rows[1])
  expect(onLocateEnd).toHaveBeenCalledTimes(1)
})

// The filter bar's conditions are what an empty list may owe its emptiness to.
const emptyPage = { items: [], hasMore: false, nextCursor: null, totalGroups: 0, totalMatches: 0, snapshot: {} }
function mountEmpty(request: unknown, onClearConditions?: () => void) {
  api.activityPage.mockResolvedValue(emptyPage)
  ;(window as any).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: { onNewBatch: () => () => {}, ...api },
    content: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), read: vi.fn() }
  }
  return render(<ActivityResults request={request as any} onClearConditions={onClearConditions} />)
}
const noText = { text: '', conditions: [], tokens: [] }

it('says the filter bar emptied the list, and clears it from there', async () => {
  const clear = vi.fn()
  mountEmpty({ parsed: noText, filter: { since: 5, before: 9 } }, clear)
  expect(await screen.findByText('activity.noMatchesFiltered')).toBeTruthy()
  expect(screen.queryByText('activity.noMatches')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'filter.clearAll' }))
  expect(clear).toHaveBeenCalledTimes(1)
})

it('says nothing was recorded when nothing narrows an empty list', async () => {
  mountEmpty({ parsed: noText, filter: { hidePersonal: true } }, vi.fn())
  expect(await screen.findByText('activity.empty')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'filter.clearAll' })).toBeNull()
})

it('keeps the plain no-match line for a typed query the filter bar has no part in', async () => {
  mountEmpty({ parsed: { text: 'needle', conditions: [], tokens: [] }, filter: {} }, vi.fn())
  expect(await screen.findByText('activity.noMatches')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'filter.clearAll' })).toBeNull()
})
