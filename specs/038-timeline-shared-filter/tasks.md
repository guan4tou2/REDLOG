---

description: "Tasks for spec 038: the Timeline on the shared filter"
---

# Tasks: Timeline on the Shared Filter

**Input**: `specs/038-timeline-shared-filter/`: spec.md, plan.md, research.md
(R1–R13), data-model.md, contracts/ipc.md, contracts/query-contract.md,
quickstart.md.

**Tests**: required. Constitution VIII covers selection, pagination, Target
identity and query semantics. Every story starts with tests that fail for the
stated reason before any implementation task in that story. Record each RED
reason in verification.md as it is observed.

**Organization**: by user story. US1 is the MVP. US2, US3 and US4 build on the
Timeline paging that US1 introduces. US5 is independent.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US5 from spec.md
- Paths are repository-relative

## Phase 1: Setup

- [X] T001 Create `test/helpers/timeline-query-fixture.ts` with `seedTimelineFixture(opts)`, following `addExportEvent` in `test/helpers/export-fixtures.ts`. It inserts rows directly into `events` or `events_logged` with `id`, `timestamp`, `created_at`, `operator_id`, `agent_type`, `subtype`, `target_id` and `data`. The FTS triggers index them.
  - It seeds a configurable count across both tiers, by default the newest 200 all `shell`.
  - Targets include `Example.COM` / `example.com`, `10.0.0.5` and `10.0.0.50`, plus rows that mention `10.0.0.5` only in `data.host` or `data.remote_addr`.
  - It adds housekeeping rows (`system/api_started`, `shell/session_start`) and a marker with an `amended` row carrying `markerId`.
  - It uses two operator ids, `op-1` and `op-2`.
  - It returns the ids by role.

---

## Phase 2: Foundational (blocks every story)

**Purpose**: one WHERE builder, plus the count and id-match queries every story uses (plan Design 1–2, research R5, R12).

- [X] T002 [P] Write failing tests in `test/event-query-builder.test.ts`, using T001's fixture:
  - `queryEventsPage({ excludeHousekeeping: true })` and `executeEventQuery({ parsed, excludeHousekeeping: true })` return no housekeeping rows in either tier.
  - `countEvents({ filter })` equals the number of rows `queryEventsPage` pages through to the end. Cover `agentType`, `since`/`before`, `targetId`, `inScopeOnly` + `scope`, and `hidePersonal` + `personalDomains`.
  - With a `cursor`, it equals the rows remaining after that cursor.
  - `countEvents({ parsed })` equals the rows `executeEventQuery` pages through; with neither text nor conditions it is 0.
  - `matchEventIds({ ids, filter })` returns the admitted subset in input order, and with `parsed` the matching subset. An unknown id is omitted.
  - 1,001 ids throws "matchEventIds takes at most 1000 ids". Empty `ids` returns `[]`.
  - SC-003: for each scenario input in SPEC-search-query-semantics (a plain word, `10.0.0.5`, `session:S1`, a quoted phrase), `matchEventIds({ ids: <every fixture id, chunked>, parsed })` equals the set of ids `executeEventQuery({ parsed })` pages through.
- [X] T003 Extract `buildTierWhere(tier, { parsed?, filter, cursor?, excludeHousekeeping?, ids? })` from `executeEventQuery` in `src/core/db/event-queries.ts`.
  - Both `executeEventQuery` and `queryEventsPage` build each arm with it.
  - `appendEventFilter(filter, parts, params, arm, alias?)` takes a **required** `arm: 'chained' | 'logged'`, with no behaviour change yet.
  - Every existing query test stays green: `npx vitest run test/event-query test/search test/transcript`.
- [X] T004 Add `excludeHousekeeping?: boolean` to `queryEventsPage`'s options and to `EventQueryRequest` in `src/core/db/event-queries.ts`. It applies `HOUSEKEEPING_SQL` inside each arm.
- [X] T005 Implement `countEvents(req)` in `src/core/db/event-queries.ts`: `SUM` of the per-arm `COUNT(*)` over `buildTierWhere`, with the cursor meaning "strictly past this position". Also `matchEventIds(req)`: the same predicates plus `e.id IN (SELECT value FROM json_each(?))`, the result reordered to input order, with the 1,000-id limit. Both come through the `src/core/db/events.ts` barrel. T002 passes.
- [X] T006 Register `events:count` and `events:matchIds` in `src/main/ipc/events.ts`.
  - Both go through `withActiveScope`.
  - Without an active project they return `0` and `[]`.
  - Errors are not caught (contracts/ipc.md).
  - Pass `excludeHousekeeping` through on `events:queryPage` and `events:runQuery`.
