# 13 · 一件事看兩次的整合、儀表板的用途、背景耗電（root-cause review）

基準：`wt-docs5`（HEAD `e2d060f6`，= `origin/main@e6d22684` 加純文件提交）。唯讀：沒有啟動 app、沒有跑測試、沒有建置、沒有量測；機器負載中，只讀檔與 grep/git。
依據：UI 標準 §26（`docs/UIUX-STANDARD.md:610-625`）、根因審查 §4 全部裁定（含「功能刪減的裁定」與擁有者修訂 2、3、1′）、報告 04／10／11／12、Spec 072–075。
本報告建立在 12 之上，不重做它的盤點；12 已列的刪除項只在「整合的形狀」或「背景成本」有新內容時才提。
標記：`file:line` 都是本人開檔讀過的。凡是耗電「量」都是讀碼推估，一律 **UNCONFIRMED**；量測方法在 C.6。

## 摘要（10 行）

1. 擁有者對書籤與 HTTP 的處理是一條可推廣的規則：**兩個東西若差在「多一個欄位」或「換一種排列」，就是一個概念加一個篩選或一個版面**。照這條規則逐一驗證後，成立的有 9 項、只成立一半的 3 項、不成立的 4 項（A.0 總表）。
2. 最大的一項是**操作者的判斷有 7 種寫法**：標記（chained，4 個各自實作的寫入點）、標記修訂、事件備註 `event_notes`（側表、可改可刪、不上鏈）、`do_not_export`（側表、可撤）、書籤（側表）、逐字稿挑選（是帶分類的標記）、內容片段標記（`contentAnchor`）；再加上已裁定但未實作的「標為私人」「清除內容」。它們可以收成**一種註記事件（`marker`）、一個核心寫入函式**，差別只在附著對象與一個 `kind` 欄位（A.1）。
3. 4 個標記寫入點已經實際分歧：API 的 `/api/marker` 不對標題與備註做遮罩偵測（`api-server.ts:518-524` 對照 `ipc/markers.ts:107` 的 `redactFields`），HUD 用 `source_timestamp`、主對話框用 `atTimestamp` 表達同一件事「這個標記指向哪個時刻」。這是 §26.5 的直接反例，也是 AX 的問題：智能體寫出的標記與操作者寫出的不一樣。
4. 加入的證據檔（`file_transfer:artifact_added`，`ipc/artifacts.ts:35-36`）**不在證據頁、也不在活動紀錄的「證據」分類**：證據頁只查 `agent_type = 'screenshot'`（`event-queries.ts:717`），活動分類比對的是一個不存在的 agent type `'artifact'`（`activity-projection.ts:62`）。這是報告 10「種類沒有定義處」的又一例，也正好證明「證據＝依登記表家族篩選」比「證據頁自己的查詢」安全。
5. 活動紀錄的固定篩選列：**全部｜指令｜HTTP｜AI｜檔案｜標記**，由 Spec 072 的 `KindFamily`（commands／traffic／ai／artifacts）加上 `role: annotation` 產生；`signals`、`record` 兩族不進篩選列（它們是狀態，屬於狀態行）。核心已有一半：`ActivityFilter.actions`（`activity-contract.ts:14-17`）在查詢層實作了，renderer 沒有任何呼叫端。
6. 儀表板：從操作者在「開始前／進行中／結束後」的問題出發，真正**只有儀表板能回答**的是開始前的整體檢查（來源、出口 IP／VPN、範圍、完整性一起看）；進行中的問題由狀態列與 HUD 回答，結束後的問題屬於證據頁。建議 **(e) 建在 (b) 之上**：儀表板變成活動紀錄頂端的一行狀態，專案還沒有事件或整體狀態不是「記錄中」時自動展開成檢查清單，其餘時候收成一行；不新增頁面，HUD 不動（B.4）。
7. 背景耗電最大的三項都是**沒有人關掉的計時器**：HUD 的滑鼠追蹤每 50 ms 一次，HUD 隱藏、沒有專案時也照跑（`ipc/overlay.ts:178-198`，只在結束 app 時停，`index.ts:2109`）；網路連結偵測每 20 秒起 2–4 個子行程，關專案也不停（`index.ts:649-661`，`linkTimer` 沒有任何清除點）；mitmproxy addon 在有流量後的 30 秒內每 0.5 秒跑一次 `lsof`（`mitmproxy-addon.py:898,985-1001,974`）。
8. 第二層是「事件一到就全表重數」：活動計數每秒最多一輪，每輪 `COUNT(*) FROM events_logged`、`COUNT(*) … WHERE hash IS NOT NULL` 與對所有戰利品列的 `json_array_length` 加總（`useAppCounts.ts:97-105`、`event-queries.ts:1107-1110,1135-1140`、`evidence-chain.ts:3-6`），視窗隱藏時照跑；儀表板掛著時每批事件再加一次來源健康讀取與錨點清單讀取（`DashboardView.tsx:186-191`）。
9. 整個程式**沒有任何 `powerMonitor` 的電池、休眠、恢復處理**（唯一用到的是 `shutdown`，`index.ts:2017`），也沒有任何 main 端計時器看視窗是否可見。建議一個 main 端排程器（`core/scheduler.ts`）持有所有週期工作，依「有無專案／錄製中／視窗可見／電池」四個狀態決定節奏，並以 `setInterval` 呼叫點數的 ratchet 擋住新計時器（C.4、C.5）。
10. 不可節流的：shell hook 的 spool 回放、mitmproxy 的 in-flight 標記心跳、終端錄製的 flush、tailer 的變更合併——它們存在是為了不留紀錄缺口；節流這些就是製造「沒記到」（C.3）。

---

## A. 一件事看兩次：逐項驗證

判準：兩個東西的**資料**（schema／型別）與**取得方式**（查詢）放在一起比，若差別只是一個欄位、一個 where 子句或一種排列，就是同一個概念；若有一方帶著另一方不能表達的語意（可刪 vs 不可刪、我的 vs 目標的），照實寫「不是同一件事」或寫出合併會失去什麼。

### A.0 總表（依「回報 ÷ 損失」排序；「可先上」＝不必等 072–075、上了之後不必重做）

