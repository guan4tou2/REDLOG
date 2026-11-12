# Feature Specification: 事件種類登記表與閱讀器契約

**Feature Branch**: `spec/072-075-contracts`
**Created**: 2026-11-12
**Status**: Draft
**Input**: [根因審查與落地計畫](../../docs/records/2026-11-12/ROOT-CAUSE-REVIEW.md) §4「擷取種類盤點的決定」與角色模型；根因報告 [10 擷取的種類與呈現](../../docs/records/2026-11-12/root-cause/10-capture-kinds-and-presentation.md)（A–F 與其 UNCONFIRMED 清單）、[03 介面狀態與資料流](../../docs/records/2026-11-12/root-cause/03-renderer-state.md)（F2 的述詞手抄本）；[PRIOR-ART-C](../../docs/research/PRIOR-ART-C-recorders-and-status.md) §4、§6.5；[DESIGN-two-tier-chain](../../docs/design/DESIGN-two-tier-chain.md) §2；Spec 071（Draft，已合併）的 FR-071、FR-111、FR-113、O8；2026-11-12 擁有者「改善並重構一切，使之更工程化、更模組化」的指示。

> 本檔只寫可觀察的行為、對外契約與 gate。登記表的欄位定義、模組介面、被否決的做法、28＋5 張表逐一的落點與遷移順序在 [plan.md](plan.md)。

## 決策與範圍

### 已決議（擁有者，2026-11-12；本規格不重開）

| # | 決定 | 落點 |
|---|---|---|
| O1 | 事件角色有五種：動作（action）、結果（effect）、狀態（state）、紀錄的事實（record-fact）、註記（annotation）；**動作是區間** | E |
| O2 | 推導出的註記（戰利品、範圍觀測、pivot、清理、憑證使用）預設附著在來源動作上；原本的泳道保留為可展開的完整清單 | E |
| O3 | 新增 `project_closed` 紀錄，使「app 沒開」與「沒有事件」可區分；既有專案的那一段標為「是否在錄：未知」 | E、F |
| O4 | 閱讀器必須說出輸出的完整性，且只依來源送來的事實 | D |
| O5 | 外掛宣告、但不在核心表上的種類預設寫入 logged；只有核心的表能把一種事件定為 chained（071 O8、FR-113）。**本規格的登記表就是那張核心表** | A |
| O6 | heartbeat 不是事件（071 O7） | A |
| O7 | 因果歸屬不用猜；取不到時不寫 `_causes`（071 O18） | A（只宣告） |
| O8 | 不改任何既有列的雜湊、簽章、鏈結；不改寫既有列；舊專案照舊開啟、驗證、匯出 | 全部 |
| O9 | 外掛只有 Source／Processor，沒有 UI 外掛；外掛只能從登記表的閱讀器中挑一個，不能帶自己的閱讀器 | D |
| O10 | 不新增頁面；Timeline 維持自己的頁；介面文字最少；範圍、擷取政策、顯示篩選、匯出選取四個詞不共用控制項 | 全部 |

### 本規格自行決定的（理由與被否決的替代方案見 plan.md）

1. 登記表放在 `src/core/kinds/`，是**純資料加純函式**的模組；它不 import 任何 Node 內建模組、Electron、資料庫或目錄外的檔案。core、main、preload、renderer 與測試都讀它（plan D1）。
2. 可寫入的種類集合以兩種方式取得，依寫入者的語言而定：TypeScript 寫入者用**型別**（入口只收 `KindId`，未登記的種類是型別錯誤）；`hooks/` 與 `plugins/` 的非 TypeScript 寫入者用**原始碼字面值掃描**，兩者在同一個 Vitest 檔中與登記表雙向比對（plan D2）。
3. 閱讀器是一個**封閉列舉** `ReaderId`，依內容類型分，不依 `agent_type` 分；renderer 以 `Record<ReaderId, …>` 對應元件，漏一個就是型別錯誤（plan D4）。
4. 完整性是一個**封閉列舉** `Completeness`，七個值；舊列與沒有說明的來源一律為 `unknown`，絕不推為 `complete`（plan D5）。
5. 區間與狀態只以**宣告**存在（`IntervalDef`）；計算全部屬於 Spec 074（plan D6）。
6. 摺疊每一張表之前，先把它今天對每個已登記種類的回答存成 golden；摺疊後逐一相等，只有列在 `DOCUMENTED_FIXES` 的差異被允許（plan D7）。

### 前提更正（已在程式碼確認，與根因報告 10 不同之處）

