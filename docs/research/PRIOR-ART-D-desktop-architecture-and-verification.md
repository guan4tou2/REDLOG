# D — 桌面應用的程序／執行緒架構、增量投影、卡頓監測、renderer 資料流與驗證策略

閱讀日期：2026-11-12。標記規則：**[來源]** 有一手來源並附 URL；**[推論]** 由來源推導；**[未驗證]** 依記憶或只找到二手資料。

## 摘要表

| 主題 | 收斂的設計（≥3 個系統同意） | 最小可採用版本 | 主要來源 |
|---|---|---|---|
| 1. 同步 DB 的程序模型 | 主程序不做阻塞工作；DB 放到 worker；**單一 writer + 多 reader**（WAL）；連線本地狀態（temp table）的查詢固定在 writer；自管 checkpoint | 每專案 1 writer worker + 1–2 reader worker；writer 回傳 `commitSeq`；reader 請求帶 `minSeq`，由 dispatcher 保證 RYW | Signal `ts/sql/main.main.ts`、SQLite WAL/isolation 文件、Electron performance、Notion WASM SQLite |
| 2. 增量衍生資料 | 衍生資料 = 由有序 log 推進的投影，記錄「已處理到哪個 seq」；變更通知以 key/topic 為單位；FTS 用 external-content + trigger 或批次推進並以 `merge` 分段整理 | 投影表 + `projection_cursor(name, last_seq)`；追不上時 UI 顯示「索引中（落後 N 筆）」 | SQLite FTS5、update_hook、session、Replicache、Linear（逆向）、Chromium sequences、LMAX |
| 3. 預算與看門狗 | 量「延遲」而不是「做什麼」：event-loop delay 直方圖 + long task / LoAF 歸因；超標時才採樣堆疊；CI 用計數或歷史離群判定而非固定毫秒 | 主程序：`monitorEventLoopDelay` + 包裝每個 IPC handler 的計時；超過門檻記下 handler 名；e2e 以「超標次數＝0（門檻寬）」+ 記錄最大值，不比絕對時間 | Node perf_hooks、VS Code unresponsive sampling wiki、W3C LoAF、Electron `collectJavaScriptCallStack`、rustc-perf、iai、Perfherder |
| 4. renderer 資料流 | 結果以「問題（key）」為鍵；`status` 與 `fetchStatus` 分離；以 tag/topic 失效而非逐事件 patch；換 key 時保留舊資料並標示 placeholder；晚到的舊回應不得覆蓋新狀態 | 自寫 `Map<keyString, Entry>` + `topics: Set` + 單調 `requestId`；導覽堆疊存 `{view, params, scroll, selection}`；層級化 Escape | TanStack Query、RTK Query、Relay 連線規格、React `Activity`、VS Code 1.65 導覽、Radix DismissableLayer、APG、WebKit bug 165004 |
| 5. 讓綠燈有意義 | 不用真實 sleep；時間由測試控制；模組單例每測重置；flaky 隔離有明確出口；skip 要有原因並被計數；平台矩陣明文宣告；發行版另跑 smoke | 測試時間 harness（fake clock + 明確 flush）；`capabilities.json` + skip 計數 gate；發行版 smoke 用 app 內建自檢旗標，結果寫檔＋exit code | Testing Library、Vitest、Playwright clock、Google flaky/mutation、Stryker、pytest、test2json、Bazel、Node tiers、Electron fuses、VS Code smoke |

---

## 1. 同步嵌入式 DB 的程序與執行緒模型

### 1.1 Signal Desktop 的 SQL 層 [來源]
讀的是 `main` 分支當前版本（2026-11）：`ts/sql/main.main.ts`、`mainWorker.node.ts`、`WalCheckpoints.std.ts`、`Server.node.ts`。
- **位置**：DB 不在 renderer，也不在主程序的 JS 執行緒；`MainSQL` 類在主程序管理 **`WORKER_COUNT = 4`** 個 `worker_threads`，每個 worker 跑 `bundles/workers/sql.js` 並各自開連線。https://github.com/signalapp/Signal-Desktop/blob/main/ts/sql/main.main.ts
- **writer/reader 分工**：`#pool[0]` 是 primary，初始化時收到 `isPrimary: true`，**唯一處理寫入**（`sqlWrite`）。其餘三個只讀。primary 先初始化（跑 schema migration），其餘再並行初始化。
- **路由**：讀取送到 `load`（in-flight 數）最低的 worker。**例外**：`pageMessages` 等分頁查詢固定在 primary，註解說明它需要存取同一個 temporary table。→ 教訓：**依賴連線本地狀態（TEMP table、`last_insert_rowid`、未提交交易）的查詢不能分散到 reader**。
- **排序**：沒有通用佇列；請求用 `seq` 編號配對回應。worker 端 `onMessage` 完全同步，所以每個 worker 內部依序執行。寫入的順序只靠「全部進 primary」保證。`pauseWriteAccess()` 可暫停寫入（備份分頁時用）。
- **Read-your-writes**：`main.main.ts` **沒有明確機制**。寫入在 primary 回覆後才 resolve，之後送出的讀取會開新 read transaction，因此在 WAL 下看得到已提交的資料（見 1.4）。風險只在「寫入回覆前就發出的讀取」。[推論]
- **Checkpoint**：用 `sqlite3_wal_hook` 自管。`PAGE_THRESHOLD = 1000`；一般 commit 後節流 `30_000 ms`，有 delete 後縮短為 `5_000 ms`；用 `wal_checkpoint(TRUNCATE)`；只在所有 worker `load === 0` 時才在 primary 執行；`SQLITE_LOCKED` 每 1000 ms 重試（TODO 註記可能需要 backoff）。https://github.com/signalapp/Signal-Desktop/blob/main/ts/sql/WalCheckpoints.std.ts
- **Pragma**：`journal_mode = WAL`、`synchronous = FULL`、`foreign_keys = ON`、`checkpoint_fullfsync = true`；可見部分沒看到 `busy_timeout`／`query_only`（檔案過大，只讀到前 40%）。
- **可觀測性**：`MIN_TRACE_DURATION = 40` ms 以上記 `slow query`（打包版也記）；`startTrackingQueryStats()` 按查詢名累計次數／總時間／最大值，輸出前 10 名。
- **為何搬到 worker、何時改成 pool**：在 commit 歷史中沒找到明確說明。[未驗證]

