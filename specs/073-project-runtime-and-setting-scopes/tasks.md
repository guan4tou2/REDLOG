# Tasks: 專案執行期、設定層級與安裝帳本

**Input**：[spec.md](spec.md)、[plan.md](plan.md)

**規則**：

- 每個 Phase 結束時 main 都可出貨，並以列出的 gate 收尾。
- 每個行為任務都先寫 RED（`it.fails`／`test.fail` 標示預期失敗的原因），再實作並翻正。
- `[P]` 表示可平行（不同檔案、沒有相依）。**任何改動 `src/main/index.ts` 的任務都不標 `[P]`**：一次只能有一個人改它（DESIGN-project-runtime §4）。
- `[USn]` 對應 spec 的故事。`[env:…]` 標示需要的環境：`mac`、`linux`、`win`、`wsl`、`real-shell`、`app`（實際啟動 Electron 檢查畫面）、`packaged`（打包版）。
- 每次 push 前依序跑五道 gate：`npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n && npm test`。
- 改動 e2e 會斷言的行為時，該 e2e spec 屬於同一個變更（CLAUDE.md「Changing behaviour」）。

## Phase 0 — 工作流程前置

- [ ] T001 依憲章（專案歸屬、證據路徑）執行 Clarify、Checklist、Analyze，結果記入 `verification.md`；spec「開放問題」Q1–Q5 取得擁有者答覆。Q1 未答覆前 Phase 5 的 T054 不開始；其餘 Phase 不受阻。（2026-11-13：Q1–Q5 已裁定，DECISIONS §9；Q4 的答覆與建議不同，見修訂 B7。新增的 Q6、Q7 答覆前，T04B 依建議進行。）跨 071–075 的順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」。

## Phase 1 — 釘住今天的行為（只加測試與 gate，不改程式行為）

- [x] T002 [P] module-state gate：`scripts/verify-architecture.mjs` 新增規則，`scripts/module-state-allowlist.json` 列出今天每一個模組層 `let`／`var`／以 `new`、`[]`、`create*()` 初始化的 `const`（`src/core/**`、`src/main/**`），分類為 `app`／`machine`／`constant`／`test-seam`／`project-legacy`，各附理由。`project-legacy` 的數目記為基準。加入 gate 自身的反向測試（放一個未登記的 `let`，gate 失敗）。
- [x] T003 [P] `test/config-direct-read.test.ts`：`loadConfig(` 在 `src/core/config.ts`、`src/main/config-store.ts` 以外的出現數，基準 36，只能下降。
- [x] T004 [P] `test/stop-project-order.characterization.test.ts`：以替身記錄 `stopProject` 今天的 27 個步驟順序與 `startProjectResources` 的開啟順序（含 `OPEN_SEQUENCE` hooks），存成 golden。Phase 3 的資源順序快照以它為對照。
- [ ] T005 [P] `src/core/settings-registry.ts` 與 `test/settings-registry-complete.test.ts`：以 TS compiler 走訪 `RedLogConfig` 的葉節點，每個都在登記表中，附歸屬範圍（plan「設定歸屬表」）。只是資料，沒有讀者。 （2026-11-13：未做。它要新增一個尚無讀者的 `src/core/settings-registry.ts`，Phase 1 不改正式程式碼，且未被讀取的匯出會被 verify:architecture 擋下；延到第一個讀它的階段）
- [x] T006 [P] `LEGACY_V1_DEFAULTS`：凍結目前的 `DEFAULT_CONFIG` 副本；`test/fixtures/config-legacy/` 放 10 份由目前 main 產生的 `config.yaml`（預設、改過 operator、改過 port、改過 personalDomains、含 `overlay` 舊區塊、含 `packMembers` 缺省等），並記錄目前 `loadConfig` 的結果為 golden。
- [x] T007 [P] [US2] RED：`test/open-never-writes-config.test.ts`。(a) 開啟一個合法專案後 `config.yaml` 的位元組改變（今天會，因為 `index.ts:782`）；(b) 開啟一個 YAML 壞掉的專案後，檔案被預設值覆蓋。兩者以 `it.fails` 標示。
- [x] T008 [P] [US3] RED：`test/airgap-live.test.ts`。專案開著時以 patch 打開 `network.offline`，斷言 NTP、錨定、更新檢查、IP 查詢的排程全部停止。今天 NTP 與更新仍在，`it.fails`。
- [x] T009 [P] [US1] RED：`test/session-switch-known-leaks.test.ts`。(a) `startLinkMonitor` 的計時器在關閉後仍在；(b) 不呼叫 `resetBodiesDirCache` 時 body 寫進前一個專案；(c) A 的 DB 錯誤讓 B 的判定維持 dark。皆 `it.fails`。
- **Gate**：五道 gate 全綠；T002–T009 在三個平台的 unit leg 執行，或計為 `not-run` 並附原因。