- **瀏覽器 console 列今天是 chained，不是 logged。** `LOGGED_TIER` 寫的是 `'browser:console'`（`src/core/db/event-write.ts:61`），但 CDP 寫入的 subtype 是 `console_warn`／`console_error`／`console_info`／`console_debug`／`console_trace`／`console_log`、`exception`、`log_entry`（`src/main/services/cdp-connector.ts:291-296,319,344`），沒有一個是 `console`。報告 10 A.1 與 DESIGN-two-tier-chain §2.3 都說它是 logged。
- **`tier-classifier-total` 不存在。** `event-write.ts:96-99` 的註解說「每一個實際寫出的種類都必須在這裡有 tier，`tier-classifier-total` 測試強制這點」；`test/db/tier-classifier.test.ts`（139 行）只有個別範例斷言，沒有掃描任何寫入端。今天沒有任何東西會因為新增一個寫入者而失敗。
- **對照表不只 28 張。** 另有五處以種類為鍵的表：`src/renderer/src/lib/knownLists.ts:19-33`（`HOUSEKEEPING_SQL` 的第三份手抄本）、`src/core/content-contract.ts:115-121`（`BODY_SOURCE_PREDICATE` 的種類條件）、`src/renderer/src/lib/timelineSessionBands.ts:41-60`（終端帶）、`src/renderer/src/lib/timelineIncremental.ts:112-165` 與 `Timeline.tsx:178`（配對後隱藏 start）、四個元件各自的「範圍或設定已變更」subtype 集合（`ScopeStatus.tsx:14`、`TargetView.tsx:118`、`HttpHistoryPanel.tsx:142`、`timeline/TimelineDetailBar.tsx:36`）。plan「表的清點」列出全部 33 張。
- **renderer 經 `src/core` 間接拉進 Node 模組的檔案有三個**：`src/core/config.ts`（`crypto`、`fs`、`path`）、`src/core/private-fs.ts`（`node:fs`、`node:os`、`node:path`）、`src/core/agent-capture-policy.ts`（`node:path`）。以非 type 的 import 從 `src/renderer/src` 走訪而得。這與建置時「externalized for browser compatibility」警告的數目（7）是否一一對應，未以建置確認（見「未確認」）。
- **在行程內寫入的 `system` subtype，只有 24 個能以「`insertEvent('system'` 後三行內的字面值」找到**；其餘經變數組出（例如 `alert/surface.ts:56-90` 的 `formatEvent`）。字面值掃描對 TypeScript 寫入者不足，這是決定 2 的依據。

## User Scenarios & Testing *(mandatory)*

| 故事 | 優先級 | 摘要 |
|---|---|---|
| US1 「沒記到」不再被說成「沒有輸出」 | P1 | 閱讀器依來源送來的完整性欄位說話；舊列說「未知」 |
| US2 每一種事件都打得開、叫得出名字 | P1 | 沒有任何已登記的種類落到原始字串標題或空白檢視器 |
| US3 新增一種事件時，漏改的地方會讓 CI 失敗 | P1 | 寫了未登記的種類、登記了卻沒有寫入者／標題／閱讀器，都失敗 |
| US4 同一類事實在每個畫面上是同一種東西 | P2 | 泳道、Activity 歸類、內務規則、計數由一張表回答 |
| US5 外掛的種類有確定的位置與閱讀器 | P2 | 外掛只能從登記表挑閱讀器；未登記的種類進 logged |
| US6 「app 沒開」與「沒有事件」看得出差別 | P2 | `project_closed` 寫入；舊專案那一段說「未知」 |
| US7 區間、狀態與註記有宣告可循 | P3 | 074 的投影只讀宣告，不在投影內另寫種類表 |

### User Story 1 — 「沒記到」不再被說成「沒有輸出」（P1）

操作者在外部 zsh 跑 `nmap -oN scan.txt 10.0.0.5`、`vim notes`、`ls -al` 與一個背景工作。閱讀器對每一筆都說出來源實際說過的事：完整、截斷（已存 X，共 Y）、部分（背景仍在輸出）、未擷取、已重導、缺口，或未知。時間軸點上的標記與閱讀器說同一件事。

**Why this priority**：relay 早已寫出 `completeness` 與 `output_disposition`（`hooks/redlog-relay.py:556-583,975-1013`），讀取端卻不讀（`src/core/content-contract.ts:136-146`、`src/renderer/src/lib/timelineDomain.ts:205-219`），「被重導」與「沒擷取到」都顯示成「未產生內容」。這是 10 的 A.4 #1，操作者會依它下錯結論。

**Independent Test**：表格驅動。對 relay 的每一種 `(completeness, output_disposition)` 組合各造一列，再加內建終端機的 `io` 三種情況、一筆沒有任何完整性欄位的舊列；斷言 `completenessOf()`、閱讀器的那一行與時間軸點的標記三者一致。

**Acceptance Scenarios**：

1. **Given** `command_end` 帶 `completeness: metadata-only`、`output_disposition: redirected`，**When** 打開閱讀器，**Then** 顯示「已重導」，不顯示「未產生內容」；時間軸點有「未擷取」以外的獨立標記。
2. **Given** `metadata-only`／`not-captured`，**Then** 顯示「未擷取」。
3. **Given** `truncated`、`stdout_bytes = 900000`、內嵌 64 KiB，**Then** 顯示「截斷（已存 64 KiB，共 879 KiB）」。
4. **Given** `partial` 且 `output_streamed: true`，**Then** 顯示「部分」，並指向同一 `command_id` 的後續輸出。
5. **Given** 一列 071 之前的外部 shell `command_end`，沒有 `completeness`、`output_disposition`、`captured_by`，**Then** 顯示「未知」，不顯示「未產生內容」也不顯示「完整」。
6. **Given** 內建終端機 `io.len = 0` 且有括號區段，**Then** 顯示「完整」並說明沒有輸出位元組；`io.unbracketed = true` 時顯示「未知」。
7. **Given** 某指令的時間區間與一筆 `system.capture_gap` 重疊，**Then** 完整性為「缺口」，並能跳到那筆缺口紀錄。

### User Story 2 — 每一種事件都打得開、叫得出名字（P1）

**Why this priority**：29 個種類今天只以原始字串標題或 JSON 呈現（10 的 A.3）；截圖在時間軸檢視器沒有圖（`timelineEvents.ts:89` 回 true，`TimelineEventInspector.tsx:413-449` 沒有截圖分支）；連線、C2、pcap 列用 HTTP 檢視器打開（`TimelineEventInspector.tsx:437-439`）。

**Independent Test**：對登記表中每一個 `active` 與 `legacy` 種類，用測試夾具中的範例列呼叫 `eventTitle()` 與閱讀器分派；斷言標題沒有走到 `eventTitle.systemOther`、`eventTitle.shellEvent` 或 `${agentType}: ${subtype}` 的預設分支，閱讀器不是因為「沒有分支」而落到 `fields`。

