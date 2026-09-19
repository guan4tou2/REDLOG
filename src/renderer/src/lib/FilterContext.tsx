import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'

export interface TimeRange {
  since?: number
  before?: number
}

export interface SharedFilter {
  targetId: string | null
  agentType: string | null
  timeRange: TimeRange | null
}

interface FilterContextValue {
  filter: SharedFilter
  setTargetId: (id: string | null) => void
  setAgentType: (type: string | null) => void
  setTimeRange: (range: TimeRange | null) => void
  clearAll: () => void
  activeCount: number
  knownTargets: Array<{ target: string; eventCount: number }>
  knownAgentTypes: string[]
}

const EMPTY: SharedFilter = { targetId: null, agentType: null, timeRange: null }

const FilterContext = createContext<FilterContextValue>({
  filter: EMPTY,
  setTargetId: () => {},
  setAgentType: () => {},
  setTimeRange: () => {},
  clearAll: () => {},
  activeCount: 0,
  knownTargets: [],
  knownAgentTypes: []
})

export function FilterProvider({ children }: { children: ReactNode }): JSX.Element {
  const [filter, setFilter] = useState<SharedFilter>(EMPTY)
  const [knownTargets, setKnownTargets] = useState<Array<{ target: string; eventCount: number }>>([])
  const [knownAgentTypes, setKnownAgentTypes] = useState<string[]>([])

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshLists = useCallback(() => {
    window.redlog.events.aggregateTargets()
      .then((rows) => setKnownTargets(rows.map((r) => ({ target: r.target, eventCount: r.eventCount }))))
      .catch(() => {})
    ;(window.redlog.events as { distinctAgentTypes?: () => Promise<string[]> })
      .distinctAgentTypes?.()
      .then((types) => setKnownAgentTypes(types ?? []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshLists()
    const unsub = window.redlog.events.onNewBatch(() => {
      if (refreshTimer.current) return
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null
        refreshLists()
      }, 2000)
    })
    return () => {
      unsub()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [refreshLists])

  const setTargetId = useCallback((id: string | null) => {
    setFilter((prev) => ({ ...prev, targetId: id }))
  }, [])
  const setAgentType = useCallback((type: string | null) => {
    setFilter((prev) => ({ ...prev, agentType: type }))
  }, [])
  const setTimeRange = useCallback((range: TimeRange | null) => {
    setFilter((prev) => ({ ...prev, timeRange: range }))
  }, [])
  const clearAll = useCallback(() => setFilter(EMPTY), [])

  const activeCount = (filter.targetId ? 1 : 0)
    + (filter.agentType ? 1 : 0)
    + (filter.timeRange ? 1 : 0)

  const value = useMemo(() => ({
    filter, setTargetId, setAgentType, setTimeRange, clearAll,
    activeCount, knownTargets, knownAgentTypes
  }), [filter, setTargetId, setAgentType, setTimeRange, clearAll,
       activeCount, knownTargets, knownAgentTypes])

  return <FilterContext value={value}>{children}</FilterContext>
}

export function useSharedFilter(): FilterContextValue {
  return useContext(FilterContext)
}
