# Verification: 查詢工作執行緒、增量投影與讀取契約

本檔目前只記 Phase 1（釘住今天的行為）的結果；決定、實作、驗證三欄與 Gates 在 Phase 8 補齊。尚未 Verified。

## Phase 1 — 今天的行為（2026-11-13，main `faf3d376`）

### T010 量測基準（`test/query-work-counts.test.ts`）

計數而非時間（`test/helpers/work-counter.ts`）。欄位：`[語句數, 回傳列數, UDF 呼叫, JSON.parse, lstat, open, 掃描型語句]`。資料集：N 列兩層、N/100 個目標與主機、N/50 列引用各自的 body 檔。「掃描型語句」是結構事實（計畫對兩層資料表走 SCAN 或只有範圍條件的 SEARCH，且不會提早停止），不是成本模型。

| 讀取 | 1 萬列 | 10 萬列 |
|---|---|---|
| runQuery 文字，冷 | 1027, 671, 0, 429, 1003, 200, 14 | 10027, 6400, 0, 4101, 10003, 2000, 14 |
| runQuery 文字，熱 | 225, 673, 0, 229, 203, 0, 14 | 2025, 6402, 0, 2101, 2003, 0, 14 |
| 只算 coverage | 209, 406, 0, 200, 0, 0, 7 | 2009, 4006, 0, 2000, 0, 0, 7 |
| runQuery 只有條件 | 9, 109, 0, 100, 0, 0, 4 | 9, 109, 0, 100, 0, 0, 4 |
| activityPage 首頁 | 62, 109, 30000, 30250, 0, 0, 8 | 62, 109, 300000, 300250, 0, 0, 8 |
| activityPage 次頁 | 63, 113, 0, 251, 0, 0, 7 | 63, 113, 0, 251, 0, 0, 7 |
| sourceSessions | 5, 5, 600, 601, 0, 0, 2 | 5, 5, 6000, 6001, 0, 0, 2 |
| aggregateTargets | 1, 90, 0, 0, 0, 0, 1 | 1, 900, 0, 0, 0, 0, 1 |
| distinctHosts | 1, 60, 0, 0, 0, 0, 1 | 1, 500, 0, 0, 0, 0, 1 |
| 其餘 `service`/`indexed` 讀取 | 見測試檔 `PINNED` | 同 |

成長的讀取（測試內 `GROWS_TODAY`，只降）與五個 `it.fails`（coverage、recheck、Activity 每頁範圍 COUNT、`aggregateTargets`、`distinctHosts`）在該檔；未量：`casts:search`、`content:*`、`httpBody:read`、`scope:*`、HTTP API 路由（原因寫在檔頭）。

### T017 今天斷言共用篩選的測試（`test/shared-filter-assertions.test.ts`）

清單即該檔的 `LISTED`（25 個檔：6 個 e2e、19 個 test）。T071、T072 改寫它們時逐檔移出；Phase 8 要求為空。依角色：

- 斷言共用篩選的語意（T071 改為每頁篩選與 `reveal`）：`shared-filter-views`、`shared-filter-live-lists`、`shared-filter-tier`、`timeline-shared-filter`、`targets-open-in-timeline`、`filter-bar-tier`、`filter-bar-a11y`、`filter-time-range`、`filter-list-load-errors`、`timeline-toolbar`、`unapplied-filter-notice`、`display-zone-surfaces`、`loot-completeness-ui`。
- 斷言查詢框與隱藏泳道的保存與「held query」（T076）：`timeline-stored-query-arrival`、`timeline-search-live-burst`。
- e2e（T072）：`timeline-evidence`（`target-focus`）、`timeline-track`（Chained only 晶片）、`app-shell`、`layout-reliability`、`layout-read-states`、`http-body-search`（Chained only 晶片；規格表未列，本次新增）。
- 只提到共用篩選的條件集合、不依賴它是共用的（FilterContext 形狀改變時才需動）：`search-query-corpus.harness`、`timeline-filter-completeness`、`timeline-query-perf`。
- 本規格自己的 T016：`timeline-bands-filter`（用共用篩選設類型；Phase 7 之後改用該頁的篩選）。

### 未做或與任務文字不同

- T011（`registerHandler` 與 `main-thread-handlers` 測試）、T018（事件迴圈探針）、T019（探針單元測試）都需要 `src/` 的新檔，Phase 1 不改 `src/`，未做。今天裸 `ipcMain.handle`／`on` 的數目是 180（165 handle、15 on，14 個檔），計畫寫 179。
- T013 的「切片中斷」今天沒有對應物（投影在讀取交易內一個語句追完，沒有預算）；以「讀取在兩層之間被 SQL 函式的例外中斷」代替，見檔頭。
