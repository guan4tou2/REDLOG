// The AlertBus — the single seam between producers and consumers.
//
//   producers  →  bus  →  policies  →  bus  →  surfaces
//
// Producers only know how to `dispatch(signal)`. Surfaces only know how
// to `handle(verdict)`. Policies map Signal → Verdict[]. The bus is the
// only piece that knows all three lists exist. Everything else in the
// subsystem is testable in isolation.
//
// The bus itself has no state beyond the registered lists. It does no
// filtering, no coalescing, no dedup — those are surface concerns (the
// badge dedups by state comparison). Keeping the bus thin means it can be
// swapped for an async version, a worker-thread version, or a test-double,
// without touching anything else in the subsystem.
//
// Verdicts go to surfaces and nowhere else. Until Spec 024 a second class of
// policy consumed verdicts and could emit more, which needed a recursion
// guard here; its only two members, Combined and Burst, were correlation the
// product does not do, and wrote chain events that cited no source.

import type { Signal } from './signal'
import type { Policy, Verdict } from './policy'
import type { Surface } from './surface'

export class AlertBus {
  private policies: Policy[] = []
  private surfaces: Surface[] = []

  registerPolicy(policy: Policy): void {
    this.policies.push(policy)
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

  /** Hand one verdict to every surface. Called from `dispatch` for each
   *  returned verdict; tests may call it directly. */
  emit(verdict: Verdict): void {
    for (const surface of this.surfaces) {
      try {
        void surface.handle(verdict)
      } catch { /* broken surface must not silence others */ }
    }
  }

  /** Reset every stateful policy — e.g. on engagement/project switch to drop
   *  stale state. Surfaces are not reset; the ChainEmitter's context is
   *  updated separately via `updateContext`. */
  resetPolicies(): void {
    for (const p of this.policies) p.reset?.()
  }

  /** Test/introspection accessor. Not for production use. */
  _debugCounts(): { policies: number; surfaces: number } {
    return { policies: this.policies.length, surfaces: this.surfaces.length }
  }
}
