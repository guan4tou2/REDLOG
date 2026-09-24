# Implementation Plan: Timeline on the Shared Filter

**Branch**: `spec/033-timeline-shared-filter` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/033-timeline-shared-filter/spec.md`

## Summary

The Timeline stops filtering the 200 rows it happens to hold, and asks the
persistence layer like every other event view. Five changes:

- **Reads.** It pages through the shared-filter page query (R1).
- **The `/` text.** It goes through the query contract and dims what does not
  match (R5).
- **Target.** Its target is the shared chip, on the canonical identity
  (R3, R4).
- **Tier.** "Chained only" becomes a shared-filter condition (R2).
- **Time.** One display zone, owned by `lib/time`, replaces the Timeline's
  clock (R8).

Three core additions carry it: `countEvents`, `matchEventIds` and the
`operator:` condition. All three reuse the WHERE builder the page queries
already share.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict), React 19, Electron 44

**Primary Dependencies**: better-sqlite3 13 (FTS5), electron-vite 5

**Storage**: SQLite. The `events` table is chained; `events_logged` is logged,
with an FTS5 table for each. No schema change. NOCASE target indexes are added
only if R13's measurement needs them.

**Testing**: vitest 5. Core tests run against a real temporary database; renderer
tests use jsdom and @testing-library/react 16. The desktop journeys are
Playwright 1.63 e2e against the built app.

**Target Platform**: desktop, on macOS and Windows. Windows e2e needs the
Electron ABI build of better-sqlite3.

**Project Type**: desktop app (Electron main, preload, React renderer, core
library)

**Performance Goals**: at 100,000 events, each query below takes under 200 ms,
and a filter change redraws in under 2 s (SC-006, R13).

**Constraints**:
- The query layer never catches an error.
- The renderer can only narrow the scope policy that main attaches.
- There is one contiguous Timeline range (R6).
- No new Timeline toolbar controls. The earlier-match notice is the only new
  Timeline control; retry actions go on failure states. The "Chained only" chip
  and the Settings zone choice are moved controls, not added ones.

**Scale/Scope**: about 12 source files changed; `Timeline.tsx` is the largest
at 2,700 lines. Two domain contracts are updated.

## Constitution Check

*Pre-design and post-design: PASS. No violations to justify.*

| Principle | How this plan meets it |
|-----------|------------------------|
| I Evidence Integrity | Nothing stored changes. Target case-folding is a comparison (R3), not an ingest rewrite; the chained hashes cover `target_id` as recorded. |
| II Surface Truthfulness | A lit chip is applied or disclosed (SC-004). A partial Timeline says "N of M". Earlier matches are counted. "Project" time is removed. HTTP History says why "Chained only" empties it. The export label says it ignores the filter (R11). |
| III Canonical Domain Semantics | One filter predicate set, `appendEventFilter`, including tier and target. One text meaning, the query contract. One time formatter, `lib/time`. One query read-out, `QueryReadout`. The Timeline's private matchers are deleted: `computeTargetMatches`, `computeScopeMatches`, `buildSearchIndex`, `computeFilterMatches`, and the client-side personal and auditor filters. |
| IV Query Completeness | Predicates apply before the limit, on every Timeline read. There is `hasMore` plus a total, and an earlier-match count from the same cursor (R12). |
| V Preview/Execute Consistency | Export selection is unchanged except that a target subset matches every casing (R3). Preview and execute still resolve through one plan, and the menu shows the resolver's counts (R11). |
| VI Explicit Failure | Text has five states: empty, unparsable, matching, matched, failed (data-model). The new IPC rejects rather than returning empty. `matchEventIds` refuses more than 1,000 ids instead of truncating. |
| VII Evidence Provenance | Unchanged. Folded rows keep their mapping to the source rows they stand for (R5). |
| VIII Risk-Based Test-First | Every behaviour starts as a failing test: core predicates, the IPC shapes, and the Timeline in jsdom. The affected e2e journeys run before Verified. |
| IX Architectural Restraint | No windowed model. No new state library. The NOCASE index is added only if measured (R13). `buildTierWhere` is extracted because three queries already duplicate it, which is a present duplication. |

## Canonical interfaces and domain invariants

- **`appendEventFilter(filter, parts, params, arm, alias?)`**
  (`core/db/event-queries.ts`) is the only evaluator of the shared filter. The
  new required `arm` carries the tier (R2), and the target predicate comes from
  `targetPredicate` (R3).
- **`buildTierWhere(tier, { parsed?, filter, cursor?, excludeHousekeeping, ids? })`**
  is extracted from `executeEventQuery`. It is shared by `executeEventQuery`,
  `queryEventsPage`, `countEvents` and `matchEventIds`, so a page, its count
  and a match check cannot disagree on a predicate.
- **`parseQuery`** (`core/query/contract.ts`) gains the `operator` field (R7).
- **`lib/time`** owns the display zone. `formatTime`, `formatDate` and
  `formatDateTime` are the only event-time printers (R8).

Invariants affected:
- *Target Canonical Identity*: the case-insensitive predicate makes the
  aggregate and detail counts agree (R3).
- *One query text, one meaning*: the Timeline joins the contract.
- *Export operates on the complete population*: untouched, except that a
  target subset selects every casing (R3). The label says the Timeline's export
  ignores the filter (R11).

## Project Structure

### Documentation (this feature)

```text
specs/033-timeline-shared-filter/
├── plan.md              # this file
├── research.md          # decisions R1–R13
├── data-model.md        # filter, request, Timeline and zone state
├── quickstart.md        # validation guide
├── contracts/
│   ├── ipc.md           # event IPC shapes
│   └── query-contract.md # domain contract delta (review copy)
├── checklists/
│   └── requirements.md
├── tasks.md             # /speckit-tasks
└── verification.md      # from .specify/templates/overrides/verification-template.md
```

### Source Code (repository root)

```text
src/core/
├── db/event-queries.ts        # targetPredicate, arm-aware appendEventFilter,
│                              #   buildTierWhere, countEvents, matchEventIds,
│                              #   excludeHousekeeping on page/query requests
├── db/index.ts                # NOCASE target indexes, only if R13 needs them
└── query/contract.ts          # `operator` field
src/main/ipc/events.ts         # events:count, events:matchIds; new request fields
src/preload/index.ts           # bridge for the two new channels
src/renderer/src/
├── env.d.ts                   # bridge types
├── lib/
│   ├── FilterContext.tsx      # tier
│   ├── time.ts                # display zone; formatTs/TzMode removed
│   ├── timelineFilters.ts     # private matchers removed
│   └── timelineDomain.ts      # axis ticks through formatTime
└── components/
    ├── Timeline.tsx           # paging, text, load-back, notices, export label
    ├── QueryReadout.tsx       # new: shared token read-out (R9)
    ├── SearchPanel.tsx        # uses QueryReadout
    ├── TranscriptView.tsx     # uses QueryReadout
    ├── FilterBar.tsx          # tier chip and control
    ├── HttpHistoryPanel.tsx   # chained-only notice
    ├── TargetView.tsx         # sets the shared target
    ├── CommandPalette.tsx     # operator:<id> and quoted host
    ├── MarkerDetail.tsx       # display zone
    ├── StatusBar.tsx          # display zone; auditor tooltip points at the chip
    ├── ReplayDrawer.tsx       # display zone
    ├── App.tsx                # focusTarget removed
    └── settings/GeneralPage.tsx # Local/UTC setting
