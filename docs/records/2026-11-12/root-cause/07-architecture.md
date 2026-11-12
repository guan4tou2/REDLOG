# 07 — 架構與模組邊界（root-cause review）

基準：`main@a087c16c`（2026-11-12）。唯讀檢視；圖譜以 node 一次性腳本解析 `src/**` 相對 import 得出（不含 type-only 與 runtime 的區分，下文另註）。

## 摘要（10 行）

1. 程式的分層方向大致守住：`main→core` 225 條、`renderer→core` 103 條，反向只有 1 條 core→main（type-only）與 2 條 renderer→main；core 不 import electron。分層不是問題來源。
2. 問題在「一個專案開著」這件事沒有擁有者：專案狀態散在 core／main 約 25 個 module 單例裡，用 4 種不同的過時判斷手法（顯式 reset、`dbGeneration()`、`projectDir` 比較、project id 比較）。`ProjectRuntime` 只管 timer 跟身分；正式碼裡 `onStop` 用到的地方是 0 處。
3. 開專案、關專案、套用設定是三份各自手寫的清單（`startProjectResources`／`stopProject`／`saveProjectConfig`）。這週看到的切換洩漏、設定存檔重啟來源，都是這三份清單對不齊造成的；air-gap 只套了一半是已確認的實例。
4. 身分由呼叫端各自帶入、不由核心蓋章：`insertEvent` 沒帶 engagement 時存成 `'default'`。`chain-anchor` 的 `anchor_failed` 就這樣寫成了 `'default'` 列，結果它在 Timeline 看得到、在 Activity 看不到，還會讓 Activity「前後」面板整塊顯示 denied。
5. 擷取傳輸契約（identity 檔、token／port、POST、spool、命名、沒專案時的行為）在 sh／ps1／4 支 python 裡各寫了一次。同一個 bug 已經分別修過兩次（mitm 與 pcap 的 spool 命名、shell 與 PowerShell 沒專案時的 spool）。
6. 因果關係（產品差異化所在）只是嵌在雜湊過的 `data._causes` JSON 裡：沒有 edge 表、沒有索引；反查 effect 是在兩層表上每一層深度跑一次全表 `json_each`，而且走寫入連線；事後才知道的關聯沒有地方存。
7. 查詢的 SQL 層已經相當統一（`buildTierWhere`／`queryTierPage`／`executeEventQuery`／`countEvents`）。剩下各做各的是：即時納入（6 種策略）、兩種 snapshot 型別、engagement 過濾有的讀取面套有的不套、`GET /api/events` 有上限卻沒有 `hasMore`。
8. Spec 與 gate：Draft 狀態下面已經有大量出貨程式碼（052：31 個 commit；069：35 處程式引用）；變動最頻繁的專案 runtime、ingest 階段順序、`~/.redlog` 交接目錄，都沒有任何 spec 負責。`verify:architecture` 以識別字名稱比對，看不到 api-server 裡已經死掉的 `castProbe`／`castOffsetAtStart`。
9. 目標結構是 6 項承重改動，依序：gate 補強 → 核心蓋身分 → `ProjectSession` + resource 清單（承接 R1b）→ 單一設定視圖 → 交接目錄契約 + 共用 client → 查詢 primitives／edge 索引。
10. 不值得做的：把內建來源改成 plugin、`/api/ingest` + mapper 管線、依行數拆 Timeline／`main/index.ts`、`src/core` 整批搬目錄、DI container／全域 store、改 evidence schema。

---

## 結構量測（供後續引用）

| 項目 | 數值 | 來源 |
|---|---|---|
| 最大檔 | `Timeline.tsx` 2910、`main/index.ts` 2204、`tailer-host.ts` 1602、`event-queries.ts` 1324、`TranscriptView.tsx` 1098、`hooks-manager.ts` 1040、`api-server.ts` 988、`terminal-manager.ts` 853、`chain-anchor.ts` 890、`capture-health.ts` 825、`event-write.ts` 757、`ingest.ts` 660；hooks：`redlog-relay.py` 2120、`mitmproxy-addon.py` 2010、`shell-common.sh` 1140 | `wc -l` |
| fan-out 最高 | `main/index.ts` 109、`Timeline.tsx` 53、`App.tsx` 44、`api-server.ts` 34 | import 圖 |
| fan-in 最高（core） | `db/events.ts` 53、`db/index.ts` 42、`event-bus.ts` 25、`capture-health.ts` 20 | import 圖 |
| 循環（SCC） | 17 檔的大環：`db/index`↔`db/events`↔`event-write`↔`event-queries`↔`http-body-store`↔`http-body-index`↔`export-plan`↔`activity-contract`↔`raw-store`…（`http-body-index.ts:116` 註解承認其中一段）；5 檔：`capture-health`↔`plugins/index`↔`loot-detector`↔`terminal-profiles`；6 檔（renderer settings） | Tarjan |
| 跨層 | core→main：`core/http-autostart.ts:15`（type-only）；renderer→main：`AboutPage.tsx:7`（type-only）、`lib/terminalFlow.ts:3`（**value** import `ACK_EVERY_CHARS`） | import 圖 |
| `Timeline.tsx` | 39 個 `useState`、35 個 `useEffect`、29 個 `useMemo`、16 種 IPC | grep |
| core 的 `configureX`／`setX`／`registerX` 注入點 | 30 個（api-server 4、capture-health 4、ingest 1、redaction 2、plugins 3…） | grep |
| `homedir()` 呼叫 | 79 處／24 檔；`'.redlog'` 直接 join 41 處；在 module 載入時就算好路徑：`api-server.ts:50-51`、`project-manager.ts:20-21`、`main/index.ts:374,471`、`hook-config.ts:12`、`overlay-position.ts:18` | grep |
| `loadConfig()` | 33 處呼叫（`main/index.ts` 20 處），每次都讀檔解析 YAML、沒有快取 | grep |
| 寫入入口 | `ingest()`／`ingestEvent()`：10 個 producer 檔；`insertEvent()` 直接呼叫：16 檔共 30 處 | grep |

