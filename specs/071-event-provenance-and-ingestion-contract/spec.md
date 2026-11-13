# Feature Specification: 核心蓋章的事件身分與來源、單一寫入契約

**Feature Branch**: `spec/ingestion-contract`
**Created**: 2026-11-12
**Status**: Draft
**Input**: [根因審查與落地計畫](../../docs/records/2026-11-12/ROOT-CAUSE-REVIEW.md) 階段 1「核心替事件蓋上身分與來源」與階段 4「統一的寫入契約」；根因報告 [01](../../docs/records/2026-11-12/root-cause/01-capture-integrity.md)（F1–F7）、[05](../../docs/records/2026-11-12/root-cause/05-trust-boundaries.md)（F2）、[07](../../docs/records/2026-11-12/root-cause/07-architecture.md)（F2、F3）、[02](../../docs/records/2026-11-12/root-cause/02-main-thread.md)（§3）；同類系統研究 PRIOR-ART-B、PRIOR-ART-A §6／§8.5（`docs/research/`，#709）；2026-11-12 擁有者決定。

> 本檔只寫可觀察的行為與對外契約。設計理由、被否決的做法、資料形狀、遷移順序與驗證方式在 [plan.md](plan.md)。契約本文（給來源實作者讀的那份）會成為 `docs/domain/SPEC-ingestion-contract.md`（tasks T080）；本規格與它衝突時，以本規格為準，直到該文件建立。

## 決策與範圍

### 已決議（擁有者，2026-11-12；本規格不重開）

| # | 決定 | 落點 |
|---|---|---|
| O1 | API 權限依能力分級；每個來源各有自己的憑證；hook 與外掛只能寫入事件，不能匯出、刪除、遮罩、seed 或切換錄製；已安裝的 hook 與外掛需重新取得憑證 | G |
| O2 | 身分與來源由接收端（核心）蓋章，新列的蓋章內容納入雜湊；用戶端自述的欄位另外保存，視為不可信 | A、B |
| O3 | 既有事件的雜湊、簽章、鏈結方式一律不變；不改寫既有列；既有專案照舊開啟、驗證、匯出 | B、升級 |
| O4 | 不做多人或中央架構；核心最小且可信，來源以外掛形式接在同一份契約後面；不預設操作者用哪些工具；記錄失敗不得打斷操作者，但每一筆遺失都要留下上鏈、可見的缺口紀錄；不新增頁面，介面文字最少 | 全部 |
| O5 | Bundle 為第 4 版並有匯出封存（另一變更，#711） | 依賴 |
| O6 | 每個外掛 Source 一把只能寫入的憑證，允許的事件種類取自其 manifest 的 `emits`；停用或撤銷 Source 即撤銷憑證，接收端從此拒收其事件 | G |
| O7 | 來源的心跳／存活訊號不是事件，不寫入任何一層 | K |
| O8 | 外掛宣告、但不在核心表內的 subtype 一律進 logged 層；只有核心的表能把一種事件升為 chained | K |
| O9 | 第三方來源只能手動設定；官方 AI adapter 從 app bundle 在行程內執行，不用 token；同意以專案為單位 | G、I |

> **Superseded（2026-11-13，修訂 A4）**：O9 的「同意以專案為單位」改為：AI adapter 的啟用與同意是機器層；**哪個工作階段記到哪個專案**仍是逐專案的選擇，且可重新綁定（Spec 073 F 段修訂、Spec 076 FR-045–046）。O9 的其餘部分不變。
| O10 | 每個有 adapter 的本機 shell 都裝 hook；hook 啟動時經本契約送出 hello，作為「此 shell 有被記錄」的證據；shell 初始化時 hook 不輸出任何文字；專案被切換的終端機進入暫停，綁定的專案重新開啟時恢復，並寫入 `capture_resumed`；A 的指令絕不記到 B | A、H、J、K |
| O11 | 沒有可擷取目標的列帶 `target_via`（目標如何決定），並承接同一終端機最後擷取到的目標，不承接全域的目前目標 | A |
| O12 | 機器／個人層級的設定移到 `~/.redlog/machine.yaml`，操作者身分是其中之一 | 依賴（operator 蓋章讀取它；搬遷本身不在本規格） |
| O13 | （原開放問題 Q1）AI 工具整合預設取得 `agent-tools` 憑證：可寫入 `agent`、`marker`，另可讀取狀態；不含控制錄製、搜尋內容或變更設定 | G |
| O14 | （原 Q2）舊入口與舊版憑證的保留期依 FR-037；移除另立規格並附 gate | C |
| O15 | （原 Q3）算不出交接檔 MAC 的 shell（沒有 python3），其交接檔進隔離區（`unauthenticated`），保留並計數，不自動寫入 | F |
| O16 | （原 Q4）不屬於任何終端機的 app 內操作（標記、手動截圖、`artifact_added`），由 app 在操作當下明確帶入所選目標，記為 `target_via: "operator-selected"`；接收端不自行套用全域目前目標 | A |
| O17 | （原 Q5）外掛 Source 停用後才送達的積壓一律拒收，計為有意（`credential-revoked`） | E、G |
| O18 | 因果歸屬不用猜的：指令 id 由環境變數 `REDLOG_COMMAND_ID` 帶給子行程，並在 proxy 位址的 userinfo 帶標記，兩者都做、userinfo 先上；都取不到時不寫 `_causes`（[擷取種類盤點](../../docs/records/2026-11-12/root-cause/10-capture-kinds-and-presentation.md) 問題 4；proxy userinfo 的可行性尚未實測） | 待併入 A、I 與 tasks |

> 本檔與 plan、tasks 中仍寫作「開放問題 Q1–Q5」之處，分別對應 O13–O17，已決定。O18 是起草後才做的決定，FR 與 tasks 尚未為它展開，動工前需補上（Spec 074 Phase 5 的 `cause_counts` 依賴它，見 [specs/README.md](../README.md)「071–075 的跨規格順序」）。新的未決事項見文末「開放問題（需要擁有者）」。
>
> **2026-11-12 跨規格對帳（071–075）**：本規格依同批起草的 072–075 做了下列增補，均為新增、不改既有列的形狀：`_ingest.rules`／`rules_partial`（FR-005、FR-006，Spec 075 的 Processor 規則紀錄）；`/api/whoami` 回傳呼叫者來源的狀態（FR-07B，Spec 075）；`CommitReceipt`（FR-096，Spec 074）；`terminal_targets` 的回填歸屬（FR-010，Spec 074）；種類的 tier 改由 Spec 072 的登記表回答（FR-113）；每個來源在本專案的第一次與最近一次接受（FR-056，Spec 075）。另依 Phase 1 實作（#716）更正三處事實：直接呼叫 `insertEvent(` 為 31 處；`PRAGMA synchronous` 實為 NORMAL（其後依 Q6 改為 FULL）；relay 不重試 5xx。

### 修訂（2026-11-13）

依 [2026-11-13 的決定](../../docs/records/2026-11-13/DECISIONS.md) §2、§5 與同日擁有者對 Spec 076 的修訂。被取代的原文保留在原處，以「> **Superseded（2026-11-13）**」標示。

| # | 改了什麼 | 為什麼 | 落點 |
|---|---|---|---|
| A1 | **出口進每一筆新事件**：接收端把最後讀到的出口位址填進既有的 `source_ip` 欄位（已在雜湊輸入內，今天寫死 `null`，`event-write.ts:609,723`），讀取時間、方式與狀態放在 `_ingest`；出口改變時寫一列帶位址的 `system:egress_changed`。舊列不動 | DECISIONS §5 #2；14 號審查 D(1)：deconfliction 的核心欄位不在紀錄裡 | M 段 FR-120–123 |
| A2 | **遠端主機與跳板上的 hook 正式支援**：事件寫回本機接收端，以只能寫入、限定單一專案的 `remote:<名稱>` 憑證（FR-071 已列）；規定遠端存什麼、永不存什麼；取代 `hooks/vps-deploy.sh` | DECISIONS §5 #3 | N 段 FR-130–134 |
| A3 | **每筆指令事件帶 hook 能知道的終端機事實**：使用者、tty／pane、shell，以及 shell 知道自己在遠端時的主機 | 14 號 F #4；多工器使用者以 pane 分辨 | L 段 FR-088 |
| A4 | **來源屬於機器**：移除以專案為單位的來源啟用（FR-07A 的外掛部分、FR-072 的發放時機、O9 的同意以專案為單位）；保留專案層的**綁定**（終端機 pin，FR-085；AI 工作階段的選擇仍逐專案，Spec 073 F 段修訂） | DECISIONS §2；Spec 076 E5、R1 | O9、FR-07A、FR-072 的標示；FR-07C |
| A5 | **暫停規則正在實作分支上改寫**：FR-080–084 與 US2 依 DECISIONS §6 改為「即時入口依收到時間判斷、暫停中即拒收；暫存檔恢復後只採信通過驗證的來源時間與已記錄的暫停區間」。本修訂**不動**這些條文，只加指標 | DECISIONS §6 | US2、H 段的指標 |
| A6 | **第一次綁定的提示與 `redlog private`** 是來源端行為，進共用向量 | DECISIONS §5 #1；Spec 076 FR-043、FR-044 | L 段 FR-086、FR-087 |
| A7 | 擴充功能（Spec 076）的 `plugin:<id>` 憑證可另帶受 manifest `reads` 限定的 `read` 能力，供 L0 讀取 API（`/api/v1/*`）；Exporter 不寫事件，送出紀錄由核心以行程內入口寫入 | Spec 076 FR-062、FR-091 | FR-070 的指標 |
| A8 | **operator 只在機器層**（DECISIONS §9 對 Spec 073 Q4 的答覆）：FR-009 的「本專案已知的操作者」只由機器層 operator 曾經生效的值構成；沒有專案層的 operator 來源 | Spec 073 修訂 B7、FR-01D | B 段 FR-009 的註記 |

> **指標（2026-11-13）**：[Spec 077](../077-personal-content-and-delivery/spec.md) 依賴本規格：操作者憑證的能力 `append(delivery_mark)`、有意遺失原因 `ignored-rule` 與 `shell-history-rule`、`target_via`（FR-010）作為「確定的目標」的依據；077 也記錄了擁有者對 `redlog private`（FR-086、FR-087）與遠端 hook（FR-130–134）的新裁定，條文的修改不在 077 內。

### 本規格自行決定的（理由與被否決的替代方案見 plan.md）