**Acceptance Scenarios**：

1. 在時間軸選中手動截圖 → 檢視器顯示那張圖；檔案已刪除時說「檔案已刪除」並指向 `screenshot_deleted` 紀錄。
2. 選中 `scanner:connection`、`scanner:packet_flow`、`pcap:port_scan` → 用 `packet-flow` 閱讀器，不是 HTTP 檢視器；`scanner:pcap_segment` 說明「封包檔不在 RedLog 內」並給出雜湊與原路徑。
3. 選中 `shell:capture_stopped` → 標題說「此終端停止記錄」，閱讀器是 `record-fact`。
4. 選中 `system:sanitized`、`system:retention_pruned_logged` → 標題說出它改了或刪了什麼，閱讀器顯示數量與適用範圍；舊列沒有適用範圍時說「未知」。
5. 搜尋結果的標題與時間軸同一句（`SearchPanel.tsx:25-45` 的第二份標題被移除）。

### User Story 3 — 新增一種事件時，漏改的地方會讓 CI 失敗（P1）

**Why this priority**：28 張以上的表沒有任何東西提醒（10 摘要 2）；唯一聲稱存在的完整性檢查其實不存在（見前提更正）。

**Independent Test**：在一個暫存分支上分別做以下四件事，每一件都讓 `npm run typecheck` 或 `npm test` 失敗，且失敗訊息指出種類與該補的欄位：(a) 在 `src/core` 以新的 subtype 呼叫入口；(b) 在 `hooks/shell-common.sh` 送一個新的 subtype；(c) 在登記表加一個沒有寫入者的種類；(d) 在登記表加一個種類但不給標題。

**Acceptance Scenarios**：

1. TypeScript 寫入者用了未登記的種類 → typecheck 失敗。
2. `hooks/`、`plugins/` 的寫入者送出未登記的種類 → `test/kinds/writers-registered.test.ts` 失敗，列出檔案、行號與種類。
3. 登記為 `active` 的種類找不到寫入者 → 同一測試失敗；要改成 `legacy` 必須寫明最後寫入它的版本與原因。
4. 登記的種類缺標題或閱讀器 → typecheck 失敗（`Record` 不完整）。
5. `src/core/kinds/` 任何檔案 import 了 Node 模組或目錄外的檔案 → `test/kinds/registry-pure.test.ts` 失敗。

### User Story 4 — 同一類事實在每個畫面上是同一種東西（P2）

**Why this priority**：10 的 B.2 列出 9 處分歧，其中 6 處操作者看得到：pcap 兩種形狀分在兩個泳道；連線在名為「代理」的泳道；`capture_gap` 分在兩個泳道；操作者自己加入的檔案在 Activity 被歸為「other」；`http_navigation` 的泳道叫「HTTP」而真正的 HTTP 叫「代理」；內務規則有三份且彼此不同（PowerShell profile 那一行在時間軸被藏起來，卻讓「首次使用」判定已有證據）。

**Independent Test**：對每個已登記種類，斷言時間軸泳道、Activity 動作、是否為內務、是否計入「工作」，全部從登記表讀出；並斷言 SQL 與 JS 的內務述詞對同一組範例列（含 PowerShell profile 行）回答相同。

**Acceptance Scenarios**：

1. `pcap:*`、`scanner:packet_flow`、`scanner:connection*` 同在一個以來源命名的連線泳道，用同一個閱讀器。
2. `scanner:capture_gap` 與 `system:capture_gap` 同在記錄本身的泳道。
3. `file_transfer:artifact_added` 在 Activity 的「證據」篩選中出現。
4. 「哪些列計入總數」由登記表的 `counts.total` 定義，與時間軸的內務規則同一份（10 的 A.4 #10）；狀態列改用這個定義計數的查詢屬於 074。
5. `knownLists.ts`、`housekeeping.ts`、`event-queries.ts` 中不再各有一份內務規則。

### User Story 5 — 外掛的種類有確定的位置與閱讀器（P2）

**Independent Test**：以一個測試用外掛 manifest 宣告兩個種類：一個指定 `reader: "packet-flow"`，一個不指定；另一個宣告 `reader: "my-viewer"`。斷言前兩者被接受（不指定者用 `fields`），第三者被拒並說明原因；三者的 tier 都是 logged，除非核心登記表已有該種類。

**Acceptance Scenarios**：

1. 外掛宣告的種類若已在核心登記表（例如 transparent-proxy 的 `scanner:http_request_start`），沿用核心的全部欄位，外掛的宣告只能更改標籤。
2. 外掛宣告的閱讀器不在 `ReaderId` 中 → 拒絕，外掛頁顯示原因（075 的 manifest 驗證介面）。
3. 外掛不能宣告顏色、圖示或自己的元件。

### User Story 6 — 「app 沒開」與「沒有事件」看得出差別（P2）

**Independent Test**：開專案、記錄、正常關閉、重開；再一次以 `kill -9` 結束後重開。斷言第一段結束時有 `reason` 為 `switched`、`app-quit` 等的 `system.project_closed`；第二段在重開時、`session_start` 之前有一列 `reason: unclean`，發生時間為上一次存活戳記；074 的投影據此回答「這段在錄」「這段沒在錄」「這段未知」。舊專案（沒有任何 `project_closed`）的每一段 app 未開期間都回答「未知」。

**Acceptance Scenarios**：

1. 正常關閉專案（關閉、切換專案、重新開同一個、結束 app、更新重啟）→ 在資料庫關閉前寫入一列 chained `system.project_closed`，經 071 的入口，帶 Spec 073 FR-033 的 reason。
2. 當掉 → 當時沒有 `project_closed`；下一次開啟時，若有上一個 session 的存活戳記，073 在 `session_start` 之前寫一列 `reason: unclean`、`last_alive_at`（這是重開時觀察到的事實，不改寫任何列）；沒有戳記時不寫，那一段為「未知」。
3. 暫停中關閉 → 照常寫入（`system` 暫停豁免）。

