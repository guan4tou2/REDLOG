# Feature Specification: 來源描述、單一狀態模型與外掛 manifest v2

**Feature Branch**: `spec/072-075-contracts`
**Created**: 2026-11-12
**Status**: Draft
**Input**: [根因審查與落地計畫](../../docs/records/2026-11-12/ROOT-CAUSE-REVIEW.md) 階段 5「單一的來源狀態模型與詞表」與 §4 的十項外掛／設定決定；根因報告 [04 來源生命週期](../../docs/records/2026-11-12/root-cause/04-source-lifecycle.md)（F1–F6、§3–§6）、[08 外掛系統](../../docs/records/2026-11-12/root-cause/08-plugin-system.md)（F1–F8、§3、§6）、[09 設定時的選擇與多重性](../../docs/records/2026-11-12/root-cause/09-setup-choices-and-multiplicity.md)（F1–F5、F9）、[05 信任邊界](../../docs/records/2026-11-12/root-cause/05-trust-boundaries.md)（F5、F6 的外掛部分）；同類系統研究 [PRIOR-ART-C](../../docs/research/PRIOR-ART-C-recorders-and-status.md) §3.3、§5、§6.3 與 [PRIOR-ART-SUMMARY](../../docs/research/PRIOR-ART-SUMMARY.md)「階段 5」；[DESIGN-plugin-kernel](../../docs/design/DESIGN-plugin-kernel.md)；[plugin-development.md](../../docs/plugin-development.md)；Spec 065、066、067、070（皆 Draft）。

> 本檔只寫可觀察的行為與對外契約。模組邊界、介面草圖、決策表的推導、遷移順序與 gate 的實作方式在 [plan.md](plan.md)。

## 決策與範圍

### 已決議（擁有者，2026-11-12；本規格不重開）

| # | 決定 | 落點 |
|---|---|---|
| P1 | 來源固定八個狀態：無法確認、失敗、已關閉、無法使用、未設定、未啟動、待命、記錄中；整體固定四個：需要處理、無可用來源、等待第一筆事件、記錄中；完整性另成一項 | B、G |
| P2 | AI session 不加常駐設定入口；偵測到有活動卻未記錄時才列入例外（#703） | B、C |
| P3 | 第三方 Source 只允許手動設定（`manual`）；RedLog 不把第三方腳本寫進 shell rc 或其他工具的設定。內建 hook 不受影響 | D、E |
| P4 | 官方 AI adapter 從 app 本體執行；第一次在某專案啟用時以原生對話框取得同意；外掛頁只保留撤回同意（Spec 071 O9：同意以專案為單位） | A、E |
| P5 | 外掛宣告、但不在核心表上的事件種類預設寫入 logged 層；heartbeat 不是事件（Spec 071 O7、O8） | A、D |
| P6 | 刪除 `state.json` 對 bundled pack 與 starter-pack 的機器層停用；既有的停用旗標轉成一次性通知 | D |
| P7 | 移除 `signature`／`publisher`；信任只看本機的內容雜湊 | D |
| P8 | Hook 裝到本機所有有 adapter 的 shell；以 hook 啟動時送出的 hello 作為「有載入」的證據 | A、B |
| P9 | Shell 初始化期間不輸出；「已載入」由 `redlog status` 與 app 的 shell 列呈現 | B、C |
| P10 | 個人流量規則與機器、個人層級的事實放在機器層級設定檔（`~/.redlog/machine.yaml`，Spec 073 擁有） | 依賴 |
| P11 | 外掛只有 Source 與 Processor；沒有 UI 外掛、沒有外掛 host，第三方程式碼不在 RedLog 的行程內執行；內建來源不改成外掛；不新增頁面；單欄；文案最少 | 全部 |

> **Superseded（2026-11-13，修訂 C1、C3）**：P11 改為：類型為 Source、Processor、Exporter；有獨立的擴充功能主機行程，第三方程式碼仍不在 RedLog 的 main 或 renderer 行程內執行；內建的選用來源成為內建擴充功能（Spec 076 FR-020 的兩層清單）；介面擴充依 Spec 076 J 段。P4 的「第一次在某專案啟用時取得同意」改為機器層一次，工作階段的選擇仍逐專案（Spec 073 修訂 B2）。其餘不變。

### 修訂（2026-11-13）

依 [2026-11-13 的決定](../../docs/records/2026-11-13/DECISIONS.md) §2、§3、§5 與 Spec 076。被取代的原文保留在原處，以「> **Superseded（2026-11-13）**」標示。

| # | 改了什麼 | 為什麼 | 落點 |
|---|---|---|---|
| C1 | **外掛（擴充功能）類型為 Source、Processor、Exporter**；Q5 的答覆反轉。內建的選用來源成為內建擴充功能（只限搬了不影響基本功能的，Spec 076 FR-020） | DECISIONS §3 | P11、決定 7、FR-051、FR-060、FR-061、Q5 的標示 |
| C2 | **內建終端機預設關閉**（「已關閉」），不是「待命」；擷取瀏覽器、受管代理同 | DECISIONS §2、§5 #6 | US1 的標示 |
| C3 | **「本專案啟用」三值事實改為機器層啟用加專案層綁定**：`enabledOnMachine`（`on`／`off`，預設取描述）與 `boundToProject`（終端機：有終端機綁定本專案；`binding: explicit` 的來源（AI）：本專案有選擇；`binding: none`：不適用）。AI 是例外：工作階段的選擇仍逐專案，沒有選擇時為「未設定」並帶理由 | DECISIONS §2；Spec 076 R1 | 決定 2、FR-010、FR-012、FR-016、FR-021、FR-074、FR-076、P4 的標示 |
| C4 | **manifest 的擁有者改為 Spec 076**（擴充功能 manifest 第 1 版取代本規格的 v2）。本規格只保留狀態需要的描述欄位：FR-001 的 `SourceDescriptor` 由 076 的 `toDescriptor` 從 manifest 產生（內建的基本來源仍由核心描述表提供） | Spec 076 決定 6 | D 段（FR-050–063）、FR-002、FR-003、F 段（FR-080–083）的標示 |
| C5 | **未知從不顯示為安全**：新 FR-025 與 gate；狀態 payload 加出口（Spec 071 FR-122） | DECISIONS §5「停止做的事」；14 號 E.1 | FR-025、FR-031 |
| C6 | 理由碼增加：`api-too-new`、`api-retired`、`experimental-changed`、`uses-deprecated`、`builtin-mismatch`、`host-unavailable`、`no-session-selected`、`view-imitates-status`（Spec 076 契約 §4.2、§5.5）；`bound-elsewhere` 也用於「工作階段已被另一個專案認領」。FR-090 的上限由 41 改為 49 | Spec 076 | FR-090 |
| C7 | 開放問題 Q6（新）：選用來源是否另用「已啟用」一詞 | DECISIONS §7 | 開放問題 |

### 本規格自行決定的（理由與被否決的替代方案見 plan.md）

1. 來源狀態只在核心以一個純函式算出，main 把結果（不是事實袋）送給每個畫面、CLI 與 API。renderer 不再判斷任何來源的狀態（plan D1）。
2. 「本專案啟用」是三值事實：`on`／`off`／`unset`。`off` 對應「已關閉」，`unset` 對應「未設定」，因此「從沒打開過」與「刻意關掉」不再共用一個字（plan D2）。

   > **Superseded（2026-11-13，修訂 C3）**：改為兩個事實：機器層 `enabledOnMachine`（`on`／`off`；`off` 對應「已關閉」）與專案層 `boundToProject`。`binding: explicit` 的來源（AI）在本專案沒有選擇時為「未設定」，理由 `no-session-selected`；終端機來源沒有綁定本專案的終端機時為「待命」（能記、尚未接受）。
3. 「需要處理」只由兩種來源狀態構成：與本專案相關的「失敗」，以及操作者明確啟用卻「無法使用」。已關閉、未設定、未啟動、待命、無法確認都不會讓整體變成需要處理；每個需要處理的來源各一則 issue（plan D3）。
4. 啟動寬限期：一個來源在其最近一次「開始」（app 啟動、專案開啟、本專案啟用、行程啟動，取最晚）之後 30 秒內（以心跳判定存活的來源為 60 秒），暫時性的失敗事實不判為「失敗」，而是「未啟動」並帶理由「啟動中」（plan D4）。
5. 每個有 adapter 的 shell 是一個獨立的來源；內建終端機是另一個。儀表板以一列「指令」概括它們，只有需要處理、或在本專案送過 hello 的 shell 才另外列出（plan D5）。
6. HTTP 的四個事實依「觀察到的 client」記錄，client 由已保存的 flow 推出（UA 族群，加上可得時的行程名稱），不由驗證流程推出。「已驗證」只是理由，從不改變狀態或顏色（plan D6）。
7. Manifest v2 每個資料夾只有一種 kind；`files` 列出每一個檔案與其 sha256；每個 schema 欄位都必須登記一個讀它的程式位置，否則 gate 失敗；**不建 Exporter**（plan D7）。

   > **Superseded（2026-11-13，修訂 C1、C4）**：manifest 由 Spec 076 的擴充功能 manifest 第 1 版取代（`files` 完整、每欄位有讀者的規則保留在那裡）；Exporter 建立（076 H 段，experimental）。
