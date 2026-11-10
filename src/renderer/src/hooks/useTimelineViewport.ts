import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { TimeMap } from '../lib/timelineTimeMap'

export function useTimelineZoom(minimum: number) {
  const [zoom, setZoom] = useState(() => {
    try {
      const value = Number.parseFloat(localStorage.getItem('redlog-timeline-zoom') ?? '')
      return Number.isFinite(value) && value >= minimum && value <= 6 ? value : 1
    } catch { return 1 }
  })
  useEffect(() => { try { localStorage.setItem('redlog-timeline-zoom', String(zoom)) } catch { /* unavailable storage */ } }, [zoom])
  return [zoom, setZoom] as const
}

/** DOM measurement and deferred zoom/centre placement share CSS coordinates.
 * The view binds afterLayout after its own initial focus placement. */
export function useTimelineViewport(scrollRef: RefObject<HTMLDivElement | null>, geometry: {
  width: number; start: number; end: number; map: TimeMap
}, history: { hasMore: boolean; loading: boolean; loadMore: () => void }, follow: { enabled: boolean; revision: unknown }) {
  const [view, setView] = useState({ left: 0, width: 100 })
  const [atRightEdge, setAtRightEdge] = useState(true)
  const pendingView = useRef<{ t0: number } | { frac: number } | null>(null)
  const pendingCenterTs = useRef<number | null>(null)
  const pendingZoomAnchor = useRef<{ frac: number; cursorX: number } | null>(null)
  const updateView = useCallback(() => {
    const el = scrollRef.current
    if (!el || geometry.width <= 0) return
    setView({ left: el.scrollLeft / geometry.width * 100, width: Math.min(100, el.clientWidth / geometry.width * 100) })
    setAtRightEdge(el.scrollLeft + el.clientWidth >= geometry.width - 10)
    if (history.hasMore && !history.loading && el.scrollLeft < 80) history.loadMore()
  }, [scrollRef, geometry.width, history.hasMore, history.loading, history.loadMore])
  useEffect(() => {
    if (!follow.enabled || !atRightEdge || !scrollRef.current || geometry.width <= 0) return
    scrollRef.current.scrollLeft = Math.max(0, geometry.width - scrollRef.current.clientWidth)
  }, [follow.enabled, follow.revision, atRightEdge, scrollRef, geometry.width])
  const afterLayout = useCallback(() => {
    const el = scrollRef.current
    if (el && pendingZoomAnchor.current) {
      const anchor = pendingZoomAnchor.current; pendingZoomAnchor.current = null
      el.scrollLeft = anchor.frac * geometry.width - anchor.cursorX
    }
    if (el && pendingView.current) {
      const point = pendingView.current; pendingView.current = null
      const x = 'frac' in point ? point.frac * geometry.width : (point.t0 - geometry.start) / ((geometry.end - geometry.start) || 1) * geometry.width
      el.scrollLeft = Math.max(0, Math.min(x, geometry.width - el.clientWidth))
    }
    if (el && pendingCenterTs.current !== null) {
      const timestamp = pendingCenterTs.current; pendingCenterTs.current = null
      el.scrollLeft = Math.max(0, Math.min(geometry.map.toX(timestamp) - el.clientWidth / 2, geometry.width - el.clientWidth))
    }
    updateView()
  }, [scrollRef, geometry.width, geometry.start, geometry.end, geometry.map, updateView])
  return { view, atRightEdge, updateView, afterLayout, pendingView, pendingCenterTs, pendingZoomAnchor }
}