### 1.2 VS Code 程序模型 [來源]
https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox （2022-11）
- main（入口，處理輸入，**不可過載**）／每個視窗一個 renderer（sandbox 化，不用 Node）／shared process（隱藏視窗，原本是 terminal 與 file watcher 的父程序，計畫改成 utility process）／每個視窗一個 extension host（已改為 utility process）。
- **搬遷原因**：sandbox renderer 不能用 Node；native module 無法打包進 web；會 fork 的元件（extension host、terminal、file watcher、search、task、debug）需要別的宿主。search 搬到 extension host，因為它本來就有支援 remote 的實作。
- **MessagePort**：shared process 建立一對 port，自留一端，另一端經 main 與 preload 轉給 renderer → 之後流量**不經過 main**。
- **改錯又改正**：先在 Insiders 以 `window.experimental.useSandbox` 預設開啟，按月逐步交付；新增 `electron-sandbox` 建置目標，用到 Node 就讓建置失敗（用工具守住邊界，而不是靠約定）。
- pty host 單獨成程序的理由：官方文件沒找到。[未驗證；二手資料說是為了隔離 terminal I/O]

### 1.3 Electron 官方指引 [來源]
- performance：不要阻塞主程序（它是 UI thread，負責視窗、輸入、IPC）；CPU 密集工作用 worker threads；**避免 sync IPC 與 `@electron/remote`**；先 profile 再優化。https://www.electronjs.org/docs/latest/tutorial/performance
- `MessageChannelMain`：只能用 `ipcRenderer.postMessage`／`webContents.postMessage` 傳 port（`invoke` 不行）；主程序端要 `port.start()`；Electron 額外提供 `close` 事件；有「reply stream」模式（請求附 port，回應分批串流後關閉）。https://www.electronjs.org/docs/latest/tutorial/message-ports
- `utilityProcess`：Chromium Services API 啟動的 Node 子程序，支援 `MessagePortMain` 傳遞，`serviceName` 會出現在 `app.getAppMetrics()` 與 `child-process-gone`。https://www.electronjs.org/docs/latest/api/utility-process
- better-sqlite3：主執行緒通常夠快；只有「非常慢的查詢」才建議 worker pool。範例中每個 worker 自開連線，worker 崩潰會重生，查詢錯誤沒有 try/catch 會讓 worker 崩潰（範例缺陷）。https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md

### 1.4 SQLite 併發事實（設計依據）[來源]
- WAL：**同時只能有一個 writer**；reader 與 writer 互不阻塞。https://www.sqlite.org/wal.html
- 每個 read transaction 有自己的 end mark，看到的是開始那一刻的 snapshot。不同連線之間是 snapshot isolation；**同一連線內沒有隔離**，邊 SELECT 邊改同一表的結果未定義（可能重複或出現已刪列）。https://www.sqlite.org/isolation.html
- 讀到舊 snapshot 後升級為寫入，會得到 `SQLITE_BUSY_SNAPSHOT`；寫入交易用 `BEGIN IMMEDIATE` 可避免。
- **長時間 reader 會讓 checkpoint 停住**，持續有 reader 時 WAL 會無限增長；解法是留出「reader gap」或用 RESTART/TRUNCATE（代價是 reader 可能被擋）。
- 自動 checkpoint 由**觸發 commit 的那條執行緒**執行，所以那次 commit 偶爾會特別慢；官方建議關掉自動 checkpoint，改在別的執行緒或程序定期執行。`synchronous=NORMAL` 時只有 checkpoint 會 fsync。
- `sqlite3_wal_hook` 可在每次 commit 後被呼叫（Signal 就是這樣用）。
- **同一執行緒開第二條讀連線沒有收益**：better-sqlite3 是同步 API，查詢期間 JS 執行緒被佔用，與幾條連線無關；WAL 的讀寫並行只有在 reader 位於不同執行緒時才能實現。[推論，由 better-sqlite3 同步模型與 WAL 文件推出]
- `busy_timeout`、`PRAGMA data_version`（偵測其他連線是否提交過，可作 reader 端快取失效依據）：本次沒有讀原文。[未驗證]

### 1.5 其他系統
- **Notion（瀏覽器版 WASM SQLite）**[來源] https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite ：v1 是每個分頁各自寫入 → **重複 ID、資料錯亂**，原因是多寫入者併發。v2 由 SharedWorker 選出唯一的「active tab」，所有查詢都送到它的 worker，用 Web Lock 偵測分頁關閉。另一教訓：同步載入 WASM 讓首頁變慢，改成非同步；慢磁碟裝置 p95 變差，改成讓 SQLite 與 API **賽跑**。→ 收斂點：**單一 writer 是正確性需求，不只是效能選擇**。
- **Slack**：用 Electron `contentTracing` 收 Chrome trace 排查效能問題，並點名 **sync IPC** 是常見元兇。https://slack.engineering/chrome-tracing-for-fun-and-profit/ （細節未逐段讀）
- Discord、Figma、Obsidian、Linear 桌面版的 DB 執行緒模型：沒找到一手資料。[未驗證]

