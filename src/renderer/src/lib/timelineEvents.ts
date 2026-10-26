import { operationPairKey } from '../../../core/operation-pair-key'

// Pure event-shaping helpers pulled out of Timeline.tsx (D1 decomposition):
// collapsing agent turns, collapsing command_start/end pairs, and the literal
// "fuzzy" score the palette + filter share. No React, no DOM — so they can be
// unit-tested directly, which the 5000-line component never allowed. Behaviour
// is identical to the previous inline definitions; test/timeline-events.test.ts
// is the guard. RedLogEvent is an ambient global (renderer env.d.ts).

/** v0.9.3 U3: per-turn agent subtypes hidden when "collapse agent sessions" is
 *  on. `transcript_snapshot` / `session_end` stay visible — they ARE the
 *  session-level view — and housekeeping (schema_drift / parent_missing /
 *  transcript_compacted) stays visible so operators still see anomalies. */
const COLLAPSIBLE_AGENT_SUBTYPES = new Set([
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'thinking',
  'compact_summary',
  'tool_interrupted',
  'away_summary'
])

export function isCollapsibleAgentTurn(e: RedLogEvent): boolean {
  return e.agentType === 'agent'
    && COLLAPSIBLE_AGENT_SUBTYPES.has(String(e.data?.subtype ?? ''))
}

export function filterAgentTurns(events: RedLogEvent[], collapse: boolean): RedLogEvent[] {
  if (!collapse) return events
  return events.filter((e) => !isCollapsibleAgentTurn(e))
}

/** Fold only an unambiguous, source-scoped command exchange. Missing identity
 * keeps the original Events visible; PID and text never substitute for it. */
export function collapseCommandPairs(events: RedLogEvent[]): RedLogEvent[] {
  const closed = new Map<string, { data: Record<string, unknown>; conflict: boolean }>()
  for (const event of events) {
    if (event.agentType !== 'shell' || event.data?.subtype !== 'command_end') continue
    const key = operationPairKey(event)
    if (!key) continue
    const previous = closed.get(key)
    if (!previous) closed.set(key, { data: event.data, conflict: false })
    else if (JSON.stringify(previous.data) !== JSON.stringify(event.data)) previous.conflict = true
  }
  return events.filter(event => {
    if (event.agentType !== 'shell' || event.data?.subtype !== 'command_start') return true
    const key = operationPairKey(event)
    const end = key ? closed.get(key) : undefined
    return !end || end.conflict || typeof event.data.command !== 'string' || end.data.command !== event.data.command
  })
}

/** Compact duration for a compressed gap label — "2h", "45m". */
export function formatGap(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const rem = min % 60
  return rem ? `${h}h${rem}m` : `${h}h`
}
