import { useCallback, useEffect, useState } from 'react'

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

/** One instance's `retry` re-reads one instance.
 *
 *  Every consumer holds its own copy of these counts, so the dashboard's
 *  scope-retry button refreshed the dashboard and left the status bar amber —
 *  the same read, two answers, and the one the operator had just corrected
 *  was the one that stayed wrong. A retry is about the data, not about the
 *  surface it was pressed on, so it says so to all of them. */
export const RECOUNT_EVENT = 'redlog:recount'

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
  scopeViolations: number
  scopeConfigured: boolean
  /** The violation count or the scope configuration could not be read. */
  scopeUnknown: boolean
  loading: boolean
  retry: () => void
}

export function useAppCounts(): AppCounts {
  const [eventCount, setEventCount] = useState(0)
  const [loggedCount, setLoggedCount] = useState(0)
  const [chainLen, setChainLen] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [scopeConfigured, setScopeConfigured] = useState(false)
  const [violationsFailed, setViolationsFailed] = useState(false)
  const [configuredFailed, setConfiguredFailed] = useState(false)
  const [loading, setLoading] = useState(true)

  const readViolations = useCallback(() => window.redlog.scope.getViolationCount()
    .then((n) => { setScopeViolations(n); setViolationsFailed(false) })
    .catch(() => setViolationsFailed(true)), [])
  const readConfigured = useCallback(() => window.redlog.scope.isConfigured()
    .then((v) => { setScopeConfigured(v); setConfiguredFailed(false) })
    .catch(() => setConfiguredFailed(true)), [])

  const load = useCallback(() => Promise.all([
    window.redlog.events.getCount('chained').then(setEventCount).catch(() => {}),
    window.redlog.events.getCount('logged').then(setLoggedCount).catch(() => {}),
    window.redlog.chain.length().then(setChainLen).catch(() => {}),
    window.redlog.loot.getCount().then(setLootCount).catch(() => {}),
    readViolations(),
    readConfigured()
  ]).then(() => setLoading(false)), [readViolations, readConfigured])

  useEffect(() => {
    void load()
    const unsub = window.redlog.events.onNewBatch(() => {
      window.redlog.events.getCount('chained').then(setEventCount).catch(() => {})
      window.redlog.events.getCount('logged').then(setLoggedCount).catch(() => {})
      window.redlog.chain.length().then(setChainLen).catch(() => {})
      window.redlog.loot.getCount().then(setLootCount).catch(() => {})
      void readViolations()
    })
    const onRecount = (): void => { void load() }
    window.addEventListener(RECOUNT_EVENT, onRecount)
    return () => { unsub(); window.removeEventListener(RECOUNT_EVENT, onRecount) }
  }, [load, readViolations])

  return {
    eventCount, loggedCount, chainLen, lootCount, scopeViolations, scopeConfigured,
    scopeUnknown: violationsFailed || configuredFailed,
    loading, retry: recountAll
  }
}
