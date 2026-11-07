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

/** command_start rows whose source-scoped pair key has no command_end anywhere
 * in `events`. "Unfinished" is a statement about what was loaded, not about the
 * process: it may be running, interrupted, or ended outside this window, so
 * callers say "running / unknown", never "failed". A start with no pair key
 * cannot be matched at all and is left out rather than guessed at. */
export function unfinishedCommandIds(events: RedLogEvent[]): Set<string> {
  const ended = new Set<string>()
  for (const event of events) {
    if (event.agentType !== 'shell' || event.data?.subtype !== 'command_end') continue
    const key = operationPairKey(event)
    if (key) ended.add(key)
  }
  const out = new Set<string>()
  for (const event of events) {
    if (event.agentType !== 'shell' || event.data?.subtype !== 'command_start') continue
    const key = operationPairKey(event)
    if (key && !ended.has(key)) out.add(event.id)
  }
  return out
}

/** Compact duration for a compressed gap label — "2h", "45m". */
export function formatGap(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const rem = min % 60
  return rem ? `${h}h${rem}m` : `${h}h`
}

/** Sources the Timeline inspector has a reader of its own for. Everything else
 *  goes to the generic reader, so a new source needs no change to the core. */
export function hasSpecificEventDetail(e: Pick<RedLogEvent, 'agentType' | 'data'>): boolean {
  switch (e.agentType) {
    case 'shell': case 'agent': case 'scanner': case 'browser': case 'marker': case 'screenshot':
      return true
    case 'file_transfer':
      return e.data?.subtype === 'artifact_added'
    default:
      return false
  }
}

type InlineBody = { data?: string; encoding?: string } | undefined

/** An inline preview short enough to be shown in the body itself. */
const inlineText = (body: InlineBody): string | null =>
  body?.encoding === 'text' && typeof body.data === 'string' && body.data.length <= 65536 ? body.data : null

/** A body that is saved (a ref, or inline but too large to show) and so is read
 *  in the Reader rather than inline. */
export const hasSavedBody = (inline: InlineBody, ref: unknown): boolean =>
  !!(inline?.data || ref) && !inlineText(inline)

const hasFileRef = (value: unknown): boolean =>
  !!value && typeof (value as { file?: unknown }).file === 'string'

/** Events with saved content the Reader can show: the same condition the body
 *  uses to offer its own "Saved content" button, so the bar never opens an
 *  empty Reader. */
export function hasContentReader(e: Pick<RedLogEvent, 'agentType' | 'data'>): boolean {
  const d = (e.data ?? {}) as Record<string, unknown>
  if (e.agentType === 'shell' && d.subtype === 'command_end') return hasFileRef(d.stdout_ref) || hasFileRef(d.stderr_ref)
  if (e.agentType !== 'scanner') return false
  return hasSavedBody(d.request_body as InlineBody, d.request_body_ref)
    || hasSavedBody(d.response_body as InlineBody, d.response_body_ref)
    || hasSavedBody(d.ws_body as InlineBody, d.ws_body_ref)
    || hasSavedBody(d.tcp_body as InlineBody, d.tcp_body_ref)
}
