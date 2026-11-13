# Feature Specification: 專案執行期、設定層級與安裝帳本

**Feature Branch**: `spec/072-075-contracts`
**Created**: 2026-11-12
**Status**: Draft
**Input**: [根因審查與落地計畫](../../docs/records/2026-11-12/ROOT-CAUSE-REVIEW.md) 階段 2「專案執行期物件：資源清單與單一的設定檢視」及 §4 的十項決定；根因報告 [07](../../docs/records/2026-11-12/root-cause/07-architecture.md)（F1、F6，T2、T3）、[04](../../docs/records/2026-11-12/root-cause/04-source-lifecycle.md)（§3.6 範圍劃分）、[08](../../docs/records/2026-11-12/root-cause/08-plugin-system.md)（F2、F3、M1、M2、G4）、[09](../../docs/records/2026-11-12/root-cause/09-setup-choices-and-multiplicity.md)（F1、F7、F8、A.5）；[DESIGN-project-runtime](../../docs/design/DESIGN-project-runtime.md)；PRIOR-ART-D 與 PRIOR-ART-SUMMARY「專案生命週期」一列；[工作計畫](../../docs/WORK-PLAN.md) 階段 2 的掛載工作。

> 本檔只寫可觀察的行為與對外契約。模組介面、被否決的做法、遷移順序與驗證方式在 [plan.md](plan.md)。本規格與 `docs/design/DESIGN-project-runtime.md` §2 衝突處以本規格為準，該文件在 tasks T090 改寫。

## 決策與範圍

### 已決議（擁有者，2026-11-12；本規格不重開）

| # | 決定 | 落點 |
|---|---|---|
| P1 | 新增機器層級設定檔 `~/.redlog/machine.yaml`；專案只保存該次任務的事實或明確覆寫的值 | B |
| P2 | 被切換專案的外部終端機改為**暫停**：綁定的專案重新開啟時自動恢復，並寫入 `capture_resumed`；「A 的指令不歸到 B」不變；`redlog stop` 仍是永久的 | D |
| P3 | 安裝帳本：RedLog 在自己目錄以外做的每一個改動都有精確的還原紀錄；移除不留殘餘，或明確說出留下了什麼；「hook 有載入」的證據是 hook 啟動時送出的 `hello` | E |
| P4 | Hook 預設裝到本機所有有 adapter 的 shell | E |
| P5 | 官方 AI adapter 從 app 本體執行，取消機器層的「安裝」；第一次在某專案啟用時以原生對話框取得同意；外掛頁只保留撤回同意 | F |

> **Superseded（2026-11-13，修訂 B2）**：P5 的「第一次在某專案啟用時」改為「第一次在這台機器啟用時」；工作階段的選擇仍逐專案。其餘不變。
| P6 | 個人流量規則搬出範圍設定，放到機器層級；預設不再含 localhost | B |
| P7 | 專案生命週期：記錄中、暫停、關閉、封存（唯讀）是不同的操作；新增 `project_closed` 紀錄，使「app 沒開」與「沒有事件」可區分；既有專案的該段標為「是否在錄：未知」 | C |
| P8 | 第三方 Source 只允許手動設定；RedLog 不把第三方腳本寫進 shell rc 或其他工具的設定 | E |
| P9 | 不引入相依注入容器、全域狀態庫；不整批搬動 `src/core`；不依行數拆檔；React 元件不在另一個元件內宣告 | 全部 |
| P10 | 不新增頁面；單欄；固定詞表（8 個來源狀態、4 個整體狀態、完整性另列）；scope、擷取政策、顯示篩選、匯出選取四個詞不共用一個控制項 | C、UI |
| P11 | 不改變既有事件的雜湊、簽章、鏈結方式；不改寫既有列；既有專案照舊開啟、驗證、匯出 | 全部 |

### 修訂（2026-11-13）

依 [2026-11-13 的決定](../../docs/records/2026-11-13/DECISIONS.md) §2 與同日擁有者對 Spec 076 的修訂 R1（AI 工具是例外）。被取代的原文保留在原處，以「> **Superseded（2026-11-13）**」標示。

| # | 改了什麼 | 為什麼 |
|---|---|---|
| B1 | **擷取來源的啟用移到機器層**：`machine.yaml` 新增 `extensions.<id>.enabled`（歸屬機器，不可在專案覆寫）；專案設定中的 `packs.<id>`、`packMembers` 讀到時只作為遷移的初值，之後忽略、不從檔案刪除（Spec 076 FR-041、FR-047） | DECISIONS §2「擷取來源屬於這台機器」 |
| B2 | **AI adapter：啟用與同意是機器層；工作階段的選擇仍是逐專案**。專案設定的 `agentTailer.sources.<kind>`（`workPaths`、選取的工作階段、`startedAt`）保留為專案層的**選擇**，意義從「這個專案同意並啟用」改為「這個專案要記錄哪些工作階段」。同意紀錄（讀取根目錄、事件種類、adapter 摘要、時間、方式）改存 `machine.yaml` 的 `extensions.<kind>.consent`；機器層撤回時間保留。重新綁定是第一級的動作（Spec 076 FR-045–046 的認領索引） | 擁有者修訂 R1：工作階段屬於哪個專案必須逐專案選擇、可改選 |
| B3 | **終端機與專案的綁定（D 段）適用於每一種終端機來源**：外部 shell、內建終端機的 pane hook、遠端 hook（Spec 071 FR-130）。內建終端機的 pane 仍依 Spec 055 輪替（FR-044）；內建終端機本身是選用、預設關閉的擴充功能（Spec 076 E6） | DECISIONS §2 |
| B4 | 終端機狀態檔的停止原因增加 `private`（Spec 071 FR-087） | DECISIONS §5 #1 |
| B5 | 開放問題 Q2 已由 B2 回答：同意是機器層一次；選擇是逐專案 | DECISIONS §7 第 4 項 |
| B6 | 擴充功能的設定進兩層檔案、以擴充功能 id 為命名空間：`machine.yaml` 的 `extensions.<id>.config.<key>`、專案 `config.yaml` 的 `extensions.<id>.<key>`；設定登記表（FR-011）以擴充功能 manifest 動態登記這些鍵，每鍵恰好一個 scope；未知鍵保留（FR-023）。`httpCapture.port`／`listenHost` 移入受管代理擴充功能的設定（Spec 076 T057） | Spec 076 K 段 |
| B7 | **operator 只在機器層**（2026-11-13 晚間，DECISIONS §9 對 Q4 的答覆，與建議不同）：`operator.id`、`operator.name` 歸屬機器、**不可**在專案覆寫；專案 `config.yaml` 中的 `operator`（既有的值、建立卡片或匯入的設定檔帶來的值）一律不讀、不顯示、不視為錯誤，下一次存檔時不再寫出。設定頁不再有「此專案覆寫」的 operator，也沒有「只套用到此專案」。舊格式規則中 operator 的例外（FR-016）與給舊版 app 的 operator 鏡像（FR-019、plan D6）一併取消（plan D12） | 擁有者裁定：專案不可以覆寫 operator | FR-016、FR-019、FR-01D；US4；plan D5、D6、D12 與歸屬表；tasks T04A、T04B；071 FR-009 的註記 |

### 本規格自行決定的（理由與被否決的替代方案見 plan.md）

1. **`ProjectSession` 吸收 `ProjectRuntime`**：一個開著的專案只有一個擁有者物件。`ProjectContext`（generation + signal）保留為交給非同步工作的「session token」型別，不再另有 `ProjectRuntime` 實例（plan D1）。
2. **一種過時判斷**：專案範圍的可變狀態只存在於 session 擁有的物件裡，隨 session 消失；跨 await 的工作只比對 session token。顯式 reset、`dbGeneration()` 懶重設、`projectDir` 比較、project id 比較四種手法全部退場（plan D2）。全程式只允許一個專案範圍的模組變數：目前 session 的插槽。
3. **切換先準備、後交棒**：解析並驗證 B 的設定、開啟 B 的資料庫並完成 schema 遷移，都在 A 停止之前做。這一段失敗時 A 原封不動，繼續記錄（plan D3）。
4. **設定分層**：預設值 → 機器 → 專案 → session 覆寫，由一個 `ConfigView` 解析一次。開專案不再把合併後的設定寫回 `config.yaml`；設定檔解析失敗時拒絕開啟，不再以預設值覆蓋檔案（plan D4、D5）。
5. **舊格式設定檔的讀法**：沒有 `configVersion` 的檔案是舊格式。舊格式裡移到機器層級的鍵，值等於舊版內建預設值時視為「未選擇」而繼承機器值；不等於時視為專案覆寫。操作者身分與個人流量清單例外，一律保留為覆寫（plan D5）。

   > **Superseded（2026-11-13，修訂 B7）**：操作者身分不再是例外，也不是覆寫：專案檔中的 `operator` 一律不讀（plan D12）。個人流量清單的例外不變。
