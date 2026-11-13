# Tasks: 來源描述、單一狀態模型與外掛 manifest v2

**Input**：[spec.md](spec.md)、[plan.md](plan.md)

**規則**：

- 每個 Phase 結束時 main 都可出貨，並以列出的 gate 收尾。
- 第一個 Phase 只加測試與 gate，不改行為；之後每個行為改變先寫 RED（以 `it.fails` 標示），同一個 PR 翻正。
- 改變契約的 PR 一併修改斷言舊契約的 test、e2e 與 spec（CLAUDE.md「Changing behaviour」）。
- `[P]` 表示可平行（不同檔案、沒有相依）。`[USn]` 對應 spec 的故事。`[真機]` 表示需要真實 app、真實 shell 或特定平台，不能以單元測試代替。
- 每次 push 前依序跑五道 gate：`npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n && npm test`。
- `main/index.ts` 同時只能有一人修改。

## Phase 0 — 工作流程前置

- [ ] T001 依憲章對本功能（跨層契約：API 欄位、manifest 公開契約、證據歸屬）執行 Clarify、Checklist、Analyze，結果記入 `verification.md` 的 Gates。
- [ ] T002 確認進行中分支 `work/1112-plugsafe`（`hash-changed`、`contentStillApproved`、bundled id 保留、使用者步驟需核准、`requiresAll`）是否已合併；未合併時，Spec 076 的 T023（原本這裡 Phase 7 的 T073）以它的行為為 RED 測試的期望，並與其作者協調檔案歸屬（`loader.ts`、`manifest.ts`、`hooks-manager.ts`）。
- [ ] T003 確認 plan「對姊妹規格的需求與提供」中每一個名稱仍與兄弟規格一致（2026-11-12 已對帳：071 接受 `/api/whoami` 與 `_ingest.rules`；憑證改為機器層加專案層政策；`detached` 的傳遞仍待 071 定義）；之後的差異記入 `verification.md`。跨 071–075 的順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」。

## Phase 1 — 釘住今天的行為（只加測試與 gate）

- [ ] T004 [P] `test/capture-payload-golden.test.ts`：以 8 種固定事實組合（新專案無 hook、有 hook、缺 python3、proxy 失敗、外掛停用仍在送、AI 相對路徑、HTTPS 未驗證、chain 抽樣失敗）呼叫 `getCaptureHealth`，釘住今天的 `verdict` 與每列 `state`。
- [ ] T005 [P] [US2] `test/source-surface-agreement.test.tsx`：對同一份 payload 渲染 9 個 surface（儀表板卡、狀態列、指令與終端、HTTP、擷取控制、外掛詳情、首次使用、HUD、pane 徽章），記錄每個來源今天顯示的字。今天不一致的組合以 `it.fails` 標示；同時重新計數 renderer 受影響的檔案，更新 plan 的估計。
- [ ] T006 [P] G2 ratchet：`test/source-status-boundary.test.ts`，基準 20（plan「要取代的判斷」J1–J7、S1–S13），只能下降；形式同 `test/mutation-guard.test.ts`。
- [ ] T007 [P] G5 的 shell 名稱字面陣列 ratchet，基準 9（plan「現況」的清單；先開檔確認 `wsl-manager.ts:288`）。
- [ ] T008 [P] G4：`test/source-owner-actions.test.ts`，以今天呼叫 `hooks.install|uninstall`、`httpCapture.start|stop`、`plugins.setEnabled|grant|revoke`、寫 `packs`／`packMembers`／`agentTailer.sources` 的檔案為允許清單，只能變短。
- [ ] T009 [P] G7 雛形：`test/plugin-manifest-consumers.test.ts`，以今天的 `PluginManifest` 欄位為對象，列出沒有讀者的欄位（`kind`、`capabilities` 的行為、`signature`、`publisher`、`schemaVersion`、頂層 `emits`、`health`、`homepage`）為允許清單，只能變短。
- [ ] T010 [P] [US1] RED：新專案無 hook 時整體應為等待第一筆事件（今天 `dark`，`test/capture-health.test.ts:65` 釘住相反的契約）；有 hook 的機器上的新專案應與無 hook 時相同。`it.fails`。
- [ ] T011 [P] [US3] RED：POSIX 缺 python3 時內建終端機不應為 ready（04-U6a）；外掛停用後仍收到事件應為失敗。`it.fails`。
- [ ] T012 [P] [US2] 特徵化：`test/cli-status-words.test.ts` 釘住今天 CLI 對每種 verdict 的輸出（含 `wired but idle`）；`test/api-status-compat.test.ts` 釘住 `/api/status` 的 `capture` 形狀。
- **Gate**：五道 gate 全綠；新測試在三個平台的 unit leg 都有執行，或記為 not-run 並附原因。

