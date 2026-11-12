// @vitest-environment jsdom
import { useRef } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTimelineLive } from '../src/renderer/src/hooks/useTimelineLive'
const deferred = () => { let resolve!: (v: string[]) => void, reject!: (e: Error) => void; const promise = new Promise<string[]>((r, j) => { resolve = r; reject = j }); return { resolve, reject, promise } }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('keeps the newest live revision and ignores obsolete filter responses or failures', async () => {
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const old = deferred(), recent = deferred(), stale = deferred()
  const query = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise).mockReturnValueOnce(stale.promise)
  ;(window as any).redlog = { events: { onNewBatch: () => () => {}, matchIds: query } }
  const actions = { publish: vi.fn(), count: vi.fn(), failed: vi.fn() }
  const h = renderHook(() => {
    const rows = useRef(new Map()), sorted = useRef([]), filter = useRef({}), generation = useRef(1)
    return { admit: useTimelineLive(filter, generation, rows, sorted, actions).admit, rows, generation }
  })
  const first = h.result.current.admit.current([{ id: 'a', timestamp: 1, data: { output: 'old' } } as any])
  const last = h.result.current.admit.current([{ id: 'a', timestamp: 1, data: { output: 'new' } } as any])
  await act(async () => { recent.resolve(['a']); await last })
  await act(async () => { old.resolve(['a']); await first })
  expect(h.result.current.rows.current.get('a').data.output).toBe('new')
  expect(actions.count).toHaveBeenCalledExactlyOnceWith(1)
  const changed = h.result.current.admit.current([{ id: 'b', timestamp: 1 } as any]).catch(() => {})
  h.result.current.generation.current++
  actions.failed.mockClear()
  await act(async () => { stale.reject(new Error('old filter')); await changed })
  expect(actions.failed).not.toHaveBeenCalled()
  expect(h.result.current.rows.current.has('b')).toBe(false)
  const failedOlder = deferred(), succeededNewer = deferred()
  query.mockReturnValueOnce(failedOlder.promise).mockReturnValueOnce(succeededNewer.promise)
  const failed = h.result.current.admit.current([{ id: 'c', timestamp: 1 } as any]).catch(() => {})
  const succeeded = h.result.current.admit.current([{ id: 'c', timestamp: 1 } as any])
  await act(async () => { succeededNewer.resolve(['c']); await succeeded })
  actions.failed.mockClear()
  await act(async () => { failedOlder.reject(new Error('obsolete live read')); await failed })
  expect(actions.failed).not.toHaveBeenCalled()

})

it.each([1, 70_000])('publishes an admission as one commit for %s existing rows, and holds the next one back by the last cost', async size => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const listeners: Array<(events: any[]) => void> = []
  const matchIds = vi.fn(async ({ ids }: any) => ids)
  ;(window as any).redlog = { events: { onNewBatch: (cb: any) => { listeners.push(cb); return () => {} }, matchIds } }
  // A publish that takes 40 ms, as a large render would; commits are recorded.
  const commits: string[][] = []
  let open: string[] | null = null
  const actions = {
    publish: vi.fn((rows: any[]) => { open?.push(`rows:${rows.length}`); vi.advanceTimersByTime(40) }),
    count: vi.fn((n: number) => { open?.push(`count:${n}`) }),
    failed: vi.fn(),
    commit: (updates: () => void) => { open = []; updates(); commits.push(open); open = null }
  }
  const h = renderHook(() => {
    const initial = Array.from({ length: size }, (_, i) => ({ id: `old-${i}`, timestamp: i } as any))
    return useTimelineLive(useRef({}), useRef(1), useRef(new Map(initial.map(e => [e.id, e]))), useRef(initial), actions)
  })
  void h
  act(() => { listeners[0]([{ id: 'a', timestamp: size + 1 }]); listeners[0]([{ id: 'b', timestamp: size + 2 }]) })
  await act(async () => { vi.advanceTimersByTime(100) })
  // Two batches, one admission, the total and every stored row in one commit.
  expect(matchIds).toHaveBeenCalledOnce()
  expect(commits).toEqual([['count:2', `rows:${size + 2}`]])
  // That publish took 40 ms, so the next admission waits 120 ms, not 100: the
  // panel renders at most a quarter of the time, whatever the row count.
  act(() => listeners[0]([{ id: 'c', timestamp: size + 3 }]))
  await act(async () => { vi.advanceTimersByTime(100) })
  expect(matchIds).toHaveBeenCalledOnce()
  await act(async () => { vi.advanceTimersByTime(20) })
  expect(matchIds).toHaveBeenCalledTimes(2)
  expect(commits).toEqual([['count:2', `rows:${size + 2}`], ['count:1', `rows:${size + 3}`]])
})

it('admits the batches of one window with one query, in arrival order', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const listeners: Array<(events: any[]) => void> = []
  const matchIds = vi.fn(async ({ ids }: any) => ids)
  ;(window as any).redlog = { events: { onNewBatch: (cb: any) => { listeners.push(cb); return () => {} }, matchIds } }
  const actions = { publish: vi.fn(), count: vi.fn(), failed: vi.fn() }
  const sorted = { current: [] as any[] }
  renderHook(() => useTimelineLive(useRef({}), useRef(1), useRef(new Map()), sorted, actions))
  // Fifty one-event batches, as main sends them under a burst.
  for (let i = 0; i < 50; i++) act(() => listeners[0]([{ id: `e${i}`, timestamp: i }]))
  expect(matchIds).not.toHaveBeenCalled()
  await act(async () => { vi.advanceTimersByTime(100) })
  expect(matchIds).toHaveBeenCalledOnce()
  expect(matchIds.mock.calls[0][0].ids).toEqual(Array.from({ length: 50 }, (_, i) => `e${i}`))
  expect(actions.count).toHaveBeenCalledExactlyOnceWith(50)
  expect(actions.publish).toHaveBeenCalledOnce()
  expect(sorted.current.map(e => e.id)).toEqual(Array.from({ length: 50 }, (_, i) => `e${i}`))
})

it('publishes paged rows through the same pacer, and at once when asked to', async () => {
  vi.useFakeTimers()
  let paint: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { paint = callback; return 1 }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn(() => { paint = undefined }))
  ;(window as any).redlog = { events: { onNewBatch: () => () => {}, matchIds: vi.fn(async ({ ids }: any) => ids) } }
  const actions = { publish: vi.fn(), count: vi.fn(), failed: vi.fn() }
  const sorted = { current: [] as any[] }
  const h = renderHook(() => useTimelineLive(useRef({}), useRef(1), useRef(new Map()), sorted, actions))
  sorted.current.push({ id: 'paged', timestamp: 1 })
  act(() => { h.result.current.schedule(); h.result.current.schedule() })
  expect(actions.publish).not.toHaveBeenCalled()
  act(() => h.result.current.flush())
  expect(actions.publish).toHaveBeenCalledOnce()
  expect(actions.publish.mock.calls[0][0]).toEqual([{ id: 'paged', timestamp: 1 }])
  // The frame that was pending is gone: flushing does not publish twice.
  expect(paint).toBeUndefined()
})
