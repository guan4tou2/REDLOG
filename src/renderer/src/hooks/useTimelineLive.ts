import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RedLogEvent, EventFilter } from '../../../core/db/events'
import { binarySearchInsert } from '../lib/timelineDomain'
import { createPublishPacer, type PublishPacer } from '../lib/timelinePacer'

/** Shortest wait before the batches that have arrived are admitted together. */
const ADMIT_WINDOW_MS = 100

/** Persistence admits live events against the same predicates as paging. Each
 * response is tied to the filter generation and latest version of its event.
 *
 * Main sends a batch per event-loop turn, which under a burst of separate
 * requests is one event each, fifty a second; each was an admission query to
 * main, a total update and a publish, every one a full render of the panel.
 * Batches are now queued and admitted together once the window has passed
 * and the last publish has paid for itself (lib/timelinePacer), and an
 * admission's count and rows land in one render (`commit`). Paged history
 * publishes through the same pacer (`schedule`, `flush`). */
export function useTimelineLive(filter: MutableRefObject<EventFilter>, generation: MutableRefObject<number>,
  rows: MutableRefObject<Map<string, RedLogEvent>>, sorted: MutableRefObject<RedLogEvent[]>,
  actions: {
    publish: (rows: RedLogEvent[]) => void
    count: (added: number) => void
    failed: (batch: RedLogEvent[] | null) => void
    /** Runs a publish's state updates as one render (the panel: flushSync). */
    commit?: (updates: () => void) => void
  }) {
  const current = useRef(actions); current.current = actions
  const admit = useRef<(batch: RedLogEvent[]) => Promise<void>>(async () => {})
  const pacer = useRef<PublishPacer | null>(null)
  useEffect(() => {
    let alive = true, revision = 0, added = 0
    const publisher = createPublishPacer(() => {
      if (!alive) return
      const n = added
      added = 0
      const { commit = (updates: () => void) => updates(), count, publish } = current.current
      commit(() => { if (n) count(n); publish([...sorted.current]) })
    })
    pacer.current = publisher
    const latest = new Map<string, number>()
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
        let changed = false
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
        // The admission waited for the pacer, so it publishes at once.
        if (changed) publisher.flush()
      } catch (error) {
        if (alive && gen === generation.current && batch.some(row => latest.get(row.id) === version)) current.current.failed(batch)
        throw error
      } finally {
        for (const row of batch) if (latest.get(row.id) === version) latest.delete(row.id)
      }
    }
    let queued: RedLogEvent[] = []
    let admitTimer: ReturnType<typeof setTimeout> | undefined
    const drain = (): void => {
      admitTimer = undefined
      const batch = queued
      queued = []
      if (batch.length) void admit.current(batch).catch(() => {})
    }
    const unsubscribe = window.redlog.events.onNewBatch(batch => {
      if (!batch.length) return
      queued = queued.length ? queued.concat(batch) : batch
      admitTimer ??= setTimeout(drain, Math.max(ADMIT_WINDOW_MS, publisher.wait()))
    })
    return () => {
      alive = false; unsubscribe(); latest.clear()
      if (admitTimer !== undefined) clearTimeout(admitTimer)
      publisher.cancel()
      if (pacer.current === publisher) pacer.current = null
    }
  }, [filter, generation, rows, sorted])
  /** Publish the stored rows when the pacer allows. */
  const schedule = useCallback(() => { pacer.current?.request() }, [])
  /** Publish the stored rows now. */
  const flush = useCallback(() => { pacer.current?.flush() }, [])
  return { admit, schedule, flush }
}