---

## 發現（依影響排序）

### F1. 「開著的專案」沒有擁有者：專案狀態散在 module 單例，靠三份手寫清單與四種過時判斷撐住

**機制。** `DESIGN-project-runtime.md` §2 明說 `ProjectRuntime`「Not a resource registry」，`stopProject` 的明確清單維持不動，services「one at a time」改掛到 `onStop`。實際狀況（`grep '\.onStop(' src` 正式碼 0 處）：沒有任何 service 掛上去。所以「一個專案開著」實際上由下面這些東西拼成，各有各的生命週期：

- DB：`db/index.ts:12-40`（`db`、`roDb`、`currentProjectDir`、`boundEngagement`、`generation`）；`cast-index.ts:99-100`（`idx`、`idxDir`）；`http-body-index.ts:16,74-78`（`index`、`indexDir`、`walked`、`dirty`、`statements`）
- 每專案快取：`http-body-store.ts:34 _cachedDir`、`raw-store.ts:44 _ensuredDir`、`scope-observation-count.ts:9`、`visibility-signals.ts:41`、`causes-resolver` 的 6 個 Map、`socket-attribution` 的 3 個 Map 與計數、`ingest.ts:83,394-404` 的 4 個 Map、`event-write.ts:109-348`（sessionId、`cachedLastHash`、`cachedEventCount`、`lastEventForClockCheck`）
- 注入的 ref：`ingest.ts:62-70`、`api-server.ts:53-120`（14 個）、`capture-health.ts:189-215,410`
- main 的變數：`recomputeTimer`／`recomputePending`、`linkTimer`、`showWifiName`、`managedStartQueue`

清掉這些狀態用了四種手法，哪個模組用哪種沒有規則：
1. `stopProject` 顯式列出：`closeCastIndex`、`closeHttpBodyIndex`、`closeDB`、`resetBodiesDirCache`、`resetCausesResolver`、`configureIngest({activeTarget:null})`（`main/index.ts:1271-1278`）
2. 下次用到時比 `dbGeneration()`：`ingest.ts:416`、`socket-attribution.ts:95`、`chain-anchor`、`screenshot-agent`、`cast-index`（共 18 處）
3. 比 `projectDir`：`raw-store.ts:45-50`、`cast-index`
4. 比 project id：`ipc/data-export.ts`（5 處）、`ipc/artifacts.ts`（2 處）。設計文件 §1 自己就說這種比法在 A→B→A 時會失準

**實例。**
- git log 自 2026-08 起，修「切換後寫進／讀到別的專案」的 commit 至少有：`9614db7d`（socket-attribution 關專案時忘記清 map）、`1b6fa2c8`（ingest 忘記清 per-terminal 狀態）、`69c93423`（ingest 在有副作用之後才拒絕）、`67b58cd9`（anchor upgrade 活過了專案）、`4ba9dcee`（capture browser）、`aa157197`（R1c 稽核表列了 8 條路徑）、`59449d43`、`8b28f852`，還有 `raw-store.ts:40-42` 註解記錄的「Caching the path itself kept writing into the previous project's raw/」。每一個都是加上一條 reset，或在某個 await 後補一次檢查。
- 還沒修的：`http-body-store.ts:36` 只要舊目錄還在就回傳 `_cachedDir`，正確性完全靠 `stopProject` 有呼叫 `resetBodiesDirCache`；哪一天開專案的路徑沒經過 `stopProject`，body 就會寫進上一個專案。`startLinkMonitor()`（`main/index.ts:607-619`）每次開專案都會啟動，但 `stopProject` 沒有停它。`capture-health.ts:212-233` 的 `_lastDbError`、`_dbErrorTotal`、`_captureErrors` 切換時不清，A 的 DB 錯誤會讓 B 的判定在 60 秒內維持 dark，累計數也會帶過去（註解寫的是「session lifetime」，但卡片顯示的是每個專案自己的健康度）。
- **設定套用是第三份清單，已確認漂移：** `network.offline`（air-gap）有四個消費者，套用時機有三種。`chain-anchor.ts:51` 每次呼叫都 `loadConfig` 即時讀；`alert-runtime.ts:115` 在開專案與 `config:save` 時讀；`setUpdaterAirgap` 與 `startNtpLoop` 只在開專案時讀（`main/index.ts:1072-1078`），`saveProjectConfig`（1590-1679）兩個都沒有重新套用，也沒有 config 檔 watcher。i18n 的 `update.airgapHint` 叫操作員直接改 `config.yaml`。所以專案開著時打開 air-gap：錨定會停，NTP 每 5 分鐘仍然對外，更新檢查也還在跑，要重開專案才會生效。這是 OPSEC 開關只套了一半。
- 同一份清單漂移的其他形狀：`startProjectResources` 的 `lootDetector.configure({identity, …})` 與存檔路徑的 `lootDetector.configure({disabledRules})` 參數集合不同；`configureAgentTailer` 存檔時只經由 `applyCapturePacks` 重設，`emitThinking` 不會重新套用（UNCONFIRMED：要看 `applyCapturePacks` 傳了哪些欄位）。
- 開專案流程裡混著 app 層級的東西：`initPlugins()`、`setTailerContributionSink`、`startLinkMonitor`、建立 overlay 視窗，都放在 `startProjectResources` 裡，卻沒有對應的 stop。

**為什麼到目前的修法都只治標。** R1a／R1c 把「寫錯庫」擋在最後一關（`bindDBEngagement` 加上 `dbGeneration`），這是對的，但它擋的是結果，不是來源。每次發現新的洩漏，都是在某個模組再加一條 reset 或 generation 檢查。進行中的「one config apply path」只處理存檔會重啟不相干來源；只要即時讀 `loadConfig` 的消費者（33 處）還在，air-gap 這種分裂就還會出現。

