import { insertEvent } from './db/events'
import { eventBus } from './event-bus'
import type { ScopeVerdict } from './artifact-pin'
import { buildSuffixSet, DEFAULT_SUFFIXES, getRegistrableDomain } from './public-suffix'
import { ipInCIDR, ipFamily, isIPLiteral, V6_PROXIMITY_BITS } from './ip-match'

interface ScopeConfig {
  /** Whether D2 (adjacent) alerts fire. D1 (excluded) always fires regardless —
   *  a fact-tier verdict is not a preference call. False = D1 only.
   *  (`ALERT-ROLES.md` Part C.3 replaces this boolean with a three-value
   *  `alertFloor` once D3 needs to be selectable again — G-C3.) */
  warnOnViolation: boolean
  targets: string[]
  excludeTargets: string[]
  /** Container width for deriving a single-IP scope entry's D2 zone. A scope of
   *  `192.168.1.10` makes `192.168.1.0/24` adjacent at the default 24. */
  proximityBits: number
  /** Extra multi-label public suffixes on top of the built-in table, so an
   *  engagement on a suffix RedLog has not heard of is not blocked on a release
   *  (`public-suffix.ts`). Additive only — the built-ins cannot be removed. */
  publicSuffixes: string[]
}

function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return host === pattern.slice(2) || host.endsWith('.' + pattern.slice(2))
  }
  return host === pattern
}

/** G-B2: was `parts.slice(-2)`, which made `co.uk` the registrable domain of
 *  `shop.example.co.uk` — so a scope of `*.example.co.uk` marked every `.co.uk`
 *  host as adjacent. Same for `github.io` and `s3.amazonaws.com`. */
function extractRootDomains(targets: string[], suffixes: Set<string>): Set<string> {
  const roots = new Set<string>()
  for (const t of targets) {
    if (isIPLiteral(t) || t.includes('/')) continue
    const domain = t.startsWith('*.') ? t.slice(2) : t
    roots.add(getRegistrableDomain(domain, suffixes))
  }
  return roots
}

const DEFAULT_PROXIMITY_BITS = 24

/** The distance of a target from declared intent (`ALERT-ROLES.md` Part B.1).
 *  D1 `excluded` outranks D0 `in_scope`: an explicit exclusion inside a broad
 *  CIDR must still fire. D2 is inferred; D3 is counted, never emitted. */
export type ScopeDistance =
  | 'in_scope'          // D0
  | 'excluded'          // D1 — fact
  | 'adjacent_subnet'   // D2 — inferred
  | 'adjacent_domain'   // D2 — inferred
  | 'unrelated'         // D3

function normaliseBits(bits: number | undefined): number {
  return Number.isInteger(bits) && (bits as number) >= 1 && (bits as number) <= 32
    ? (bits as number)
    : DEFAULT_PROXIMITY_BITS
}

/** The container rule, IP side: **a single point expands one level into its
 *  container; an entry that already IS a container does not expand.** A bare
 *  `192.168.1.10` carries no boundary information, so deriving a /24 fills in a
 *  missing boundary. A written `10.0.0.0/8` states one — widening it would
 *  invent authorisation the operator did not give. */
function isAdjacentSubnet(ip: string, targets: string[], v4Bits: number): boolean {
  return targets.some((t) => {
    if (t.includes('/')) return false          // a stated boundary never widens
    const family = ipFamily(t)
    if (family === null) return false
    return ipInCIDR(ip, `${t}/${family === 6 ? V6_PROXIMITY_BITS : v4Bits}`)
  })
}

/** The container rule, domain side. Note the deliberate asymmetry with IPs:
 *  a wildcard `*.staging.example.com` DOES still expand to its registrable
 *  domain, because that domain is the *ownership* boundary the authorisation is
 *  actually about — hitting `prod.example.com` while scoped to staging is the
 *  exact mistake D2 exists to catch. A CIDR has no comparable ownership
 *  boundary recoverable from the string, which is why it does not expand. */
function isAdjacentDomain(host: string, roots: Set<string>, suffixes: Set<string>): boolean {
  return roots.has(getRegistrableDomain(host, suffixes))
}

/** Pure distance classification — the test seam for the ladder, sibling of
 *  `classifyIP()` in `ip-monitor.ts`. No side effects, unlike `checkTarget`. */
export function classifyDistance(
  target: string,
  cfg: {
    targets: string[]
    excludeTargets: string[]
    proximityBits?: number
    /** Pass a prebuilt set to avoid rebuilding it per call; `publicSuffixes`
     *  is the convenience form for callers holding raw config. */
    suffixes?: Set<string>
    publicSuffixes?: string[]
  }
): ScopeDistance {
  if (cfg.targets.length === 0) return 'in_scope'
  const isIP = isIPLiteral(target)
  const hits = (list: string[]): boolean =>
    list.some((t) => (isIP ? ipInCIDR(target, t) : matchesDomain(target, t)))

  if (hits(cfg.excludeTargets)) return 'excluded'
  if (hits(cfg.targets)) return 'in_scope'

  // D2 — near-miss. Before G-B1/G-B3 the IP branch had no container rule at all
  // and every out-of-scope IP raised, so scanning 8.8.8.8 alerted exactly as
  // loudly as hitting the wrong box on the target segment. A muted channel is a
  // removed defence, so that noise was a correctness bug, not an annoyance.
  if (isIP) {
    return isAdjacentSubnet(target, cfg.targets, normaliseBits(cfg.proximityBits))
      ? 'adjacent_subnet'
      : 'unrelated'
  }
  const suffixes = cfg.suffixes ?? (cfg.publicSuffixes?.length ? buildSuffixSet(cfg.publicSuffixes) : DEFAULT_SUFFIXES)
  return isAdjacentDomain(target, extractRootDomains(cfg.targets, suffixes), suffixes)
    ? 'adjacent_domain'
    : 'unrelated'
}