## Phase 2 — 模型進核心，介面不變

- [ ] T020 [P] `src/core/sources/vocabulary.ts`：8＋4 個狀態碼、理由碼（41 個，含 073 要求的 `project-archived`、`bound-elsewhere`、`consent-scope-changed`、`hook-file-missing`）、動作碼（plan「理由與動作」）。
- [ ] T021 [P] `src/core/sources/descriptor.ts`：型別與 `BUILTIN_SOURCES`（涵蓋今天 capture-health 的每一列，加上每個 shell adapter）；`descriptorFromManifest` 先接今天的 v1 capture 形狀。G5 的「每個收集到事實的來源都有描述」轉綠。
- [ ] T022 [US1] [US3] RED → GREEN：`src/core/sources/status.ts` 與 `test/source-status-table.test.ts`（決策表每列至少一案例，G1）。
- [ ] T023 [P] `test/source-status-property.test.ts`：固定種子隨機事實 ≥10,000 組；決定性、整體不取最壞、非 attention 不改整體、寬限期內暫時性失敗不為 failed（SC-001）。
- [ ] T024 `capture-health.ts` 改成事實收集器：`collectSourceFacts` 以今天的對等來源產生事實（探針、`installed`、heartbeat 列、`noteCaptureError`、prerequisite provider、`resolveAgentCapture`），尚未有來源的事實（071、073）保持缺席並標理由；`createOfficialAgentPluginManager` 在本檔只建立一次。J1、S1 由收集器與純函式取代，G2 −2。
- [ ] T025 payload 同時帶舊欄位與 `v: 2` 欄位（`overall`、`statuses`、`integrity`、`paused`）；bridge 型別 `env.d.ts` 的 `statuses[i].facts` 為 readonly 不透明型別。
- [ ] T026 等價測試：以 T004 的 8 種組合與 `test/capture-health.test.ts` 的怪列矩陣，列出新舊對照，每一個差異寫明對應的 FR（例如新專案 dark → waiting：FR-015、FR-017）。
- [ ] T027 [P] G0：`sources/status.ts`、`vocabulary.ts` 的匯入限制；`status.ts` 只能被 `capture-health.ts` 與測試匯入。
- **Gate**：五道 gate；T004 的 golden 不變（舊欄位）；`verify:architecture` 對新匯出無 unused。

## Phase 3 — 整體換源（契約變更）

- [ ] T030 [US2] RED → GREEN：`captureIssueView` 與 `sourceTarget`（`captureIssue.ts:15-37`）刪除；每個 attention 來源一則 issue（`source:<id>`），目的地讀 `owner`。同 PR 改 `test/capture-issue-route.test.tsx`。G2 −1。
- [ ] T031 [US1] StatusBar：dot、label、tooltip 讀 `overall`；issue 依 T030；toast 只在來源進入 attention 且過寬限期時；issue 狀態以專案為範圍（依 073 的 `ProjectSession`，未落地前以 project id 為鍵重置）。同 PR 改 `statusbar-narrow.test.tsx`、`capture-health-unknown.test.tsx`。G2 −1。`[真機]`：從有事件的專案切到新專案，無 toast（04-U1）。
- [ ] T032 [P] RecordingWorkspace 的來源警示讀 `statuses.filter(attention)`；同 PR 改 `recording-workspace.test.tsx`。G2 −1。
- [ ] T033 [P] [US2] CLI 印英文狀態字與整體字；T012 翻正。`shell/redlog-agent.sh` 與 agent skill 的讀法同步。G2 −1。
- [ ] T034 `/api/status`、`/api/capture`：新欄位 `capture.v/overall/statuses`；舊欄位依 plan「舊欄位對映」，標 deprecated 一個 minor 版本；更新 `docs/codex-tools.json`、`docs/api-reference.md`。
- [ ] T035 [US1] 完整性移出整體：chain 抽樣與 DB 寫入改走 StatusBar 既有的完整性 issue；T010 翻正；同 PR 改 `test/capture-health.test.ts:65` 等釘住舊契約的案例、`capture-readiness.test.ts`、`capture-onboarding-render.test.tsx`。
- [ ] T036 修訂 `README.md:247`；`docs/UIUX-STANDARD.md:342` 與 FR-016 的差異是 spec 的開放問題 Q1（AGENTS.md：不自行判定），擁有者答覆後依答覆修訂標準或本規格，記入 verification。
- **Gate**：五道 gate；e2e（ubuntu）中斷言舊整體字的 spec 同 PR 修改（以 `verify:i18n` 與 grep `data-capture` 的結果為準，候選見 Phase 6 T061）。`[真機]` 狀態列在新專案、缺 python3、proxy 埠被占用三種情況的截圖與 payload 對照。

