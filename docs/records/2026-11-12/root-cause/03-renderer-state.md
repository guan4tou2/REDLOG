# 03 — Renderer 狀態與資料流：根因審查

基準：`main@a087c16c`（乾淨）。另讀了 open PR #701（`origin/refactor/live-paged-query`）的 diff。唯讀審查，沒有改 repo。程序上有一點要註明：為了讀 #701，我跑過一次 `git fetch origin refactor/live-paged-query`，這會更新 remote-tracking ref，但不碰 working tree 和 index。這次沒有跑 vitest，以下判斷全部來自讀程式碼和 git 歷史。

## 摘要（10 行）

1. `ReadState<T>` 只記 phase 和 value，沒記「這是哪個問題的答案」，也沒有共用的非資料狀態呈現。所以每個畫面都自己重解一次：有 50 處 `.catch(() => {})` 類的吞錯，約 30 組 `*.loadFailed` 文案，3 種身分補丁。失敗被畫成 0／空、別的事件的內容掛在目前事件下，都是這個機制的產物。
2. 即時更新沒有失效（invalidation）模型。main 只推原始 `events:new-batch`，23 個訂閱點各自寫述詞、各自決定節流。結果是：會飢餓的 debounce 在 main 上還剩 5 處；有逐批次不節流的 IPC；config 失效有兩條互不覆蓋的訊號；housekeeping 在 renderer 重寫了一份。
3. 「事件數」「N of M」沒有詞彙表。同樣叫「事件」的數字算的東西不同（tier、housekeeping、個人流量、分享篩選、上限）；「Loaded N of M」有兩種互不相干的意思；截圖頁會出現「顯示 6 / 5」；Dashboard 會因為兩個計數不是在同一個快照讀出來，誤報 chain drift。
4. 分享篩選（`FilterContext`）是全域、隱性的狀態，套不套用由各頁自己決定。跳轉不帶篩選語境，所以從 Scope／Targets 跳到 Timeline 的事件會被篩選藏起來，畫面只給一個 ×。
5. 「操作員在哪、怎麼來的」分散在 `App.tsx` 的 10 個 state、兩套「隱藏但仍掛載」、兩套捲動保留、手動穿線的 `active` prop、單一槽位的 export scope 和 localStorage。鍵盤層至少有 3 份「正在打字」判斷，彼此不一致。
6. `Timeline.tsx` 有 2,910 行，其中一個元件就佔 2,750 行（38 個 `useState`、35 個 effect）。它的大小確實是缺陷來源：同檔 TDZ 錯被 e2e 抓到兩次，`FilterContext` 每批次都在變動的副作用要靠一層 memo 包裝擋住。
7. 根治順序：先 (a)，用帶身分的 `Query<T>`、唯一的 `<ReadStatus>` 渲染器，加一個掃描 ad-hoc 讀取的 ratchet 測試。再做窄版 (b)：main 發型別化的 topic 失效，只用在 config、計數、彙總；需要「列」的畫面照舊吃 batch。
8. (b) 不必等 (a)。可以先只做 `config` topic，它能一次消掉兩條訊號互不覆蓋的問題。
9. 不建議引入新的狀態函式庫。`useReadState`、`createThrottledRead`、`useLivePagedQuery`（#701）、`useSyncExternalStore` store 足以承載這個模型，缺的是身分、可見性和強制執行。
10. #701、「3 步返回軌跡」（進行中）和 `useAppCounts` 的節流，都是對的局部修正。但它們各自在處理上面第 1、2、5 點的單一症狀，沒有建立會讓下一個畫面自動正確的不變量。

---

## 盤點（任務 1 的濃縮版）

閱讀方式分 5 種：
- R = `useReadState`
- T = `createThrottledRead`
- L = `useLivePagedQuery`（#701）
- A = ad-hoc `useEffect` + `.then`
- S = 模組 store（`useSyncExternalStore`）

「不能表示」只列實際會發生的狀態。

| 畫面 | 讀取方式 | 即時 | 不能表示／錯置 | 隱藏時 |
|---|---|---|---|---|
| `StatusBar` 事件數 | S `useAppCounts` | 1s 節流 | 失敗：`getCount`／`chain.length`／`loot.getCount` 都吞錯，畫成 0（`lib/useAppCounts.ts:99-102`），只有 scope 有失敗旗標 | 常駐 |
| `DashboardView` | S + A `config.get` + T | 1s | 同上；drift 誤報（見 F3） | — |
| `Sidebar` loot 徽章 | S | 1s | 失敗會畫成 0 | 常駐 |
| `App` exportableCount | A `getCount('all')` `.catch(()=>{})`（`App.tsx:261`） | 無，只在換 view 時讀 | 失敗或新專案時是 0，會顯示「No events to export yet」（`ExportMenu.tsx:505`） | 常駐 |
| `CommandPalette` 專案／主機／operator 清單 | A，吞錯（`:167-174`） | 無 | 失敗和空清單一樣 | modal |
| `Timeline` | A×8 種自訂 union（`TotalState`、`boxState`、`earlier`、`loadBack`、`loadError`、`liveError`、`outsideFilter`、attribution） | 自有 pacer + `matchIds` | 大致完整；attribution、`verify` 吞錯 | 不保留，會 remount |
| `TimelineEventDetails.LateOutput` | R `[commandId]` | **每批次**都 `retry`（`:36`），不節流、不看是否相關 | 換指令時沿用上一個指令的輸出（身分） | — |
| `EventContentReader`（`CommandEndDetail` 內） | R `[projectId,eventId]` | 無 | 沒有 key（`TimelineEventDetails.tsx:116`），換事件時顯示上一事件的欄位，`selected` 也沿用 | — |
| `ScopeStatus` | R×5 | scope 子類型：100ms 會飢餓的 debounce；其他每一批：一次 `chain.length()`（`:172`），不節流 | 刷新失敗會把整頁換成錯誤（`:179`） | kept origin，仍訂閱 |
| `TargetsScopeHeader` | R | 1.5s 會飢餓的 debounce（`:41-44`） | — | 常駐於兩頁 |
| `EvidenceHeader` | R | 1s 會飢餓的 debounce（`:31-35`） | — | — |
| `TargetView` | T（2s）+ A + `matchIds` | 是 | 換篩選時的舊回覆有 ref 防護 | kept origin，仍訂閱 |
| `LootPanel` | A（seq 防護） | 每個 loot 批次都整頁重讀，並丟棄已載入的較舊頁（#701 會修） | 首次載入狀態不完整（WORK-PLAN 2026-11-12） | kept origin，仍訂閱 |
| `ScreenshotsView` | A → L（#701） | 自己插入列 | 計數錯（見 F3） | kept origin |
| `HttpHistoryPanel` | A + R → L（#701） | main 上還是 300ms 會飢餓的 debounce（`:282-285`） | — | 不可保留（`keptOrigin.ts` 註解） |
| `ActivityResults` | R，用 key remount 換身分 | 只有「N 筆新事件」提示 | 提示計入所有列（含 housekeeping、不符查詢的） | `active` prop |
| `SourceSessionPicker` | R，回傳值裡回聲 request 換身分 | 任一批次就亮刷新鈕 | — | — |
| `FirstRunView` | A（generation） | 300ms 會飢餓的 debounce | — | — |
| `useVisibility` | A | 500ms debounce（只在未完成時） | 失敗時當成全揭露（刻意） | 常駐 |
| `TimelineDetailBar.useScopePolicy` | A | 只聽 `config_changed`／`scope_recomputed` 列 | 失敗顯示 `httpScope.unknown`（正確） | — |
| `FilterContext` | A（gen + live ref） | 合併 batch | 清單有 `ListsStatus`；`refreshScope` 沒有 gen 防護 | 常駐 |
| `OverlayApp` | A，各自 `.then` | IP 和 recording 用 push channel | `ip.getStatus()` 沒有 catch（`:110`），但會退到 `'unknown'`，可接受 | 另一視窗 |
| settings／\* | 多為 R | 無 | 本次未逐頁驗證 | — |