| # | 兩個（以上）東西 | 單一概念 | 轉換 | 失去的 | 移除 | 可先上？ |
|---|---|---|---|---|---|---|
| U1 | 標記（4 個寫入點）、修訂、`event_notes`、`do_not_export`、書籤、挑選、內容片段標記 | **註記**＝`marker` 事件，`kind` ∈ note／url／private（＋舊值唯讀），附著於 `_causes`／`atTimestamp`／`url`／`contentAnchor`；一個核心寫入函式 | 書籤與備註一次性寫成新的標記事件（不改既有列）；`do_not_export` 待「標為私人」規格 | 書籤可改網址可刪；備註可刪且不上鏈 | 側表 3 張的讀寫、IPC 10、API 2、≈1,000 行 | 寫入函式合一：**可**；轉換：書籤可，備註與私人待規格 |
| U2 | HTTP 頁、戰利品頁、活動紀錄 4 個頁籤、來源下拉 | 活動紀錄一份清單＋固定篩選列（A.2） | 無資料轉換 | 戰利品的分組列表、HTTP 的密集表格（列改為方法／狀態／主機） | HttpHistoryPanel 710、LootPanel 350、頁籤與 SourceSessionPicker ≈250、`httpHistory.*` 27、`loot.*` ≈20、`workspace.*` 19 | 否（072、074） |
| U3 | 截圖檢視的專屬查詢、活動紀錄的「證據」分類 | 證據頁＝`family = artifacts` 的格狀排列＋驗證 | 無 | 無（反而補回加入的證據檔） | `queryScreenshotPage` 與其 IPC | 修正分類字面值：**可**；換查詢：072 後 |
| U4 | 兩份 socket 擁有者表（addon 的 `lsof` 執行緒、連線監控的 `netstat`＋`lsof`） | 一個 socket 表生產者，兩個讀者 | 無 | 無 | 一份解析器；每秒 2–3.5 次子行程 | 否（需要 071 的 envelope 傳到 addon，或 addon 改問 app） |
| U5 | API／IPC／HUD 對同一動作各一份實作（標記、匯出、狀態、書籤） | 核心動作函式＋型別化結果；IPC、API、CLI 只是傳輸 | 無 | 無 | API 的 `exportHar`／`exportBundle` 旁路、`/api/capture` | 標記：**可**；匯出：**可**；狀態：075 |
| U6 | 目標頁自己的事件清單、範圍分頁、全域目前目標 | 目標＝活動紀錄的一個面向（target）；目標頁是這個面向的索引；範圍是目標列上的狀態 | 無 | 目標頁內就地看事件 | TargetView 的事件清單與 `queryPage` 一份、ScopeStatus 大部分 | 否（074） |
| U7 | 各頁 9 個事件搜尋框、3 種比對語意 | 一個查詢契約（`parseQuery`）＋頁的篩選作為範圍 | 無 | 依載入列的即時子字串比對 | 4 份 `toLowerCase().includes` | 隨各頁刪除 |
| U8 | 全域暫停、`redlog stop`、切專案時的終端暫停、專案關閉、「這個終端沒在錄」 | 一種「錄製狀態」區間（072 `role: state`）帶理由；075 的理由字 | 無 | 無 | 各畫面自己的暫停判斷 | 否（072、075） |
| U9 | 儀表板、首次使用、設定 ▸ 擷取來源 | 一份來源清單（075）在兩個大小：活動紀錄頂端（展開）與設定頁 | 無 | 見 B | 見 B | 否（075） |
| U10 | 時間軸與活動紀錄 | **不是同一頁**（固定裁定）；但篩選物件、閱讀器、計數語意要共用 | 無 | 無 | 兩份事件細節（Inspector 與 reader） | 部分（篩選物件可先） |
| U11 | air-gap 與更新自動檢查 | 一個開關（air-gap）；更新只手動（裁定 7） | 自動檢查的偏好讀到時忽略 | 自動得知新版（已裁定） | `autoCheck` 偏好、啟動 5 秒計時器 | **可** |
| U12 | 五份主機清單 | 半成立：「目標的」（範圍內、排除）與「我的」（個人、出口安全清單）是兩種；同一個評估器回答「這台主機屬於誰」 | 個人清單搬機器層（已裁定） | — | — | 已在 073 |

不成立（照實寫「不是同一件事」）：
- **出口 IP 白／黑名單 vs 範圍**：前者判斷「我現在從哪裡出去」，後者判斷「我碰的是誰」；同一個 IP 可以同時在兩份清單上而不矛盾（`config.ts:273-283` 與 `:284-290`）。合併會讓「我暴露了嗎」與「我越界了嗎」共用一個答案，那是錯的。
- **工作階段重播 vs 指令閱讀器**：三個入口（`terminal:replay`、`replaySession`、`replayAtTime`，`ipc/terminal.ts:39,66,95`）已經是同一個播放器（UI 標準 §第三期「回放器改狀態列上方抽屜」），差別只是錨點；它與指令輸出閱讀器的差別是「依時間播放」vs「讀文字」，不是同一件事。
- **匯出格式**：已經是一個計畫器加一張能力表（`export-capabilities.ts:7-20`），子集 `selection` 帶著當前篩選與查詢（`export-plan.ts:28`、`export-selection.ts:40-58`），也就是「匯出我正在看的」已經存在。剩下的重複只在 API（U5）與 `projection: 'http'`（併入 U2 後由篩選表達，HAR 仍要求 HTTP 列）。
- **設定檔匯出（profile）vs 事件匯出**：前者是設定，不是紀錄；已裁定在 073 後刪除，不必合併。
- 顯示時區：已經合一（`lib/time.ts:36-56`，舊的時間軸鍵讀一次後轉移），列為「檢查過、沒問題」。

### A.1 U1 註記：七種寫法收成一種

**證明（並列）**

| 寫法 | 儲存 | 可改／可刪 | 上鏈 | 附著於 | 寫入點 |
|---|---|---|---|---|---|
| 標記 | `events`，`agent_type='marker'` | 不可改，以修訂事件更正（`marker-amend.ts:1-12`） | 是 | `_causes`、`atTimestamp`、`url`、`contentAnchor`、`targetId` | IPC `ipc/markers.ts:95-125`；HUD `index.ts:447-468`；API `api-server.ts:511-527`；修訂 `marker-amend.ts:97` |
| 事件備註 | 側表 `event_notes(event_id PK, note, created_at, updated_at)`（`db/index.ts:312-317`） | 可改；空字串即刪除（`event-notes.ts:23-28`） | 否 | 一個 `event_id` | `events:setNote`（`ipc/events.ts:190-195`） |
| 不得匯出 | 側表 `do_not_export(event_id PK, created_at)`（`db/index.ts:296-299`） | 切換（`events:toggleDoNotExport`，`ipc/events.ts:183-186`） | 否 | 一個 `event_id` | 時間軸 Inspector |
| 書籤 | 側表 `bookmarks(id, title, url, note, context, created_at)`（`db/index.ts:240-247`） | 可改（含網址）、可刪（`index.ts:1711-1712`） | 否 | 網址＋瀏覽器與出口 IP 的情境（`index.ts:1700-1704`） | IPC 5、`/api/bookmarks` GET/POST、CLI、agent 腳本 |
| 逐字稿挑選 | 就是標記，分類 `key_step`／`failed_attempt`，`_causes` 指向步驟（`lib/transcriptPicks.ts:1-8`） | 同標記 | 是 | `_causes` | `TranscriptView.tsx:717`（已裁定刪除） |
| 內容片段 | 標記帶 `contentAnchor`（`ipc/markers.ts:99-104,109`） | 同標記 | 是 | 事件內一段位元組（含 sha256） | 主對話框 |
| 標為私人／清除內容 | 已裁定：鏈上留標記（§4 晚間追加） | — | 是 | 事件或一段 | 未實作 |

三張側表的註解自己都寫了同一個理由：「事件列不可改，所以放旁邊」（`db/index.ts:293-311`、`event-notes.ts:5-9`）。這個理由對標記一樣成立，而標記用的是「另寫一列並指回去」——也就是說同一個問題有兩種解法並存。

**已經分歧的實例（同一機制產生的缺陷）**
1. API 寫的標記沒有遮罩 span：IPC 與 HUD 都用 `redactFields(…, MARKER_TEXT_FIELDS)`（`ipc/markers.ts:107`、`index.ts:455`），API 直接 `ingest`（`api-server.ts:518`），而 `ingest` 的通用偵測只看 `output/command/stdout/…`，不含 `title`／`notes`（`ingest.ts:633-647`）。智能體透過 `redlog_mark` 寫進標記的密碼，匯出時不會有 span（報告 11 已說明 span 預設不套用，但連可套用的 span 都沒有）。
2. 「標記指向的時刻」兩種寫法：主對話框寫 `atTimestamp`，列時間仍是寫入時間，時間軸依 `atTimestamp` 畫（`timelineFilters.ts:108`、`MarkerDetail.tsx:223`）；HUD 寫 `source_timestamp`，由寫入端改成列的發生時間（`event-write.ts:416`、`ipc/markers.ts:46`），`MarkerDetail` 的「指向時間」列讀不到它。我先懷疑 HUD 標記的點擊時間被丟掉，讀到 `resolveOccurredAt` 後確認沒有丟——但同一個語意兩個欄位，閱讀器只認一個，這就是 §26.5 要消滅的形狀。
3. API 標記的分類預設 `external`、HUD 與對話框是 `custom`；API 標記不能帶 `_causes`、`url`、`atTimestamp`。