8. 寫入路徑上的 Processor 共用每個事件一個總時限；其推導在列上記錄規則集的外掛 id 與內容雜湊（Spec 071 已接受，`_ingest.rules`／`rules_partial`，071 FR-005、FR-006）；被停掉的規則保留到該外掛的內容雜湊改變為止（plan D8）。
9. v1 manifest 照讀並轉成內部 v2 形狀；v1 的雜湊算法保留給 v1 manifest，既有核准不失效；v1 使用者 Source 的提權步驟在改寫成 v2 之前不顯示（plan D9）。
10. 「曾經成功過」不另建機器層的 proof 檔：專案層取 Spec 071 寫入的「第一次接受」里程碑；機器層的 shell 證據沿用既有的 `~/.redlog/tool-detection/shell:*.json`（plan D10）。
11. 外掛與官方整合的同意畫面一律由 main 以原生對話框顯示，內容由 main 從自己載入的 manifest 產生；IPC 帶預期的雜湊，main 在顯示前與確認後各驗一次（05-F5、08 §3b-3；plan D11）。
12. 「仍在回報存活、卻有一段時間沒送事件」不再判為失敗（今天的 `producerStalled`，`capture-health.ts:818-830`），改為待命或記錄中的理由「未送出事件」：安靜不等於故障；只有「曾存活、後來停止回報」才是失敗（plan D13）。

### 前提更正（2026-11-12 於 `origin/main@56c9fe6c` 開檔確認）

- 審查引用的行號已位移。整體判斷今天在 `capture-health.ts:844-858`（審查寫 :795-809），來源狀態在 `:415-436`。
- 「整體是否有問題」不是 6 份而是 **7 份**：審查漏了首次使用的 `coreCaptureReady`（`coreCapture.ts:26-28`，由 `FirstRunView.tsx:184` 使用）。完整清單見 plan「要取代的判斷」。
- `DashboardIssues.tsx` 與 `lib/issues.ts` 不是判斷：前者渲染 issue store（`DashboardIssues.tsx:11-28` 的註解自述），後者是 store 本身（`issues.ts:58-103`）。判斷發生在 raise 的那一方（`StatusBar.tsx:145-162`）。
- bundled manifest 是 7 份（`plugins/*`），加上 `optional-plugins/*` 的 2 份，不是審查所說的 8 份。
- `PluginStatus 'hash-changed'` 在 main 上從不產生（`loader.ts:38-46`）。進行中的另一個分支（工作樹 `work/1112-plugsafe`，尚未合併）讓它產生，加入「顯示步驟前重驗內容」（`contentStillApproved`）、禁止使用者外掛占用 bundled id、使用者外掛的步驟若帶指令就要核准。本規格建立在這些行為之上，但不假設它已合併（tasks T002）。
- `eventTypes` 的 `label` 與 `lane` 今天有讀者：`Timeline.tsx:545-560` 讀 `plugins.eventTypes()`。08 說「lane 刪除」不能直接做；本規格把它們移給 Spec 072 的種類登記（FR-055）。
- `createOfficialAgentPluginManager` 今天在 6 處各自建立：`capture-health.ts:683`、`main/ipc/plugins.ts:30,64`、`main/index.ts:584,1563`、`main/services/agent-tailer.ts:51`。

### 與 Draft 規格 065、066、067、070 的關係

| 規格 | 本規格取代 | 保留 | 不處理（留給該規格或他人） |
|---|---|---|---|
| 065 外掛列表與詳情 | FR-021（五個維度分開呈現）改為兩個機器層的軸「信任」「生效」，專案與健康改為連到來源列並顯示八個字之一；FR-040／041 的擷取相關維度改讀來源狀態 | FR-001–003、FR-010–012、FR-020、FR-022、FR-023、FR-030、FR-031 | 列表的版面與搜尋實作 |
| 066 官方整合入口 | FR-001–005（外掛頁作為官方整合的安裝／更新／移除入口；`update-available`／`conflict` 計入需處理）；FR-010、FR-011（AgentsPanel 跳去外掛頁安裝）；FR-030–033（健康軸）由八個字取代 | FR-012（AgentsPanel 既有的 session 排除、scope 變更提示等行為）；FR-020–022（雙向定位，只檢視不寫入） | — |
| 067 官方整合安裝邊界 | US8、US9、FR-010–013（收據損毀、移開、重新採用）：它們只因為複製本存在而存在，P4 之後不再有複製本 | FR-001–003（目錄讀取的失敗隔離，改為讀 app 本體內的目錄時仍適用）；FR-020–022 | 既有安裝的收據轉成同意紀錄（Spec 073） |
| 070 擷取來源與外部工具 | FR-001–004（`CaptureSourceStatus`）由本規格的 `SourceStatus` 取代，「紅色只用於真正的錯誤」保留為 FR-024；FR-006（HTTP 測試順序）由 FR-030 的四個事實取代；FR-013、FR-014 的狀態部分；US2 的「閒置」與已決定的「沒有閒置」衝突，不採用 | FR-005（重連成功不等於缺口補齊） | FR-007–009（Spec 071／072）；FR-010、011（Burp：日後以 manifest v2 的 Source 外掛實作）；FR-012、FR-015–020 |

## User Scenarios & Testing *(mandatory)*

| 故事 | 優先級 | 摘要 |
|---|---|---|
| US1 新專案與每次啟動都不變黃 | P1 | 整體只取決於本專案能用的來源；啟動寬限期內不判失敗 |
| US2 同一個來源，每個畫面說同一個字 | P1 | 狀態只算一次；畫面只讀不算，gate 擋住自己算的元件 |
| US3 真的記不到的時候一定說出來 | P1 | 缺前置、hook 被拆、送不進來、外掛停用後仍在送，都有狀態與理由 |
| US4 HTTPS 分成四個獨立事實，依 client 記錄 | P1 | 「proxy 在聽」不再被當成「你的 client 有經過」 |
| US5 一份 manifest，每個欄位都有人讀 | P2 | v2 schema、消費者登記、內容雜湊；v1 不中斷擷取 |
| US6 「我要記這個可選來源」只有一個地方、步驟更少 | P2 | 一台狀態機；機器動作在外掛頁，專案動作在來源列 |
| US7 外掛作者在本機就能驗證 | P3 | `plugin check`、一致性工具組、版本相容 |

### User Story 1 — 新專案與每次啟動都不變黃（P1）

操作者在一台從沒裝過 hook 的機器上建立新專案：儀表板寫「等待第一筆事件」，狀態列沒有注意數、沒有 toast，唯一的動作是開啟終端機。在一台已經裝好 hook、驗證過 HTTPS 的機器上重開 app：整體在任何時刻都不是黃色。從一個有事件的專案切到新專案：不跳「紀錄可能不完整」。

**Why this priority**：今天新專案判 `dark`（`capture-health.ts:849`，`test/capture-health.test.ts:65` 釘住），同一個空專案在裝過 hook 的機器上卻是 `healthy`；每次啟動因 proxy 自動啟動而 HTTPS 未重新驗證，標題變成 amber「部分來源待確認」（`CaptureHealth.tsx:464`）。這教操作者忽略唯一不能被忽略的指示（04-F2、F3）。

**Independent Test**：決策表測試（plan「決策表」每一列一個案例），加上兩個機器情境 × 三個專案情境的矩陣：{無 hook、hook 已裝} × {新專案、有事件的專案、缺 python3 的新專案}。斷言整體為 {waiting, waiting, recording, recording, none, none}，與機器上其他專案無關。再加一個時間注入測試：啟動後 0–30 秒 proxy 為 `starting`，整體從不是 `attention`。

> **Superseded（2026-11-13，修訂 C2）**：情境 1 的「內建終端機為『待命』，整體為『等待第一筆事件』」改為「內建終端機為『已關閉』；沒有任何 shell hook 時整體為『無可用來源』，活動紀錄頂端的清單展開成首次使用清單（DECISIONS §4），唯一的動作是安裝 hook」。情境 3 的「內建終端機為『無法使用』」改為：內建終端機為「已關閉」（優先序 3 先於 4）；缺 python3 的理由出現在各 POSIX shell 的列；整體仍為「無可用來源」。獨立測試的矩陣期望值依此改寫。其餘情境不變。

**Acceptance Scenarios**：

1. **Given** macOS、有 python3、沒有任何 hook，**When** 建立新專案，**Then** 內建終端機為「待命」，整體為「等待第一筆事件」，issue store 沒有 `source:*` 項目，沒有 toast。
2. **Given** 同一台機器、zsh hook 已裝且在別的專案送過 hello，**When** 建立新專案，**Then** zsh 列為「待命」並帶理由「已在本機看過」，整體仍為「等待第一筆事件」。
3. **Given** 缺 python3、也沒有其他能記的來源，**When** 開專案，**Then** 整體為「無可用來源」，內建終端機為「無法使用」並帶理由「找不到 python3」與動作「準備」；不 toast。
4. **Given** 受管 proxy 自動啟動、上次已驗證 HTTPS，**When** 重開 app，**Then** HTTP 列在寬限期內為「未啟動・啟動中」，之後為「待命」或「記錄中」，理由帶「上次已驗證」；整體沒有任何一刻是需要處理。
5. **Given** 專案 A 為「記錄中」，**When** 切到新專案 B，**Then** 沒有 toast；B 的整體為「等待第一筆事件」。

