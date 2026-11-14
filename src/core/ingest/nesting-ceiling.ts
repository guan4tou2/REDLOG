// The one event RedLog refuses for its nesting (Spec 071 FR-097).
//
// An event nested deeper than `data`'s bound is kept: the writer collapses the
// excess (./depth.ts). Below the bound nothing on the ingest path recurses, but
// the parse and the collapse still cost memory per level. Past
// EVENT_NESTING_CEILING levels, counted on the whole body or spool file before
// it is parsed, the event is refused instead, and the refusal is a capture gap:
// what was not recorded is on the record. Owner, 2026-11-14:
// 「事件 API 超過十萬層就拒絕並記缺口，可以嗎？」「可以」.
//
// Measured on this machine (plan.md D13): a body 100,000 levels deep is
// parsed and stored in about 17 ms and +19 MB. The process aborts out of
// memory well before the 20 MiB body cap allows nesting to end.
//
// The spool door counts its refusals the way it counts every file it sets
// aside: one gap row per reason per drain pass (spool-drain.ts). This file is
// the API door's: the first refusal is recorded at once; further refusals
// within REFUSAL_WINDOW_MS are added together and recorded as one row when the
// window closes, so a sender in a loop writes one row a minute, not one a
// request.

import { ingest, committedEventOf } from '../ingest'
import { getDB } from '../db/index'
import { noteDbError } from '../capture-health'
import { EVENT_NESTING_CEILING, NESTED_TOO_DEEP } from './depth'
import { IN_PROCESS, withEntrance } from './stamp'

const REFUSAL_WINDOW_MS = 60_000

interface Window {
  engagementId: string
  operatorId: string
  /** When the window closes. */
  until: number
  /** Refusals in it not yet recorded, and their bytes, first and last time. */
  count: number
  bytes: number
  firstAt: number
  lastAt: number
  timer: ReturnType<typeof setTimeout> | null
}

/** One open window per project database; it goes with the handle. */
const windows = new WeakMap<object, Window>()

function record(win: Pick<Window, 'engagementId' | 'operatorId' | 'count' | 'bytes' | 'firstAt' | 'lastAt'>): void {
  try {
    // RedLog's own record of what it refused, as the spool's gap rows are:
    // in-process, whatever entrance the refused request came by.
    const result = withEntrance(IN_PROCESS, () => ingest({
      agentType: 'system', engagementId: win.engagementId, operatorId: win.operatorId, occurredAt: win.firstAt,
      data: {
        subtype: 'capture_gap', source: 'api', door: 'legacy-api', reason: NESTED_TOO_DEEP,
        intentional: false,
        skipped_units: win.count,
        bytes: win.bytes,
        max_nesting: EVENT_NESTING_CEILING,
        gap_started_at: win.firstAt, gap_ended_at: win.lastAt,
        description: `${win.count} event(s) refused by the API: nested more than 100,000 levels deep; content not kept`
      }
    }))
    if (!result.event) throw new Error(`the ${NESTED_TOO_DEEP} gap row was not written (${result.skipped ?? 'no row'})`)
  } catch (e) {
    if (committedEventOf(e)) return
    console.error(`[api] a ${NESTED_TOO_DEEP} gap of ${win.count} could not be recorded:`, e)
    noteDbError('api-nesting-gap', e)
  }
}

function flush(handle: object, win: Window): void {
  if (win.timer) { clearTimeout(win.timer); win.timer = null }
  if (windows.get(handle) === win) windows.delete(handle)
  if (win.count === 0) return
  // The project the refusals were made in, or none: a closed project's
  // database is not written to from here.
  let open: object | null = null
  try { open = getDB() } catch { /* no project open */ }
  if (open !== handle) {
    console.error(`[api] ${win.count} ${NESTED_TOO_DEEP} refusal(s) were not recorded: the project closed first`)
    noteDbError('api-nesting-gap', new Error('project closed before the refusal window did'))
    return
  }
  record(win)
}

/** Record that the API refused an event of `bytes` for its nesting, in the
 *  project open now, at `now`. */
export function noteNestingRefusal(identity: { engagementId: string; operatorId: string }, bytes: number, now = Date.now()): void {
  const handle = getDB() as unknown as object
  const win = windows.get(handle)
  if (win && now < win.until && win.engagementId === identity.engagementId) {
    if (win.count === 0) win.firstAt = now
    win.count++
    win.bytes += bytes
    win.lastAt = now
    if (!win.timer) {
      win.timer = setTimeout(() => flush(handle, win), Math.max(0, win.until - now))
      win.timer.unref?.()
    }
    return
  }
  if (win) flush(handle, win)
  record({ ...identity, count: 1, bytes, firstAt: now, lastAt: now })
  windows.set(handle, { ...identity, until: now + REFUSAL_WINDOW_MS, count: 0, bytes: 0, firstAt: now, lastAt: now, timer: null })
}
