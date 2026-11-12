// @vitest-environment jsdom
//
// The one hook behind HTTP History, Loot, Screenshots and a target's evidence:
// a paged list that stays current while events arrive. The views pin what the
// operator sees; this pins the mechanism they share.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLivePagedQuery, type LivePage, type LivePagedQueryOptions, type LiveReadSignal } from '../src/renderer/src/hooks/useLivePagedQuery'

interface Row { id: string; v?: number }
type Fetch = (cursor: string | undefined, signal: LiveReadSignal) => Promise<LivePage<Row>>

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }))
const ids = (list: Row[]): string[] => list.map((r) => r.id)

let listeners: Set<(events: RedLogEvent[]) => void>
function emit(events: Partial<RedLogEvent>[]): void {
  for (const cb of listeners) cb(events as RedLogEvent[])
}

beforeEach(() => {
  vi.useFakeTimers()
  listeners = new Set()
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { onNewBatch: (cb: (events: RedLogEvent[]) => void) => { listeners.add(cb); return () => listeners.delete(cb) } }
  }
})
afterEach(() => { vi.useRealTimers() })

const settle = (ms = 0): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

function mount(opts: Partial<LivePagedQueryOptions<Row>> & { fetch: Fetch }) {
  return renderHook((p: Partial<LivePagedQueryOptions<Row>>) => useLivePagedQuery<Row>({ key: 'k', rowKey: (r) => r.id, ...opts, ...p }), { initialProps: {} })
}

describe('reset', () => {
  it('a key change drops the previous key\'s reply, however late it lands', async () => {
    const a = deferred<LivePage<Row>>()
    const b = deferred<LivePage<Row>>()
    const fetch = vi.fn<Fetch>().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const h = mount({ fetch })
    h.rerender({ key: 'k2' })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    await act(async () => { b.resolve({ rows: rows('new') }) })
    await act(async () => { a.resolve({ rows: rows('old') }) })
    expect(ids(h.result.current.rows)).toEqual(['new'])
    expect(h.result.current.state.phase).toBe('loaded')
  })

  it('clears the rows for the new key unless asked to keep them until it answers', async () => {
    const fetch = vi.fn<Fetch>(async () => ({ rows: rows('a') }))
    const h = mount({ fetch })
    await settle()
    fetch.mockReturnValueOnce(new Promise(() => {}))
    h.rerender({ key: 'k2' })
    expect(h.result.current.state).toEqual({ phase: 'loading', value: null })

    const kept = mount({ fetch: vi.fn<Fetch>(async () => ({ rows: rows('a') })), keepRowsOnReset: true })
    await settle()
    kept.rerender({ key: 'k2', fetch: () => new Promise(() => {}) })
    expect(kept.result.current.state).toEqual({ phase: 'loading', value: rows('a') })
  })

  it('no render after a key change shows the previous key\'s rows, not even the one before its read starts', async () => {
    const seen: Array<{ key: string; rows: string[] }> = []
    const fetch = vi.fn<Fetch>(async () => ({ rows: rows('a') }))
    const h = renderHook((p: { key: string }) => {
      const q = useLivePagedQuery<Row>({ key: p.key, fetch })
      seen.push({ key: p.key, rows: ids(q.rows) })
      return q
    }, { initialProps: { key: 'k' } })
    await settle()
    fetch.mockReturnValueOnce(new Promise(() => {}))
    h.rerender({ key: 'k2' })
    expect(seen.filter((s) => s.key === 'k2').every((s) => s.rows.length === 0)).toBe(true)
  })

  it('a failed first load is failed, with no rows', async () => {
    const h = mount({ fetch: vi.fn<Fetch>(async () => { throw new Error('db down') }) })
    await settle()
    expect(h.result.current.state).toEqual({ phase: 'failed', value: null, error: 'db down' })
    expect(h.result.current.rows).toEqual([])
  })

  it('a disabled query asks nothing and is an empty, loaded list', async () => {
    const fetch = vi.fn<Fetch>()
    const h = mount({ fetch, enabled: false })
    await settle()
    expect(fetch).not.toHaveBeenCalled()
    expect(h.result.current.state).toEqual({ phase: 'loaded', value: [] })
  })
})

