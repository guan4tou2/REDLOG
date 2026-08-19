// The Policy layer of the alert subsystem (v0.12.0).
//
// A **Policy** classifies signals into **verdicts**. Policies are the pure
// half of the subsystem — no I/O, no DB, no timers except when explicitly
// stateful (e.g. burst window aggregation). Every side effect happens in
// a Surface consumer.
//
// Verdict shapes track ea's `ALERT-ROLES.md`:
//   • Self alarm (IP) — five values on the fact/inferred/unknown authority
//     tier, with modifiers (`settling`, `stale`, `listConflict`) that are
//     independent of the base verdict (ea G-A2/G-A3).
//   • Target alarm (scope) — four-rung distance ladder (`in_scope`,
//     `excluded`, `adjacent_subnet`/`adjacent_domain`, `unrelated`) with
//     the same authority tier attached to each rung (ea G-B4/G-C2).
//   • Combined — v0.12.0 addition, a policy that reads recent IP + recent
//     Scope verdicts and escalates to CRITICAL when both non-clean.
//   • Burst — v0.12.0 addition, aggregates recent Scope verdicts into a
//     summary when N hit within window T. Doesn't replace individual
//     verdicts, adds a burst-severity modifier.
//
// Verdicts do NOT hold references to sources or event ids — that context
// is on the originating Signal. When a Surface writes an event it composes
// verdict + signal into event data. Keeping verdicts self-contained keeps
// them testable in isolation.

import type { IPChangeSignal, TargetHitSignal, Signal } from './signal'

// ─── Authority tier (from ea's K1) ──────────────────────────────────────────

/** Every verdict declares whether it is observed (`fact`), derived
 *  (`inferred`), or absent (`unknown`). A `fact` may not be silenced by a
 *  preference toggle; `inferred` may. `unknown` never collapses into
 *  `safe`/`in_scope` — it is its own colour. */
export type Authority = 'fact' | 'inferred' | 'unknown'

/** The four-step severity scale shared by all verdicts (ea G-C1). Every
 *  Surface can render / forward / count based on this alone without
 *  knowing the underlying policy. */
export type Severity = 'clean' | 'notice' | 'warning' | 'critical'

// ─── IP verdict (Self alarm) ────────────────────────────────────────────────

/** Five IP verdict values covering every reachable cell in the
 *  `whitelist × blacklist × w × b` matrix (ea A-1..A-9). A whitelist miss
 *  is never `safe`; a blacklist miss with no whitelist is never `safe`
 *  either — that's the `A-9 false green` bug the vocabulary exists to
 *  prevent. */
export type IPVerdictKind =
  | 'safe'           // explicit whitelist match (fact)
  | 'presumed_safe'  // no whitelist configured, IP not on blacklist (inferred)
  | 'off_profile'    // whitelist configured, IP not on it AND not on blacklist (fact)
  | 'exposed'        // blacklist match (fact) — always dominates
  | 'unknown'        // no data / no lists (unknown)

export interface IPVerdict {
  /** The verdict value itself — see `IPVerdictKind`. Named `value` (not
   *  `kind`) so it doesn't collide with the outer `Verdict` union's
   *  discriminator (`{kind: 'ip'}`). */
  value: IPVerdictKind
  authority: Authority
  severity: Severity
  /** Modifiers are independent of the base verdict (ea A.3). A
   *  `settling` `safe` is still `safe` semantically — the modifier
   *  qualifies the presentation. */
  settling?: boolean
  stale?: boolean
  /** IP is on BOTH lists at once — the verdict is still `exposed` (the
   *  worse of the two wins), and the modifier surfaces the config bug so
   *  the operator can fix it (ea A-6 / G-A2). */
  listConflict?: boolean
  /** Optional LAN-profile secondary verdict computed from the internal
   *  address (ea G-A4). Held separately so the primary badge doesn't get
   *  confused when the operator is on-VPN externally but off-VPN on the
   *  wired jack. */
  lanSafety?: IPVerdictKind
}

// ─── Scope verdict (Target alarm) ───────────────────────────────────────────

