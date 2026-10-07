import { describe, it, expect } from 'vitest'
import { computeCaptureReadiness, primaryCaptureAction } from '../src/renderer/src/lib/captureReadiness'
import type { ReadinessHealth, ReadinessSource } from '../src/renderer/src/lib/captureReadiness'

// capture-readiness turns the diagnostic CaptureHealth (which source is feeding,
// is anything feeding at all) into an ORDERED onboarding model for a first-run
// operator: what is the single next thing to do to go from a dark timeline to a
// recording one. capture-health answers "is anything wrong"; readiness answers
// "what do I do about it". It is a pure function so it can be exercised without
// a DB, a renderer, or a running app.

// Minimal source factory. Accepts (and ignores) the hookId/configPath/verdict
// realism fields the tests pass — readiness reads only id/state/installed/
// enabled/lastEventAt, so the factory copies just those into a ReadinessSource.
type SourceOverrides = Partial<ReadinessSource> & { hookId?: string; configPath?: string }
function src(id: string, over: SourceOverrides = {}): ReadinessSource {
  return {
    id,
    installed: over.installed,
    enabled: over.enabled,
    lastEventAt: over.lastEventAt ?? null,
    state: over.state ?? 'idle'
  }
}

// readiness derives its own level from the sources, so verdict/recording on the
// health payload are decorative here — accepted for readability, not used.
function health(sources: ReadinessSource[], _over: Record<string, unknown> = {}): ReadinessHealth {
  return { sources }
}

// What a solo operator wires for commands: the terminal — RedLog's own panes,
// plus the operator's own shell once the hook is installed — and the agent
// tailer for AI agents. The two terminals are one source because they are one
// capture in two places; which one a command came from is on the command.
const CORE = ['terminal', 'agent-tailer']

