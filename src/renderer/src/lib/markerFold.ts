// What a marker says now, given what it said when it was written and every
// amendment since (docs/DESIGN-core-and-capture.md §1, design turn 8b).
//
// The core promise is 紀錄可修、不可篡改 — a record can be corrected, and the
// correction cannot hide the original. So there is no edit: an amendment is its
// own chained event that names the marker it revises, and the marker an operator
// reads is a fold over the pair. Both halves stay in the chain, in order, and a
// reviewer can always ask what the finding said before someone changed it.
//
// The fold is pure and lives in the renderer because the two bundles share no
// module graph (lib/defaults.ts, test/redaction-boundary.test.ts). Main
// validates the shape of an amendment; it does not fold.

import type { RedLogEvent } from '../../../core/db/events'
import { compareMonotonicNs } from './eventOrder'

/** The severity vocabulary a marker actually uses (EventMarker.tsx). Duplicated
 *  in src/core/marker-amend.ts because main cannot import this file; a test
 *  reads both sources and asserts the two lists are equal. */
export const MARKER_SEVERITIES = ['info', 'important', 'critical'] as const
export type MarkerSeverity = (typeof MARKER_SEVERITIES)[number]

/** The three fields an amendment may carry. Everything else about a marker is
 *  fixed: `atTimestamp` is where the operator pointed, `category` is outside
 *  what turn 8b opened, and the envelope (time, operator, hash) is the record
 *  itself. Moving any of them would be moving evidence rather than correcting a
 *  description of it. */
// `url` is deliberately absent: it is where the mark POINTS, the web analogue
// of `atTimestamp`, and moving it is moving the evidence rather than correcting
// a description of it. docs/UIUX-STANDARD.md §20 rules it immutable.
export const AMENDABLE_FIELDS = ['title', 'severity', 'notes'] as const
export type AmendableField = (typeof AMENDABLE_FIELDS)[number]

export interface MarkerValues {
  title: string
  severity: string
  notes: string
}

export interface FieldChange {
  field: AmendableField
  from: unknown
  to: unknown
}

export interface AmendmentEntry {
  event: RedLogEvent
  /** Empty when the row is a structurally valid amendment that carries nothing
   *  applicable — it still counts and still shows, because a count that
   *  disagrees with the chain is the app telling the operator a smaller number
   *  than the record holds. */
  changes: FieldChange[]
}

export interface MarkerFold {
  effective: MarkerValues
  amendCount: number
  history: AmendmentEntry[]
}

const data = (e: RedLogEvent): Record<string, unknown> => (e.data ?? {}) as Record<string, unknown>

/** An amendment row. Structural, not semantic: `subtype: 'amended'` plus a
 *  string `markerId` is what makes a row addressed at another marker, and every
 *  marker consumer must test this FIRST — an amendment carries `title` and
 *  `severity` under the same names as a marker, so anything that reads
 *  `data.title` without asking renders a correction as a second finding. */
export function isMarkerAmendment(e: RedLogEvent): boolean {
  const d = data(e)
  return e.agentType === 'marker' && d.subtype === 'amended' && typeof d.markerId === 'string'
}

/** A marker that can be amended. Deliberately the complement of
 *  `isMarkerAmendment` rather than "a marker with no subtype": `/api/events` and
 *  plugin `appendEvent` both write marker rows verbatim, so markers carrying
 *  some other subtype exist in the wild and refusing to amend them would make
 *  the feature unavailable exactly where the record is least controlled. */
export function isMarkerOriginal(e: RedLogEvent): boolean {
  return e.agentType === 'marker' && !isMarkerAmendment(e)
}

/** Which of the three fields an amendment actually carries, in a fixed order. */
export function amendedFields(e: RedLogEvent): AmendableField[] {
  const d = data(e)
  return AMENDABLE_FIELDS.filter((f) => d[f] !== undefined)
}

/**
 * Chain order for two amendments.
 *
 * Deliberately not keyed on wall clock, which is where this differs from
 * Timeline's display order: `timestamp` regresses on an NTP correction — which
 * is why the DB pages by `created_at` — and "the latest correction wins" has to
 * mean the one written last, not the one whose clock read highest.
 *
 * The monotonic comparison itself is shared with the timeline (lib/eventOrder),
 * so the two cannot disagree about which of two events came first.
 */
