// Extracted from Timeline.tsx so the §3 solid-vs-dashed rule has test coverage.
// Before K1 the distinction existed only on the phase ribbon, and it was wired
// to which ARRAY a band came from rather than to any authority field — nothing
// could assert that an inferred event dot renders differently from an observed
// one, because nothing decided it in a place a test could reach.
//
// The classification itself is NOT duplicated here. `insertEvent` resolves it
// once in core (`authority.ts`) and stamps `data.authority = 'inferred'` into
// the hashed row; absence means `fact`. The renderer reads that field, because
// it cannot import core (see `lib/mask.ts`) and a second copy of the table on
// this side of the process boundary is the exact drift K1 exists to end.

export type DotShape = 'circle' | 'diamond' | 'ring'

export interface DotMarks {
  shape: DotShape
  scale: number
  /** §3: this event records a judgement, not an observation. Renders as a
   *  dashed outline over an unfilled body, with no glow — the same statement
   *  the phase ribbon makes with a dashed segment. */
  inferred: boolean
}

interface EventLike {
  agentType: string
  data?: Record<string, unknown> | null
}

export function isInferredEvent(e: EventLike): boolean {
  return e.data?.authority === 'inferred'
}

/**
 *    scope violation   diamond          out of bounds is categorical
 *    critical marker   ring (hollow)    reads as an outline, not a fill
 *    important marker  larger circle
 *    everything else   circle
 *
 * Shape and authority are orthogonal: a scope violation is a diamond whether it
 * is a fact (excluded target) or an inference (proximity), and the stroke says
 * which.
 */
export function dotShape(e: EventLike): DotMarks {
  const sub = e.data?.subtype as string | undefined
  const inferred = isInferredEvent(e)
  if (e.agentType === 'system' && sub === 'scope_violation') return { shape: 'diamond', scale: 1.25, inferred }
  if (e.agentType === 'marker') {
    const sev = String(e.data?.severity ?? 'info')
    if (sev === 'critical') return { shape: 'ring', scale: 1.5, inferred }
    if (sev === 'important') return { shape: 'circle', scale: 1.25, inferred }
  }
  return { shape: 'circle', scale: 1, inferred }
}
