# Tasks: Search Result Integrity

## Phase 1 — Failure contracts

- [x] T001 [US1] Add a failing renderer test proving query rejection is not an empty result.
- [x] T002 [US2] Add a failing renderer test proving secondary-source rejection is partial.
- [x] T003 [US3] Add retry and next-page preservation coverage.

## Phase 2 — Implementation

- [x] T004 Add explicit primary, secondary and next-page error state to Search.
- [x] T005 Add accessible English and Traditional Chinese messages and retry actions.
- [x] T006 Ensure new, retried and superseded searches preserve truthful state.

## Phase 3 — Verification

- [x] T007 Run focused tests, i18n parity, typecheck, full tests and build.
- [x] T008 Run the affected Electron Search journey.
- [x] T009 Analyze and converge artifacts; record verification and mark Verified.
