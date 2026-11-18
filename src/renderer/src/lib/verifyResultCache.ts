import { clearIssue } from './issues'

// Module-level cache for the last full-chain verify result of this run of the
// app.
//
// lib/chainActions writes here after each walk, wherever it was started (the
// Evidence page's Verify, the dashboard's fix button); the Evidence page and
// the Timeline read it, and hear about a new one through the
// `redlog-timeline-verify-updated` window event.
//
// It lives in memory on purpose. A restart has no result: the record may have
// changed while the app was closed, so the only honest thing to show then is
// "not verified yet". It also carries which project it was walked on, so a
// result from the project left a minute ago is never shown on the next one.

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
  noPubKeyCount?: number
  authentication?: 'verified' | 'none' | 'failed'
  authenticationReasons?: string[]
  firstUncheckedEventId?: string | null
  badSignatureAtEventId?: string | null
}

/** One walk: what it found, when it finished, and on which project. */
export interface VerifyRecord {
  result: FullVerifyResult
  verifiedAt: number
  /** Null when the project could not be named for certain (it changed during
   *  the walk, or the read failed): such a result is shown on no project. */
  projectId: string | null
}

// The custom-event name dispatched on window after set/clear. Named on module
// so the writer (chainActions) and the readers import the same string —
// no risk of a typo silently breaking the subscription.
export const VERIFY_UPDATED_EVENT = 'redlog-timeline-verify-updated'

let cached: VerifyRecord | null = null

export function setLastVerifyResult(r: FullVerifyResult | null, meta: { verifiedAt?: number; projectId?: string | null } = {}): void {
  cached = r ? { result: r, verifiedAt: meta.verifiedAt ?? Date.now(), projectId: meta.projectId ?? null } : null
  try { window.dispatchEvent(new CustomEvent(VERIFY_UPDATED_EVENT)) } catch { /* SSR / test env */ }
}

/** The last walk, only when it was walked on `projectId`. */
export function getLastVerification(projectId: string | null): VerifyRecord | null {
  return cached && projectId !== null && cached.projectId === projectId ? cached : null
}

// The project the window has open, as App knows it. App notes it while it
// renders, before any page below it reads the cache, so a page never reads
// one project's result under another.
let openProject: string | null = null

/** App calls this on every render with the open project's id (or null). On a
 *  change, the previous project's chain and anchor issues are cleared: they
 *  are about a record that is no longer open. The clearing is deferred, since
 *  it notifies other components and this runs during a render. */
export function noteOpenProject(id: string | null): void {
  if (id === openProject) return
  openProject = id
  queueMicrotask(() => { clearIssue('chain'); clearIssue('anchor') })
}

/** The last walk, if it was walked on the project open now. */
export function getOpenVerification(): VerifyRecord | null {
  return cached && cached.projectId === openProject ? cached : null
}
