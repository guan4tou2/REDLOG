// Bundled policy implementations.
//
// Two policies ship with the app:
//   • IPPolicy    — Self alarm; consumes IPChangeSignal, emits IPVerdict
//   • ScopePolicy — Target alarm; consumes TargetHitSignal, emits ScopeVerdict
//
// There were two more, CombinedPolicy and BurstPolicy, which read these
// verdicts and wrote their own. They were removed in Spec 024: correlation is
// outside the product, nothing presented their output, and the chain events
// they wrote cited no source.
//
// Every policy is a class so it can hold config + reset state. Config
// lives on the policy (not the bus) so the bus stays generic — swapping
// a policy for a plugin-provided one doesn't require a config-plumbing
// change.
//
// See `docs/ALERT-ROLES.md` (ea's spec) for the semantic backing —
// authority tier (K1), five-verdict IP matrix (Part A), four-rung Scope
// ladder (Part B). Comments below cross-reference by section id.

import type {
  Policy,
  Verdict,
  IPVerdict,
  IPVerdictKind,
  ScopeVerdict,
  Authority,
  Severity
} from './policy'
import type { Signal, IPChangeSignal, TargetHitSignal } from './signal'

import { classifyScope, buildScopeIndexes, type ScopeDistance, type ScopeIndexes } from '../scope-evaluator'

// ─── shared helpers (CIDR + domain matching) ────────────────────────────────

const IPV6_RE = /^[0-9a-f:]+$/i

function isIPv6(ip: string): boolean { return ip.includes(':') && IPV6_RE.test(ip) }

function ipv4ToLong(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + parseInt(o), 0) >>> 0
}

function matchesCIDR(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) return ip === cidr
  if (isIPv6(ip) !== isIPv6(cidr)) return false
  if (isIPv6(ip)) {
    // Ea's IPv6 fix — we don't do prefix arithmetic on IPv6 yet, so a
    // bare-address /N match falls back to exact match on the address
    // part. That's stricter than the spec's ideal but never a
    // false-clean, which is the safer direction.
    return ip === cidr.split('/')[0]
  }
  const [network, bitsStr] = cidr.split('/')
  const bits = parseInt(bitsStr)
  if (bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = ~(2 ** (32 - bits) - 1) >>> 0
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(network) & mask)
}

// ─── IPPolicy — Self alarm classifier ───────────────────────────────────────

export interface IPPolicyConfig {
  /** Explicit safe IPs / CIDRs. When set, a miss is `off_profile`. */
  safeIps: string[]
  /** Explicit exposed IPs / CIDRs (operator's real address). Always dominates. */
  exposedIps: string[]
}

export class IPPolicy implements Policy {
  readonly name = 'ip'
  private cfg: IPPolicyConfig = { safeIps: [], exposedIps: [] }
  private lastEmitted: IPVerdictKind | null = null  // dedup — only emit when changed

  configure(next: Partial<IPPolicyConfig>): void {
    if (next.safeIps) this.cfg.safeIps = next.safeIps
    if (next.exposedIps) this.cfg.exposedIps = next.exposedIps
    // Config change invalidates dedup — the next signal should re-emit
    // even if the address happens to land the same verdict, so operators
    // see the effect of their config edit.
    this.lastEmitted = null
  }

  evaluate(signal: Signal): Verdict[] {
    if (signal.kind !== 'ip_change') return []
    const verdict = this.classify(signal)
    // Dedup: don't emit if the verdict value + modifiers haven't changed.
    // Note: modifiers (settling/stale/listConflict) live on the verdict
    // but not in the dedup key — a modifier-only change (e.g. settling
    // → false) is not a state change worth chain-logging.
    if (verdict.value === this.lastEmitted && !verdict.settling && !verdict.stale) return []
    this.lastEmitted = verdict.value
    return [{ kind: 'ip', ...verdict }]
  }

  reset(): void { this.lastEmitted = null }

  private classify(s: IPChangeSignal): IPVerdict {
    const ip = s.external
    if (!ip || s.stale) {
      return {
        value: 'unknown',
        authority: 'unknown',
        severity: 'notice',
        stale: s.stale || undefined,
        settling: s.settling || undefined
      }
    }

    const onSafe = this.cfg.safeIps.some((c) => matchesCIDR(ip, c))
    const onExposed = this.cfg.exposedIps.some((c) => matchesCIDR(ip, c))

    // Precedence (ea A-6, A-7): exposed dominates, regardless of also
    // being on safe. listConflict modifier surfaces the config bug.
    if (onExposed) {
      return {
        value: 'exposed',
        authority: 'fact',
        severity: 'critical',
        settling: s.settling || undefined,
        listConflict: onSafe || undefined
      }
    }

    if (onSafe) {
      return {
        value: 'safe',
        authority: 'fact',
        severity: 'clean',
        settling: s.settling || undefined
      }
    }

    // Neither list matched. If a safe list IS configured, the miss is a
    // real off-profile fact (ea A-4). If no safe list is set, we can't
    // say "off-profile" — the best we can do is `presumed_safe` when an
    // exposed list is set (implication: address ≠ leak), or `unknown`.
    if (this.cfg.safeIps.length > 0) {
      return {
        value: 'off_profile',
        authority: 'fact',
        severity: 'warning',
        settling: s.settling || undefined
      }
    }
    if (this.cfg.exposedIps.length > 0) {
      return {
        value: 'presumed_safe',
        authority: 'inferred',
        severity: 'notice',
        settling: s.settling || undefined
      }
    }
    return {
      value: 'unknown',
      authority: 'unknown',
      severity: 'notice',
      settling: s.settling || undefined
    }
  }
}