1. 接收端蓋的來源資料放在新列 `data` 的**唯一保留鍵 `_ingest`**。雜湊公式不變，舊列與新列由同一條規則驗證（plan D1）。
2. 新增寫入入口 `POST /api/ingest`（契約第 1 版，逐項回執）。`POST /api/events` 保留為舊版入口，每種情況的狀態碼與今天相同（plan D3）。
3. 冪等鍵 `event_id` 由來源在觀察當下產生；（來源、`event_id`）永久唯一，跨兩層、也跨保留期刪除。帶 `event_id` 的項目不再套用 2 秒內容去重（plan D4）。
4. 交接目錄 `~/.redlog/handoff/<project>/{tmp,new,quarantine}` 取代 `~/.redlog/pending/`。交接檔以來源憑證衍生的 MAC 認證，並套用與 API 相同的種類政策（plan D6）。
5. 遺失帳本：來源回報累計計數，接收端以序號推導缺口，缺口以既有的 `system.capture_gap` 上鏈（plan D5）。

### 前提更正（已在程式碼確認）

- **內建終端機的指令事件不在行程內寫入。** 它們由 pane 內執行的 shell hook 經 HTTP、以全域 token 送到 `/api/events`（`hooks/shell-common.sh:593` 自報 `source: builtin-terminal`；`src/main/terminal-manager.ts:665-683` 只給 PTY `REDLOG_TERMINAL`／`REDLOG_TERMINAL_ID`）。行程內寫入的只有 session 生命週期列（`terminal-manager.ts:162,170,271,540,547`）。所以內建終端機也需要憑證（FR-071）。
- `data.source === 'builtin-terminal'` 是 payload 的自報欄位，有 25 處程式依它分流或做存取判斷（05-F2）。

## User Scenarios & Testing *(mandatory)*

| 故事 | 優先級 | 摘要 |
|---|---|---|
| US1 延遲送達的事件仍屬於觀察當下 | P1 | 只記一次；專案、操作者、目標依觀察當下決定；來源資訊在雜湊內 |
| US2 暫停期間的內容永遠不會補進紀錄 | P1 | 來源在觀察點丟棄並計為有意；接收端以持久化的暫停區間再判一次 |
| US3 每一筆遺失都留下可見、上鏈的缺口 | P1 | 審查找出的不計數情況全部計數；有意與非有意分開 |
| US4 來源憑證只能寫入，交接檔不能變成任意型別的簽章列 | P1 | 能力分級；交接檔經同一政策與 MAC |
| US5 升級不打斷舊專案與已安裝的 hook | P2 | 舊列逐位元組不變；舊 hook 降為只能寫入、仍持續記錄 |
| US6 來源拿到明確回執並依回執行動 | P2 | 封閉的結果列舉，取代以狀態碼猜測 |
| US7 一份用戶端規格，各語言用同一組向量證明 | P3 | 相容矩陣由測試結果產生 |

### User Story 1 — 延遲送達的事件仍屬於觀察當下（P1）

操作者在 RedLog 關閉時打的指令、主行程卡住時被暫存的事件、重啟後才送到的背景工作輸出，送達時：只記一次；歸到觀察當下的專案與操作者；目標依觀察當下的規則決定，不取「現在」的目前目標；每一列都看得出是經哪個入口、由哪個來源進來，且這份資訊在雜湊內。

**Why this priority**：重送與重啟目前會造成重複列、錯誤的目標與永久錯誤的 `unattributed` 標記，而且寫進鏈後無法更正（01-F2、F5）。

**Independent Test**：「重啟等價」。同一串事件分三種方式走完：(a) 即時送達，(b) 中途重啟，(c) 全部經交接目錄。三者寫出的列在 `engagement_id`、`operator_id`、`target_id`、`_causes`、`_ingest.target_via` 完全相同，只有 `_ingest.door`／`auth` 與收到時間不同。再做「已 commit 但回應遺失、重送」的故障注入，列數不變。

**Acceptance Scenarios**：

1. **Given** 一筆已寫入的事件，**When** 同一個 `event_id` 經任一入口再送 1000 次，**Then** 只有 1 列，每次回執都是 `duplicate` 並帶原列 id。
2. **Given** 終端機 T 在 10:00 擷取到目標 10.0.0.5，操作者 10:05 把全域目前目標改成 10.0.0.9，**When** T 在 10:03 觀察到、10:30 才送達一筆沒有可擷取目標的事件，**Then** 該列 `target_id = 10.0.0.5`，`_ingest.target_via = "terminal-last"`。
3. **Given** 項目在專案 A 開著時被觀察，送達時開的是 B，**When** 送達，**Then** B 沒有任何列；項目留在 A 的交接目錄，A 開啟後寫入 A。
4. **Given** 來源在 `data` 中自填 `_ingest` 與 `_clock_anomaly`，**When** 寫入，**Then** 列上的 `_ingest` 是接收端蓋的，來源自填的值不在列上，`_ingest.stripped` 記下被移除的鍵名。
5. **Given** 同樣內容分別經 API、交接檔、行程內送入（不同 `event_id`），**Then** 三列除 `_ingest.door`／`auth`／`credential` 與收到時間外完全相同。

### User Story 2 — 暫停期間的內容永遠不會補進紀錄（P1）

> **修訂中（2026-11-13，修訂 A5）**：本故事與 FR-080–084 正在實作分支上依 DECISIONS §6 改寫（即時入口依收到時間判斷；暫存檔恢復後只採信通過驗證的來源時間與已記錄的暫停區間）。下文是 2026-11-12 的版本，以實作分支合併時的改寫為準。

**Why this priority**：暫停中 app 當掉後，spool 會把暫停期間打的指令重放進 chained 紀錄；暫停前就該寫入的 `command_end` 則永遠卡在 spool（01-F4，違反 DESIGN-capture-trust §3）。

**Independent Test**：property test。隨機產生暫停區間、隨機觀察時間的項目，以及隨機的入口與送達時間。驗證兩層都沒有任何列（`system`、`marker` 與既有的 `bypassPause` 除外）是在暫停期間收到的；交接檔中可用的來源時間落在已記錄暫停區間內的項目一筆都不寫入；暫停前觀察到的交接項目在暫停結束後都會寫入。

> **修訂（2026-11-13）**：原本的「依觀察時間判斷、暫停中也寫入暫停前的項目、暫停中照常排空」改為下列較小的規則。理由：來源提供的觀察時間是**自述，不是事實**。信任它的規則在三種情況把暫停期間的內容寫進紀錄（Phase 2 審查的 probe）：來源時鐘慢 30 秒、暫停 10 秒時送達（P8）；relay 的 chunk 以第一個位元組蓋時間、暫停後 1 秒才送出（P12）；暫停中系統時鐘倒退（P1）。新規則只修 Phase 1 釘住的兩個缺陷（T008 的 (a)、(b)），而且不會外洩：即時入口依收到時間；交接檔只在暫停結束後、依**已記錄**的暫停區間判斷。來源在觀察點丟棄（FR-081）留給後續階段。

**Acceptance Scenarios**：

1. **Given** 錄製中於 10:00 觀察到 `command_end`，10:01 暫停、10:02 恢復，**When** 10:05 才從交接目錄送達，**Then** 寫入。今天會永久卡住。
2. **Given** 暫停中 app 當掉，操作者繼續在終端機打指令，**When** 重開專案，**Then** 這段期間觀察到的指令一筆都不寫入，計為有意（`paused`）。
3. **Given** 暫停中，**When** 來源觀察到活動，**Then** 來源不建立項目、不寫交接檔，只把 `paused` 計數加一。
4. **Given** 目前是暫停狀態，**When** 交接目錄有暫停前觀察到的項目，**Then** 留在交接目錄，暫停結束後寫入（修訂 2026-11-13；原為「照常寫入，不必等恢復」）。

### User Story 3 — 每一筆遺失都留下可見、上鏈的缺口（P1）

**Why this priority**：spool 達上限、磁碟滿、`.bad` 隔離、relay 最後一列被拒、沒有 port，目前都沒有計數，也不出現在介面上（01-F3）。

**Independent Test**：對每個情境做故障注入，斷言每個來源 instance 都滿足「嘗試數 = 寫入 + 有意遺失 + 非有意遺失 + 待確認」。結算後，非有意的部分有一列 chained `system.capture_gap`。

**Acceptance Scenarios**：

1. 交接目錄已滿 → 不寫檔，計 `handoff-full`；結算後有缺口列。
2. 交接檔寫入失敗（磁碟滿）→ 計 `handoff-write-failed`。若連計數都送不到，接收端由序號缺口推出，列為「原因未知」。
3. 交接檔損毀或解析失敗 → 移入隔離區，檔名帶原因，計數並寫缺口列。
4. relay 的最後一列被拒，或 relay 沒送 `bye` 就結束 → 缺口列指出該指令與該 instance。
5. 來源找不到 port → 寫交接檔，不丟棄。
6. 來源憑證已撤銷 → 其交接檔移入隔離區（`credential-revoked`），計為有意。
7. 有意與非有意分開呈現；`plumbing`、`duplicate` 不計為遺失。

### User Story 4 — 來源憑證只能寫入；交接檔不能變成任意型別的簽章列（P1）

**Why this priority**：今天一把 token 代表全部權限，發給的正是最容易接觸敵意內容的呼叫者（05-F2）。任何同使用者程序往 `~/.redlog/pending/` 放一個 `system` 檔，就能得到經操作者金鑰簽章的 chained 列，因為 spool 重放繞過了外部事件政策（01-F7(a)）。

**Independent Test**：路由能力表測試，再加上以每一類來源憑證呼叫每一條非寫入路由，全部回 403。在交接目錄放入 `system` 型別、沒有 MAC、MAC 錯誤的檔，全部不產生列，移入隔離區並計數。

**Acceptance Scenarios**：

1. hook 憑證呼叫 `/api/recording`、`/api/export/bundle`、`/api/sanitize`、`/api/events/search` → 403，任何狀態都不改變。
2. 同使用者程序在交接目錄放入 `agent_type: system` 或 `marker`／`amended` 的檔，即使 MAC 正確 → 拒絕（`kind-not-allowed`），移入隔離區。
3. 沒有 MAC 或 MAC 錯誤 → 隔離（`unauthenticated`）。
4. 停用外掛 Source → 之後送達的事件被拒（`credential-revoked`）並計數。
5. 憑證不出現在任何行程的 argv 或子行程環境變數中，內建終端機的 pane 也一樣。

### User Story 5 — 升級不打斷舊專案與已安裝的 hook（P2）

**Independent Test**：用目前 main 產生的 golden 專案與 bundle 驗證：升級後兩個 verifier 的結果與升級前相同；舊列匯出的 `events.jsonl` 逐位元組相同；舊列沒有任何 UPDATE。另外，一個已載入舊 hook 函式、未重新 source 的 shell，升級後仍持續寫入，但只能寫入；capture 狀態看得出它用的是舊入口。

**Acceptance Scenarios**：