**結構改動。**
- 新增 `ProjectSession`（main，取代 `startProjectResources` 與 `stopProject` 的本體），在 `projectRuntime.begin` 時建立，持有：DB 連線（rw／ro）、cast index、body index、`ConfigView`（見 T4）、identity，以及一個**有序的** `ProjectResource[]`。每個 resource 的形狀是 `{ id, start(session), apply(diff), stop() }`。順序就是陣列順序，關閉時反向執行；`stopProject` 現在的順序契約（terminal binding 在 DB 關閉前 detach、API binding 先於 spool identity 撤銷）用陣列位置表達，並用一個測試把陣列快照釘住。
- core 的每專案快取改由 session 傳入 handle（`bodiesDir(session)`、`rawDir(session)`），或掛在 session 上的 per-session 物件。要刪掉的：`resetBodiesDirCache`、`resetCausesResolver`、ingest／socket-attribution 的 `dbGeneration` 懶重設、`raw-store` 的 `_ensuredDir`、`configureIngest({activeTarget:null})`。
- `dbGeneration()` 只保留給真正會跨過 await 的寫入當最後一道保險（R1c 的角色），不再拿來當「清快取」的訊號。
- 不變式：**專案範圍的可變狀態只能存在於 session 擁有的物件裡**。Gate：在 `verify:architecture` 加一條規則，`src/core/**` 的 module 層 `let`、`new Map()`、`new Set()` 必須列在 `architecture-allowlist.json` 並寫明理由（app 層級或常數），新增的就會失敗。再加一個行為測試：開 A、經每個 resource 寫入、切到 B，斷言每個 resource 的 `inspect()` 裡沒有 A 的 id。

**遷移步驟（每步都可出貨）。** 1) 先加 gate 與 allowlist，把現況全部列進去（綠燈），清單之後只會變短。2) 引入 `ProjectSession` 與空的 resource 陣列；`stopProject` 改成先跑 resources、再跑舊清單。3) 每個 PR 只把一個 service 從舊清單移進陣列（R1b 原本的節奏），附切換測試。4) 移到 cast／body index 與 DB 時，把 core 的懶重設一併刪掉。5) 舊清單清空後刪除 `stopProject` 本體。

**影響範圍。** `main/index.ts`、`main/services/*`、`core/db/index.ts`、`cast-index`、`http-body-*`、`raw-store`、`ingest`、`socket-attribution`、`causes-resolver`、`capture-health`。磁碟資料不變，跨平台無差異。
**風險。** 順序契約搬家時被隱性改動（`stopProject` 的註解已列出兩條）；`index.ts` 同時只能有一個人改（設計文件 §4 已警告）。
**驗證。** 單元：每個 resource 的切換測試；等價：在同一組 e2e（`project-open-rollback`、`terminal-session-rotation`、`capture-browser-project-switch`）前後跑一次；真機：mac 上 A→B→A 加 air-gap 切換，看對外連線（`lsof -i`）。

---

### F2. 身分由呼叫端提供、核心沒有蓋章：同一個 DB 裡會出現別的 engagement，而讀取面對這件事的處理不一致

**機制。** 一個專案 DB 只屬於一個 engagement（`config.ts:383-385` 把 `engagement.id` 強制等於 `projectId`），而且 R1c 之後 DB 自己就知道（`dbEngagement()`）。即使如此，`insertEvent` 仍然要每個呼叫端傳 `engagementId`，沒傳就存成 `'default'`（`event-write.ts:604,716`）。guard 只拒絕「明確寫了別的 id」的列（`event-write.ts:461`），沒寫的照樣放行。身分目前有六份拷貝：`ProjectRuntime` context、`db/index` 的 `boundEngagement`、`api-server.ts:56,59` 的 `engagementId`／`primaryOperatorId`、`~/.redlog/active-identity.json`、`config.yaml`（`ipc/markers.ts:121,132`、`ipc/artifacts.ts:45` 直接 `loadConfig` 拿身分），以及 `AlertRuntime`／`LootDetector` 各自持有的 identity。操作員一變更，就得靠 `operator-change.ts` 同時去改其中三份。

**實例。**
- `chain-anchor.ts:242-249`：`insertEvent('system', {subtype:'anchor_failed', …}, { operatorId: opId })` 沒有帶 engagement，所以存成 `'default'`。錨定每小時跑一次（`startAnchorLoop` 預設 60 分鐘），只要機器連不到 OTS calendar（滲透測試常見的隔離網段，而且沒開 air-gap），每小時就多一列 `'default'`。
- 讀取面意見不一：`activity-queries.ts:223-311`、`evidence-content.ts:40`、`source-sessions.ts:87` 用 `engagement_id=@eng` 過濾；`queryEventsPage`、`executeEventQuery`、`countEvents`、`aggregateTargets`、`queryEffectsOf` 不過濾。所以 `anchor_failed` 會出現在 Timeline 與搜尋裡，Activity 裡卻沒有，它的內容也讀不到（`evidence-content` 回 denied）。
- `ActivityAround.tsx:48`：只要 ±5 分鐘窗口裡有任何一列 `engagementId !== projectId`，就整塊丟出 `content.status.denied`。`anchor_failed` 不屬於 `HOUSEKEEPING_SQL`（`event-queries.ts:212-220`），所以離線機器上，錨定失敗前後 5 分鐘內任何一個操作的「前後脈絡」都會顯示「拒絕存取」。（程式碼路徑已確認；真機重現 UNCONFIRMED：需要一台連不到 calendar、未開 air-gap 的機器跑滿 1 小時。）
- 同一種失敗以前出現過：updater 的重啟 marker 當時把 `engagementId:'default'` 寫死（設計文件 §2b 記載，R1c 修掉的就是那一個呼叫點）。

