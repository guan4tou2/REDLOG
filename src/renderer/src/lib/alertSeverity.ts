// The one severity scale (`ALERT-ROLES.md` G-C1).
//
// The two alarm roles grew their own colour vocabularies independently and they
// did not line up:
//
//   * Self alarm  — four tones (green / orange / amber / red), one per verdict.
//   * Target alarm — an ON/OFF LIGHT. `scopeViolations > 0 ? red : green`, so a
//     D1 hit on an explicitly forbidden host and a D2 proximity inference
//     rendered identically. G-B4 made them distinguishable in the data and
//     G-C2 on the wire; the operator's eye was where the distinction stopped.
//
// SEVERITY AND AUTHORITY ARE ORTHOGONAL — do not fold one into the other:
//
//   * severity (here) — how loudly to shout. Sets the COLOUR.
//   * authority (K1)  — observed or inferred. Sets the FILL: solid, or hollow
//     and unglowing.
//
// That is why `presumed_safe` and a D2 near-miss are both inferred yet look
// nothing alike: `ok` + inferred is a hollow green, `warn` + inferred a hollow
// orange. Collapsing the axes would force one of those two to lie.

import { HUD } from './hud'

export type Severity = 'ok' | 'notice' | 'unknown' | 'warn' | 'critical'

/** Ordered worst-first, so `worstSeverity` and any future sort share one order.
 *  `notice` sits below `unknown`: "here is something that happened, out of scope
 *  but unrelated" asks less of the operator than "I cannot tell you whether you
 *  are safe". */
const RANK: Record<Severity, number> = { critical: 4, warn: 3, unknown: 2, notice: 1, ok: 0 }

export const SEVERITY_HUD: Record<Severity, string> = {
  ok: HUD.green,
  notice: HUD.muted,
  unknown: HUD.amber,
  warn: HUD.orange,
  critical: HUD.red
}

/** Tailwind classes for the app surfaces. Same four steps as `SEVERITY_HUD` —
 *  the soften map in `tailwind.config.js` keeps the hexes identical. */
export const SEVERITY_CLASS: Record<Severity, { dot: string; text: string; border: string }> = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-400/80', border: 'border-emerald-500' },
  notice: { dot: 'bg-zinc-500', text: 'text-zinc-400/80', border: 'border-zinc-500' },
  unknown: { dot: 'bg-amber-500', text: 'text-amber-400/80', border: 'border-amber-500' },
  warn: { dot: 'bg-orange-500', text: 'text-orange-400/80', border: 'border-orange-500' },
  critical: { dot: 'bg-red-500', text: 'text-red-400/80', border: 'border-red-500' }
}

type IPVerdict = 'safe' | 'presumed_safe' | 'off_profile' | 'exposed' | 'unknown'

/** Self alarm → the scale. `presumed_safe` is `ok`: it is the good answer,
 *  merely an inferred one, and the inference is carried by authority rather
 *  than by pretending the situation is worse than it is. */
export function ipSeverity(verdict: IPVerdict): Severity {
  switch (verdict) {
    case 'exposed': return 'critical'
    case 'off_profile': return 'warn'
    case 'unknown': return 'unknown'
    default: return 'ok'
  }
}

/** Target alarm → the scale. D1 sits level with `exposed`: both are the thing
 *  the operator must not do, both observed, both non-silenceable — one is an
 *  OPSEC failure, the other an authorisation failure.
 *
 *  D3 only reaches here under `alertFloor: 'all'`, and gets its own step rather
 *  than borrowing D2's. Giving it `warn` would put the noise G-B3 removed back
 *  inside the violation list; giving it `ok` would render a recorded departure
 *  green. `notice` is grey: on the record, not shouting. */
export function scopeSeverity(
  reason: 'excluded_target' | 'adjacent_subnet' | 'adjacent_domain' | 'unrelated'
): Severity {
  if (reason === 'excluded_target') return 'critical'
  if (reason === 'unrelated') return 'notice'
  return 'warn'
}

export function worstSeverity(list: readonly Severity[]): Severity {
  return list.reduce<Severity>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ok')
}
