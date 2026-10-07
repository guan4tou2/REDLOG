// Has this engagement captured anything yet, and has it ever had a logged tier?
//
// Two questions, both read-only — nothing here writes a row.
//
// This used to answer eight, because §22 hid a sidebar page until the record
// held the noun it was named after. That is gone: hiding cost a hint line in
// the nav to explain the absence, a settings checkbox to undo it, a
// localStorage module, a hook, and it still confused the app's own author
// twice in one afternoon. What it bought was not showing eight rows.
//
// The two that survive are not page hiding. `evidenceSeen` decides whether the
// dashboard says what to do instead of showing empty panels, and `loggedEver`
// decides whether the Inspector draws a tier chip — a distinction worth
// nothing to a project that has only ever had one tier. Both are statements
// about the data, neither hides a way in.
//
// Two constraints still shape them.
//
// BOUNDED. Each probe is a `LIMIT 1` an index can serve, because this runs on
// the main thread on project open and again when a row arrives that could
// answer a question still open. The question is "is there one", not "how many".
//
// MONOTONIC. A flag that has gone true is never re-probed and never goes back
// to false. Retention prunes the logged tier after thirty days, and a screen
// reverting because its evidence aged out would read as the evidence having
// been destroyed.

import { getDB } from './db/index'
import { EVIDENCE_SQL } from './db/events'

export interface VisibilitySignals {
  evidenceSeen: boolean
  loggedEver: boolean
}

export const EMPTY_VISIBILITY_SIGNALS: VisibilitySignals = {
  evidenceSeen: false,
  loggedEver: false
}

let cache: VisibilitySignals = { ...EMPTY_VISIBILITY_SIGNALS }

/** Called where `activeProject` is assigned or cleared. The flags describe one
 *  engagement and must not survive into the next. */
export function resetVisibilitySignalsCache(): void {
  cache = { ...EMPTY_VISIBILITY_SIGNALS }
}

const exists = (sql: string, params: unknown[] = []): boolean => {
  try {
    return getDB().prepare(`SELECT 1 AS x FROM ${sql} LIMIT 1`).get(...params) !== undefined
  } catch {
    // A probe failing must never take the shell down with it; the caller
    // treats a missing signal as "not yet".
    return false
  }
}

/**
 * Both flags, probing only what is still unanswered.
 *
 * Called on project open and then on a debounced batch of incoming rows, so
 * the steady-state cost on a mature project is zero queries: both are already
 * true and nothing is asked again.
 */
export function getVisibilitySignals(): VisibilitySignals {
  const next: VisibilitySignals = { ...cache }

  if (!next.evidenceSeen) {
    // Any logged row is evidence by construction — the logged tier holds only
    // captured traffic. On the chained side the predicate has to be positive;
    // see EVIDENCE_SQL for why "not housekeeping" is not good enough.
    next.evidenceSeen = exists('events_logged') || exists(`events WHERE ${EVIDENCE_SQL}`)
  }
  if (!next.loggedEver) {
    // The audit row survives the sweep that deletes what it describes, so a
    // project whose logged tier has been fully pruned still knows it had one.
    next.loggedEver = exists('events_logged')
      || exists(`events WHERE agent_type = 'system' AND subtype = 'retention_pruned_logged'`)
  }

  cache = next
  return { ...next }
}
