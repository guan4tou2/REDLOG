import type { RedLogEvent } from './db/events'
import { eventBus } from './event-bus'
import { countActiveScopeObservations } from './scope-recompute-run'
import { countsAsStandingVerdict } from './scope-observation-standing'

// StatusBar and Sidebar both ask for the violation count on EVERY captured
// event, so this cannot be a query per event during a scan. Cached, and dropped
// only when a row that could change it lands.
let cachedObservationCount: number | null = null

export function activeObservationCount(): number {
  if (cachedObservationCount === null) cachedObservationCount = countActiveScopeObservations()
  return cachedObservationCount
}

export function invalidateObservationCount(): void { cachedObservationCount = null }

// A scope row that can change the count: a withdrawal, a recompute, or a
// violation record. In-scope verdicts are the one scope row that cannot — they
// are written once per request as the adherence counter's positive proof, and
// dropping the cache for each would rescan every scope row per request.
eventBus.on('event', (e: RedLogEvent) => {
  if (e.agentType !== 'system') return
  const subtype = e.data?.subtype
  if (subtype === 'scope_cleared' || subtype === 'scope_recomputed' || countsAsStandingVerdict(e.data ?? {})) {
    invalidateObservationCount()
  }
})
