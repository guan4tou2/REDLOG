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

// The three sources a solo operator wires first, in the order the README tells
// them to: the shell hook is the backbone, the agent tailer covers AI agents,
// the built-in terminal is the zero-setup fallback.
const CORE = ['shell-hook', 'agent-tailer', 'builtin-terminal']

describe('computeCaptureReadiness', () => {
  it('is dark with a clear first step when nothing is wired', () => {
    const h = health([
      src('shell-hook', { hookId: 'shell-zsh', installed: false, state: 'absent' }),
      src('agent-tailer', { configPath: 'agentTailer.enabled', state: 'idle' }),
      src('builtin-terminal', { state: 'idle' })
    ], { verdict: 'dark' })

    const r = computeCaptureReadiness(h)
    expect(r.level).toBe('dark')
    // Every core step is still to-do.
    expect(r.steps.filter((s) => s.core).every((s) => s.status === 'todo')).toBe(true)
    // The one action surfaced is installing the shell hook — the highest-impact,
    // lowest-effort setup step, and the one the README leads with.
    expect(r.nextStep?.id).toBe('shell-hook')
  })

  it('orders the core steps by the canonical onboarding sequence', () => {
    const h = health([
      src('builtin-terminal', { state: 'idle' }),
      src('agent-tailer', { configPath: 'agentTailer.enabled', state: 'idle' }),
      src('shell-hook', { hookId: 'shell-zsh', installed: false, state: 'absent' })
    ], { verdict: 'dark' })

    const r = computeCaptureReadiness(h)
    expect(r.steps.filter((s) => s.core).map((s) => s.id)).toEqual(CORE)
  })

  it('counts an installed-but-silent hook as wired, and points at the next unset source', () => {
    const h = health([
      // shell hook installed but no command has run yet
      src('shell-hook', { hookId: 'shell-zsh', installed: true, state: 'idle' }),
      src('agent-tailer', { configPath: 'agentTailer.enabled', state: 'idle' }),
      src('builtin-terminal', { state: 'idle' })
    ], { verdict: 'partial' })

    const r = computeCaptureReadiness(h)
    expect(r.level).toBe('setup')
    expect(r.steps.find((s) => s.id === 'shell-hook')?.status).toBe('wired')
    // shell hook is set up; the next unfinished setup step is the agent tailer.
    expect(r.nextStep?.id).toBe('agent-tailer')
  })

  it('treats an enabled tailer as wired even before its first event', () => {
    const h = health([
      src('shell-hook', { hookId: 'shell-zsh', installed: false, state: 'absent' }),
      src('agent-tailer', { configPath: 'agentTailer.enabled', enabled: true, state: 'idle' }),
      src('builtin-terminal', { state: 'idle' })
    ])
    const r = computeCaptureReadiness(h)
    expect(r.steps.find((s) => s.id === 'agent-tailer')?.status).toBe('wired')
    // shell-hook is still the only untouched core step, so it stays the next action.
    expect(r.nextStep?.id).toBe('shell-hook')
  })

  it('is recording, with no urgent next step, once any core source is active', () => {
    const h = health([
      src('shell-hook', { hookId: 'shell-zsh', installed: true, state: 'active', lastEventAt: 1 }),
      src('agent-tailer', { configPath: 'agentTailer.enabled', state: 'idle' }),
      src('builtin-terminal', { state: 'idle' })
    ], { verdict: 'healthy', recording: true })

    const r = computeCaptureReadiness(h)
    expect(r.level).toBe('recording')
    expect(r.activeCount).toBe(1)
    expect(r.nextStep).toBeNull()
    expect(r.steps.find((s) => s.id === 'shell-hook')?.status).toBe('active')
  })

  it('once everything is wired but nothing active, nudges the operator to generate activity', () => {
    const h = health([
      src('shell-hook', { hookId: 'shell-zsh', installed: true, state: 'idle' }),
      src('agent-tailer', { configPath: 'agentTailer.enabled', enabled: true, state: 'idle' }),
      src('builtin-terminal', { state: 'idle', lastEventAt: 5 })
    ], { verdict: 'partial' })

    const r = computeCaptureReadiness(h)
    expect(r.level).toBe('setup')
    // No core step needs setup any more, so the next step is the first wired
    // source, waiting for activity — the UI copy becomes "run a command".
    expect(r.steps.filter((s) => s.core).every((s) => s.status === 'wired')).toBe(true)
    expect(r.nextStep?.id).toBe('shell-hook')
    expect(r.nextStep?.status).toBe('wired')
  })

  it('ranks a switched-off core source as todo, not wired', () => {
    // An operator who turned the tailer off has not "set it up" for onboarding
    // purposes — offering to enable it is exactly the right nudge.
    const h = health([
      src('shell-hook', { hookId: 'shell-zsh', installed: false, state: 'absent' }),
      src('agent-tailer', { configPath: 'agentTailer.enabled', enabled: false, state: 'off' }),
      src('builtin-terminal', { state: 'idle' })
    ], { verdict: 'dark' })
    const r = computeCaptureReadiness(h)
    expect(r.steps.find((s) => s.id === 'agent-tailer')?.status).toBe('todo')
  })

  it('is resilient to a health payload missing a core source', () => {
    // Defensive: never throw if the sources list drifts from the core list.
    const h = health([src('shell-hook', { hookId: 'shell-zsh', installed: true, state: 'active', lastEventAt: 1 })],
      { verdict: 'healthy', recording: true })
    const r = computeCaptureReadiness(h)
    expect(r.level).toBe('recording')
    expect(r.steps.map((s) => s.id)).toContain('shell-hook')
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
    expect(primaryCaptureAction(src({ installed: true, enabled: true, state: 'idle' }))).toBe('none')
  })

  it('never says install for a source with nothing to install', () => {
    // The built-in terminal has no hook — it is either on or off.
    expect(primaryCaptureAction({ state: 'absent', hookId: undefined, enabled: false })).toBe('enable')
    expect(primaryCaptureAction({ state: 'active', hookId: undefined, enabled: true })).toBe('none')
  })
})