1. **Given** 舊專案，**When** 新版開啟、記錄、匯出，**Then** 舊列的位元組與雜湊不變，新 capture session 的 `session_start` 帶 `_ingest`。
2. **Given** 升級前就開著的 shell，**When** 升級後執行指令，**Then** 仍被記錄（舊入口，能力為只能寫入），但不能再暫停錄製或匯出。
3. **Given** 舊的 per-project token 被複製到 VPS 或外掛，**When** 升級，**Then** 該值只剩寫入能力；CLI 改用新的操作者憑證，繼續可用。
4. **Given** 舊版入口，**Then** 舊 producer 對每一種情況收到的狀態碼與今天相同，只多出欄位。

### User Story 6 — 來源拿到明確回執並依回執行動（P2）

**Independent Test**：對 mock receiver 注入每一種 outcome 與 reason，斷言每個用戶端的反應都符合 FR-031 的表。

**Acceptance Scenarios**：

1. **Given** commit 失敗（故障注入），**Then** 回執為 `retry`，不是 `accepted`。
2. **Given** 一批 5 項、結果各不相同，**Then** 回執與請求同序同長，`written` 等於 `accepted` 的數目。
3. **Given** 回應的 `written` 與逐項結果不一致，**Then** 來源把整批視為 `retry`。

### User Story 7 — 一份用戶端規格，各語言用同一組向量證明（P3）

**Independent Test**：CI 對每個 producer × runtime 執行共用向量，由結果產生相容矩陣；每個 producer 的 xfail 清單只能變短。

**Acceptance Scenarios**：

1. bash 3.2、bash 5、zsh、PowerShell 5.1、PowerShell 7、Python、Node 的來源都通過必要向量，或以 xfail、`not-run` 加原因明列。
2. 載入 hook 的輸出為 0 位元組；第一次綁定專案時送出 `hello`。
3. `new/` 中從不出現寫一半的檔；`event_id` 在重送間不變；序號連續，且每個缺號都有帳。

### Edge Cases

- 來源時鐘早於 2015 或晚於收到時間 60 秒以上：沿用今天的規則，時間退回收到時間並在 chained 列記 `_source_time_rejected`。暫停判斷視同沒有來源時間（FR-082，修訂 2026-11-13）。
- 兩個不同來源用了同一個 `event_id`：互不影響，唯一性以接收端認定的來源為範圍。
- 來源重設了序號卻沒換 instance：仍依 `event_id` 去重；該 instance 的缺口帳標為「不可靠」並說明原因。
- 單一 instance 的亂序序號超過可追蹤的上限：缺口帳退化為只有計數，並說明。
- 交接檔屬於已刪除的專案：隔離（`unknown-project`），計數。
- 專案 id 含不合法的路徑字元：來源不寫該目錄，計 `handoff-write-failed`。
- 接收端在排空時遇到磁碟滿：回 `retry`，檔案留著不刪，capture 狀態顯示錯誤。
- commit 之後、刪檔之前當掉：重開後再處理一次，結果為 `duplicate`，然後刪檔。
- 隔離區已滿：不再移入，計數並在缺口列註明「內容未保留」。
- 憑證輪替時有項目在途：舊世代在寬限期內仍有效，交接檔依觀察時間判斷。
- 外掛停用時交接目錄還有積壓：全部拒收並計為有意（`credential-revoked`）。
- 暫停在觀察與送達之間切換：即時入口依收到時間判斷；交接檔在暫停結束後，依可用的來源時間對照已記錄的暫停區間判斷，沒有可用的來源時間就寫入（修訂 2026-11-13，見 US2）。
- 指令在暫停前開始輸出、暫停後才結束：整個 `command_end` 拒絕，不拆分（FR-082）。指令在暫停中打下、恢復後才結束：以 `output_started_at` 或「結束時間 − `duration_sec`」判得的起點落在暫停內，拒絕。
- 恢復列沒寫成（寫入失敗）：排空延後所有可能落在該暫停之後的檔，直到重試寫成恢復列；不丟檔（FR-082）。暫停列沒寫成時同樣延後該切換之後的檔。暫停或恢復列直到 app 關閉都沒寫成：它保存在專案資料庫旁，重開時以原時間寫入（FR-082）；連這份也沒有時（例如寫檔也失敗），落在該暫停中的檔以非有意的 `pause-end-unknown` 計入 Known Gaps，內容保留在隔離區。
- 排空的切片之間開始暫停：該次排空不提交任何缺口列，檔全部留到暫停後（FR-083）。
- 外部終端機綁定 A 而 B 開著：終端機本地暫停並計數，A 重開時送出 `capture_resumed`。
- 外部 shell 啟動時沒有專案開著：`hello` 延到第一次綁定專案時才送。
- shell 沒有 python3，算不出交接檔 MAC：檔案進隔離區（`unauthenticated`），保留但不自動寫入（O15）。
- 以提權身分執行的來源（例如 sudo 下的 pcap）：交接檔要屬於發起的使用者。接收端讀不到時，只改名移入隔離區（`unreadable`）。過渡期排空舊 `pending/` 時則留在原處重試，不計數（FR-066）：讀不到就無從得知它屬於哪個專案。
- WSL 經 `/mnt/c` 存取時權限位元不受強制：屬已知平台限制，寫入風險說明。
- 重送的項目，其原列已被保留期刪除（logged 層）：回 `duplicate` 並標 `original: pruned`，不再寫入。
- 降版到 071 之前的版本又升回來：舊版 session 寫的列在 verifier 報告為「自述」。
- 新版來源遇到舊版 app（`/api/ingest` 回 404）：項目進交接目錄，計為待確認，不改走舊入口。
- 混合結果的批次：逐項處理。

## Requirements *(mandatory)*

### Functional Requirements

#### A. 信封與接收端蓋章（US1）

- **FR-001** 契約第 1 版的每個項目必須帶下列欄位，全部由來源填寫。缺少必填欄位時，該項回 `rejected`／`malformed`。

  | 欄位 | 必填 | 意義 |
  |---|---|---|
  | `event_id` | 是 | 冪等鍵，於觀察當下產生 |
  | `kind` | 是 | `event`／`hello`／`alive`／`bye` |
  | `producer` | 是 | `{name, version}`，來源自述的實作名稱與版本，含它實作的契約版本 |
  | `instance` | 是 | 每次行程啟動新產生的隨機 id，至少 64 位元熵 |
  | `seq` | 是 | 該 instance 內的整數序號 |
  | `observed` | 是 | `{at, project, operator?, terminal?, command?}`，觀察當下的身分 |
  | `occurred_at` | 否 | 來源宣告的事件發生時間（毫秒），與 `observed.at` 不同時才填 |
  | `type`、`data` | `kind=event` 時必填 | 事件型別與內容（與今天的 `agent_type`／`data` 同義） |
  | `target` | 否 | 來源明示的目標 |
  | `discarded` | 否 | 該 instance 各原因的**累計**遺失數（FR-051） |
  | `last_seq` | `kind=bye` 時必填 | 最後一個序號 |
  | `sent_at` | 否 | 送出時刻；交接檔不填 |

- **FR-002** `event_id` 在觀察當下產生，隨交接檔持久，同一觀察的每次重送都帶同一個值。格式為 `^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`。
- **FR-003** `seq` 每個 instance 從 0 開始，每一次觀察加一，包括在來源端被丟棄的觀察。行程每次啟動都換新的 `instance`。
- **FR-004** 列的 `timestamp` 依序取驗證通過的 `occurred_at`、驗證通過的 `observed.at`、收到時間。驗證規則與被拒時的 `_source_time_rejected` 註記沿用今天（`event-write.ts:407-429`）。`created_at` 仍是接收端時鐘。觀察時間與 `timestamp` 不同時，記在 `_ingest.observed_at`。
- **FR-005** 接收端為每一列新事件蓋上 `data._ingest`，不論入口或層級，且每次都覆寫呼叫端給的值。內容如下：

  | 鍵 | 意義 |
  |---|---|
  | `v` | 蓋章格式版本，目前為 1 |
  | `door` | 入口：`api`／`handoff`／`in-process`／`legacy-api`／`legacy-handoff` |
  | `producer` | 接收端認定的來源（由憑證或行程內呼叫者決定） |
  | `credential` | `"<id>:<世代>"`；行程內入口為 null |
  | `auth` | 認證方式：`bearer`／`mac`／`in-process`／`none` |
  | `event_id`、`instance`、`seq` | 冪等鍵與序號 |
  | `terminal` | 正規化後的終端機 id（FR-011） |
  | `target_via` | 目標如何決定（FR-010） |
  | `claimed` | 來源自述、未被採信為身分的值：`producer`（`name@version`）、`operator` |
  | `stripped` | 被移除的保留鍵名；沒有時省略 |
  | `rules` | 寫入路徑上、結果被寫進本列的使用者 Processor 規則集（Spec 075 FR-059）：字串陣列，每項 `<pluginId>#<內容雜湊前 12 碼>`，依字典序；沒有使用者規則參與時省略 |
  | `rules_partial` | `true` 表示本列的使用者推導因每事件時限而未完成（Spec 075 FR-059）；完成時省略 |

  來源送來的 `_ingest`、`_raw`、`_clock_anomaly`、`_source_time_rejected` 一律移除。`_causes` 是唯一可由來源寫入的底線鍵（Domain Invariant 6）。
- **FR-006** `_ingest` 只含字串、整數、布林、null 與字串陣列，使兩個 verifier 的序列化逐位元組一致。一般項目序列化後不超過 512 bytes，含 `rules` 的列也一樣：`rules` 是有界形式，不帶外掛版本，至多 3 項、每項至多 45 bytes（`pluginId` 截至 32 字元）；超過 3 個外掛參與時，保留字典序前 2 項，第 3 項寫 `+<其餘數目>`。外掛版本與完整規則內容由內容雜湊在外掛詳情中對照（Spec 075 FR-059）。
- **FR-007** 新列的 engagement 一律等於開著的專案 DB 所綁定的 engagement。任何入口都不再寫 `'default'`。沒有綁定的 DB 時不寫入，回 `retry`／`no-project`。
- **FR-008** `observed.project` 與開著的專案不同時，不寫入，回 `retry`／`foreign-project`，項目留給它自己的專案（Spec 002 FR-001）。沒有 `observed.project` 的交接項目進隔離區（`no-project`，承接 Spec 002 FR-006 的語意）。專案已不在本機專案清單中的交接項目進隔離區（`unknown-project`）。
- **FR-009** 列的操作者是觀察當下的操作者。`observed.operator` 是本專案已知且未撤銷的操作者時採用；否則採機器層級設定中的目前操作者（O12），來源的值記在 `_ingest.claimed.operator`。
  > **修訂註記（2026-11-13，修訂 A8）**：專案不可以覆寫 operator（Spec 073 FR-01D）。`observed.operator` 是觀察當下的機器層 operator（交接目錄延遲送達時，送達時的值可能已改）；「本專案已知」的集合只由機器層 operator 曾在本專案生效的值構成。專案 `config.yaml` 中的 `operator` 不是任何一步的來源。