**統一**
- 單一概念：**註記**（Spec 072 `role: annotation` 的操作者那一半），事件型別仍是 `marker`（舊列不動）。
- 單一寫入：`core/annotation-write.ts` 的 `writeAnnotation(input, identity, transport)`：驗證、截斷、`redactFields`、`_causes` 正規化、時間（只用 `atTimestamp`；HUD 的點擊時間改寫進 `atTimestamp`，`source_timestamp` 讀到時仍照舊轉成發生時間，舊列不受影響）。IPC、HUD、API、修訂都只呼叫它，回傳同一個型別化結果 `{ ok, event?, reason? }`。
- `kind`：`note`（預設）、`url`（取代書籤）、`private`（取代 `do_not_export` 與已裁定的「標為私人」）。舊的 `severity`／`category` 只讀（裁定 5）。
- 事件備註 → 帶 `_causes: [eventId]` 的註記；「改備註」＝修訂；時間軸「這列有人寫過字」的判斷改由 074 的 `cause_counts` 依 `role: annotation` 回答，`events:annotatedIds` 刪除。

**轉換（不丟資料、不改既有列）**
- 書籤（已裁定）：每列寫一個新的 `marker`，`kind: 'url'`、`title`、`notes ← note`、`url`、`atTimestamp ← created_at`、`context`（瀏覽器網址、標題、出口 IP）原樣放進 `data.converted_from_bookmark`。轉換本身寫一筆 `system:annotations_converted`（數量）。側表保留唯讀一個版本後再停止讀取。
- 事件備註：同法，`_causes: [event_id]`、`atTimestamp ← updated_at`，`data.converted_from_note = { created_at, updated_at }`。
- `do_not_export`：**等「標為私人」的規格**（報告 11 建議的 Spec 076），不在本報告先行轉換；在那之前兩者並存，這是唯一暫時保留的側表。

**照實列出失去的**
- 書籤的網址可改：標記的 `url` 刻意不可修訂（`marker-amend.ts:27-30`，§20）。轉換後要改網址只能寫新標記。
- 書籤與備註可刪且「刪了什麼都不留」（`event-notes.ts:20-22`）：變成註記後，刪除只能是修訂成空白，原文仍在鏈上。這是語意改變——事後寫下的判斷變成簽章過的紀錄。對證據工具多半是收益，但有人會把私人想法寫在備註裡；列為擁有者問題 2。
- 書籤的釘選（已裁定接受）。

**移除**：`db/bookmarks.ts` 110、`db/event-notes.ts`、`EventNoteField.tsx` 102、BookmarksView 518、IPC（bookmarks 5、notes 3、DNE 2 待規格）、`/api/bookmarks` 2 條、CLI 與 agent 腳本的 bookmark 指令、`retention.bookmarks`、`bookmarks.*` 42 鍵。
**守住**：「`insertEvent('marker'` 與 `agentType: 'marker'` 只在 `annotation-write.ts` 出現」的字面掃描測試（沿用 boundary 測試的寫法）。

### A.2 U2 活動紀錄：固定篩選列與每列的呈現

**證明**：HTTP 頁讀 `queryHttpFlowPage`、戰利品頁讀 `queryPage({agentType:'loot'})`、截圖讀 `queryScreenshotPage`、活動紀錄讀 `runQuery`／`queryPage`（`HttpHistoryPanel.tsx:227`、`LootPanel.tsx:90`、`ScreenshotsView.tsx:190`、`SearchPanel.tsx:123-125`）——同一張 `events ∪ events_logged`，四個 where。活動紀錄的 4 個頁籤（`RecordingWorkspace.tsx:57-59`）把兩件不相干的事綁成一列：「分組方式」（活動 vs 原始事件）與「種類」（全部 vs 一個 shell session vs 一個 AI session）；AI 頁籤還寫死兩個工具名（`:142`）。另有一個以 agent type 為選項的來源下拉（`:118-120`）。核心的 `ActivityFilter.actions`（`activity-contract.ts:14-17`、`db/activity-queries.ts:97,255`）沒有任何 UI 呼叫端。

**篩選列（固定）**：`全部｜指令｜HTTP｜AI｜檔案｜標記`

| 篩選 | 來源（072） | 列上顯示 | 開啟（072 閱讀器） |
|---|---|---|---|
| 全部 | 所有 action 與 annotation 列 | 依種類 | 依種類 |
| 指令 | `family: commands`（shell、AI 的 execute 工具呼叫） | 指令行、結束碼、時長、目標、戰利品徽章（附著的 loot 數） | 指令閱讀器（輸出、cast 片段、命中處就地標示） |
| HTTP | `family: traffic` 中的 flow（`flow_id` 區間）；DNS／TCP／pcap 為其成員或在「全部」中 | 方法、狀態碼、主機＋路徑、大小（裁定 2） | `HttpDetail` |
| AI | `family: ai` 的 session 與訊息 | session 列：工具、第一句、輪數；訊息列：角色＋首行 | 逐字稿閱讀器（今天的 TranscriptView 只留閱讀） |
| 檔案 | `family: artifacts`（截圖、加入的證據檔、傳輸） | 縮圖或檔名、大小、SHA-256 前綴 | 影像／檔案閱讀器 |
| 標記 | `role: annotation`（操作者的註記＋偵測器的戰利品、範圍觀測） | 標題、附著對象的一行摘要、作者（操作者／偵測） | 註記閱讀器；附著對象一鍵開啟 |

規則（防止這一列長大）：
1. 篩選列的選項＝072 `KindFamily` 中屬於「動作與結果」的值，加上 `role: annotation`。`signals` 與 `record` 兩族不進列（它們是狀態與紀錄本身的事實，住在狀態行與時間軸）。新增一個選項＝在 072 新增一個家族，而家族是封閉列舉、由 gate 鎖住（`specs/072…/spec.md:171`）。
2. 不以工具或來源命名（不出現 mitmproxy、Claude Code、Burp）；來源與 session 是次要篩選，收在一個「篩選」選單。
3. 本專案沒有資料的家族不顯示（12 H.1 的對策）；「全部」永遠在。
4. 「原始事件」不是篩選，是同一份結果的排列（分組 vs 不分組），收進選單。

**取代的頁與頁籤**：HTTP 頁（裁定 2）、戰利品頁（裁定 6 的戰利品部分）、`io`／`ai`／`events` 頁籤、來源下拉、`RecordingStatus`（第 4 份整體判斷，`RecordingWorkspace.tsx:21-53`，改由狀態行承接，見 B）。

**戰利品的確切形狀**（裁定「移到活動紀錄」，§4「附著在來源指令上」）：
- 戰利品事件本來就是帶 `_causes: [來源事件]` 的註記（`loot-detector.ts:251-269`），不需轉換。
- 在「指令」篩選中，來源列帶「戰利品 N」徽章（N＝`matches` 長度總和）；開啟來源列時在輸出中就地標示命中（即正在寫的「就地閱讀」工作）。
- 在「標記」篩選中，戰利品是作者為「偵測」的註記列，可依類型再篩。沒有 `_causes` 的戰利品（`/api/loot/scan` 未帶來源、手動掃描）只出現在這裡。
- 失去的：以類型分組的戰利品清單、在戰利品預覽上的即時子字串搜尋（`LootPanel.tsx:127-131`）。活動搜尋是否涵蓋 `matches[].preview` **UNCONFIRMED**（需查 `executeEventQuery` 的全文欄位；若不涵蓋，要在 074 的投影把它納入，否則搜尋能力倒退）。

### A.3 U3 證據頁：查詢換成家族

- 證據頁只列 `agent_type = 'screenshot'`（`event-queries.ts:717`）。加入的證據檔寫成 `file_transfer:artifact_added`（`ipc/artifacts.ts:35-45`），證據頁看不到；活動分類的證據比對 `'artifact'`（`activity-projection.ts:62`），這個 agent type 沒有任何寫入點（grep `insertEvent('artifact'`、`agentType: 'artifact'` 皆無）。所以操作者拖進來的檔案只在時間軸與全文搜尋找得到（`SearchPanel.tsx:36`、`TimelineEventInspector.tsx:443`）。
- 統一：證據頁＝`family: artifacts` 的格狀排列＋驗證（裁定 6）。它與活動紀錄「檔案」篩選是**同一個查詢的兩種排列**（像時間軸之於活動紀錄），所以不違反「頁就是篩選」——留頁的理由是驗證，不是清單。
- 可先上的一行修正：`activity-projection.ts:62` 改為比對 `file_transfer` 的 `artifact_added`（或等 072 由登記表給 `action`）。**未執行**；修正前要確認 `test/activity-*.test.ts` 沒有釘住現行為（UNCONFIRMED）。

