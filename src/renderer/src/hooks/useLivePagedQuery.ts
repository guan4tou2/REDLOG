import { useCallback, useEffect, useRef, useState } from 'react'
import { createThrottledRead, type ThrottledRead } from '../lib/throttledRead'
import {
  describeError, initialRead, readFailed, readStarted, readSucceeded, readValueUpdated, type ReadState
} from '../lib/readState'

// A paged list that stays current while events arrive: HTTP History, Loot,
// Screenshots and a target's evidence. Each kept its own copy of the same
// half-dozen mechanisms, and each copy missed a different one — a live refresh
// that threw away the older pages the operator had loaded, a slow reply for
// the previous filter landing over the current one, a debounce that never
// fired while traffic kept coming.
//
// One question is in force at a time, named by `key`. Three things read it:
//
//   reset    — the key changed (or first mount): page one of the new question.
//              Replies to the previous key are dropped.
//   append   — the next page after the loaded ones (`loadMore`).
//   refresh  — the same question again, because a live batch said it might
//              have changed (`live.affects`) or the view asked (`refresh`).
//              `'pages'` re-reads exactly as many pages as are loaded and
//              replaces them; `'head'` reads page one and merges it into the
//              loaded rows by `rowKey`, keeping the cursor — and when that
//              page shares nothing with what is loaded while more lies past
//              it, the gap is unknown, so it reads page one again in place
//              of the loaded rows.
//
// All three run through one createThrottledRead: one read in flight, live
// refreshes at most once per `live.intervalMs` with a trailing one so the last
// batch is always read, and the operator's own asks (loadMore, retry) without
// waiting out the interval.
//
// A failed refresh keeps the rows and says it failed (ReadState 'failed' with
// the value); a failed reset has no rows, because the previous question's
// answer is not this one's. A failed append is separate (`moreFailed`): the
// loaded pages are still a correct answer, only an incomplete one.

export interface LivePage<R> {
  rows: R[]
  /** The cursor for the page after this one; absent or null when there is none. */
  nextCursor?: string | null
  total?: number
  truncated?: boolean
}

/** Set once the read it was handed to is no longer wanted (key change, unmount). */
export interface LiveReadSignal { readonly cancelled: boolean }

export interface LivePagedQueryOptions<R> {
  /** The question. A different key starts over from page one. */
  key: string
  fetch: (cursor: string | undefined, signal: LiveReadSignal) => Promise<LivePage<R>>
  /** False: nothing to ask — an empty, loaded list. */
  enabled?: boolean
  /** Re-read on live batches the predicate says concern this list. */
  live?: { affects: (events: RedLogEvent[]) => boolean; intervalMs: number }
  refresh?: 'pages' | 'head'
  /** Identity for merging pages (later copies replace earlier ones in place). Required for 'head'. */
  rowKey?: (row: R) => string
  /** Keep the previous key's rows on screen until the new answer replaces them. */
  keepRowsOnReset?: boolean
}

export interface LivePagedQuery<R> {
  /** Reset and refresh outcome. `value` is the loaded rows. */
  state: ReadState<R[]>
  rows: R[]
  hasMore: boolean
  total: number | undefined
  truncated: boolean
  /** An append is wanted or in flight. */
  loadingMore: boolean
  /** The last append failed; a new object per failure. */
  moreFailed: { error: string } | null
  loadMore: () => void
  /** Re-read now (not paced): the loaded pages, or page one if none loaded. */
  refresh: () => void
  /** Repeat what failed: the append if that was it, otherwise a refresh. */
  retry: () => void
  /** A local change to the loaded rows (a live row admitted, a delete). */
  update: (fn: (rows: R[]) => R[]) => void
}

interface Paging { cursor: string | null; total: number | undefined; truncated: boolean }
const NO_PAGING: Paging = { cursor: null, total: undefined, truncated: false }
// One empty list, so "no rows yet" keeps its identity across renders.
const NO_ROWS: unknown[] = []

interface Controller<R> {
  rows: R[]
  pages: number
  paging: Paging
  want: { reset: boolean; append: boolean; refresh: boolean }
  signal: { cancelled: boolean }
  runner: ThrottledRead | null
  put: (fn: (s: Snapshot<R>) => Snapshot<R>) => void
}

