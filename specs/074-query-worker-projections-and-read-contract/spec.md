# Feature Specification: 查詢工作執行緒、增量投影與讀取契約

**Feature Branch**: `spec/072-075-contracts`
**Created**: 2026-11-12
**Status**: Draft
**Input**: [根因審查與落地計畫](../../docs/records/2026-11-12/ROOT-CAUSE-REVIEW.md) 階段 3「每個專案一個查詢工作執行緒；衍生資料增量化」與階段 6「介面的讀取模型、變更通知、計數定義、篩選歸屬、導覽狀態」；根因報告 [02 主行程回應性](../../docs/records/2026-11-12/root-cause/02-main-thread.md)、[03 介面狀態與資料流](../../docs/records/2026-11-12/root-cause/03-renderer-state.md)、[10 擷取種類與呈現](../../docs/records/2026-11-12/root-cause/10-capture-kinds-and-presentation.md) §A.4、§D、§E、§F；同類系統研究 [PRIOR-ART-D](../../docs/research/PRIOR-ART-D-desktop-architecture-and-verification.md) 與 [整合](../../docs/research/PRIOR-ART-SUMMARY.md) 的階段 3／6 兩表；2026-11-12 擁有者決定（根因審查 §4）。

> 本檔只寫可觀察的行為與對外契約。設計理由、被否決的做法、模組介面、資料形狀、遷移順序與驗證方式在 [plan.md](plan.md)。讀取契約本文（給畫面實作者讀的那份）會成為 `docs/domain/SPEC-read-contract.md`（tasks T090）；本規格與它衝突時，以本規格為準，直到該文件建立。

## 決策與範圍

### 已決議（擁有者，2026-11-12；本規格不重開）

| # | 決定 | 落點 |
|---|---|---|
| O1 | 每個開著的專案一個查詢工作執行緒；衍生資料改為增量（階段 3，前提為階段 0、2） | A、C |
| O2 | 介面的讀取模型、變更通知、計數定義、篩選的歸屬、導覽狀態（階段 6，前提為階段 3） | D |
| O3 | 跨頁只帶專案、時間範圍與選中的事件；篩選留在各頁。這**取代** Spec 038 的「共用篩選套用到每個事件視圖」（根因審查 §4、10 §E.7） | D（FR-085–FR-088） |
| O4 | 推導出的註記（戰利品、範圍觀測、pivot、清理、憑證使用）預設附著在來源指令上；原本的泳道保留為可展開的完整清單 | C、F |
| O5 | 狀態帶由整個專案的區間投影供應，與篩選和分頁無關 | C、F |
| O6 | 新增 `project_closed` 紀錄，使「app 沒開」與「沒有事件」可區分；既有專案的那一段為「是否在錄：未知」（寫入與種類由 072／073 負責；投影由本規格負責） | C |
| O7 | 不引入相依注入容器或全域狀態函式庫；不整批搬動 `src/core`；不依行數拆 `Timeline.tsx`；不新增頁面；元件不得宣告在另一個元件內 | 全部 |
| O8 | Activity 是投影，不是表：它可以被保存為衍生資料以免每次重算，但永遠可丟棄、可重建、不進證據檔、不進匯出 | C |
| O9 | 牆鐘時間的比例測試在本 repo 只能手動執行（`REDLOG_PERF`）；常駐的閘門以工作量計數判定 | E |
| O10 | 不改任何既有事件的雜湊、簽章、鏈結；不改寫既有列；既有專案照舊開啟、驗證、匯出 | 全部 |

### 本規格自行決定的（理由與被否決的替代方案見 plan.md）

1. **寫入者留在主行程**；只有讀取與衍生資料移出。讀取服務是一個資源，擁有兩條讀取執行緒（`interactive`、`heavy`），`heavy` 是衍生資料庫唯一的寫入者（plan D1、D2）。
2. 執行緒用 `worker_threads`，不用 `utilityProcess`：沿用匯出 worker 已證明可在三平台、asar 與現行 fuses 下載入原生模組的路徑（plan D3）。
3. **提交序號**是寫入者在每次 commit 後遞增的記憶體內計數（每個開啟各自從 1 起算），與該次 commit 後兩層的 rowid 水位一起回傳；持久的游標一律用兩層 rowid 加游標所在列的 id（plan D4）。
4. 衍生資料放在每個專案一個新的 `derived.db`；`http-body-index.db` 與 `cast-index.db` 保持原檔，但改守同一份投影契約；071 的 `terminal_targets` 因為寫入路徑要同步讀它，是唯一由寫入者推進、放在 `timeline.db` 的投影（plan D5）。表歸 071；本規格把它當成可重建的投影，負責舊專案的回填（`heavy` 計算、主行程的寫入者寫入）。回填完成前，該專案的新列不套用 `terminal-last`，寫 `target_via: "none"`，而且因為列永不改寫，這是永久的（071 FR-010）。
5. 效應數與註記數由**同一個** `cause_counts` 投影提供，依 072 註冊表的角色分開（plan D7）。
6. 讀取服務停擺時，主行程**絕不**改為自己執行查詢（plan D8）。
7. 計數只有三種：`exact`、`atLeast`（顯示為「N+」）、`unknown`；清單的完整度另成一欄。全部畫面經同一個格式化函式（plan D11）。

> **指標（2026-11-13）**：[Spec 077](../077-personal-content-and-delivery/spec.md) 在 `derived.db` 新增投影 `delivery_state`、在讀取契約加共用參數 `delivery`（`operator`／`deliver`）與查詢鍵 `delivery:`，並刪除 FR-032 所列的 `sanitized_events`、`do_not_export` 兩表；FR-065 的「不匯出標記」topic 改為 `delivery`。


### 前提更正（已在程式碼確認）

- **第二條連線沒有讓讀取離開寫入的執行緒。** `src/core/db/index.ts:516-529` 與 `src/core/db/event-queries.ts:353` 的註解說唯讀連線讓重掃描「不會序列化擷取寫入」；better-sqlite3 是同步的，兩條連線都在主行程的 JS 執行緒上。分開連線解決的是 `index.ts:473-493` 記載的「connection is busy」，不是回應性（02 §1）。
- **Activity 的每一頁都數一次全專案。** `readActivitySnapshot`（`src/core/db/dataset-snapshot.ts:6-9`）對兩層各執行 `COUNT(*) … WHERE rowid <= ?`，那是 rowid 範圍走訪，列數隨專案成長；`activity-queries.ts:116` 在每次 `setup` 都呼叫它。02 沒有列出這一項。
- **body 索引由主行程寫。** ingest 在 commit 後呼叫 `linkHttpBodyEvent`（`src/core/ingest.ts:290`），搜尋呼叫 `sync`（`http-body-index.ts:276-314`），兩者都用 `getDB()`（寫入連線）讀來源列；retention 呼叫 `pruneHttpBodyIndex`／`pruneSavedFileIndex`（`retention.ts:94,97,341`）。
- **#701 已合併。** `useLivePagedQuery` 在 main 上（`src/renderer/src/hooks/useLivePagedQuery.ts`），`HttpHistoryPanel` 的飢餓 debounce 已不在；03 列的五處剩四處（`ScopeStatus.tsx:165`、`EvidenceHeader.tsx:33`、`TargetsScopeHeader.tsx:43`、`FirstRunView.tsx:164`）。
- **「顯示 6 筆，共 5 筆」仍在。** `ScreenshotsView.tsx:195` 只用第一頁的列計算 `triggerTotals`，`:286` 以它當總數，`:356` 顯示 shown／total；即時插入的截圖不更新它。
- `ipcMain.handle`／`ipcMain.on` 在 `src/` 共 179 處（`src/main/index.ts` 75、`src/main/ipc/events.ts` 37，其餘分散在 12 個檔案）。分級見 plan「主行程上的讀取」。

