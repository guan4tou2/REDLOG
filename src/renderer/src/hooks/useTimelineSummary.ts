import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { toEventFilter } from '../lib/FilterContext'
import { createLiveTotal, type LiveTotal, type TotalState } from '../lib/liveTotal'

/** Query summary belongs to the same generation and filter as the event pages. */
export function useTimelineSummary(
  filter: MutableRefObject<ReturnType<typeof toEventFilter>>,
  generation: MutableRefObject<number>
) {
  const [total, setTotal] = useState<TotalState>({ state: 'pending' })
  const [projectBounds, setProjectBounds] = useState<{ first: number; last: number } | null>(null)
  // One count cycle per request: rows admitted while it counts are carried by
  // createLiveTotal, which recounts at most once instead of chaining counts.
  const liveTotal = useRef<LiveTotal | null>(null)
  const sequence = useRef(0)
  const live = useRef(true)
  // Not disposed on unmount: StrictMode's remount would keep a disposed
  // counter. `live` stops what it publishes, and a pending recount with it.
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const requestTotal = useCallback((gen: number): void => {
    const attempt = ++sequence.current
    const current = () => live.current && gen === generation.current && attempt === sequence.current
    setProjectBounds(null)
    const request = { filter: filter.current, excludeHousekeeping: true }
    // The span is the filter's, not the count's: a recount does not re-issue it.
    Promise.resolve().then(() => window.redlog.events.span(request))
      .then(bounds => { if (current()) setProjectBounds(bounds) })
      .catch(() => { /* the viewport falls back to the loaded page span */ })
    liveTotal.current?.dispose()
    const counter = createLiveTotal({
      count: () => live.current ? window.redlog.events.count(request) : Promise.reject(new Error('unmounted')),
      publish: t => { if (current()) setTotal(t) }
    })
    liveTotal.current = counter
    counter.request()
  }, [filter, generation])
  const admitCount = useCallback((added: number): void => {
    liveTotal.current?.admitted(added)
  }, [])
  return { total, projectBounds, requestTotal, admitCount }
}