- [X] T007 Expose `events.count(req)` and `events.matchIds(req)` in `src/preload/index.ts`. Type them, and the new request fields, in `src/renderer/src/env.d.ts` from the core types.

**Checkpoint**: `npx vitest run test/event-query-builder.test.ts` passes; `npx tsc -p tsconfig.check.json` passes.

---

## Phase 3: User Story 1 - The shared filter means the same on the Timeline (P1) 🎯 MVP

**Goal**: the Timeline draws exactly what the shared filter admits, over the whole project, and says when it has drawn only part of it (FR-001–FR-004 counts, FR-010, FR-016, FR-017).

**Independent Test**: quickstart scenario 1. Type `dns` and the oldest hour select exactly the DNS events in that hour, including rows older than the first 200, and "N of M" is stated until all are drawn.

### Tests for User Story 1 (write first, confirm they fail)

- [X] T008 [P] [US1] Write a failing core test in `test/timeline-filter-completeness.test.ts`. With ≥1,200 fixture events, paging `queryEventsPage({ agentType: 'dns', since, before, excludeHousekeeping: true })` to the end returns exactly the DNS rows in range (SC-001). Add one case each for `targetId`, `inScopeOnly` and `hidePersonal`.
- [X] T009 [P] [US1] Write failing renderer tests in `test/timeline-shared-filter.test.tsx`: jsdom, `TimelinePanel` inside `FilterProvider`, and a mocked bridge that records calls.
  1. The first `events.queryPage` call carries the shared filter's `agentType`, `since`, `before`, `targetId`, `inScopeOnly` and `hidePersonal`, plus `excludeHousekeeping: true`. `events.query` is never called.
  2. A filter change re-queries from the first page and drops a late reply from the previous filter.
  3. While `hasMore`, the status line reads "N of M events", with M from `events.count`.
  4. A rejected `events.count` shows "total unavailable" with retry, and never a zero or guessed total.
  5. A rejected `events.queryPage` shows a failure with retry, never an empty timeline.
  6. A filter with zero rows shows an empty state listing every active condition, distinct from the empty-project state.
  7. A live batch calls `events.matchIds` with `excludeHousekeeping: true`, with or without a filter, and inserts only the returned ids. M grows by the admitted count, so N never exceeds M.
  8. A rejected live `matchIds` shows the live-admission failure with retry.
  9. A selected event that the new filter excludes (per `events.matchIds([id])`) is deselected, and the "outside the current filter" notice shows.
  10. With a filter set, the contributed export label is "Visible time range, filter not applied", with no `count`.
  11. While the first page loads, the loading state shows. Once it arrives and before the total does, the status line marks the total as pending.
  12. Following an amendment to a marker that `events.matchIds` excludes opens the marker in the detail panel with the "outside the current filter" note, and adds nothing to the drawn events.
  13. Lane chip counts, and the agent-turn collapse's hidden count, count drawn, admitted rows only.

### Implementation for User Story 1

- [X] T010 [US1] In `src/renderer/src/components/Timeline.tsx`, replace both `window.redlog.events.query(...)` loads (the initial load and the old-edge pager) with `events.queryPage({ ...toEventFilter(sharedFilter), excludeHousekeeping: true, limit: 200, cursor })`.
  - Keep `nextCursor` and `hasMore` in state, replacing `allLoaded`.
  - Add a generation counter: a shared-filter change bumps it, clears `eventsMapRef`/`sortedRef`, and reloads. A reply from an older generation is dropped.
- [X] T011 [US1] In `Timeline.tsx`, add the total and the status line.
  - Call `events.count({ filter, excludeHousekeeping: true })` once per generation.
  - While `hasMore`, show "N of M events · scroll back for older" (FR-003, US1 scenario 5).
  - A failed total shows "total unavailable" with retry.
  - Add i18n keys `timeline.rangeOfTotal` and `timeline.totalUnavailable` to `src/renderer/src/i18n/en.json` and `zh-TW.json`.
- [X] T012 [US1] In `Timeline.tsx`, admit every batch from `events.onNewBatch` through `events.matchIds({ ids, filter: toEventFilter(sharedFilter), excludeHousekeeping: true })`, in chunks of ≤1,000, whatever the filter (research R10).
  - Each admitted row adds one to the total M.
  - A failure shows `timeline.liveAdmissionFailed` with retry.
  - Remove the Timeline's renderer `isHousekeeping` checks from the page and live paths: `HOUSEKEEPING_SQL` is the one rule.