### 1.6 收斂與差異
- 收斂：主程序不做重活（Electron、VS Code、Slack）；單一 writer（SQLite 本身、Signal、Notion）；用 MessagePort 讓資料不經 main 轉送（VS Code、Electron 文件）；自管 checkpoint（SQLite 建議、Signal 實作）。
- 差異：Signal 用 worker_threads（同程序、共享記憶體位址空間、崩潰會拖累主程序？[未驗證]）；VS Code 偏好 utility process（崩潰隔離、可在 process explorer／`getAppMetrics` 看到）。選擇依據：要不要獨立崩潰、要不要 native module 隔離。

### 1.7 移轉評估
- **可移轉**：Signal 的 primary + reader pool、按 load 分派、慢查詢門檻記錄、TEMP 依賴查詢固定在 writer、checkpoint 只在閒置時做；Notion 的「多寫入者＝資料損壞」教訓。
- **不需要**：Notion 的跨分頁協調（單視窗）；VS Code 為遠端／多視窗設計的 shared process；4 個 reader 對單一使用者通常過多（Signal 的同時查詢量遠高於此）。
- **最小可採用版本**：見文末 S1。

---

## 2. 不重算就能保持衍生資料最新

### 2.1 SQLite 提供的機制 [來源]
- **Trigger + FTS5 external content**：用 `content=` 指向原表，由 trigger 同步；trigger 不會回填既有資料；**delete 必須帶入與索引時完全相同的舊值**，否則結果不可預期；update = delete(old) + insert(new)；出錯時用 `'rebuild'` 重建。https://www.sqlite.org/fts5.html
- **Contentless / contentless_delete（3.43+）**：只存索引不存內容；`contentless_delete=1` 才支援 DELETE；官方建議優先用後者。
- **Merge 參數**：`automerge` 預設 4（同層 ≥4 個 b-tree 時在後續寫入中逐步合併）；`crisismerge` 預設 16，達到時**單次寫入**就會整層合併 → 一次 INSERT 可能突然很慢（卡頓來源）。`'optimize'` 會一次合併成單一 b-tree，可能很久；官方給出分段做法：先 `merge` 傳 **-N**，之後反覆傳 **+N**，直到 `total_changes()` 差值 < 2。→ 可在 idle 時分小段整理索引。
- `integrity-check` 加 `rank=1` 才會比對 external content 原表。
- **`sqlite3_update_hook`**：rowid 表每列 insert/update/delete 回呼（表名 + rowid）；**不觸發**於 WITHOUT ROWID 表、`ON CONFLICT REPLACE` 刪除的列、truncate 最佳化（無 WHERE 的 `DELETE FROM t`）；回呼內不可用同一連線執行 SQL。要搭配 commit/rollback hook 才知道是否真的生效。https://www.sqlite.org/c3ref/update_hook.html
- **Session extension**：記錄 PK 與舊值，產生 changeset/patchset；需要 PK、**不支援虛擬表**、需編譯旗標。https://www.sqlite.org/sessionintro.html → 對本機單 writer 而言太重；只要寫入路徑唯一，**由 writer 自己發出變更通知**就比 hook 可靠。[推論]

### 2.2 本機投影與變更通知
- **Replicache**[來源]：subscribe 的查詢函式只在「上次讀過的 key」有變時重跑；可自訂 `isEqual` 判斷結果是否改變；官方承認任意函式能優化的程度有限。https://doc.replicache.dev/tutorial/subscriptions 、https://doc.replicache.dev/api/interfaces/SubscribeOptions
- **Linear sync engine**（只有逆向工程與演講摘要，**非一手**）：全域單調 `lastSyncId` 作為版本號，用來偵測漏收的 delta；記憶體 Object Pool（UUID → model）；MobX observable 驅動 UI；pending transaction 存在 IndexedDB 的 `__transactions` 表，重啟後重送；partial index（如 `assigneeId-<id>`）會記下「這個查詢已載入過」，避免重抓。https://github.com/wzhudev/reverse-linear-sync-engine [二手]；官方演講頁沒有技術內容 https://linear.app/blog/scaling-the-linear-sync-engine
- ElectricSQL、PowerSync、cr-sqlite、Zero 的本機投影細節：本次沒讀原文。[未驗證]

### 2.3 有序 ingest + 並行計算
- **Chromium**[來源]：偏好 **sequence（虛擬執行緒）**，不直接操作實體執行緒；`SequencedTaskRunner` 保證依投遞順序逐一執行；`PostTaskAndReply` 把慢工作丟到 thread pool，結果回到原 sequence；預設 task 不可阻塞，要阻塞須標 `MayBlock()`；優先度分 `USER_BLOCKING`／`USER_VISIBLE`／`BEST_EFFORT`。https://chromium.googlesource.com/chromium/src/+/HEAD/docs/threading_and_tasks.md
- **LMAX**[來源]：業務邏輯單執行緒；之前的 journaling、replication、unmarshalling 互不依賴，**可並行**；每個消費者有自己的單調序號，下游等上游序號推進後才處理該格。https://martinfowler.com/articles/lmax.html
- 合起來的模式：**計算可以並行（解析、hash、壓縮、擷取文字），提交必須依序**——並行工作完成後放進以 seq 為鍵的 reorder buffer，由單一 writer 依 seq 連續提交。[推論，合併兩個來源]

### 2.4 主執行緒外的全文搜尋
- VS Code 文字搜尋呼叫 ripgrep 子程序，並已移出 renderer（見 1.2）；排查時可在 log 看到 ripgrep 的參數。https://github.com/microsoft/vscode/wiki/Search-Issues （wiki 只讀了搜尋摘要）
- Zed、Obsidian 的索引器設計：沒有一手資料。[未驗證]

### 2.5 「衍生資料尚在計算中」的 UI 狀態
- 沒有找到專門討論這個狀態的一手文章。可借用的近似機制：TanStack 的 `isPlaceholderData`（資料存在但不是最新答案）與 `fetchStatus`（見 4.1）；GitHub search 的 `incomplete_results`（逾時就回傳部分結果並標記，文件也說明這不一定代表結果真的不完整）https://docs.github.com/en/rest/search/search

