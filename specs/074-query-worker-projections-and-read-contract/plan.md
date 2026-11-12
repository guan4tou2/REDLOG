# Implementation Plan: 查詢工作執行緒、增量投影與讀取契約

**Branch**: `spec/072-075-contracts` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

## Summary

讀取離開主行程：每個開著的專案一個讀取服務，兩條 `worker_threads`（`interactive`、`heavy`），以唯讀連線讀 `timeline.db`。衍生資料改為由有序事件紀錄推進的投影，持久化在可丟棄的 `derived.db`（`terminal_targets` 例外，在寫入交易內推進），每個投影有版本、游標、重建規則與等價測試。寫入者留在主行程，每次 commit 回傳提交回執；讀取帶「至少到此」的序號。畫面以「問題」為鍵讀取，依 topic 失效，計數只有三種，導覽是堆疊，跨頁只帶專案、時間範圍與選中事件。每條規則有一個會失敗的閘門。

## Technical Context

| 項目 | 值 |
|---|---|
| 語言／執行期 | TypeScript；Electron 主行程與 `worker_threads`；React renderer |
| 儲存 | SQLite（better-sqlite3，WAL）：`timeline.db`（證據，主行程唯一寫入）、`derived.db`（新，衍生）、`http-body-index.db`、`cast-index.db`（既有，衍生） |
| 測試 | Vitest（unit／元件／性質）、Playwright e2e（只在 ubuntu CI；本機不跑 Electron e2e） |
| 建置 | `electron.worker.config.ts` + `scripts/build-export-worker.mjs`（擴充為多入口），electron-builder，fuses 由 `scripts/verify-fuses.mjs` 讀回 |
| 平台 | macOS、Windows、Linux；worker 中載入原生模組已由匯出 worker 證明 |
| 效能目標 | 以工作量計數表達（spec FR-094）；牆鐘比例只在 `REDLOG_PERF=1` |
| 限制 | 不改雜湊、不改既有列；不新增頁面；不引入狀態函式庫或 DI 容器 |

## Constitution Check

| 原則 | 本規格 | 結果 |
|---|---|---|
| I 證據完整 | 投影只讀證據列；衍生檔可整檔刪除；證據表不加欄位或 trigger | 通過 |
| II 呈現誠實 | `behind(lag)`、`atLeast`、`unknown`；刷新失敗保留舊值並標示 | 通過，且是本規格目的 |
| III 單一實作 | 一個派送者、一個計數格式化、一份 topic 分類；housekeeping 規則屬 072 | 通過 |
| IV 查詢完整 | 分頁以游標；總數分開；上限明示 | 通過 |
| V 預覽／執行一致 | 不改匯出；匯出快照仍為 rowid 水位 | 不受影響 |
| VI 明確失敗 | `superseded`、`busy`、`service-restarting`、`service-unavailable` 都是明確回覆；計數失敗為 `unknown` | 通過 |
| VII 來源可追 | `cause_counts` 保留來源列 id；`candidate` 永不併入 `caused` | 通過 |
| VIII 先測試 | Phase 1 只加測試與閘門；行為變更先 RED | 通過 |
| IX 架構節制 | 新的層：讀取服務、投影執行器、讀取登記表。證據：02 的量測比例與 Phase 1 產出的工作量基準；每一層對應一個已存在的重複（見「取代什麼」）。Phase 2 開工前把基準寫進 `verification.md` | 有條件通過 |

## 現況（程式碼確認，2026-11-12，`main@56c9fe6c`）

- 讀取連線：`getReadonlyDB()`（`src/core/db/index.ts:530-535`）是主行程上的一條快取唯讀連線；`openReadonlyProjectDB()`（`:500-509`）讓 worker 以模組單例開唯讀連線並遞增 generation；`dbGeneration()`（`:40-41`）在每次開關時前進。`getReadonlyDB()` 在 `src/` 有 36 個呼叫點（12 個檔案）。
- Activity：`register()`（`activity-queries.ts:24-71`）在連線上註冊三個 JS UDF 與兩張 TEMP 表；`syncProjection`（`:150-189`）在讀取時以 rowid 水位追趕；每頁 `setup` 呼叫 `readActivitySnapshot`（`dataset-snapshot.ts:4-14`），後者對兩層各做一次 `COUNT(*) WHERE rowid <= ?`；`queryActivityPage` 以 `COUNT(*) OVER()` 物化全部群組（`:285`）。retention 改動 rowid 時整個清掉重建（`:153-161`）。
- body 索引：`http-body-index.db`（`user_version` 7，`http-body-index.ts:17-39`）；`sync`（`:276-314`）與 `bodySearchCoverage`（`:430-494`）用 `getDB()`；coverage 每頁走訪全部 content-ref 列並 `JSON.parse` 每列、每個參照一次索引查詢；`recheck`（`:331-349`）每次搜尋對每個已驗證參照 lstat、重連結每個 missing／failed 參照。寫入者：ingest（`ingest.ts:290`）、搜尋、retention（`retention.ts:94,97,341`）。
- cast 索引：`cast-index.db`（`cast-index.ts:102-140`，`user_version` 2）；寫入者：終端關閉時 `indexCast`（`terminal-manager.ts:187`）、`casts:search` 前的 `backfillCastIndex`（`ipc/terminal.ts:131-137`）、retention 的 `pruneCast`（`retention.ts:91,508`）。
- 排序：`event-order.ts` 定義 `(timestamp, rowId, tierRank)`；`query-page.ts` 的游標 `(ts, row, tier)`；兩者不變。
- 即時：主行程每輪事件迴圈把整批 `RedLogEvent[]` 推給 `events:new-batch`（`src/main/index.ts:1617-1631`）；renderer 有 23 個 `onNewBatch` 訂閱點、22 個檔案。
- 畫面讀取：`readState.ts`（三相、無身分）、`createThrottledRead`（`throttledRead.ts`，序號防舊回覆）、`useLivePagedQuery`（#701，以 `key` 換題）。
- 導覽：`App.tsx:77-174` 有 `view`、`focusEvent`、`trail`、`kept`、`workspaceProject`、`readingRequest`、`activityQuery`、`timelineReturn`、`settingsRequest` 等 state；`returnTrail.ts`（至多三步，不是堆疊）、`keptOrigin.ts`（保留一頁、DOM 快照還原捲動、隱藏時仍重讀）。
- 專案執行期：`src/core/project-runtime.ts` 的 `ProjectRuntime`（generation、`signal`、`onStop`、`setInterval`／`setTimeout`）已存在；073 會在其上定義資源介面。
- 打包：`electron-builder.yml:6-8` 把 `out/**` 打進 asar；`electronFuses` 關閉 `runAsNode`、`enableNodeOptionsEnvironmentVariable`、`enableNodeCliInspectArguments`，註解（`:58-60`）明說「workers are worker_threads … no child_process.fork or utilityProcess」，`test/package-fuses.test.ts` 守住。`scripts/build-export-worker.mjs` 建 `out/main/export-worker.js`，`pretest` 與 `build` 都跑它。