- **FR-010** 目標依以下順序決定，結果寫在 `target_id`，方法寫在 `_ingest.target_via`：
  1. `explicit`：項目明示的目標；
  2. `extracted`：從內容擷取（既有的 target extractor）；
  3. `command`：背景輸出承接它所屬指令的目標；
  4. `terminal-last`：同一終端機在觀察時間以前、最後一筆 `explicit` 或 `extracted` 列的目標；
  5. `none`。

  全部由持久化資料決定。不論是否重啟、經哪個入口、何時送達，結果相同。全域目前目標不再自動套用到任何列（O11；不屬於任何終端機的 app 內操作見 O16）。

  `terminal-last` 讀專案資料庫中的 `terminal_targets` 表。這張表歸本規格：由寫入路徑在同一個 commit 交易內同步寫入。它同時是 Spec 074 可重建的投影：含 071 之前事件的專案需要回填，回填由 074 的 `heavy` 執行緒計算、由主行程的寫入者以小交易寫入（074 FR-032、plan D5）。**回填完成之前**（含 074 尚未落地、回填從未開始的期間），該專案的新列不套用第 4 步：沒有 `explicit`、`extracted`、`command` 可用的列寫 `target_via: "none"`。列永不改寫，所以這些列的 `none` 是永久的；這是重啟等價（SC-003）唯一的例外，只發生在含 071 之前事件的專案。沒有 071 之前事件的專案不需要回填，第 4 步一開始就適用。
- **FR-011** 新列的終端機身分只有一個正規值 `_ingest.terminal`：取 `observed.terminal`；舊入口依序取 `data.terminalId`、`data.terminal_id`。核心中需要新列終端機身分的地方一律讀這個值。
- **FR-012** 接收端認定的來源只由憑證（或行程內呼叫者）決定。`producer.name`／`version` 只記錄、不用於信任。對帶 `_ingest` 的列，凡依「是否為內建終端機」做的存取或信任判斷（例如 `/api/terminal/replay` 讀取 cast），一律以 `_ingest.producer` 為準。純顯示用途不在本規格。
- **FR-013** 交接用的 identity 檔（`~/.redlog/active-identity.json`）以原子方式寫入，讀者不會讀到半寫的內容；欄位只增不改。

#### B. 雜湊涵蓋與驗證（US1、US5）

- **FR-020** chained 列的雜湊與簽章輸入（欄位集合與序列化）不變：`sha256(canonicalStringify({agentType, createdAt, data, engagementId, hostname, id, monotonicNs, ntpOffsetMs, operatorId, prevHash, sessionId, sourceIP, targetId, tier:'chained', timestamp}))`，簽章簽同一字串（`event-write.ts:601-631`、`chain-anchor.ts:514-542`、`tools/redlog-verify.py:141-170`）。`_ingest` 在 `data` 內，因此被涵蓋。
- **FR-021** 不改寫、不 UPDATE、不回填任何既有列；不替舊列補 `_ingest` 或 `event_id`。
- **FR-022** 新版寫入的每個 capture session，其 `system.session_start` 都帶 `_ingest`。一列的接收端來源**已證明**，若且唯若該列帶 `_ingest`，且同一 `session_id` 的 `session_start` 也帶 `_ingest`。其他列為**自述**；bundle 中缺少該 session 的 `session_start` 時為**無法判斷**。
- **FR-023** `tools/redlog-verify.py` 與 app 內驗證依同一規則回報三種來源狀態的數目，兩者數字一致（共用向量）。雜湊驗證的判定與結束碼不因此改變。
- **FR-024** logged 層的 `_ingest` 沒有逐列的防竄改，這是該層的既有語意；匯出時由 logged digest 涵蓋。任何介面或 verifier 都不得把 logged 列的來源說成「已證明」。
- **FR-025** 全文搜尋不因 `_ingest` 的內容命中（例如搜尋 `shell`，不會因每一列的 `_ingest.producer` 而命中），且不得為此重建既有專案的全文索引。

#### C. 回執（US6）

- **FR-030** `POST /api/ingest` 的請求為 `{contract: 1, items: [...]}`，1–100 項，總長不超過 20 MiB。回應中每項一個回執，與請求同序同長，另帶 `written`，等於 `accepted` 的數目。
- **FR-031** 結果為封閉列舉。來源的反應是必要行為：

  | outcome | reason（封閉，契約 1） | 來源必做 |
  |---|---|---|
  | `accepted` | — | 完成；刪除對應的交接檔 |
  | `duplicate` | —（附原列 id 與 `present`／`pruned`） | 視同 `accepted` |
  | `rejected` | `malformed`、`too-large`、`unsupported-contract`、`kind-not-allowed`、`paused`、`terminal-not-recording`、`source-disabled`、`credential-revoked`、`key-conflict`、`plumbing` | 不再重送；不自行計數（接收端已計） |
  | `retry` | `busy`、`storage`、`starting`（附 `after_ms`）；`no-project`、`foreign-project`（`after_ms` 為 null） | 寫入或保留在觀察當下所屬專案的交接目錄；不阻塞操作者 |

  沒有回應、逾時或連線被拒，一律視同 `retry`。`written` 與逐項結果不一致時，整批視為 `retry`。
- **FR-032** `accepted` 只在該列已 commit 之後回覆；commit 失敗回 `retry`（`storage` 或 `busy`）。
- **FR-033** 請求層級的回應：請求本身不可解析為 400；未認證或憑證已撤銷為 401；超過大小為 413；沒有專案、啟動中或忙碌為 503 並帶 `Retry-After`。收到 401 時，來源把項目寫入交接目錄，由接收端判斷並計數。
- **FR-034** 來源只依 `outcome`／`reason`（以及 FR-033 的請求層級狀態）決定行動，不依錯誤字串。
- **FR-035** 接收端發出的每一個 `rejected`（`plumbing` 除外）都由接收端計入遺失帳本。來源只計從未送到接收端的遺失，同一件事只計一次。
- **FR-036** 舊入口 `POST /api/events`（請求中沒有 `contract`）對每種情況回與今天相同的狀態碼，只在回應中**增加** `outcome`／`reason` 欄位。201 的回應主體仍是該列（既有來源讀其中的 `id`，`mitmproxy-addon.py:635-669`）。唯一的行為修正：ingest 內的跨專案拒絕仍回 409，主體文字改為與標頭 pin 相同的 `engagement changed`，讓 relay 計為被拒（今天被當成已收，`redlog-relay.py:333-338`）。
- **FR-037** 舊入口與舊版憑證至少保留到所有內建來源改用契約 1 之後兩個 minor 版本，且在本機 14 天內仍有舊入口流量時不移除。移除另立規格（O14）。

#### D. 冪等（US1）

- **FR-040**（接收端認定的來源、`event_id`）永久唯一，跨兩層，也跨保留期刪除。重複時回 `duplicate`，附原列 id，並說明原列是 `present` 還是 `pruned`。
- **FR-041** 同一 `event_id` 但內容不同（以接收端對項目的正規化摘要比較）：回 `rejected`／`key-conflict`，不寫入，計為非有意遺失。若來自交接檔，該檔移入隔離區。
- **FR-042** 帶 `event_id` 的項目一律不經 2 秒內容去重。舊入口的項目維持今天的去重與回應（`event-write.ts:517-562`）。
- **FR-043** 行程內來源若有天然穩定鍵（例如 transcript uuid、recording id 加 command id），`event_id` 由該鍵決定性導出，重啟後的重送在資料庫層即被吸收。
- **FR-044** 不遷移既有列；去重表從空的開始。舊列永遠不會產生 `duplicate` 回答。
- **FR-045** 每項的去重成本不超過一次索引查詢加一次插入；一百萬項的儲存不超過 100 MB（規模測試量測）。

#### E. 遺失帳本（US3）

- **FR-050** 遺失原因為封閉列舉，各有「有意／非有意」與「誰計數」：

  | 原因 | 有意 | 由誰計 |
  |---|---|---|
  | `paused` | 是 | 來源（觀察點）與接收端（區間判定） |
  | `project-switched` | 是 | 來源（O10） |
  | `terminal-not-recording` | 是 | 接收端 |
  | `source-disabled`、`credential-revoked` | 是 | 接收端 |
  | `handoff-full` | 否 | 來源 |
  | `handoff-write-failed` | 否 | 來源 |
  | `encode-failed` | 否 | 來源 |
  | `malformed`、`too-large`、`kind-not-allowed`、`key-conflict`、`unauthenticated`、`unreadable`、`incomplete-write`、`unknown-project`、`no-project`、`legacy-bad`（FR-069 一次移入的舊 `.bad` 檔） | 否 | 接收端 |
  | `pause-end-unknown`（落在結束時間未記錄的暫停中，FR-082；不寫入紀錄，內容保留在隔離區） | 否 | 接收端（區間判定） |
  | `sequence-gap`（原因未知） | 否 | 接收端由序號推導 |
  | `ended-unclean`（尾端數量未知） | 否 | 接收端 |

- **FR-051** 來源為每個 instance 保存各原因的累計計數，附在任何一個項目（含 `hello`／`alive`／`bye`）的 `discarded` 中送出。接收端只計與上次的差值，重送不會重複計數。
- **FR-052** Python、Node、PowerShell 來源另把計數原子寫入每個 instance 的狀態檔，當掉後仍在。shell 來源只保存在記憶體中，當掉時的遺失由序號缺口涵蓋。
- **FR-053** 接收端依每個 instance 的序號推導缺口。缺口在下列任一條件成立時結算：
  - 收到 `bye` 並完成該專案交接目錄的一次完整排空；
  - 較高序號送達已滿 10 分鐘，其間至少完成一次完整排空；
  - 該 instance 靜默超過 24 小時且沒有 `bye`，記為 `ended-unclean`。

  缺號扣掉來源回報的原因計數，餘數記為原因未知。

  本表是遺失原因的**唯一**封閉清單；交接隔離區的原因（FR-066）與它相同。Spec 075 的來源狀態理由是另一份清單（顯示用），它的 `loss` 事實以本表的原因名稱彙總，不另立遺失原因。
