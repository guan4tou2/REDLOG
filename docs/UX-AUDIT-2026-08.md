# UX & Complexity Audit — 2026-08-10

Written against v0.11.5 by a full-tree read of `src/renderer/`, cross-checked
against `PRODUCT-POSITIONING.md` (personas) and external research on how
pentesters actually adopt tools. Companion to the correctness-focused
`AUDIT-2026-08-08.md` — that one asks "is it right?", this one asks "does the
primary persona (P1, the solo operator) succeed, and is the surface bigger than
the job?"

Every finding cites a file and line so it can be verified, not taken on faith.
Severity is about **the primary persona's success**, not code health.

## TL;DR

RedLog is functionally deep and, for an experienced operator, dense in a good
way. The two systemic risks both trace to the same root: **the product was
built outward from capabilities, and the first-run path was never built inward
from the persona.**

1. **The zero-friction promise inverts on first run.** RedLog markets passive
   capture but records nothing until a source is wired, and the dark-state
   guidance was one sentence + a link into a 2,600-line Settings page. *(F1 —
   partly addressed this cycle; see Fixed.)*
2. **Breadth has outrun the solo persona in three surfaces** — Timeline (3,875
   lines, 18 lanes), Settings (2,681 lines, 8 tabs, no search), and shortcut/
   empty-state discoverability. *(F2–F6.)*

Nothing here is a correctness bug. Everything here is "the operator who would
benefit most bounces off before they get value."

## What's genuinely good (keep it)

Calibration matters — this is not a teardown.

- **Capture Health as an exception report, not an inventory** (`App.tsx`
  L268–279). Showing only what's wrong by default is exactly right.
- **Empty lanes auto-collapse** (`Timeline.tsx` L1095, L1105) — the 18-lane
  model only ever shows what an engagement touched.
- **Dot-shape encoding for severity/output-state** (`Timeline.tsx` L487) —
  honestly acknowledges that 18 colours exceed reliable discrimination and adds
  a redundant channel instead of pretending otherwise.
- **Housekeeping filter** — RedLog's own lifecycle events stay in the DB for the
  record but off the timeline. Correct instinct: keep everything, show what
  matters.

The instincts are right. The gap is that they were applied *within* views by an
expert, and never applied *to the first-run arc* for a newcomer.

## Findings

### F1 — First-run capture guidance was a dead end *(High — partly fixed this cycle)*

**Was:** a `dark` verdict rendered `capture.darkHint` ("…Install the shell hook
and start mitmproxy.") plus one link to Settings (`App.tsx`, prior L380–388).
Settings is 2,681 lines across 8 tabs (`Settings.tsx`). A first-run P1 got a
sentence and a haystack, with no order and no single next action — the exact
"frictionware" pattern that kills security-tool adoption.

**Now:** the card renders an ordered 3-step checklist (shell hook → agent
capture → RedLog terminal) with a single primary CTA derived from a pure,
unit-tested model (`lib/captureReadiness.ts`, `App.tsx` `CaptureOnboarding`).
See `DEV-REQUIREMENTS-capture-onboarding.md`.

**Still open:** the checklist tells the operator *what* is next but the shell-
hook install still hands off to Settings for the how; a genuinely guided
"install now, verify it fired" loop is the follow-up. Tracked as F1-b.

### F2 — Timeline.tsx is a 3,875-line single-responsibility violation *(High — maintainability / test risk)*

One file owns zoom, pan, minimap, clustering, the ⌘K palette, focus-chain,
redaction reveal, saved views, cast replay, session dividers, timezone, and
anomaly filtering: **49 `useState`, 45 `useEffect`, 19 `useMemo`, 33 `localStorage`
sites** (`Timeline.tsx`). It is 34% of all renderer code by itself.

Impact on the persona is indirect but real: this is where regressions hide
(v0.2.0 shipped a Timeline that crashed on open — `renderer-smoke.test.tsx`
L2–8 exists because of it), and it has **zero interaction tests** — the smoke
test only asserts it mounts. Every zoom/cluster/minimap behaviour is unverified.

**Recommendation:** don't rewrite. Extract *testable seams* first (the codebase
already values this — see `capture-health.ts`). Candidates, each a pure function
liftable out of the component with a unit test attached: cluster bucketing
(L1404–1411), the time-domain/minimap binning (already flagged in
`AUDIT`/`ROADMAP` as geometry-only), lane visibility resolution
(`populatedLanes`/`visibleLanes`), and the ⌘K palette filter. Extracting even
two of these both shrinks the file and buys the first interaction tests.

### F3 — Settings has no search and a flat 34-group surface *(Medium)*

8 tabs, 34 `FieldGroup`s, 16 embedded panels, 234 i18n keys (`Settings.tsx`).
The maintainer already did one consolidation pass (L110–118). The next lever is
**find, not reorganize**: a single filter box that matches group titles/labels
turns "which tab was the exclusion list under?" from a hunt into a keystroke.
Cheap relative to another re-tab.

### F4 — The `EmptyState` CTA component is dead code; all 8 empty states are dead ends *(Medium — highest value-to-effort)*

