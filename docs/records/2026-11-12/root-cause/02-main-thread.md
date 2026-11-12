# 02 — 主行程回應性：為什麼無上限的同步工作一直回到 Electron 主執行緒

審查基準：`main@a087c16c`（乾淨）。唯讀審查；量測用暫存目錄裡以 esbuild 打包的腳本直接呼叫 `src/core` 的真實函式（非 Electron、非打包 app），量測時機器 load average 約 15（其他審查同時在跑），絕對值偏高，比例可參考。

## 摘要（10 行）

1. 根因不是個別查詢慢，而是**一條執行緒承擔所有事**：IPC 讀取、`/api/*`（含 shell hook 的 ingest）、ingest 的衍生工作、PTY 輸出、計時器全在主行程 event loop；v0.15 把重讀取移到「另一條連線」（`getReadonlyDB`），程式註解相信這樣就不會「serialise capture writes」，但 better-sqlite3 是同步的，**換連線不換執行緒**，序列化一點也沒少。
2. 第二個機制：**讀取時重算衍生狀態**。搜尋每一頁都把全部 body 參照列走一次（`bodySearchCoverage`）、Activity 投影是連線內 TEMP 表、每次啟動重建；renderer 再以 live batch 觸發這些整案讀取，throttle 只限頻率不限成本。
3. 實測（25 萬列、10 萬 body 參照、2 萬檔）：首次搜尋 21.5 s、之後每次搜尋 2.3–2.6 s（其中 coverage 單獨 1.9 s）、Activity 首開 11 s、Activity 文字搜尋 11.8 s——全在主執行緒。#695 的增量化只修了 `sync`，coverage 的全走訪仍在。
4. 第三個機制：**ingest 以位元組設上限（20 MiB／請求），沒有以時間設上限**；loot 命中數、遮蔽的 denylist（含本事件所有 loot 值）、`linkHttpBodyEvent` 對每個回應 body 的重讀、重雜湊與 FTS 分詞，都同步在寫入路徑上。
5. 第四個機制：必須留在主行程的維護工作，讓出點放在「階段邊界」或「每 N 列／N MiB」，不是時間預算（開專案時 `drainSpool(Infinity)`、`sweepLoggedTier` 迴圈、`scanCandidates`、tailer 每 session 整檔讀 sidecar 並雜湊）。
6. 第五個機制：**沒有任何閘門量主執行緒**。時間比例測試因雜訊改為 `REDLOG_PERF=1` 才跑，plan guard 只鎖兩條路徑，QA 的 event-loop sampler 靠 `app.evaluate`（正式版已拒絕 inspector）且未提交。
7. 已經離開主執行緒的只有匯出（每任務一個 worker、唯讀連線、`BEGIN` 快照、只回傳 metadata 或暫存檔）；`bounded-regex` 的 worker 只給時間上限，主行程仍以 `Atomics.wait` 同步等待最多 250 ms。
8. 結構答案：(a) 一個**長駐、綁專案的讀取服務 worker**，所有 renderer 與 API 讀取都經過它，並擁有衍生資料庫（body 索引、持久化 Activity 投影）；主行程只保留寫入、鏈頭、ingest 的順序關鍵部分與協調。
9. 搭配 (d) 寫入後增量維護的投影（讀取成本 O(page)），(c) 只用在不進鏈的衍生物（body FTS、Activity），loot／遮蔽因為寫進鏈內 `data.redactions`，改為「worker 算、主行程依序寫」以保持列內容不變。(b) 預算用登記表 + 匯入邊界掃描實作，不靠計時。
10. 執行順序：先量測歸因（handler 計時 + e2e watchdog）→ 讀取服務骨架 → body 索引與 coverage 移入並改增量 → Activity 投影持久化 → ingest 大事件的 CPU 推導移入 worker → 開啟閘門。

---

## 0. 清單：主執行緒上、成本由 app 不控制的輸入決定的工作

標記：**無界** = 沒有任何上限；「位元組有界」= 有大小上限但時間仍可達秒級。成本欄「實測」為上述 25 萬列資料集；「估」為按列數線性外推到 10 萬 chained + 100 萬 logged。

### IPC（`ipcMain.handle` 共 178 個登記；以下只列成本隨資料成長者，其餘是 O(1) 設定／狀態讀取）

| 管道 | 成本由什麼決定 | 上限是否強制 | 同步成分 | 成本 |
|---|---|---|---|---|
| `events:runQuery`、`GET /api/events/search` → `executeEventQuery`（`event-queries.ts:1235`） | 全部 content-ref 列數、body 檔數、命中 id 數 | **無界**（`limit` 只限頁大小；查詢字串 ≤1000 字） | `searchHttpBodyEventIds`→`sync`（新列 link + `recheck` 對每個已驗證參照 lstat、每個 missing/failed 參照重讀）；`bodySearchCoverage` 走全部 content-ref 列並 `JSON.parse` 每列 `data`；FTS；sha256 | 實測：首次 21.5 s，重複 2.3–2.6 s（coverage 單獨 1.9 s）；估 1.1M 列：重複約 10 s／每頁 |
| `events:activityPage`／`activityMembers`（`activity-queries.ts`） | 自上次投影後的新列；查詢模式下全部命中列；全部 group 數 | **無界** | `syncProjection`：每列 3 個 JS UDF（`JSON.parse` 兩次 + sha256）；`COUNT(*) OVER()` 物化全部 group；文字模式另含上一列全部 | 實測：首開 11.0 s、第二頁 2.6 s、文字查詢 11.8 s；估 1.1M 列首開約 45 s |
| `events:aggregateTargets` | 兩層全表 + `LOWER()` GROUP BY；結果列數 = 全部目標 | **無界**（掃描與回傳都無上限） | SQL + 結構化複製 | 實測 250 ms；估 ~1 s；TargetView 與 TargetsScopeHeader 各在 live batch 後重跑 |
| `events:distinctHosts` | 兩層 `json_extract(data,'$.host')` 全表 | 掃描無界、輸出 500 | SQL | 實測 256 ms；估 ~1 s |
| `events:count`／`events:span` | 篩選述詞；`inScopeOnly` 時為目標述詞 | 掃描無界 | SQL | 未量（依篩選） |
| `events:queryPage`／`queryHttpFlowPage`／`queryScreenshotPage` | 頁大小 + 篩選是否能用索引 | 部分（limit 有，renderer 傳入值未夾限；`events:query` 的 `limit` 不檢查，-1 即全表） | SQL | 一般 ms 級 |
| `content:read`／`find`／`copySaved`／`httpBody:read` | 單一 body 大小（≤ mitm `REDLOG_MAX_BODY` 預設 10 MB） | 位元組有界 | 讀檔 + 全檔 sha256 驗證 + 解碼 | 10 MB 約 30–60 ms（估） |
| `artifacts:add` | 操作者選的檔案 | 200 MiB | `copyFileSync` + `hashFile` 同步 | 200 MiB 約 0.5–1 s（估） |
| `project:open`／`project:create` → `startProject` | 見 §6 | 部分無界 | 全同步 | 見 §6 |
| `loot:getCount`、`events:getCount('logged')` | loot 列數；logged 列數 | 無界但便宜 | SQL COUNT/SUM | 實測 5 ms 級 |
| `data:*` 匯出、`chain:verify` | — | 匯出在 worker；verify 每 1000 列 `setImmediate` | — | 健全（§5） |

