// capture-health (main process) answers "is anything wrong with capture right
// now" — an exception report for an operator mid-engagement. It does NOT answer
// the question a first-run operator actually has: the timeline is empty, what
// do I do? That gap is why the README has to say, in bold, "RedLog captures
// nothing until a source is wired up — being open is not enough."
//
// computeCaptureReadiness turns the same CaptureHealth the Dashboard already
// fetches over the bridge into a GROUPED onboarding model — which sources are
// live, which are set up but quiet, which are untouched, and the single most
// useful next action. It lives in the renderer because it is a
// PRESENTATION model (how to guide the operator), depends on nothing in the
// main process, and reads only fields present on the bridge's CaptureHealthInfo.
// Pure and side-effect free, so it is unit tested without a DB or a renderer.

// Capture sources, grouped by what they capture — not ranked.
//
// This was an ordered triple: shell hook, then agent tailer, then built-in
// terminal, with everything else (mitmproxy, clipboard, screenshots, the file
// and process watchers) declared "enrichment" and excluded from the
// dark→recording path outright. Two things were wrong with that.
//
// The ordering claimed a sequence that does not exist. An operator running a
// proxied web assessment wires mitmproxy first and may never install a shell
// hook; the model told them they were dark while HTTP events were landing on
// the timeline, because the source producing them was not on the list.
//
// And the grouping the ordering hid is the useful part: sources differ by
// *what they capture*, which is what an operator is actually choosing between.
// Commands, traffic, artefacts. Within a group the order carries no meaning,
// so the model no longer implies one.
export type CaptureGroupId = 'commands' | 'traffic' | 'artifacts'

export const CAPTURE_GROUPS: ReadonlyArray<{
  id: CaptureGroupId
  sources: readonly string[]
}> = [
  // What was typed, by a person or an agent.
  { id: 'commands', sources: ['shell-hook', 'agent-tailer', 'builtin-terminal'] },
  // What went over the wire. mitmproxy carries HTTP and DNS on one addon.
  { id: 'traffic', sources: ['mitmproxy', 'browser-console', 'connection-monitor'] },
  // What was on screen or on disk.
  { id: 'artifacts', sources: ['screenshot', 'clipboard', 'file-watcher', 'process-monitor'] }
]

// Minimal structural shape of a capture source. Both the main-process
// CaptureSource and the renderer's ambient CaptureSourceInfo satisfy it, so
// readiness needs no cross-boundary type import.
export interface ReadinessSource {
  id: string
  state: 'active' | 'idle' | 'absent' | 'off'
  installed?: boolean
  enabled?: boolean
  lastEventAt: number | null
}

export interface ReadinessHealth {
  sources: ReadinessSource[]
}

export type StepStatus =
  | 'active' // produced an event within the active window — it is recording
  | 'wired' // set up (hook installed, switch on, or has fed before) but quiet
  | 'todo' // nothing done yet, or explicitly switched off — offer the setup action

export interface ReadinessStep {
  /** stable id, matches the source id and the i18n `capture.*` labels */
  id: string
  status: StepStatus
  group: CaptureGroupId
}

export type ReadinessLevel =
  | 'dark' // nothing is set up at all — the timeline will stay empty
  | 'setup' // something is set up but nothing is actively feeding
  | 'recording' // at least one source, in any group, is live

export interface ReadinessGroup {
  id: CaptureGroupId
  steps: ReadinessStep[]
  /** how many sources in this group are feeding the timeline right now */
  activeCount: number
}

export interface CaptureReadiness {
  level: ReadinessLevel
  steps: ReadinessStep[]
  /** the same steps, grouped by what they capture — what the UI renders */
  groups: ReadinessGroup[]
  /** the single action to surface, or null once recording */
  nextStep: ReadinessStep | null
  /** how many sources are currently active, across every group */
  activeCount: number
}

// A source counts as "wired" when the operator has done the setup for it, even
// if no event has landed yet: a hook installed on disk, a config switch turned
// on, or (for passive sources with no switch, like the built-in terminal) at
// least one event ever recorded. A source that is explicitly switched OFF is
// NOT wired — for onboarding that is precisely the thing to nudge back on, so
// it ranks as `todo`, not `wired`.
function statusFor(source: ReadinessSource): StepStatus {
  if (source.state === 'active') return 'active'
  if (source.state === 'off') return 'todo'
  const wired =
    source.installed === true ||
    source.enabled === true ||
    source.lastEventAt !== null
  return wired ? 'wired' : 'todo'
}

export function computeCaptureReadiness(health: ReadinessHealth): CaptureReadiness {
  const byId = new Map(health.sources.map((s) => [s.id, s]))

  const steps: ReadinessStep[] = CAPTURE_GROUPS.flatMap((g) =>
    g.sources.map((id) => {
      const source = byId.get(id)
      // Defensive: a source missing from the payload counts as untouched
      // rather than throwing. The health shape drifts across versions and
      // readiness must never be the thing that crashes the card.
      const status: StepStatus = source ? statusFor(source) : 'todo'
      return { id, status, group: g.id }
    })
  )

  const groups: ReadinessGroup[] = CAPTURE_GROUPS.map((g) => {
    const own = steps.filter((s) => s.group === g.id)
    return { id: g.id, steps: own, activeCount: own.filter((s) => s.status === 'active').length }
  })

  const activeCount = steps.filter((s) => s.status === 'active').length

  let level: ReadinessLevel
  if (activeCount > 0) level = 'recording'
  else if (steps.every((s) => s.status === 'todo')) level = 'dark'
  else level = 'setup'

  // Chosen by state, not by position — the list is no longer a sequence, so
  // "first in the array" would be an arbitrary answer dressed up as a
  // recommendation.
  //
  // A `wired` source is one setup step ahead of a `todo` one: it needs an
  // event, not an installation. Guiding to it first is the shortest route out
  // of dark, which is the only thing this model is for. Ties inside a status
  // fall back to group order — commands before traffic before artefacts — not
  // because commands rank higher, but because a tie needs a stable answer and
  // that one at least matches how the groups are read.
  let nextStep: ReadinessStep | null = null
  if (level !== 'recording') {
    nextStep =
      steps.find((s) => s.status === 'wired') ??
      steps.find((s) => s.status === 'todo') ??
      null
  }

  return { level, steps, groups, nextStep, activeCount }
}


// §17: one primary action per state combination.
//
// A capture source has two independent axes — installed or not, switched on or
// not — and the manage row exposes both, correctly: collapsing them into one
// control hides which half is missing. But showing two equally-weighted buttons
// leaves the operator to work out which one moves them forward, and the answer
// is always determined by the state. So the axes stay, and exactly one of the
// controls is drawn as primary.
//
// The order is "make it exist, then make it run, then leave it alone": a source
// that is off cannot be helped by installing it again, and a source that is
// working needs no primary action at all — its buttons are for undoing, and
// undo is never the thing to emphasise.
export type CaptureAction = 'install' | 'enable' | 'none'

export function primaryCaptureAction(source: {
  state: ReadinessSource['state']
  installed?: boolean
  enabled?: boolean
  hookId?: string
}): CaptureAction {
  // Only a source with something to install can be installed; the built-in
  // terminal, for instance, has no hook.
  if (source.hookId && source.installed !== true) return 'install'
  if (source.enabled === false) return 'enable'
  return 'none'
}