## Phase 2 — Session 骨架與「先準備、後交棒」

- [ ] T020 [US2] 先 RED：`e2e/project-open-rollback.spec.ts` 改為 spec US2 的期望：`db-open`、`db-pragma`、`source-config` 之後 A 仍開著、identity 檔仍是 A、API 仍回 200；新增兩種故障：設定檔無法解析、第 k 個資源啟動失敗（經 test hook 注入）。新期望以 `test.fail` 標示，T023 翻正。（`[env:linux]` CI；本機只在操作者同意時跑）
- [ ] T021 [P] `src/core/session/{resource,lifecycle,timers}.ts`：資源介面、`ResourceId`、`CloseReason`、生命週期的純轉移函式；`test/session-lifecycle.test.ts` 走遍轉移表。
- [ ] T022 `src/core/session/{session,current}.ts`：`ProjectSession` 接手 `ProjectRuntime` 的 token、計時器、cleanups、`renameProject`、`setOperator`；`ProjectContext` 改名 `SessionToken` 並保留別名。`main/index.ts` 改用 session；`stopProject` 改為「`closeSession`（資源清單為空）→ 舊清單」。`test/project-runtime.test.ts` 改為測 session，斷言不變。
- [ ] T023 [US2] `prepareOpen`：設定以會丟錯的解析讀取並驗證（型別錯誤如 `network: null` 也拒絕）；資料庫以回傳 handle 的方式開啟與遷移；都在 `stopProject` 之前。開專案不再 `saveConfig`（FR-008）。T007、T020 翻正。專案選擇器顯示準備失敗的原因（檔案與位置）。`[env:app]` 檢查選擇器的訊息。
- [ ] T024 [P] `test/session-boundary.test.ts`：只有 `core/session/session.ts` 呼叫 `_setCurrent`；`src/renderer/**` 不匯入 `core/session`；session 不匯入 `electron`／`src/main`／`src/renderer`。
- **Gate**：五道 gate；T004 的 golden 仍成立（關閉順序尚未改變）；e2e `project-open-rollback`、`terminal-session-rotation`、`capture-browser-project-switch` 在 CI 綠燈。

## Phase 3 — 一次一個資源搬進清單（R1b 的節奏）

每個子任務一個 PR：建立資源（或把既有 service 包成資源）、從 `startProjectResources`／`stopProject` 刪掉對應的行、在切換洩漏測試中加入它的案例、從 module-state 允許清單刪掉它的 `project-legacy` 項目（計數必須下降）。任何一步都不得改變 T004 golden 以外的順序；改變處要在 PR 中列出。

