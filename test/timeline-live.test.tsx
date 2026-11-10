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
    return { admit: useTimelineLive(filter, generation, rows, sorted, actions), rows, generation }
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

it.each([1, 5001])('coalesces live publishes for %s existing rows and keeps the small-set frame path', async size => {
  vi.useFakeTimers()
  let paint: FrameRequestCallback | undefined
  const raf = vi.fn((callback: FrameRequestCallback) => { paint = callback; return 1 })
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  ;(window as any).redlog = { events: { onNewBatch: () => () => {}, matchIds: vi.fn(async ({ ids }: any) => ids) } }
  const actions = { publish: vi.fn(), count: vi.fn(), failed: vi.fn() }
  const h = renderHook(() => {
    const initial = Array.from({ length: size }, (_, i) => ({ id: `old-${i}`, timestamp: i } as any))
    return useTimelineLive(useRef({}), useRef(1), useRef(new Map(initial.map(e => [e.id, e]))), useRef(initial), actions)
  })
  await act(async () => {
    await h.result.current.current([{ id: 'a', timestamp: size + 1 } as any])
    await h.result.current.current([{ id: 'b', timestamp: size + 2 } as any])
  })
  expect(actions.publish).not.toHaveBeenCalled()
  if (size > 5000) {
    expect(raf).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(249))
    expect(actions.publish).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
  } else {
    expect(raf).toHaveBeenCalledOnce()
    act(() => paint!(0))
  }
  expect(actions.publish).toHaveBeenCalledOnce()
  expect(actions.publish.mock.calls[0][0]).toHaveLength(size + 2)
})