### User Story 7 — 區間、狀態與註記有宣告可循（P3）

**Independent Test**：對 `IntervalDef` 表斷言：每個 `start` 種類的登記 `shape` 是 `start`；每個區間至少有一個 `end` 或寫明 `open` 的意義；每個 `state` 角色的種類都屬於某個區間或階梯狀態；每個 `annotation` 種類都寫明附著對象。

**Acceptance Scenarios**：

1. 074 的投影程式碼中沒有以 `agent_type` 字面值判斷起訖的分支；它只讀 `IntervalDef`（由 074 的 gate 檢查，本規格提供資料）。
2. `pivot:*` 的開放區間被宣告為「偵測於 T」，不是「開著」（UX-005）。

### Edge Cases

- 外部生產者送來 `external:*`、`terminal:*` 的任意 subtype：以族（family）登記，`subtype: '*'`，閱讀器 `fields`，沿用今天的 chained 預設與舊入口行為（071 FR-113）。族登記必須寫明理由，數量由 gate 鎖住。
- AI adapter 的 `subtypeFor` 有開放分支（`optional-plugins/claude-code/adapter.ts:297-300` 回傳 `t.systemSubtype ?? 'system'` 與 `t.type`）：以 `agent:*` 族承接，閱讀器 `ai-transcript`；已知的 subtype 各自登記。
- 舊格式 `shell:command`（標題與內務規則仍讀它）：`legacy`。
- 同一種類的角色依列而異（截圖：手動是動作、指令結束自動拍是結果、標記觸發是附件）：登記的是預設角色；列上的 `trigger` 與 `_causes` 決定實際位置（074 的投影做）。
- 只存在於舊專案的種類（`system:ip_transition`、`system:api_started`、`system:secret_revealed`、`system:producer_heartbeat` 在 071 之後）：`legacy`，仍有標題與閱讀器，因為舊專案還會被打開。
- 外掛停用後，它的種類的舊列仍在專案中：沿用最後一次已知的宣告；連宣告都沒有時，用 `fields` 閱讀器、以儲存名稱為標籤。不失敗、不隱藏。
- 來源同時送 `completeness: complete` 與 `stdout_truncated: true`（矛盾）：取較不完整的那個（`truncated`），並以 `capture-health` 的計數記錄矛盾（不在閱讀器加字）。
- 同一列同時屬於缺口區間與截斷：完整性取「缺口」，閱讀器另列截斷的位元組數。
- 一列的種類不在登記表、也沒有外掛宣告（舊外掛寫的、或資料庫被手動插入）：`fields` 閱讀器、儲存名稱為標題，計入 `unregistered` 計數；不丟棄、不隱藏。

## Requirements *(mandatory)*

### Functional Requirements

#### A. 登記表（US2、US3、US4）

- **FR-001** 每一個事件種類（`agent_type × subtype`，或明列理由的 `agent_type × *` 族）在 `src/core/kinds/registry.ts` 恰好登記一次。登記表是 071 FR-113 所稱的「核心表」。
- **FR-002** 每個登記項目有下列欄位，全部必填（可為明示的「無」）。欄位定義、值域與今天對應的表見 plan「登記項目的欄位」：
  - 身分：`id`（`"<agent_type>:<subtype>"`）、`status`（`active`／`legacy`）、`legacy`（`legacy` 時必填：最後寫入的版本與原因）；
  - 角色與形狀：`role`、`shape`（`point`／`start`／`end`／`chunk`／`span-in-data`／`transition`）；
  - 寫入政策：`tier`、`pause`（`gated`／`exempt`／`gated-by-observation`）、`writers`（允許寫入的來源類別）；
  - 身分欄位：`identity.target`（套用 071 FR-010 目標規則的哪幾步）、`identity.terminal`、`identity.command`、`identity.flow`、`identity.agentSession`；
  - 因果：`cause`（`none`／`lifecycle`／`flow`／`socket`／`derived`／`trigger`／`candidate`）、`scopeSignal`；
  - 呈現：`title`（`TitleId`）、`labelKey`、`lane`、`band`、`activity`（`group` 與 `action`）、`reader`、`content`（內容類型清單）、`badges`、`transcript`；
  - 家族：`family`（封閉列舉 `KindFamily`：`commands`／`traffic`／`ai`／`artifacts`／`signals`／`record`），Spec 074 的變更主題 `rows:<family>` 與 `cause_counts` 的分組讀它；
  - 計數與內務：`counts.work`（是否算操作者的工作）、`counts.total`（是否計入總數）、`housekeeping`（`never`／`always`／列規則 id）；
  - 匯出：`export.attachment`、`export.summary`（計入匯出摘要的哪一項）、`export.har`；
  - 失效：`invalidates`（此種類寫入後哪些衍生答案失效：`scope`、`config`）。
