// The seam between G-B4 (closed `reason` vocabulary + `authority`) and G-C2
// (the deconfliction feed tiers on them). `scope-monitor-behaviour.test.ts`
// deliberately runs without an operatorId so `recordViolation` short-circuits
// before touching the DB — which means nothing there proves the event DATA is
// actually stamped. If it is not, the whole G-C2 fix is inert: the blue team
// gets an inference with no label on it.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const inserted: Array<{ agentType: string; data: Record<string, unknown> }> = []

vi.mock('../src/core/db/events', () => ({
  insertEvent: (agentType: string, data: Record<string, unknown>) => {
    inserted.push({ agentType, data })
    return { id: 'e1', agentType, data }
  }
}))
vi.mock('../src/core/event-bus', () => ({ eventBus: { publish: () => {} } }))

const { ScopeMonitor } = await import('../src/core/scope-monitor')

describe('scope_violation event payload', () => {
  let m: InstanceType<typeof ScopeMonitor>

  beforeEach(() => {
    inserted.length = 0
    m = new ScopeMonitor()
    m.configure({
      targets: ['192.168.1.10', '*.app.example.com'],
      excludeTargets: ['dc01.app.example.com'],
      operatorId: 'op-1',
      alertFloor: 'adjacent'
    })
  })

  it('stamps an excluded target as a fact', () => {
    m.checkTarget('dc01.app.example.com', 'nmap dc01.app.example.com')
    expect(inserted).toHaveLength(1)
    expect(inserted[0].data.subtype).toBe('scope_violation')
    expect(inserted[0].data.reason).toBe('excluded_target')
    expect(inserted[0].data.authority).toBe('fact')
  })

  it('stamps a same-subnet near-miss as an inference, named', () => {
    m.checkTarget('192.168.1.55', 'nmap 192.168.1.55')
    expect(inserted[0].data.reason).toBe('adjacent_subnet')
    expect(inserted[0].data.authority).toBe('inferred')
  })

  it('stamps a same-domain near-miss as an inference, named', () => {
    m.checkTarget('vpn.example.com', 'curl vpn.example.com')
    expect(inserted[0].data.reason).toBe('adjacent_domain')
    expect(inserted[0].data.authority).toBe('inferred')
  })

  it('emits nothing for an unrelated target — D3 is counted, not forwarded', () => {
    m.checkTarget('8.8.8.8', 'dig @8.8.8.8 example.com')
    expect(inserted).toHaveLength(0)
    expect(m.getUnrelatedCount()).toBe(1)
  })

  it('emits nothing in scope', () => {
    m.checkTarget('api.app.example.com', 'curl api.app.example.com')
    expect(inserted).toHaveLength(0)
  })

  // The fact tier is not silenceable, so a fact-floored feed still gets it.
  it('still emits the fact-tier violation at the lowest floor', () => {
    m.configure({ alertFloor: 'excluded_only' })
    m.checkTarget('192.168.1.55', 'nmap 192.168.1.55')
    expect(inserted).toHaveLength(0)
    m.checkTarget('dc01.app.example.com', 'nmap dc01.app.example.com')
    expect(inserted).toHaveLength(1)
    expect(inserted[0].data.authority).toBe('fact')
  })
})
