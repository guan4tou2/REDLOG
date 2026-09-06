# Timeline Elements — the reconstruction surface, decomposed

Written 2026-08-13. Applies `DECOMPOSITION-METHOD.md` to the timeline as a
**structural lens**, complementing (not replacing) the design docs that own the
timeline: `SPEC-TIMELINE-AXIS.md` (the axis refactor), `UX-TIMELINE-2026-08.md`
(the UX diagnosis + T1–T6), and `DESIGN-PRINCIPLES.md` §8 (timeline = event map,
transcript = I/O reader) / §9 (necessity). Those are the source of truth for
*what to build*; this doc adds the closed **element taxonomy** — so the timeline's
complexity has a structural name (channel/mode overloading) and every element
declares whether it shows a fact or a suggestion.

## The principle everything derives from

The timeline is a **visual encoding surface**: it maps data dimensions to visual
variables and exposes interactions over them. Its felt complexity (UX-TIMELINE's
"invisible, overloaded, context-dependent") is **channel/mode overloading** — one
visual channel carrying two data dimensions, or one gesture bound to two actions.
The decomposition's payoff: **one channel = one data dimension; one mode = one
action; every element declares its §3 authority.** When that holds, the surface is
legible by construction.

> **Implementation status varies by branch.** This is a *structural* taxonomy, not
> a shipped-state guarantee. Some elements are live on `feat/ux-design-and-tickets`
> (lane axis, phase ribbon, wheel/modes/keys resolvers), some only have their
> underlying data on `main` with the visual still proposed (instance-ordinal
> badges, shell bracketed-cast preview). Rows below tag **[shipped]** / **[data
> only]** / **[proposed]** where sessions have confirmed; confirm against git
> before relying on any as done.

## Two families (mechanism axis)

```
Does it map a DATA dimension → a visual variable?   → ENCODING CHANNEL
Does it let the operator NAVIGATE or MUTATE?        → INTERACTION MODE
```

## The authority axis (§3, applies to every element)

Every element renders either a **fact** (operator marker, primary capture) or an
**inferred suggestion** (ambiguous target, inferred phase) — and the two must be
**visually distinct** (solid vs dashed/ghost) with one-click promotion. This is
already the phase-ribbon design (solid markers vs dashed inference,
`SPEC-TIMELINE-AXIS.md` §11); the taxonomy makes it a rule for *all* elements.

## Encoding channels (closed set)

Visual variables are a bounded set (Bertin: position, colour, shape, size/density,
plus the temporal band, and composites of these — e.g. an instance ordinal =
colour + text-value) — so this table is provably exhaustive over what the surface
*can* encode.

| Channel | Data dimension | Authority | Seam / source |
|---|---|---|---|
| **Position-X** | time (the one fixed anchor) | fact (wall-clock, but see clock-anomaly) | time scale |
| **Lane (Y-group)** | organizing axis — `source` **or** `target`/phase (§8) | fact | `lanesForAxis(axis, events, …)` (implemented: header ⊞ toggle) |
| **Colour** | source-type (kept as encoding even when lane = target) | fact | event `agent_type` |
| **Glyph / shape** | event kind | fact | event registry |
| **Instance ordinal** | which concurrent instance — `instanceOf(event)`: shell = `terminal_id` (ext-shell fallback `pid`), agent = `session_id`; HTTP/scanner `flow_id` **excluded** (per-request, not a persistent instance) | fact (recorded id) | **[data only]** `session_id`/`terminal_id` exist in event data on `main`; the **[proposed]** visual = coloured ordinal badge (dot corner) + detail chip (`term #2`) + cluster-popover `#N`, shown only when a lane has >1 concurrent instance |
| **Density / cluster** | event count in a 14px time bucket | fact | `timelineCluster.ts` |
| **Phase ribbon (band)** | phase segments over time | **fact (solid marker) + suggestion (dashed inference)** | `phaseRibbon.ts` |

**The §8 fix restated in channel terms:** originally **lane and colour were both
bound to source-type** — redundant, and the lane channel maxed out at 18 groups.
§8 re-binds **lane ← target/phase**, freeing colour to keep encoding source without
the 18-lane overload. One channel, one dimension.

## Interaction modes (closed set)