## User Scenarios & Testing *(mandatory)*

| 故事 | 優先級 | 摘要 |
|---|---|---|
| US1 重讀取不再擋住擷取與介面 | P1 | 搜尋、Activity、彙總在讀取服務執行；主行程不執行隨專案成長的讀取 |
| US2 剛寫入的立刻讀得到；晚到的舊回覆不覆蓋新的 | P1 | 提交序號與「至少到此」的讀取 |
| US3 狀態帶與效應數不隨篩選、分頁或載入範圍改變 | P1 | 全專案投影 |
| US4 第一次讀取與第 N 次成本相同；落後時明說 | P2 | 增量投影、「索引中，落後 N 筆」 |
| US5 每個數字只有一種意思 | P2 | 三種計數、一個格式化函式；消除「顯示 6 筆，共 5 筆」 |
| US6 跨頁只帶專案、時間範圍與選中事件；返回回到原處 | P2 | 導覽堆疊；篩選各頁持有 |
| US7 讀取服務出錯時照實說，擷取照常 | P2 | 重啟、退避、畫面狀態 |

### User Story 1 — 重讀取不再擋住擷取與介面（P1）

操作者在 25 萬列的專案中反覆搜尋、開 Activity、看目標頁，同時 shell hook 與 proxy 持續寫入。寫入不因讀取而延遲或進交接目錄；介面的捲動、輸入與 PTY 輸出不停頓；讀取慢時，慢的是那一個結果，不是整個 app。

**Why this priority**：02 在 25 萬列量到首次搜尋 21.5 s、重複搜尋 2.3–2.6 s、Activity 首開 11 s，全在主執行緒（機器負載約 15，絕對值偏高，比例可信）。主行程卡住超過 1 s，shell hook 就把事件改寫進暫存，擷取健康顯示延遲。

**Independent Test**：e2e 的事件迴圈延遲探針（FR-093）在腳本化的重讀取期間（搜尋、Activity 首頁、目標彙總，交錯即時寫入）回報超過 500 ms 的停頓為 0 次；失敗時訊息列出最慢的處理程式名稱。另以匯入邊界掃描（FR-091）證明主行程不匯入讀取服務專屬的函式。

**Acceptance Scenarios**：

1. **Given** 專案開著且有持續寫入，**When** 執行一次需要走訪全部 body 參照的文字搜尋，**Then** 主行程的事件迴圈沒有超過門檻的停頓，hook 沒有因逾時寫入交接目錄。
2. **Given** 一個長時間的文字搜尋正在執行，**When** 時間軸要求下一頁，**Then** 時間軸的頁不排在該搜尋之後（不同執行緒）。
3. **Given** 搜尋框連續輸入五個字元，**When** 前四個請求尚未開始，**Then** 它們被丟棄，只執行最後一個。
4. **Given** 匯出正在執行，**When** 時間軸讀取與計數，**Then** 照常回應（匯出在自己的 worker，本規格不改它）。

### User Story 2 — 剛寫入的立刻讀得到；晚到的舊回覆不覆蓋新的（P1）

操作者存一則事件註記或手動加一個標記，畫面立刻讀到它；兩個請求一前一後送出，先送的晚回，畫面上留的是後送的答案。

**Why this priority**：讀取移到另一條執行緒後，「寫完立刻讀」不再自然成立；03 F1 記錄了三種各自修補的「舊答案掛在新問題下」。

**Independent Test**：單元：寫入回傳提交序號 s，帶 `minSeq = s` 的讀取一定看到該列（含讀取執行緒忙碌、排隊、重啟的情形）。元件：同一個 key 的兩個請求以相反順序回覆，畫面只採用後者；不同 key 的回覆不會被當成目前 key 的答案。

**Acceptance Scenarios**：

1. **Given** 操作者存了一則註記（寫入回傳序號 s），**When** 畫面以 `minSeq = s` 讀取，**Then** 結果含該註記，即使讀取服務在兩者之間重啟過。
2. **Given** 時間軸從事件 A 換到事件 B，**When** A 的內容晚於 B 的請求才回來，**Then** 畫面不顯示 A 的內容在 B 的標題下（今天 `TimelineEventDetails.tsx:116` 的 `EventContentReader` 沒有 key，會）。
3. **Given** 同一個問題的兩次讀取，**When** 回覆的 `asOf.seq` 較舊的那個晚到，**Then** 被丟棄。

### User Story 3 — 狀態帶與效應數不隨篩選、分頁或載入範圍改變（P1）

操作者暫停錄製一分鐘，之後在時間軸只看 Shell 類型、搜尋、往回載入。暫停帶、終端 session、IP／VPN、目前目標、tunnel 的狀態帶一直在；一個 `ffuf` 指令旁的「+5000」不因只載入 200 列而變成「+37」，也不因「只看上鏈」而消失。

**Why this priority**：今天狀態帶由已載入、已篩選的列推得（`timelineIncremental.ts:471-486`、`timelineSessionBands.ts`），效應清單只算已載入列（`Timeline.tsx:963`）；HTTP 為 logged 層，「只看上鏈」時效應全部消失而計數不說（10 §A.4 #3、#6）。

**Independent Test**：同一組事件以三種載入範圍與五種篩選讀取，狀態帶的區間集合與每個動作的效應數完全相同；與「從零重算」的結果相同（FR-095 等價測試）。

**Acceptance Scenarios**：

1. **Given** 10:00–10:01 暫停，**When** 時間軸只看「Shell」類型，**Then** 10:00–10:01 仍畫出暫停帶。
2. **Given** 一個指令有 5000 個 caused effect，**When** 時間軸只載入最新 200 列，**Then** 該指令旁顯示的效應數是 5000（超過上限時為「上限+」），不是已載入的數目。
3. **Given** 一段時間 app 沒開（有 `project_closed` 紀錄），**Then** 該段呈現為「沒有在錄」；在 `project_closed` 出現之前建立的專案，該段為「是否在錄：未知」。
4. **Given** 一個指令產生了戰利品與範圍觀測，**Then** 它們以數目附著在該指令上；對應的泳道仍可展開列出全部。

