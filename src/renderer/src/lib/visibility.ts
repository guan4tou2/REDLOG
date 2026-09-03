// Which nouns the interface admits to, given what the engagement actually
// contains (docs/UIUX-STANDARD.md §22).
//
// One rule: a noun does not appear before its data exists. On day one the
// sidebar is four rows, and 目標 / 範圍 / 戰利品 / 截圖 / 標記 / HTTP / 逐字稿 /
// 搜尋 arrive as the work that produces them arrives. The cost of the current
// design is paid on the first day by every new operator, who is asked to
// understand eleven pages before having done anything; the cost of this one is
// paid by nobody, because a hidden page is never unreachable — ⌘K lists every
// view regardless, and the appearance settings can turn the whole thing off.
//
// THREE PROPERTIES, and each is a trap the obvious implementation falls into.
//
// DERIVED, NEVER REMEMBERED. Visibility is a projection of the record. Nothing
// here is persisted except the operator's explicit opt-out, so two people
// opening the same project see the same sidebar and the record is never a
// function of who is looking at it.
//
// MONOTONIC. A noun that has appeared never disappears. Retention prunes the
// logged tier after thirty days, and a page vanishing because its evidence
// aged out would read as the evidence having been destroyed.
//
// THE SIGNAL MUST BE THE PAGE'S OWN DATA. Unlocking a page that then renders
// empty is worse than leaving it hidden — it teaches the operator that the
// sidebar lies. Every predicate below is keyed to what its page actually reads,
// which is why several of them are narrower than they first appear; the notes
// say which and why.
//
// Pure: no React, no window, no src/core import — the boundary captureReadiness
// keeps.

import { DEFAULT_ORDER, type SidebarViewId } from './sidebarOrder'

/**
 * Existence flags, capped. Deliberately not counts: "how many" is not a
 * question this asks, and a count would invite a refetch on every event.
 */
export interface VisibilitySignals {
  /** Any row that represents work, as opposed to the app talking to itself. */
  evidenceSeen: boolean
  /** A finished command, or any agent turn. */
  transcriptSeen: boolean
  /** Distinct targets derived from COMMANDS, capped at 2. */
  targetCount: 0 | 1 | 2
  lootSeen: boolean
  screenshotSeen: boolean
  /** A quickmarks row — the table the 標記 page actually lists. */
  markSeen: boolean
  /** A logged-tier HTTP flow — what the HTTP page actually queries. */
  httpFlowSeen: boolean
  /** The engagement has ever had a logged-tier row. */
  loggedEver: boolean
}

export const EMPTY_SIGNALS: VisibilitySignals = {
  evidenceSeen: false,
  transcriptSeen: false,
  targetCount: 0,
  lootSeen: false,
  screenshotSeen: false,
  markSeen: false,
  httpFlowSeen: false,
  loggedEver: false
}

/** The first day: somewhere to look, somewhere to read, somewhere to type.
 *  Settings is pinned outside DEFAULT_ORDER and always shown, so the sidebar
 *  starts at exactly four buttons. */
export const DAY_ONE: readonly SidebarViewId[] = ['dashboard', 'timeline', 'terminal']

/**
 * What each noun waits for.
 *
 * Several of these are narrower than the obvious version, and the reasons are
 * the whole design:
 *
 * `targets` / `scope` count targets derived from COMMANDS. The proxy addon
 * stamps a target on every HTTP flow and DNS query, and the connection monitor
 * on every established socket — so the obvious "any row with a target" would
 * unlock both pages from one browser page load, with no command typed, which
 * is the inverse of what §22 asks for.
 *
 * `http_history` waits for a LOGGED HTTP flow, because that is what its page
 * queries. A chained `scanner:connection` row from the connection monitor would
 * otherwise unlock a permanently empty page.
 *
 * `marks` waits for a quickmarks row, not a marker event: those are two
 * different stores, and the page lists only the former.
 *
 * `search` waits for evidence rather than for nothing, so it never opens onto a
 * corpus with nothing findable in it.
 */
export const UNLOCK: Record<SidebarViewId, (s: VisibilitySignals) => boolean> = {
  dashboard: () => true,
  timeline: () => true,
  terminal: () => true,
  search: (s) => s.evidenceSeen,
  transcript: (s) => s.transcriptSeen,
  targets: (s) => s.targetCount >= 1,
  scope: (s) => s.targetCount >= 2,
  loot: (s) => s.lootSeen,
  screenshots: (s) => s.screenshotSeen,
  marks: (s) => s.markSeen,
  http_history: (s) => s.httpFlowSeen
}

export interface Visibility {
  /** The sidebar rows to render, in DEFAULT_ORDER. */
  views: ReadonlySet<SidebarViewId>
  /** Whether the Inspector shows the tier chip. Two tiers is a distinction
   *  worth nothing to a project that has only ever had one. */
  tierChip: boolean
  /** Nothing has been captured yet, so the app should say what to do rather
   *  than show empty dashboards. */
  firstRun: boolean
  /** Every gate is open — the caller can stop probing. */
  complete: boolean
}

/**
 * `showAllPages` is the operator's opt-out and the only user state in the
 * feature. It governs PAGES only: the tier chip and the first-run screen stay
 * data-derived, because showing a chip for a distinction that does not exist,
 * or a "type your first command" screen to someone who has typed thousands,
 * would be noise rather than disclosure.
 */
export function computeVisibility(signals: VisibilitySignals, showAllPages = false): Visibility {
  const views = new Set<SidebarViewId>(
    showAllPages ? DEFAULT_ORDER : DEFAULT_ORDER.filter((id) => UNLOCK[id](signals))
  )
  return {
    views,
    tierChip: signals.loggedEver,
    firstRun: !signals.evidenceSeen,
    complete: allDisclosed(signals)
  }
}

/** Every gate open, ignoring the opt-out. */
export function allDisclosed(signals: VisibilitySignals): boolean {
  return DEFAULT_ORDER.every((id) => UNLOCK[id](signals)) && signals.loggedEver
}

/** A row that could open a gate that is still closed.
 *
 *  Used to decide whether an incoming batch is worth a re-probe at all — a scan
 *  produces hundreds of rows a second, and re-running eight SQL probes for each
 *  of them would put the disclosure model on the hot path of capture. */
export function shouldRefetch(
  signals: VisibilitySignals,
  batch: ReadonlyArray<{ agentType: string; data?: Record<string, unknown> | null; tier?: string }>
): boolean {
  if (allDisclosed(signals)) return false
  for (const e of batch) {
    const sub = String(e.data?.subtype ?? '')
    if (!signals.evidenceSeen && e.agentType !== 'system' && e.agentType !== 'cleanup') return true
    if (!signals.lootSeen && e.agentType === 'loot') return true
    if (!signals.screenshotSeen && e.agentType === 'screenshot') return true
    if (!signals.transcriptSeen && (e.agentType === 'agent' || (e.agentType === 'shell' && sub === 'command_end'))) return true
    if (signals.targetCount < 2 && e.agentType === 'shell' && sub === 'command_start') return true
    if (!signals.httpFlowSeen && e.agentType === 'scanner' && (sub === 'http_request_start' || sub === 'http_response')) return true
    if (!signals.loggedEver && e.tier === 'logged') return true
  }
  return false
}
