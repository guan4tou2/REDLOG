// Spec 024 T001 — RED.
//
// Driven through the runtime exactly as the app wires it, not through the
// policy classes: the claim is that nothing the app can do produces a
// correlation verdict, and only the real wiring can show that.
//
// Combined fired on an IP verdict and a scope verdict inside a recall window;
// Burst fired on N scope verdicts of one distance inside a window. Both wrote
// chain events citing no source. The sequences below are the ones that used to
// trigger each.

import { describe, expect, it } from 'vitest'
import { AlertRuntime } from '../../src/main/services/alert-runtime'
import type { Surface } from '../../src/core/alert/surface'
import type { Verdict } from '../../src/core/alert/policy'

function wiredRuntime(): { runtime: AlertRuntime; seen: Verdict[] } {
  const runtime = new AlertRuntime({ engagementId: 'eng', operatorId: '' })
  const seen: Verdict[] = []
  const capture: Surface = { name: 'capture', handle: (v) => { seen.push(v) } }
  runtime.bus.registerSurface(capture)
  runtime.ipPolicy.configure({ safeIps: ['203.0.113.10'], exposedIps: ['198.51.100.7'] })
  runtime.scopePolicy.configure({
    targets: ['target.com', '10.0.0.5'],
    excludeTargets: [],
    alertFloor: ['excluded', 'adjacent_subnet', 'adjacent_domain']
  })
  return { runtime, seen }
}

const exposed = (): Parameters<AlertRuntime['bus']['dispatch']>[0] => ({
  kind: 'ip_change', timestamp: Date.now(), external: '198.51.100.7', internal: '10.1.1.2',
  settling: false, stale: false
})

describe('no alert correlation (Spec 024)', () => {
  it('yields an IP verdict and a scope verdict, and nothing combining them', () => {
    const { runtime, seen } = wiredRuntime()
    runtime.bus.dispatch(exposed())
    runtime.dispatchTargetHit({ target: 'dev.target.com', source: 'shell', action: 'curl dev.target.com' })

    const kinds = seen.map((v) => v.kind)
    expect(kinds).toContain('ip')
    expect(kinds).toContain('scope')
    expect(kinds).not.toContain('combined')
  })

  it('yields one scope verdict per hit, and nothing summarising a burst of them', () => {
    const { runtime, seen } = wiredRuntime()
    for (let i = 0; i < 25; i++) {
      runtime.dispatchTargetHit({ target: `h${i}.target.com`, source: 'http', action: `GET https://h${i}.target.com/` })
    }
    const kinds = seen.map((v) => v.kind)
    expect(kinds.filter((k) => k === 'scope')).toHaveLength(25)
    expect(kinds).not.toContain('burst')
  })

  it('routes verdicts through one kind of policy only', async () => {
    const bus = await import('../../src/core/alert/bus')
    expect('DerivedPolicy' in bus).toBe(false)
    const alert = await import('../../src/core/alert')
    expect('CombinedPolicy' in alert).toBe(false)
    expect('BurstPolicy' in alert).toBe(false)
  })
})