- [ ] T030 `test/session-resource-order.test.ts`（快照 `RESOURCE_ORDER`，停止為反向，成對約束：`api-binding` 在 `handoff-identity` 之後啟動、`terminal-binding` 在 `db` 之後、`query-worker` 在 `db` 之後）與 `test/session-switch-leak.test.ts`（由 `ResourceId` 產生案例；未實作的資源以 `it.todo` 列出，`todo` 數只能下降）。
- [ ] T031 [US1] 依序搬遷（不平行，皆改 `index.ts`）：
  - [ ] T031a `db`：`core/db/index.ts` 的模組變數改為 session 的 handle；`getDB()` 經 `currentSession()`。
  - [ ] T031b `project-state` 第一部分：寫入端快取（`event-write.ts:109,146,180,348`）。
  - [ ] T031c `body-index` 與 body 目錄：刪除 `resetBodiesDirCache`；T009(b) 翻正。
  - [ ] T031d `cast-index` 與 `cast-content-source`；`cast-index` 的 `dbGeneration` 刪除。
  - [ ] T031e `project-state` 第二部分：ingest 的 map 與 active target、causes、socket-attribution；刪除 `resetCausesResolver`、`configureIngest({activeTarget:null})`、ingest／socket 的 `dbGeneration`。
  - [ ] T031f `project-state` 第三部分：capture-health 計數（D11，修改 `capture-health.ts:207-211` 註解）、visibility、observation count。T009(c) 翻正。
  - [ ] T031g `lifecycle-records`（只搬 `session_start`、暫停沿用標記、`opsec_airgap`；`project_closed` 在 Phase 5）。開啟時列的先後改變，`test/ingest-golden.test.ts` 等釘住順序的測試在同一 PR 更新並說明。
  - [ ] T031h `terminal-binding`。
  - [ ] T031i `query-worker` 預留位置（074 尚未落地時為 no-op 資源，介面依 plan）。
  - [ ] T031j `exports`：進行中的匯出登記於 session；`ipc/data-export.ts` 的 project id 比較改為 token。
  - [ ] T031k–T031q 監看器各一 PR：`screenshot`（刪 `dbGeneration`）、`opsec`、`cdp`、`agent-tailer`、`powershell-transcript`、`connection-monitor`、`process-monitor`、`file-watcher`、`clipboard`；各模組內的 `generation` 計數刪除。
  - [ ] T031r `alert`（`AlertRuntime`、`LootDetector`、`ScreenshotAgent` 改為每 session 一個實例）。
  - [ ] T031s `scope-recompute`（`index.ts:718-768`）。
  - [ ] T031t `retention`、`handoff-drain`、`chain-sample`。
  - [ ] T031u `ntp`、`anchor`、`updater-airgap`（`chain-anchor.ts` 的 `dbGeneration` 刪除；air-gap 的即時套用留到 T044）。
  - [ ] T031v `link-monitor`。T009(a) 翻正。
  - [ ] T031w `managed-proxy`、`capture-browser`。
  - [ ] T031x `handoff-identity`、`api-binding`（`api-server.ts:54-121` 的專案部分；順帶刪除只寫不讀的 `castProbe`／`castOffsetAtStart`，07-F6）、`presentation`。
- [ ] T032 刪除 `startProjectResources`、`stopProject`、`OPEN_SEQUENCE` 的 hooks、`ProjectRuntime` 類別；`ipc/artifacts.ts`、`ipc/terminal.ts`、`ipc/events.ts` 的 project id 比較改為 token。T004 的 golden 換成 T030 的快照，並在 commit 訊息列出 plan 寫明的三點刻意差異。SC-003、SC-011。
- **Gate**：五道 gate；module-state 的 `project-legacy` 計數為 0（只剩 `session-slot`）；`dbGeneration` 出現數為 0；切換洩漏測試沒有 `todo`；三支切換相關 e2e 綠燈；`[env:mac,app]` A→B→A 實跑一次並記錄。

## Phase 4 — 設定層級與 `machine.yaml`

