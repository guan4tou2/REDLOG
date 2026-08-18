// The Signal layer of the alert subsystem (v0.12.0).
//
// A **Signal** is a raw observation — "something happened that the alert
// system should look at." Signals are transient values, not chain events;
// producers hand them to `AlertBus.dispatch`, the bus runs registered
// policies over them, verdicts go to surfaces (chain, badge, webhook,
// adherence). See `docs/ALERT-ROLES.md` (ea's spec) for the "why" —
// Self alarm (state machine) vs Target alarm (event stream) as the two
// roles, plus the fact/inferred/unknown authority tier.
//
// This file only defines the *shapes*. Producers live at their source
// (mitmproxy addon for DNS, api-server for shell command_start, etc.);
// the bus is in `bus.ts`; policies in `policy.ts`; surfaces in `surface.ts`.
//
// Signals are POJOs — no methods, no inheritance — so any producer can
// synthesise one from a raw event without dragging in this file. The tag
// (`kind`) is the discriminator; the rest is per-kind.

/** Change of the operator's own egress address — periodic pulse from
 *  `ip-monitor.ts`. Fires only when the address actually changed (or on
 *  first successful poll), not every tick. This is the Self alarm role. */
export interface IPChangeSignal {
  kind: 'ip_change'
  timestamp: number
  external: string | null
  internal: string | null
  /** True during the confirmation-count window when a new value is being
   *  validated; the previous stable value is what's authoritative. Used by
   *  the badge to draw a "settling" modifier per ea's G-A3. */
  settling: boolean
  /** True when the last poll failed and the verdict should decay to
   *  `unknown` rather than stick at the last known good. */
  stale: boolean
  /** LAN link the internal address belongs to — Wi-Fi SSID or wired.
   *  Feeds the `lanProfile` verdict pathway (ea G-A4). */
  link?: { type: 'wifi' | 'wired' | 'unknown'; name: string }
}

/** Per-action observation of a target host (the Target alarm role).
 *  Every shell command_start / DNS query / HTTP request / agent tool call
 *  that carries a hostname or IP produces one of these; the `source` tag
 *  identifies which producer emitted it so multiple lanes can share the
 *  same downstream classifier. */
export interface TargetHitSignal {
  kind: 'target_hit'
  timestamp: number
  target: string
  /** Which producer saw the target — used by cross-signal correlation and
   *  by the adherence report to break down by source. */
  source: 'shell' | 'dns' | 'http' | 'scanner' | 'agent_tool'
  /** The originating event's id, so the emitted verdict can chain back
   *  via `_causes` (v0.6.89 causal model). Missing when the signal fires
   *  before the source event is persisted — surface treats null as
   *  "no causal link available". */
  sourceEventId: string | null
  /** Short description of the action for the audit trail: the shell
   *  command line, the DNS query name+type, the HTTP method+path, etc.
   *  Capped at 200 chars at surface time. */
  action: string
}

/** Union of every signal kind. Adding a new signal = extend this union
 *  and register a policy that handles the new `kind`. */
export type Signal = IPChangeSignal | TargetHitSignal

/** A Signal producer is anything that observes the world and calls
 *  `bus.dispatch(signal)`. Producers are wired at boot in `main/index.ts`
 *  or `api-server.ts`; the interface here is nominal — producers don't
 *  actually `implements` this, they just hold a bus reference and call
 *  `.dispatch()`. Documenting the contract in one place so the seam is
 *  reviewable. */
export interface SignalProducer {
  /** Debug/logging label; not stable, don't key off it. */
  readonly name: string
  /** Called at teardown so producers can close watchers, timers, etc.
   *  Optional; a stateless synchronous producer has nothing to clean up. */
  stop?(): void | Promise<void>
}
