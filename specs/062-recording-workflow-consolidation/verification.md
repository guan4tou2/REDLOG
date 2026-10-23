# Verification: Recording workflow consolidation

Overall status remains Draft. Existing bounded Mac acceptance and three prior fixes: see mac-acceptance-20261021.md and fix-verification.md. This record covers the US6 and US5 implementation slices, not a claim that all stories or platforms passed.

## Native layout review / T040–T041（2026-10-23）

See [manual-layout-20261023.md](manual-layout-20261023.md) for the page inventory, native window sizes, remaining recommendations and explicit coverage limits. Responsive source cards, expandable terminal policy details and a usable Transcript query width were implemented and manually checked in an isolated macOS source build. Related tests: 42 passed; typecheck, build, Spec Kit, architecture, i18n and diff checks passed. No packaged or cross-platform acceptance claim; T008–T013 remain open.

## Layout follow-up / T042–T045（2026-10-23）

The seven findings in manual-layout-20261023.md are implemented. Native Mac checks covered single-pane empty bookmark/create/cancel, scope→settings and HTTP→settings, HUD Increment and actual Right-key size changes, compact numbers, wide/narrow AI/VPN lists and reaching the last integrity anchor. Related tests: 9 files / 69 passed, then the HTTP file / 5 passed after adding its failure-state case (70 distinct cases total). Typecheck, final build, Spec Kit, architecture, i18n and diff checks passed. This does not close the untested populated/error/platform matrix or T008–T013.

## Populated detail follow-up / T046（2026-10-23）

Native Mac / ~875×548: 6 long bookmarks, 4 synthetic HTTP exchanges through the isolated API; bookmark detail/edit/cancel, request/response inline bodies, long headers and both dock positions. Fixed long bookmark wrapping, opaque sticky HTTP controls, and a preview-only paired renderer that hid recorded full bodies. One shared half renderer now handles both tabs. Optional Codex integration installed only in temporary HOME, directory selection remained opt-in, then integration removed without enabling recording. No real AI transcripts read.

Two meaningful new HTTP cases first failed (2 failed / 8 passed); final focused 5 files / 40 passed includes paired full inline body, truncation, sidecar load and pair-query error/retry. Typecheck, final build, Spec Kit, architecture, i18n and diff checks passed. The desktop locked before the extra 2xx filter click; do not count it as native acceptance. Sidecar/error behavior is unit-verified only. See manual-layout-20261023.md for fixture and process-cleanup details. Cross-platform/install acceptance remains open.

## HTTP journey completion / T047（2026-10-23）

The previously lock-interrupted native 2xx check is now complete. It exposed All clearing only method while leaving status active; fixed local method/status/host reset and pressed state, retaining URL text and shared filters. New case RED: 1 failed / 5 passed; GREEN: two HTTP files / 17 passed. Native Mac confirmed 2xx→one 200 flow, All→four flows, next detail 500→404 and close→four-row list. Typecheck, build, Spec Kit, architecture, i18n and diff checks passed. Isolated App/proxy exited normally through GUI. This closes that specific lock gap, not T008–T013 or cross-platform acceptance.

## Manual search/bookmark/export continuation / T048（2026-10-23）

Native Mac at ~875×548 and ~1750×1100: no-match search→results; no-match bookmarks→six rows; bookmark next/close; bundle cast untick/recount, Space retoggle with focus preserved, Tab to Cancel, cancellation/reset; JSON capability display; export→scope settings; Escape restores trigger focus. No export file was created. Found three open copy defects: attachments mislabeled HTTP bodies, JSON receiving attachment-only instructions/warnings, and raw boolean filter summaries. They are recorded as T049, not fixed or passed; see manual-layout-20261023.md. No new product code or automated suite run in this slice. Prior code-check results remain historical, not proof of these new findings being resolved.

## First-run and navigation review / T050（2026-10-23）

Created a fresh synthetic project via native UI at ~1750×1100, then resized to ~875×548. External Zsh setup installed only into the isolated HOME; did not run its canary or touch the operator profile. Defer remained recoverable by returning to Dashboard before evidence arrived. Retention-field search successfully scrolled/highlighted its target; CA search exposed inapplicable WSL/status templates and an unresolvable `{{path}}` target. Native built-in printf displayed stdout/stderr. After terminal evidence arrived, Dashboard replaced onboarding and showed an all-good/listening HTTP verdict without the promised unverified HTTPS reminder; readonly DB inspection found no logged rows. Health setup navigated to existing settings, but landed on the advanced captureControl page. Windows-only tshark instructions were visibly offered on Mac. Full reproduction, minimal recommendations and source pointers are in manual-layout-20261023.md; T051–T054 are open, as is T049.

No product-code edits, new UI automation, real HTTPS/CA verification or artifact export in this slice. Normal Quit/Stop action was followed by a native observation timeout; process session nevertheless exited 0. Restored Node SQLite runtime. This is a bounded manual review, not completion of T008–T013 or the overall Draft spec.

## RED
- 8 個新行為案例先跑，全數失敗：舊介面沒有直接 dialog、格式／範圍獨立控制或 loading 取消；舊介面不會在開啟時解析選取。
- 原生操作發現附件重算後焦點落到背景；在 export-attachment-list.test.tsx 加入焦點斷言先跑，1 failed。

## GREEN
- 新單一視窗測試擴為 11 個；9 檔相關 UI/架構回歸共 68 tests passed。
- Electron 6 條原流程通過；擴大後英／繁中分頁匯出各 1 條通過（106 筆，超過搜尋一頁100筆；切換格式、晚到事件隔離、空及錯誤 query）。
- 焦點修正的相關 2 檔12測試通過。
- 第一輪 typecheck、verify:i18n、verify:architecture、verify:specs、build、diff check 通過。最後焦點修改後單一 worker 重跑 9 檔68測試通過；一次平行重跑有4個 worker 啟動逾時，屬環境失敗，沒有將它算通過。

### 最後檢查（2026-10-22）

- `vitest run --maxWorkers=1 --no-file-parallelism` 指定9檔：68 passed。
- `playwright test e2e/export-preview.spec.ts e2e/filtered-export.spec.ts e2e/external-session.spec.ts`：7 passed，包括新附件焦點／底部按鈕區可見性測試。
- `typecheck`、`verify:i18n`、`verify:architecture`、`verify:specs`、`build` 與 `git diff --check` 通過。最後只有CSS捲動區分離及E2E追加；typecheck、build、7條受影響E2E再次通過。
- 一次帶原生驗收App同時執行的E2E發生afterAll退出逾時，四個行為斷言均通過；結束原生候選App後完整7條通過。沒有放寬timeout或修改產品退出程式來消除此失敗。
- 版面分離屬低風險CSS：不改選取／執行語義；焦點缺陷有RED，版面另有實際Electron幾何斷言，不以模擬DOM尺寸當桌面驗證。

## Operational Verification
Risk surface: export renderer / existing local ExportPlan integration. No capture or package resource contracts change. Native Mac 新視窗、NDJSON內容、bundle附件排除與簽章驗證通過；見 export-acceptance-20261022.md。最終候選包以 Tab 移至附件、空白鍵排除後，確認焦點仍留原核取方塊。捲動區改為與按鈕分開後，小視窗版面由 Electron 回歸確認，未另重包手動驗收該 CSS 排列。 Windows installation NOT RUN on this host.

## Release Impact
| Item | Result |
|---|---|
| User-visible | yes |
| Breaking | no persisted contract changes |
| Packaging affected | no packaged resource or installer changes |
| CHANGELOG updated | yes; unified dialog and prior Mac fixes recorded |
| Upgrade note required | no |
| Packaged smoke required | no resource change; native candidate export check required |

## Gates
| Gate | Result | Date |
|---|---|---|
| Clarify | No new questions for US6: supplied decisions fix range independence, existing formats, exclusions and one confirmation. AI installation handled separately. | 2026-10-21 |
| Checklist | US6 reviewed for default current selection, all-page completeness, capabilities, races, failure, keyboard and narrow windows; acceptance remains open. | 2026-10-21 |
| Analyze | No conflicts in bounded US6 plan/spec/tasks. Existing domain selection contract is reused. Other US1–5/7 work explicitly remains open; no claim of full completion. | 2026-10-21 |
| Converge | US6 的8個 acceptance scenarios、FR-012–014及相關FR-016逐項對照無新增實作缺口；使用既有領域契約，9項憲法原則無例外。全062仍有US5及跨平台驗收等已列T007–T013，不宣稱全規格收斂。 | 2026-10-22 |