- **FR-054** 每次結算，對有遺失的 instance 寫一列 chained `system.capture_gap`（沿用既有 subtype），內容含：來源、instance、序號範圍、各原因計數、未說明數、有意／非有意、窗口起訖、相關指令 id（若 `observed.command` 有值）。列的 `timestamp` 為窗口起點，讓它出現在時間軸上的原位。接收端的拒收與隔離以同樣方式按 instance（舊入口按來源）彙總。
  - 舊交接目錄（`source: hook-spool`）每次排空每個原因一列，列中以 `files` 列出它計數的檔名，歸屬以 `by_owner`（本專案／不明）分計。**例外**：同一原因超過 100 個檔時分成數列，每列帶 `part`／`parts` 與自己那部分的檔名與計數。
  - 每個檔最多計數一次，跨排空、跨重啟皆然：鏈上的缺口列就是計數紀錄。已被已提交的缺口列列名的檔，之後只重試它的移動或刪除，不再計數，也不再送進管線。這依賴檔名在來源端依構造唯一（時間戳加行程或 instance 識別）。例外是 proxy 中斷時由接收端重寫的 inflight 缺口檔（`<心跳>000000-inflight-<instance>-<序號>.json`，`core/inflight-marker.ts`），刻意以同一名稱覆寫；它是來源的 `capture_gap`，照常寫入，不以 `paused` 拒絕。
  - 讀不出歸屬的檔（`_unknown`）反過來：**先移入**隔離區、再計數。移不動的檔留在原處，任何專案都不計它——否則它會留在 spool，被每個開啟的專案各計一次，因為沒有任何專案的鏈能認出它已被計數。移入後缺口列寫入失敗、或切片之間開始暫停時，該檔移回 spool、回報為延後，由之後的排空計數一次；移不回去的檔留在 `_unknown`、沒有計數（已知限制）。
  - 窗口起訖只採通過 FR-004 驗證的來源時間，否則用接收端看到該檔的時間。
- **FR-055** 不計為遺失：`duplicate`、`plumbing`、尚未結算的 `retry`。
- **FR-056** 狀態呈現在既有的 capture 狀態內，不新增頁面，每個來源提供以下事實（如何算成狀態屬 Spec 075）：存活（K）；本專案**第一次接受**該來源列的時間（里程碑，一旦寫入不再改，也不因保留期刪列而清除）與最近一次接受的時間；待確認數；非有意與有意遺失數，以及最近一次非有意缺口窗口的結束時間；停用後被拒數（`source-disabled`、`credential-revoked` 兩個原因在停用或撤銷時刻之後的計數）；隔離區數量與原因；是否仍在用舊入口。這些事實取代 Spec 075 之外任何「曾經成功過」的獨立紀錄（不另建 proof 檔）。
- **FR-057** 缺口列是 chained 列，自然進入匯出；本規格不改變 bundle 格式。
- **FR-058** 審查找出的不計數情況，各自有明確落點：
  - spool 達上限 → `handoff-full`；
  - spool 寫入失敗 → `handoff-write-failed`；
  - `.bad` → 隔離並計數；
  - relay 最後一列被拒或缺 `bye` → 接收端計數，或記為 `ended-unclean` 並帶指令 id；
  - 沒有 port → 寫交接檔；
  - `redlog-send.ps1` 的 `catch {}` → 依回執處理並計數；
  - pcap-capture 不檢查 POST 的結果（沒有連線、或任何非 2xx 都被當成已送達，靜默遺失）→ 依回執處理：沒有回應與 `retry` 寫交接檔，`rejected` 由接收端計數。

#### F. 交接目錄（US3、US4）

- **FR-060** 結構為 `~/.redlog/handoff/<project>/{tmp,new,quarantine}`。`new/` 中的檔名為 `<觀察毫秒>-<instance>-<seq>.rli`，依觀察時間排序。
- **FR-061** 來源只在 `tmp/` 以獨占方式建檔，寫完後以同一檔案系統內的 rename 移入 `new/`。接收端從不讀 `tmp/`。`new/` 中永遠沒有寫一半的檔。
- **FR-062** Python、Node、PowerShell 在 rename 前對檔案 fsync。shell 不 fsync，斷電時可能留下損毀檔，由 MAC 檢出並隔離。接收端只在 commit 之後刪檔。資料庫的耐久度：寫入連線為 WAL + `PRAGMA synchronous = FULL`（見 Assumptions），每次 commit 之後對 WAL 做一次 sync，`accepted` 與刪檔都在那次 sync 之後。因此 commit 對行程當掉與作業系統當掉耐久。斷電：Linux 與 Windows 上，sync 是 `fsync()`／`FlushFileBuffers()`，在儲存裝置如實執行 flush 的前提下耐久；macOS 上 `fsync()` 不清磁碟的寫入快取，而 `fullfsync` 未開（Q6），所以斷電時最近幾筆已回 `accepted` 的 commit 仍可能遺失。資料庫在任何情況下都不會因此損毀。
- **FR-063** 每個專案的 `new/` 合計（所有來源）最多 5000 檔；能廉價量測大小的來源另限 512 MiB；單檔不超過 20 MiB。滿了就丟最新的並計 `handoff-full`，絕不阻塞操作者。
- **FR-064** 交接檔第一行宣告憑證 id、世代與 HMAC，其後是項目的確切位元組。MAC 以憑證衍生的金鑰、對加上領域前綴的項目位元組計算。接收端先驗 MAC 再解析。金鑰不出現在 argv 或環境變數中。
- **FR-065** 交接檔走與 API 相同的整條管線，包括依憑證的種類政策。任何檔都不能產生該憑證不得寫入的種類：`system`、衍生種類、`amended` 都不行；`marker` 只有種類範圍明列它的憑證可以（目前只有 O13 的 `agent-tools`）。種類範圍的資料取自 Spec 072 登記表的 `writers`（072 FR-005），本規格負責強制。
- **FR-066** 隔離區只放不可重試的項目，檔名 `<原因>--<原檔名>`，旁附 `.why`（原因、細節、時間、接收端版本）。每個專案上限 1000 檔或 256 MiB，滿了就只計數。隔離區的檔從不自動重新處理。操作者可以開啟所在資料夾或清除，清除動作寫一列 chained 紀錄。
  - 上限以**一次排空**為單位保留：該次排空的所有切片與舊檔遷移共用同一份預留帳，開始時量一次目錄，之後每移入一檔就預留。分切片不會讓目錄超過上限。
  - 只有本專案自己的檔在隔離區滿時會被刪除（計為「內容未保留」）。別的專案的檔、讀不出屬於誰的檔，隔離區滿時留在原處。
  - 讀不到的檔（權限、I/O 錯誤）不判斷內容也不判斷歸屬：留在原處、以退避重試，不計數、不移入 `_unknown`。解析失敗但文字中仍有 `"engagementId":"…"` 的檔屬於該專案：別的專案的就留給它，本專案的就計入本專案。重試計數只存在記憶體、以路徑為鍵，重啟後歸零，只代表多試幾次。
- **FR-067** `tmp/` 中超過 24 小時的孤兒檔移入隔離區（`incomplete-write`）。
- **FR-068** 目錄權限 0700、檔案 0600；Windows 只授權給擁有者。以提權身分執行的來源，交接檔屬於發起的使用者。
- **FR-069** 過渡期內，舊的 `~/.redlog/pending/` 仍會排空，走同一條政策與管線（`door = legacy-handoff`、`auth = none`），違反政策的檔移入隔離區。既有的 `.bad` 與 `.unattributed` 檔在第一次開啟時一次移入隔離區（`legacy-bad`、`no-project`）並計數。排空以有界切片在背景進行，開專案時不做無上限的同步排空。

#### G. 憑證與能力（US4、US5）

- **FR-070** 能力為封閉列舉：`append`（限定種類）、`read`、`control`（錄製、錨定、截圖觸發等）、`export`、`sanitize`、`admin`（憑證與操作者）、`seed`（只在測試建置）。每條 API 路由宣告恰好一種所需能力。操作者憑證擁有 `seed` 以外的全部能力；來源憑證只有 `append`，外加存活回報、`/api/whoami`，以及 HTTP 代理專用的 `/api/http-verify`。（2026-11-13，修訂 A7：`plugin:<id>` 另可帶 `read`，範圍限於該擴充功能 manifest 的 `reads`，只用於 `/api/v1/*`；能力與稽核由 Spec 076 FR-062、FR-091 定義。）
- **FR-071** 每個來源一把憑證，種類範圍固定：
  - 外部 shell（zsh、bash、PowerShell hook、relay、session recorder）：`shell`；
  - 內建終端機 pane 內的 hook：`builtin-terminal`；
  - HTTP 代理：`http-proxy`；
  - `hooks/pcap-agent.py`：`pcap-agent`；
  - 每個外掛 Source：`plugin:<id>`，種類取自 manifest 的 `emits`（O6）；
  - 遠端主機：`remote:<名稱>`，限定單一專案；
  - AI 工具整合（O13）：`agent-tools`，可寫 `agent`、`marker`，另可讀狀態；
  - 舊版：`legacy`。

  這份來源類別的值域（加上行程內的 `in-process` 與 `derived`）就是 Spec 072 `ProducerClass` 的值域；外掛類別在 072 中記為 `plugin`，個別外掛由憑證 id 區分。

  官方 AI adapter、內建終端機的 session 生命週期列與 `system` 列走行程內入口，沒有憑證。
- **FR-072** 憑證由 app 直接寫檔發放，不需要網路服務：
  - app 啟動時：為已安裝的 hook、內建終端機、受管代理發放；
  - 操作者第一次在任一專案啟用外掛 Source（Spec 075 FR-076 的 `on`）時：發放 `plugin:<id>`（O9）；憑證是機器層級的（plan D7），之後其他專案的啟用不再發放；
  - 操作者以 CLI 執行時：發放遠端主機的憑證。

  > **Superseded（2026-11-13，修訂 A4）**：上面第二項改為「操作者在**這台機器上**啟用擴充功能 Source（Spec 076 FR-040，`machine.yaml` 的 `extensions.<id>.enabled`）時：發放 `plugin:<id>`」；不再有專案層的啟用。第三項改為「操作者以 `redlog remote add <名稱> --project <id>` 執行時」（FR-130）。

  每次寫入憑證檔都經 Spec 073 的安裝帳本（`install-ledger.apply`，類型 `credential-file`），使移除能收回它；073 的帳本落地前直接寫檔。
- **FR-073** 來源讀取 `~/.redlog/credentials/<來源>.cred`（單行，0600，目錄 0700）。接收端只保存 secret 的摘要與 MAC 金鑰，secret 本身不進資料庫、日誌或任何事件。
- **FR-074** 憑證從不出現在任何行程的 argv 或子行程的環境變數中。內建終端機的 hook 以既有的非秘密旗標 `REDLOG_TERMINAL` 找到自己的憑證檔。`test/shell-token-not-in-argv.test.ts` 擴充到每個來源。
- **FR-075** 輪替以原子方式替換檔案。上一世代對 bearer 認證另有 10 分鐘寬限；對觀察時間早於輪替時刻的交接檔仍有效。輪替在開著的專案寫一列 chained 紀錄。
- **FR-076** 撤銷立即生效。停用外掛 Source 即撤銷其憑證（O6）。撤銷在開著的專案寫一列 chained 紀錄。
- **FR-077** 一把憑證的某一世代第一次在某專案寫入時，接收端先寫一列 chained `system.producer_enrolled`（憑證 id、來源類別、允許種類、世代），再寫該項目。
- **FR-078** 升級後第一次開啟各專案時：
  - 該專案的舊 token 換成新的操作者憑證；
  - 舊值降為只能寫入（`legacy`）；
  - 操作者憑證的鏡像改放 `~/.redlog/credentials/operator`；
  - `~/.redlog/api-token` 改放機器層級、只能寫入的 `legacy` 憑證；
  - CLI 讀新路徑。