### 2.6 移轉評估
- **可移轉**：projection cursor（Linear 的 `lastSyncId` 概念，縮小為每個投影一個 `last_seq`）；external-content FTS 用 trigger 或由 writer 批次推進；FTS 分段 merge 放到 idle；writer 在 commit 後發出 `{topics, seq}`。
- **不移轉**：伺服器 delta、衝突重定基（rebase）、session changeset、CRDT——都是為多副本設計，單 writer 本機沒有這些問題。
- **注意**：`crisismerge` 與自動 checkpoint 都會把成本藏進「某一次寫入」→ 正是 capture 路徑偶發卡頓的來源，要在 writer 的計時中能看出來。

---

## 3. 預算與看門狗

### 3.1 測量原語 [來源]
- **Node `monitorEventLoopDelay`**：`ELDHistogram`，單位 ns；預設 timer 模式 `resolution=10ms`（每個樣本都含 resolution 本身）；新版可設 `samplePerIteration`（兩種模式**不可互相比較**）；提供 `percentile()`、`max`、`exceeds`、`snapshot()`。只能看到「迴圈晚了多少」，**不知道是誰造成的**。另有 `performance.eventLoopUtilization()`。https://nodejs.org/api/perf_hooks.html
- **Long Animation Frames（LoAF）**：門檻 50ms；每個 script 有 `invokerType`（event listener、user callback、promise…）、`invoker`、`sourceURL`、`sourceFunctionName` → **可以指出是哪個 handler**；規格說它比 long tasks 更貼近使用者感受。https://w3c.github.io/long-animation-frames/
- **Electron**：`BrowserWindow` 的 `unresponsive`/`responsive` 事件（文件沒寫門檻）；`WebFrameMain.collectJavaScriptCallStack()`（實驗性）可在 `unresponsive` 時取得 renderer 當下的 JS 堆疊，需啟用 `DocumentPolicyIncludeJSCallStacksInCrashReports`。https://www.electronjs.org/docs/latest/api/web-frame-main

### 3.2 VS Code 的做法 [來源]
- 啟動後先算出效能基準（快機器約 15ms），收到 **10× 基準**（約 150ms）的 long task 時開始 profiling **5 秒**，回報「有意義的」堆疊（`functionname` + `callers`）；重複出現的變成 `PerfSampleError`，合成 stacktrace 用最常見的堆疊；分析查詢只保留 `selftime > 2×基準` 的樣本。https://github.com/microsoft/vscode/wiki/%5Bdev-perf%5D-PerformanceError-and-unresponsive-renderer-telemetry
- 主程序端：commit「log js stacks from unresponsive window」新增 `--unresponsive-sample-interval`（預設 1000ms）／`--unresponsive-sample-period`（15000ms）。（只看到鏡像站，**未在官方 repo 確認**）
- **重點**：門檻是**相對於這台機器的基準**，不是固定毫秒 → 在慢 CI 上不會一直誤報。
- `--prof-startup`、`Developer: Startup Performance`：本次沒讀原文。[未驗證]

### 3.3 CI 上不 flaky 的效能檢查 [來源]
- **rustc-perf**：顯著性用歷史資料的 IQR 欄：`result > Q3 + 3×IQR`（文字說 1.5 倍、公式寫 3 倍，原文不一致）；只看上界；再用 magnitude 與 relevance 決定是否回報。https://github.com/rust-lang/rustc-perf/blob/master/docs/comparison-analysis.md
- **iai**：用 Cachegrind **指令數**，單次執行，在吵雜的 CI 上穩定；限制：不等於牆鐘時間、**不量 syscall／I/O**、看不到排程變異、Windows 不支援。https://github.com/bheisler/iai
- **Firefox Perfherder**：先 t-test（約前 12 個 revision 對比後 12 個），顯著後再檢查幅度門檻才發警報；門檻依 harness 而異（常見 2%）。https://firefox-source-docs.mozilla.org/testing/perfdocs/perf-sheriffing.html （窗口大小來自 arXiv 2503.16332，非官方文件）
- Chromium perf waterfall/Pinpoint、Slack/Discord 的效能回歸 gate：沒有讀到一手資料。[未驗證]
- 收斂：**不用單次牆鐘時間比固定門檻**。可行做法有三種：計數工作量（指令數、查詢次數、render 次數）、相對於本機基準、或對歷史做統計。

### 3.4 移轉評估
- **可移轉**：直方圖 + 「超標時才收堆疊」（VS Code）；在每個 IPC handler／writer 批次加名字計時（Signal 的 `MIN_TRACE_DURATION` + top-N 統計）；renderer 端用 LoAF 取得 handler 歸因；CI 計數而不計時。
- **不移轉**：遙測聚合、KQL、t-test 警報系統（沒有大量樣本，也沒有 sheriff 角色）。
- 最小可採用版本見 S3。

---

## 4. 列表為主、即時更新應用的 renderer 資料流

### 4.1 查詢快取的「模型」（不是函式庫）[來源]
- **以問題為鍵**：結果存在 query key 下；換 key 就是換一個問題。
- **兩個正交狀態**：`status`（pending/error/success：**有沒有資料**）與 `fetchStatus`（fetching/paused/idle：**查詢函式有沒有在跑**）；success + fetching = 背景更新中。https://tanstack.com/query/latest/docs/framework/react/guides/queries
- **Stale**：預設 `staleTime 0`；`gcTime` 5 分鐘後清掉不活躍的結果；**structural sharing** 讓沒變的子樹保持同一個參考，減少重 render。https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults
- **換 key 時保留舊資料**：`placeholderData: prev => prev` 讓 UI 不閃回 loading，並以 `isPlaceholderData` 標示；placeholder **不寫入快取**。https://tanstack.com/query/latest/docs/framework/react/guides/placeholder-query-data
- **文件明示的競態**：樂觀更新前要先 `cancelQueries`，「so they don't overwrite our optimistic update」——晚到的舊回應會覆蓋新狀態。被取消的查詢回到先前狀態（`revert: true`）。https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates 、…/query-cancellation
- **Tag 失效（RTK Query）**：query `providesTags`，mutation `invalidatesTags`；一般 tag 讓同類型全部失效，`{type,id}` 只讓特定項目失效；`'LIST'` 只是慣例 id，用來「新增只刷新列表、不刷新各項詳情」；失效後**有訂閱者就重抓，沒有就直接丟掉**。https://redux.js.org/toolkit/rtk-query/usage/automated-refetching
- SWR、Relay store/fragments、Apollo 正規化快取：沒有讀原文。[未驗證]
- **收斂**（TanStack、RTK、Replicache）：失效的單位是「主題／key」，不是逐筆事件；只有可見（有訂閱）的結果會重算。