## US5 / T014 installation-backend increment（2026-10-22）

Scope: local catalog/install/uninstall only. Installation metadata does not activate an adapter, write project configuration, install an AI tool or download code. Existing AI source activation/global scope behavior remains until T015–T018; whole-US5 uninstalled/read-isolation claims are NOT verified yet.

### RED

- New real-filesystem manager tests against the stub: 8 failed / 9 passed, including empty catalog, absent manifest installation and preservation behavior.
- New IPC tests before handlers existed: 6 failed because the catalog/install/uninstall channels were not registered.
- Partial removal test first failed: cleanup error did not report that the manifest was already removed. Test injection initially spied on a different fs import wrapper; aligned the existing default-fs import convention, then verified the changed=true error path.

### GREEN

- `vitest run --maxWorkers=1 test/official-agent-plugins.test.ts test/official-agent-plugins-ipc.test.ts test/plugins-ipc-audit.test.ts test/plugins.test.ts`: 4 files, 51 passed.
- `playwright test e2e/official-agent-installation.spec.ts`: 1 passed. A fresh isolated HOME has three not-installed entries; Codex install creates only its manifest; project config is byte-equivalent through API; modified manifest is protected; uninstall preserves existing evidence. This is automated Electron integration, not manual UI acceptance.
- typecheck, architecture, i18n and build passed. No renderer controls or capture producer changed in this increment; no new packaged resources. Packaging and Windows native acceptance remain open in T019.

### Gates / convergence

Clarify: no additional question for allowlisted local installation; existing decisions are sufficient. Checklist/Analyze: reviewed no default filesystem writes, no extra destination input, no transcript reads in this manager, explicit IO errors, ownership and non-recursive deletion; canonical plugin format/loader/IPC reused. Converge: T014 complete; T007 and T015–T019 remain open, with the activation/scope/UI gap explicitly recorded rather than marked complete. No domain invariant changes in this installation-only increment; capture lifecycle contract integration stays T018.

Release impact: backend scaffolding only, no new operator workflow yet; CHANGELOG explicitly identifies the increment as inactive groundwork. No release or main merge performed.


## US5 / T015–T019 integration（2026-10-22）

### Observable RED → GREEN

- Policy tests failed before adding the installed + active + explicit project path/activation decision; lifecycle/UI tests failed before replacing the preset and watcher lifecycle.
- Real-file Electron E2E initially timed out waiting for `transcript_capture_started`: the watcher ignored `.codex` and non-JSONL parent directories. Fixed root-relative filtering, then the same flow recorded only subsequent authorized content.
- A full regression found a retired member assertion and a delayed focus frame stealing the attachment checkbox's focus. Updated the audited per-source contract; added failing modal interaction/replacement tests and fixed the pending opening frame to respect prior interaction. Kept the original attachment focus assertion.

### Automated results

- Complete Vitest regression: **411 files passed, 4 skipped; 4082 tests passed, 26 skipped**. No new skip or weakened preservation/isolation assertions. Existing platform/opt-in performance skips remain skips.
- Typecheck, i18n assertions, architecture gate, Spec Kit gate, build and diff check passed.
- Electron journeys: **8 passed** across installation ownership/protection, explicit capture, export preview and English/Traditional-Chinese filtered exports. The capture flow verifies actual production watchers, new prompt plus tool input/output, unrelated directory exclusion, stop, uninstall, reinstall and unchanged evidence bytes.
- Mac **packaged** capture journey: **1 passed**, additionally instrumenting actual source `openSync`/`readFileSync`. Before installation and after installation without activation: zero opens/reads for all three tools. With Codex enabled: Codex is read, Claude/OpenCode remain unread. After disabling: zero further reads. This is automated observation, not manual UI acceptance.
- Candidate: `/private/tmp/redlog-ai-capture-20261022-dist/mac-arm64/RedLog.app`; arm64 Electron 44.4.1. `app.asar` SHA-256 `aa5e8b33ccc4ab631b45b6fbd296bad4f4ccae1fd0e9c356153671172613cc5c`.
- Packaged resource contract and deep/strict code-signature verification passed, including absence of the retired AI pack. Signature is ad-hoc; this is not notarization or a published release.

### Native manual acceptance / remaining gates

The isolated candidate was launched with HOME `/private/tmp/redlog-ai-native-20261022/home` and a separate profile, containing only synthetic client/private transcript fixtures. The native control tool reported **Mac locked** before any UI action. That initial block was later resolved by the user unlocking the Mac; the native flow was then completed as recorded below. The automated journey alone was not counted as manual directory-picker/keyboard acceptance. No real project or private AI transcript was opened.

Clarify/Checklist/Analyze: existing decisions resolve default installation, project permission and evidence retention; no new product direction needed. Converge at the initial locked checkpoint: T015–T018 implemented and tested; T019 was pending. This checkpoint is superseded by the native results below. Overall Spec 062 stays Draft; T008–T013 retain their specific platform/workflow acceptance gates. Windows/Linux native installers and vendor-version capture matrices were not run on this Mac. No merge or release performed.


## US5 Mac native completion after unlock（2026-10-22）

See [AI Mac native acceptance](ai-mac-acceptance-20261022.md). On the same c15f2186 packaged candidate, real native controls completed install → native folder picker → explicit enable → search of new prompt/tool input/output → keyboard disable → uninstall → reinstall without activation. The private-work, old-history, disabled and reinstalled-but-off content was absent from the database and sidecar. Existing sidecar SHA-256 stayed unchanged through disable/uninstall/reinstall. Normal quit stopped the isolated process (exit 0).

No product-code changes were required. Updated navigation descriptions to the actual Capture sources / 擷取來源 menu. T019 and parent T007 now close for this implementation/Mac-candidate slice; remaining cross-platform installers and complete manual matrix remain T008–T013, and the overall spec remains Draft. The explicit candidate/native distinction avoids claiming a DMG install or other-platform validation that was not run. Documentation-only checks: Spec Kit gate and diff check; the existing 4082-pass regression and packaged results still describe the same candidate.

## US2 / US4 Mac acceptance and T020（2026-10-22）

See [Mac settings/HUD acceptance](mac-workflow-acceptance-20261022.md). Native settings fault injection preserved the unsaved edit, showed failure, and saved after permissions were restored and Retry was clicked. Quick navigation persisted a change. HUD marker storage and focus return passed for the recorded case.

Native testing exposed an unproven global pass-through recovery despite successful accelerator registration. T020 adds the same release-only chord to main/HUD native window input, tested RED → GREEN, with persistence and duplicate-delivery safety. Main-window native acceptance, seven HUD Electron regressions and one packaged-candidate input regression passed; 73 targeted unit/component tests passed. Typecheck, architecture, build, packaged resources and strict/deep signature checks passed. No new HUD control, mode or changed default.

The user-supplied PID 10253 crash matches the sandboxed E2E launch before AppKit application registration completed. The unchanged build launched and passed outside the sandbox; no product workaround or weakened security was introduced for that environment failure.

Converge: T020 complete as a bounded window-input repair. OS-global delivery while another app is foreground is still unresolved under T011; T009's complete matrix and T008/T010/T012/T013 stay open. Overall status remains Draft; neither a release nor full-platform acceptance is claimed.

## T021–T023: small settings defects / #298 / #289（2026-10-22）

### Assess / scope

Baseline `2b21b690` plus this local change. Use the constitution's diagnosed-defect assess → fix → verify path. No new feature spec, source backend, permission, capture policy or evidence invariant. Reuse canonical managed-proxy endpoint following, health.running, the existing read-state hook and setup flow. The larger terminal/source/export redesigns (#434–#436) remain separate.

### Observable RED → GREEN