type Outcome<R> =
  | { op: 'none' }
  | { op: 'reset' | 'refresh' | 'append'; ok: true; rows: R[]; pages: number; paging: Paging }
  | { op: 'reset' | 'refresh' | 'append'; ok: false; error: string }

function mergeRows<R>(current: R[], incoming: R[], rowKey?: (row: R) => string): R[] {
  if (!rowKey) return [...current, ...incoming]
  return [...new Map([...current, ...incoming].map((row) => [rowKey(row), row] as const)).values()]
}

function pagingOf<R>(page: LivePage<R>, previous: Paging): Paging {
  return {
    cursor: page.nextCursor ?? null,
    total: page.total ?? previous.total,
    truncated: page.truncated ?? false
  }
}

/** Page one, then on through the cursor until `count` pages or the end. */
async function readPages<R>(c: Controller<R>, opts: LivePagedQueryOptions<R>, count: number): Promise<{ rows: R[]; pages: number; paging: Paging }> {
  let rows: R[] = []
  let paging = NO_PAGING
  let pages = 0
  let cursor: string | undefined
  do {
    const page = await opts.fetch(cursor, c.signal)
    rows = pages === 0 ? page.rows : mergeRows(rows, page.rows, opts.rowKey)
    paging = pagingOf(page, paging)
    pages++
    cursor = paging.cursor ?? undefined
  } while (pages < count && cursor !== undefined)
  return { rows, pages, paging }
}

async function step<R>(c: Controller<R>, opts: LivePagedQueryOptions<R>): Promise<Outcome<R>> {
  const op = c.want.reset ? 'reset' : c.want.append ? 'append' : c.want.refresh ? 'refresh' : null
  if (op === null) return { op: 'none' }
  if (op === 'reset') { c.want.reset = false; c.want.refresh = false }
  else c.want[op] = false
  try {
    if (op === 'append') {
      if (c.paging.cursor === null) return { op, ok: true, rows: c.rows, pages: c.pages, paging: c.paging }
      const page = await opts.fetch(c.paging.cursor, c.signal)
      return { op, ok: true, rows: mergeRows(c.rows, page.rows, opts.rowKey), pages: c.pages + 1, paging: pagingOf(page, c.paging) }
    }
    if (op === 'refresh' && opts.refresh === 'head' && c.pages > 0 && c.rows.length > 0 && opts.rowKey) {
      const head = await opts.fetch(undefined, c.signal)
      const rowKey = opts.rowKey
      const known = new Set(c.rows.map(rowKey))
      if (!(head.nextCursor && !head.rows.some((row) => known.has(rowKey(row))))) {
        return { op, ok: true, rows: mergeRows(c.rows, head.rows, rowKey), pages: c.pages, paging: c.paging }
      }
      // More arrived than one page holds: merging would leave a hole that
      // reads as nothing having happened. Ask again from the top.
      return { op, ok: true, ...await readPages(c, opts, 1) }
    }
    return { op, ok: true, ...await readPages(c, opts, op === 'reset' ? 1 : Math.max(1, c.pages)) }
  } catch (error: unknown) {
    return { op, ok: false, error: describeError(error) }
  }
}

/** Everything the view sees, tagged with the question it answers. */
interface Snapshot<R> {
  id: string
  read: ReadState<R[]>
  paging: Paging
  loadingMore: boolean
  moreFailed: { error: string } | null
}

/** The state of a question nothing has been read for yet. */
function fresh<R>(id: string, enabled: boolean, shown: R[] | null, keep: boolean): Snapshot<R> {
  const read: ReadState<R[]> = !enabled ? readSucceeded<R[]>([])
    : keep && shown !== null ? { phase: 'loading', value: shown } : initialRead<R[]>()
  return { id, read, paging: NO_PAGING, loadingMore: false, moreFailed: null }
}