6. **封存**是專案選擇器上的操作，只能對未開啟的專案執行；封存的專案以唯讀 session 開啟，不啟動任何擷取資源（plan D8）。
7. **安裝帳本**位於 `~/.redlog/installs.json`，以「檔案」為單位記錄，一個 shell 可有多筆；還原以寫入的確切位元組為準（plan D9）。
8. **AI 同意**存在專案設定裡；撤回可以是機器層級的一個時間戳，使所有專案在該時刻之前取得的同意一併失效（plan D10）。

   > **Superseded（2026-11-13，修訂 B2）**：同意存在 `machine.yaml` 的 `extensions.<kind>.consent`；專案設定只存工作階段的選擇。機器層撤回時間保留。
9. **擷取健康的 DB 錯誤計數**改為 session 範圍：切換專案即歸零（plan D11；07-F1 列為待產品決定，本規格依 UI 以專案為單位呈現的事實決定）。

### 前提更正（已在程式碼確認，`origin/main@56c9fe6c`）

- **開專案會用預設值覆蓋壞掉的設定檔。** `startProject` 先 `loadConfig` 再 `saveConfig`（`src/main/index.ts:781-782`）；`loadConfig` 對任何讀取或解析錯誤都回傳預設值（`src/core/config.ts:401-410`）。所以一份無法解析的 `config.yaml` 會被整份改寫成預設值，操作者的 scope、operator 等明確值就此消失。只有「寫入失敗」會中止開啟。
- **每次開啟都把合併後的完整設定寫回檔案**（同上 `:782`），所以既有專案的 `config.yaml` 一律含有全部鍵的預設值：從檔案無法分辨「操作者選了預設值」與「從未設定」。B 的遷移規則以此為前提。
- 直接讀設定檔的呼叫，在 `src/main` 與 `src/core` 共 **36 處**（07 報告記為 33），清單見 plan「它取代什麼」。
- `ProjectRuntime.onStop` 在正式碼中的使用數為 **0**（07 報告的主張成立）。`dbGeneration()` 的使用為 **17 處**、5 個檔案（07 記為 18）。
- `network.offline` 只有 `alertRuntime` 在存檔時重新套用（`config-apply-plan.ts:159-164`）；`setUpdaterAirgap`、`startAnchorLoop`、`startNtpLoop` 只在開專案時讀（`main/index.ts:1058-1064`）；`chain-anchor.ts:51` 每次呼叫自行讀檔。07-F1 的「air-gap 只套一半」成立。
- `startLinkMonitor()`（`main/index.ts:649-661`）每次開專案都啟動，`stopProject`（`:1220-1280`）不停它。
- 官方 AI adapter 的執行路徑是 `~/.redlog/plugins/<id>/adapter.cjs` 的複製本（`main/index.ts:583-586`、`agent-tailer.ts:26-32`），能否執行取決於收據與 bytes 比對（`official-agents.ts:47-57`）。

## User Scenarios & Testing *(mandatory)*

| 故事 | 優先級 | 摘要 |
|---|---|---|
| US1 切換專案不會讓 A 的任何東西活到 B | P1 | 一個擁有者、一份資源清單；切換後沒有任何資源還持有 A 的 id |
| US2 開不起來的專案不會留下半開的狀態，也不會毀掉設定 | P1 | 準備失敗時 A 照常；啟動失敗時乾淨地沒有專案；設定檔不被覆蓋 |
| US3 一個設定值在所有消費者同時生效 | P1 | 單一設定檢視；air-gap 打開的那一刻，所有對外連線同時停止 |
| US4 機器與個人的事實只設一次 | P1 | 新專案繼承 operator、自有 IP、proxy 端點等；既有專案的值一個都不變 |
| US5 回到專案時，被暫停的終端機自己恢復 | P1 | 外部終端機切走時暫停、切回時恢復並留下 `capture_resumed`；`redlog stop` 不受影響 |
| US6 看得出 app 沒開的時段，關閉、封存是不同的操作 | P2 | `project_closed` 紀錄；封存的專案唯讀開啟 |
| US7 RedLog 寫過的每個檔案都能精確還原 | P2 | 安裝帳本；移除後位元組相同，或明列留下什麼 |
| US8 官方 AI 整合不再「安裝」，升級不會讓它停錄 | P2 | 從 app 本體執行；同意以專案為單位；舊複製本遷移時不中斷擷取 |

### User Story 1 — 切換專案不會讓 A 的任何東西活到 B（P1）

操作者在 A 專案工作，切到 B 查一件事，再切回 A。切換後，B 收到的每一筆事件、每一個 HTTP body、每一個快取答案、每一個計時器的動作，都屬於 B；回到 A 時，A 的狀態是重新開啟的狀態，而不是上一次 A 殘留的狀態。

**Why this priority**：自 2026-08 起至少 8 個 commit 修的都是「切換後寫進／讀到別的專案」（07-F1 實例），每次都是補一條 reset。`http-body-store.ts:36` 的 `_cachedDir` 仍要靠 `stopProject` 記得呼叫 `resetBodiesDirCache` 才正確。

**Independent Test**：切換洩漏測試。對每一個登記的資源：開 A → 經該資源寫入或觸發一次 → 切到 B → 斷言 `inspect()` 回報的專案 id 只有 B，且沒有任何屬於 A 的計時器或檔案控制代碼仍在。資源清單與測試案例由登記表產生：新增資源而沒有切換案例時，測試失敗。

**Acceptance Scenarios**：

1. **Given** A 開著且 HTTP body 已寫入 A 的 `http-bodies/`，**When** 切到 B 並收到一個 body，**Then** 它寫在 B 的目錄，A 的目錄檔案數不變；不需要任何 `reset*` 呼叫。
2. **Given** 一個在 A 開始、跨過 await 的工作（錨定、截圖、scope 重算、匯出），**When** await 期間切到 B，**Then** 該工作不寫入 B，結束時回報 `superseded`。
3. **Given** A → B → A，**When** 第一個 A 的延遲回呼在第二個 A 期間觸發，**Then** 它被識別為過時（不同 session token），不寫入。
4. **Given** 連結監看（`startLinkMonitor`）在 A 開啟時啟動，**When** 關閉 A，**Then** 它的計時器停止。

### User Story 2 — 開不起來的專案不會留下半開的狀態，也不會毀掉設定（P1）

**Why this priority**：今天設定檔解析失敗會被預設值整份覆蓋（前提更正）；資料庫開不起來時，原本開著的 A 已經被關掉，操作者回到一個沒有專案的畫面。

**Independent Test**：故障注入（沿用 `e2e/project-open-rollback.spec.ts` 的四種故障，再加上「設定檔無法解析」與「第 k 個資源啟動時丟錯」）。斷言：(a) 準備階段的故障：A 仍是開著的專案、仍在記錄、identity 檔與 API 都還是 A；B 的檔案位元組不變；(b) 啟動階段的故障：沒有開著的專案，已啟動的資源全部以相反順序停止，identity 檔不存在，API 回 503；(c) 兩種情況都沒有任何資源還持有 B 的 id。

**Acceptance Scenarios**：

1. **Given** B 的 `config.yaml` 無法解析，**When** 開 B，**Then** 開啟被拒絕並說明原因（檔案與錯誤位置），檔案位元組不變，A 繼續記錄。
2. **Given** B 的資料庫檔損毀，**When** 開 B，**Then** 同上：A 繼續記錄。
3. **Given** B 的第 k 個資源啟動失敗，**When** 開 B，**Then** 第 1…k−1 個資源以相反順序停止，沒有專案開著，畫面回到專案選擇器並顯示「無法開啟此專案」與原因；再開 A 可以正常記錄。
4. **Given** 任何一種失敗，**Then** 不存在「`project:active` 回答 B、但 API 或 identity 檔仍是 A」或相反的時刻。

### User Story 3 — 一個設定值在所有消費者同時生效（P1）

**Why this priority**：air-gap 是 OPSEC 開關。今天在專案開著時打開它，錨定會停，NTP 每 5 分鐘仍然對外，更新檢查仍在跑，要重開專案才生效（07-F1）。

**Independent Test**：對設定登記表中每一個鍵：在 session 開著時以存檔改變它，斷言每一個宣告讀取它的資源在存檔回覆之前已收到新值；宣告「無即時效果」的鍵有寫明的理由，且沒有任何資源在執行期讀它。另以網路替身斷言：打開 `network.offline` 之後，NTP、錨定、更新檢查、對外 IP 查詢的對外連線數為 0。

