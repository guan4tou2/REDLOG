// Source-scoped pairs for the inspector. Original Events stay independently
// stored; conflicting keys remain unpaired instead of selecting a winner.
import type { RedLogEvent } from '../../../core/db/events'
import { operationPairKey } from '../../../core/operation-pair-key'

type PairEvent = Parameters<typeof operationPairKey>[0]

export interface ToolPairIndex<T extends PairEvent = RedLogEvent> {
  calls: Map<string, T>
  results: Map<string, T>
  conflicts: Set<string>
}

export function buildToolPairIndex<T extends PairEvent>(events: readonly T[]): ToolPairIndex<T> {
  const calls = new Map<string, T>()
  const results = new Map<string, T>()
  const conflicts = new Set<string>()
  for (const event of events) {
    if (event.agentType !== 'agent' || !event.data) continue
    const key = operationPairKey(event)
    const map = event.data.subtype === 'tool_call' ? calls : event.data.subtype === 'tool_result' ? results : null
    if (!key || !map) continue
    const previous = map.get(key)
    if (!previous) map.set(key, event)
    else if (JSON.stringify(previous.data) !== JSON.stringify(event.data)) conflicts.add(key)
  }
  return { calls, results, conflicts }
}

/** A loaded partner only. Absence says nothing about execution outcome or
 * whether an unloaded page contains it; C1 query resolution remains required. */
export function pairedToolHalf<T extends PairEvent>(
  selected: T,
  index: ToolPairIndex<T>
): { kind: 'call' | 'result'; data: Record<string, unknown> } | undefined {
  const key = operationPairKey(selected)
  if (!key || !selected.data || index.conflicts.has(key)) return undefined
  if (selected.data.subtype === 'tool_call') {
    const result = index.results.get(key)
    return result?.data ? { kind: 'result', data: result.data } : undefined
  }
  if (selected.data.subtype === 'tool_result') {
    const call = index.calls.get(key)
    return call?.data ? { kind: 'call', data: call.data } : undefined
  }
  return undefined
}
