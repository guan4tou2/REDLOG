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

## Manual layout follow-up (2026-10-23)

- [x] T040 [US2] Inspect all current settings/work views through the native UI; fix the observed Hooks form-width cap with responsive source cards and expandable classifications while keeping the current recording mode visible. Record actual state/size coverage and remaining findings in manual-layout-20261023.md.
- [x] T041 [US2] Preserve a usable minimum width for the transcript query input and allow the toolbar to wrap. Recheck the native narrow-window layout and existing query/order/completeness behavior.

T040–T041 are bounded layout fixes and a recorded review, not completion of every view/state/size matrix or T008–T013. The initial remaining findings are completed in T042–T045 below; state/size coverage limits remain recorded in manual-layout-20261023.md.

- [x] T042 [US2] Replace the double bookmark empty pane with one empty state; keep the custody boundary and allow a full-width creation form. Associate existing form labels with inputs.
- [x] T043 [US2] Remove the nested 240px integrity scroll cap, size numeric settings to their values, and make AI/VPN lists responsive without hiding state, authorization or warnings.
- [x] T044 [US2] Map the HUD slider to its six existing scale stops; align labels and support keyboard steps plus named size buttons without changing persisted scale values.
- [x] T045 [US2] Link scope/HTTP empty states to the correct existing settings, distinguish command exit results, and keep HTTP read failures separate from empty/complete states. Verify focused behavior tests and native Mac journeys.

T042–T045 complete the seven recorded layout recommendations, not installer or cross-platform acceptance. No new capture modes, automatic installation or export semantics were added.

- [x] T046 [US2] Populate the isolated Mac review with long bookmarks and paired HTTP fixtures; repair bookmark wrapping and the preview-only paired HTTP renderer. Verify full inline/sidecar body behavior, truncation and failed-pair retry, then manually check narrow details and optional AI install/scope/removal without enabling real capture. Record lock-screen and platform limits.

- [x] T047 [US2] Complete the lock-interrupted native HTTP filter/step/close checks; make All clear local method/status/host filters and expose a truthful pressed state, preserving search and shared filter semantics. Reproduce the status-reset bug before fixing it and recheck the native 1→4 flow result.

