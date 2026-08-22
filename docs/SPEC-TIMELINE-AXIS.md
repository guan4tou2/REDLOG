# Spec — Timeline Reconstruction Axis (Phase C)

Written 2026-08-11. Executable spec for the flagship timeline refactor from
`DESIGN-PRINCIPLES.md` §8/§9: re-organise the timeline from a live source-type
firehose into a **reconstruction surface organised by target and phase**. This
is the highest-value and highest-risk item in the UX plan — it touches the
4,100-line `Timeline.tsx` lane model — so it is specced before a line is wired.

Foundation already shipped (Phase B, commit `d8494c2`): `phaseSegments`,
`phaseInference`, `targetGrouping`. This spec is how they reach the screen.

## Goal

A reviewer reconstructing an engagement asks *"what happened to this target, in
what order?"* and *"reconstruct this phase (recon → exploit → pivot → exfil)."*
The current 18 source-type lanes answer *"which streams are active"* — a live
question that now belongs to the HUD (§8). Phase C makes the timeline answer the
reconstruction questions.

## Non-goals (unchanged from the principles)

- No opinionated ATT&CK/correlation output. Phase inference stays a **suggestion**
  (§3) — dashed, promotable, never authoritative.
- Timeline stays the **event map**; it does not grow inline I/O content (that is
  the transcript/exchange reader, §8 / Q10).
- No new capture. This is a presentation refactor over existing events + the
  Phase B seams.

## The axis model (recommended design)

Two orthogonal controls, not one three-way switch:

1. **Lane axis** — the swim-lane rows. Toggles between:
   - `source` *(current, default at ship)* — the 18 source-type lanes, unchanged.
   - `target` *(new)* — one lane per target from `groupByTarget(events)`, plus the
     explicit **untargeted** lane always last (§12). Each event's dot keeps its
     source-type colour/shape, so source is still legible as an encoding, just
     not as the row axis.
2. **Phase ribbon** — a thin horizontal band across the top of the time axis,
   independent of the lane axis, rendered from `phaseSegments(...)`. Operator
   phase-markers draw **solid** bands; `inferPhaseSuggestions(...)` draws
   **dashed/ghost** bands with a "suggest" affordance that promotes to an operator
   marker on click (§11). Toggleable; off by default until the operator has
   phases.

