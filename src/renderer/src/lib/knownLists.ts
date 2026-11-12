// The shared filter's target and type menus, kept current from live batches.
//
// Both lists are whole-project reads (`aggregateTargets`, `distinctAgentTypes`)
// that scan both tiers. They used to be re-read two seconds after every batch
// for as long as anything was recording; a batch already carries everything
// that can be new in them, so it is folded in here instead, and the full read
// is kept for mount, focus and retry.

export interface KnownTarget {
  target: string
  eventCount: number
  /** Kept to order the list as the aggregate does: most recently seen first. */
  lastSeen: number
}

const HOOK_SCRIPTS = ['shell-bash-hook.sh', 'shell-zsh-hook.zsh', 'shell-hook.ps1', 'tlogger_prompt_command', 'Microsoft.PowerShell_profile.ps1']

/** The rows `aggregateTargets` leaves out: core's HOUSEKEEPING_SQL
 *  (src/core/db/event-queries.ts), read off the event instead of the row. */
function isHousekeeping(e: RedLogEvent): boolean {
  const data = (e.data ?? {}) as Record<string, unknown>
  const subtype = typeof data.subtype === 'string' ? data.subtype : ''
  const type = e.agentType
  if (subtype === 'session_start' && (type === 'system' || type === 'shell' || type === 'terminal')) return true
  if (type === 'system' && subtype === 'api_started') return true
  if (type !== 'shell') return false
  if (subtype === 'command_output') return Number(data.late) === 1 || data.late === true || Number(data.streamed) === 1 || data.streamed === true
  if (subtype === 'command_start' || subtype === 'command' || subtype === 'command_end') {
    // LIKE is case-insensitive for ASCII.
    const command = typeof data.command === 'string' ? data.command.toLowerCase() : ''
    return HOOK_SCRIPTS.some((s) => command.includes(s.toLowerCase()))
  }
  return false
}

/**
 * Fold a batch's `targetId`s into the known targets the way `aggregateTargets`
 * groups them: one entry per target in any casing, shown in its most recently
 * seen casing, ordered by last seen, housekeeping aside. Keyed on `targetId`
 * alone — the aggregate does not read `data.detectedTarget`, and a menu entry
 * the target filter could not match would be worse than none.
 *
 * `presence` adds missing targets without counting known ones again: for rows
 * that a full read issued before them may already have counted.
 *
 * Returns the list it was given when nothing changed, so a batch with nothing
 * new does not re-render every filter consumer.
 */
export function mergeKnownTargets(
  list: readonly KnownTarget[],
  events: readonly RedLogEvent[],
  mode: 'count' | 'presence' = 'count'
): KnownTarget[] {
  let out: KnownTarget[] | null = null
  let index: Map<string, number> | null = null
  for (const e of events) {
    const id = e.targetId
    if (!id || isHousekeeping(e)) continue
    index ??= new Map(list.map((x, i) => [x.target.toLowerCase(), i]))
    const key = id.toLowerCase()
    const at = index.get(key)
    if (at !== undefined && mode === 'presence') continue
    out ??= list.slice()
    if (at === undefined) {
      index.set(key, out.length)
      out.push({ target: id, eventCount: 1, lastSeen: e.timestamp })
      continue
    }
    const prev = out[at]
    const newer = e.timestamp >= prev.lastSeen
    out[at] = {
      target: newer ? id : prev.target,
      eventCount: prev.eventCount + 1,
      lastSeen: newer ? e.timestamp : prev.lastSeen
    }
  }
  if (!out) return list as KnownTarget[]
  // Stable: equal last-seen keeps the order it had.
  return out.sort((a, b) => b.lastSeen - a.lastSeen)
}

/** Add a batch's unseen agent types, in the order `distinctAgentTypes` returns
 *  them (SQLite's BINARY collation, which is code-unit order). */
export function mergeKnownAgentTypes(list: readonly string[], events: readonly RedLogEvent[]): string[] {
  let out: string[] | null = null
  for (const e of events) {
    const type = e.agentType
    if (!type || (out ?? list).includes(type)) continue
    out ??= list.slice()
    out.push(type)
  }
  if (!out) return list as string[]
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