### 4.2 誠實呈現「N / M」[來源]
- Relay 連線規格：`edges{node,cursor}` + `pageInfo{hasNextPage,hasPreviousPage,startCursor,endCursor}`；往前分頁時 `hasPreviousPage` 若無法便宜地算出**可以回 false**；**`totalCount` 不在規格內**。https://relay.dev/graphql/connections.htm
- GitHub search：每次搜尋最多 1000 筆；逾時就回傳已找到的部分並標 `incomplete_results`。https://docs.github.com/en/rest/search/search
- GitHub/Linear/Sentry 在 UI 上顯示「1k+」這類上限計數的規則：沒有一手資料。[未驗證]
- 原則：分頁用 cursor，「還有更多」與「總數」分開處理；總數拿不到時要明說是下限（`≥ 1000`），不能顯示成精確數字。

### 4.3 沒有 URL 的導覽狀態 [來源]
- **VS Code 1.65 重寫編輯器歷史**：分成 navigation locations（Go to Definition 等跳轉）與 edit locations（編輯時）兩條堆疊，各有 Back/Forward；`workbench.editor.navigationScope = default | editorGroup | editor`；Go Back 會在**原本的 editor group** 重新啟用並聚焦；**group 被移除時，相關歷史項目一併丟棄**。文件沒提捲動位置與堆疊上限。https://code.visualstudio.com/updates/v1_65
- **React `<Activity mode="hidden">`**：保留 state 與 DOM（`display:none`），**effects 會被清掉**（訂閱解除），可見時重建；隱藏中的子樹仍以低優先度 re-render；DOM 副作用（video 等）會持續，需自己清理。https://react.dev/reference/react/Activity → 這是「保留畫面但暫停訂閱」的現成語意。
- JetBrains、Slack、Discord、Linear 的歷史堆疊細節：[未驗證]。`content-visibility` 沒有讀原文。[未驗證]

### 4.4 鍵盤與焦點分層 [來源]
- **VS Code keybinding**：由下往上找，**第一個 key 與 `when` 都符合的規則勝出**；使用者規則附加在後所以會覆蓋預設；`-command` 移除規則；有 `Toggle Keyboard Shortcuts Troubleshooting` 可記錄每次按鍵比對到哪條規則（要「說明為什麼這個鍵做了這件事」時很關鍵）。https://code.visualstudio.com/docs/getstarted/keybindings
- **Radix DismissableLayer**：共用 context 內的 `layers` Set（插入順序就是疊放順序）；**只有最上層**在 document 上註冊 capture 階段的 keydown 處理 Escape；**IME 組字中（`isComposing` 或 `keyCode === 229`）忽略 Escape**；`onEscapeKeyDown` 可以 `preventDefault` 否決關閉；branch 機制讓指定外部節點視為「在層內」。https://github.com/radix-ui/primitives/blob/main/packages/react/dismissable-layer/src/dismissable-layer.tsx
- **WAI-ARIA APG（modal dialog）**：Escape 關閉；Tab 在內部循環；關閉後焦點回到觸發元素，**例外**：觸發元素已不存在，或工作流程有更合理的下一個目標。https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- **IME**：`isComposing` 只在 compositionstart～end 之間為 true（MDN）；Safari 會在確認組字的 Enter **之前**送出 `compositionend`，導致該次 keydown 的 `isComposing === false`（WebKit bug 165004，從 2016 年開到至少 2023）。因此要同時檢查 `keyCode === 229`；自建 composition 旗標在 Safari 上無效。https://bugs.webkit.org/show_bug.cgi?id=165004 、https://developer.chrome.com/docs/modern-web-guidance/guides/forms/ime-safe-enter-submit 。Electron 是 Chromium，但在 macOS 輸入法下是否一樣：[未驗證，需實測]。

### 4.5 移轉評估
- **可移轉**：key + 兩軸狀態 + topic 失效 + 單調 requestId 丟棄晚到回應 + 換 key 保留舊資料並標示；導覽項目存「問題」（view + params），返回時重新查詢並還原 scroll／selection；隱藏視圖保留但取消訂閱；層級化 Escape + IME 防護。
- **不移轉**：正規化實體快取（Apollo/Relay store）——本系統的列表大多是唯讀紀錄的投影，不需要跨查詢合併同一實體的更新；retry/backoff、視窗聚焦重抓（本機 IPC 不會斷線）。

---

## 5. 讓綠燈有意義的測試策略