### User Story 4 — 第一次讀取與第 N 次成本相同；落後時明說（P2）

重開大專案後第一次開 Activity 或搜尋，不再付全專案的成本；投影還在追趕時，畫面說「索引中，落後 N 筆」，而不是把不完整的結果當成完整的。

**Why this priority**：02 §2：投影在讀取時才追趕，「第一次讀取」永遠付全部成本；body coverage 每頁走訪全部參照（`http-body-index.ts:430-494`）。

**Independent Test**：工作量計數測試：同一個讀取在 1 萬列與 10 萬列的專案上，走訪的列數、執行的語句數與開檔數不隨總列數成長（FR-094）；第一次與第二次相同。落後測試：投影游標停在水位之下 N 列時，讀取結果的完整度為 `behind`，數值為 N。

**Acceptance Scenarios**：

1. **Given** 升級後第一次開啟一個 25 萬列的專案，**When** 開 Activity，**Then** 畫面立即可用；投影在背景追趕，期間結果標示「索引中，落後 N 筆」，追上後自動更新。
2. **Given** 投影已追上，**When** 重複文字搜尋，**Then** coverage 不再走訪全部 body 參照。
3. **Given** retention 刪除了 logged 層的舊列，**Then** 投影移除對應的衍生列，與從零重建的結果相同。
4. **Given** 投影版本升級，**Then** 只有該投影被丟棄並在背景重建，其他投影不受影響。

### User Story 5 — 每個數字只有一種意思（P2）

截圖頁不再出現「顯示 6 筆，共 5 筆」；有上限的結果一律寫「N+」；儀表板不再因兩個數字不在同一個快照讀出而閃出「證據鏈不一致」。

**Why this priority**：03 F3：同樣叫「事件」的數字算不同的東西；「Loaded N of M」有兩種意思；`useAppCounts.ts:99-102` 的四個計數各自讀、各自吞錯，失敗畫成 0。

**Independent Test**：每個清單畫面都在清單登記表中宣告它的計數種類與單位（FR-095）；登記表測試斷言每個清單都經 `formatCount`，沒有畫面自己組「{{shown}}／{{total}}」；性質測試：`exact` 總數下顯示的已載入數永遠不大於總數。

**Acceptance Scenarios**：

1. **Given** 截圖頁已載入全部 5 張，**When** 即時再進來 1 張，**Then** 總數同時變成 6，或標示為「6+」，不會出現「6／5」。
2. **Given** 擷取持續進行，**When** 儀表板讀取事件數與鏈長，**Then** 兩者來自同一個讀取交易，不一致只在真的不一致時出現。
3. **Given** 某個計數讀取失敗，**Then** 顯示為「—」並可重試，不是 0。

### User Story 6 — 跨頁只帶專案、時間範圍與選中事件；返回回到原處（P2）

操作者在範圍頁點「在時間軸開啟」越界的那筆事件：它在時間軸上看得到，即使時間軸自己的篩選本來會排除它（以「在此頁篩選之外」標示）。在目標頁點一列跳到時間軸，時間軸不被設上目標晶片；返回時目標頁的篩選、捲動位置與選取都還在。

**Why this priority**：03 F4：共用篩選是全域、隱性的狀態，跳轉後事件被篩選藏起來，畫面只給一個 ×；03 F5：位置與來源分散在 `App.tsx` 的十個 state。

**Independent Test**：導覽 reducer 的純函式測試（push、back、replace、深度上限）；元件測試：時間軸開著「範圍內」時，從範圍頁跳轉，該事件可見並標示；e2e：目標頁 → 時間軸 → 返回，目標頁狀態不變。

**Acceptance Scenarios**：

1. **Given** 時間軸的「範圍內」開著，**When** 從範圍頁跳到一筆越界事件，**Then** 該事件被畫出並標示在此頁篩選之外，時間軸的總數不變。
2. **Given** 目標頁選了 10.10.11.24，**When** 跳到時間軸，**Then** 時間軸的篩選不變，選中的事件與時間範圍帶過去。
3. **Given** 時間軸 → Activity → 返回 → 返回，**Then** 依序回到 Activity、再回到時間軸，各自的參數、捲動錨點與選取都還原。
4. **Given** 一個被保留但看不見的頁，**When** 即時寫入持續，**Then** 它不重讀；回到前景時若資料已變才重讀。

### User Story 7 — 讀取服務出錯時照實說，擷取照常（P2）

讀取執行緒崩潰或卡住時，擷取、寫入與錄製控制不受影響；畫面保留上次的結果並標示「讀取服務重新啟動中」，之後自動恢復。

**Independent Test**：故障注入：在讀取中終止 worker、在開啟時讓 `derived.db` 損毀、讓 worker 啟動失敗。斷言：寫入持續、主行程沒有改為自己執行查詢、畫面狀態為 `error` 並保留上次的值、重啟後讀取恢復、重啟次數有上限。

**Acceptance Scenarios**：

1. **Given** 讀取中 worker 崩潰，**Then** 進行中的請求以 `service-restarting` 失敗，畫面保留上次的值並標示，worker 依退避重啟，之後請求恢復。
2. **Given** `derived.db` 損毀，**Then** 檔案被丟棄並重建，期間讀取的完整度為 `behind`，證據檔不受影響。
3. **Given** 五分鐘內重啟達上限，**Then** 停止自動重啟，畫面顯示讀取服務無法使用並提供重試；擷取照常。

### Edge Cases

- 專案在請求排隊時被切換：請求帶 generation，不屬於目前 generation 的請求與回覆一律丟棄；讀取服務隨舊開啟一起停止。
- 同一個專案 A → B → A：generation 不同，A 第一次開啟的回覆不會被第二次開啟採用。
- logged 層的最大 rowid 被 retention 刪除，SQLite 之後重用該 rowid：投影以「游標所在列的 id」偵測，丟棄 logged 層衍生的部分並重建。
- retention 在刪除與寫入摘要列之間當掉：開啟時的背景檢查以兩層列數比對偵測，重建受影響的投影。
- 一個指令的 `_causes` 指向不存在（已被 retention 刪除）的列：計數照算，閱讀時標示「來源已被保留期刪除」。
- 投影追趕中又有大量寫入：落後數可能上升；畫面顯示目前的落後數，不閃爍成 0。
- 讀取的 `minSeq` 大於寫入者已提交的序號（不應發生）：請求被拒為 `bad-request`，不等待。
- 一個讀取在 `heavy` 執行緒執行超過預算且已被取代：該執行緒被終止並重啟；衍生資料庫的未提交交易由 SQLite 回復。
- 衍生資料庫的磁碟滿：投影停止推進並標示落後，讀取改由已物化部分加上有界的尾端回答；證據寫入不受影響。
- 舊專案沒有 `derived.db`：第一次開啟時在背景建立，不需停機遷移。
- 降版到 074 之前：舊版不讀 `derived.db`，照舊用 TEMP 投影；升回時檢查版本並重建。
- 匯出、bundle、HAR、`verify:package-resources` 的打包清單都不得包含 `derived.db`。
- 選中的事件在跳轉後被 retention 刪除：返回項目被丟棄，聚焦最近的列。
- 隱藏的頁所依賴的專案被關閉：隨專案的 reload 一起消失（今天換專案會 `window.location.reload()`）。

