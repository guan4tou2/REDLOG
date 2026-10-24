// @vitest-environment jsdom
//
// A batch arriving while the Transcript is open used to clear the list and
// reload it from the first page: it blanked, the older pages the operator had
// loaded were gone, and so was their place. A live agent session sends batches
// several times a second, so the view could not be read while recording.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../src/renderer/src/lib/FilterContext', () => ({
  useSharedFilter: () => ({
    filter: { targetId: null, agentType: null, timeRange: null, inScopeOnly: false }
  }),
  toEventFilter: () => ({})
}))
vi.mock('../src/renderer/src/i18n/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))
vi.mock('../src/renderer/src/components/Toast', () => ({ toast: vi.fn() }))

type Row = Record<string, unknown>
type Page = { items: Row[]; hasMore: boolean; nextCursor: string | null }

const row = (id: string, ts: number): Row => ({
  id, timestamp: ts, operatorId: 'op', agentType: 'agent', targetId: null,
  data: { subtype: 'assistant_message', agent: 'codex', full: `message ${id}` }
})

const empty: Page = { items: [], hasMore: false, nextCursor: null }

function installBridge(head: () => Page, older: Page = empty): {
  queryPage: ReturnType<typeof vi.fn>
  emit: () => void
} {
  let listener: (() => void) | null = null
  const queryPage = vi.fn().mockImplementation((opts: { agentType: string; cursor?: string }) => {
    if (opts.agentType !== 'agent') return Promise.resolve(empty)
    return Promise.resolve(opts.cursor ? older : head())
  })
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: {
      queryPage,
      runQuery: vi.fn(),
      toolCounterparts: vi.fn().mockResolvedValue([]),
      commandOutput: vi.fn().mockResolvedValue([]),
      onNewBatch: (cb: () => void) => { listener = cb; return () => { listener = null } }
    },
    operators: { list: vi.fn().mockResolvedValue([{ id: 'op', name: 'Operator' }]) },
    clipboard: { writeText: vi.fn().mockResolvedValue(true), readText: vi.fn().mockResolvedValue('') }
  }
  return { queryPage, emit: () => listener?.() }
}

const headCalls = (queryPage: ReturnType<typeof vi.fn>): number =>
  queryPage.mock.calls.filter((c) => c[0].agentType === 'agent' && !c[0].cursor).length