- Initial interaction tests: **10 failed / 1 passed**. Failures reproduced eager port clamping, missing validation, lifecycle labels/duplicate actions, lost running and swallowed list/health errors. The custom-proxy preservation case already passed and was retained.
- Label/transition increment: **3 failed / 17 passed** before the fix; setup still said Restart and an initially observed starting state never became actionable. Existing setup/control tests were updated to the agreed Start/Retry semantics, retaining actual start/stop/verification assertions.
- A lost stop reply regression failed before adding the status recheck. A rejection can arrive after an action has happened; the repair reads actual state before allowing another action, without automatically replaying Start/Stop. One interaction test was corrected to wait for this deliberate read before submitting another Start.

### Final verification

- **103 tests passed in 8 files**: capture settings interactions, CA removal/listener, ListField/accessibility, autosave/project binding, read states, HTTP autostart, first-run terminal/HTTPS and settings search. No new skips or relaxed failure/provenance assertions.
- **3 Electron journeys passed**: English and Traditional-Chinese port drafts/validation/persistence at 800×600; external running/disabled and rejected IPC/retry; existing owned proxy/terminal route/nonce flow. External-source responses are synthetic IPC fixtures, not a claim that tcpdump ran. The owned-proxy regression retains its controlled local process fixture.
- typecheck, architecture, i18n assertion gate, generated settings-search index check, Spec Kit gate, build and diff check passed. This bounded renderer fix did not rerun the previously recorded full regression or package new installers.

### Native Mac source-build check

Started the final built Electron with synthetic HOME `/private/tmp/redlog-ai-native-20261022/home` and a separate profile. Opened only `AI-Native-Acceptance`. Through native UI: stopped the owned proxy; its action became「啟動 HTTP 擷取」. Selected port 6661 and typed `6`: UI retained 6 and explicitly said not applied; disk remained port 6661/proxy `http://127.0.0.1:6661`. Tab displayed the linked range error while retaining the draft. Enter on 7777 saved both the port and the owned browser URL; disk readback confirmed 7777. Restored 6661 through the same UI, visited other-source settings (normal stopped rows loaded), then quit normally, exit 0. Final disk readback confirmed the original 6661 URL and port.

This was a native source-build check, not a fresh DMG install, real external producer test, system CA change or Windows/Linux manual acceptance. Existing evidence and real profiles were untouched.

### Gates / convergence

Clarify: supplied issue requirements resolve the bounded behavior; no new product choice needed. Checklist/Analyze: error/unknown/loading, valid/invalid drafts, managed versus custom proxy, duplicate/lost replies, stale reads, labels and actual save results reviewed against Principles II/III/VI/VIII/IX; no domain-contract update required. Converge: T021–T023 complete for this slice. T008–T013 and overall Draft status stay unchanged; #289/#298 remain broader open work, not closed by these fixes.

## T024–T027: small navigation, duplicate-create and Plugins-width follow-ups (2026-10-22)

Scope: clarify the existing optional-source page, link inactive AI integrations to existing plugin settings, show the pending-scope activation cue, prevent duplicate project creation and remove only the Plugins page's 900px cap. No extra navigation level, capture permission, activation control or source backend. Other forms retain their width cap. Plugin explanatory text references the canonical translated page label.

### Observable RED → GREEN / verification

- After correcting a test-only missing waitFor import, the valid initial behavior run had **3 failures / 23 passes**, reproducing the missing AI route/cue and duplicate creation. No product conclusion was drawn from the import failure.
- **89 tests passed in 9 targeted files** covering project creation/read states, AI settings/authorization, settings IA/search/autosave, existing capture settings, official plugins and capture policy.
- **7 Electron journeys passed** covering settings interactions, explicit AI activation, real production watcher isolation/preservation, duplicate Enter creating exactly one real project, view shortcuts and chain verification. Native directory selection is stubbed only in the automated scope-edit flow; production watcher assertions use real synthetic files.
- Native Mac source build with separate profile and synthetic HOME `/private/tmp/redlog-small-followups-native/home`: chose `/private/tmp/redlog-small-followups-native/client-work` through the real directory picker, observed the persistent cue and unchecked recording checkbox, and confirmed disk config retained `enabled: false`. Disabled Codex in Plugins, followed the new direct route back from Other capture sources, and confirmed it stayed disabled. No real transcript source or project was used.
- Width regression failed against the previous build with **478.6px** remaining to the right of the sample input at 1600×900. After the bounded fix, **4 affected Electron journeys passed**, including available-width geometry at 1600×900, no horizontal document overflow at 800×600, English/Traditional-Chinese port editing, IPC failure/retry, and explicit AI activation. These overlap the prior seven journeys and are not added as distinct coverage.
- Final follow-up: **38 tests passed in 4 files** for settings search/IA and Plugins state/sample behavior. Typecheck, architecture, i18n assertions, generated settings-search index and build passed. Restored better-sqlite3 to the project's Node runtime after Electron validation.

Converge: T024–T027 complete as bounded fixes. No release, packaged-installer or full-platform acceptance is claimed. T008–T013 and overall Draft remain open. Broader #434–#436 work is not closed by this slice. The pre-existing unrelated package-lock.json change is preserved outside this task's edits.

## T028: one capture-source entry (2026-10-22)

Scope: #435. Each capture source states its own facts in the entry that configures it — installed on this computer, recording for this project, what it reads, and when it last delivered. A changed project scope is named in place and confirmed with the one project control. A local integration removal asks first and names what stops and what stays. No new capture permission, no new backend, no new navigation level, and the AI integration stays uninstalled and off by default.

### Observable behaviour

- **Install state and project state are separate sentences.** The row reads "Installed on this computer · recording for this project" (or "not recording for this project"). Before, one line said only "installed", so an operator who had installed the integration everywhere could not tell which of the two axes the row answered.
- **Last delivered is a fact about the record.** Every pack member row, the screenshot source and each AI source now carry the same line, read from `window.redlog.capture.health()` — the same snapshot the dashboard's capture card reads, so the two screens cannot disagree. A source that is off and has never delivered says nothing; a source that delivered before and is off now keeps the line, because that is how the operator sees that it stopped.
- **A changed scope is named, not implied.** `agentTailer.sources.<kind>.scopeChangedAt` marks a scope change made while the source was recording. The row then reads "Scope changed — recording stopped until the new range is confirmed." and the project checkbox is relabelled "Confirm this range and record". One control, not two ways to do the same thing. A source that was never recording is not reported as a scope change.
- **Removal asks.** `confirmGraded` at level `plain` names the consequences: every project on this computer stops recording that source, and the records already captured are kept. Cancelling removes nothing.
- **Vocabulary is shared.** The health card's agent rows are labelled "Claude Code" / "Codex CLI" / "OpenCode", the same names the settings rows use; the settings verbs are Install integration / Remove integration.

### Verification

- **Unit tests: 22 new/updated assertions across two files.** `test/agent-sources-panel.test.tsx` (13 tests) pins the scope-changed sentence, the relabelled control, the removal consequences and the cancel path; `test/capture-source-rows.test.tsx` (5 tests) pins the last-delivered line, the "never delivered" wording, the absent line for a source the snapshot does not carry, and that a failing health read leaves the controls usable. The two pre-existing AI panel cases were updated to the new scope-changed wording rather than loosened.
- **Electron journeys: 18 passed** — capture-settings interaction, official-agent installation, official-agent capture, first-run. Two journeys were updated to the new behaviour (the removal now confirms; the scope change now names itself) and the AI capture journey now reads the removal dialog in English.
- **Native capture-sources check.** Built Electron with a synthetic HOME and a separate profile: turning the host-monitor pack on showed "尚未收到資料" under each enabled member immediately, the clipboard row (opt-in, off) stayed silent, and the uninstalled AI rows showed no last-delivered line at all.
- Typecheck, the i18n assertion gate, the generated settings-search index check and the build passed. `config.screenshot?.intervalSec` / `?.diffThreshold` now read the optional way their sibling fields already did, so a config without a screenshot section renders instead of throwing.
- Not claimed: the external-source entries and the plugin-management page keep their own #435 follow-ups; no cross-platform installer acceptance (T008) and no full-platform matrix (T009–T013). Converge: T028 complete as a bounded increment; #435 stays open.

## T029: external sources and pack-management entries (2026-10-22)