export function compareAmendments(a: RedLogEvent, b: RedLogEvent): number {
  const mono = compareMonotonicNs(a.monotonicNs, b.monotonicNs)
  if (mono !== 0) return mono
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Group amendment rows by the marker each one names, in chain order. Rows that
 *  are not amendments are dropped; the map is never keyed by an amendment's own
 *  id, so an amendment can never be mistaken for a marker with a history. */
export function groupAmendments(events: readonly RedLogEvent[]): Map<string, RedLogEvent[]> {
  const byMarker = new Map<string, RedLogEvent[]>()
  for (const e of events) {
    if (!isMarkerAmendment(e)) continue
    const id = String(data(e).markerId)
    const list = byMarker.get(id)
    if (list) list.push(e)
    else byMarker.set(id, [e])
  }
  for (const list of byMarker.values()) list.sort(compareAmendments)
  return byMarker
}

const applicable = (field: AmendableField, value: unknown): boolean => {
  if (field === 'severity') return MARKER_SEVERITIES.includes(value as MarkerSeverity)
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The effective marker, its amendment count, and the per-amendment diff.
 *
 * `amendCount` counts every row addressed at this marker; whether a row's
 * *values* apply is a separate question. A plugin or a REST client can write a
 * structurally valid amendment carrying nonsense, and 「已修訂 2 次」 while three
 * amendment rows sit in the chain would be the app disagreeing with the record
 * it exists to keep.
 *
 * Pure: neither the original nor any amendment is mutated, and `effective` is a
 * fresh object.
 */
export function foldMarker(original: RedLogEvent, amendments: readonly RedLogEvent[]): MarkerFold {
  const od = data(original)
  const effective: MarkerValues = {
    title: typeof od.title === 'string' ? od.title : '',
    severity: typeof od.severity === 'string' ? od.severity : 'info',
    notes: typeof od.notes === 'string' ? od.notes : ''
  }
  const mine = amendments
    .filter((e) => isMarkerAmendment(e) && data(e).markerId === original.id)
    .slice()
    .sort(compareAmendments)

  const history: AmendmentEntry[] = []
  for (const e of mine) {
    const d = data(e)
    const changes: FieldChange[] = []
    for (const field of AMENDABLE_FIELDS) {
      const value = d[field]
      if (value === undefined || !applicable(field, value)) continue
      const from = effective[field]
      const to = field === 'severity' ? String(value) : (value as string)
      if (from === to) continue
      changes.push({ field, from, to })
      effective[field] = to
    }
    history.push({ event: e, changes })
  }
  return { effective, amendCount: mine.length, history }
}

/** Fold every marker in one pass over a mixed event list — the shape the
 *  Timeline needs, where originals and amendments arrive interleaved. */
export function foldAllMarkers(events: readonly RedLogEvent[]): Map<string, MarkerFold> {
  const byMarker = groupAmendments(events)
  const folds = new Map<string, MarkerFold>()
  for (const e of events) {
    if (!isMarkerOriginal(e)) continue
    const mine = byMarker.get(e.id)
    if (!mine) continue
    folds.set(e.id, foldMarker(e, mine))
  }
  return folds
}

/** What an operator's draft actually changes about the marker in front of them.
 *  The Inspector uses it as the no-op guard: an empty diff writes nothing, so
 *  opening the editor and pressing commit does not put a vacuous row in the
 *  chain. Compared against the EFFECTIVE values, never the original's — the
 *  operator is editing what they can see. */
export function diffAgainst(effective: MarkerValues, draft: Partial<MarkerValues>): Partial<MarkerValues> {
  const out: Partial<MarkerValues> = {}
  for (const field of AMENDABLE_FIELDS) {
    const raw = draft[field]
    if (raw === undefined) continue
    const value = field === 'notes' ? raw : raw.trim()
    if (!applicable(field, value)) continue
    if (value === effective[field]) continue
    out[field] = value
  }
  return out
}