## Phase 4 — 儀表板卡與 HTTP

> **裁定（2026-11-13，DECISIONS §8 第 9 項）**：儀表板移除，不替它接新的狀態模型。T040 的對象改為
> 活動紀錄頂端的狀態讀數與其展開區（DECISIONS §4）：要刪的判斷與要改的測試不變，渲染的位置改變。
> 儀表板頁面本身的移除屬導覽收斂，不在本規格。T041、T042 不受影響。

- [ ] T040 [US2] CaptureHealthCard 只渲染 `statuses` 與 `overall`：刪 `coreCommandState`、`ownShellKey`、`isRogue`、`isProblem`、`isAgentRow`、`dark`／`partial`／`coreGap`／`healthyGap`、7 處 `settingsTarget(...)` 對照；指令列以 shell 群組呈現（D5）。同 PR 改 `capture-core-commands-own-shell`、`capture-source-rows`、`capture-health-prerequisite-card`、`capture-health-proxy-failed`、`capture-health-unrecorded-card` 等測試。G2 −4（J2、S2、S10、S13）。
- [ ] T041 [US4] HTTP client 事實：收集器從本專案的 flow 推出 client（UA 族群、socket 歸因的行程名稱），產生四個事實；擷取瀏覽器 proxy 非受管端點的事實。先 RED（`test/http-client-facts.test.ts`，US4 的四個情境）。
- [ ] T042 [US4] HTTP 列、`HttpCaptureStep`、`BrowserPage` 的驗證面板改為同一元件、讀同一份狀態；刪 `httpCaptureState`、兩份「已驗證」（`CaptureHealth.tsx:143`、`HttpCaptureStep.tsx:255`）。同 PR 改 `http-capture-state.test.ts`、`capture-http-row.test.tsx`、`capture-browser-check-caveat.test.tsx`、`http-ca-trust-label.test.tsx`。G2 −2。
- **Gate**：五道 gate。`[真機]` macOS：裝好 hook、驗證過 HTTPS 的機器重開 app 20 次，整體無一次為需要處理或黃色（SC-002）；真實瀏覽器、curl、另一個 proxy 以 RedLog 為上游，各自的 client 事實（09-F9 的驗證）。

## Phase 5 — 設定列、外掛詳情與動作的唯一位置

