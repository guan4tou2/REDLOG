# Tasks: 事件種類登記表與閱讀器契約

**Input**：[spec.md](spec.md)、[plan.md](plan.md)

**規則**：

- 每個 Phase 結束時 main 都可出貨，並以列出的 gate 收尾。
- 每個行為修正先寫 RED（`it.fails` 或失敗的斷言），再實作；純摺疊以 golden 證明等價。
- `[P]` 表示可平行（不同檔案、沒有相依）。`[USn]` 對應 spec 的故事；`Fn` 對應 plan D7 的有記錄修正。
- 每次 push 前依序跑五道 gate：`npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n && npm test`。
- 改動任何畫面元件的 PR，先 grep `e2e/` 中對應的文字與 `data-testid`，並在 PR 前於本機跑受影響的 spec（CI 只在 ubuntu 跑 e2e）。
- 「已決定／已實作／已驗證」分開記錄在 `verification.md`；勾選任務不等於驗證。

## Phase 0 — 工作流程前置

- [ ] T001 依憲章（跨層契約、證據呈現）執行 Clarify、Checklist、Analyze，結果記入 `verification.md` 的 Gates。開放問題 Q1–Q3 取得擁有者答覆前，Phase 4 的 T040 與 T042 不開始。

## Phase 1 — 釘住今天的行為（只加測試與 gate，不改程式行為）

- [ ] T002 [P] 種類清單：`test/kinds/inventory.ts`，以 plan D2 的掃描樣式與 AST 列出今天所有寫入者寫出的 `(agent_type, subtype)`，附檔案與行號；與 10 的 A.1 對照，差異寫入 `verification.md`。
- [ ] T003 [P] 範例列：`test/kinds/examples.ts`，T002 每個種類至少一列（含 relay 的每種 `completeness × output_disposition`、內建終端機 `io` 三種、無欄位的舊 `command_end`、`shell:command`、`agent:*` 的未知 subtype、外掛的 `scanner:packet_flow` 與 `c2_*`）。
- [ ] T004 golden：`test/kinds/golden/<表>.json`，以**今天的函式**對 T003 的每列求值，涵蓋 plan「表的清點」中要摺的 31 張；SQL 類另存 SQL 文字與 in-memory SQLite 的求值結果。依賴 T003。
- [ ] T005 [P] `test/kinds/kind-literal-ratchet.test.ts`（plan D3）：量得兩個基準（種類比較、subtype 比較），只能下降；建立空的 `kind-literal-allowlist.json`。另加「以種類為鍵的表」計數：plan 表中 31 張的特徵樣式各一，基準 31。
- [ ] T006 [P] `test/kinds/registry-pure.test.ts` 的後半：renderer 經非 type import 走訪到、且 import Node 模組的 `src/core` 檔案數，基準 3（FR-022）。
- [ ] T007 [P] [US1] RED：`test/kinds/completeness.test.ts`，依 spec US1 的七個情境斷言閱讀器第一行與時間軸點標記；以 `it.fails` 標示（今天 `redirected` 顯示為「未產生內容」）。
- [ ] T008 [P] [US2] RED：`test/kinds/every-kind-presentable.test.tsx`，對 T003 的每列斷言標題不走預設分支、閱讀器不因缺分支而為通用；以 `it.fails` 逐項標示今天的 29 個與截圖。
- [ ] T009 [P] [US4] RED：內務規則一致性，`HOUSEKEEPING_SQL`、`EVIDENCE_SQL`、`isEvidence`、`knownLists.isHousekeeping` 對同一組列（含 PowerShell profile 與 `tlogger_prompt_command` 行）回答一致；以 `it.fails` 標示（F9）。
- [ ] T010 [P] 特徵化：擴充 `test/db/tier-classifier.test.ts`，對 T002 的每個種類斷言今天的實際 tier，包括瀏覽器 console 的 chained；修正 `event-write.ts:96-99` 的註解指向本測試。
- **Gate**：五道 gate 全綠；新測試在三個平台的 unit leg 都有執行，或計為 `not-run` 並附原因。

## Phase 2 — 建立登記表（沒有任何消費者切換，行為不變）

