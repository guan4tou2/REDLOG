# Tasks: filtered evidence export

## Setup and foundations
- [x] T001 Record canonical selection/projection decisions in specs/041-filtered-evidence-export/{plan,research,data-model}.md and contracts/selection.md.
- [ ] T002 Add failing selection contract regressions in test/export-plan-ipc.test.ts and test/http-flow-page.test.ts.

## US1 — complete investigation selection
Independent test: persisted matches beyond the visible page, frozen after preview.
- [ ] T003 [US1] Validate selection and snapshot-aware query contracts in src/core/export-plan.ts and src/core/db/event-queries.ts.
- [ ] T004 [US1] Resolve/execute complete selections through src/main/ipc/data-export.ts across JSON/NDJSON/Timeline.
- [ ] T005 [US1] Contribute canonical selections from Timeline/Search/Transcript and render whole/current choices in src/renderer/src/components/ExportMenu.tsx.

## US2 — HTTP exchange membership
Independent test: all method/status/host/text matches with complete eligible pairs, before pagination.
- [ ] T006 [US2] Implement canonical HTTP predicates/snapshot in src/core/db/event-queries.ts and carry through src/main/ipc/events.ts, src/preload/index.ts, src/renderer/src/env.d.ts.
- [ ] T007 [US2] Replace frontend-only filters/timestamp envelope in src/renderer/src/components/HttpHistoryPanel.tsx and resolve HTTP selections in src/main/ipc/data-export.ts.
- [ ] T008 [US2] Cover response-only/repeated flows and exact HAR entries in test/har-export.test.ts and test/export-plan-ipc.test.ts.

## US3 — honest evidence projections
Independent test: noncontiguous export verifies as projection; tampering fails.
- [ ] T009 [US3] Add projection verifier regressions in test/redlog-verify.test.ts and test/bundle-export.test.ts.
- [ ] T010 [US3] Implement projection manifest/count/source metadata and correct planned chain head in src/core/bundle-export.ts.
- [ ] T011 [US3] Verify projection files/row hashes/counts without full-chain claims in tools/redlog-verify.py.
- [ ] T012 [US3] Show exact conditions, event/exchange counts and projection limits in src/renderer/src/components/ExportMenu.tsx and src/renderer/src/i18n/{en,zh-TW}.json.

## Cross-cutting completion
- [ ] T013 Verify current/whole selection, error/zero/locale/compact flows in e2e/filtered-export.spec.ts.
- [ ] T014 Update docs/domain/SPEC-export-event-selection.md and record all gates/Converge in specs/041-filtered-evidence-export/verification.md.
- [ ] T015 Correct installation acceptance docs and add explicit installed-package validation under e2e/ and scripts/; record actual platform results in docs/PACKAGED-SMOKE.md.

Dependencies: T001→T002→US1→US2→US3→T013/T014. T015 environment inventory can run independently; no concurrent edits to shared export files. Incremental implementation with RED/GREEN per contract. No partial story is labelled complete.