Interaction reduces to a bounded set — navigate, filter, select, mutate — so this
too is exhaustive.

Seams below are the **implemented** pure resolvers on the PR #8 branch (per the
timeline-axis session), not spec placeholders.

| Mode | Action | State visibility | Implemented seam |
|---|---|---|---|
| **Navigate** | pan / zoom / scroll the time axis | — (the overloaded one) | `lib/timelineWheel.ts` (`wheelMode` decision matrix) + `lib/timelineKeys.ts` (keyboard resolver) |
| **Filter** | show/hide/solo lanes; source-type demoted to a filter (§8) | T3 active-modes row | `lib/timelineModes.ts` (`activeModes` — which non-default modes are hiding events) |
| **Select / inline-preview → drill-down** | three-part (§8 refined): **axis = glyph** presence **[shipped]** (v0.9.2 `eventTitle` role prefixes `❯ ◂ ⚙ ↩ 💭`); **select = inline short I/O preview** — agent tier-2 **[shipped]** (v0.9.2 `AgentTurnDetail`, `CollapsibleStream startOpen`, *text* body), shell bracketed-cast stdout preview **[proposed]** (`CommandEndDetail` shows stdout/stderr today but not the bracketed-cast visual); **full narrative = transcript** **[proposed]** ("Open transcript" button, like today's "Open sidecar") | selection highlight | detail inline preview + transcript view |
| **Mutate / promote** | inferred → authoritative (dashed phase → solid marker, §3) | the "suggest" affordance | phase-ribbon promote action |

## Completeness

- **Channels:** the surface can encode only via position, colour, shape, density,
  a temporal band, or a composite of these (instance ordinal = colour+text-value)
  — a closed set. Every current visual maps to one row; nothing falls outside.
- **Modes:** an operator can only navigate, filter, select, or mutate — a closed
  set. Every current gesture maps to one row.
- **Authority:** every element is fact or suggestion (§3) — no third state.

So the timeline is fully described by **7 channels × 4 modes × the fact/suggestion
axis**. A new timeline feature is one of these, or it is over-encoding (see gaps).

## Gaps — the UX-TIMELINE problems, restated structurally

| # | UX-TIMELINE problem | Structural name | Fix |
|---|---|---|---|
| G1 | "same gesture does different things by invisible state" (wheel) | **one mode bound to two actions** (pan/zoom/scroll on the same wheel, switched by hidden state — the `timelineWheel.ts` `wheelMode` matrix) | T2 — one gesture, one action; make the binding explicit |
| G2 | "every affordance invisible until `?`" | **modes have no state channel** — interaction state isn't encoded on the surface | T1 persistent legend + T3 active-modes row (give modes a visible channel) |
| G3 | "18-colour problem" | **lane + colour both bound to source-type** (redundant, lane overloaded) | §8 axis re-bind: lane ← target/phase, colour ← source |
| G4 | inference vs fact must not blur | **authority axis not uniform across elements** — only phase does solid/dashed today | extend solid-vs-dashed to every inferred element (ambiguous target, inferred tags) per §3 |
| G5 | timeline trying to be the I/O reader | **Select mode scope** — where does I/O content live | §8 refined (three-part): axis = glyph; select = *inline short* preview in the detail; *full* narrative stays in the transcript/exchange view — the map never becomes the full reader |

## Why this lens pays

- It gives the timeline's complexity a **structural diagnosis** (overloaded
  channel/mode) instead of a list of symptoms — each T-ticket becomes "un-overload
  channel X / mode Y."
- It makes "should this go on the timeline?" answerable: which channel or mode is
  it? If none, it belongs in a paired surface (transcript/HUD/search, §8), not the
  map.
- It carries §3 onto every visual element by contract, not by memory.

## Cross-references

- Owns the axis design: `SPEC-TIMELINE-AXIS.md`
- Owns the UX diagnosis + tickets: `UX-TIMELINE-2026-08.md`, `UX-BACKLOG-TICKETS.md` (T1–T6)
- Surface split (map vs reader vs HUD vs search): `DESIGN-PRINCIPLES.md` §8, §9
- Fact vs inferred suggestion: `DESIGN-PRINCIPLES.md` §3
- The method + its variants: `DECOMPOSITION-METHOD.md`
