# Dev Requirements & Process — Capture Readiness Onboarding

Written 2026-08-10. This doc does two jobs: it specifies the **Capture
Readiness** feature (requirements, acceptance, done-definition), and it uses
that feature as the **worked example of the TDD process** every UX change in
`UX-AUDIT-2026-08.md` should follow. If you're picking up F4 (empty states) or
F5 (shortcuts) next, copy this shape.

## 1. The requirement

**Problem** (from `UX-AUDIT-2026-08.md` F1 and `PRODUCT-POSITIONING.md` risk 1):
RedLog promises passive, zero-friction capture, but records nothing until a
source is wired. A first-run operator sees an empty timeline; the dark-state
Dashboard card gave one sentence and a link into a 2,681-line Settings page —
no order, no single next action.

**Goal:** turn "the timeline is dark, now what?" into an ordered checklist with
exactly one obvious next step, driving the operator from dark → recording along
the canonical path the README already prescribes (shell hook → agent → built-in
terminal).

**Non-goals** (deliberately out of scope for this slice):
- Installing the hook from inside the card without visiting Settings. *(F1-b.)*
- Any new capture source or backend change. This is presentation only — it reads
  the `CaptureHealth` the Dashboard already fetches over the bridge.
- Onboarding for enrichment sources (mitmproxy, clipboard, screenshots). The
  checklist is intentionally the three *core* sources only.

## 2. Design constraints (from the codebase, not invented)

1. **Renderer talks to main only through `window.redlog`.** The onboarding
   model is a *presentation* concern, so it lives in the renderer
   (`src/renderer/src/lib/`), not `src/core`. Reaching into `src/core` from the
   renderer crosses the `tsconfig.web.json` boundary (`include:
   src/renderer/src/**`) and was rejected during implementation for that reason.
2. **Pure and testable.** The decision logic must be a pure function of
   `CaptureHealth`, with no DB, no React, no `window`. This is the house style —
   see `capture-health.ts`, whose verdict logic is pure and unit-tested.
3. **One source of truth.** The checklist order, the step statuses, and the
   "what's next" choice all come from one function so the card, a future
   empty-state CTA, and a future first-run tour can't drift.
4. **Never the thing that crashes the card.** If the health payload drifts
   (a core source missing), readiness degrades gracefully, it does not throw.

## 3. The model

`computeCaptureReadiness(health) → CaptureReadiness` (`lib/captureReadiness.ts`).

- **Core sources, in canonical order:** `shell-hook`, `agent-tailer`,
  `builtin-terminal`. Enrichment sources are deliberately excluded.
- **Per-step status:**
  - `active` — produced an event within the active window; it is recording.
  - `wired` — set up (hook installed, switch on, or has ever fed) but quiet.
  - `todo` — nothing done, *or explicitly switched off* (an off source is the
    thing to nudge back on, so it ranks `todo`, not `wired`).
- **Level:** `recording` if any core source is `active`; `dark` if all core
  steps are `todo`; else `setup`.
- **`nextStep`:** null when recording; otherwise the first `todo` core step
  (highest impact, lowest effort, keeps the operator on the canonical order);
  if all core steps are set up but none active, the first `wired` step, whose UI
  copy becomes "run a command."

## 4. Acceptance criteria

Each maps to a test in `test/capture-readiness.test.ts` (model) or
`test/capture-onboarding-render.test.tsx` (render).

| # | Given | Then | Test |
|---|---|---|---|
| A1 | Nothing wired | level `dark`, all core steps `todo`, `nextStep = shell-hook` | model |
| A2 | Sources given out of order | steps still in canonical order | model |
| A3 | Shell hook installed but silent | shell-hook `wired`, `nextStep = agent-tailer` | model |
| A4 | Tailer enabled, no event yet | tailer `wired` | model |
| A5 | A core source active | level `recording`, `nextStep = null` | model |
| A6 | All wired, none active | `nextStep` = first wired, status `wired` ("run a command") | model |
| A7 | A core source switched off | status `todo`, not `wired` | model |
| A8 | Health missing a core source | no throw; degrades to `todo` | model |
| A9 | Dark card renders | ordered 3-step checklist appears | render |
| A10 | Dark card renders | primary CTA is "Install shell hook" | render |
| A11 | Hook installed | CTA advances to "Turn on agent capture" | render |
| A12 | A core source recording | onboarding block is hidden entirely | render |

