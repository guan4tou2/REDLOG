# RedLog 最新版本現存問題整理

審查日期：2026-09-19  
核對版本：`82183f1`（`screenshot: paginate gallery with QueryPage + SQL-level trigger filter`）  
審查範圍：協查搜尋、共用篩選、AI Transcript、匯出預覽與 evidence bundle  
審查方式：最新原始碼與參數流向核對；本文件不宣稱已完成新版桌面端到端驗收

## 結論

目前最需要處理的不是增加更多功能，而是讓畫面所表示的範圍、實際查詢的範圍，以及最後匯出的範圍一致。

現存四項問題都直接影響 RedLog 的核心用途：

1. 共用篩選沒有在所有頁面完整生效。
2. 匯出預覽不一定對應即將輸出的資料。
3. 查詢失敗可能被誤認為沒有事件。
4. AI Transcript 仍是固定上限的閱讀子集，不適合作為完整協查結果。

建議優先順序：匯出一致性 → 共用篩選 → 搜尋錯誤狀態 → Transcript 分頁與精準查找。

---

## P1：共用篩選沒有在所有頁面完整生效

### 使用情境

藍隊要求找出「某目標在某一小時內，由 AI 或 shell 執行的活動」。操作者在頂端 FilterBar 選取 target、type、time 和 in-scope only，接著切換 Search、Transcript、HTTP、Timeline 查看。

### 實際行為

| 頁面 | Target | Type | Time | In-scope only |
|---|---:|---:|---:|---:|
| Timeline | 有 | 由 Timeline 顯示邏輯處理 | 有 | 有 |
| Search | 未套用 | 有 | 有 | 未套用 |
| Transcript | 未套用 | 未套用 | 有 | 未套用 |
| HTTP | 有 | 固定為 scanner | 有 | 未套用 |

Filter chip 仍顯示啟用，但部分頁面忽略其中的條件。使用者可能把範圍外事件誤認為符合目前協查條件。

### 程式證據

- `src/renderer/src/components/SearchPanel.tsx:117` 的 `searchOpts` 只有 `agentType/since/before`。
- `src/core/db/event-queries.ts` 的 `searchEvents()` options 同樣只有 `agentType/since/before`。
- `src/renderer/src/components/TranscriptView.tsx:323` 只檢查 `sharedFilter.timeRange`。
- `src/renderer/src/components/HttpHistoryPanel.tsx` 套用 target 和 time，沒有套用 `inScopeOnly`。

### 建議修正

建立一個可序列化的共用查詢條件，例如：

```ts
interface EventFilter {
  targetId?: string
  agentType?: string
  since?: number
  before?: number
  inScopeOnly?: boolean
}
```

各頁面與 IPC 共用相同結構。某條件對目前頁面不適用時，應停用或明確標示，而不是保留啟用中的 chip 卻忽略它。

### 驗收條件

- 相同 filter 在 Search、Transcript、HTTP 和 Timeline 得到一致的事件集合語意。
- Target filter 能在後端搜尋中生效，不是在取得前 200 筆後才由前端排除。
- In-scope only 使用 canonical scope evaluator。
- 切換頁面時，任何未套用條件都有可見提示。
- 清除任一 chip 後，各頁結果同步更新。

---

## P1：匯出預覽與實際匯出集合不一致

### 使用情境

操作者篩選 HTTP 或縮放 Timeline 到某段攻擊時間，選擇「目前檢視」匯出，並先查看包含／排除筆數。

### 實際行為

`ExportMenu.loadPreview()` 只把 `sharing` 傳給 `data:exportPreview`。後端 preview 固定統計整個專案，沒有收到：

- 匯出格式；
- Timeline 的時間視窗；
- HTTP 的 host、method、status 或文字條件；
- 共用 target/type/time/scope filter；
- view-specific event IDs。

因此 preview 顯示的 total、included、out-of-scope、body refs 和 screenshot 數量，可能不是即將輸出的資料。

### Evidence bundle 的額外落差

ExportMenu 的「自用／交付」切換位於所有格式上方，preview 也會依 `sharing` 計算 metadata masking 與 blacklist；但 bundle 執行時只傳入：

```ts
{ maskOutOfScope: maskScope }
```

Bundle 本身已有 do-not-export、personal domain、scope body、附件政策等處理，但沒有承接 preview 所表示的完整 sharing policy。畫面可能呈現「將排除／遮蔽」，成品卻使用不同政策。

### 程式證據

- `src/renderer/src/components/ExportMenu.tsx:48`：preview 只傳 `sharing`。
- `src/main/ipc/data-export.ts:287`：preview 直接 `queryEvents({ limit: -1 })`。
- `src/renderer/src/components/ExportMenu.tsx:250`：bundle 只傳 `maskOutOfScope`。
- `src/main/ipc/data-export.ts:78`：bundle IPC 沒有 sharing 或 view filter contract。

### 建議修正

Preview 與 execute 共用同一份 `ExportRequest`：

