// Does this engagement contain the thing each noun is named after?
// (docs/UIUX-STANDARD.md §22, design turn 9b.)
//
// The renderer decides what to show; this only answers the eight existence
// questions it needs. Read-only — nothing here writes a row, and visibility is
// a projection of the record rather than a fact about it.
//
// Two constraints shape every query below.
//
// BOUNDED. Each probe is a `LIMIT 1` that an index can serve, because this runs
// on the main thread on project open and again whenever a row arrives that
// could open a gate. `SELECT COUNT(*)` and `SELECT DISTINCT` are both wrong
// here: the question is "is there one", not "how many".
//
// MONOTONIC. A flag that has gone true is never re-probed, and never goes back
// to false. Retention prunes the logged tier after thirty days, and a page
// disappearing because its evidence aged out would read as the evidence having
// been destroyed.

import { getDB } from './db/index'
import { EVIDENCE_SQL, HTTP_FLOW_SUBTYPES } from './db/events'

export interface VisibilitySignals {
  evidenceSeen: boolean
  transcriptSeen: boolean
  targetCount: 0 | 1 | 2
  lootSeen: boolean
  screenshotSeen: boolean
  markSeen: boolean
  httpFlowSeen: boolean
  loggedEver: boolean
}

export const EMPTY_VISIBILITY_SIGNALS: VisibilitySignals = {
  evidenceSeen: false,
  transcriptSeen: false,
  targetCount: 0,
  lootSeen: false,
  screenshotSeen: false,
  markSeen: false,
  httpFlowSeen: false,
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
    // treats a missing signal as "not yet", which only hides a page.
    return false
  }
}

/** Distinct command-derived targets, capped at two — the only two answers that
 *  matter, since 目標 unlocks at one and 範圍 at two.
 *
 *  Keyed to `agent_type = 'shell'` on purpose. The proxy addon stamps a target
 *  on every HTTP flow and DNS query, and the connection monitor on every
 *  established socket, so counting targets across all types would unlock both
 *  pages from a single browser page load with no command typed — the inverse of
 *  what §22 asks for. Two seeks on (agent_type, target_id). */
function countTargets(): 0 | 1 | 2 {
  try {
    const db = getDB()
    const first = db.prepare(
      `SELECT target_id AS t FROM events
       WHERE agent_type = 'shell' AND target_id IS NOT NULL AND target_id <> ''
       ORDER BY target_id LIMIT 1`
    ).get() as { t: string } | undefined
    if (!first) return 0
    const second = db.prepare(
      `SELECT target_id AS t FROM events
       WHERE agent_type = 'shell' AND target_id IS NOT NULL AND target_id <> '' AND target_id > ?
       ORDER BY target_id LIMIT 1`
    ).get(first.t) as { t: string } | undefined
    return second ? 2 : 1
  } catch {
    return 0
  }
}

/**
 * The eight flags, probing only the gates still closed.
 *
 * Called on project open and then on a debounced batch of incoming rows, so the
 * steady-state cost on a mature project is zero queries: every flag is already
 * true and nothing is asked again.
 */
export function getVisibilitySignals(): VisibilitySignals {
  const holes = HTTP_FLOW_SUBTYPES.map(() => '?').join(',')
  const next: VisibilitySignals = { ...cache }

  if (!next.evidenceSeen) {
    // Any logged row is evidence by construction — the logged tier holds only
    // captured traffic. On the chained side the predicate has to be positive;
    // see EVIDENCE_SQL for why "not housekeeping" is not good enough.
    next.evidenceSeen = exists('events_logged') || exists(`events WHERE ${EVIDENCE_SQL}`)
  }
  if (!next.transcriptSeen) {
    next.transcriptSeen =
      exists(`events WHERE agent_type = 'shell' AND json_extract(data,'$.subtype') = 'command_end'`)
      || exists(`events WHERE agent_type = 'agent'`)
      || exists(`events_logged WHERE agent_type = 'agent'`)
  }
  if (next.targetCount < 2) next.targetCount = Math.max(next.targetCount, countTargets()) as 0 | 1 | 2
  if (!next.lootSeen) next.lootSeen = exists(`events WHERE agent_type = 'loot'`)
  if (!next.screenshotSeen) next.screenshotSeen = exists(`events WHERE agent_type = 'screenshot'`)
  // The 標記 page lists the quickmarks table and nothing else. A `marker` event
  // is a different store — and it is on the externally-postable allowlist, so
  // keying on it would let an outside tool unlock an empty page.
  if (!next.markSeen) next.markSeen = exists('quickmarks')
  if (!next.httpFlowSeen) {
    next.httpFlowSeen = exists(
      `events_logged WHERE agent_type = 'scanner' AND json_extract(data,'$.subtype') IN (${holes})`,
      [...HTTP_FLOW_SUBTYPES]
    )
  }
  if (!next.loggedEver) {
    // The audit row survives the sweep that deletes what it describes, so a
    // project whose logged tier has been fully pruned still knows it had one.
    next.loggedEver = exists('events_logged')
      || exists(`events WHERE agent_type = 'system' AND json_extract(data,'$.subtype') = 'retention_pruned_logged'`)
  }

  cache = next
  return { ...next }
}
