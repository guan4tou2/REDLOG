// Steps the operator marked in the record (#225).
//
// A pick is an ordinary marker — category `key_step` or `failed_attempt` —
// whose `_causes` cite the events of the step. Nothing is stored beside the
// chain and nothing about the cited events changes. Like every marker, a pick
// is append-only: one made in error is corrected by amending its title or
// notes, which the reader sees, not by making it disappear.

export const PICK_CATEGORIES = ['key_step', 'failed_attempt'] as const
export type PickCategory = typeof PICK_CATEGORIES[number]

interface PickEvent { id: string; agentType: string; data?: Record<string, unknown> }

function isPick(c: unknown): c is PickCategory {
  return typeof c === 'string' && (PICK_CATEGORIES as readonly string[]).includes(c)
}

/** event id → the pick categories citing it. Amendments cite their marker,
 *  not a step, and carry no category, so they are skipped. */
export function pickedSteps(events: readonly PickEvent[]): Map<string, Set<PickCategory>> {
  const out = new Map<string, Set<PickCategory>>()
  for (const e of events) {
    if (e.agentType !== 'marker') continue
    const d = e.data ?? {}
    if (d.subtype === 'amended') continue
    const category = d.category
    if (!isPick(category)) continue
    const causes = Array.isArray(d._causes) ? d._causes.filter((c): c is string => typeof c === 'string') : []
    for (const c of causes) {
      const set = out.get(c) ?? new Set<PickCategory>()
      set.add(category)
      out.set(c, set)
    }
  }
  return out
}