- [ ] T040 [P] [US4] 先 RED：`test/config-legacy-equivalence.test.ts`（property，≥10,000 組；SC-006）與 `test/machine-settings-file.test.ts`（權限、原子取代、修訂衝突、較新 schema 唯讀、未知鍵保留、解析失敗不覆寫）。
- [ ] T041 [US4] `src/core/session/config-view.ts`：`resolveConfig` 四層、`origin`、驗證；`prepareOpen` 改用它。T006 的 golden 經新路徑得到相同結果。
- [ ] T042 [P] `src/core/machine-settings.ts`：讀寫、原子寫入、修訂值、schema。根目錄經 071 的根目錄解析；若 071 尚未提供，先用本模組內唯一的 `redlogHome()`，071 落地時替換。`[env:win]` 原子取代測試。
- [ ] T043 `ConfigStore` 依登記表把每個 op 寫到歸屬檔；新增 `resetToMachine(key)`；`config-apply-plan.ts` 改以有效設定為輸入、`reads` 由資源宣告、新增原因 `machine`；`NO_LIVE_EFFECT` 逐項重審並在 `config-apply-plan.ts:192-201` 寫明理由。`test/config-apply.test.ts` 的 golden 更新屬本任務。存檔回覆前發出 Spec 074 的 `config` 主題（FR-013）；074 T062 落地前這一步是 no-op，由 074 T062 接上並以 `test/change-topics.test.ts` 斷言。
- [ ] T044 [US3] air-gap 即時：`ntp`、`anchor`、`updater-airgap`、`alert`（IP 查詢）四個資源宣告讀 `network.offline` 並實作 `apply`；`chain-anchor.ts:50-52` 的自行讀檔刪除。T008 翻正。`[env:mac]` 以 `lsof -i`／`nettop` 確認 5 分鐘內無 NTP（udp 123）與更新檢查連線（SC-005）。
- [ ] T045 收斂 36 處直接讀取（plan 的表），每個 PR 一個檔案群，T003 的基準逐次下降到 0：
  - [ ] T045a `core/chain-anchor.ts`、`core/export-planning.ts`
  - [ ] T045b `main/ipc/*`（target-context、plugins、artifacts、events、markers、data-export）
  - [ ] T045c `main/index.ts`（剩餘各處）
- [ ] T046 [US4] `personalTraffic`：改名、歸屬機器、預設空；舊檔的 `scope.personalDomains` 讀為覆寫；匯出與查詢讀新鍵；設定頁移出範圍分組；`config.ts:69-73` 的註解改寫。US4-3 的匯出等價測試。
- [ ] T047 [US4] 新專案只寫專案鍵與卡片值（`mergeInitialConfig` 改寫，`test/create-config-merge.test.ts` 更新）；新格式寫 `configVersion: 2`、`configWriter` 摘要與 operator 鏡像；舊檔在下一次存檔時轉換。
  > **Superseded（2026-11-13，修訂 B7）**：不寫 operator 鏡像；卡片值不含 operator（T04B）。其餘不變。
- [ ] T048 [US4] 設定頁：每個機器範圍欄位標示來源；被覆寫者提供「改用此電腦的值」（寫一列設定變更紀錄）；`machine.yaml` 錯誤與較新 schema 的唯讀說明。不新增頁面與分組（`test/settings-ia.test.ts` 預算不變）；新字串通過 `test/ui-copy.test.ts`。`[env:app]` 桌面與窄窗各檢查一次。
- [ ] T049 [P] `hook-config.json` 的 `excludedPaths` 遷入 `machine.yaml`（第一次寫入時），讀取改經 `ConfigView`。
- [ ] T04A [P] [US4] 先 RED（修訂 B7）：`test/operator-machine-only.test.ts`（plan Gate 表）：專案檔 operator `bob`、機器層 `alice` → 有效值 `alice`、`origin` 為 `machine`，session token 與新列的 `operator_id` 為 `alice`，開啟不被拒、檔案位元組不變；`ConfigStore` 對專案層 operator op 回 `scope-not-overridable` 且不寫檔；`mergeInitialConfig` 與設定檔匯入丟棄 `operator`；舊格式檔存檔後不再含 `operator`；登記表 `operator.*` 為 `overridable: false`。今天 operator 只在專案檔，前四項以 `it.fails` 標示。
- [ ] T04B [US4] （修訂 B7）實作 FR-01D：登記表、`resolveConfig` 不讀專案層 operator、`ConfigStore` 的拒絕與丟棄、`mergeInitialConfig` 不合併 `initial.operator`；`applyOperatorChange`（`main/operator-change.ts`）改由機器層存檔觸發（原因 `machine`），session 開啟時從機器層取得 operator；設定頁的 operator 欄位依 Q6 的答覆放置（答覆前依建議移到〈設定 ▸ 一般〉），沒有覆寫與「改用此電腦的值」；機器層第一次的值依 Q7（答覆前：內建預設值，不從專案取）。同一個變更更新斷言舊位置或專案層 operator 的測試：`test/create-config-merge.test.ts`、`test/settings-search.test.ts`、`test/project-runtime.test.ts`、`e2e/capture-settings-interaction.spec.ts:29,217-227`，並 grep `e2e/` 的 `operatorGroup` 與欄位標籤（CLAUDE.md「Changing behaviour」）；被刪的 i18n 鍵由 `verify:i18n` 檢查。依賴 T041、T042、T043。T04A 翻正。`[env:app]` 桌面與窄窗各檢查一次。
- **Gate**：五道 gate；T003 為 0；`test/settings-registry-complete.test.ts` 要求每個鍵有讀者或 `NO_LIVE_EFFECT` 理由；`[env:app]` 新建專案繼承 operator、既有專案顯示覆寫。
  > **Superseded（2026-11-13，修訂 B7）**：`[env:app]` 的檢查改為：新建專案與既有專案都用機器層的 operator，沒有專案層的 operator 欄位；其他機器層鍵的覆寫照舊顯示。另加 T04A 綠燈。