describe('computeCaptureReadiness', () => {
  it('is dark with a clear first step when nothing is wired', () => {
    const h = health([
      src('terminal', { hookId: 'shell-zsh', installed: false, state: 'ready' }),
      src('agent-tailer', { configPath: 'packs.aiAgents', state: 'ready' })
    ], { verdict: 'dark' })

    const r = computeCaptureReadiness(h)
    // Every core step is still to-do.
    expect(r.steps.filter((s) => s.core).every((s) => s.status === 'todo')).toBe(true)
    // The one action surfaced is the terminal — and because RedLog's own pane
    // needs nothing installed, that action is "open one and type", not a setup.
    expect(r.nextStep?.id).toBe('terminal')
  })

  it('groups sources by what they capture, and claims no order within a group', () => {
    // The model used to be an ordered triple that declared everything else
    // "enrichment". An operator on a proxied web assessment wires mitmproxy
    // first and may never install a shell hook — and was told they were dark
    // while HTTP events landed on the timeline.
    const h = health([
      src('agent-tailer', { configPath: 'packs.aiAgents', state: 'ready' }),
      src('terminal', { hookId: 'shell-zsh', installed: false, state: 'ready' })
    ], { verdict: 'dark' })

    const r = computeCaptureReadiness(h)
    expect(r.groups.map((g) => g.id)).toEqual(['commands', 'http', 'traffic', 'artifacts'])
    expect(r.groups.find((g) => g.id === 'commands')?.steps.map((s) => s.id).sort())
      .toEqual([...CORE].sort())
    // Traffic and artefacts are in the model now, not excluded from it.
    expect(r.steps.map((s) => s.id)).toContain('mitmproxy')
    expect(r.steps.map((s) => s.id)).toContain('screenshot')
    // Exactly two groups are core, and HTTP is one of them. The rest annotate
    // an engagement; these two constitute one.
    expect(r.groups.filter((g) => g.core).map((g) => g.id)).toEqual(['commands', 'http'])
    expect(r.steps.find((s) => s.id === 'mitmproxy')?.core).toBe(true)
    expect(r.steps.find((s) => s.id === 'screenshot')?.core).toBe(false)
  })

  it('is recording when HTTP alone is feeding the timeline', () => {
    // The case the ordered model got wrong: events are landing, so the app is
    // not dark, whatever the terminal is doing.
    const h = health([
      src('terminal', { hookId: 'shell-zsh', installed: false, state: 'ready' }),
      src('mitmproxy', { state: 'active', lastEventAt: 1 })
    ], { verdict: 'partial' })
    const r = computeCaptureReadiness(h)
    expect(r.steps.find((s) => s.id === 'mitmproxy')?.status).toBe('active')
  })

  it('counts an installed-but-silent hook as wired, and still points at the terminal', () => {
    const h = health([
      // shell hook installed but no command has run yet
      src('terminal', { hookId: 'shell-zsh', installed: true, state: 'ready' }),
      src('agent-tailer', { configPath: 'packs.aiAgents', state: 'ready' })
    ], { verdict: 'partial' })

    const r = computeCaptureReadiness(h)
    expect(r.steps.find((s) => s.id === 'terminal')?.status).toBe('wired')
    // Chosen by state, not position: a wired source needs an event, a todo one
    // needs an installation first. The wired one is the shorter route out of
    // dark, which is the only thing this model is for.
    expect(r.nextStep?.id).toBe('terminal')
    expect(r.nextStep?.status).toBe('wired')
  })

  it('treats an enabled tailer as wired, but never makes it the next step', () => {
    // Spec 037: the agent tailer is an opt-in pack (Spec 035). It stays
    // visible in Capture Health, but onboarding never sends anyone to it —
    // not even when it is the only wired source.
    const h = health([
      src('terminal', { hookId: 'shell-zsh', installed: false, state: 'ready' }),
      src('agent-tailer', { configPath: 'packs.aiAgents', enabled: true, state: 'ready' })
    ])
    const r = computeCaptureReadiness(h)
    expect(r.steps.find((s) => s.id === 'agent-tailer')?.status).toBe('wired')
    expect(r.groups.find((g) => g.id === 'commands')?.steps.map((s) => s.id)).toContain('agent-tailer')
    expect(r.nextStep?.id).toBe('terminal')
  })

  it('never picks the agent tailer or an HTTP source as the next step, in any state', () => {
    const states: ReadinessSource['state'][] = ['ready', 'unset', 'off', 'error']
    for (const terminal of states) for (const tailer of states) for (const mitm of states) {
      const r = computeCaptureReadiness(health([
        src('terminal', { state: terminal, installed: terminal !== 'absent' }),
        src('agent-tailer', { state: tailer, enabled: tailer !== 'off' }),
        src('mitmproxy', { state: mitm, enabled: mitm !== 'off' })
      ]))
      expect(['terminal', undefined]).toContain(r.nextStep?.id)
    }
  })

  it('completes onboarding when a command has been recorded, from either terminal', () => {
    // Either terminal: the row is fed by RedLog's own panes and by the
    // operator's own shell, and the model no longer asks which — the event
    // does, in `data.source`.
    const base = [
      src('agent-tailer', { state: 'active', lastEventAt: 1 }),
      src('mitmproxy', { state: 'active', lastEventAt: 1 })
    ]
    const recorded = computeCaptureReadiness(health([...base, src('terminal', { state: 'active', lastEventAt: 1 })]))
    const quiet = computeCaptureReadiness(health([...base, src('terminal', { state: 'ready' })]))
    expect(recorded.steps.find((s) => s.id === 'terminal')?.status).toBe('active')
    expect(recorded.nextStep).toBeNull()
    // Agent turns and HTTP are landing, but no command has proved itself.
    expect(quiet.nextStep?.id).toBe('terminal')
  })

  it('never lets HTTP make onboarding incomplete', () => {
    const r = computeCaptureReadiness(health([
      src('terminal', { state: 'active', lastEventAt: 1 }),
      src('mitmproxy', { state: 'off', enabled: false })
    ]))
    expect(r.nextStep).toBeNull()
  })

  it('is recording, with no urgent next step, once any core source is active', () => {
    const h = health([
      src('terminal', { hookId: 'shell-zsh', installed: true, state: 'active', lastEventAt: 1 }),
      src('agent-tailer', { configPath: 'packs.aiAgents', state: 'ready' })
    ], { verdict: 'healthy', recording: true })

    const r = computeCaptureReadiness(h)
    expect(r.steps.filter((s) => s.status === 'active')).toHaveLength(1)
    expect(r.nextStep).toBeNull()
    expect(r.steps.find((s) => s.id === 'terminal')?.status).toBe('active')
  })

  it('once everything is set up but nothing has been recorded, nudges the operator to generate activity', () => {
    const h = health([
      src('terminal', { hookId: 'shell-zsh', installed: true, state: 'ready', lastEventAt: null }),
      src('agent-tailer', { configPath: 'packs.aiAgents', enabled: true, state: 'ready' })
    ], { verdict: 'partial' })

    const r = computeCaptureReadiness(h)
    // No core step needs setup any more, so the next step is the first wired
    // source, waiting for activity — the UI copy becomes "run a command".
    expect(r.steps.filter((s) => s.group === 'commands').every((s) => s.status === 'wired')).toBe(true)
    expect(r.nextStep?.id).toBe('terminal')
    expect(r.nextStep?.status).toBe('wired')
  })

  it('ranks a switched-off core source as todo, not wired', () => {
    // An operator who turned the tailer off has not "set it up" for onboarding
    // purposes — offering to enable it is exactly the right nudge.
    const h = health([
      src('terminal', { hookId: 'shell-zsh', installed: false, state: 'ready' }),
      src('agent-tailer', { configPath: 'packs.aiAgents', enabled: false, state: 'off' })
    ], { verdict: 'dark' })
    const r = computeCaptureReadiness(h)
    expect(r.steps.find((s) => s.id === 'agent-tailer')?.status).toBe('todo')
  })

  it('is resilient to a health payload missing a core source', () => {
    // Defensive: never throw if the sources list drifts from the core list.
    const h = health([src('terminal', { hookId: 'shell-zsh', installed: true, state: 'active', lastEventAt: 1 })],
      { verdict: 'healthy', recording: true })
    const r = computeCaptureReadiness(h)
    expect(r.steps.find((s) => s.id === 'terminal')?.status).toBe('active')
  })
})

