// The API door's record of the events it refuses for their nesting (Spec 071
// FR-097).
//
// An event nested deeper than `data`'s bound is kept: the writer collapses the
// excess (./depth.ts). Past EVENT_NESTING_CEILING levels, counted on the whole
// body before it is parsed, the API refuses it instead (413), and the refusal
// is a capture gap: what was not recorded is on the record. Owner, 2026-11-14:
// 「事件 API 超過十萬層就拒絕並記缺口，可以嗎？」「可以」. The spool door
// refuses the same files and counts them its own way: one gap row per reason
// per drain pass (spool-drain.ts).
//
// Rows, for a sender that keeps being refused: the first refusal is written at
// once and opens a window of REFUSAL_WINDOW_MS. Refusals inside a window are
// added up and written as one row when it closes, and that row opens the next
// window. A steady stream is therefore one row at the start and one per
// window after it; a window in which nothing arrived writes nothing and ends
// the run. Before the project's database closes (project close, switch, app
// quit: stopProject → onApiProjectClose), the open window is written out, so
// what was counted is recorded in the project it was counted in. A process
// that dies without stopProject loses the open window's count — the one case.
//
// A refusal while recording is paused is `intentional`, as the spool's are: an
// event sent then would not have been recorded either. (Except a marker, the
// one kind the API records while paused; the scan cannot tell which kind an
// unparsed body was.)

import { ingest, committedEventOf } from '../ingest'
import { getDB } from '../db/index'
import { notePipelineWarning } from '../capture-health'
import { EVENT_NESTING_CEILING, NESTED_TOO_DEEP } from './depth'
import { IN_PROCESS, withEntrance } from './stamp'

const REFUSAL_WINDOW_MS = 60_000

/** The ceiling as the gap rows and the API's answer write it: `100,000`. */
export const CEILING_TEXT = EVENT_NESTING_CEILING.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

interface Counted {
  engagementId: string
  operatorId: string
  /** Paused when the refusals were made: a window holds one kind only. */
  intentional: boolean
  count: number
  bytes: number
  firstAt: number
  lastAt: number
}

interface Window extends Counted {
  /** When the window closes. */
  until: number
  timer: ReturnType<typeof setTimeout> | null
}

/** One open window per project database; it goes with the handle. */
const windows = new WeakMap<object, Window>()

function record(c: Counted): void {
  try {
    // RedLog's own record of what it refused, as the spool's gap rows are:
    // in-process, whatever entrance the refused request came by.
    const result = withEntrance(IN_PROCESS, () => ingest({
      agentType: 'system', engagementId: c.engagementId, operatorId: c.operatorId, occurredAt: c.firstAt,
      data: {
        subtype: 'capture_gap', source: 'api', door: 'legacy-api', reason: NESTED_TOO_DEEP,
        intentional: c.intentional,
        skipped_units: c.count,
        bytes: c.bytes,
        max_nesting: EVENT_NESTING_CEILING,
        gap_started_at: c.firstAt, gap_ended_at: c.lastAt,
        description: `${c.count} request(s) refused by the API${c.intentional ? ' while recording was paused' : ''}: ` +
          `nested more than ${CEILING_TEXT} levels deep, so not parsed and not kept`
      }
    }))
    if (!result.event) throw new Error(`the ${NESTED_TOO_DEEP} gap row was not written (${result.skipped ?? 'no row'})`)
  } catch (e) {
    if (committedEventOf(e)) return
    console.error(`[api] a ${NESTED_TOO_DEEP} gap of ${c.count} could not be recorded:`, e)
    notePipelineWarning('api-nesting-gap', e)
  }
}

/** Write the window's count, if any, and drop it. The handle must be the open one. */
function close(handle: object, win: Window): void {
  if (win.timer) { clearTimeout(win.timer); win.timer = null }
  if (windows.get(handle) === win) windows.delete(handle)
  if (win.count > 0) record(win)
}

/** The timer: write the window's count and open the next window from it. */
function roll(handle: object, win: Window): void {
  win.timer = null
  if (windows.get(handle) !== win) return
  let open: object | null = null
  try { open = getDB() } catch { /* no project open */ }
  // Written out by onApiProjectClose before the handle closed; nothing left.
  if (open !== handle) { windows.delete(handle); return }
  if (win.count === 0) { windows.delete(handle); return }
  record(win)
  const now = Date.now()
  windows.set(handle, { ...win, until: now + REFUSAL_WINDOW_MS, count: 0, bytes: 0, firstAt: now, lastAt: now, timer: null })
}

/** Record that the API refused a request of `bytes` for its nesting, in the
 *  project open now, at `now`. */
export function noteNestingRefusal(identity: { engagementId: string; operatorId: string; paused: boolean }, bytes: number, now = Date.now()): void {
  const handle = getDB() as unknown as object
  const win = windows.get(handle)
  const same = win !== undefined && win.engagementId === identity.engagementId && win.intentional === identity.paused
  const add = (w: Window): void => {
    if (w.count === 0) w.firstAt = now
    w.count++
    w.bytes += bytes
    w.lastAt = now
    if (!w.timer) {
      w.timer = setTimeout(() => roll(handle, w), Math.max(0, w.until - now))
      w.timer.unref?.()
    }
  }
  if (win && same && now < win.until) { add(win); return }
  if (win && same && win.count > 0) {
    // The window is over and its timer has not run yet: what roll would do.
    if (win.timer) { clearTimeout(win.timer); win.timer = null }
    record(win)
    const next: Window = { ...win, until: now + REFUSAL_WINDOW_MS, count: 0, bytes: 0, firstAt: now, lastAt: now, timer: null }
    windows.set(handle, next)
    add(next)
    return
  }
  if (win) close(handle, win)
  const first = { engagementId: identity.engagementId, operatorId: identity.operatorId, intentional: identity.paused, count: 1, bytes, firstAt: now, lastAt: now }
  record(first)
  windows.set(handle, { ...first, count: 0, bytes: 0, until: now + REFUSAL_WINDOW_MS, timer: null })
}

/** Write out the open project's window before its database closes. */
export function flushNestingRefusals(): void {
  let handle: object | null = null
  try { handle = getDB() as unknown as object } catch { return }
  const win = windows.get(handle)
  if (win) close(handle, win)
}
