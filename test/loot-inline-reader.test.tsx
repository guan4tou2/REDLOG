// @vitest-environment jsdom
//
// Triage reads a hit's source where the hit is: an open loot row holds the
// same content reader Activity uses, opened at the line that matched. The
// Timeline stays one button away for the surrounding events.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { LootPanel } from '../src/renderer/src/components/LootPanel'
import { EventContentReader } from '../src/renderer/src/components/EventContentReader'

const shared = { filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false } }
vi.mock('../src/renderer/src/lib/FilterContext', () => ({ useSharedFilter: () => shared, toEventFilter: () => ({}) }))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../src/renderer/src/components/CopyButton', () => ({ CopyButton: () => <button>copy</button> }))

const HIT = 'password: hunter2-secret'
const TEXT = `line one\n${HIT}\nline three`
const loot = (id: string, opts: { causes?: string[]; preview?: string; ts?: number } = {}) => ({
  id, timestamp: opts.ts ?? 2, operatorId: 'op', agentType: 'loot', targetId: '10.0.0.5',
  data: { source: 'cat creds', matches: [{ type: 'password', confidence: 'high', preview: opts.preview ?? HIT }], ...(opts.causes ? { _causes: opts.causes } : {}) }
})

type Bridge = {
  queryPage: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
  find: ReturnType<typeof vi.fn>
  emit: (events: unknown[]) => void
}
let rows: unknown[] = []
function install(over: Partial<Pick<Bridge, 'list' | 'read' | 'find'>> = {}): Bridge {
  const listeners = new Set<(events: unknown[]) => void>()
  const descriptor = (eventId: string) => ({ field: 'stdout', status: 'available', ref: { projectId: 'p1', eventId, field: 'stdout', version: 'v1' }, bytes: TEXT.length, format: 'utf8', capture: 'unknown' })
  const b: Bridge = {
    queryPage: vi.fn(async () => ({ items: rows, hasMore: false, nextCursor: null })),
    list: over.list ?? vi.fn(async ({ eventId }: { eventId: string }) => ({ ok: true, value: [descriptor(eventId)] })),
    read: over.read ?? vi.fn(async ({ offset = 0 }: { offset?: number }) => ({ ok: true, value: { offset, end: TEXT.length, total: TEXT.length, text: new TextDecoder().decode(new TextEncoder().encode(TEXT).subarray(offset)), format: 'utf8', hasMore: false, nextCursor: null } })),
    find: over.find ?? vi.fn(async ({ needle }: { needle: string }) => {
      const at = new TextEncoder().encode(TEXT.slice(0, TEXT.indexOf(needle))).length
      return { ok: true, value: TEXT.includes(needle) ? { match: { offset: at, bytes: needle.length }, searchedThrough: at, total: TEXT.length, hasMore: false, nextCursor: null } : { match: null, searchedThrough: TEXT.length, total: TEXT.length, hasMore: false, nextCursor: null } }
    }),
    emit: (events) => { for (const cb of listeners) cb(events) }
  }
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { queryPage: b.queryPage, onNewBatch: (cb: (events: unknown[]) => void) => { listeners.add(cb); return () => listeners.delete(cb) } },
    content: { list: b.list, read: b.read, find: b.find }
  }
  return b
}
const onOpen = vi.fn()
const rowOf = (of: string | HTMLElement): HTMLElement => (typeof of === 'string' ? screen.getAllByText(of) : [of]).map((el) => el.closest('[role="option"]') as HTMLElement).find(Boolean)!
async function openFirst(preview = HIT): Promise<HTMLElement> {
  render(<LootPanel projectId="p1" onOpenInTimeline={onOpen} />)
  const row = rowOf(await screen.findByText(preview))
  fireEvent.click(row)
  return row
}

beforeEach(() => { rows = [loot('l1', { causes: ['src-1'] })]; onOpen.mockReset() })
afterEach(cleanup)

