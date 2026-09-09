// Client-side scope classification for host / target strings, mirroring the
// display logic §4c TargetView grew first. It stays in the renderer because it
// is stricter on CIDR than core's matcher (proper 32-bit mask), and it drives
// DISPLAY only — the authoritative in-chain verdict is core's
// `classifyScopeTarget`, which is what a `scope_violation` event records. Used
// to mark out-of-scope (non-attack) hosts in HTTP History (§7a) and Targets.

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0
}

/** True when `target` (a host or IP) matches one scope pattern: a bare host,
 *  a `*.example.com` wildcard, or a `10.0.0.0/8` CIDR. */
export function matchesScope(target: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const bare = pattern.slice(2)
    return target === bare || target.endsWith('.' + bare)
  }
  if (pattern.includes('/')) {
    const [net, bits] = pattern.split('/')
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(target)) return false
    const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0
    return (ipToLong(target) & mask) === (ipToLong(net) & mask)
  }
  return target === pattern
}

/** Scope verdict for a host from the project's allow + exclude lists:
 *  - No allow list configured → in-scope (there is no rule to violate).
 *  - An explicit exclude match → out of scope, always (excludes win).
 *  - Otherwise in-scope iff it matches an allow pattern.
 *  Mirror of the `inScope` column TargetView computes. */
export function hostInScope(
  host: string,
  targets: string[],
  excludeTargets: string[] = []
): boolean {
  if (!host) return true
  if (excludeTargets.some((p) => matchesScope(host, p))) return false
  if (targets.length === 0) return true
  return targets.some((p) => matchesScope(host, p))
}

/** True only when a scope IS configured AND `host` falls outside it — the
 *  condition for the §7a "範圍外" marker. Returns false when no scope is set
 *  (nothing to be outside of) so the marker never appears on an unscoped
 *  engagement. */
export function hostOutOfScope(
  host: string,
  targets: string[],
  excludeTargets: string[] = []
): boolean {
  if (!host) return false
  if (targets.length === 0 && excludeTargets.length === 0) return false
  return !hostInScope(host, targets, excludeTargets)
}