## Requirements *(mandatory)*

### Functional Requirements

#### A. 讀取服務（US1、US7）

- **FR-001** 每個開著的專案有一個讀取服務（`QueryService`），由專案執行期（Spec 073 的 `ProjectSession`）以資源的形式啟動與停止。它擁有：兩條讀取執行緒（`interactive`、`heavy`）、各自對 `timeline.db` 的唯讀連線、`derived.db` 的唯一寫入連線（在 `heavy`）、`http-body-index.db` 與 `cast-index.db` 的唯一寫入權（FR-040）。
- **FR-002** 讀取服務對外的介面是 `start(context)`、`stop()`、`health()` 與 `query(request)`；`health()` 回報 `starting | ready | restarting | unavailable`、每條執行緒的佇列長度、每個投影的落後數。專案執行期以外的程式不得啟動或停止它。
- **FR-003** 請求帶 `{id, generation, kind, params, minSeq, lane, supersedes?}`。`generation` 不等於目前開啟的請求，在送出前與回覆後都被丟棄。
- **FR-004** 每一種請求（`kind`）恰好宣告一條執行緒：`interactive`（成本 O(頁大小) 或索引 seek 的讀取）或 `heavy`（文字搜尋、Activity、彙總的重建、因果鏈、API 的 HAR 串流以外的大型讀取）。宣告是一張表，測試斷言每個 `kind` 都在表上。
- **FR-005** 同一個 `supersedes` 鍵（例如同一個搜尋框）在佇列中只保留最新的請求，較舊的以 `superseded` 回覆。執行中的請求被取代且已超過該 `kind` 的工作預算時，終止該執行緒並重啟；這是 better-sqlite3 唯一的中斷手段。
- **FR-006** 背壓：每條執行緒的佇列有上限（`interactive` 64、`heavy` 16）。超過時拒絕最舊的可取代請求；仍超過時以 `busy` 拒絕新請求。拒絕一律是明確的回覆，不是靜默丟棄。
- **FR-007** 用到連線本地狀態的查詢（TEMP 表、已註冊的 UDF、未提交的交易）固定在一條具名的連線上；這組查詢列在一張表中，測試斷言它們不會被派到另一條連線。TEMP 版 Activity 投影在 FR-041 落地後移除，這張表隨之縮小。
- **FR-008** 讀取執行緒不得跨請求持有讀取交易：每個請求開始新的交易、結束時結束它。測試斷言請求之間沒有開著的交易（WAL 的 checkpoint 才不會被餓死）。
- **FR-009** 崩潰、啟動失敗或被終止的執行緒依退避重啟（1、2、4、8、16、30 秒）；任一執行緒在五分鐘內重啟達五次即停止自動重啟，`health()` 為 `unavailable`，直到操作者重試或專案重開。進行中與排隊的請求以 `service-restarting` 或 `service-unavailable` 失敗。
- **FR-010** 讀取服務不可用時，主行程**不得**改為自己執行該查詢，畫面依 FR-064 的錯誤狀態呈現並保留上次的值。
- **FR-011** worker 程式以與匯出 worker 相同的建置路徑產生（`electron.worker.config.ts` 的另一個入口），放在 `app.asar` 內的 `out/main/`；不使用 `child_process.fork` 或 `utilityProcess`，`runAsNode`、`enableNodeOptionsEnvironmentVariable`、`enableNodeCliInspectArguments` 三個 fuse 維持關閉。打包檢查斷言 worker 檔存在於正式版產物中。
- **FR-012** `GET /api/events`、`/api/events/search`、`/api/events/count`、`/api/http-body/:sha` 的讀取經同一個讀取服務；`GET /api/export/har` 改走既有的匯出 worker。API 與 IPC 共用同一個派送函式，不各寫一份。
- **FR-013** 讀取服務啟動時預熱（開連線、註冊 UDF、讀投影狀態），讓開專案後的第一個讀取不付啟動成本；預熱不阻擋專案變為可用。

#### B. 讀到自己的寫入（US2）

- **FR-020** 寫入者（主行程，071 的 commit 階段）每次 commit 後回傳 `CommitReceipt = {seq, chainedMaxRowId, loggedMaxRowId}`（071 FR-096 擁有這個回傳值；本規格是它的消費者）。`seq` 是每個開啟從 1 起算、每次 commit 遞增的整數；一個交易內寫入多列只有一個 `seq`。`seq` 不寫入任何列。
- **FR-021** 每個寫入型 IPC 與 API 在回覆中帶回 `seq`。畫面發出的每個讀取帶 `minSeq`：它最後一次寫入或最後一次看到的變更通知的 `seq`，取大者。
- **FR-022** 派送者（主行程）在 `minSeq` 大於已提交序號時不送出請求：等到該序號提交為止（寫入改為非同步後才會發生），或在該開啟結束時以 `service-restarting` 失敗。`minSeq` 不可能大於下一個序號；這種請求以 `bad-request` 拒絕。
- **FR-023** 每個讀取結果帶 `asOf = {seq, chainedMaxRowId, loggedMaxRowId}`：`seq` 是送出時已提交的序號（結果至少反映到此），兩個 rowid 是讀取交易實際看到的水位。
- **FR-024** 持久保存的游標（分頁游標、Activity 的資料快照、投影游標）一律以兩層 rowid 加上游標所在列的 id 表示，不用 `seq`：`seq` 只在一次開啟內有意義。既有的 `ActivitySnapshot` 形狀相容。

#### C. 增量投影（US3、US4）

- **FR-030** 一個投影 = `(name, version, cursor, rebuild)`：`cursor` 是兩層各自處理到的 rowid 與該列的 id；`rebuild` 是從空開始依序處理全部列的同一份程式。增量推進與從零重建必須產生相同的內容（FR-095）。
- **FR-031** 投影一覽（每一項的存放、推進者與「時間 T 的狀態」見 plan「投影」表）：
  1. `activity`：Activity 的投影列與群組彙總（今天的 TEMP `activity_projection_v1`／`activity_groups_v1`）。
  2. `terminal_targets`：每個終端在每個時間點最後擷取到的目標（071 T024），供 071 的 `target_via = terminal-last` 與「目前目標」狀態帶使用。
  3. `intervals`：072 註冊表的 `INTERVALS`（`IntervalDef`：起訖、成員、配對鍵 `key`／`fallbackKey`、開放的意義）與 `STATES`（`StateDef`）所宣告的區間與階梯狀態，含缺口的資料範圍，含全域與每終端暫停、專案開／關、終端 session、tunnel、IP／VPN、目前目標、proxy 啟停、指令。
  4. `cause_counts`：每個來源列被多少列以 `caused` 指向，依 072 的角色（effect、annotation）與家族分開計數。
  5. `body_coverage`：body 與檔案搜尋的涵蓋計數（併入進行中的增量化，見 FR-046）。
  6. `kind_totals`：每層、每個種類、是否 housekeeping 的列數與首末時間；「已記錄總數」依 072 的 `counts.total` 加總，不另訂哪些種類計入。
  7. `target_totals`：每個正規化目標的列數、首末時間與顯示值（取代每次全表的 `aggregateTargets`）。
