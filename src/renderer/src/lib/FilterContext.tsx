import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import type { EventFilter } from '../../../core/db/events'
import { formatTime, formatDate, formatDateTime } from './time'
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
  /** Spec 038: "chained only" is a condition of the investigation, applied
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

/** The same calendar day, in the zone the UI is displaying. Below that, the
 *  time of day is enough; across it, a bare `23:40 – 01:10` is a puzzle. */
const sameDisplayDay = (a: number, b: number): boolean => formatDate(a) === formatDate(b)

/** Never relative. The condition is a fixed window — a preset snapshots the
 *  last N hours at the moment it is clicked — so the chip has to print what
 *  the query actually holds. It used to repeat the button ("last 1h"), which
 *  stopped being true a minute later. */
export function formatTimeRange(range: TimeRange, t: Translate): string {
  const stamp = (ms: number, withDate: boolean): string =>
    withDate ? formatDateTime(ms, { seconds: false }) : formatTime(ms, { seconds: false })
  const today = Date.now()
  if (range.since && !range.before) {
    return t('filter.since', { time: stamp(range.since, !sameDisplayDay(range.since, today)) })
  }
  if (!range.since && range.before) {
    return t('filter.before', { time: stamp(range.before, !sameDisplayDay(range.before, today)) })
  }
  if (range.since && range.before) {
    const crossesDay = !sameDisplayDay(range.since, range.before)
    const notToday = !sameDisplayDay(range.since, today)
    if (crossesDay) {
      return `${formatDateTime(range.since, { seconds: false })} – ${formatDateTime(range.before, { seconds: false })}`
    }
    return notToday
      ? `${formatDate(range.since)} ${formatTime(range.since, { seconds: false })} – ${formatTime(range.before, { seconds: false })}`
      : `${formatTime(range.since, { seconds: false })} – ${formatTime(range.before, { seconds: false })}`
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

/** Whether the option lists behind the filter menus are loaded.
 *
 *  Empty and failed are not the same thing, and the menus used to render them
 *  identically: `refreshLists` and the scope read swallowed their rejections,
 *  so a failed first load left an empty menu that read as "this project has no
 *  targets", and a failed refresh left the previous values on screen with
 *  nothing to say they were stale. An operator choosing what to look at
 *  deserves to know which of those they are looking at. */
export type ListsStatus = 'loading' | 'ready' | 'error'

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
  /** Of the target/type menus. `error` keeps whatever loaded before. */
  listsStatus: ListsStatus
  /** Of the scope lists, which drive the in-scope and personal switches. */
  scopeStatus: ListsStatus
  /** Load the menus again, for the retry the operator is offered. */
  retryLists: () => void
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
  personalDomains: [],
  listsStatus: 'loading',
  scopeStatus: 'loading',
  retryLists: () => {}
})

export function FilterProvider({ children }: { children: ReactNode }): JSX.Element {
  const [filter, setFilter] = useState<SharedFilter>(EMPTY)
  const [knownTargets, setKnownTargets] = useState<Array<{ target: string; eventCount: number }>>([])
  const [knownAgentTypes, setKnownAgentTypes] = useState<string[]>([])
  const [scopeTargets, setScopeTargets] = useState<string[]>([])
  const [scopeExcludeTargets, setScopeExcludeTargets] = useState<string[]>([])
  const [personalDomains, setPersonalDomains] = useState<string[]>([])

  const [listsStatus, setListsStatus] = useState<ListsStatus>('loading')
  const [scopeStatus, setScopeStatus] = useState<ListsStatus>('loading')

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A late reply must not write into a provider that has gone away — the
  // provider unmounts when the project closes, so a reply in flight then
  // belongs to a project that is no longer open.
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])

  const refreshLists = useCallback(() => {
    // A failure keeps whatever loaded before rather than blanking the menus:
    // stale-and-labelled beats empty-and-silent, which reads as "no data".
    const targets = window.redlog.events.aggregateTargets()
      .then((rows) => {
        if (live.current) setKnownTargets(rows.map((r) => ({ target: r.target, eventCount: r.eventCount })))
      })
    const types = (window.redlog.events as { distinctAgentTypes?: () => Promise<string[]> })
      .distinctAgentTypes?.()
      .then((list) => { if (live.current) setKnownAgentTypes(list ?? []) })
      ?? Promise.resolve()
    void Promise.allSettled([targets, types]).then((results) => {
      if (!live.current) return
      setListsStatus(results.some((r) => r.status === 'rejected') ? 'error' : 'ready')
    })
  }, [])

  useEffect(() => {
    const refreshScope = (): void => { window.redlog.config.get().then((c) => {
      if (!live.current) return
      const cfg = c as { scope?: { targets?: string[]; excludeTargets?: string[]; personalDomains?: string[] } } | null
      setScopeTargets(cfg?.scope?.targets ?? [])
      setScopeExcludeTargets(cfg?.scope?.excludeTargets ?? [])
      setPersonalDomains(cfg?.scope?.personalDomains ?? [])
      setScopeStatus('ready')
    }).catch(() => { if (live.current) setScopeStatus('error') }) }
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

  const retryLists = useCallback(() => { setListsStatus('loading'); refreshLists() }, [refreshLists])

  const value = useMemo(() => ({
    filter, setTargetId, setAgentType, setTimeRange, setInScopeOnly, setHidePersonal, setTier, clearAll,
    activeCount, knownTargets, knownAgentTypes, scopeTargets, scopeExcludeTargets, personalDomains,
    listsStatus, scopeStatus, retryLists
  }), [filter, setTargetId, setAgentType, setTimeRange, setInScopeOnly, setHidePersonal, setTier, clearAll,
       activeCount, knownTargets, knownAgentTypes, scopeTargets, scopeExcludeTargets, personalDomains,
       listsStatus, scopeStatus, retryLists])

  return <FilterContext value={value}>{children}</FilterContext>
}

export function useSharedFilter(): FilterContextValue {
  return useContext(FilterContext)
}