Scope: #435 continuation. An external producer (tcpdump, transparent proxy, C2
tailer) row now says when it last delivered, with the same words the AI and
pack rows use, through a shared `SourceLastSeen` component. A pack disabled in
Plugins no longer only describes the way to the Plugins page; the row offers
the direct route there. The last-delivered wording moved from the AI panel
onto the shared component so the three surfaces cannot drift.

### Observable behaviour

- **External producers say when they last delivered.** The row already said
  whether the producer is running now; it now also says when something
  actually arrived, through the same capture-health snapshot. A producer that
  is off and has never delivered says nothing.
- **A disabled pack offers the way back.** The pack-removed row keeps its
  message and adds "Go to plugin settings", so the operator does not have to
  find the page themselves. When there is no plugin-settings handler, no link
  is offered rather than a dead button.
- **One wording.** `settings.source.lastReceived` / `neverReceived` are shared;
  the AI panel no longer carries its own copy.

### Verification

- **Unit tests: 11 new assertions.** `test/capture-settings-interaction.test.tsx`
  gained three external-source cases (last delivered, never delivered, never
  started and never delivered); `test/capture-pack-group.test.tsx` gained two
  (direct route offered when disabled, no route when there is nowhere to go).
- **Electron journeys: 6 passed** — capture-settings, official-agent
  installation and capture.
- Typecheck, i18n assertion gate, generated settings-search index check and
  build passed. Converge: T029 complete as a bounded increment; #435 stays
  open.

## T030: contribution results for every kind (2026-10-22)

Scope: #348. Loot and redaction already reported accepted/rejected counts with
each rejected rule named; target extractors, command tags, event types and
capture entries registered and said nothing. A manifest that loaded was
therefore presented as every rule in it working. The four kinds now report the
same way, and the Plugins page renders the four new lines beside the two old
ones.

### Observable behaviour

- A bad regex in `targetExtractors`, `commandTags` or `capture` is named with
  its own error, not dropped in silence.
- A target extractor with an unknown `strategy` (or neither `strategy` nor
  `extract`) is rejected by name with the reason, rather than vanishing.
- An event type with no `agentType`/`label`, and a capture entry with no
  `id`/`hookFile`, are rejected by name.
- The row still shows the accepted count, so a partially-working plugin is
  distinguishable from a fully-working one and from a fully-broken one.
- Nothing about the refusal of third-party tailers changed: they are still
  rejected before consent with the ingest-API path forward.

### Verification

- **Unit tests: 110 passed in 9 files.** `test/plugin-contribution-report.test.tsx`
  gained a mixed-validity case asserting accepted/rejected for all four kinds
  and a page case asserting the four new result lines; `test/target-extractor.test.ts`
  updated its three count assertions to the new return shape (one of them now
  also pins the rejected name and reason).
- Native source-build check with a synthetic user plugin carrying one good and
  one broken loot rule, one good extractor and one unknown strategy, and a
  broken command tag: the Plugins page showed "1 accepted, 1 rejected" for each
  kind with the broken rule named, and the plugin stayed active — a broken rule
  does not disable the rest of the pack.
- typecheck, architecture, i18n assertion and Spec Kit gates and build passed.
  The 16 shell/PTY files still fail on this machine against a clean HEAD, as
  recorded earlier.
- Converge: T030 complete as a bounded diagnostics increment; #348's
  remaining items (supported external-producer path, explicit version contract)
  stay open.

## T031: WSL diagnostics read the script's real output (2026-10-22)

Scope: #433. The diagnostics script prints coloured `✓ / ✗ / !` lines under
`── section` headers. The parser expected `[PASS] name: message`, matched
nothing, and recorded every line as a passing `info` row — so
`✗ Failed to send test event: …` was displayed as a green `+`.

### Observable behaviour

- `✗` → `fail`, `!` → `warn`, `✓` → `pass`; ANSI is stripped before matching,
  so no escape sequence reaches the panel.
- Indented prose under a verdict (`→ Is RedLog running?`, `Fix: create …`) is
  appended to the check it belongs to instead of becoming a second row.
- Section headers name the check when the verdict line has no `name: message`
  split.
- An unrecognised line is `warn`, never `pass` — the catch-all that made a
  failure look green is gone.
- The panel shows `✓ / ✗ / !` (instead of `+ / x / !`) and carries an
  `sr-only` status word, so the status is not colour-only.

### Verification

- **The test input is the script's real output.** `test/fixtures/wsl-diagnostics-output.txt`
  was captured by running `hooks/wsl-redlog-test.sh` against stub `cmd.exe` /
  `wslpath` / `wslinfo` / `ip` / `curl` binaries, reaching the failing POST
  branch. The fixture keeps the ANSI escapes and indentation;
  `test/fixtures/README.md` records how to regenerate it.
- `test/wsl-manager.test.ts` (10 tests) now parses that fixture: exactly one
  `fail` named "Failed to send test event" with "connection reset", at least
  six passes, the NAT line as `warn`, and no surviving escape bytes. A second
  case pins that an unknown line is `warn`.
- `test/wsl-diagnostics-panel.test.tsx` (3 tests) renders the parsed fixture
  through the panel after pressing Diagnose: a failure row exists with its
  message and the accessible status word, pass/warn rows exist, and no raw
  ANSI appears in the document.
- typecheck, architecture, i18n assertion and Spec Kit gates and build passed;
  the affected Electron spec still passes.
- Not claimed: #327's cold-start timeout is a separate failure mode and was not
  changed. The script's output format was kept; only the parser moved.

## T032: the rest of #298 on macOS (2026-10-22)

Scope: #298's remaining small-window defects, verified on macOS. The settings
half (narrow category column, Scope field accessibility, read states) already
shipped; this closes what was left in the other views.

### What was actually wrong

- **Transcript toolbar.** A single non-wrapping row held the title, count,
  completeness chip, filter input, six kind filters and three action buttons.
  At 800×600 — even at 100% zoom — `Picked only`, `Newest first` and
  `Copy as Markdown` ran off the right edge: 897px, 998px and 1122px in an
  800px viewport. There was no scroller, so they were unreachable.
- **Status bar.** At 800×600 @200% the bar is 400 layout pixels and the HUD
  toggle sat at 405..421, inside the bar's own `overflow-hidden`. The IP-safety
  and scope words were taking the room.

### The measurement bug behind the first "all clear"

The first version of this check compared `getBoundingClientRect().right`
against `window.innerWidth`. Those are different spaces: the body carries
`zoom: 0.9` and the shell applies its own `zoomFactor`, so innerWidth
overstated the viewport by 11% at 100% and by 100% at 200%. Every overflow
looked contained. A second attempt used the app root's rect as the edge, which
is worse — the root grows to fit the overflow. The check now uses
`documentElement.clientWidth`, the only viewport number in the same space as
the rects, and it measures the status bar separately because the bar sits
outside the view root and outside every view's scroll container.

### Observable behaviour

- The transcript toolbar wraps (`flex-wrap`) instead of clipping, and its
  filter input is allowed to shrink (`min-w-0`).
- Narrow, the status bar keeps the IP-safety and scope **dots** and moves their
  words into `sr-only` spans: nothing is lost to a screen reader, nothing is
  painted, and the HUD toggle stays inside the bar.
- Nothing changes at 1280×800 or on a wide window; the words are still visible.

### Verification

- **Electron, 14 passed.** The new case runs every one of 11 views at
  1280×800@100%, 800×600@100/150/200% and 1280×800@200%, asserting that no
  control outside a horizontal scroller leaves the viewport and that no
  status-bar button does either.
- **Both fixes were RED first, with the same spec.** With the two component
  changes stashed and the app rebuilt: `transcript: Picked only (0) @897 of
  800, Newest first ↓ @998 of 800, Copy as Markdown @1122 of 800`. A direct
  probe of the status bar on the old build showed `status-bar-overlay:
  405..421` in a 400px bar. Re-applied: 14/14.
- `test/renderer-smoke.test.tsx` gained a case pinning that the narrow bar
  keeps its words in `sr-only` spans (readable) and paints none of them, and
  that the HUD toggle survives.
- **A note on screenshots.** `page.screenshot()` under an Electron
  `zoomFactor` does not capture what the window shows — at 200% it produced an
  image whose content was cut, while the DOM reported a correct layout and
  `webContents.capturePage()` showed the same layout rendered correctly. Every
  assertion here is DOM measurement, not a screenshot, for that reason.
