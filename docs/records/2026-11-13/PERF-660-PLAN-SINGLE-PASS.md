# #660 匯出預覽：計數與摘要併入選取的那一遍

> **狀態**：record — 同一台筆電、同一份專案、改前改後各量一次，數字只屬於這台機器、這個時間點  
> **範圍**：[#660](https://github.com/guan4tou2/REDLOG/issues/660) 與 [#587](https://github.com/guan4tou2/REDLOG/issues/587)。起點是 [PERF-660-WINDOWS-198K](PERF-660-WINDOWS-198K.md) §4（預覽階段讀了 8 遍整個專案）

## 1. 改了什麼

`buildExportPlan`（`src/core/export-planning.ts`）原本先用一遍選出事件，再對「選中事件」這個每次迭代都重新讀整個快照的可迭代物件各走一遍：超出範圍的 HTTP flow、被引用的附件（格式不支援附件時）、被截斷的輸出、暫停區間、擷取缺口、被中斷的錄製、證據摘要，HAR 另有 partial flow 與 exchanges。每遍都重讀、重新遮蔽每一筆事件。

現在每個數字都是一個逐筆餵入的 fold（`src/core/export-plan.ts` 的 `EventFold`、`*Fold`、`sequenceFingerprint`），在選取迴圈裡吃**已遮蔽的事件**；摘要是邊走邊更新的雜湊。事件格式（JSON／NDJSON／timeline／HAR）整個預覽只讀一遍快照；不收集事件，只保留計數器與雜湊狀態，所以記憶體不隨專案大小增加。

沒有丟棄、抽樣或截斷任何東西。

## 2. 沒有改的

- **bundle**：附件清單（`listExportAttachments`）要先走一遍找出 cast 與終端機的對應、再走一遍歸屬，`countExportAttachments` 另走兩遍，所以 bundle 仍會重讀選中事件。bundle 從 15 遍降到 9 遍（測試固定為 9）；把附件清單也改成 fold 是下一步，需要把「先解析 cast 再歸屬」改成延後解析。
- **HTTP 檢視的 HAR**：`partialHttpFlowsOutside` 要看選取**沒有選到**的 stream-only flow，這些事件不在選取串流裡，所以多一遍（`har` + HTTP selection 比 JSON + HTTP selection 多正好一遍，測試固定）。
- 選取本身（`iterateExportSelection`）對 activity／session／selection 各有自己的讀取，不在這次範圍。
- `validateExportSources`（execute 前的重驗）與 execute 各自仍走一遍。
- `getSanitizedFields` 在這個基準（`origin/main@fd9754bb`）已快取 prepared statement，所以第二個目標只剩每筆事件一次 `.all` 查詢；沒有量測改它的收益，沒有動。

## 3. 輸出沒有變

- `test/export-plan-golden.test.ts`／`test/fixtures/export-plan-golden.json`：25 種請求（json／ndjson／timeline／har／bundle、遮蔽、scrubPii、時間範圍、selection、HTTP selection、Activity、Session）的 `counts`、`selectedEventIds`、`selectedEvidenceDigest`、`attachmentDigest` 與附件清單。golden 是用**改前**的實作產生的，且先於改動提交；之後補的 `partialHttpFlowsOutside` 兩個案例也是用改前的原始碼重新產生（原本 23 個值沒有任何變動）。
- `test/export-plan-single-pass.test.ts`：數資料庫實際走訪次數（每次走訪都以一次無 cursor 的 `queryEventsPage` 開始）。事件格式 1 遍；每個走訪次數檢查在改前的程式碼上都會失敗（JSON 8、HAR 9、bundle 15）。
- 198k 專案上，改前改後的 `selectedEvidenceDigest`、`selectedEventIds`（雜湊）與整個 `counts` 位元組相同（見 §4）。
- 已存在的 `golden-old-rows`、`export-events-equivalence`、`filtered-export`、`export-plan-ipc`、`export-runner` 測試結果見 PR。

獨立對抗審查（`reviewer`）沒有找到會讓輸出不同的輸入。唯一理論上的差異：同一個 id 同時存在 `events` 與 `events_logged`（兩表各自 `id TEXT PRIMARY KEY`，彼此不互斥）時，舊的第二遍會把兩列都吐出來、新的只看選取吐出的那一列。目前兩個寫入路徑都用 `crypto.randomUUID()`，也沒有匯入、還原或遷移路徑會把列複製進任一表，所以不會發生；若日後加了合併／匯入功能，`validateExportSources` 仍是依 id 篩選，會以 `event-count` 拒絕，而不是靜默匯出不同內容。

## 4. 量測

- **專案**：`measure-app.mjs create` 建立、`seed-project.ts … 18000` 植入，198,360 列（chained 90,367、logged 108,000），與 #660 同規模。複製成兩份，分別跑改前（`origin/main@fd9754bb` 的 `export-plan*.ts`）與改後。
- **方法**：`bench-export-plan.ts`（`buildExportPlan`，NDJSON、整個專案、預設選項、無 Electron）。兩輪，每輪改前與改後各一次。
- **環境**：與 #660 同一台筆電（i7-1265U、32 GB、NVMe、Windows 11、Defender 開啟），量測時還有其他工作階段在跑，絕對值只供參考。

| | 改前 | 改後 | 倍數 |
|---|---:|---:|---:|
| 第一輪 | 146.0 s | 23.6 s | 6.2× |
| 第二輪（附摘要比對） | 123.2 s | 18.9 s | 6.5× |

兩輪的 `included`／`examined` 都是 198,367。第二輪同時輸出 `selectedEvidenceDigest`（`7bad5a2f…`）、`selectedEventIds` 的 sha256 與完整 `counts`：改前與改後三者完全相同。這份植入資料沒有被截斷、暫停、缺口或超出範圍的事件，所以 `counts` 大多是 0；那幾個計數器的等價性由 §3 的 golden 固定，不由這份資料。

單遍成本與 #660 §4 的估計一致（分頁讀取約 12 s 加上遮蔽）。剩下的 19～24 s 大部分是這一遍本身。

## 5. 沒量到的

- 端到端（resolve＋execute）與 Electron 內的數字：沒有重跑 `measure-app.mjs export`，只量了預覽階段。execute 與 validate 各自還有一遍。
- HAR、JSON、bundle 的預覽時間沒有在 198k 上各量一次，只量 NDJSON；其他格式的走訪次數由測試固定。
- 沒有量記憶體峰值；設計上不保留事件，但沒有用 198k 專案量測堆積用量。