### A.4 U5 同一個動作三種傳輸、三種結果

| 動作 | IPC | API | CLI／agent | 分歧 |
|---|---|---|---|---|
| 寫標記 | `marker:create` | `POST /api/marker` | `redlog mark`、`redlog_mark` | 見 A.1 |
| 匯出 | 匯出計畫器（`export-plan.ts`、`export-selection.ts`） | `/api/export/har` 直呼 `exportHar`、`/api/export/bundle` 直呼 `exportBundle`（`api-server.ts:476-490,756-762`） | `redlog export` | API 不經計畫器：沒有 selection、沒有個人清單（報告 11 已指出）、沒有快照驗證 |
| 狀態 | `capture:health`（`index.ts:1838`） | `/api/status`（拼 IP、計數、health）、`/api/capture`（同一份 health）（`api-server.ts:579-592`） | `redlog status` 讀 `/api/status` | 三個形狀；075 FR-031 已規定一份 payload |
| 書籤 | 5 個 IPC | GET/POST | `redlog bookmark` | 隨 U1 消失 |

規則（AX）：每個動作在 `src/core/actions/` 有一個函式與一個型別化結果；IPC handler、API route、CLI 只做驗證身分與序列化。gate：API route 與 IPC handler 不得直接 import `db/events` 的寫入函式（字面掃描）。這也是 071 FR-070「每條路由宣告一個能力」的實作位置，不是新工作。

### A.5 U6 目標、範圍、目前目標

- 目標頁的事件清單（`TargetView.tsx:58` 的 `queryPage`）＝活動紀錄加 `targetId` 篩選；目標頁本身的聚合（`aggregateTargets`，`:32,106`）是索引，保留（裁定導覽含「目標（含範圍）」）。統一後：點目標＝開活動紀錄並帶 target 篩選（篩選列不變，target 是次要篩選的一個已填值），目標頁不再有自己的事件清單。
- 範圍分頁＝目標列上的狀態（範圍內／外／未知）＋「範圍外觀測」篩選（12 C.5 已提）。
- 全域目前目標（`targetContext.get/set/onChange`，`TargetView.tsx:139-176`）：已裁定只用於標記與手動截圖的預設值；它不是篩選，也不該再出現在目標頁的列上作為「目前」。
- 失去：在目標頁內就地捲事件（改為跳一頁，返回走 12 已有的麵包屑）。

### A.6 U7 搜尋框

事件資料上的搜尋框 9 個、3 種語意：
- 子字串比對**已載入的列**：截圖（`ScreenshotsView.tsx:246-249`）、戰利品（`LootPanel.tsx:127-131`）、書籤（`BookmarksView.tsx:85-87`）、目標（`TargetView.tsx:235-237`）。這正是記憶中「capped view 不得看起來像完整資料」的反例：搜尋結果只涵蓋已載入的頁。
- 查詢契約 `parseQuery`：活動紀錄（`SearchPanel.tsx:123-125`）、時間軸（`Timeline.tsx:53,417,856`）、逐字稿（`TranscriptView.tsx:14,463`）。
- HTTP 結構化欄位＋文字：HTTP 頁（`HttpHistoryPanel.tsx:222`）。
另有 ⌘K 的事件段。不是同一件事的：設定搜尋（已裁定刪）、外掛、專案選擇器、終端機內尋找、閱讀器內尋找（`EventContentReader.tsx:131`）——它們搜的不是紀錄。
統一：只剩 `parseQuery` 一種語意，範圍＝頁上的篩選；子字串搜尋隨 U1–U3 的頁刪除而消失，**不另做遷移**。

### A.7 U8 錄製狀態只有一種

今天「這一段有沒有在錄」有五個來源：全域暫停（`eventBus.paused`）、每終端 `redlog stop`（`shell:capture_stopped/resumed`）、切專案時的終端暫停（已裁定）、專案關閉（072 FR-046 `system:project_closed`）、「這個終端沒被記錄」（`terminal.noProjectRecording`）。報告 10 已證明暫停帶是從已載入的列推出來的（`timelineIncremental.ts:473-486`）。統一：072 的 `role: state` 區間「錄製」，`reason` 為上面五者之一；075 的來源狀態用同一個理由字（FR-020 已有 `recording-paused`）；狀態行、HUD、時間軸的帶、匯出的「未錄」區段都讀這一個區間投影（074）。不需轉換舊列：區間由既有列推出。

### A.8 U10 時間軸與活動紀錄：不是同一頁，但有四樣東西該只有一份

時間軸保留自己的頁（固定裁定）。兩者今天**已共用**：查詢契約（`parseQuery`、`queryPage`、`matchIds`）。**仍各一份**：
1. 事件細節：時間軸的 `TimelineEventInspector` vs 活動的 `ActivityReader`／`EventContentReader`、另有 `MarkerDetail`、`HttpDetail`、截圖詳情——072 的閱讀器登記表收掉。
2. 篩選物件：時間軸讀共用 FilterBar 加自己的工具列；活動有自己的頁籤與下拉。應該是同一個序列化的篩選物件（家族、target、時間、查詢字串），讓「在時間軸開啟這組條件」與反向都是傳一個物件。074 FR-085 決定篩選留各頁——那是指 UI 位置，物件仍應是同一型別。
3. 即時更新：各自訂閱 `onNewBatch`（`Timeline.tsx:605`、`SearchPanel` 內、`TargetView.tsx:116`、`ScopeStatus.tsx:168`、`ScreenshotsView.tsx:210`、`HttpHistoryPanel.tsx:141`）——074 的變更主題 `rows:<family>` 收成一份。
4. 「共多少」：時間軸 `events.count`、活動 `totalGroups/totalMatches`、狀態列與儀表板 `useAppCounts`——074 的計數契約。

### A.9 U11 設定其實是狀態

- air-gap（`network.offline`，專案層）已經關掉錨定、NTP、更新、IP 查詢（`index.ts:1054-1064`），但更新還有自己的 `autoCheck`（`updater.ts:49-53`），而且在任何專案開啟之前 5 秒就檢查（`index.ts:2036`）。裁定 7（只手動）落地後，`autoCheck` 與啟動計時器一起刪，air-gap 成為唯一開關。另一半：air-gap 是「這台機器此刻不得連外」，屬機器層（073），不是專案層——這是報告 11「三處不即時生效」的根。
- 縮放與密度（裁定已有）、時區（已合一）不重述。
- 來源的開關 vs 外掛啟用 vs pack 成員開關：075 的單一來源清單處理，本報告不重複。

---

## B. 儀表板是做什麼的

### B.1 從操作者的問題出發

| 時刻 | 問題 | 今天在哪回答 | 只有儀表板能回答？ |
|---|---|---|---|
| 開始前 | 該錄的都在錄嗎？（指令、HTTP、AI、我開的終端） | 儀表板擷取卡、首次使用、設定三頁 | **是**（唯一能一次看全部來源的地方） |
| 開始前 | 我從哪裡出去？VPN 在不在？ | 儀表板 IP 卡、HUD、狀態列 | 否（HUD 一直在） |
| 開始前 | 範圍載入了嗎？幾個目標、幾個排除？ | 儀表板「專案」區塊、範圍頁 | 部分（範圍頁有，但不和來源一起看） |
| 開始前 | 上次的紀錄完整嗎？錨定過了嗎？ | 儀表板記錄概況、設定 ▸ 證據鏈 | 部分 |
| 進行中 | 有什麼停了？ | 狀態列「需要注意 N」、HUD REC、儀表板 issues | 否 |
| 進行中 | 我越界了嗎？ | 狀態列範圍、HUD、側欄徽章 | 否 |
| 進行中 | 現在 IP 安全嗎？ | HUD（常駐）、狀態列 | 否 |
| 結束後 | 證據完整嗎？哪裡斷了？ | 設定 ▸ 證據鏈、時間軸斷鏈橫幅 | 否（裁定 6：證據頁） |
| 結束後 | 有沒有一段沒錄到？ | 時間軸暫停帶（只看已載入列） | 否（U8 之後由區間投影回答） |