- typecheck, architecture, i18n assertion and Spec Kit gates and build passed.
  Not claimed: Windows/Linux DPI, or the T008–T013 platform matrix.

## T033: UIUX audit — copy and accessibility (2026-10-22)

Method: launched the built app with a synthetic HOME, walked all 11 views and
all 12 Settings pages at 1440×1000, and ran an accessible-name sweep over every
visible interactive element (button, link, input, select, textarea,
role=button, tabbable) on each screen.

### What the sweep found

- **One unnamed control in the whole app:** the HUD text-size slider. Its
  visible label was a `<label>` with no `for`, so a screen reader announced
  "slider" and nothing else. Fixed with `htmlFor`/`id` plus `aria-label` and
  `aria-valuetext` (the step name, which changes as it moves and so cannot be
  the name).
- **Loot rules explained only by a tooltip.** The row showed an internal id
  (`ntlm_hash`, `private_key`) and put what it matches in `title`. A keyboard
  cannot reach a tooltip and a screen reader does not read one — the only text
  explaining the row was unavailable to the people who need it. The description
  is now visible text and part of each switch's accessible name.
- **An uninstalled AI integration gave advice that cannot work.** With the
  integration not installed and the transcript folder absent, the row said
  "start the AI tool, then reopen this project" — following it records nothing,
  and nothing on screen said why. The folder is a fact about the AI tool;
  whether it can be read is a fact about the integration. The "start the tool"
  step now appears only on a row that can actually read the folder.

### What the audit deliberately kept

Copy that carries a fact the control cannot: the clipboard scope warning, the
SYN-scan blind spot, `0 = keep everything` on retention budgets, the unsigned
build's manual-update instructions, the bookmark-is-not-evidence explanation,
the chain-anchor description, and the plugin consent dialog. These are
security, evidence or platform facts, not restatements.

### Verification

- `test/hud-auto-show.test.tsx` +1: the slider has a name, a value text and a
  label associated by `for`.
- `test/loot-rules-group.test.tsx` +2: descriptions render as text, and each
  switch's accessible name includes them (with the bare type when a plugin
  supplies none).
- `test/agent-sources-panel.test.tsx` +2: the start-the-tool step is absent on
  an uninstalled row and present on an installed one.
- 19 Electron tests still pass (ui-closeout, capture-settings,
  official-agent-capture). typecheck, architecture, i18n assertion, Spec Kit
  gates and build passed.
- The sweep is a point-in-time check, not a gate: it lives in this record, not
  in CI. Converge: T033 complete.

## T034: the copy rule as a gate (2026-10-22)

AGENTS.md said "Avoid unnecessary secondary labels and descriptions. Let the
layout do the explaining." That is advice: a reviewer reads it and the next
agent does not. This turns the mechanical half of it into a test that CI runs.

### What the gate checks

`test/ui-copy.test.ts`, five cases:

1. **One explanation, one key.** Two descriptive keys with the same sentence
   means one will be edited and the other will not.
2. **No descriptive key that nothing renders.** A sentence written for an
   operator who will never see it sits in the translation queue forever.
3. **A hint may not repeat its label.** Exact equality after trailing
   punctuation — not a prefix match.
4. **A tooltip may not repeat the visible text beside it.** A tooltip earns its
   place by saying what the label cannot.
5. **Helper lines stay at three sentences or fewer** unless the key is on an
   allow-list of warnings (clipboard scope, SYN-scan blind spot, unsigned-build
   update path, plugin consent, …). Adding a key there is a decision.

What it deliberately does not do: judge whether a sentence is worth saying.
That needs §2's four questions and a human. Length alone is not a failure
either — the clipboard and SYN-scan warnings are long and belong.

### What it found, and what was fixed

- **Six dead keys** from `settings.hookWatchPaths.*`. `c15f2186` moved AI
  capture to per-project authorisation and removed the UI that rendered them;
  the strings stayed. The `hint` was also the only unreferenced descriptive key
  in the locale. Removed from both locales.
- **`bookmarks.cdpHint` repeated the state already on screen.** The panel
  showed "Chrome CDP not connected" and the hint opened with the same words.
  It now says only the actionable part: launch Chrome with the debugging port.
- **`timeline.help.hint` was a second copy of `timeline.help.title`** (both
  "Keyboard shortcuts"). It was used only as the button's `title`/`aria-label`,
  so the button now references the one string and the duplicate is gone.
- **One false positive, fixed in the rule.** A prefix match flagged
  `firstRun.core.laterWhy` ("Core capture that is not verified stays flagged…")
  because it opens with the heading's words. That sentence says something the
  heading cannot, and a gate that fails on it is a gate someone turns off. The
  rule now requires exact equality.

### Verification

- `test/ui-copy.test.ts` 5/5. typecheck, architecture, i18n assertion, Spec Kit
  gates and build passed; 4 Electron settings journeys still pass.
- `npm test`: 4051 passed. The 16 shell/PTY files still fail on this machine
  against a clean HEAD, as recorded earlier.
- AGENTS.md now names the test and says what to do when it fails.

## T035: mutation-testing the copy gate (2026-10-22)

A gate that cannot fail is worse than no gate: it is a green check that means
nothing. Each of the five rules in `test/ui-copy.test.ts` was given a
deliberate violation and the suite was run.

### What the mutation test found

- **Rule 1 did not fire on its own violation.** It compared only *descriptive*
  keys, so a duplicated explanation stored as `test.dupA` / `test.dupB` passed
  the rule named "does not store the same explanation under two keys". Widened
  to every key, with a length floor so labels like "Cancel" may repeat on
  purpose. It then found a real duplicate in the product: `castSearch.openAtMoment`
  and `httpHistory.openAtMoment` were the same sentence in two places —
  consolidated into `common.openAtMoment`.
- **Rule 4 never fired, on anything.** Two bugs in the rule itself. The tag
  scanner allowed `=>` as an alternative to `[^<>]`, which let the attribute
  group swallow an arrow function and stop matching the tag it belonged to;
  and the visible-text matcher required the character after the closing quote
  to be `,` or `}`, while a plain `{t('key')}` ends with `)`. Both are fixed.
  The repaired rule then found a real one: the timeline event inspector's
  "around this event" button had `title` and label both reading
  `filter.around`, so hovering said nothing the label did not.
- Rules 2, 3 and 5 fired on their injected violations as claimed.

### Verification

- `test/ui-copy.test.ts` 5/5, with every rule now demonstrated to fail on an
  injected violation.
- typecheck, architecture, i18n assertion, Spec Kit gates and build passed;
  19 Electron journeys still pass. `npm test`: 4052 passed; the 16 shell/PTY
  files still fail on this machine against a clean HEAD.

## T036: the copy gate runs against both locales (2026-10-22)

The gate ran against `en.json` only. That was a gap with a shape: a duplicate
sentence can be invisible in one language and obvious in another, and the
Chinese is the interface's default locale.

### What the Chinese side showed

- **`artifacts.tooLarge` and `artifacts.noSpace` were the same string in both
  languages** — "{{name}} was not added" / "未加入 {{name}}". They are different
  problems: the file is over the 200 MB per-evidence limit, or the disk is
  full. The `why` line said which, but the message line is the one read first
  and it named neither. The message now says which; the detail stays in the
  `why` line.
- **`project.appliedScope` ("Scope 2") and `statusBar.scopeViolations`
  ("SCOPE 2") were both "範圍 2" in Chinese.** The first means two in-scope
  targets were imported from a profile; the second means two scope
  violations. The card sits next to the profile-import button, so an operator
  could read "2" as violations and go hunting for out-of-scope commands that
  do not exist. The status bar now says "越界 2".

### Verification

- All five rules now run against both locales, with a length floor per
  language (24 characters in English, 10 in Chinese — Chinese carries more
  meaning per character, so the same floor would flag every label).
- A mutation test in Chinese (`test.zhDupA` / `test.zhDupB`) confirms the
  duplicate-key rule fires there too.
