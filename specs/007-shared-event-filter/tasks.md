# Tasks: Shared Event Filter

## Phase 1 — Contract and counterexamples

- [x] T001 [US1] Add target and scope-before-limit counterexamples in `test/search-pagination.test.ts`.
- [x] T002 [US2] Renderer filter contracts are exercised by `test/shared-filter-views.test.tsx`; pagination retains the same predicates. Active-project scope overrides are covered by `test/events-ipc-count-match.test.ts`. These behavior tests replace the original source-string guards.

## Phase 2 — Canonical query contract

- [x] T003 [US1] Define and apply `EventFilter` in `src/core/db/event-queries.ts`.
- [x] T004 [US1] Resolve canonical project scope in `src/main/ipc/events.ts` and update preload types.

## Phase 3 — Investigation surfaces

- [x] T005 [US1] Pass all shared filters through Search pagination in `src/renderer/src/components/SearchPanel.tsx`.
- [x] T006 [US2] Apply shared filters before Transcript bucket limits in `src/renderer/src/components/TranscriptView.tsx`.
- [x] T007 [US2] Apply shared filters before the HTTP History event cap in `src/renderer/src/components/HttpHistoryPanel.tsx`.
- [x] T008 [US3] Reset and preserve pagination consistently when filters change.

## Phase 4 — Verification

- [x] T009 Run focused query and renderer tests, typecheck, full tests and build.
- [x] T010 Analyze and converge artifacts; record verification and mark Verified.
