import type { RedLogEvent } from '../../../core/db/event-types'

// Folding a tool's traffic under the command that produced it.
//
// A fold is a CAUSAL CLAIM, and this record goes to a client. The constitution
// (VII) requires a grouped Activity to preserve references to its source
// events; II requires a label to describe what the system actually knows. So
// there is exactly one rule here and it is not a heuristic:
//
//   A child is an event whose `_causes` names a parent in this list.
//
// Nothing else. No User-Agent matching, no time windows, no "same host and
// close together". `causes-resolver.ts` already drew that line for file
// events and wrote the reason down — cwd and time overlap is "an
// investigation hint, not proof" — and kept it out of `_causes` deliberately.
// A fold is not a hint. It is the app asserting, in a collapsed row a reader
// may never open, that these 920 requests were made by that command.
//
// The failure mode this avoids is specific: the operator's own manual
// `POST /admin/delete?confirm=1` lands inside a dirb run's time window, folds
// under it, and the collapsed row reads "automated enumeration, 920 flows".
// What the client's counsel sees is a scan, not a destructive request someone
// typed. Under the rule above that cannot happen — a browser request carries
// no `_causes` edge to the command, so it stays where it is.
//
// DISPLAY ONLY. Nothing here reaches the export: `timeline` format is a time
// slice of events and carries no grouping. The chain covers events, not
// groupings, so a verifier cannot check this layer — which is the other
// reason it must never assert more than `_causes` already records.

export interface Fold {
  parent: RedLogEvent
  children: RedLogEvent[]
}

export type FoldRow =
  | { kind: 'event'; event: RedLogEvent }
  | { kind: 'fold'; fold: Fold }

/** Fewer than this and folding costs more than it saves: it hides rows the
 *  operator could already see, to replace them with a row about them. */
export const MIN_FOLD_CHILDREN = 3

/**
 * Events that must stay on the surface whatever produced them.
 *
 * Out-of-scope and errors because they are the reason to look at all; a
 * collapsed anomaly is an anomaly nobody sees. Markers, loot and screenshots
 * because the operator made them deliberately, and anything a person reached
 * out and touched is not noise to be summarised. The authentication shift —
 * a Set-Cookie, a 401 that becomes a 200 — because that is the moment access
 * changed, and it is usually buried in exactly the kind of run that folds.
 */
export function neverFold(e: RedLogEvent): boolean {
  const d = (e.data ?? {}) as Record<string, unknown>
  if (d.inScope === false || d.violation === true) return true
  if (typeof d.exitCode === 'number' && d.exitCode !== 0) return true
  if (d.severity === 'critical' || d.severity === 'important') return true
  if (['marker', 'loot', 'scope', 'screenshot', 'credential_use'].includes(e.agentType)) return true
  if (Array.isArray(d.set_cookies) && d.set_cookies.length > 0) return true
  if (d.subtype === 'cookie_change') return true
  if (typeof d.status === 'number' && d.status === 401) return true
  return false
}

const causesOf = (e: RedLogEvent): string[] => {
  const c = (e.data as { _causes?: unknown } | undefined)?._causes
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Fold `events` into parents and their recorded children, preserving order.
 *
 * `annotated` and `selected` are events the operator has reached for — a note
 * they wrote, the row they have open. Those never fold either: a row the
 * person is looking at must not disappear underneath them.
 */
export function foldByCause(
  events: readonly RedLogEvent[],
  opts: { annotated?: ReadonlySet<string>; selected?: string | null } = {}
): FoldRow[] {
  const annotated = opts.annotated ?? new Set<string>()
  const present = new Map(events.map((e) => [e.id, e]))
  const childrenOf = new Map<string, RedLogEvent[]>()
  const claimed = new Set<string>()

  for (const e of events) {
    if (neverFold(e) || annotated.has(e.id) || e.id === opts.selected) continue
    // The first cause that is itself in this list. An event with several
    // causes belongs under one of them, not duplicated under each: a reader
    // counting rows must not count the same request twice.
    const parentId = causesOf(e).find((id) => present.has(id) && id !== e.id)
    if (!parentId) continue
    const list = childrenOf.get(parentId)
    if (list) list.push(e)
    else childrenOf.set(parentId, [e])
  }

  // A parent that is itself somebody's child does not start a fold. Two levels
  // of collapse hides a row behind a row behind a summary, and the operator
  // who expands the outer one still cannot see what they came for.
  for (const [parentId, kids] of childrenOf) {
    if (kids.length >= MIN_FOLD_CHILDREN) for (const k of kids) claimed.add(k.id)
  }

  const rows: FoldRow[] = []
  for (const e of events) {
    if (claimed.has(e.id)) continue
    const kids = childrenOf.get(e.id)
    if (kids && kids.length >= MIN_FOLD_CHILDREN) rows.push({ kind: 'fold', fold: { parent: e, children: kids } })
    else rows.push({ kind: 'event', event: e })
  }
  return rows
}

/** `200×12 · 301×4 · 404×904`, newest status classes first by count. */
export function statusSummary(children: readonly RedLogEvent[]): Array<{ status: number; count: number }> {
  const counts = new Map<number, number>()
  for (const c of children) {
    const s = (c.data as { status?: unknown } | undefined)?.status
    if (typeof s === 'number') counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status - b.status)
}