- [ ] T011 `src/core/kinds/types.ts`：全部封閉列舉與 `KindDef`、`IntervalDef`、`StateDef`、`KindRow`；`ActivityAction`、`LaneId`、`BandId` 搬入，`activity-contract.ts`、`timelineDomain.ts` 改為 re-export。
- [ ] T012 `src/core/kinds/registry.ts`：T002 的每個種類一個項目，欄位值等於今天各表的回答（以 T004 的 golden 生成初稿，再逐項審）；`legacy` 項目寫明理由；每個項目有 `family`（074 的 topics 讀它）；族登記三個（plan D8）；`TIER_CHANGES` 為空；`KIND_REGISTRY_VERSION = 1`。
- [ ] T013 [P] `INTERVALS`、`STATES` 與註記附著、適用區間欄位（plan D6）。
- [ ] T014 [P] `rules.ts`、`completeness.ts`（plan D5）、`plugin.ts`（plan D9）、`index.ts`；`housekeepingSql()` 的文字逐字等於今天的 `HOUSEKEEPING_SQL`（golden）。
- [ ] T015 gate：`registry-pure`（前半，FR-020）、`registry-shape`（FR-014、FR-015、FTS 不依種類）、`writers-registered`（FR-011、FR-012，含已知盲點的負向斷言）、`plugin-kinds`（US5）。
- [ ] T016 `scripts/architecture-allowlist.json` 為 `src/core/kinds` 的新匯出加暫時項目，理由寫「Phase 3 第一個 PR 移除」。
- **Gate**：五道 gate；T004 的 golden 不變；沒有任何正式程式碼 import `src/core/kinds`（除 re-export 的型別）。

## Phase 3 — 摺疊純呈現的表（依操作者看得到的分歧排序；每項一個 PR）

- [ ] T020 [US1] F1：`completenessOf` 成為唯一判斷；`commandOutputState`、`ioMark`、Transcript 的輸出狀態改為呼叫它；`<CompletenessLine>`；新增 7 個字串 key（兩個語系），跑 `test/ui-copy.test.ts`。T007 翻正。移除 T016 中對應的 allowlist 項目。
- [ ] T021 [US2] F2–F4：`src/renderer/src/lib/kindPresentation.tsx` 的 `READERS`；新增 `image`、`packet-flow`、`record-fact`、`text-output` 的閱讀器元件（模組層宣告）；`hasSpecificEventDetail` 與檢視器內以 `agentType` 判斷的分支改為 `READERS[kind.reader]`。若 `work/1112-present` 已合併，其分派決定先抄進登記表並成為 golden（FR-054）。
- [ ] T022 [P] [US2] Activity 閱讀器與 Transcript 單列展開共用 `READERS`。依賴 T021。
- [ ] T023 [US2] F5、F6：`TITLES` 與 `TitleId`（今天每個分支一個 id，加 29 個新 id）；`eventTitle` 改為查表；刪除 `SearchPanel.tsx:25-45` 的摘要。T008 翻正。
- [ ] T024 [US4] F7：`LANE_DEFS`；`toLane`、`LANE_LABEL_KEYS`、`agentTypeLabel` 讀登記表；連線泳道、C2 泳道（取代 `c2_checkin`）、`capture_gap` 同泳道、`http_navigation` 與 `scanner` 泳道以來源改名。grep `e2e/` 的泳道名稱與 test id 並跑受影響的 spec。
- [ ] T025 [US4] F9：`housekeepingSql`／`isHousekeeping`／`workSql`／`isWork` 取代 `event-queries.ts:150-221`、`housekeeping.ts:28-36`、`knownLists.ts:15-33`。T009 翻正。
- [ ] T026 [P] [US4] F8：Activity 的 `group` 與 `action` 讀登記表；移除死字串與死項目。`act1` 身分雜湊的 golden 不變（只有 action 改變）。
- [ ] T027 [P] 純摺疊：`computeBadges` 的種類部分、`timelineCard` 的 type tag、Transcript 收錄、`BODY_SOURCE_PREDICATE`（SQL 文字逐字相同）、四個元件的失效集合（`invalidates`）。
- [ ] T028 [P] 每個 Phase 3 PR 降低 T005 的兩個計數與表數；把留下的合理比較寫進 allowlist 並附理由。
- [ ] T030 依 CLAUDE.md「Changing behaviour」：修改斷言舊顯示的 spec 與測試（Spec 004、009 中外部 shell 輸出的顯示；`test/command-output-state.test.tsx`、`test/reader-content-state.test.tsx`；e2e 中 `content.empty`、`timeline.io.uncaptured`、泳道名稱），與對應的 T020／T021／T024 同一個 PR。
- [ ] T031 真機（macOS）：外部 zsh 跑 `ls`、`ls -al`、`nmap -oN x 127.0.0.1`、`vim`、背景工作；內建終端機；手動截圖；`redlog stop`／`start`；在時間軸、Activity、搜尋、Transcript 逐一打開，確認完整性、標題、閱讀器與泳道。記入 `verification.md`。
- **Gate**：五道 gate；`folded-tables` 的差異等於 `DOCUMENTED_FIXES` 中 F1–F9；T005 的計數下降；ubuntu e2e 全綠。