### `/api/*`（同一 event loop；shell hook 小事件 1 s 期限）

| 路由 | 成本由什麼決定 | 上限 | 同步成分 | 成本 |
|---|---|---|---|---|
| `POST /api/events` → `ingest` | 請求 ≤20 MiB（`api-server.ts:198`）；loot 命中數；token 數；body 大小 | 位元組有界、**時間無界** | `JSON.parse` + 深度檢查；內建 loot regex；遮蔽 tokenization + entropy（denylist 加入本事件全部 loot 值）；sidecar base64 解碼 + sha256 + `writeFileSync`；`insertEvent`（canonical JSON、sha256、Ed25519、FTS trigger）；`linkHttpBodyEvent` 再讀一次 body、再雜湊、UTF-8 解碼、FTS 分塊寫入 | 已知 8 MiB 相異雜湊輸出約 8.5 s；10 MB 回應 body 估數百 ms |
| `GET /api/export/har` → `exportHar`（`har-export.ts:195`） | ≤50 000 個 flow × 每個 body | **無界（位元組）** | `queryEvents` + 每個 body `readBodyForDelivery`（讀檔 + sha256）+ 單一 `JSON.stringify(…, null, 2)` | UI 的 HAR 已移到 worker，這條 API 路徑沒有；最壞為 GB 級字串 |
| `GET /api/events` | limit ≤1000 | 有界 | SQL | 小 |
| `GET /api/http-body/:sha` | 引用該 body 的事件數 + body 大小 | 位元組有界 | 每個引用 `queryEventById` + 匯出遮蔽；讀檔 + 雜湊 | 小到中 |
| `POST /api/loot/scan` | ≤128 KiB | 有界 | regex | <200 ms |
| `POST /api/export/bundle` | — | worker | — | 健全 |
| `GET /api/anchors/verify?full=1` | 鏈長 | 分塊讓出 | — | 健全 |

### eventBus 訂閱者、計時器、輪詢、tailer

| 項目 | 上限 | 備註 |
|---|---|---|
| `index.ts:1717` 主訂閱者：批次轉送、`pivotsMayChange`→`readActivePivots`、`screenshotAgent.onCommandEnd` | 有界（有門檻） | — |
| `capture-health` 失效、`scope-observation-count` 計數 | 有界 | 探針為索引 seek，`test/query-plans.test.ts` 守住 |
| `verifyRandomSample(50)` 每 5 分鐘 | 有界 | 曾是 2 s × 每小時 4 次（`chain-anchor.ts:792` 註解）——本機制的歷史實例 |
| `sweepLoggedTier` 開專案 + 每 24 h（opt-in） | **無界**：最多 10 000 × 5000 列刪除，中間不讓出；另有全範圍 `SUM(LENGTH(data))` | 分批是為 WAL，不是為 event loop |
| spool 週期 drain（30 s） | 每片 10 檔、共 200 | 健全；但開專案時 `drainSpool()` 為 `limit=Infinity`（`index.ts:949`） |
| agent tailer：chokidar `add` → `registerSession` | **無界**：整檔 `readFileSync(sidecar)` + sha256（`tailer-host.ts:1360`），per-message adapter 再整檔讀一次（:1395），pending replay 再讀一次（:1408） | 每個曾見過的 session 在開專案時都重新登記 |
| tailer catch-up | 每片 10 MiB，片間 `setImmediate` | 以位元組切片，單片可含上千次 ingest |
| scope recompute（設定儲存後 2 s debounce） | `scanCandidates` 每 bucket × 每層一次 GROUP BY，整段同步，讓出點在階段之間 | 估 1.1M 列秒級 |
| connection／process／opsec monitor | `execFile` 非同步；解析輸出有界 | 健全 |

---

## 1. 發現一（最高）：讀寫分了連線，但沒有分執行緒——「連線並行」被當成「執行緒並行」

**機制。** `src/core/db/index.ts:516-529` 為重讀取開了第二條唯讀連線，理由是「heavy scan on getDB() serialises every capture write behind it. WAL lets a separate reader run concurrently with the writer」。`queryEvents` 的註解（`event-queries.ts:353`）重複同一前提：「so a large timeline scan doesn't serialise capture writes」。WAL 讓**兩個執行緒**上的讀寫可以並行；better-sqlite3 每個呼叫都同步執行，兩條連線都在主行程 JS 執行緒，所以一個 2 s 的唯讀掃描仍然讓同一執行緒上的 `POST /api/events`、IPC、PTY 輸出全部等 2 s。另一條連線解決的是「This database connection is busy」（`index.ts:481` 的那次事故，hash walk 持有 iterator 跨 `setImmediate`），不是回應性；這個區別從沒寫下來，之後每個「heavy read」都被放到 `getReadonlyDB()` 並被認為已經處理。

