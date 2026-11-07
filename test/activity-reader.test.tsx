// @vitest-environment jsdom
//
// Spec 069 T019: an expanded operation is a summary and two actions; the
// reading happens in the Reader, which steps between operations and keeps the
// saved-content reader inside it unchanged.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ActivityResults } from '../src/renderer/src/components/ActivityResults'

vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (k: string, v?: Record<string, unknown>) => v ? `${k} ${JSON.stringify(v)}` : k }) }))
vi.mock('../src/renderer/src/components/CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button>{text}</button> }))

const ev = (id: string, over: Record<string, unknown> = {}) => ({
  id, timestamp: 1000, agentType: 'shell', sessionId: `sess-${id}`, targetId: null, hash: `hash-${id}`, prevHash: `prev-${id}`,
  data: { command: id, subtype: 'command_start' }, ...over
})
const summary = (id: string, anchor = ev(id)) => ({
  id, kind: 'command', toolAction: 'unknown', provider: null, firstAt: 1000, anchor, matchedCount: 1, sourceCount: 1, contextCount: 0
})

const api = { activityPage: vi.fn(), activityMembers: vi.fn() }
const onOpen = vi.fn()
function mount(items: ReturnType<typeof summary>[], over: { hasMore?: boolean } = {}): void {
  api.activityPage.mockResolvedValueOnce({ items, hasMore: over.hasMore ?? false, nextCursor: over.hasMore ? 'next' : null, totalGroups: items.length, totalMatches: items.length, snapshot: {} })
  api.activityMembers.mockImplementation(({ ref }: { ref: { id: string } }) => Promise.resolve({
    items: [{ event: items.find((i) => i.id === ref.id)?.anchor ?? ev(ref.id), matched: true }], hasMore: false, nextCursor: null, sourceCount: 1, matchedCount: 1, snapshot: {}
  }))
  ;(window as any).redlog = {
    config: { get: vi.fn().mockResolvedValue({ engagement: { id: 'p' } }) },
    events: { onNewBatch: () => () => {}, ...api },
    content: { list: vi.fn().mockResolvedValue({ ok: true, value: [] }), read: vi.fn() }
  }
  render(<ActivityResults onOpen={onOpen} request={{ parsed: { text: '', conditions: [], tokens: [] } } as any} />)
}
const rows = async (): Promise<HTMLElement[]> => { await screen.findAllByTestId('activity-row'); return screen.getAllByTestId('activity-row') }
const open = async (n = 0): Promise<void> => {
  fireEvent.click((await rows())[n])
  fireEvent.click(await screen.findByTestId('activity-read'))
  await screen.findByTestId('activity-reader')
}

beforeEach(() => { localStorage.clear(); onOpen.mockReset(); Object.values(api).forEach((f) => f.mockReset()) })
afterEach(() => cleanup())

it('expands to a summary with the two actions, and reads nothing until asked', async () => {
  mount([summary('a')])
  fireEvent.click((await rows())[0])
  expect(await screen.findByTestId('activity-summary')).toBeTruthy()
  expect(screen.getByTestId('activity-read')).toBeTruthy()
  expect(screen.getByTestId('activity-locate')).toBeTruthy()
  expect(screen.queryByTestId('activity-reader')).toBeNull()
  expect(api.activityMembers).not.toHaveBeenCalled()
})

it('names the operation and its place among those loaded, and steps between them', async () => {
  mount([summary('a'), summary('b'), summary('c')])
  await open(0)
  expect(screen.getByTestId('reader-headline').textContent).toContain('a')
  expect(screen.getByTestId('reader-counter').textContent).toContain('"index":1')
  expect((screen.getByTestId('reader-prev') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByTestId('reader-next'))
  await waitFor(() => expect(screen.getByTestId('reader-counter').textContent).toContain('"index":2'))
  expect(screen.getByTestId('reader-headline').textContent).toContain('b')
  fireEvent.click(screen.getByTestId('reader-next'))
  await waitFor(() => expect(screen.getByTestId('reader-counter').textContent).toContain('"index":3'))
  expect((screen.getByTestId('reader-next') as HTMLButtonElement).disabled).toBe(true)
})

it('steps with the arrow keys, but leaves the arrows to text being read or typed', async () => {
  mount([summary('a'), summary('b')])
  await open(0)
  const reader = screen.getByTestId('activity-reader')
  fireEvent.keyDown(reader, { key: 'ArrowDown' })
  await waitFor(() => expect(screen.getByTestId('reader-headline').textContent).toContain('b'))
  const field = document.createElement('input')
  reader.appendChild(field)
  fireEvent.keyDown(field, { key: 'ArrowUp' })
  expect(screen.getByTestId('reader-headline').textContent).toContain('b')
  fireEvent.keyDown(reader, { key: 'ArrowUp' })
  await waitFor(() => expect(screen.getByTestId('reader-headline').textContent).toContain('a'))
})

it('closes with Escape and with the close control', async () => {
  mount([summary('a')])
  await open()
  fireEvent.keyDown(screen.getByTestId('activity-reader'), { key: 'Escape' })
  expect(screen.queryByTestId('activity-reader')).toBeNull()
  // The row stays expanded behind it, so the Reader opens again from there.
  fireEvent.click(screen.getByTestId('activity-read'))
  fireEvent.click(await screen.findByTestId('reader-close'))
  expect(screen.queryByTestId('activity-reader')).toBeNull()
})

it('reads on into the next page when stepping past the last loaded operation', async () => {
  mount([summary('a')], { hasMore: true })
  api.activityPage.mockResolvedValueOnce({ items: [summary('b')], hasMore: false, nextCursor: null, totalGroups: 2, totalMatches: 2, snapshot: {} })
  await open()
  fireEvent.click(screen.getByTestId('reader-next'))
  await waitFor(() => expect(screen.getByTestId('reader-headline').textContent).toContain('b'))
})

it('locates the event being read in the Timeline, and keeps the Reader where it was for the way back', async () => {
  mount([summary('a')])
  await open()
  await screen.findAllByTestId('reader-source-tab')
  await waitFor(() => expect((screen.getByTestId('reader-locate') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByTestId('reader-locate'))
  expect(onOpen).toHaveBeenCalledWith('a', 1000)
  expect(screen.getByTestId('activity-reader')).toBeTruthy()
})

it('shows the event as stored: its identifiers, and its hashes without claiming they were checked', async () => {
  mount([summary('a')])
  await open()
  const info = await screen.findByTestId('reader-event-info')
  expect(info.textContent).toContain('sess-a')
  const integrity = screen.getByTestId('reader-integrity') as HTMLDetailsElement
  expect(integrity.open).toBe(false)
  expect(integrity.textContent).toContain('hash-a')
  expect(integrity.textContent).toContain('prev-a')
  expect(integrity.textContent).toContain('activity.reader.integrityNote')
  // A row outside the chain has no hash to show; it says so.
  cleanup()
  mount([summary('b', ev('b', { hash: null, prevHash: null }))])
  await open()
  expect((await screen.findByTestId('reader-integrity')).textContent).toContain('activity.reader.notChained')
})

it('lays the list out as a column header, one separator per day, and a stats line with the way to clear', async () => {
  const day = 86_400_000
  const old = summary('old', ev('old', { timestamp: 1000 }))
  mount([summary('a', ev('a', { timestamp: 5 * day })), { ...summary('b', ev('b', { timestamp: 5 * day + 1000 })), firstAt: 5 * day + 1000 }, { ...old, firstAt: 1000 }].map((i, n) => n === 0 ? { ...i, firstAt: 5 * day } : i) as any)
  await rows()
  expect(screen.getByTestId('activity-stats').textContent).toContain('activity.count')
  expect(screen.getAllByTestId('activity-day')).toHaveLength(2)
  expect(screen.queryByTestId('activity-clear-filter')).toBeNull()
})

it('titles rows and the Reader through the interface language, not the English fallback', async () => {
  const shot = ev('s', { agentType: 'screenshot', data: { subtype: 'screenshot', trigger: 'manual' } })
  mount([summary('s', shot)])
  await open(0)
  // The mocked translator returns keys; the English fallback would have printed "Screenshot".
  expect(screen.getByTestId('reader-headline').textContent).toContain('eventTitle.')
  expect(screen.getAllByTestId('activity-row')[0].textContent).toContain('eventTitle.')
})

it('names the source the way the filter does, not by the stored event type', async () => {
  mount([summary('a')])
  const row = (await rows())[0]
  // The mocked translator returns keys: the lane label key, not the raw event type.
  expect(row.textContent).toContain('timeline.shell')
  fireEvent.click(row)
  fireEvent.click(await screen.findByTestId('activity-read'))
  await screen.findByTestId('activity-reader')
  expect(screen.getByTestId('reader-badge').textContent).toContain('timeline.shell')
  expect(screen.getByTestId('reader-event-info').textContent).toContain('timeline.shell')
})

it('shows what a finished command carries, and nothing for an event without it', async () => {
  const done = ev('d', { data: { command: 'ls', subtype: 'command_end', exit_code: 2, duration_sec: 1.5, pid: 4242, cwd: '/opt/tools' } })
  mount([summary('d', done), summary('e')])
  await open(0)
  const info = screen.getByTestId('reader-event-info').textContent ?? ''
  expect(info).toContain('/opt/tools')
  expect(info).toContain('4242')
  expect(info).toContain('1.5 s')
  fireEvent.click(screen.getByTestId('reader-next'))
  await waitFor(() => expect(screen.getByTestId('reader-headline').textContent).toContain('e'))
  expect(screen.getByTestId('reader-event-info').textContent).not.toContain('activity.reader.field.exit')
})

it('puts the session and pid on the expanded summary, and marks today in the day separator', async () => {
  const now = Date.now()
  mount([summary('p', ev('p', { timestamp: now, data: { command: 'p', subtype: 'command_start', pid: 77 } }))].map((s) => ({ ...s, firstAt: now })))
  fireEvent.click((await rows())[0])
  const meta = await screen.findByTestId('activity-summary-meta')
  expect(meta.textContent).toContain('sess-p')
  expect(meta.textContent).toContain('77')
  expect(screen.getByTestId('activity-day').textContent).toContain('activity.today')
})