統計（main）：
- `onNewBatch` 訂閱點 23 個，分布在 22 個檔案。
- `.catch(() => {}|null|[]|undefined)` 共 50 處，其中讀取約佔 35 處；寫入已由 `test/mutation-guard.test.ts` 管住。
- `role="alert"` 共 79 處，分布在 39 個檔案。
- en.json 裡帶 `loadFailed`／`readFailed`／`failed` 的鍵約 127 個；其中專門描述「讀取失敗」的約 30 個，文法不一：有的會補一句「這不代表沒有資料」，有的不會。
- 「近期子集」有 3 組不同的鍵：`loot.recentSubset`、`transcript.recentSubset`、`httpHistory.recentSubset`。
- 「N of M」模板至少 12 個。

---

## 發現（依「解釋多少操作員可見的錯誤」×「能預防多少未來缺陷」排序）

### F1. 讀取狀態沒有「問題身分」，也沒有唯一的非資料狀態渲染器，所以每個畫面各自重新發明 loading／empty／failed／stale，而且會發明錯

**機制。** `lib/readState.ts` 的 `ReadState<T>` 是 `{phase, value, error}`，`useReadState(load, enabled, deps)` 在 deps 改變時會用 `readStarted(prev)` 保留舊值。這個設計對「同一個問題的刷新」是對的（陳舊但有標示，勝過空白不說話）。但對「換了一個問題」是錯的：上一題的 value 會被當成這一題的 stale 值。在 effect 跑之前那一幀，phase 甚至還停在 `loaded`。

此外沒有任何共用元件負責把 `loading`、`failed-first`、`failed-refresh`、`empty`、`partial`、`no-project` 畫成固定的樣子。所以每個畫面都自己決定：
- 要不要吞錯；
- 失敗時是否保留舊值；
- 文案怎麼寫；
- 失敗是整頁替換，還是只出一條橫幅。

ARCHITECTURE.md:126 寫著「專案切換與過時回覆不得沿用舊資料身分」，但這是規範，沒有原語去強制它。

**實例。**
- **身分錯置（3 個消費者、3 種不同補丁，說明原語缺了東西）。**
  - `ActivityResults.tsx:44` 用 `key={…JSON.stringify(request)}` 強制 remount。
  - `ScopeStatus.tsx:276-289` 每處都要比對 `detail.state.value?.id === v.id`。
  - `SourceSessionPicker.tsx:89` 讓 loader 回傳 `{request, page}`，再比對 `request.query === applied`。
  - 第四個消費者沒有補：`TimelineEventDetails.tsx:116` 的 `EventContentReader` 沒有 key，`LateOutput` 只有 `[commandId]` deps。操作員在 Inspector 裡從 command A 走到 B 時（`reader` 模式由父層保存，所以閱讀器保持開啟），B 的欄位清單或延遲輸出回來之前，畫面顯示的是 A 的已保存內容，`selected` 欄位也沿用 A 的。在證據工具裡，這等於把別的事件的內容放在這個事件的標題下。
  - 相對地，同一個 Inspector 的另一處 `TimelineEventInspector.tsx:447` 有 `key={event.id}`：有人知道要加，但沒有東西逼人加。
- **失敗被畫成 0 或空。**
  - `useAppCounts.ts:99-102`：4 個計數吞錯，`INITIAL` 是 0，`loading` 照樣轉成 false。Dashboard 會顯示「0 事件」，狀態列顯示「0 events」。
  - `App.tsx:261`：`exportableCount` 讀失敗時，匯出選單說「No events to export yet」。
  - `CommandPalette.tsx:167-174`：專案、operator、主機清單失敗時看起來就是空清單。
- **刷新失敗把整頁換掉。** `ScopeStatus.tsx:179` 只要 `phase==='failed'` 就回傳錯誤區塊，不管 `value` 是否存在。這頁會在每個 scope 批次時 `retry()`，所以一次暫時性失敗就會把已讀到的觀察清單整頁換成錯誤（這是證據清單中的一項，main 上仍然是這樣）。
- **過去的修正都是逐頁做的。** 例如：
  - `be1d086c`「report failures, never show a failed read as safe」
  - `5596d8ba`「show read failures instead of empty results in search and project picker」
  - `0fffa335`（filter 清單）
  - `762853d0`（onboarding）
  - `890c8700`（timeline host）
  - `35065b5d`（pivot）
  - `c5bd4a03`、`f10c6645`（capture health）
  - `9aa28ed3`（11-11 audit 的 read-failure states）

  它們各自修一頁，下一頁照樣是新寫法。WORK-PLAN 11-12 還列著「戰利品頁無載入中狀態」。

**為何至今只治標。** `useReadState` 是 #298 為了「失敗不是空」做的，只解決了 phase；身分和呈現留給呼叫端。#701 的 `useLivePagedQuery` 用 `Snapshot.id` 解了身分（它的註解明說「The render that changes the key comes before the effect…」），但只套在 4 個分頁清單上，也沒有接管呈現。

**結構性改法。**
1. 把 `ReadState` 升級成帶身分的型別。
   - `type Query<T> = { key: string; phase: 'idle'|'loading'|'loaded'|'failed'; value: T|null; valueKey: string|null; error?: string; completeness?: Completeness }`。
   - 不變量：只有 `valueKey === key` 時，才能把 `value` 當成這個問題的答案渲染。`valueKey !== key` 時，若沒有開 `keepPrevious`，就一律視為 `loading`；開了的話，必須以「先前條件的結果」標示。
   - `useReadState` 改成 `useQuery(key, load, opts)`，實作直接搬 #701 的 snapshot-id 技巧。#701 的 `useLivePagedQuery` 底層改用同一個型別。