**為什麼只治標。** R1c 修的是「被看到的那個呼叫點」，而不是把參數拿掉。只要參數是選填、預設值是 `'default'`，下一個寫系統事件的人照樣會漏。

**結構改動。**
- `insertEvent` 的 engagement 改由 bound DB 蓋章：DB 已 bind 時，忽略或拒絕呼叫端傳入的值；沒有 bind（測試、CLI 工具）時才接受明確傳入，而且不再預設 `'default'`，直接拋錯。operator 同理，由 session 的 `operatorId` getter 蓋章。外部 producer 帶來的 engagement 只在 HTTP 邊界比對（`api-server.ts:329` 現有的 409）；比對過後，進核心的是 session 的身分，不是請求帶來的字串。
- 讀取面統一：一個 DB 就是一個專案，所以讀取 SQL **一律不**以 `engagement_id` 過濾（`ActivityAround.tsx:48` 的逐列檢查也刪掉，專案一致性改由 IPC 回覆所附的 session token 判斷，見 F1／T3）。既有的 `'default'` 列算本專案的歷史。engagement 在 hash 輸入裡（`event-write.ts:619`），列本身不能改寫，只能改讀法。
- 要刪的：`insertEvent`／`ingest` 的 `engagementId` 參數（約 35 個呼叫點）、`api-server` 自己那份 `engagementId`、`ipc/*` 裡拿 `loadConfig().engagement.id` 當身分的寫法、`applyOperatorChange` 裡對 api-server 的同步。
- 不變式：「每一列新寫入的 engagement 都等於 bound engagement」，以及「沒有任何讀取路徑以 engagement 過濾」。Gate：一支測試 grep `src/` 不得出現 `engagement_id=` 或 `engagement_id =` 的 SQL；`insertEvent` 的型別上不再有 `engagementId`。

**遷移步驟。** 1) 讀取面先統一（去掉過濾、去掉 Around 的逐列檢查），附一個帶 `'default'` 列的 fixture 測試：Activity 與 Timeline 看到同一組列。2) `insertEvent` 改為以 bound 值為準，傳入值不一致就拋錯（現在只拒絕明確不符的列）。3) 逐檔刪掉呼叫端的 engagement 參數（純機械，typecheck 保底）。4) api-server 改讀 session。
**影響範圍。** `event-write`、`ingest`、`activity-queries`、`evidence-content`、`source-sessions`、`ActivityAround`、約 20 個寫入檔。磁碟不變；舊專案裡的 `'default'` 列會開始在 Activity 出現（行為改變，要對應 Spec 064 CT 的斷言）。
**風險。** 有測試以 `'default'` 當預設值；Spec 064 的 contract 測試可能斷言了 engagement 過濾（依 CLAUDE.md「Changing behaviour」，這些測試屬於本次改動的一部分）。
**驗證。** 單元與 064 coverage manifest；等價測試：同一個 DB 在改動前後，Activity 的列集合只差 `'default'` 那幾列；真機：拔網跑 1 小時錨定。

---

### F3. 擷取傳輸契約在每個 producer 各自重寫一次，而且沒有共同的一致性測試

**機制。** 外部 producer 要跟 App 溝通，得照一份從未寫下來的契約：讀 `~/.redlog/active-identity.json`、`api-token`、`api-port` → POST `/api/events` → 失敗時寫進 `~/.redlog/pending/`（檔名不能撞、權限 0600、要帶 `_identity`）→ 沒有專案時不要 spool（或要 spool）→ identity 檔被改寫時怎麼處理。這份契約目前的實作：`shell-common.sh`（identity 讀了 5 次，路徑 278、335、572、719、808、851，其中一處是內嵌的 python）、`shell-hook.ps1`、`redlog-relay.py:223,1154`、`redlog-session.py:66`、`mitmproxy-addon.py:91,128`、`pcap-agent.py:45,64`，寫入端是 `main/index.ts:378-383`。路徑解析也各做各的：shell 有 `_redlog_resolve_dir`（WSL 判斷，#326），relay 用 `terminal_home(opts)`，mitm 與 pcap 用 `Path.home()`，TS 有 41 處 `'.redlog'` join。

**實例。**
- 同一個修正做了兩次：`d889a35c`「fix(mitm): the spool never gives two records one name」與 `d601af48`「fix(pcap): the spool never gives two payloads one name」。
- 沒有專案時要不要 spool，修了兩次：`0a6a07b1`／#316（shell）與 `80bf5752`／#427（PowerShell）。
- `b3f5b654`：spool replay 繞過了 ingest。replay 是第七個「寫入方」，契約當時沒有規定它要走哪個入口。
- identity 檔用 `fs.writeFileSync` 寫，不是原子寫入（`main/index.ts:381`）。結果讀取端各自去處理半寫狀態：`shell-common.sh:322-325` 的註解寫「An empty read is a file being rewritten (RedLog truncates, then writes)」；python 端是 `json.loads` 包 `except ValueError` 後回 `None`，直接當作沒有 client。三種語言對同一個暫態給出三種反應。
- `api-server.ts:50-51` 在 module 載入時就把 `TOKEN_PATH` 固定下來，測試要隔離 HOME 就得在 import 前設好（`29ba8bda`「stop api-server touching the real home」修過一次）。

**為什麼只治標。** 每次修的都是「某一種語言的某一個分支」。契約本身沒有版本，也沒有一套 fixture 能讓每個 client 都跑一遍。