- [x] T048 [US2] Manually exercise search/bookmark no-match recovery, bookmark stepping, bundle attachment keyboard toggles and focus, cancellation/reset, JSON capability display and scope recovery in narrow/wide native Mac windows. Record observed export-copy defects without claiming actual artifact execution.
- [x] T049 [US6] Correct the export attachment count label, gate attachment-only instructions/warnings by capability, and humanize boolean selection conditions. Preserve resolver counts, source-chain/scope warnings, tri-state filter meaning and preview/execute selection semantics. Recheck Bundle/JSON with the recorded casts fixture.
- [x] T050 [US2] Manually inspect a fresh isolated project through external-shell setup, defer/re-entry, settings field searches, native terminal stdout/stderr and health-to-settings navigation at narrow/wide Mac sizes. Record reproducible findings and distinguish actual verification from listener readiness; do not claim cross-platform or external-shell acceptance.
- [x] T051 [US2] Keep unverified HTTPS visible after the first terminal evidence replaces onboarding, and make core health actions open their corresponding existing settings. Preserve terminal-only use and distinguish listener readiness from client verification.
- [x] T052 [US2] Make settings search reflect applicable fields rather than untranslated interpolation/status templates; use stable field targets for navigation. Recheck CA on Mac and the already working retention-field search, including other-platform disclosure.
- [x] T053 [US2] Align first-run copy and hierarchy with external-terminal-first use; show browser-path choices before their detailed steps and describe ignored certificate errors as an exception rather than a requirement. Preserve nonce/client/CA verification distinctions and a single built-in fallback.
- [x] T054 [US2] Apply explicit platform applicability to external capture cards so Windows-only execution steps do not appear as primary Mac actions. Reuse existing source/platform contracts and allow deliberate discovery of other platforms without executing those instructions.
- [x] T055 [US2] Remove the first-run overview and built-in fallback's fixed form-width caps; use available content width, with terminal/HTTP setup side by side only when each has sufficient space. Manually check narrow stacking, wide layout and expanded fallback without changing recording behavior.
- [x] T056 [US6] Repair the native artifact check's observed implicit cast rewrite: bundle cannot scrub operator PII, so preserve its approved recording prefix byte-for-byte, including headers and io offsets. Remove the obsolete scrubbing helper/tests; retain bounded copy memory and snapshot/exclusion checks. Verify a failing IPC regression and re-export a real isolated bundle through the UI.
- [x] T057 [US6] Verify native Search → JSON/NDJSON, whole-project Bundle with one excluded cast, file-manager reveal and HTTP 4xx → HAR against actual artifacts/manifests. Omit blank/unset HTTP controls from the export summary without changing the request or query. Record platform/fixture limits rather than closing the entire acceptance matrix.
- [x] T058 [US2] Make Bash/Zsh startup and terminal status truthful about loaded versus enabled versus missing identity; start reports refusal after project switch without emitting capture_resumed, and the no-project offline warning does not promise replay. Reproduce the reported prompt change with/without RedLog before changing product hooks; verify the local prompt correction and installed Zsh helper in isolated PTYs without imposing a theme policy on other users.
- [x] T059 [US2] Measure command, event-query, body-heavy HTTP-query and settings-lookup costs; defer unused relay imports and rank only HTTP selection metadata. Preserve capture/exit/spool behavior, complete selected bodies, duplicate evidence and export snapshots. Retain a reproducible opt-in HTTP benchmark, verify relevant regressions and record local timing/platform limits without claiming native rendering or cross-platform acceptance.
- [x] T060 [US2] Repair the reported mixed-state onboarding layout: place work actions above setup, keep recent evidence with terminal capture, remove the enclosing duplicate card/heading and duplicate leave action. Verify 1600/800 geometry and actual external-Zsh proof in native wide/narrow windows. Record the initial unreliable narrow capture and the subsequent successful unlocked native inspection separately. Align installed-smoke navigation and current operator documentation without changing capture/export semantics.
- [x] T061 [US6] Exercise real POSIX export-directory write refusal and a missing approved attachment through the UI, preserving the selection and source evidence on recovery. Repair the reproduced non-modal toast overlap without dismissing errors or bypassing normal clicks; retain the scenarios in the existing export journey and allow it to target an installed candidate.
- [x] T062 [US6] Remove obsolete dropdown layout assumptions and seven duplicate source-expression tests while retaining their behavioral coverage. Diagnose the installed permission-test failure: same-second exports overwrite existing writable files even in a read-only directory. Preserve each JSON/NDJSON/HAR/Timeline delivery and manifest with exclusive creation and collision suffixes; verify four deterministic collision regressions and rerun the installed recovery journey. Complete the native narrow/wide partial-setup check without marking unrelated platform acceptance complete.
- [x] T063 [US2] Complete the bounded UI/CSS consolidation: classify project/appearance settings without adding pages, align field search, use available width for source/evidence lists, unify ordinary compact actions with accessible wrapping/selection and density, replace the stale loading grid, and verify long content in both locales across narrow/wide/zoomed windows plus native manual checks.

- [x] T064 [US5] Prioritize Claude Code terminal/IDE transcript capture, then Codex, using one shared installed/source journey. Verify explicit installation and directory authorization, new user/assistant text and paired complete tool I/O, search and actual JSON delivery, reload deduplication, stop/uninstall/reinstall/project isolation, and byte preservation. Repair the reproduced multiline JSON search-token defect and unreadable collapsed tool-input summary without changing evidence or adding another AI settings flow; record synthetic/native/provider-version limits.

- [x] T065 [US5] Package provider parsers as inert, separately built optional plugins; copy and validate only the selected package and load/unload it only for an authorized project. Discover provider metadata from package manifests without importing parsers into main. Consolidate official AI installation/recovery and project recording in the source entry, remove its generic plugin switch, preserve explicit opt-in and uninstall boundaries, and reduce repeated source copy using a responsive list with expandable settings.
- [x] T066 [US5] Resolve Claude/Codex transcript roots consistently for capture, detection and health (explicit project directory, absolute vendor environment root, then default). Changing the source directory stops capture pending explicit confirmation; verify real-file capture, switching and from-now semantics.
- [x] T067 [US2] Group optional sources by operator task without new navigation layers; manually inspect every work/settings page, including representative wide/narrow journeys, repair observed layout/accessibility friction, and record unexercised states and remaining design decisions.

