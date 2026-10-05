# Feature Specification: Causal Graph View

**Feature Branch**: `feat/causal-dag-view`

**Created**: 2026-10-05

**Status**: Implemented

**Input**: `queryEventCausalChain` has returned `{ events, edges }` since
v0.6.89.5. The renderer kept the ids and discarded the edges — Timeline's
`focusChain` is a `Set<string>` — so the only causal structure an operator
could see was one hop in each direction, as chips in the inspector. This
feature draws the component the backend was already computing.

## Background

Three places in the renderer read causality today, and none of them shows
shape:

- `TimelineEventInspector` renders `data._causes` as chips (one hop up) and a
  reverse-effects index as chips (one hop down).
- `Timeline`'s focus chain calls `events:causalChain`, keeps
  `new Set(result.events.map(e => e.id))` for dimming the track, and drops
  `result.edges` on the floor.
- `FocusChainBadge` reports the counts.

The question a finding raises is not "what is one hop from here" but "what did
this come from, and what did it lead to" — which is a path, and a path needs
more than a count and two chip rows.

Nothing is needed from the backend. `queryEventCausalChain` already traverses
both storage tiers, bounds itself (`maxDepth` ≤ 50, `eventLimit` ≤ 500),
reports `truncated`, and separates `unavailableCauseIds` from events it simply
did not page in.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An operator traces a finding back to what produced it (Priority: P1)

An operator opens a `marker:finding` on the Timeline and wants to know which
request surfaced it and which command issued that request. The inspector names
the immediate cause; the one before that needs another click, and the shape of
the whole path is never visible at once.

**Acceptance**: expanding `Causal graph` on the finding draws the finding, its
causes and its effects as a directed graph, with the finding marked as the
anchor. Clicking any node selects that event in the inspector.

### User Story 2 - Missing evidence is visible as missing (Priority: P1)

A cause that retention removed, or that a producer never wrote, must not look
like the end of a chain.

**Acceptance**: an unavailable cause referenced by an edge is drawn as an
explicit placeholder node, visually distinct from a recorded event and not
selectable. The count is reported beneath the graph.

### User Story 3 - A bounded walk says it is bounded (Priority: P2)

**Acceptance**: when the backend reports `truncated`, the graph says so rather
than presenting a partial component as complete.

## Requirements *(mandatory)*

- **FR-001**: The graph MUST render `queryEventCausalChain(anchorId)` — every
  returned event as a node, every returned edge as a directed link.
- **FR-002**: The graph MUST NOT apply the shared filter. The backend's own
  contract states the chain "deliberately ignores list filters: hiding linked
  evidence would make provenance misleading", and a provenance view that drops
  links inherits that defect. This is why the view queries for itself rather
  than reading Timeline's `focusChain`, which is passed through `matchIds`.
- **FR-003**: An id in `unavailableCauseIds` that an edge points at MUST be
  drawn as a placeholder. An id no edge points at MUST NOT be drawn — a node
  with no line into it reads as a defect, not as missing evidence.
- **FR-004**: Absence MUST stay neutral. Nothing distinguishes "retention
  removed it" from "never written", and the placeholder MUST NOT claim either.
- **FR-005**: Layout MUST be top-to-bottom. The view lives in the detail pane,
  440px by default and 280px at its narrowest; left-to-right puts a ten-rank
  chain across ~2400px, which is unreadable at pane width.
- **FR-005a**: A rank of two MUST fit the right-docked pane without a
  horizontal scrollbar. That is the commonest branch — a request with both a
  response and a scope violation hanging off it — and it was the first shape
  tried in the running app. Measured there: the dock's inner width is 396px,
  and a 186px node made the rank 414px, clipping the second node. Node width
  is 172px so the rank comes to 386px. A rank of three or more does not fit
  and is left to scroll; shrinking every node to that case would cost the
  common one its title.
- **FR-006**: Colour MUST follow UIUX-STANDARD §1 — hue is status, not
  category. Nodes MUST NOT carry a per-lane colour; the lane is named in the
  node's own meta line. The anchor's ring is the one status mark.
- **FR-007**: The graph MUST NOT query on selection. It is collapsed by
  default and fetches when opened, so stepping through rows does not fire a
  causal-chain query per row.
- **FR-008**: Layout MUST be deterministic. The same chain MUST produce the
  same node order, or React remounts every node on refresh.
- **FR-009**: Layout MUST terminate on a cyclic `_causes`. The field is
  producer-supplied and nothing upstream guarantees it is acyclic.

## Non-Goals

- **Pan and zoom.** The pane scrolls vertically and the graph is bounded by
  `eventLimit`. A canvas to roam would be the answer to a question this
  container does not pose. (See *Why not React Flow* below.)
- **Replacing the chips.** One hop up and one hop down stay where they are;
  they answer a different, commoner question and they carry detail the nodes
  do not.
- **A project-wide graph.** This is one event's component, not a map of the
  engagement.

## Implementation Notes

### Why dagre, and why not React Flow

Layered layout over a possibly-cyclic digraph — break cycles, assign ranks,
reduce crossings, place coordinates — is not worth hand-rolling, so
`@dagrejs/dagre` does it. It is layout only and emits no DOM.

Rendering is RedLog's own SVG, not React Flow, for a reason measured rather
than assumed. The renderer draws inside `body { zoom: var(--app-zoom, 0.9) }`
(`styles/index.css:270`), with an operator-selectable scale up to 1.4×
(`lib/uiScale.ts`). Under CSS `zoom`, two unit systems coexist, and a spike on
Chromium 152 measured both:

| `--app-zoom` | `rect.width` ÷ `offsetWidth` | 100px CSS `translateX` observed as |
|---|---|---|
| 0.9 | 0.8998 | 90.0 client px |
| 0.99 | 0.99 | 99.0 |
| 1.125 | 1.1246 | 112.5 |
| 1.26 | 1.2605 | 126.0 |

React Flow's pan and node drag run on d3-zoom, whose pointer maths is
`event.clientX − node.getBoundingClientRect().left` — a **client**-pixel
delta — and it applies that delta as a **CSS**-pixel `transform: translate()`.
The two differ by exactly the zoom factor, so the canvas would lag the cursor
by 10% at the default scale and overshoot by 26% at the largest. A workaround
exists (neutralise `zoom` on the container, fold the app scale into the
library's own transform) but it is the class of patch that breaks silently
when `uiScale` next changes, and no unit test would catch it.

Since the pane scrolls and the graph is bounded, pan and zoom were the only
thing React Flow was being brought in for. The layout module is independent of
the renderer, so a later full-window view that does need roaming can adopt
React Flow without touching it.

### Files

| File | Role |
|---|---|
| `src/renderer/src/lib/causalGraphLayout.ts` | Pure: chain → geometry. No DOM, no measurement. |
| `src/renderer/src/components/timeline/CausalGraph.tsx` | Fetch, states, SVG. |
| `src/renderer/src/components/timeline/TimelineEventInspector.tsx` | The collapsed section that hosts it. |
| `test/causal-graph-layout.test.ts` | Ranking, ghosts, cycles, determinism. |
| `test/causal-graph.test.tsx` | Nodes drawn, selection, the three non-drawing states. |

`Timeline.tsx` is unchanged. The view owning its own query is what keeps it
out of a 2774-line file.