2. 新增唯一的非資料狀態渲染器 `<ReadStatus query subject conditions onRetry>`。它只負責以下 6 種狀態，每種文字固定：
   - first-load
   - failed-first：「無法讀取 {subject}。這不代表沒有資料。」＋重試
   - failed-refresh：以小橫幅疊在舊資料上，加上讀取時間
   - no-project
   - empty：名稱化的條件，用既有的 `describeActiveConditions`
   - partial：見 F3

   這樣每頁約 30 個 `*.loadFailed` 鍵可以收斂成 `read.failed`、`read.failedStale` 加上主詞名詞。符合「最小 UI 文案」。
3. 刪除：
   - 各頁的 `loadError`／`loading`／`setLoading` 樣板（`LootPanel`、`ScreenshotsView`、`TargetView`、`BookmarksView`、`TranscriptView`、`HttpHistoryPanel` 的手寫部分，#701 已刪一部分）
   - `ActivityResults` 的 key-remount 補丁
   - `ScopeStatus` 的 id 比對
   - `SourceSessionPicker` 的 request 回聲
   - `useAppCounts` 的吞錯：每個計數改成 `Query<number>`
4. 強制執行：新增 `test/read-guard.test.ts`，仿 `mutation-guard`／`raw-button-ratchet` 的 ratchet。
   - 計算 `components/**` 裡不在 `useQuery`／`useLivePagedQuery`／`createThrottledRead` thunk 內的 `window.redlog.<area>.<read>(` 呼叫，以及讀取上的 `.catch(() => {}|null|[]|undefined)`。只降不升。
   - 再加一個掃描：`role="alert"` 加上 `loadFailed` 的鍵只能出現在 `ReadStatus.tsx`。
   - 「元件內宣告元件」用同一支掃描抓（見 F6）。

**遷移步驟（每一步 app 都能用）。**
1. 加入 `Query<T>`、`useQuery`；`useReadState` 改成它的薄包裝（key = `JSON.stringify(deps)`），行為除身分外不變。消費者的補丁暫時保留。
2. 加入 `<ReadStatus>`，先在 `LateOutput` 和 `EventContentReader`（身分錯置）以及 `ScopeStatus`（整頁替換）上使用。
3. `useAppCounts` 改成逐項 `Query`，Dashboard、狀態列、Sidebar 改用 `ReadStatus` 的行內變體（「—」加 tooltip，不是 0）。
4. 開 ratchet，記錄基準數字。
5. 逐頁遷移，每次降基準；最後刪掉三種補丁和多餘的 i18n 鍵。這一步依賴 `verify:i18n`，因為測試裡斷言的舊字串要一起改。

**影響範圍。** 只在 renderer：約 25 個元件、`lib/readState.ts`、i18n 兩語系、測試裡斷言文案的地方。磁碟資料、main、跨平台都不受影響。

**可能出錯的地方。**
- 統一文案時，可能誤刪某頁刻意的「為什麼」，例如 `firstRun.readFailedWhy`。對策：`ReadStatus` 收一個可選的 `why`。
- `keepPrevious` 的預設值選錯，會讓換篩選時閃空。對策：清單類預設保留並標示，詳情類預設不保留。

**驗證。**
- `useQuery` 的單元測試：key 切換、舊回覆、失敗刷新。
- `EventContentReader` 和 `LateOutput` 換事件的元件測試：B 載入前不出現 A 的文字。
- 用 ratchet 測試。
- 在實機上讓 IPC 注入失敗（測試 preload），逐頁看。

---

### F2. 即時更新沒有失效模型：每個畫面自己訂閱原始 batch、自己寫述詞、自己節流，config 失效有兩條互不覆蓋的訊號

**機制。**
- main 只在 `src/main/index.ts:1707-1715` 每個 event-loop turn 推一次完整的 `RedLogEvent[]`。renderer 有 23 個訂閱點，各自決定三件事：
  - 這批跟我有沒有關係：在 renderer 重寫 core 的述詞；
  - 多快重讀：每頁一套；
  - 隱藏時要不要繼續。
- 不是新列造成的變更另有三條管道：
  - window CustomEvent：`redlog:config-saved`、`BOOKMARKS_CHANGED`、`RECOUNT_EVENT`、`EVENT_NOTE_SAVED`；
  - 寫進紀錄的 system 列：`config_changed`、`scope_recomputed`、`screenshot_deleted`；
  - 少數型別化 push：`recording:changed`、`pivots:changed`、`hudPrefs:changed`、`targetContext:changed`。

  沒有任何一處規定「某份資料變了，要發什麼訊號」。

**實例。**
- **config 失效兩條訊號，誰聽哪條沒有規則。**
  - window 事件 `redlog:config-saved` 只在 renderer 自己存檔時發，來源只有 `Settings.tsx:185` 和 `TargetView.tsx:210`。
  - `config_changed` 列只在 main 判定為「安全相關」的 diff 時寫入（`index.ts:641-659`），或在 hook 安裝時寫入（`:1967`）。
  - `FilterContext.refreshScope`、`useAppCounts.configured`、`TargetsScopeHeader` 只聽第一條。
  - `HttpHistoryPanel:131`、`TimelineDetailBar:36` 只聽第二條。
  - `TargetView` 兩條都聽。

  所以不經 renderer 存檔的 scope 變更（plugin 的 config 路徑 `ipc/plugins.ts:57`，或任何非 Settings 的寫入路徑），會讓 FilterBar 的 in-scope 清單和狀態列的「scope 已設定」停在舊值。反過來，不被判為安全相關的存檔，不會讓 HTTP 的 scope 標記重讀。這就是證據裡「scope configured 有三種定義」的真正殘餘。定義本身已經收斂到 core 的 `ScopePolicy.isConfigured`（`lib/scope.ts:11`），但「何時重讀」仍有三種。
- **會飢餓的 debounce（`clearTimeout` + `setTimeout`，持續流量下永不觸發）在 main 上還剩 5 處。**
  - `ScopeStatus.tsx:165`（100ms）
  - `EvidenceHeader.tsx:34`（1s）
  - `TargetsScopeHeader.tsx:43`（1.5s）
  - `FirstRunView.tsx:150`（300ms）
  - `HttpHistoryPanel.tsx:282`（300ms，#701 修）

  `TargetsScopeHeader` 的目標數，在掃描（每批都帶 `targetId`）期間不會更新。