- [ ] T050 [US3] HooksPanel：每個 shell 一列，讀 `statuses`；`configured` 在 073 的安裝帳本落地前沿用 `checkInstalled` 並帶 `install-record-missing` 理由；落地後改讀 `hookLine(shell)`。刪「已安裝／未安裝」判斷（S8）；「停用」改為「移除」。G2 −1。
- [ ] T051 [P] [US2] `pluginViewModel.officialProjectLevel/officialHealth` 與 `AgentsPanel.projectRecording` 刪除，改讀 AI 來源的狀態；外掛詳情的五個維度縮為「信任」「生效」，專案與健康改為連到來源列（Spec 065 FR-021 的取代記入 065）。同 PR 改 `plugin-view-model.test.ts`、`agent-sources-panel.test.tsx`、`plugin-integration-panel.test.tsx`。G2 −2（S5、S6）。
- [ ] T052 [P] ExternalCaptureGroup：刪 `stateLabel` 鏈與 `ExternalCaptureGroup.tsx:108` 的 regex；依賴來自描述的結構化前置條件。同 PR 改 `external-capture.test.ts`、`e2e/capture-settings-interaction.spec.ts`。G2 −1。
- [ ] T053 [P] 終端機 pane 徽章讀內建終端機與該 pane 的事實，字對齊八個狀態；刪 `terminal.meta.hookOn/hookOff`。G2 −1。
- [ ] T054 [US6] 刪重複的動作（04 §4 清單 1–9）：卡片的安裝 cta 與 manage 模式的安裝／移除／開關；`CapturePackGroup.tsx:110-112` 的「修復」；HTTP 的第二份啟停 handler。G4 的允許清單縮短到每個來源只剩 owner。
- [ ] T055 [P] 前置條件的 6 份表改讀描述（`hooks-manager.ts` 的 `requiresAll`／`checkAvailable` 特例、`runtime-preflight.ts:96`、`terminalActivation.ts:18`、`CapturePreparation.tsx:13-18`、`capture-prerequisites.ts`、T052 的 regex）。
- [ ] T056 [P] shell 清單的 9 份改讀描述的 `shell` 欄位；G5 shell 陣列 ratchet 降到 0。`[真機]` Windows：Git Bash 不再出現在裝不起來的選擇器（09-F3）。
- **Gate**：五道 gate；G2 ≤ 3（只剩 Phase 6 的 J7、S4、S12）。`[真機]` 設定的三個頁面與外掛詳情的截圖與 payload 對照；04-U4（AI 相對路徑）在每個 surface 說同一個字。

## Phase 6 — 首次使用與文案

- [ ] T060 [US1] 首次使用改為儀表板同一份來源清單、預設展開；刪 `coreCaptureReady`、`commandsVerification`、`computeCaptureReadiness`、`primaryCaptureAction`；preflight 與偵測在背景，列先以無法確認畫出。同 PR 改 `core-capture.test.tsx`、`capture-readiness.test.ts`、`first-run-record-terminal.test.tsx`、`capture-preparation.test.tsx`、`e2e/first-run.spec.ts`。G2 −2。
- [ ] T061 退役 plan 所列的 101 個 i18n key，新增至多 58 個；`verify:i18n` 列出的每個 test／e2e 同 PR 修改。候選 e2e（依 2026-11-12 的 grep，以 `verify:i18n` 為準）：`app-shell`、`capture-settings-interaction`、`first-run`、`external-session`、`official-agent-capture`、`network-state-recovery`、`plugin-explore`、`terminal-enrollment`、`visual-reference`、`managed-http-capture`、`dependency-cancel`、`packaged-dependency-install`、`layout-read-states`、`screenshot-capture`、`hud-overlay`、`timeline-track`、`uiux-convergence`、`packaged-smoke`。
- [ ] T062 [P] 刪 `src/core/capture-contract.ts`（`captureFacts`）。G2 降到 0。
- [ ] T063 [P] G3：`test/source-status-vocabulary.test.ts` 轉綠；`test/ui-copy.test.ts` 通過。
- [ ] T064 shell 內 `redlog status` 印本 shell 的狀態字（讀 071 FR-07B 的 `/api/whoami`，071 T060；未落地時印本地事實並標無法確認）。
- **Gate**：五道 gate；G2 = 0；每個語系淨 key 數下降（SC-009）。`[真機]` Linux 容器移除 python3 的新專案（04-U6a）、fish 為預設 shell 的 pane（U6b）；macOS 螢幕錄製權限未決定與拒絕（U7）；Windows Restricted 執行原則（U8）。

## Phase 7 — Manifest v2

> **裁定（2026-11-13，DECISIONS §8 第 8 項）**：T070–T074 已移除，由 Spec 076 的任務承接：
> T070（schema 與驗證器）→ 076 T020、T022；T071（v1 與新 manifest 轉成內部形狀）→ 076 T022、T029；
> T072（每個欄位都有讀者）→ 076 T022；T073（內容雜湊涵蓋 `files`）→ 076 T023；T074（bundled 改寫）→ 076 T030。
> 下面四個在 076 沒有對應任務，留在這裡：刪除三個 pack 與 `STARTER_PACK_FALLBACK`（T075）、
> `state.json` 的停用旗標（T076）、`optional-plugins` 不再被讀成 pack（T077）、v1 遷移的 fixture（T078）。
> T072 原本要清空的 T009 允許清單，改由 076 T022 完成時清空。