/** Pure scope classification — no side effects, unlike `checkTarget` which
 *  records violations. This is the classifier scope-aware sanitize and retention
 *  share (SPEC-SCOPE-AWARE-LIFECYCLE.md Part A). An empty/absent target is
 *  `unknown` (the caller decides the safe default per action); no scope set at
 *  all means everything is in scope. */
export function classifyTarget(
  target: string | null | undefined,
  cfg: { targets: string[]; excludeTargets: string[] }
): ScopeVerdict {
  if (!target) return 'unknown'
  if (cfg.targets.length === 0) return 'in_scope'
  const isIP = isIPLiteral(target)
  const isExcluded = cfg.excludeTargets.some((ex) => (isIP ? ipInCIDR(target, ex) : matchesDomain(target, ex)))
  if (isExcluded) return 'excluded'
  const isInScope = cfg.targets.some((t) => (isIP ? ipInCIDR(target, t) : matchesDomain(target, t)))
  return isInScope ? 'in_scope' : 'out_of_scope'
}

export class ScopeMonitor {
  private config: ScopeConfig = {
    warnOnViolation: true,
    targets: [],
    excludeTargets: [],
    proximityBits: DEFAULT_PROXIMITY_BITS,
    publicSuffixes: []
  }
  /** Built once per configure(), not per command — the table is ~250 entries. */
  private suffixes: Set<string> = DEFAULT_SUFFIXES
  private engagementId = 'default'
  private operatorId = ''
  private violations: Array<{ target: string; command: string; timestamp: number }> = []
  /** D3 is silent, not dropped: the count is what lets the operator (and the
   *  adherence report, G-D1) see how much was suppressed. Without it, "silent"
   *  is indistinguishable from "not looking". */
  private unrelated = 0

  configure(opts: {
    warnOnViolation?: boolean
    targets?: string[]
    excludeTargets?: string[]
    proximityBits?: number
    publicSuffixes?: string[]
    engagementId?: string
    operatorId?: string
  }): void {
    if (opts.warnOnViolation !== undefined) this.config.warnOnViolation = opts.warnOnViolation
    if (opts.targets) this.config.targets = opts.targets
    if (opts.excludeTargets) this.config.excludeTargets = opts.excludeTargets
    if (opts.proximityBits !== undefined) this.config.proximityBits = normaliseBits(opts.proximityBits)
    if (opts.publicSuffixes) this.config.publicSuffixes = opts.publicSuffixes
    this.suffixes = this.config.publicSuffixes.length
      ? buildSuffixSet(this.config.publicSuffixes)
      : DEFAULT_SUFFIXES
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
  }

  /** Walk the distance ladder (`ALERT-ROLES.md` Part B). RedLog never blocks —
   *  the return value tells the caller what happened, it does not gate anything.
   *  Note that a D3 target still lands in the timeline as `detectedTarget` like
   *  any other command; only the *alert* is suppressed, never the record. */
  checkTarget(target: string, command: string): { inScope: boolean; violation: boolean } {
    if (this.config.targets.length === 0) return { inScope: true, violation: false }

    const distance = classifyDistance(target, { ...this.config, suffixes: this.suffixes })

    if (distance === 'in_scope') return { inScope: true, violation: false }

    // D1 — fact tier. Fires regardless of warnOnViolation: if you explicitly
    // told RedLog to keep off X, hitting X is not a preference call.
    if (distance === 'excluded') {
      this.recordViolation(target, command, 'excluded_target', 'fact')
      return { inScope: false, violation: true }
    }

    // D3 — counted, never emitted.
    if (distance === 'unrelated') {
      this.unrelated += 1
      return { inScope: false, violation: false }
    }

    // D2 — inferred tier, and therefore silenceable. Warnings off = no badge,
    // no event, no deconfliction alert. The raw shell command still lands in
    // the timeline like any other command — RedLog never blocks.
    if (!this.config.warnOnViolation) return { inScope: false, violation: false }
    this.recordViolation(target, command, distance, 'inferred')
    return { inScope: false, violation: true }
  }

  getUnrelatedCount(): number {
    return this.unrelated
  }

  /** `reason` is a closed vocabulary (G-B4) so downstream can tell a fact from an
   *  inference: before this, both the domain-adjacent case and the unrelated-IP
   *  case wrote `out_of_scope` and were indistinguishable. `authority` is the
   *  data half of the §3 fact/inferred split — it is what lets the deconfliction
   *  feed forward D1 to the blue team while holding D2 back (G-C2), instead of
   *  today's all-or-nothing `subtypes: ['scope_violation']`. */
  private recordViolation(
    target: string,
    command: string,
    reason: 'excluded_target' | 'adjacent_subnet' | 'adjacent_domain',
    authority: 'fact' | 'inferred'
  ): void {
    this.violations.push({ target, command, timestamp: Date.now() })
    if (!this.operatorId) return

    try {
      const evt = insertEvent('system', {
        subtype: 'scope_violation',
        target,
        command: command.slice(0, 200),
        reason,
        authority
      }, { engagementId: this.engagementId, operatorId: this.operatorId, targetId: target })
      if (evt) eventBus.publish(evt)
    } catch { /* DB may not be ready */ }
  }

  getViolations(): Array<{ target: string; command: string; timestamp: number }> {
    return [...this.violations]
  }

  getViolationCount(): number {
    return this.violations.length
  }

  isConfigured(): boolean {
    return this.config.targets.length > 0
  }
}
