// The three view modes (docs/UIUX-STANDARD.md §6).
//
// The toolbar carried eight independent toggles — collapse agent turns,
// compress idle gaps, session dividers, anomaly filter, auditor view, follow,
// timezone, lane visibility — sitting side by side with equal weight and no
// stated relationship. Eight booleans is 256 states, and an operator arriving
// at one of them had no way to know whether it was a sensible place to be.
//
// They are not really independent. They fall into three postures an operator
// actually holds:
//
//   working  mid-engagement, watching it happen. Collapse the agent's turns,
//            skip the idle stretches, local time.
//   audit    reading the record back, or handing it to someone who will.
//            Chained events only, anomalies marked, UTC, and time NOT
//            compressed — a gap is evidence about when nothing happened, and
//            squeezing it is editing the record.
//   debug    something is wrong with capture itself. Everything, including
//            session boundaries and raw time.
//
// Audit mode is locked. Every other mode is a convenience and can be adjusted;
// audit is a claim about what is being shown, and a claim you can quietly
// tweak is not a claim. Adjusting any setting while in audit leaves audit —
// which is the honest outcome, and visible, rather than an audit view that no
// longer means what it says.

export type TimelineMode = 'working' | 'audit' | 'debug'

export interface TimelineSettings {
  /** Fold an agent's back-and-forth into one row. */
  collapseAgentTurns: boolean
  /** Squeeze stretches where nothing happened. */
  compressGaps: boolean
  /** Show only hash-chained events, hiding the logged tier. */
  auditorView: boolean
  /** Mark rows the anomaly detector flagged. */
  anomalyFilter: boolean
  /** Draw a divider at each terminal session boundary. */
  sessionDividers: boolean
  tz: 'local' | 'utc' | 'project'
}

export const MODE_SETTINGS: Record<TimelineMode, TimelineSettings> = {
  working: {
    collapseAgentTurns: true,
    compressGaps: true,
    auditorView: false,
    anomalyFilter: false,
    sessionDividers: false,
    tz: 'local'
  },
  audit: {
    // Nothing folded and nothing skipped: a reader of the record must see the
    // same rows the chain contains, in the spacing they actually occurred.
    collapseAgentTurns: false,
    compressGaps: false,
    auditorView: true,
    anomalyFilter: true,
    sessionDividers: false,
    // UTC, because a report read in another country must not depend on where
    // it was written.
    tz: 'utc'
  },
  debug: {
    collapseAgentTurns: false,
    compressGaps: false,
    auditorView: false,
    anomalyFilter: false,
    sessionDividers: true,
    tz: 'local'
  }
}

/** Audit is the only mode whose settings cannot be adjusted in place. */
export function isLocked(mode: TimelineMode): boolean {
  return mode === 'audit'
}

/** The mode these settings represent, or null when they match none — which is
 *  what the UI shows as "custom" rather than pretending one of the three is
 *  still selected. */
export function modeFor(settings: TimelineSettings): TimelineMode | null {
  const keys = Object.keys(MODE_SETTINGS.working) as Array<keyof TimelineSettings>
  for (const [mode, preset] of Object.entries(MODE_SETTINGS) as Array<[TimelineMode, TimelineSettings]>) {
    if (keys.every((k) => settings[k] === preset[k])) return mode
  }
  return null
}

/**
 * Apply a change to one setting.
 *
 * From audit this returns the adjusted settings and drops the mode, because
 * the result is no longer an audit view and must stop calling itself one. The
 * caller decides whether to offer that at all — the toolbar disables the
 * controls in audit — but if it happens, leaving the mode is the honest
 * outcome, not silently keeping the label.
 */
export function adjust<K extends keyof TimelineSettings>(
  settings: TimelineSettings,
  key: K,
  value: TimelineSettings[K]
): TimelineSettings {
  return { ...settings, [key]: value }
}