- [ ] T075 刪 `plugins/starter-pack`、`plugins/pack-host-monitors`、`plugins/pack-windows-output`；`hooks-manager.ts` 的內建 producer 改讀描述表，刪 `STARTER_PACK_FALLBACK` 與 parity 測試；`isPackAvailable` 不再看外掛；同 PR 修訂 Spec 035 FR-001／002 與 `capture-packs.ts:1-10`、`capture-health.ts:736-746` 的註解，改寫 `starter-pack.test.ts`、`capture-packs.test.ts`、`capture-pack-group.test.tsx`。`verify:package-resources` 的清單同步（release-only gate）。
- [ ] T076 [P] `state.json` 中 bundled pack 與 starter-pack 的停用旗標轉成一次性通知並刪除；使用者外掛與 `builtin-tools` 的旗標保留（FR-072）。
- [ ] T077 `optional-plugins/*/plugin.json` 不再被通用 loader 讀成 `kind: pack`；官方 AI 來源改由描述表提供（載入路徑與收據轉換屬 Spec 073，協調同一版本出貨）。
- [ ] T078 [US5] G10：`test/manifest-v1-migration.test.ts`，8 種機器狀態 fixture（含已核准的 v1 使用者外掛、已安裝的 v1 `shell-source` capture、停用的 pack、官方 AI 已安裝與 `update-available`）；斷言無靜默停止、grant 不失效（SC-006）。
- **Gate**：五道 gate；G6、G7、G9、G10 綠。`[真機]` 打包版升級：有 pack 停用旗標與已安裝官方 AI 的機器，升級後每個來源的狀態與理由。

## Phase 8 — 生命週期與動作

- [ ] T080 [US6] 原生核准對話框：`plugins:grant(id, expectedHash)`，main 顯示前與確認後各驗一次；刪 renderer 的核准對話框與 capabilities 清單；trust grant 不再記錄專案 operator id。
- [ ] T081 提權步驟只執行 root 擁有的複本（同一次提權內複製、驗證 sha256、執行）；G9 驗證包裝。`[真機]` macOS 與 Linux：以非 root 使用者修改 hook 檔後執行顯示的步驟必須失敗並說明原因；Windows 的 `-ExecutionPolicy Bypass` 步驟同樣處理。
- [ ] T082 [US6] 擷取控制的來源列提供「在此專案記錄」；第一次在任一專案啟用時呼叫 071 T045 發放機器層的 `plugin:<id>` 憑證，機器層停用、撤銷、雜湊改變、移除時撤銷；專案層的 `on`／`off` 只寫 `enabledForProject`，由 071 FR-07A 強制（FR-076）；`writing-while-off` 改由「停用後被拒」計數判定。
- [ ] T083 [US6] 官方 AI：每個專案第一次啟用時由該專案的來源列觸發原生同意對話框（P4；儲存屬 073 T084）；外掛頁只保留撤回；刪 AgentsPanel 的「到外掛頁安裝／更新」與 `update-available` 的文案；同 PR 修訂 Spec 066 FR-001–005、010、011 與 067 US8、US9、FR-010–013 的狀態註記。
- [ ] T084 [US6] 移除：外掛頁呼叫 073 的 `revert(owner)`，結果列出已收回與無法收回；`residue` 事實接上。
- [ ] T085 [US6] e2e（ubuntu）計數「Claude Code 在本專案被記錄」與「pcap 在本專案記錄」的點擊與頁面（SC-007），取代 plan 表中的估計。
- **Gate**：五道 gate。`[真機]` 打包版（mac、Windows）：官方 AI 從 app 本體執行，換一版 adapter 後仍在記錄；pcap 在 sudo 下的完整流程（未設定 → 未啟動 → 待命 → 記錄中 → 停用後仍送 → 失敗）。