- **FR-079** 不需操作者重新安裝即可延續：app 啟動時更新 hook 檔並寫好憑證檔。仍在執行舊函式的 shell 經舊入口繼續寫入。無法自動重新發放的地方（WSL 中手動複製的 hook、VPS、第三方來源）同樣經舊入口繼續，但只能寫入；狀態呈現指出哪些來源仍在用舊入口，遠端主機需要操作者以 CLI 重新發放。
- **FR-07A** 以專案為單位的啟用由接收端強制：官方 AI adapter 的項目，若所屬專案沒有有效的同意（O9；同意狀態由 Spec 073 的 `ai-consent` 回答）；外掛 Source 的項目，若所屬專案對該來源不是 `on`（Spec 075 的 `enabledForProject`）；兩者都回 `rejected`／`source-disabled`，計為有意。專案層的 `off` 不撤銷機器層的憑證（FR-076 的撤銷只對機器層的停用、撤銷、雜湊改變、移除）。

  > **Superseded（2026-11-13，修訂 A4）**：外掛 Source 不再有專案層的 `on`／`off`（Spec 075 的 `enabledForProject` 已改為機器層啟用加專案層綁定）。本條的外掛部分由 FR-07C 取代；AI adapter 的部分改為「該工作階段不屬於所屬專案的選擇」，由 tailer 在讀取前判斷（AI adapter 在行程內，不經接收端的憑證檢查），不改為接收端的拒收。
- **FR-07C**（2026-11-13，修訂 A4）接收端對來源的「啟用」只看機器層：憑證已發放、未撤銷、世代有效（FR-073–076）。專案層只有**綁定**：外部與遠端終端機依 FR-085 的 pin（不是綁定的專案時在來源端本地暫停，不送）；AI 工作階段依 Spec 073 F 段的逐專案選擇與 Spec 076 FR-045 的認領索引；`binding: none` 的來源寫到觀察當下開著的專案（FR-008）。綁定不改變憑證。
- **FR-07B** `GET /api/whoami`（來源憑證可呼叫，FR-070）回傳呼叫者的憑證 id、來源類別、世代，以及該來源在目前開著的專案中的狀態：Spec 075 的狀態碼、理由碼與動作碼（075 FR-031 的同一份 payload 中該來源的一項）。沒有開著的專案時狀態為 `unknown`；075 落地前一律回 `unknown` 並說明。shell 的 `redlog status` 讀它（075 FR-035）。

#### H. 暫停邊界（US2）

> **修訂中（2026-11-13，修訂 A5）**：FR-080–084 正在實作分支上改寫，見 US2 的指標。本修訂不動這五條；FR-085 不在改寫範圍內。

- **FR-080** app 把暫停狀態放在 `~/.redlog/state/recording`：暫停時存在，內容為開始時間；恢復時移除；app 啟動時依實際狀態重寫。shell 不需啟動行程即可檢查。
- **FR-081** 來源在觀察點檢查暫停狀態。暫停中不建立項目、不寫交接檔，只計 `paused` 並用掉一個序號。
- **FR-082**（修訂 2026-11-13，理由見 US2）接收端的暫停判斷分兩種入口：
  - **即時入口**（API、行程內）：依**收到時間**，與今天相同——目前是暫停狀態就拒絕（舊入口回 `200 recording:false`）。不依來源時間做任何推論。
  - **交接目錄**（今天的 `pending/`）：暫停中不排空。暫停結束或重開後判斷，每個檔最多**計數**一次（FR-054 修訂）：帶有通過 FR-004 驗證的來源時間，且該時間落在本專案**已記錄**的暫停區間內，就 `rejected`／`paused`，計為有意；否則寫入——包括暫停前觀察到的 `command_end`，以及沒有可用來源時間的檔（驗證不通過視同沒有）。來源自己記下的遺失紀錄（`capture_gap`）不以 `paused` 拒絕。
    - **區間**為 `[暫停, 恢復)`：暫停那一刻算暫停，恢復那一刻不算。只有暫停列與恢復列都在同一次開啟中寫成的區間，才算確定的暫停（`paused`，有意）。
    - **結束時間未知**的暫停分兩種，判斷規則不同：
      - **本次開啟中**（暫停列晚於本次開啟資料庫）：沒有恢復列；或暫停列之後又出現暫停列、中間沒有恢復列（恢復列遺失）——從第一個暫停起到下一個已記錄的恢復為止都是**未知**；或該次切換的暫停／恢復列寫入失敗、仍在重試——從該切換的時間起都是未知。排空只在錄製中執行，所以恢復確實發生了，只是還沒寫成。任何可能落在未知範圍的檔（可用時間在其中、沒有可用時間的檔、窗口伸進其中的 `queue-full`／`proxy-stopped` 缺口）都**延後**，不寫也不丟。遲到的列帶著原始時間寫入（讀取依 timestamp、rowid 排序），寫成後區間照常判斷。
      - **已結束的開啟中**：沒有恢復列、直到專案再次開啟（重開時的恢復列關閉它）；暫停跨越一次開啟才恢復（重開時仍在暫停，之後才恢復）時重開之前的部分；暫停列之後又出現暫停列、中間沒有恢復列時兩者之間的部分。操作者可能已經恢復、只是恢復列遺失，所以落在其中的檔以 `pause-end-unknown` 拒絕：**不寫入紀錄，內容保留在本專案的隔離區**（與其他保留的遺失同一份上限；滿了就依既有規則只計數並刪除），先寫缺口列，計為**非有意**遺失，會出現在 Known Gaps。後果：恢復列遺失時，恢復後、重開前真正錄到的交接檔不進紀錄，但內容留在隔離區、缺口看得見；暫停跨越重開時，重開之後的部分仍是確定的暫停。
    - 結束時間未知的範圍一律在它之後的第一次開啟處截斷：前一次開啟留下未結束的暫停，本次開啟的恢復列沒寫成，本次又有暫停列時，`[暫停, 本次開啟)` 是 `pause-end-unknown`，`[本次開啟, 下一個暫停)` 是未知、延後。因此，在一次以未解決的先前暫停開始的開啟中錄到的內容，該次開啟期間會延後；若標記始終沒有到達，下一次開啟時以 `pause-end-unknown` 移入隔離區（內容保留、缺口可見）。
    - 待寫標記檔只有「不存在」代表沒有待寫標記。讀不到、解析失敗、不是清單、或任何一筆未通過檢查（種類只能是 `recording_paused`／`recording_resumed`，時間須通過 FR-004 的檢查）時，回報 `noteDbError('recording-marker')`，該檔改名為 `recording-markers-pending.json.unreadable` 保留（從不覆寫），本次開啟的所有時間都視為未知、排空延後；只要 `.unreadable` 檔還在，之後每次開啟都一樣，直到操作者處理。補寫的列只由檢查過的欄位重建（種類、時間、來源字串），檔中其他內容一律忽略。
    - 開啟時決定是否寫 `markerForOpen` 的依據，是「鏈上最後一列」與「仍待寫入的標記」兩者中較晚的那一個。開啟的寫入順序（`session_start` → 待寫標記 → 開啟自己的標記）集中在 `recordProjectOpen`，main 只呼叫它。
    - 已知的過度回報：暫停狀態在記憶體中跨越專案切換、或佇列缺口與一段在 app 結束時才結束的暫停重疊時，這些現在會被回報為遺失。
    - main 寫暫停／恢復列失敗時——切換時與開專案時（`markerForOpen`）都一樣——回報 `noteDbError('recording-marker')`，並以該切換的原始時間重試，直到寫成或專案關閉。重試期間，該列（種類與切換時間）以私有權限原子寫入專案資料庫旁的 `recording-markers-pending.json`，寫成後移除；下次開啟時，在 `markerForOpen` 之前、排空開始之前，先把檔中的列以各自的時間寫入鏈（同一個重試流程），寫成才移除。寫成之前，該切換之後的時間都是未知。因此一個在 app 結束前沒寫成的暫停或恢復列，重開後會在原時間點補上，區間照實判斷。暫停紀錄讀取失敗時回報 `noteDbError('recording-state')`，所有時間視為未知，排空延後。
    - 佇列缺口（`queueGapAgainstPauses`）只以確定的暫停區間判斷，伸進未知範圍時延後；與檔案判斷讀同一份紀錄。
    - **`command_end`** 帶著打下的指令與輸出，它們早於自己的時間。另外判斷它的起點：有可用的 `output_started_at` 就以它為起點，否則以「可用的來源時間 − `duration_sec`」為起點。起點落在已記錄的暫停區間內就拒絕——即使來源時間缺少或被拒（只要 `output_started_at` 可用）。輸出始於暫停之前、結束於暫停之後（`output_started_at` 與來源時間之間開始過一次已記錄的暫停）時**整列拒絕**，不拆分。已知限制：沒有 `output_started_at`、也算不出起點（沒有可用來源時間或沒有 `duration_sec`）的 `command_end` 照常寫入；以 `duration_sec` 推得起點的，只判斷起點本身，不套用跨越規則。
    - 判斷不使用檔案 mtime。mtime 只用來辨認可能還在寫的檔（`YOUNG_FILE_MS`，10 秒，容許 1 秒的時鐘誤差），與暫停判斷無關。
  
  取代今天交接目錄經過的「早於最近一次恢復即拒」（`ingest.ts:160-168`），它讓暫停前的 `command_end` 永久卡住；即時入口保留該判法。
- **FR-083** 交接目錄中，可用來源時間（或依 FR-082 判得的 `command_end` 起點）落在已記錄暫停區間內的項目，之後任何時候都不會寫入，與排空和開專案的順序無關。排空的切片之間若開始暫停，該次排空不寫缺口列，也不移動或刪除任何待計數的檔；這些檔由暫停後的排空重新判斷（已先移入 `_unknown` 的檔移回 spool，見 FR-054）。即時入口在暫停中收到的項目不會被補寫。
- **FR-084** `system`、`marker` 的暫停豁免與既有的 `bypassPause`（手動截圖）不變。
- **FR-085** 外部終端機在 `hello` 時綁定一個專案。開著的專案不是綁定的專案時，終端機在觀察點本地暫停，計 `project-switched`（有意），絕不送往其他專案（O10）。綁定的專案重新開啟時，送出 `capture_resumed` 事件並附計數。內建終端機維持 Spec 055 的輪替。本規格擁有來源端（relay 的轉移、`project-switched` 計數、`capture_resumed` 項目）；app 端的綁定狀態、生命週期與終端機狀態檔的 schema 屬 Spec 073（FR-040–045）。兩側的轉移表由同一個 agreement 測試 `test/terminal-enrollment-agreement.test.ts` 保證一致（本規格 T075、073 T060，同一個 PR 或同日配對）。