- **FR-032** 存放：`terminal_targets` 在 `timeline.db` 的新表（由寫入者在同一個 commit 交易內推進）；`body_coverage` 在 `http-body-index.db`；其他全部在 `derived.db`。既有的證據表（`events`、`events_logged`、`sanitized_events`、`do_not_export`、`event_notes`、`chain_anchors`、`operators`、`bookmarks`）不加欄位、不加 trigger、不被投影寫入。
- **FR-033** 每個衍生檔與衍生表都可整個刪除而不損失證據：刪除後在背景依序重建，結果與刪除前相同。`derived.db` 不進 bundle、NDJSON、HAR 或任何匯出，也不進打包資源（測試斷言）。
- **FR-034** `derived.db` 有一張 `projection_state(name, version, chained_cursor, chained_cursor_id, logged_cursor, logged_cursor_id, status, rebuilt_at)`。開啟時：某投影的 `version` 不符 → 只丟棄並重建該投影；檔案的 `user_version` 不符或無法開啟 → 整檔刪除重建。
- **FR-035** 推進：寫入者每次 commit 後把 `CommitReceipt` 送給讀取服務（同一輪事件迴圈內的多個合併為一個）。`heavy` 執行緒在請求之間以有界切片推進投影：每片最多處理 2000 列或一個交易，推進與 `projection_state` 更新在同一個交易內。
- **FR-036** 每個投影回報 `lag = (chainedMax − chainedCursor) + (loggedMax − loggedCursor)`。讀取依賴的投影 `lag > 0` 時：尾端不超過 5000 列就就地補算，結果為精確；超過就以已物化的部分回答，完整度為 `behind(lag)`，畫面顯示「索引中，落後 N 筆」。讀取絕不為了追上而同步走訪整個專案。
- **FR-037** retention：處理到 chained 層的 `system.retention_pruned_logged` 列時，刪除 logged 層衍生、`created_at ≤ newest_pruned_at` 的投影列並重算受影響的群組與計數。另外，每次開啟時在背景比對兩層列數與游標所在列的 id；不符（包括 logged 層 rowid 被重用、retention 在寫摘要前當掉）時，重建依賴 logged 層的投影。
- **FR-038** 損毀：`derived.db` 的任何語句回報 `SQLITE_CORRUPT` 或 `SQLITE_NOTADB` 時，讀取服務關閉該檔、刪除、重建，期間相關讀取為 `behind`。`http-body-index.db`、`cast-index.db` 同此規則。衍生檔的損毀不是證據事件，不寫入鏈；它出現在讀取服務的 `health()`。
- **FR-039** 每個投影對每一列新事件的推進成本有上限，以工作量計數：`activity` 1 列插入加 1 次群組更新；`intervals` 至多 2 次寫入；`cause_counts` 每個 `caused` 參照 1 次 upsert（每列至多 32 個，超過的部分計入 `cause_counts_truncated`）；`kind_totals`、`target_totals` 各 1 次 upsert；`terminal_targets` 至多 1 次插入。
- **FR-040** 衍生檔各只有一個寫入者：`derived.db`、`http-body-index.db`、`cast-index.db` 都由 `heavy` 執行緒寫。主行程不再直接寫它們：ingest 的 `linkHttpBodyEvent`、retention 的 `pruneHttpBodyIndex`／`pruneSavedFileIndex`／`pruneCast`、終端的 `indexCast` 改為送訊息給讀取服務。
- **FR-041** Activity 的投影從連線內 TEMP 表改為 `derived.db` 中的持久表，schema 與分頁游標語意不變（`within()` 以 rowid 界定）；每頁不再對兩層執行 `COUNT(*) … WHERE rowid <= ?`，資料快照的一致性改以游標所在列的 id 與 retention 世代判斷。
- **FR-042** 「時間 T 的狀態」由 `intervals` 回答：`stateAt(timestamps[], keys[])` 一次查詢回傳每個時間點、每個鍵（全域或某終端）的狀態值與它的來源列 id；一頁 200 列一次呼叫。
- **FR-043** 區間的結束依據為封閉列舉：`observed`（有對應的結束列）、`data-range`（起訖在列內）、`superseded`（被下一個同鍵狀態取代，或終端結束、專案關閉）、`open`（尚未結束，延伸到現在）。沒有結束列的區間不被寫成失敗。
- **FR-044** 專案開／關：`project_closed`（O6）與下一個 `session_start` 之間是「沒有在錄」；`project_closed` 種類出現之前的專案，兩次 `session_start` 之間沒有 `project_closed` 的那一段為「是否在錄：未知」。
- **FR-045** `cause_counts` 只計 `caused` 參照；`candidate`（例如 `file_created` 的 `related_commands`）另計為「可能相關」，永不併入效應數（Domain Invariant 6）。
- **FR-046** body 搜尋涵蓋：`bodySearchCoverage` 不再每頁走訪全部 body 參照；改由 `body_event_refs` 的狀態變更以差量維護每種來源 × 狀態的數目與位元組，`revision` 為單調遞增的整數。`recheck` 不再每次搜尋執行，改為背景週期、有界切片。進行中的增量化（`work/1112-search`）以本條為準併入，不另寫一份規格。
- **FR-047** 投影的推進不得改變任何讀取的語意：同一個問題在追上之後的答案，與今天在主行程直接執行的答案相同（等價測試，FR-095）。
- **FR-048** 缺口重疊：`gapOverlaps(rowIds[])` 一次查詢回答每一列的時間區間是否與一筆缺口紀錄（072 `IntervalDef('capture-gap')`：`scanner:capture_gap`、`system:capture_gap` 的資料範圍）重疊，並回傳該缺口列的 id；由 `intervals` 投影回答（`interactive`）。這是 072 `completenessOf(kind, data, overlapsGap)` 的 `overlapsGap` 唯一的來源（072 FR-034、plan D5）；在本條落地前，072 以已載入的缺口列判斷並標明是有限的判斷。

#### D. 讀取契約（US2、US5、US6）