- **逐批次、不節流、不看相關性的 IPC。**
  - `ScopeStatus.tsx:172`：每一批不涉 scope 的事件都打一次 `chain.length()`。
  - `TimelineEventDetails.tsx:36`：選中 command_end 時，每一批都重讀 `commandOutput`。
  - `LootPanel` 每個 loot 批次都整頁重讀。

  而且 `ScopeStatus`、`LootPanel`、`TargetView`、`ScreenshotsView` 被 kept origin 隱藏時仍在跑（`App.tsx:320` 註解自承「A hidden page still takes live batches」）。
- **renderer 重寫 core 述詞。** `lib/knownLists.ts:19-33` 的 `isHousekeeping` 是 `HOUSEKEEPING_SQL` 的手抄本，註解自己也說「read off the event instead of the row」。core 一改，FilterBar 的目標選單就會和 `aggregateTargets` 不一致，沒有測試把兩者綁在一起。scope 子類型集合則各自寫在 `ScopeStatus:14`、`TargetView:117`、`HttpHistoryPanel:132`、`TimelineDetailBar:36` 四處。
- **節流原語收斂了，但還是各自掛。** `throttledRead`（3 個 + #701）、`timelinePacer`、`liveTotal`、`useRevalidateOnFocus`、裸 `setTimeout`。#701 的 `useLivePagedQuery` 仍然每個實例各自訂閱 `onNewBatch`，述詞由呼叫端提供。

**為何只治標。** 每次修正都是「把這一頁的 debounce 換成 `createThrottledRead`」，例如 `805c5d8d` 和 #701。共用的是節流機制，不是「什麼變了、誰該重讀」這個問題。

**結構性改法（窄版 (b)）。**
1. main 在 `flushBatch` 同一處額外送一則 `data:changed { projectId, seq, topics }`。
   - topics 是封閉集合：`events`、`loot`、`screenshots`、`http`、`targets`、`scope.rules`、`scope.observations`、`chain`、`bookmarks`、`notes`、`config`、`capture`。
   - 分類函式放在 core，例如 `src/core/db/change-topics.ts`。它和 `HOUSEKEEPING_SQL`、scope 子類型、`aggregateTargets` 的條件放在一起，並用單元測試對同一組列斷言兩者一致。
   - 每條寫入路徑在寫完後發 topic：`saveProjectConfig` 的唯一出口、bookmarks CRUD、notes、screenshot 刪除。renderer 端的 `redlog:config-saved`、`BOOKMARKS_CHANGED`、`EVENT_NOTE_SAVED`、`RECOUNT_EVENT` 全部刪掉。這和「正在寫的一條 config 套用路徑」是同一個出口，應該一起做。
2. renderer 建一個極薄的 query registry，靠 `useSyncExternalStore` 實作：
   - 以 `(channel, JSON(args))` 為 key，每個 key 宣告 `topics` 和 `minIntervalMs`；
   - 收到 topic 就把對應 key 標髒，畫面可見時才用 `createThrottledRead` 重讀；
   - 同一個 key 在多處掛載時共用一份結果，這是 `useAppCounts` 已經證明有效的形狀，也會順便消掉 `TargetsScopeHeader` 和 `TargetView` 各讀一次 `aggregateTargets` 的重複。
3. 需要「列本身」的畫面保留原始 batch：Timeline 用 `matchIds` 准入，`TerminalView`、`RecordTerminalFlow`、Screenshots 也要插列。這些不改。值不值得：config、計數、彙總、清單刷新這幾類值得，約 15 個訂閱點會消失；列准入不值得，batch 本來就帶了它要的東西。
4. 刪除的東西：
   - 5 處 debounce；
   - `ScopeStatus` 的逐批 `chain.length`；
   - `LateOutput` 的逐批 retry（改成訂閱 `events` topic 並篩 `command_id`，或由 main 回報 `commandOutput` 的變更）；
   - `knownLists.isHousekeeping`（main 在 batch 上附 `housekeeping: boolean`，或改用 topic 判定）；
   - 4 份 scope 子類型集合；
   - 4 個 window CustomEvent。

**遷移步驟。**
1. 只做 `config` topic：main 在唯一的存檔出口發；renderer 新增 `onDataChanged`；把 6 個 config 讀者改聽它；舊的兩條訊號暫時並存。
2. 再加 `scope.*` 和 `chain` topic；`ScopeStatus`、`useAppCounts` 改用。
3. registry 上線，`EvidenceHeader`、`TargetsScopeHeader`、`FirstRunView` 改用。刪 debounce。
4. 拔掉 window CustomEvent 和 renderer 端的述詞副本。

**影響範圍。** main 的 `flushBatch`、存檔出口、bookmarks／notes／screenshot 刪除 IPC；preload 多一個 channel；`env.d.ts`；renderer 約 15 個訂閱點。不改資料，不改既有專案。

**可能出錯的地方。**
- topic 分類漏掉某種寫入，畫面就不再更新。這比現在「更新太多」更難察覺。對策：契約測試，對每個寫入型 IPC 斷言至少發一個 topic（可以沿用 `verify-contract-coverage.mjs` 的模式）。
- overlay 視窗也要收 `config` topic。

**驗證。**
- core 分類函式和 `HOUSEKEEPING_SQL` 的等價測試（同一組 fixture 列）。
- 不經 Settings 的 scope 變更，例如 plugin 路徑，讓 FilterBar 和狀態列更新的整合測試。
- 持續流量下 header 計數會前進的測試：`app-counts-throttle` 已有範本。

---

### F3. 計數沒有詞彙表：同名的數字算不同的東西，「N of M」有兩種意思，成對的計數不在同一個快照讀

**機制。** 每個計數都在自己的元件裡選一支 IPC，算法因此不同：
- `getCount(tier)`：不含 scope，含 housekeeping；
- `events.count({filter, excludeHousekeeping})`：含分享篩選；
- `aggregateTargets`：兩個 tier、去掉 housekeeping；
- `getLootCount`：命中數，不是事件數；
- 前端陣列長度。

「complete／capped／render window」也沒有統一的表示。

**實例。**
- **同樣叫「事件」，算法不同。**
  - 狀態列 `statusBar.events` 是 `chained + logged`，含 housekeeping，不套任何篩選（`StatusBar.tsx:394`）。`24b43f9a` 刻意讓它算「每一筆紀錄」。
  - Timeline 的 M 是 `events.count({filter, excludeHousekeeping:true})`（`hooks/useTimelineSummary.ts:23`），而且 `hidePersonal` 預設為 true（`FilterContext.tsx:134`）。`activeCount` 又不計 `hidePersonal`（`:255-259`），所以 FilterBar 可能顯示 0 個條件，但實際仍有一個條件在作用。
  - 匯出的 totalCount 是 `getCount('all')`，只在換 view 時讀。
  - 三處都標「事件」，可以同時顯示三個數字。