## Phase 5 — 生命週期

- [ ] T050 [P] [US6] 先 RED：`test/project-closed-record.test.ts`（6 種結束 × 恰好一列、`reason` 正確、為該 session 最後一列）與存活戳記的假時鐘測試（`unclean` 的發生時間 = 戳記時間）。依賴 072 宣告 `project_closed`；072 未落地時以 `it.todo` 列出。
- [ ] T051 [US6] `lifecycle-records` 資源的 `stop` 寫 `project_closed`（經 071 的入口，reason 依 FR-033，含 `open-failed`）；開啟時的當機補寫（`unclean`、`last_alive_at`）；`<project>/.session-alive`。同一個 PR 移除 072 T051 掛在切換專案與 `before-quit` 的過渡寫入點，不並存兩個寫入點。
- [ ] T052 [US6] 封存：`ARCHIVED` 標記檔與 `projects.json` 的 `archivedAt`；專案選擇器列的封存／取消封存（只對未開啟的專案）；唯讀 session（只啟動 `use:'read'` 的資源、資料庫唯讀、`ConfigStore` 拒寫、交接目錄不排空）；唯讀標示。先 RED：`e2e/project-archive-readonly.spec.ts`（開啟前後資料庫與 WAL 位元組不變）。`[env:app]` 選擇器與唯讀標示。
- [ ] T053 [US6] 關閉時取消進行中的匯出（暫存刪除、回 `project-closed`）；離開確認（`lib/leaveProject`）列出進行中的匯出。`test/leave-project-confirm.test.ts` 在同一變更更新。
- [ ] T054 依 Q1 的答覆處理唯讀專案的匯出。
- [ ] T055 [P] 協調任務（詞表屬 075）：確認本規格用到的四個理由碼 `project-archived`、`bound-elsewhere`、`consent-scope-changed`、`hook-file-missing` 都在 075 的封閉清單（075 T020），唯讀 session 的來源呈現為「無法使用・`project-archived`」。
- **Gate**：五道 gate；`[env:mac]` `kill -9` 後重開，時間軸上有 `project_closed{unclean}`。

## Phase 6 — 終端機綁定：暫停與恢復

- [ ] T060 [US5] 先 RED：擴充 `test/terminal-enrollment-agreement.test.ts`（與 071 T075 共用的唯一 agreement 測試）的狀態表（{綁定 A、未綁定} × {開 A、開 B、無專案} × {記錄中、`operator`、`hook-removed`}，加上舊檔的 `project-switched`）；relay 一側由 071 T075 在同一個 PR 或同一天的配對 PR 實作。`test/shell-project-switch.test.ts` 改為恢復的期望。（沒有 shell 目標時該測試會 `describe.skip`：CI 的 ubuntu leg 必須有 zsh 與 bash，否則計為 `not-run`。）
- [ ] T061 [US5] `terminal-enrollment.ts`：`bindingState`、停止原因縮減、舊 `project-switched` 讀為無停止原因；改寫檔頭註解（`:17-20`）；Spec 052 FR-010 改寫為暫停與恢復（Draft，同一變更）。
- [ ] T062 [US5] 擷取控制的終端機列：只在 N > 0 時說明「N 個終端機綁定其他專案，已暫停」；舊 hook 函式的終端機另說明不會自動恢復。`[env:app]`。
- [ ] T063 [US5] `[env:mac,linux,real-shell]` 開 A、開 tmux 兩個 pane、切 B、執行指令、切回 A、執行指令：B 沒有列；A 有 `capture_resumed` 與之後的指令；`redlog stop` 的 pane 不恢復。
- **Gate**：五道 gate；agreement 測試在有 shell 的 leg 實際執行。