- [X] T013 [US1] Remove the client-side shared-filter work from `Timeline.tsx`:
  - the `hidePersonal`/`personalDomains` filter in the `events` memo
  - the `computeScopeMatches` call and its dimming branch
  Delete `computeScopeMatches` from `src/renderer/src/lib/timelineFilters.ts`, and its cases from `test/timeline-filters.test.ts`.
- [X] T014 [US1] In `Timeline.tsx`, add the three states (FR-010, FR-017, Edge Cases):
  - loading, while a generation's first page is in flight
  - the empty-with-filter state, listing active conditions from `useSharedFilter()`; add i18n `timeline.emptyFiltered`
  - page failure with retry
- [X] T015 [US1] Handle a selected event that a filter change excludes. After a generation's first page, check `selectedEvent` with `events.matchIds([id])`. If it is excluded, clear the selection and show `timeline.outsideFilter` (i18n en and zh-TW). Also make `resolveReferencedEvent`, which follows an amendment to its marker, check admission before inserting a fetched row. An excluded row opens in the detail panel with `timeline.outsideFilter` and is never added to `eventsMapRef` or `sortedRef` (spec edge case, research R5). The causal-chain focus admits its links the same way: only admitted links are drawn, and the badge counts the rest.
- [X] T016 [US1] Change the export contribution in `Timeline.tsx` (`useContributeExport`). While any shared-filter condition is active, use label `timeline.exportSliceUnfiltered` and omit `count` (FR-016). Add i18n "Visible time range, filter not applied" / "可見時間範圍（不套用篩選）".

**Checkpoint**: T008 and T009 pass, and `npx vitest run test/renderer-smoke.test.tsx test/timeline-filters.test.ts test/timeline-flush.test.ts` passes.

---

## Phase 4: User Story 2 - One target, whichever page it is picked from (P1)

**Goal**: one case-insensitive target predicate in every view. The Targets page sets the shared chip, and the Timeline's own target focus is gone (FR-005, FR-006, SC-002).

**Independent Test**: quickstart scenario 2.

### Tests for User Story 2 (write first, confirm they fail)

- [X] T017 [P] [US2] Write failing tests in `test/target-identity-case.test.ts`. With `Example.COM` and `example.com` rows, one number must be equal across:
  - `aggregateTargets()`'s count
  - `queryEvents({ targetId: 'example.com' }).length`
  - the rows `queryEventsPage({ targetId: 'EXAMPLE.com' })` pages through
  - `countEvents({ filter: { targetId: 'Example.COM' } })`
  - `queryHttpFlowPage({ targetId: 'EXAMPLE.COM' })`, which matches case-insensitively
  For target `10.0.0.5`, rows for `10.0.0.50` and `host`-only mentions are excluded. An export plan for a `time-range` subset with `targetId: 'EXAMPLE.com'` includes both casings, and its preview counts equal its execute counts (research R3). Drive it through the registered-handler harness in `test/export-plan-ipc.test.ts`.
- [X] T018 [P] [US2] Write failing tests in `test/targets-open-in-timeline.test.tsx`.
  - "Open in Timeline" on `TargetView` sets the shared `targetId`, seen through a probe inside `FilterProvider`.
  - It calls `onOpenInTimeline(ts)` without a target argument.
  - The Timeline shows no `timeline-target-focus-badge`, and its first `queryPage` carries `targetId`.

### Implementation for User Story 2

- [X] T019 [US2] Add `targetPredicate(column)` → `${column} = ? COLLATE NOCASE` in `src/core/db/event-queries.ts`. Use it in `appendEventFilter`, in the `queryEvents` `targetId` branch and in `queryHttpFlowPage`, replacing each `target_id = ?`. T017 passes.
- [X] T020 [US2] In `src/renderer/src/components/TargetView.tsx`, "Open in Timeline" (the click and ⌘↩ paths) calls `useSharedFilter().setTargetId(target)` and then `onOpenInTimeline(ts)`. Narrow `TargetViewProps.onOpenInTimeline` to `(ts: number) => void`.
- [X] T021 [US2] Remove App's `focusTarget` state and prop in `src/renderer/src/App.tsx`.
  - In `Timeline.tsx`, remove the `focusTarget` prop, `targetFocus`, `effectiveTarget` and the target-focus badge (`data-testid="timeline-target-focus-badge"`).
  - Delete `computeTargetMatches` from `src/renderer/src/lib/timelineFilters.ts` and from `test/timeline-filters.test.ts`.
  - Remove the `timeline.targetFocus.*` keys from both locale files.
  - T018 passes.
