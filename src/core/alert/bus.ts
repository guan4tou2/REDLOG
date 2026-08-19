// The AlertBus — the single seam between producers and consumers.
//
//   producers  →  bus  →  policies  →  bus  →  surfaces
//                                └── → derived policies → bus (recurse)
//
// Producers only know how to `dispatch(signal)`. Surfaces only know how
// to `handle(verdict)`. Policies map Signal → Verdict[]. **Derived**
// policies (Combined, Burst) map Verdict → Verdict[] — they read the
// verdict stream and can emit their own verdicts on top. The bus is the
// only piece that knows all four lists exist. Everything else in the
// subsystem is testable in isolation.
//
// The bus itself has no state beyond the registered lists. It does no
// filtering, no coalescing, no dedup — those are surface concerns
// (webhook does coalescing; badge dedups by state comparison). Keeping
// the bus thin means it can be swapped for an async version, a
// worker-thread version, or a test-double, without touching anything
// else in the subsystem.

import type { Signal } from './signal'
import type { Policy, Verdict } from './policy'
import type { Surface } from './surface'

/** A DerivedPolicy consumes verdicts (rather than signals) and can emit
 *  further verdicts on top — used for cross-signal correlation
 *  (CombinedPolicy) and rate limiting (BurstPolicy). The `evaluate` method
 *  from `Policy` is present but returns [] — DerivedPolicies never react
 *  to raw signals. */
export interface DerivedPolicy extends Policy {
  ingest(verdict: Verdict): Verdict[]
}

/** Duck-typed guard — anything with `ingest` and `evaluate` looks like a
 *  DerivedPolicy. Avoids a class-based inheritance check that would break
 *  when policies come from a plugin bundle with a different `instanceof`
 *  identity. */
function isDerived(p: Policy): p is DerivedPolicy {
  return typeof (p as DerivedPolicy).ingest === 'function'
}

export class AlertBus {
  private policies: Policy[] = []
  private derived: DerivedPolicy[] = []
  private surfaces: Surface[] = []
  /** Recursion guard — a poorly-wired derived policy could emit a verdict
   *  its own ingest would react to, and loop forever. Cap the depth. */
  private static readonly MAX_EMIT_DEPTH = 8
  private emitDepth = 0

  registerPolicy(policy: Policy): void {
    if (isDerived(policy)) this.derived.push(policy)
    else this.policies.push(policy)
  }

  registerSurface(surface: Surface): void {
    this.surfaces.push(surface)
  }

  /** Feed a signal through every policy and forward each returned verdict
   *  to every surface. Synchronous fan-out; surfaces that need async I/O
   *  return a Promise from `handle` and the bus ignores it (fire-and-
   *  forget — see Surface contract). */
  dispatch(signal: Signal): void {
    for (const policy of this.policies) {
      let verdicts: Verdict[]
      try {
        verdicts = policy.evaluate(signal)
      } catch {
        // A broken policy must not take down other policies. Same reason
        // the surface loop below catches per-surface.
        continue
      }
      for (const verdict of verdicts) this.emit(verdict)
    }
  }

  /** Direct emission — bypasses signal policies. Called from `dispatch`
   *  for every returned verdict, and callable directly by DerivedPolicies
   *  or tests. Runs verdict through surfaces AND derived policies. */
  emit(verdict: Verdict): void {
    if (this.emitDepth >= AlertBus.MAX_EMIT_DEPTH) return
    this.emitDepth++
    try {
      for (const surface of this.surfaces) {
        try {
          void surface.handle(verdict)
        } catch { /* broken surface must not silence others */ }
      }
      for (const dp of this.derived) {
        let further: Verdict[]
        try {
          further = dp.ingest(verdict)
        } catch { continue }
        for (const next of further) this.emit(next)
      }
    } finally {
      this.emitDepth--
    }
  }

  /** Reset every stateful policy — e.g. on engagement/project switch to
   *  drop stale correlation/burst history. Surfaces are not reset;
   *  the ChainEmitter's context is updated separately via
   *  `updateContext`. */
  resetPolicies(): void {
    for (const p of this.policies) p.reset?.()
    for (const p of this.derived) p.reset?.()
  }

  /** Test/introspection accessor. Not for production use. */
  _debugCounts(): { signals: number; derived: number; surfaces: number } {
    return { signals: this.policies.length, derived: this.derived.length, surfaces: this.surfaces.length }
  }
}