it('opens the source event of the hit in place, positioned at the matched line', async () => {
  const b = install()
  const row = await openFirst()
  const mark = await waitFor(() => { const m = row.querySelector('pre mark'); expect(m).toBeTruthy(); return m! })
  expect(mark.textContent).toBe(HIT)
  expect(b.list).toHaveBeenCalledWith({ projectId: 'p1', eventId: 'src-1' })
  expect(b.find).toHaveBeenCalledWith(expect.objectContaining({ needle: HIT }))
  // Read from the hit's byte offset, so it is at the top of the reader.
  expect(b.read).toHaveBeenLastCalledWith(expect.objectContaining({ offset: TEXT.indexOf(HIT) }))
  expect(row.querySelector('pre')!.textContent!.startsWith(HIT)).toBe(true)
})

it('shows no more than the Activity reader does for the same event', async () => {
  install()
  const row = await openFirst()
  await waitFor(() => expect(row.querySelector('pre mark')).toBeTruthy())
  const inLoot = row.querySelector('pre')!.textContent
  cleanup()
  install()
  // How ActivityReader mounts it (ReaderSources), then Find for the same line.
  const { container } = render(<EventContentReader active projectId="p1" eventId="src-1" />)
  await waitFor(() => expect(container.querySelector('pre')).toBeTruthy())
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: HIT } })
  fireEvent.click(screen.getByRole('button', { name: 'content.find' }))
  await waitFor(() => expect(container.querySelector('pre mark')).toBeTruthy())
  expect(container.querySelector('pre')!.textContent).toBe(inLoot)
})

it('a line that is not in the saved content opens the start and says so', async () => {
  rows = [loot('l1', { causes: ['src-1'], preview: 'not-in-the-text' })]
  install()
  const row = await openFirst('not-in-the-text')
  await waitFor(() => expect(row.querySelector('pre')?.textContent).toBe(TEXT))
  expect(within(row).getByText('content.notFound')).toBeTruthy()
})

it('says when the saved content is gone, and does not show it as empty', async () => {
  install({ list: vi.fn(async () => ({ ok: true, value: [{ field: 'stdout', status: 'missing', ref: null, bytes: 0, format: 'utf8', capture: 'unknown' }] })) })
  const row = await openFirst()
  await within(row).findByText('content.status.missing')
  expect(within(row).queryByText('content.empty')).toBeNull()
  expect(within(row).queryByText('content.noText')).toBeNull()
})

it('a failed read is an error with Retry, not empty content, and Retry reads again', async () => {
  const list = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 'failed', message: 'boom' })
    .mockResolvedValue({ ok: true, value: [{ field: 'stdout', status: 'available', ref: { projectId: 'p1', eventId: 'src-1', field: 'stdout', version: 'v1' }, bytes: TEXT.length, format: 'utf8', capture: 'unknown' }] })
  install({ list })
  const row = await openFirst()
  const alert = await within(row).findByRole('alert')
  expect(alert.textContent).toContain('content.status.failed')
  expect(within(row).queryByText('content.empty')).toBeNull()
  expect(within(row).queryByText('content.noText')).toBeNull()
  fireEvent.click(within(alert).getByRole('button', { name: 'common.retry' }))
  await waitFor(() => expect(row.querySelector('pre mark')?.textContent).toBe(HIT))
  expect(list).toHaveBeenCalledTimes(2)
})

it('binary content is named as binary and not searched', async () => {
  const b = install({ list: vi.fn(async () => ({ ok: true, value: [{ field: 'stdout', status: 'available', ref: { projectId: 'p1', eventId: 'src-1', field: 'stdout', version: 'v1' }, bytes: 4, format: 'binary', capture: 'unknown' }] })) })
  const row = await openFirst()
  await within(row).findByText('content.binary')
  await waitFor(() => expect(b.read).toHaveBeenCalled())
  expect(b.find).not.toHaveBeenCalled()
})

it('a hit with no recorded source says so instead of opening a reader', async () => {
  rows = [loot('l1')]
  const b = install()
  const row = await openFirst()
  expect(within(row).getByTestId('loot-no-source').textContent).toBe('content.status.not-captured')
  expect(b.list).not.toHaveBeenCalled()
})

