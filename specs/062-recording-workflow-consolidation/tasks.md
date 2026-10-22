# Tasks: Recording workflow consolidation

Delivered implementation slices: US6 and US5 T014–T019 (including Mac packaged-candidate native acceptance). Other platform/workflow gates remain open below. Other stories remain explicit follow-up gates rather than being marked complete from an export test run. No extension hooks are configured.

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
- [x] T007 [US5] Plan and implement explicit per-tool optional AI installation against specs/062-recording-workflow-consolidation/spec.md and docs/domain/SPEC-capture-source-lifecycle.md; verify uninstalled tools are not read.
- [ ] T008 [US1] Close remaining supported-platform install acceptance in specs/062-recording-workflow-consolidation/manual-acceptance.md.
- [ ] T009 [US2] Complete settings save/failure/project-switch acceptance in specs/062-recording-workflow-consolidation/manual-acceptance.md.
- [ ] T010 [US3] Complete interactive terminal and preservation failure acceptance in specs/062-recording-workflow-consolidation/manual-acceptance.md.
- [ ] T011 [US4] Complete native HUD keyboard/focus/pass-through acceptance in specs/062-recording-workflow-consolidation/manual-acceptance.md.
- [ ] T012 [US7] Complete update/defer/restart acceptance against Spec 061 in specs/062-recording-workflow-consolidation/manual-acceptance.md.

## Final verification
- [ ] T013 Converge against all acceptance scenarios and update specs/062-recording-workflow-consolidation/{verification,spec}.md; do not mark Verified with unrun platform gates.

Dependencies: T001 → T002 → T003 RED → T004 → T005 → T006. T007 is independent of export code; T008–T012 require their specific environments. T013 requires all applicable gates. Independent test files can run together; edits to ExportMenu are sequential. No parallel agent work is necessary. Deliver and validate US6 before changing AI installation.

## Phase 4 — US5 incremental installation backend
- [x] T014 [US5] Test-first and implement allowlisted local official-plugin install/catalog/uninstall in src/core/plugins/official-agents.ts, expose through src/main/ipc/plugins.ts and preload/env bridge; verify managed-file protection and explicit errors in test/official-agent-plugins.test.ts and test/official-agent-plugins-ipc.test.ts.
- [x] T015 [US5] Replace the AI preset authority with per-tool installed/active/project-scope decisions in src/core/capture-packs.ts, src/core/config.ts and src/main/services/agent-tailer.ts; test zero transcript reads while uninstalled or disabled.
- [x] T016 [US5] Enforce explicit project working directories and activation boundaries in src/main/services/tailer-host.ts and src/main/index.ts; test absent cwd, project switch, old history and late reads.
- [x] T017 [US5] Replace the AI settings preset and global watch-path writer with installation, per-tool project activation and directory/error controls in src/renderer/src/components/settings/AgentsPanel.tsx and Settings.tsx.
- [x] T018 [US5] Align source health, old bundled pack removal and docs/domain/SPEC-capture-source-lifecycle.md with the new decision; preserve existing evidence during disable/uninstall.
- [x] T019 [US5] Verify a clean Mac packaged-candidate profile, per-tool install/enable/disable/uninstall and preservation in native UI and affected tests; record in specs/062-recording-workflow-consolidation/{verification,ai-mac-acceptance-20261022}.md. Cross-platform installer acceptance remains T008.

Dependencies: T014 → T015 → T016 → T017/T018 → T019. T007 is complete with all six increments and the Mac native flow; T008–T013 remain separate platform/workflow gates.


## Native acceptance follow-up
- [x] T020 [US4] Close the observed HUD recovery gap: add failing window-event regressions, route the existing release-only shortcut in main/HUD windows, verify persistence/duplicate delivery and native candidate behavior. Keep OS-global delivery separate from the window fallback; no new HUD control or mode. See mac-workflow-acceptance-20261022.md; OS-global delivery remains unresolved under T011.

T020 is a bounded defect found during T011 native acceptance, not a replacement for the remaining platform gates.

## Small settings defects — #298 / #289
- [x] T021 [US2] Reproduce and repair managed HTTP port editing: preserve incomplete/invalid drafts, validate on blur/Enter, retain the last valid config and custom upstream proxy.
- [x] T022 [US2] Reproduce and repair external-source health projection and failed reads: retain running, label unknown/stale results, provide retry, reuse the existing read-state contract.
- [x] T023 [US2] Align managed HTTP start/starting/stop/retry actions with actual state; prevent duplicate actions and surface IPC/read failure. Verify relevant interaction tests, gates and Electron settings flow without closing the full-platform matrix.

T021–T023 are bounded diagnosed settings defects, verified in 103 targeted tests, three Electron journeys and the recorded Mac source-build native port flow. They do not complete T009's full matrix or replace supported-platform installer acceptance.

- [x] T024 [US2] Clarify the optional capture page name without changing routes or adding navigation levels.
- [x] T025 [US5] Show a persistent not-recording cue beside configured AI scope, and link a disabled plugin directly to existing plugin settings without enabling it or widening authorization; preserve the single explicit project checkbox.
- [x] T026 [US1] Prevent repeated Enter/click from creating duplicate projects; preserve input and allow retry after failure. Verify affected UI and existing project/AI isolation behavior.
- [x] T027 [US2] Remove the shared form-width cap only from Plugins and its footer. Verify available width at 1600×900 and no horizontal document overflow at 800×600; preserve other settings form widths.

## Source entry consolidation — #435