**結構改動。**
- 把交接目錄寫成 spec（建議 `docs/domain/SPEC-producer-handoff.md` 或新 spec），內容是檔案清單、JSON schema、版本欄位、原子寫入（tmp + rename）、目錄解析順序（`REDLOG_HOME` → WSL 規則 → `~/.redlog`）、spool 檔名與 `_identity` 格式、沒有專案時的行為。
- TS 端只留一個模組 `core/handoff-dir.ts`：負責解析根目錄（吃 `REDLOG_HOME`，並且在呼叫時解析，不在 module 載入時）、做所有寫入（identity、token、port），用原子寫入。要刪的：`main/index.ts:374-401`、`api-server.ts:50-51,166-178` 的路徑常數，以及散在 24 個檔裡、指向 `.redlog` 的 `homedir()`（machine 層級設定可以留在 `hooks-manager`，但根目錄要經過這個模組）。
- python 端抽出一個 `hooks/redlog_client.py`（identity、token、port、POST、spool），讓 relay、session、mitm addon、pcap 共用；sh 與 ps1 保留最小的讀取，但行為由同一套 fixture 驗證。
- 不變式：「每個 client 對同一組交接目錄的狀態給出一樣的決定」。Gate：`test/handoff-conformance.test.ts` 以表格驅動（沒有專案、identity 改寫中、401、port 不見、spool 已存在同名檔、WSL 舊目錄），對 sh、ps1（可用時）、python client 各跑一次，斷言「送出／spool／丟棄」與 spool 檔內容一致。

**遷移步驟。** 1) 先寫 spec 與 conformance 測試，把現有行為照實記錄下來（不一致的地方標 `test.fails`，列入待辦）。2) TS 寫入端改用原子寫入（讀取端不用改，是純改善）。3) 抽出 python client，mitm／pcap 先換（兩者最像），再換 relay 與 session。4) 把 sh 端的 5 處 identity 讀取收斂成一個函式。5) 引入 `REDLOG_HOME`，e2e 改用它，不再改 HOME。
**影響範圍。** `hooks/*`（已安裝在操作員機器上的 hook 要能跟新 App 共存：spec 要規定 N-1 版本相容，`hook-update-mixed-version.test.ts` 已有這種形狀）、`main/index.ts`、`api-server.ts`。Windows／WSL 是主要風險面。
**風險。** 已安裝的舊 hook 讀到新格式的 identity 檔（欄位只能加不能改）；python client 被打包時漏檔（`verify:package-resources` 要列進去）。
**驗證。** conformance 測試；Windows 與 WSL 真機（CI 的 e2e 只跑 ubuntu，CLAUDE.md 已說明這個盲區）。

---

### F4. 因果關係只存在於雜湊過的 JSON 欄位裡：資料模型撐不起「cause chain 是差異化」

**機制。** 邊只有一種表示法：`data._causes`（在 hash 內、不可變），外加 `data.related_commands`（候選提示，有 `method` 標籤）。沒有 edge 表，`_causes` 也沒有索引（`db/index.ts:192-410` 的所有 `CREATE INDEX` 都沒有它）。

**實例。**
- `event-queries.ts:845-871 queryEffectsOf`：對 `events` 與 `events_logged` 逐列 `json_each(json_extract(e.data,'$._causes'))`；`queryEventCausalChain`（893-958）每一層深度呼叫一次，最多 20 層；而且用的是 `getDB()`（寫入連線，`:847,829`），不是 `getReadonlyDB()`。Timeline 的 focus chain（`Timeline.tsx:1044`）和 `CausalGraph.tsx:262` 每次換錨點都會觸發。語料大半在 logged 層（ARCHITECTURE「兩層事件表」），因此代價和總列數成正比，還會跟擷取寫入搶同一條連線。（實際耗時 UNCONFIRMED：需要拿 1M 列的 logged 層量 `causalChain`，同時觀察寫入延遲。）
- 邊只能在 ingest 當下產生：`socket-attribution` 要在 HTTP 事件到達**之前**就已經從 connection／process monitor 看過 port→pid→ppid（`socket-attribution.ts:1-42`）。這兩個 monitor 都在預設關閉的 `hostMonitors` pack 裡（`capture-packs.ts:21-24`），macOS 也拿不到 socket owner。晚到的 pid 資訊可以構成確定的關聯，卻沒有地方存：`_causes` 已經在 hash 裡，設計文件 DESIGN-plugin-kernel §4 第 2 點「追加衍生列」也沒有實作。
- 結果就是：預設設定下，「指令 → HTTP」的邊只在 managed proxy 加上連線監看都開著、而且在 Linux／Windows 上才存在；而現有的反查成本會跟著專案規模線性成長。

**為什麼這不只是效能問題。** 產品規則是「保守、正確優先於聰明」。這條在現有程式裡守得很好（`relatedCommandCandidates` 只是標記好的提示，不寫進 `_causes`；`socket-attribution` 不猜）。但正因為保守，確定的邊常常要等到事後才知道，而模型沒有地方追加它。

**結構改動。**
- 新增**衍生、可重建**的 `event_edges(cause_id, effect_id, kind, method, evidence, created_at)` 表，兩個方向都建索引。它不是證據，跟 cast／body index 屬於同一類：要嘛放在主 DB 但不上鏈，要嘛放在獨立的 index DB。
- ingest 寫入後，從 `_causes` 填入（`method='producer'|'flow_id'|'pid'`），也從 `related_commands` 填入（`kind='hint'`，UI 仍然只把它當提示）。
- 事後確定的關聯（晚到的 pid／ppid、port 對應）寫成 `kind='late-deterministic'` 的 edge，並附一列上鏈的 `system.edge_added` 事件，記錄是哪兩列、用什麼方法、依據是什麼。這和 marker amend 是同一個模式：證據只追加，不改寫。
- `queryEffectsOf` 與 `queryEventsByIds` 改走 edge 表與唯讀連線；`_causes` 的 JSON 掃描只留給重建 edge 表用。
- 不變式：「edge 表 = `_causes` ∪ hint ∪ 已上鏈的 `edge_added`」，可以從頭重建，並有一致性測試把它釘住。

