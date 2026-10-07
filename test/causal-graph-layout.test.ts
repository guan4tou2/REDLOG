// The testable half of the causal graph: chain in, geometry out, no DOM.
//
// Synthetic chains rather than a real database — `queryEventCausalChain` has
// its own coverage in event-causal-chain.test.ts, and what this file is about
// is what happens to a chain's shape once it is drawn.
import { describe, expect, it } from 'vitest'
import type { EventCausalChain, RedLogEvent } from '../src/core/db/event-types'
import { layoutCausalGraph } from '../src/renderer/src/lib/causalGraphLayout'

function evt(id: string, overrides: Partial<RedLogEvent> = {}): RedLogEvent {
  return {
    id,
    timestamp: 1_700_000_000_000,
    engagementId: 'eng',
    sessionId: 'sess',
    operatorId: 'op',
    agentType: 'shell',
    hostname: 'host',
    sourceIP: null,
    targetId: null,
    data: { subtype: 'command_end' },
    createdAt: 1_700_000_000_000,
    tier: 'chained',
    ...overrides
  }
}

function chain(partial: Partial<EventCausalChain> = {}): EventCausalChain {
  return {
    anchorId: 'a',
    anchorFound: true,
    events: [],
    edges: [],
    unavailableCauseIds: [],
    truncated: false,
    ...partial
  }
}

describe('layoutCausalGraph', () => {
  it('ranks a linear chain downward, one event per rank', () => {
    const out = layoutCausalGraph(chain({
      anchorId: 'b',
      events: [evt('a'), evt('b'), evt('c')],
      edges: [{ causeId: 'a', effectId: 'b' }, { causeId: 'b', effectId: 'c' }]
    }))

    const y = (id: string): number => out.nodes.find((n) => n.id === id)!.y
    expect(y('a')).toBeLessThan(y('b'))
    expect(y('b')).toBeLessThan(y('c'))
    expect(out.edges).toHaveLength(2)
    // Top-to-bottom is the whole reason the graph fits a 440px pane; a
    // regression to rankdir LR would show up here as a wide, short box.
    expect(out.height).toBeGreaterThan(out.width)
  })

  it('puts siblings on one rank, side by side', () => {
    const out = layoutCausalGraph(chain({
      anchorId: 'root',
      events: [evt('root'), evt('left'), evt('right')],
      edges: [{ causeId: 'root', effectId: 'left' }, { causeId: 'root', effectId: 'right' }]
    }))

    const left = out.nodes.find((n) => n.id === 'left')!
    const right = out.nodes.find((n) => n.id === 'right')!
    expect(left.y).toBe(right.y)
    expect(left.x).not.toBe(right.x)
  })

  it('draws an unavailable cause as a node with no event', () => {
    const out = layoutCausalGraph(chain({
      anchorId: 'b',
      events: [evt('b')],
      edges: [{ causeId: 'gone', effectId: 'b' }],
      unavailableCauseIds: ['gone']
    }))

    const ghost = out.nodes.find((n) => n.id === 'gone')
    expect(ghost).toBeDefined()
    expect(ghost!.event).toBeNull()
    expect(out.edges).toHaveLength(1)
  })

  it('leaves out an unavailable id that no edge points at', () => {
    // The backend can report an id the traversal never drew an edge for. A
    // node with no line into it reads as a bug rather than as missing
    // evidence, so it is not drawn.
    const out = layoutCausalGraph(chain({
      anchorId: 'b',
      events: [evt('b')],
      edges: [],
      unavailableCauseIds: ['orphan']
    }))

    expect(out.nodes.map((n) => n.id)).toEqual(['b'])
  })

  it('drops an edge whose other end is not drawn', () => {
    const out = layoutCausalGraph(chain({
      anchorId: 'b',
      events: [evt('b')],
      edges: [{ causeId: 'b', effectId: 'never-loaded' }]
    }))

    expect(out.nodes.map((n) => n.id)).toEqual(['b'])
    expect(out.edges).toEqual([])
  })

  it('survives a cycle in _causes', () => {
    // `_causes` is producer-supplied; nothing upstream guarantees it is
    // acyclic. dagre breaks the cycle, and the point here is that layout
    // returns rather than hanging or throwing.
    const out = layoutCausalGraph(chain({
      anchorId: 'a',
      events: [evt('a'), evt('b')],
      edges: [{ causeId: 'a', effectId: 'b' }, { causeId: 'b', effectId: 'a' }]
    }))

    expect(out.nodes).toHaveLength(2)
    expect(out.edges).toHaveLength(2)
    for (const edge of out.edges) expect(edge.path).not.toBe('')
  })

  it('marks only the anchor', () => {
    const out = layoutCausalGraph(chain({
      anchorId: 'b',
      events: [evt('a'), evt('b')],
      edges: [{ causeId: 'a', effectId: 'b' }]
    }))

    expect(out.nodes.filter((n) => n.isAnchor).map((n) => n.id)).toEqual(['b'])
  })

  it('is deterministic', () => {
    // React keys off node identity; an unstable order would remount every row
    // on each refresh, and a test that renders once would not show it.
    const input = chain({
      anchorId: 'root',
      events: [evt('root'), evt('x'), evt('y'), evt('z')],
      edges: [
        { causeId: 'root', effectId: 'x' },
        { causeId: 'root', effectId: 'y' },
        { causeId: 'x', effectId: 'z' },
        { causeId: 'y', effectId: 'z' }
      ]
    })

    expect(layoutCausalGraph(input)).toEqual(layoutCausalGraph(input))
  })

  it('returns nothing for an empty chain', () => {
    const out = layoutCausalGraph(chain({ anchorFound: false }))
    expect(out).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
  })

  it('honours a caller-supplied node size', () => {
    const out = layoutCausalGraph(chain({
      anchorId: 'a',
      events: [evt('a'), evt('b')],
      edges: [{ causeId: 'a', effectId: 'b' }]
    }), { nodeWidth: 300, nodeHeight: 80 })

    for (const node of out.nodes) {
      expect(node.width).toBe(300)
      expect(node.height).toBe(80)
    }
  })
})