規則也沒被遵守、沒有東西檢查：`http-body-index.ts` 的 `rows()`、`sync()`、`bodySearchCoverage()` 與 `latestSnapshotIds()` 用的是 `getDB()`（寫入連線）；`verifyRandomSample` 也是。

**後果對操作者不只是 UI 卡。** API server 與 IPC 共用 event loop，shell hook 小事件期限 1 s（收尾紀錄 §3）。主行程卡 1 s 以上，hook 就把事件寫進 spool，capture-health 顯示延遲，事件順序靠去重修補。收尾紀錄量到的「即時寫入時主行程最長停頓 42.9 s」與「約 7 萬筆時 4–5 秒」都是這條路徑：讀取把寫入擋在門外。

**實例。**
- 本次兩天的清單幾乎全是：Activity 每次讀取重新分組（`activity-queries.ts:50-56` 註解：1.3–1.7 s @80k，「a burst of live capture queued behind it」）、43 s 停頓、HAR 計畫無索引（43.5 s）、搜尋重雜湊全部 body（2.5 s @20k）、bundle 匯出在主行程、開啟後第一次搜尋。
- 更早：`verifyRandomSample` 每 5 分鐘 2 s（`chain-anchor.ts:796-807`）、tailer 每 session 167 ms × 1075 = 180 s（`tailer-host.ts:1371-1377`）、匯出稀疏選取走完整快照（`6f1ff450`）、screenshot `readFileSync` 5–15 ms（`index.ts:1395-1399`）。
- 實測仍在的：重複搜尋 2.3–2.6 s、Activity 首開 11 s、文字 Activity 11.8 s（25 萬列）。

**為何過去的修正是治標。** 每次都是把**那一條**查詢變快（加索引、增量化、加快取、改演算法）或把**那一個**功能移到 worker（匯出）。成本隨資料成長的讀取一共有十幾條（§0），沒有任何一條規則說「O(專案) 的工作不得在主行程執行」，下一條新讀取的預設位置仍是 `ipcMain.handle` 裡的同步呼叫。

**結構改變——讀取服務（選項 a）。**
- 引入 `src/main/services/query-service.ts`（主行程端代理）與 `query-worker.ts`（worker 入口），長駐、綁定開啟中的專案：開專案時以 `openReadonlyProjectDB` 開一條唯讀 `timeline.db` 連線（與匯出 worker 同一個函式，核心模組已證明可在 worker 中以模組單例跑）、註冊 Activity 的 UDF 與 TEMP 表、並**擁有**衍生資料庫（`http-body-index.db`，以及 §2 的投影）。
- 移過去的：`executeEventQuery`、`queryActivityPage/Members`、`querySourceSessions`、`aggregateTargets`、`distinctHosts`、`distinctAgentTypes`、`countEvents`、`spanEvents`、`matchEventIds`、`queryEventsPage`、`queryHttpFlowPage`、`queryScreenshotPage`、`queryEventCausalChain`、`content:*` 的讀取與驗證、`GET /api/events*`、`GET /api/export/har`（改走既有匯出 worker 或讀取服務的串流）。
- 留在主行程：所有寫入（`insertEvent`、鏈頭、簽章、companions）、ingest 中順序相關的狀態（causes resolver、去重、lifecycle）、專案生命週期、設定、計時器的寫入部分；以及確定 O(1)／索引 seek 的小讀取（capture-health 探針、`getEventCount('chained')` 快取、`queryEventById`）。
- 刪除：`getReadonlyDB()` 在主行程的使用（主行程只剩 `getDB()`）；`ipc/events.ts` 的同步 handler 變成薄代理（renderer 早就是 `invoke`，介面不變）。
- 協定：請求帶 `{ id, generation, kind, superseding? }`；專案切換時主行程遞增 generation、終止並重建 worker（沿用 `export-runner.ts` 的 `isAllowed` 思路）；同一 `superseding` 鍵（例如同一搜尋框）的排隊請求被丟棄，執行中超過預算的可 `terminate()`（better-sqlite3 無 interrupt，終止 worker 是唯一可中斷手段）；兩條佇列（互動、重型）避免一個 Activity 首建擋住所有計數。

**它建立的不變式。** 主行程不執行任何成本隨專案列數或檔案數成長的讀取。可以被測：見 §7 的匯入邊界掃描（主行程 bundle 不得匯入 `src/core/db/activity-queries`、`event-aggregates`、`http-body-index` 的讀取函式與 `getReadonlyDB`）。

**會打破什麼、如何處理。**
- *寫後讀*：主行程 `insertEvent` 同步 commit 後才回覆 IPC／publish；worker 下一個語句開始新的 WAL 讀交易，必看得到。前提是 worker **不得**跨請求持有讀交易（`readActivity` 用 `db.transaction` 只包一次呼叫，符合；需加測試：寫入 IPC 回覆後立即從 worker 讀到）。
- *匯出快照邊界*：讀取已用 `chainedMaxRowId/loggedMaxRowId` 快照（`ActivitySnapshot`、`ExportSnapshot`），與連線無關，不受影響。
- *鏈驗證*：只讀，不受影響；`verifyChainFullAsync` 可改在讀取服務執行，順便除去主行程上每 1000 列的切片。
- *body 索引的寫入者*：目前 ingest（主行程）與搜尋（主行程）都寫 `http-body-index.db`；移過去後只有 worker 寫，ingest 改送「link 這個事件」訊息、retention 的 `pruneHttpBodyIndex`／`pruneSavedFileIndex` 改送訊息。單一寫入者反而比現在簡單。
- *plugin*：讀取路徑沒有 plugin 程式碼；tailer adapter 仍在主行程（不在本範圍，見 §4）。
- *結構化複製*：頁都有上限（≤1000 列、Activity ≤100/200）；`aggregateTargets` 需要加分頁或上限（目前回傳全部目標）。

