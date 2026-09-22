# Tasks: Transcript Completeness

## Phase 1 — Contracts

- [x] T001 Add general filtered event-page cursor tests.
- [x] T002 Add Transcript completeness and failure-state contract tests.

## Phase 2 — Query path

- [x] T003 Implement canonical `queryEventsPage` over both tiers.
- [x] T004 Expose the paged query through main IPC, preload and renderer types.

## Phase 3 — Transcript

- [x] T005 Track per-bucket cursors and merge older pages without duplicates.
- [x] T006 Render recent-subset, complete and page-error states with recovery.
- [x] T007 Disclose partial loaded data in copied Markdown.

## Phase 4 — Verification

- [x] T008 Run focused tests, typecheck, full tests and build.
- [x] T009 Run the Transcript Electron journey.
- [x] T010 Analyze and converge artifacts; record verification and mark Verified.