describe('append', () => {
  it('adds the next page through the cursor, and passes hasMore, total and truncated through', async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce({ rows: rows('a', 'b'), nextCursor: 'c1', total: 4, truncated: true })
      .mockResolvedValueOnce({ rows: rows('b', 'c'), nextCursor: null, truncated: false })
    const h = mount({ fetch })
    await settle()
    expect(h.result.current.hasMore).toBe(true)
    expect(h.result.current.total).toBe(4)
    expect(h.result.current.truncated).toBe(true)
    act(() => h.result.current.loadMore())
    expect(h.result.current.loadingMore).toBe(true)
    await settle()
    expect(fetch).toHaveBeenLastCalledWith('c1', expect.anything())
    expect(ids(h.result.current.rows)).toEqual(['a', 'b', 'c'])
    expect(h.result.current.hasMore).toBe(false)
    expect(h.result.current.total).toBe(4)
    expect(h.result.current.truncated).toBe(false)
    expect(h.result.current.loadingMore).toBe(false)
  })

  it('a failed append keeps the loaded rows and cursor; retry asks for the same page', async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce({ rows: rows('a'), nextCursor: 'c1' })
      .mockRejectedValueOnce(new Error('older unavailable'))
      .mockResolvedValueOnce({ rows: rows('b') })
    const h = mount({ fetch })
    await settle()
    act(() => h.result.current.loadMore())
    await settle()
    expect(h.result.current.moreFailed).toEqual({ error: 'older unavailable' })
    expect(h.result.current.state.phase).toBe('loaded')
    expect(ids(h.result.current.rows)).toEqual(['a'])
    act(() => h.result.current.retry())
    await settle()
    expect(fetch).toHaveBeenLastCalledWith('c1', expect.anything())
    expect(ids(h.result.current.rows)).toEqual(['a', 'b'])
    expect(h.result.current.moreFailed).toBeNull()
  })
})