**遷移步驟（每步都可出貨）。**
1. 加 `query-service` 骨架與一個讀取（`aggregateTargets`），renderer 介面不變；匯出 worker 已證明 native module 在三平台 worker 中可載入（CI 三平台 unit + 打包）。
2. 依成本順序搬：`executeEventQuery`／`activityPage` → counts/span → 其餘頁面讀取 → API GET 路由。每搬一條，核心函式不改，只換呼叫處；既有核心測試照跑，另加「經 worker 與直接呼叫結果 deep-equal」等價測試。
3. 移交 `http-body-index.db` 擁有權（§2）。
4. 刪除主行程對 `getReadonlyDB` 的匯入，開啟 §7 的匯入邊界閘門。

**影響範圍。** `src/main/ipc/events.ts`、`src/main/index.ts` 的讀取 handler、`src/core/api-server.ts` 的 GET 路由、`src/core/db/index.ts`（主行程不再需要 `roDb`）、`http-body-index.ts` 的呼叫端、`electron.worker.config.ts`／`scripts/build-export-worker.mjs`（多一個 worker 入口）。磁碟資料：無格式變更。既有專案：無遷移。跨平台：Windows 上兩執行緒各一條連線的 WAL 讀取與現況（兩條連線）相同；需在 Windows 跑一次專案切換中途有查詢的 e2e。

**可能出錯。** worker 啟動成本（數十 ms）落在開專案後第一次讀取——在開專案時預熱；worker 崩潰需走既有「讀取失敗保留上次值」狀態，不可靜默空白；Activity TEMP 表跟著連線走，worker 重建時需重新投影（§2 解決）；記憶體多一份 SQLite page cache（預設 2 MB 級，可忽略）。

**驗證。** 單元：等價測試；寫後讀測試；generation 測試（切換專案時舊請求被拒）。量測：§7 的 watchdog 在 e2e 中 0 次超標；把本報告的 25 萬列腳本搬成 `REDLOG_PERF` 測試，量「查詢執行中主行程最長停頓」< 50 ms（不是查詢耗時）。實機：live ingest + 搜尋時 hook 不再 spool。Windows／Linux 各一次。

---

## 2. 發現二：讀取時重算衍生狀態，並由 live batch 重複觸發

**機制。** 幾個「目前狀態」只在讀取時算：搜尋的 body coverage、Activity 投影與分組、目標與 host 彙總、Activity 頁的總數。renderer 在每個 `events:new-batch` 後要求重讀（`TargetView.tsx:105-115`、`TargetsScopeHeader.tsx:33-44`、`DashboardView.tsx:198`、`useAppCounts.ts:99-102`），`throttledRead` 把頻率壓到每 1–1.5 s 一次——但每次的成本仍是 O(專案)。只要單次成本超過間隔，主行程就在 live ingest 期間持續飽和；這正是「即時寫入時主行程最長停頓」的形狀。

**實例。**
- `bodySearchCoverage`（`http-body-index.ts:430-494`）：每個文字搜尋**每一頁**（`executeEventQuery:1255`、Activity `setup:112`）都 `iterate` 全部 content-ref 列、`JSON.parse(row.data)`、每個參照一次索引查詢、一次 sha256 update。實測 1.9 s @10 萬參照。#695（`2b708a60`）只把 `sync` 增量化；它的提交訊息「~2.5 s → ~140 ms」是 2 萬參照下的 body id 部分，coverage 的全走訪沒動。
- `recheck`（同檔 :331）：每次搜尋對每個已驗證參照 `lstat`，並對每個 `verified_desc IS NULL` 的參照（missing／failed）重新 `linkEvent`。retention 的大小壓力淘汰（`sweepBodyStore`）會把 body 變成 missing——**啟用 retention 的專案，每次搜尋都重試全部被淘汰的 body**。（實測佐證：fixture 的 size 寫錯讓 2 萬參照全為 failed，重複搜尋每次 1.5–1.7 s，profile 顯示 `recheck→linkEvent→withVerifiedFile` 為主。）
- Activity 投影是連線內 TEMP 表（`activity-queries.ts:45-66`），每次啟動、每次專案切換、每次讀取失敗以外的清除後，第一頁都要把全專案逐列跑 3 個 JS UDF：實測 11 s @25 萬列。之後每頁仍有 `COUNT(*) OVER()` 物化全部 group（第二頁 2.6 s）。
- `aggregateTargets` 回傳全部目標、每批後兩個元件各讀一次；`distinctHosts` 每次全表 `json_extract`。
- 歷史：Activity 每次讀取重新分組（已改為 `activity_groups_v1`）、首次搜尋（已改為持久化驗證）、`liveTotal`／`known` 清單的 renderer 端增量化（Timeline 70k 18.2 s → 1.1 s）——同一機制在 renderer 端也出現過，當時的解法就是增量物化。

**為何過去的修正是治標。** 每次增量化的是**一個**投影的**一部分**，而且維護動作仍掛在讀取上（`syncProjection` 在讀取時追趕、`sync` 在搜尋時追趕），於是「第一次讀取」永遠付全部成本，而 live ingest 時每次讀取都付「自上次以來」的成本。