結論：儀表板唯一不可替代的用途是**開始前的整體檢查**，而這件事在第一次開專案時最需要、之後每次開專案時需要一眼。進行中它是第三份副本（狀態列、HUD 之後），結束後它不是對的地方。

### B.2 今天儀表板上的每一筆資料

| 資料（元件，file:line） | 回答的問題 | 何時需要 | 變動頻率 | 需要動作？ | 別處 |
|---|---|---|---|---|---|
| 需處理清單（`DashboardIssues`，`:20-24` 的三個修復：立即錨定、驗證鏈、重查範圍） | 什麼壞了、怎麼修 | 任何時候 | 事件驅動 | 是 | 狀態列計數（同一個 issue store，`lib/issues.ts`；raise 寫在 `StatusBar.tsx:120,148,180,193`） |
| 擷取健康卡（`CaptureHealth.tsx`，728 行） | 每個來源能不能記、有沒有在記 | 開始前、壞掉時 | 秒～分 | 有時（安裝、驗證） | 首次使用、設定三頁、外掛頁（報告 04 F5） |
| IP 卡（`IPStatusCard.tsx`：外部 IP、安全／暴露／未知、內部 IP、更新時間、重查） | 我從哪裡出去 | 開始前、切 VPN 後 | 60 秒 | 偶爾（重查） | HUD、狀態列 |
| 記錄概況（`DashboardView.tsx:37-63`：上鏈數、僅本機數、錨定狀態與新鮮度、漂移／過期錨點／抽樣斷鏈警告） | 記了多少、證據完整嗎 | 結束後、偶爾 | 每批事件 | 偶爾 | 狀態列事件數、時間軸、設定 ▸ 證據鏈 |
| 專案摘要（`:322-344`：專案 ID、操作者、範圍目標與排除數、「檢視範圍」） | 我在哪個專案、範圍載入了沒 | 開始前 | 幾乎不變 | 否 | 標題列專案名、範圍頁 |
| 快捷鍵（`:347-358`） | — | 第一次 | 不變 | 否 | `?` 面板、⌘K |
| 新鮮度說明（`:243`） | 解釋版面（§26.4 反例） | — | 不變 | 否 | — |
| 首次使用變體（`FirstRunView`：指令路徑、HTTP 路徑、preflight、卡住偵測 `:174-183`） | 怎樣開始記 | 第一次 | 秒 | 是 | 設定 ▸ hooks、終端機頁 |

### B.3 五個設計的評估

固定規則：單欄、不新增頁面、HUD 全保留、擷取失敗與證據不完整不得隱藏、「沒有事件」不得看起來像「什麼都沒發生」。所有設計都只渲染 075 的單一 payload（FR-031／032）。

| | (a) 刪頁，只留狀態列＋HUD | (b) 活動紀錄頂端一行狀態，就地展開 | (c) 狀態列的 popover | (d) 留頁，只剩「準備好錄了嗎」清單 | (e) 檢查清單＝活動紀錄的空狀態，有事件後退成狀態行 |
|---|---|---|---|---|---|
| 首 3 秒看到 | 活動紀錄；底部 8px 的一個字 | 活動紀錄＋頂端一行「記錄中 · 6 個來源 · IP 安全 · 範圍 3／1 · 鏈完整」 | 活動紀錄；要看全貌得先找到狀態列 | 一頁清單：每來源一行＋出口＋範圍＋完整性，綠的收合 | 新專案：清單（就是 (d) 的內容）；有事件：同 (b) |
| 到全貌的點擊 | 無全貌（只能逐一去設定頁） | 1（展開） | 1，但 popover 在視窗底部、會被捲動或焦點關掉 | 0（但要先導覽到該頁，+1） | 0（新專案）／1 |
| 失去的 | 開始前的一眼檢查；範圍與來源並看 | 一個導覽目的地 | 同 (b)，另失去「首屏就看到」 | 「活動紀錄成為首屏」的收益；導覽多一頁 | 一個導覽目的地 |
| 移除的程式 | 全部 ≈650 行＋鍵；CaptureHealth 搬去設定 | DashboardView、DashboardIssues、IPStatusCard、RecordingStatus；CaptureHealth 換成 075 的來源列元件 | 同 (b)，另加 popover 元件 | 保留 DashboardView 外殼；刪 IP 卡、記錄概況、快捷鍵、說明 | 同 (b)＋FirstRunView 的外殼（RecordTerminalFlow 保留） |
| 與 075 | 只有狀態列渲染整體字 | 狀態行＝整體字；展開＝來源列＋完整性；FR-034 改寫為「活動紀錄頂端」 | 同 (b) | FR-032／034 照原文 | 同 (b)；FR-034「首次使用預設展開」直接成立 |
| AX | `/api/status` | 同一份 payload | 同 | 同 | 同 |
| §26 檢核 | 3 秒：過；一主動作：過；但違反「失敗不得隱藏」的精神——只剩一個字 | 3 秒：過；狀態行不是動作，主動作仍是搜尋；異常會展開 | 3 秒：不過（開始前的問題得自己去找） | 3 秒：過；但多一頁，且這一頁在 90% 的時間只說「都好」 | 3 秒：過；空專案的主動作是「開啟終端機」，有事件後是搜尋——兩者在不同時刻，不衝突 |

「沒有事件」與「什麼都沒發生」的區分：(a)(c) 只能靠一個字；(b)(e) 的狀態行在零事件時寫「等待第一筆事件」並展開來源清單（075 的整體字之一），而活動清單本身是空狀態——兩件事各在其位。

### B.4 建議：(e) 建在 (b) 之上

1. 儀表板不再是目的地；它的內容成為**活動紀錄頂端的狀態行**，只渲染 075 的 payload：整體字＋來源數＋出口＋範圍＋完整性，各一個字或數字。
2. 自動展開成檢查清單的條件：專案還沒有任何動作類事件（首次使用），或整體字不是「記錄中」；展開時列出每個來源（八個字之一＋理由＋至多一個前往）、出口 IP／VPN、範圍、完整性。都正常時收成一行，操作者可手動展開。
3. 狀態列的整體字點擊＝捲到並展開這一行；來源的修復仍只在設定 ▸ 擷取來源（075 FR-040 的 owner）；HUD 不動。
4. 記錄概況的上鏈數與錨點移到證據頁（裁定 6），專案摘要已在範圍設定，快捷鍵進 ⌘K（12 已提）。
5. 會改變這個建議的：(i) 若 075 的 payload 計算成本使得「每批事件更新一次頂端狀態行」不可行（C 節顯示今天每批就有 5 次計數讀取），則狀態行改為只在狀態字變化時更新；(ii) 若實機上操作者在開始前根本不切到活動紀錄而是直接去終端機頁，檢查清單應改放在終端機頁的空狀態，而不是保留 (d)；(iii) 擁有者若認為「開始前檢查」值得一個固定位置，(d) 是唯一合規的退路。

---

## C. 背景耗電

### C.1 盤點（main、子行程、renderer、hook）

週期以預設設定計。「無專案」＝專案關閉後 app 仍開；「暫停」＝全域錄製暫停；「隱藏」＝主視窗隱藏或最小化。成本是讀碼推估（**UNCONFIRMED**，量測見 C.6）。