- **FR-003** 種類的 tier 由登記表的 `tier` 決定；已登記種類的 `tier` 必須等於今天 `classifyTier` 對它的回答，除非列在 `TIER_CHANGES`（每項附決定與規格條號，初始只含 071 T027 的項目）。未登記的種類：`plugin:*` 來源 → logged；其他 → chained（071 FR-113）。
- **FR-004** 暫停時是否寫入由 `pause` 決定，取代 `PAUSE_EXEMPT_AGENT_TYPES`（`event-write.ts:380`）與 `delayedCapture`（`ingest.ts:162-163`）。判斷的時間基準由 071 FR-082 決定，本規格只宣告每個種類屬於哪一類。
- **FR-005** 誰可以寫入由 `writers` 決定，取代 `EXTERNAL_ALLOWED_AGENT_TYPES`（`external-event-policy.ts:12-20`）。來源類別的值域與 071 FR-071 相同，另加 `in-process`、`derived`。071 的種類政策以 `writers` 判斷，不另存一份清單。
- **FR-006** 推導出的種類（`loot`、`pivot`、`cleanup`、`credential_use`、`system:scope_violation`、`file_transfer:upload/download`）的 `writers` 只有 `derived`；經契約 1 入口的外部來源寫入它們回 `kind-not-allowed`。舊入口的狀態碼不變（071 FR-036）。這修正今天 `credential_use` 可被外部寫入、而同為推導的其他種類被拒的不一致（`external-event-policy.ts:4-8` vs `:14`）。`credential_use` 的部分待開放問題 Q2 確認後才實作。
- **FR-007** 不寫入任何一層的訊號（071 O7 的 `hello`／`alive`／`bye`）不登記為種類。`system:producer_heartbeat` 登記為 `legacy`，`writers` 只有 `legacy`。
- **FR-008** 全文索引對所有種類一致（`db/index.ts:431-461` 的觸發器不依種類過濾），登記表**不設**搜尋欄位；gate 釘住觸發器不引用 `agent_type`／`subtype` 作為條件。
- **FR-009** 登記表有版本 `KIND_REGISTRY_VERSION`（整數，只增）。登記項目的任何欄位變更都要增加版本，並在同一個變更中更新 golden。

#### B. 完整性 gate（US3）

- **FR-010** TypeScript 寫入者：071 的行程內入口與 `insertEvent` 的種類參數型別為 `KindId`（由登記表 `as const` 導出的字串聯集）。以 `string` 傳入種類的呼叫數為 ratchet，基準為 Phase 1 量得的值，只能下降，最終為 0。推導器（pivot、cleanup、憑證、alert）回傳的 subtype 型別必須是登記表中該族 subtype 的子集。
- **FR-011** 非 TypeScript 寫入者：`test/kinds/writers-registered.test.ts` 以各語言的寫入樣式掃描 `hooks/**`、`plugins/**`（樣式清單見 plan D2），並列舉兩個 AI adapter 的 `subtypeFor` 對其型別的全部輸入的輸出。每一個找到的種類都必須已登記，或由該外掛 manifest 的 `emits` 宣告。
- **FR-012** 反向：每一個 `active` 種類至少有一個寫入者（FR-010 的型別引用或 FR-011 的掃描結果）。找不到時，該項必須改為 `legacy` 並寫明理由；`legacy` 種類若又出現寫入者，測試也失敗（要求改回 `active`）。
- **FR-013** 每一個 `active` 與 `legacy` 種類都有標題、閱讀器、泳道與 `labelKey`。renderer 的 `TITLES: Record<TitleId, …>` 與 `READERS: Record<ReaderId, …>` 以型別保證完整；`test/kinds/examples.ts` 以 `satisfies Record<KindId, …>` 為每個種類提供範例列，供 US2 的測試使用。
- **FR-014** 每一個 `shape: 'start'` 的種類都出現在某個 `IntervalDef` 的 `start`；每一個 `shape: 'end'` 的種類都出現在某個 `end` 或 `supersededBy`。
- **FR-015** 族登記（`subtype: '*'`）只允許出現在 plan「族登記」列出的 agent type，每項附理由；數量是 ratchet。
- **FR-016** `src/` 中、`src/core/kinds/` 之外，以字面值比較種類的次數（`agentType === '…'`、`agent_type = '…'`、`case '<已知 agent_type>':` 等，樣式見 plan D3）為 ratchet，基準為 Phase 1 量得的值（起草時約 274 處、62 個檔案），只能下降。被允許長留的比較（例如閱讀器內部對自己內容欄位的判斷）列在允許清單並附理由；允許清單中不再命中的項目讓測試失敗。

#### C. 模組位置與純度（US3）

- **FR-020** `src/core/kinds/**` 只能 import 同目錄的檔案；`import type` 亦同。不得 import `node:*`、Node 內建模組名、`electron`、`better-sqlite3`，或任何 `src/core/kinds/` 之外的模組。gate：`test/kinds/registry-pure.test.ts`。
- **FR-021** 任何層都可以 import `src/core/kinds`。renderer 對種類的判斷只經由它與 renderer 端的兩個對應表（`TITLES`、`READERS`）。
- **FR-022** 從 `src/renderer/src` 以非 type 的 import 可走訪到、且 import Node 模組的 `src/core` 檔案數為 ratchet，基準 3（`config.ts`、`private-fs.ts`、`agent-capture-policy.ts`），只能下降。本規格不負責把它降到 0，但新增的一個會失敗。

#### D. 閱讀器契約（US1、US2、US5）

- **FR-030** 閱讀器為封閉列舉 `ReaderId`，依內容類型劃分：

  | ReaderId | 內容 | 今天對應的元件或缺口 |
  |---|---|---|
  | `text-output` | 指令輸出（內嵌、body store 參照、cast 區段）、背景輸出片段、PTY 片段、瀏覽器 console 訊息與堆疊 | `CommandEndDetail`、`BrowserConsoleDetail`；`session_output`、`command_output` 今天沒有 |
  | `terminal-recording` | 整段 cast 錄影 | `ReplayCommand mode="session"` |
  | `http-exchange` | 請求、回應、分段、WebSocket／TCP 訊息、body | `HttpDetail`（今天也被套用到非 HTTP 的 scanner 列） |
  | `image` | 截圖 | 今天沒有（時間軸檢視器） |
  | `file` | 操作者加入的檔案、檔案監看列、不在 RedLog 內的封包檔 | `EvidenceFileDetail` |
  | `packet-flow` | 連線、封包流、pcap 推導、C2 回報 | 今天沒有 |
  | `ai-transcript` | AI 對話與工具呼叫 | `AgentTurnDetail` |
  | `record-fact` | 缺口、暫停、改寫與刪除、設定變更、狀態轉移（前後值）、錨定 | 今天沒有 |
  | `note` | 操作者的標記與修正 | `MarkerDetail` |
  | `fields` | 通用：有標籤的欄位格 | `GenericEventDetail` |

