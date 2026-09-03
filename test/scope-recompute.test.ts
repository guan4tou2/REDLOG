import { describe, it, expect } from 'vitest'
import {
  planScopeRecompute, scopeHash, MAX_RETRO_ROWS,
  type CorpusEvent, type ExistingViolation, type ScopeSnapshot
} from '../src/core/scope-recompute'
import { classifyScopeTarget, alertFloorFor } from '../src/core/alert/policies'
import type { ScopeDistance } from '../src/core/alert/policy'

// docs/DESIGN-core-and-capture.md §1, design turn 8a. This is a policy for
// re-judging evidence after the rules change, in a tool whose whole claim is
// that the record cannot be rewritten — so, like the eviction planner, most of
// these tests are about what it must REFUSE to do, and about the counts it
// reports being the counts that are true.

let seq = 0
const ev = (o: Partial<CorpusEvent> & { target: string }): CorpusEvent => {
  seq += 1
  return {
    id: `evt-${seq}`, timestamp: 1_700_000_000_000 + seq * 1000,
    source: 'shell', action: `curl ${o.target}`, tier: 'chained', ...o
  }
}
const viol = (o: Partial<ExistingViolation> & { target: string }): ExistingViolation => {
  seq += 1
  return {
    id: `viol-${seq}`, sourceEventId: null, timestamp: 1_700_000_000_000 + seq * 1000,
    distance: 'excluded', judged: 'live', cleared: false, supersededBy: null, ...o
  }
}

const SCOPE = (targets: string[], excludeTargets: string[] = []): ScopeSnapshot =>
  ({ targets, excludeTargets, alertFloor: alertFloorFor(true) })

/** The real classifier, so the planner is tested against the verdicts the live
 *  path would actually produce rather than against a stand-in. */
const classifierFor = (scope: ScopeSnapshot) => (target: string): ScopeDistance =>
  classifyScopeTarget(target, scope).distance

const plan = (
  corpus: CorpusEvent[], existing: ExistingViolation[], after: ScopeSnapshot, cap?: number
): ReturnType<typeof planScopeRecompute> =>
  planScopeRecompute({ corpus, existing, after, classify: classifierFor(after), cap })

describe('the scope fingerprint', () => {
  it('ignores the order the operator typed the list in', () => {
    expect(scopeHash({ targets: ['b', 'a'], excludeTargets: [] }))
      .toBe(scopeHash({ targets: ['a', 'b'], excludeTargets: [] }))
  })

  it('changes when the boundary moves, in either direction', () => {
    const base = scopeHash({ targets: ['a'], excludeTargets: [] })
    expect(scopeHash({ targets: ['a', 'b'], excludeTargets: [] })).not.toBe(base)
    expect(scopeHash({ targets: ['a'], excludeTargets: ['x'] })).not.toBe(base)
  })

  it('does not change when only the alert floor does', () => {
    // Turning notifications down narrows what is REPORTED; it does not move the
    // boundary. Hashing it would make a notification preference re-judge the
    // whole corpus and write hundreds of rows.
    const a = { targets: ['a'], excludeTargets: [], alertFloor: alertFloorFor(true) }
    const b = { targets: ['a'], excludeTargets: [], alertFloor: alertFloorFor(false) }
    expect(scopeHash(a)).toBe(scopeHash(b))
  })
})

