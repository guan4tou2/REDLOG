import { describe, it, expect } from 'vitest'
import { groupFlows, type FlowLike } from '../src/renderer/src/lib/httpActivity'

// docs/DESIGN-core-and-capture.md §3. The claim is not "flows get bucketed" —
// it is that the level the eye lands on is the activity, not the connection,
// while every connection is still reachable one level down.

const f = (o: Partial<FlowLike> & { timestamp: number }): FlowLike => ({
  flowId: `f${o.timestamp}`, host: 'target.example', method: 'GET', url: '/',
  status: 200, durationMs: 10, causeEventId: null, ...o
})

describe('grouping HTTP flows into §3 activities', () => {
  it('calls a lone connection a point', () => {
    const [a] = groupFlows([f({ timestamp: 1000 })])
    expect(a.kind).toBe('point')
    expect(a.flows).toHaveLength(1)
  })

  it('collapses a brute-force into one span, not four hundred rows', () => {
    const flows = Array.from({ length: 400 }, (_, i) => f({ timestamp: 1000 + i * 20 }))
    const groups = groupFlows(flows)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('span')
    expect(groups[0].flows).toHaveLength(400)
  })

  it('keeps every connection reachable inside the span', () => {
    // "never rendered individually" is about the top level. Losing them would
    // be a different product — this is a record.
    const flows = Array.from({ length: 50 }, (_, i) => f({ timestamp: 1000 + i * 20, flowId: `id-${i}` }))
    const [a] = groupFlows(flows)
    expect(a.flows.map((x) => x.flowId)).toEqual(flows.map((x) => x.flowId))
  })

  it('does not let a scanner’s own pacing split one run apart', () => {
    // A rate limit or a slow target produces gaps. Splitting on them would
    // recreate the wall of rows this exists to remove.
    const groups = groupFlows([
      f({ timestamp: 0 }), f({ timestamp: 3500 }), f({ timestamp: 7000 })
    ])
    expect(groups).toHaveLength(1)
  })

  it('starts a new activity after a real gap', () => {
    const groups = groupFlows([f({ timestamp: 0 }), f({ timestamp: 60_000 })])
    expect(groups).toHaveLength(2)
  })

  it('separates concurrent hosts', () => {
    const groups = groupFlows([
      f({ timestamp: 0, host: 'a.example' }),
      f({ timestamp: 100, host: 'b.example' }),
      f({ timestamp: 200, host: 'a.example' })
    ])
    expect(groups.map((g) => g.host).sort()).toEqual(['a.example', 'a.example', 'b.example'])
  })

  it('attaches traffic to its parent command and never merges across one', () => {
    // §3: "Has a parent command → attach; do not draw separately." The cause
    // is a hard boundary both ways — traffic with a known parent belongs to
    // that parent, and unattributed traffic never joins it, however close in
    // time it lands.
    const groups = groupFlows([
      f({ timestamp: 0, causeEventId: 'cmd-1' }),
      f({ timestamp: 50, causeEventId: 'cmd-1' }),
      f({ timestamp: 100 }),
      f({ timestamp: 150, causeEventId: 'cmd-2' })
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0].causeEventId).toBe('cmd-1')
    expect(groups[0].flows).toHaveLength(2)
    expect(groups[1].causeEventId).toBeNull()
    expect(groups[2].causeEventId).toBe('cmd-2')
  })

  it('treats one request from a known command as a span, not a point', () => {
    // The extent that matters is the command's, not the connection's.
    const [a] = groupFlows([f({ timestamp: 0, causeEventId: 'cmd-1' })])
    expect(a.kind).toBe('span')
  })

  it('ends the span at the last response, not the last request', () => {
    const [a] = groupFlows([f({ timestamp: 0, durationMs: 10 }), f({ timestamp: 1000, durationMs: 2500 })])
    expect(a.endMs).toBe(3500)
  })

  it('summarises the result shape without opening the group', () => {
    const [a] = groupFlows([
      f({ timestamp: 0, status: 200 }), f({ timestamp: 100, status: 404 }),
      f({ timestamp: 200, status: 404 }), f({ timestamp: 300, status: 500 }),
      f({ timestamp: 400, method: 'POST', status: 200 })
    ])
    expect(a.statusBuckets).toEqual({ '2': 2, '4': 2, '5': 1 })
    expect(a.methods).toEqual(['GET', 'POST'])
  })

  it('is stable regardless of the order events arrive in', () => {
    const flows = [f({ timestamp: 200 }), f({ timestamp: 0 }), f({ timestamp: 100 })]
    const [a] = groupFlows(flows)
    expect(a.flows.map((x) => x.timestamp)).toEqual([0, 100, 200])
  })

  it('handles an empty record', () => {
    expect(groupFlows([])).toEqual([])
  })
})