## 主行程上的讀取（盤點與分級）

分級：**constant**（O(1) 或快取）、**indexed**（索引 seek／有界走訪）、**service**（成本隨專案成長，要移到讀取服務）、**write**、**file**（成本由單一檔案大小決定）。成本欄以工作量表示，是由程式推得的估計；Phase 1 的 T010 以計數測試釘住實際值後才用來排序。

| 通道（file:line） | 核心函式 | 分級 | 工作量（N=兩層總列數，R=body 參照，F=body 檔，G=Activity 群組） | 移動順序 |
|---|---|---|---|---|
| `events:runQuery`（`ipc/events.ts:62`）、`GET /api/events/search`（`api-server.ts:430`） | `executeEventQuery` | service | 文字：R 列走訪 + R 次 `JSON.parse` + R 次索引查詢（coverage）；F 次 lstat 與 missing 參照的重讀（recheck）；FTS | 1 |
| `events:activityPage`／`activityMembers`（`:81-82`） | `queryActivityPage`／`Members` | service | 首開：N 列 × 3 UDF；每頁：2 次 rowid 範圍 COUNT（N）+ `COUNT(*) OVER()`（G）；文字：再加上一列 | 2 |
| `events:sourceSessions`（`:77`） | `querySourceSessions` | service | 每頁 `readActivitySnapshot`（N）+ 該頁 | 2 |
| `events:aggregateTargets`（`:148`） | `aggregateTargets` | service | 兩層全表 GROUP BY（N），回傳全部目標 | 3 |
| `events:distinctHosts`（`:156`） | `distinctHosts` | service | 兩層全表 `json_extract`（N） | 3 |
| `events:distinctAgentTypes`（`:145`） | `distinctAgentTypes` | service | 兩層 DISTINCT（索引走訪，N） | 3 |
| `events:count`／`events:span`（`:125,132`） | `countEvents`／`spanEvents` | service | 依述詞；無可用索引時 N | 4 |
| `events:query`（`:42`） | `queryEvents` | service | `limit` 未夾限（02 §0：-1 即全表） | 4 |
| `events:matchIds`（`:137`） | `matchEventIds` | indexed | ≤1000 個 id 的述詞檢查 | 5 |
| `events:queryPage`／`queryHttpFlowPage`／`queryScreenshotPage`（`:45,50,151`） | 分頁 | indexed（篩選可走索引時） | 頁大小；篩選不能用索引時 N | 5 |
| `events:commandOutput`／`commandEnds`／`queryByFlowId`／`streamCompletion`／`toolCounterparts`（`:159-171,142`） | 各自 | indexed | ≤2000 列或單一 flow | 5 |
| `events:causalChain`（`:178`） | `queryEventCausalChain` | service（heavy） | 深度 × 每層 seek | 5 |
| `events:getById`（`:173`） | `queryEventById`（`getDB()`） | indexed | ≤200 次 PK seek | 留在主行程（allowlist） |
| `events:getCount`（`:55`） | `getEventCount` | constant（chained 有快取）／indexed（logged COUNT） | logged：B-tree count | 改為 `counts:snapshot`（service） |
| `chain:length`（`ipc/chain.ts:10`） | `getChainLength` | indexed | 部分索引走訪（chained 列數） | 併入 `counts:snapshot` |
| `loot:getCount`（`index.ts:1686`） | `getLootCount` | service | loot 桶全部列 `json_array_length` | 併入 `counts:snapshot`（由 `kind_totals` 回答） |
| `scope:getObservations`／`getObservationCount`／`getLastRecompute`（`index.ts:1657-1659`） | scope | indexed（有快取） | ≤500 列＋已存觀察 | 5 |
| `visibility:signals`（`:1681`） | `getVisibilitySignals` | constant（旗標單調） | — | 留 |
| `pivots:getActive`（`:1648`）與 eventBus 內的 `getActivePivots`（`:1637`） | `readActivePivots` | indexed | 40 列 | 改讀 `intervals`（tunnel） |
| `events:commandEvidence`、`annotatedIds`、`getNote`、`isDoNotExport`、`attributionStats` | 各自 | constant／indexed | — | 留 |
| `content:*`、`httpBody:read`（`:91-119,220`） | 讀檔 + 全檔 sha256 | file | 單一 body ≤10 MB | 5（heavy） |
| `casts:search`（`ipc/terminal.ts:131`） | `backfillCastIndex` + `searchCasts` | service | 回填：全部 cast 檔 | 3 |
| `data:*`（`ipc/data-export.ts`） | 匯出 worker | — | 已在 worker | 不動 |
| `GET /api/events`（`api-server.ts:418`）、`/api/events/count`（`:471`）、`/api/http-body/:sha`（`:496`） | 讀取 | indexed／service | — | 4 |
| `GET /api/export/har`（`:476`） | `exportHar` | service | ≤5 萬 flow × 每個 body | 改走匯出 worker |
| 其他約 120 個（設定、hook、瀏覽器、更新、overlay、terminal 寫入等） | — | constant／write | — | 登記但不移 |

基準：Phase 1 的 T011 由 `registerHandler` 的登記表產生上表的實際數字（每級幾個），寫入 `test/main-thread-handlers.test.ts` 的基準。

## 設計決策

### D1 寫入者留在主行程，只移讀取

**做法**：主行程保留 `getDB()` 的唯一可寫連線與 071 的整條入口；讀取服務只開唯讀連線。