**遷移步驟。** 1) 建表，開專案時背景回填（比照 cast backfill：可中斷、可 signal 取消）。2) 讀取改走 edge 表，回填未完成時退回舊查詢（並在 UI 標示「索引中」）。3) 加上 `edge_added`（新的 system subtype，要寫 spec，並更新 bundle verifier 的已知型別）。
**影響範圍。** `db/index.ts`（新表）、`ingest.ts`、`event-queries.ts`、`socket-attribution.ts`、bundle export（要決定 `edge_added` 是否、以及如何進 bundle）。舊專案在第一次開啟時回填。
**風險。** 回填耗時（可參考 #695 body index 的切片做法）；`edge_added` 會改變 export 的事件集合，屬於契約變更。
**驗證。** 等價：同一個 DB 上，新舊 `causalChain` 結果一致；效能：1M logged 列下的 p95；真機：Linux 上開 hostMonitors 跑 sqlmap。

---

### F5. 讀取面：SQL 層已統一，但即時納入、snapshot、完成度訊號仍由每個畫面自己決定

**現況（先講好的部分）。** `buildTierWhere` 加上 `queryTierPage` 已經是共用的兩層 union 與 cursor 核心；`executeEventQuery`（`event-queries.ts:1235`）、`queryEventsPage`、`countEvents`、`spanEvents`、`matchEventIds`、`compileEventSelection` 都走同一組 predicate；Activity 透過 `compileEventSelection` 共用 selection；export 以 `selectedEvidenceDigest` 驗證 preview 與 execute 一致（`export-planning.ts:117,137`）。記憶裡「每個畫面各自 capped query 加 client filter」那條筆記，對 SQL 層已經過時。

**剩下的分歧（實例）。**
- 即時納入有 6 種寫法：Timeline 用 `matchIds` 回 server 判斷（`useTimelineLive.ts`）；`LootPanel.tsx:134` 有任何 loot 事件就整頁重讀；`HttpHistoryPanel.tsx:306` 有 scanner 事件就重讀；`ScreenshotsView.tsx:213` 在 client 端用自己的 trigger 過濾後 prepend；`TranscriptView.tsx:595` 重讀 head；`ActivityResults.tsx:74` **每來一個事件就把「N 筆新的」加 1**，不管它符不符合目前的查詢，也不管是不是 housekeeping，所以這個數字對操作員來說是錯的。
- snapshot 有兩種型別：`ExportSnapshot`（只有 rowid 上界，`export-plan.ts:21`）和 `ActivitySnapshot`（另外有計數與尾端 id，可以偵測 retention 刪列，`activity-contract.ts:10`）；`executeEventQuery` 用 `'chainedCount' in snapshot` 執行期判斷是哪一種（`event-queries.ts:1243,1250`）。
- 完成度：`GET /api/events`（`api-server.ts:424-425`）有上限，回 `{count: events.length}`，沒有 `hasMore` 或 cursor，違反 constitution IV；`ActivityAround`、`FirstRunView`、`active-pivots`、`ipc/artifacts` 還在用舊的 `queryEvents`（後三者是有界的提示，見「刻意」）。
- engagement 過濾不一致（見 F2）。
- 進行中的 #701 `useLivePagedQuery` 收斂了 HTTP／loot／screenshots／target evidence 四個畫面的 renderer 端形狀，但納入的判斷仍在各畫面的 predicate 裡。它處理的是形狀，不是「納入由 selection 決定」這件事。

**結構改動（最小 primitive 集）。** 所有畫面都只用這五個建構：
1. `select(request) → Selection`（已存在：`compileEventSelection`）
2. `page(selection, snapshot, cursor)`（`queryTierPage`）
3. `count/span(selection, snapshot, cursor)`（已存在）
4. `admit(selection, eventIds) → ids`：即時事件是否屬於這個 selection，交給 server 判斷（已存在：`matchEventIds`）
5. `aggregate(selection, groupBy)`：`aggregateTargets`／`distinctHosts` 改成接受 selection

snapshot 收斂成一種：以 `ActivitySnapshot` 為準（它比較強），`ExportSnapshot` 變成它的子集別名。
不變式：「畫面看到的列數、『N 筆新的』、export preview，對同一個 selection 與 snapshot 給出同一組列」。Gate：一支測試掃 `src/renderer`，`onNewBatch` 的回呼裡不得出現 `agentType ===`／`subtype ===` 的判斷（納入一律走 `admit`）。

**移動順序。** ActivityResults 的新筆數改用 `admit`（影響最直接、最小）→ `GET /api/events` 補 cursor 與 `hasMore`（外部契約，要更新 `api-reference.md`）→ `ActivityAround` 改用 `page` → 等 #701 合併後，把 Loot／HTTP／Screenshots 的 predicate 換成 `admit` → Timeline 放最後（R4：同一組 query 加 snapshot 要給出同一組列）。
**風險與驗證。** `admit` 的成本（每批一次 IPC，Timeline 已經在這樣付）；等價測試：每個畫面在改動前後，對同一個 fixture DB 的列集合相同。

---

### F6. Spec 與 gate 守的不是正在變的那些地方