- **FR-031** 每個種類只走一個閱讀器（登記表的 `reader`）。時間軸檢視器與 Activity 閱讀器用同一個分派；`hasSpecificEventDetail`（`timelineEvents.ts:87-96`）與檢視器內以 `agentType` 判斷的分支（`TimelineEventInspector.tsx:412-449`）被 `READERS[kind.reader]` 取代。
- **FR-032** 任何閱讀器的預設呈現都不是原始 JSON。原始資料只經由明確的「原始內容」動作取得（今天的 JSON 切換與 `content-contract` 的 `event_data` 欄位），且一律可取得。
- **FR-033** 有內容的種類（`content` 非空），閱讀器的第一行固定說出完整性，值為封閉列舉 `Completeness`：`complete`、`truncated`、`partial`、`not-captured`、`redirected`、`gap`、`unknown`。顯示文字見 plan D5；每個語系新增的字串不超過 8 個 key。沒有內容的種類不顯示完整性。
- **FR-034** 完整性只由 `completenessOf(kind, data, overlaps)` 這一個純函式決定，它只讀來源送來的欄位與 074 提供的「是否與缺口紀錄重疊」；規則依種類的 `content` 宣告（plan D5 的表）。沒有任何可判斷的欄位時回 `unknown`。`commandOutputState`（`content-contract.ts:136-146`）、`ioMark`（`timelineDomain.ts:205-219`）與 Transcript 的輸出狀態改為呼叫它。
- **FR-035** 每個閱讀器都能回到原始位元組：經 `ContentRef`（`content-contract.ts:3-8`）讀取 body store、cast 區段、檔案或 `event_data`。內容不在 RedLog 內的（pcap 檔、已刪除的截圖）說明位置與雜湊，不提供假的開啟動作。
- **FR-036** 外掛只能以 `ReaderId` 的值為它宣告的種類指定閱讀器；不指定時為 `fields`。manifest 的欄位與驗證流程屬於 075；本規格提供 `validatePluginKind(decl)`，回傳接受後的登記項目或拒絕原因。外掛宣告的種類若已在核心登記表，只有 `labelKey` 以外的欄位一律沿用核心。
- **FR-037** `src/core/event-registry.ts` 的外掛 `eventTypes`（label、lane、color、icon）被 FR-036 取代；`color`、`icon` 不再被接受（UIUX §1：色相保留給狀態）。

#### E. 角色、區間與註記的宣告（US6、US7）

- **FR-040** 每個種類的 `role` 是五種之一（O1）。角色是種類的**預設**；列的實際位置由 `_causes`、`trigger` 等列上的事實決定，計算屬於 074。
- **FR-041** 區間以 `IntervalDef` 宣告：`id`、`role`（`action`、`effect` 或 `state`；資料範圍在列內的缺口不屬任何角色）、`start`、`end`、`members`、`supersededBy`、`key`（`PairKey`）、`fallbackKey`、`open`（開放區間的意義）。plan D6 列出起草時的全部區間。
- **FR-042** 開放區間的意義為封閉列舉：`not-seen-ended`（「未見結束」，不是失敗）、`until-next-start`、`detected-at`（只宣告「偵測於 T」，不宣告「仍開著」）、`unknown-before`（舊資料無法判斷）。
- **FR-043** 階梯狀態（目前目標、IP 判定、proxy 啟停、opsec）以 `StateDef` 宣告：轉移種類與存放值的欄位；分組鍵（全域或每終端機）。
- **FR-044** 註記（`role: 'annotation'`）宣告附著對象：`cause`（`_causes` 的第一個來源列）、`time`（`atTimestamp` 或列時間）或 `event`（明示的事件 id，如標記的連結）。原本的泳道保留為「全部列出」（O2），由登記表的 `lane` 指定。
- **FR-045** record-fact 宣告其「適用區間」的欄位（例如 `applies_from`／`applies_to`）；舊列沒有時，適用區間為 `unknown`。本規格不要求任何來源開始送這些欄位；那是各來源自己的變更。
- **FR-046** 新增種類 `system:project_closed`（`role: record-fact`、`tier: chained`、`pause: exempt`、`writers: ['in-process']`）。內容：`reason`（封閉列舉，值由 Spec 073 FR-033 提供：`closed`、`switched`、`reopened`、`app-quit`、`update-restart`、`open-failed`、`unclean`），`reason = unclean` 時另有 `last_alive_at`（毫秒）。本規格擁有種類與欄位；寫入時機與 reason 的判定屬 073；寫入經 071 的單一入口。正常結束時它是該 session 的最後一列（資料庫關閉前）；`unclean` 由 073 在下一次開啟時、`session_start` 之前寫入，列的發生時間取上一次存活戳記（`last_alive_at`），這是下一次開啟時觀察到的事實，不改寫任何既有列。寫入失敗不阻擋關閉，記入 capture 狀態。
- **FR-047** `project-open` 狀態區間：`start = system:session_start`、`end = system:project_closed`（任何 reason）；下一個 `session_start` 之前沒有 `project_closed` 的區間（本種類出現之前的舊專案，或沒有存活戳記可據的當機），其結束的意義為 `unknown-before`（O3）。