#### I. 單一入口（US1、US4）

- **FR-090** 每一列事件不論來源，都依序經過同一組階段：認證 → 驗證 → 蓋章 → 去重 → 結算執行期配對 → 政策（種類、暫停、未記錄的終端機、plumbing、同意、專案）→ 推導 → commit → 回執 → commit 後的工作。各入口只在「認證」不同。
- **FR-091** 結果會寫進該列並被雜湊的推導（`_causes`、目標、標籤、cast 區段、loot 命中加入遮罩 denylist、遮罩 span、sidecar 參照）在 commit 前同步完成；本規格不把它們延後（02 §3）。commit 之後才做的：publish、HTTP body 索引連結、scope 派送、companion 列（以 `derived` 再走一次入口）、存活狀態更新。
- **FR-092** 目前直接呼叫 `insertEvent` 的 31 處（Phase 1 量得，#716；系統生命週期、保留期稽核、錨定、匯出摘要、scope 重算、loot、alert、markers、plugins）改走入口，以 `system`／`derived` 身分略過「推導」，但不略過蓋章、政策、去重與 commit。之後新增的行程內寫入（Spec 072 的 `system.project_closed`、Spec 073 的 `session_start` 與當機補寫）同樣走入口。
- **FR-093** 入口等價：同一份內容不論經哪個入口進來，寫出的列除 `_ingest.door`／`auth`／`credential` 與收到時間外相同。
- **FR-094** 正式程式碼中，commit 階段之外出現 DB 寫入原語的呼叫時，gate 失敗。基準值只能下降，最後為 0。
- **FR-095** commit 原語不得靜默回報「什麼都沒寫」：它要嘛寫入，要嘛丟出錯誤。入口把錯誤對應為 `retry`，並記入 capture 狀態。
- **FR-096** commit 階段在每次 commit 之後，於行程內回傳 `CommitReceipt = {seq, chainedMaxRowId, loggedMaxRowId}`（Spec 074 FR-020）：`seq` 是每次開啟從 1 起算、每次 commit 加一的記憶體內整數，一個交易只有一個；兩個 rowid 是該 commit 後兩層的最大 rowid。它只是回傳值與 commit 後工作的輸入，**不寫入任何列或表**，不進 `_ingest`、不進雜湊。commit 後的工作把它交給 Spec 074 的讀取服務（`notifyCommit`）與變更主題分類（`topicsForCommit`）。

#### J. 用戶端規格與一致性（US7）

- **FR-100** 只有一份有版本的用戶端規格（契約 1），放在 `docs/domain/`。每個來源在 `producer.version` 中宣告它實作的契約版本。
- **FR-101** 共用測試向量、一個 mock receiver，以及每種 runtime 一個受測入口，涵蓋 bash 3.2、bash 5、zsh、PowerShell 5.1、PowerShell 7、Python、Node。相容矩陣由測試結果產生，不是自報。每個來源的 xfail 清單只能變短；沒有執行的 runtime 以原因計數。
- **FR-102** 向量至少涵蓋：
  - 載入時輸出 0 位元組；第一次綁定時送 `hello`；
  - 交接檔原子寫入；
  - `event_id` 在重送間不變；序號連續且有帳；
  - 暫停時的丟棄；滿時丟最新的；
  - 對 FR-031 每一種結果的反應；收到 404 時寫交接檔；
  - 憑證不在 argv 與環境變數中；
  - 專案切換時的本地暫停與 `capture_resumed`。
- **FR-103** 與今天相比，shell hook 在成功送達時不多啟動任何行程；寫交接檔時最多多啟動一個行程。

#### K. 存活與分層規則（O7、O8、O10）

- **FR-110** `hello`、`alive`、`bye` 不寫入任何一層。接收端用它們維護來源 instance 的登記與存活狀態，狀態呈現讀這些資料，不讀事件。
- **FR-111** 舊入口收到的 `system.producer_heartbeat` 改送存活通道，回 2xx 但不寫入。外部事件政策不再允許任何 `system` 種類。
- **FR-112** 「此 shell 有被記錄」的依據，是該專案收到一個綁定到此專案的 instance 的 `hello`（O10）。
- **FR-113** 分層規則：核心表決定哪些種類為 chained。`plugin:<id>` 憑證寫入、但不在核心表內的種類一律進 logged 層。核心來源與舊入口的未知種類維持今天的預設（chained）。只影響新列。「核心表」就是 Spec 072 的種類登記表：本規格的 `classifyTier` 只呼叫 072 的 `tierFor(agentType, subtype, producerClass)`，不另立任何 tier 表。072 的登記表落地前，本規格照今天的 `classifyTier` 出貨（外掛種類仍為 chained），本條在 072 Phase 4 的 T040 才生效。

#### L. 終端機事實、第一次綁定與私人（修訂 A3、A6，2026-11-13）

- **FR-086** 外部 shell 第一次綁定到某個專案時（FR-085 的 pin 成立、第一個項目被接受後），hook 在**下一個 prompt 之前**於 stderr 印恰好一行：專案名稱與 `redlog private`。每個 shell instance 每個專案至多一次；shell 初始化期間仍為 0 位元組（O10）；stderr 不是終端機時不印。共用向量加「第一次綁定恰好一行、之後 0 行」。
- **FR-087** `redlog private`：(a) 從未綁定的 instance：之後不送 `hello`、不送任何項目、不寫交接檔、不累計 `discarded`（私人 pane 的活動量本身就是私人資訊）；(b) 已綁定的 instance：送一列 `capture_stopped{reason:"private"}`（既有的 subtype），之後同 (a)。`redlog start` 撤銷它；從未綁定者的 `start` 視同第一次綁定（FR-086 再印一次）。終端機狀態檔的停止原因增加 `private`（Spec 073 FR-041 的封閉清單加一項，永久直到 `start`）。共用向量涵蓋 (a)(b)。
  > **指標（2026-11-13 深夜，DECISIONS §12）**：擁有者取消私人終端機：只有一套錄製流程，不想被記錄用暫停（FR-080–FR-084）。本條（與 FR-086 提示中的 `redlog private`）不再實作；[Spec 077](../077-personal-content-and-delivery/spec.md) 修訂 S3。077 也不再需要 FR-050 的 `ignored-rule`、`shell-history-rule`（077 修訂 S6，推得、待擁有者確認）。077 FR-110 的「擷取路徑」在本規格的單一入口落地時改指向它，其名稱 ratchet 的基準一併移過去。
- **FR-088** 每個 shell 的 `hello`、`command_start`、`command_end` 在 `data.term` 帶 hook 能知道的終端機事實：`user`（`$USER`／`$env:USERNAME`）、`tty`（`tty` 的結果，例如 `/dev/pts/3`）、`pane`（多工器提供的識別，依序取 `$TMUX_PANE`、`$WEZTERM_PANE`、`$KITTY_WINDOW_ID`、`$ZELLIJ_PANE_ID`；都沒有則省略）、`shell`（名稱與主版本）、`host`（只有在 shell 知道自己在遠端時：遠端 hook 一律帶 `hostname`；本機 hook 不帶，本機主機名已在列的 `hostname`）。這些是**來源自述的內容**，不是身分：在 `data` 內（受雜湊涵蓋），不進 `_ingest`；接收端只做長度上限（每項 64 位元組）與控制字元移除。FR-103 的行程數限制適用：取得這些值不得多啟動行程（`tty` 在 shell 啟動時讀一次並快取）。

#### M. 出口（修訂 A1，2026-11-13）

- **FR-120** 接收端為每一列新事件（兩層、任何入口）填 `source_ip`：值取核心出口讀取器（`IPSignalProducer`，`ip-signal-producer.ts:143-155`）在**接收當下**的穩定位址 `external`，依 FR-121 的狀態決定是否填。`source_ip` 已在雜湊與簽章輸入內（FR-020），雜湊公式不變；兩個 verifier 已讀這個欄位（`chain-anchor.ts:482,550`、`tools/redlog-verify.py:192`），只需新增「非 null 值」的共用向量。不填、不回填任何既有列（FR-021）。
- **FR-121** `_ingest` 增加三個鍵（FR-006 的型別限制內，約 60 位元組）：

  | 鍵 | 值 |
  |---|---|
  | `egress` | `current`（最近一次讀取成功、未在確認新位址、且距今不超過讀取週期的 3 倍）、`changing`（讀到不同位址、尚未確認；`source_ip` 仍為原穩定位址）、`stale`（最近一次讀取失敗，或成功讀取已超過 3 倍週期；`source_ip` 為最後的穩定位址）、`none`（本次 app 執行中從未讀到；`source_ip` 為 null）、`airgap`（`network.offline` 開；null）、`remote`（`remote:<名稱>` 的項目，見 FR-133；null） |
  | `egress_at` | 該位址最後一次被成功讀到的時間（毫秒，`externalReadAt`）；`none`／`airgap`／`remote` 為 null |
  | `egress_via` | `dns`／`http`；null 同上 |

  「未知」＝`none`、`airgap`、`remote`，以及 `stale`；它們在任何介面、CLI 與匯出中都顯示為位址加讀取時間或「未知」，**從不顯示為安全**（Spec 075 FR-025）。舊列沒有 `_ingest.egress`，顯示為「未記錄」。出口是 app 讀到的公有位址，不是封包層的證明，閱讀器照實寫讀取時間。
- **FR-122** 出口的對外形狀 `Egress = {address: string|null, read_at: number|null, state, via}`，由 `/api/whoami`（FR-07B）、Spec 075 的狀態 payload 與 `redlog status` 共用。
- **FR-123** 核心在下列時刻以行程內入口寫一列 chained `system:egress_changed`：穩定位址改變；`egress` 狀態在 `current`／`stale`／`none`／`airgap` 之間改變；每個 capture session 開始時一次。內容：`address`、`previous`、`read_at`、`via`、`state`、`vpn_interfaces`（`opsec-state.ts` 的 `vpnInterfaces`）、`link_type`。不依 IP 判斷字去重（與 `system:ip_verdict` 並存，後者不變）；種類由 Spec 072 登記（指標已加）。`changing` 不寫列，確認後以位址改變寫一列。

#### N. 遠端主機與跳板（修訂 A2，2026-11-13）