## Phase 7 — 安裝帳本

- [ ] T070 [P] [US7] 先 RED：`test/install-ledger-roundtrip.test.ts`，類型 × {一般檔、symlink、`ZDOTDIR`、bash login 檔、CRLF、無結尾換行、安裝後被改、安裝後被刪}；PowerShell 移除把 LF 變 CRLF 的缺陷（`hooks-manager.ts:1022`）以 `it.fails` 標示。
- [ ] T071 [US7] `src/core/install-ledger.ts`：意圖 → 寫入 → 完成；寫入前位元組另存；驗證；還原；移除報告；帳本損毀時改名並補登。
- [ ] T072 [US7] `hooks-manager.ts` 的 install／uninstall／refresh／remove 與 `wsl-manager.ts` 的 install／uninstall 全部經帳本；安裝對本機每個有 adapter 的 shell 寫入（P4），選擇器不再「點選即安裝」（`RecordTerminalFlow.tsx:198-203`、`test/record-terminal-adapter-selection.test.tsx` 同一變更更新）。寫入位置由進行中的 hook 位置變更決定；本任務只要求帳本能為一個 shell 記多個檔。
- [ ] T073 [US7] 補登：以 `hookSpellings` 掃描 rc、PowerShell 各 edition 與 host 的 profile、`~/.claude/settings.json`、WSL distro；孤兒標記；設定頁可移除孤兒。
- [ ] T074 [US7] 解除安裝的 `--remove-hooks`（`index.ts:1298-1304`）改為依帳本移除，輸出移除報告到 debug log。
- [ ] T075 [P] `test/no-unledgered-external-writes.test.ts`：ratchet，基準 9，最後為 0（只剩 `install-ledger.ts`）。
- [ ] T076 [P] 與 071 協調：`credentials.ts` 發放憑證檔時呼叫 `ledger.apply`（`credential-file`）。
- [ ] T077 設定頁的 shell 列：「已寫入 · 尚未看到」與 `hello` 合併由 075 的狀態模型呈現；本任務提供帳本事實（`present`／`missing`／`modified`）的 IPC。`[env:app]`。
- [ ] T078 `[env:mac,linux,win,wsl,real-shell]` 安裝 → 移除位元組相同（SC-008）：macOS 的 `ZDOTDIR` 與 Terminal.app login bash；Linux 的 stow symlink；Windows PowerShell 5.1 與 7（`CurrentUserAllHosts` 與 VS Code host）；WSL distro 的 rc。
- **Gate**：五道 gate；T075 為 0。

## Phase 8 — 官方 AI adapter：從 app 本體執行、以專案同意