- **FR-060** 查詢鍵就是問題：`QueryKey = {project, generation, view, params}`，`params` 為該讀取的全部輸入（含該頁的篩選），以穩定序列化比較。兩個鍵相等，若且唯若它們問同一個問題。
- **FR-061** 結果項目的形狀：`{key, status: 'pending' | 'success' | 'error', fetching: boolean, data, dataKey, isPlaceholder, asOf, completeness, error?}`。`status` 說有沒有這個問題的答案，`fetching` 說是否正在讀；兩者分開。
- **FR-062** 只有 `dataKey === key` 時，`data` 才能被當成這個問題的答案呈現。換鍵時若該畫面宣告「保留舊資料」，舊資料以 `isPlaceholder = true` 呈現並標示為先前條件的結果；否則為 `pending`。清單類預設保留、詳情類預設不保留。
- **FR-063** 晚到的回覆依 `(key, requestId)` 與 `asOf.seq` 丟棄：不是目前 key 的、不是該 key 最新請求的、`asOf.seq` 小於現有值的，一律不套用。
- **FR-064** 非資料狀態只有一個呈現元件，固定六種：首次載入、首次失敗（「無法讀取 {主詞}。這不代表沒有資料。」加重試）、刷新失敗（疊在舊資料上、附讀取時間）、沒有專案、空（列出生效中的條件）、部分（`capped`／`behind`／`truncated`）。讀取服務重啟屬於刷新失敗或首次失敗，不另立第七種。
- **FR-065** 變更通知：寫入者每次 commit 後送出 `data:changed {project, generation, seq, topics}`；topics 是封閉集合（plan「主題」），由 072 註冊表的角色與家族推導，加上非事件的寫入（設定、範圍規則、書籤、註記、不匯出標記）。每條寫入路徑寫完後都發出至少一個 topic（契約測試）。
- **FR-066** 畫面的讀取以 key 宣告它在意的 topics；收到交集的 topic 時標記為過時；**有可見的訂閱者**才重讀，重讀頻率由每個 key 的最小間隔限制，且最後一次一定會讀到。看不見的訂閱者不重讀，回到可見時若已過時才重讀。
- **FR-067** 需要「列本身」的畫面（時間軸的即時列、終端、截圖的插入）保留 `events:new-batch`；其准入仍由主行程用與分頁相同的述詞判斷（`matchIds`）。其他畫面不得訂閱原始批次：計數、彙總、清單刷新、設定一律經 topic。
- **FR-068** 分頁一律用游標；`hasMore` 與總數分開。總數取得代價高或有上限時，回 `atLeast` 或 `unknown`，不得為了總數走訪全專案。
- **FR-069** `useLivePagedQuery` 成為建立在同一個 key／項目模型上的分頁變體，`live.affects`（對原始批次的述詞）改為 topics；`createThrottledRead` 只作為登記表內部的節流原語，元件不得直接使用；`useReadState` 成為過渡用的薄包裝，最後移除。

#### E. 計數（US5）

- **FR-070** 計數只有三種：`exact(n)`、`atLeast(n)`（顯示「n+」）、`unknown`（顯示「—」，可說明原因）。每個數字帶單位名詞（事件、命中、flow、目標、觀察、截圖）。
- **FR-071** 清單的完整度另成一欄（型別名 `ListCompleteness`，與 072 閱讀器第一行的 `Completeness`「完整性」是不同的東西）：`complete`、`more`（有下一頁）、`capped(limit)`、`truncated`、`behind(lag)`。「已載入 n／共 N」只在總數為 `exact` 時出現；否則寫「已載入 n／N+」或只寫 n 加上 `more`。
- **FR-072** 所有畫面的數字經同一個 `formatCount({count, unit, of?, completeness})`；i18n 中 `{{shown}}`／`{{total}}` 這類成對的鍵只能由它使用。三組 `*.recentSubset` 收成一組。
- **FR-073** 性質：`exact` 總數下，顯示的已載入數永遠不大於總數；即時插入使已載入數超過已知的 `exact` 總數時，總數改為 `atLeast` 或重新讀取，不得呈現「6／5」。
- **FR-074** 成對的數字（事件數與鏈長、chained 與 logged）由同一個讀取交易回傳（`counts:snapshot`），畫面一次套用；證據鏈不一致的判斷只用同一個快照。
- **FR-075** 讀取失敗的計數是 `unknown`（「—」並可重試），不是 0。

#### F. 導覽與跨頁語境（US6）

- **FR-080** 導覽是一個堆疊，每一項 `NavEntry = {view, params, scrollAnchor: {rowId, offset}, selection}`。明確的跳轉（從 A 的某一列到 B）推入；側欄、快捷鍵、命令面板的移動取代整個堆疊。深度上限 3。返回彈出並還原參數、以錨點列還原捲動（不用像素）、還原選取；選取已不存在時聚焦最近的列。
- **FR-081** 最多保留一個看不見但仍掛載的頁（堆疊中目前頁的下一層，若該頁可保留）；它保留狀態但取消訂閱（FR-066）。其他項目返回時重新掛載，由 `params` 與錨點還原。
- **FR-082** 可見性只有一個來源：App 為每個掛載中的頁提供 `visible`；讀取登記表、匯出的「此頁」範圍、捲動保留都從它推導。各元件的 `active` prop 移除。
- **FR-083** 匯出的「此頁」範圍只接受可見頁的貢獻。
- **FR-084** 選中事件的鍵帶專案 id（今天的 `redlog-timeline-focus-event` 不分專案）。
- **FR-085** 跨頁語境只有三項：專案、時間範圍、選中的事件（O3）。目標、類型、範圍內、個人流量、tier 這五項篩選改為各頁持有，每頁每專案一份，存於記憶體，專案開啟時歸零（與今天相同）；時間軸的查詢框照舊依專案保存。
- **FR-086** 跳轉帶 `reveal: eventId`。目的頁收到 `reveal` 而該事件不符此頁篩選時，該事件仍被呈現並標示「在此頁篩選之外」，此頁的總數不變；這是一次性的，不改此頁的篩選。
- **FR-087** 從目標頁跳到時間軸，帶選中事件與時間範圍，不設定時間軸的目標篩選（取代 Spec 038 FR-005）。
- **FR-088** 每頁宣告它套用的條件集合；「空」與「部分」狀態列出此頁生效中的條件（含 housekeeping 排除、查詢框、上限），由 FR-064 的同一個元件呈現。

#### G. 閘門（全部）

