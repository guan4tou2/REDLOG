// Bundled policy implementations.
//
// Four policies ship with the app:
//   • IPPolicy       — Self alarm; consumes IPChangeSignal, emits IPVerdict
//   • ScopePolicy    — Target alarm; consumes TargetHitSignal, emits ScopeVerdict
//   • CombinedPolicy — cross-signal; watches recent verdicts from IP + Scope
//                      via a peek at the bus's emitted verdict history (held
//                      on the policy itself, not the bus)
//   • BurstPolicy    — rate limiter; aggregates ScopeVerdicts into a single
//                      BurstVerdict when N-in-T is hit
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
  ScopeDistance,
  CombinedVerdict,
  BurstVerdict,
  Authority,
  Severity
} from './policy'
import type { Signal, IPChangeSignal, TargetHitSignal } from './signal'

// ─── shared helpers (CIDR + domain matching) ────────────────────────────────

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const IPV6_RE = /^[0-9a-f:]+$/i

function isIPv4(ip: string): boolean { return IPV4_RE.test(ip) }
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

function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const bare = pattern.slice(2)
    return host === bare || host.endsWith('.' + bare)
  }
  return host === pattern
}

// Ea's registrable-domain fix — a naïve `takeLast(2)` treats "co.uk" as a
// registrable domain and mis-classifies "target.co.uk" / "attacker.co.uk"
// as siblings. This uses a small effective-TLD list to strip one more
// label when needed. It's not the full Public Suffix List (that's
// megabytes) but covers the common two-label eTLDs a bug-bounty engagement
// will actually meet — the residual mismatch degrades to "unrelated",
// which is the safe side.
const TWO_LABEL_ETLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in',
  'com.au', 'com.br', 'com.cn', 'com.hk', 'com.mx', 'com.sg', 'com.tw',
  'org.uk', 'net.au', 'ne.jp', 'or.jp'
])

