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
// Within a group the order carries no meaning, so the model no longer implies
// one.
//
// The groups are not all equal, though, and pretending otherwise was the next
// mistake. RedLog exists to answer "what did the operator do to the target",
// and two kinds of answer carry that on their own: the commands they ran, and
// the requests they sent. HTTP(S) sat in a "Traffic" bucket beside the browser
// console and the connection monitor — nice-to-haves that annotate an
// engagement rather than constitute one — and next to an "optional
// integrations" heading on the readiness panel. An operator reading that
// reasonably concludes that a report without requests in it is still a
// complete record. It is not: on a web assessment it is the record with the
// evidence removed.
//
// So `core` marks the two capabilities RedLog is for. It says nothing about
// whether a source is installed — mitmproxy needs a runtime that ships with
// nothing, and that is a dependency problem, not a demotion.
export type CaptureGroupId = 'commands' | 'http' | 'traffic' | 'artifacts'

export const CAPTURE_GROUPS: ReadonlyArray<{
  id: CaptureGroupId
  core: boolean
  sources: readonly string[]
}> = [
  // What was typed, by a person or an agent. `terminal` is one capability
  // fed by two terminals — RedLog's own panes and, once the shell hook is
  // installed, the operator's own shell — because they are the same capture in
  // two places, and which one a command came from is on the command.
  { id: 'commands', core: true, sources: ['terminal', 'agent-tailer'] },
  // What was sent over the wire. mitmproxy carries HTTP and DNS on one addon,
  // which is why one source stands for the whole capability.
  { id: 'http', core: true, sources: ['mitmproxy'] },
  // Network detail that annotates the above rather than standing alone.
  { id: 'traffic', core: false, sources: ['browser-console', 'connection-monitor'] },
  // What was on screen or on disk.
  { id: 'artifacts', core: false, sources: ['screenshot', 'clipboard', 'file-watcher', 'process-monitor'] }
]

// Minimal structural shape of a capture source. Both the main-process
// CaptureSource and the renderer's ambient CaptureSourceInfo satisfy it, so
// readiness needs no cross-boundary type import.
// Spec 037: the sources that can finish onboarding — the ones that prove a
// typed command is recorded. The agent tailer is an opt-in pack (Spec 035): it
// stays in the commands group for Capture Health, but onboarding never sends
// anyone to it.
//
// mitmproxy is NOT here, and this is not the old "HTTP is optional" claim
// wearing a new hat. Onboarding asks one question — is anything I type being
// written down — and HTTP capture cannot answer it, in either direction. A
// live proxy does not show that a command was recorded, and a proxy nobody
// installed does not show that it was not. The onboarding block is hidden the
// moment ANY source goes active (`level === 'recording'`), so an operator on a
// pure web engagement is never nagged about a shell hook they do not want.
const ONBOARDING_SOURCES = ['terminal']

export interface ReadinessSource {
  id: string
  state: 'ready' | 'unset' | 'off' | 'error'
  installed?: boolean
  enabled?: boolean
  lastEventAt: number | null
}

export interface ReadinessHealth {
  sources: ReadinessSource[]
}

export type StepStatus =
  // Has recorded something — this capture path has proved itself. It does not
  // expire: it used to mean "fed within ten minutes", so an operator who
  // stopped typing for a quarter of an hour had the whole onboarding block
  // reappear underneath a timeline full of their own commands.
  | 'active'
  | 'wired' // set up (hook installed, switch on) but has never delivered
  | 'todo' // nothing done yet, or explicitly switched off — offer the setup action

export interface ReadinessStep {
  /** stable id, matches the source id and the i18n `capture.*` labels */
  id: string
  status: StepStatus
  group: CaptureGroupId
  /** its group is one of the two core capture capabilities */
  core: boolean
}

export interface ReadinessGroup {
  id: CaptureGroupId
  steps: ReadinessStep[]
  /** one of the two core capture capabilities */
  core: boolean
}

export interface CaptureReadiness {
  steps: ReadinessStep[]
  /** the same steps, grouped by what they capture */
  groups: ReadinessGroup[]
  /** the single action to surface, or null once a command has been recorded */
  nextStep: ReadinessStep | null
}

// A source counts as "wired" when the operator has done the setup for it but
// nothing has come through yet: a hook installed on disk, a config switch
// turned on, a source that needs neither. One event, ever, promotes it to
// `active` — onboarding asks whether anything the operator does is being
// written down, and a recorded event is the answer, permanently.
//
// A source that is explicitly switched OFF is NOT wired — for onboarding that
// is precisely the thing to nudge back on, so it ranks as `todo`.
function statusFor(source: ReadinessSource): StepStatus {
  if (source.lastEventAt !== null && source.state !== 'off') return 'active'
  if (source.state === 'off') return 'todo'
  // A failing source is set up — reinstalling it is not the fix — so it ranks
  // `wired`, never `active`. Onboarding stops nudging; Capture Health shows
  // the failure and its reason.
  if (source.state === 'error') return 'wired'
  // `ready` alone is not enough here. Several sources are resident and able to
  // record without the operator having done anything — the screen grabber, the
  // launched browser's console — and counting those as set up would mean a
  // fresh install never reads as dark, which is the one state the onboarding
  // copy exists for.
  return source.installed === true || source.enabled === true ? 'wired' : 'todo'
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
      return { id, status, group: g.id, core: g.core }
    })
  )

  const groups: ReadinessGroup[] = CAPTURE_GROUPS.map((g) => ({
    id: g.id,
    steps: steps.filter((s) => s.group === g.id),
    core: g.core
  }))

  // Chosen by state, not by position — the list is no longer a sequence, so
  // "first in the array" would be an arbitrary answer dressed up as a
  // recommendation.
  //
  // A `wired` source is one setup step ahead of a `todo` one: it needs an
  // event, not an installation. Guiding to it first is the shortest route out
  // of dark, which is the only thing this model is for. Ties inside a status
  // fall back to ONBOARDING_SOURCES order, which is a stable answer — though
  // since the two terminals became one row there is only ever one candidate.
  const candidates = steps.filter((s) => ONBOARDING_SOURCES.includes(s.id))
  const nextStep = candidates.some((s) => s.status === 'active')
    ? null
    : candidates.find((s) => s.status === 'wired')
      ?? candidates.find((s) => s.status === 'todo')
      ?? null

  return { steps, groups, nextStep }
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
