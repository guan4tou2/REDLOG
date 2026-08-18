# UX Backlog — Ticket Specs

> **Updated 2026-08-11 by the necessity model (`DESIGN-PRINCIPLES.md`).** Three
> tickets change scope: **F3** (Settings) is now the *structural* reorg by
> necessity tier / front door, not just a search box. **F1** onboarding is
> *value-first with evidence stated as the core* + a **HUD-only** path (new: a
> first-class HUD-only runtime mode). The **T-series** is re-read through the
> timeline reframe (job = review; axis = target/phase; map vs. I/O reader — see
> `UX-TIMELINE-2026-08.md`'s banner). And a new decision: the plugin
> **marketplace is shelved** (product, not platform), so any marketplace polish
> is out of scope. Acceptance criteria below stand.

> **Extended 2026-08-13 against v0.11.7.** The [`UX-AUDIT-2026-08-13.md`](UX-AUDIT-2026-08-13.md)
> resize/discoverability pass and [`DESIGN-TIMELINE-DISCOVERABILITY.md`](DESIGN-TIMELINE-DISCOVERABILITY.md)
> surfaced work that was written up as prose in that audit's §6 backlog but never
> broken into independently-implementable tickets. This revision closes that gap:
> new **T7/T8** (timeline wheel + axis discoverability), a new **S-series**
> (Settings correctness, audit §2.5) and a new **C-series** (cross-view pains,
> audit §3). It also reconciles the priority table below against what has since
> shipped — several F/T seams now exist and are wired, so their status moved off
> ⚪ (verified by import + test presence, 2026-08-13).

Written 2026-08-10 against v0.11.6. Each finding from `UX-AUDIT-2026-08.md`
(F-series, whole renderer) and `UX-TIMELINE-2026-08.md` (T-series, timeline) is
broken out here into an **independently implementable ticket**: enough spec,
acceptance criteria and a named test seam that any one of them can be picked up
in isolation — including by a parallel session — without reading the other
tickets first.

House rules (from `DEV-REQUIREMENTS-capture-onboarding.md`):

- **Pull the decision into a pure function, test it before it exists, then let
  the component render/dispatch it.** Every ticket names the seam.
- **The renderer talks to main only through `window.redlog`.** Presentation
  models live under `src/renderer/src/lib/`, never in `src/core`.
- **i18n parity is part of "done":** every new key in both `en.json` and
  `zh-TW.json`, same edit.
- **Verify by running,** not by re-reading: `vitest run` + `npm run build`.

Status legend: 🟢 done · 🟡 in progress / partial · ⚪ not started.
Effort: S (<½ day) · M (½–2 days) · L (>2 days).

---

## Priority order (recommended)

The fast, high-impact pairs first, structural work after.

| Rank | Ticket | Why now | Effort | Status |
|---|---|---|---|---|
| 1 | **F4** — wire the dead `EmptyState` into 6 views | Best effort:impact in the whole backlog; component already exists | S | 🟡 |
| 2 | **T1** — persistent interaction legend | Covers the 80% "invisible affordance" case in one strip | S | ⚪ |
| 3 | **T2** — resolve the wheel-mode ambiguity | The single most disorienting timeline behaviour | S–M | ⚪ |
| 4 | **F1-b** — guided hook install + verify | Finishes the onboarding arc F1 opened | M | ⚪ |
| 5 | **T3** — active-modes row | Answers "why is my timeline empty" on-screen | M | ⚪ |
| 6 | **F3** — Settings filter box | Find, don't re-tab a 34-group page | S–M | 🟡 |
| 7 | **F5** — unified shortcut registry | Kills the split/inconsistent shortcut docs | S | 🟡 |
| 8 | **F6** — discoverable search entry | Headline feature currently unfindable | S | ⚪ |
| 9 | **T4** — header "View options" overflow menu | Header stops competing with itself | M | ⚪ |
| 10 | **T5** — extract timeline pure seams + first interaction tests | Makes every later timeline change safe | M–L | 🟡 |
| 11 | **F7** — sidebar reorder affordance | Minor discoverability polish | S | ⚪ |
| 12 | **T6** — lane virtualization | Structural; also closes T2 permanently (= ROADMAP V4) | L | ⚪ |
| 13 | **PL1** — plugin lifecycle: one card, Install≠Enable | Removes the two-tab split + the orphaned-hook footgun | M–L | ⚪ |

Already shipped in v0.11.6: **F1 (partial)** — Capture Readiness onboarding
checklist; **T5 first seam** — the Timeline keyboard resolver.

**Reconciled 2026-08-13 (🟡, seam + test present, verify acceptance before closing):**
**F3** — `lib/settingsSearch.ts` + `test/settings-search.test.ts` exist and are
wired into `Settings.tsx`; the remaining gap is search *coverage*, now its own
ticket **S3**. **F4** — `lib/emptyState.ts` + `test/empty-state.test.ts` exist and
`EmptyState` is wired into Loot / Transcript / Findings; still missing from
Timeline / Screenshots / Marks / Targets, so F4 stays partial. **F5** —
`lib/shortcuts.ts` + `test/shortcuts.test.ts` exist but the registry renders only
in Timeline (`?`), not yet on the Dashboard card, so the two surfaces still
disagree. **T5** — more seams extracted since first-seam: `lib/timelineCluster.ts`,
`lib/laneVisibility.ts`, `lib/timelineAxis.ts`, `lib/timelineModes.ts` now exist.

### Priority order — 2026-08-13 additions

New tickets from the resize/discoverability pass. Ranked within themselves; slot
into the master list by effort:impact as capacity allows.

| Rank | Ticket | Why now | Effort | Status |
|---|---|---|---|---|
| a | **S1** — one save signal + visible save failures | Contradictory save UI + silently-swallowed errors is a correctness bug, not polish | S | ⚪ |
| b | **C2** — hide dead jump-to-Timeline buttons | Disabled placeholders read as broken; cheapest correctness win | S | ⚪ |
| c | **C3** — filtered-empty + scope empty CTA | "Filtered to 0" looks like data loss; ScopeStatus empty state is a dead end | S–M | ⚪ |
| d | **S3** — fill Settings search coverage | Makes F3's box actually find proxy/port/token/regex | S–M | ⚪ |
| e | **T7** — persistent wheel-mode indicator (W1–W3) | Turns T2's post-scroll flash into a before-scroll, always-true cue | S–M | ⚪ |
| f | **C6** — modal focus trap | a11y correctness; Tab currently escapes dialogs | S–M | ⚪ |
| g | **C1r** — click-to-copy IP / mark URLs | Finishes C1 (Loot/Transcript copy already shipped) | S | ⚪ |
| h | **S2** — confirm + diff for destructive Settings actions | token rotate/revoke + whole-config profile import have no guard | M | ⚪ |
| i | **T8** — axis segmented control + preserved filtering (A1–A3) | Stops the silent lane-chip blanking on axis switch | M | ⚪ |
| j | **C4** — consistent filter-entry thresholds | Sparse-data surfaces hide filters you expect to exist | S | ⚪ |
| k | **C5** — custom tooltip / persistent gesture legend | Retires native `title` for key gestures (touch/keyboard reachable) | M | ⚪ |
| l | **C7** — unify UI-state persistence | Consistency, not a blocker — Settings/Overlay/ Timeline persist differently | M | ⚪ |

---

## F-series — whole-renderer findings

### F1 — First-run capture onboarding 🟡 (checklist shipped v0.11.6)

- **Persona:** P1 / P3. **Source:** UX-AUDIT F1; DEV-REQUIREMENTS-capture-onboarding.
- **Problem:** RedLog records nothing until a source is wired; the dark-state
  card used to give one sentence + a link into a 2,681-line Settings page.
- **Shipped:** `lib/captureReadiness.ts` (pure, 8 tests) + `CaptureOnboarding`
  ordered checklist + single CTA (4 render tests).
- **Remaining → F1-b.**

### F1-b — Guided hook install + verify loop ⚪

- **Problem:** the onboarding CTA "Install shell hook" still hands off to
  Settings for the actual install and gives no confirmation the hook fired.
- **Proposed:** the CTA installs in place (`window.redlog.hooks.install`),
  then the checklist step flips `todo → wired → active` live as the first event
  lands, with a "waiting for first command…" affordance in between.
- **Acceptance:**
  - Clicking the CTA installs the hook without leaving the Dashboard.
  - The step advances to `wired` on install and `active` on first event, with no
    manual refresh.
  - A visible "verifying…" state exists between install and first event.
- **Seam:** the state transitions are already modelled by
  `computeCaptureReadiness`; this ticket is wiring + one new `wired`-with-pending
  render state. Extend `capture-onboarding-render.test.tsx`.
- **Effort:** M. **Depends on:** F1.

### F4 — Wire the `EmptyState` CTA into every empty view ⚪ *(do first)*

- **Persona:** P1. **Source:** UX-AUDIT F4.
- **Problem:** `Feedback.tsx` (L20–41) defines an `EmptyState` with an `action`
  CTA and it has **zero usages**. All 8 empty states are hand-rolled dead ends
  with no next step: Timeline, Screenshots, Targets, Loot, Marks, Transcript.
- **Proposed:** a small pure `emptyStateFor(view, counts, captureLevel)` that
  returns `{ icon, titleKey, subtitleKey, action }`, then replace each hand-
  rolled empty block with `<EmptyState {...} />`. Actions: Loot → "set up
  capture" (nav to Dashboard onboarding); Marks → "⌘⇧M to mark"; Screenshots →
  "capture now"; Targets/Transcript → "learn what lands here" doc link.
- **Acceptance:**
  - Every one of the 6 named empty views renders `EmptyState` with a relevant,
    working action.
  - No hand-rolled empty markup remains in those views.
  - `emptyStateFor` has unit tests for each view + the capture-dark variant.
- **Seam:** `lib/emptyState.ts` (pure map). Test `test/empty-state.test.ts`.
- **Effort:** S.

### F3 — Settings filter box ⚪

- **Persona:** P1. **Source:** UX-AUDIT F3.
- **Problem:** Settings is 8 tabs / 34 `FieldGroup`s / 234 i18n keys with no
  way to find a setting except remembering its tab.
- **Proposed:** a single filter input in the Settings header that matches
  against group titles + field labels and (a) filters visible groups within the
  active tab and (b) surfaces cross-tab hits with their tab name.
- **Acceptance:**
  - Typing "exclude" surfaces the scope exclusion list regardless of active tab.
  - Empty query restores the normal tabbed view.
  - Match is case-insensitive over title + label text.
- **Seam:** `lib/settingsSearch.ts` — pure `matchGroups(query, index)` over a
  static `{ tab, groupId, titleKey, labelKeys[] }` index. Test the matcher; the
  input is thin.
- **Effort:** S–M.

### F5 — One shortcut registry, two renderers ⚪

- **Persona:** P1. **Source:** UX-AUDIT F5.
- **Problem:** the Dashboard shortcuts card and the Timeline `?` cheatsheet are
  maintained separately and disagree — Timeline's 14 shortcuts never appear on
  the Dashboard card.
- **Proposed:** one `SHORTCUTS` registry (`lib/shortcuts.ts`): `{ id, keys,
  labelKey, scope: 'global' | 'timeline' }`. Both surfaces render from it,
  filtered by scope. `modKey` platform token resolved once.
- **Acceptance:**
  - Adding a shortcut to the registry makes it appear in both surfaces.
  - Dashboard shows global scope; Timeline `?` shows global + timeline.
  - A test asserts every registry entry renders in the appropriate surface.
- **Seam:** the registry is the data; test `shortcutsForScope(scope)`.
- **Effort:** S.

### F6 — Discoverable search entry ⚪

- **Persona:** P1. **Source:** UX-AUDIT F6.
- **Problem:** the `search` view (a headline feature) has no Sidebar entry; it's
  reachable only via `⌘/` or `⌘K`, so a newcomer cannot find it by looking.
- **Proposed:** add `search` to the Sidebar (or a persistent header search
  affordance that opens it). Keep the shortcut.
- **Acceptance:** search is reachable by pointer with no prior knowledge; the
  shortcut still works; sidebar order persistence is unaffected.
- **Seam:** `sidebarOrder.ts` `DEFAULT_ORDER` + a Sidebar entry. Extend the
  Sidebar smoke render assertion.
- **Effort:** S.

### F7 — Sidebar reorder affordance ⚪

- **Persona:** P1 power user. **Source:** UX-AUDIT F7.
- **Problem:** drag-to-reorder is discoverable only via one item's tooltip.
- **Proposed:** a low-weight drag handle (or `⠿` on hover) on sidebar items.
- **Acceptance:** the reorder affordance is visible on hover without a tooltip;
  drag threshold behaviour unchanged.
- **Effort:** S. **Note:** lowest priority — an Easter egg, not a blocker.

---

## T-series — timeline interaction

### T1 — Persistent interaction legend ⚪ *(high impact)*

- **Persona:** P1 newcomer. **Source:** UX-TIMELINE §2.
- **Problem:** the whole gesture vocabulary is invisible until `?` is pressed,
  and `?` itself is a 20px glyph in a crowded header.
- **Proposed:** a persistent, low-weight strip (footer or under the header):
  `drag to pan · ⌘-scroll to zoom · / filter · ? all keys`. Three core gestures
  always visible; the `?` modal keeps the long tail.
- **Acceptance:**
  - The three core gestures are visible without any interaction.
  - The strip is dismissible/collapsible and its state persists per project.
  - The `?` modal remains the complete reference.
- **Seam:** static content; the only logic is the platform `modKey` token (share
  with F5's registry). Assert the strip renders the core gestures.
- **Effort:** S.

### T2 — Resolve the wheel-mode ambiguity ⚪ *(most disorienting)*

- **Persona:** P1. **Source:** UX-TIMELINE §1.
- **Problem:** plain wheel pans horizontally — *unless* the lane stack overflows
  vertically, when plain wheel becomes vertical scroll and `shift+wheel` is
  required to pan. Same gesture, different result, no on-screen cue.
- **Proposed (pick one, in preference order):**
  1. A transient hint that appears **only while the stack overflows**:
     "⇅ scrolling lanes · ⇧-scroll to pan".
  2. A dedicated vertical scrollbar on the lane stack so plain wheel can always
     mean horizontal pan.
  3. Virtualize lanes so the stack never overflows (→ T6, the permanent fix).
- **Acceptance:**
  - When the lane stack overflows, the active wheel behaviour is communicated
    on-screen (option 1) or eliminated (options 2/3).
  - No regression to cursor-anchored `⌘-scroll` zoom.
- **Seam:** the overflow predicate (`scrollHeight > clientHeight + 1`) is already
  computed in the wheel handler; lift it to a small pure `wheelMode(overflow,
  shiftKey, ctrlOrMeta)` returning `'zoom' | 'pan-x' | 'scroll-y'` and test the
  matrix. The hint renders off the same predicate.
- **Effort:** S–M.

### T3 — Active-modes row ⚪

- **Persona:** P1. **Source:** UX-TIMELINE §3.
- **Problem:** sticky toggles (focus-chain, follow, anomaly-filter, collapse-
  agent, lane-solo) change what's shown; some show a badge, some are silent. An
  operator who left one on later sees a near-empty track and assumes data loss.
- **Proposed:** one consistent "active filters/modes" row that shows a
  dismissible chip for every **non-default** mode currently on, so an empty
  track always has an on-screen explanation. Mirrors the Capture Health
  exception-report instinct.
- **Acceptance:**
  - Every non-default active mode shows exactly one chip; default state shows no
    row.
  - Each chip clears its own mode.
  - With all modes default, the row is absent (no empty bar).
- **Seam:** `lib/timelineModes.ts` — pure `activeModes(state) → ModeChip[]` over
  the toggle state. Test the mapping for each mode and the all-default case.
- **Effort:** M.

### T4 — Header "View options" overflow menu ⚪

- **Persona:** P1. **Source:** UX-TIMELINE §"secondary".
- **Problem:** the header packs title, count, load-more, `?`, zoom −/reset/+,
  collapse-agent, `/` filter, then lane chips + tz/follow/anomaly/saved-views —
  primary and rare controls at equal weight.
- **Proposed:** keep zoom + `/` filter primary; fold tz, anomaly, follow,
  saved-views into a single "⋯ View options" menu. Progressive disclosure, no
  removal.
- **Acceptance:**
  - Zoom and filter remain one-click.
  - The four secondary controls live behind one menu; their behaviour is
    unchanged.
  - Keyboard access to the menu contents is preserved.
- **Seam:** mostly layout; no new pure logic. Cover with a render test that the
  menu exposes each control.
- **Effort:** M.

### T5 — Extract timeline pure seams + first interaction tests 🟡

- **Persona:** maintainer. **Source:** UX-TIMELINE §"secondary"; UX-AUDIT F2.
- **Problem:** one 3,875-line component, 49 `useState` / 45 `useEffect`, **zero
  interaction tests** — nothing stops a new interaction breaking an old one.
- **Shipped (v0.11.6):** the keyboard resolver — `lib/timelineKeys.ts` +
  `test/timeline-keys.test.ts` (13 tests), consolidating four keydown listeners.
- **Remaining seams to extract (each pure, each currently inline):**
  - **Cluster bucketing** — the 14px same-lane merge → `lib/timelineCluster.ts`.
  - **Lane visibility** — populated / visible / hidden / solo resolution →
    `lib/laneVisibility.ts` (pairs with T3).
  - **Time-domain / minimap binning** — already flagged as geometry-only in
    AUDIT/ROADMAP.
- **Acceptance:** each extracted seam has a unit test; the component imports and
  renders it; no behaviour change (smoke + build green).
- **Effort:** M–L (incremental — one seam per PR).

### T6 — Lane virtualization ⚪ (= ROADMAP V4)

- **Persona:** P1 on large engagements. **Source:** ROADMAP v0.12.0 V4;
  UX-TIMELINE T2 option (c).
- **Problem:** the lane stack can overflow its container (the root cause behind
  T2's wheel ambiguity) and long tracks render every node.
- **Proposed:** viewport virtualization of lanes/nodes so the stack fits and only
  visible nodes render. Permanently removes the vertical-overflow branch → closes
  T2 by construction.
- **Acceptance:** the lane stack never vertically overflows; scroll performance
  holds on a 100k-event engagement; T2's wheel branch is deleted.
- **Effort:** L. **Note:** the one genuinely structural item; sequence last.

### T7 — Persistent wheel-mode indicator ⚪ *(supersedes T2's flash)*

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §2.4;
  `DESIGN-TIMELINE-DISCOVERABILITY.md` 第一部 (W1–W3).
- **Problem:** plain-wheel behaviour depends on the invisible lane-overflow state
  (pan-x when the stack fits, scroll-y when it overflows, `⇧` to escape). The only
  cue is a ~2.5s flash *after* the (often wrong) scroll, and T1's static legend
  hard-codes "⌘-scroll to zoom" — it never mentions scroll-y or the `⇧` escape, so
  the legend actively contradicts the live behaviour.
- **Proposed:** an always-on, low-weight indicator at the track's top-right that
  reflects the current-context plain-wheel result **before** the scroll (W1), and
  live-previews the modifier results while `⇧`/`⌘` is held (W2). All three
  surfaces — T1 legend, the indicator, the preview — read one new pure
  `wheelModeLabel(ctx)` (W3) so they can never drift.
- **Acceptance:**
  - Before any scroll, the plain-wheel result is shown on-screen and updates as
    overflow changes (window height / lane count / detail panel).
  - Holding `⇧` or `⌘`/`Ctrl` live-previews that modifier's result; releasing
    restores. Under `prefers-reduced-motion` the swap is instant, no transition.
  - Legend + indicator + preview text are all produced by `wheelModeLabel`; no
    hard-coded gesture string remains. No regression to cursor-anchored `⌘-scroll`
    zoom.
- **Seam:** `lib/timelineWheel.ts` — add `wheelModeLabel(ctx): WheelModeView`
  (`{ mode, labelKey, escapeHintKey? }`) derived from the existing `wheelMode(ctx)`;
  extend `test/timeline-wheel.test.ts` over the same 4-row matrix asserting each
  row's `labelKey`/`escapeHintKey`. UI reads live `overflow`.
- **Effort:** S–M. **Relates:** replaces T2's flash with a persistent cue; **T6**
  later deletes the overflow branch, at which point the indicator degrades to
  "`⇔ pan · ⌘ zoom`".

### T8 — Axis segmented control + preserved filtering ⚪

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §2.4;
  `DESIGN-TIMELINE-DISCOVERABILITY.md` 第二部 (A1–A3).
- **Problem:** the source↔target lane axis is a cryptic `⊞` toggle. Switching to
  the target axis **silently blanks the entire lane-chip row** (the
  `laneAxis === 'source' &&` gate at `Timeline.tsx:2925`) and **orphans
  `hiddenLanes`** — the "Show all" restore button survives but the per-lane chips
  that could bring a hidden lane back are gone.
- **Partly done since the audit:** the toggle now renders a text label
  (`timeline.axisSource`/`axisTarget`, `Timeline.tsx:2664`), so A1 is *partially*
  met; A2 (preserved filtering) and A3 (transition chip) remain.
- **Proposed:**
  - **A1** — replace the `⊞` toggle with a two-segment control (`來源 | 目標`),
    current segment highlighted, hover explains each axis. Deep-links ("Targets" →
    target axis) land with the control already showing the 目標 segment.
  - **A2** — under the target axis, render **equivalent per-host lane chips**
    (reuse `lib/laneVisibility.ts`, generalised to the target lane set) so
    `hiddenLanes` operates on the current axis's lanes and is never orphaned; keep
    the "Show all" restore. (Fallback (b): if per-host chips are deferred, show a
    one-line "來源篩選暫不適用 · [切回來源軸]" instead of a silent blank.)
  - **A3** — when the axis is non-default (target), emit one dismissible
    `⊞ 目標軸 ✕` chip in the T3 active-modes row whose `✕` returns to the source
    axis, so "why does my timeline look different" is stated on-screen.
- **Acceptance:**
  - The current axis is always visible and text-labelled.
  - The target axis keeps equivalent filtering with a guaranteed restore path;
    hidden lanes are never orphaned.
  - A non-default axis shows exactly one clear-in-one-click chip; returning to
    source removes the chip and restores the source lane chips.
  - Invariant preserved: all-default (source axis, no sticky modes) → no "Active:"
    row (continues T3). i18n parity for all new keys.
- **Seam:** `lib/timelineAxis.ts` (exists) for A1; `lib/laneVisibility.ts`
  (exists, generalise to target lanes) for A2; `lib/timelineModes.ts` — add a
  `laneAxis: 'source' | 'target'` field so `activeModes` yields one chip on
  `target` and `[]` on `source`. Extend `test/timeline-modes` (or add it).
- **Effort:** M. **Depends on:** T3 (active-modes row) for A3.

---

## S-series — Settings correctness (audit §2.5)

### S1 — One save signal; surface save failures ⚪

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §2.5.
- **Problem:** auto-save, a manual **儲存** button, and a **"會自動儲存"** hint all
  coexist (`Settings.tsx:738-755`) — three contradictory signals about whether the
  user must act. Worse, save failure is swallowed by `.catch(() => {})`
  (`Settings.tsx:160`): a failed save looks identical to a successful one.
- **Proposed:** commit to one model (auto-save is canonical). Drop the redundant
  manual button — or demote it to a "Save now" that only appears while a save is
  pending or has failed — and show a single status line: `Saved` / `Saving…` /
  `Save failed — retry`. Replace the empty catch with a visible, retryable state.
- **Acceptance:**
  - At most one save affordance/message is visible at a time; no simultaneous
    "auto-saves" hint next to a manual save button.
  - A forced save failure renders a visible, retryable error — never a silent
    no-op. i18n parity for the new status strings.
- **Seam:** `lib/saveStatus.ts` — a tiny `saveStatusReducer(state, event)` over
  `idle | saving | saved | error`; test the transitions (incl. error→retry→saved).
  The status line and button visibility render off it.
- **Effort:** S.

### S2 — Confirm + diff for destructive Settings actions ⚪

- **Persona:** P1 / P3. **Source:** UX-AUDIT-2026-08-13 §2.5.
- **Problem:** only **刪除操作員** has a `confirmDialog` (`Settings.tsx:1789`).
  **Token rotate**, **revoke**, and **profile import** (`Settings.tsx:465-467` — a
  whole-config overwrite with **no diff preview**) all apply with no confirmation.
- **Proposed:** reuse the existing `confirmDialog` for token rotate + revoke. For
  profile import, show a **diff preview** (keys added / changed / removed) behind
  the confirm, so the operator sees exactly what a profile will overwrite before
  applying.
- **Acceptance:**
  - Rotate, revoke, and import each require an explicit confirmation.
  - Import shows a before/after diff and can be cancelled with **zero** state
    change. i18n parity for the new keys.
- **Seam:** `lib/settingsProfileDiff.ts` — pure
  `diffProfile(current, incoming) → { added, changed, removed }`; test it before
  the dialog renders it.
- **Effort:** M.

### S3 — Fill Settings search coverage ⚪ *(extends F3)*

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §2.5; §5 seam note.
- **Problem:** F3's filter box exists, but **16 of 35 groups have
  `labelKeys: []`** (~46%) — so searching real fields (`proxy`, `port`, `token`,
  `regex`) returns nothing; only group *titles* are searchable. The box is
  under-fed by a hand-maintained index.
- **Proposed:** replace hand-maintained `labelKeys` with a **generated**
  `settingsSearchIndex(groups)` derived from the group definitions + i18n, so every
  rendered field (and its hint text) is searchable without manual upkeep.
- **Acceptance:**
  - Searching `proxy` / `port` / `token` / `regex` each surface their owning group
    from any tab.
  - No group ships with empty searchable terms; the index is generated, not
    hand-listed.
- **Seam:** `lib/settingsSearch.ts` (exists) — add
  `settingsSearchIndex(groups)`; extend `test/settings-search.test.ts` to assert
  the four example terms resolve to the right group.
- **Effort:** S–M.

---

## C-series — cross-view pains (audit §3)

### C1r — Click-to-copy for IP / mark URLs ⚪

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §3 C1 (remainder).
- **Problem:** Loot / Transcript detail now show full values + a copy button
  (shipped 2026-08-13), but **IP addresses and mark URLs still can't be copied by
  click** — the operator re-types them.
- **Proposed:** a shared `<CopyableValue>` (or `useCopy()` hook) applied to IP
  cells (`IPStatusCard` / Timeline) and mark URLs, with an inline `✓` confirmation
  mirroring the HUD `⚡` quick-mark pattern (no focus steal).
- **Acceptance:** clicking an IP or a mark URL copies it with a visible, transient
  confirmation; keyboard-activatable; no layout shift on confirm.
- **Seam:** `lib/clipboard.ts` thin wrapper (or reuse the existing copy util from
  the Loot/Transcript work); the value-formatting fn is the tested part.
- **Effort:** S.

### C2 — Hide dead jump-to-Timeline buttons ⚪

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §3 C2.
- **Problem:** `onOpenInTimeline` is optional; when a parent doesn't pass it, the
  button renders **disabled-but-present** (`SearchPanel.tsx:122`,
  `ScopeStatus.tsx:95`, `LootPanel.tsx:169`) — a dead placeholder that reads as
  broken.
- **Proposed:** render the jump button only when a handler exists (preferred), or
  always wire the handler. No disabled placeholder.
- **Acceptance:** no disabled jump-to-Timeline placeholder is ever shown; when the
  button is present it always navigates.
- **Seam:** none pure; a render test per panel asserting presence-iff-handler.
- **Effort:** S.

### C3 — Filtered-empty state + ScopeStatus empty CTA ⚪

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §3 C3; §5 seam note.
- **Problem:** two dead ends. (1) **Timeline "filtered to 0"** is pixel-identical
  to "genuinely no events" (`Timeline.tsx:2442`), with no "clear filters?" path —
  it reads as data loss. (2) **ScopeStatus with no scope set** is icon + text with
  no CTA (`ScopeStatus.tsx:69`).
- **Proposed:** extend `emptyStateFor` with a `filtered-empty` branch that offers a
  **"clear filters"** action; give the ScopeStatus empty state a **"set scope"**
  CTA (nav to Settings ▸ Scope).
- **Acceptance:**
  - A filtered-to-zero timeline shows a distinct "clear filters" action that
    restores results; a genuinely-empty timeline keeps its own copy.
  - ScopeStatus's no-scope state offers a working CTA. i18n parity.
- **Seam:** `lib/emptyState.ts` (exists) — add the `filtered-empty` branch; extend
  `test/empty-state.test.ts`.
- **Effort:** S–M.

### C4 — Consistent filter-entry thresholds ⚪

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §3 C4.
- **Problem:** the filter UI appears at **different data thresholds** per view —
  Findings search needs marks ≥ 5, Loot chips need types ≥ 2, Search chips need
  types > 1 (`FindingsView.tsx:136`, `LootPanel.tsx:121`) — so with sparse data a
  filter you expect to exist is simply missing, inconsistently.
- **Proposed:** one policy across Findings / Loot / Search (e.g. reveal the filter
  affordance whenever there is more than one distinct value, otherwise omit it),
  documented in one place.
- **Acceptance:** the three surfaces reveal their filter at the same, documented
  threshold; no surface hides a filter that another would show for the same data
  shape.
- **Seam:** `lib/filterAffordance.ts` — `shouldShowFilter(distinctCount, policy)`;
  test the boundary cases.
- **Effort:** S.

### C5 — Custom tooltip / persistent gesture legend ⚪

- **Persona:** P1. **Source:** UX-AUDIT-2026-08-13 §3 C5.
- **Problem:** key gestures ride on native `title` tooltips — ~1s delay,
  unstyleable, and **invisible to touch and keyboard users**.
- **Proposed:** a lightweight `<Tooltip>` (hover **and** focus, no delay) for the
  handful of gesture hints, and/or fold the core gestures into the persistent
  legend (**T1**). Native `title` retired for these gesture affordances.
- **Acceptance:** gesture hints are keyboard-focusable and appear without the
  native delay; no key gesture is documented *only* through `title`.
- **Seam:** UI component; a render + focus test.
- **Effort:** M. **Overlaps:** T1 (persistent legend).

### C6 — Modal focus trap ⚪

- **Persona:** P1 (a11y). **Source:** UX-AUDIT-2026-08-13 §3 C6.
- **Problem:** modals (e.g. `EventMarker.tsx:31`) don't trap focus — Tab escapes
  the open dialog into the page behind it.
- **Proposed:** a `useFocusTrap(ref)` hook on modal roots: cycle Tab / Shift-Tab
  within the modal, restore focus to the opener on close, Esc closes.
- **Acceptance:** Tab and Shift-Tab stay within the open modal; focus returns to
  the triggering control on close; Esc closes.
- **Seam:** `lib/focusTrap.ts` — the focusable-order / wrap math is pure and
  testable; the hook wires it to the DOM.
- **Effort:** S–M.

### C7 — Unify UI-state persistence ⚪ *(consistency, not a blocker)*

- **Persona:** maintainer / P1. **Source:** UX-AUDIT-2026-08-13 §3 C7.
- **Problem:** persistence is split three ways — Timeline keeps ~20 localStorage
  keys, Settings **resets tab + search on every open**, Overlay preferences go
  through config rather than localStorage. Same concept, three mechanisms.
- **Proposed:** a small `uiState` helper with a namespaced key convention; migrate
  Settings tab/search and Overlay *UI* prefs onto it (Overlay's *functional* prefs
  stay in config, deliberately).
- **Acceptance:** Settings reopens on its last tab + search string; one documented
  key convention; no two sources persist the same preference.
- **Seam:** `lib/uiState.ts` — namespaced get/set with default fallback; test the
  namespacing + private-mode fallback.
- **Effort:** M. **Note:** lowest of the C-series — consistency polish.

---

## PL-series — plugin & capture lifecycle

### PL1 — Unify the plugin lifecycle into one card; disambiguate Install ≠ Enable ⚪

- **Persona:** P1 / P3. **Source:** `CAPTURE-SOURCE-TAXONOMY.md` §Part 4 (four
  gates); this session's UI review of `Settings.tsx`.
- **Problem:** a plugin's lifecycle is **split across two tabs with overloaded
  wording**, and one gate has a silent footgun:
  - Enable/trust (gates 2–3) live in **Plugins tab** (`PluginsPanel`); capture-hook
    install (gate 4) lives in **Capture tab → Hooks detected** (`HooksPanel`). A
    plugin that contributes a capture hook appears in **both**, with no
    cross-link — the operator can enable it and never realise its hook isn't wired
    ("enabled but not recording" is invisible).
  - The word **"Enable/Disable" is overloaded**: in Plugins it means gate 2
    (in-process, reversible, zero external footprint); the Hooks button labelled
    `hookEnable`/`hookDisable` (`Settings.tsx` L878) actually means gate 4 —
    **writing into `.zshrc` / `~/.claude/settings.json`**, external state that
    outlives RedLog.
  - **Disable ≠ Uninstall footgun:** `setPluginEnabled(false)` (`plugins/index.ts`)
    only flips `state.json`; it does **not** remove the hook line. Disabling or
    deleting a plugin **leaves orphaned hook lines** in the operator's shell/agent
    config that keep firing whether or not RedLog is open.
- **Proposed (full refactor — optimise for final effect, not minimal diff):**
  - **One lifecycle card per plugin** (in Plugins tab) rendering all four gates as
    a single progression: `Present → Enabled → (Trusted, 🔴) → Hook installed`,
    with the current state and the *one* next action surfaced. A contributed
    capture hook shows its install state inline on the same card (no tab hop).
  - **Two distinct verbs, never shared:** **Enable/Disable** for gate 2 only;
    **Install/Uninstall** for gate 4 (the button that writes external config).
    Rename the Hooks button accordingly and restyle it to read as a
    system-mutating action (it edits files outside RedLog).
  - **"Enabled but not wired" is a first-class, legible state** with a clear
    "Install hook to start capturing" CTA — reuse the `captureReadiness` state
    machine so this ties into onboarding (F1/F1-b).
  - **Kill the orphan:** disabling/deleting a plugin that has installed hooks
    prompts to uninstall them (or clearly flags them as still-installed with a
    one-click cleanup). Hook uninstall is always its own explicit action.
  - The Capture-tab Hooks list may remain as the *system-wide* hook inventory, but
    plugin-contributed hooks deep-link to/from their plugin card so the two views
    agree.
- **Acceptance:**
  - A plugin with a capture hook shows enable-state **and** hook-install-state on
    one card; the operator never needs both tabs to get it capturing.
  - No control labelled "Enable" writes to `.zshrc`/`.claude/settings.json`; every
    such write is labelled "Install" and visually marked as external.
  - Disabling or deleting a plugin with an installed hook cannot silently leave an
    orphaned hook line — the flow either removes it or surfaces it with a cleanup
    action.
  - "Enabled but hook not installed" renders a distinct state with a next-step CTA.
  - i18n parity: all new keys in `en.json` and `zh-TW.json`, same edit.
- **Seam (house rule — pure function first):** `lib/pluginLifecycle.ts` —
  `computePluginLifecycle(plugin, hooks, trust)` → a view model
  `{ present, enabled, trusted, hooks: [{id, installed}], nextAction, orphanedHooks }`
  merging `PluginView` (from `window.redlog.plugins`) with hook state (from
  `window.redlog.hooks` / `capture-health`). Test `test/plugin-lifecycle.test.ts`
  before the card renders/dispatches it; reuse `computeCaptureReadiness` for the
  wired/active transitions.
- **Effort:** M–L. **Depends on:** none hard; composes with F1-b (guided install)
  and the `captureReadiness` seam.

---

## Cross-references

- Personas + non-goals: `PRODUCT-POSITIONING.md`
- Whole-renderer audit: `UX-AUDIT-2026-08.md`
- Resize / discoverability audit (T7/T8, S-, C-series source): `UX-AUDIT-2026-08-13.md`
- Timeline deep-dive: `UX-TIMELINE-2026-08.md`
- Wheel + axis discoverability spec (T7/T8 detail): `DESIGN-TIMELINE-DISCOVERABILITY.md`
- Design system (tokens / layout / HIG targets): `DESIGN-SYSTEM.md`
- TDD process + worked example: `DEV-REQUIREMENTS-capture-onboarding.md`
- Correctness/trust/scale roadmap: `ROADMAP.md` (UX track added 2026-08-10)