describe('refresh', () => {
  it("'pages' re-reads exactly the pages loaded and keeps their count", async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce({ rows: rows('a', 'b'), nextCursor: 'c1' })
      .mockResolvedValueOnce({ rows: rows('c', 'd'), nextCursor: 'c2' })
    const h = mount({ fetch })
    await settle()
    act(() => h.result.current.loadMore())
    await settle()
    fetch.mockClear()
    fetch
      .mockResolvedValueOnce({ rows: rows('n', 'a'), nextCursor: 'c1b' })
      .mockResolvedValueOnce({ rows: rows('b', 'c'), nextCursor: 'c2b' })
    act(() => h.result.current.refresh())
    await settle()
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([undefined, 'c1b'])
    expect(ids(h.result.current.rows)).toEqual(['n', 'a', 'b', 'c'])
    expect(h.result.current.hasMore).toBe(true)
    // The next append continues from where the re-read pages end.
    fetch.mockResolvedValueOnce({ rows: rows('d') })
    act(() => h.result.current.loadMore())
    await settle()
    expect(fetch).toHaveBeenLastCalledWith('c2b', expect.anything())
  })

  it("'head' merges page one into what is loaded and keeps the cursor", async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce({ rows: [{ id: 'a', v: 1 }, { id: 'b' }], nextCursor: 'c1' })
      .mockResolvedValueOnce({ rows: [{ id: 'n' }, { id: 'a', v: 2 }], nextCursor: 'other' })
    const h = mount({ fetch, refresh: 'head' })
    await settle()
    act(() => h.result.current.refresh())
    await settle()
    expect(h.result.current.rows).toEqual([{ id: 'a', v: 2 }, { id: 'b' }, { id: 'n' }])
    fetch.mockResolvedValueOnce({ rows: rows('z') })
    act(() => h.result.current.loadMore())
    await settle()
    expect(fetch).toHaveBeenLastCalledWith('c1', expect.anything())
  })

  it("'head' reads from the top again when page one shares nothing with the loaded rows", async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce({ rows: rows('a', 'b') })
      .mockResolvedValueOnce({ rows: rows('x', 'y'), nextCursor: 'more' })
      .mockResolvedValueOnce({ rows: rows('x', 'y', 'a', 'b') })
    const h = mount({ fetch, refresh: 'head' })
    await settle()
    act(() => h.result.current.refresh())
    await settle()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(ids(h.result.current.rows)).toEqual(['x', 'y', 'a', 'b'])
  })

  it('a failed refresh keeps the rows and says it failed; retry recovers', async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce({ rows: rows('a', 'b') })
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce({ rows: rows('c', 'a', 'b') })
    const h = mount({ fetch })
    await settle()
    act(() => h.result.current.refresh())
    await settle()
    expect(h.result.current.state).toEqual({ phase: 'failed', value: rows('a', 'b'), error: 'busy' })
    act(() => h.result.current.retry())
    expect(h.result.current.state.phase).toBe('loading')
    await settle()
    expect(h.result.current.state).toEqual({ phase: 'loaded', value: rows('c', 'a', 'b') })
  })

  it('a slower, older reply never overwrites a newer one', async () => {
    // A tiny server: each read answers with the value at the moment it was asked.
    let serverValue = 1
    const pending: Array<() => void> = []
    let inFlight = 0, maxInFlight = 0
    const fetch = vi.fn<Fetch>(() => {
      const answer = { rows: [{ id: 'a', v: serverValue }] }
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve) => pending.push(() => { inFlight--; resolve(answer) }))
    })
    const h = mount({ fetch, live: { affects: () => true, intervalMs: 100 } })
    await settle()
    pending.shift()!()
    await settle()
    // Two refreshes asked while the server changes between them.
    act(() => h.result.current.refresh())
    serverValue = 2
    act(() => h.result.current.refresh())
    await settle(500)
    // Answer the newest first, then the older: "the slower reply lands last".
    while (pending.length) { pending.pop()!(); await settle(500) }
    expect(h.result.current.rows).toEqual([{ id: 'a', v: 2 }])
    expect(maxInFlight).toBe(1)
  })
})

describe('live batches', () => {
  it('a burst of matching batches is one paced refresh; a batch that does not concern the list is none', async () => {
    const fetch = vi.fn<Fetch>(async () => ({ rows: rows('a') }))
    mount({ fetch, live: { affects: (events) => events.some((e) => e.agentType === 'loot'), intervalMs: 1000 } })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    act(() => emit([{ agentType: 'shell' }]))
    await settle(2000)
    expect(fetch).toHaveBeenCalledTimes(1)

    act(() => emit([{ agentType: 'loot' }]))
    await settle(10)
    expect(fetch).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 10; i++) act(() => emit([{ agentType: 'loot' }]))
    await settle(500)
    expect(fetch).toHaveBeenCalledTimes(2)
    await settle(600)
    expect(fetch).toHaveBeenCalledTimes(3)
    await settle(5000)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('local changes and teardown', () => {
  it('update edits the loaded rows without a read and without changing the phase', async () => {
    const fetch = vi.fn<Fetch>(async () => ({ rows: rows('a') }))
    const h = mount({ fetch })
    await settle()
    act(() => h.result.current.update((prev) => [{ id: 'live' }, ...prev]))
    expect(ids(h.result.current.rows)).toEqual(['live', 'a'])
    expect(h.result.current.state.phase).toBe('loaded')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('unmount cancels: the read is told, its reply is not applied, and batches stop', async () => {
    const d = deferred<LivePage<Row>>()
    let signal: LiveReadSignal | undefined
    const fetch = vi.fn<Fetch>((_c, s) => { signal = s; return d.promise })
    const h = mount({ fetch, live: { affects: () => true, intervalMs: 0 } })
    const seen = h.result.current
    h.unmount()
    expect(signal?.cancelled).toBe(true)
    expect(listeners.size).toBe(0)
    await act(async () => { d.resolve({ rows: rows('late') }) })
    expect(h.result.current).toBe(seen)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
