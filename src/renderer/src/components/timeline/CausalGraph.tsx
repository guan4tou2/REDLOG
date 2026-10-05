// The causal component around one event, drawn.
//
// The inspector already shows one hop in each direction — `caused by` chips
// and an `effects` list. Neither says what the shape is three hops out, which
// is the question a finding actually raises: what did this come from, and what
// did it lead to. `queryEventCausalChain` has answered that since v0.6.89.5;
// its `edges` just had nowhere to go.
//
// This fetches its own chain rather than reading Timeline's `focusChain`.
// They are not the same data: the focus set is passed through `matchIds` and
// drops links the shared filter excludes, which is right for dimming a track
// and wrong here — a provenance view that hides a link misleads. The backend
// says so itself ("deliberately ignores list filters").
//
// Colour follows UIUX-STANDARD §1: hue is status, not category. Nodes do not
// get a per-lane colour; the lane is named in the node's own meta line, the
// way the Timeline separates lanes by label. The accent ring marks the anchor
// because "which one is the event I opened" is the only status here.

import { useEffect, useState } from 'react'
import type { RedLogEvent, EventCausalChain } from '../../../../core/db/event-types'
import type { Translate } from '../../lib/eventTitle'
import { formatTime } from '../../lib/time'
import { toLane, LANE_LABEL_KEYS, type PluginEventType } from '../../lib/timelineDomain'
import {
  layoutCausalGraph,
  type CausalGraphLayout,
  type CausalGraphNode
} from '../../lib/causalGraphLayout'

export interface CausalGraphProps {
  /** The event whose causal component is drawn. */
  anchorId: string
  /** Plugin-declared event types, so a plugin row lands in the lane it
   *  declares rather than the fallback — the same list the Timeline uses. */
  pluginTypes: PluginEventType[]
  /** The Timeline's single source of displayed text, so a corrected finding
   *  reads here the way it reads on the track. */
  titleOf: (e: RedLogEvent) => string
  /** Select a node's event; the inspector swaps to it. */
  onSelect: (e: RedLogEvent) => void
  t: Translate
}

type State =
  | { phase: 'loading' }
  | { phase: 'failed' }
  | { phase: 'ready'; chain: EventCausalChain; layout: CausalGraphLayout }

/** Type size inside the graph. The pane's own baseline is `text-xs` (12px),
 *  which UIUX-STANDARD §23 settled on deliberately — below the §2 floor of
 *  13px so an annotation does not outweigh the content it annotates. SVG text
 *  takes a number, not a class, so the number is named here once. */
const NODE_FONT_PX = 12

/** How much of a title fits across a node, in half-width units.
 *
 *  Counted rather than measured: measuring would make the layout depend on
 *  the font being loaded, and clipped here rather than with SVG `textLength`
 *  (which squeezes glyphs instead of cutting them) or a clipPath per node
 *  (200 of those is a lot of defs for no gain at this size).
 *
 *  Units, not characters, because the UI ships zh-TW: 23 Latin characters fit
 *  a 172px node and 23 Han characters are twice that wide. */
const TITLE_UNITS = 23

/** Fullwidth ranges that occupy two half-width cells: CJK ideographs and
 *  kana, Hangul, and the fullwidth/CJK punctuation forms around them. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/

function clip(text: string, maxUnits: number): string {
  let used = 0
  for (let i = 0; i < text.length; i++) {
    const cost = WIDE.test(text[i]) ? 2 : 1
    // The ellipsis needs a cell of its own, so stop one short of the budget.
    if (used + cost > maxUnits - 1) return `${text.slice(0, i)}…`
    used += cost
  }
  return text
}

/** The node's second line: when it happened, and which lane it is in. The
 *  lane is the label the Timeline separates by, so the two views name the
 *  same row the same way. */
function nodeMeta(event: RedLogEvent, pluginTypes: PluginEventType[], t: Translate): string {
  const lane = toLane(event.agentType, event.data?.subtype as string | undefined, pluginTypes)
  return `${formatTime(event.timestamp, { seconds: true })}  ${t(LANE_LABEL_KEYS[lane])}`
}

/** Declared at module scope. A component defined inside another component's
 *  body is a new type on every render, so React would remount every node on
 *  each hover — and the unit suite, which renders once, would not show it. */
