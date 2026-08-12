// One pure derivation for the Timeline's "Active:" row (DESIGN-TIMELINE-
// INTERACTION §T3). The track carries several sticky, non-default modes that each
// HIDE or TRANSFORM events — focus chain, anomaly filter, agent-turn collapse,
// lane solo, hidden lanes, text filter. Left on, they leave the operator staring
// at a near-empty track with no explanation (DESIGN-PRINCIPLES §8: an empty track
// must explain itself). This function turns the current mode state into the exact
// set of dismissible chips the row renders — one per non-default mode, in a fixed
// order — and returns [] when everything is default so the UI drops the row
// entirely instead of drawing an empty bar.
//
// Scope note: follow mode is deliberately absent. It auto-scrolls but hides no
// data, so per the design's open-question #3 it stays a header toggle, not a chip
// — and keeping it off TimelineModeState keeps it out of this seam by construction.

export interface TimelineModeState {
  /** focus-chain mode is active (isolates one causal chain) */
  focusActive: boolean
  /** anomaly filter is on (only flagged events shown) */
  anomalyOnly: boolean
  /** agent turns are collapsed (multi-event turns folded to one) */
  collapseAgentTurns: boolean
  /** a single lane is soloed (null = no solo); every other lane is hidden */
  soloLane: string | null
  /** how many lanes are hidden by the operator (0 = none) */
  hiddenLaneCount: number
  /** the '/' text filter query ('' = no filter) */
  filterQuery: string
}

export interface ModeChip {
  /** stable identity for the mode, drives keying and the chip's icon */
  id: string
  /** stable i18n identifier — resolved by the caller, never registered here */
  labelKey: string
  /** action id the chip's ✕ dispatches to clear just this mode */
  clearAction: string
  /** optional dynamic payload (lane name, hidden count, query text) */
  value?: string
}

export function activeModes(state: TimelineModeState): ModeChip[] {
  const chips: ModeChip[] = []

  // Fixed order: focus → anomaly → collapse-agent → solo/hidden → filter. The
  // order is part of the contract so the row never reshuffles between renders.
  if (state.focusActive) {
    chips.push({ id: 'focus', labelKey: 'timeline.mode.focus', clearAction: 'clear-focus' })
  }
  if (state.anomalyOnly) {
    chips.push({ id: 'anomaly', labelKey: 'timeline.mode.anomaly', clearAction: 'clear-anomaly' })
  }
  if (state.collapseAgentTurns) {
    chips.push({
      id: 'collapse-agent',
      labelKey: 'timeline.mode.collapseAgent',
      clearAction: 'clear-collapse-agent'
    })
  }

  // Solo and hidden-lanes are mutually exclusive in the row: a soloed lane
  // already hides every other lane, so the hidden count is redundant noise while
  // solo is on. Show the sharper fact (which lane) and suppress the count.
  if (state.soloLane !== null) {
    chips.push({
      id: 'solo',
      labelKey: 'timeline.mode.solo',
      clearAction: 'clear-solo',
      value: state.soloLane
    })
  } else if (state.hiddenLaneCount > 0) {
    chips.push({
      id: 'hidden-lanes',
      labelKey: 'timeline.mode.hiddenLanes',
      clearAction: 'clear-hidden-lanes',
      value: String(state.hiddenLaneCount)
    })
  }

  // Emptiness is strictly '' — a query of only spaces is an odd but real filter,
  // so it still earns a chip and its text is carried verbatim.
  if (state.filterQuery !== '') {
    chips.push({
      id: 'filter',
      labelKey: 'timeline.mode.filter',
      clearAction: 'clear-filter',
      value: state.filterQuery
    })
  }

  return chips
}