### User Story 2 — 同一個來源，每個畫面說同一個字（P1）

對任何來源，儀表板卡、狀態列、設定的來源列、首次使用、外掛詳情、HUD、CLI 與 `/api/status` 顯示的狀態字相同，理由相同，至多一個動作。

**Why this priority**：同一個問題今天有 7 份「整體是否有問題」、13 份「這個來源的狀態」、2 組「來源在哪裡設定」（共 8 處）各自計算（plan「要取代的判斷」）。結果是「未安裝」一字兩義、「沒驗證」有 7 種說法、首次使用說已收到指令而儀表板說還沒納入（04-F1、F4）。

**Independent Test**：(a) 對每個 surface 的 render 測試，用同一份 payload，斷言每個來源的 `data-source-state` 屬性等於 payload 中的狀態；(b) 靜態 gate（FR-042）：在 renderer 中出現自行判斷狀態的形狀時失敗；(c) CLI 測試斷言印出的字等於英文詞表。

**Acceptance Scenarios**：

1. **Given** AI 來源的 workdir 是相對路徑而勾選了「在此專案記錄」（04-U4），**Then** 來源列、外掛詳情與儀表板都說「未設定」，理由「工作目錄無效」，沒有任何地方說「已為此專案啟用」。
2. **Given** 一個失敗的來源，**When** 點狀態列的 issue，**Then** 前往該來源描述所宣告的唯一位置（descriptor 的 owner），不是儀表板自己。
3. **Given** 兩個失敗的來源，**Then** 注意數為 2，兩則 issue 各自連到各自的 owner。
4. **Given** `redlog-cli status`，**Then** 每個來源印出英文狀態字（例如 `Ready`、`Recording`），整體印出四個英文字之一；不再出現 `wired but idle`。

### User Story 3 — 真的記不到的時候一定說出來（P1）

**Why this priority**：產品規則是「沒有事件不得看起來像什麼都沒發生」。今天：hook 被 dotfile 工具拆掉或 `PROMPT_COMMAND` 被覆寫後完全靜默（09-F4）；內建終端機缺 python3 仍顯示「可用」（04-F2 #5）；`zsh` 寫進 `~/.zshrc` 而 shell 讀 `$ZDOTDIR/.zshrc` 時顯示已安裝（09-F1）；擷取瀏覽器的 proxy 指向別處時 HTTP 列仍是「待命」（09-F9）；外掛停用後仍在送的事件被照收（08-F5）。

**Independent Test**：每一種情境注入對應的事實，斷言狀態、理由與是否進入需要處理（plan 決策表的 F、N、S 列）。

**Acceptance Scenarios**：

1. **Given** zsh hook 執行期自我檢查回報被移除（Spec 071 的存活通道帶 `detached`），**Then** zsh 列為「失敗」，理由「hook 已被移除」，整體為需要處理，動作前往指令與終端設定。
2. **Given** 安裝帳本記錄的檔案存在 hook 行，但該 shell 實際讀的檔案（`$ZDOTDIR/.zshrc`）沒有，**Then** zsh 為「未設定」，理由指出實際讀的檔案；不是「已安裝」。
3. **Given** POSIX 缺 python3，**Then** 內建終端機為「無法使用」；pane 的徽章與卡片說同一個字。
4. **Given** 外掛 Source 在機器層被停用，之後仍有它的項目送達，**Then** 接收端拒收（Spec 071 FR-076）；該列為「失敗」，理由「已停用但仍在送 N 筆」，進入需要處理。
5. **Given** 一個心跳來源曾在本 session 存活，之後超過窗口沒有心跳，**Then** 「失敗」，理由「停止回報」；若從沒存活過，則為「未啟動」。
6. **Given** 本專案某來源有已結算、非有意的遺失，且之後沒有任何成功寫入，**Then** 「失敗」，理由「正在遺失」；若之後已有成功寫入，狀態不變，理由帶「缺口 N 筆」。

### User Story 4 — HTTPS 分成四個獨立事實，依 client 記錄（P1）

**Why this priority**：三家攔截工具都不把「proxy 在跑」當成功（PRIOR-ART-C §3.3）。今天儀表板以 `http==='ready' && !!verification` 判定已驗證（`CaptureHealth.tsx:143`），首次使用另有一套 `trustVerified`（`HttpCaptureStep.tsx:255`），history 一律寫 `caTrustVerified:false`。

**Independent Test**：以三個假 client（同一 UA 族群的瀏覽器、curl、另一個 proxy 以 RedLog 為上游）注入 flow 與 TLS 結果，斷言每個 client 的四個事實與 HTTP 來源的狀態、理由。

**Acceptance Scenarios**：

1. **Given** proxy 在聽、沒有任何 flow，**Then** HTTP 為「待命」，理由「尚未有任何 client 經過」，不是黃色。
2. **Given** 擷取瀏覽器的 proxy 設定不是受管端點，**Then** 理由「擷取瀏覽器送往 {位址}，不經過 RedLog」。
3. **Given** client A 有 flow 已保存、client B 的 TLS 握手以未知 CA 失敗，**Then** HTTP 為「記錄中」，理由列出 A，並附「B 不信任 RedLog 的 CA」；只有一個動作（信任 CA 的指令，就地複製）；不進需要處理。
4. **Given** proxy 啟動失敗（埠被占用），**Then** 「失敗」，理由帶位址與占用者；client 的 TLS 事實為「無法確認」，不另外標失敗（依賴不傳染）。

### User Story 5 — 一份 manifest，每個欄位都有人讀（P2）

**Why this priority**：今天被接受的 manifest 有三份 schema（generic `plugin.json`、hooks-manager 的 producer manifest、官方 AI 的 `redlogAgent`），宣告了的 `kind`、`capabilities`、`signature`／`publisher`、`schemaVersion`、頂層 `emits`／`health` 沒有任何行為（08-F1，`manifest.ts:259-274` 解析、`src/` 無讀者）。

**Independent Test**：(a) schema 測試驗證每一份 bundled、optional、examples 與文件中的 manifest；(b) 消費者登記 gate：在 schema 加一個沒人讀的欄位時失敗；(c) v1 fixture 的遷移測試：升級前在擷取的來源，升級後的第一次狀態讀取不是「仍在擷取」就是帶理由的非記錄狀態；既有核准不失效。

**Acceptance Scenarios**：

1. **Given** 一份 v2 manifest 少列了 `files` 中的某個檔，**Then** 載入失敗，錯誤指出 JSON pointer 與檔名。
2. **Given** 已核准的使用者 Source，**When** 它的任一檔案被改，**Then** 下一次載入為「未設定」，理由「內容已變更，需要重新核准」，憑證撤銷；顯示步驟之前也會再驗一次。
3. **Given** v1 使用者外掛（只有 `lootPatterns`）已核准，**When** 升級，**Then** 照常生效，核准不需重給。
4. **Given** 使用者外掛宣告 bundled 的 id，**Then** 它以另一個 id 列為錯誤，bundled 的照常載入。
5. **Given** 一份 v2 Source 宣告 `emits` 中有一個不在核心種類表的種類，**Then** 該種類寫入 logged 層（P5），其憑證只能寫 `emits` 列出的種類。

### User Story 6 — 「我要記這個可選來源」只有一個地方、步驟更少（P2）

**Why this priority**：今天要讓 Claude Code 在本專案被記錄需要至少 8 次點擊、2 個設定頁、1 個原生對話框（08 §5 的計數）；安裝、啟用、驗證、移除在卡片、設定、外掛頁、首次使用各有一份（04-F5）。

**Independent Test**：從主畫面起算，以 e2e 腳本計數到「來源狀態為待命」所需的點擊與頁面，與 plan「點擊與頁面數」的目標比較。

**Acceptance Scenarios**：

1. **Given** 官方 AI 整合在本專案沒有同意，**When** 在擷取控制的 AI 列按「在此專案記錄」，選工作目錄並在原生對話框同意，**Then** 該列為「待命」；總共 5 次點擊、1 個設定頁。同意以專案為單位（P4、Spec 071 O9），每個專案第一次啟用都會出現對話框。
2. **Given** bundled 的 pcap Source，**When** 在擷取控制的該列按「在此專案記錄」，**Then** 狀態為「未啟動」，同一列展開啟動步驟；憑證此時發放。
3. **Given** 任何一個來源，**Then** 會改變 RedLog 狀態的動作只出現在它的 owner；其他畫面只顯示狀態、理由與「前往」。
4. **Given** 外掛頁按「移除」，**Then** 結果列出「已收回 N 項；無法收回的 M 項：…」（Spec 073 的安裝帳本）；有殘留時該來源為「失敗」，理由「有殘留」。

