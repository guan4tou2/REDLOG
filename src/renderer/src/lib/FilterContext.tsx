import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { EventFilter } from '../../../core/db/events'

export interface TimeRange {
  since?: number
  before?: number
}

export interface SharedFilter {
  targetId: string | null
  agentType: string | null
  timeRange: TimeRange | null
  inScopeOnly: boolean
  hidePersonal: boolean
}

/** Convert UI state into the canonical cross-process query contract. */
export function toEventFilter(filter: SharedFilter): EventFilter {
  return {
    ...(filter.targetId ? { targetId: filter.targetId } : {}),
    ...(filter.agentType ? { agentType: filter.agentType } : {}),
    ...(filter.timeRange?.since != null ? { since: filter.timeRange.since } : {}),
    ...(filter.timeRange?.before != null ? { before: filter.timeRange.before } : {}),
    ...(filter.inScopeOnly ? { inScopeOnly: true } : {}),
    ...(filter.hidePersonal ? { hidePersonal: true } : {})
  }
}

interface FilterContextValue {
  filter: SharedFilter
  setTargetId: (id: string | null) => void
  setAgentType: (type: string | null) => void
  setTimeRange: (range: TimeRange | null) => void
  setInScopeOnly: (v: boolean) => void
  setHidePersonal: (v: boolean) => void
  clearAll: () => void
  activeCount: number
  knownTargets: Array<{ target: string; eventCount: number }>
  knownAgentTypes: string[]
  scopeTargets: string[]
  scopeExcludeTargets: string[]
  personalDomains: string[]
}

const EMPTY: SharedFilter = { targetId: null, agentType: null, timeRange: null, inScopeOnly: false, hidePersonal: true }

const FilterContext = createContext<FilterContextValue>({
  filter: EMPTY,
  setTargetId: () => {},
  setAgentType: () => {},
  setTimeRange: () => {},
  setInScopeOnly: () => {},
  setHidePersonal: () => {},
  clearAll: () => {},
  activeCount: 0,
  knownTargets: [],
  knownAgentTypes: [],
  scopeTargets: [],
  scopeExcludeTargets: [],
  personalDomains: []
})

export function FilterProvider({ children }: { children: ReactNode }): JSX.Element {
  const [filter, setFilter] = useState<SharedFilter>(EMPTY)
  const [knownTargets, setKnownTargets] = useState<Array<{ target: string; eventCount: number }>>([])
  const [knownAgentTypes, setKnownAgentTypes] = useState<string[]>([])
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const [scopeExcludeTargets, setScopeExcludeTargets] = useState<string[]>([])
  const [personalDomains, setPersonalDomains] = useState<string[]>([])

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
    const refreshScope = (): void => { window.redlog.config.get().then((c) => {
      const cfg = c as { scope?: { targets?: string[]; excludeTargets?: string[]; personalDomains?: string[] } } | null
      setScopeTargets(cfg?.scope?.targets ?? [])
      setScopeExcludeTargets(cfg?.scope?.excludeTargets ?? [])
      setPersonalDomains(cfg?.scope?.personalDomains ?? [])
    }).catch(() => {}) }
    refreshScope()
    window.addEventListener('redlog:config-saved', refreshScope)
    return () => window.removeEventListener('redlog:config-saved', refreshScope)
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
  const setInScopeOnly = useCallback((v: boolean) => {
    setFilter((prev) => ({ ...prev, inScopeOnly: v }))
  }, [])
  const setHidePersonal = useCallback((v: boolean) => {
    setFilter((prev) => ({ ...prev, hidePersonal: v }))
  }, [])
  const clearAll = useCallback(() => setFilter(EMPTY), [])

  const activeCount = (filter.targetId ? 1 : 0)
    + (filter.agentType ? 1 : 0)
    + (filter.timeRange ? 1 : 0)
    + (filter.inScopeOnly ? 1 : 0)

  const value = useMemo(() => ({
    filter, setTargetId, setAgentType, setTimeRange, setInScopeOnly, setHidePersonal, clearAll,
    activeCount, knownTargets, knownAgentTypes, scopeTargets, scopeExcludeTargets, personalDomains
  }), [filter, setTargetId, setAgentType, setTimeRange, setInScopeOnly, setHidePersonal, clearAll,
       activeCount, knownTargets, knownAgentTypes, scopeTargets, scopeExcludeTargets, personalDomains])

  return <FilterContext value={value}>{children}</FilterContext>
}

export function useSharedFilter(): FilterContextValue {
  return useContext(FilterContext)
}