**結構改變——寫入後增量物化（選項 d），由讀取服務擁有。**
- 新增 `derived.db`（或併入 `http-body-index.db`，同為不進 bundle 的衍生檔），由讀取服務 worker 唯一寫入，持久化：Activity 投影與 group 表（現在的 TEMP schema 原樣搬過去，加 `watermark` 表）；body 參照狀態（已存在）與**coverage 計數器表**（每種 kind × status 的 count、bytes，在 `linkEvent` 改狀態時以差量更新，revision 以單調序號取代全走訪雜湊）；目標彙總表（`target_lower → count, first, last, display`）。
- 維護：主行程每次 commit 後送 `{chainedMaxRowId, loggedMaxRowId}` 給 worker（可合併），worker 在背景以小交易追到 watermark；讀取只讀物化表 + 「watermark 之後尚未物化的列」的小範圍補算（Activity 已有 `dirty` CTE 這個做法）。
- 讀取回傳 `derivedThrough` 水位；UI 在水位落後時顯示既有的「pending」狀態（coverage 已經有 `pending`/`partial` 狀態與文案）。
- 刪除：`bodySearchCoverage` 的全走訪；`recheck` 的每搜尋全 lstat（改為背景週期性、限時切片）；missing 參照在每次搜尋重試（改為檔案事件或背景週期）；renderer 對整案彙總的每批重讀（改讀物化表，成本 O(結果頁)）。

**不變式。** 任何讀取的成本 O(頁大小 + 未物化尾端)，與專案大小無關；第一次讀取與第 N 次讀取成本相同。測試：在 1 萬與 10 萬列兩個資料集上，同一讀取「掃描的列數」（以 worker 內計數器或 `EXPLAIN QUERY PLAN` 判定）不隨總列數成長。

**會打破什麼。**
- *「不進 bundle」*：`activity-queries.ts:45-46` 的註解刻意讓投影只活在連線內，「no cache enters an evidence bundle」。持久化檔必須與 `http-body-index.db` 一樣被 bundle、匯出與 `verify:package-resources` 排除；加測試。
- *retention 改寫歷史*：`sweepLoggedTier` 刪除列、rowid 可能重用。現行 `syncProjection` 遇到快照不一致就整個清掉重建（:144-149）；持久化後需要 retention 送「已刪除到 rowid X」訊息，worker 以範圍刪除投影，而不是重建全部。
- *Activity 游標的快照語意*：游標裡的 `ActivitySnapshot` 以 rowid 界定，物化表也以 `_row` 界定（`within()`），語意可原樣保留。
- *coverage revision*：游標比對 `coverage.revision`，改為序號後語意是「索引狀態有變」，比全走訪雜湊更精確。

**遷移。** 先在讀取服務裡把 TEMP 表換成持久化表（同 schema），開專案時背景追趕並顯示 pending；再換 coverage 為計數器（以「計數器結果 == 全走訪結果」做 21 步腳本等價測試，沿用 `test/http-body-index-incremental.test.ts` 的形式）；最後換目標彙總。每步都可單獨出貨。

**影響範圍。** `activity-queries.ts`、`http-body-index.ts`、`event-aggregates.ts`、`retention.ts`（送訊息）、renderer 的 TargetView／TargetsScopeHeader（介面不變）。磁碟：每專案多一個衍生檔，升級後首次開啟於背景建立（現有專案不需停機遷移）。

**可能出錯。** 物化與來源不同步（最大風險）：每個物化表都要有「從零重建 == 增量結果」的性質測試；`user_version` 變更時整檔丟棄重建。

**驗證。** 等價（增量 vs 全建）、retention 刪除後的等價、30 萬列資料集上首開 Activity 的主行程停頓（應接近 0，因為在 worker 且背景）。

---

## 3. 發現三：ingest 以位元組設上限，沒有以時間設上限；衍生工作同步做在寫入路徑上

**機制。** `ingest()`（`ingest.ts:132`）是每個事件的唯一入口，順序為：閘門 → causes → enrich（loot、目標、標籤、憑證）→ 遮蔽 span → `insertEvent` → body link → publish → scope → companions。每一步都同步。上限只有請求大小（20 MiB）與 mitm 的 `REDLOG_MAX_BODY`（10 MB，可由環境變數調高），這些限的是位元組，不是時間，而且有幾項工作的成本與位元組不成線性：
- loot：內建 pattern 在主行程跑全文（`loot-detector.ts:207-211`），命中數無上限；收尾紀錄 8 MiB 輸出 8.5 s（已列待辦）。
- 遮蔽：`detectRedactions` 把**本事件的全部 loot 值**加入 denylist（`ingest.ts:637`），每個欄位重新 `compileList`（`redaction.ts:214`），再對每個 token 比對 + entropy；命中數 N 時是 N 條 denylist × 全部 token。
- body：`extractBodyToSidecar` 解 base64、sha256、寫檔；接著 `linkHttpBodyEvent`（`ingest.ts:290`）**再讀一次同一檔、再 sha256、UTF-8 decode、分塊寫 FTS**。10 MB 回應等於在主行程處理 ~30 MB。
- plugin loot/遮蔽規則在 worker，但主行程 `Atomics.wait` 最多 250 ms／次，且卡住的規則被停後「其餘規則重跑」。

**實例。** 8 MiB 輸出 8.5 s（#695 待辦）；二次方的 secret pattern 從 ingest 拋出（已修為線性）；loot 行號查找二次方（13 s/1 MB，已修）；`POST /api/loot/scan` 限制到 128 KiB（因為「scan runs on the main thread」，`api-request.ts:88`）。

**為何治標。** 每次修的是一個演算法的複雜度或加一個大小上限；下一個非線性（命中數 × denylist、FTS 分塊）仍在同一執行緒上。「限制到 128 KiB 讓最壞情況 < 200 ms」這種推理，本身就說明了上限是為了主執行緒而設、而不是為了產品。