- Two false leads were checked and cleared rather than "fixed": 289 then 27
  apparently unreferenced keys were both artefacts of the detector — the
  locale keys are read through `text('quit.title')` and built at runtime from
  a prefix (`sidebar.${view}`). A corrected detector finds **zero** dead
  keys, so nothing was removed on a hunch.
- Placeholder parity between locales was checked separately and holds for
  every key, and no string over 25 characters is identical in both locales.
- typecheck, architecture, i18n assertion, Spec Kit gates and build passed;
  39 unit and 7 Electron tests still pass. `npm test`: 4051 passed; the 16
  shell/PTY files still fail on this machine against a clean HEAD.

## T037: layout heuristics, measured and ruled out (2026-10-22)

AGENTS.md names patterns the string-level gate cannot judge: the
"icon + title + description + card" stack, a card used to compensate for weak
grouping, a heading over a single item. Each was measured across the whole
renderer before deciding whether it could become a rule.

### Method and result

- **Card inside a card.** A JSX-nesting scan (a tag stack, not a text window —
  the first attempt matched sibling cards and produced 22 false positives)
  finds exactly **two**. `ScopeStatus`'s inner "card" is a 48px status dot with
  `border rounded-full`; `ExportMenu`'s is a warning panel inside a modal. Both
  legitimate. A rule here would need to tell a container from a dot, and would
  fail on the first false positive.
- **Heading immediately followed by a paragraph repeating it.** Two matches.
  "PowerShell will not load your profile" is followed by the sentence saying
  *why* the policy blocks it; "A command ran, but nothing arrived" is followed
  by what to check. A heading carrying either would be a paragraph.
- **Icon buttons whose `title` and `aria-label` are the same string.** Five, all
  close / clear / exit controls with no visible text. For those the tooltip is
  the visible label, which is what the accessible-name rules require — the
  opposite of redundant.
