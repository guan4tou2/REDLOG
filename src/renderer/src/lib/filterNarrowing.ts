import type { EventFilter } from '../../../core/db/event-queries'

/** Whether the filter bar's conditions are narrowing what a view reads: the
 *  target, source, time range, scope and chained-only chips, which is the set
 *  its badge counts. Personal-traffic hiding is not one: it is on by default
 *  and the bar has no chip for it unless personal domains are set. An empty
 *  list owes its emptiness to the conditions only when this is true. */
export function narrowsEvents(filter: EventFilter | undefined): boolean {
  if (!filter) return false
  return !!(filter.targetId || filter.agentType || filter.since != null || filter.before != null
    || filter.inScopeOnly || filter.tier === 'chained')
}
