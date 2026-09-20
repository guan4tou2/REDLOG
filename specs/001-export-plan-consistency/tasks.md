# Tasks: Trustworthy Export Preview and Execution

**Input**: Design documents from `/specs/001-export-plan-consistency/`
**Tests**: Required by the constitution and the user's TDD request.

## Phase 1: Setup

- [X] T001 Record the current snapshot implementation and legacy format capability baseline in `specs/001-export-plan-consistency/tasks.md` — baseline: commit `2422587` bounds JSON, NDJSON and bundle by rowid; legacy preview remains format-agnostic and HAR/Timeline execute outside the snapshot plan.
- [X] T002 [P] Add reusable isolated project fixtures for both event tiers and evidence attachments in `test/helpers/export-fixtures.ts`

## Phase 2: Foundational

- [X] T003 Write failing model and validation tests for normalized `ExportRequest`, immutable `ExportPlan`, counts, fingerprint and expiry in `test/export-plan.test.ts` — RED: 4/4 failed because the new domain API did not exist.
- [X] T004 Implement the canonical types, capability matrix, normalization, fingerprinting and bounded plan registry in `src/core/export-plan.ts` — GREEN: 12/12 plan and snapshot tests pass; typecheck passes.
- [X] T005 Write failing IPC contract tests for resolve/execute errors and project binding in `test/export-plan-ipc.test.ts`
- [X] T006 Implement `data:resolveExportPlan` and `data:executeExportPlan` orchestration in `src/main/ipc/data-export.ts`
- [X] T007 Expose the typed resolve/execute contract in `src/preload/index.ts` and `src/renderer/src/env.d.ts`

## Phase 3: User Story 1 — Confirm the Actual Delivery Set (P1) 🎯 MVP

**Goal**: JSON, NDJSON and Evidence Bundle preview and execute from the same approved plan.

**Independent Test**: Preview each format, insert events in both tiers, execute by plan ID, and compare planned and actual IDs/counts/fingerprint.

- [X] T008 [US1] Write failing preview=execute integration tests for JSON, NDJSON and bundle in `test/export-plan-ipc.test.ts`
- [X] T009 [US1] Adapt JSON and NDJSON execution to consume the resolved plan in `src/main/ipc/data-export.ts`
- [X] T010 [US1] Adapt Evidence Bundle selection and manifest reporting to the resolved plan in `src/core/bundle-export.ts`
- [X] T011 [US1] Write renderer tests for loading, resolve failure, empty plan and confirmation in `test/export-menu.test.tsx` and `test/export-mask-toggle.test.tsx`
- [X] T012 [US1] Replace callback-based pending exports with plan resolve/execute flow in `src/renderer/src/components/ExportMenu.tsx`
- [X] T013 [US1] Add truthful plan/result labels and error messages in `src/renderer/src/i18n/en.json` and `src/renderer/src/i18n/zh-TW.json`

## Phase 4: User Story 2 — Understand Every Applied Policy (P1)

**Goal**: Preview names all policies, attachment outcomes and format capability gaps.

**Independent Test**: Resolve each policy alone and in combination for all formats; unsupported requested protection blocks confirmation.

- [X] T014 [US2] Write failing capability and policy-outcome matrix tests in `test/export-plan.test.ts`
- [X] T015 [US2] Resolve scope snapshot, sharing exclusions, sanitization and attachment outcomes in `src/core/export-plan.ts`
- [X] T016 [US2] Include actual policy outcomes and attachment counts in Evidence Bundle manifest in `src/core/bundle-export.ts`
- [X] T017 [US2] Write disclosure and unsupported-policy UI tests in `test/export-menu.test.tsx` and `test/export-mask-toggle.test.tsx`
- [X] T018 [US2] Present subset, policy, attachment and limitation sections in `src/renderer/src/components/ExportMenu.tsx`
- [X] T019 [US2] Add accessible focus, keyboard, loading and error semantics to the preview surface in `src/renderer/src/components/ExportMenu.tsx`

## Phase 5: User Story 3 — Detect Dataset Changes (P2)

**Goal**: HAR and Timeline use bounded plans; expired or invalid plans require a refresh.

**Independent Test**: Resolve bounded HAR/Timeline plans, mutate selected and unrelated data, then verify preserved bounds or explicit invalidation.

- [X] T020 [US3] Write failing snapshot-aware HAR and Timeline bounded selection tests in `test/export-plan-ipc.test.ts`
- [X] T021 [US3] Add snapshot bounds to HAR selection in `src/core/har-export.ts`
- [X] T022 [US3] Route Timeline slice selection through canonical snapshot-aware queries in `src/main/ipc/data-export.ts`
- [X] T023 [US3] Extend view contributions to provide declarative format/subset requests in `src/renderer/src/lib/exportScope.ts`
- [X] T024 [US3] Migrate HTTP and Timeline contributors in `src/renderer/src/components/HttpHistoryPanel.tsx` and `src/renderer/src/components/Timeline.tsx`
- [X] T025 [US3] Write and implement plan expiry, single-use and project-switch behavior in `test/export-plan-ipc.test.ts` and `src/main/ipc/data-export.ts`

## Phase 6: Verification and Convergence

- [X] T026 [P] Add an isolated Electron journey for stable approval and failed refresh in `e2e/export-preview.spec.ts`; bounded HAR is covered by IPC integration because generating HTTP traffic in E2E would test unrelated capture setup.
- [X] T027 Update the authoritative status and capability matrix in `docs/domain/SPEC-export-event-selection.md`
- [X] T028 Run targeted export tests, related regression tests, typecheck and production build per `specs/001-export-plan-consistency/quickstart.md` — 74 export tests pass; typecheck and build pass (existing Vite chunk warnings only).
- [X] T029 Run the desktop E2E journey and record RED/GREEN/verification evidence in `specs/001-export-plan-consistency/tasks.md` — initial locator timed out despite correct rendered preview; corrected to the visible 12-character fingerprint. Final: 2/2 Electron journeys pass in isolated HOME.
- [X] T030 Run `$speckit-converge` and append any remaining work to `specs/001-export-plan-consistency/tasks.md` — first pass appended T031–T033; follow-up pass found no remaining actionable gaps.

## Phase 7: Convergence

- [X] T031 Add an adjacent actual-result manifest with plan identity, dataset boundary, policies and actual counts for JSON, NDJSON, HAR and Timeline per FR-011 and SC-002 (partial)
- [X] T032 Reject execution when approved Event or attachment inputs disappear or actual written counts differ from the plan per FR-002, FR-007 and SC-003 (partial)
- [X] T033 Stop JSON execution from re-reading mutable current config as approved policy metadata per FR-002 and Constitution V (contradicts)

## Dependencies

`T001–T002 → T003–T007 → US1 (T008–T013) → US2 (T014–T019) → US3 (T020–T025) → T026–T030`.

US1 is the MVP. US2 depends on the plan model and UI established by US1. US3 depends on declarative view requests and the canonical resolver.

## Parallel Opportunities

T002 can run while T001 documents the baseline. After core interfaces stabilize, renderer tests and bundle adapter work may proceed independently. T026 and T027 can proceed in parallel after all formats migrate.

## Implementation Strategy

Implement one failing behavior at a time. Preserve the current snapshot tests as regression coverage. Do not mark a task complete until its specific test has failed for the intended reason and then passed; record final integration and desktop evidence under T029.