- **A hint opening with a state restatement** ("Off by default", "This is a read
  failure"). Two, both stating a fact the control cannot: that a switch is off
  unless asked, and that an empty list is not a failed capture.

### Outcome

No product change. The four findings are recorded as a comment block in
`test/ui-copy.test.ts` and summarised in AGENTS.md, so the next person does not
re-run the same scans and so nobody adds a layout gate that the data does not
support. The one real defect this pass produced was in the *scan* itself: the
first nesting detector counted 22 false positives by matching sibling cards,
which is exactly the failure mode a shipped layout gate would have.

### Verification

- `test/ui-copy.test.ts` 6/6 (the sixth case is the record itself, so deleting
  the comment breaks the build). typecheck, architecture, i18n assertion, Spec
  Kit gates and build passed. `npm test`: 4053 passed; the 16 shell/PTY files
  still fail on this machine against a clean HEAD.

## T038: hit areas (2026-10-22)

Measured every interactive element across 11 views and 12 Settings pages
(861 targets) and compared each against the 24x24 floor. Normalised by the
body's `zoom: 0.9` first — measuring raw rects reports 25.2 / 30.6 / 36px for
what is declared as 28 / 34 / 40px, which reads as a dozen inconsistent sizes
that do not exist.

### Before: 141 of 861 targets under 24x24 (16%)

| Size | Count | What |
|---|---|---|
| 13x13 | 38 | checkbox inputs; their label rows were 858x**20** |
| 16x16 | 1 | terminal tab close |
| 20x20 | 5 | timeline help / zoom out / zoom in, tab restart |
| 20px tall | 14 | bare text buttons: 稍後處理, 改用內建終端, 其他擷取來源, 篩選 |
| 22px tall | 1 | HUD text-size slider |
| 18x10 | 1 | status-bar HUD toggle, narrow (dot only) |

The worst of it was the checkbox row: the highest-frequency control in
Settings — clipboard sampling, file watching, loot rules — was also the
smallest target in the app.

### After: 0 of 855

- **`CheckRow`** (`components/settings/CheckRow.tsx`): one checkbox row for the
  whole app. The input stays 16px (the icon size §4 allows); the ROW gets
  `min-h-8`, so the clickable area is the full 32px line. All 22 checkboxes in
  Settings moved to it, plus ExportMenu, ConfirmDialog and EventMarker.
- Terminal tab close/restart 16 → 24; shell picker 20 → 24.
- Timeline help and zoom controls 20 → 24; the event-dot hit area's floor
  20 → 24 (`Math.max(24, dot + 8)` — the visible dot keeps its own size, so a
  small dot is still easy to click).
- Status-bar HUD toggle gets `min-w-6 min-h-6`; narrow it is a dot with no
  label, which had left it 18x10.
- Bare text buttons get `min-h-8`.
- HUD sliders get `h-8`; a range input's own box is the browser's track height.

### Verification

- **An Electron assertion now measures this**, in the same pass that checks
  controls stay inside the window: every view at five size/zoom combinations,
  a checkbox measured by its wrapping label, with 0.5px of tolerance because a
  24px row lands on 23.999… after dividing out the body zoom. 14/14.
- Two failures were found *by the new assertion*, not by the audit: the
  narrow status-bar toggle (18x10) and the floating-point tolerance. Both were
  real; both are fixed.
- 53 unit tests across the affected Settings components still pass. typecheck,
  architecture, i18n assertion and Spec Kit gates and build passed.
  `npm test`: 4053 passed; the 16 shell/PTY files still fail on this machine
  against a clean HEAD.
- Not done: the padding/gap/radius token consolidation (26 padding values, 4
  radii, `--pad`/`--gap` largely unused). That is a separate cleanup with no
  behaviour change and a much wider diff.

## T039: the density axis was a no-op (2026-10-22)

docs/UIUX-STANDARD.md §3 declares four density variables and says tight changes
row heights **and** padding. Measured in the running app:

| Variable | Declared | Read by |
|---|---|---|
| `--row-h` | 40 / 32px | Sidebar, Settings nav (2 files) |
| `--pad` | 16 / 10px | **nothing** |
| `--gap` | 12 / 8px | **nothing** |
| `--section-gap` | 24 / 14px | **nothing** |

So switching to tight shrank the sidebar rows and left every card, panel and
gap exactly where it was — while `lib/density.ts`'s own comment said density
"changes only row heights and padding". The feature looked implemented and was
a no-op for two thirds of what it claimed.

### The fix, and why not the obvious one

Rewriting the 271 `rounded` / 300-odd `p-*` / `gap-*` call sites would have been
a huge diff with no behaviour change. Instead the three variables are bound to
three utilities, and the containers that carry the page rhythm use them:

```css
@utility p-pad { padding: var(--pad); }
@utility gap-gap { gap: var(--gap); }
.space-y-section > :not([hidden]) ~ :not([hidden]) { margin-top: var(--section-gap); }
```

`@utility` is required for the first two — Tailwind only emits a utility it has
been told about; a hand-written `.p-pad` rule is emitted but never recognised,
which is exactly the failure mode that made `--pad` inert in the first place.
`space-y-section` is a plain rule because Tailwind rejects `>` in a utility
name.

Nine page-level containers moved from `p-4` to `p-pad` (Settings, Screenshots,
ScopeStatus, LootPanel, TargetView, Dashboard, Bookmarks, FirstRun ×2), and the
two dashboard containers take `gap-gap` / `space-y-section`.

Measured before and after in the running app: comfortable 16px padding and 11px
block gap; tight 10px and 7px. Density now moves the page.

### What was NOT changed

The radius spread — `rounded` 4px ×271, `rounded-lg` 8px ×28, `rounded-xl` 12px
×6 — turned out to be a deliberate three-level scheme (panel/input, card,
dialog), not drift. Consolidating it would have flattened a real hierarchy, so
it is now **documented in §3** instead. Same for the padding spread: the
page-level containers are on the token; the ~300 inner paddings are local
spacing decisions, not a broken system.

### Verification

- `test/density.test.ts` (5 cases): resolution rules, the document attribute,
  **that every declared variable is read by a utility**, and that the nine page
  containers use `p-pad`. Stashing the CSS and component changes makes the last
  two fail — the gate is real.
- 18 Electron journeys pass, including the small-window matrix, which now
  measures a page whose padding follows density.
- typecheck, architecture, i18n assertion and Spec Kit gates and build passed.
  `npm test`: 4058 passed; the 16 shell/PTY files still fail on this machine
  against a clean HEAD.

## Manual QA walk: every view, every button (2026-10-23)

Walked the running app at 1440×1000, zh-TW, clicking every control in all
eleven views, the twelve settings pages, the titlebar and the status bar
(~260 clicks). Findings:

- Zero renderer errors, zero unhandled page errors across all of it.
- Every visible control has an accessible name (earlier "unnamed" inputs were
  `<label for>` associations the first probe missed).
- Main-view switches lag 7–35 ms; first entry into the terminal view takes
  ~330 ms while the lazy xterm chunk loads, with no loading indicator —
  recorded here rather than "fixed", because a spinner for a third of a
  second would be its own noise.
- The settings fixed footer (「修改會自動儲存」, 36 px) does not cover scrolled-up
  content: the `p-pad` bottom padding clears it (last element bottom 920, footer
  top 935).
- One real defect: the first-run entry button kept saying 「記我的 Zsh 終端」
  after Bash was chosen in the picker below it. `RecordTerminalFlow` now takes
  `onSelectedLabel` and `FirstRunView` renders it on the entry button, so the
  label can only ever match what actually installs. Pinned by a test in
  `test/first-run-record-terminal.test.tsx` (asserting both the stale and the
  updated label); `e2e/first-run.spec.ts` passes.

## Redundancy audit: nothing dead except what was pointed out (2026-10-23)

Four axes, mechanically checked against the running app and the sources:

1. **Dead strings.** 139 en / 138 zh keys matched no exact `t('key')` call, but
   every one resolves through a dynamic prefix (`t('marker.category.' + …)`).
   Removing exact-match-only dead keys would have deleted live text — the
   prefix check is what made the audit safe.
2. **Dead config.** Every leaf of `RedLogConfig` has a main/core reader except
   `engagement.focus` — removed from the UI and its readers in 7de4b9b6, but
   the field and its comment survived with nothing following the answer.
   Deleted the field. Everything else (from `clipboard.pollMs` to
   `agentTailer.emitThinking`) is read.
3. **Double editors.** No config leaf is edited from two places
   (`engagement.id` dupes in BrowserPanel/GeneralPage are write-context
   spread vs read-only display).
4. **Identical renderings.** 36 English keys share a value, but zh-TW renders
   35 of them differently — the keys are per-context by design, exactly why
   EN-side value-sharing is not consolidation-worthy. The one zh-TW match
   (「結果已達安全上限」) is two keys of one feature.

### Fixed from the same walk

- **「範圍 未設定」 becomes clickable.** The chip sat between
  fault-counter buttons that navigate and it sat still: a warning with no
  route to the lists that resolve it. It is now a button opening
  `settingsTarget('scope')` in all four states, with a 24×24 hit-area floor
  for the narrow bar (the first run of the hit-area check caught it at
  18×10 @150% — the new control had reproduced the exact bug the floor
  exists for).
- **HUD scale slider:** the value appeared twice (right-hand label +
  highlighted tick). The right-hand span is gone; tick labels and
  `aria-valuetext` stay.

## Manual page-by-page redundancy walk (2026-10-23)

Per the operator's instruction the audit switched from mechanical scans to a
manual inspection: the app was driven with seeded data (6 shell command pairs,
6 HTTP flows, 2 screenshots, a file artifact, 14 loot events, 3 markers) at
1440×1000 and every view, every detail state, and all 12 settings pages were
read one by one from screenshots, with the code behind each suspicion checked.

Findings, both visual and confirmed in source:

1. **Event-log band header repeated the view title.** The screen said
   攻擊時間軸 in the toolbar (Timeline.tsx) and again on every divider row of
   the log band below (TimelineEventLog). The band header now carries only the
   hidden-count toggle and the row count, right-aligned; the region is named
   once by the view title.
2. **Screenshots banner duplicated the title count.** 截圖 (2) with the banner
   已載入 2 張截圖 says the same thing twice; with more available the title
   already becomes 截圖 (2+), so the banner (removed together with its
   `screenshots.loaded` key) carried no state the title lacked.

Checked and explicitly kept, page by page: timeline filter panel (quick chips
plus custom range are complementary), the attribution-blind warning (a lost
join is not an empty result), transcript toolbar (every control is distinct:
counts, completeness, picker, type chips, selected-only, ordering, export),
HTTP chips (method/status/host), targets rows, loot cards, bookmarks empty
state (the bookmark-vs-marker / not-in-evidence-chain distinction is a
custody fact), dashboard cards, and all 12 settings pages whose hints state
consequences or fix paths (VPN regex list, IP-poll warning, trust-store
instructions, air-gap update copy).

Verified: typecheck, verify:i18n (129 removed strings unasserted), build,
e2e/ui-closeout 14 passed, timeline/screenshot unit tests 54 passed, full
suite same 16 baseline PTY-file failures (4059 passed).


## Friction fixes / T051–T054（2026-10-23）

Completed the six recorded first-run/navigation defects. Managed-proxy HTTPS
proof survives page unmounts only within its live process generation and CA;
Dashboard retains unverified state and core-to-settings links. Settings can
reopen the existing verifier. External-first onboarding and browser-path
selection remove competing instructions. CA search has an asynchronous stable
target, excludes unresolved templates and Mac WSL results, and short Latin
queries no longer match arbitrary substrings. Explicit capture-platform metadata
passes from validated manifests through hook detection to foreign-source
presentation; active producers remain visible.

Native isolated Mac: new synthetic project, wide/narrow first-run selection,
printf then Dashboard pending, health HTTP link and general setup route, CA
search from another settings page with real scroll/highlight, opening the
settings verifier, real loopback curl --cacert nonce proof, Dashboard verified
client, stop/start then proof invalidation, foreign card disclosure without
PowerShell actions. No system CA trust, AI activation or real-project capture.
Normal GUI exit was confirmed by process exit 0; Node SQLite restored.

RED: 3 failed / 55 passed for new behavior. GREEN: 12 files / 185 passed, then
2 affected files / 54 passed after adding one verified-client case and removing
the redundant command link for an HTTPS-only gap (186 distinct cases). Typecheck,
build, Spec Kit, architecture, i18n and diff checks passed. The final one-line
link condition was unit/build checked after the native walk, not separately
relaunched. Screenshots and detailed limits: manual-layout-20261023.md. Overall
Draft, T049 and cross-platform/install tasks remain open.


## Export copy closeout / T049（2026-10-23）

The three previously open copy defects are now fixed. Attachment totals use
Attachments, not HTTP bodies. Scope/source-chain boundaries stay; per-file
choice instructions remain on the actual list, and the cast warning only
appears for included casts. Boolean filter values are localized enabled/disabled,
false is retained and unset omitted, with no query or export-policy change.
Narrow preview labels do not shrink into vertical text beside long selections.

RED: three failures / 19 passed. GREEN: five files / 40 passed, including six
ui-copy cases already counted in the prior slice. Typecheck, build and final
gates passed. Native ~875×548 Mac checked current Timeline/JSON conditions and
warnings, whole-project Bundle with two casts, untick to one without changing
the 70-event count, and the final label geometry after reload. Canceled all
previews; did not execute export. Normal GUI exit 0; restored Node SQLite.
T049 is closed; earlier statements of it being open describe those earlier
slices. Overall Draft and cross-platform/install/artifact acceptance stay open.

## First-run responsive width / T055（2026-10-23）

The user screenshot exposed a missed layout constraint: both the operational
overview and its built-in terminal fallback still used max-w-3xl (48rem).
Removed these caps. The two existing core setup blocks now use a container-
responsive grid, retaining a single column when two readable columns do not fit.
Shared status/footer content and the built-in fallback stay below the grid.
No capture, verification, routing or export behavior changed.

Native isolated Mac: new synthetic project, actual window resizing via native
window controls, narrow single-column setup, wide side-by-side setup and wide
expanded fallback. No horizontal clipping observed in these states. Saved the
single-column and two-column screenshots locally; the expanded fallback was
visually inspected before a later screenshot-saving attempt failed in the OS
capture service. This is not a product crash or saved screenshot. Normal Quit
and Stop/Exit confirmed process exit 0; restored Node SQLite runtime.

Typecheck, production build and three related test files (62 passed) completed.
No duplicate CSS-shape tests added for this reversible geometry change. Full
Spec remains Draft; this does not close installer, external-shell or artifact
acceptance. Details and local evidence: manual-layout-20261023.md.

## Native export artifacts / T056–T057（2026-10-23）

Source-build Mac, isolated existing synthetic project, native UI actions only
for selection/confirmation/reveal. Search layout-check → JSON and NDJSON each
delivered the same two event IDs with expected command_start/end, stdout,
stderr and exit 0. Finder selected the just-created JSON and showed its content.
Both manifests retained the query, counts and observed preview fingerprints.

Whole-project Bundle, exclude one of two casts: the initial artifact correctly
excluded the file but implicitly replaced operator identifiers in the other
cast (3414 source bytes → 3421 delivered bytes), despite piiScrubbing:false.
The new public IPC regression reproduced that defect (1 failed / 31 passed).
Removed the obsolete scrubCast helper and its seven implementation-specific
tests. Bundle now copies the approved prefix bytes with bounded memory; the
regression also covers Unicode beyond a chunk and post-preview growth. Existing
freeze, rewrite, truncation and exclusion cases remain. No capability or default
privacy flag was added; bundles can contain operator identifiers as the UI says.

After rebuilding, native export produced bundle-2026-10-23T09-53-57: 78 total
events, one cast included, one excluded, fingerprint 1bcc2b114dbf matching the
preview. Delivered cast is byte-identical to the 3414-byte source. Packaged
verifier exit 0: chain intact/head matched, 70 signatures verified, 8 logged
supporting rows, six evidence-file digests verified. The additional four events
since the earlier 74-event bundle are project lifecycle records from restarting
the candidate, not an unexplained widening of a frozen plan.

HTTP 4xx → HAR: one POST/404 exchange, URL case=2 and expected inline request/
response bodies, two selected events, fingerprint 56fc6188b0bd matched artifact
manifest. These are existing synthetic flows, not live network-capture proof.
The native preview exposed an empty HTTP text condition. A failing summary
case (1 failed / 8 passed) preceded the display-only fix; the final rebuilt
native preview retained status prefix 4 and omitted the blank control. Canceled
this final preview; no additional artifact was claimed.

GREEN: eight export-related files / 96 tests, then three affected summary/dialog/
copy files / 26 tests (11 overlap, 111 distinct). Typecheck, build, Spec Kit,
architecture, i18n and diff checks passed. Two native sessions quit normally
(exit 0); Node SQLite restored. No new global shell/CA/plugin authorization or
real-project changes. Details, artifact names and limits are in the manual
layout report. Overall Draft and T008–T013 remain open; this bounded Mac check
does not complete all M20–M25 scenarios or cross-platform installation.

## Prompt diagnosis and truthful shell status / T058（2026-10-23）

Isolated real Zsh PTYs reproduced first-custom-then-Powerlevel10k prompt changes
with no RedLog, the previously installed hook and the current hook. Powerlevel10k
alone stayed stable with/without the hook. This is a local dual-prompt conflict,
not evidence that RedLog rewrites PROMPT. The authorized local correction removes
only the competing precmd registration (with a backup and syntax check); no
theme policy was added to the product.

Product defects reproduced first: seven failing announcement/status/start cases,
plus a failing no-project replay-warning case. Human status now shows missing
project/operator identity explicitly; an enabled switch is not an acknowledged
delivery. Start preserves the existing project-switch refusal, reports that
actual state and does not emit capture_resumed for a terminal that stayed stopped.
The enrollment JSON and TS/Python transition rules were not changed.

GREEN: 12 files / 80 tests, including real PTY auto output, command exit statuses,
stop/start, source-once, spool, transport, pager/failure behavior and TS/Python
agreement. The first combined run was blocked by sandbox listener EPERM and was
stopped; the same cases passed outside the sandbox. Typecheck, shell syntax,
Spec Kit, architecture, i18n and diff checks passed. This is not Windows terminal
acceptance or a full unit run.

After backing up code, synchronized the existing local Zsh adapter/common/relay
files; preserved custom classification, session helper, identity and evidence.
Byte comparisons confirmed they match the tested sources. A fresh isolated PTY
with the caller's Powerlevel10k configuration and these installed files retained
Powerlevel10k across seven stages, with no custom prompt, and status/start both
reported no project. It did not source the caller's full rc or manipulate an
already-open terminal. Existing terminals need a new tab to load the new adapter.
Local-only transcripts: /private/tmp/redlog-prompt-diagnosis/. No private shell
configuration or transcript is added to the repository. Overall Draft remains.

## Measured performance / T059（2026-10-23）

Local synthetic measurements on Apple M2 Pro, 16 GiB, Node v26.12.1 and Python
3.15. Ordinary Zsh no-output command overhead median fell 216 → 169 ms after
deferring relay imports; one-line output 206 → 185 ms. Complete before/after
PTY benchmark runs each passed three cases and required command_end delivery.
An interleaved A/B check supported the import improvement. The separate
shorter-poll experiment had no repeatable benefit and was reverted; drain
windows and capture limits are unchanged.

HTTP selection was sorting full body-bearing JSON. Ranking metadata first and
then reading complete selected evidence reduced a 5,000-flow / ~40 MB fixture's
first 500-flow query from 331.34 → 79.75 ms; independent after rerun 86.5 ms.
4xx selection fell 311.20 → 81.90 ms (rerun 81.7 ms). The new public behavior
case passed on the original query before optimization and preserves request/
response choice, duplicate evidence, Unicode bodies and snapshot boundaries.
The opt-in benchmark verifies complete returned rows/bodies; no shared-CI
hardware promise was introduced. Existing 100k-event query budgets passed all
nine cases. Settings lookup CPU 0.022–0.070 ms did not justify adding a cache;
native settings navigation/rendering was not timed.

GREEN: six HTTP/query/export files / 59 tests (includes two body-heavy benchmark
cases); ten shell files / 80 tests, covering separated streams, exit codes,
large output, late delivery, spool, debug logging, transparent degradation and
PTY boundaries. Six traditional-netcat upgrade cases were skipped because the
Mac host lacks Kali's nc v1.10; this is not new Kali/Windows acceptance.
Typecheck, Spec Kit, architecture, i18n, production build and diff checks passed.
No full unit, native rendering or packaged-install claim is made.

Backed up the installed relay to
~/.redlog/backups/relay-perf-20261023-183525, synchronized only that helper and
verified byte equality with the tested source. No running user relay was killed
and no profile, custom classification, session helper, identity or evidence was
changed. HTTP optimization is in the source build; an already-running installed
App is not silently upgraded. Full reproducible results and limitations:
[performance-20261023.md](performance-20261023.md). Overall Draft and T008–T013
remain open.

## Push gate follow-up（2026-10-23）

The first full unit run exposed five failures across four files: the defaults
classifier test read the operator's real class overlay; two background-output
search assertions omitted the now-visible unknown exit code; and two first-run
assertions still required the removed quick-test helper paragraph. Use a
temporary home for default classification and align the UI assertions with the
external-terminal action/exit title. Retain classification agreement, overlay
merge, blocker recovery, search de-duplication and command navigation checks.
The affected four files then passed 27 focused cases. No operator policy or
production behavior was changed to satisfy these assertions.

Four source-build Electron suites covered capture-settings-interaction,
first-run, http-history-view and export-preview. An old first-run assertion
expected the other-source page instead of the terminal settings now used by the
Dashboard. Corrected the expected settings target and reran the complete serial
first-run suite, including its previously skipped final terminal re-entry case.
All 24 distinct cases passed across the initial run and that rerun. This is
automated isolated Mac workflow coverage, separate from the earlier manual
layout checks; it is not packaged or cross-platform acceptance. SQLite was
switched to Electron only for these suites and the final npm test pretest
restores the Node runtime. Final full-gate results follow below.

Final ordered push gates passed: typecheck → Spec Kit → architecture → i18n →
npm test. Full unit result: 416 files / 4,167 tests passed; five files / 28
cases skipped by existing platform/opt-in guards, including the new HTTP
performance benchmark. Its opt-in timing run is recorded separately above.
No retries were enabled in the final full run. Source build and diff checks
also passed. This closes the bounded push validation, not the open installer
and cross-platform acceptance matrix.
