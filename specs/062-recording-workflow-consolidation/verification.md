# Verification: Recording workflow consolidation

Overall status remains Draft. Existing bounded Mac acceptance and three prior fixes: see mac-acceptance-20261021.md and fix-verification.md. This record covers the US6 and US5 implementation slices, not a claim that all stories or platforms passed.

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