| # | 項目（file:line） | 週期 | 每次的工作 | 無專案 | 暫停 | 隱藏 | 喚醒 |
|---|---|---|---|---|---|---|---|
| 1 | HUD 滑鼠追蹤（`ipc/overlay.ts:178-198`） | **50 ms** | `screen.getCursorScreenPoint()`＋`getBounds()`；HUD 不可見時 `isVisible()` 後返回，但計時器照跑 | **跑**（只在 quit 停，`index.ts:2109`；`stopProject` 只 hide，`index.ts:1270-1276`） | 跑 | 跑 | main 執行緒 20 次／秒 |
| 2 | 網路連結偵測（`index.ts:649-661` → `network-info.ts:34-61`） | 20 s | macOS：`route`、`networksetup -listallhardwareports`，Wi-Fi 時再 `ipconfig getsummary`、`networksetup -getairportnetwork`，每個經 `exec`（另起 `/bin/sh`）＝4–8 個行程 | **跑**（`linkTimer` 無清除點） | 跑 | 跑 | 行程 12–24 個／分 |
| 3 | addon 的 socket 擁有者表（`mitmproxy-addon.py:898,985-1001`、`:974`） | 0.5 s，最後一次查詢後 30 s 停 | `lsof -nP -iTCP -sTCP:ESTABLISHED`（macOS）／`ss`／`netstat` | proxy 隨專案；無專案則無 | 跑（有流量就跑） | 跑 | 行程 2 個／秒；瀏覽器背景連線可使其長時間不停 |
| 4 | 行程監控（`process-monitor.ts:186-227`，預設 `pollMs` 500，`config.ts:323`） | 0.5 s（Win 2 s） | `ps -eo …` 全表＋解析；暫停時 `poll` 返回（`:233`） | 停 | 計時器跑、不 spawn | 跑 | 行程 2 個／秒（pack 預設關） |
| 5 | 連線監控（`connection-monitor.ts:96-106,248-260`） | 2 s | macOS：`netstat -p tcp`、`netstat -p udp`、`lsof`＝3 個行程 | 停 | 不 spawn | 跑 | 1.5 個／秒（pack 預設關）；與 #3 讀同一張表 |
| 6 | 活動計數（`useAppCounts.ts:91-114,141`） | 每批事件，≤1 輪／秒 | 5 次 IPC：已快取的 chained 數、`COUNT(*) FROM events_logged`（未快取，`event-queries.ts:1107-1110`）、`COUNT(*) … hash IS NOT NULL`（`evidence-chain.ts:3-6`）、所有 loot 列的 `json_array_length` 加總（`event-queries.ts:1135-1140`）、觀測數（已快取） | — | 有事件就跑 | **跑** | main 執行緒 O(n) 掃描 ≤1 次／秒 |
| 7 | 擷取健康（`StatusBar.tsx:41` 30 s；設定頁 5 s；儀表板每批） | 30 s／5 s／每批 | `computeCaptureHealth`：每來源一次索引 seek、hook 偵測（快取 2 分）、AI 活動探測（每根目錄每分最多一次、上限 400 次 fs 呼叫，`agent-activity-probe.ts:24-26`） | IPC 回 null | 跑 | 跑 | main ≤2 次／分；fs ≤800 次／分 |
| 8 | 托盤閃爍（`tray.ts:113-116`） | 750 ms | `tray.setImage` 換圖 | 停（`index.ts:1278`） | 停（換暫停圖） | 跑 | main＋WindowServer 1.3 次／秒，錄製中全程 |
| 9 | HUD 動畫與時鐘（`OverlayApp.tsx:41` `useTick()` 1 s；`:287,315,319` CSS 動畫 `blinkRec` 1.1 s、暴露時 `pulse`、警報 `alarm`） | 1 s＋持續動畫 | 每秒整個 HUD 重繪；透明置頂視窗的合成 | HUD 隱藏（但 #1 仍跑） | REC 不閃 | 不相干（HUD 獨立） | GPU 合成，**量級 UNCONFIRMED** |
| 10 | 狀態列（`StatusBar.tsx:74` 1 s uptime；`:198` 暫停計時；`:261-269` `animate-pulse-slow`） | 1 s＋持續動畫 | 整個狀態列每秒重繪；REC 點持續動畫 | — | 暫停計時 1 s | Chromium 對隱藏頁節流 | renderer |
| 11 | 時間軸時鐘（`TimelineClock.tsx:15`）、`useTick` 用者（`IPStatusCard.tsx:82`、`CaptureHealth.tsx:404`、`DashboardIssues.tsx:112`） | 1 s／30 s | 小範圍重繪 | — | — | 節流 | renderer，掛載時 |
| 12 | IP 查詢（`ip-signal-producer.ts:209-212`，`checkInterval` 60） | 60 s | 1 次 DNS（失敗時 HTTP 輪替），`os.networkInterfaces()`，廣播到主視窗與 HUD | 停（`alert-runtime.ts:191`） | 跑（HUD 要） | 跑 | 網路 1 次／分 |
| 13 | opsec 狀態（`opsec-state.ts:126-169`） | 30 s | `scutil --dns`（經 shell，2 個行程）、介面列舉 | 停 | 跑 | 跑 | 行程 4 個／分 |
| 14 | NTP（`clock.ts:81-85`） | 5 分（首次 5 s） | 1 個 UDP 封包 | 停 | 跑 | 跑 | 網路 |
| 15 | OTS 錨定（`chain-anchor.ts:264-283`） | 1 時（首次 30 s）、升級 6 時 | 鏈頭沒變就不送；變了送多個 calendar | 停 | 跑 | 跑 | 網路 |
| 16 | 鏈抽樣（`index.ts:1122-1143`） | 5 分 | 依 rowid 抽 50 列驗證（`chain-anchor.ts:797-816`） | 停 | 跑 | 跑 | 磁碟讀 |
| 17 | spool 回放（`index.ts:972-975`） | 30 s | `readdir` pending 與 inflight 目錄；暫停時返回 | 停 | 返回 | 跑 | 磁碟 meta |
| 18 | logged 層清掃（`index.ts:896-907`） | 24 時 | DELETE 過期列（預設保留期 0＝不刪時近乎無事） | 停 | 跑 | 跑 | 磁碟寫 |
| 19 | CDP 導覽輪詢（`cdp-connector.ts:127-132`） | 3 s | 對 `127.0.0.1:<port>/json` 一次 HTTP；**瀏覽器關掉後仍輪詢到專案關閉**（`:128-130` 註解「silent no-op」） | 停 | 返回 | 跑 | main 20 次／分 |
| 20 | 剪貼簿（`clipboard-monitor.ts:120`，1.5 s）、週期截圖（`screenshot-agent.ts:190`） | 1.5 s／設定 | 讀剪貼簿／擷圖 | 停 | 返回 | 跑 | **已裁定刪除** |
| 21 | 更新檢查（`index.ts:2036`） | 啟動後 5 s 一次 | HTTP | 跑（早於專案） | — | — | **已裁定改手動** |
| 22 | addon in-flight 心跳（`mitmproxy-addon.py:446-449`） | 1 s | 取鎖；有在途事件才寫標記檔 | proxy 隨專案 | 跑 | 跑 | 子行程 1 次／秒（不可節流，C.3） |
| 23 | managed mitmdump 子行程 | 常駐 | Python＋asyncio；有 mitmdump 時每次開專案自動啟動（報告 04 F3） | 停 | 跑 | 跑 | 子行程常駐 |
| 24 | tailer（`tailer-host.ts:1501-1520`，chokidar 3.6＋fsevents） | 事件驅動 | 啟動時 `ignoreInitial:false` 走訪 depth 6 的整個 transcript 根並為每個 `.jsonl` 註冊；之後 fsevents | 停 | 跑 | 跑 | 啟動成本與檔案數成正比 |
| 25 | pcap 外掛心跳（`pcap-capture.js:80,172`） | 15 s | 寫一列 `system:producer_heartbeat`，**chained**（`event-write.ts:84-91` 註明特例已死） | 外掛開才有 | — | — | 每時 240 列上鏈（已裁定「heartbeat 不是事件」） |
| 26 | c2 tailer（`c2-tail.js:100`） | 1 s | drain | 外掛開才有 | — | — | — |
| 27 | shell hook 每個指令 | 每指令 | relayed 類：`mktemp`、背景 `python3 relay pty`、結束時 `python3 relay finish`、`rm -rf`、2 次 `curl`（`shell-zsh-hook.zsh:393,483-488,520-528`；`shell-common.sh:675`）；`classify` 有快取（`:122-138`） | — | — | — | 操作者動作的成本，不是閒置成本 |
| 28 | 終端錄製 flush（`terminal-recording.ts:148`）、tailer 合併（`tailer-host.ts:399`）、idle flush 15 s（`:1147-1150`） | 事件驅動 | 合併寫入 | — | — | — | 不可節流 |

