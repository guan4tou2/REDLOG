import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { toEventFilter } from '../lib/FilterContext'

type Total = { state: 'pending' } | { state: 'ok'; value: number } | { state: 'failed' }
/** Query summary belongs to the same generation and filter as the event pages. */
export function useTimelineSummary(
  filter: MutableRefObject<ReturnType<typeof toEventFilter>>,
  generation: MutableRefObject<number>
) {
  const [total, setTotal] = useState<Total>({ state: 'pending' })
  const [projectBounds, setProjectBounds] = useState<{ first: number; last: number } | null>(null)
  const value = useRef<Total>(total)
  const recount = useRef(false)
  const sequence = useRef(0)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const requestTotal = useCallback((gen: number): void => {
    const attempt = ++sequence.current
    const current = () => live.current && gen === generation.current && attempt === sequence.current
    recount.current = false
    value.current = { state: 'pending' }
    setTotal(value.current)
    setProjectBounds(null)
    const request = { filter: filter.current, excludeHousekeeping: true }
    Promise.resolve().then(() => window.redlog.events.span(request))
      .then(bounds => { if (current()) setProjectBounds(bounds) })
      .catch(() => { /* the viewport falls back to the loaded page span */ })
    Promise.resolve().then(() => window.redlog.events.count(request))
      .then(count => {
        if (!current()) return
        if (recount.current) { requestTotal(gen); return }
        value.current = { state: 'ok', value: count }
        setTotal(value.current)
      }).catch(() => {
        if (!current()) return
        value.current = { state: 'failed' }
        setTotal(value.current)
      })
  }, [filter, generation])
  const admitCount = useCallback((added: number): void => {
    if (value.current.state === 'pending') recount.current = true
    if (value.current.state !== 'ok') return
    value.current = { state: 'ok', value: value.current.value + added }
    setTotal(value.current)
  }, [])
  return { total, projectBounds, requestTotal, admitCount }
}
