# Tasks: Recording workflow consolidation

Current executable slice: US6. Other stories remain explicit follow-up gates rather than being marked complete from an export test run. No extension hooks are configured.

## Phase 1 — Setup
- [x] T001 Record the bounded export plan and canonical contracts in specs/062-recording-workflow-consolidation/plan.md.

## Phase 2 — Foundation
- [x] T002 Review plan/spec/tasks against the constitution and record question-free Clarify, checklist and Analyze outcomes in specs/062-recording-workflow-consolidation/verification.md.

## Phase 3 — US6: One export flow (P1)
Independent test: format changes preserve complete store selection; only the latest resolved plan can execute; attachment exclusions, errors and destination survive edits.
- [x] T003 [US6] Add failing request, stale-response, close and capability behavior tests in test/export-unified-dialog.test.tsx.
- [x] T004 [US6] Integrate controls and real preview in src/renderer/src/components/ExportMenu.tsx and src/renderer/src/i18n/{en,zh-TW}.json.
- [x] T005 [US6] Update existing export UI regressions and e2e/{export-preview,filtered-export}.spec.ts for the single dialog without weakening selection/policy assertions.
- [x] T006 [US6] Run targeted tests, relevant gates, build and affected desktop journeys; record native UI and artifact checks in specs/062-recording-workflow-consolidation/verification.md.

## Subsequent slices — not completed by US6
- [ ] T007 [US5] Plan and implement explicit per-tool optional AI installation against specs/062-recording-workflow-consolidation/spec.md and docs/domain/SPEC-capture-source-lifecycle.md; verify uninstalled tools are not read.
- [ ] T008 [US1] Close remaining supported-platform install acceptance in specs/062-recording-workflow-consolidation/manual-acceptance.md.
- [ ] T009 [US2] Complete settings save/failure/project-switch acceptance in specs/062-recording-workflow-consolidation/manual-acceptance.md.
- [ ] T010 [US3] Complete interactive terminal and preservation failure acceptance in specs/062-recording-workflow-consolidation/manual-acceptance.md.
- [ ] T011 [US4] Complete native HUD keyboard/focus/pass-through acceptance in specs/062-recording-workflow-consolidation/manual-acceptance.md.
- [ ] T012 [US7] Complete update/defer/restart acceptance against Spec 061 in specs/062-recording-workflow-consolidation/manual-acceptance.md.

## Final verification
- [ ] T013 Converge against all acceptance scenarios and update specs/062-recording-workflow-consolidation/{verification,spec}.md; do not mark Verified with unrun platform gates.

Dependencies: T001 → T002 → T003 RED → T004 → T005 → T006. T007 is independent of export code; T008–T012 require their specific environments. T013 requires all applicable gates. Independent test files can run together; edits to ExportMenu are sequential. No parallel agent work is necessary. Deliver and validate US6 before changing AI installation.