### User Story 7 — 外掛作者在本機就能驗證（P3）

**Independent Test**：對 `examples/plugins/*` 與一份故意寫錯的 manifest 執行 `redlog-cli plugin check`；對範例 Source 執行一致性工具組。

**Acceptance Scenarios**：

1. `plugin check` 對錯誤輸出 JSON pointer、期望值與實際值；重算 `files` 的雜湊並列出不符者。
2. 一致性工具組沿用 Spec 071 的向量與 mock receiver，並套用與核心相同的 `emits` 範圍：送出 `emits` 以外的種類得到 `rejected`／`kind-not-allowed`。
3. `manifestVersion` 為 1 或 2 都能讀；`engines.pluginApi` 比 host 新一版時，只讀已知的資料部分並在外掛頁標示。

### Edge Cases

- 狀態讀取本身失敗：整個 payload 標為無法確認；畫面沿用 `captureHealthStore` 的規則，不把上一次的整體當成現在。
- 某個事實讀取失敗（例如螢幕錄製權限查不到）：該事實為 unknown；若其他事實不足以決定，來源為「無法確認」，不進需要處理。
- 全域錄製暫停：不是來源狀態。待命與記錄中的列帶理由「錄製已暫停」；狀態列與 HUD 顯示暫停，取代整體字。
- 寬限期內出現確定性的失敗（埠被占用、二進位不存在）：照常判定，不等寬限期結束。
- 一個 shell 從沒安裝也從沒送過 hello：不列出；在設定頁收合為「另有 N 種 shell 可接」。
- 外部終端機綁定的專案不是目前的專案：該終端機在本地暫停（Spec 071 FR-085），不使任何來源失敗。
- 舊入口仍在使用（Spec 071 FR-079）：理由「仍在使用舊入口」，不改狀態。
- 隔離區有檔：理由「隔離 N 筆」，不改狀態。
- 同一來源在機器層停用、在專案層啟用：機器層優先，「已關閉」。
- 使用者外掛 manifest 有效但 `requires` 的平台不符：「無法使用」，不列入其他平台的來源清單之外；已在送事件的仍列出。
- 官方 AI 的 adapter 不在 app 本體（打包缺檔）：「無法使用」，理由「整合檔案缺失」，進需要處理只在本專案已啟用時。
- 移除外掛時另一個專案正開著並使用它：移除照常；該專案的列在下一次讀取為「未設定」或「失敗：有殘留」。
- v1 manifest 同時有 `capture` 與規則：內部拆成一個 Source 與一個 Processor，共用 id 與核准。
- 外掛宣告的 reader 不在 Spec 072 的登記：manifest 錯誤。
- 提權步驟的檔案在顯示後、執行前被改：執行的是 root 擁有的複本，驗證失敗就中止並說明原因。

## Requirements *(mandatory)*

### Functional Requirements

#### A. 來源描述（SourceDescriptor）

- **FR-001** 每個擷取來源，不論內建或外掛，都只有一份描述，欄位如下；內建來源的描述是核心的資料，**不**因此成為外掛。

  | 欄位 | 意義 |
  |---|---|
  | `id` | 穩定的來源 id；外掛為 `plugin:<pluginId>`，與 Spec 071 FR-071 的憑證來源名稱一致 |
  | `kind` | `shell-adapter`／`builtin-terminal`／`managed-service`／`in-process`／`resident`／`external-producer` |
  | `emits` | 會寫入的事件種類（Spec 072 的 `KindId`，形如 `scanner:packet_flow`）。每一個必須存在於 072 的種類登記，或由外掛宣告（因而為 logged，經 072 的 `validatePluginKind`） |
  | `scope` | 設定的範圍：`machine` 或 `project` |
  | `setup` | 由誰設定（`none`／`redlog`／`operator`），以及唯一的 `owner`：會改變狀態的每個動作所在的設定列錨點 |
  | `prerequisites` | 結構化的前置條件：`binary`（any-of 或 all-of）、`permission`（作業系統權限種類）、`platform`、`file`。永遠是資料，不是文字 |
  | `liveness` | 存活訊號：`hello`（shell）、`alive`（心跳）、`process`（RedLog 管理的行程）、`pane`、`none` |
  | `verification` | 怎樣算「證明能用」：`first-event`、`hello`、`http-clients`（FR-030） |
  | `startedBy` | `always`／`redlog`／`operator` |
  | `privilegedSteps` | 需要提權的步驟（只有外掛 Source 可能有），見 FR-063 |
  | `core` | 是否為核心來源（影響 FR-021 的「與本專案相關」） |

> **Superseded（2026-11-13，修訂 C1、C4）**：FR-001 的「內建來源…**不**因此成為外掛」與 FR-002、FR-003 改為：基本層來源（Spec 076 FR-020）的描述在核心的表；內建與安裝的擴充功能 Source 的描述由 076 的 `toDescriptor` 從擴充功能 manifest 產生；兩者合成同一份清單，欄位不變。`scope` 欄位只剩 `machine`（`binding` 另由 manifest 宣告）。下方原文保留。

- **FR-002** 內建來源的描述集中在核心的一張表，涵蓋今天 capture-health 列出的每一個來源（terminal、各 shell adapter、受管 HTTP proxy、browser-console、screenshot、connection-monitor、process-monitor、file-watcher、每個官方 AI 整合）。這張表取代 starter-pack 的 `builtinProducers`、`STARTER_PACK_FALLBACK`、pack 外掛 manifest 與「哪些 shell 能接」的各份清單（plan「要取代的判斷」）。
- **FR-003** 外掛 Source 的描述由其 manifest v2 機械地產生（FR-051）；外掛不能宣告 `owner`：一律是擷取控制頁上該來源的列。
- **FR-004** 前置條件只由核心檢查並以事實回報（FR-010）。任何畫面都不得從描述文字推出依賴（取代 `ExternalCaptureGroup.tsx:108` 的 regex）。
- **FR-005** 描述中不得出現工具名稱作為邏輯分支；工具名稱只出現在 `label` 與前置條件的資料中。今天寫死 producer id 的地方（`capture-health.ts:338-340` 的 `PROXY_MODE_PRODUCERS`、`hooks-manager.ts:599-614` 的 `checkAvailable` 分支）改為描述的資料。

#### B. 具名事實與單一狀態函式

- **FR-010** 來源回報的事實是封閉清單。每個事實的形狀為（值 或 unknown、理由碼、起始時間，選填訊息）；**事實缺席等於 unknown**。

  | 事實 | 範圍 | 來源 |
  |---|---|---|
  | `configured` | 機器 | 安裝帳本與該 shell 實際讀的檔案（Spec 073）；外掛核准與內容雜湊；沒有設定步驟的來源為「不適用」 |
  | `enabledForProject` | 專案 | `on`／`off`／`unset`；AI 依 `resolveAgentCapture` 的全部條件 |
  | `prerequisites` | 機器 | 每一項為 `ok`／`missing`／`unknown`，附修復方式 |
  | `process` | 執行期 | `up`／`starting`／`down`／`failed`（附失敗原因） |
  | `credential` | 機器 | Spec 071 的憑證登記：已發放、未撤銷、世代有效；行程內來源為「不適用」 |
  | `lastHello`、`lastAlive` | 執行期／終端機 | Spec 071 的存活通道，**從不由事件推出** |
  | `firstEventEver` | 專案 | 本專案第一次接受這個來源的列（Spec 071 FR-056 的里程碑，`ingest_producers.first_accepted_at`）；一旦成立永不清除 |
  | `lastEvent` | 專案 | 本專案最近一次接受的列（071 FR-056） |
  | `loss` | 專案 | Spec 071 遺失帳本，以 071 FR-050 的原因名稱彙總，不另立遺失原因：非有意 = FR-050 中「有意：否」的各原因（含 `sequence-gap`、`ended-unclean`）；有意 = 「有意：是」的各原因（`paused`、`project-switched`、`terminal-not-recording`、`source-disabled`、`credential-revoked`）；待確認 = 尚未結算的 `retry`；停用後被拒 = 停用或撤銷時刻之後的 `source-disabled` 與 `credential-revoked` |
  | `quarantine` | 專案 | Spec 071 隔離區的數量與原因（原因名稱同 071 FR-050） |
  | `legacyDoor` | 專案 | 是否仍經舊入口寫入（Spec 071 FR-079） |
  | `captureError` | 執行期 | 該來源自己回報的擷取錯誤（沿用 `noteCaptureError` 的存活期） |
  | `selfCheck` | 終端機 | hook 的執行期自我檢查：`ok`／`detached`（附原因） |
  | `residue` | 機器 | 安裝帳本中，停用或移除後仍留著的寫入（Spec 073） |

  > **Superseded（2026-11-13，修訂 C3）**：`enabledForProject` 一列改為兩列：`enabledOnMachine`（機器；`on`／`off`；`machine.yaml` 的 `extensions.<id>.enabled`，基本層來源恆為 `on`）與 `boundToProject`（專案；終端機來源：本專案綁定的終端機數；`binding: explicit`：本專案的選擇是否非空，AI 依 Spec 073 FR-063′；`binding: none`：不適用）。FR-012 中「本專案為 `off`」→「機器層為 `off`」；「本專案為 `unset`」→「`binding: explicit` 且本專案沒有選擇」（理由 `no-session-selected`）。FR-016、FR-021 中的「本專案為 `on`」→「機器層為 `on`」（基本層來源視為 `on`）。

  後四項不在擁有者給的清單上；加入的理由見 plan D12。另有兩個不屬於任何來源的全域事實：`paused` 與 `integrity`。本表是來源事實唯一的封閉清單；狀態理由碼是另一份封閉清單（FR-090，plan「理由與動作」）；兩者都不重複 071 FR-050 的遺失原因。