### 5.1 時間控制 [來源]
- Testing Library：`beforeEach` 開 fake timers；`afterEach` **先 `runOnlyPendingTimers()` 再 `useRealTimers()`**，否則排程中的工作會被丟掉，或 fake timers 漏到其他測試；user-event 要傳 `advanceTimers`，否則會逾時。https://testing-library.com/docs/using-fake-timers/
- `waitFor`：預設 interval 50ms、timeout 1000ms；callback **必須 throw** 才會重試；會用 MutationObserver 監聽 DOM 變化；`findBy = getBy + waitFor`。https://testing-library.com/docs/dom-testing-library/api-async/
- Vitest：預設**不**模擬 `nextTick`／`queueMicrotask`；`--pool=forks` 下模擬 `nextTick` 會卡住；`advanceTimersByTimeAsync` 會連「非同步設定的計時器」一起推進（promise 鏈中的 timer 需要它）；`setSystemTime` 不會觸發計時器；`vi.waitFor` 會自動推進 fake timers；`vi.resetModules` 清模組快取，但**頂層 import 不會重新求值，mock registry 也不會重置**。https://vitest.dev/api/vi 、https://vitest.dev/guide/mocking/timers
- Playwright `page.clock`：優先用 `setFixedTime`；`install` 必須是第一個 clock 呼叫（範例在 `goto` 之前）；`fastForward`（到期的 timer 各觸發一次）與 `runFor`（逐步觸發每個 timer 與 rAF）語意不同；會模擬 Date、timers、rAF、rIC、`performance`、`Event.timeStamp`。https://playwright.dev/docs/clock
- VS Code smoke README：「Hope is your worst enemy in UI tests」，列出 flaky 來源：共用 workbench 狀態、單例（port、路徑）、失去焦點、固定等待。https://github.com/microsoft/vscode/blob/main/test/smoke/README.md

### 5.2 Flake 管理 [來源]
- Google 2016：約 16% 的測試有某種程度的 flaky；約 1.5% 的測試執行結果是 flaky；**約 84% 由 pass 轉 fail 的情況牽涉 flaky 測試**；重跑只用在標記為 flaky 或使用者要求時；flaky 程度依 flag／config 組合分開計算。https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html （數字經二手資料交叉確認；本文頁面抓取只拿到留言串）
- Google 2017：測試越大（以 binary size 衡量）越 flaky；主因是絕對時間假設與執行緒相對時序。https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html
- Bazel `flaky = True`：最多執行 3 次，三次都失敗才算失敗；`manual` 不納入萬用字元展開；`exclusive` 執行時不與其他測試並行。https://bazel.build/reference/be/common-definitions
- Chromium flake dashboard、Spotify／Slack／GitHub 的隔離政策：[未驗證]。
- 收斂：重跑**必須明確標記**，不可以全域開啟；flaky 標記要能被統計、有到期時間［到期部分為推論］。

### 5.3 測不會失敗的測試／突變測試 [來源]
- Google（Petrović & Ivanković，ICSE-SEIP 2018；TSE 版 arXiv 2102.11378）：**只對 diff 中有被覆蓋的行**產生突變；**每行最多一個突變**；每個 CL 回報上限約為 7 × 檔案數；以 code review 的自動評論呈現，附「Please fix／Not useful」回饋；**arid node**（log、監控、時間／deadline、快取等）超過一百條規則抑制無效突變；有用率約從 15% 提升到 89%；沒有抑制規則，使用者會「opt out of the system altogether」。https://ar5iv.labs.arxiv.org/html/2102.11378 、https://research.google/pubs/state-of-mutation-testing-at-google/
- Stryker incremental：`reports/stryker-incremental.json`；只偵測**被突變檔與測試檔**的變更（依賴、環境變數、snapshot 改變**偵測不到**）；Vitest/Jest 提供完整測試位置，偵測最精確；`--force` + `--mutate` 可重跑指定範圍。https://stryker-mutator.io/docs/stryker-js/incremental/
- PIT：[未讀]。

### 5.4 Skip 計帳 [來源]
- pytest：`xfail(strict=True)`／`xfail_strict` 讓 XPASS 變成失敗；`-rs` 列出 skip 原因。https://docs.pytest.org/en/stable/how-to/skipping.html （`--strict-markers` 不在此頁 [未驗證]）
- Go `test2json`：Action 包含 `skip`，事件帶 `Test`、`Package`、`Elapsed`，skip 可以機器統計。https://pkg.go.dev/cmd/test2json
- Rust `#[ignore]` 在摘要中顯示 ignored 數量：[未驗證，依記憶]。
- 收斂：skip 是**一種結果**，要有原因、要被計數、要能比對基準；「預期失敗但通過」必須讓 CI 變紅。

### 5.5 宣告式平台矩陣 [來源]
- Node.js：Tier 1／Tier 2 都有完整 CI，**失敗會擋發行**（Tier 2 的差別只在基礎設施問題可能延遲 binary）；Experimental 不保證、不擋發行。https://github.com/nodejs/node/blob/main/BUILDING.md
- Shell 版本矩陣：bash-preexec 0.7.0 起 CI 測 Bash 3.2/4.4/5.0/5.3（release notes）；bats-core 自己的 CI 以 matrix 建立 `bash:<ver>` 容器跑測試；官方 `bash` Docker image 就是為多版本相容測試設計。https://newreleases.io/project/github/rcaloras/bash-preexec/release/0.7.0 （二手轉載 release notes）、https://hub.docker.com/_/bash
- VS Code、Git、Electron 自身的矩陣宣告：[未驗證]。

### 5.6 測發行版 [來源]
- Electron fuses：`nodeCliInspect`（預設啟用）關閉後，`--inspect` 與 SIGUSR1 都失效；`runAsNode` 關閉後 `child_process.fork` 會 throw；`embeddedAsarIntegrityValidation` + `onlyLoadAppFromAsar` 確保只載入已驗證的程式碼；用 `npx @electron/fuses read --app <path>` 驗證。https://www.electronjs.org/docs/latest/tutorial/fuses
- **Playwright Electron**：文件明載 launch 逾時請確認 `EnableNodeCliInspectArguments` 沒被設成 false → 用 Playwright 驅動發行版，就**必須保留除錯入口**，與發行版硬化互相衝突。https://playwright.dev/docs/api/class-electron 。WebdriverIO 的建議是只在測試版開啟該 fuse（那就不是在測真正的發行版）[二手]；macOS 改 fuse 後必須重新簽章。
- VS Code smoke：對**已安裝的建置**執行（`--build <path>`），並使用與該發行相符的 release 分支；以獨立的 `--user-data-dir`、`--extensions-dir`、`--crash-reporter-directory`、`--logsPath` 隔離狀態，並關閉 telemetry/updates/experiments。https://raw.githubusercontent.com/microsoft/vscode/main/test/automation/src/electron.ts
- Electron Forge/Builder 的發行版測試指引：[未讀]。

