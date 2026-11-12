import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { RedLogEvent } from '../../../core/db/events'
import type { toEventFilter } from '../lib/FilterContext'

type Page = { items: RedLogEvent[]; hasMore: boolean; nextCursor: string | null }
const FIRST_PAGE = 200
const MAX_PAGE = 2000
/** Owns query generations, paging errors and cursor arbitration. Timeline
 * supplies row admission/selection; neither can accidentally accept an old page. */
export function useTimelinePages(
  filter: MutableRefObject<ReturnType<typeof toEventFilter>>,
  generation: MutableRefObject<number>,
  callbacks: { reset: (generation: number) => void; rows: (events: RedLogEvent[]) => void; ready: (generation: number) => void }
) {
  const handlers = useRef(callbacks)
  handlers.current = callbacks
  const cursorRef = useRef<string | null>(null)
  const [pageCursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setError] = useState<string | null>(null)
  const pending = useRef(false), alive = useRef(true)
  // Each further page of a generation asks for twice the rows of the last, up
  // to MAX_PAGE. At zoom 1 the whole track is on screen, so the left edge is
  // always in view and history pages in until it runs out: 350 round trips of
  // 200 rows for a 70 000-row project, each followed by a render. Growing the
  // page makes that ~40.
  const nextLimit = useRef(FIRST_PAGE)
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++ } }, [generation])

  const acceptPage = useCallback((page: Page, gen: number, from: string | null): boolean => {
    if (!alive.current || generation.current !== gen || cursorRef.current !== from) return false
    if (page.hasMore && (!page.nextCursor || page.nextCursor === from)) throw new Error('Incomplete timeline page')
    handlers.current.rows(page.items)
    cursorRef.current = page.nextCursor
    setCursor(page.nextCursor)
    setHasMore(page.hasMore)
    return true
  }, [generation])

  const loadFirstPage = useCallback((): void => {
    const gen = ++generation.current
    cursorRef.current = null; setCursor(null); setHasMore(false); setError(null)
    pending.current = true; setLoading(true)
    nextLimit.current = FIRST_PAGE
    const request = { ...filter.current, excludeHousekeeping: true, limit: FIRST_PAGE }
    handlers.current.reset(gen)
    Promise.resolve().then(() => window.redlog.events.queryPage(request))
      .then(page => { if (acceptPage(page, gen, null)) handlers.current.ready(gen) })
      .catch(error => { if (alive.current && generation.current === gen) setError(String(error instanceof Error ? error.message : error)) })
      .finally(() => { if (alive.current && generation.current === gen) { pending.current = false; setLoading(false) } })
  }, [filter, generation, acceptPage])
  const filterKey = JSON.stringify(filter.current)
  useEffect(() => { loadFirstPage() }, [filterKey, loadFirstPage])

  const loadMore = useCallback((): void => {
    if (pending.current || !hasMore || !cursorRef.current) return
    const gen = generation.current, from = cursorRef.current
    pending.current = true; setLoading(true); setError(null)
    nextLimit.current = Math.min(MAX_PAGE, nextLimit.current * 2)
    const request = { ...filter.current, excludeHousekeeping: true, limit: nextLimit.current, cursor: from }
    Promise.resolve().then(() => window.redlog.events.queryPage(request))
      .then(page => { acceptPage(page, gen, from) })
      .catch(error => { if (alive.current && generation.current === gen) setError(String(error instanceof Error ? error.message : error)) })
      .finally(() => { if (alive.current && generation.current === gen) { pending.current = false; setLoading(false) } })
  }, [filter, generation, hasMore, acceptPage])
  return { pageCursorRef: cursorRef, pageCursor, hasMore, loading, loadError, loadFirstPage, loadMore, acceptPage }
}
