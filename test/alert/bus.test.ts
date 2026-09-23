import { describe, it, expect, beforeEach } from 'vitest'
import { AlertBus } from '../../src/core/alert/bus'
import type { Signal } from '../../src/core/alert/signal'
import type { Policy, Verdict, Surface } from '../../src/core/alert'

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

  it('resetPolicies calls reset on every policy', () => {
    const reset: string[] = []
    bus.registerPolicy({ name: 'p1', evaluate: () => [], reset: () => { reset.push('p1') } })
    bus.registerPolicy({ name: 'p2', evaluate: () => [], reset: () => { reset.push('p2') } })
    bus.resetPolicies()
    expect(reset).toEqual(['p1', 'p2'])
  })

  it('a verdict reaches surfaces and nothing else', () => {
    // A verdict used to be offered back to a second class of policy that
    // could emit more; nothing consumes verdicts but surfaces now.
    const { surface, seen } = makeSurface()
    bus.registerPolicy(makePolicy('p', [ipVerdict()]))
    bus.registerSurface(surface)
    bus.dispatch(ipSignal())
    expect(seen.map((v) => v.kind)).toEqual(['ip'])
  })

  it('debug counts policies and surfaces', () => {
    bus.registerPolicy(makePolicy('sig', []))
    bus.registerSurface({ name: 's', handle: () => {} })
    expect(bus._debugCounts()).toEqual({ policies: 1, surfaces: 1 })
  })
})