### 5.7 型別化測試 [來源]
- Vitest `--typecheck`：`*.test-d.ts` 只做靜態分析不執行；`expectTypeOf`／`assertType`；也會回報原始碼的型別錯誤。https://vitest.dev/guide/testing-types 。`tsd`：[未讀]。

### 5.8 移轉評估
- **可移轉**：teardown 規則（先 flush 再還原計時器）；禁止固定 sleep；模組單例提供明確的 `__resetForTests()`，不要依賴 `resetModules`（頂層 import 不會重跑）；diff 範圍的突變測試，每行一個、設上限；skip 計數 gate；宣告式平台表；發行版 smoke 用獨立 profile 目錄。
- **不移轉**：Google 規模的 flake 統計基礎設施、Perfherder 式的 sheriff 流程、Bazel 遠端執行。

---

## 最小可採用版本（S1–S7）

### S1. 每專案查詢 worker，具 read-your-writes
- 每個開啟的專案：**1 個 writer worker**（唯一可寫連線，負責 migration、所有 INSERT/UPDATE、FTS 推進、checkpoint）+ **1 個 reader worker**（必要時 2 個；本機單人用 4 個通常過多）。主程序只負責 dispatch，不碰 DB。
- writer 每次 commit 後回報 `commitSeq`（單調遞增，可用 log 表的最大 rowid）。dispatcher 記錄 `lastCommittedSeq`。
- **RYW 規則**：renderer 的每個讀請求帶 `minSeq`（它最後看到或寫入的 seq）。dispatcher 在 `lastCommittedSeq >= minSeq` 之前不把請求送給 reader；送出後 reader 開新的 read transaction，WAL snapshot 一定包含該次 commit（isolation.html）。reader **不得保留跨請求的長交易**（會餓死 checkpoint，也會讀到舊 snapshot）。
- 用到連線本地狀態的查詢（TEMP table、分頁游標狀態）固定在 writer，或改寫成無狀態的 keyset 分頁（Signal 的教訓）。
- 自動 checkpoint 關掉，由 writer 在閒置時做 `wal_checkpoint(TRUNCATE)`（Signal：只在所有 worker 都閒置時；節流 30s／delete 後 5s）。
- 每個查詢都有名字；超過 40ms 記 `slow query`；可切換開啟 top-N 統計（Signal）。
- 渲染端與 worker 之間直接用 MessagePort（VS Code 模式），大量結果不經 main 轉送。

### S2. 增量投影 + 可見的 pending 狀態
- `projection_cursor(name TEXT PRIMARY KEY, last_seq INTEGER)`。每個投影（FTS、目標聚合、時間軸 bucket）由 writer 在 ingest 交易內或之後的小批次中推進，**推進與 cursor 更新在同一交易**。
- 並行計算（解析、文字擷取、hash）在其他 worker 完成後，依 seq 放進 reorder buffer，由 writer 依序提交（Chromium sequence + LMAX gating）。
- FTS：external content + 由 writer 寫入（delete 時帶完全相同的舊值）；idle 時以 `merge -N`、`+N`… 分段整理；`crisismerge` 的突發成本要能在 writer 計時中看見。
- 查詢回應附上 `{asOfSeq, projectionLagBySeq}`；`lag > 0` 時 UI 顯示「索引中，落後 N 筆」，不要把不完整的結果當成完整結果呈現。

### S3. 會指出 handler 的主執行緒卡頓看門狗（e2e/CI 可用、不 flaky）
- 主程序與每個 worker：`monitorEventLoopDelay({resolution: 20})`，定期取 `snapshot()`。
- 每個 IPC handler、writer 批次與投影步驟都包一層 `timed(name, fn)`：超過門檻（例如 100ms）就記錄 `{name, ms, seq}`，並保留最近 N 筆。直方圖負責發現卡頓，具名計時負責歸因到 handler。
- renderer：`PerformanceObserver({type:'long-animation-frame'})`，記下 `scripts[].invoker/sourceFunctionName`。
- e2e：測試結束時從 app 讀出「超標事件清單」。**斷言用計數**（例如 capture handler 的超標次數 = 0，門檻設得寬，例如 250ms），並把 p99 和最大值寫進 artifact 但不作斷言；另一種做法是像 VS Code 一樣用相對門檻（先量測閒置基準，再要求不超過基準的 10 倍）。真正的效能回歸用工作量計數（每次 ingest 的 SQL 次數、每次事件的 render 次數），不用牆鐘時間。
- 開發模式：`BrowserWindow` 的 `unresponsive` 事件觸發時，呼叫 `collectJavaScriptCallStack()` 寫入 log。

### S4. Keyed 讀取結果 + topic 失效（不採用函式庫）
```
Entry = { key, data?, error?, status:'pending'|'error'|'success',
          fetching:boolean, stale:boolean, asOfSeq, topics:Set<string>,
          reqId:number, subscribers:number, isPlaceholder:boolean }
```
- `key = stableStringify([viewName, params])`；`topics` 由 key 宣告（例如 `commands:project`、`http:host:<h>`）。
- writer commit 後廣播 `{seq, topics}` → 所有 `topics` 有交集的 entry 標記 `stale`；**有訂閱者的才重抓**，沒有就丟掉（RTK 規則）。對事件做節流（例如每 100–250ms 合併一次）。
- 每次 fetch 遞增 `reqId`；回應的 `reqId` 不等於目前值就丟棄（防止晚到的舊回應覆蓋新狀態，也就是 TanStack cancel 文件描述的競態）；回應附 `asOfSeq`，比 entry 現有的舊就丟棄。
- 換 key 時沿用舊 data、標記 `isPlaceholder`；gc：沒有訂閱者 N 分鐘後刪除。
- 計數一律回 `{count, exact:boolean}`；超過上限就顯示「≥ 上限」。