- [ ] T080 [P] [US8] 先 RED：`test/ai-consent.test.ts`（有效、無、撤回、範圍改變、舊安裝）；`test/official-agent-migration.test.ts`（收據 → `legacyInstallations`，`installationId` 延續；`conflict`／`error` 不遷移）；`test/official-adapter-load-path.test.ts`（動態 `require` 只在打包目錄之下）。
- [ ] T081 [US8] `official-agents.ts` 只讀打包目錄，6 處各自建立的 manager 收斂為一個 app 範圍的 `aiCatalog()`；`update-available`、`conflict`、收據比對、安裝與更新的路徑刪除。Spec 066 FR-003、Spec 067 相關 FR 標為被本規格取代（同一變更）。
- [ ] T082 [US8] `ai-consent.ts`；`resolveAgentCapture` 改用同意條件；`diffSecurityConfig` 涵蓋 `consent`（同意與撤回寫鏈上紀錄）。
- [ ] T083 [US8] 啟動時遷移（任何專案開啟之前）；第一次開啟相符專案時補寫 `consent{by:'migration'}`；外掛頁說明舊資料夾仍在並提供移除。
- [ ] T084 [US8] 同意的儲存與 IPC：寫入專案的 `consent`（經 `ConfigStore`，`config-audit` 寫鏈上紀錄）、撤回此專案、撤回此電腦全部（`ai.revokedAt`），以及開著的專案在撤回當下停止該來源。按鈕的位置（來源列「在此專案記錄」、外掛頁的撤回）與原生對話框的顯示屬 075（FR-074、D11、075 T083），兩者同一個 PR 或配對 PR；對話框的內容（讀取根目錄與事件種類）取自 075 描述的 `adapter`。`[env:app]`。
- [ ] T085 [US8] `[env:mac,win,packaged]` 正在記錄 Claude Code 的專案，換一版 adapter 的 build 升級，第一次開啟時停錄時間為 0、對話框出現 0 次（SC-009）；讀取 `verify-fuses` 的結果記入 verification。
- **Gate**：五道 gate；`verify:package-resources` 涵蓋 `optional-ai`（若不涵蓋，先補）。

## Phase 9 — 文件與驗收

- [ ] T090 改寫 `docs/design/DESIGN-project-runtime.md` §2–§4：session、資源清單、一種過時判斷；§1 保留為歷史。
- [ ] T091 `docs/domain/glossary.md`：Project Session、Session Token、Resource、Setting Scope（機器／專案）、Archived Project、Install Ledger、AI Consent；Recording 一詞補上關閉與封存。
- [ ] T092 `verification.md`：每條 FR 三欄（已決定／已實作／已驗證），每個驗證附 commit、平台與證據；沒有實跑的保留 NOT RUN。
- [ ] T093 `[env:app]` 契約落地時的實機 UI 檢查（工作計畫驗收規則二）：專案選擇器（封存、準備失敗訊息）、設定頁（來源標示、改用機器值、`machine.yaml` 錯誤）、擷取控制（綁定他處的終端機、AI 同意）、指令與終端設定（多 shell、移除報告）、外掛頁（撤回、舊複製本）、唯讀標示、離開確認；桌面與窄窗、繁中與英文、空／載入／錯誤狀態。
- [ ] T094 `[env:mac,linux,real-shell]` 擷取信任端到端（驗收規則一）：真實的 zsh、bash、受管 proxy、Claude Code 在 A→B→A、air-gap 切換、封存、升級四種情境下，讀回的列與預期一致。
- [ ] T100 `[env:mac]` 降版檢查：以前一版的 app 開啟新格式專案，署名（operator）不變，能記錄；結果寫入 verification。
  > **Superseded（2026-11-13，修訂 B7）**：不做。operator 鏡像已取消（plan D12），降版時的署名不在保證之內。

## 相依與平行

- Phase 1 的 T002–T009 全部可平行。
- Phase 2 依賴 Phase 1；Phase 3 依賴 Phase 2；Phase 3 內部依序（皆改 `index.ts`）。
- Phase 4 的 T040、T042 可與 Phase 3 平行；T041 起依賴 T031a（`db`）與 T023（`prepareOpen`）；T044 依賴 T031u。
- （修訂 B7）T04A 可與 T040 平行；T04B 依賴 T041–T043，與 T048 改同一個設定頁，兩者排開或同一個 PR。
- Phase 5 依賴 Phase 3 的 T031g 與 072 的種類宣告。
- Phase 6 只依賴 Phase 2（不需要資源清單完成），可與 Phase 3–5 平行，但必須與 071 T075 配對。
- Phase 7 不依賴 session，可在 Phase 1 之後任何時候開始。
- Phase 8 依賴 Phase 4（同意存在專案設定、撤回存在 `machine.yaml`）與 075 的 adapter 宣告（075 T021 的描述表）；T084 與 075 T083 配對。
- Phase 5 依賴 072 T051（種類登記）；072 的過渡寫入點在 T051 落地時移除。
- Phase 7 的 T076 依賴 071 T041（憑證發放）。
