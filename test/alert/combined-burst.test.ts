import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CombinedPolicy, BurstPolicy } from '../../src/core/alert/policies'
import type { Verdict } from '../../src/core/alert/policy'
import type { TargetHitSignal } from '../../src/core/alert/signal'

function ipVerdict(value: 'safe' | 'exposed' | 'off_profile', severity: 'clean' | 'warning' | 'critical'): Verdict {
  return { kind: 'ip', value, authority: 'fact', severity }
}
function scopeVerdict(distance: 'in_scope' | 'excluded' | 'adjacent_subnet', severity: 'clean' | 'warning' | 'critical', target = 'foo.com'): Verdict {
  const sig: TargetHitSignal = { kind: 'target_hit', timestamp: 0, target, source: 'shell', sourceEventId: null, action: '' }
  return { kind: 'scope', signal: sig, distance, authority: 'fact', severity }
}

describe('CombinedPolicy — cross-signal escalation', () => {
  let p: CombinedPolicy
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    p = new CombinedPolicy()
  })

  it('two non-clean verdicts within window → combined + escalated', () => {
    expect(p.ingest(ipVerdict('exposed', 'critical'))).toHaveLength(0)
    const r = p.ingest(scopeVerdict('adjacent_subnet', 'warning'))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: 'combined', severity: 'critical' })
  })

  it('below severity floor: no combined', () => {
    p.ingest(ipVerdict('safe', 'clean'))
    const r = p.ingest(scopeVerdict('adjacent_subnet', 'warning'))
    expect(r).toHaveLength(0)  // IP is clean, below warning floor
  })

  it('outside window: no combined', () => {
    p.ingest(ipVerdict('exposed', 'critical'))
    vi.advanceTimersByTime(60_000)  // 60s > 30s default window
    const r = p.ingest(scopeVerdict('adjacent_subnet', 'warning'))
    expect(r).toHaveLength(0)
  })

  it('cooldown: consecutive scope verdicts against same non-clean IP fire only once', () => {
    p.ingest(ipVerdict('exposed', 'critical'))
    expect(p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'a.com'))).toHaveLength(1)
    expect(p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'b.com'))).toHaveLength(0)  // cooldown
  })

  it('ignores non-ip/non-scope verdicts', () => {
    const r = p.ingest({ kind: 'burst', distance: 'adjacent_subnet', count: 10, windowMs: 60000, firstAt: 0, lastAt: 0, targets: [], severity: 'warning', authority: 'inferred' })
    expect(r).toHaveLength(0)
  })

  it('reset() clears history', () => {
    p.ingest(ipVerdict('exposed', 'critical'))
    p.reset()
    const r = p.ingest(scopeVerdict('adjacent_subnet', 'warning'))
    expect(r).toHaveLength(0)  // no IP to correlate against
  })
})

describe('BurstPolicy — N-in-T rate limiter', () => {
  let p: BurstPolicy
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    p = new BurstPolicy()
    p.configure({ threshold: 3, windowMs: 10_000, distances: ['adjacent_subnet'] })
  })

  it('N-in-T triggers a burst', () => {
    expect(p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'a'))).toHaveLength(0)
    expect(p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'b'))).toHaveLength(0)
    const r = p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'c'))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: 'burst', distance: 'adjacent_subnet', count: 3 })
    expect((r[0] as { targets: string[] }).targets).toEqual(['a', 'b', 'c'])
  })

  it('cooldown suppresses immediate second burst', () => {
    for (let i = 0; i < 3; i++) p.ingest(scopeVerdict('adjacent_subnet', 'warning', `t${i}`))
    // Now cooldown active — next 3 should NOT trigger
    for (let i = 3; i < 6; i++) {
      const r = p.ingest(scopeVerdict('adjacent_subnet', 'warning', `t${i}`))
      expect(r).toHaveLength(0)
    }
  })

  it('distance not in aggregation list is ignored', () => {
    const r = p.ingest(scopeVerdict('in_scope', 'clean', 'a'))
    expect(r).toHaveLength(0)
  })

  it('window slides — old events fall off', () => {
    p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'a'))
    vi.advanceTimersByTime(11_000)  // past window
    p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'b'))
    p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'c'))
    // 'a' fell off; only 2 in window → no burst
    const r = p.ingest(scopeVerdict('adjacent_subnet', 'warning', 'd'))
    expect(r).toHaveLength(1)  // b, c, d in window
    expect((r[0] as { count: number }).count).toBe(3)
  })
})