- **FR-011** 只有一個純函式把（描述、事實、時間、寬限期）算成一個來源狀態、一個理由碼與至多一個動作碼。同一輸入永遠得到同一輸出；函式不做 IO、不讀時鐘以外的全域狀態（時間由參數給）。
- **FR-012** 八個狀態依下表的優先序決定，取第一個成立者。完整條件見 plan「決策表」。

  | 優先 | 狀態 | 碼 | 摘要 |
  |---|---|---|---|
  | 1 | 無法確認 | `unknown` | 整份讀取失敗；或決定狀態所需的事實是 unknown，而失敗、已關閉、無法使用、未設定都不成立（plan 決策表 U1、U2） |
  | 2 | 失敗 | `failed` | 有主動的失敗證據：已停用仍在送、行程失敗、擷取錯誤未恢復、hook 被移除、曾存活後停止回報、啟用中但憑證無效、有殘留、manifest 無效、正在遺失 |
  | 3 | 已關閉 | `off` | 機器層停用，或本專案為 `off` |
  | 4 | 無法使用 | `unavailable` | 前置條件缺、平台不符、整合檔案缺失 |
  | 5 | 未設定 | `not-set-up` | 需要設定而沒有（hook 不在實際讀的檔、待核准、需重新核准）；或本專案為 `unset`；或 AI 缺有效工作目錄 |
  | 6 | 未啟動 | `stopped` | 需要行程或存活訊號而目前沒有；寬限期內的暫時性失敗也在這裡（理由「啟動中」） |
  | 7 | 待命 | `ready` | 能記，本專案尚未接受過它的列 |
  | 8 | 記錄中 | `recording` | 能記，本專案已接受過它的列 |

- **FR-013** 「證明過」「上次已驗證」「已在本機看過」都只是理由，從不改變狀態或顏色。證明只因它的前提改變而失效（adapter 雜湊、CA 指紋、端點、路由），與時間、重啟、換專案無關。
- **FR-014** 啟動寬限期（決定 4）：寬限期內，下列暫時性失敗不判「失敗」：心跳未到、行程尚未 `up`、hello 未到、憑證尚未發放。確定性失敗（埠被占用、行程以錯誤結束、二進位不存在、已停用仍在送、hook 被移除）不受寬限期影響。「曾經成功」（`firstEventEver`、曾存活）一旦成立就不清除。
- **FR-015** 只有一個純函式把一個專案的全部來源狀態算成四個整體狀態之一，**不是**取最壞的子項：

  | 優先 | 整體 | 碼 | 條件 |
  |---|---|---|---|
  | 1 | 需要處理 | `attention` | 至少一個來源 `isAttention`（FR-021） |
  | 2 | 記錄中 | `recording` | 至少一個來源為記錄中 |
  | 3 | 等待第一筆事件 | `waiting` | 至少一個來源為待命 |
  | 4 | 無可用來源 | `none` | 其他情況（沒有任何來源能記）；為什麼由各來源自己的理由說明，整體不另設理由 |

- **FR-016** 已關閉、未設定、未啟動、待命、無法確認的來源從不使整體變成需要處理；`startedBy: operator` 且從沒存活過的外掛 Source 也不會（保留今天 `capture-health.ts:806-811` 的不對稱保證）。
- **FR-017** 完整性（證據鏈抽樣失敗、DB 寫入失敗）不進整體，以獨立的 `integrity` 回報，沿用 StatusBar 既有的完整性 issue 管道。整體只由來源狀態決定，不再有任何機器層事實直接決定專案整體（取代 `anyWired`，`capture-health.ts:815-817`）。
- **FR-018** 每個 shell adapter（P8）的事實：`configured` 由安裝帳本記錄的、**該 shell 實際讀的檔案**是否含 hook 行決定（Spec 073）；`lastHello` 取綁定本專案的 instance 的 hello（Spec 071 FR-112）；機器層的「已在本機看過」取既有的 `~/.redlog/tool-detection/shell:*.json`；`selfCheck` 取 hook 的執行期自我檢查。狀態從不由 `$SHELL` 或二進位是否存在決定。
- **FR-019** 「AI 工具有活動卻未記錄」（#703）只以理由 `in-use-not-recorded` 出現在該 AI 來源，不改狀態、不進整體；這是 AI 來源在儀表板上唯一的常駐以外的出現方式（P2）。
- **FR-020** 全域錄製暫停：待命與記錄中的來源帶理由 `recording-paused`；整體字不變，但狀態列與 HUD 以暫停取代整體字的顯示。
- **FR-021** `isAttention(status)` 只在下列情況成立：狀態為失敗，且（來源為核心來源、或本專案為 `on`、或理由為已停用仍在送）；或狀態為無法使用，且本專案為 `on`。
- **FR-022** 每個需要處理的來源各一則 issue（id `source:<來源 id>`），目的地為其 owner。toast 只在一個來源**進入**需要處理且已過寬限期時出現；issue 的狀態以專案為範圍，換專案時重置，不因換專案產生 toast。
- **FR-023** `recording` 只說「本專案接受過且現在沒壞」；最近一筆的時間以「多久以前」作為資料顯示，不分級。不新增「閒置」。
- **FR-024** 紅色只用於失敗；無法使用在本專案為 `on` 時用警示色，其餘狀態用中性色；狀態從不只靠顏色表達（承接 Spec 070 FR-004）。
- **FR-025**（2026-11-13，修訂 C5）**未知從不顯示為安全**。payload 中任何值為 unknown 的事實或讀數（來源事實、出口 `Egress.state` 為 `none`／`stale`／`airgap`／`remote`、IP 判斷在沒有 `current` 出口時），每個 surface（狀態行、狀態列、HUD、設定、CLI、`redlog status`、`/api/status`）都顯示為「無法確認」、「未知」或位址加讀取時間，從不使用「安全」或同義字，也從不使用表示安全的顏色。安全判斷只在出口為 `current` 時可以成立。Gate：`test/source-status/unknown-never-safe.test.ts`——對每個 surface 的 render 測試，以全部 unknown 組合的 payload 斷言輸出不含 `safe`、`安全` 與安全色的 class；另以 property test 斷言 IP 判斷函式在出口非 `current` 時永不回傳 `safe`。

#### C. 單一讀者

- **FR-030** HTTP 的事實依 client 分開記錄，每個 client 四個獨立事實（PRIOR-ART-C §6.3）：`proxyListening`、`clientRouted`、`tlsTrusted`、`trafficStored`。client 由本專案已保存的 flow 推出（UA 族群，加上 socket 歸因可得時的行程名稱）。HTTP 來源的狀態：proxy 失敗為失敗；不在聽為未啟動；任一 client 已保存為記錄中；在聽而沒有已保存的為待命。TLS 不信任、擷取瀏覽器送往別處、尚未有 client，都是理由。proxy 失敗時，client 的 TLS 事實為 unknown，不另外標失敗。
- **FR-031** main 對外只送一份狀態 payload：整體、每個來源的狀態（含理由、動作、owner 與唯讀的事實）、完整性、暫停。（2026-11-13，修訂 C5：另加 `egress`，形狀為 Spec 071 FR-122 的 `Egress`。）`capture:health` IPC、`/api/status`、`/api/capture` 與 CLI 都讀這一份。
- **FR-032** 儀表板卡、狀態列、設定的各來源列（指令與終端、HTTP、擷取控制、外掛詳情的生效軸）、首次使用、HUD、終端機 pane 徽章、CLI、`redlog status`（shell）都只渲染這份 payload；它們不得從事實算出任何狀態、整體或注意數。
- **FR-033** `/api/status` 保留舊的 `capture.verdict` 與 `capture.sources[].state` 欄位一個 minor 版本並標為 deprecated，舊值由新狀態對映（plan「舊欄位對映」）；新欄位為 `capture.v`、`capture.overall`、`capture.statuses`。`docs/codex-tools.json` 與 agent skill 同步更新。
- **FR-034** 首次使用就是儀表板上的同一份來源清單，預設展開；刪除「核心擷取已就緒」與 `coreCaptureReady`；preflight、hook 偵測、外掛目錄、proxy 自動啟動都在背景進行，列先以無法確認畫出再補上，不擋整頁（04-F6）。
- **FR-035** `redlog status`（shell 內）印出這個 shell 的狀態字（來自 app）；app 不可達時只印本地事實並標為無法確認。來源是 Spec 071 FR-07B 的 `/api/whoami`，它回傳本規格 payload 中呼叫者來源的那一項。
- **FR-040** 會寫設定、hook 檔、外掛狀態、同意或憑證的 handler，每個來源只有其 owner 會呼叫；其他畫面只有「前往」。例外是只開作業系統面板或複製指令的修復（不改 RedLog 狀態），可在顯示理由的地方就地提供。
- **FR-041** 「來源在哪裡設定」只讀描述的 `owner`；今天的三份對照（`captureIssue.ts:23-27`、`CaptureHealth.tsx` 的 7 處 `settingsTarget(...)`）刪除。
- **FR-042** Gate：(a) 型別：bridge 型別的事實只在 `statuses[i].facts`，以 readonly 不透明型別提供；(b) 靜態掃描：`src/renderer/**` 除指定的檢視模組外，出現讀取事實、比較狀態碼以外的來源欄位、或比較舊 verdict 時失敗；(c) ratchet：今天的獨立判斷數為基準，只能下降，最後為 0（plan「Gates」G2）。