**為何**：寫入路徑的順序關鍵狀態（鏈頭、簽章、causes resolver、去重、暫停判斷）都在主行程，071 剛把它們收斂成單一入口；把寫入者也移出會同時改動 071 與 073 的範圍。02 §3 的 (c)（推導的 CPU 移到 worker）是寫入者留在原處時的下一步，不在本規格。

**否決**：PRIOR-ART-D S1 的「writer worker + reader worker、主程序不碰 DB」：正確但範圍是階段 1／4 的寫入契約加上本階段；而且 Notion 的教訓（多寫入者）在單一主行程寫入者下不會發生。

### D2 兩條讀取執行緒，`heavy` 是衍生檔的唯一寫入者

**做法**：`interactive` 只跑宣告為 O(頁大小) 或索引 seek 的 `kind`；`heavy` 跑文字搜尋、Activity、彙總、因果鏈、內容讀取與驗證，並推進投影、寫三個衍生檔。`interactive` 對 `derived.db` 只讀。

**為何**：better-sqlite3 沒有中斷；一個執行緒內的優先佇列無法讓時間軸的頁插隊到一個已開始的 2 秒搜尋前面。第二條執行緒是唯一真正的優先度。衍生檔只有一個寫入者，避免兩條執行緒爭寫鎖。

**否決**：(a) 單一 worker 加優先佇列——不能搶占執行中的語句；(b) Signal 的四個 worker 依負載分派——單人本機過多，且寫入者還是只能有一個；(c) 每個請求一個 Worker（匯出的模式）——每次按鍵數十 ms 的啟動，也無法保留連線本地狀態（02 §5）。

### D3 `worker_threads`，不用 `utilityProcess`

沿用匯出 worker 的路徑：`new Worker(path.join(__dirname, 'query-worker.js'))`，`out/main/` 在 asar 內，better-sqlite3 從 `app.asar.unpacked` 載入。`utilityProcess` 會帶來新的打包與程序模型，並與 `electron-builder.yml:58-60` 的註解及 `test/package-fuses.test.ts` 的守門相反。崩潰隔離的需求以 FR-009 的重啟處理。

### D4 提交序號：記憶體內計數 + rowid 水位

**做法**：071 的 commit 原語在 commit 之後回傳 `CommitReceipt {seq, chainedMaxRowId, loggedMaxRowId}`。`seq` 是主行程每次開啟從 1 起算的計數；水位是該 commit 後兩層的 `MAX(rowid)`（寫入者已知剛插入的 rowid，不需另查）。派送者記 `lastCommitted`。

**RYW 的保證**：(1) 派送者在 `lastCommitted ≥ minSeq` 之前不送出請求；(2) worker 收到請求後才開始新的讀取交易；(3) 寫入者在回傳回執前已 commit（071 FR-032）。WAL 下，(2) 開始的交易看得到 (3) 之前的所有 commit。今天寫入是同步的，(1) 永遠立即成立；當 071／02 §3 的 (c) 讓寫入變非同步時，(1) 才會等待。

**為何不寫入資料庫**：spec 要求「不改既有列」；一張計數表會在每次 commit 多一次寫入，而 `seq` 只在一次開啟內有用——跨重啟時沒有在途的寫入可以等。持久的東西（游標）本來就用 rowid。

**否決**：(a) 持久計數表；(b) 單一 rowid（兩張表的 rowid 互相獨立，`event-order.ts:19-23`）；(c) `PRAGMA data_version`（只說「有別的連線 commit 過」，不給順序，且只對其他連線有效）。

**logged 層的 rowid 不單調**：`events_logged` 沒有 AUTOINCREMENT，retention 刪掉最大 rowid 後 SQLite 會重用。所以游標同時記游標所在列的 id；不符就視為 retention 並重建 logged 層衍生的部分（spec FR-037）。

### D5 衍生資料的存放

| 檔 | 內容 | 寫入者 | 為何在這裡 |
|---|---|---|---|
| `timeline.db`（新表 `terminal_targets`） | 071 T024 | 主行程，在 commit 交易內 | 寫入路徑要同步讀它決定 `target_via = terminal-last`；放在別的檔就要跨檔交易 |
| `derived.db`（新） | `activity_rows`、`activity_groups`、`intervals`、`cause_counts`、`kind_totals`、`target_totals`、`projection_state` | `heavy` | 一個檔、一個寫入者、一個版本表；整檔可刪 |
| `http-body-index.db`（既有） | body FTS、`body_event_refs`、新增 `coverage_counts` | `heavy`（從主行程移過來） | 保留既有 `user_version` 機制與檔案，避免一次重建所有使用者的 body 索引 |
| `cast-index.db`（既有） | cast FTS | `heavy` | 同上 |

`terminal_targets` 的回填（舊專案第一次開啟）：`heavy` 以唯讀連線計算 `(terminal, observed_at, target, source_row_id)`，分批送回主行程，由主行程以小交易依序寫入；回填完成前，該專案的新列不套用 `terminal-last`，寫 `_ingest.target_via: "none"`，永久（071 FR-010 已採用此規則，2026-11-12 對帳）。回填完成時以 `projection` 訊息告知主行程，寫入路徑自此套用 `terminal-last`。表可整張刪除並重建；重建不改變已寫入列的 `target_via`。

**否決**：(a) 全部併進一個衍生檔——要合併兩個既有的 `user_version` 方案，第一次升級時重建所有使用者的 body 與 cast 索引；(b) 投影表放進 `timeline.db`——證據檔混入可丟棄的資料，讀取服務就成為證據檔的第二個寫入者；(c) Activity 留在 TEMP——每次開啟重算全專案（02 §2）。

### D6 投影執行器

一個投影實作 `Projection` 介面（見「模組」）。執行器在 `heavy` 上：

1. 收到合併後的 `CommitReceipt`（或啟動、或請求之間有空），對每個投影計算 `lag`。
2. 依登記順序推進：每片 ≤2000 列或一個交易；推進與 `projection_state` 在同一個交易。
3. 讀取優先：佇列有請求時，片與片之間先處理請求。
4. `retention_pruned_logged` 是 chained 層的一列，依序處理到它時呼叫各投影的 `onLoggedPruned(newestPrunedAt)`。
5. 開啟時背景檢查（spec FR-037）：游標所在列的 id 是否仍在、兩層列數是否等於投影記下的數目（一次 B-tree count，不是 rowid 範圍走訪）。