## Phase 9 — Processor

- [ ] T090 RED → GREEN：`test/processor-budget.test.ts`（G8）k = 1、4、16 條病態規則；每事件共用 deadline，取代 `bounded-regex.ts:125-140` 的「停一條、再跑一趟」。
- [ ] T091 寫入路徑上的推導帶 `_ingest.rules`／`_ingest.rules_partial`（071 FR-005、FR-006 的有界形式；071 T020 的測試已涵蓋大小上限，本任務填值並斷言內容）；同 PR 更新 `docs/domain/SPEC-ingestion-contract.md` 中 `_ingest` 的欄位說明（若 071 T080 已建立）。
- [ ] T092 [P] 載入時拒絕已知非線性形狀（巢狀量詞、backreference）；沿用 `test/secret-patterns-linear.test.ts` 的方法。
- [ ] T093 [P] 被停的規則保留到內容雜湊改變並出現在外掛詳情；同 PR 修訂 Spec 033 FR-003／004。
- **Gate**：五道 gate；G8 綠。

## Phase 10 — 開發者體驗與文件

- [ ] T095 [P] [US7] `redlog-cli plugin check <dir>`（FR-080）。
- [ ] T096 [P] [US7] 一致性工具組：沿用 Spec 071 的向量與 mock receiver，加上 `emits` 範圍；Processor 的 `testSample` CLI。
- [ ] T097 [US7] 改寫 `docs/plugin-development.md`（FR-083 的每一項）；欄位參考由 schema 產生；G12 綠。
- [ ] T098 [P] 修訂 `DESIGN-plugin-kernel.md` §1、§2、manifest 草案、§5；`types.ts` 的不實註解；glossary 加入 Source Descriptor、Source Fact、Source State、Overall State、Client Facts、Manifest v2。
- [ ] T099 [P] 修訂 Spec 070 的 FR-001–004、FR-006、US2 的狀態註記；Spec 052 FR-015 的措辭；Spec 065 FR-021。
- **Gate**：五道 gate；`verify:specs`。

## Phase 11 — 驗收

- [ ] T100 建立 `verification.md`（依 `.specify/templates/overrides/verification-template.md`），分「已決定／已實作／已驗證」三欄；RED（T010、T011、T022、T030、T041、T073、T090 失敗的原因）、GREEN、Gates。
- [ ] T101 [真機] 端到端擷取可信度：zsh（含 `ZDOTDIR`）、macOS Terminal.app 的 bash、PowerShell 5.1／7 與 VS Code host、WSL、受管 proxy 加真實瀏覽器與 curl、sudo 下的 pcap、Claude Code 對話；每一項記錄狀態字的序列與失敗注入（拆掉 hook、`PROMPT_COMMAND` 被覆寫、停用後繼續送、埠被占用）。沒有環境時記 NOT RUN 與原因。
- [ ] T102 [真機] 介面：plan「驗收」第 2 條列出的每個 surface 截圖與同一時刻的 payload 對照。
- [ ] T103 更新 `specs/README.md` 索引；全部完成並驗證前，Spec 075 維持 Draft。

## Dependencies & Execution Order

- Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 依序；Phase 7 可在 Phase 2 之後與 3–6 平行（不同檔案；T075 與 T055 都改 `hooks-manager.ts`，不可同時）。Phase 7 剩下的 T075–T078 依賴 Spec 076 Phase 2、3（原 T070–T074 的承接者）。
- Phase 8 依賴 Phase 7，以及 Spec 071（憑證）與 Spec 073（同意紀錄、安裝帳本）的對應部分。
- Phase 9 依賴 Spec 071 Phase 3 的蓋章（`_ingest.rules` 已由 071 接受）。
- Phase 6 的 T064 讀 071 T060；決策表 F6（`detached`）在 071 定義傳遞方式之前不會成立（spec 開放問題下的注記）。
- Phase 1 全部可平行；Phase 2 的 T020、T021、T027 可平行；Phase 4 的 T041 可與 T040 平行。
- 需要其他平台或真機的任務：T031、T042 的 Gate、T050、T056、Phase 6 Gate、T078 Gate、T081、Phase 8 Gate、T101、T102。

## 明確排除

見 spec「不在範圍」。