#### F. 遷移（全部故事）

- **FR-050** 摺疊依 plan「遷移順序」：先摺操作者看得到分歧的純呈現表，再摺行為表（與 071 同步），最後摺匯出與外掛的表。每摺一張，以字面值比較的 ratchet（FR-016）與表的計數同時下降。
- **FR-051** 每張表摺疊前，Phase 1 先以今天的程式碼對每個已登記種類的範例列產生 golden（`test/kinds/golden/<表>.json`）；摺疊後，新答案與 golden 相等，只允許 `DOCUMENTED_FIXES` 中列出的項目不同。每一項附：表、種類、舊答案、新答案、本規格的 FR 或 US 編號。
- **FR-052** 第一批（純呈現）以外，不改任何行為；`DOCUMENTED_FIXES` 在起草時的全部內容見 plan D7。
- **FR-053** 舊專案：不寫入、不更新任何既有列；登記表只影響呈現與新列。舊列的種類若已不在登記表的 `active` 中，以 `legacy` 項目呈現。
- **FR-054** 另一分支正在以手寫分派修正最嚴重的閱讀器錯配（起草時 `work/1112-present` 尚無提交）。不論它先或後合併，它的每一個分派決定都抄進登記表的 `reader`，並成為 FR-051 的 golden 的一部分；它的手寫分派在 Phase 3 被 `READERS[kind.reader]` 取代，不並存。

### Key Entities

- **事件種類（Event Kind）**：`agent_type × subtype`，或附理由的 `agent_type × *` 族；登記表的一個項目。
- **登記表（Kind Registry）**：`src/core/kinds/` 的純資料模組，回答「這個種類是什麼」的每一個問題。
- **角色（Role）**：action、effect、state、record-fact、annotation。
- **區間宣告（IntervalDef）／階梯狀態宣告（StateDef）**：074 的投影所消費的資料。
- **閱讀器（Reader）**：依內容類型的十種之一；外掛只能從中挑選。
- **完整性（Completeness）**：閱讀器第一行的七值之一，只依來源事實。
- **有記錄的修正（Documented Fix）**：摺疊時唯一允許與 golden 不同的項目。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** 在 `src/core/kinds/` 之外，以種類為鍵的表：33 → 0（plan「表的清點」中標為「不是種類表、留在原處」的除外，起草時 2 張：`TOOL_ACTIONS` 與 capture-health 的來源探測，後者移交 075）。
- **SC-002** 字面值種類比較的 ratchet（FR-016）從基準下降至少 70%。
- **SC-003** 100% 的 `active` 與 `legacy` 種類：標題不走預設分支、閱讀器不是因為缺分支而為 `fields`、有泳道與 `labelKey`。
- **SC-004** 10 的清單 (1) 的 29 個種類：29 → 0 個只以原始字串或 JSON 呈現。
- **SC-005** relay 的每一種 `(completeness, output_disposition)` 組合、內建終端機的 `io` 三種情況、無欄位的舊列：閱讀器、時間軸點與 Transcript 的完整性三者一致（US1）。
- **SC-006** 每張摺疊的表：golden 與新答案的差異數 = `DOCUMENTED_FIXES` 中該表的項目數。
- **SC-007** 寫入端掃描（FR-011）在三個平台的 unit leg 都有執行；漏掉的寫入樣式以已知盲點列在測試檔頭，不靜默。
- **SC-008** renderer 可走訪到的 Node 模組檔案數（FR-022）：不高於 3。
- **SC-009** 介面沒有新增頁面或路由；新增的字串每個語系不超過 16 個 key（完整性 7 個、閱讀器標題、泳道改名），並通過 `test/ui-copy.test.ts`。
- **SC-010** 舊列：0 列被 UPDATE；`events.jsonl` 匯出逐位元組不變（沿用 071 T002 的 golden）。

## Assumptions

- 單一使用者、單機（產品規則）。登記表不是安全邊界：它決定呈現與政策的**資料**，強制由 071 的入口執行。
- 「種類」以 `agent_type` 與 `subtype` 欄位為準；`subtype` 是 `data.subtype` 的去正規化欄位（既有）。不新增欄位。
- 範例列（`test/kinds/examples.ts`）是測試資料，不進正式程式碼，不受 FR-020 限制。
- 074 會提供「列是否與缺口紀錄重疊」（FR-034）與區間投影；在 074 落地前，`gap` 狀態只在閱讀器已載入的列中判斷，並標明這是有限的判斷（Phase 3 的過渡）。
- 073 提供專案關閉前的掛鉤與 reason（FR-046）；在 073 落地前，`project_closed` 由今天的關閉路徑（`src/main/index.ts` 的專案切換與 `before-quit`）呼叫同一個寫入函式，這段過渡只產生 `switched`、`app-quit`、`update-restart`；`closed`、`reopened`、`open-failed`、`unclean` 由 073 T051 加入。

## 不在範圍

- 區間、狀態帶、`stateAt(T)`、effect 總數的**計算**與查詢工作執行緒（074）。
- 信封、蓋章、回執、憑證、暫停的時間基準、目標決定演算法本身（071）。本規格只宣告每個種類套用哪些規則。
- 來源狀態模型與 manifest v2 的格式（075）；`capture-health.ts` 的來源探測表（#28）改由 075 的來源描述列出它證明的 `KindId`。
- 專案執行期與關閉流程（073）。
- 時間軸的視覺改版：動作畫成區間、效應附著的繪製、狀態帶的繪製（另案）；本規格只改泳道歸屬與標題。
- 篩選放在哪裡、是否跨頁共用（10 的 E.7，階段 6）：屬 Spec 074，它以每頁持有的篩選取代 Spec 038 的共用篩選（074 FR-085–FR-088）。本規格只提供每個類型值的標籤（`labelKey`）；類型篩選的值（`agent_type`）與比對語意不變。
- 確定性歸屬（`REDLOG_COMMAND_ID`、proxy userinfo；071 O18）。
- 把 `pcap:*` 與 `scanner:packet_flow` 合併成一種寫入形狀；本規格只讓兩者的呈現一致。
- 在 bundle 內附 `kinds.json` 或區間檔（會改變 bundle 格式，#711）。
- CSV 匯出（不存在，不新增）。

