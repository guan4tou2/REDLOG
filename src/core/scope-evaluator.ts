// Canonical Scope Evaluator — the single source of truth for scope decisions.
// Every surface (Timeline, TargetView, Export, ScopeStatus, alert policies)
// must use this module instead of rolling its own matcher.

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const IPV4_MAPPED_V6 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i

function isIPv4(s: string): boolean {
  return IPV4_RE.test(s) && s.split('.').every((octet) => {
    const value = Number(octet)
    return Number.isInteger(value) && value >= 0 && value <= 255
  })
}

function ipv6ToBigInt(raw: string): bigint | null {
  let value = raw.toLowerCase()
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  if (!value.includes(':') || (value.match(/::/g)?.length ?? 0) > 1) return null

  const convertIpv4Tail = (parts: string[]): string[] | null => {
    const tail = parts[parts.length - 1]
    if (!tail?.includes('.')) return parts
    const octets = tail.split('.').map(Number)
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
    return [...parts.slice(0, -1), ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)]
  }

  const halves = value.split('::')
  const left = convertIpv4Tail(halves[0] ? halves[0].split(':') : [])
  const right = convertIpv4Tail(halves.length === 2 && halves[1] ? halves[1].split(':') : [])
  if (!left || !right) return null
  const valid = (part: string): boolean => /^[0-9a-f]{1,4}$/.test(part)
  if (![...left, ...right].every(valid)) return null
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left
  if (groups.length !== 8) return null
  return groups.reduce((result, group) => (result << 16n) | BigInt(parseInt(group, 16)), 0n)
}

function isIPv6(s: string): boolean { return ipv6ToBigInt(s) !== null }

function ipv4ToLong(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + parseInt(o, 10), 0) >>> 0
}

export function normalizeSubject(raw: string): string {
  if (!raw) return ''
  let s = raw.trim().toLowerCase()

  // URL → extract hostname
  const protoIdx = s.indexOf('://')
  if (protoIdx !== -1) {
    s = s.slice(protoIdx + 3)
    const slashIdx = s.indexOf('/')
    if (slashIdx !== -1) s = s.slice(0, slashIdx)
    const atIdx = s.indexOf('@')
    if (atIdx !== -1) s = s.slice(atIdx + 1)
  }

  // IPv6 bracket notation [::1]:port
  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    if (close !== -1) s = s.slice(1, close)
  } else {
    // host:port — but only if it's not IPv6 (which has multiple colons)
    const lastColon = s.lastIndexOf(':')
    if (lastColon !== -1) {
      const beforeColon = s.slice(0, lastColon)
      if (!beforeColon.includes(':')) {
        s = beforeColon
      }
    }
  }

  // Trailing dot (FQDN)
  if (s.endsWith('.')) s = s.slice(0, -1)

  // IPv4-mapped IPv6
  const mapped = IPV4_MAPPED_V6.exec(s)
  if (mapped) s = mapped[1]

  return s
}

function normalizePattern(raw: string): string {
  if (!raw) return ''
  let s = raw.trim().toLowerCase()
  if (s.endsWith('.') && !s.includes('/')) s = s.slice(0, -1)
  return s
}

export function matchPattern(subject: string, pattern: string): boolean {
  const s = normalizeSubject(subject)
  const p = normalizePattern(pattern)
  if (!s || !p) return false

  // Wildcard *.domain
  if (p.startsWith('*.')) {
    const bare = p.slice(2)
    return s === bare || s.endsWith('.' + bare)
  }

  // CIDR
  if (p.includes('/')) {
    const [network, bitsStr] = p.split('/')
    const bits = parseInt(bitsStr, 10)

    // IPv6 CIDR
    if (isIPv6(network)) {
      if (!isIPv6(s)) return false
      if (isNaN(bits) || bits < 0 || bits > 128) return false
      if (bits === 0) return true
      const subjectValue = ipv6ToBigInt(s)
      const networkValue = ipv6ToBigInt(network)
      if (subjectValue === null || networkValue === null) return false
      const shift = BigInt(128 - bits)
      return (subjectValue >> shift) === (networkValue >> shift)
    }

    // IPv4 CIDR
    if (!isIPv4(s)) return false
    if (isNaN(bits) || bits < 0 || bits > 32) return false
    if (bits === 0) return true
    const mask = ~(2 ** (32 - bits) - 1) >>> 0
    return (ipv4ToLong(s) & mask) === (ipv4ToLong(network) & mask)
  }

  // Exact match (case already normalized)
  return s === p
}

// ─── Adjacency ──────────────────────────────────────────────────────────────
//
// Beyond in/out, a target can sit next to scope: the same /24 as an in-scope
// address, or the same registrable domain as an in-scope host. That is the
// likeliest shape of an accidental scope violation, which is why the alarm
// warns on it. These helpers read NORMALISED input only — the adjacency rungs
// used to see the raw subject, so `Dev.Target.com`, `dev.target.com:8443` and
// `https://dev.target.com/x` fell through to `unrelated` beside an in-scope
// `target.com` while the bare lowercase form was caught.