**Acceptance Scenarios**：

1. **Given** 專案開著、air-gap 關，**When** 在設定頁打開 air-gap，**Then** 存檔回覆時錨定迴圈、NTP 迴圈、更新檢查、對外 IP 查詢都已停止，並寫一列 `opsec_airgap`。
2. **Given** air-gap 開，**When** 關掉，**Then** 上述四者在存檔回覆時已重新排程（不立即對外連線，依各自的首次延遲）。
3. **Given** 任何讀設定的程式碼，**Then** 它經由 session 的設定檢視讀，不自己讀檔。

### User Story 4 — 機器與個人的事實只設一次（P1）

**Why this priority**：每個新專案都回到 `operator-1/Operator`、空的自有 IP 黑名單（沒有洩漏偵測，且畫面不說）、6661／127.0.0.1（09-F8）。

**Independent Test**：遷移等價（property test）：任意產生舊格式的 `config.yaml` 與任意 `machine.yaml`，斷言升級後每個鍵的有效值與升級前 `loadConfig` 的值相同。另一個測試：設定機器值後建立新專案，新專案讀到機器值；在專案上覆寫，再「改回使用機器值」，有效值回到機器值。

**Acceptance Scenarios**：

1. **Given** 機器層的 operator 是 `alice`，**When** 建立新專案，**Then** 新專案的 operator 是 `alice`，且新專案的 `config.yaml` 不含 operator。
2. **Given** 一個既有專案，其 `config.yaml` 的 operator 是 `bob`，**When** 升級後開啟，**Then** 它的 operator 仍是 `bob`，設定頁在該欄標示「此專案覆寫」並提供「改用此電腦的值」。
3. **Given** 一個既有專案的 `scope.personalDomains` 是舊預設值（含 localhost），**When** 升級後開啟並匯出，**Then** 排除的列與升級前相同。新建立的專案預設不排除 localhost。
4. **Given** 一個既有專案的 `httpCapture.port` 等於舊預設 6661，機器層設定為 6670，**When** 開啟，**Then** 受管 proxy 綁 6670（該值未被操作者選擇過，繼承機器）。
5. **Given** 舊版 app 打開一個新格式的專案，**Then** 它能開啟並記錄，operator 與新版相同（plan D6 的鏡像）；其他機器層的值在舊版中回到舊預設，這是已知的降版行為。

> **Superseded（2026-11-13，修訂 B7）**：情境 2 與情境 5 改為下列兩條；情境 1、3、4 不變。
>
> - **2′** **Given** 一個既有專案，其 `config.yaml` 的 operator 是 `bob`，機器層的 operator 是 `alice`，**When** 升級後開啟，**Then** 有效的 operator 是 `alice`（來源：機器），此後新列的 `operator_id` 是 `alice`；`bob` 不顯示、不是錯誤、不阻擋開啟，下一次存檔後檔案不再含 operator。設定頁的 operator 欄位沒有「此專案覆寫」也沒有「改用此電腦的值」。
> - **5′** 不再保證較舊版本的 app 開啟新格式專案時 operator 相同：新格式的專案檔不含 operator（不寫鏡像，plan D12）。
> - **6** **Given** 專案開著，**When** 在設定頁改 operator，**Then** 寫入 `machine.yaml`，開著的 session 在存檔回覆前改用新值（FR-01C），之後開啟的每一個專案都用它；任何專案檔都不被寫入 operator。

### User Story 5 — 回到專案時，被暫停的終端機自己恢復（P1）

**Why this priority**：同時跑兩個 engagement，或只是去 B 看一眼，所有開著的 tmux pane 都會永久停錄；回到 A 之後要重開所有 pane，否則之後的指令都沒有記錄（09-F7）。

**Independent Test**：以兩份轉移函式（TS 與 relay）的 agreement 測試，加上狀態表的全組合測試：{綁定 A、未綁定} × {開著 A、開著 B、沒有專案} × {記錄中、操作者停止、hook 移除}，斷言「是否送往 A」「是否送往 B」「是否恢復」。真機：開 A、開 tmux、切 B、再切回 A，接下來的指令有記錄，且 A 的時間軸上有一列 `capture_resumed`。

**Acceptance Scenarios**：

1. **Given** 終端機綁定 A、正在記錄，**When** 開 B，**Then** 該終端機的指令不送往 B（本地暫停，由 071 FR-085 計數），終端機下一個 prompt 說一次「此終端機綁定另一個專案，已暫停」。
2. **Given** 同上，**When** 再開 A，**Then** 下一個指令照常記錄到 A，且之前有一列 `capture_resumed`，附暫停期間的計數。
3. **Given** 終端機已被操作者 `redlog stop`，**When** 經過任意次切換，**Then** 它仍然停止，直到操作者 `redlog start`。
4. **Given** 終端機綁定 A，**When** A 被關閉且沒有專案開著，**Then** 與「開著 B」相同：本地暫停，A 再開時恢復。
5. **Given** 升級前就被標成 `project-switched` 的終端機狀態檔，**When** 升級後 A 開著，**Then** 該終端機視為「暫停中」，下一個指令恢復記錄（仍在跑舊 hook 函式的 shell 例外，見 Edge Cases）。
6. **Given** 內建終端機，**Then** 行為不變：依 Spec 055 隨開著的專案輪替。

### User Story 6 — 看得出 app 沒開的時段，關閉、封存是不同的操作（P2）

**Why this priority**：沒有事件的時段無法分辨「app 沒開」「在錄但沒有活動」「當機」，違反「沒有事件不得看起來像什麼都沒發生」。

**Independent Test**：對每一種結束方式（關閉、切換、結束 app、更新重啟、封存前的關閉、當機）斷言專案的最後一列或下一次開啟時的第一批列中有恰好一列 `project_closed`，`reason` 正確。封存的專案以唯讀開啟時，資料庫的位元組與 WAL 都不變。

**Acceptance Scenarios**：

1. **Given** 專案開著，**When** 操作者關閉專案，**Then** 該 session 寫入的最後一列是 `project_closed{reason:"closed"}`：在終端機的 `session_end` 等關閉時的列之後、資料庫關閉之前。
2. **Given** app 被強制結束，**When** 下次開啟同一專案，**Then** 在 `session_start` 之前寫一列 `project_closed{reason:"unclean"}`，其發生時間是上一次存活戳記的時間。
3. **Given** 一個未開啟的專案，**When** 在專案選擇器上封存，**Then** 該列顯示「已封存」；開啟它時是唯讀：沒有擷取、沒有設定寫入、沒有保留期清理、沒有交接目錄排空，畫面上有一處標示「唯讀」。
4. **Given** 已封存的專案，**When** 在選擇器上取消封存，**Then** 下次開啟恢復正常。
5. **Given** 匯出進行中，**When** 關閉專案，**Then** 離開確認列出進行中的匯出；確認後匯出取消、暫存刪除、沒有半成品交付物，介面說明「匯出已取消：專案已關閉」。

### User Story 7 — RedLog 寫過的每個檔案都能精確還原（P2）

**Why this priority**：撤銷、停用或移除外掛後，已寫進 rc 或 `~/.claude/settings.json` 的項目會變成孤兒，連 `uninstallHook` 都找不到（08-F3）；PowerShell 的移除會把 LF 的 profile 變成 CRLF（09-A.2）。

**Independent Test**：對每一種寫入類型（rc 區塊、PowerShell profile 行、JSON 設定項目、複製的檔案、憑證檔、指示操作者執行的步驟），在 {一般檔、symlink、`ZDOTDIR`、bash login 檔、CRLF、沒有結尾換行、安裝後被操作者改動、安裝後被刪除} 的組合上執行「安裝 → 移除」，斷言檔案位元組與安裝前相同、帳本為空；或移除報告逐項列出留下了什麼與原因。

**Acceptance Scenarios**：

1. **Given** 本機有 zsh 與 bash，**When** 安裝 shell hook，**Then** 兩者都被寫入，帳本各有一筆以上（一個 shell 可能有多個檔），設定頁兩列各自顯示「已寫入 · 尚未看到」，直到收到該 shell 的 `hello`。
2. **Given** 安裝後操作者改動了 RedLog 寫的那一行，**When** 移除，**Then** 那一行留在原處，報告寫出檔案、行號與「內容已被修改，未移除」。
3. **Given** 升級前已安裝的 hook 與孤兒項目（已退役外掛留在 rc 或 `~/.claude/settings.json` 的項目），**When** 新版第一次啟動，**Then** 認得的項目被補登到帳本（標示「補登」），可以從設定頁移除；認不得的不動。
4. **Given** 解除安裝程式執行 `--remove-hooks`，**Then** 依帳本移除，不依 manifest。