- [x] T028 [US5] Give every capture source one entry that states the two axes (installed on this computer, recording for this project), what it reads, and when it last delivered — from the same capture-health snapshot the dashboard card reads. State a changed project scope in place and confirm it with the single project control; ask before a local integration removal and name what stops and what stays. Verify with unit tests, the affected Electron journeys and a native capture-sources check.

- [x] T029 [US5] Extend the same one-entry treatment to the external producers and the pack-management row: each external producer says when it last delivered, and a pack disabled in Plugins offers the direct route to plugin settings instead of describing the way there. Unify the last-delivered wording through a shared SourceLastSeen component so the AI rows, pack rows and external rows cannot drift. Verify with unit and Electron tests.

T028–T029 are bounded settings increments for #435. They do not close #435 (plugin-management and external SourceLastSeen recovery details keep their own follow-ups) and do not replace T008–T013.

## Contribution results — #348

- [x] T030 [US5] Report what actually took effect for every contribution kind, not only loot and redaction: target extractors, command tags, event types and capture entries now return accepted/rejected counts with each rejected rule named and reasoned (bad regex, unknown strategy, missing field). The Plugins page renders them beside the existing loot/redaction/tailer lines. A manifest that loads is no longer presented as every rule working.

T030 is a bounded diagnostics increment for #348. It does not add a third-party code host, a marketplace, LLM classification, or any new capture capability; unsupported user tailers stay refused before consent, and the sample tester is unchanged.

## WSL diagnostics parsing — #433

- [x] T031 [US1] Parse the diagnostics script's own `✓/✗/!` output instead of a `[PASS] name: message` format it never emits, strip ANSI before matching, keep indented remediation lines with the check above them, and never turn an unrecognised line into a pass. Pin the parser and the panel with a captured real-output fixture.

T031 is a bounded correctness fix for #433. It does not touch #327 (cold-start timeout) or change the script's output format.

## Narrow window and status bar — #298 remainder

- [x] T032 [US2] Close the remaining small-window defects on macOS: the transcript toolbar clipped its kind filters and order/copy buttons at 800×600, and the status bar's HUD toggle fell outside the bar at 800×600 @200%. Measure every view and the status bar against `documentElement.clientWidth` (the only space shared with `getBoundingClientRect`), at 1280×800 and 800×600 across 100/150/200% zoom.

T032 is the Mac-verifiable remainder of #298. Windows/Linux DPI and the full-platform matrix (T008–T013) stay open.

## UIUX audit — copy and accessibility

- [x] T033 [US2] Audit every view and every Settings page in the running app for redundant copy, unnamed controls and misleading states. Fix what the audit found: a slider with no accessible name, loot rules whose only explanation was an unreachable tooltip, and an uninstalled AI integration telling the operator to start the AI tool as if that would record something.

T033 is a bounded audit pass. It does not redesign layout or add features.

## Executable copy gate — AGENTS.md

- [x] T034 [US2] Make the AGENTS.md copy rule executable instead of advisory: add test/ui-copy.test.ts covering the shapes that are never right (one explanation under two keys, a descriptive key nothing renders, a hint that only repeats its label, a tooltip that repeats the visible text, a helper line over three sentences without being an allow-listed warning), and remove the dead prose it found.

T034 adds a gate, not a redesign. It does not judge whether a sentence is worth saying — that stays with docs/UIUX-CONTROLS-AND-COPY.md §2 and review.

## Copy gate, mutation-tested — T034 follow-up

- [x] T035 [US2] Mutation-test the copy gate: prove each of its five rules fails on an injected violation, widen the duplicate-key rule to every key, and fix the tooltip rule whose tag scanner never matched a plain `{t('key')}` body. Fix what the repaired rules then found.

T035 makes the gate trustworthy. A rule that cannot fail is worse than no rule: it is a green check that means nothing.

## Copy gate, both locales — T034 follow-up

- [x] T036 [US2] Run the copy gate against zh-TW as well as en, and fix the two defects only the Chinese side showed: two artifact failures that named neither of two different problems, and a project-card label that read exactly like a violation counter.

T036 closes the language gap in the gate. A duplicate sentence can be invisible in one language and obvious in another.

## Layout heuristics, measured and ruled out — T034 follow-up

- [x] T037 [US2] Measure the layout patterns the copy rule names but cannot mechanically judge — nested card containers, a heading immediately followed by a paragraph repeating it, icon buttons whose tooltip is their accessible name, hints opening with a state restatement — and record the result in the gate so the ground is not re-dug.

T037 closes the audit. Nothing was changed: every candidate was inspected and found legitimate. The deliverable is the record.

## Hit areas and control geometry — UIUX audit

- [x] T038 [US2] Raise every interactive target to the 24x24 floor the app's own §3 implies (32px, WCAG 2.5.8 at 24): a shared CheckRow for all 22 checkboxes (their label rows were 20px), the terminal tab close/restart buttons (16px), the timeline's event-dot hit area (20px), the timeline help/zoom controls (20px), the status bar's HUD toggle (18x10 when narrow), and the HUD sliders (22px). Pin it with an Electron assertion so it cannot regress.

T038 changes geometry only. It does not touch the padding/gap/radius token consolidation, which is a separate and larger cleanup.

## Density tokens actually consumed — UIUX audit

- [x] T039 [US2] Make the density axis work: `--pad`, `--gap` and `--section-gap` were declared in styles/index.css and read by nothing, so tight density shrank only the sidebar rows while `density.ts` claimed it moved padding. Bind them to `p-pad` / `gap-gap` / `space-y-section` utilities, move the nine page-level containers onto them, and pin "declared but never read" with a test.

T039 is a behaviour fix disguised as a token cleanup. The radius tiers (4/8/12px) were found to be a deliberate three-level scheme and are now documented rather than changed.