- **FR-090** 主行程的每個 IPC 處理程式經 `registerHandler(channel, {cost}, fn)` 登記，`cost ∈ constant | indexed | service | write | file`；掃描測試拒絕 `src/main/**` 中裸的 `ipcMain.handle(`／`ipcMain.on(`，白名單只能變短。`indexed` 等級必須在 `test/query-plans.test.ts` 有 `EXPLAIN QUERY PLAN` 斷言。`service` 等級的處理程式在主行程只能是轉送給讀取服務的薄代理。API 路由同樣登記。
- **FR-091** 匯入邊界：`src/main/**`（`query-worker.ts` 除外）與 `src/core/api-server.ts` 不得匯入讀取服務專屬的符號（`getReadonlyDB`、`openReadOnlyDB`、`db/activity-queries`、`db/event-aggregates`、`http-body-index` 的讀取與寫入函式、`cast-index` 的寫入函式、`executeEventQuery`、`queryEvents` 等，清單在 plan）；基準值只能下降，最後為 0。
- **FR-092** 衍生檔的單一寫入者：掃描斷言只有 `query-worker.ts` 的模組圖會開啟 `derived.db`、`http-body-index.db`、`cast-index.db` 的可寫連線。
- **FR-093** 事件迴圈延遲探針：主行程在 e2e（`testHooks.e2e`）下以 `monitorEventLoopDelay` 取樣，並記錄每個處理程式與 API 路由超過 100 ms 的執行 `{name, ms, at}`；經測試專用路由回報。e2e 的共用 fixture 在每個 spec 結束時斷言：排除開專案後 2 秒，超過 500 ms 的停頓為 0；失敗訊息列出最慢的處理程式。p99 與最大值寫入 artifact，不作斷言。
- **FR-094** 工作量計數：每個移入讀取服務的 `kind` 與每個投影，在 1 萬列與 10 萬列的專案上計算走訪的列數、執行的語句數、開檔數與 lstat 數；`interactive` 讀取與投影推進的每列成本不隨總列數成長（比值 < 1.5）；文字搜尋的 coverage 不隨 body 參照數成長。牆鐘比例只在 `REDLOG_PERF=1` 時執行。
- **FR-095** 投影等價：每個登記的投影都有一個性質測試：隨機的事件腳本（含兩層交錯、同毫秒、retention 刪除、logged rowid 重用、重啟、版本升級、切片中斷）下，增量推進的內容等於從零重建的內容。登記表測試斷言每個投影都有這個測試。
- **FR-096** 計數語意：清單登記表列出每個呈現清單或計數的畫面、它的計數種類與單位；測試斷言每個登記的畫面都經 `formatCount`，未登記的畫面若出現成對的計數鍵即失敗。
- **FR-097** 讀取守門（ratchet）：計算 `components/**` 中不經 `useQuery`／分頁變體的 `window.redlog.<area>.<read>(` 呼叫、讀取上的 `.catch(() => {}|null|[]|undefined)`、直接訂閱 `onNewBatch` 的元件數；三個數字只能下降。

#### H. 呈現後果（只陳述，不設計外觀）

- **FR-100** 指令是區間：時間軸能取得每個指令的起訖（`intervals`），未結束的延伸到現在；不再在配對後隱藏起點（今天 `Timeline.tsx:178-179` 的做法）。外觀由 UIUX-STANDARD 決定。
- **FR-101** 效應以數目附著在它的動作上，數目來自 `cause_counts`，不是已載入的列；超過顯示上限寫「上限+」。沒有 `caused` 參照的效應留在自己的來源泳道，以來源命名。
- **FR-102** 一個動作有上千個效應時，時間軸取得的是「數目加上按時間分桶的密度」（`cause_counts` 加 `intervals` 的範圍查詢），不是逐列；逐列只在 Activity 的成員清單分頁讀，附總數。
- **FR-103** 狀態帶讀 `intervals`，不讀已載入或已篩選的列；任何篩選、搜尋、往回載入都不改變狀態帶。
- **FR-104** 註記（戰利品、範圍觀測、清理、憑證使用、pivot 偵測）以數目附著在來源指令上（O4），來自 `cause_counts` 的 annotation 角色；泳道保留為完整清單。

### Key Entities

- **讀取服務（QueryService）**：一個開啟的專案擁有的資源，兩條讀取執行緒加派送者。
- **提交回執（CommitReceipt）**：`{seq, chainedMaxRowId, loggedMaxRowId}`，寫入者在每次 commit 後產生。
- **查詢鍵（QueryKey）與結果項目（Entry）**：畫面的問題與它的答案、狀態、完整度。
- **投影（Projection）**：`(name, version, cursor, rebuild)`，由有序的事件紀錄推進的衍生資料。
- **主題（Topic）**：變更通知的單位。
- **計數（Count）與清單完整度（ListCompleteness）**：三種計數、五種完整度；不同於 072 閱讀器的「完整性」（`Completeness`）。
- **導覽項目（NavEntry）**：堆疊中的一個位置。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** e2e 全部 spec 在 ubuntu CI 上，事件迴圈延遲探針回報超過 500 ms 的停頓為 0（開專案後 2 秒除外）。
- **SC-002** 主行程中 `service` 等級的讀取：基準為 plan 的盤點數，最後為 0（只剩薄代理）；匯入邊界違規數最後為 0。
- **SC-003** 文字搜尋重複執行時，coverage 走訪的 body 參照數為 0（今天為全部）；Activity 每頁走訪的事件列數與專案大小無關。
- **SC-004** 七個投影各通過至少 1,000 組隨機腳本的等價測試。
- **SC-005** 讀到自己的寫入：10,000 組隨機「寫入→帶 minSeq 讀取」（含讀取服務重啟）全部看到自己的寫入。
- **SC-006** 「顯示 6 筆，共 5 筆」型的呈現在清單登記表的每個畫面上為 0（性質測試）。
- **SC-007** 沒有新頁面、沒有新的路由；新增的介面字串每個語系不超過 8 個 key，且通過 `test/ui-copy.test.ts`；讀取失敗類的 i18n 鍵數只減不增。
- **SC-008** 讀取守門的三個數字（FR-097）從 plan 的基準開始只降不升；直接訂閱原始批次的元件從 22 個檔案降到只剩需要列本身的畫面。
- **SC-009** 正式版產物（mac、Windows、Linux 各一）啟動時讀取服務進入 `ready`，打包檢查找到 worker 檔，fuses 與今天相同。

## Assumptions

- 單一使用者、單機、單視窗（加 HUD overlay）。讀取服務的威脅模型與 `timeline.db` 相同：同使用者的程序可以改寫衍生檔；衍生檔被竄改只影響呈現，閱讀器顯示事件內容時仍讀證據列與驗證過的附件。
- SQLite 維持 WAL；不同執行緒上的唯讀連線各自看到自己交易開始時的快照（SQLite isolation 文件）。
- worker 中載入 better-sqlite3 原生模組在三平台的正式版可行：匯出 worker 已在 CI 三平台 unit 與打包中證明（`src/main/services/export-runner.ts:39-42`、`export-worker.ts:24`）。
- 02 的絕對數字在負載約 15 的機器上量得；本規格的閘門不依賴絕對時間。
- 依賴：階段 0 的略過記帳（#706）；Spec 071 的 commit 階段（提交回執由它回傳）與 `_causes` 的指令 id（O18）；Spec 072 的種類註冊表；Spec 073 的專案執行期資源介面。各依賴未落地時的過渡做法見 plan「依賴順序」。