### User Story 8 — 官方 AI 整合不再「安裝」，升級不會讓它停錄（P2）

> **Superseded（2026-11-13，修訂 B2）**：情境 2 改為「新專案 B，adapter 已在機器層啟用並同意 → 在來源列選擇工作目錄或工作階段，不再出現對話框；adapter 尚未啟用 → 先在設定 ▸ 擴充功能啟用（對話框一次），再選擇」。情境 4 的「所有專案在此時刻之前的同意失效」照舊，入口只剩設定 ▸ 擴充功能。其餘情境不變。

**Why this priority**：app 更新改了 adapter → `update-available` → 該 agent 在所有專案停錄，直到有人去外掛頁按更新（08-F2）。

**Independent Test**：遷移單元測試（收據 → 同意，`installationId` 延續）；在有一個正在記錄 Claude Code 的專案上換一版 adapter 的 build，斷言升級後第一次開啟該專案時，擷取在不需任何操作的情況下繼續，且沒有任何一段被標成停錄。

**Acceptance Scenarios**：

1. **Given** 專案 A 已授權 Claude Code（舊的安裝收據有效），**When** 升級，**Then** A 開啟後 Claude Code 繼續記錄，不出現同意對話框；舊的 `~/.redlog/plugins/<id>/` 留在原處、不再被執行，外掛頁說明它仍在並提供移除。
2. **Given** 新專案 B，**When** 在來源列按「在此專案記錄」，**Then** 先選工作目錄，再出現原生同意對話框（列出它會讀的根目錄與會產生的事件種類）；同意後開始記錄。
3. **Given** app 更新後 adapter 宣告的讀取範圍沒有改變，**Then** 同意延續、不停錄；範圍改變時，來源列為「未設定」並說明「讀取範圍已變更，需要重新同意」。
4. **Given** 外掛頁按「撤回同意」，**Then** 所有專案在此時刻之前的同意失效；開著的專案立刻停止該來源並寫一列紀錄。
5. **Given** 舊收據處於 `conflict` 或 `error`，**Then** 不遷移；該來源顯示「未設定」並說明原因，不是無聲地停掉。

### Edge Cases

- 切換到同一個專案（重新開啟 A）：等同關閉 A 再開 A，session token 換新；`project_closed{reason:"reopened"}` 寫入。
- 開啟中又要求開另一個專案：後到的要求在前一個開啟完成（或失敗）後才處理，不交錯。
- 關閉期間有 IPC 進來：回 `no-project`，不排隊到下一個 session。
- 一個資源的 `stop` 丟錯：其餘資源照樣停止；關閉報告列出失敗的資源，資料庫照樣關閉。
- 唯讀 session 中有外部來源送事件：API 回 `retry`／`no-project`（等同沒有可寫入的專案），來源依 071 寫進交接目錄；封存的專案不排空交接目錄，取消封存並開啟後才寫入。
- `machine.yaml` 的 `schema` 大於本版認得的：本版只讀認得的鍵，不寫入該檔；設定頁的機器值顯示為唯讀並說明「由較新版本的 RedLog 寫入」。
- `machine.yaml` 解析失敗：機器層視為空（以內建預設值運作），設定頁顯示錯誤與檔案路徑；不覆寫該檔。專案照常開啟。
- 兩個 RedLog 同時寫 `machine.yaml`（開發版與安裝版）：寫入以修訂值比對，後寫的一方得到衝突並重讀，不靜默覆蓋。
- 舊格式設定檔中機器層的鍵值等於舊預設值，但操作者確實是刻意選的：無法分辨；本規格把它當成「未選擇」。例外清單（身分、個人流量）不受影響（Assumptions）。
- 仍在執行舊 hook 函式、尚未重新 source 的 shell：它的 relay 依舊把 `project-switched` 當永久停止，直到開新終端機。設定頁的終端機列說明「此終端機使用舊版 hook，切換後不會自動恢復」。
- 終端機綁定的專案已被刪除：永遠不恢復；呈現沿用 075 的理由碼 `bound-elsewhere`（變數指出綁定的專案已不存在），不另立理由碼；計數依 071。
- 終端機綁定的專案被封存：唯讀 session 不視為「綁定的專案重新開啟」，終端機維持暫停。
- 安裝目標是 symlink（stow、yadm）：先問操作者要寫進 symlink 的目標，還是改寫 `ZDOTDIR` 或本機的 local 檔；帳本記錄實際寫入的路徑與 realpath。
- 安裝目標所在的 dotfile 管理工具在之後重新產生檔案，使 RedLog 的區塊消失：驗證把該筆標為 `missing`，設定頁的 shell 列說明「RedLog 寫的那一行已不在 {檔案}」。
- WSL 內的 rc：帳本記錄 distro；移除經 `wsl.exe` 執行；distro 已不存在時，報告列為「無法存取，未移除」。
- 帳本本身遺失或損毀：下一次啟動以補登重建；損毀的檔改名保存，不覆寫。
- 官方 adapter 的打包檔缺失：該來源為「無法使用」並附理由；不回頭執行 `~/.redlog/plugins` 的舊複製本。
- 匯出途中切換專案：匯出取消（同 US6-5），不寫入任一專案。

## Requirements *(mandatory)*

### Functional Requirements

#### A. 專案 session（US1、US2）

- **FR-001** 同一時刻最多一個 `ProjectSession`。它是「這個專案開著」期間所有狀態的唯一擁有者：資料庫連線（讀寫與唯讀）、cast 索引、body 索引、設定檢視、身分 token、每個專案的快取、計時器，以及一份有序的資源清單。
- **FR-002** 每個資源宣告 `id`、它讀的設定鍵、它屬於擷取或唯讀用途，並實作 `start`、`stop`、`inspect`，可選 `apply`。資源依清單順序啟動，以**相反順序**停止。今天 `stopProject` 的順序契約（終端機綁定在資料庫關閉前結束；API 綁定先於 identity 檔撤銷；先中止 session 的 signal 再停任何資源）由清單位置表達，並由快照測試釘住。
- **FR-003** 專案範圍的可變狀態只能存在於 session 擁有的物件中。`src/core` 與 `src/main` 的模組層級可變繫結，除了 session 插槽以外，都必須是 app 範圍、機器範圍、常數或測試接縫，且列在允許清單並寫明理由（gate：FR-090）。
- **FR-004** 非同步工作開始時取得 session token；每一次 await 之後、寫入之前，以 token 判斷自己是否仍屬於目前的 session。不再以 project id、專案目錄或 `dbGeneration()` 判斷。R1c 的寫入守衛（綁定的 engagement）保留為最後一道防線。
- **FR-005** 開啟分兩段：
  1. **準備**：解析並驗證設定（B 段）、開啟資料庫並完成 pragma 與 schema 遷移、檢查封存狀態。這一段不碰目前的 session。
  2. **交棒與啟動**：關閉目前的 session（C 段），啟動新的 session 的資源。

  準備失敗時目前的 session 不受影響。啟動失敗時，已啟動的資源以相反順序停止，結果是沒有開著的專案。
- **FR-006** 「半開」不存在：對外可見的開著專案（`project:active`、API 的 `projectOpen`、identity 檔、HUD 的 REC、托盤圖示）只在 session 進入 `recording` 或 `paused` 之後才指向它，且在 session 離開這兩個狀態的第一步就全部撤下。對外發布的資源排在清單最後，撤下時最先。
- **FR-007** 關閉時每個資源的 `stop` 都會執行，即使前面的丟錯；關閉報告列出失敗的資源，第一個錯誤在全部執行完後重新拋出。
- **FR-008** 開專案不寫 `config.yaml`。
- **FR-009** 應用程式層級的東西（外掛載入、tailer contribution sink、HUD 視窗建立、連結監看的偵測函式、工具偵測）不屬於 session。它們若需要專案資料，從目前的 session 讀，不在 session 啟動時被順手建立。
- **FR-00A** 每個專案一個查詢工作執行緒（Spec 074）是 session 的資源，必須實作本段的資源介面（plan「給 074 的資源介面」）。

#### B. 設定層級與單一設定檢視（US3、US4）