beforeEach(() => { try { localStorage.removeItem('redlog.transcript.order') } catch { /* newest first */ } })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('the Transcript takes new rows without reloading', () => {
  it('adds the new row and keeps the older pages already loaded', async () => {
    let head: Page = { items: [row('b', 20), row('c', 30)], hasMore: true, nextCursor: 'older' }
    const { queryPage, emit } = installBridge(() => head, { items: [row('a', 10)], hasMore: false, nextCursor: null })
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('message c')

    fireEvent.click(screen.getByText('transcript.loadOlder'))
    await screen.findByText('message a')

    head = { items: [row('c', 30), row('d', 40)], hasMore: true, nextCursor: 'older-2' }
    act(() => { emit() })
    // Nothing was cleared while the refresh was in flight.
    expect(screen.queryByText('transcript.loading')).toBeNull()
    expect(screen.getByText('message a')).toBeTruthy()

    await screen.findByText('message d')
    for (const id of ['a', 'b', 'c']) expect(screen.getByText(`message ${id}`)).toBeTruthy()
    // The older page is not fetched again: its rows are kept, not re-read.
    expect(queryPage.mock.calls.filter((c) => c[0].cursor).length).toBe(1)
  })

  it('folds batches that arrive during a refresh into one more refresh', async () => {
    const { queryPage, emit } = installBridge(() => ({ items: [row('a', 10)], hasMore: false, nextCursor: null }))
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('message a')
    const before = headCalls(queryPage)

    act(() => { for (let i = 0; i < 5; i++) emit() })
    await waitFor(() => expect(headCalls(queryPage)).toBe(before + 2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(headCalls(queryPage)).toBe(before + 2)
  })

  it('reloads when more arrived than one page holds, rather than leaving a hole', async () => {
    let head: Page = { items: [row('b', 20)], hasMore: true, nextCursor: 'older' }
    const { emit } = installBridge(() => head, { items: [row('a', 10)], hasMore: false, nextCursor: null })
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('message b')
    fireEvent.click(screen.getByText('transcript.loadOlder'))
    await screen.findByText('message a')

    // No overlap with what is loaded: the rows between b and y were never read.
    head = { items: [row('y', 90)], hasMore: true, nextCursor: 'older-2' }
    act(() => { emit() })
    await screen.findByText('message y')
    // A fresh first page, offered as the recent subset it is.
    expect(screen.queryByText('message b')).toBeNull()
    expect(screen.queryByText('message a')).toBeNull()
    expect(screen.getByText('transcript.loadOlder')).toBeTruthy()
  })
})

describe('an older page and a batch landing together', () => {
  it('keeps both, once each, whichever finishes first', async () => {
    let head: Page = { items: [row('b', 20)], hasMore: true, nextCursor: 'older' }
    let releaseOlder: (page: Page) => void = () => {}
    let listener: (() => void) | null = null
    const queryPage = vi.fn().mockImplementation((opts: { agentType: string; cursor?: string }) => {
      if (opts.agentType !== 'agent') return Promise.resolve(empty)
      if (opts.cursor) return new Promise<Page>((resolve) => { releaseOlder = resolve })
      return Promise.resolve(head)
    })
    ;(window as unknown as { redlog: unknown }).redlog = {
      events: {
        queryPage, runQuery: vi.fn(), toolCounterparts: vi.fn().mockResolvedValue([]),
        commandOutput: vi.fn().mockResolvedValue([]),
        onNewBatch: (cb: () => void) => { listener = cb; return () => { listener = null } }
      },
      operators: { list: vi.fn().mockResolvedValue([]) },
      clipboard: { writeText: vi.fn(), readText: vi.fn() }
    }
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('message b')

    fireEvent.click(screen.getByText('transcript.loadOlder'))
    head = { items: [row('b', 20), row('c', 30)], hasMore: true, nextCursor: 'older' }
    act(() => { listener?.(); listener?.() })
    await screen.findByText('message c')
    await act(async () => { releaseOlder({ items: [row('a', 10)], hasMore: false, nextCursor: null }) })
    await screen.findByText('message a')

    for (const id of ['a', 'b', 'c']) expect(screen.getAllByText(`message ${id}`)).toHaveLength(1)
  })
})

describe('the reader keeps their place', () => {
  // jsdom has no layout: give every block a 100px row, stacked in DOM order.
  const ROW = 100
  let restore: Array<() => void> = []
  beforeEach(() => {
    const define = (name: 'offsetTop' | 'offsetHeight', get: (el: HTMLElement) => number): void => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get() { return get(this as HTMLElement) } })
      restore.push(() => { if (original) Object.defineProperty(HTMLElement.prototype, name, original) })
    }
    define('offsetHeight', (el) => (el.dataset.blockId ? ROW : 0))
    define('offsetTop', (el) => {
      if (!el.dataset.blockId || !el.parentElement) return 0
      return [...el.parentElement.querySelectorAll('[data-block-id]')].indexOf(el) * ROW
    })
  })
  afterEach(() => { for (const undo of restore) undo(); restore = [] })

  it('holds the row being read still when newer rows arrive above it', async () => {
    let head: Page = { items: [row('a', 10), row('b', 20), row('c', 30)], hasMore: false, nextCursor: null }
    const { emit } = installBridge(() => head)
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('message a')

    // Newest first: c, b, a. Read halfway into b.
    const body = screen.getByTestId('transcript-body')
    body.scrollTop = 150
    fireEvent.scroll(body)

    head = { items: [row('a', 10), row('b', 20), row('c', 30), row('d', 40)], hasMore: false, nextCursor: null }
    act(() => { emit() })
    await screen.findByText('message d')
    // d, c, b, a: b moved down one row, and so did the view.
    expect(body.scrollTop).toBe(250)
  })

  it('counts rows that arrived while the reader was away, and goes to them on request', async () => {
    let head: Page = { items: [row('a', 10), row('b', 20), row('c', 30)], hasMore: false, nextCursor: null }
    const { emit } = installBridge(() => head)
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('message a')
    const body = screen.getByTestId('transcript-body')
    body.scrollTop = 150
    fireEvent.scroll(body)
    expect(screen.queryByTestId('transcript-unseen')).toBeNull()

    head = { items: [...head.items, row('d', 40), row('e', 50)], hasMore: false, nextCursor: null }
    act(() => { emit() })
    const button = await screen.findByTestId('transcript-unseen')
    expect(button.textContent).toBe('transcript.unseen')

    fireEvent.click(button)
    expect(body.scrollTop).toBe(0)
    expect(screen.queryByTestId('transcript-unseen')).toBeNull()
  })

  it('stays at the live end when that is where the reader was', async () => {
    let head: Page = { items: [row('a', 10), row('b', 20)], hasMore: false, nextCursor: null }
    const { emit } = installBridge(() => head)
    const { default: TranscriptView } = await import('../src/renderer/src/components/TranscriptView')
    render(<TranscriptView />)
    await screen.findByText('message a')
    const body = screen.getByTestId('transcript-body')
    expect(body.scrollTop).toBe(0)

    head = { items: [row('a', 10), row('b', 20), row('c', 30)], hasMore: false, nextCursor: null }
    act(() => { emit() })
    await screen.findByText('message c')
    expect(body.scrollTop).toBe(0)
  })
})
