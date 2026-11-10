// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useTimelineInspector } from '../src/renderer/src/hooks/useTimelineInspector'
import { useTimelineViewport, useTimelineZoom } from '../src/renderer/src/hooks/useTimelineViewport'
import type { RedLogEvent } from '../src/core/db/events'

afterEach(() => { cleanup(); localStorage.clear() })
it('keeps ring selection independent of pane visibility and never transfers Reader state to another event', () => {
  const h = renderHook(useTimelineInspector)
  act(() => { h.result.current.setSelectedEvent({ id: 'a' } as RedLogEvent); h.result.current.setDetailOpen(true) })
  act(() => h.result.current.setReader('expanded'))
  expect(h.result.current.readerMode).toBe('expanded')
  act(() => h.result.current.setSelectedEvent({ id: 'b' } as RedLogEvent))
  expect(h.result.current.readerMode).toBe('closed')
  act(() => h.result.current.setReader('inline'))
  act(() => h.result.current.setDetailOpen(false))
  expect(h.result.current.selectedRef.current?.id).toBe('b')
  act(() => h.result.current.setDetailOpen(true))
  expect(h.result.current.readerMode).toBe('closed')
})
it('places zoom, minimap and compressed-time focus in CSS coordinates, and requests history only at the left edge', () => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 200 })
  const scroll = { current: el }, loadMore = vi.fn()
  const geometry = { width: 1000, start: 100, end: 1100, map: { toX: (ts: number) => ts * 2, fromX: (x: number) => x / 2, gaps: [] } }
  const h = renderHook(() => useTimelineViewport(scroll, geometry, { hasMore: true, loading: false, loadMore }, { enabled: false, revision: 1 }))
  act(() => { h.result.current.pendingZoomAnchor.current = { frac: .5, cursorX: 80 }; h.result.current.afterLayout() })
  expect(el.scrollLeft).toBe(420)
  expect(h.result.current.view).toEqual({ left: 42, width: 20 })
  expect(loadMore).not.toHaveBeenCalled()
  act(() => { h.result.current.pendingView.current = { frac: .95 }; h.result.current.afterLayout() })
  expect(el.scrollLeft).toBe(800)
  expect(h.result.current.atRightEdge).toBe(true)
  act(() => { h.result.current.pendingCenterTs.current = 200; h.result.current.afterLayout() })
  expect(el.scrollLeft).toBe(300)
  act(() => { el.scrollLeft = 20; h.result.current.updateView() })
  expect(loadMore).toHaveBeenCalledOnce()
  expect(h.result.current.atRightEdge).toBe(false)
})
it('restores a valid zoom and persists later changes without retaining invalid values', () => {
  localStorage.setItem('redlog-timeline-zoom', 'NaN')
  const h = renderHook(() => useTimelineZoom(.1))
  expect(h.result.current[0]).toBe(1)
  act(() => h.result.current[1](2))
  expect(localStorage.getItem('redlog-timeline-zoom')).toBe('2')
})