describe('flagging what was out of scope all along', () => {
  it('flags an event whose target is newly excluded', () => {
    const e = ev({ target: 'evil.example' })
    const p = plan([e], [], SCOPE(['*.target.com'], ['evil.example']))
    expect(p.flag).toHaveLength(1)
    expect(p.flag[0]).toMatchObject({ sourceEventId: e.id, target: 'evil.example', distance: 'excluded' })
    expect(p.counts.flagged).toBe(1)
  })

  it('says nothing about an event that is in scope', () => {
    const p = plan([ev({ target: 'www.target.com' })], [], SCOPE(['*.target.com']))
    expect(p.flag).toEqual([])
    expect(p.clear).toEqual([])
    expect(p.recomputed).toBe(1)   // it WAS re-judged; that is the first number
  })

  it('does not flag the entire off-profile corpus', () => {
    // `unrelated` is below every floor the app ships. A recompute that ignored
    // that would, on the first save, write a violation for every host the
    // operator ever touched — which teaches them the lane lies.
    const p = plan([ev({ target: 'cdn.unrelated.test' })], [], SCOPE(['*.target.com']))
    expect(p.flag).toEqual([])
  })

  it('does not flag an event that already has a standing violation', () => {
    const e = ev({ target: 'evil.example' })
    const existing = viol({ target: 'evil.example', sourceEventId: e.id })
    const p = plan([e], [existing], SCOPE(['*.target.com'], ['evil.example']))
    expect(p.flag).toEqual([])
    expect(p.regrade).toEqual([])
  })

  it('flags again when the standing violation was withdrawn earlier', () => {
    const e = ev({ target: 'evil.example' })
    const p = plan([e], [viol({ target: 'evil.example', sourceEventId: e.id, cleared: true })],
      SCOPE(['*.target.com'], ['evil.example']))
    expect(p.flag).toHaveLength(1)
    expect(p.flag[0].sourceEventId).toBe(e.id)
  })

  it('treats a superseded violation as not standing', () => {
    const e = ev({ target: 'evil.example' })
    const stale = viol({ target: 'evil.example', sourceEventId: e.id, supersededBy: 'viol-newer' })
    const p = plan([e], [stale], SCOPE(['*.target.com'], ['evil.example']))
    expect(p.flag).toHaveLength(1)
  })

  it('does not re-flag events a cause-less live violation already covered', () => {
    // Some producers emit a verdict with no source event id. The events behind
    // such a row are already known; without a coverage window the first
    // recompute would report each of them as a fresh discovery.
    const covered = ev({ target: 'evil.example', timestamp: 1_000_000 })
    const v = viol({ target: 'evil.example', sourceEventId: null, timestamp: 1_000_500 })
    const p = plan([covered], [v], SCOPE(['*.target.com'], ['evil.example']))
    expect(p.flag).toEqual([])
  })

  it('still flags an event far outside that coverage window', () => {
    const old = ev({ target: 'evil.example', timestamp: 1_000_000 })
    const v = viol({ target: 'evil.example', sourceEventId: null, timestamp: 9_000_000 })
    expect(plan([old], [v], SCOPE(['*.target.com'], ['evil.example'])).flag).toHaveLength(1)
  })
})

describe('regrading — the rung changed, not the fact', () => {
  it('writes a superseding row when an inferred warning becomes an explicit deny', () => {
    // Without this the chain's latest verdict says "adjacent domain, warning"
    // while the scope in force says the operator forbade it outright. The
    // operator could only find that out by rerunning the classifier by hand.
    const e = ev({ target: 'staging.target.com' })
    const standing = viol({
      target: 'staging.target.com', sourceEventId: e.id, distance: 'adjacent_domain'
    })
    const p = plan([e], [standing], SCOPE(['*.target.com'], ['staging.target.com']))
    expect(p.flag).toEqual([])
    expect(p.regrade).toHaveLength(1)
    expect(p.regrade[0]).toMatchObject({ distance: 'excluded', regradeOf: standing.id })
    expect(p.counts.regraded).toBe(1)
  })

  it('says nothing when the rung is unchanged', () => {
    const e = ev({ target: 'evil.example' })
    const standing = viol({ target: 'evil.example', sourceEventId: e.id, distance: 'excluded' })
    expect(plan([e], [standing], SCOPE(['*.target.com'], ['evil.example'])).regrade).toEqual([])
  })
})

describe('withdrawing what no longer holds', () => {
  it('clears a standing violation whose target is now in scope', () => {
    const v = viol({ target: 'evil.example', sourceEventId: 'evt-gone' })
    const p = plan([], [v], SCOPE(['*.target.com', 'evil.example']))
    expect(p.clear).toHaveLength(1)
    expect(p.clear[0]).toMatchObject({
      violationId: v.id, distanceBefore: 'excluded', distanceAfter: 'in_scope', judgedBefore: 'live'
    })
  })

  it('clears from the RECORDS, so it still works after the source row was pruned', () => {
    // The logged tier is swept after thirty days. A rescan-based clear would
    // silently leave those violations standing forever, because the DNS and
    // HTTP rows behind them no longer exist.
    const v = viol({ target: 'evil.example', sourceEventId: 'a-pruned-logged-row' })
    expect(plan([], [v], SCOPE(['evil.example'])).clear).toHaveLength(1)
  })

  it('never clears a violation twice', () => {
    const v = viol({ target: 'evil.example', cleared: true })
    expect(plan([], [v], SCOPE(['evil.example'])).clear).toEqual([])
  })

  it('re-flags a cleared violation whose source event is gone and whose target is forbidden again', () => {
    // Otherwise the active count reads zero for a target the operator has just
    // explicitly excluded — the count would be describing history rather than
    // the scope in force.
    const v = viol({ target: 'evil.example', sourceEventId: 'a-pruned-row', cleared: true })
    const p = plan([], [v], SCOPE(['*.target.com'], ['evil.example']))
    expect(p.flag).toHaveLength(1)
    expect(p.flag[0]).toMatchObject({ reflagOf: v.id, target: 'evil.example', distance: 'excluded' })
  })

  it('does not re-flag when the source event is back in the corpus — that row is flagged instead', () => {
    const e = ev({ target: 'evil.example' })
    const v = viol({ target: 'evil.example', sourceEventId: e.id, cleared: true })
    const p = plan([e], [v], SCOPE(['*.target.com'], ['evil.example']))
    expect(p.flag).toHaveLength(1)
    expect(p.flag[0].reflagOf).toBeUndefined()
    expect(p.flag[0].sourceEventId).toBe(e.id)
  })
})