## Phase 4 — 摺疊行為表（與 071 Phase 3 同步；需要 071 D10 與 T010、T015、T024 已落地或同 PR）

- [ ] T040 tier：`classifyTier` 呼叫 `tierFor`；`LOGGED_TIER` 刪除；T010 的特徵化測試改為「每個登記種類的 tier = 登記表，差異只來自 `TIER_CHANGES`」；把 071 T027 的項目寫入 `TIER_CHANGES`。與 071 T027 是同一個 PR（071 FR-113 由此生效）。依 Q1 的答覆處理瀏覽器 console。
- [ ] T041 暫停：`PAUSE_EXEMPT_AGENT_TYPES` 與 `delayedCapture` 改讀 `pause`；與 071 T015 同一個 PR。
- [ ] T042 [US3] 寫入者：先 RED（F10：`credential_use` 經契約 1 入口應被拒）；071 的種類政策改讀 `writers`；`EXTERNAL_ALLOWED_AGENT_TYPES` 刪除；舊入口的狀態碼不變（071 T003 的特徵化不變）。依 Q2 的答覆。
- [ ] T043 目標：`ACTIVE_TARGET_FALLBACK_TYPES` 改讀 `identity.target`；與 071 T024 同一個 PR。
- [ ] T044 [P] 因果與範圍訊號：`causes-resolver.ts` 的起訖判斷讀 `INTERVALS`；`socket-attribution.ts:189` 讀 `cause`；`scopeSignalFor` 改為 `Record<ScopeSignalKind, …>`，鍵由 `scopeSignal` 導出。golden 不變。
- [ ] T045 [US3] 型別化入口：`insertEvent`／`ingestEvent`／071 的行程內入口的種類參數改為登記表型別；推導器的 subtype 型別化；AI adapter 的 `subtypeFor` 回傳型別化；`test/kinds/untyped-kind-calls.test.ts` 的 ratchet 降到 0。與 071 T037 的檔案群同批。
- **Gate**：五道 gate；071 T002（舊列 golden）與 T003（舊入口狀態碼）不變；`folded-tables` 只多 F10。

## Phase 5 — 角色、區間的宣告交給 074；`project_closed`

- [ ] T050 [US6] RED：`test/kinds/project-closed.test.ts`，登記項目與欄位（`reason` 值域與 073 的 `CloseReason` 加 `unclean` 相等、`last_alive_at` 只在 `unclean`）；正常關閉（切換、結束、更新）有一列 chained `system.project_closed` 且在資料庫關閉之前；`kill -9` 當下沒有；暫停中關閉仍寫入；寫入失敗不阻擋關閉。`unclean` 的補寫由 073 T050 測。
- [ ] T051 [US6] 實作種類與過渡寫入點：登記 `system:project_closed`；經 071 的行程內入口寫入。073 的 `lifecycle-records` 資源（073 T051）若已存在，本任務只登記種類；否則暫時掛在今天的切換專案與 `before-quit` 路徑（只產生 `switched`、`app-quit`、`update-restart`），073 T051 落地時移除這個過渡寫入點，不並存。T050 翻正。
- [ ] T052 [US7] 交付 074：`INTERVALS`、`STATES`、`invalidates` 與 `counts.total` 的消費者由 074 的任務實作；本任務只在 074 的 gate 中加入「投影不得以 `agent_type` 字面值判斷起訖」的條件，並在 074 取代 `isBoundary`、`timelineSessionBands`、配對後隱藏 start（表 #21、#31、#32）時確認 golden 等價。
- [ ] T053 真機：切換專案、結束 app、`kill -9` 後重開；在 074 的投影可用後，確認「沒在錄」「未知」的區段呈現。
- **Gate**：五道 gate；T005 的表數扣除 #21、#31、#32（074 合併後）。