**結構改變（選項 c 的修正版）。** 分成三類，各有不同答案：
1. **進鏈的推導**（loot 命中 → `loot` 事件、`data.redactions`、`detectedTarget`、標籤、companion）：它們的結果是鏈內列的內容，不能變成「之後再補」。改為：主行程做閘門與 causes（有狀態、需依序、便宜）→ 把 `(data, 規則版本)` 交給推導 worker 計算 plan（純函式，`enrich` 已是純的，只讀 `lootDetectorRef`／`getRules()`／plugin 規則）→ 主行程依**接收序號**依序 `insertEvent` 與 companions。小事件（例如 < 64 KiB 文字）維持同步路徑，避免每事件一次訊息往返；大事件走 worker。不變式：同樣輸入產生位元組相同的列（`test/ingest-golden.test.ts` 已存在，擴充成「同步路徑 vs worker 路徑」等價）。
2. **不進鏈的衍生**（body FTS、Activity 投影、目標彙總）：真正的 post-commit 非同步（§2），以 watermark 與 pending 狀態對外說明。`linkHttpBodyEvent` 從 ingest 移除，改為 commit 後通知讀取服務。
3. **命中數本身**：單一 loot 事件設上限並標記 `truncated`（已在待辦；在本結構下仍需要，因為它限制的是鏈內列大小，不只是時間）。

**為何不全部做成 post-commit（純選項 c）。** `data.redactions` 是在 insert 前算出並寫進被雜湊的列（`ingest.ts:257-260`：「the bytes stay so the chain closes over the true text」），loot 事件以 `_causes` 指向本事件且需在同一順序中出現；把它們改成「之後的 annotation 列」會改變鏈的內容契約、UI 遮蔽與匯出 sanitize 的資料來源，影響面遠大於把計算搬到 worker。

**會打破什麼。** 接收序與寫入序：API 回覆從同步變成等待 worker 完成，hook 看到的延遲在大事件上變長但主行程不卡；必須保證同一 `command_id`／`terminalId` 的事件不被小事件超車——最簡單的規則是「只要佇列非空，小事件也排隊」，即全域 FIFO，worker 只是把 CPU 移走。`ingestEvent()` 對 19 個 in-process producer 是同步回傳的；第一階段只讓 `POST /api/events` 與 tailer 走非同步，其他 producer（system 事件）維持同步但同樣進 FIFO（佇列空時立即執行）。規則版本：loot/遮蔽設定變更時 worker 收到新快照，計畫帶版本號，主行程寫入時比對，不符就重算（與 export 的 redaction-revision 複查同一模式）。

**影響範圍。** `ingest.ts`、`api-server.ts` 的 POST 路由、`tailer-host.ts` 的 `processUnit` 呼叫處、`loot-detector.ts`／`redaction.ts`（規則快照可序列化）、新 worker 入口。磁碟：無。

**驗證。** 等價（golden）；順序性質測試（隨機大小事件交錯，寫入序 == 接收序）；8 MiB 輸出時主行程最長停頓 < 50 ms；hook 不 spool。

---

## 4. 發現四：留在主行程的維護工作以「階段」或「N 列／N MiB」讓出，不是以時間讓出

**機制。** 寫入必須留在主行程，所以有些工作沒辦法移走；它們自己切片，但切片單位都是資料量或程式階段，單片的時間仍隨資料而變：
- 開專案時 `drainSpool()` 無上限（`index.ts:949`），每個 spool 檔走完整 ingest；週期 drain 才切 10 檔一片（`7367cc75` 專門為此修過，只修了週期那一半）。
- `sweepLoggedTier` 每批 5000 列、最多 10 000 批，中間不讓出（`retention.ts:180-185`）；設計文件說分批是為了 WAL（「so a 40 GB sweep doesn't stall WAL」），不是為 event loop——同發現一的混淆。
- `scanCandidates`（`scope-recompute-run.ts:65`）整段同步，讓出點在讀與寫之間（:219、:238）。
- tailer：`registerSession` 每個 session 整檔讀 sidecar 並 sha256（`tailer-host.ts:1360`），最多三次；catch-up 每片 10 MiB。
- `verifyChainFullAsync` 每 1000 列讓出（列大小不定，AI transcript 列平均 3.8 KB 時一片仍短；這條是健全的）。

**結構改變。** 一個共用的協作排程器 `cooperative(task, { budgetMs: 8 })`：任務以 generator 寫，排程器在**時間**到時 `setImmediate`，並在 generation 變更時停止。上面幾項改寫成 generator；只做讀取的部分（`scanCandidates`、sidecar 雜湊）移到讀取服務，主行程只做最後的寫入批次。開專案的 spool drain 改用與週期相同的切片並在背景跑（專案先可用，spool 補進來時 Timeline 照常即時更新）。

**不變式。** 主行程上的維護任務單一片 ≤ budget；可由 §7 的 watchdog 歸因驗證。

**影響範圍。** `retention.ts`、`scope-recompute-run.ts`、`index.ts` 的 `startProject`、`tailer-host.ts`。風險：retention 期間 ingest 交錯寫入——已是 WAL 單寫者，分批 DELETE 之間插入 INSERT 沒有問題；scope recompute 已處理「讓出期間專案切換」（`signal`）。

---

## 5. 已經離開主行程的工作，以及為何其他重讀取沒放過去

| 項目 | 機制 | 契約 |
|---|---|---|
| 匯出（plan、validate、logged-digest、bundle、direct-bundle、HAR、events）`export-runner.ts` + `export-worker.ts` | 每任務 `new Worker`；worker 以 `openReadonlyProjectDB` 取代模組單例、`BEGIN` 取快照、`ROLLBACK`；主行程每 25 ms 輪詢 `isAllowed`；暫存目錄由主行程建立並驗 inode | 只回傳 plan metadata 或暫存檔路徑；主行程重驗專案、DoNotExport、policy、redaction revision 後才發佈；鏈內的 digest 事件由主行程寫（`6264138f`） |
| plugin regex `bounded-regex.ts` | eval worker + `SharedArrayBuffer`；呼叫端同步 `Atomics.wait` 最多 250 ms | 給的是**時間上限**，不是回應性：主行程在這段時間完全阻塞；首次啟動 worker 最多等 5 s（:95） |
| `verifyChainFullAsync`、cast index backfill、週期 spool drain、tailer catch-up | 主行程上切片 | 見 §4 |
| screenshot 讀取（protocol handler）、screenshot 寫入 | `fs.promises` | 健全 |
| 監控（connection/process/opsec/network） | `execFile` 子行程 | 健全 |