#### D. 外掛 manifest v2

> **Superseded（2026-11-13，修訂 C1、C4）**：本段（FR-050–063）的擁有者改為 Spec 076，由擴充功能 manifest 第 1 版（076 契約 §2）取代。對應：FR-050、FR-052、FR-053 → 076 契約 §2、§10；FR-051（不建 Exporter）→ 反轉，076 H 段；FR-054、FR-055 → 076 契約 §2.2；FR-056 → 076 FR-063；FR-057 → 076 FR-004；FR-058 → 076 FR-071 與契約 §2.9（核准對話框的規則照舊）；FR-059 → 076 契約 §2.3（執行規則照舊，仍由本規格的 Processor 時限實作）；FR-060、FR-061 → 076 FR-020 的兩層清單；FR-062、FR-063 照舊，由 076 引用。本規格對 manifest 只保留一件事：`toDescriptor` 產生的 `SourceDescriptor`（FR-001）欄位不變。下方原文保留。

- **FR-050** 只有一份有版本的 JSON Schema（`plugins/plugin.schema.json`）。loader 的驗證、`plugin check`、測試與文件的欄位參考都由它產生或以它驗證。
- **FR-051** `kind` 只有 `source` 與 `processor`；一個資料夾一種。`pack`、`producer`、`mapper`、`enrichment`、`exporter` 不再被接受（v2 為錯誤；v1 照 FR-070 轉譯）。**不建 Exporter**：產品不做報告產生；HAR、JSON、NDJSON、bundle 在核心並經 snapshot 與封存；若將來需要第三方格式，契約是「讀封存 bundle 或 NDJSON 匯出檔的外部程式」，它不需要 RedLog 提供任何 host（08 §3a）。
- **FR-052** 每個 schema 欄位都必須在消費者登記表中有一個讀它的程式位置（檔案與符號）；沒有消費者的欄位使 gate 失敗。
- **FR-053** v2 不接受 `signature`、`publisher`、`capabilities`、頂層 `emits`／`health`／`schemaVersion`、`contributes.tailers`、`description`（作者說明放 README，不再顯示）；遇到時錯誤訊息說明原因。
- **FR-054** Source 的欄位：`source.emits`（決定 Spec 071 `plugin:<id>` 憑證允許的種類，恰好等於此清單）、`source.requires`（結構化前置條件）、`source.start`／`source.stop`（步驟，每步 `label`、`run`、`args`、`elevated`）、`source.liveness`。
- **FR-055** `emits[]` 每項為 `{kind, label, reader?}`，形狀與 Spec 072 的 `validatePluginKind(pluginId, decl)` 相同。`reader` 只能是 072 的 `ReaderId`；不在核心登記表上的 `kind` 由 072 產生外掛種類，寫入 logged 層（P5）。外掛宣告保存在本規格的 manifest 狀態中，由呼叫端傳給 072 的 `kindOf(row, plugins)`。今天 `eventTypes` 的 `label`／`lane` 由此承接，`color`／`icon` 不再支援（沒有 UI 外掛）。
- **FR-056** 信任：`files` 列出外掛資料夾內的每一個檔案及其 sha256；未列出的檔案存在時為錯誤。內容雜湊 = sha256（正規化 manifest ‖ 依路徑排序的每個檔案）。核准時 pin 住，**每次載入時重算**，並在下列時刻之前再驗一次：顯示任何步驟、發放憑證、執行或安裝任何動作。不符即為「未設定・需要重新核准」，並撤銷憑證。
- **FR-057** bundled 外掛由 app 簽章涵蓋，不需逐一核准；bundled id 保留，使用者外掛不得使用（承接進行中分支的行為）。
- **FR-058** 核准畫面由 main 以原生對話框顯示（決定 11），內容由 main 從自己載入的 manifest 產生：id、版本、雜湊前 12 碼、`emits`、會寫入的檔案（terminal profiles）、需要的提權。IPC 為 `plugins:grant(id, expectedHash)`，顯示前與確認後各驗一次。核准紀錄不再記錄專案的 operator id。
- **FR-059** Processor 的內容只有資料：`lootPatterns`、`redaction.denylist`、`commandTags`、`targetExtractors`、`terminalProfiles`（唯一需要核准的 Processor 內容）。執行規則：
  - 結果會寫進列並被雜湊的推導（loot 事件與遮罩 denylist、`data.redactions` 的 span、`commandTags` 蓋上的欄位、`target_id`／`detectedTarget`／`extractor_name`）全部在寫入路徑上，依 Spec 071 FR-091 在 commit 前同步完成；
  - 它們必須是決定性的、有界的；使用者規則共用**每個事件一個總時限**（預設 250 ms），超過時該事件的使用者推導標為部分完成，並停掉造成超時的規則，不再「停一條、再跑一趟」；
  - 每筆推導在列上記錄規則集：`_ingest.rules`，每項 `<pluginId>#<內容雜湊前 12 碼>`；推導因時限而未完成時 `_ingest.rules_partial: true`（Spec 071 FR-005、FR-006）。為守住 071 的 512 bytes 上限，這是有界形式：不帶版本、至多 3 項、超過時第 3 項為 `+<其餘數目>`；外掛版本由內容雜湊在外掛詳情中對照；
  - 被停掉的規則保留到該外掛的內容雜湊改變為止，並出現在外掛詳情；
  - 載入時拒絕已知的非線性形狀（巢狀量詞、backreference），時限仍是最終保證；
  - bundled 規則照今天在 main 直接執行（隨 app 測試），不計入使用者時限。
- **FR-060** 回到核心、不再是外掛的 bundled 項目，各有理由（套用 07「不為了搬而搬」的警告；被否決的搬動見 plan D7）：
  - `starter-pack`：內容是操作者自己的 shell 與 RedLog 自己的 proxy；停用它會讓擷取變暗，UI 從未提供這個選擇；改為核心描述表；
  - `pack-host-monitors`、`pack-windows-output`：manifest 是空的，唯一作用是當機器層開關，與專案層 `packs.<id>` 互相矛盾；程式碼本來就在核心（`capture-packs.ts:7-9`）；
  - `optional-plugins/*/plugin.json` 的 `kind: pack` 外殼：官方 AI adapter 是 app 程式碼（P4），不再被通用 loader 讀成第二份。
- **FR-061** 保留為外掛的 bundled 項目：`builtin-tools`（bundled Processor，工具知識是資料，id 保留）；`pcap-capture`、`c2-tailers`（bundled Source，改寫為 v2 的 `files`、`requires`、`stop`、`elevated`）。
- **FR-062** 使用者 Source 的步驟在核准之前不顯示；核准後顯示時標出來源外掛。
- **FR-063** 提權步驟只執行經驗證的 root 擁有複本：在同一次提權中，先複製到 root 擁有的位置、驗證 `files` 中的 sha256、再從那裡執行；驗證失敗就中止並說明原因。

#### E. 生命週期

> **Superseded（2026-11-13，修訂 C3）**：FR-073 的專案層 `unset → on ⇄ off` 改為專案層的綁定（終端機 pin、AI 選擇）；FR-074 中「擷取控制的來源列（專案範圍）：在此專案記錄」改為：來源列只有綁定相關的動作（AI 的工作路徑與工作階段選擇、「記錄到這個專案」改綁）與顯示步驟；啟用、停用、核准、撤回同意都在設定 ▸ 擴充功能（機器範圍）；FR-076 的「第一次在任一專案啟用（`on`）時發放」改為「在這台機器上啟用時發放」，專案層的 `off` 不再存在（Spec 071 FR-07C）。

