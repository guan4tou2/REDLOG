# Verification: Timeline on the Shared Filter

<!-- The spec's **Status** line is the verdict; this file is the evidence for it.
     Record commands and counts, not adjectives. -->

## RED

Each test file was written before its change and run to confirm it failed,
for the reason given.

- **T002** `test/event-query-builder.test.ts`: 16/16 failed. `countEvents` and
  `matchEventIds` did not exist; `excludeHousekeeping` was ignored by
  `queryEventsPage`; the 1,001-id case did not throw the limit error. A 17th
  case, added at GREEN, pinned the contract's reading of text (`10.0.0.5`
  prefix-matches `10.0.0.50`, `map` never matches `nmap`) and showed the
  spec's own example was wrong; spec, US3 and quickstart were corrected.
- **T006** `test/events-ipc-count-match.test.ts`: 4/4 failed. No
  `events:count` or `events:matchIds` handlers.
- **T008** `test/timeline-filter-completeness.test.ts`: passed first.
  `queryEventsPage` was already complete for every condition; the defect was
  the Timeline not reading through it (T009). Kept as the SC-001 guard.
- **T009** `test/timeline-shared-filter.test.tsx`: 13/13 failed. The Timeline
  read `events.query` unfiltered and never called `queryPage`; no range
  status, load-failed, empty-filtered, live-failed or outside-filter states;
  no export contribution for an empty set.
- **T017** `test/target-identity-case.test.ts`: 2/3 failed. A target filter
  returned 3 of the 7 rows the Targets page counted (exact compare against a
  `LOWER()` grouping), and a target-bounded export selected 0 events. The
  third case passed and guards the NOCASE change.
- **T018** `test/targets-open-in-timeline.test.tsx`: 2/2 failed. Opening a
  target left the shared target unset, and the Timeline drew its own focus
  badge.
- **T023** `test/query-operator-condition.test.ts`: 3/3 failed.
  `operator:op-2` parsed as text, `operator:` did not fail, and the query
  matched nothing.
- **T024** `test/query-readout.test.tsx`: failed, no `QueryReadout` module.
- **T025** `test/timeline-text-query.test.tsx`: 15/16 failed. `/` dimmed by a
  substring bag over loaded rows, never through `matchIds`, and only by
  opacity; no read-out, unparsable, earlier-match, load-back, failure or
  live-region states; the ⌘K operator pick set the display name. The 16th
  (box text survives a remount) passed and is a guard.
- **T034** `test/shared-filter-tier.test.ts`: 2/3 failed. `tier: 'chained'`
  was ignored by pages, queries, counts and matches, and HTTP flows came
  back under it. The third (no tier reads both) is a guard.
- **T035** `test/filter-bar-tier.test.tsx`: 3/3 failed (no chip, no tier, no
  clear). `test/shared-filter-views.test.tsx`: 9 of 25 failed, all tier: no
  view carried it or re-read on it, and neither empty-by-construction notice
  existed. The 16 others (target, time, in-scope, personal on every view)
  passed and are guards. The Type rows added from T035's own list: HTTP ×
  Type and Transcript × unbucketed Type already showed their notice; Loot ×
  Type was one of the failing notice cases.
- **T042** `test/display-zone.test.ts`: 8/8 failed. `lib/time` had no zone
  store; the formatters printed local time only; nothing outside the
  Timeline read `redlog-timeline-tz`.
- **T043** `test/display-zone-surfaces.test.tsx`: 5/5 failed. No Local / UTC
  choice in Settings ▸ General; the ⋯ menu still held `timeline-tz-select`;
  no app-wide zone for the Timeline, MarkerDetail and FilterBar chip. (The ⋯
  case first failed on setup, an empty Timeline draws no toolbar; it was
  seeded with one event so it fails on the picker itself.)
- **T053** `test/timeline-query-perf.test.ts` (`REDLOG_PERF=1`): 8/9 passed
  first. The live-admission burst (60 × `matchEventIds` of 100 ids, in-scope
  filter) took 975 ms against 100 ms: scope and personal traffic listed every
  distinct target of the project on each call, once per tier arm.

Found walking the built app through the quickstart (T055), each pinned by a
test that failed first:

- `test/housekeeping-parity.test.ts`, "keeps a row stored with no subtype, and
  a command row with no command": failed. The ingest stores a missing
  subtype as NULL and `HOUSEKEEPING_SQL`'s `NOT (…)` was then NULL, so seeded
  shell events never appeared. The fixture had stored `''`, never NULL.
- `test/event-title-missing-fields.test.ts`: 3/4 failed. With such rows now
  shown, a command row with no `command` threw in `eventTitle`, and one with
  no `exit_code` printed "exit undefined".
- `test/shared-filter-views.test.tsx`, the two HTTP cases: failed. Beneath a
  notice saying the empty list is not evidence of no traffic, HTTP History
  also said "No HTTP traffic captured yet."

Found by Converge, appended as T057 and T058, each RED first:

- **T057** (Constitution II) `test/timeline-shared-filter.test.tsx`, two
  cases: failed. With only personal traffic hiding everything, or the AI-turn
  collapse folding every row, the Timeline said "No events recorded yet": its
  filtered-empty state was gated on a badge count that leaves personal traffic
  out, and on the folded rows.