- [X] T022 [US2] Rewrite `e2e/target-focus.spec.ts` for the shared target:
  - arriving from a target shows the FilterBar target chip with `10.10.11.24`
  - clearing the chip restores the unfiltered Timeline
  - leaving and coming back keeps the chip, which is visible, per FR-005
  Update its header comment to cite spec 038 instead of the dimming focus.

**Checkpoint**: T017 and T018 pass, and the Targets page count equals the Timeline's "N of M" total for a mixed-case target.

---

## Phase 5: User Story 3 - `/` in the Timeline means what it means in Search (P2)

**Goal**: the filter box goes through the query contract and dims without removing. Earlier matches are counted and reachable. Palette picks use the contract's meaning (FR-004 matches, FR-007–FR-010, FR-015, FR-017, FR-018).

**Independent Test**: quickstart scenarios 3, 4 and 8.

### Tests for User Story 3 (write first, confirm they fail)

- [X] T023 [P] [US3] Write failing tests in `test/query-operator-condition.test.ts`.
  - `parseQuery('operator:op-2')` yields `{ field: 'operator', value: 'op-2' }`.
  - `operator:` fails with `empty-condition-value`.
  - `executeEventQuery` with the condition returns only `op-2`'s rows in both tiers.
  - A row whose text mentions `op-2` but whose `operator_id` is `op-1` does not match.
- [X] T024 [P] [US3] Write failing tests in `test/query-readout.test.tsx`. `QueryReadout` renders condition and text tokens with `data-testid="search-query-parse"` and the unparsable message with `data-testid="search-query-unparsable"`. `SearchPanel` and `TranscriptView` render it.
- [X] T025 [P] [US3] Write failing renderer tests in `test/timeline-text-query.test.tsx` (jsdom, mocked bridge):
  1. Typing `10.0.0.5` calls `events.matchIds({ ids: <drawn>, parsed: parseQuery(...).parsed, filter, excludeHousekeeping: true })`. Unreturned events stay drawn, with a non-visual not-matching state (FR-018).
  2. The QueryReadout shows the tokens.
  3. `session:` shows unparsable and dims nothing.
  4. While `hasMore`, it calls `events.count({ parsed, filter, cursor })` and `events.runQuery({ parsed, filter, cursor, limit: 1, excludeHousekeeping: true })`, then shows "K earlier matches".
  5. Enter on the notice pages `events.queryPage` (limit 1,000) until the nearest id is drawn, selects it and shows progress. Esc cancels and keeps what was loaded.
  6. A rejected `matchIds`, `count` or `runQuery` shows a failure with retry and dims nothing.
  7. An `amended` id returned by `matchIds` lights its marker.
  8. The match count is announced in an `aria-live` region.
  9. `redlog:filter-operator` with `op-2` sets the box to `operator:op-2`. `redlog:filter-host` with `10.0.0.5:8080` sets `"10.0.0.5:8080"`.
  10. `focusEventId` for an undrawn event loads back to it. For an event the filter excludes, it shows `timeline.outsideFilter`.
  11. Only earlier matches: every drawn event is dimmed.
  12. A `command_start` match lights its drawn `command_end`. A collapsed agent-turn match lights its drawn session row, or is counted as hidden by the collapse (FR-015).
  13. While `matchIds` is pending, the "matching" state shows (FR-017).
  14. A rejected load-back page shows a failure with retry and keeps what was loaded.
  15. The box input survives a remount of the Timeline for the same project (FR-008).

### Implementation for User Story 3

- [X] T026 [US3] Add `'operator'` to `QueryField` and `QUERY_FIELDS` in `src/core/query/contract.ts`. Add `case 'operator': e.operator_id = ?` to `appendConditions` in `src/core/db/event-queries.ts`. T023 passes.
- [X] T027 [US3] Create `src/renderer/src/components/QueryReadout.tsx` from `SearchPanel.tsx`'s token block (~lines 301–316) and its unparsable block. Replace both in `SearchPanel.tsx` and the block in `TranscriptView.tsx` (~line 535). The existing test ids stay, and T024 passes.
- [X] T028 [US3] Rebuild the filter box state in `Timeline.tsx`.
  - Parse with `parseQuery` (`core/query/contract.ts`). The states are empty, unparsable, matching, matched and failed (data-model TimelineText).
  - Render `QueryReadout`.
  - Get matches from `events.matchIds` for the drawn ids, in chunks of 1,000. New pages and live rows are checked incrementally.
  - Map matches through the existing fold index (research R5):
    - a command start lights its drawn end
    - a collapsed agent turn lights its drawn session row, or is counted as hidden by the collapse
    - an amendment, drawn as its own row, also lights its marker (`groupAmendments`)
  - Dim with `aria-disabled` and visually hidden "not matching" text.
  - Announce the match count in an `aria-live="polite"` region.
  - Keep the mutual exclusion with focus-chain and anomaly.
