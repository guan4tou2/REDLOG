// Pin score for artifact rotation (SPEC-SCOPE-AWARE-LIFECYCLE.md — "scope as
// pin", the IPFS lesson). Under size pressure the io/ store GCs UNPINNED bodies
// first and keeps pinned ones longest, so scope attaches to *rotation priority*,
// never to capture. This is the single pure function that decides eviction order.
//
// A body is content-addressed and deduped, so its pin inputs are the UNION over
// every event that references it: pinned if ANY referencing event pins it.

export type ScopeVerdict = 'in_scope' | 'out_of_scope' | 'excluded' | 'unknown'

export interface PinInputs {
  /** Strongest scope verdict across referencing events (in_scope wins). */
  scope: ScopeVerdict
  /** Any referencing event is a `loot` or `marker` — operator-asserted value. */
  referencedByMarkerOrLoot: boolean
  /** An operator explicitly pinned this body. */
  operatorPinned: boolean
}

// Higher = more pinned = evicted later. The tiers are ordinal, not additive —
// the strongest applicable reason wins, so an out-of-scope body that a marker
// cites is still pinned (evidence beats scope).
export const PIN_TIER = {
  operator: 100,     // explicit operator pin — never auto-evict
  markerLoot: 80,    // cited by a finding/loot event — evidence
  inScope: 60,       // in the engagement's scope
  unknown: 30,       // unclassified — evict before scoped-out, keep before excluded
  outOfScope: 10,    // outside scope
  excluded: 0        // explicitly excluded — evict first
} as const

/** Everything at or above this score is PINNED: never size-evicted, pruned only
 *  once past its age window. Below it is unpinned: first to go under pressure. */
export const PIN_THRESHOLD = PIN_TIER.inScope

export function pinScore(inp: PinInputs): number {
  if (inp.operatorPinned) return PIN_TIER.operator
  if (inp.referencedByMarkerOrLoot) return PIN_TIER.markerLoot
  switch (inp.scope) {
    case 'in_scope': return PIN_TIER.inScope
    case 'unknown': return PIN_TIER.unknown
    case 'out_of_scope': return PIN_TIER.outOfScope
    case 'excluded': return PIN_TIER.excluded
  }
}

export function isPinned(inp: PinInputs): boolean {
  return pinScore(inp) >= PIN_THRESHOLD
}