- **T058** (SC-002) `test/target-identity-case.test.ts`: failed, the Targets
  aggregate 9 against the Timeline total 7. The active-target fallback stamps
  every shell row with the target, a terminal opening and the hook sourcing
  itself included; the aggregate counted those housekeeping rows and the
  Timeline does not. `test/targets-open-in-timeline.test.tsx`, the live-row
  case: passes with the change and fails with `TargetView.tsx` stashed (its
  list read carried no `excludeHousekeeping`, and live rows were admitted by
  an exact `===`).

## GREEN

Per story, the files above pass after their tasks: T002 17/17, T006 4/4,
T009 13/13, T017 3/3, T018 2/2, T023 3/3, T024 3/3, T025 16/16, T034 3/3,
T035 3/3 and 35/35, T042 8/8, T043 5/5, housekeeping-parity 6/6,
event-title-missing-fields 4/4, T057 15/15, T058 4/4 and 3/3.

Existing tests changed because they pinned what this spec replaces:
renderer-smoke (the bridge gained `count` / `matchIds`), timeline-filters,
housekeeping-parity (runs the SQL itself), transcript-query-disclosure,
command-palette (expects the operator id), timeline-flush (guards the new
structure), loot-completeness-ui (the by-construction notice),
shared-event-filter (Search's dependency list includes the tier),
time-format (the zone lives in `lib/time`; no other file keeps one),
marker-detail (no zone props), and the e2e journeys `target-focus` and
`timeline-toolbar-overflow`.

Final run, 2026-09-24, Windows 11 (win32 10.0.26200), Node v22.23.1:

| Check | Command | Result |
|-------|---------|--------|
| Unit and integration | `npx vitest run` | 225 files passed, 3 skipped; 2413 tests passed, 20 skipped, 0 failed |
| Types | `npx tsc -p tsconfig.check.json` | exit 0 |
| Build | `npm run build` | exit 0 |
| Spec gates | `npm run verify:specs` | passed |
| Desktop E2E (Electron ABI) | `npx playwright test` on `target-focus`, `timeline-encoding`, `timeline-geometry`, `timeline-lane-bands`, `timeline-presentation`, `timeline-toolbar-overflow`, `timeline-virtualisation`, `search-query-contract`, `transcript-view`, `http-activity-view`, `loot-view`, `marker-amend` | 36 passed, before and after the walk-through fixes; after T057 and T058, with `active-target-context` added, 37 passed |

One earlier full run had a single failure, `confirm-dialog` "pulls focus back
when it is outside the dialog". It passed 3/3 run alone and in the final full
run; the file is not touched by this spec. A timing flake under load.

**Performance (T053, SC-006, research R13).** 100,000 events, 50/50 tiers,
200 targets each in two casings; median of 5 warm runs. Machine: 12th Gen
Intel Core i7-1265U, 12 threads, 32 GiB, Windows 11, Node v22.23.1.

| Read | First page (ms) | Total (ms) |
|------|-----------------|------------|
| No filter | 2.6 | 42.3 |
| Target (other casing) | 31.1 | 23.6 |
| Type | 1.7 | 1.2 |
| Time | 1.1 | 5.4 |
| In scope | 131.4 | 119.8 |
| Personal traffic | 17.2 | 82.8 |
| Chained only | 1.7 | 18.2 |

`matchEventIds` for 1,000 ids: 1.7 ms (filter), 10.9 ms (filter and text).
Earlier matches: `executeEventQuery` with a cursor and `limit: 1` 7.8 ms,
`countEvents` with text and a cursor 10.3 ms. Every read is under the 200 ms
budget. The live burst is 53.4 ms against 100 ms after the fix (a check by
id decides scope and personal over those rows' targets only; the answer is
the same, pinned by "admits by id exactly what the page walks" for each
filter kind, which passes with and without the change). The coalescing
fallback and the NOCASE target indexes were not needed.

**Real-app walk-through.** The built app, driven by Playwright with events
seeded through `/api/events/seed`: the `/` box reads its query back and dims
non-matches; "⛓ Chained only" lights and counts as a condition; HTTP History
under it shows the logged-tier notice and nothing else; Settings ▸ General
offers Local / UTC under "Language and time zone"; with UTC set the axis and
rows print `04:55Z` / `04:55:49Z` where Local printed `12:55`. The three
defects listed at the end of RED were found here.

Corrections made while implementing, in the spec and plan: ReplayDrawer was
listed as printing event times but prints only the elapsed playback
position, so it needs no zone subscription (FR-013's list and the plan
corrected); the zone choice sits in the Language group rather than a group
of its own, which the settings-ia group cap (29) refused.

## Gates

| Gate | Result | Date |
|------|--------|------|
| Clarify | 5 answered: the filter removes and `/` dims; "Chained only" in the shared filter; one Local/UTC zone; earlier matches counted and reachable; the tier not persisted | 2026-09-24 |
| Checklist | `requirements.md` 16/16. `query-integrity.md` 41 items, evaluated at the reviewer's request: 41 satisfied, with notes | 2026-09-24 |
| Analyze | Two passes: 14 findings resolved (`0401b60`), then 3 more (`b67bd57`) | 2026-09-24 |
| Converge | 2 tasks appended (T057 CRITICAL, Constitution II; T058, SC-002) and implemented; the second run converged | 2026-09-24 |