`rebuild` 與增量推進是同一個函式從游標 0 開始，等價測試因此只需比較兩次執行的結果，不需要第二份實作。

### D7 一個 `cause_counts` 投影

`cause_counts(cause_id, role, family, kind, n, first_at, last_at)`，主鍵 `(cause_id, role, kind)`。來源是每列 `data._causes` 的 `caused` 參照；`role` 與 `family` 由 072 的註冊表從該列的種類查得。效應（`role = effect`）與註記（`role = annotation`）由同一張表回答。每列至多計 32 個 `caused` 參照，超過的部分記在 `projection_state` 的 `truncated` 計數（spec FR-039），閱讀時那個來源的數目顯示為 `atLeast`。

**否決**：效應與註記各一張表——同一份 `_causes` 解析寫兩次，兩邊的「誰算效應」可能分歧。

### D8 讀取服務停擺時不回退到主行程

回退會讓停擺時正好出現 02 所述的凍結，而且讓「主行程不執行 service 等級讀取」這條閘門無法成立。畫面已有「刷新失敗保留舊值」的狀態（FR-064）。

### D9 派送者留在主行程；不給 renderer 直接的 MessagePort

renderer 照舊以 `invoke` 呼叫；主行程的 `registerHandler` 把 `service` 等級的請求轉給派送者。理由：專案與 generation 的檢查、`withActiveScope`（`ipc/events.ts:30-40`）、API 路由都要經過同一處；頁的大小有上限，經主行程結構化複製一次的成本有界。直接 MessagePort（VS Code 的做法）是之後的最佳化，不改契約。

### D10 主題（topics）

topic 是封閉集合，分兩類：

| topic | 由什麼產生 | 誰在意（例） |
|---|---|---|
| `rows:<family>`（`commands`、`traffic`、`ai`、`artifacts`、`signals`、`record`） | 一列事件，family 取自 072 註冊表 | 計數、Activity 的「N 筆新事件」、HTTP／Loot／截圖清單 |
| `state` | `role = state` 或區間起訖的列 | 狀態帶、HUD、暫停顯示 |
| `annotations` | `role = annotation` 的列 | 效應／註記數、Loot、範圍頁 |
| `record-facts` | `role = record-fact`（缺口、retention、sanitize、config_changed） | 狀態帶上的刻度、完整度 |
| `housekeeping` | 註冊表 `housekeeping` 的列 | 只有「已記錄」總數 |
| `config` | 設定存檔的唯一出口（073） | 篩選清單、範圍是否已設定、HTTP 範圍標記 |
| `scope.rules`、`scope.observations` | 設定中的範圍、`scope_*` 列 | 範圍頁、狀態列 |
| `bookmarks`、`notes`、`do-not-export` | 對應的寫入 IPC | 書籤、註記、匯出 |
| `projection:<name>` | 投影推進到新的游標 | 依賴該投影、曾回 `behind` 的讀取 |

分類函式 `topicsForCommit(rows, nonEventWrites)` 在 core，讀 072 的註冊表；它取代 renderer 的 `lib/knownLists.ts:20` `isHousekeeping` 副本與四份 scope 子類型集合（03 F2）。`capture`（來源狀態變了）屬 075，不在本表。

### D11 計數型別

```ts
type Count = { kind: 'exact'; n: number } | { kind: 'atLeast'; n: number } | { kind: 'unknown'; reason?: string }
type ListCompleteness = { kind: 'complete' } | { kind: 'more' } | { kind: 'capped'; limit: number } | { kind: 'truncated' } | { kind: 'behind'; lag: number }
```

型別名刻意不用 `Completeness`：072 的 `Completeness` 是閱讀器第一行說的「這一列的內容是否完整」（七值），這裡是「這份清單是否完整」。兩者在 renderer 同時出現，同名會被誤用。

「已記錄」（狀態列、儀表板）、「符合」（此頁述詞下的列數）、「已載入」、「新進」四種名稱只是同一個 `Count` 的不同來源，名稱屬於畫面文案（03 F3 的詞彙表）；本規格只保證型別與格式化函式唯一。

**否決**：每個清單都附精確 `totalCount`——Relay 的連線規格刻意不含它；對文字搜尋與大專案，它會把 O(專案) 的成本加回每一頁。

### D12 導覽堆疊取代返回軌跡與保留來源頁

`lib/navigation.ts` 擴充 `NavEntry` 與 reducer（`push`／`back`／`replace`）；`App` 只保留 `route` 一個 state。`returnTrail.ts` 的三步上限成為堆疊深度上限；`keptOrigin.ts` 的「保留一頁」成為「堆疊中目前頁的下一層若可保留則保持掛載」；DOM 快照式的捲動還原換成錨點列。

## 模組邊界