### C.2 依估計成本排序（閒置時，專案開著、錄製中、HUD 依預設）

1. **#1 HUD 滑鼠追蹤 50 ms**：唯一以 20 Hz 喚醒 main 的東西，且在 HUD 隱藏、無專案時照跑。
2. **#2 連結偵測 20 s 起 4–8 個行程**：行程建立是 macOS 上最貴的週期動作之一，關專案也不停。
3. **#3 addon `lsof` 每 0.5 s**（有 HTTP 流量時）：`lsof` 在 macOS 上要走訪所有行程的 fd 表；瀏覽器經 proxy 的背景連線使它很少停。
4. **#6 活動計數每批 O(n)**（擷取進行中）：表越大越貴，視窗隱藏時照跑。
5. **#9 HUD 持續動畫＋每秒重繪**：透明置頂視窗的合成成本（UNCONFIRMED，最需要實測的一項）。
6. **#8 托盤閃爍 750 ms**：錄製期間全程。
7. **#4／#5 主機監控 pack**（開啟時）：每秒 3.5 個行程，且 #5 與 #3 讀同一張 socket 表。
8. **#13 opsec 30 s 起 2 個行程**。
9. **#7 擷取健康 30 s＋AI 活動探測 fs 走訪**。
10. **#19 CDP 3 s 輪詢**（瀏覽器關後仍跑）與 **#10 狀態列每秒重繪＋持續動畫**（視窗可見時）。

### C.3 不可節流（節流＝製造紀錄缺口）

- spool 回放（#17）的存在是為了把 API 不可達時 hook 留下的事件收回；可以改事件驅動（見下），但不得在電池或隱藏時停。
- addon in-flight 心跳（#22）：它降低在途上限、移除標記，讓「proxy 被殺」能變成 `capture_gap`（`mitmproxy-addon.py:340-349`）。
- 終端錄製 flush、tailer 合併與 idle flush（#28）、行程監控的每次 `ps`（#4，行程短於輪詢間隔就看不到——這是它的已知限制，拉長間隔會擴大漏看）。
- addon 的 socket 表（#3）：拉長間隔會讓更多短連線失去歸屬（`mitmproxy-addon.py:883-889` 自己寫明）；應以 U4 合併降低成本，不是拉長間隔。
- IP 查詢在暫停時仍要跑（HUD 的安全判斷不因錄製暫停而失效）；可在電池時拉長（見下），但不可停。

### C.4 處置

**刪除（已裁定，一併拿掉計時器）**：#20 剪貼簿、週期截圖與指令截圖；#21 啟動更新檢查；#25 心跳改為不寫列（§4「heartbeat 不是事件」：改由 API 收到即更新記憶體中的存活時間，075 讀它）。

**改事件驅動**
- #1 HUD 追蹤：只在 HUD 可見且非穿透時才開；更好的是用 overlay 視窗的 `mouseenter`/`mouseleave`（`setIgnoreMouseEvents(true, { forward: true })` 已在穿透模式使用，正常模式可用同一機制轉送滑鼠移動），完全不用輪詢。最低限度：`overlayWindow.on('hide')` 停、`on('show')` 開，`stopProject` 停。
- #2 連結偵測：macOS 以 `scutil` 的網路變更通知或 Node 無原生事件時改為「IP 查詢結果變化時才重讀」；Windows 有 `NetworkChange`。最低限度：放進 `stopProject`，並與 #13 合併成一次讀取（兩者都在問「網路變了沒」）。
- #17 spool：hook 寫入 spool 時 API 不可達，所以 app 側只能輪詢；但可改為 `fs.watch` pending 目錄，30 s 輪詢降為 5 分鐘的保底。
- #19 CDP：瀏覽器的 `exit` 事件（main 已知道，`DashboardView.tsx:85-90` 的註解）停止輪詢。
- #6 活動計數：logged 數與鏈長改為寫入端維護的計數器（與 chained 數已有的 `_getCachedEventCount` 同法），戰利品數改為寫入時累加——三個 O(n) 掃描變成 O(1)。這屬於 074 的計數契約。

**依狀態節流（一個排程器）**
新增 `core/scheduler.ts`：所有週期工作向它註冊 `{ id, everyMs, when: { project?: true, recording?: true, visible?: boolean, battery?: 'run'|'slow'|'skip' }, mustRun?: true }`。排程器訂閱 `powerMonitor` 的 `on-battery`／`on-ac`／`suspend`／`resume`、主視窗與 HUD 的 `show`/`hide`/`minimize`/`restore`、專案開關與錄製狀態，並把同一秒內到期的工作合併到一個 tick。
- 無專案：只留更新（手動）以外的零項。
- 視窗隱藏：renderer 的計數與健康讀取停止（`document.visibilityState === 'hidden'` 時 `useAppCounts` 不發新輪，回到可見時讀一次——`useRevalidateOnFocus` 已有這個鉤子，`hooks/useRevalidateOnFocus.ts:20-46`）。
- 電池：#13 opsec 30 s → 2 分、#12 IP 60 s → 2 分（`mustRun`，只拉長）、#16 抽樣 5 分 → 30 分、#15 錨定照舊（每時一次，本來就少）、托盤改為不閃的錄製圖示。
- `resume`：立即跑一次 IP、opsec、連結、NTP（休眠後最可能變的就是網路與時鐘），並寫一筆 `system:resumed`（休眠期間「沒有事件」不等於「什麼都沒發生」——這與 072 的 `project_closed` 是同一類事實）。
- 托盤閃爍與 HUD `blinkRec`：改成靜態紅點。閃爍傳達的只有「正在錄」，靜態圖示一樣傳達；HUD 的 `pulse`／`alarm` 只在暴露時出現，保留（那是警報）。狀態列的 `animate-pulse-slow` 在「記錄中」時改靜態，只在需要注意時動。

**合併到一個 tick**：#2、#12、#13 都在問「網路狀態」，合成一個網路觀察者，每 60 s 一次（電池 2 分），任一項變化才廣播。

### C.5 守住它的 gate

沿用 `test/raw-button-ratchet.test.ts` 的「只降不升」：
- `test/timer-ratchet.test.ts`：掃描 `src/main/**`、`src/core/**`、`plugins/**` 中 `setInterval(` 的呼叫點數（今天 `src/main`、`src/core`、`plugins` 中含 `setInterval(` 的行 26 行——含 `projectRuntime.setInterval` 4 處與其定義 2 行——renderer 11 行；grep 計，基準以 gate 第一次執行讀出的數為準），基準寫在測試中；新增須在同一 PR 下修基準並說明，且只允許出現在 `core/scheduler.ts`。renderer 另一個基準，允許清單是「掛載時才跑、卸載即清」的元件。
- 「計時器必須在 `stopProject` 停止」：在 e2e 之外可測——`startProject` → `stopProject` 後，斷言排程器沒有任何 `project: true` 的工作仍在。
- 子行程：`exec(` 與 `execFile(` 的呼叫點也進同一個 ratchet，因為行程建立是最貴的週期工作。

### C.6 真正的量測（UNCONFIRMED，留給安靜的機器）

- 工具：`sudo powermetrics --samplers tasks,cpu_power,gpu_power -i 5000 -n 24`（每行程的喚醒數 `wakeups/s` 與能耗）；活動監視器「能源」頁的「能源影響」與「App Nap」欄；`sample <pid> 10` 看 main 執行緒閒置時在做什麼；`fs_usage -w -f proc <pid>` 看 fork/exec；`log stream --predicate 'process == "lsof"'` 或 `sudo dtrace -n 'proc:::exec-success { @[execname] = count(); }'` 數子行程。
- 情境（各 10 分鐘，打包版，關閉 DevTools）：(1) 無專案、HUD 隱藏；(2) 專案開著、錄製中、閒置、HUD 顯示；(3) 同 (2) 但主視窗最小化；(4) 經受管 proxy 開一個瀏覽器分頁閒置；(5) 開 host monitors pack；(6) 拔電源重做 (2)。
- 每項記錄：Electron main 與 renderer、GPU process、mitmdump 的 wakeups/s 與 CPU ms/s，子行程數／分。預期 (1) 的 main wakeups 由 #1 主導（約 20／秒）；若不是，C.2 的排序要改。