// §17: two axes, one primary. The manage row correctly exposes install and
// enable separately — collapsing them hides which half is missing — but two
// equally-weighted buttons leave the operator to work out which one moves them
// forward, when the state already determines it.
describe('primaryCaptureAction', () => {
  const src = (o: Partial<Parameters<typeof primaryCaptureAction>[0]>): Parameters<typeof primaryCaptureAction>[0] =>
    ({ state: 'absent', hookId: 'shell', ...o })

  it('says install first — an uninstalled source cannot be helped by a switch', () => {
    expect(primaryCaptureAction(src({ installed: false, enabled: false }))).toBe('install')
    expect(primaryCaptureAction(src({ installed: false, enabled: true }))).toBe('install')
  })

  it('says enable once it exists but is switched off', () => {
    expect(primaryCaptureAction(src({ installed: true, enabled: false }))).toBe('enable')
  })

  it('asks for nothing when the source is set up and running', () => {
    // Its buttons are for undoing at that point, and undo is never the thing
    // to emphasise.
    expect(primaryCaptureAction(src({ installed: true, enabled: true, state: 'active' }))).toBe('none')
    expect(primaryCaptureAction(src({ installed: true, enabled: true, state: 'ready' }))).toBe('none')
  })

  it('never says install for a source with nothing to install', () => {
    // A source with no hook — the screenshot agent, the launched browser — is
    // either on or off.
    expect(primaryCaptureAction({ state: 'absent', hookId: undefined, enabled: false })).toBe('enable')
    expect(primaryCaptureAction({ state: 'active', hookId: undefined, enabled: true })).toBe('none')
  })
})
