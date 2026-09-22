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

export type ScopeDecision =
  | { status: 'in-scope';    matchedBy: string }
  | { status: 'out-of-scope' }
  | { status: 'excluded';    matchedBy: string }
  | { status: 'no-scope' }

export interface ScopePolicy {
  targets: string[]
  excludeTargets: string[]
}

export function evaluateScope(subject: string, policy: ScopePolicy): ScopeDecision {
  if (policy.targets.length === 0 && policy.excludeTargets.length === 0) {
    return { status: 'no-scope' }
  }

  const s = normalizeSubject(subject)
  if (!s) return { status: 'out-of-scope' }

  for (const ex of policy.excludeTargets) {
    if (matchPattern(s, ex)) {
      return { status: 'excluded', matchedBy: ex }
    }
  }

  if (policy.targets.length === 0) {
    return { status: 'no-scope' }
  }

  for (const t of policy.targets) {
    if (matchPattern(s, t)) {
      return { status: 'in-scope', matchedBy: t }
    }
  }

  return { status: 'out-of-scope' }
}

// Convenience: boolean check used by most surfaces
export function isInScope(subject: string, targets: string[], excludeTargets: string[] = []): boolean {
  const d = evaluateScope(subject, { targets, excludeTargets })
  return d.status === 'in-scope' || d.status === 'no-scope'
}