```ts
interface ExportRequest {
  format: 'json' | 'ndjson' | 'har' | 'bundle' | 'timeline-slice'
  filter?: EventFilter
  sharing: boolean
  maskOutOfScope: boolean
  attachmentPolicy?: {
    screenshots: 'include' | 'exclude'
    casts: 'include' | 'exclude'
    agentTranscripts: 'include' | 'exclude'
  }
}
```

後端先將 request 解析為不可變的 export plan。Preview 與真正輸出都使用同一個 plan；輸出後由 manifest 記錄實際包含、排除、遮蔽與無法判定的數量。

### 驗收條件

- Preview total 等於實際輸出 event count。
- Timeline slice preview 只計算可見時間範圍。
- HAR preview 套用與成品完全相同的 host/time/filter。
- Bundle preview 所列 blacklist、metadata masking、scope 與附件政策，成品逐項一致。
- Manifest 記錄實際結果，而不只記錄執行前預估。
- 匯出期間若專案新增事件，preview 與 execute 使用同一 snapshot 或提示資料已變更。

---

## P2：搜尋失敗可能被誤認為沒有事件

### 實際行為

Search 的主要查詢失敗時，catch 只關閉 searching；cast search 失敗時直接設為空陣列。畫面沒有 query failed、partial failure、原因或 retry 狀態。

對紀錄工具而言，「沒有符合事件」和「查詢來源失敗」是完全不同的結論。協查時若顯示相同空畫面，會產生錯誤判斷。

### 程式證據

- `src/renderer/src/components/SearchPanel.tsx` 的 events search catch 只執行 `setSearching(false)`。
- 同檔案的 cast search catch 將結果設成空陣列。
- 目前已有 indexing 狀態，但沒有 query failure 狀態。

### 建議修正

區分以下狀態：

- 尚未搜尋；
- 搜尋中；
- 完整查詢成功且沒有結果；
- events 查詢失敗；
- cast 查詢失敗，但 events 結果可用；
- cast index 尚未完成；
- 查詢結果被上限截斷。

錯誤狀態應保留原查詢與 filters，提供 retry，並說明哪些來源仍成功。

### 驗收條件

- Events IPC rejection 不會顯示「沒有結果」。
- Cast search rejection 顯示 partial result，而不會讓 events 結果失效。
- Retry 使用相同 query/filter。
- 錯誤訊息可由鍵盤與螢幕閱讀器得知。

---

## P2：AI Transcript 仍是固定上限的閱讀子集

### 實際行為

Transcript 已避免所有事件混在同一個 2,000 筆上限，改為按來源分配：

- agent：800；
- shell：400；
- scanner：300；
- system：200；
- marker、loot、pivot：各 100。

這項改善能避免 HTTP 大量事件把 AI 全部擠掉，但仍不是完整資料集。較舊的 session 或 tool result 可能不在前端集合中，畫面也沒有顯示尚有更多資料。

Transcript 的文字 filter 只搜尋目前已載入的 blocks；它不能用來證明整個專案沒有某個事件。

### 程式證據

- `src/renderer/src/components/TranscriptView.tsx:264` 定義各類型固定 limit。
- 同檔案先載入固定集合，再於前端執行文字 filter。
- 目前沒有 cursor、load more 或結果完整性提示。

### 建議修正

沿用專案已加入的 `EventCursor + QueryPage`：

- Transcript 顯示目前載入範圍與「載入更多」。
- 文字搜尋送至後端，不只搜尋前端 blocks。
- 支援精準識別欄位：event ID、session ID、transcript UUID、tool-use ID、flow ID、operator、target、source time。
- Tool call/result 的配對查詢要能跨頁補齊另一半。
- 若只提供閱讀摘要，畫面明確標示「最近事件摘要」，避免被當成完整查詢。

### 驗收條件

- 超過各類型目前上限後，仍能找到最舊事件。
- 以 session ID 或 tool-use ID 查詢能得到完整 call/result。
- 結果列明 source timestamp 與 received timestamp。
- 分頁過程不重複、不漏失 dual-tier events。
- 新事件進入時不會使 cursor 結果跳動或漏頁。

---

## 不建議擴充的範圍

以上修正不需要加入：

- 案件管理；
- SIEM 規則引擎；
- AI agent 任務編排；
- 自動攻擊或結果評分；
- 清理任務追蹤平台。

RedLog 只需要確保三件事：操作者看到的條件確實被套用、搜尋失敗不會被當成沒有資料、預覽的交付內容與最終成品一致。

## 驗證限制

本文件結論已在 `82183f1` 核對相關 source 與 IPC 參數流向。尚未完成以下新版桌面端到端測試：

- 建立隔離專案並產生超過查詢上限的事件；
- 模擬 IPC 失敗與 partial search；
- 對同一 filter 比對四個頁面的實際結果 ID；
- 比對 export preview、輸出事件數與 bundle manifest；
- 窄視窗、鍵盤與螢幕閱讀器操作。

因此上述屬於已確認的設計／接線問題與建議驗收規格，不代表完整 UI 測試已通過。
