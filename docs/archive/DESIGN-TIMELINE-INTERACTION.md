# Design Draft — Timeline Interaction Redesign

Written 2026-08-10 against v0.11.6. A concrete UI proposal for the three
highest-impact timeline fixes — **T1 (interaction legend)**, **T2 (wheel-mode
ambiguity)**, **T3 (active-modes row)** — from `UX-TIMELINE-2026-08.md`. This is
a design draft, not an implementation: it fixes the *shape* so the tickets in
`UX-BACKLOG-TICKETS.md` can be built without re-litigating layout.

Scope discipline (from `PRODUCT-POSITIONING.md`): this makes the *existing*
timeline legible for the solo operator (P1). It adds no new capability and moves
nothing off the downstream line.

## Design principles for this surface

1. **The three core gestures are never a secret.** Pan, zoom, filter must be
   visible without pressing anything.
2. **A gesture means one thing.** No input whose result depends on invisible
   state. Where state must change behaviour, the state is shown.
3. **An empty track always explains itself.** If a mode is hiding events, a chip
   says so — the same instinct as the Capture Health exception report.
4. **Progressive disclosure.** Primary controls (zoom, filter) stay; the long
   tail collapses behind `?` and a "View options" menu (T4, separate ticket).

---

## Current layout (for reference)

```
┌─ Timeline ─────────────────────────────────────────────────────────────────┐
│ Timeline  1,204 events  load more   [?]  [−][100%↺][+]  [⇗ collapse]  [/____]│  ← header, dense
│  … lane chips (shell, agent, http, scanner, …)  tz  follow  anomaly  saved ⌄ │
├─────────────────────────────────────────────────────────────────────────────┤
│ shell   ● ● ●    ●        ●●●                                                 │
│ agent      ● ●  ●●●   ●                                                       │  ← track (18 lanes,
│ scanner        ●●●●●●●●●●                                                     │     empty ones hidden)
│ …                                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ [minimap density strip ▁▃▅▇▅▃▁]                                              │
└─────────────────────────────────────────────────────────────────────────────┘
     ▲ every gesture (drag-pan, ⌘-scroll zoom, alt-click solo, minimap zoom,
       f focus, right-click marker) is invisible until you press `?`.
```

---

## T1 — Persistent interaction legend

A single low-weight strip, always visible, carrying the three core gestures +
the pointer to the full list. Placement: a slim footer under the minimap (does
not compete with the header). Collapsible; state persists per project.

```
├─────────────────────────────────────────────────────────────────────────────┤
│ ⇔ drag to pan   ⌘-scroll to zoom   / filter          ? all shortcuts     ⌄   │  ← T1 legend
└─────────────────────────────────────────────────────────────────────────────┘
```

Collapsed (operator dismissed it):

```
│                                                                         ? ⌃  │
```

- Content is static except the `modKey` token (`⌘` on macOS, `Ctrl` elsewhere),
  resolved once and shared with the F5 shortcut registry.
- The `?` here opens the existing full cheatsheet modal — the legend is the
  teaser, the modal is the reference. No duplicated content (this is also F5).

**Behaviour:** collapse toggle writes `redlog-timeline-legend-collapsed` (per
project, like the other timeline prefs). Default expanded for a project that has
never shown it; once collapsed, stays collapsed.

---

## T2 — Wheel-mode: make the mode a decision, and show it

Today plain-wheel silently flips between horizontal pan and vertical scroll
depending on whether the lane stack overflows. Fix in two parts: **(a)** lift the
decision into a pure function so it is testable and unambiguous, **(b)** when the
ambiguous mode is active, *show* it.

### (a) The decision — `wheelMode(ctx)` (pure, the T2 seam)

```
inputs:  overflow  = laneStack.scrollHeight > clientHeight + 1
         shiftKey
         zoomKey   = ctrlKey || metaKey

           zoomKey │ shiftKey │ overflow │  →  result
          ─────────┼──────────┼──────────┼──────────────
             T     │    —     │    —     │  'zoom'        (cursor-anchored)
             F     │    —     │   F      │  'pan-x'       (common case, unchanged)
             F     │    T     │   T      │  'pan-x'       (shift overrides scroll)
             F     │    F     │   T      │  'scroll-y'    (reach the clipped lanes)
```

The whole confusing branch becomes one table with one row that is "surprising"
(`F/F/T → scroll-y`) — and that row is exactly the one T2(b) annotates on-screen.
`test/timeline-wheel.test.ts` pins all four rows.

### (b) Show the surprising mode

While `overflow` is true, a transient inline hint rides the right edge of the
track — visible only when it matters, so the common case stays clean:

```
│ shell   ● ● ●    ●        ●●●                          ┌───────────────────┐ │
│ agent      ● ●  ●●●   ●                                │ ⇅ scrolling lanes │ │
│ scanner        ●●●●●●●●●●                              │ ⇧-scroll to pan → │ │
│ …  (stack taller than the viewport — more below)      └───────────────────┘ │
```