- **FR-070** v1 manifest 的對映：
  - generic `plugin.json` v1 → 轉成內部 v2 形狀；同時有 `capture` 與規則的拆成一個 Source 與一個 Processor，共用 id 與核准；非 `manual` 的使用者 capture 不再被安裝（P3），已安裝的寫入交由 Spec 073 收回或保留並顯示；v1 的雜湊算法保留給 v1，既有 grant 不失效；
  - producer manifest（`builtinProducers`、`STARTER_PACK_FALLBACK`）→ 核心描述表；已安裝在磁碟上的 hook 不動，由 Spec 073 補登帳本；
  - `redlogAgent` → 核心描述表中的官方 AI 來源；收據轉成同意紀錄並保留 `installationId`（Spec 073）。
- **FR-071** 遷移期間沒有任何擷取靜默停止：升級後第一次狀態讀取時，每個升級前在擷取的來源，不是仍在擷取，就是一個帶理由的非記錄狀態（需要重新核准、需要在此專案啟用、殘留）。
- **FR-072** `state.json` 中 bundled pack 與 starter-pack 的停用旗標在第一次啟動時轉成一次性通知並刪除（P6）；使用者外掛與 `builtin-tools` 的停用旗標保留。
- **FR-073** 生命週期是一台狀態機：機器層 `available → approved → disabled／removed`（另有 `invalid`、`awaiting-approval`），專案層 `unset → on ⇄ off`，執行期由事實決定；三者合成八個狀態之一（plan「生命週期對映」）。Processor 沒有來源狀態，它的問題只出現在外掛詳情。
- **FR-074** 每個動作的家（不新增頁面）：
  - 外掛頁（機器範圍，對話框寫明「影響所有專案」）：核准、停用、移除、撤回官方 AI 的同意、診斷、樣本測試；
  - 擷取控制的來源列（專案範圍）：在此專案記錄、工作目錄、顯示啟動與停止步驟；官方 AI 第一次在某專案啟用時，同意的原生對話框由這裡觸發（同意存在該專案，Spec 073 FR-061–063）；
  - 指令與終端設定（內建 shell，非外掛）：安裝、移除、驗證；
  - HTTP 設定：proxy、埠、CA 與驗證面板（唯一的一份元件，首次使用嵌入同一元件）；
  - 儀表板、狀態列、HUD、首次使用：只顯示並「前往」。
- **FR-075** 移除不留殘餘，交由 Spec 073 的安裝帳本：移除與撤銷時依帳本收回寫入，結果列出已收回與無法收回的項目；無法收回時該來源為「失敗」，理由 `residue`，動作前往 owner。
- **FR-076** 憑證是 Spec 071 的機器層憑證（071 plan D7）：外掛 Source 第一次在任一專案啟用（`on`）時發放 `plugin:<id>`；機器層停用、撤銷、內容雜湊改變、移除時撤銷（071 FR-072、FR-076）。專案層的 `off` 或 `unset` 不撤銷憑證：接收端對該專案的項目回 `rejected`／`source-disabled`（071 FR-07A），計入「停用後被拒」，由決策表 F1 判為 `writing-while-off`。

#### F. 開發者體驗

> **Superseded（2026-11-13，修訂 C4）**：本段由 Spec 076 契約 §10 與 076 T028 取代（`redlog-cli extension init|check|test`）；FR-083 列出的文件錯誤由 076 T091 一併修正。

- **FR-080** `redlog-cli plugin check <dir>`：以 FR-050 的 schema 驗證，錯誤指出 JSON pointer、期望值、實際值與附近的欄位；重算 `files` 的雜湊；執行規則的靜態線性檢查。
- **FR-081** 本機一致性工具組：沿用 Spec 071 的共用向量與 mock receiver，並套用與核心相同的 `emits` 範圍與蓋章；Processor 另有 `testSample` 的 CLI 版本（`core/plugins/test-sample.ts` 已是純函式）。
- **FR-082** 相容：`manifestVersion` 讀 1 與 2；`engines.pluginApi` 讀 N 與 N-1；N+1 只讀已知的資料部分（保留今天 `apiAhead` 的行為，`loader.ts:70-77`）。
- **FR-083** `docs/plugin-development.md` 改寫：欄位參考由 schema 產生；下列今天的錯誤逐一修正或刪除（2026-11-12 開檔確認的行號）：`:5` 可提供 agent 可操作的工具；`:54` `code/tools.js` 模組；`:80` `signature` 保留給簽章發佈；`:85` 比 host 新的 API 會被拒絕；`:275-276`、`:368` capture 出現在 Settings ▸ Hooks 且可一鍵安裝；`:364-365` 可放在專案的 `.redlog/plugins/`；`:395` 隔離、依能力範圍執行；`:418` CODE CHANGED 狀態；`:419` 撤銷時隔離行程被終止；`:442` `examples/plugins/geoip-tool`；`:461-462` exporters／monitors「reserved」；`:475` 🔴 為隔離、依能力範圍。文件中的每個 jsonc 範例都以 schema 驗證，提到的每個 `examples/` 路徑都必須存在。

#### G. 文案與詞表

- **FR-090** 狀態字只存在 `source.state.<碼>`（8 個）；整體字只存在 `capture.overall.<碼>`（4 個）；理由只存在 `source.reason.<碼>`（封閉清單，至多 41 個，plan「理由與動作」，含 Spec 073 要求的 4 個：`project-archived`、`bound-elsewhere`、`consent-scope-changed`、`hook-file-missing`）；動作只存在 `source.action.<碼>`（至多 5 個）。每個語系新增至多 58 個 key。（2026-11-13，修訂 C6：理由上限 49、每語系新增上限 66，新增的 8 個理由碼見修訂表。）
- **FR-091** 任何其他命名空間的值不得與這 12 個狀態字完全相同。
- **FR-092** 退役的 key（plan「退役的 key」，101 個，分屬 `capture.state.*`、`capture.http.*`、`httpCapture.state.*`、`capture.{dark,partial,healthy,healthyGap}`、`capture.confirmed.*`、`statusBar.capture*`、`issues.captureDetail`、`activity.status.sourceAlert`、`settings.external*`（8 個）、`plugins.healthAxis.*`、`plugins.projectAxis.*`、`capture.tag.*`、`capture.terminalOwnShell*`、`firstRun.core.{pending,verified,capturedTrustUnproven,ready}`、`httpVerification.*`、`settings.{hookNotFound,shellInstalled,hookDisable}`、`terminal.meta.hook{On,Off}`、`capture.summary.*`、`capture.sub.*`、`capture.*` 的 11 個動作與標籤、`settings.source.*`）在同一個變更中刪除；斷言它們的 test 與 e2e 是該變更的一部分（plan 列出）。每個語系的淨 key 數下降。
- **FR-093** `plugins.installState.*` 與 `plugins.status.*` 保留：它們是外掛頁的機器層信任軸，不是擷取狀態；擷取相關的畫面不得引用它們。

### Key Entities

- **來源描述（SourceDescriptor）**：一個擷取來源是什麼、會寫什麼、需要什麼、在哪裡設定（FR-001）。
- **具名事實（Source Fact）**：（值 或 unknown、理由、起始時間）；缺席等於 unknown（FR-010）。
- **來源狀態（SourceStatus）**：八個狀態之一，加一個理由與至多一個動作（FR-012）。
- **整體狀態（Overall）**：四個之一，不取最壞子項（FR-015）。
- **完整性（Integrity）**：證據鏈與寫入，與整體分開（FR-017）。
- **Client 事實**：HTTP 的四個獨立事實，依 client 記錄（FR-030）。
- **Manifest v2**：一份 schema、兩種 kind、`files` 雜湊、消費者登記（FR-050–056）。
- **消費者登記（Field Consumer Registry）**：schema 欄位到讀它的程式位置的對照（FR-052）。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** 決策表的每一列各有至少一個測試案例；property test（至少 10,000 組隨機事實）斷言：同一輸入同一輸出；把任何一個來源從待命改為已關閉，整體永遠不會變差；任何非 `isAttention` 的來源都不改變整體是否為需要處理。
- **SC-002** US1 的 2 × 3 矩陣全部符合；在真機上，裝好 hook 並驗證過 HTTPS 的機器重開 app 20 次，整體沒有一次是需要處理或黃色。
- **SC-003** 各自判斷來源狀態或整體的位置從 20 處（plan 基準：7 份整體、13 份來源，分布在 core、renderer 與 CLI）降到 0，只剩 FR-011 與 FR-015 的兩個純函式；「來源在哪裡設定」的對照從 2 份降到 0（只剩描述的 `owner`）。
- **SC-004** 每個 surface 對同一份 payload 的每個來源顯示同一個狀態字（render 測試涵蓋 9 個 surface）。
- **SC-005** schema 涵蓋 100% 的 bundled、optional、examples 與文件中的 manifest；消費者登記涵蓋 100% 的 schema 欄位。
- **SC-006** v1 遷移 fixture（至少 8 種機器狀態）升級後，擷取中的來源有 0 個在沒有理由的情況下不再記錄；既有使用者 grant 有 0 個失效。
- **SC-007** 讓 Claude Code 在本專案被記錄：從 ≥8 次點擊、2 個設定頁，降到每個專案 5 次、1 頁（同意以專案為單位，每個專案都有一次原生對話框）。
- **SC-008** k 條病態使用者規則對單一事件造成的主執行緒阻塞不超過每事件時限加 50 ms，且不隨 k 成長（k = 1、4、16）。
- **SC-009** 每個語系的淨 key 數下降（新增 ≤ 58、退役 ≥ 101）；`test/ui-copy.test.ts` 與新的詞表測試通過。
- **SC-010** 沒有新增頁面或路由。