### S5. 導覽堆疊與還原規則
- `NavEntry = { view, params(=查詢 key 的輸入), scrollAnchor:{id, offset}, selectionId?, filters, focusTarget? }`；push 時機：明確的跳轉（從 A 的某一列跳到 B），**不是**每次篩選變更（VS Code 把 navigation 與 edit 兩類位置分開）。
- Back：重建 key → 重新查詢（stale 也可以先顯示）→ 以 **錨點 id** 還原捲動（不用像素，因為列表可能已成長）→ 若 selection 已不存在，就聚焦最近的列（APG 對「觸發元素已不存在」的規則）。
- 參照的物件被刪除時，丟棄相關項目（VS Code：group 移除，歷史一併移除）。
- 隱藏的視圖最多保留 2–3 個（`<Activity hidden>` 語意：保留 state/DOM、取消訂閱）；回到前景時以 `asOfSeq` 判斷是否需要重抓。
- Escape：用單一 layer stack，只有最上層處理；IME 組字中（`isComposing || keyCode===229`）一律不處理 Enter／Escape；提供「這個鍵做了什麼」的除錯 log（VS Code 的 troubleshooting 模式）。

### S6. 測試時間 harness + skip／capability 清單
- `testClock`：包住 `vi.useFakeTimers({toFake:[...]})`，只提供 `advance(ms)`（內部用 `advanceTimersByTimeAsync`）與 `flush()`；`afterEach` 自動 `runOnlyPendingTimers` → `useRealTimers`，並檢查**沒有殘留的 timer**（有就讓測試失敗）。lint 禁止在測試中 `setTimeout(r, N)` 等待。
- 單例：每個模組級單例都匯出 `__resetForTests()`，由全域 `afterEach` 呼叫（不要依賴 `resetModules`）。
- `test/capabilities.json`：宣告每項能力需要的條件（`posix-shell`、`bash>=4`、`zsh`、`pwsh`、`macos-pty`…）以及每個 CI job 提供哪些能力。測試只能用 `skipUnless(cap)` 跳過；reporter 輸出 `{test, cap, reason}`；CI gate：**被跳過的 (test, cap) 組合，必須在至少一個 job 上實際執行過**；skip 數量相較基準增加時失敗；xfail 必須 strict。
- 平台表照 Node tiers 寫明：哪些平台的失敗會擋 merge，哪些只回報。Shell 版本用容器 matrix（bats 模式）。
- 突變測試只對 diff 中的核心模組（hash chain、ingest 排序）跑，每行一個突變，抑制 log／時間相關的程式碼。

### S7. 不需要除錯 port 的發行版 smoke
- 發行版保持硬化：`nodeCliInspect` 關閉、asar integrity 開啟；CI 先跑 `npx @electron/fuses read --app <path>`，把結果與預期表比對（fuse 本身就是被測對象）。
- app 內建一個**由主程序解析的自檢旗標**（例如 `--self-test=<outDir>`），只接受這個入口：以獨立的 `--user-data-dir` 啟動（VS Code smoke 模式）、建立暫存專案、透過正式的 ingest 路徑寫入固定的 fixture（一條 shell 事件、一個 HTTP flow、一段 transcript）、讀回並驗證 hash chain 與簽章、匯出 bundle 後用打包進去的 verifier 驗證；結果寫成 `<outDir>/result.json`，以 exit code 表示成敗，**不開任何除錯 port**。
- CI 驗證 exit code、result.json，以及 `child-process-gone`／crash 目錄是否為空。macOS 要對簽章過的產物執行（改 fuse 後必須重新簽章）。
- 安全邊界：自檢旗標只能寫入指定的暫存目錄，不能讀現有專案；預設不顯示視窗。[推論，屬設計建議]

---

## 無法驗證的事項
1. Signal 為何、何時從單一 SQL worker 改成 4-worker pool；reader 連線是否設 `query_only`／`busy_timeout`（`Server.node.ts` 只讀到前 40%）。
2. VS Code pty host 單獨成程序的官方理由；主程序 unresponsive 採樣參數只在鏡像站看到；`--prof-startup`／Startup Performance 沒讀。
3. Discord、Figma、Obsidian、Linear 桌面版的 DB／執行緒模型；Slack/Discord 的效能回歸 gate；Chromium jank 指標與 perf waterfall／Pinpoint。
4. Linear sync engine 全部細節（只有逆向工程與二手摘要）。ElectricSQL、PowerSync、cr-sqlite、Zero、Zed 的本機投影與索引設計。
5. `PRAGMA data_version`、`busy_timeout` 的確切語意（本次沒讀原文）。
6. SWR、Relay store、Apollo 正規化；GitHub/Linear/Sentry UI 的「1k+」計數規則；JetBrains／Slack 的導覽堆疊；`content-visibility`。
7. Electron（Chromium）在 macOS 輸入法下 `compositionend`／keydown 的順序（WebKit bug 是 Safari 的問題）；WebKit 是否已修正（有一篇部落格提到 #311717，未證實）。
8. Google flaky 2016 原文正文（頁面只抓到留言串，數字經二手資料交叉確認）；Perfherder 的窗口大小來自學術論文。
9. pytest `--strict-markers`、Rust `#[ignore]` 報告、`tsd`、PIT、Electron Forge/Builder 的發行版測試指引、VS Code/Git/Electron 的平台矩陣宣告。
10. bash-preexec 版本矩陣只看到 release notes 的轉載；direnv、starship、nvm 的測試矩陣沒查。
