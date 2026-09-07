import { useState, useEffect, useRef, useMemo, useCallback } from 'react'

// Shared infinite-scroll for the row lists (loot, bookmarks, cast hits, HTTP).
// UIUX-STANDARD §9 "全部清單改無限捲動 …「已載入 N／共 M」": render a page at a
// time and grow as a sentinel near the bottom scrolls into view, so a project
// with tens of thousands of rows doesn't mount them all at once. Kept as one
// hook so the four lists can't drift apart (they had, and only HttpHistoryPanel
// ever got the treatment).
//
// The Timeline is deliberately NOT a consumer: it pages its DB fetch
// (`beforeCreatedAt`, 200 at a time) and is a spatial lane view, not a row list.

export const LIST_PAGE_SIZE = 200

/** Next visible-count after one page grows, never past the total. Pure. */
export function nextVisibleCount(current: number, total: number, pageSize = LIST_PAGE_SIZE): number {
  return Math.min(current + pageSize, total)
}

export interface InfiniteScroll<T> {
  /** The rows to actually render this frame (items.slice(0, visibleCount)). */
  visible: T[]
  /** How many are shown — clamped to the total. */
  shown: number
  /** The full length behind the window. */
  total: number
  /** More rows remain past the window. */
  hasMore: boolean
  /** Attach to a node at the end of the list; scrolling it into view loads more. */
  sentinelRef: (node: Element | null) => void
  /** Grow one page now (keyboard/paging affordance, tests). */
  showMore: () => void
}

/**
 * Window `items` into pages of `pageSize`. Resets to the first page whenever the
 * list identity changes (a new filter, a reload), so a filtered-down list never
 * shows a stale tall window.
 */
export function useInfiniteScroll<T>(items: T[], pageSize = LIST_PAGE_SIZE): InfiniteScroll<T> {
  const [visibleCount, setVisibleCount] = useState(pageSize)
  const total = items.length

  // Reset on list-identity change (new filter / reload).
  useEffect(() => { setVisibleCount(pageSize) }, [items, pageSize])

  const showMore = useCallback(
    () => setVisibleCount((c) => nextVisibleCount(c, items.length, pageSize)),
    [items.length, pageSize]
  )

  // Callback ref so any element type (div, tr, li) can be the sentinel without
  // the consumer juggling a typed ref. Re-observes whenever the node changes.
  const obsRef = useRef<IntersectionObserver | null>(null)
  const sentinelRef = useCallback((node: Element | null) => {
    obsRef.current?.disconnect()
    if (!node) return
    obsRef.current = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) showMore()
    })
    obsRef.current.observe(node)
  }, [showMore])
  useEffect(() => () => obsRef.current?.disconnect(), [])

  const visible = useMemo(() => items.slice(0, visibleCount), [items, visibleCount])
  return { visible, shown: Math.min(visibleCount, total), total, hasMore: visibleCount < total, sentinelRef, showMore }
}