**實例。**
- Draft spec 底下已經有大量出貨程式碼：052（31 個 commit、38 處程式引用、已有 `verification.md`）、069（11 個 commit、35 處引用）、064（17 個 commit）、060、061。`specs/README.md` 明說「Draft 可包含已合併的局部實作」，所以這不算違規；但它代表 Draft 這個狀態對於「哪些行為已經是契約」沒有提供任何資訊。依 CLAUDE.md 的「Changing behaviour」，改這些行為時，沒有任何 spec 會被認定為「必須一起改」。
- 沒有任何 spec 負責的高頻變動區：專案 runtime（R1a／b／c 三輪、上面列的 8 個以上切換修正，只有 design doc）、ingest 的階段順序（R2 的 characterization 測試存在，`test/ingest-characterization.test.ts`，但沒有 spec）、交接目錄（F3）。
- `verify:architecture` 以識別字名稱計數（`scripts/verify-architecture.mjs:19-22` 自己承認名稱撞到會漏）：`api-server.ts:110-116` 的 `castProbe` 與 `castOffsetAtStart` 只寫不讀，屬於死掉的狀態；`main/index.ts:823` 仍在呼叫 `setCastProbe`，而 `ingest.ts` 裡有同名變數，所以 gate 看不到。
- `test/canonical-ingest-sources.test.ts` 用的是**檔案 allowlist**（10 個檔），新加的 producer 不在保護範圍內；`insertEvent` 的直接呼叫者（30 處）沒有被列為「可識別的例外」（Spec 003 FR-004 的要求）。
- 沒有分層方向的 gate：`renderer/lib/terminalFlow.ts:3` 從 `main/` 做 value import，目前沒有東西會擋。
- `PluginKind` 接受 `'mapper'` 與 `'exporter'`（`plugins/manifest.ts:135`），但沒有任何程式碼處理這兩種：manifest 驗證通過，然後什麼都不做。這是 schema 宣告了能力，背後卻沒有行為。

**結構改動。**
- 把 `canonical-ingest-sources` 反過來：`insertEvent(` 在 `src/**` 一律禁止，只有 allowlist 列出的系統寫入者可用（每項附理由），新檔預設被擋。
- `verify:architecture` 加上：(a) 分層方向（core 不得 import main 或 renderer，renderer 只能 type-import main）；(b) F1 的 module 層可變狀態 allowlist；(c)「只寫不讀」的 module 層變數（AST 上找沒有讀取的 binding）。
- 新增兩份 spec：Project Session（承接 `DESIGN-project-runtime.md` §2–3，F1 與 F2 的不變式寫在這裡），以及 Producer Handoff（F3）。
- `PluginKind` 先刪掉 `mapper`／`exporter`，等真的實作時再加回來。
**驗證。** gate 自身的反向測試（放一個違規檔，gate 要失敗）。

---

## 目標結構：承重改動（依相依順序）

| # | 改動 | 建立的不變式 | 刪掉的東西 | 相依 | 落地方式（main 每步可出貨） | 實現／取代 |
|---|---|---|---|---|---|---|
| T0 | gate 補強（F6） | 新 producer 預設不得直接寫入；分層方向；專案範圍狀態要登記；沒有只寫不讀的狀態 | 檔案 allowlist 的 ingest 測試；api-server 的死狀態；`PluginKind` 裡未實作的兩種 | 無 | 先以「現況全列」的 allowlist 讓 gate 綠燈，之後清單只會縮短 | Spec 030、003 FR-004 |
| T1 | 核心蓋身分（F2） | 新列的 engagement／operator 等於 session；讀取面不以 engagement 過濾 | 約 35 處身分參數；api-server 的身分拷貝；`ActivityAround` 的逐列檢查 | T0 | 先統一讀取 → 寫入時拋錯 → 機械刪參數 | R1c 延伸；DESIGN-project-runtime §2b |
| T2 | `ProjectSession` + 有序的 `ProjectResource[]`（F1） | 專案範圍狀態只在 session 擁有的物件裡；start 與 stop 是同一份清單 | `stopProject` 本體；`reset*`；ingest 等處的 generation 懶重設；`linkTimer` 等孤兒 | T0、T1 | 一個 PR 移一個 service，附切換測試 | 完成 R1b；取代 §2「Not a resource registry」 |
| T3 | `ConfigView`：快取、帶版本、統一一個套用點（`apply(diff)` 由 session 派發給 resources） | 一個設定值在所有消費者生效的時刻相同 | 33 處 `loadConfig()` 即時讀（只留 session 建立時的那一次）；`saveProjectConfig` 裡手寫的 configure 清單 | T2（進行中的「one config apply path」應直接做成這個形狀） | 先讓 `ConfigView` 包住 `loadConfig`，再逐一把消費者改成讀 view | R6「settings write controller」 |
| T4 | 交接目錄契約 + `handoff-dir.ts` + `redlog_client.py` + conformance 測試（F3） | 每個 client 對同一狀態做出同一決定；寫入是原子的；根目錄可注入 | 散落的 `.redlog` 路徑常數；mitm／pcap／relay／session 各自的 POST 與 spool 實作 | T0 | 先寫 spec 與測試（記錄現況）→ 原子寫入 → 逐個 client 換 | 新 spec；DESIGN-core-and-capture 的 producer 邊界 |
| T5 | 查詢 primitives（F5），之後接 edge 索引（F4） | 每個畫面的列集合、新筆數、preview 對同一 selection 與 snapshot 一致；因果反查有索引 | 各畫面自己的納入 predicate；`ExportSnapshot` 這個獨立型別；`queryEffectsOf` 的全表掃描 | T1（engagement 過濾已統一）；#701 | ActivityResults → API → Around → #701 的畫面 → Timeline；edge 表先回填、讀取有退路 | R4；Spec 017／026／053；DESIGN-plugin-kernel §4-2 |

R2（ingest 階段明確化）與 R3（`api-server` 依能力拆分）不列為承重改動，理由見下。

## 不值得做的（以及原因）

