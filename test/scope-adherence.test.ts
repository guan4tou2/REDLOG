// G-D1: the positive proof. RedLog does not prevent (ALERT-ROLES Part D), so
// "provably did not exceed scope" IS the deliverable — and until this existed
// only the accusation half did. A client reading "3 violations" cannot tell 3
// out of 250 targets from 3 out of 5; the denominator is the whole point.

import { describe, it, expect } from 'vitest'
import { buildAdherenceReport, summariseAdherence } from '../src/core/scope-adherence'

const SCOPE = {
  targets: ['192.168.1.10', '192.168.1.20', '*.app.example.com'],
  excludeTargets: ['dc01.app.example.com']
}

let clock = 1_700_000_000_000
const shell = (target: string, command = `nmap ${target}`): Record<string, unknown> => ({
  timestamp: (clock += 1000),
  agentType: 'shell',
  targetId: target,
  data: { subtype: 'command_start', command, detectedTarget: target }
})
const violation = (
  target: string,
  reason: string,
  authority: 'fact' | 'inferred'
): Record<string, unknown> => ({
  timestamp: (clock += 1000),
  agentType: 'system',
  targetId: target,
  data: { subtype: 'scope_violation', target, reason, authority }
})

const build = (events: Array<Record<string, unknown>>, scope = SCOPE): ReturnType<typeof buildAdherenceReport> =>
  buildAdherenceReport(events as never, scope, { generatedAt: 1_700_000_999_999, engagementId: 'eng-1' })

describe('buildAdherenceReport — the denominator', () => {
  it('counts distinct targets and total actions separately', () => {
    const r = build([shell('192.168.1.10'), shell('192.168.1.10', 'curl 192.168.1.10'), shell('192.168.1.20')])
    expect(r.totals.targets).toBe(2)
    expect(r.totals.actions).toBe(3)
  })

  it('classifies every target touched, not just the ones that alerted', () => {
    const r = build([
      shell('192.168.1.10'),            // D0
      shell('api.app.example.com'),     // D0
      shell('dc01.app.example.com'),    // D1
      shell('192.168.1.55'),            // D2 subnet
      shell('vpn.example.com'),         // D2 domain
      shell('8.8.8.8')                  // D3
    ])
    expect(r.totals).toMatchObject({
      targets: 6, in_scope: 2, excluded: 1, adjacent_subnet: 1, adjacent_domain: 1, unrelated: 1
    })
  })

  it('the summary line is the sentence a client deliverable needs', () => {
    const r = build([shell('192.168.1.10'), shell('192.168.1.20'), shell('192.168.1.55')])
    expect(summariseAdherence(r)).toBe('3 targets, 2 in scope, 0 excluded, 1 adjacent')
  })

  it('mentions off-list targets only when there are some', () => {
    expect(summariseAdherence(build([shell('192.168.1.10')]))).not.toContain('off-list')
    expect(summariseAdherence(build([shell('8.8.8.8')]))).toContain('1 off-list')
  })

  it('an engagement with nothing out of bounds says so with a denominator', () => {
    const r = build([shell('192.168.1.10'), shell('192.168.1.20'), shell('api.app.example.com')])
    expect(r.totals.in_scope).toBe(3)
    expect(r.totals.excluded + r.totals.adjacent_subnet + r.totals.adjacent_domain + r.totals.unrelated).toBe(0)
  })
})

describe('buildAdherenceReport — what counts as a target touched', () => {
  // A scope_violation carries the offending host in targetId. Counting it would
  // inflate the very target it is reporting on.
  it('does not count RedLog\'s own bookkeeping as an operator action', () => {
    const r = build([shell('192.168.1.55'), violation('192.168.1.55', 'adjacent_subnet', 'inferred')])
    expect(r.totals.targets).toBe(1)
    expect(r.totals.actions).toBe(1)
  })

  it('falls back to targetId when no target was extracted from a command', () => {
    const r = build([{ timestamp: 1, agentType: 'http', targetId: '192.168.1.10', data: {} }])
    expect(r.totals.targets).toBe(1)
    expect(r.targets[0].target).toBe('192.168.1.10')
  })

  it('ignores events with no target at all', () => {
    const r = build([{ timestamp: 1, agentType: 'shell', data: { subtype: 'command_start', command: 'ls' } }])
    expect(r.totals.targets).toBe(0)
    expect(r.totals.actions).toBe(0)
  })
})