/** Where a target sits relative to the scope. `in_scope` covers "no scope is
 *  configured" too; the filter view separates that case as `no-scope`. */
export type ScopeDistance = 'in_scope' | 'excluded' | 'adjacent_subnet' | 'adjacent_domain' | 'unrelated'

// Not the full Public Suffix List (that is megabytes), but the two-label
// eTLDs an engagement actually meets. A naive last-two-labels would make
// `target.co.uk` and `attacker.co.uk` siblings. A residual mismatch degrades
// to `unrelated`, the quiet side.
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

function subnetOf(ip: string, prefix = 24): string | null {
  if (!isIPv4(ip)) return null
  const net = (ipv4ToLong(ip) & (~(2 ** (32 - prefix) - 1) >>> 0)) >>> 0
  return `${(net >>> 24) & 0xff}.${(net >>> 16) & 0xff}.${(net >>> 8) & 0xff}.${net & 0xff}/${prefix}`
}

/** The subnets and registrable domains the adjacency rungs compare against.
 *  Derived from the allowlist alone, so a caller judging thousands of stored
 *  rows builds it once. */
export interface ScopeIndexes {
  subnets: Set<string>
  domains: Set<string>
}

export function buildScopeIndexes(targets: readonly string[]): ScopeIndexes {
  const subnets = new Set<string>()
  const domains = new Set<string>()
  for (const raw of targets) {
    const t = normalizePattern(raw)
    if (!t) continue
    if (t.includes('/')) {
      const sub = subnetOf(t.split('/')[0])
      if (sub) subnets.add(sub)
    } else if (isIPv4(t)) {
      const sub = subnetOf(t)
      if (sub) subnets.add(sub)
    } else if (!t.includes(':')) {
      domains.add(registrableDomain(t.startsWith('*.') ? t.slice(2) : t))
    }
  }
  return { subnets, domains }
}

export type ScopeDecision =
  | { status: 'in-scope';    matchedBy: string }
  | { status: 'out-of-scope' }
  | { status: 'excluded';    matchedBy: string }
  | { status: 'no-scope' }

export interface ScopePolicy {
  targets: string[]
  excludeTargets: string[]
}

/** One decision, two views. `status` is what the investigation filter needs;
 *  `distance` is what export masking, recompute and the scope alarm need.
 *  They cannot disagree because neither is computed separately. */
export interface ScopeClassification {
  status: ScopeDecision['status']
  distance: ScopeDistance
  matchedBy?: string
}

/**
 * The single scope decision procedure (constitution III). The subject is
 * normalised once, before every rung — exclusion, allowlist and both adjacency
 * rungs — so how a host was written cannot change where it sits.
 *
 * A project with no allowlist is "no scope": nothing is out of scope except
 * what is explicitly excluded. That holds whether or not exclusions exist; an
 * exclude-only project used to classify every other target as `unrelated`,
 * which export masking read as out of scope.
 */
export function classifyScope(
  subject: string,
  policy: ScopePolicy,
  indexes?: ScopeIndexes
): ScopeClassification {
  if (policy.targets.length === 0 && policy.excludeTargets.length === 0) {
    return { status: 'no-scope', distance: 'in_scope' }
  }

  const s = normalizeSubject(subject)
  if (!s) return { status: 'out-of-scope', distance: 'unrelated' }

  for (const ex of policy.excludeTargets) {
    if (matchPattern(s, ex)) return { status: 'excluded', distance: 'excluded', matchedBy: ex }
  }

  if (policy.targets.length === 0) return { status: 'no-scope', distance: 'in_scope' }

  for (const t of policy.targets) {
    if (matchPattern(s, t)) return { status: 'in-scope', distance: 'in_scope', matchedBy: t }
  }

  const idx = indexes ?? buildScopeIndexes(policy.targets)
  if (isIPv4(s)) {
    const sub = subnetOf(s)
    if (sub && idx.subnets.has(sub)) return { status: 'out-of-scope', distance: 'adjacent_subnet' }
  } else if (idx.domains.has(registrableDomain(s))) {
    return { status: 'out-of-scope', distance: 'adjacent_domain' }
  }
  return { status: 'out-of-scope', distance: 'unrelated' }
}

/** The filter view of `classifyScope`. */
export function evaluateScope(subject: string, policy: ScopePolicy): ScopeDecision {
  const c = classifyScope(subject, policy)
  if (c.status === 'in-scope' || c.status === 'excluded') {
    return { status: c.status, matchedBy: c.matchedBy as string }
  }
  return { status: c.status }
}

// Convenience: boolean check used by most surfaces
export function isInScope(subject: string, targets: string[], excludeTargets: string[] = []): boolean {
  const d = evaluateScope(subject, { targets, excludeTargets })
  return d.status === 'in-scope' || d.status === 'no-scope'
}