- **「Loaded N of M」的兩種意思。**
  - `ListFooter` 的 M 是「已載入陣列的長度」，只是渲染窗口（`lib/useInfiniteScroll.ts`）。
  - `LootPanel` 同時顯示 `ListFooter`「已載入 200／共 340」（340 是已從 DB 取回的事件數），加上 `loot.recentSubset`「近期子集」（DB 那一層有上限），加上標題的 `visibleMatchCount`（命中數），加上 aria-label 的 `paged.total`（事件數），還有 Sidebar 徽章的 `getLootCount`（全專案命中數，不套篩選）。
  - 一頁上有 5 個數字，單位有兩種，「共」的意思有兩種。
  - `ScopeStatus:300` 同樣把 `ListFooter` 放在可能被截斷（`scope.truncated`）的清單上。
- **截圖頁「顯示 6 / 5」。** `ScreenshotsView.tsx:196` 只在第一頁讀取時用該頁的列計算 `triggerTotals`；即時插入的截圖（`:213-221`）會增加 `screenshots`，但不更新 `triggerTotals`。所以 `!hasMore` 時 `screenshots.summary` 會顯示 shown 大於 total。#701 的 diff 保留了這個行為（`if (!cursor && triggerFilter === null …) setTriggerTotals`）。
- **成對計數非原子，造成誤報 drift。** `useAppCounts.round()` 把 `getCount('chained')` 和 `chain.length()` 當成兩次 IPC，各自在 `.then` 裡 `set()`（`:99-101`），每次 `set` 都會觸發 `useSyncExternalStore` 重新渲染。Dashboard 的 `eventTileStatus` 在 `chainLen !== eventCount` 時就顯示紅色的 `dashboard.chainDrift`（`lib/eventTileStatus.ts:24`）。所以：
  - 擷取進行中，兩個回覆之間的那次渲染，必定是新的 eventCount 配舊的 chainLen；
  - 任一個讀取失敗時，0 對 N 會常駐為「drift」。

  狀態列的 `loadIntegrity`（`StatusBar.tsx:102`）用 `Promise.all`，但仍是兩次 invoke，中間如果有寫入也會不一致。是否真的會閃紅是 UNCONFIRMED（見最後一節），但第二種情況是確定的。
- **「N 筆新事件」計入所有列。** `ActivityResults.tsx:74` 把整批長度累加，包含 housekeeping 和不符查詢的列，然後顯示為「有 N 筆新事件進入」。

**為何只治標。** `liveTotal`、`useAppCounts`（「One fetch, one answer」）、`LootPanel` 的 v0.7.1 註解，都是在一個畫面內讓兩個數字一致。跨畫面的一致性沒有定義。constitution 的「capped result must not look complete」只能逐頁人工檢查。

**結構性改法（詞彙與位置）。**

| 詞 | 定義 | 放在哪裡 |
|---|---|---|
| **recorded** | 專案內所有列，兩個 tier 都算，含 housekeeping，不套篩選 | 只放在狀態列和 Dashboard；文案寫「已記錄」而不是「事件」 |
| **matching** | 這個畫面的述詞（分享篩選，加上畫面固有條件，加上排除 housekeeping）下的列數，由 main 用和分頁同一組述詞計算 | 畫面標題或工具列 |
| **loaded** | 已取到 renderer 的列數 | 只能以「loaded of matching」形式出現；matching 未知時寫「N+」或「最新 N 筆」 |
| **new since read** | 自上次讀取後，符合同一述詞的新列（由 `matchIds` 或 topic 判定） | 刷新提示 |
| 單位 | 每個數字都要帶單位名詞：事件、命中、flow、目標、觀察 | 同一畫面不得混用而不標示 |
| completeness | `complete \| capped(limit) \| truncated \| unknown` | 隨 `Query.completeness` 傳到 `<ReadStatus partial>`，只有一種畫法 |

具體刪改：
- `ListFooter` 不再顯示「of」；渲染窗口不屬於使用者語意，可以只留 sentinel，或顯示 loaded／matching。
- 3 組 `*.recentSubset` 收成一個。
- `screenshots.summary` 的 total 改用 main 的 count（加上 `trigger` 條件），或在 `hasMore` 為 false 時直接用 `screenshots.length`。
- 新增 `counts:snapshot` IPC，在 main 端一個 read transaction 內回傳 `{chained, logged, chainLen, loot, scopeObservations}`；`useAppCounts` 一次 `set`。drift 判定只用同一個快照。

強制執行：
- 一個 `formatCount({kind, unit, value, of?, completeness})`；
- i18n 測試斷言 `{{shown}}`／`{{total}}` 這類鍵只在 formatter 裡使用；
- `counts:snapshot` 的原子性測試：寫入和讀取交錯時 `chainLen === chained`。

**遷移步驟。**
1. 先做 `counts:snapshot`。它最小，能消掉誤報 drift。
2. 修 Screenshots 的 total。
3. `ListFooter` 改語意，Loot／Scope 套用。
4. 狀態列文案改成「已記錄」（需要產品確認用字；屬於 WORK-PLAN「等決定」的用詞類）。
5. `ActivityResults` 的新事件數改用 `matchIds`，和 Timeline 同一條路。

**影響範圍。** 少量 main IPC 和 core 查詢、renderer 約 10 個顯示點、兩語系文案、斷言文案的 e2e。跨平台無差異。

**可能出錯的地方。** 狀態列的數字改名，可能讓既有 e2e 或使用者習慣誤判。`counts:snapshot` 在大專案上若用 `COUNT(*)` 加上 chain 長度，成本要量測，可以沿用現有 `getCount` 的索引。

**驗證。** 單元：formatter、Screenshots 的即時插入。整合：寫入中的快照原子性。實機：持續擷取時 Dashboard 不再閃紅（需要錄影或計數紅色幀）。

---

### F4. 分享篩選是全域、隱性、各頁自選套用的狀態；跳轉不帶篩選語境，「為什麼看不到」無法從畫面得知

**機制。**
- `FilterContext` 的 `SharedFilter`（target、type、time、inScopeOnly、hidePersonal、tier）掛在 App 層，只在記憶體，換專案時會隨 reload 消失。
- 套不套用由各頁自己決定：
  - 套用：Timeline、HTTP、Loot、Search／Activity、Transcript、Export；
  - 不套用：Targets、Scope、Screenshots、Bookmarks、Dashboard、狀態列。
- FilterBar 只在 4 個 view 顯示（`App.tsx:317`）。
- 寫入者不只 FilterBar：`TargetView.tsx:287` 選目標時會寫全域的 `targetId`，`RecordingWorkspace:107,116` 寫 `agentType`。
- 同一個 context 還同時承載每批次都在變的 `knownTargets`。`Timeline.tsx:135-139` 自承：「The shared filter's provider changes its value on every live batch」，所以 Timeline 需要一層 memo 包裝；其他 8 個消費者每次有新目標的批次都會重新渲染。