- [X] T029 [US3] Add earlier matches in `Timeline.tsx`: `events.count({ parsed, filter, cursor: pageCursor, excludeHousekeeping: true })` and `events.runQuery({ ..., limit: 1 })`.
  - The notice is a keyboard-focusable button: "K earlier matches" (`timeline.earlierMatches`).
  - It recomputes after every load-back. Live rows never change it (FR-004).
- [X] T030 [US3] Implement `loadBackTo(eventId)` in `Timeline.tsx`.
  1. Check admission with `events.matchIds({ ids: [eventId], filter })`. If excluded, show `timeline.outsideFilter` and stop.
  2. Otherwise page `events.queryPage` with `limit: 1000` until the event is drawn, passed or the end is reached. Show `timeline.loadingBack` with a count.
  3. Esc cancels (`timeline.loadBackCancelled`) and keeps what was loaded. A failure offers retry.
  Wire it to the earlier-match notice, and to `focusEventId` when the event is not drawn: "Open in Timeline" from Search, Loot and the Transcript.
- [X] T031 [US3] Delete `buildSearchIndex` and `computeFilterMatches` from `src/renderer/src/lib/timelineFilters.ts`, their use in `Timeline.tsx`, and their cases in `test/timeline-filters.test.ts`. Keep the persisted-per-project box input (FR-008).
- [X] T032 [US3] In `src/renderer/src/components/CommandPalette.tsx`, the operator pick dispatches `redlog:filter-operator` with `op.id`. In `Timeline.tsx`, that event sets `operator:<id>`, and `redlog:filter-host` sets `"<host>"` (quoted).
- [X] T033 [US3] Add i18n keys to `en.json` and `zh-TW.json`: `timeline.earlierMatches`, `timeline.loadingBack`, `timeline.loadBackCancelled`, `timeline.outsideFilter` (if not added in T015), `timeline.matching`, `timeline.matchCount`, `timeline.hiddenByCollapse` and `timeline.notMatching`. T025 passes, and `test/i18n-keys.test.ts` passes.

**Checkpoint**: T023, T024 and T025 pass. `e2e/search-query-contract.spec.ts` still passes.

---

## Phase 6: User Story 4 - The tier is part of the filter (P2)

**Goal**: "Chained only" is a shared-filter condition that every event view applies, starting at "All tiers" on each project open. The Timeline's auditor switch is gone (FR-011, FR-012, SC-007).

**Independent Test**: quickstart scenario 5.

### Tests for User Story 4 (write first, confirm they fail)

- [X] T034 [P] [US4] Write failing core tests in `test/shared-filter-tier.test.ts`. Each of these returns no logged row under `tier: 'chained'`:
  - `queryEventsPage`
  - `executeEventQuery({ filter: { tier: 'chained' } })`
  - `countEvents`
  - `matchEventIds`
  `queryHttpFlowPage({ tier: 'chained' })` returns an empty page. Without a tier, both tiers return.
- [X] T035 [P] [US4] Write failing renderer tests in `test/filter-bar-tier.test.tsx`:
  - `FilterBar` shows an always-visible "Chained only" chip beside "In scope only".
  - Toggling sets `filter.tier`, `toEventFilter` emits `{ tier: 'chained' }`, and `activeCount` counts it.
  - A fresh `FilterProvider` starts at `'all'` even with `redlog-timeline-auditor-view:<id>` = `'1'` in localStorage.
  - `HttpHistoryPanel` under "Chained only" shows the logged-tier notice, in wording distinct from the unapplied-Type notice, and no rows.
  - SC-004 matrix: with each chip set in turn (target, type, time, in-scope, personal, tier), `SearchPanel`, `TranscriptView`, `LootPanel` and `HttpHistoryPanel` either carry it in their bridge request, via `toEventFilter`, or show their notice for it. The expected notices are HTTP History × Type, HTTP History × Chained only, the Transcript × an unbucketed Type, and Loot × a Type other than `loot`.

### Implementation for User Story 4

