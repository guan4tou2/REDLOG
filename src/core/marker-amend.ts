// Writing a correction to a marker (docs/DESIGN-core-and-capture.md §1, design
// turn 8b).
//
// There is no edit. The `events` table refuses UPDATE and DELETE outright — two
// triggers reinstalled on every open (db/events.ts) — and that refusal is the
// point rather than an obstacle to route around. So a correction is its own
// chained event that names the marker it revises, and the marker an operator
// reads is a fold over the pair (src/renderer/src/lib/markerFold.ts). What the
// finding said before someone changed it stays in the chain, signed, for as long
// as the chain does.
//
// This module validates structure and writes the row. It deliberately does NOT
// decide whether a change is meaningful: "the draft matches what is on screen"
// is a question about what the operator is looking at, so the Inspector answers
// it before calling, and main never folds.

import { insertEvent, queryEventById, type RedLogEvent } from './db/events'
import { redactFields } from './redaction'

/** Must equal MARKER_SEVERITIES in src/renderer/src/lib/markerFold.ts. The two
 *  bundles share no module graph, so the list is written twice and a test reads
 *  both source files to assert they agree. */
export const MARKER_SEVERITIES = ['info', 'important', 'critical'] as const

/** The three fields turn 8b opens. Everything else about a marker is the record
 *  rather than a description of it: `atTimestamp` is where the operator pointed,
 *  and the envelope (time, operator, hash) is what makes the row evidence. */
export const AMENDABLE_FIELDS = ['title', 'severity', 'notes'] as const

export type AmendError =
  | 'not-found'
  | 'not-a-marker'
  | 'invalid-changes'

export type AmendResult =
  | { ok: true; event: RedLogEvent }
  | { ok: false; error: AmendError; detail?: string }

export interface AmendChanges {
  title?: unknown
  severity?: unknown
  notes?: unknown
}

/**
 * Append one amendment for `markerId`.
 *
 * Refusals are explicit and named, never silent drops. An unknown key is an
 * error rather than something quietly ignored — the same drop-by-omission that
 * lost `atTimestamp` in `marker:create` for several releases, where the caller
 * sent a field, the handler rebuilt the payload without it, and nothing said so.
 */
export function amendMarker(
  markerId: string,
  changes: AmendChanges,
  opts: { engagementId?: string; operatorId?: string }
): AmendResult {
  const original = queryEventById(markerId)
  if (!original) return { ok: false, error: 'not-found' }
  if (original.agentType !== 'marker') return { ok: false, error: 'not-a-marker' }
  // Amending an amendment would make the fold a graph walk and the history a
  // tree, for no gain: correcting a correction is just another correction of
  // the marker. Refusing it keeps "what does this marker say now" a list fold.
  const od = (original.data ?? {}) as Record<string, unknown>
  if (od.subtype === 'amended') {
    return { ok: false, error: 'not-a-marker', detail: 'amend the marker, not one of its amendments' }
  }

  const unknown = Object.keys(changes).filter((k) => !(AMENDABLE_FIELDS as readonly string[]).includes(k))
  if (unknown.length > 0) {
    return { ok: false, error: 'invalid-changes', detail: `unknown field(s): ${unknown.join(', ')}` }
  }

  const payload: Record<string, unknown> = {}
  for (const field of AMENDABLE_FIELDS) {
    const value = changes[field]
    if (value === undefined) continue
    if (field === 'severity') {
      if (!(MARKER_SEVERITIES as readonly unknown[]).includes(value)) {
        return { ok: false, error: 'invalid-changes', detail: `severity must be one of ${MARKER_SEVERITIES.join(' / ')}` }
      }
      payload.severity = value
      continue
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, error: 'invalid-changes', detail: `${field} must be a non-empty string` }
    }
    payload[field] = field === 'title' ? value.trim() : value
  }
  if (Object.keys(payload).length === 0) {
    return { ok: false, error: 'invalid-changes', detail: 'no amendable field supplied' }
  }

  const event = insertEvent('marker', redactFields({
    subtype: 'amended',
    // The typed reference the fold keys on. `_causes` carries the same link for
    // the focus chain, but it is an array whose order is not a contract, so the
    // fold must not have to guess which entry is the marker.
    markerId,
    _causes: [markerId],
    ...payload
  }, ['title', 'notes']), {
    engagementId: opts.engagementId,
    operatorId: opts.operatorId,
    // Inherited so an amendment is filtered, exported and scoped with the
    // marker it belongs to rather than escaping a target-scoped export.
    targetId: original.targetId ?? undefined
  })
  if (!event) return { ok: false, error: 'invalid-changes', detail: 'insert refused (duplicate window)' }
  return { ok: true, event }
}