**實例。**
- **Scope → Timeline 被藏起來（建構上必然）。** `ScopeStatus` 的「在時間軸開啟」打開的是造成越界的那筆事件（`ScopeStatus.tsx` 註解：「the thing the operator wants on the Timeline is the event that caused it」）。那筆事件本身就是 out-of-scope。只要操作員之前在 Timeline 開過 `inScopeOnly`，Scope 頁（不顯示 FilterBar）的每一次跳轉都會落在 `timeline.outsideFilter`「That event is outside the current filter.」，畫面只給一個 ×（`Timeline.tsx:2054-2062`）。
- **Targets → Timeline。** Targets 的證據清單只套 `{targetId: sel}` 加上 `excludeHousekeeping`（`TargetView.tsx:120`），不套分享篩選的 type、time、hidePersonal；Timeline 則全部套用。從 Targets 證據跳過去的事件，只要落在時間窗外，或是 personal domain 的流量，就會被藏。
- **條件不完整可見。** `hidePersonal` 預設開，但不計入 `activeCount`。`describeActiveConditions` 只在 `personalDomains` 非空時才列出它。Timeline 的查詢框文字存在 localStorage（`Timeline.tsx:461-472`，以專案為 scope），重開後會默默生效；目前選中的事件存在全域、不分專案的 `redlog-timeline-focus-event`（`lib/selectedEvent.ts`），其他 Timeline 鍵都有 `:${projectId}`。
- **「三個頁面無共用篩選提示」** 已經列在 WORK-PLAN 11-12。`FilterNotice.tsx` 的 `UnappliedFilterNotice`、`EmptyByConstructionNotice` 是逐頁補的，沒有東西要求每頁宣告自己套用哪些條件。

**為何只治標。** spec 038 決定「篩選是調查的條件，每頁的查詢都套用」，但沒定義：不套用的頁怎麼辦、跳轉怎麼辦、條件以外的隱藏原因（housekeeping、查詢框、上限、個人流量）怎麼一起說明。`outsideFilter` 提示和 `UnappliedFilterNotice` 都只是事後告知。

**結構性改法（所有權模型）。**
1. **三類狀態，三個擁有者。**
   - (i) 調查條件，即現在的 `SharedFilter`：App 擁有，每專案一份，維持記憶體加 reload 歸零的設計。
   - (ii) 畫面細化條件：Loot type、HTTP method／host、Screenshot trigger、查詢框文字。由畫面宣告，但存進「每專案 × 每畫面」的 store（模組 store，不放元件 state），所以 kept origin、返回、remount 都能保留。哪些要持久化，由一張表決定，不再每頁自己決定 localStorage。
   - (iii) 導航意圖：跳轉帶 `reveal: eventId`。
2. 每個畫面宣告 `applies: ReadonlySet<ConditionId>`。`useViewConditions(viewId)` 回傳以下東西，交給 F1 的 `<ReadStatus empty|partial>`：
   - 正在套用的條件（含 hidePersonal、housekeeping 排除、查詢框）；
   - 有設但沒套用的條件；
   - completeness。

   「為什麼少了列」因此永遠由同一個元件、同一套文字回答。`UnappliedFilterNotice` 和 `EmptyByConstructionNotice` 變成它的兩種狀態。
3. `reveal` 的契約：Timeline 收到 `reveal` 時，若事件不符條件，就顯示該事件（以「在目前篩選之外」的樣式釘住），並提供一個按鈕「顯示時略過 {條件}」。這只是一次性豁免，不改全域條件。這取代現在只有 × 的提示。不新增頁面，也不新增常駐文案。
4. 把 `FilterContext` 拆成兩個 context：`FilterState`（低頻）和 `FilterOptions`（knownTargets／types，高頻）。Timeline 的 memo 包裝和多數消費者的逐批重繪就會消失。
5. `selectedEvent` 鍵加上專案 id。

**遷移步驟。**
1. 拆 context。純重構，消費者改 import。
2. 加 `useViewConditions`，先接 Timeline 和 Loot。
3. `reveal` 接上 Scope 和 Targets 的跳轉。
4. 畫面細化條件移入 store。
5. `selectedEvent` 鍵改名，並遷移一次舊鍵。

**影響範圍。** renderer：`FilterContext`、9 個消費者、`App.tsx` 跳轉、Timeline 的 focus／loadBack 路徑。e2e 若有跳轉後斷言 outsideFilter 的情境要更新。localStorage 鍵遷移只影響該機器上的偏好。

**可能出錯的地方。** `reveal` 的豁免若被誤解成「條件失效」，Timeline 的 total 會跟著變。不變量：豁免只加入一列，並標示為「篩選外」，M 不變。

**驗證。** 單元測試 `useViewConditions`；元件測試：開著 `inScopeOnly` 時，從 Scope 跳轉後，該列可見且有標示；e2e 在 CI 上跑既有的 timeline 規格。

---

### F5. 導航與可見性沒有單一擁有者：位置、來源、可見性、鍵盤層各自手工維護

**機制。** `App.tsx` 用 10 個 state 加 1 個 ref 表達「在哪、從哪來」：`view`、`returnTo`、`kept`、`focusEvent`、`timelineReturn`、`activityQuery`、`readingRequest`、`settingsRequest`、`workspaceProject`、`returning`、`readingRequest`。另外：
- 「隱藏但仍掛載」有兩套：kept origin 只保留一次造訪；`workspaceProject` 保留到換專案為止。
- 捲動保留有兩套：`useKeepScroll(active)`；`restoreScroll` 用 DOM 快照。
- 可見性靠手動穿線的 `active` prop，用在 6 個元件。kept origin 的頁面沒有收到這個 prop。
- export 的「這個畫面」是單一全域槽位，最後寫入者勝（`lib/exportScope.ts`），正確性取決於每個貢獻者記得傳 `active ? … : null`。

