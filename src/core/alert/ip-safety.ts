// The one answer to "may this IP status be shown as safe?". Main applies it
// before `ip:getStatus` / `ip:status` leave the process; the status bar, the
// dashboard card and the HUD apply it again to what they receive. Pure and
// import-free so the renderer can load it.

export type IpSafety = 'safe' | 'exposed' | 'unknown'

export interface IpSafetyReading {
  ipSafety?: unknown
  externalIP?: unknown
  error?: unknown
  /** When `externalIP` was last read (ms). Judged only with `freshness`. */
  externalReadAt?: number
}

/** Safe needs an address that was read, no failed read since, and — where the
 *  caller knows the poll cadence — a read recent enough to still be the
 *  egress. Anything short of that is unknown. Exposed is never softened. */
export function shownIpSafety(
  s: IpSafetyReading | null | undefined,
  freshness?: { now: number; maxAgeMs: number }
): IpSafety {
  if (!s) return 'unknown'
  if (s.ipSafety === 'exposed') return 'exposed'
  if (s.ipSafety !== 'safe') return 'unknown'
  if (typeof s.externalIP !== 'string' || s.externalIP.trim() === '') return 'unknown'
  if (s.error) return 'unknown'
  if (freshness) {
    const at = s.externalReadAt ?? 0
    if (!(at > 0) || freshness.now - at > freshness.maxAgeMs) return 'unknown'
  }
  return 'safe'
}

/** How old the last read of the stable address may be. A new address takes
 *  `confirmations` polls to replace it, so a read older than that many polls
 *  (plus one, plus the slowest lookup) means the egress is something else. */
export function ipReadMaxAgeMs(checkIntervalSec: number, confirmations: number): number {
  return (confirmations + 1) * checkIntervalSec * 1000 + 30_000
}
