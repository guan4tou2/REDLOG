import { useEffect, useSyncExternalStore } from 'react'
import { createThrottledRead, type ThrottledRead } from './throttledRead'

// Shared counts that Sidebar, DashboardView, and StatusBar all need.
// Centralises the fetch + batch subscription so each consumer doesn't
// independently wire the same IPC calls and the same listener.
//
// `loggedCount` and `chainLen` moved in because two consumers were fetching
// them separately and disagreeing: the dashboard refetched, the status bar
// seeded once and incremented, so the strip's number could only go up while
// the dashboard's told the truth. One fetch, one answer.
//
// A read that fails is not a zero. The scope pair in particular used to
// fall back to "0 violations, configured", which the dashboard painted green
// — a safety signal shown exactly when RedLog could not check. `scopeUnknown`
// says the scope state could not be read; consumers must not show it as OK.
//
// One store for every consumer. Each mounted consumer used to hold its own
// copy and re-read five counts on every live batch, so a capture burst cost
// (consumers × batches × 5) IPC reads on the main process — measured at ~21
// reads/s for 50 events/s. Now live batches are coalesced: at most one round
// of reads is in flight, and batches start a new round at most once per
// LIVE_INTERVAL_MS, however many components subscribe. The last batch of a
// burst is never dropped: it schedules a trailing round.

/** One instance's `retry` re-reads one instance.
 *
 *  Every consumer holds its own copy of these counts, so the dashboard's
 *  scope-retry button refreshed the dashboard and left the status bar amber —
 *  the same read, two answers, and the one the operator had just corrected
 *  was the one that stayed wrong. A retry is about the data, not about the
 *  surface it was pressed on, so it says so to all of them. */
export const RECOUNT_EVENT = 'redlog:recount'

/** Live batches start a round of reads at most this often. */
const LIVE_INTERVAL_MS = 1000

/** Re-read the shared counts everywhere they are mounted. */
export function recountAll(): void {
  window.dispatchEvent(new Event(RECOUNT_EVENT))
}

export interface AppCounts {
  eventCount: number
  /** Rows in the logged tier. Fetched, never accumulated: the status bar used
   *  to seed this once and add to it per batch, so it could only ever go up —
   *  a deletion or a redaction of logged rows never reached it, and the same
   *  number differed between the strip and the dashboard. */
  loggedCount: number
  /** Rows carrying a hash. Equal to `eventCount` on a sound chain, and the
   *  number the word 證據鏈 actually means. */
  chainLen: number
  lootCount: number
  /** `lootCount` is a lower bound (#695: a loot event stores at most 500). */
  lootPartial: boolean
  scopeObservations: number
  scopeConfigured: boolean
  /** The violation count or the scope configuration could not be read. */
  scopeUnknown: boolean
  loading: boolean
  retry: () => void
}

interface State {
  eventCount: number; loggedCount: number; chainLen: number; lootCount: number; lootPartial: boolean
  scopeObservations: number; scopeConfigured: boolean
  observationsFailed: boolean; configuredFailed: boolean; loading: boolean
}
const INITIAL: State = {
  eventCount: 0, loggedCount: 0, chainLen: 0, lootCount: 0, lootPartial: false, scopeObservations: 0, scopeConfigured: false,
  observationsFailed: false, configuredFailed: false, loading: true
}
/** What a round reads. `live`: what a batch can change. `configured`: whether
 *  a scope is set, which only a config save or a recount can change. */
interface Want { live: boolean; configured: boolean; done: boolean }

let state: State = INITIAL
const listeners = new Set<() => void>()
let consumers = 0
let detach: (() => void) | null = null
let want: Want = { live: false, configured: false, done: false }
/** Paces rounds while anyone is mounted; replaced on the next first mount. */
let pacer: ThrottledRead | null = null
/** Bumped when the last consumer leaves, so a round that outlives every
 *  consumer cannot write into the next mount's counts. */
