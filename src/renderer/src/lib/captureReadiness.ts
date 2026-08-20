// capture-health (main process) answers "is anything wrong with capture right
// now" — an exception report for an operator mid-engagement. It does NOT answer
// the question a first-run operator actually has: the timeline is empty, what
// do I do? That gap is why the README has to say, in bold, "RedLog captures
// nothing until a source is wired up — being open is not enough."
//
// computeCaptureReadiness turns the same CaptureHealth the Dashboard already
// fetches over the bridge into an ORDERED onboarding model — which core capture
// sources are live, which are set up but quiet, which are untouched, and the
// single most useful next action. It lives in the renderer because it is a
// PRESENTATION model (how to guide the operator), depends on nothing in the
// main process, and reads only fields present on the bridge's CaptureHealthInfo.
// Pure and side-effect free, so it is unit tested without a DB or a renderer.

// The sources a solo operator wires first, in the order the README leads with:
// the shell hook is the capture backbone, the agent tailer covers AI coding
// agents, the built-in terminal is the zero-setup fallback that records the
// moment a pane is opened. Everything else (mitmproxy, clipboard, screenshots,
// file/process watchers) is enrichment and is deliberately not part of the
// "go from dark to recording" path.
export const CORE_SOURCE_ORDER = ['shell-hook', 'agent-tailer', 'builtin-terminal'] as const

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
  /** part of the canonical dark→recording path (vs. optional enrichment) */
  core: boolean
}

export type ReadinessLevel =
  | 'dark' // no core source is set up — the timeline will stay empty
  | 'setup' // something is set up but nothing is actively feeding
  | 'recording' // at least one core source is live

export interface CaptureReadiness {
  level: ReadinessLevel
  steps: ReadinessStep[]
  /** the single action to surface, or null once recording */
  nextStep: ReadinessStep | null
  /** how many core sources are currently active — drives "N of 3 live" copy */
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

  const steps: ReadinessStep[] = CORE_SOURCE_ORDER.map((id) => {
    const source = byId.get(id)
    // Defensive: if a core source is missing from the payload, treat it as
    // untouched rather than throwing — the health shape can drift across
    // versions and readiness must never be the thing that crashes the card.
    const status: StepStatus = source ? statusFor(source) : 'todo'
    return { id, status, core: true }
  })

  const coreSteps = steps.filter((s) => s.core)
  const activeCount = coreSteps.filter((s) => s.status === 'active').length

  let level: ReadinessLevel
  if (activeCount > 0) level = 'recording'
  else if (coreSteps.every((s) => s.status === 'todo')) level = 'dark'
  else level = 'setup'

  // The next action, in priority order:
  //   recording → nothing urgent; onboarding is done.
  //   otherwise → the first core step that still needs SETUP (todo). Highest
  //               impact, lowest effort, keeps the operator on the canonical
  //               order (shell hook first).
  //   all core set up but none active → the first wired source, whose UI copy
  //               becomes "run a command" rather than a setup CTA.
  let nextStep: ReadinessStep | null = null
  if (level !== 'recording') {
    nextStep =
      coreSteps.find((s) => s.status === 'todo') ??
      coreSteps.find((s) => s.status === 'wired') ??
      null
  }

  return { level, steps, nextStep, activeCount }
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