it('a live refresh keeps the open reader — same node, no new read', async () => {
  const b = install()
  const row = await openFirst()
  await waitFor(() => expect(row.querySelector('pre mark')).toBeTruthy())
  const pre = row.querySelector('pre')
  const calls = [b.list.mock.calls.length, b.read.mock.calls.length, b.find.mock.calls.length]
  rows = [loot('l2', { causes: ['src-2'], preview: 'token: newer', ts: 3 }), loot('l1', { causes: ['src-1'] })]
  act(() => { b.emit([{ id: 'l2', agentType: 'loot', data: {} }]) })
  await screen.findByText('token: newer', {}, { timeout: 3000 })
  expect(rowOf(HIT).querySelector('pre')).toBe(pre)
  expect(rowOf(HIT).getAttribute('aria-expanded')).toBe('true')
  expect([b.list.mock.calls.length, b.read.mock.calls.length, b.find.mock.calls.length]).toEqual(calls)
})

it('keys inside the reader are the reader\'s; Escape closes one layer at a time', async () => {
  rows = [loot('l1', { causes: ['src-1'] }), loot('l2', { causes: ['src-2'], preview: 'token: other', ts: 1 })]
  install()
  const row = await openFirst()
  await waitFor(() => expect(row.querySelector('pre mark')).toBeTruthy())
  const selected = (): string[] => screen.getAllByRole('option').map((o) => o.getAttribute('aria-selected') ?? '')
  const before = selected()
  const search = within(row).getByRole('searchbox')
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  fireEvent.keyDown(search, { key: 'End' })
  fireEvent.keyDown(search, { key: 'Enter' })
  expect(selected()).toEqual(before)
  expect(row.getAttribute('aria-expanded')).toBe('true')
  // Expanded reader first: Escape closes it, and the row stays open.
  fireEvent.click(within(row).getByRole('button', { name: 'content.expandReader' }))
  const dialog = within(row).getByRole('dialog')
  fireEvent.keyDown(within(dialog).getByRole('searchbox'), { key: 'Escape' })
  expect(within(row).queryByRole('dialog')).toBeNull()
  expect(row.getAttribute('aria-expanded')).toBe('true')
  // Then the row closes, and focus is back on it.
  fireEvent.keyDown(within(row).getByRole('searchbox'), { key: 'Escape' })
  expect(row.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(row)
  // The list's own keys still work from the row.
  fireEvent.keyDown(row, { key: 'ArrowDown' })
  expect(selected()).not.toEqual(before)
})

it('Open in Timeline is still there, for the surrounding events', async () => {
  install()
  await openFirst()
  fireEvent.click(screen.getByTestId('loot-locate'))
  expect(onOpen).toHaveBeenCalledWith('l1', 2)
})

it('a live refresh does not shrink the loaded window under an open row past the first page', async () => {
  const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
  vi.stubGlobal('IntersectionObserver', class { constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) { observers.push(cb) } observe(): void {} disconnect(): void {} })
  rows = Array.from({ length: 260 }, (_, i) => loot(`l${i}`, { causes: [`s${i}`], preview: `hit number ${i}`, ts: 1000 - i }))
  const b = install()
  render(<LootPanel projectId="p1" />)
  await screen.findByText('hit number 0')
  act(() => { observers.at(-1)!([{ isIntersecting: true }]) })
  fireEvent.click(rowOf(await screen.findByText('hit number 250')))
  expect(rowOf('hit number 250').getAttribute('aria-expanded')).toBe('true')
  rows = [loot('fresh', { causes: ['sf'], preview: 'fresh hit', ts: 2000 }), ...rows]
  act(() => { b.emit([{ id: 'fresh', agentType: 'loot', data: {} }]) })
  await screen.findByText('fresh hit', {}, { timeout: 3000 })
  // Let the effects that follow the new rows settle before looking.
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  expect(screen.getAllByRole('option').length).toBeGreaterThan(200)
  expect(screen.queryAllByText('hit number 250').length).toBeGreaterThan(0)
  expect(rowOf('hit number 250').getAttribute('aria-expanded')).toBe('true')
  vi.unstubAllGlobals()
})