**為何互動讀取沒放進匯出 worker。** (1) 每任務一個 Worker、每次開 DB、載入模組：數十 ms，對每次按鍵的搜尋太慢；(2) 契約是「回傳 metadata 或檔案」，不是頁結果；(3) Activity 依賴連線內 TEMP 表與 UDF，必須是長駐連線才有意義；(4) body 索引要寫 `http-body-index.db`，而匯出 worker 定位為唯讀；(5) 匯出有天然的「發佈」關卡，互動讀取沒有。這些都不是不能做的理由，而是**需要另一種 worker**（長駐、綁專案、可寫衍生檔、可取代請求）。核心模組以模組單例存取 DB、而 `openReadonlyProjectDB` 已能在 worker 內替換單例——這是讓 §1 可行的既有基礎。

---

## 6. 啟動與開專案

**第一個視窗繪製之前**（`index.ts:1363-1448`）：`restrictRedlogHome`（與專案數成正比，小）、`refreshInstalledHooks`、`startApiServer`（非同步）、CSP 與 protocol 註冊、`createMainWindow`。與專案大小無關，健全。

**專案可用之前**：`project:open` IPC 同步執行 `startProject`（`index.ts:731`），renderer 的每個 IPC 都排在它後面（註解自己也說了）：
| 步驟 | 隨什麼成長 | 有無上限 |
|---|---|---|
| `initDB` → `applySchema`（單一交易） | schema 變更時的 backfill `UPDATE … SET col=json_extract(…)` 與 FTS 重建（`index.ts:105-118`、:442） | 一次性，但對 1M 列是分鐘級、無進度、主行程凍結 |
| `sweepRetention`／`sweepBodyStore`／`sweepArtifactStore`（opt-in） | 目錄檔數（readdir + 每檔 stat）、刪除數（每刪一檔一個 chained 事件） | **無界** |
| `sweepLoggedTier`（opt-in） | 待刪列數 | **無界**（§4） |
| `recoverOrphanSessions` | 孤兒 session 數 | 小 |
| `drainSpool()` | spool 檔數 × ingest | **無界**（§4） |
| `initPlugins` | plugin 數 | 小 |
| `verifyRandomSample(100)` | 固定 | 健全 |
| tailer `registerSession`（chokidar `add`，開專案後陸續） | 所有曾見 session 的 sidecar 總位元組（讀 + sha256） | **無界**，分散在多個回呼但每個回呼不限時 |

**專案可用之後的第一批讀取**：Activity 首頁投影（實測 11 s @25 萬列）、首次搜尋全走訪（重啟後走持久化簽章：讀每列 + lstat 每檔；收尾紀錄 7 萬筆約 4–5 s）、`aggregateTargets`。這三項就是「開啟後第一次搜尋」與「活動頁那次停頓」的來源；在 §1/§2 之後它們都在 worker 背景完成，主行程不受影響，UI 顯示 pending。

**建議**：`startProject` 拆成「同步的最小可用」（config、`initDB`（無 schema 變更時）、ingest 接線、API 綁定、`session_start`）與「背景的維護」（retention、spool、tailer 登記、預熱讀取服務），後者經 §4 的排程器；schema 遷移若需要 backfill，進度要能顯示（目前沒有），長期可改為 worker 內以唯讀方式預先計算再在主行程短交易套用——UNCONFIRMED 是否值得，取決於未來是否還有 backfill 型遷移。

---

## 7. 執法：讓下一個無界 handler 在出貨前失敗

時間比例測試在 CI 上被證明太吵（`57edf4cf`、收尾紀錄 §4「改為 `REDLOG_PERF=1` 才執行」），所以主要閘門必須是**決定性**的，計時只當後盾並負責「說出名字」。

1. **匯入邊界閘門（決定性，第一道）。** 仿 `test/test-hooks-scan.test.ts`：掃描 `src/main/**` 與 `src/core/api-server.ts`，凡匯入 `getReadonlyDB`、`db/activity-queries`、`db/event-aggregates`、`http-body-index` 的讀取函式、`executeEventQuery`、`queryEvents` 等「讀取服務專屬」符號者失敗，白名單只有 `query-worker.ts`。新讀取若寫在主行程，typecheck 照過、這個測試失敗。可併入 `verify:architecture`。
2. **handler 登記與成本等級。** 以 `registerHandler(channel, { cost: 'constant' | 'indexed' | 'service' }, fn)` 取代裸的 `ipcMain.handle`；掃描測試拒絕 `src/main` 內的裸 `ipcMain.handle(`／`ipcMain.on(`（`context-menu` 等少數以白名單列出）。`indexed` 等級的 handler 必須在 `test/query-plans.test.ts` 有對應的 `EXPLAIN QUERY PLAN` 斷言（不得出現無 LIMIT 的 `SCAN events`／`SCAN events_logged`，或 `USING INDEX` 的全索引掃描）。API 路由同樣登記。這是選項 (b)，但以「放在哪裡」表達預算，而不是以毫秒。
3. **dev／e2e 的 runtime watchdog（後盾，負責歸因）。** 主行程在 `testHooks.e2e`（或 dev）時：
   - `perf_hooks.monitorEventLoopDelay({ resolution: 10 })`；
   - `registerHandler` 與 API dispatcher 包一層計時，單次 > 100 ms 記下 `{channel, ms, at}`，dev 下 `console.warn`；
   - 經**測試專用**路由（只在 `testHooks.e2e` 註冊，如同 `/api/events/seed`）或 preload 的 e2e 橋回傳 `{ loopMax, p99, slowHandlers }`；
   - e2e 共用 fixture 的 `afterEach` 讀取並在 `loopMax > 500 ms`（排除開專案後 2 s 視窗）時失敗，錯誤訊息列出 `slowHandlers`——依 CLAUDE.md「make it name something」。
   未提交的 `zz-qa-abuse.spec.ts` sampler 要成為正式版本需要改的地方：不能用 `app.evaluate`／`process.mainModule.require`（正式版已關 inspector，smoke 版才允許，且不應依賴）；不能 monkeypatch `ipcMain._invokeHandlers`（私有）；門檻不能用 QA 啟發式的 200 ms（CI runner 會誤報），用 500 ms 並以歸因為主；必須在每個 spec 自動啟用，而不是一支 15 分鐘的專門 spec。