`Feedback.tsx` L20–41 defines an `EmptyState` with `icon/title/subtitle/action`
— a CTA-carrying empty state — and it has **zero usages** in the codebase. Every
actual empty state is hand-rolled and **actionless**: Timeline (L2019–2030),
Screenshots (`App.tsx` L856), Targets (`TargetView.tsx` L163), Loot
(`LootPanel.tsx` L146), Marks (`FindingsView.tsx` L170), Transcript
(`TranscriptView.tsx` L326). A P1 landing on any of these sees "nothing here"
and no way forward.

This is the single best effort-to-impact fix in the audit: the component exists,
the design intent is written into `Feedback.tsx`'s header comment, and wiring
each empty view to it with a relevant action (Loot → "set up capture", Marks →
"⌘⇧M to mark", Screenshots → "capture now") closes six dead ends. **Recommend
doing this next, TDD, same pattern as F1.**

### F5 — Shortcut discoverability is split and inconsistent *(Low–Medium)*

Two shortcut references exist and disagree: the Dashboard shortcuts card
(`App.tsx` L734–755) and the Timeline `?` cheatsheet (`Timeline.tsx` L2138+, 14
shortcuts). Timeline's 14 shortcuts never appear on the Dashboard card. A P1 who
reads the Dashboard believes they've seen the shortcuts. **Recommend** one
shared shortcut registry both surfaces render from — and it removes a
double-maintenance burden.

### F6 — `search` is a first-class view with no way to discover it *(Low)*

The `search` view (`App.tsx` L233) has no Sidebar entry (`sidebarOrder.ts`
`DEFAULT_ORDER`); it's reachable only by ⌘/ or ⌘K. Full-text search is a
headline feature (README) that a newcomer cannot find by looking. **Recommend**
either a Sidebar entry or a visible search affordance in the header.

### F7 — Sidebar drag-to-reorder has no visual affordance *(Low)*

Reordering is discoverable only via the first item's tooltip
(`Sidebar.tsx` L137, `sidebar.reorderHint`). Fine as a power-user Easter egg;
just don't count it as a discoverable feature.

## Is anything over-built for the persona?

Assessed against P1 (solo). None of these should be *removed* — but each should
be **demoted in the first-run path** so the newcomer isn't paying for them up
front:

| Surface | Verdict | Reasoning |
|---|---|---|
| 18 timeline lanes | **Keep, already mitigated** | Auto-collapse means P1 only sees touched lanes. The complexity is opt-in by data. |
| Plugin trust tiers (🟢/🔴) | **Keep, defer** | Correct and well-designed, but zero P1s need it on day one. It belongs behind "you'll know when you need this," not in the onboarding surface. |
| Cloud share worker + BYO-bucket | **Keep, defer** | Genuinely optional; already gated behind Advanced. Good. |
| Deconfliction / operators / MCP tabs | **Keep, P2/P3 only** | These are P2/P3 surfaces sitting in P1's Settings with equal weight. Consider a "role" or "show advanced" gate so P1's Settings is smaller by default. |
| 4 integration layers (hooks/MCP/REST/shell fns) | **Keep, sequence it** | The README already says "start with hooks." The app doesn't enforce that sequence — the onboarding checklist (F1) is the mechanism to. |

**Net:** RedLog is not over-*featured* — every feature has a persona. It is
under-*sequenced*: P2/P3/expert surfaces are presented to P1 at full weight from
the first screen. The fix is progressive disclosure, not deletion.

## Prioritized backlog

| # | Finding | Severity | Effort | Recommendation |
|---|---|---|---|---|
| F1-b | Guided hook install + verify loop | High | M | Extend the Capture Readiness checklist into a do-it-here flow |
| F4 | Wire the dead `EmptyState` into 6 views | Medium | **S** | **Do next** — best effort:impact, TDD |
| F2 | Extract 2 pure seams out of Timeline + first interaction tests | High | M–L | Seams first, no rewrite |
| F3 | Settings filter box | Medium | S–M | Find, don't re-tab |
| F5 | Unified shortcut registry | Low–Med | S | One source, two renderers |
| F6 | Discoverable search entry | Low | S | Sidebar entry or header affordance |
| F7 | Reorder affordance | Low | S | Optional |

## Fixed in this cycle

- **F1 (partial)** — `computeCaptureReadiness` (`lib/captureReadiness.ts`, 8
  unit tests) + the `CaptureOnboarding` block (`App.tsx`, 4 render tests). Turns
  the dark-state dead end into an ordered checklist with one clear next action.
  Full write-up: `DEV-REQUIREMENTS-capture-onboarding.md`.

## Sources (adoption research)

- [Cybersecurity (Anti)Patterns: Frictionware — Spaceraccoon](https://spaceraccoon.dev/cybersecurity-antipatterns-frictionware/) — why setup friction kills security-tool adoption
- [Top 10 SAST Tools 2026 — OX Security](https://www.ox.security/blog/static-application-security-sast-tools/) — "noisy out of the box" / minimal-config adoption
- [How I document web pentest engagements — Medium](https://medium.com/@rastislongesec/how-i-document-web-penetration-testing-engagements-62914d797228) — real note-taking workflow + cloud-sync compliance pain
- [Workflow Improvements for Pentesters — TrustedSec](https://trustedsec.com/blog/workflow-improvements-for-pentesters)