**Definition of done:**
- [x] All 12 acceptance tests green (`capture-readiness` 8 + `capture-onboarding-render` 4).
- [x] `renderer-smoke.test.tsx` still green (no regression to the healthy path).
- [x] `npm run build` succeeds (renderer + main + preload).
- [x] i18n: every new key present in **both** `en.json` and `zh-TW.json` (the
      suite convention is exact parity — verified 832 keys each, zero mismatch,
      after adding 10 `capture.*` keys).
- [x] No new type errors attributable to the change (verified: the 247 errors
      from a bare `tsc -p tsconfig.web.json` are the pre-existing ambient-global
      artifact — none match the new identifiers).

## 5. The TDD process (the part to reuse)

This feature was built **red → green → integrate → cover**, and every UX-audit
item should be too. The point of writing it down: the discipline is what let a
pure-logic change land in a 3,875-line-neighbour codebase without fear.

### Step 1 — RED: write the model test first

`test/capture-readiness.test.ts` was written before `captureReadiness.ts`
existed. Run it, watch it fail for the *right* reason:

```
Error: Cannot find module '../src/renderer/src/lib/captureReadiness'
```

Not "assertion failed on a stub" — "the thing doesn't exist yet." That confirms
the test is wired to the real target.

### Step 2 — GREEN: minimal implementation

Write only enough of `computeCaptureReadiness` to pass all 8. No UI, no extra
fields "for later." The function is pure, so this is fast and the feedback loop
is sub-second (`npx vitest run test/capture-readiness.test.ts`).

### Step 3 — INTEGRATE (refactor): wire it into the card

Only now touch `App.tsx`. The pure model is fixed and proven, so the React work
is just rendering it: a `CaptureOnboarding` component that maps `readiness.steps`
to a checklist and `readiness.nextStep` to one CTA, reusing the card's existing
`setInstalled` / `setEnabled` / `onNavigate` actions. During this step the
renderer→core boundary problem surfaced; the fix (move the pure module into the
renderer) is a design constraint now recorded above, not a patch.

### Step 4 — COVER the UI path

The smoke test's bridge is healthy, so it never renders the onboarding block.
Add `test/capture-onboarding-render.test.tsx`: render `CaptureHealthCard` with a
dark prop, assert the checklist and CTA. This required exporting
`CaptureHealthCard` — an acceptable, minimal test seam.

### Step 5 — no regressions

`npx vitest run` (note: needs `npm run rebuild` for the Node ABI, or the
DB-backed suites fail with `NODE_MODULE_VERSION` — that failure is the
environment, not the change) + `npm run build`.

### Rules of the loop

- **One pure function per behavioural change, tested before it exists.** If a
  change can't be expressed as a pure function, find the seam that can.
- **The component renders the model; it does not re-decide it.** No status logic
  in JSX. If the card needs a new rule, it goes in the model with a new test.
- **i18n parity is part of green.** A key in one locale and not the other is a
  failing state even if no test catches it — add to both in the same edit.
- **Don't verify by re-reading; verify by running.** `vitest run` + `build` are
  the gates.

## 6. Next tickets, same shape

- **F4 — empty states:** `computeEmptyStateAction(view, counts)` pure model →
  wire the already-existing `EmptyState` component (`Feedback.tsx`) into the 6
  actionless views. Best effort:impact in the audit.
- **F5 — shortcuts:** one `SHORTCUTS` registry → Dashboard card and Timeline
  `?` cheatsheet both render it. Test: registry completeness + both surfaces
  render every entry.
- **F2 — Timeline seams:** extract cluster bucketing and lane-visibility as pure
  functions with unit tests before any structural change.