- **FR-130** 遠端 hook 經操作者自己的 ssh 反向轉送寫回本機接收端（`ssh -R <遠端埠>:127.0.0.1:<本機埠>`）；RedLog 提供 `redlog remote add <名稱> --project <id>`：發放 `remote:<名稱>` 憑證（只能寫入 `shell` 種類、限定單一專案、機器層登記）並印出要在遠端執行的安裝指令與 ssh 參數。`redlog remote revoke <名稱>` 立即撤銷（FR-076）。`hooks/vps-deploy.sh` 由此取代並刪除。
- **FR-131** 遠端**存放**：hook 腳本（與本機相同版本，安裝指令帶雜湊供核對）、`remote:<名稱>` 憑證檔（0600，目錄 0700）、有界的待送佇列（預設 500 項或 8 MiB，滿了丟最新的並計 `handoff-full`；接收 `accepted` 後即刪）、終端機狀態檔。遠端**永不存放**：操作者憑證、簽章私鑰、任何專案資料庫或匯出、其他來源的憑證、專案名稱（憑證在本機綁定專案，遠端只帶不透明的憑證 id）、已被接受的事件內容。`redlog remote uninstall` 刪除以上全部並印出結果。
- **FR-132** 遠端的待送佇列由遠端 hook 自己在通道恢復時重送（HTTP），不經本機的交接目錄；它的 MAC 與 FR-064 相同。可在安裝時以 `--no-spool` 關閉：通道不通時直接丟棄並計數。
- **FR-133** 接收端對 `remote:<名稱>` 的列：`_ingest.producer = remote:<名稱>`；`source_ip` 為 null、`_ingest.egress = "remote"`（本機出口不是遠端指令的出口）；`data.term.host` 為遠端 hook 回報的主機名（FR-088）；時間依 FR-004（遠端時鐘不校正，見 Assumptions）。
- **FR-134** 遠端 hook 讀不到本機的暫停狀態檔；暫停對遠端項目的判斷依修訂中的 FR-080–084（修訂 A5）在接收端進行，本修訂不另定。

### Key Entities

- **信封項目（Envelope Item）**：來源送出的一個觀察或控制訊號（FR-001），在觀察當下確定 `event_id`、`instance`、`seq` 與觀察身分。
- **接收端蓋章（`_ingest`）**：接收端寫進新列 `data` 的來源資料；chained 列的這部分在雜湊內。
- **回執（Receipt）**：每個項目一個封閉列舉的結果（FR-031）。
- **來源（Producer）與憑證（Credential）**：一個安裝在本機的擷取來源，以及它唯一的一把只能寫入的憑證（可輪替、可撤銷）。
- **來源 instance**：一個來源的一次行程執行，有 `hello`／`bye` 與序號。
- **遺失帳本（Loss Ledger）**：累計計數與序號缺口，結算為 chained `system.capture_gap`。
- **交接目錄（Handoff Directory）與隔離區（Quarantine）**：來源與核心之間的耐久交接處，以及不可重試項目的停車場。
- **存活訊號**：`hello`／`alive`／`bye`，不是事件。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** 以目前 main 產生的 golden 專案與 bundle：升級後 100% 的舊列，在 app 內驗證與 `redlog-verify.py` 的結果都與升級前相同；舊列的 `events.jsonl` 逐位元組相同；舊列的 UPDATE 數為 0。
- **SC-002** 「commit 後回應遺失、重送」故障注入 1000 次：每個契約 1 來源各得到恰好 1000 個不同的列，重複列為 0。
- **SC-003** 重啟等價（US1）在三種送達方式下，`target_id`、`_causes`、`engagement_id`、`operator_id`、`_ingest.target_via` 全部相同。
- **SC-004** FR-058 列出的每個情境都在結算期限內出現對應的缺口列，且每個 instance 的帳平衡（US3）。
- **SC-005** 暫停 property test（至少 10,000 組隨機案例）與「暫停中當掉」的真機情境：暫停期間收到的列為 0；交接檔中可用來源時間落在已記錄暫停區間內的列為 0（修訂 2026-11-13）。
- **SC-006** 100% 的 API 路由宣告所需能力；每一類來源憑證對每條非寫入路由都得到 403。
- **SC-007** 正式程式碼中直接呼叫 DB 寫入原語的位置為 0（基準 31，#716 量得）。
- **SC-008** 每個內建來源在其支援平台上通過全部必要向量；相容矩陣由測試結果產生。
- **SC-009** 每項的去重額外工作不超過一次索引查詢加一次插入；一百萬項的去重儲存不超過 100 MB；典型 `_ingest` 不超過 320 bytes（工作量計數，不用牆鐘）。
- **SC-010** 介面沒有新增頁面或路由；新增的介面字串每個語系不超過 8 個 key，且通過 `test/ui-copy.test.ts`。
- **SC-011** 舊入口對每一種情況的狀態碼與今天的特徵化測試完全一致（FR-036 的修正除外，該處只改主體文字）。
- **SC-012** `system.producer_heartbeat` 的新列數為 0，存活狀態仍可在 capture 狀態中看到。

## Assumptions

- 單一使用者、單機。**威脅模型**：防的是瀏覽器或網頁、敵意的錄製內容、只有檔案讀寫工具（不能執行程式碼）的代理、bundle 的持有者；**不防**能執行任意程式碼的同使用者程序（05-F6）。憑證與 MAC 防的是誤歸屬與越權，不防惡意的本機程序。
- 來源與接收端在同一台機器、同一時鐘。跨 VM、SSH 或遠端主機的來源可帶 `sent_at`，但本規格不據此校正時間。
- 本機已有 POSIX shell 擷取的地方就有 python3：adapter 每個指令會呼叫 relay（`shell-zsh-hook.zsh:116,161`）。沒有 python3 的情形見 O15。
- SQLite 維持 WAL。**專案的寫入連線設 `PRAGMA synchronous = FULL`**（`db/index.ts` 的 `initDB`，在第一次寫入之前；每次開專案、重開與切換專案都經過它）。必須明設：better-sqlite3 以 `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` 建置，沒有明設的連線在第一次讀到 WAL 檔時就降為 NORMAL（1）。唯讀連線（`getReadonlyDB`、`openReadOnlyDB`、匯出 worker 的 `openReadonlyProjectDB`）從不 commit，維持預設 NORMAL；衍生索引 `http-body-index.db` 與 cast index 可由證據重建，也維持 NORMAL。WAL + FULL 下 commit 對行程當掉與作業系統當掉耐久；斷電的界線依平台，見 FR-062。`test/hash-input-pin.test.ts` 釘住這些值。
- relay 只對網路錯誤（沒有回應、連線被拒、逾時）重試，不對 5xx 重試；01 報告 F1 表中「relay 重試 5xx」一格在 #716 未能重現（T004 依實測釘住）。
- 操作者身分讀自機器層級設定（O12）；搬遷本身是另一項變更。
- 依賴：階段 0 的略過記帳（#706 已合併）；#708 的事件排序修正與本規格無衝突；#711 的 bundle 第 4 版與本規格無格式衝突。

## 不在範圍

- 查詢工作執行緒、衍生資料增量化（階段 3）；把推導的 CPU 搬到 worker（02 §3 的 (c)）。
- 來源狀態模型與固定詞表（階段 5）。本規格只提供它要讀的事實。
- 介面改版、新頁面；Reader 對「已結束卻顯示執行中」的顯示修正（01-F3 #3）。本規格只確保缺口列帶有指令 id。
- 讀取面停止以 `engagement_id` 過濾，以及舊的 `'default'` 列在 Activity 的呈現（07-F2 讀取面）。
- Merkle checkpoint、匯出檢查點鏈；bundle 格式變更。
- 改寫、回填或重新雜湊任何既有列。
- 匯出時集中遮罩（05-F3）、完整性詞彙（01-F6）、因果 edge 表（07-F4）、NTP 逐列蓋章（05-F4）。
- `ProjectSession` 與單一設定視圖（階段 2）；`machine.yaml` 的搬遷本身（O12）。
- DESIGN-plugin-kernel §3 的「先存原始位元組 + mapper」管線；以 OSC 序列傳遞內建終端機事件。
- 從隔離區重新寫入（需要另一個規格）。

## 開放問題（需要擁有者）

> **2026-11-12 擁有者答覆**：Q6 照建議——寫入連線改為 `synchronous=FULL`，改之前先量測寫入成本；量測結果若顯示影響明顯，回報後再議折衷。

> **2026-11-12 已實作**：寫入連線設 `synchronous = FULL`；`fullfsync` 不開。量測（MacBook Pro M2 Pro、內建 Apple SSD AP1024Z／APFS，經 `insertEvent` 的真實寫入路徑，每列一次 commit，單一行程、1 分鐘負載低於 8）：FULL 與 NORMAL 在雜訊範圍內沒有差別（100 筆 shell 突發 35→42 ms；2,000 筆 HTTP flow 事件 0.79→0.60 s；20k 積壓 9.0→8.8 s；FULL 每次 commit p50 約 0.2–0.3 ms、p99 低於 3 ms），macOS 上不清磁碟快取的 `fsync()` 很便宜。`fullfsync = ON` 每次 commit 約 4–5 ms，100 筆突發 0.66 s、2,000 筆 HTTP 事件 10.6 s、20k 積壓 112 s（今天的 12–19 倍），且主執行緒同步等待，所以不開；代價是 macOS 上斷電時最近幾筆 commit 仍可能遺失（FR-062）。Q6 關閉。

O13–O17（原 Q1–Q5）已決定。以下是 2026-11-12 Phase 1 實作後新出現、尚未答覆的事項；本規格不替擁有者決定。

| # | 問題 | 建議 |
|---|---|---|
| Q6 | `PRAGMA synchronous` 實為 NORMAL（見 Assumptions），`accepted` 之後來源會刪掉交接檔，所以斷電或作業系統當掉時，最近幾筆已回 `accepted` 的事件可能既不在資料庫、也不在交接目錄。要在寫入連線設 `synchronous = FULL`，還是在契約中寫明「`accepted` 對行程當掉耐久、對斷電不耐久」？ | 設 FULL（只在寫入連線）。先以 T061 的 perf lane 量測每次 commit 的額外成本，再決定；量測前不改。若不改，FR-032、FR-062 與 `docs/domain/SPEC-ingestion-contract.md` 要明寫斷電的界線 |

## Domain References

- `.specify/memory/constitution.md` I、II、III、VI、VII、VIII、IX。
- `docs/domain/glossary.md`：Event、Chained／Logged Event、Capture Session、Source Time、Receipt Time；Domain Invariant 5、6、8、9。本規格新增的術語在 T080 寫入 glossary。
- `docs/design/DESIGN-capture-trust.md` §1–§3；`DESIGN-two-tier-chain.md` §2.1；`DESIGN-plugin-kernel.md` §3。
- Spec 002（FR-001、FR-006、FR-007）、003（FR-004）、052（FR-010）、055。
- Spec 072–075（同批起草）：介面見 plan「與兄弟規格的介面」；跨規格的實作順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」。