4. **規模 lane（opt-in，但每週排程）。** 把本報告的資料集（25 萬列、10 萬 body 參照）做成 `REDLOG_PERF` 測試：每個 `service` 等級讀取在 worker 執行期間量主行程最長停頓（`setInterval(2ms)` 取樣，與 `export-main-thread-stall.test.ts` 同法），斷言 < 50 ms；並對 `indexed` 等級量「1 萬列 vs 10 萬列」的時間比 < 3（次線性）。排程 workflow 每週跑一次，失敗開 issue。

---

## 結構答案對照（a/b/c/d）

| 選項 | 給的不變式 | 會打破 | 規模 | 順序 |
|---|---|---|---|---|
| (a) 讀取服務 worker | 主行程無 O(專案) 讀取；讀取再慢也不擋 capture | 寫後讀（需不跨請求持有讀交易）、專案切換（generation）、body 索引單一寫入者 | 中：一個 worker 入口、約 30 個 handler 改為代理、核心不動 | 2 |
| (b) 成本預算 | 新 handler 必須宣告位置；邊界掃描阻止回歸 | 無（純閘門），需白名單 | 小 | 1（與量測同時）、4（收緊） |
| (c) ingest 衍生工作 | 進鏈推導：列內容不變、CPU 移走；不進鏈衍生：post-commit + pending | 接收序 vs 寫入序（全域 FIFO 解決）、同步 `ingestEvent` 呼叫端、規則版本 | 中到大 | 5 |
| (d) 增量物化 | 讀取 O(頁)；首次＝第 N 次 | 「不進 bundle」需保持、retention 刪除需傳遞、增量／全建等價 | 中 | 3 |

只做 (d) 不做 (a)：每次讀取變快，但下一個新讀取仍會以同步全掃描的形式回到主行程，且物化維護本身在主行程上與 ingest 競爭。只做 (a) 不做 (d)：主行程不卡，但搜尋與 Activity 在 worker 裡仍要 2–11 s，操作者看到的是慢的結果而不是凍結的 app——比現在好，但不夠。(b) 單獨無法修任何現存問題。所以順序是 (b 的量測部分) → (a) → (d) → (c) → (b 的收緊)。

---

## 檢查過、健全

- capture-health：探針為等式索引 seek，`HEALTH_TTL_MS` + 事件失效，`test/query-plans.test.ts` 鎖住計畫。
- `verifyRandomSample`：rowid 抽樣，固定成本。
- 匯出全系列在 worker；主行程最長停頓已有測試（`test/export-main-thread-stall.test.ts`）。
- `matchEventIds` ≤1000、`events:getById` ≤200、`events:commandOutput` ≤2000、API `limit` 上限、查詢字串 ≤1000、`/api/loot/scan` ≤128 KiB、請求 ≤20 MiB。
- `getEventCount('chained')` 有快取；`getEventCount('logged')` 25 萬列 5 ms。
- screenshot protocol 非同步讀檔；週期 spool drain 切片；cast index backfill 每檔讓出；`verifyChainFullAsync` 切片。
- `withActiveScope` 每次讀 config（`loadConfig` 同步）——成本隨設定檔大小，屬小常數。

## 刻意如此（有註解或 spec）

- 連線內 TEMP 的 Activity 投影：「no cache enters an evidence bundle」（`activity-queries.ts:45-46`）——持久化時必須保留這個性質。
- body 搜尋信任持久化檔案簽章、原地改寫且五項屬性不變的檔案在搜尋中不被察覺（`http-body-index.ts` 開頭註解、收尾紀錄 §3）；讀取內容時仍驗證。
- `bounded-regex` 的同步呼叫契約（Spec 033）：呼叫端保持同步是刻意設計；本報告只指出它不提供回應性。
- logged tier 每批 5000 列刪除（DESIGN-logged-tier-retention §5.3），目的為 WAL；本報告建議另加時間讓出，不改批大小。
- 遮蔽 span 在 insert 前計算並進鏈（ingest.ts 步驟 4 註解、redaction-design layer 2）。

## 未確認（UNCONFIRMED）

- 1.1M 列的數字是由 25 萬列線性外推；查詢計畫或快取在更大資料集上可能非線性。確認方式：同腳本以 `LG=1000000` 在閒置機器重跑。
- 量測時 load average 約 15；絕對值可能偏高 1.5–3 倍。比例（coverage 佔重複搜尋 ~80%、首開 Activity 為重複頁的 ~4 倍）較可信。
- Activity 空查詢第二頁仍 2.6 s 的主因未剖析（推測為 `COUNT(*) OVER()` 物化全部 group 加 `dirty` CTE）；確認方式：`--cpu-prof` 加 `EXPLAIN QUERY PLAN`。
- tailer 開專案時 sidecar 讀取 + 雜湊的實際總量未量；取決於操作者的 AI transcript 量。確認方式：在真實專案記錄 `registerSession` 耗時。
- schema backfill／FTS 重建在 1M 列上的時間未量。
- `/api/sanitize` 的 `event_ids` 是否有上限未檢查。
- 量測方法：暫存目錄中以 esbuild 打包、直接呼叫 `initDB`、`executeEventQuery`、`queryActivityPage`、`aggregateTargets`、`distinctHosts`、`bodySearchCoverage`；資料為 5 萬 chained shell 列 + 20 萬 logged scanner 列（其中 10 萬帶 `response_body_ref`，指向 2 萬個實體 body 檔）。腳本已刪除，未留在任何位置。