鍵盤：
- `useAppShortcuts` 用表（`lib/shortcuts.ts`）；
- 「返回」（Cmd+[ / Alt+←）另寫在 `App.tsx:221-235`，不在表中，所以 Dashboard 的速查表和 Timeline 的 `?` 面板都沒列出它；
- 「正在打字」判斷有 3 份：`App.tsx:227` 含 SELECT，`useAppShortcuts.ts:72` 和 `Timeline.tsx:1492` 不含。
- WORK-PLAN 11-12 把「統一鍵盤層」列在待決策。

**實例。**
- **返回只有一層。** `openInTimeline` 用 `returnTo = view` 覆蓋舊值。從 Activity 進到 Timeline 再到 Activity，`timelineReturn` 和 `returnTo` 要靠 5 個 setter 同步（`App.tsx:157-208`）。「3 步返回軌跡」正在寫，但如果它是在這些 state 上再加一個陣列，就是在第 11 個 state 上治標。
- **kept origin 和 export scope 的耦合。** `keptOrigin.ts` 的註解說 HTTP history 因為 export effect「does not know whether it is on screen」而不能保留。但同一個 commit `9aa28ed3` 已經在 `HttpHistoryPanel.tsx:426` 加了 `active` 閘門，可見性這個概念散到連作者都需要猜。是否已可保留：UNCONFIRMED。
- **隱藏頁仍跑即時讀取**（見 F2），因為 kept origin 的頁面無從得知自己不可見；`inert` 只擋得住輸入。
- 跳轉帶的語境（事件 id、時間）、返回的語境（`timelineReturn`）、閱讀請求（`readingRequest`）是三種不同形狀。

**結構性改法。**
1. `lib/navigation.ts` 擴充出 `Route = { view, params, reveal?, origin?: Route }`，加上一個 reducer：`navigate`、`jump`（push）、`back`（pop）、`replace`。`App` 只保留 `route` 一個 state。kept origin 變成「棧頂下一層若可保留就保留」的推導，`workspaceProject` 也併進這條規則。返回軌跡直接取自棧。「3 步軌跡」應該讀這個棧，而不是另外存一份。
2. `ViewVisibility` context：`App` 為每個掛載中的頁面提供 `visible`。由它推導出來的東西：
   - `useQuery` 和 F2 的 registry 在不可見時暫停，回到可見時若資料已髒就重讀；
   - `useContributeExport` 只接受可見頁的貢獻；
   - `useKeepScroll` 取代 DOM 快照；
   - `active` prop 全部刪除。
3. 鍵盤：「返回」加進 `shortcuts.ts` 的表；「正在打字」只有一份判斷函式（`lib/ime.ts` 旁）；`escapeLayer` 已經是分層的雛形，擴充為 modal > 浮層 > 畫面 > app 的單一 dispatcher。是否全面做成統一鍵盤層要等產品決策，但前兩步沒有爭議。

**遷移步驟。**
1. 加 reducer，行為和現在完全等價（棧深 1）。
2. 開放棧深 3，接到進行中的返回軌跡。
3. 加 `ViewVisibility`，逐一移除 `active` prop。
4. 鍵盤表收編「返回」。

**影響範圍。** `App.tsx`、`keptOrigin.ts`、`navigation.ts`、6 個收 `active` 的元件、`exportScope.ts`、`useAppShortcuts`。e2e 裡的返回和跳轉規格要在本機或 CI 上跑；依記憶的規則，不在本機跑 Electron e2e，交給 CI。

**可能出錯的地方。** 保留多層頁面時記憶體會增長。不變量：最多保留 1 個隱藏頁，其餘 remount 後靠 F4 的細化條件 store 加上捲動快照還原。

**驗證。** reducer 純函式測試；跳轉→返回→再跳轉的元件測試；`exportScope` 在隱藏頁不會搶槽的測試。

---

### F6. `Timeline.tsx` 的單一閉包是缺陷來源；另有一個違規的內嵌元件，而且沒有 gate 抓它

**機制。** `TimelinePanelView` 從 `Timeline.tsx:159` 到 `:2910`，約 2,750 行，含 38 個 `useState`、35 個 effect、29 個 ref、25 個 `useCallback`、24 個 `useMemo`。所有衍生值在同一個 render 函式裡依宣告順序求值。

**實例。**
- **TDZ。** `Timeline.tsx:966` 的註解：「the e2e has caught this exact mistake twice in this file」，指的是 hook 的 deps 引用了在下方才宣告的 const。CLAUDE.md 也把它列為已知風險。這是大小的直接後果：宣告順序是一條 2,700 行的隱性契約。
- **效能補丁。** 需要 `memo` 包裝加上 ref 轉發回呼（`:135-157`），才能擋住 `FilterContext` 每批次都在變的副作用。這個成因在 F4，但只有在單一巨型元件裡才貴到必須補。
- **全域 keydown effect 依賴 events。** deps 是 `[… events, hiddenLanes, …, visibleRows, rowKeyOf]`（`:1599`），每次即時發佈都會拆掉再重掛 window listener。目前沒觀察到缺陷，但會放大競態。
- **8 種手寫的非同步狀態 union**（見盤點），是 F1 在這個檔案裡的局部版本。
- 從 2026-08 起，這個檔案有 187 個 commit，其中 45 個是 fix。已經有 `220607a8` 把 paging、live、selection、viewport 拆成 hooks，方向正確。
- **內嵌元件。** `StatusBar.tsx:213` 的 `const Sep = () => …` 在 `StatusBar` 函式體內宣告，並以 `<Sep />` 使用 3 次，違反 CLAUDE.md 的「Never declare a component inside another component's body」。它目前無狀態，所以只是每次渲染都 remount 一個 `<span>`，沒有可見缺陷。repo 沒有 ESLint（沒有 config，`package.json` 裡也沒有 lint script），所以 `// eslint-disable-next-line` 註解都是死碼，也沒有任何東西能抓下一個 `ExportMenu` 式的錯誤。WORK-PLAN 把「lint 第六道 gate」列為待決策。其他元件我用 regex 掃過 components、`App`、`OverlayApp`，沒有找到其他違規。`PluginRow.tsx:24` 的 `const Icon = …` 只是選取既有元件，不是新型別，屬於合法。

**超過約 1000 行的檔案。**
- `Timeline.tsx`（2,910 行）：大小是成因，理由如上。
- `TranscriptView.tsx`（1,098 行）：只是大。主元件約 700 行，有 16 個 `useState`、6 個 effect，沒看到因大小造成的缺陷，它的問題在 F1（手寫的讀取狀態）和 F2（自訂即時路徑）。
- 其餘都低於 1000 行。

**拆解方式（必須保持不變的東西）。** 按「資料生命週期」切，不按 UI 區塊切：
1. `useTimelineQuery`：pages、live、summary、loadBack、`outsideFilter`/`reveal`，輸出一個 `Query` 和 rows。
2. `useTimelineQueryBox`：parse、`matchIds` 快取、`earlier`。
3. `useTimelineDerivations`：folds、titles、effects、markers。
4. `useTimelineKeys`：已有 `resolveTimelineKey`，改成用 ref 讀最新值，listener 只掛一次。
5. 渲染層：既有的 `timeline/*` 子元件。

不得改變的東西：
- `body { zoom }` 下的幾何（`offset*` 系列）和 `test/` 的幾何單元測試；
- e2e 的 `timeline-track.spec.ts`、`timeline-evidence.spec.ts` 和各 testid；
- localStorage 鍵名（必要時做遷移）；
- 即時發佈的 `flushSync` 批次語意（`useTimelineLive` 的 `commit`）。

強制執行：
- 用原始碼掃描測試（和 F1 的 read-guard 同一支）偵測「元件函式體內出現以大寫命名、並以 JSX 使用的函式」，Sep 是第一個要修的；
- 或在 lint gate 決定之後改用 `react/no-unstable-nested-components`。
- 加一個檔案大小 ratchet（Timeline 只降不升），先固定方向。

**遷移步驟。** 每抽出一個 hook 就是一個 PR，PR 內只動 import 和參數，並跑 `npm test` 加上 CI 的 e2e。第 1 步依賴 F1 的 `Query` 型別。

**影響範圍。** Timeline 和它的 62 個相關測試檔。純 renderer。

**可能出錯的地方。** 抽 hook 時 effect 的執行順序會變，例如 focus 和 loadBack 的先後。每一步都要跑 e2e。

**驗證。** 既有單元測試加上 CI e2e，再在實機用掃描流量看 Timeline 跟隨和返回 focus。

---

## 建議的順序（任務 2 的結論）

選 (c)，兩者都做，順序如下：

1. **F3 的 `counts:snapshot`，加上 F2 的 `config` topic。** 兩個都小，各自消掉一個確定的錯誤顯示（誤報 drift；scope 狀態停在舊值）。
2. **F1：`Query<T>`、`<ReadStatus>`、read-guard ratchet。** 這一步讓「下一個畫面」預設就對。
3. **F4 拆 context，F5 的 `ViewVisibility`。** 有了可見性，F2 的 registry 才能「隱藏時暫停」。
4. **F2 的 topic registry 全面化。** 刪 debounce、刪 window CustomEvent、刪 renderer 端的述詞副本。
5. **F4 的 `reveal`、F5 的 route 棧、F6 的拆解。**

會刪掉的東西（總表）：
- 5 處會飢餓的 debounce；
- 約 35 處讀取的吞錯；
- 3 種身分補丁；
- 約 30 個讀取失敗的 i18n 鍵，收斂成約 4 個；
- 3 組 `recentSubset`；
- 4 個 window CustomEvent；
- `knownLists.isHousekeeping`；
- 4 份 scope 子類型集合；
- 6 個 `active` prop；
- DOM 快照式的捲動還原；
- `App.tsx` 約 8 個導航 state；
- Timeline 的 memo 包裝；
- `StatusBar` 的 `Sep`。

---

## 查過且健全（下一位不必重查）

- `lib/throttledRead.ts`：序號保證舊回覆不覆蓋新回覆，一次只有一個在飛，trailing 一定會跑，`dispose` 之後不再套用。
- `lib/liveTotal.ts`：上界語意、只重算一次、失敗時保留上界。
- `FilterContext.refreshLists`：gen 防護、StrictMode 的 `live` ref 會重新上膛（#223）、讀取期間的 batch 補登。
- `useTimelineLive`：generation 加上 `latest` 版本防護；准入走 main 的 `matchIds`，和分頁用同一組述詞，不在 renderer 重寫。
- 換專案會 `window.location.reload()`（`CommandPalette.tsx:124`）；關閉專案則因 `!project` 卸下整個 `FilterProvider` 樹。所以 renderer 記憶體狀態不會跨專案殘留；只有 localStorage 鍵會（見 F4 的 `selectedEvent`）。
- main 端 `withActiveScope` 把 scope 附加在 `events:query`／`count`／`span`／`matchIds`／`runQuery`，renderer 的述詞只能縮小、不能放大。
- 「scope 已設定」的**定義**已收斂到 core `ScopePolicy.isConfigured`（`lib/scope.ts:11` 和 `alert/policies.ts:236` 一致）。殘餘問題在失效時機（F2），不在定義。
- #701 `useLivePagedQuery` 的設計：key 換題時同一幀就顯示未答、reset 失敗不保留舊題的列、append 失敗獨立、`head` 合併有斷層偵測。它應該成為 F1 的實作基礎。
- `escapeBelongsAbove` 的分層邏輯正確，只是還沒擴及其他鍵。

## 刻意如此（附出處）

- `EvidenceHeader` 不顯示 loot 數：註解說明兩個數字會互相矛盾（`EvidenceHeader.tsx:13-16`）。
- 狀態列計入每一筆紀錄，含 logged tier：`24b43f9a`「one event number, and it counts every recorded row」。F3 只建議改名，不改算法。
- `hidePersonal` 預設開（`FilterContext.tsx:134`）。F4 只要求它算進「可見的條件」。
- Activity 用「快照加新事件提示」而不是自動合併：Activity 是查詢快照（Stitch 06）。F3 只修提示的計數。
- Timeline 不用 `useInfiniteScroll`（`useInfiniteScroll.ts:10` 註解）。
- `useVisibility` 探測失敗時當成全揭露（`hooks/useVisibility.ts:83`）。
- `ExportMenu.planScopeSet` 把「只有排除項」也算成 scope 已設：它回答的是「遮蔽是否有作用」，不是「scope 是否已設定」（`ExportMenu.tsx:21-24`）。
- HTTP history 不在 `KEEPABLE`（`keptOrigin.ts` 註解）。理由可能已過時，見下節。

## 未確認（以及怎麼確認）

- **Dashboard 在擷取中是否實際閃紅 drift。** 程式碼確定兩次 `set` 之間會有一次 eventCount 和 chainLen 不一致的渲染；可見幀數未量測。確認方式：持續擷取時對 `eventTileStatus` 的 tone 計數，或錄影。另外，`StatusBar.loadIntegrity` 的兩次 invoke 之間是否會插入寫入，取決於寫入在 main 上的排程，需要在 handler 加時間戳記確認。
- **`EvidenceHeader` 的截圖數是否包含已刪檔的截圖列。** 刪除時寫的是 `screenshot_deleted` 列，原列似乎保留。需要查 core 的刪除路徑。
- **`keptOrigin.ts` 對 HTTP history 的排除是否已過時。** `active` 閘門已存在。確認方式：保留它，檢查返回後 export 槽位的歸屬。
- **全域 `selectedEvent` 鍵在換專案後的行為。** 推測是靜默的 `loadBackTo` 找不到就結束；未實測。
- **兩個 `active` 的 export 貢獻者同時存在時，最後寫入者是誰**（`SearchPanel` 和 `TranscriptView` 同在 `RecordingWorkspace` 內）。需要元件測試。
- **settings/\* 各頁沒有逐一盤點**；以上統計涵蓋它們的 `useReadState` 用法，但未驗證呈現。