> **Why a ribbon, not a third lane mode:** phase is inherently *temporal*
> (segments over time), so it maps naturally to time-bands, not rows. Making it a
> ribbon lets target-lanes and phase coexist ("show me, per target, which phase
> each action fell in") instead of forcing a choice. **Open question O1** records
> the alternative.

### Data flow

```
events ──┬─ groupByTarget()        → target lanes (axis='target')
         ├─ toLane() [existing]     → source lanes (axis='source')
         ├─ phaseMarkersFromEvents → phaseSegments()   → solid phase bands
         └─ inferPhaseSuggestions()                    → dashed phase bands
event dot colour/shape ← source-type (unchanged encoding, both axes)
```

## Safe refactor strategy — incremental, behind a toggle

The rule: **never a big-bang replacement of the lane model.** Order:

1. **Extract T5 seams first** (make the current behaviour testable before
   changing it):
   - `lib/timelineCluster.ts` — the 14px same-lane cluster bucketing (currently
     inline). Pure `clusterEvents(events, pxPerMs, laneOf)`.
   - `lib/laneVisibility.ts` — populated / visible / hidden / solo resolution
     (currently inline; pairs with the T3 modes seam already shipped).
   Each ships with unit tests and is imported back into Timeline.tsx with **zero
   behaviour change** (renderer-smoke + timeline-keys stay green). This buys the
   first real interaction-test coverage on the file before we touch its axis.
2. **Introduce `laneAxis` state** (`'source' | 'target'`), default `'source'`.
   Add a `lib/timelineAxis.ts` seam: `lanesForAxis(axis, events, ...)` returning
   the ordered lane descriptors — for `'source'` it returns today's lanes
   (delegating to the existing logic), for `'target'` it wraps `groupByTarget`.
   The renderer maps events to rows through this one function regardless of axis.
   Ship with `'source'` as default so nothing changes until the operator opts in.
3. **Wire the target axis** behind a header control (part of the T4 "View
   options" menu). Verify empty/untargeted handling, cluster + visibility still
   work per-lane, and the T3 modes row reflects target-lane solo/hide.
4. **Add the phase ribbon** (solid from markers, dashed from inference, promote
   action). Independent toggle.
5. **Fold TargetView in** — once the target axis is solid, TargetView becomes the
   timeline with `laneAxis='target'`; deprecate the separate view or make it a
   deep-link into that axis. (Sequenced last; not required for the axis to ship.)

Each step is independently shippable and independently revertible. The default
stays `source` until `target` is proven, so no operator loses the current view on
upgrade.

## Seams to build (all pure, TDD, renderer lib)

| Seam | Purpose | Ships in step |
|---|---|---|
| `timelineCluster.ts` | cluster bucketing, testable | 1 |
| `laneVisibility.ts` | populated/visible/hidden/solo | 1 |
| `timelineAxis.ts` | `lanesForAxis(axis, events, …)` → ordered lanes | 2 |
| `phaseRibbon.ts` | merge `phaseSegments` (solid) + `inferPhaseSuggestions` (dashed) into render-ready bands, with promote targets | 4 |

Phase B seams (`phaseSegments`, `phaseInference`, `targetGrouping`) are consumed,
not rebuilt.

## Acceptance criteria

- **A1 — no-regression default:** with `laneAxis='source'` and the phase ribbon
  off, the timeline is byte-for-byte the current behaviour. `renderer-smoke` and
  `timeline-keys` stay green; the T5 extractions change nothing observable.
- **A2 — target axis:** `laneAxis='target'` renders one lane per target ordered by
  first activity, untargeted last; every event appears in exactly one lane; dots
  keep source-type encoding.
- **A3 — untargeted honesty:** events with no target land in the explicit
  untargeted lane, never dropped, never guessed into a target (§12).
- **A4 — phase ribbon:** operator phase-markers render as solid bands spanning
  their segment; inferred suggestions render dashed and are visually distinct;
  clicking a suggestion's promote affordance creates an operator marker (an
  authoritative, attributable, on-chain fact — §3/§11).
- **A5 — cross-feature integrity:** cluster popovers, lane solo/hide (T3 row),
  the `/` filter, zoom/pan, and the T2 wheel behaviour all work under both axes.
- **A6 — I/O boundary held:** the timeline still surfaces I/O only as a glyph;
  drill-down still opens the transcript (§8 / Q10). No inline I/O content added.

## Regression guards (hard gates each step)

- `npx vitest run` on: the new seam tests, `renderer-smoke`, `timeline-keys`,
  `timeline-modes`, `timeline-wheel`, plus (steps 1) the extracted-seam tests.
- `npm run build` green.
- i18n en/zh parity for any new axis/ribbon copy.
- Manual smoke on a transcript-heavy project before folding TargetView in (step 5).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Big-bang breaks the fragile 4,100-line file | Toggle-behind + `source` default; each step revertible; T5 seams give test coverage *before* the axis change |
| Target-lane count explodes on a wide engagement | Lane virtualization (T6) — sequence it alongside/after; until then cap + "N more targets" like the cluster cap |
| Phase inference reads as authoritative | Enforced by design: dashed rendering + promote-to-marker; inference never writes to the chain (§3) |
| Concurrent edits to Timeline.tsx (has happened) | Single-owner sequential passes; check `git status`/mtime before each |

## Open questions — RESOLVED 2026-08-11

- **O1 — phase representation → RIBBON overlay.** Phase renders as a horizontal
  time-band at the top of the time axis, independent of the lane axis, so target
  lanes and phase coexist. (Not a third `laneAxis='phase'` mode.)
- **O2 — default axis at ship → keep `source`.** `target` is opt-in; nothing
  changes on upgrade until the operator switches. Revisit the default after
  dogfooding.
- **O3 — TargetView → REMOVE.** The `target` lane axis fully subsumes TargetView;
  step 5 deletes the separate view rather than keeping it as a deep-link. (More
  decisive than the original recommendation — the axis is the one place targets
  are reviewed.)

## Sequencing summary

Step 1 (T5 seams, no behaviour change) → Step 2 (`timelineAxis` seam, source
default) → Step 3 (wire target axis behind View options) → Step 4 (phase ribbon +
promote) → Step 5 (**remove** TargetView, per O3). Steps 1–2 shipped (commits
7c98579, dfceb47); O1–O3 resolved, so 3–5 are unblocked.

Cross-references: `DESIGN-PRINCIPLES.md` §3/§8/§9/§11/§12 · `UX-TIMELINE-2026-08.md`
(T-series) · `UX-BACKLOG-TICKETS.md` (T4/T5/T6) · Phase B commit `d8494c2`.
