import { useEffect, useState } from 'react'

// Shared counts that Sidebar, DashboardView, and StatusBar all need.
// Centralises the fetch + batch subscription so each consumer doesn't
// independently wire the same four IPC calls and the same listener.

export interface AppCounts {
  eventCount: number
  lootCount: number
  scopeViolations: number
  scopeConfigured: boolean
  loading: boolean
}

export function useAppCounts(): AppCounts {
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [scopeConfigured, setScopeConfigured] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      window.redlog.events.getCount('chained').then(setEventCount).catch(() => {}),
      window.redlog.loot.getCount().then(setLootCount).catch(() => {}),
      window.redlog.scope.getViolationCount().then(setScopeViolations).catch(() => {}),
      window.redlog.scope.isConfigured().then(setScopeConfigured).catch(() => {})
    ]).then(() => setLoading(false))

    const unsub = window.redlog.events.onNewBatch(() => {
      window.redlog.events.getCount('chained').then(setEventCount).catch(() => {})
      window.redlog.loot.getCount().then(setLootCount).catch(() => {})
      window.redlog.scope.getViolationCount().then(setScopeViolations).catch(() => {})
    })

    return unsub
  }, [])

  return { eventCount, lootCount, scopeViolations, scopeConfigured, loading }
}
