// What the interface says about an engagement that has captured nothing yet.
//
// This file used to hide sidebar pages until the record held the noun each one
// was named after — eleven gates, an opt-out, and a hint line in the nav to
// explain the absence. It is gone. The argument for it was that a new operator
// should not be asked to understand eleven pages before doing anything; what
// actually happened was that the app's own author opened a fresh project twice
// and asked why the sidebar had three rows. A design that needs a sentence in
// the sidebar explaining what it has hidden, and a checkbox in Settings to
// undo it, is charging more than eleven rows are worth.
//
// Two things survive, and neither hides a way in:
//
//   firstRun  nothing captured yet, so the dashboard should say what to do
//             rather than show empty panels
//   tierChip  the Inspector draws the tier distinction only for a project
//             that has ever had two tiers
//
// Both are statements about the data, and both are monotonic: a flag that has
// gone true never goes back. Retention prunes the logged tier after thirty
// days, and a screen reverting because its evidence aged out would read as the
// evidence having been destroyed.
//
// Pure: no React, no window, no src/core import — the boundary
// captureReadiness keeps.

/** Existence flags, capped. Deliberately not counts: "how many" is not a
 *  question this asks, and a count would invite a refetch on every event. */
export interface VisibilitySignals {
  /** Any row that represents work, as opposed to the app talking to itself. */
  evidenceSeen: boolean
  /** The engagement has ever had a logged-tier row. */
  loggedEver: boolean
}

export const EMPTY_SIGNALS: VisibilitySignals = {
  evidenceSeen: false,
  loggedEver: false
}

export interface Visibility {
  /** Whether the Inspector shows the tier chip. Two tiers is a distinction
   *  worth nothing to a project that has only ever had one. */
  tierChip: boolean
  /** Nothing has been captured yet, so the app should say what to do rather
   *  than show empty dashboards. */
  firstRun: boolean
  /** Both answers are in — the caller can stop probing. */
  complete: boolean
}

export function computeVisibility(signals: VisibilitySignals): Visibility {
  return {
    tierChip: signals.loggedEver,
    firstRun: !signals.evidenceSeen,
    complete: signals.evidenceSeen && signals.loggedEver
  }
}

/** A row that could answer a question still open.
 *
 *  Used to decide whether an incoming batch is worth a re-probe at all — a
 *  scan produces hundreds of rows a second, and re-running the probes for each
 *  of them would put this on the hot path of capture. */
export function shouldRefetch(
  signals: VisibilitySignals,
  batch: ReadonlyArray<{ agentType: string; data?: Record<string, unknown> | null; tier?: string }>
): boolean {
  if (signals.evidenceSeen && signals.loggedEver) return false
  for (const e of batch) {
    if (!signals.evidenceSeen && e.agentType !== 'system' && e.agentType !== 'cleanup') return true
    if (!signals.loggedEver && e.tier === 'logged') return true
  }
  return false
}
