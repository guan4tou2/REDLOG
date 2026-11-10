import { useEffect, useRef, type MutableRefObject } from 'react'
import type { RedLogEvent, EventFilter } from '../../../core/db/events'
import { binarySearchInsert } from '../lib/timelineDomain'

/** Persistence admits live events against the same predicates as paging. Each
 * response is tied to the filter generation and latest version of its event. */
export function useTimelineLive(filter: MutableRefObject<EventFilter>, generation: MutableRefObject<number>,
  rows: MutableRefObject<Map<string, RedLogEvent>>, sorted: MutableRefObject<RedLogEvent[]>,
  actions: { publish: (rows: RedLogEvent[]) => void; count: (added: number) => void; failed: (batch: RedLogEvent[] | null) => void }) {
  const current = useRef(actions); current.current = actions
  const admit = useRef<(batch: RedLogEvent[]) => Promise<void>>(async () => {})
  useEffect(() => {
    let alive = true, scheduled = false
    let timer: ReturnType<typeof setTimeout> | undefined, frame: number | undefined, revision = 0
    const latest = new Map<string, number>()
    const flush = () => { scheduled = false; if (alive) current.current.publish([...sorted.current]) }
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      if (sorted.current.length > 5000) timer = setTimeout(flush, 250)
      else frame = requestAnimationFrame(flush)
    }
    admit.current = async batch => {
      const gen = generation.current, predicates = filter.current, version = ++revision
      for (const row of batch) latest.set(row.id, version)
      const admitted = new Set<string>()
      try {
        for (let i = 0; i < batch.length; i += 100) {
          const hits = await window.redlog.events.matchIds({ ids: batch.slice(i, i + 100).map(row => row.id), filter: predicates, excludeHousekeeping: true })
          if (!alive || gen !== generation.current) return
          for (const id of hits) admitted.add(id)
        }
        let added = 0, changed = false
        for (const row of batch) {
          if (!admitted.has(row.id) || latest.get(row.id) !== version) continue
          const previous = rows.current.get(row.id)
          if (!previous) added++
          else {
            const index = sorted.current.findIndex(event => event.id === row.id)
            if (index >= 0) sorted.current.splice(index, 1)
          }
          binarySearchInsert(sorted.current, row)
          rows.current.set(row.id, row)
          changed = true
        }
        current.current.failed(null)
        if (added) current.current.count(added)
        if (changed) schedule()
      } catch (error) {
        if (alive && gen === generation.current) current.current.failed(batch)
        throw error
      } finally {
        for (const row of batch) if (latest.get(row.id) === version) latest.delete(row.id)
      }
    }
    const unsubscribe = window.redlog.events.onNewBatch(batch => { if (batch.length) void admit.current(batch).catch(() => {}) })
    return () => {
      alive = false; unsubscribe(); latest.clear()
      if (timer !== undefined) clearTimeout(timer)
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [filter, generation, rows, sorted])
  return admit
}
