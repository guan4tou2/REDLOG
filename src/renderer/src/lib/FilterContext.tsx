import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { EventFilter } from '../../../core/db/events'
import { formatTime } from './time'
import { agentTypeLabel } from './timelineDomain'

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
  /** Spec 033: "chained only" is a condition of the investigation, applied
   *  by every view's query. Not persisted, like the rest of this state. */
  tier: 'all' | 'chained'
}

/** Convert UI state into the canonical cross-process query contract. */
export function toEventFilter(filter: SharedFilter): EventFilter {
  return {
    ...(filter.targetId ? { targetId: filter.targetId } : {}),
    ...(filter.agentType ? { agentType: filter.agentType } : {}),
    ...(filter.timeRange?.since != null ? { since: filter.timeRange.since } : {}),
    ...(filter.timeRange?.before != null ? { before: filter.timeRange.before } : {}),
    ...(filter.inScopeOnly ? { inScopeOnly: true } : {}),
    ...(filter.hidePersonal ? { hidePersonal: true } : {}),
    ...(filter.tier === 'chained' ? { tier: 'chained' as const } : {})
  }
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

export function formatTimeRange(range: TimeRange, t: Translate): string {
  if (range.since && !range.before) {
    return t('filter.since', { time: formatTime(range.since, { seconds: false }) })
  }
  if (!range.since && range.before) {
    return t('filter.before', { time: formatTime(range.before, { seconds: false }) })
  }
  if (range.since && range.before) {
    return `${formatTime(range.since, { seconds: false })} – ${formatTime(range.before, { seconds: false })}`
  }
  return ''
}

/** How each active condition is named: the FilterBar's chips, and any view
 *  that has to say which conditions explain what it shows. Personal traffic
 *  narrows only once personal domains are configured, which is also when the
 *  FilterBar shows its chip, so it is named only when `personalDomains` is
 *  passed and non-empty. */
export function conditionLabels(filter: SharedFilter, t: Translate, opts: { personalDomains?: string[] } = {}): {
  target?: string; type?: string; time?: string; inScope?: string; tier?: string; personal?: string
} {
  return {
    ...(filter.targetId ? { target: `${t('filter.target')}: ${filter.targetId}` } : {}),
    // "Type: Shell", not the stored `shell` (Spec 034); the FilterBar puts the stored type in the tooltip.
    ...(filter.agentType ? { type: `${t('filter.type')}: ${agentTypeLabel(filter.agentType, t)}` } : {}),
    ...(filter.timeRange ? { time: `${t('filter.time')}: ${formatTimeRange(filter.timeRange, t)}` } : {}),
    ...(filter.inScopeOnly ? { inScope: t('filter.inScopeOnly') } : {}),
    ...(filter.tier === 'chained' ? { tier: t('filter.chainedOnly') } : {}),
    ...(filter.hidePersonal && opts.personalDomains?.length ? { personal: t('filter.personalHidden') } : {})
  }
}

/** Every condition narrowing what a view shows, named. Empty means nothing
 *  narrows it, so an empty view is an empty project. */
export const describeActiveConditions = (
  filter: SharedFilter, t: Translate, opts: { personalDomains?: string[] } = {}
): string[] =>
  Object.values(conditionLabels(filter, t, opts)).filter((l): l is string => !!l)

interface FilterContextValue {
  filter: SharedFilter
  setTargetId: (id: string | null) => void
  setAgentType: (type: string | null) => void
  setTimeRange: (range: TimeRange | null) => void
  setInScopeOnly: (v: boolean) => void
  setHidePersonal: (v: boolean) => void
  setTier: (tier: SharedFilter['tier']) => void
  clearAll: () => void
  activeCount: number
  knownTargets: Array<{ target: string; eventCount: number }>
  knownAgentTypes: string[]
  scopeTargets: string[]
  scopeExcludeTargets: string[]
  personalDomains: string[]
}

const EMPTY: SharedFilter = { targetId: null, agentType: null, timeRange: null, inScopeOnly: false, hidePersonal: true, tier: 'all' }

const FilterContext = createContext<FilterContextValue>({
  filter: EMPTY,
  setTargetId: () => {},
  setAgentType: () => {},
  setTimeRange: () => {},
  setInScopeOnly: () => {},
  setHidePersonal: () => {},
  setTier: () => {},
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
  const setTier = useCallback((tier: SharedFilter['tier']) => {
    setFilter((prev) => ({ ...prev, tier }))
  }, [])
  const clearAll = useCallback(() => setFilter(EMPTY), [])

  const activeCount = (filter.targetId ? 1 : 0)
    + (filter.agentType ? 1 : 0)
    + (filter.timeRange ? 1 : 0)
    + (filter.inScopeOnly ? 1 : 0)
    + (filter.tier === 'chained' ? 1 : 0)

  const value = useMemo(() => ({
    filter, setTargetId, setAgentType, setTimeRange, setInScopeOnly, setHidePersonal, setTier, clearAll,
    activeCount, knownTargets, knownAgentTypes, scopeTargets, scopeExcludeTargets, personalDomains
  }), [filter, setTargetId, setAgentType, setTimeRange, setInScopeOnly, setHidePersonal, setTier, clearAll,
       activeCount, knownTargets, knownAgentTypes, scopeTargets, scopeExcludeTargets, personalDomains])

  return <FilterContext value={value}>{children}</FilterContext>
}

export function useSharedFilter(): FilterContextValue {
  return useContext(FilterContext)
}
