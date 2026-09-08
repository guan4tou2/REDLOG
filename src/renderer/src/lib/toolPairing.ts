// A tool_call and its tool_result are two separate chained events — each
// independently hashed and timestamped, so the log records the real call→return
// latency and ordering, and neither can be silently rewritten to fake the other.
// That fidelity is why they aren't merged at capture time. The cost is that the
// exchange lands as two dots on the timeline, so selecting one shows only half.
// These pure helpers reunite the halves for the detail panel, matched by
// tool_use_id, without touching the stored events.

import type { RedLogEvent } from '../../../core/db/events'

export interface ToolPairIndex {
  calls: Map<string, RedLogEvent>
  results: Map<string, RedLogEvent>
}

/** Index the loaded events by tool_use_id into call and result halves. A later
 *  event with the same id wins (Map.set overwrites) — a tool_use_id is unique
 *  per exchange, so a collision only happens across a retry, where the newer
 *  turn is the one an operator means. Events without a tool_use_id, or whose
 *  subtype is neither tool_call nor tool_result, are skipped. */
export function buildToolPairIndex(events: readonly RedLogEvent[]): ToolPairIndex {
  const calls = new Map<string, RedLogEvent>()
  const results = new Map<string, RedLogEvent>()
  for (const e of events) {
    const d = e.data as Record<string, unknown> | undefined
    const id = d && typeof d.tool_use_id === 'string' ? (d.tool_use_id as string) : undefined
    if (!id) continue
    if (d!.subtype === 'tool_call') calls.set(id, e)
    else if (d!.subtype === 'tool_result') results.set(id, e)
  }
  return { calls, results }
}

/** The other half of a tool exchange for the detail panel: given the selected
 *  event, return its paired tool_result (when a tool_call is selected) or its
 *  tool_call (when a tool_result is selected), matched by tool_use_id. Returns
 *  undefined when the event isn't a tool turn, carries no tool_use_id, or its
 *  partner hasn't been paged into the index — all graceful no-ops that leave the
 *  panel showing just the selected half. */
export function pairedToolHalf(
  sel: RedLogEvent,
  index: ToolPairIndex
): { kind: 'call' | 'result'; data: Record<string, unknown> } | undefined {
  const d = sel.data as Record<string, unknown> | undefined
  const id = d && typeof d.tool_use_id === 'string' ? (d.tool_use_id as string) : undefined
  if (!id) return undefined
  if (d!.subtype === 'tool_call') {
    const r = index.results.get(id)
    return r ? { kind: 'result', data: r.data as Record<string, unknown> } : undefined
  }
  if (d!.subtype === 'tool_result') {
    const c = index.calls.get(id)
    return c ? { kind: 'call', data: c.data as Record<string, unknown> } : undefined
  }
  return undefined
}