src/renderer/src/OverlayApp.tsx  # HUD: display zone through `storage`
src/renderer/src/i18n/{en,zh-TW}.json
docs/domain/
├── SPEC-search-query-semantics.md
├── SPEC-target-identity.md
├── SPEC-export-event-selection.md   # a target subset matches every casing
└── INVENTORY-query-completeness.md
docs/UIUX-STANDARD.md, docs/DESIGN-core-and-capture.md
test/                          # new and changed tests, per tasks.md
e2e/target-focus.spec.ts, e2e/timeline-toolbar-overflow.spec.ts
```

**Structure Decision**: the existing Electron layout. Core owns the query
semantics, main owns scope attachment, the renderer only renders. No new
directories.

## Design

1. **Core predicates first**:
   - `targetPredicate` and the required `arm` (tier).
   - `buildTierWhere` extracted from `executeEventQuery` and adopted by
     `queryEventsPage`.
   - `excludeHousekeeping` on page and query requests.
   - `countEvents` and `matchEventIds` on the same builder.
   - `operator:` in the parser and in `appendConditions`.
2. **IPC and bridge**: the two new channels and the new request fields, all
   through `withActiveScope`.
3. **Shared filter**: `tier` in `SharedFilter` and `toEventFilter`, and a tier
   chip and control in the FilterBar. HTTP History shows its chained-only
   notice.
4. **Timeline reads**:
   - `events:queryPage` with the shared filter and a generation guard. A total
     comes from `events:count`.
   - Every live batch is admitted through `events:matchIds`, and each admitted
     row adds one to the total. The renderer `isHousekeeping` checks are
     removed (R10).
   - `resolveReferencedEvent` never draws a row the filter excludes (R5).
   - Removed: the client-side personal, scope, target and auditor filters, the
     auditor chip, `targetFocus`, and App's `focusTarget`.
   - TargetView sets the shared target.
5. **Timeline text**:
   - `parseQuery`, `QueryReadout`, the five states, dimming by
     `matchIds`, and the fold mapping.
   - The earlier-match count and notice, and `loadBackTo`.
   - The palette sends `operator:<id>` and a quoted host.
   - "Open in Timeline" for an old event goes through `loadBackTo`.
6. **Display zone**:
   - The `lib/time` store and its migration.
   - Formatters that know the zone; `formatTs`/`TzMode` removed from the
     Timeline, the axis ticks and MarkerDetail.
   - The Settings ▸ General choice, with the Timeline's ⋯ menu item removed.
7. **Export label**: while a filter is set, the Timeline's contribution is
   labelled "filter not applied" and carries no `count`.
8. **Domain documents and inventory** (explicit tasks). Status lines are
   updated at Converge.

## Complexity Tracking

No constitution violations. One deliberate limit: `loadBackTo` loads
contiguously, so a match far back costs what scrolling there costs today.
It is recorded in R6, not hidden.