## Phase 6 — 匯出與外掛

- [ ] T060 [P] 匯出：`export-plan.ts` 的摘要計數、`export-attachments.ts` 的附件、`export-selection.ts` 的 HTTP 伴隨列、`do-not-export.ts` 的串連改讀 `export` 與 `INTERVALS` 的 `members`。golden 不變；071 T002 的匯出位元組不變。
- [ ] T061 [US5] 外掛：`validatePluginKind` 取代 `event-registry.ts`；075 的 manifest v2 載入時呼叫它，拒絕原因由 075 呈現；`color`、`icon` 不再接受。依賴 075 的 manifest v2。
- [ ] T062 capture-health 的來源探測（#28）改由 075 的來源描述列出 `KindId`（075 的任務；本任務只確認 `KindId` 型別被使用）。
- **Gate**：五道 gate；T005 的表數為 0（扣除 2 張不摺的）；SC-001。

## Phase 7 — 文件與領域契約

- [ ] T070 glossary 加入 Event Kind、Role（五種）、Reader、Completeness、Interval Declaration；標明 Marker 的角色為 annotation。
- [ ] T071 [P] `docs/event-schema.md` 改為由登記表產生（`scripts/` 中的產生器，CI 比對產物）或改為只指向 `src/core/kinds/registry.ts`；擇一並在 PR 中說明。
- [ ] T072 [P] DESIGN-two-tier-chain §2.2–2.4 改為指向登記表與 `TIER_CHANGES`；確認 071 T082 已把外掛預設改為 logged；移除 §2.2 中誤列為 `system` 的 pivot／cleanup subtype。
- [ ] T073 [P] `docs/UIUX-STANDARD.md` 記錄完整性七值的用詞與閱讀器第一行的規則（設計決定放在標準，實作細節留在本規格）。
- **Gate**：五道 gate；`verify:specs`。

## Phase 8 — 驗收

- [ ] T080 建立 `verification.md`（依 `.specify/templates/overrides/verification-template.md`）：RED（T007–T009、T042、T050 失敗的原因）、GREEN、Gates、`DOCUMENTED_FIXES` 的逐項證據。
- [ ] T081 真機驗收：
  - macOS：T031 與 T053 的全部情境；bash 3.2；受管代理 `curl`；claude-code adapter 一段對話；匯出對話框與 HTTP 紀錄沒有變化。
  - Linux 或 Kali：pcap-capture 外掛與 `hooks/pcap-agent.py`（sudo）、host-monitors pack 的連線監控、c2 tailer 範例日誌：三者同泳道、同閱讀器；外掛寫入的新列為 logged（071 T027）。
  - Windows：PowerShell transcript pack 的 `command_end` 在閱讀器的完整性（確認其欄位）。
  - 沒有環境的項目記為 NOT RUN 並附原因。
- [ ] T082 更新 `specs/README.md` 的索引；全部完成並驗證前，Spec 072 維持 Draft。

## Dependencies & Execution Order

- 依序：Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8；Phase 7 可與 4–6 平行。
- Phase 1 的 T002、T005–T010 互相平行；T003 依賴 T002，T004 依賴 T003。
- Phase 3 的順序是 T020 → T021 → T023 → T024 → T025，其後 T022、T026、T027 平行；T030 隨各自的 PR。
- Phase 4 需要 071 Phase 3（T040 與 071 T027 同 PR；T041 與 071 T015、T042 與 071 T010、T043 與 071 T024 同 PR）；Phase 5 的 T051 需要 071 的行程內入口（073 的掛鉤可選）；T052 需要 074 Phase 5；Phase 6 的 T061、T062 需要 075 Phase 7。跨 071–075 的順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」。
- `main/index.ts` 同時只能有一人修改（DESIGN-project-runtime §4）：T051 與 071 T037a、073 的任務排開。

## 需要的環境

| 項目 | 環境 |
|---|---|
| T031、T053、T081 macOS | 真實 app、外部 zsh 與 bash 3.2、內建終端機、mitmdump |
| T081 Linux | sudo、tcpdump、pcap-capture 與 host-monitors pack |
| T081 Windows | PowerShell 5.1 與 7、`pack-windows-output` |
| 其餘 | 一般 CI 三平台 unit leg；e2e 只在 ubuntu |

## 明確排除

見 spec「不在範圍」。