| 模組（檔） | 公開介面 | 擁有 | 不得匯入 | 誰可匯入 |
|---|---|---|---|---|
| `src/core/read-contract.ts`（新，純型別與純函式，無匯入，同 `event-order.ts` 的規矩） | `QueryKey`、`ReadRequest`、`ReadResult<T>`、`CommitReceipt`（形狀由 071 FR-096 決定，此處只是型別的家）、`AsOf`、`Count`、`ListCompleteness`、`Topic`、`ProjectionStatus`、`stableKey(params)` | 型別 | 任何東西 | main、worker、renderer、api-server、071 的 `ingest/commit.ts` |
| `src/core/projections/registry.ts`（新） | `PROJECTIONS: readonly Projection[]`、`projectionByName` | 投影清單 | `db/index`（不碰模組單例連線） | runner、測試 |
| `src/core/projections/<name>.ts`（新：`activity`、`intervals`、`cause-counts`、`kind-totals`、`target-totals`、`body-coverage`、`terminal-targets`） | 實作 `Projection` | 各自的表 | `getDB`、`getReadonlyDB`、`src/main/**` | registry |
| `src/core/projections/runner.ts`（新） | `advance(conns, receipt, budget)`、`checkOnOpen(conns)`、`lagOf(name)` | `projection_state` | `src/main/**` | `query-worker.ts`；`terminal-targets` 的推進由 071 的 commit 階段呼叫 `advanceInTransaction` |
| `src/core/change-topics.ts`（新） | `topicsForCommit(rows, writes): Topic[]` | topic 分類 | renderer | main 的 commit 後處理 |
| `src/main/services/query-service.ts`（新） | `createQueryService(): ProjectResource & { query(req): Promise<ReadResult>; notifyCommit(r: CommitReceipt): void; health(): QueryHealth }` | 兩條 worker、佇列、退避、generation 檢查 | core 的讀取函式（只匯入 `read-contract`） | `src/main/index.ts`（經 073 的資源登記）、`ipc/register-handler.ts`、`api-server`（經注入的 `query` 函式） |
| `src/main/services/query-worker.ts`（新，worker 入口） | 訊息協定 | 連線、投影執行、衍生檔寫入 | `electron` | 無（只由 `new Worker` 載入） |
| `src/main/ipc/register-handler.ts`（新） | `registerHandler(channel, {cost, kind?}, fn)`、`HANDLERS`（登記表，供測試） | 處理程式的成本分級 | — | `src/main/**` 每個 IPC 模組 |
| `src/renderer/src/lib/query/`（新：`registry.ts`、`useQuery.ts`、`usePagedQuery.ts`、`formatCount.ts`） | `useQuery(key, load, {topics, keepPrevious, minIntervalMs})`、`usePagedQuery(...)`、`formatCount(...)` | 畫面的查詢項目、topic 訂閱、可見性暫停 | 其他畫面元件 | `components/**` |
| `src/renderer/src/components/ReadStatus.tsx`（新，模組層級元件） | `<ReadStatus entry subject conditions onRetry />` | 六種非資料狀態的呈現 | — | 任何畫面 |
| `src/renderer/src/lib/navigation.ts`（擴充） | `NavEntry`、`navReducer`、`useNav()`、`ViewVisibility` context | 導覽堆疊、可見性 | — | `App.tsx`、畫面 |
| `src/renderer/src/lib/pageFilters.ts`（新，取代 `FilterContext` 的共用部分） | `usePageFilter(view)` | 每頁每專案的篩選 | — | 各頁 |

`Projection` 介面（簽名草稿）：

```ts
interface Projection {
  name: string
  version: number
  store: 'derived' | 'body-index' | 'timeline'          // 'timeline' 只有 terminal_targets
  tiers: ReadonlyArray<'chained' | 'logged'>          // 讀哪幾層
  createSchema(db: Database): void
  dropSchema(db: Database): void
  apply(db: Database, rows: Iterable<ProjectedRow>, kinds: KindRegistry): void   // 依 rowid 順序，增量與重建共用
  onLoggedPruned?(db: Database, newestPrunedAt: number): void
  costPerRow: { writes: number }                       // 宣告，供 FR-039 的計數測試比對
}
```

`ProjectResource`：照用 Spec 073 plan「介面草稿」與「給 074 的資源介面」的定義，不另寫一份（2026-11-12 對帳）：

```ts
// 073 src/core/session/resource.ts（本規格只實作，不定義）
interface ProjectResource {
  readonly id: ResourceId                // 'query-worker'
  readonly use: 'capture' | 'read'       // 'read'：唯讀 session 也啟動
  readonly reads: readonly SettingKey[]
  start(ctx: ResourceContext): void      // 同步；以 ctx.dir 與唯讀模式建立 worker，不自行開讀寫連線
  apply?(change: SettingsChange, ctx: ResourceContext): void
  stop(reason: CloseReason): void        // 同步；worker.terminate() 不等待，進行中的請求以 session-closed 拒絕
  inspect(): ResourceInspection          // worker 開的資料庫所屬專案 id、進行中的請求數
}
```

`QueryService = ProjectResource & { query(req): Promise<ReadResult>; notifyCommit(r: CommitReceipt): void; health(): QueryHealth }`：`health()` 是讀取服務自己的方法（FR-002），不屬於資源介面。請求帶的 generation 取自 `ctx.token`（073 的 `SessionToken`，今天的 `ProjectContext`）。073 的 session 落地前（073 T031i 之前），以 `ProjectRuntime.onStop` 呼叫同一個 `stop`，簽名不變。

## 取代什麼（依折入順序；每一步之後數量只減不增）

| # | 今天的重複或單例（file:line） | 折入後 | Phase |
|---|---|---|---|
| 1 | 主行程上的 `getReadonlyDB` 讀取（36 個呼叫點，`db/index.ts:516-535` 的前提錯誤註解） | 只在 worker 的模組圖中 | 3 |
| 2 | 179 個裸 `ipcMain.handle`／`on` | `registerHandler` 登記表 | 1（登記）→ 3（service 等級清零） |
| 3 | Activity 的 TEMP 投影與 UDF 註冊（`activity-queries.ts:24-71`）與讀取時追趕（`:150-189`） | `derived.db` 的 `activity` 投影 | 4 |
| 4 | `readActivitySnapshot` 每頁的 rowid 範圍 COUNT（`dataset-snapshot.ts:8`） | 游標列 id + retention 世代 | 4 |
| 5 | `bodySearchCoverage` 每頁全走訪（`http-body-index.ts:430-494`）、每次搜尋的 `recheck`（`:331`） | `coverage_counts` 差量 + 背景切片 | 4 |
| 6 | 衍生檔的多個寫入者：ingest（`ingest.ts:290`）、retention（`retention.ts:91,94,97,341,508`）、終端（`terminal-manager.ts:187`）、搜尋 | `heavy` 一個寫入者 | 4 |
| 7 | `aggregateTargets`／`distinctHosts`／`distinctAgentTypes`／`getLootCount` 的全表掃描（`event-aggregates.ts:17,57`、`event-queries.ts:1121,1135`） | `target_totals`、`kind_totals` | 4 |
| 8 | renderer 由已載入列推狀態帶：`sessionBoundaries`（`timelineIncremental.ts:471-486`）、`timelineSessionBands.ts` | `intervals` | 5 |
| 9 | renderer 由已載入列算效應：`effectsIndex`（`Timeline.tsx:963`） | `cause_counts` | 5 |
| 10 | pivot 以指令文字配對、30 分鐘猜測（`active-pivots.ts:26-58`） | `intervals` 的 tunnel（HUD 照 UX-005 呈現為「偵測於」） | 5 |
| 11 | `useAppCounts` 四個各自吞錯的讀取（`useAppCounts.ts:99-102`） | `counts:snapshot` 一個 `Query` | 6 |
| 12 | 截圖的總數取自第一頁（`ScreenshotsView.tsx:195,286`） | 主行程的計數 + `formatCount` | 6 |
| 13 | 三組 `*.recentSubset`（`en.json:248,927,1337`）、至少 12 個「N of M」模板 | `formatCount` | 6 |
| 14 | 讀取身分的三種補丁：`ActivityResults.tsx:44` 的 key remount、`ScopeStatus` 的 id 比對、`SourceSessionPicker` 的 request 回聲；`EventContentReader` 沒有 key | `useQuery` 的 `dataKey` | 6 |
| 15 | 四處飢餓的 debounce（`ScopeStatus.tsx:165`、`EvidenceHeader.tsx:33`、`TargetsScopeHeader.tsx:43`、`FirstRunView.tsx:164`） | topic + 登記表節流 | 6 |
| 16 | 22 個檔案的 `onNewBatch` 訂閱 | 只剩需要列本身的畫面 | 6 |
| 17 | 四個 window CustomEvent（`redlog:config-saved`、`BOOKMARKS_CHANGED`、`RECOUNT_EVENT`、`EVENT_NOTE_SAVED`） | `data:changed` 的 topics | 6 |
| 18 | `FilterContext` 的共用篩選（15 個 renderer 檔使用）、`TargetView` 寫全域目標 | 各頁篩選 + `reveal` | 7 |
| 19 | `App.tsx` 的導覽 state、`returnTrail.ts`、`keptOrigin.ts` 的 DOM 快照、六個 `active` prop、`exportScope` 單一槽位 | 導覽堆疊 + `ViewVisibility` | 7 |