let generation = 0

function set(patch: Partial<State>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

async function round(): Promise<void> {
  const take = want, gen = generation
  want = { live: false, configured: false, done: false }
  const r = window.redlog
  const apply = (patch: Partial<State>): void => { if (gen === generation) set(patch) }
  const reads: Array<Promise<unknown>> = []
  if (take.live) {
    reads.push(
      r.events.getCount('chained').then((n) => apply({ eventCount: n })).catch(() => {}),
      r.events.getCount('logged').then((n) => apply({ loggedCount: n })).catch(() => {}),
      r.chain.length().then((n) => apply({ chainLen: n })).catch(() => {}),
      r.loot.getCount().then((n) => apply({ lootCount: n })).catch(() => {}),
      // Read like the count beside it: a failed read keeps the last answer.
      Promise.resolve().then(() => r.loot.countIsPartial()).then((partial) => apply({ lootPartial: partial === true })).catch(() => {}),
      r.scope.getObservationCount()
        .then((n) => apply({ scopeObservations: n, observationsFailed: false }))
        .catch(() => apply({ observationsFailed: true }))
    )
  }
  if (take.configured) {
    reads.push(r.scope.isConfigured()
      .then((v) => apply({ scopeConfigured: v, configuredFailed: false }))
      .catch(() => apply({ configuredFailed: true })))
  }
  try { await Promise.all(reads) } finally {
    if (take.done) apply({ loading: false })
  }
}

/** Start the next round if one is wanted. One round is in flight at most. A
 *  round that carries only live counts waits out LIVE_INTERVAL_MS from the
 *  previous round; anything the operator or a mount asked for goes as soon as
 *  nothing is in flight. */
function pump(): void {
  if (!want.live && !want.configured) return
  pacer?.request({ immediate: want.configured || want.done })
}

let queued = false
/** Asks made in one tick — three consumers mounting in one commit, a batch
 *  and a config save — are served by one round. */
function ask(next: Partial<Want>): void {
  want = { live: want.live || !!next.live, configured: want.configured || !!next.configured, done: want.done || !!next.done }
  if (queued) return
  queued = true
  queueMicrotask(() => { queued = false; pump() })
}
const everything = (): void => ask({ live: true, configured: true, done: true })

function attach(): () => void {
  const paced = createThrottledRead({ read: round, minIntervalMs: LIVE_INTERVAL_MS })
  pacer = paced
  const unsub = window.redlog.events.onNewBatch(() => ask({ live: true }))
  // A saved config can change what "configured" means (a scope target added
  // from Settings or from the Targets view). Without this the status bar
  // kept saying "scope not set" until something else forced a recount.
  const onConfigSaved = (): void => ask({ live: true, configured: true })
  window.addEventListener(RECOUNT_EVENT, everything)
  window.addEventListener('redlog:config-saved', onConfigSaved)
  return () => {
    unsub()
    paced.dispose()
    if (pacer === paced) pacer = null
    window.removeEventListener(RECOUNT_EVENT, everything)
    window.removeEventListener('redlog:config-saved', onConfigSaved)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = (): State => state

export function useAppCounts(): AppCounts {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (consumers++ === 0) detach = attach()
    // A newly mounted surface reads fresh rather than trusting what another
    // surface last saw; it joins a round already in flight.
    everything()
    return () => {
      if (--consumers > 0) return
      detach?.(); detach = null
      generation++
      state = INITIAL
      want = { live: false, configured: false, done: false }
    }
  }, [])
  return {
    eventCount: s.eventCount, loggedCount: s.loggedCount, chainLen: s.chainLen, lootCount: s.lootCount, lootPartial: s.lootPartial,
    scopeObservations: s.scopeObservations, scopeConfigured: s.scopeConfigured,
    scopeUnknown: s.observationsFailed || s.configuredFailed,
    loading: s.loading, retry: recountAll
  }
}