function GraphNode({
  node, title, meta, hovered, onPick
}: {
  node: CausalGraphNode
  title: string
  meta: string
  hovered: boolean
  onPick: () => void
}): JSX.Element {
  if (!node.event) {
    // An unavailable cause. Absence is neutral: nothing here can tell whether
    // retention removed the row or the producer never wrote it, so the node
    // says "not available" and does not guess.
    return (
      <g transform={`translate(${node.x},${node.y})`} data-testid="causal-node-unavailable">
        <rect
          width={node.width} height={node.height} rx={4}
          className="fill-none stroke-redlog-border-subtle"
          strokeDasharray="3 3" strokeWidth={1}
        />
        <text
          x={node.width / 2} y={node.height / 2 + 4}
          textAnchor="middle" className="fill-redlog-muted italic"
          style={{ fontSize: NODE_FONT_PX }}
        >{meta}</text>
      </g>
    )
  }

  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      className="cursor-pointer"
      data-testid="causal-node"
      data-event-id={node.id}
      onClick={onPick}
    >
      <rect
        width={node.width} height={node.height} rx={4}
        className={`fill-redlog-elevated ${
          node.isAnchor ? 'stroke-redlog-accent' : hovered ? 'stroke-redlog-border' : 'stroke-redlog-border-subtle'
        }`}
        strokeWidth={node.isAnchor ? 1.5 : 1}
      />
      {/* Two lines at the same size, separated by colour and by the mono face
          — not by shrinking the second one under the pane's floor. */}
      <text x={11} y={18} className="fill-redlog-text" style={{ fontSize: NODE_FONT_PX }}>{title}</text>
      <text x={11} y={34} className="fill-redlog-muted font-mono" style={{ fontSize: NODE_FONT_PX }}>{meta}</text>
    </g>
  )
}

export function CausalGraph({ anchorId, pluginTypes, titleOf, onSelect, t }: CausalGraphProps): JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    setHovered(null)
    void window.redlog.events.causalChain(anchorId).then((chain) => {
      if (cancelled) return
      if (!chain.anchorFound) { setState({ phase: 'failed' }); return }
      setState({ phase: 'ready', chain, layout: layoutCausalGraph(chain) })
    }).catch(() => {
      if (!cancelled) setState({ phase: 'failed' })
    })
    return () => { cancelled = true }
  }, [anchorId])

  if (state.phase === 'loading') {
    return <p className="text-xs text-redlog-muted py-6 text-center">{t('timeline.causalGraph.loading')}</p>
  }
  if (state.phase === 'failed') {
    return <p className="text-xs text-redlog-muted py-6 text-center">{t('timeline.causalGraph.failed')}</p>
  }

  const { chain, layout } = state

  // One event and no edges is not a graph. The inspector's own chips already
  // say "no causes, no effects" better than an empty canvas does.
  if (layout.edges.length === 0) {
    return <p className="text-xs text-redlog-muted py-6 text-center">{t('timeline.causalGraph.solitary')}</p>
  }

  const incident = (id: string): boolean =>
    !!hovered && (hovered === id || layout.edges.some(
      (e) => (e.from === hovered && e.to === id) || (e.to === hovered && e.from === id)
    ))

  return (
    <div data-testid="causal-graph">
      <div className="overflow-auto max-h-[52vh] rounded border border-redlog-border-subtle bg-redlog-surface">
        <svg
          width={layout.width} height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img" aria-label={t('timeline.causalGraph.ariaLabel', { count: layout.nodes.length })}
        >
          <defs>
            <marker
              id="causal-arrow" viewBox="0 0 8 8" refX="7" refY="4"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 Z" className="fill-redlog-border" />
            </marker>
          </defs>

          <g>
            {layout.edges.map((edge) => {
              const hot = hovered !== null && (edge.from === hovered || edge.to === hovered)
              return (
                <path
                  key={edge.id}
                  d={edge.path}
                  markerEnd="url(#causal-arrow)"
                  className={`fill-none ${hot ? 'stroke-redlog-accent' : 'stroke-redlog-border'}`}
                  strokeWidth={hot ? 1.8 : 1.2}
                  opacity={hovered === null ? 0.5 : hot ? 1 : 0.12}
                />
              )
            })}
          </g>

          <g>
            {layout.nodes.map((node) => {
              const dimmed = hovered !== null && !incident(node.id)
              return (
                <g
                  key={node.id}
                  opacity={dimmed ? 0.28 : 1}
                  onMouseEnter={() => setHovered(node.id)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <GraphNode
                    node={node}
                    title={node.event ? clip(titleOf(node.event), TITLE_UNITS) : ''}
                    meta={node.event ? nodeMeta(node.event, pluginTypes, t) : t('timeline.causalGraph.unavailable')}
                    hovered={incident(node.id)}
                    onPick={() => { if (node.event) onSelect(node.event) }}
                  />
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      <p className="mt-2 text-xs text-redlog-muted font-mono flex flex-wrap gap-x-3 gap-y-1">
        <span>{t('timeline.causalGraph.counts', { nodes: layout.nodes.length, edges: layout.edges.length })}</span>
        {chain.unavailableCauseIds.length > 0 && (
          <span>{t('timeline.causalGraph.unavailableCount', { count: chain.unavailableCauseIds.length })}</span>
        )}
        {chain.truncated && <span>{t('timeline.causalGraph.truncated')}</span>}
      </p>
    </div>
  )
}