- Appears only while `overflow` is true; fades after a few seconds of no wheel
  input, reappears on the next wheel event. Never shown when the stack fits.
- Long-term, **T6 (lane virtualization) deletes `overflow` entirely** — the
  stack always fits, `scroll-y` never happens, and this hint is removed with the
  branch. T2 is the interim; T6 is the cure.

---

## T3 — Active-modes row

Every sticky, non-default mode that is currently hiding or transforming events
gets one dismissible chip in a single row directly under the header. Default
state (nothing on) shows **no row at all** — no empty bar.

Nothing active:

```
│ (header)                                                                     │
│ (track…)                                                                     │   ← no modes row
```

Operator left three modes on and comes back to a near-empty track — now it says
why:

```
│ (header)                                                                     │
│ Active:  [◎ focus chain ✕]  [⚑ anomalies only ✕]  [solo: shell ✕]   clear all│  ← T3
├─────────────────────────────────────────────────────────────────────────────┤
│ shell   ● ● ●    ●        ●●●                                                 │
│ (other lanes hidden by solo)                                                 │
```

Modes surfaced as chips (all currently-toggleable state that changes what's
shown):

| Mode | Chip label | Default (no chip) |
|---|---|---|
| Focus chain | `◎ focus chain` | off |
| Anomaly filter | `⚑ anomalies only` | off |
| Follow mode | `⇊ following` | off |
| Collapse agent turns | `⇘ agent turns hidden −N` | off |
| Lane solo / hidden lanes | `solo: <lane>` or `N lanes hidden` | all shown |
| Text filter `/` | `/ "<query>"` | empty |

**Seam:** `lib/timelineModes.ts` — pure `activeModes(state) → ModeChip[]`, where
each chip carries a `clear()` action id. The row renders the array; empty array
→ no row. `test/timeline-modes.test.ts` asserts one chip per non-default mode and
the all-default → `[]` case. This pairs with **T5**'s `laneVisibility` seam
(solo/hidden derivation).

---

## Combined target layout

```
┌─ Timeline ─────────────────────────────────────────────────────────────────┐
│ Timeline  1,204 events   [−][100%↺][+]   [/____________]        ⋯ View ▾  ? │  ← header (T4 folds
├─────────────────────────────────────────────────────────────────────────────┤     tz/anomaly/follow/
│ Active:  [◎ focus chain ✕]  [solo: shell ✕]                        clear all │  ← T3 (only when on)
├─────────────────────────────────────────────────────────────────────────────┤
│ shell   ● ● ●    ●        ●●●                          ┌───────────────────┐ │
│ …                                                     │ ⇅ scrolling lanes │ │  ← T2 hint
│                                                       │ ⇧-scroll to pan → │ │     (only on overflow)
│                                                       └───────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│ [minimap density strip ▁▃▅▇▅▃▁]                                              │
│ ⇔ drag to pan   ⌘-scroll to zoom   / filter          ? all shortcuts     ⌄   │  ← T1 legend
└─────────────────────────────────────────────────────────────────────────────┘
```

Net effect for a first-run P1: the three things they need are on screen (legend),
the one confusing gesture explains itself when it occurs (T2 hint), and an empty
track is never a mystery (T3 row). The header is quieter because the rare
controls moved behind `⋯ View` (T4).

---

## Build order & seams (all pure, all testable first)

| Step | Ticket | Pure seam | Test |
|---|---|---|---|
| 1 | T1 | `modKey` token (shared w/ F5) | legend renders 3 gestures |
| 2 | T2 | `lib/timelineWheel.ts` `wheelMode(ctx)` | 4-row matrix |
| 3 | T3 | `lib/timelineModes.ts` `activeModes(state)` | one chip per non-default; `[]` when default |
| 4 | T4 | — (layout) | menu exposes each control |

Each step is independently shippable and follows the
`DEV-REQUIREMENTS-capture-onboarding.md` loop: seam + test before the component
renders it. None require touching the capture pipeline or the chain.

## Open questions for the maintainer

1. **Legend placement** — footer (drawn above) vs. a one-time coach mark that
   auto-dismisses. Footer is always-on and cheaper; coach mark is less
   persistent chrome. Recommendation: footer, collapsible.
2. **T2 option** — interim hint (option 1) now, or jump straight to T6
   virtualization and skip the hint? Recommendation: hint now (S), T6 later (L);
   the hint is deleted when T6 lands.
3. **Follow mode in T3** — is "following" a *mode that hides events* (belongs in
   the row) or just an auto-scroll (belongs in the header)? It doesn't hide
   data, so it may not warrant a chip. Recommendation: header toggle, not a chip.