## 不在範圍

- 寫入路徑本身：信封、蓋章、回執、遺失帳本（071）；把 ingest 的推導 CPU 移到 worker（02 §3 的 (c)）。
- 種類、角色、閱讀器、housekeeping 規則的定義（072）。本規格只消費註冊表。
- 專案執行期、設定範圍、安裝帳本（073）；本規格只實作它定義的資源介面。
- 來源狀態模型與詞表（075）。
- 狀態帶、區間、效應數、密度在畫面上的外觀（UIUX-STANDARD）；本規格只保證資料與其語意。
- 匯出 worker 的行為；bundle、NDJSON、HAR 的格式。`intervals.jsonl` 與 `kinds.json` 是否隨匯出附帶（10 §E.9）是 Spec 072 的開放問題 Q3。
- 渲染端與 worker 之間的直接 MessagePort。
- 保存查詢、跨專案搜尋、多視窗。
- 依行數拆 `Timeline.tsx`；以資料生命週期抽出 hook（03 F6）只在本規格的讀取模型落地後、由另一項工作進行。

## 與既有文件、程式註解與相鄰規格的衝突

| 位置 | 現在說的 | 本規格 |
|---|---|---|
| Spec 038（Verified）FR-001、FR-004（「共用篩選」部分）、FR-005、FR-011，及其 SC-007 | 共用篩選套用到每個事件視圖；從目標頁到時間軸設定共用的目標晶片並跨頁保留；tier 是每頁都套用的共用條件 | 篩選各頁持有；跨頁只帶專案、時間範圍、選中事件（FR-085–FR-087）。這是契約替換，038 的對應 FR 需標註被 074 取代 |
| `e2e/timeline-evidence.spec.ts:115-176`（`target-focus` 一組：「arriving from a target sets the shared target chip」「navigating away and back keeps the target」） | 斷言共用目標晶片 | 改為斷言選中事件與時間範圍帶過去、時間軸篩選不變、返回還原（T072） |
| `e2e/timeline-track.spec.ts:637-664` | 在時間軸斷言 FilterBar 的「Chained only」晶片 | tier 晶片若保留為時間軸自己的篩選，斷言改為此頁的晶片；需重讀確認（T072） |
| `e2e/app-shell.spec.ts:143`、`e2e/layout-reliability.spec.ts:116-129`、`e2e/layout-read-states.spec.ts:81` | 「existing shared FilterBar」、FilterBar 面板的版面與讀取失敗 | 版面斷言大致不變；註解與共用語意的斷言隨 T072 檢查 |
| `test/shared-filter-views.test.tsx`、`test/shared-filter-live-lists.test.tsx`、`test/targets-open-in-timeline.test.tsx`、`test/filter-bar-tier.test.tsx` | 斷言每個視圖套用共用篩選 | 改為每頁篩選與 `reveal`（T071） |
| `docs/UIUX-STANDARD.md:190,196`、`docs/domain/SPEC-target-identity.md:16,113`、`docs/domain/SPEC-search-query-semantics.md:4,25,51,90,168-170` | 共用篩選的語意 | 同一個變更中改寫（T073） |
| `src/core/db/activity-queries.ts:46-47` 註解 | 「Connection-local derived index. Closing a project drops it」 | 改為持久、可丟棄的 `derived.db`；「no cache enters an evidence bundle」保持並加測試 |
| `src/core/db/index.ts:516-529`、`src/core/db/event-queries.ts:353` 註解 | 第二條連線讓重讀取不擋寫入 | 前提錯誤；`getReadonlyDB` 在主行程的使用移除後刪除這段說明 |
| `src/renderer/src/lib/returnTrail.ts:1-5` | 「This is not a history stack」，至多三步 | 換成深度 3 的導覽堆疊（FR-080） |
| `src/renderer/src/lib/keptOrigin.ts:11-12` | 被保留的頁仍隨即時批次與共用篩選變更重讀 | 被保留的頁取消訂閱（FR-081） |
| `docs/research/PRIOR-ART-D` S1 | 建議寫入者也在 worker | 寫入者留在主行程（決定 1）；研究不是需求 |
| Spec 071 plan D2／tasks T024（起草時） | `terminal_targets` 開專案時回填、可中斷（未說在哪條執行緒） | 已於 2026-11-12 對帳時改寫 071：回填在本規格（`heavy` 計算，主行程以小交易依序寫入，plan D5、T052）；推進仍在 071 的 commit 交易內；回填完成前的新列 `target_via: "none"`、永久（071 FR-010） |
| 憲章 IX（架構節制） | 新的層要有量測證據 | 證據為 02 的量測（比例）與本規格 Phase 1 的工作量基準；Phase 2 之前先產出 |

## 開放問題（需要擁有者）

> **2026-11-12 擁有者答覆**：Q1–Q5 均照「建議」欄採納。這是決定，尚未實作。

起草者回報、尚待擁有者答覆的五項（建議為起草者的建議；答覆前，相關 FR 以建議的做法為準）：

| # | 問題 | 建議 |
|---|---|---|
| Q1 | 狀態列的總數算每一筆紀錄（含內務列），還是只算登記表上非內務的列？ | 只算非內務的列，文案改為「已記錄」 |
| Q2 | 各頁的篩選要不要跨重開保存？ | 與今天相同：存在記憶體，開專案時歸零；時間軸的查詢框照舊依專案保存 |
| Q3 | 升級後大專案第一次開活動紀錄、投影還在追趕時，顯示標示「落後」的部分結果，還是追上前不給用？ | 顯示部分結果並標示 |
| Q4 | 返回時保留幾個隱藏但仍掛載的頁面、路徑多深？ | 保留 1 頁、深度 3 |
| Q5 | 「只看上鏈」是以儲存層命名的顯示篩選：各頁是否保留？ | 只留在有篩選列的頁面，並另外改名 |

除上表外：取代 Spec 038 共用篩選是擁有者已做的決定（O3）。相關但由他規格擁有的：匯出是否附 `intervals.jsonl`（Spec 072 Q3）；`_causes` 帶指令 id 的 O18 尚待 071 展開為 FR 與任務（影響 `cause_counts` 的完整度，不阻擋本規格任何 Phase）。

## Domain References

- `.specify/memory/constitution.md` I、II、IV、VI、VII、VIII、IX。
- `docs/domain/glossary.md`：Event、Chained／Logged Event、Activity；Domain Invariant 1、5、6、7、9。本規格新增的術語（提交回執、投影、主題、計數種類）在 T090 寫入 glossary。
- `docs/domain/INVENTORY-query-completeness.md`、`SPEC-search-query-semantics.md`、`SPEC-target-identity.md`。
- `docs/design/DESIGN-project-runtime.md`、`DESIGN-logged-tier-retention.md`。
- Spec 017、026、038、069、071。