- **FR-010** 有效設定依序由四層解析：內建預設值 → 機器層（`machine.yaml` 與既有的機器層檔案）→ 專案層（`config.yaml`）→ session 覆寫（只存在記憶體，用於環境變數與測試，正式版目前沒有鍵）。每個鍵的有效值附帶來源（`default`／`machine`／`project`／`session`）。
- **FR-011** 每一個設定鍵在登記表中恰好有一個**歸屬範圍**（機器或專案），並宣告是否可在專案覆寫。專案範圍的鍵不出現在 `machine.yaml`。完整的歸屬表見 plan「設定歸屬表」，它涵蓋 `RedLogConfig`（`src/core/config.ts:30-263`）的每一個葉節點。
- **FR-012** 開著的 session 只有一個設定檢視；所有讀設定的程式碼都經由它。直接讀設定檔的位置只剩兩個：寫入者讀自己的檔案（ConfigStore），以及專案選擇器的唯讀摘要（`readProjectScope`，讀未開啟的專案）。
- **FR-013** 存檔先寫入該鍵的歸屬檔，再重新解析檢視，再由 #702 的套用計畫決定哪些資源要 `apply`；存檔回覆時這些 `apply` 都已執行。機器層的變更以同一條路徑套用到開著的 session（新的套用原因 `machine`）。存檔是設定變更唯一的出口，它在回覆前發出 Spec 074 的變更主題 `config`（074 FR-065），並在存檔回覆中帶回 074 的 `seq`。
- **FR-014** 登記表中的每一個鍵，若有任何資源在執行期讀它，就必須出現在該資源宣告的讀取清單；若沒有，必須列在「無即時效果」並寫明理由。`network.offline` 不再列在「無即時效果」，它的消費者是錨定、NTP、更新檢查與對外 IP 查詢四個資源。
- **FR-015** 設定檔解析失敗、型別不符（例如 `network: null`）或含有不合法的值時，開啟在準備階段被拒絕，回報檔案路徑與第一個錯誤的位置；檔案不被改寫。
- **FR-016** 新格式的 `config.yaml` 帶 `configVersion: 2`，只寫有明確值的鍵。沒有 `configVersion` 的是舊格式；讀舊格式時，歸屬於機器層的鍵：
  - 值等於舊版內建預設值（凍結為 `LEGACY_V1_DEFAULTS`）→ 視為未設定，繼承機器層；
  - 否則 → 視為專案覆寫；
  - 例外：`operator.*` 與 `scope.personalDomains` 一律視為專案覆寫。

  > **Superseded（2026-11-13，修訂 B7）**：例外只剩 `scope.personalDomains`。`operator.*` 不可覆寫（FR-01D）：專案檔中的值在任何格式下都不讀。

  新版寫入的檔另帶寫入者摘要；摘要與檔案內容不符的新格式檔（被較舊版本或手動改寫過）同樣依舊格式規則解讀。
- **FR-017** 舊格式的檔案只在操作者下一次存檔時轉為新格式；轉換前後每個鍵的有效值相同。升級本身不改寫任何專案的設定檔。
- **FR-018** 新建專案只寫專案範圍的鍵與建立卡片上操作者填的值；不複製機器層的值。
- **FR-019** 新格式的專案檔另寫 `operator` 的鏡像（標記為鏡像，新版不視為覆寫），使較舊的版本開啟時署名不變（降版相容）。

  > **Superseded（2026-11-13，修訂 B7）**：不寫鏡像。新格式的專案檔不含 `operator`；較舊版本開啟新格式專案時 operator 回到它的預設值，不在本規格的保證之內（plan D12）。
- **FR-01A** 設定頁的每個機器範圍欄位標示它目前的來源。被專案覆寫的欄位提供「改用此電腦的值」；這個動作寫一列設定變更紀錄。繼承機器值本身不寫紀錄（承接 Spec 051 FR-007、FR-008）。不新增頁面或分頁。
- **FR-01B** 個人流量規則的鍵改為 `personalTraffic`，歸屬機器層，預設為空（不含 localhost）。舊檔的 `scope.personalDomains` 讀為 `personalTraffic` 的專案覆寫。設定頁把它移出範圍分組。
  > **指標（2026-11-13 深夜，[Spec 077](../077-personal-content-and-delivery/spec.md) 修訂 S4、S6）**：077 以排除規則取代 `personalTraffic`：預設在專案 `config.yaml` 的 `delivery.rules[]`（`action: withhold`），操作者明確選擇時在 `machine.yaml` 的 `delivery.excludeRules[]`（077 Q7 已裁定，修訂 S10），沒有 `personal.followShellHistory`。077 FR-115 另要求 `config-store` 在開專案、套用存檔與建立匯出計畫前比對磁碟上的有效範圍（含 `scopeFile` 內容）與鏈上最後的範圍版本，不同就先寫一列 `config_changed{basis:'observed'}`；今天 `commit(…, {reason:'create'})` 不寫任何鏈上紀錄（`src/main/config-store.ts:84-88`）。
- **FR-01C** 必須在不重啟的情況下即時生效的機器層鍵（至少：operator、`network.*` 中屬於機器的鍵、`httpCapture.port`／`listenHost`），存檔後依 FR-013 套用到開著的 session。
- **FR-01D**（修訂 B7，2026-11-13）`operator.id`、`operator.name` 歸屬機器層且不可覆寫（登記表 `overridable: false`）。
  1. 有效的 operator 只來自機器層（未設定時為內建預設值）；session token 的 operator、071 的蓋章（071 FR-009）、API 的主要操作者、交接目錄的身分檔都讀它。
  2. 專案 `config.yaml` 中的 `operator`（任何格式、任何來源：既有的值、建立卡片、匯入的設定檔）不讀、不顯示、不是解析錯誤（FR-015 不因它拒絕開啟），忽略它也不寫設定變更紀錄；`ConfigStore` 的下一次存檔不再寫出它。
  3. `ConfigStore` 收到寫入專案層 operator 的 op 時拒絕並回報原因，不改寫任何檔案；建立專案與匯入設定檔時丟棄 `operator`。
  4. 設定頁的 operator 欄位標示來源為「此電腦」，沒有「只套用到此專案」與「改用此電腦的值」；欄位放在哪一頁見開放問題 Q6。
  5. operator 的變更在開著的 session 中即時生效（FR-01C）；切換專案不改變 operator。

#### machine.yaml

- **FR-020** 路徑為 RedLog 根目錄下的 `machine.yaml`（根目錄的解析由 071 的 `handoff-dir.ts` 擁有，見「與兄弟規格的介面」）。檔案權限 0600、目錄 0700；Windows 只授權給擁有者。
- **FR-021** 寫入是原子的：同目錄下以獨占方式建立暫存檔、寫入、fsync、rename 取代；POSIX 另 fsync 目錄。讀者永遠讀到完整的舊檔或完整的新檔。
- **FR-022** 每次寫入帶上讀到的修訂值；檔案的修訂值不同時回 `conflict`，不覆寫。
- **FR-023** 檔案帶 `schema: 1`。不認得的鍵在寫回時原樣保留。`schema` 大於本版時，本版只讀不寫（Edge Cases）。
- **FR-024** 解析失敗時機器層視為空，不覆寫檔案，設定頁顯示錯誤（Edge Cases）。

#### C. 專案生命週期（US6）

- **FR-030** Session 狀態為 `opening → recording ⇄ paused → closing → closed`，以及 `opening → failed`。每一個轉移由一個純函式決定，非法的轉移被拒絕並回報原因。暫停與恢復維持 app 層級的語意（Spec 071 FR-080 的狀態檔），並跨專案切換延續（今天的行為，`recording-state-marker.ts`）。
- **FR-031** 專案的磁碟狀態為「一般」或「已封存」。封存與取消封存只能在專案選擇器上、對未開啟的專案執行；封存以專案目錄內的標記檔與專案索引兩處記錄，兩者不一致時以標記檔為準。
- **FR-032** 已封存的專案以**唯讀 session** 開啟：資料庫以唯讀模式開啟；只啟動唯讀用途的資源（查詢、閱讀、匯出規劃）；不寫任何列、不寫設定、不做保留期清理、不排空交接目錄、不啟動任何擷取資源、不發布 identity 檔。畫面上有一處「唯讀」標示；擷取控制的每個來源以 075 的詞表呈現為「無法使用」，理由碼 `project-archived`（075 plan「理由與動作」）。
- **FR-033** 每一次一般 session 結束，都恰好寫一列 `project_closed`，`reason` 為封閉列舉：`closed`（操作者關閉）、`switched`（開另一個專案）、`reopened`（重新開同一個）、`app-quit`、`update-restart`、`open-failed`（`session_start` 已寫入後，後面的資源啟動失敗，FR-005）、`unclean`（下次開啟時寫，FR-034）。種類與欄位（`reason`、`last_alive_at`）由 Spec 072 FR-046 宣告；本規格提供值與時機。正常結束時，它是該 session 寫入的最後一列：所有會寫入的資源都已停止、資料庫關閉之前，經 071 的單一入口寫入。對應的 `session_start` 在任何擷取資源啟動之前寫入（順序見 plan「資源清單」）。
- **FR-034** Session 每 60 秒在專案目錄寫一次存活戳記（不是事件，原子寫入），正常結束時移除。開啟時若發現上一個 session 的戳記仍在、且沒有對應的 `project_closed`，在 `session_start` 之前寫一列 `project_closed{reason:"unclean", last_alive_at}`，其發生時間為戳記時間。
- **FR-035** 既有專案在 071 之前的時段沒有 `project_closed`；本規格不回填。「是否在錄：未知」的呈現由讀取端依「第一列 `project_closed` 之前」判定（呈現不在本規格）。
- **FR-036** 關閉時進行中的匯出被取消：暫存刪除，不產生交付物，回報 `project-closed`。離開確認（既有的分級確認）把進行中的匯出列為會被中止的項目之一。
- **FR-037** 關閉不影響已寫入交接目錄的項目；它們依 071 留到所屬專案再開時寫入。

