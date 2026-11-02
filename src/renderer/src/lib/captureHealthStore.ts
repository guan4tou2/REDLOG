// One capture-health snapshot, shared by every reader.
//
// The status bar, the dashboard card and two settings pages each used to poll
// `capture.health()` for themselves, and each decided on its own what a failed
// read meant: two left the last verdict on screen as if it were current, one
// threw it away. A dot that stays green because the read that would have turned
// it amber never arrived is the failure this store exists to make impossible.
//
// So the store keeps three things and a rule:
//
//   health    the last snapshot that was read successfully
//   lastOkAt  when that was
//   status    'ok', or 'unknown' from a failed read until the next success
//
// `health` is history while `status` is 'unknown'. It is kept so a reader can
// say "last confirmed healthy 22:40", and must not be drawn as the verdict.
//
// One read at a time, shared. Readers arriving together share the read in
// flight, a poll tick during one is dropped, and `refresh()` during one asks
// for a single follow-up read (the one in flight may predate whatever the
// refresh is for). The poll runs at the fastest cadence any mounted reader asks
// for and stops with the last of them.
//
// A read that never settles is a failed read too: after twice the poll interval
// it is abandoned, the status goes 'unknown' and the next tick reads again.
//
// Reads are applied in the order they were issued. Two can overlap only when
// every reader leaves and a new one arrives while the abandoned read is still
// out; the late reply must not undo the newer one, success or failure.

export type CaptureHealthStatus = 'ok' | 'unknown'

export interface CaptureHealthState {
  health: CaptureHealthInfo | null
  lastOkAt: number | null
  status: CaptureHealthStatus
}

const INITIAL: CaptureHealthState = { health: null, lastOkAt: null, status: 'ok' }

let state: CaptureHealthState = INITIAL
const listeners = new Set<() => void>()
// One entry per mounted reader; the value is the cadence it asks for, 0 for
// "read when I arrive and when I say so".
const readers = new Map<symbol, number>()
let timer: ReturnType<typeof setInterval> | null = null
let timerMs = 0
let issued = 0
let applied = 0
let inFlight = 0
let rerun = false
let stallTimer: ReturnType<typeof setTimeout> | null = null

/** How many poll intervals a read may take before it is called stalled. Two:
 *  one interval is an ordinary slow read, and the tick after it is the first
 *  that could have replaced it. */
const STALL_INTERVALS = 2
/** The interval to count in when no mounted reader polls (they read on arrival
 *  and on refresh only): the status bar's, the slowest cadence in use. */
const NO_POLL_STALL_BASE_MS = 30_000

function set(next: CaptureHealthState): void {
  state = next
  for (const l of listeners) l()
}

function read(): void {
  if (inFlight) return
  const seq = ++issued
  inFlight = seq
  // A read that never settles (a stalled main process, a lost reply) would
  // otherwise hold `inFlight` for good: every tick is dropped and the status
  // stays 'ok' on a snapshot nobody is refreshing. So a read has this long, and
  // then it is abandoned: the status goes 'unknown' (the last snapshot and
  // lastOkAt stay, as "last confirmed"), the next tick reads again, and the
  // abandoned read's reply — if it ever comes — is dropped by the ordering below.
  const stallMs = STALL_INTERVALS * (timerMs || NO_POLL_STALL_BASE_MS)
  const stall = setTimeout(() => {
    if (inFlight !== seq) return
    inFlight = 0
    applied = Math.max(applied, seq)
    if (state.status !== 'unknown') set({ ...state, status: 'unknown' })
    if (rerun && readers.size > 0) { rerun = false; read() }
  }, stallMs)
  stallTimer = stall
  const done = (next: CaptureHealthState | null): void => {
    clearTimeout(stall)
    if (stallTimer === stall) stallTimer = null
    if (inFlight === seq) inFlight = 0
    if (seq > applied) {
      applied = seq
      if (next) set(next)
      // A second failure changes nothing a reader could draw.
      else if (state.status !== 'unknown') set({ ...state, status: 'unknown' })
    }
    // Only when no other read took over, or the request would be spent on a
    // call that returns early.
    if (rerun && readers.size > 0 && !inFlight) { rerun = false; read() }
  }
  let pending: Promise<unknown>
  try { pending = Promise.resolve(window.redlog.capture.health()) } catch (e) { pending = Promise.reject(e) }
  void pending.then(
    (h) => done(h && typeof h === 'object'
      ? { health: h as CaptureHealthInfo, lastOkAt: Date.now(), status: 'ok' }
      : null),
    () => done(null)
  )
}

function syncTimer(): void {
  const ms = Math.min(...[...readers.values()].filter((v) => v > 0), Infinity)
  const want = Number.isFinite(ms) ? ms : 0
  if (want === timerMs) return
  if (timer) clearInterval(timer)
  timer = null
  timerMs = want
  if (want) timer = setInterval(read, want)
}

/** Ask for a fresh read, for a change the current snapshot cannot have seen. */
export function refreshCaptureHealth(): void {
  if (readers.size === 0) return
  if (inFlight) rerun = true
  else read()
}

/** Register a reader. `pollMs` is how often it wants the snapshot kept fresh,
 *  or 0 for none. Arriving is a read of its own. Returns the release. */
export function acquireCaptureHealth(pollMs: number): () => void {
  const id = Symbol('capture-health-reader')
  readers.set(id, pollMs)
  syncTimer()
  read()
  return () => {
    readers.delete(id)
    syncTimer()
    // The read in flight belongs to nobody now. A reader that arrives next
    // starts its own, and the ordering above keeps the two apart.
    if (readers.size === 0) {
      inFlight = 0; rerun = false
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
    }
  }
}

export function getCaptureHealth(): CaptureHealthState { return state }

export function listenCaptureHealth(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Test seam — the store is module state and would otherwise leak between cases. */
export function _resetCaptureHealth(): void {
  if (timer) clearInterval(timer)
  timer = null; timerMs = 0
  if (stallTimer) clearTimeout(stallTimer)
  stallTimer = null
  readers.clear(); listeners.clear()
  state = INITIAL
  issued = 0; applied = 0; inFlight = 0; rerun = false
}