## 投影

| 名稱 | 存放 | 來源 | 推進者 | 每列成本 | 「時間 T」怎麼回答 | retention | 版本／重建 |
|---|---|---|---|---|---|---|---|
| `activity` | `derived.db` | 兩層全部列 | `heavy` | 1 插入 + 1 群組 upsert | 不適用（以 rowid 界定的快照） | 依 `retention_pruned_logged` 刪 logged 列並重算受影響群組 | v2（v1 為 TEMP）；只重建本投影 |
| `terminal_targets` | `timeline.db` | 有 `explicit`／`extracted` 目標的新列 | 主行程，commit 交易內；舊專案回填見 D5 | ≤1 插入 | `(terminal, observed_at ≤ T)` 最新一列 | chained 不刪；logged 來源的列依 `created_at` 刪 | 表可整張刪除並回填 |
| `intervals` | `derived.db` | 072 註冊表宣告為 `start`／`end`／`state` 的種類 | `heavy` | ≤2 寫入（開一段或關一段） | `stateAt(ts[], keys[])`：`(kind, key, start_ts)` 索引上二分 | logged 來源的區間刪除；被切斷的區間 `end_basis` 不變 | 註冊表版本變更即重建本投影 |
| `cause_counts` | `derived.db` | 每列 `_causes` 的 `caused` 參照 | `heavy` | 每參照 1 upsert（≤32） | 不適用 | 被刪的 effect 從計數扣除 | 重建本投影 |
| `body_coverage` | `http-body-index.db` | `body_event_refs` 的狀態變更 | `heavy` | 每次狀態變更 2 次 upsert（舊狀態減、新狀態加） | 不適用 | `prune*` 時差量扣除 | `user_version` 8 |
| `kind_totals` | `derived.db` | 兩層全部列 | `heavy` | 1 upsert | 不適用 | 扣除 | 重建本投影 |
| `target_totals` | `derived.db` | 有 `target_id` 的列（排除 housekeeping，依 072） | `heavy` | 1 upsert | 不適用 | 扣除；`first_at` 失效時對該目標重算一次 | 重建本投影 |

`intervals` 的形狀：`intervals(kind, key, start_id, start_ts, end_id, end_ts, end_basis, value)`，`key` 為 `global` 或 `terminal:<id>`（取 071 的 `_ingest.terminal`；舊列依 071 FR-011 的退回規則），`value` 為狀態值（目標、IP、暫停原因）。指令以 `command_id`（沒有時以 `tid|pid|cmd`，同 `causes-resolver.ts:84-91`）配對。專案開／關依 spec FR-044。

落後的呈現：讀取結果的 `completeness = {kind: 'behind', lag}`；`projection:<name>` topic 在推進後送出，畫面的項目據此重讀。

## 協定

```ts
// main → worker
type ToWorker =
  | { t: 'open'; projectDir: string; engagementId: string; generation: number; role: 'interactive' | 'heavy' }
  | { t: 'req'; id: number; generation: number; kind: string; params: unknown; minSeq: number; budget: WorkBudget }
  | { t: 'cancel'; id: number }                        // 只對尚未開始的請求有效
  | { t: 'commit'; receipt: CommitReceipt }            // 只送 heavy；合併
  | { t: 'derived-op'; op: 'link-body' | 'prune-body' | 'prune-saved' | 'index-cast' | 'prune-cast'; args: unknown } // heavy
  | { t: 'close' }
// worker → main
type FromWorker =
  | { t: 'ready'; projections: ProjectionStatus[] }
  | { t: 'res'; id: number; ok: true; value: unknown; asOf: AsOf; completeness: ListCompleteness; work: WorkCount }
  | { t: 'res'; id: number; ok: false; error: 'superseded' | 'busy' | 'bad-request' | 'failed'; message?: string }
  | { t: 'projection'; status: ProjectionStatus }      // 推進或重建後
  | { t: 'tt-backfill'; rows: TerminalTargetRow[]; done: boolean } // 交給主行程寫入
```

`work` 是該請求的工作量計數（走訪列、語句、開檔、lstat），在測試與 dev 下收集，正式版只收集數字不記內容；FR-094 的測試讀它。

## 閘門