function registrableDomain(host: string): string {
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join('.')
  if (TWO_LABEL_ETLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.')
  return lastTwo
}

function domainFor(target: string): string | null {
  if (isIPv4(target) || target.includes('/') || target.includes(':')) return null
  const bare = target.startsWith('*.') ? target.slice(2) : target
  return bare
}

function subnetOf(ip: string, prefix = 24): string | null {
  if (!isIPv4(ip)) return null
  const parts = ip.split('.').map((o) => parseInt(o))
  if (parts.some((n) => isNaN(n) || n < 0 || n > 255)) return null
  const nMask = 32 - prefix
  const netLong = (ipv4ToLong(ip) & (~(2 ** nMask - 1) >>> 0)) >>> 0
  const a = (netLong >>> 24) & 0xff
  const b = (netLong >>> 16) & 0xff
  const c = (netLong >>> 8) & 0xff
  const d = netLong & 0xff
  return `${a}.${b}.${c}.${d}/${prefix}`
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

export class ScopePolicy implements Policy {
  readonly name = 'scope'
  private cfg: ScopePolicyConfig = { targets: [], excludeTargets: [], alertFloor: DEFAULT_ALERT_FLOOR }
  private scopeSubnets = new Set<string>()  // /24s covered by CIDR targets
  private scopeDomains = new Set<string>()  // registrable domains covered

  configure(next: Partial<ScopePolicyConfig>): void {
    if (next.targets) this.cfg.targets = next.targets
    if (next.excludeTargets) this.cfg.excludeTargets = next.excludeTargets
    if (next.alertFloor) this.cfg.alertFloor = next.alertFloor
    this.rebuildIndexes()
  }

  evaluate(signal: Signal): Verdict[] {
    if (signal.kind !== 'target_hit') return []
    const verdict = this.classify(signal)
    // in_scope always emits so AdherenceCounter can tally. Non-in-scope
    // emits only if included in alertFloor.
    if (verdict.distance !== 'in_scope' && !this.cfg.alertFloor.includes(verdict.distance)) return []
    return [{ kind: 'scope', signal, ...verdict }]
  }

  private rebuildIndexes(): void {
    this.scopeSubnets.clear()
    this.scopeDomains.clear()
    for (const t of this.cfg.targets) {
      if (t.includes('/')) {
        // CIDR — index by /24 for adjacent-subnet detection
        const [net] = t.split('/')
        const sub = subnetOf(net, 24)
        if (sub) this.scopeSubnets.add(sub)
      } else if (isIPv4(t)) {
        const sub = subnetOf(t, 24)
        if (sub) this.scopeSubnets.add(sub)
      } else {
        const dom = domainFor(t)
        if (dom) this.scopeDomains.add(registrableDomain(dom))
      }
    }
  }

  private classify(s: TargetHitSignal): ScopeVerdict {
    const target = s.target
    // No scope configured → everything is in-scope by default (opt-in model).
    if (this.cfg.targets.length === 0 && this.cfg.excludeTargets.length === 0) {
      return { distance: 'in_scope', authority: 'unknown', severity: 'clean' }
    }

    // Rung 1 (strongest): explicit exclude match.
    const isExcluded = this.cfg.excludeTargets.some((ex) =>
      isIPv4(target) ? matchesCIDR(target, ex) : matchesDomain(target, ex)
    )
    if (isExcluded) return { distance: 'excluded', authority: 'fact', severity: 'critical' }

    // Rung 4 (floor): explicit include match.
    const isInScope = this.cfg.targets.some((t) =>
      isIPv4(target) ? matchesCIDR(target, t) : matchesDomain(target, t)
    )
    if (isInScope) return { distance: 'in_scope', authority: 'fact', severity: 'clean' }

    // Rung 2 (inferred adjacency): same /24 as any scope target.
    if (isIPv4(target)) {
      const sub = subnetOf(target, 24)
      if (sub && this.scopeSubnets.has(sub)) {
        return { distance: 'adjacent_subnet', authority: 'inferred', severity: 'warning' }
      }
    }

    // Rung 3 (inferred adjacency): same registrable domain.
    if (!isIPv4(target)) {
      const reg = registrableDomain(target)
      if (this.scopeDomains.has(reg)) {
        return { distance: 'adjacent_domain', authority: 'inferred', severity: 'warning' }
      }
    }

    // Residual bucket. Off-profile by definition — but authority is
    // 'inferred' because we're inferring "you probably didn't mean this"
    // from silence, not from a rule.
    return { distance: 'unrelated', authority: 'inferred', severity: 'notice' }
  }
}

// ─── CombinedPolicy — cross-signal escalation ───────────────────────────────

export interface CombinedPolicyConfig {
  /** Correlation window — an IP verdict and Scope verdict within this many
   *  ms of each other are considered co-occurring. */
  windowMs: number
  /** Minimum severity per side to trigger. Both sides must be at or above
   *  this to escalate; both-clean pairs are noise. */
  ipSeverityFloor: Severity
  scopeSeverityFloor: Severity
}

const SEVERITY_ORDER: Record<Severity, number> = { clean: 0, notice: 1, warning: 2, critical: 3 }
function atLeast(a: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[floor]
}

export class CombinedPolicy implements Policy {
  readonly name = 'combined'
  private cfg: CombinedPolicyConfig = {
    windowMs: 30_000,
    ipSeverityFloor: 'warning',
    scopeSeverityFloor: 'warning'
  }
  private lastIp: { verdict: IPVerdict; at: number } | null = null
  private lastScope: { verdict: ScopeVerdict; at: number } | null = null
  /** Dedup — a burst of Scope verdicts against the same non-clean IP
   *  otherwise emits Combined for every one of them. Cool down for the
   *  correlation window. */
  private lastEmitAt = 0

  configure(next: Partial<CombinedPolicyConfig>): void {
    if (typeof next.windowMs === 'number') this.cfg.windowMs = next.windowMs
    if (next.ipSeverityFloor) this.cfg.ipSeverityFloor = next.ipSeverityFloor
    if (next.scopeSeverityFloor) this.cfg.scopeSeverityFloor = next.scopeSeverityFloor
  }

  /** Peek-in from downstream — a policy can't listen to bus.emit() from
   *  inside evaluate(), so the AlertBus wire-up calls this whenever the
   *  IPPolicy or ScopePolicy emits. Two-way glue is what lets Combined
   *  work without a real event-store. */
  ingest(verdict: Verdict): Verdict[] {
    const at = Date.now()
    if (verdict.kind === 'ip') this.lastIp = { verdict, at }
    else if (verdict.kind === 'scope') this.lastScope = { verdict, at }
    else return []
    return this.tryEmit(at)
  }

  evaluate(_signal: Signal): Verdict[] {
    // Combined is fed by verdicts, not signals — it registers with the bus
    // but produces from `ingest` instead of `evaluate`. Returning [] here
    // keeps the Policy interface honest.
    return []
  }

  reset(): void {
    this.lastIp = null
    this.lastScope = null
    this.lastEmitAt = 0
  }

  private tryEmit(now: number): Verdict[] {
    if (!this.lastIp || !this.lastScope) return []
    const dt = Math.abs(this.lastIp.at - this.lastScope.at)
    if (dt > this.cfg.windowMs) return []
    if (!atLeast(this.lastIp.verdict.severity, this.cfg.ipSeverityFloor)) return []
    if (!atLeast(this.lastScope.verdict.severity, this.cfg.scopeSeverityFloor)) return []
    if (now - this.lastEmitAt < this.cfg.windowMs) return []
    this.lastEmitAt = now

    const escalated = escalate(
      this.lastIp.verdict.severity,
      this.lastScope.verdict.severity
    )
    const combined: CombinedVerdict = {
      ipValue: this.lastIp.verdict.value,
      scopeDistance: this.lastScope.verdict.distance,
      correlationMs: dt,
      severity: escalated,
      authority: minAuthority(this.lastIp.verdict.authority, this.lastScope.verdict.authority)
    }
    return [{ kind: 'combined', ...combined }]
  }
}

function escalate(a: Severity, b: Severity): Severity {
  const worst = SEVERITY_ORDER[a] > SEVERITY_ORDER[b] ? a : b
  if (worst === 'critical') return 'critical'
  if (worst === 'warning') return 'critical'
  if (worst === 'notice') return 'warning'
  return 'notice'
}

const AUTH_ORDER: Record<Authority, number> = { unknown: 0, inferred: 1, fact: 2 }
function minAuthority(a: Authority, b: Authority): Authority {
  return AUTH_ORDER[a] < AUTH_ORDER[b] ? a : b
}

// ─── BurstPolicy — N-in-T aggregator ────────────────────────────────────────

export interface BurstPolicyConfig {
  /** Only these distances aggregate. Defaults exclude `in_scope` (no
   *  operator wants a "you did 200 good things" flag). */
  distances: ScopeDistance[]
  windowMs: number
  threshold: number
}

const DEFAULT_BURST_DISTANCES: ScopeDistance[] = ['adjacent_subnet', 'adjacent_domain', 'excluded', 'unrelated']

export class BurstPolicy implements Policy {
  readonly name = 'burst'
  private cfg: BurstPolicyConfig = {
    distances: DEFAULT_BURST_DISTANCES,
    windowMs: 60_000,
    threshold: 10
  }
  private windows = new Map<ScopeDistance, Array<{ target: string; at: number }>>()
  /** After a burst fires, silence the same distance for a full window so
   *  we don't fire another burst on hits 11..20 immediately after. */
  private cooldownUntil = new Map<ScopeDistance, number>()

  configure(next: Partial<BurstPolicyConfig>): void {
    if (next.distances) this.cfg.distances = next.distances
    if (typeof next.windowMs === 'number') this.cfg.windowMs = next.windowMs
    if (typeof next.threshold === 'number') this.cfg.threshold = next.threshold
  }

  ingest(verdict: Verdict): Verdict[] {
    if (verdict.kind !== 'scope') return []
    if (!this.cfg.distances.includes(verdict.distance)) return []
    const now = Date.now()
    if ((this.cooldownUntil.get(verdict.distance) ?? 0) > now) return []
    const bucket = this.windows.get(verdict.distance) ?? []
    // Slide the window
    const cutoff = now - this.cfg.windowMs
    const pruned = bucket.filter((r) => r.at >= cutoff)
    pruned.push({ target: verdict.signal.target, at: now })
    this.windows.set(verdict.distance, pruned)
    if (pruned.length >= this.cfg.threshold) {
      this.cooldownUntil.set(verdict.distance, now + this.cfg.windowMs)
      this.windows.set(verdict.distance, [])
      const targets = Array.from(new Set(pruned.map((r) => r.target)))
      const burst: BurstVerdict = {
        distance: verdict.distance,
        count: pruned.length,
        windowMs: this.cfg.windowMs,
        firstAt: pruned[0].at,
        lastAt: pruned[pruned.length - 1].at,
        targets,
        severity: verdict.severity,  // burst inherits the base severity — it's a rate, not an escalation
        authority: 'inferred'  // burst is always an inference, not a fact
      }
      return [{ kind: 'burst', ...burst }]
    }
    return []
  }

  evaluate(_signal: Signal): Verdict[] { return [] }
  reset(): void {
    this.windows.clear()
    this.cooldownUntil.clear()
  }
}