// ─── ScopePolicy — Target alarm classifier ──────────────────────────────────

export interface ScopePolicyConfig {
  targets: string[]         // include list (globs / CIDRs / hosts)
  excludeTargets: string[]  // explicit deny — always the strongest rung
  /** Which distances trigger a verdict emit. `in_scope` is always emitted
   *  (adherence report needs the positive proof). The rest opt-in per
   *  operator preference (ea G-C1 — the surface layer's alertFloor). */
  alertFloor: ScopeDistance[]
}

const DEFAULT_ALERT_FLOOR: ScopeDistance[] = ['excluded', 'adjacent_subnet', 'adjacent_domain']

/** The scope in force, as a value rather than as policy state. Everything that
 *  needs to reproduce a verdict — the live path, and the recompute that
 *  re-judges stored rows after the allowlist changes — takes one of these, so
 *  the two cannot answer the same question differently. */
export interface ScopeSnapshot {
  targets: string[]
  excludeTargets: string[]
  alertFloor: ScopeDistance[]
}

/**
 * Scope distance with the alert's view of it. The distance itself is decided
 * by `classifyScope` in scope-evaluator — this module only says how much a
 * distance matters: an explicit rule is a fact, an adjacency is an inference,
 * and "no scope configured" is unknown. Deciding the distance here instead is
 * what let export masking, which imported this, drift from the filter.
 */
export function classifyScopeTarget(
  target: string,
  scope: Pick<ScopeSnapshot, 'targets' | 'excludeTargets'>,
  indexes?: ScopeIndexes
): { distance: ScopeDistance; authority: Authority; severity: Severity } {
  const c = classifyScope(target, scope, indexes)
  switch (c.distance) {
    case 'excluded': return { distance: 'excluded', authority: 'fact', severity: 'critical' }
    case 'in_scope':
      return { distance: 'in_scope', authority: c.status === 'no-scope' ? 'unknown' : 'fact', severity: 'clean' }
    case 'adjacent_subnet':
    case 'adjacent_domain':
      return { distance: c.distance, authority: 'inferred', severity: 'warning' }
    case 'unrelated':
      // Off-profile by silence rather than by rule: noticed, not alarmed on.
      return { distance: 'unrelated', authority: 'inferred', severity: 'notice' }
  }
}

/** Whether a distance actually produces a violation record. `in_scope` never
 *  does; everything else is opt-in through the floor. This is the emit gate
 *  `evaluate` applies, exported so a recompute can ask the same question
 *  without constructing a signal. */
export function isReportable(distance: ScopeDistance, alertFloor: readonly ScopeDistance[]): boolean {
  return distance !== 'in_scope' && alertFloor.includes(distance)
}

/** The floor the app actually runs with. Two settings, and `unrelated` is in
 *  neither — off-profile traffic is noticed, not alarmed about. */
export function alertFloorFor(warnOnViolation: boolean | undefined): ScopeDistance[] {
  return warnOnViolation === false
    ? (['excluded'] as ScopeDistance[])
    : ([...DEFAULT_ALERT_FLOOR] as ScopeDistance[])
}

export class ScopePolicy implements Policy {
  readonly name = 'scope'
  private cfg: ScopePolicyConfig = { targets: [], excludeTargets: [], alertFloor: DEFAULT_ALERT_FLOOR }
  private indexes: ScopeIndexes = { subnets: new Set(), domains: new Set() }

  /** Operator has drawn a boundary (targets configured). Excludes alone
   *  don't count as configured — an exclude-only scope makes no sense. */
  isConfigured(): boolean { return this.cfg.targets.length > 0 }

  configure(next: Partial<ScopePolicyConfig>): void {
    if (next.targets) this.cfg.targets = next.targets
    if (next.excludeTargets) this.cfg.excludeTargets = next.excludeTargets
    if (next.alertFloor) this.cfg.alertFloor = next.alertFloor
    this.indexes = buildScopeIndexes(this.cfg.targets)
  }

  /** The scope in force, as a value the recompute can carry across a save. */
  snapshot(): ScopeSnapshot {
    return {
      targets: [...this.cfg.targets],
      excludeTargets: [...this.cfg.excludeTargets],
      alertFloor: [...this.cfg.alertFloor]
    }
  }

  evaluate(signal: Signal): Verdict[] {
    if (signal.kind !== 'target_hit') return []
    const verdict = this.classify(signal)
    // in_scope always emits so AdherenceCounter can tally. Non-in-scope
    // emits only if included in alertFloor.
    if (verdict.distance !== 'in_scope' && !isReportable(verdict.distance, this.cfg.alertFloor)) return []
    return [{ kind: 'scope', signal, ...verdict }]
  }

  private classify(s: TargetHitSignal): ScopeVerdict {
    return classifyScopeTarget(s.target, this.cfg, this.indexes)
  }
}
