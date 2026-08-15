// The §3 authority primitive (DECOMPOSITION-BACKLOG K1, minimal slice).
//
// DESIGN-PRINCIPLES §3 draws one line: RedLog records FACTS and treats every
// interpretation as a SUGGESTION. Until now that line was enforced by each
// author remembering it, and it had drifted into three unrelated spellings —
// `phaseInference.ts`'s renderer-only `Confidence`, `loot-detector.ts`'s
// per-match `confidence`, and `scope-monitor.ts`'s per-event `authority`. This
// module is the one answer to "is this event an observation or a judgement?",
// so the honesty stops depending on anyone remembering.
//
// AUTHORITY IS NOT CONFIDENCE. They are orthogonal and must not be merged:
//
//   * `authority` — observed or inferred. Two values. Decides RENDERING
//     (solid vs dashed) and FORWARDING (deconfliction's authority floor).
//   * `confidence` — how strong an inference is. Only meaningful when authority
//     is `inferred`; a fact has no confidence to report.
//
// A scope violation on an explicitly excluded target is `fact` with no
// confidence; a loot match is `inferred` with `high`/`medium`/`low`. Collapsing
// them would force one of those two cases to lie.

export type Authority = 'fact' | 'inferred'

/** Default authority per built-in agent_type, from `EVENT-TYPE-VOCABULARY.md`'s
 *  origin classification. Only the detector-derived origins are listed — every
 *  other origin (operator-authored, primary capture, agent tool-calls, system
 *  drift signals) records something that actually happened, so `fact` is both
 *  the correct answer and the right default for anything unlisted.
 *
 *  Note `scope_violation` is deliberately ABSENT even though the vocabulary doc
 *  files it under detector-derived: it is a `system` subtype, and it is `fact`
 *  when an excluded target matched but `inferred` when the match was proximity.
 *  Type-level authority cannot express that — which is precisely why the
 *  per-event override below takes precedence. */
const BUILT_IN_AUTHORITY: Readonly<Record<string, Authority>> = {
  loot: 'inferred',
  pivot: 'inferred',
  cleanup: 'inferred',
  file_transfer: 'inferred'
}

function isAuthority(v: unknown): v is Authority {
  return v === 'fact' || v === 'inferred'
}

interface EventLike {
  agentType?: string
  data?: Record<string, unknown> | null
}

/** Resolve an event's authority, most specific answer first:
 *
 *  1. `data.authority` — the emitter classified THIS event. Required whenever a
 *     type can produce both (see `scope_violation` above).
 *  2. a registered `EventTypeDef.authority` — a plugin declared it for the type.
 *  3. the built-in table.
 *  4. `fact`.
 *
 *  Why `fact` is the fallback and not `inferred`: primary capture dominates the
 *  event stream, so defaulting to `inferred` would dash almost everything and
 *  drain the distinction of meaning. The safety net for a detector is step 1 —
 *  emit the label with the event — not a pessimistic default. */
export function authorityOf(
  event: EventLike,
  registered?: (agentType: string) => Authority | undefined
): Authority {
  const perEvent = event.data?.authority
  if (isAuthority(perEvent)) return perEvent

  const agentType = event.agentType ?? ''
  if (registered) {
    const declared = registered(agentType)
    if (isAuthority(declared)) return declared
  }
  return BUILT_IN_AUTHORITY[agentType] ?? 'fact'
}

/** Convenience for renderers: inferred elements must never present at full
 *  confidence — dashed outline, not a solid fill (§3). */
export function isInferred(
  event: EventLike,
  registered?: (agentType: string) => Authority | undefined
): boolean {
  return authorityOf(event, registered) === 'inferred'
}