T065–T067 complete the bounded optional-package/source-placement increment. Exact per-page state/size coverage, package/native evidence and remaining recommendations are in source-placement-and-ui-review-20261024.md; T008–T013 remain open.

- [x] T068 [US5] Reproduce and repair JSONL/per-message progress on DB/raw/checkpoint failures, preserving event UUID deduplication and complete raw units across retries/restart.
- [x] T069 [US5] Make global pause omit new AI sidecar content and establish durable resume boundaries, including delayed notifications and partial lines; retain metadata-only capture gaps.
- [x] T070 [US5] Add project/provider/session exclusion and explicit from-now reauthorization through existing AI source rows; show observed sessions without a new page or semantic classifier.
- [x] T071 [US5] Repair official managed-package upgrade/removal without executing stale/modified code or adopting foreign files; test and record exact acceptance/platform limits.

T068–T071 follow ai-durability-and-session-boundaries.md; they do not complete T008–T013.

- [x] T072 [US2] Reproduce the native stale settings-save error after successful retry; clear only the resolved project notification, retaining failed/refused retries and unrelated errors. Verify the post-merge Mac package and record native/platform limits.


## Phase 5: Convergence — #434 / #435 / #436

- [x] T073 [US1] Share RecordTerminalFlow between initial setup, host settings and WSL install/repair; opening settings must remain read-only. Respect detected adapter capabilities, distinguish installed/command/output proof, preserve shell-specific commands/profiles and stale-attempt/project isolation (FR-001/FR-004, partial).
- [x] T074 [US2] Keep dependency preparation and source repair in the current source entry, move Windows output configuration beside terminal setup, refuse unknown/failed pack availability, and provide direct managed-integration recovery without silently authorizing capture or adding fake external-producer switches (FR-003/FR-005/FR-011, partial).
- [x] T075 [US6] Retain the successful artifact in the export dialog and expose the last successful delivery for the current project on this machine; persist only main-owned metadata after actual success. Bound reveal to approved locations or that exact completed artifact; missing, inaccessible, corrupt metadata and failed reveal remain distinguishable (FR-014/US6.7, partial).
- [x] T076 [US6] Present evidence bundle/HAR as primary applicable formats and existing other formats in an advanced choice; retain all selection/policy/attachment/snapshot invariants and important warnings. Verify cancellation, failure/retry and reopening cannot mislabel an old result as the new export (FR-012/FR-013/FR-016, partial).
- [x] T077 Verify these bounded journeys test-first, run the ordered gates and affected installed/native Mac journeys at wide/narrow sizes, update domain/feature and issue evidence, and preserve unrun Windows/Linux/OS acceptance as NOT RUN (Constitution VIII, FR-016/SC-001).

- [x] T078 Consolidate the affected test journeys: reuse a process for ordinary settings with project/preference/viewport resets, include source connection in the export journey, retain process isolation for IPC fault injection, remove redundant renderer checks, and document one targeted verification run instead of repeatedly launching source/package copies.

T073–T078 close only the bounded #434/#435/#436 increment and its test cleanup.
The 2026-10-25 verification entry records exact source/package/native coverage,
including the consolidated-test selector failure and its targeted repair.
T008–T013 and the wider platform matrix remain open; Spec 062 remains Draft.

- [x] T079 Close the bounded follow-up: distinguish a manual adapter choice from the detected recommendation; refresh hooks, terminal policy and integration availability on return without running installers or changing project permissions; use HUD-off non-HUD test fixtures with explicit HUD-on acceptance and keep the product default unchanged.

- [x] T080 Reproduce the Windows late-discovery pause leak with a filesystem clock ahead of Date.now; persist a filesystem-calibrated recording boundary and reuse it for resumed sessions. Verify paused content stays absent after restart while genuinely new conversations still record; retain the CI/platform results in verification.md.