/** The four-rung distance ladder (ea Part B). `in_scope` is the
 *  everything-is-fine floor; `excluded` is an explicit deny-list hit and
 *  the strongest signal a Target verdict carries; the two `adjacent_*`
 *  values are inferred proximity ("same subnet, wrong host" / "same
 *  registrable domain, wrong subdomain"); `unrelated` is the residual
 *  bucket that fires only under the strictest `alertFloor`. */
export type ScopeDistance = 'in_scope' | 'excluded' | 'adjacent_subnet' | 'adjacent_domain' | 'unrelated'

export interface ScopeVerdict {
  distance: ScopeDistance
  authority: Authority
  severity: Severity
  /** The plugin/extractor that identified the target, if any (v0.9.1
   *  attribution). Held on the verdict so downstream surfaces can render
   *  "flagged by rule X" without another lookup. */
  extractorPluginId?: string
  extractorName?: string
}

// ─── Combined verdict (v0.12.0 addition) ────────────────────────────────────

/** Cross-signal escalation. When a Combined policy sees a non-clean IP
 *  verdict within recall window T of a non-clean Scope verdict (or vice
 *  versa), it emits a Combined verdict with escalated severity. Both
 *  source verdicts also fire independently through their own surfaces —
 *  Combined is an *additional* signal, not a replacement. */
export interface CombinedVerdict {
  /** Snapshot of the IP verdict that co-occurred (safe/exposed/etc + modifiers). */
  ipValue: IPVerdictKind
  /** Snapshot of the scope distance that co-occurred. */
  scopeDistance: ScopeDistance
  /** How far apart the two source signals were (ms). Small ↔ higher
   *  correlation confidence. */
  correlationMs: number
  severity: Severity  // usually escalated one step above max(ip.severity, scope.severity)
  authority: Authority  // min(ip.authority, scope.authority) — combined is at most as strong as the weaker source
}

// ─── Burst verdict (v0.12.0 addition) ───────────────────────────────────────

/** Rate-limit signal. When N Scope verdicts of the same distance hit
 *  within window T (defaults: N=10, T=60s), emit ONE Burst verdict
 *  summarising the run. Individual verdicts still fire independently
 *  (chain integrity, adherence counting); Burst is a UI/webhook
 *  compression signal. */
export interface BurstVerdict {
  /** Which distance rung burst. Only Scope verdicts aggregate; IP
   *  verdicts have a state-machine of their own (don't burst). */
  distance: ScopeDistance
  count: number
  windowMs: number
  firstAt: number
  lastAt: number
  /** Distinct targets seen in the burst. Capped at ~10 for display. */
  targets: string[]
  severity: Severity
  authority: Authority
}

// ─── Verdict union + Policy interface ───────────────────────────────────────

/** Discriminated union of every verdict shape. Surfaces switch on
 *  `.kind` (added by the wrapper below) to route to the right renderer. */
export type Verdict =
  | (IPVerdict & { kind: 'ip' })
  | (ScopeVerdict & { kind: 'scope'; signal: TargetHitSignal })
  | (CombinedVerdict & { kind: 'combined' })
  | (BurstVerdict & { kind: 'burst' })

/** A Policy consumes a Signal (or a signal history via `stateful` policies
 *  like Combined and Burst) and returns 0..N verdicts. The bus feeds each
 *  registered policy the same signal; each policy decides whether it
 *  applies. Returning `[]` is normal — a policy that doesn't handle the
 *  signal kind, or one whose classifier says nothing changed, produces
 *  nothing.
 *
 *  Pure (stateless) policies only look at the input Signal. Stateful
 *  policies (Combined, Burst) hold their own history — they should be
 *  small, self-contained, and reset via `reset()`. */
export interface Policy {
  readonly name: string
  /** Called for every dispatched signal. Return verdicts to emit; empty
   *  array = policy didn't fire. */
  evaluate(signal: Signal): Verdict[]
  /** Optional reset for test isolation and for engagement/project switches. */
  reset?(): void
}