describe('buildAdherenceReport — the rows', () => {
  it('tracks first/last seen and a capped command sample', () => {
    const events = Array.from({ length: 8 }, (_, i) => shell('192.168.1.10', `cmd-${i}`))
    const r = build(events)
    const row = r.targets[0]
    expect(row.count).toBe(8)
    expect(row.firstSeen).toBeLessThan(row.lastSeen)
    expect(row.commands).toHaveLength(5)   // the full record is the timeline
  })

  // A client reads the problems first, not an alphabetical list.
  it('orders worst-first, then by traffic', () => {
    const r = build([
      shell('192.168.1.10'), shell('192.168.1.10'),
      shell('8.8.8.8'),
      shell('192.168.1.55'),
      shell('dc01.app.example.com')
    ])
    expect(r.targets.map((t) => t.distance)).toEqual([
      'excluded', 'adjacent_subnet', 'unrelated', 'in_scope'
    ])
  })
})

describe('buildAdherenceReport — honesty about re-classification', () => {
  const configChanged = (changed: Record<string, unknown>): Record<string, unknown> => ({
    timestamp: (clock += 1000),
    agentType: 'system',
    data: { subtype: 'config_changed', changed }
  })

  it('carries the violations exactly as they were recorded at the time', () => {
    const r = build([shell('192.168.1.55'), violation('192.168.1.55', 'adjacent_subnet', 'inferred')])
    expect(r.recordedViolations).toEqual([
      { target: '192.168.1.55', reason: 'adjacent_subnet', authority: 'inferred', timestamp: expect.any(Number) }
    ])
  })

  // Re-classification uses the CURRENT scope. Saying so is the difference
  // between a caveat and a silent error.
  it('surfaces scope edits inside the window', () => {
    const r = build([
      shell('192.168.1.10'),
      configChanged({ 'scope.targets': { from: ['a'], to: ['b'] }, 'network.whitelist': { from: [], to: ['x'] } })
    ])
    expect(r.scopeChanges).toHaveLength(1)
    expect(Object.keys(r.scopeChanges[0].changed)).toEqual(['scope.targets'])
  })

  it('ignores config changes that did not touch the scope', () => {
    const r = build([shell('192.168.1.10'), configChanged({ 'network.whitelist': { from: [], to: ['x'] } })])
    expect(r.scopeChanges).toHaveLength(0)
  })

  it('no disagreement when the recorded reason still matches', () => {
    const r = build([
      shell('dc01.app.example.com'),
      violation('dc01.app.example.com', 'excluded_target', 'fact'),
      shell('192.168.1.55'),
      violation('192.168.1.55', 'adjacent_subnet', 'inferred')
    ])
    expect(r.disagreements).toEqual([])
  })

  // The honest consequence of editing scope mid-engagement, not a bug.
  it('flags a target whose live classification no longer matches what was recorded', () => {
    const r = build(
      [shell('192.168.1.55'), violation('192.168.1.55', 'adjacent_subnet', 'inferred')],
      { targets: ['192.168.1.0/24'], excludeTargets: [] }   // widened since
    )
    expect(r.disagreements).toEqual([
      { target: '192.168.1.55', recorded: 'adjacent_subnet', current: 'in_scope' }
    ])
  })

  it('reports each disagreeing target once, however many times it fired', () => {
    const r = build(
      [
        shell('192.168.1.55'),
        violation('192.168.1.55', 'adjacent_subnet', 'inferred'),
        violation('192.168.1.55', 'adjacent_subnet', 'inferred')
      ],
      { targets: ['192.168.1.0/24'], excludeTargets: [] }
    )
    expect(r.disagreements).toHaveLength(1)
  })

  it('records the scope it judged against, so the report is self-describing', () => {
    const r = build([shell('192.168.1.10')])
    expect(r.scope.targets).toEqual(SCOPE.targets)
    expect(r.engagementId).toBe('eng-1')
    expect(r.generatedAt).toBe(1_700_000_999_999)
  })
})

// G-D2: the report says what scope it judged against — and now, where that
// scope came from. Without the digest a reviewer can only take the path on
// trust, which is not the kind of claim an evidence tool should be making.
describe('buildAdherenceReport — scope provenance travels with the report', () => {
  const PROV = {
    path: '/engagements/acme/scope.txt',
    digest: 'a'.repeat(64),
    bytes: 128,
    entries: 3,
    modifiedAt: 1_699_000_000_000,
    loadedAt: 1_700_000_000_000
  }

  it('carries the provenance verbatim', () => {
    const r = buildAdherenceReport(
      [shell('192.168.1.10')] as never,
      { ...SCOPE, provenance: PROV },
      { generatedAt: 1, engagementId: 'eng-1' }
    )
    expect(r.scope.provenance).toEqual(PROV)
  })

  // A typed-in scope is a legitimate state, not an error — it just cannot be
  // joined to a document, and the report should not pretend otherwise.
  it('a typed-in scope reports no provenance rather than a fake one', () => {
    const r = build([shell('192.168.1.10')])
    expect(r.scope.provenance ?? null).toBeNull()
  })
})