| 規則 | 閘門（會失敗的東西） | 形式 |
|---|---|---|
| 每個 IPC 處理程式有成本等級；主行程沒有 `service` 等級的實作 | `test/main-thread-handlers.test.ts`：掃描裸 `ipcMain.handle(`／`.on(`（白名單只降）；登記表中 `service` 等級必須是代理 | ratchet（同 `test/mutation-guard.test.ts`） |
| `indexed` 等級有計畫斷言 | 同上，交叉比對 `test/query-plans.test.ts` 的通道清單 | 完整性 |
| 主行程不匯入讀取服務專屬符號 | `test/query-import-boundary.test.ts`（原始碼掃描，形式同 `test/inline-components.test.ts`），基準只降 | ratchet |
| 衍生檔單一寫入者 | `test/derived-single-writer.test.ts`：模組圖掃描 `new Database(… 'derived.db'|'http-body-index.db'|'cast-index.db')` 只在 worker 圖內 | 邊界 |
| 主行程無超過門檻的停頓 | e2e fixture 的事件迴圈探針（`e2e/fixtures/loop-probe.ts`）＋測試專用路由；每個 spec 的 `afterEach` | 執行期 |
| 讀取的成本不隨專案成長 | `test/query-work-counts.test.ts`：1 萬 vs 10 萬列，每個 `kind` 與投影 | 工作量計數 |
| 增量 == 重建 | `test/projection-equivalence.test.ts`（每個投影一組 property test）；`test/projection-registry.test.ts` 斷言每個登記的投影都有 | 性質 + 完整性 |
| 讀到自己的寫入 | `test/read-your-writes.test.ts`（含重啟、排隊、generation 切換） | 性質 |
| `derived.db` 不進匯出與打包 | `test/derived-not-exported.test.ts`；`scripts/verify-packaged-resources.mjs` 斷言 worker 檔存在、`derived.db` 不存在 | 內容 |
| worker 在正式版可載入；fuses 不變 | `test/package-fuses.test.ts`（不變）；`test/bundle-requires.test.ts` 擴充到 `query-worker.js`；正式版自檢（階段 0／7 的 smoke） | 打包 |
| 每個 `kind` 恰好一條執行緒；TEMP 依賴的查詢固定在一條連線 | `test/query-kinds.test.ts` | 完整性 |
| 計數只經 `formatCount` | `test/count-semantics.test.ts`：清單登記表 + i18n 掃描（`{{shown}}`／`{{total}}` 只在 formatter） + 「shown ≤ exact total」性質 | 完整性 + 性質 |
| 寫入都發 topic | `test/change-topics.test.ts`：每個寫入型 IPC 與每條 commit 路徑至少一個 topic；分類與 072 的 housekeeping 規則對同一組列一致 | 契約 |
| 畫面讀取經 `useQuery` | `test/read-guard.test.ts`：三個數字（FR-097）只降 | ratchet |
| 元件不宣告在元件內 | 既有 `test/inline-components.test.ts` | 不變 |
| 投影不另寫種類表（起訖、角色、家族只讀 072） | 072 的 `test/kinds/kind-literal-ratchet.test.ts`：`src/core/projections/**` 與 `change-topics.ts` 的允許數為 0（072 T052 加入此條件；本規格不另寫一個測試） | ratchet（基準 0） |

沒有閘門的規則：worker 的退避參數（1–30 秒、5 次／5 分）只以單元測試驗證行為，不設常駐的計時閘門——理由：O9，牆鐘測試在本 repo 只能手動。

## 對相鄰規格

| 規格 | 我需要 | 我提供 |
|---|---|---|
| 071 寫入契約 | (a) commit 原語在 commit 之後回傳 `CommitReceipt {seq, chainedMaxRowId, loggedMaxRowId}`（071 FR-096、T038；不寫入列）；(b) effect 與註記的 `_causes` 帶來源指令的事件 id（O18：`REDLOG_COMMAND_ID`／proxy userinfo）——**071 尚未展開為 FR 與任務**，未展開前 `cause_counts` 只依今天的 `_causes`；(c) `_ingest.terminal` 為正規終端 id（FR-011）；(d) commit 後處理呼叫 `queryService.notifyCommit(receipt)` 與 `topicsForCommit`（071 plan D8）；(e) `linkHttpBodyEvent` 從 ingest 移除，改送 `derived-op`（071 plan D8）；(f) `terminal_targets` 回填期間的 `target_via` 為 `none`、永久（071 FR-010） | `terminal_targets` 的投影契約（版本、等價測試、回填由 `heavy` 計算、回填完成的通知） |
| 072 種類註冊表 | `role`、`shape`、`family`、`housekeeping`、`counts.total`、`INTERVALS`（配對鍵 `key`／`fallbackKey`）、`STATES`（`groupBy` 全域／每終端）、`status: legacy`；`kindOf(row, plugins?)` 為純函式，worker 可匯入；`KIND_REGISTRY_VERSION`（變更即重建 `intervals`、`cause_counts`）；`project_closed` 種類 | topics 由註冊表推導；`intervals`／`cause_counts` 依註冊表的宣告建立；不自行定義任何角色；`gapOverlaps`（FR-048）給 072 的 `completenessOf` |
| 073 專案執行期 | `ProjectResource`（073 的定義，見上）；`SessionToken` 的 generation 與 signal；設定存檔的唯一出口發出 `config` topic（073 FR-013、T043）；`project_closed` 由 073 在關閉時寫入（經 071） | `QueryService` 實作 `ProjectResource`；`health()` |
| 075 來源狀態 | 不需要 | `kind_totals` 可回答「某種類最後一筆的時間」（若 075 要讀，經 `query`，不直接讀表）；`capture` topic 由 075 定義 |

重疊時的歸屬：housekeeping 的定義、角色、閱讀器屬 072；`project_closed` 的寫入屬 073（經 071）；本規格只投影它。來源狀態的詞表屬 075。

## 依賴順序

跨 071–075 的順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」；以下是本規格自己的 Phase 與它們等待的兄弟項目。

