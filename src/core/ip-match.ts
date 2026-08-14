// One address matcher for the whole alert subsystem (`ALERT-ROLES.md` G-A5).
//
// `ip-monitor.ts` and `scope-monitor.ts` each carried their own `ipToLong` +
// CIDR matcher, and both were IPv4-only in different ways:
//
//   * ip-monitor compared IPv6 by STRING EQUALITY against the network part, so
//     `2001:db8::1` was never inside `2001:db8::/32` and a v6 whitelist could
//     not match — dropping the verdict into A-5/A-9 (or, with a v4-only
//     blacklist, the A-3 fall-through, which used to answer green).
//   * scope-monitor's `IP_RE` matched only dotted quads, so a v6 target was
//     routed through the DOMAIN matcher: a v6 CIDR scope entry never matched,
//     and on the adjacency path a v6 host fell out as `unrelated` — silent.
//     Silence is the one direction this subsystem must never fail in.
//
// So: one implementation, both families, used by both monitors.

export type IPFamily = 4 | 6

interface ParsedIP {
  family: IPFamily
  /** family 4: the address as an unsigned 32-bit number. */
  v4?: number
  /** family 6: 16 bytes, network order. */
  v6?: Uint8Array
}

/** IPv6 subnets are /64 by convention almost everywhere, so unlike the v4
 *  container width there is no meaningful operator choice to expose — see
 *  `ALERT-ROLES.md` C.4 on not adding knobs that have one right answer. */
export const V6_PROXIMITY_BITS = 64

export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i])
    if (octet > 255) return null
    n = n * 256 + octet
  }
  return n >>> 0
}

/** Expand one colon-separated run into 16-bit groups, accepting a trailing
 *  dotted-quad (`::ffff:192.0.2.1`, `64:ff9b::192.0.2.1`). */
function groupsFrom(parts: string[]): number[] | null {
  const out: number[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.includes('.')) {
      if (i !== parts.length - 1) return null    // embedded v4 must be last
      const v4 = parseIPv4(p)
      if (v4 === null) return null
      out.push((v4 >>> 16) & 0xffff, v4 & 0xffff)
      continue
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null
    out.push(parseInt(p, 16))
  }
  return out
}

export function parseIPv6(input: string): Uint8Array | null {
  // Strip a zone id (`fe80::1%en0`) and any URL brackets before parsing.
  const s = input.replace(/^\[|\]$/g, '').split('%')[0]
  if (!s.includes(':')) return null

  const halves = s.split('::')
  if (halves.length > 2) return null

  let groups: number[]
  if (halves.length === 2) {
    const head = halves[0] ? groupsFrom(halves[0].split(':')) : []
    const tail = halves[1] ? groupsFrom(halves[1].split(':')) : []
    if (!head || !tail) return null
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null      // `::` stands for at least one zero group
    groups = [...head, ...new Array(fill).fill(0), ...tail]
  } else {
    const g = groupsFrom(s.split(':'))
    if (!g || g.length !== 8) return null
    groups = g
  }

  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >>> 8) & 0xff
    bytes[i * 2 + 1] = groups[i] & 0xff
  }
  return bytes
}

function isV4Mapped(b: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return false
  return b[10] === 0xff && b[11] === 0xff
}

/** Parse either family. An IPv4-mapped IPv6 address (`::ffff:10.8.0.5`) is
 *  reported as IPv4 — providers do return that form, and an operator whose
 *  whitelist says `10.8.0.0/24` means it to match. */
export function parseIP(s: string): ParsedIP | null {
  if (s.includes(':')) {
    const b = parseIPv6(s)
    if (!b) return null
    if (isV4Mapped(b)) {
      return { family: 4, v4: ((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0 }
    }
    return { family: 6, v6: b }
  }
  const v4 = parseIPv4(s)
  return v4 === null ? null : { family: 4, v4 }
}

export function ipFamily(s: string): IPFamily | null {
  return parseIP(s)?.family ?? null
}

/** True for anything that is an IP address literal, either family. Replaces the
 *  dotted-quad regexes that made v6 look like a hostname. */
export function isIPLiteral(s: string): boolean {
  return parseIP(s) !== null
}

function prefixEqual(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const whole = bits >> 3
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false
  const rest = bits & 7
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (a[whole] & mask) === (b[whole] & mask)
}

/** Is `ip` inside `cidr`? Without a `/`, this is address equality — compared as
 *  parsed values, not strings, so `2001:db8::1` matches the fully expanded
 *  `2001:0db8:0000:0000:0000:0000:0000:0001`. A malformed address, a malformed
 *  prefix length, or a family mismatch is `false`: this decides whether to
 *  raise an alert, so unparseable input must never accidentally match. */
export function ipInCIDR(ip: string, cidr: string): boolean {
  const a = parseIP(ip)
  if (!a) return false

  if (!cidr.includes('/')) {
    const b = parseIP(cidr)
    if (!b || b.family !== a.family) return false
    return a.family === 4 ? a.v4 === b.v4 : prefixEqual(a.v6!, b.v6!, 128)
  }

  const slash = cidr.lastIndexOf('/')
  const b = parseIP(cidr.slice(0, slash))
  if (!b || b.family !== a.family) return false

  const bitsRaw = cidr.slice(slash + 1)
  if (!/^\d{1,3}$/.test(bitsRaw)) return false
  const bits = Number(bitsRaw)
  const max = a.family === 4 ? 32 : 128
  if (bits > max) return false

  if (a.family === 6) return prefixEqual(a.v6!, b.v6!, bits)
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1) >>> 0)
  return (a.v4! & mask) >>> 0 === (b.v4! & mask) >>> 0
}