## 開放問題（需要擁有者）

> **2026-11-12 擁有者答覆**：以下各項均照「建議」欄採納（Q1 新的瀏覽器 console 列改回 logged，既有列不動；Q2 契約 1 拒絕外部寫入 `credential_use`，舊入口不變；Q3 匯出不附 `kinds.json` 與 `intervals.jsonl`）。這是決定，尚未實作。

| # | 問題 | 建議 |
|---|---|---|
| Q1 | 瀏覽器 console 列今天因 `LOGGED_TIER` 的鍵寫錯而是 chained；新列是否改為設計原意的 logged？ | 改。列入 `TIER_CHANGES`，只影響新列，舊列不動；理由與 DESIGN-two-tier-chain §2.3 相同（console 是足跡，不是證據）。若不改，就把 `LOGGED_TIER` 中的 `'browser:console'` 刪掉，使文件與事實一致 |
| Q2 | `credential_use` 今天外部可寫；契約 1 是否拒絕？（FR-006） | 拒絕契約 1 憑證寫入；舊入口維持今天的行為直到 071 FR-037 移除它。理由：它是 RedLog 的推導，偽造它就是偽造 RedLog 的結論（`external-event-policy.ts:4-8` 自己的理由） |
| Q3 | 匯出是否附上登記表版本與每列的角色（`kinds.json`），以及 Spec 074 的區間投影（`intervals.jsonl`）？（074 的「不在範圍」指向本題） | 兩者都不做：會改變 bundle 格式（#711 的第 4 版剛定）。NDJSON 的每列已有 `agent_type`／`subtype`，讀者可用公開的登記表對照；區間可由列重算 |

## 與既有文件、程式註解、規格的矛盾

| 位置 | 它說 | 本規格 |
|---|---|---|
| `src/core/db/event-write.ts:96-99` | `tier-classifier-total` 測試強制每個實際寫出的種類都有 tier | 該測試沒有掃描（前提更正）；FR-010–012 才是 |
| `event-write.ts:58-61`、DESIGN-two-tier-chain §2.3 | 瀏覽器 console 為 logged | 實際為 chained（前提更正）；開放問題 Q1 |
| DESIGN-two-tier-chain §2.4 | 外掛的種類預設 chained | 071 FR-113：logged（071 T082 修訂該文件；本規格的 T072 確認） |
| DESIGN-two-tier-chain §2.2 的 `system` 列 | 列出 `agent_connect`、`attr_hide`、`interactive` 等為 system | 這些是 pivot／cleanup 的 subtype；§2.2 改為指向登記表（T072） |
| `src/core/external-event-policy.ts:4-8` | 推導的種類不可由外部寫入 | 同檔 `:14` 允許 `credential_use`；FR-006 修正（契約 1 入口） |
| `src/core/content-contract.ts:123-133` | 每個閱讀器都問這個函式；`not-captured` 表示外部 shell | 不讀來源的完整性欄位；relayed 已是預設；FR-034 取代 |
| `src/renderer/src/lib/timelineEvents.ts:85-86` | 其他種類都走通用閱讀器，新來源不需改核心 | 截圖回 true 卻沒有分支；FR-031 |
| 報告 10 A.1、B.1 | 瀏覽器 console logged；28 張表 | 前提更正 |
| Spec 071 plan D10（起草時） | 另立一張 `CORE_CHAINED` 表，與 `LOGGED_TIER` 互斥 | 已於 2026-11-12 對帳時改寫 071 D10：登記表本身列出全部 chained 種類，`CORE_CHAINED` 不另立；`classifyTier` 只呼叫 `tierFor`（plan D10）。071 T027 與本規格 T040 同一個 PR，寫入 `TIER_CHANGES` |
| Spec 038（Verified）的共用篩選 | 類型以 `agent_type` 篩，且篩選跨頁共用 | 類型的值與比對語意不變，本規格只換標籤來源（T024 的 PR 不改 038）。篩選的歸屬（跨頁共用 → 每頁持有）由 Spec 074 取代，038 的標註在 074 T073 |
| Spec 004、009（Verified）中對外部 shell 輸出顯示的斷言 | 「未擷取」與「沒有輸出」的字串 | 依 CLAUDE.md「Changing behaviour」，T030 一併修改相關 spec 與測試 |
| `docs/event-schema.md` | 一份手寫的種類表（85 行表格） | 改為由登記表產生或指向登記表（T071） |

## Domain References

- `.specify/memory/constitution.md` II（介面誠實：完整性、未知）、III（單一實作：一張種類表）、VI（未知與空不同）、VII（推導列保留來源：註記附著）、IX（新模組解決 33 張表的重複）。
- `docs/domain/glossary.md`：Event、Chained／Logged Event、Evidence、Activity、Marker、Cause；Domain Invariant 5、6、9。本規格新增 Event Kind、Role、Reader、Completeness（T070）。
- `docs/design/DESIGN-two-tier-chain.md` §2；`docs/UIUX-STANDARD.md` §1、§9、§25。
- Spec 071（FR-010、FR-071、FR-082、FR-111、FR-113、T027、T082）；073、074、075（同批起草，介面見 plan「與兄弟規格的介面」）。