#### D. 終端機與專案的綁定（US5）

- **FR-040** 外部終端機的綁定（pin）在終端機啟動時決定，之後不改。「開著的專案不是綁定的專案」（包括沒有專案開著）是一個**計算出的狀態**，不再寫成停止原因。
> **修訂（2026-11-13，B3）**：本段（FR-040–045）適用於每一種終端機來源：外部 shell、內建終端機的 pane hook、遠端 hook（Spec 071 FR-130）。綁定是擷取的邊界，不是來源的開關（Spec 076 FR-042）。

- **FR-041** 終端機的狀態檔（`~/.redlog/terminals/<session>.json`）的停止原因只剩 `operator` 與 `hook-removed`，兩者都是永久的，直到 `redlog start`。（2026-11-13，修訂 B4：加 `private`，同樣永久直到 `redlog start`，Spec 071 FR-087。）`project-switched` 不再寫入；讀到舊檔的 `project-switched` 時，視為沒有停止原因（暫停由計算得出）。
  > **指標（2026-11-13 深夜，DECISIONS §12）**：私人終端機取消，修訂 B4 的停止原因 `private` 不加入；封閉清單仍只有 `operator` 與 `hook-removed`（[Spec 077](../077-personal-content-and-delivery/spec.md) 修訂 S3）。
- **FR-042** 綁定狀態的轉移表只有一份，TS（`terminal-enrollment.ts`）與 relay 兩份實作由 agreement 測試保證一致。TS 一側屬本規格，relay 一側由 071 FR-085 實作。
- **FR-043** App 讀綁定狀態以呈現：開著的專案的擷取控制中，終端機列除了本專案的終端機外，另說明「N 個終端機綁定其他專案，已暫停」（只在 N > 0 時）。
- **FR-044** 內建終端機依 Spec 055 隨開著的專案輪替，不受本段影響。
- **FR-045** `capture_resumed` 的寫入與暫停期間的計數屬於 071（FR-085）；本規格只保證：綁定的專案以一般 session 重新開啟時，該終端機的計算狀態回到「記錄中」。唯讀 session 不算重新開啟。

#### E. 安裝帳本（US7）

- **FR-050** 機器層級一份帳本，記錄 RedLog 在自己目錄以外做的每一個改動，以及它發放的憑證檔（不論位置）。每一筆包括：類型、目標檔（路徑、realpath、是否經 symlink、shell、edition 或 host、WSL distro）、寫入的確切位元組與位置、換行風格、寫入前後的檔案摘要、擁有者（元件與版本）、時間、狀態。
- **FR-051** 類型為封閉列舉：`rc-block`、`profile-line`、`json-entry`、`file-copy`、`credential-file`、`instructed`（RedLog 只指示、由操作者自己執行的步驟，例如信任 CA）。
- **FR-052** 先記錄意圖、再寫檔、再標記完成；寫到一半當掉時，下一次驗證能判斷該筆是否已生效。
- **FR-053** 一個 shell 可以有多筆（例如 zsh 的 `$ZDOTDIR/.zshrc` 與 `~/.zshrc`、bash 的 `.bashrc` 與 `.bash_profile`）；寫入位置的決定不屬於帳本，帳本只記錄並還原。
- **FR-054** 驗證：app 啟動時與設定頁開啟時，對每一筆判斷 `present`、`missing`（RedLog 寫的內容不在了）或 `modified`（周圍或內容被改動）。驗證只讀檔，不寫。
- **FR-055** 還原：
  - 寫入後檔案未被改動（摘要相符）→ 還原為寫入前的位元組；
  - 否則 → 只移除與記錄完全相同的位元組序列；找不到 → 留下並在報告中說明；
  - 換行風格依原檔；
  - `instructed` 類不還原，報告附上操作者要執行的步驟。
- **FR-056** 移除報告為「已移除 N 項；留下 M 項：{檔案、位置、原因}」，原因為封閉列舉：`modified`、`unwritable`、`unreachable`（例如 WSL distro 不存在）、`instructed`。報告為空時才說「已完全移除」。
- **FR-057** 移除依帳本進行，不讀 manifest；已退役外掛的項目也能移除。解除安裝程式的 `--remove-hooks` 走同一條路。
- **FR-058** 第一次以新版啟動時補登：以既有的 `hookSpellings` 規則掃描已知位置（rc、PowerShell profile 各 edition 與 host、`~/.claude/settings.json`、WSL distro），把認得的 RedLog 寫入加入帳本並標記為補登；指向已退役外掛的項目標記為孤兒。認不得的不動。
- **FR-059** 安裝 shell hook 時，對本機每個有 adapter、且存在的 shell 都寫入（P4）。「已寫入」與「有載入」分開：後者只來自該 shell 的 `hello`（071），由來源狀態模型（075）合併呈現。
- **FR-05A** 帳本檔權限 0600，原子寫入（同 FR-021）；損毀時改名保存，下一次啟動補登重建。

#### F. 官方 AI adapter 與同意（US8）

> **Superseded（2026-11-13，修訂 B2）**：FR-061、FR-063、FR-064 的第一種撤回、FR-065 中「同意」的部分改為下列條文；FR-060、FR-062、FR-066、FR-067 的語意不變（FR-067 改讀機器層同意加專案層選擇）。原文保留於下方。
>
> - **FR-061′** 一個 agent 的 adapter 在這台機器上啟用（`extensions.<kind>.enabled`）時，以原生對話框取得一次同意，列出讀取根目錄與事件種類；同意紀錄存在 `machine.yaml` 的 `extensions.<kind>.consent`：`{at, method: "dialog"|"migration", roots, kinds, adapterDigest}`。
> - **FR-063′** 一個工作階段記錄到某專案，若且唯若：adapter 在機器層啟用且同意有效；該專案的 `agentTailer.sources.<kind>` 選擇涵蓋它（工作路徑或明確選取的工作階段）；且機器層的認領索引（Spec 076 FR-045）把它歸給該專案。專案層的選擇是逐專案的動作，不在機器層。
> - **FR-064′** 撤回只有一種：設定 ▸ 擴充功能的「撤回同意」（機器層，寫撤回時間）；開著的專案在撤回當下停止該來源並寫一列紀錄。專案層的「不再記錄」是清空該專案的選擇，不是撤回同意。
> - **FR-065′** 遷移：收據有效（`installed` 或 `update-available`）→ 機器層啟用，同意 `method: "migration"`，`adapterDigest` 取 app 本體的 adapter；各專案的 `agentTailer.sources.<kind>` 原樣保留為選擇；專案中 `enabled: false` 的選擇保留為空選擇（該專案不記錄任何工作階段）。`conflict`／`error`／收據損毀 → 機器層不啟用，來源顯示「未設定」並附理由。舊資料夾不刪、不執行。

- **FR-060** 官方 AI adapter 只從 app 本體的打包目錄載入；任何程式路徑都不再執行 `~/.redlog/plugins` 下的複製本。
- **FR-061** 「安裝」被移除。一個 agent 在一個專案記錄，若且唯若該專案有一筆有效的同意。同意記錄：agent 種類、時間、方式（`dialog`／`migration`）、同意當下 adapter 宣告的讀取根目錄與事件種類、adapter 的內容摘要。
- **FR-062** 同意在 adapter 更新後延續，只要宣告的讀取根目錄與事件種類沒有變；改變時該來源為「未設定」並附理由，要求重新同意。
- **FR-063** 同意在第一次於某專案啟用該來源時，以原生對話框取得；對話框列出讀取根目錄與事件種類。
- **FR-064** 撤回有兩種：在開著的專案撤回該專案的同意（來源列）；在外掛頁撤回此電腦上所有專案的同意（寫機器層的撤回時間，早於它的同意全部失效）。開著的專案在撤回當下停止該來源並寫一列紀錄。
- **FR-065** 遷移（新版第一次啟動，在任何專案開啟之前）：
  - 收據有效（`installed` 或 `update-available`）→ 記下該 agent 的舊 `installationId`；之後任何專案只要其設定中該 agent 的 `installationId` 相符且已啟用，就視為有效的同意（方式 `migration`），第一次開啟時補寫同意記錄；
  - `conflict`／`error`／收據損毀 → 不遷移，該來源顯示「未設定」並附理由；
  - 舊資料夾不刪、不執行；外掛頁說明它仍在並提供移除。