## Assumptions

- 單一使用者、單機。**威脅模型**沿用 Spec 071 與 05-F6：防的是瀏覽器與網頁、敵意的錄製內容、只有檔案工具的代理、bundle 的持有者；**不防**能執行任意程式碼的同使用者程序。內容雜湊與核准防的是「未經同意的內容被顯示或執行」與誤歸屬，不防惡意的本機程序；外掛 Source 以使用者身分執行，可讀 `~/.redlog` 底下任何檔案，文件要寫明這一點。提權步驟的 root 擁有複本是為了不讓同使用者程序取得 root（08-F7）。
- Spec 071 的存活通道、憑證登記、遺失帳本、隔離區與「第一次接受」里程碑可讀（plan「對姊妹規格的需求」）。在它們落地之前，本規格以今天的對等事實代替（heartbeat 列、`lastEventAt` 探針），並在理由中標明。
- Spec 073 的安裝帳本能回答「某 shell 實際讀的檔案是否含 hook 行」以及「某擁有者還留下哪些寫入」。在它落地之前，`configured` 沿用今天 `checkInstalled` 的結果，事實的 `reason` 記 `install-record-missing`（這是事實層的內部標記，不是 FR-090 的狀態理由碼，不顯示文字）。
- 啟動寬限期 30／60 秒是依現有心跳週期（15 秒，`capture-health.ts:331-334`）與 proxy 啟動時間估的；以真機量測確認。

## 不在範圍

- 信封、憑證發放、存活通道的傳輸與遺失帳本本身（Spec 071，本規格只讀）。
- 事件種類與讀者的登記與分層（Spec 072）。
- 安裝帳本、同意紀錄的儲存、機器層設定檔、官方 AI adapter 的載入路徑改為 app 本體、收據轉換（Spec 073）。
- 查詢工作執行緒與投影；`lastEvent`／`firstEventEver` 的 SQL 由 Spec 074 擁有（本規格只定義事實）。
- Shell hook 本身的改寫（hello、自我檢查、不輸出、寫入位置的解析）：本規格定義讀它們的事實；hook 的實作屬 Spec 071（向量）與 073（安裝）。
- 推導搬到 worker 的 CPU 工作（02 §3 的 (c)）；本規格只改時限單位與記錄規則版本。
- 第三方 in-process 程式碼、utilityProcess host、publisher 簽章、registry、marketplace。
- 視覺改版、新頁面。

## 與既有文件的衝突（本規格生效時需一併修訂）

- **Spec 035（Verified）** FR-001「每個可選來源由 bundled pack manifest 宣告」、FR-002「停用 pack 移除其來源」：FR-060 刪除 pack manifest，可選來源改由核心描述宣告，pack 只剩專案層開關。`capture-health.ts:736-746` 的註解與 `test/capture-packs.test.ts` 依此改寫。
- **Spec 033（Verified）** FR-004「重新登記外掛規則會清除停止」：FR-059 改為保留到內容雜湊改變為止；FR-003 的呈現位置改為外掛詳情。
- **`docs/UIUX-STANDARD.md:342`**「儀表板只列有問題的來源（開著但沒在送、已就緒但未有事件）」：已就緒而未有事件是「待命」，不是問題（FR-016）。依 AGENTS.md，此差異回報擁有者，由擁有者修訂標準。
- **`test/capture-health.test.ts:65`**「dark when no hooks installed」釘住的契約被 FR-015、FR-017 取代；`README.md:247`「RedLog captures nothing until a source is wired up」不再成立（內建終端機開箱可記）。（2026-11-13，修訂 C2：內建終端機預設關閉，`README.md:247` 的說法在沒有 shell hook 時**仍然成立**，不需修訂。）
- **`capture-health.ts:818-830` 的註解與 `producerStalled`**（存活但停送使整體為 partial）：被決定 12 取代；釘住它的 `test/capture-health.test.ts` 案例屬於本變更。
- **`capture-health.ts:22-44` 的註解**（狀態軸 `ready/unset/off/error`）與 **`captureReadiness.ts:145-149`**（新安裝必須讀成 dark）。
- **`DESIGN-plugin-kernel.md`**（current）：§1 starter pack 為「可移除的外掛格式」、§2 四種角色（mapper、exporter）、manifest 草案（`kind: producer`、`health`、`schemaVersion`、`capabilities`）、§5 第 5 步。由 FR-050–061 取代。
- **`src/core/plugins/types.ts:190-192`** 的註解「kernel 用 `kind` 判斷 capture source」不實；**`types.ts:4-28`** 部分不實。
- **Spec 066 FR-003**（Draft）「插件頁是官方整合安裝的唯一入口」、**Spec 070 US2**（Draft）「閒置」：見上方關係表。
- **Spec 052 FR-015**（Draft）「安裝在第一筆指令到達前不算完成」：語意保留，但改為理由而非狀態，且證據改為 hello。
- **Spec 071**：FR-056 列出的狀態事實與本規格 FR-010 一致（2026-11-12 對帳時 071 FR-056 補上第一次與最近一次接受、停用後被拒、最近一次非有意窗口）；本規格的兩個新增已由 071 接受：`/api/whoami` 回傳來源狀態（071 FR-07B）、`_ingest.rules`／`rules_partial`（071 FR-005、FR-006，有界形式）。本規格原寫的「本專案 `on` 時發放、`off` 時撤銷」改為 071 的機器層憑證加專案層政策（FR-076）。hook 自我檢查 `detached` 經存活通道傳遞（FR-010 的 `selfCheck`、US3-1）尚未在 071 的信封中定義，見文末開放問題的注記。

## 開放問題（需要擁有者）

> **2026-11-12 擁有者答覆**：Q1–Q5 均照「建議」欄採納。這是決定，尚未實作。

| # | 問題 | 建議 |
|---|---|---|
| Q1 | `docs/UIUX-STANDARD.md:342` 說儀表板只列「有問題的來源」，並把「已就緒但未有事件」算作問題；本規格把它定為「待命」，不是問題（FR-016）。依 AGENTS.md 這個差異要由擁有者決定：要不要修訂標準？ | 修訂標準：「已就緒、尚未有事件」是待命，不是問題（FR-016）；否則新專案每次開啟都會被標成有問題（US1）。T036 在答覆後執行 **已裁定（2026-11-13，DECISIONS §9）**：修訂標準：待命不是問題 |

| Q2 | 已驗收的 Spec 035 FR-001／002（內建 pack 的 manifest）在 pack manifest 刪除後是否一併修訂？ | 是，同一個 PR（T075） **已裁定（2026-11-13，DECISIONS §9）**：是，同一個 PR |
| Q3 | 已驗收的 Spec 033 FR-004 是否改為：被停用的規則在外掛內容雜湊變更前維持停用？ | 是 **已裁定（2026-11-13，DECISIONS §9）**：是 |
| Q4 | 「仍回報存活但沒有送出任何事件」由失敗改為原因說明（未送出事件）？ | 是 **已裁定（2026-11-13，DECISIONS §9）**：改為原因說明 |
| Q5 | 外掛類型去掉 Exporter，只留 Source 與 Processor？ | 是（理由見根因報告 08 §3a）（**2026-11-13 反轉**：類型為 Source、Processor、Exporter，DECISIONS §3；Spec 076 H 段） |
| Q6（2026-11-13 新增） | 選用來源要不要另用「已啟用」一詞，還是只用八個來源狀態（「已關閉」＝未啟用，其他任何狀態＝已啟用）？ | 建議只用八個字：「已啟用」會與「待命」「記錄中」並存於同一列，違反固定詞表；設定 ▸ 擴充功能的開關本身已表達啟用。本規格不替擁有者決定（DECISIONS §7） |

跨規格的協調事項（不是給擁有者的問題，由規格協調處理）：hook 的執行期自我檢查 `detached` 要經 Spec 071 的存活通道送達（FR-010 `selfCheck`），071 的 `hello`／`alive` 目前沒有這個欄位。在 071 加上之前，`selfCheck` 事實缺席（等於 unknown），決策表 F6 不會成立。

## Domain References

- `.specify/memory/constitution.md` II（Surface Truthfulness）、III（Canonical Semantics）、VI（Explicit Failure）、VIII、IX。
- 跨 071–075 的實作順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」。
- `docs/domain/glossary.md`：Capture Session、Chained／Logged Event、Recording。本規格新增的術語（Source Descriptor、Source Fact、Source State、Overall State、Client Facts、Manifest v2）在 tasks T098 寫入 glossary。
- `docs/design/DESIGN-plugin-kernel.md`、`DESIGN-capture-trust.md`。
- Spec 027、033、035、052、060、065、066、067、070、071。
