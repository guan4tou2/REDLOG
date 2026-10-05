// Layered layout for one event's causal component.
//
// The backend already hands us a graph: `queryEventCausalChain` returns both
// `events` and `edges`, and until now the renderer kept only the ids and threw
// the edges away (Timeline's `focusChain` is a Set). This turns that result
// into drawable geometry.
//
// Two decisions are forced by where the graph is drawn, which is the detail
// pane — 440px wide by default, 280px at its narrowest:
//
//   * `rankdir: 'TB'`. A causal chain is mostly linear, so left-to-right puts
//     ten ranks across ~2400px; scaled into the pane that is a strip too short
//     to read a label in. Top-to-bottom gives a column the pane's own width
//     and a height the pane already knows how to scroll.
//   * Fixed node width. Titles are operator-supplied and translated, so
//     measuring text to size nodes would make the layout depend on the font
//     being loaded. The renderer clips instead.
//
// dagre does the layering, cycle breaking and crossing reduction. We do not:
// `_causes` is producer-supplied and nothing guarantees it is acyclic.

import dagre from '@dagrejs/dagre'
import type { EventCausalChain, RedLogEvent } from '../../../core/db/event-types'

/** One drawn node. `event` is null for a cause that the chain reported as
 *  unavailable — retention removed it, or the producer never wrote it. The
 *  two are not distinguishable from here and the renderer must not pretend
 *  otherwise; it draws an explicit placeholder, not a gap. */
export interface CausalGraphNode {
  id: string
  event: RedLogEvent | null
  x: number
  y: number
  width: number
  height: number
  isAnchor: boolean
}

export interface CausalGraphEdge {
  id: string
  from: string
  to: string
  /** SVG path data through dagre's own control points. */
  path: string
}

export interface CausalGraphLayout {
  nodes: CausalGraphNode[]
  edges: CausalGraphEdge[]
  width: number
  height: number
}

export interface CausalGraphLayoutOptions {
  nodeWidth?: number
  nodeHeight?: number
  /** Gap between ranks (vertical, since rankdir is TB). */
  rankGap?: number
  /** Gap between siblings within a rank. */
  nodeGap?: number
  margin?: number
}

// Not exported: the architecture gate counts an export production code does
// not reach as dead, and these are defaults, not a contract. A caller that
// needs a different size passes one.
//
// The width is sized so a rank of TWO fits the right-docked pane without a
// horizontal scrollbar, which is the commonest branch: one request with a
// response and a scope violation hanging off it. Measured in the running app,
// the right dock's inner width is 396px, and at 186 a two-node rank came to
// 414 — eighteen pixels over, enough to clip the second node and raise a
// scrollbar under a graph that otherwise fits.
//
//   2 × 172 + 14 (nodesep) + 2 × 14 (margin) = 386 ≤ 396
//
// Three siblings still exceed it, and that is left to scroll: a rank that
// wide genuinely does not fit, and shrinking every node to the worst case
// would cost the common one its title.
const DEFAULT_NODE_WIDTH = 172
const DEFAULT_NODE_HEIGHT = 44

/** Build an SVG path from dagre's polyline points, smoothed into a curve.
 *  dagre emits at least the two endpoints; with three or more it has routed
 *  around a node and the bend matters, so we keep every point. */
function pathFrom(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  if (points.length < 3) {
    const [a, b] = points.length === 1 ? [points[0], points[0]] : points
    const mid = (a.y + b.y) / 2
    return `M${a.x},${a.y} C${a.x},${mid} ${b.x},${mid} ${b.x},${b.y}`
  }
  let d = `M${points[0].x},${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]
    const next = points[i + 1]
    d += ` Q${p.x},${p.y} ${(p.x + next.x) / 2},${(p.y + next.y) / 2}`
  }
  const last = points[points.length - 1]
  d += ` T${last.x},${last.y}`
  return d
}

/**
 * Lay out a causal chain. Pure: same chain in, same geometry out, no DOM and
 * no measurement — which is what makes it the testable half of the feature.
 */
export function layoutCausalGraph(
  chain: EventCausalChain,
  options: CausalGraphLayoutOptions = {}
): CausalGraphLayout {
  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH
  const nodeHeight = options.nodeHeight ?? DEFAULT_NODE_HEIGHT
  const rankGap = options.rankGap ?? 30
  const nodeGap = options.nodeGap ?? 14
  const margin = options.margin ?? 14

  const eventById = new Map<string, RedLogEvent>()
  for (const event of chain.events) eventById.set(event.id, event)

  // An unavailable cause is only worth drawing when an edge actually points at
  // it. The backend reports the set; an id nothing references would be a node
  // floating with no line into the graph, which reads as a bug rather than as
  // missing evidence.
  const referenced = new Set<string>()
  for (const edge of chain.edges) {
    referenced.add(edge.causeId)
    referenced.add(edge.effectId)
  }
  const ghosts = chain.unavailableCauseIds.filter(
    (id) => referenced.has(id) && !eventById.has(id)
  )

  const drawable = new Set<string>([...eventById.keys(), ...ghosts])
  if (drawable.size === 0) return { nodes: [], edges: [], width: 0, height: 0 }

  const g = new dagre.graphlib.Graph({ multigraph: false, compound: false })
  g.setGraph({ rankdir: 'TB', ranksep: rankGap, nodesep: nodeGap, marginx: margin, marginy: margin })
  g.setDefaultEdgeLabel(() => ({}))

  for (const id of drawable) g.setNode(id, { width: nodeWidth, height: nodeHeight })

  // Edges whose endpoints are not both drawable are dropped rather than
  // forcing dagre to invent a node for them: an edge to an id we are not
  // drawing has nowhere to land.
  const drawnEdges = chain.edges.filter(
    (e) => drawable.has(e.causeId) && drawable.has(e.effectId)
  )
  for (const edge of drawnEdges) g.setEdge(edge.causeId, edge.effectId)

  dagre.layout(g)

  // dagre positions by centre; the renderer draws from the top-left corner.
  const nodes: CausalGraphNode[] = []
  for (const id of drawable) {
    const placed = g.node(id) as { x: number; y: number; width: number; height: number } | undefined
    if (!placed) continue
    nodes.push({
      id,
      event: eventById.get(id) ?? null,
      x: placed.x - placed.width / 2,
      y: placed.y - placed.height / 2,
      width: placed.width,
      height: placed.height,
      isAnchor: id === chain.anchorId
    })
  }
  // Stable order: by rank then by horizontal position. Two runs over the same
  // chain must emit the same list, or React remounts rows on every refresh.
  nodes.sort((a, b) => (a.y - b.y) || (a.x - b.x) || a.id.localeCompare(b.id))

  const edges: CausalGraphEdge[] = drawnEdges.map((edge) => {
    const routed = g.edge(edge.causeId, edge.effectId) as { points?: Array<{ x: number; y: number }> } | undefined
    return {
      id: `${edge.causeId}\u0000${edge.effectId}`,
      from: edge.causeId,
      to: edge.effectId,
      path: pathFrom(routed?.points ?? [])
    }
  })

  const graph = g.graph() as { width?: number; height?: number }
  return {
    nodes,
    edges,
    width: Math.ceil(graph.width ?? 0),
    height: Math.ceil(graph.height ?? 0)
  }
}