- **FR-066** 遷移不得造成擷取中斷：一個在升級前正在記錄的專案，升級後第一次開啟時，該 agent 在不需任何操作的情況下繼續記錄，且 tailer 的續讀位置不因載入路徑改變而重置。
- **FR-067** 071 FR-07A 的檢查讀本段的同意狀態。

#### G. 模組邊界與 gate

- **FR-090** 模組層級可變狀態的 gate：AST 掃描 `src/core/**`、`src/main/**` 的模組層 `let`、`var`，以及以 `new`、陣列字面值或工廠呼叫初始化的 `const`。每一個都必須列在允許清單並附分類與理由；清單中不再相符的項目也是失敗。分類為 `project-legacy` 的項目數只能下降，最後為 0。
- **FR-091** 直接讀設定檔的 gate：`loadConfig(` 在 FR-012 允許的兩處以外的出現數，基準 36，只能下降，最後為 0。
- **FR-092** 資源登記完整性：每一個 `ResourceId` 都有切換洩漏測試案例（US1）；資源清單的順序有快照。
- **FR-093** 設定登記完整性：`RedLogConfig` 的每一個葉節點都有登記；每一個登記的鍵都被某個資源讀取或列在「無即時效果」。
- **FR-094** 匯入邊界：只有 `src/core/session/**` 能建立資料庫連線與 session；`src/renderer/**` 不得匯入 session；session 模組不得匯入 `electron`、`src/main/**` 或 `src/renderer/**`；資源的 `start`／`stop` 只能由 session 呼叫。
- **FR-095** 官方 adapter 的動態 `require` 只允許路徑位於打包目錄之下（與 075 的 G2 共用同一個允許清單）。

### Key Entities

- **ProjectSession**：一個開著的專案的唯一擁有者；有 token、狀態、模式（一般／唯讀）、設定檢視、資料庫、資源清單。
- **Session token**：交給非同步工作的身分（generation + signal + 專案、engagement、operator）；今天的 `ProjectContext`。
- **ProjectResource**：session 擁有的一個有生命週期的東西，宣告它讀的設定鍵。
- **ConfigView**：一個 session 的有效設定，附每個鍵的來源。
- **設定登記表**：每個設定鍵的歸屬範圍、是否可覆寫、舊預設值、遷移例外。
- **機器設定檔**（`machine.yaml`）。
- **生命週期狀態**與 **`project_closed` 紀錄**。
- **終端機綁定狀態**：pin 加上計算出的「記錄中／綁定他處而暫停／停止」。
- **安裝帳本項目**與**移除報告**。
- **AI 同意**與**機器層撤回時間**。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** 專案範圍的模組層可變繫結：由第一次 gate 執行產生的基準（約 30 個模組、約 130 個繫結）降到 0，只剩 session 插槽。
- **SC-002** `loadConfig(` 的直接呼叫：36 → 0（FR-012 的兩處除外）。
- **SC-003** 切換洩漏測試對 100% 的登記資源通過；`reset*` 函式（`resetBodiesDirCache`、`resetCausesResolver`、`resetVisibilitySignalsCache`、`invalidateObservationCount`、`configureIngest({activeTarget:null})`）與 `dbGeneration()` 的懶重設全部刪除。
- **SC-004** `project-open-rollback` 的六種故障（四種既有加兩種新增）全部符合 US2，沒有任何一種留下半開。
- **SC-005** 打開 air-gap 後 5 分鐘內，網路替身記錄到的 NTP、錨定、更新、IP 查詢連線為 0；真機以 `lsof -i` 或 `nettop` 確認。
- **SC-006** 遷移等價 property test（至少 10,000 組）：每個鍵的有效值在升級前後相同。
- **SC-007** 結束方式 × `project_closed`：6 種結束方式各恰好一列，`reason` 正確。
- **SC-008** 安裝 → 移除的位元組相同率 100%（帳本為空），或移除報告逐項說明；macOS、Linux、Windows 各跑一次（Windows 含 PowerShell 5.1 與 7 的 profile）。
- **SC-009** 升級後第一次開啟一個正在記錄 Claude Code 的專案：停錄時間為 0，同意對話框出現次數為 0。
- **SC-010** 沒有新增頁面或路由；新增介面字串每個語系不超過 12 個 key，通過 `test/ui-copy.test.ts`。
- **SC-011** `src/main/index.ts` 中 `startProjectResources` 與 `stopProject` 兩個函式不再存在。

## Assumptions

- 單一使用者、單機，同一時刻一個 RedLog 實例（單一實例鎖）；開發版與安裝版可能先後執行，所以 `machine.yaml` 需要修訂值比對。
- **威脅模型**同 071：防誤歸屬、防半寫、防沒有執行程式碼能力的寫入者；不防能執行任意程式碼的同使用者程序。帳本與同意記錄都可被同使用者改寫，它們防的是 RedLog 自己遺忘或錯置，不是對抗。
- 舊格式設定檔中，機器範圍的鍵等於舊預設值者，視為操作者未選擇（FR-016）。這是無法從檔案分辨的情況下，唯一不需要詢問操作者、又不改變任何專案升級當下有效值的規則。
- 「hook 寫入位置」的決定（`ZDOTDIR`、bash login 檔、PowerShell `CurrentUserAllHosts`）由另一個進行中的變更處理；帳本只要求能容納每個 shell 多個檔。
- better-sqlite3 能在 WAL 模式的檔案上以唯讀開啟；若 `-shm` 不可寫時失敗，唯讀 session 退回「以讀寫開啟但不寫入」並由 gate 保證不寫（UNCONFIRMED，見 plan）。
- 依賴：071（單一入口、憑證、`hello`、FR-080 暫停狀態檔、FR-085、根目錄解析）；072（`project_closed` 種類）；074（查詢工作執行緒作為資源）；075（狀態詞表、官方 AI 描述的讀取範圍宣告）。「hook 曾經載入或成功過」不另建檔：075 的狀態函式直接合成 071 的 `hello` 與第一次接受（071 FR-056、FR-112）、本規格的帳本事實與既有的 `~/.redlog/tool-detection/` 檔（075 D10）。跨規格的實作順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」。

## 不在範圍

- 事件的身分蓋章與單一入口、憑證、交接目錄、`capture_resumed` 的產生與計數（071）。
- 事件種類登記與 `project_closed` 的欄位定義（072）。
- 查詢工作執行緒的內容、投影、查詢契約（074）；本規格只定義它作為資源必須實作的介面。
- 來源狀態詞表、manifest v2、「已寫入」與「有載入」的合成（075）。
- Hook 寫入位置的決定與 shell 初始化不輸出（另一個進行中的變更與 071）。
- 匯出對話框中「排除 N 筆」個人流量的呈現（匯出規格）。
- 讀取面停止以 engagement 過濾、舊 `'default'` 列的呈現（07-F2 讀取面）。
- 多專案同時開啟、專案管理功能（標籤、資料夾、搜尋以外的整理）。
- 改寫、回填或重新雜湊任何既有列；為舊專案補寫 `project_closed`。

## 與現有文件、程式註解、已驗證規格與兄弟規格的矛盾

