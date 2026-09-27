import { useCallback, useEffect, useState } from 'react'

// Shared counts that Sidebar, DashboardView, and StatusBar all need.
// Centralises the fetch + batch subscription so each consumer doesn't
// independently wire the same four IPC calls and the same listener.
//
// A read that fails is not a zero. The scope pair in particular used to
// fall back to "0 violations, configured", which the dashboard painted green
// — a safety signal shown exactly when RedLog could not check. `scopeUnknown`
// says the scope state could not be read; consumers must not show it as OK.

export interface AppCounts {
  eventCount: number
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
    window.redlog.loot.getCount().then(setLootCount).catch(() => {}),
    readViolations(),
    readConfigured()
  ]).then(() => setLoading(false)), [readViolations, readConfigured])

  useEffect(() => {
    void load()
    const unsub = window.redlog.events.onNewBatch(() => {
      window.redlog.events.getCount('chained').then(setEventCount).catch(() => {})
      window.redlog.loot.getCount().then(setLootCount).catch(() => {})
      void readViolations()
    })
    return unsub
  }, [load, readViolations])

  return {
    eventCount, lootCount, scopeViolations, scopeConfigured,
    scopeUnknown: violationsFailed || configuredFailed,
    loading, retry: () => { void load() }
  }
}