- [X] T036 [US4] Add `tier?: 'chained'` to `EventFilter` in `src/core/db/event-queries.ts`. In `appendEventFilter`, emit `0 = 1` for the logged arm when `filter.tier === 'chained'`. `queryHttpFlowPage` returns an empty page under it. T034 passes.
- [X] T037 [US4] In `src/renderer/src/lib/FilterContext.tsx`, add `SharedFilter.tier: 'all' | 'chained'` (default `'all'` in `EMPTY`), `setTier`, the `toEventFilter` mapping and the `activeCount` term.
- [X] T038 [US4] Add the "Chained only" chip beside the in-scope chip in `src/renderer/src/components/FilterBar.tsx`. Add i18n `filter.chainedOnly` and `filter.chainedOnlyHint` (en and zh-TW).
- [X] T039 [US4] Add the "empty by construction" notices (FR-012), in the notice style and worded differently from the `filter.unapplied*` notices:
  - In `src/renderer/src/components/HttpHistoryPanel.tsx`, while `sharedFilter.tier === 'chained'`, show `filter.chainedOnlyHttp` ("HTTP flows are recorded in the logged tier; Chained only leaves nothing here").
  - In `src/renderer/src/components/LootPanel.tsx`, while the Type chip is set to anything other than `loot`, show `filter.lootTypeEmpty` ("Loot lists only loot rows; this Type leaves nothing here") in place of the bare empty list.
- [X] T040 [US4] Remove the auditor view from `Timeline.tsx`:
  - the `auditorView` state
  - its `redlog-timeline-auditor-view` load and save
  - the logged-row drop in the `events` memo
  - `hiddenLoggedCount`
  - the ⋯-menu chip (`data-testid="timeline-auditor-view-chip"`)
  Remove the `timeline.auditorView.*` i18n keys. The status bar tooltip that names the auditor toggle points at the FilterBar chip instead (`src/renderer/src/components/StatusBar.tsx`). T035 passes.
- [X] T041 [US4] Update `e2e/timeline-toolbar-overflow.spec.ts`: the ⋯ menu no longer holds the auditor chip. Grep `e2e/` for `timeline-auditor-view-chip` and update any other user.

**Checkpoint**: T034 and T035 pass, and no view lists a logged row under "Chained only".

---

## Phase 7: User Story 5 - One clock across the app (P3)

**Goal**: one display zone, Local or UTC, set in Settings ▸ General and used by every surface that prints an event time (FR-013, FR-014, SC-005).

**Independent Test**: quickstart scenario 6.

### Tests for User Story 5 (write first, confirm they fail)

- [X] T042 [P] [US5] Write failing tests in `test/display-zone.test.ts`.
  - `formatTime`, `formatDate` and `formatDateTime` print local time by default. After `setDisplayZone('utc')` they print UTC with `Z` (`07:04Z`, `2026-09-24 07:04Z`).
  - Migration: `redlog-timeline-tz` = `'utc'` becomes `'utc'`, and `'project'` or `'local'` becomes `'local'`. The result is stored as `redlog-display-zone`.
  - `useDisplayZone()` re-renders on `setDisplayZone` and on a `storage` event.
- [X] T043 [P] [US5] Write failing tests in `test/display-zone-surfaces.test.tsx`.
  - `GeneralPage` offers Local and UTC.
  - The Timeline ⋯ menu has no `timeline-tz-select`.
  - `MarkerDetail` and the FilterBar time chip print `Z` times under UTC.

### Implementation for User Story 5

- [X] T044 [US5] In `src/renderer/src/lib/time.ts`, add `getDisplayZone`, `setDisplayZone` and `useDisplayZone` (`useSyncExternalStore`, with a `storage` listener), stored as `redlog-display-zone` with the one-time migration. Make `formatTime`, `formatDate` and `formatDateTime` zone-aware, with the `Z` suffix in UTC. Delete `formatTs`, `TzMode` and `TsStyle`. T042 passes.
- [X] T045 [US5] Move the `formatTs` callers onto the three formatters:
  - `src/renderer/src/lib/timelineDomain.ts` (axis ticks)
  - `Timeline.tsx`: remove `tz`, `projectTz`, the `engagement.timezone` fetch and the ⋯ tz select
  - `src/renderer/src/components/MarkerDetail.tsx`: remove the `tz`/`projectTz` props
- [X] T046 [US5] Add the Local/UTC choice to the personal viewing-preference block of `src/renderer/src/components/settings/GeneralPage.tsx`. Add i18n `settings.displayZone`, `settings.displayZoneLocal` and `settings.displayZoneUtc`. T043 passes.
- [X] T047 [US5] Subscribe the surfaces that stay mounted while Settings is open, so they reprint on a change: `StatusBar.tsx` and `src/renderer/src/OverlayApp.tsx` (the HUD window, through `storage`). Each calls `useDisplayZone()`. (`ReplayDrawer.tsx` was listed here, but it prints only the elapsed playback position, `mm:ss`, which is not an event time, so it needs no subscription. FR-013 and the plan are corrected to match.)
- [X] T048 [US5] Update `e2e/timeline-toolbar-overflow.spec.ts`: remove the `timeline-tz-select` steps and the `redlog-timeline-tz` assertion.