| 位置 | 現在的說法 | 本規格 | 處置 |
|---|---|---|---|
| `docs/design/DESIGN-project-runtime.md` §2 | `ProjectRuntime`「Not a resource registry」；`stopProject` 的明確清單維持；services 逐一掛到 `onStop` | Session 擁有有序資源清單；`stopProject` 被清單取代 | T090 改寫該文件 §2–§4 |
| Spec 052 FR-010（Draft）；`terminal-enrollment.ts:17-20,79-83`；`shell-common.sh:312-325` | 切換後停止，且「cannot be talked back into recording」 | 暫停，回到綁定專案時恢復 | 與 071 D11／T075 同一變更；FR-010 改寫（T061） |
| Spec 051（Draft）FR-002、Background 表 | 兩個 scope 分頁；operator 身分是機器層 `active-identity.json` | 不新增分頁，欄位標示來源；`active-identity.json` 是交接鏡像，不是設定 | 051 的 FR-007／FR-008 由本規格實作；FR-002 的分頁不做（P10） |
| Spec 066 FR-003、Spec 067 全篇（Draft） | 外掛頁是官方整合的安裝、更新、解除安裝入口；收據、衝突恢復 | 沒有安裝；同意以專案為單位 | 兩份規格的相關 FR 在 T081 標為被取代 |
| `e2e/project-open-rollback.spec.ts:67-79` | `db-open`、`db-pragma`、`source-config` 故障後 `active` 為 null | 準備階段的故障後 A 仍開著 | 該 spec 是本變更的一部分（T020） |
| `src/core/config.ts:69-73,289` | 個人流量預設含 localhost，屬於 scope | `personalTraffic`，機器層，預設空 | T046 |
| `src/core/config-apply-plan.ts:194-201` `NO_LIVE_EFFECT` | `browser`、`retention` 等無即時效果 | `network.offline` 必須有即時效果；清單逐項重審 | T043 |
| `src/core/capture-health.ts:207-211` | DB 錯誤計數以 app session 為範圍 | 以專案 session 為範圍 | T031f |
| 07-architecture「刻意的設計」 | 終端機切換後永久停止是 FR-010 | 擁有者已改決定 | 記錄即可 |
| `src/core/config.ts:36-39,250-253,363`；`src/renderer/src/components/settings/ProjectSettings.tsx:27-53`；`src/main/index.ts:779,809,1018`；`src/main/operator-change.ts`（修訂 B7） | operator 存在每個專案的 `config.yaml`，在專案設定頁編輯，建立卡片可帶入（`mergeInitialConfig`），開專案時從專案設定讀出蓋章 | operator 只在機器層，專案檔中的值不讀（FR-01D） | T04A、T04B |
| 本規格 FR-016 例外、FR-019、plan D5 例外、D6、T047 的鏡像、T100（修訂 B7） | 既有專案的 operator 一律保留為覆寫；新格式寫 operator 鏡像供舊版讀 | 取消（FR-01D、plan D12） | 原文以 Superseded 標示保留 |
| 08-plugin-system F2「機器層同意收據」 | 同意在機器層，第一次在這台機器上啟用時取得 | 同意在專案層（擁有者決定 P5、071 O9） | 記錄即可（開放問題 Q2 只在擁有者要改變 P5 時才需要答） |
| 071 plan D11、T075 | relay 的 `apply_terminal_action` 改為暫停 | relay 一側屬 071，TS 一側與狀態檔 schema 屬本規格 | 兩份規格共同的 agreement 測試（T060） |
| Constitution「domain contract 變更須有明確任務」 | glossary 的 Recording 只有 recording／paused | 新增 session 狀態、封存、唯讀 | T091 更新 glossary |

## 開放問題（需要擁有者）

> **2026-11-12 擁有者答覆**：以下各項均照「建議」欄採納（封存的唯讀專案可匯出，只允許寫入匯出的封存與摘要列；AI 同意為每個專案一次；暫停跨專案切換延續；新專案可覆寫操作者但介面不提供；`network.whitelist` 屬於專案）。這是決定，尚未實作。
> **Superseded（2026-11-13，修訂 B7）**：Q4 的答覆改為「不可以」：operator 只在機器層（DECISIONS §9）；條文見 FR-01D。其餘答覆不變。

起草者的建議附在每一題；本規格依建議撰寫，但不視為已決定。理由與替代方案在 plan 的相關決策。

| # | 問題 | 建議 |
|---|---|---|
| Q1 | 封存（唯讀）的專案能不能匯出？Bundle 第 4 版要求鏈上有封存事件（ROOT-CAUSE-REVIEW §4），唯讀 session 寫不進去 | 允許，且唯讀 session 只開放匯出的封存與摘要兩種列經 071 入口寫入；其餘一律拒絕。替代：要求先取消封存再匯出 **已裁定（2026-11-13，DECISIONS §9）**：允許，唯讀狀態只開放封存與摘要兩種列 |
| Q2 | AI 同意的原生對話框：每個專案第一次啟用都問，還是每台機器只問一次（08 原案）（**2026-11-13 已由修訂 B2 回答：每台機器一次；工作階段的選擇逐專案**） | 每個專案問。注意：P5 與 071 O9 已寫明「第一次在某專案啟用時」取得同意，本題只在擁有者要改變那個決定時才需要回答；075 已依 P5 改寫 |
| Q3 | 暫停跨專案切換延續（今天），還是每個專案各自記住 | 延續；改成各自記住會讓「切到 B 就開始錄」成為可能的意外 **已裁定（2026-11-13，DECISIONS §9）**：延續 |
| Q4 | 新專案可不可以覆寫 operator | 可以，但設定頁不主動提供；只在既有覆寫或操作者明確選「只套用到此專案」時出現 **已裁定（2026-11-13，DECISIONS §9）**：**不可以**；operator 只在機器層。與建議不同，設定歸屬表與相關條文待修訂 |
| Q5 | `network.whitelist`（攻擊用出口）歸屬專案還是機器 | 專案（plan 設定歸屬表的寫法），因為 VPS 出口通常每個任務不同 **已裁定（2026-11-13，DECISIONS §9）**：專案 |

**2026-11-13 新增**（修訂 B7 的後果；裁定本身沒有回答。答覆前依「建議」欄撰寫，但不視為已決定）：

| # | 問題 | 建議 |
|---|---|---|
| Q6（2026-11-13 新增） | operator 只在機器層之後，設定頁的 operator 欄位放在哪裡？今天它在專案設定頁（`ProjectSettings.tsx:47-53`，與 engagement 同一頁） | 移到〈設定 ▸ 一般〉，與全 app 的顯示時區等機器層偏好同頁；專案頁只留 engagement。理由：留在專案頁的欄位會被讀成「這個專案的 operator」，正是被裁定不存在的東西。不新增頁面或分組（P10） **已裁定（2026-11-13 晚間，擁有者）**：移到〈設定 ▸ 一般〉，與建議相同 |
| Q7（2026-11-13 新增） | 升級後第一次啟動、`machine.yaml` 還沒有 operator 時，機器層的 operator 是內建預設值（`operator-1`／`Operator`），還是從某個既有專案的 `config.yaml` 取一次？ | 內建預設值，不取。取一次需要選「哪一個專案」（各專案可能不同），而且是只為舊格式存在的遷移；產品尚未發布，代價是操作者在設定頁填一次。後果寫明：在操作者填之前開啟既有專案，新列的 `operator_id` 是 `operator-1`，與該專案先前的列不同；兩者都照常驗證（plan D12） **已裁定（2026-11-13 晚間，擁有者）**：內建預設值，不從專案取，與建議相同 |

## Domain References

- `.specify/memory/constitution.md` I、II、III、VI、VIII、IX。
- `docs/domain/glossary.md`：Recording、Capture Session、Engagement；本規格新增的術語在 T091 寫入。
- `docs/design/DESIGN-project-runtime.md`；`DESIGN-capture-trust.md` §3（暫停）。
- Spec 002（FR-001、FR-006）、036（FR-003）、051、052（FR-010、FR-016、FR-022）、055、066、067、071。

## 與兄弟規格的介面

| 規格 | 本規格需要 | 本規格提供 |
|---|---|---|
| 071 | 單一入口寫 `project_closed` 與 `session_start`（in-process、`system`，071 FR-092）；`handoff-dir.ts` 的根目錄解析；FR-080 暫停狀態檔；FR-085 的 relay 一側與 `capture_resumed`；憑證檔寫入時呼叫帳本（071 FR-072、T041） | Session token 與綁定的 engagement（FR-007 的蓋章來源）；機器層的目前 operator（FR-009）；AI 同意狀態（071 FR-07A）；終端機綁定狀態轉移表（TS）與共用的 `test/terminal-enrollment-agreement.test.ts`；`machine.yaml` 讀取；安裝帳本 |
| 072 | 宣告 `project_closed` 種類與欄位（072 FR-046：`reason`、`last_alive_at`） | 發出時機與 reason 值（FR-033）；`CloseReason` 型別（072 的測試比對值域） |
| 074 | 查詢工作執行緒實作 `ProjectResource`（plan「給 074 的資源介面」，074 照抄這份簽名）；074 的變更主題與 `seq` | Session 擁有它的生命週期、資料庫路徑、唯讀模式、token；關閉時先停它再關資料庫；設定存檔發出 `config` 主題（FR-013） |
| 075 | 8 個來源狀態與理由碼（本規格用到的四個：`project-archived`、`bound-elsewhere`、`consent-scope-changed`、`hook-file-missing`，都在 075 的封閉清單中）；官方 adapter 描述宣告的讀取根目錄與事件種類（075 `SourceDescriptor.adapter`） | 帳本事實（每個 shell 的 `present`／`missing`／`modified`，對實際讀的檔）；`residue(owner)`、`revert(owner)`；同意事實（`consentState`）；綁定事實；session 模式（唯讀）。「已寫入」與「`hello`」的合成在 075 的狀態函式，不另建檔 |
