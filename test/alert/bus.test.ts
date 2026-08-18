import { describe, it, expect, beforeEach } from 'vitest'
import { AlertBus } from '../../src/core/alert/bus'
import type { Signal } from '../../src/core/alert/signal'
import type { Policy, Verdict, Surface } from '../../src/core/alert'
import type { DerivedPolicy } from '../../src/core/alert/bus'

function makePolicy(name: string, out: Verdict[]): Policy {
  return { name, evaluate: () => out }
}

function makeSurface(): { surface: Surface; seen: Verdict[] } {
  const seen: Verdict[] = []
  return {
    seen,
    surface: {
      name: 'test-surface',
      handle: (v) => { seen.push(v) }
    }
  }
}

function ipSignal(): Signal {
  return { kind: 'ip_change', timestamp: 0, external: '1.2.3.4', internal: null, settling: false, stale: false }
}

function ipVerdict(): Verdict {
  return { kind: 'ip', value: 'safe', authority: 'fact', severity: 'clean' }
}

describe('AlertBus — fan-out', () => {
  let bus: AlertBus
  beforeEach(() => { bus = new AlertBus() })

  it('routes dispatch → policy → surface', () => {
    const { surface, seen } = makeSurface()
    bus.registerPolicy(makePolicy('p', [ipVerdict()]))
    bus.registerSurface(surface)
    bus.dispatch(ipSignal())
    expect(seen).toHaveLength(1)
  })

  it('empty policies → nothing to surface', () => {
    const { surface, seen } = makeSurface()
    bus.registerSurface(surface)
    bus.dispatch(ipSignal())
    expect(seen).toHaveLength(0)
  })

  it('broken policy does not kill others', () => {
    const { surface, seen } = makeSurface()
    bus.registerPolicy({ name: 'bad', evaluate: () => { throw new Error('boom') } })
    bus.registerPolicy(makePolicy('good', [ipVerdict()]))
    bus.registerSurface(surface)
    bus.dispatch(ipSignal())
    expect(seen).toHaveLength(1)
  })

  it('broken surface does not silence others', () => {
    const { surface, seen } = makeSurface()
    bus.registerSurface({ name: 'bad', handle: () => { throw new Error('boom') } })
    bus.registerSurface(surface)
    bus.registerPolicy(makePolicy('p', [ipVerdict()]))
    bus.dispatch(ipSignal())
    expect(seen).toHaveLength(1)
  })

  it('derived policy sees verdicts and can emit further verdicts', () => {
    const { surface, seen } = makeSurface()
    const derived: DerivedPolicy = {
      name: 'derived',
      evaluate: () => [],
      ingest: (v) => (v.kind === 'ip' ? [{ kind: 'burst', distance: 'adjacent_subnet', count: 1, windowMs: 0, firstAt: 0, lastAt: 0, targets: [], severity: 'notice', authority: 'inferred' }] : [])
    }
    bus.registerPolicy(makePolicy('p', [ipVerdict()]))
    bus.registerPolicy(derived)  // duck-typed as DerivedPolicy
    bus.registerSurface(surface)
    bus.dispatch(ipSignal())
    expect(seen).toHaveLength(2)  // original ip + derived burst
    expect(seen[0].kind).toBe('ip')
    expect(seen[1].kind).toBe('burst')
  })

  it('recursion cap prevents runaway derived loops', () => {
    const { surface, seen } = makeSurface()
    let calls = 0
    const loopy: DerivedPolicy = {
      name: 'loopy',
      evaluate: () => [],
      ingest: (v) => {
        calls++
        return [v]  // re-emit whatever we saw → infinite loop without the cap
      }
    }
    bus.registerPolicy(loopy)
    bus.registerSurface(surface)
    bus.emit(ipVerdict())
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThan(100)  // cap kicks in well before this
  })

  it('resetPolicies calls reset on both kinds', () => {
    let signalReset = false, derivedReset = false
    bus.registerPolicy({ name: 'p1', evaluate: () => [], reset: () => { signalReset = true } })
    bus.registerPolicy({ name: 'p2', evaluate: () => [], ingest: () => [], reset: () => { derivedReset = true } })
    bus.resetPolicies()
    expect(signalReset).toBe(true)
    expect(derivedReset).toBe(true)
  })

  it('debug counts split signal vs derived', () => {
    bus.registerPolicy(makePolicy('sig', []))
    bus.registerPolicy({ name: 'deriv', evaluate: () => [], ingest: () => [] })
    bus.registerSurface({ name: 's', handle: () => {} })
    expect(bus._debugCounts()).toEqual({ signals: 1, derived: 1, surfaces: 1 })
  })
})
