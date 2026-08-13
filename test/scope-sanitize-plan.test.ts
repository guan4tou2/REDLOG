import { describe, it, expect } from 'vitest'
import { classifyTarget } from '../src/core/scope-monitor'
import { planScopeSanitize, resolveEventTarget, type SanitizeCandidate } from '../src/core/scope-sanitize-plan'
import type { ScopeVerdict } from '../src/core/artifact-pin'

// Scope-aware sanitize planner (SPEC-SCOPE-AWARE-LIFECYCLE.md Part B). The pure
// decision behind a client-deliverable export: which events' bodies to strip.
// The two rules that matter: unknown is never auto-stripped (A2), and the plan
// covers the io sidecar body, not just inline fields (A1 / §3).

describe('classifyTarget (pure, no side effects)', () => {
  const cfg = { targets: ['*.example.com', '10.0.0.0/24'], excludeTargets: ['secret.example.com'] }
  it('classifies in-scope, excluded, and out-of-scope', () => {
    expect(classifyTarget('app.example.com', cfg)).toBe('in_scope')
    expect(classifyTarget('10.0.0.5', cfg)).toBe('in_scope')
    expect(classifyTarget('secret.example.com', cfg)).toBe('excluded')
    expect(classifyTarget('evil.com', cfg)).toBe('out_of_scope')
  })
  it('is unknown for an absent target, in_scope when no scope is set', () => {
    expect(classifyTarget('', cfg)).toBe('unknown')
    expect(classifyTarget(null, cfg)).toBe('unknown')
    expect(classifyTarget('anything.com', { targets: [], excludeTargets: [] })).toBe('in_scope')
  })
})

describe('resolveEventTarget', () => {
  it('prefers explicit target, falls back to host/dest_host/detectedTarget, then url host', () => {
    expect(resolveEventTarget({ id: '1', targetId: 'a.com', data: {} })).toBe('a.com')
    expect(resolveEventTarget({ id: '2', data: { host: 'b.com' } })).toBe('b.com')
    expect(resolveEventTarget({ id: '3', data: { url: 'https://c.com/x?q=1' } })).toBe('c.com')
    expect(resolveEventTarget({ id: '4', data: {} })).toBeNull()
  })
})

const classify = (targets: string[], excl: string[] = []) =>
  (t: string | null): ScopeVerdict => classifyTarget(t, { targets, excludeTargets: excl })

describe('planScopeSanitize', () => {
  const events: SanitizeCandidate[] = [
    { id: 'in', targetId: 'app.example.com', data: { response_preview: 'in-scope body', io: { response: { ref: 'a'.repeat(64) } } } },
    { id: 'out', targetId: 'evil.com', data: { response_preview: 'leaked body', io: { response: { ref: 'b'.repeat(64) } } } },
    { id: 'excl', targetId: 'secret.example.com', data: { request_body_preview: 'excluded body' } },
    { id: 'unk', data: { output: 'no target here' } },
    { id: 'empty', targetId: 'evil.com', data: { status: 200 } }   // nothing to strip
  ]
  const plan = planScopeSanitize(events, classify(['*.example.com'], ['secret.example.com']))

  it('sanitizes out-of-scope and excluded events, keeps in-scope', () => {
    expect(plan.toSanitize.map((i) => i.eventId).sort()).toEqual(['excl', 'out'])
    expect(plan.keptInScope).toBe(1)
  })

  it('never auto-sanitizes unknown-target events — flags them instead (A2)', () => {
    expect(plan.unknown.map((i) => i.eventId)).toEqual(['unk'])
    expect(plan.toSanitize.find((i) => i.eventId === 'unk')).toBeUndefined()
  })

  it('covers the io sidecar body, not just inline fields (A1 / §3)', () => {
    const out = plan.toSanitize.find((i) => i.eventId === 'out')!
    expect(out.fields).toContain('response_preview')
    expect(out.ioRefs).toEqual(['b'.repeat(64)])
  })

  it('omits events with no strippable content', () => {
    expect(plan.items.find((i) => i.eventId === 'empty')).toBeUndefined()
  })

  it('leaves in-scope bodies untouched (fields listed but action=keep)', () => {
    const inItem = plan.items.find((i) => i.eventId === 'in')!
    expect(inItem.action).toBe('keep')
  })
})