describe('an unchanged scope', () => {
  it('produces nothing to write at all', () => {
    const e = ev({ target: 'evil.example' })
    const standing = viol({ target: 'evil.example', sourceEventId: e.id, distance: 'excluded' })
    const p = plan([e], [standing], SCOPE(['*.target.com'], ['evil.example']))
    expect([p.flag, p.regrade, p.clear]).toEqual([[], [], []])
    expect(p.counts).toMatchObject({ flagged: 0, regraded: 0, cleared: 0 })
  })
})

describe('the cap, and telling the truth about it', () => {
  it('writes the freshest rows and reports how many there really were', () => {
    // Truncation the operator cannot see is worse than no cap: the banner would
    // claim a smaller number than the engagement holds.
    const corpus = Array.from({ length: 10 }, () => ev({ target: 'evil.example' }))
    const p = plan(corpus, [], SCOPE(['*.target.com'], ['evil.example']), 3)
    expect(p.flag).toHaveLength(3)
    expect(p.counts.flagged).toBe(10)
    expect(p.counts.flaggedWritten).toBe(3)
    const written = p.flag.map((r) => r.timestamp)
    expect(written).toEqual([...written].sort((a, b) => b - a))
    expect(Math.min(...written)).toBeGreaterThan(corpus[0].timestamp)
  })

  it('defaults to a bounded cap rather than unbounded', () => {
    expect(MAX_RETRO_ROWS).toBe(500)
  })
})

describe('what the plan reports', () => {
  it('counts every eligible event as recomputed, not just the flagged ones', () => {
    const p = plan(
      [ev({ target: 'www.target.com' }), ev({ target: 'evil.example' })],
      [], SCOPE(['*.target.com'], ['evil.example'])
    )
    expect(p.recomputed).toBe(2)
    expect(p.counts.flagged).toBe(1)
    expect(p.targetsRecomputed).toBe(2)
  })

  it('reports the span the changes actually cover', () => {
    const a = ev({ target: 'evil.example', timestamp: 5_000 })
    const b = ev({ target: 'evil.example', timestamp: 9_000 })
    const p = plan([a, b], [], SCOPE(['*.target.com'], ['evil.example']))
    expect(p.firstAffectedAt).toBe(5_000)
    expect(p.lastAffectedAt).toBe(9_000)
  })

  it('reports no span when nothing changed', () => {
    const p = plan([ev({ target: 'www.target.com' })], [], SCOPE(['*.target.com']))
    expect(p.firstAffectedAt).toBeNull()
    expect(p.lastAffectedAt).toBeNull()
  })

  it('carries the tier and the sanitize flag through to the row', () => {
    const e = ev({ target: 'evil.example', tier: 'logged', sanitized: true })
    const [row] = plan([e], [], SCOPE(['*.target.com'], ['evil.example'])).flag
    expect(row).toMatchObject({ tier: 'logged', sanitized: true })
  })

  it('handles an empty corpus and no verdicts', () => {
    const p = plan([], [], SCOPE(['*.target.com']))
    expect(p).toMatchObject({ recomputed: 0, flag: [], regrade: [], clear: [] })
  })
})

describe('what it never does', () => {
  it('has no shape in which a row could be modified or deleted', () => {
    const e = ev({ target: 'evil.example' })
    const v = viol({ target: 'evil.example', sourceEventId: e.id, distance: 'adjacent_domain' })
    const p = plan([e], [v], SCOPE(['*.target.com'], ['evil.example']))
    const keys = new Set([...p.flag, ...p.regrade].flatMap((r) => Object.keys(r))
      .concat(p.clear.flatMap((r) => Object.keys(r))))
    for (const forbidden of ['update', 'delete', 'patch', 'set', 'remove']) {
      expect([...keys].some((k) => k.toLowerCase().includes(forbidden)), `plan exposes "${forbidden}"`).toBe(false)
    }
  })

  it('does not mutate its inputs', () => {
    const corpus = [ev({ target: 'evil.example' })]
    const existing = [viol({ target: 'evil.example' })]
    const before = JSON.stringify([corpus, existing])
    plan(corpus, existing, SCOPE(['*.target.com'], ['evil.example']))
    expect(JSON.stringify([corpus, existing])).toBe(before)
  })

  it('under an exclude-only floor, flags the deny but not the adjacency', () => {
    const floor = { targets: ['*.target.com'], excludeTargets: ['bad.example'], alertFloor: alertFloorFor(false) }
    const p = planScopeRecompute({
      corpus: [ev({ target: 'bad.example' }), ev({ target: 'staging.target.com' })],
      existing: [], after: floor, classify: classifierFor(floor)
    })
    expect(p.flag.map((r) => r.target)).toEqual(['bad.example'])
  })
})