**Checkpoint**: T042 and T043 pass, and one event's time is printed identically on every surface under UTC.

---

## Phase 8: Polish, domain contracts and verification

- [X] T049 [P] Update `docs/domain/SPEC-search-query-semantics.md` per `contracts/query-contract.md`:
  - Parsing rule 2 and Evaluation rule 2 (`operator:`)
  - Evaluation rules 7, 9 and 13 (tier; the Timeline)
  - a Counting rule and a Matching-given-rows rule
  - Coverage
  - the Timeline's empty-box section
  - Housekeeping
  - the Status line, adding Spec 038
- [X] T050 [P] Update `docs/domain/SPEC-target-identity.md`:
  - Normalization: filters compare case-insensitively through one helper.
  - The Invariant's `≈`.
  - Scenario 3's filtering half.
  - The Timeline no longer matches observation fields.
  - The Status line.
  Update `docs/domain/SPEC-export-event-selection.md` as well: a target subset selects every casing of the target (research R3). Preview and execute resolve through one plan.
- [X] T051 [P] Update `docs/domain/INVENTORY-query-completeness.md` §1: the Timeline row is now `queryEventsPage` with the shared filter, keyset cursor, total via `countEvents`, and completeness visible as "N of M". Update the cross-surface table and mark Batch 3 done.
- [X] T052 [P] Update `docs/UIUX-STANDARD.md`:
  - §6's view-mode divergence note: the zone moved to Settings ▸ General, and the auditor switch is the shared "Chained only" chip.
  - §7's target jump uses the shared target chip.
  - Any description of the Timeline's substring `/` filter.
  Grep `docs/DESIGN-core-and-capture.md` for the target-focus design and mark it superseded by spec 038.
- [X] T053 Add a performance check, `test/timeline-query-perf.test.ts`, skipped unless `REDLOG_PERF=1`. On a 100,000-event fixture it times each of these (research R13):
  - `queryEventsPage` for each filter kind
  - `countEvents`
  - `matchEventIds` for 1,000 ids
  - `executeEventQuery` with a cursor and `limit: 1`
  The first page and total for each condition kind are SC-006: under 200 ms each.
  Add a burst case for live admission (research R10): 60 `matchEventIds` calls of 100 ids within one second, with the main thread's total time under 100 ms (10%). If it misses, T012 coalesces admissions to at most 4 calls a second, and the case is re-run.
  Record the numbers, and the machine they come from, in verification.md. Add NOCASE `target_id` indexes to `src/core/db/index.ts` only if a target case exceeds 200 ms.
- [X] T054 Add Unreleased entries to `CHANGELOG.md`:
  - The Timeline honours Type and Time, over the whole project.
  - `/` reads like Search and dims.
  - Earlier matches are counted and reachable.
  - One target chip; target matching is case-insensitive everywhere.
  - "Chained only" is a shared-filter chip; the auditor switch is gone.
  - One Local/UTC setting in Settings ▸ General; "Project" is gone.
  - The export label is truthful.
- [X] T055 Run the full verification:
  - `npx vitest run`, checking for `[0-9]+ failed`
  - `npx tsc -p tsconfig.check.json`, `npm run build`, `npm run verify:specs`
  - the affected e2e journeys with the Electron ABI build: `target-focus`, `timeline-*`, `search-query-contract`, `transcript-view`, `http-activity-view`, `loot-view`, `marker-amend`