---

## D. 交付摘要

### D.1 整合表（依回報 ÷ 損失）

見 A.0。可先上、之後不必重做的：U1 的單一寫入函式（API 標記的遮罩分歧一併修好）、U3 的分類字面值修正、U5 的 API 匯出改走計畫器、U11 刪自動更新與 `autoCheck`、書籤轉換（裁定 3）。其餘依 075 → 072／074 → 073 的順序。

### D.2 儀表板建議（五行）

1. 儀表板的唯一用途是開始前的整體檢查；進行中由狀態列與 HUD 回答，結束後由證據頁回答。
2. 它變成活動紀錄頂端的一行狀態，只渲染 075 的 payload：整體字、來源、出口、範圍、完整性。
3. 專案還沒有事件、或整體不是「記錄中」時自動展開成檢查清單；正常時收成一行，可手動展開。
4. 狀態列點擊即展開這一行；修復只在設定 ▸ 擷取來源；HUD 全保留；不新增頁面。
5. 若實機顯示操作者開始前不看活動紀錄，改把清單放到終端機頁的空狀態；不回到獨立頁面。

### D.3 背景成本前十與處置

| # | 項目 | 處置 |
|---|---|---|
| 1 | HUD 滑鼠追蹤 50 ms，隱藏與無專案照跑 | 改用滑鼠進出事件；最低限度隨 HUD 顯示／隱藏與 `stopProject` 開關 |
| 2 | 連結偵測 20 s 起 4–8 個行程，關專案不停 | 與 opsec、IP 合成一個網路觀察者；放進 `stopProject` |
| 3 | addon `lsof` 每 0.5 s | 與連線監控合成一個 socket 表（U4）；不拉長間隔 |
| 4 | 活動計數每批 O(n) 掃描 | 寫入端計數器（074）；隱藏時不讀 |
| 5 | HUD 持續動畫＋每秒重繪 | REC 改靜態；時鐘只在顯示「最後看到」時跑；實測確認 |
| 6 | 托盤 750 ms 閃爍 | 靜態錄製圖示 |
| 7 | 主機監控 pack 每秒 3.5 個行程 | 共用 socket 表；電池時提示而非靜默拉長（行程監控拉長＝漏看） |
| 8 | opsec 30 s `scutil` | 併入網路觀察者；電池 2 分 |
| 9 | 擷取健康 30 s＋AI 目錄走訪 | 由 075 的狀態變化推送取代輪詢；隱藏時不讀 |
| 10 | CDP 3 s 輪詢不隨瀏覽器結束 | 以瀏覽器 `exit` 停止 |

### D.4 擁有者問題（≤8）

1. **儀表板改成活動紀錄頂端的狀態行（空專案或有異常時展開成檢查清單）？** 建議：是。失去：一個導覽目的地與獨立的總覽頁；首屏多一行。
2. **事件備註改為上鏈的註記（帶 `_causes`，修改＝修訂）？** 建議：是。失去：備註可刪且不留痕；事後寫下的判斷變成簽章過的紀錄。
3. **活動紀錄的篩選列固定為「全部｜指令｜HTTP｜AI｜檔案｜標記」，由 072 的家族產生、只能經規格新增？** 建議：是。失去：依工具或來源的頂層篩選（改在選單）；戰利品不再有自己的分頁。
4. **HTTP 篩選標為「HTTP」而 DNS／TCP／pcap 只在「全部」與 HTTP 列的成員中出現？** 建議：是（照擁有者的命名）。失去：DNS 與連線沒有自己的頂層篩選。
5. **標記的所有寫入（對話框、HUD、API、修訂）改走一個核心函式，API 標記開始做遮罩偵測、可帶 `_causes` 與 `atTimestamp`？** 建議：是，可在 072 之前先做。失去：無（API 回應形狀加欄位，不刪欄位）。
6. **API 的 HAR／bundle 匯出改走與 app 相同的匯出計畫器？** 建議：是。失去：API 匯出的輸出可能比今天少（會套用個人清單與排除），呼叫端看得到「排除 N 筆」。
7. **錄製中的托盤與 HUD 改為不閃的靜態紅點？** 建議：是。失去：閃爍帶來的醒目感；暴露與警報的閃動保留。
8. **新增一個 main 端排程器，依電池、休眠、視窗可見與有無專案調整節奏，並以計時器 ratchet 擋住新計時器？** 建議：是。失去：電池時 IP 與 opsec 狀態最多晚 2 分鐘更新；`resume` 時立即補一次。

---

## 檢查過、沒有問題的

- 匯出已是一個計畫器加能力表，「匯出我正在看的」（`selection` 子集帶篩選與查詢）已存在（`export-plan.ts:28`、`export-selection.ts:40-58`）。
- 顯示時區已合一並轉移舊鍵（`lib/time.ts:36-56`）。
- 鏈抽樣用 rowid 隨機而非 `ORDER BY RANDOM()`（`chain-anchor.ts:797-816`），每 5 分鐘的成本小。
- 錨定在鏈頭沒變時不送（`chain-anchor.ts:268-270`）；air-gap 關掉錨定、NTP、IP、更新（`index.ts:1058-1064`）。
- AI 活動探測有硬上限（深度 4、400 次呼叫、1 秒、每根目錄每分最多一次，`agent-activity-probe.ts:24-26,107-121`）。
- `useAppCounts` 已把多個消費者合成一個 store 與一個 pacer（`useAppCounts.ts:18-24`）；問題在每輪讀什麼，不在輪數。
- 行程、連線、CDP、剪貼簿、截圖在暫停時都不寫（`process-monitor.ts:233`、`connection-monitor.ts:140`、`cdp-connector.ts:156`、`clipboard-monitor.ts:51`、`screenshot-agent.ts:209`）。
- 時間軸的秒鐘只重繪兩個小元件（`TimelineClock.tsx:1-6` 的註解與實作相符）。
- 隱藏的保留頁至多一個（`App.tsx:329-337`）。

## 刻意的設計（附依據）

- addon socket 表選擇「背景快照、查詢是 dict 讀取」而非每次查詢 spawn（`mitmproxy-addon.py:883-889`），以免拖慢 proxy；本報告只建議合併，不改此取捨。
- HUD 正常模式不整窗穿透，以免第一次滑鼠移動收不到（`ipc/overlay.ts:88-93`）；這是 #1 用輪詢的原因，改事件驅動時要保住這個不變式。
- logged 層清掃週期執行，因為一天內可長到 20–40 GB（`index.ts:892-895`）。
- 行程監控 Windows 下限 2 s（`process-monitor.ts:194-201`）。
- 標記的 `url` 不可修訂（`marker-amend.ts:27-30`）——這正是書籤轉換的已知損失。

## UNCONFIRMED（與最便宜的確認方式）

1. C.1／C.2 的所有耗電量級 → C.6 的情境量測。
2. HUD 的 `step-end` 動畫是否讓合成器每個 vsync 出幀 → `powermetrics` 看 GPU process 在 HUD 顯示 vs 隱藏時的差。
3. 活動搜尋是否涵蓋 `loot.matches[].preview` → 讀 `executeEventQuery` 的全文欄位，或在有戰利品的專案搜一段預覽文字。
4. 修 `activity-projection.ts:62` 是否會讓既有測試失敗 → `rg "'evidence'" test/` 並跑相關檔。
5. 評估中的 chokidar 6 在 macOS 不再用 fsevents，改為每目錄一個 `fs.watch`；tailer 以 depth 6 監看 transcript 根時，watcher 數與目錄數成正比 → 升級前在有大量 Claude Code session 的家目錄數 `lsof -p <pid> | wc -l`。
6. 專案選擇器、最近清單與封存（073）是否為同一份清單：本報告未讀 `ProjectPicker` 的資料來源，沒有下結論。
7. `/api/marker` 的呼叫者是否依賴 `category: 'external'` → 問擁有者，或在一個版本中保留該預設。
