// Module-level cache for the last full-chain verify result.
//
// Settings ▸ Audit ▸ Verify full chain writes here after each successful
// (or broken) walk; Timeline reads it on mount + on the
// `redlog-timeline-verify-updated` window event so a fresh mount of the
// Timeline can still render the broken-chain banner + badges without the
// operator having to re-open Settings and click Verify again.

export interface FullVerifyResult {
  ok: boolean
  walked?: number
  brokenAtEventId?: string | null
  brokenReason?: string | null
  currentHead?: string | null
  anchor?: unknown
  anchorMatchesWalkedHead?: boolean
  clockAnomalies?: Array<{ eventId: string; reason: string }>
  signedCount?: number
  unsignedCount?: number
  badSignatureAtEventId?: string | null
}

// The custom-event name dispatched on window after set/clear. Named on module
// so both writer (Settings) and reader (Timeline) import the same string —
// no risk of a typo silently breaking the subscription.
export const VERIFY_UPDATED_EVENT = 'redlog-timeline-verify-updated'

let cached: FullVerifyResult | null = null

export function setLastVerifyResult(r: FullVerifyResult | null): void {
  cached = r
  try { window.dispatchEvent(new CustomEvent(VERIFY_UPDATED_EVENT)) } catch { /* SSR / test env */ }
}

export function getLastVerifyResult(): FullVerifyResult | null {
  return cached
}