1. **Phase 1（無依賴）**：閘門與工作量基準、等價測試釘住今天的 TEMP 投影、特徵化測試（共用篩選、截圖計數、儀表板 drift）。
2. **Phase 2（需要 073 的資源介面；未定時以 `ProjectRuntime.onStop` 實作同形介面）**：讀取服務骨架、第一個 `kind`（`aggregateTargets`）、打包、崩潰與重啟、RYW（`seq` 先由主行程在 `insertEvent` 回傳點包一層；071 落地後改由 commit 原語提供）。
3. **Phase 3**：依成本排名移動讀取；每移一個，白名單與匯入邊界的基準下降。
4. **Phase 4**：`derived.db`、投影執行器、`activity`、`body_coverage`（併入 `work/1112-search`）、`kind_totals`、`target_totals`；衍生檔單一寫入者。
5. **Phase 5（需要 072 的註冊表與 071 的 `_causes` 指令 id）**：`intervals`、`cause_counts`、`stateAt`；舊專案的 `terminal_targets` 回填。072 未落地時 `intervals` 只處理今天已知的種類並以 `legacy` 清單標示，這份清單在 072 落地時刪除。
6. **Phase 6**：畫面讀取模型、topics、計數。
7. **Phase 7**：導覽堆疊、各頁篩選（取代 038）。
8. **Phase 8**：閘門收緊、文件、驗收。

## 風險

| 風險 | 對策 |
|---|---|
| 投影與來源不同步（最大風險） | 每個投影一組等價性質測試；開啟時背景檢查；版本不符即重建 |
| worker 載入失敗只發生在某平台的正式版 | Phase 2 就跑三平台打包與正式版自檢；`test/bundle-requires.test.ts` |
| 結構化複製成本 | 頁大小有上限；`aggregateTargets` 改為分頁（今天回傳全部目標） |
| `heavy` 被長搜尋佔住，投影推進延後 | 落後如實顯示；搜尋可被取代並終止；投影游標持久，重啟不失進度 |
| 兩條唯讀連線加一條衍生寫入連線的記憶體 | 每條約一個 page cache（預設 2 MB 級）；量測記入 verification |
| e2e 探針在 CI 上誤報 | 門檻寬（500 ms）且以歸因為主；p99 不斷言 |
| 取代 038 的範圍大、e2e 需全輪 | Phase 7 單獨一個 PR；先列出所有斷言共用篩選的 spec 與 unit test（spec 的衝突表），同一個 PR 更新 |
| 寫入改為非同步後 RYW 的等待 | 派送者等待有上限（開啟結束即失敗）；測試覆蓋 |

## 驗證策略

- **自動化**：上表的閘門；既有核心讀取測試照跑，另加「經讀取服務 vs 直接呼叫」deep-equal 等價測試（每個移動的 `kind`）。
- **e2e（ubuntu CI）**：事件迴圈探針在每個 spec 啟用；新增 `e2e/query-service.spec.ts`：持續寫入時的搜尋與 Activity、專案切換時有請求在途、worker 被終止後恢復。本機不跑 Electron e2e。
- **需要其他平台**：Windows 上「專案切換中途有查詢」的 e2e 與正式版啟動自檢；Linux 正式版啟動自檢；macOS 簽章後的正式版。沒有環境時記 NOT RUN。
- **真機（spec 落地時檢查的畫面）**：時間軸（頁、狀態帶、效應數、跳轉）、Activity（首開、文字查詢、落後標示）、HTTP History、Loot、截圖（計數）、目標頁（彙總、跳轉、返回）、範圍頁（跳轉 `reveal`）、儀表板與狀態列（`counts:snapshot`、drift）、側欄徽章、HUD（tunnel）。以一個 ≥25 萬列、≥10 萬 body 參照的專案，在持續擷取（真實 shell hook 與 proxy）下操作。
- **端到端擷取信任**：真實 zsh hook 與 mitmproxy 寫入期間執行重讀取，確認 hook 沒有因逾時寫入交接目錄（工作計畫第一條規則）。
- **決定／實作／驗證分開**：`verification.md` 每項記三欄。

## Project Structure

### Documentation (this feature)

```text
specs/074-query-worker-projections-and-read-contract/
├── spec.md
├── plan.md
├── tasks.md
└── verification.md        # Phase 1 建立：基準數字、閘門、真機紀錄
```

### Source Code

```text
src/core/read-contract.ts                    # 新：型別與 stableKey
src/core/change-topics.ts                    # 新：topicsForCommit
src/core/projections/{registry,runner,activity,intervals,cause-counts,kind-totals,target-totals,body-coverage,terminal-targets}.ts
src/core/db/activity-queries.ts              # 改讀 derived.db；移除 TEMP 註冊
src/core/db/dataset-snapshot.ts              # 移除每頁的 rowid 範圍 COUNT
src/core/http-body-index.ts                  # coverage 計數；寫入只在 worker
src/core/cast-index.ts                       # 寫入只在 worker
src/core/ingest.ts, src/core/retention.ts    # 改送 derived-op
src/main/services/query-service.ts           # 新
src/main/services/query-worker.ts            # 新
src/main/ipc/register-handler.ts             # 新
src/main/ipc/*.ts, src/main/index.ts         # 改用 registerHandler；service 等級改為代理
src/core/api-server.ts                       # GET 路由經 query
electron.worker.config.ts, scripts/build-export-worker.mjs   # 多入口
src/renderer/src/lib/query/*                 # 新
src/renderer/src/components/ReadStatus.tsx   # 新
src/renderer/src/lib/navigation.ts           # 擴充
src/renderer/src/lib/pageFilters.ts          # 新；FilterContext 縮為 FilterOptions
src/renderer/src/lib/{returnTrail,keptOrigin,readState}.ts   # 逐步移除
```

## Complexity Tracking

| 新增 | 為何需要 | 更簡單的替代為何不夠 |
|---|---|---|
| 第二條讀取執行緒 | 唯一能讓時間軸不排在長搜尋後面的方式 | 單一 worker 的優先佇列無法搶占執行中的語句 |
| `derived.db` 第三個衍生檔 | 投影要持久、可整檔丟棄、單一寫入者 | 放 `timeline.db` 會讓讀取服務成為證據檔的寫入者；TEMP 每次開啟重算 |
| 投影執行器與等價測試框架 | 七個投影共用推進、版本、retention、損毀規則 | 各寫一份正是今天 activity 與 body 索引各自發明水位的原因 |
| 讀取登記表（renderer） | key、topic、可見性、節流在一處 | `useReadState` 已證明只解相位不解身分；逐頁修補是 03 列出的 9 次 |