export function useLivePagedQuery<R>(opts: LivePagedQueryOptions<R>): LivePagedQuery<R> {
  const { key, enabled = true } = opts
  const keep = opts.keepRowsOnReset === true
  const optsRef = useRef(opts)
  optsRef.current = opts
  const id = enabled ? `on:${key}` : 'off'
  const [stored, setStored] = useState<Snapshot<R>>(() => fresh<R>(id, enabled, null, keep))
  // The render that changes the key comes before the effect that starts the
  // new read: it must already show the new question as unanswered, not the
  // previous question's rows and phase for a frame.
  const snap = stored.id === id ? stored : fresh(id, enabled, stored.read.value, keep)
  const ctl = useRef<Controller<R> | null>(null)
  const liveOn = opts.live !== undefined
  const intervalMs = opts.live?.intervalMs ?? 0

  useEffect(() => {
    setStored((prev) => prev.id === id ? prev : fresh(id, enabled, prev.read.value, optsRef.current.keepRowsOnReset === true))
    if (!enabled) return
    // Only this question's snapshot is written; anything else is a reply to
    // a question no longer asked.
    const put = (fn: (s: Snapshot<R>) => Snapshot<R>): void => setStored((prev) => prev.id === id ? fn(prev) : prev)
    const c: Controller<R> = {
      rows: [],
      pages: 0,
      paging: NO_PAGING,
      want: { reset: true, append: false, refresh: false },
      signal: { cancelled: false },
      runner: null,
      put
    }

    const land = (o: Outcome<R>): void => {
      if (o.op !== 'none') {
        if (o.ok) {
          c.rows = o.rows
          c.pages = o.pages
          c.paging = o.paging
          put((s) => ({
            ...s,
            paging: o.paging,
            read: o.op === 'append' ? readValueUpdated(s.read, o.rows) : readSucceeded(o.rows),
            ...(o.op === 'append' ? { loadingMore: false, moreFailed: null } : {})
          }))
        } else if (o.op === 'reset') {
          // No rows: the previous question's answer is not this one's.
          c.rows = []
          c.pages = 0
          c.paging = NO_PAGING
          put((s) => ({ ...s, paging: NO_PAGING, read: { phase: 'failed', value: null, error: o.error } }))
        } else if (o.op === 'append') put((s) => ({ ...s, loadingMore: false, moreFailed: { error: o.error } }))
        else put((s) => ({ ...s, read: readFailed(s.read, o.error) }))
      }
      // Whatever was asked for meanwhile: the operator's asks at once, a live
      // refresh at its pace.
      if (c.want.reset || c.want.append) c.runner?.request({ immediate: true })
      else if (c.want.refresh) c.runner?.request()
    }
    const runner = createThrottledRead<Outcome<R>>({
      read: () => step(c, optsRef.current),
      apply: land,
      minIntervalMs: intervalMs
    })
    c.runner = runner
    ctl.current = c
    runner.now()
    const unsub = liveOn
      ? window.redlog.events.onNewBatch((events) => {
        if (!optsRef.current.live?.affects(events)) return
        c.want.refresh = true
        runner.request()
      })
      : undefined
    return () => {
      c.signal.cancelled = true
      runner.dispose()
      unsub?.()
      if (ctl.current === c) ctl.current = null
    }
  }, [id, enabled, liveOn, intervalMs])

  const loadMore = useCallback(() => {
    const c = ctl.current
    if (!c || c.want.append || c.paging.cursor === null) return
    c.want.append = true
    c.put((s) => ({ ...s, loadingMore: true, moreFailed: null }))
    c.runner?.request({ immediate: true })
  }, [])

  const refresh = useCallback(() => {
    const c = ctl.current
    if (!c) return
    c.want.refresh = true
    c.runner?.request({ immediate: true })
  }, [])

  const moreFailed = snap.moreFailed
  const retry = useCallback(() => {
    const c = ctl.current
    if (!c || c.want.append) return
    if (moreFailed) { loadMore(); return }
    c.put((s) => ({ ...s, read: readStarted(s.read) }))
    refresh()
  }, [moreFailed, loadMore, refresh])

  const update = useCallback((fn: (rows: R[]) => R[]) => {
    const c = ctl.current
    if (!c) return
    c.rows = fn(c.rows)
    const next = c.rows
    c.put((s) => ({ ...s, read: readValueUpdated(s.read, next) }))
  }, [])

  return {
    state: snap.read,
    rows: snap.read.value ?? (NO_ROWS as R[]),
    hasMore: snap.paging.cursor !== null,
    total: snap.paging.total,
    truncated: snap.paging.truncated,
    loadingMore: snap.loadingMore,
    moreFailed,
    loadMore,
    refresh,
    retry,
    update
  }
}
