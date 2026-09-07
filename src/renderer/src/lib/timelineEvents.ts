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

/** Drop a `command_start` when a matching `command_end` exists (same pid +
 *  command), so a completed command shows as one row, not two. An unmatched
 *  start (still running, or its end was pruned) stays. */
export function collapseCommandPairs(events: RedLogEvent[]): RedLogEvent[] {
  const closed = new Set<string>()
  for (const e of events) {
    if (e.agentType !== 'shell' || e.data?.subtype !== 'command_end') continue
    const key = `${e.data?.pid ?? ''}|${e.data?.command ?? ''}`
    closed.add(key)
  }
  return events.filter((e) => {
    if (e.agentType !== 'shell' || e.data?.subtype !== 'command_start') return true
    const key = `${e.data?.pid ?? ''}|${e.data?.command ?? ''}`
    return !closed.has(key)
  })
}

// v0.6.91 W1/W3: case-insensitive substring "score". Higher = better; earlier
// match position wins, then shorter-target-vs-query as tiebreak. Deliberately
// not a real fuzzy matcher (no gap tolerance) — the palette and filter both aim
// at literal identifiers (command names, hosts, subtypes), so a subsequence
// matcher's extra false positives aren't worth it.
export function fuzzyScore(target: string, q: string): number {
  if (!q) return 0
  if (!target) return -1
  const idx = target.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return -1
  return 1000 - idx - Math.max(0, target.length - q.length) * 0.05
}

/** Compact duration for a compressed gap label — "2h", "45m". */
export function formatGap(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const rem = min % 60
  return rem ? `${h}h${rem}m` : `${h}h`
}
