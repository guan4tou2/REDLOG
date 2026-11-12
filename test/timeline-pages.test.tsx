// @vitest-environment jsdom
import { useRef } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTimelinePages } from '../src/renderer/src/hooks/useTimelinePages'

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const page = (id: string, cursor: string | null = null) => ({ items: [{ id } as any], hasMore: cursor !== null, nextCursor: cursor })
afterEach(cleanup)
function mount(queryPage: ReturnType<typeof vi.fn>) {
  ;(window as any).redlog = { events: { queryPage } }
  const callbacks = { reset: vi.fn(), rows: vi.fn(), ready: vi.fn() }
  const hook = renderHook(({ targetId }) => {
    const filter = useRef({ targetId }); filter.current = { targetId }
    const generation = useRef(0)
    return { ...useTimelinePages(filter, generation, callbacks), generation }
  }, { initialProps: { targetId: 'first' } })
  return { ...hook, callbacks }
}

it('drops responses from the old filter or an unmounted project', async () => {
  const old = deferred<any>(), current = deferred<any>()
  const query = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  const hook = mount(query)
  await waitFor(() => expect(query).toHaveBeenCalledTimes(1))
  hook.rerender({ targetId: 'second' })
  await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
  await act(async () => old.resolve(page('old')))
  expect(hook.callbacks.rows).not.toHaveBeenCalled()
  hook.unmount()
  await act(async () => current.resolve(page('after-unmount')))
  expect(hook.callbacks.rows).not.toHaveBeenCalled()
  expect(query.mock.calls.map(call => call[0].targetId)).toEqual(['first', 'second'])
})

it('does not request the same cursor twice or move backwards after a load-back overtakes it', async () => {
  const slow = deferred<any>()
  const query = vi.fn().mockResolvedValueOnce(page('first', 'c1')).mockReturnValueOnce(slow.promise)
  const hook = mount(query)
  await waitFor(() => expect(hook.result.current.pageCursor).toBe('c1'))
  act(() => { hook.result.current.loadMore(); hook.result.current.loadMore() })
  await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
  act(() => { expect(hook.result.current.acceptPage(page('load-back', 'c3'), hook.result.current.generation.current, 'c1')).toBe(true) })
  await act(async () => slow.resolve(page('obsolete', 'c2')))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  expect(hook.result.current.pageCursor).toBe('c3')
  expect(hook.callbacks.rows.mock.calls.flatMap(call => call[0].map((event: any) => event.id))).toEqual(['first', 'load-back'])
})

it('keeps the loaded page on failure and retries from that same cursor', async () => {
  const query = vi.fn().mockResolvedValueOnce(page('first', 'c1')).mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce(page('second'))
  const hook = mount(query)
  await waitFor(() => expect(hook.result.current.pageCursor).toBe('c1'))
  act(() => hook.result.current.loadMore())
  await waitFor(() => expect(hook.result.current.loadError).toBe('read failed'))
  expect(hook.result.current.pageCursor).toBe('c1')
  act(() => hook.result.current.loadMore())
  await waitFor(() => expect(hook.result.current.hasMore).toBe(false))
  expect(query.mock.calls.slice(1).map(call => call[0].cursor)).toEqual(['c1', 'c1'])
  expect(hook.callbacks.rows.mock.calls.flatMap(call => call[0].map((event: any) => event.id))).toEqual(['first', 'second'])
})

it('grows each further page of a generation, and starts over at 200 with a new filter', async () => {
  let n = 0
  const query = vi.fn(async () => page(`p${n++}`, `c${n}`))
  const hook = mount(query)
  await waitFor(() => expect(hook.result.current.pageCursor).toBe('c1'))
  for (let i = 0; i < 6; i++) {
    act(() => hook.result.current.loadMore())
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
  }
  expect(query.mock.calls.map(call => call[0].limit)).toEqual([200, 400, 800, 1600, 2000, 2000, 2000])
  hook.rerender({ targetId: 'second' })
  await waitFor(() => expect(query).toHaveBeenCalledTimes(8))
  act(() => hook.result.current.loadMore())
  await waitFor(() => expect(query).toHaveBeenCalledTimes(9))
  expect(query.mock.calls.slice(7).map(call => call[0].limit)).toEqual([200, 400])
})