- [X] T056 Write `specs/038-timeline-shared-filter/verification.md` from `.specify/templates/overrides/verification-template.md`:
  - `## RED`: each test file and the reason it failed first.
  - `## GREEN`: the evidence from T055 and the T053 numbers.
  - `## Gates`: Clarify (5 answered), Checklist (41 items, and the reviewer's result), Analyze, Converge.
  Set the spec's `**Status**` to `Implemented`; it becomes `Verified` at Converge.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (T001)** → **Foundational (T002–T007)** → every story.
- **US1 (T008–T016)** depends on Foundational. It introduces the paged, filtered Timeline that US2, US3 and US4 build on.
- **US2 (T017–T022)**: core T017/T019 need only Foundational. The Timeline half (T018, T020–T022) needs US1.
- **US3 (T023–T033)**: T023/T026 (the operator condition) and T024/T027 (QueryReadout) need only Foundational. The Timeline half (T025, T028–T033) needs US1.
- **US4 (T034–T041)**: core T034/T036 need Foundational (T003's `arm`). The renderer half needs US1.
- **US5 (T042–T048)**: independent of US1–US4. It can start after Setup. T045 and T048 touch `Timeline.tsx` and the overflow e2e, so they are sequenced after any story editing those files.
- **Polish (T049–T056)** comes after every story it documents.

### Same-file sequencing

`Timeline.tsx` is edited by T010–T016, T021, T028–T032, T040 and T045. Those tasks run in ID order, never in parallel. `event-queries.ts` is edited by T003–T005, T019, T026 and T036, also in ID order.

### Parallel opportunities

- T002 while T001 is reviewed, since T002 only imports the fixture's interface.
- Within US1: T008 ∥ T009.
- Across stories, once US1 lands:
  - US2: T017 ∥ T018
  - US3: T023 ∥ T024 ∥ T025
  - US4: T034 ∥ T035
  - US5: T042 ∥ T043
- Docs T049 ∥ T050 ∥ T051 ∥ T052.

## Parallel Example: User Story 3

```bash
# Tests first, together:
Task: "Failing operator-condition tests in test/query-operator-condition.test.ts"
Task: "Failing QueryReadout tests in test/query-readout.test.tsx"
Task: "Failing Timeline filter-box tests in test/timeline-text-query.test.tsx"
# Then the two core-side implementations, which touch different files:
Task: "Add the operator field in src/core/query/contract.ts (then appendConditions)"
Task: "Extract src/renderer/src/components/QueryReadout.tsx"
```

## Implementation Strategy

### MVP (User Story 1)

Setup → Foundational → US1, then stop and validate quickstart scenario 1. The
Timeline now answers every FilterBar chip over the whole project and says when
it is partial. This is the fault the spec leads with.

### Incremental delivery

1. US1: the filter is honoured and complete.
2. US2: one target; the Targets count matches.
3. US3: the filter box on the contract, and earlier matches.
4. US4: the tier in the shared filter.
5. US5: one clock.
6. Polish: contracts, performance, verification.

Each step leaves the suite green and is committed on its own, with its RED
record written as it happens.

## Notes

- A test is RED only when it fails for the reason its task states. Record the
  message.
- Count failures with `grep -E "[0-9]+ failed"`. A test name containing "failed"
  must not be read as a failure.
- Do not mark checklist items: `checklists/query-integrity.md` belongs to the
  reviewer.

## Phase 9: Convergence

- [X] T057 CRITICAL: Make the Timeline's empty state say why nothing is drawn, per Constitution II and the Edge Cases' "a filter that matches nothing" (contradicts). In `src/renderer/src/components/Timeline.tsx` the filtered-empty state (`timeline-empty-filtered`) is gated on FilterContext's `activeCount`, which leaves out personal traffic, and "No events recorded yet" is chosen from the folded `events`. So a project whose admitted rows are all personal-domain traffic, or all collapsed agent turns, reads as having recorded nothing.
  - Show the filtered-empty state whenever a narrowing condition is active, personal traffic included: `hidePersonal` with personal domains configured, which the FilterBar shows lit as "Non-work hidden".
  - List personal traffic among the active conditions in `conditionLabels` / `describeActiveConditions` (`src/renderer/src/lib/FilterContext.tsx`).
  - When rows are held but the agent-turn collapse hides every one, say so, with the count and the toggle, instead of the empty-project state (FR-015).
  - RED first in `test/timeline-shared-filter.test.tsx`: a personal-only case and a collapse-only case.
- [X] T058 Make the Targets count agree with the Timeline's total, per SC-002 and FR-005 (partial). `aggregateTargets` (`src/core/db/event-aggregates.ts`) and the Targets page's list (`src/renderer/src/components/TargetView.tsx`, `queryPage({ targetId })`) count housekeeping rows, which the Timeline's total excludes. The ingest's active-target fallback (`src/core/ingest.ts`, `ACTIVE_TARGET_FALLBACK_TYPES`) stamps every shell row with the current target, `session_start` and hook-source rows included, so the Targets page promised rows the Timeline never shows.
  - Apply `HOUSEKEEPING_SQL` in `aggregateTargets` (export it from `src/core/db/event-queries.ts`) and pass `excludeHousekeeping: true` for the Targets list. Check the other consumers: FilterContext's known targets and `ActiveTargetControl`.
  - Update `docs/domain/SPEC-target-identity.md`'s Invariant and Property to the housekeeping-excluded count.
  - RED first in `test/target-identity-case.test.ts`: a `shell.session_start` row carrying the target makes the aggregate exceed `countEvents({ filter: { targetId }, excludeHousekeeping: true })`.
