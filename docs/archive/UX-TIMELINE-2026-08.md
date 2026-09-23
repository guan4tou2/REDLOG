# Timeline UX — Why It Feels Complex, and How to Simplify

Written 2026-08-10 against v0.11.5, from a full read of `Timeline.tsx`. This is
the deep-dive behind finding **F2** in `UX-AUDIT-2026-08.md`. The complaint —
"the timeline is too complex and not intuitive to operate" — is correct and, on
inspection, *specific*: it is not that the timeline does too much, it is that
**its interactions are invisible, overloaded, and context-dependent.** Those are
three fixable properties, not a vague feeling.

Every claim cites a line so it can be checked.

## The root cause in one sentence

The timeline grew ~14 interaction affordances layered onto a single canvas, and
almost none of them **announce themselves, hold a visible state, or behave the
same way twice.** An expert who memorized them is fast; everyone else is
guessing.

## The three concrete problems

### 1. The same gesture does different things depending on invisible state

The clearest offender is the mouse wheel (`Timeline.tsx`, wheel handler):

- `⌘/ctrl + wheel` → zoom (cursor-anchored).
- plain `wheel` → **horizontal** pan… *unless* the lane stack is taller than its
  container, in which case plain `wheel` becomes **vertical** scroll and you must
  hold `shift` to pan horizontally.

So the same plain-wheel gesture pans sideways in one engagement and scrolls down
in another, with **no on-screen cue which mode you're in**. This is the single
most disorienting thing in the view. The code even documents the branch — it's a
correct fix for a real reachability bug (bottom lanes were unreachable), but the
mode switch is silent.

**Fix options (pick one):** (a) a transient "⇅ scrolling lanes · ⇧ to pan" hint
that appears only while the stack overflows; (b) a dedicated vertical scrollbar
on the lane stack so the wheel can stay horizontal always; (c) never overflow —
virtualize lanes so the stack fits (this is the V4 item already in `ROADMAP.md`).

### 2. Every affordance is invisible until you press `?`

The interaction vocabulary — `⌘K` palette, `/` filter, `?` help, `f` focus
chain, `↑/↓` walk, right-click drop-marker, **Alt-click a lane chip to solo**,
minimap drag-to-zoom, drag-to-pan — is discoverable only through the `?`
cheatsheet, which is itself only discoverable by pressing `?` or spotting a 20px
`?` glyph in a crowded header. A first-time operator sees a wall of dots and has
no way to learn that Alt-click solos a lane or that the minimap zooms.

**Fix:** a persistent, low-weight **interaction legend** (a one-line hint strip,
or an always-visible "drag to pan · ⌘-scroll to zoom · ? for keys" footer) so the
core three gestures are never a secret. Reserve the `?` modal for the long tail.

### 3. Modes toggle but don't persistently show they're on

Focus-chain, follow-mode, anomaly-filter, collapse-agent-turns, and lane-solo are
all sticky toggles. Some show a badge (focus chain has a corner pill; collapse-
agent tints its chip); others change the result silently. An operator who left
`anomaly filter` or a lane `solo` on comes back later, sees a near-empty track,
and reasonably concludes the tool lost data.

**Fix:** every active non-default mode gets a visible, dismissible chip in one
consistent "active filters" row, so "why is my timeline empty" always has an
on-screen answer. This mirrors the instinct already right in the Capture Health
card — surface the exception, make absence explainable.

## Secondary contributors

- **Header density.** The control bar carries title, event count, load-more,
  `?`, zoom −/reset/+, collapse-agent chip, and the `/` filter *before* the lane
  chips and saved-views/tz/follow/anomaly controls even begin. Primary actions
  (zoom, filter) compete for attention with rarely-touched ones (tz, anomaly).
  **Fix:** keep zoom + filter primary; fold tz / anomaly / follow / saved-views
  behind a single "⋯ View options" menu. Progressive disclosure, not deletion.
- **Escape was overloaded.** Escape was bound in three independent listeners
  (close detail / close help / exit focus), so with all three open one press
  fired all three. *Fixed this cycle* — see below.
- **One 3,875-line component, zero interaction tests.** 49 `useState`, 45
  `useEffect`. Nothing stops a new interaction from breaking an old one, because
  none of them are covered. Extraction of pure seams (below) is the way in.

## What it is NOT

Not too many lanes — empty lanes auto-collapse, so the operator only ever sees
what an engagement touched. Not too much data — clustering and load-more handle
scale. The problem is strictly the **input model**, not the output.

## Prioritized plan

| # | Change | Why it's the lever | Effort |
|---|---|---|---|
| T1 | Persistent interaction legend (3 core gestures always visible) | Kills "invisible affordances" for the 80% case | S |
| T2 | Resolve the wheel-mode ambiguity (hint strip or lane scrollbar) | The single most disorienting behaviour | S–M |
| T3 | One "active filters/modes" row; every non-default mode shows a chip | "Why is my timeline empty" gets an on-screen answer | M |
| T4 | Fold secondary controls behind a "View options" menu | Header stops competing with itself | M |
| T5 | Extract pure seams + first interaction tests (key resolver ✓, cluster bucketing, lane visibility) | Makes the next change safe | M–L |
| T6 | Lane virtualization (removes vertical overflow entirely) | Also closes T2 option (c); tracked as ROADMAP V4 | L |

**Sequencing:** T1 + T2 are the fast, high-impact pair — do them first; together
they cover the two things a newcomer trips on in the first minute. T3 is the
"trust" fix. T4–T6 are structural and can follow.

## Fixed this cycle

- **Escape overload → explicit precedence.** The four scattered global keydown
  listeners (each re-implementing the "am I typing?" guard, three handling
  Escape) are consolidated behind one pure, unit-tested resolver
  (`lib/timelineKeys.ts`, `test/timeline-keys.test.ts`, 13 tests). Escape now
  resolves to exactly one action by precedence — modal, then focus mode, then
  detail panel — and a second press peels the next layer. This is T5's first
  extracted seam and the template for the rest.

## Method note

The fixes above follow the same TDD discipline as
`DEV-REQUIREMENTS-capture-onboarding.md`: pull the decision into a pure function,
test it before it exists, then let the component render/dispatch it. For the
timeline specifically, the reusable seams to extract next are **cluster
bucketing** (the 14px same-lane merge) and **lane-visibility resolution**
(`populated` / `visible` / `hidden` / solo) — both are pure, both currently live
inline in the 3,875-line component, and both are where interaction regressions
hide.
