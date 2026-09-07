import { describe, it, expect } from 'vitest'
import { nextVisibleCount, LIST_PAGE_SIZE } from '../src/renderer/src/lib/useInfiniteScroll'

// The windowing arithmetic behind §9's "無限捲動 …「已載入 N／共 M」". The hook
// itself needs a DOM (IntersectionObserver); this pins the growth rule that
// decides how far the window opens, which is the part that can be wrong.

describe('nextVisibleCount', () => {
  it('grows by one page', () => {
    expect(nextVisibleCount(200, 1000)).toBe(400)
    expect(nextVisibleCount(200, 1000, 50)).toBe(250)
  })
  it('never exceeds the total — the last page is short', () => {
    expect(nextVisibleCount(200, 250)).toBe(250)
    expect(nextVisibleCount(200, 200)).toBe(200)
  })
  it('is idempotent once everything is shown', () => {
    expect(nextVisibleCount(500, 500)).toBe(500)
  })
  it('defaults to the 200-row page size', () => {
    expect(LIST_PAGE_SIZE).toBe(200)
    expect(nextVisibleCount(0, 10_000)).toBe(200)
  })
})