- **把內建來源改成 plugin、`POST /api/ingest` 加 mapper 管線。** Spec 027 已經移除 code host；`capture-packs.ts:7-9` 的理由（把行程內 service 搬出去會碰到證據路徑，又換不到隔離）仍然成立。真正的重複在交接契約（F3），不在「是不是 plugin」。mapper 現在沒有第二個消費者，做了只是多一層。
- **依行數拆 `Timeline.tsx`（2910）或 `main/index.ts`（2204）。** `main/index.ts` 的體積主要來自 F1 的三份清單，T2 做完它自然會縮；先拆檔只會把三份清單分散到更多檔案。Timeline 該依資料責任拆（R4，T5 之後），不是依長度。
- **R3：把 `api-server.ts` 依能力拆檔。** 現在的路由表加上 409 recheck 是集中的，可讀性也還行；它真正的問題是持有身分拷貝和死狀態，T1 與 T0 會處理。在那之前拆，反而會把「一個不可跳過的入口」這個不變式拆散。
- **把 R2 做成框架化的 stage pipeline。** `ingest()` 的順序已經寫在一個函式裡（`ingest.ts:132-375`），也有 characterization 測試。值得做的只有 T0 的反向 gate，加上 F2 的蓋章。
- **`src/core` 整批搬進子目錄、建 barrel、拆掉那個 17 檔的循環。** 循環在 TS 底下是無害的（只有 `http-body-index.ts:116` 需要延後解析），搬目錄修不到任何一個缺陷；架構文件 §10 也已經拒絕依外觀整理目錄。
- **DI container 或全域狀態 store（renderer 或 main）。** 問題在擁有權與生命週期（F1），不在注入的語法；一個 `ProjectSession` 物件加上明確的陣列就夠了。
- **edge 表上鏈，或改寫既有的 `_causes`。** evidence schema 不能在重構裡改；edge 表是衍生資料，事後確定的關聯以追加上鏈事件記錄。

---

## 已檢查、確認健全

- 分層：core 不 import electron；core→main 只有一條 type-only（`http-autostart.ts:15`）。
- Scope 分類已統一：renderer 的 `lib/scope.ts`、`scopeInput`、`scopeTest`、`TimelineDetailBar` 都委派給 `core/scope-evaluator`（Spec 023 Verified，程式碼一致）。
- 秘密樣式只有一張表，有 golden 測試（`secret-patterns-golden.test.ts`，Spec 025）。
- `ingest()` 的順序與 pause、plumbing、跨專案拒絕都在同一個函式裡；spool replay 已經走 ingest（`main/index.ts:931`）。
- 時間鄰近只當提示，沒有當成因果：`relatedCommandCandidates` 只寫 `related_commands`，附 `method`／`state`（`causes-resolver.ts:187-207`）；`socket-attribution` 明文不猜；`ActivityAround` 只在共享 key 成立時才標出關聯（`ActivityAround.tsx:20-21`）。
- Export 的 preview／execute 以選取證據的 digest 加政策 fingerprint 驗證（`export-planning.ts:117-140`），符合 constitution V。
- 路徑包含判斷：`paths.ts isInsideDir` 加 `contained-file.ts` 是共用的；在它們之外自己寫 `path.relative` 的只有 `export-runner.ts:69` 與 `tailer-host.ts:1507`，都是局部用途。
- API 路由在專案關閉時有 `projectOpen` 閘門（`api-server.ts:287`），寫入路由有 409 recheck；`configureApi` 的 ref 雖然不會清掉，但不會被用到。
- 終端 enrollment 狀態機的雙實作（TS 與 relay.py）有 agreement 測試（`terminal-enrollment-agreement.test.ts`）。注意：沒有 shell 目標時它會 `describe.skip`。
- starter-pack 的 fallback 拷貝有 parity 測試（`test/starter-pack.test.ts`）。

## 刻意的設計（附依據）

- `active-pivots.ts` 只看最新 40 列 pivot 加 30 分鐘窗口：HUD 用的有界啟發式，註解寫明了原因（`active-pivots.ts:6-25`）。
- `ipc/artifacts.ts:31` 用 ±窗口抓 5000 列 shell 當 `related_commands` 的候選：明確標示為提示，不寫進 `_causes`。
- 終端在專案切換後永久停止、`redlog start` 也解不開：FR-010（`shell-common.sh:303-326`）。
- 可選 pack 的程式碼留在 core：Spec 027 與 `capture-packs.ts:7-9`。
- `stopProject` 的順序是契約（DESIGN-project-runtime §2）；T2 要保留它，不是消滅它。
- `capture-health` 的累計 DB 錯誤數以 app session 為範圍（`capture-health.ts:207-211` 的註解）。它跨專案帶過去這件事，列在 F1 是因為 UI 是以專案為單位呈現；是否算缺陷，要看產品決定。

## 未確認（UNCONFIRMED）以及怎麼確認

- `queryEffectsOf`／`causalChain` 在大型 logged 層的實際耗時，以及對寫入延遲的影響：用 1M logged 列的 fixture，量 `causalChain` 的 p95，同時跑 ingest 量寫入延遲。
- air-gap 只套一半在真機上的表現：開專案 → 把 `config.yaml` 的 `network.offline` 改成 true → 在 Settings 存任一項 → 5 分鐘內用 `lsof -i`／`nettop` 看有沒有 NTP（udp 123）與更新檢查的連線。
- `ActivityAround` 的 denied：在連不到 OTS calendar、沒開 air-gap 的機器上跑滿 1 小時，打開錨定失敗時間點附近操作的「前後」面板。
- `emitThinking` 等 tailer 設定存檔後是否生效：讀 `applyCapturePacks` 傳給 `configureAgentTailer` 的欄位。
- 工作目錄裡的 `plugins/pack-ai-agents/`（未追蹤的空目錄）被 `verify-packaged-resources.mjs:71` 列為禁止項，所以從這個 checkout 做 release build 可能會失敗；這只影響本機，不是程式缺陷。
- tailer-host 在寫入前就改寫秘密（`deepRedactStrings`，`tailer-host.ts:567`），而 ingest 只記錄 span 不改原文：這兩種遮蔽模型並存，是否違反 DESIGN-plugin-kernel §4「最大的失真來源」，要與 redaction 審查者以 `docs/redaction-design.md` 核對（原始 JSONL sidecar 仍保留原文）。
