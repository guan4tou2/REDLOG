# 01 — Capture integrity（擷取完整性）根因審查

基準：`main` @ a087c16c（2026-11-12）。唯讀審查；沒有執行 app，也沒有寫測試。下文的「已確認」都是由程式碼路徑逐行推得；需要實跑才能確認的，標成 UNCONFIRMED。

## 摘要（10 行）

1. **「這筆已持久記錄」沒有統一定義。** `ingest()` 只回 `event | null` 加上一個會混在一起的 `skipped`，API 再把它壓成 201/200/409。目前至少有 8 個 producer，各自用不同的表解讀這個結果，所以同一種拒絕，在 shell 會進 spool、在 mitm 靜默丟棄、在 relay 算成「已收」。
2. **沒有 producer 端的冪等鍵。** 去重只靠 chained tier 上 2 秒的內容啟發式；spool 重放、relay 重送、tailer 重試三條 at-least-once 路徑各自發明自己的身分，或根本沒有，所以會重複寫入，或把重複丟掉後又被 spool 救回來。
3. **遺失的計帳和資料走同一條會遺失的通道，而且每條路徑各有一套。** shell spool 滿 5000、磁碟滿、`.bad` 隔離、relay final row 被拒都沒有計數也不會出現在 UI；Reader 甚至會把已結束的指令永遠顯示成 running。
4. **暫停邊界每條路徑各實作一次，判準不同。** crash-while-paused 期間被 spool 的 shell 指令會在重開時被重放進紀錄，違反 DESIGN-capture-trust §3；暫停前就已 spool 的 `command_end` 則被當成暫停內容永久卡在 spool。
5. **身分欄位（engagement／operator／terminal／target）由各 producer 在不同時間點自行推導。** 重放與重啟後的 row 會拿到「現在」的 active target，鏈上還會被蓋上錯誤的 `unattributed` 標記。
6. **完整性詞彙沒有收斂。** relay 用 `completeness`，tailer 用 `truncated`，content reader 讀 `$.<field>_truncated`。AI 訊息被截斷時，reader 會顯示成完整；描述子也永遠無法說出「complete」。
7. **「ingest 是唯一入口」只有一半成立。** 還有 30 個直接 `insertEvent` 的呼叫點；`/api/ingest`（raw first）從未實作；envelope 的 `source`／`raw_ref` 大多是 null；spool 重放繞過 API 的外部事件政策。
8. 結構答案：**需要一份 ingestion contract**，至少包含 envelope（producer id、版本、producer event id、observation identity、observed_at）、receipt（列舉式結果，1:1 對到傳輸層）和 loss ledger（獨立於資料通道的遺失紀錄）。所有 producer 共用一個小型 client 規格（sh／py／ps1／js 各一份，從同一張表產生），用 contract test 鎖住。
9. 目前程式離這個 contract 的距離：mitmproxy 路徑最接近，已有 gap 紀錄、in-flight marker、不重放內容；tailer 次之，已做到 progress-after-persist 和 uuid 去重；shell／spool、pcap、c2、PowerShell send 最遠。
10. 已確認健全：two-tier 讀取一致、chain head 快取、foreign-engagement 提早拒絕、tailer 的 pause 和 checkpoint。詳見末節。

---

## 排名後的發現

### F1. 沒有統一的「已記錄」回執：ingest 的結果被壓縮，每個 producer 各自猜

**機制。** `ingest()` 回傳 `{ event, skipped?: 'paused'|'dedup'|'plumbing'|'unrecorded' }`（`src/core/ingest.ts:108-117`）。其中 `'dedup'` 同時代表四件不同的事：

- 真的落在 2 秒去重窗內；
- foreign engagement 被拒（`ingest.ts:142-146`，註解自承「Reported as `dedup`, as it always was」）；
- `insertEvent` 內部的暫停閘（`event-write.ts:452`）；
- `insertEvent` 的 engagement 不符（`event-write.ts:460-464`）。

API 再壓一次（`api-server.ts:398-413`）：`paused` 和 `unrecorded` 回 200，帶 `recording:false`；**`dedup` 和 `plumbing` 一律回 409 `"Duplicate event (dedup window)"`**。另一路 409（`engagement changed`）用的是不同的 body 字串。

各 producer 解讀同一組回應的方式（每一列都已讀過程式碼）：

| producer | 2xx | 409 dedup | 409 engagement | 其他 4xx | 5xx／網路 |
|---|---|---|---|---|---|
| shell hook `_redlog_send_event`（`shell-common.sh:828-894`）| 完成 | `curl -f` 失敗 → **spool 全文** | spool 全文 | spool 全文 | spool 全文 |
| relay late／foreground output（`redlog-relay.py:315-344`）| accepted；`recording:false` → 丟並計數 | **accepted**（不計遺失）| refused → 丟並計數 | refused → 丟並計數 | 重試，最多 64 筆後丟 |
| mitmproxy addon（`mitmproxy-addon.py:554-562`）| 完成 | **靜默丟棄、不記 gap** | 同左 | 同左 | 只記 `capture_gap`（不重放內容）|
| pcap-agent（`hooks/pcap-agent.py:118-129`）| 完成 | spool 全文 | spool 全文 | spool 全文 | spool 全文；**沒有 port 時直接 return、不 spool** |
| c2-tail（`plugins/c2-tailers/follow.js:62-67`）| ok | drop，寫一行 stderr | drop | drop（401/408/429 除外）| retry；offset 只存在記憶體 |
| `redlog-send.ps1:55-58` | — | `catch {}` | `catch {}` | `catch {}` | `catch {}`（fire-and-forget）|
| tailer（in-process，`tailer-host.ts:845-848`）| `ev` 非 null | `!ev` → throw，重試 | — | — | — |
| spool 重放（`main/index.ts:931-940`）| 刪檔 | **視為已存在而刪檔** | （同 dedup）| — | 例外 → `.bad`（見 F3）|

**實例。**
- (a) relay 遇到 ingest 內的 foreign-engagement 拒絕，收到的是 409 `Duplicate`，於是當成 accepted，遺失沒有計入 `dropped_bytes`。header 版本的 409 則會被計入。兩者是同一個事實，卻得到兩種帳。
- (b) shell 收到 409 dedup 會 spool；重放時 `insertChainedEvent` 的去重窗是 `timestamp >= now-2000`（`event-write.ts:536-539`），而 spool row 的 `timestamp` 是原本的 source time，早已在窗外，所以**一定寫入**。2 秒去重在 shell 路徑上等於「延後 30 秒、加上 📮 標記再寫一次」。
- (c) shell 的 fast builder 期限只有 1 秒（`shell-common.sh:832`），而 API 和 main thread 共用一條執行緒（`main/index.ts:951`；已知「首次搜尋 stall main thread」）。curl 逾時後 app 仍會處理已收完 body 的 request，同一筆就**同時被寫入又被 spool**，30 秒後重放出第二筆（UNCONFIRMED，見末節）。
- (d) mitm 的 4xx 不算 gap：「A refusal … must never be replayed」是刻意的，但它也沒有被記成 gap。HTTP 層的遺失帳因此在 4xx 上有洞。

**為何過去的修補只治標。** #685 修 `terminalId` 去重、#410 修 late chunk 去重、`69c93423` 讓 foreign row 提早拒絕、`b3f5b654` 讓 spool 改走 ingest，每次都是補一條路徑上一個 case，從沒有修正「結果列舉」本身。`api-server.ts:409-410` 的註解「the only way to reach here with no event is the 2 s dedup window」在 `69c93423` 之後已經不成立。

**結構改動。**
- 新增 `IngestReceipt = { outcome: 'recorded' | 'duplicate' | 'refused', reason: 'paused-interval' | 'terminal-not-recording' | 'foreign-project' | 'policy' | 'plumbing' | 'malformed', eventId?, existingId? } | { outcome: 'failed', retryable: true }`。`ingest()` 一律回傳它，**刪掉** `skipped` 和 `ingestEvent` 的 `| null` 語意。
- API 回應以 `outcome`／`reason` 欄位為準；HTTP status 固定對應：recorded=201、duplicate=200、refused=422 加 reason、failed=503。producer 只讀 `outcome`，不讀 status 或錯誤字串。
- 一份 `docs/design/` 的 receipt 表，加上四個語言的小 client（sh／py／ps1／js）。每個 client 只有一個決策函式：`recorded|duplicate|refused → 完成（refused 寫 loss ledger）`、`failed|網路 → 交給持久佇列`。
- 不變式：producer 的決策只依 receipt，不依 HTTP status 或文字。
- Gate：`test/ingest-receipt-contract.test.ts` 列舉每個 `reason`，對每個 producer 的 client 斷言決策；再加一個 grep gate，禁止 hooks／plugins 出現 `error.code ==`、`curl -f` 和 `"Duplicate event"` 字面值。

**遷移。**
1. ingest 內部改回 receipt，`ingestEvent` 保留為薄包裝。行為不變。
2. API 在現有 status 之外**加上** `outcome`／`reason` 欄位。舊 hook 仍可運作。
3. relay、mitm、c2、pcap 改讀 `outcome`（依賴 F2 的 duplicate 語意）。
4. shell 改成：拿到 `refused` 時不 spool，寫 loss ledger（F3）。
5. 移除舊的 status 對應。

**影響範圍。** `ingest.ts`、`api-server.ts`、全部 hooks／plugins producer、`tailer-host.ts`、`main/index.ts` 的 drain。磁碟資料不需遷移。已安裝的舊 hook 在第 2 步之後仍相容；`refreshInstalledHooks` 只更新檔案，活著的 shell 要重新 source 才會換到新邏輯（見 F7）。

**可能出錯。** PowerShell 5.1 的 `Invoke-RestMethod` 遇到 4xx 會丟例外，要用 `-SkipHttpErrorCheck`（7+）或改用 `Invoke-WebRequest`。WSL 下 curl 是 Windows 原生版。

**驗證。**
- 單元：receipt 列舉 × client 的決策表。
- 等價：舊 hook 對新 API 的 golden 測試。
- 真實 app：人為 stall main thread 2 秒，斷言沒有重複 row。

---

### F2. 沒有冪等鍵：at-least-once 路徑靠 2 秒的內容啟發式去重

**機制。** chained tier 的去重是「同 subtype、同 command、同 terminalId（跨型別時用 pid）、2 秒內」（`event-write.ts:517-562`）。只有 `shell`／`agent` 而且帶 `data.command` 的 row 會套用；logged tier 不去重（刻意）。資料庫沒有任何 producer 給的唯一鍵（`db/index.ts` 只有 token 的 UNIQUE）。能重送的路徑各有一套身分：

- relay chunk：`command_id+seq`，存在**記憶體**的 `lateChunkSeen`（`ingest.ts:400-404`）。註解自承「a resend after an app restart is not caught here」，所以把去重推給 reader（`queryCommandOutput` 每個 seq 只留一列）。
- tailer：transcript uuid → `redlogIdByUuid`，啟動時從 DB 播種（`tailer-host.ts:1365`）。**這是唯一做對的一條**，符合 DESIGN-capture-trust §2.3。
- spool 重放：沒有任何身分。
- mitm：不重放，所以不需要。
- c2：offset 只存在記憶體，重啟時從檔尾開始，等於直接跳過。

**實例。**
- F1(b)：shell 遇到 409 會在重放時寫入第二筆。
- F1(c)：逾時造成重複。
- #685：去重鍵 `terminalId`／`terminal_id` 拼法不一致，導致誤丟或不去重。
- 姊妹問題：`causes-resolver.ts:83` 讀 `data.terminal_id ?? data.terminalId`，`event-write.ts:479` 讀 `d.terminalId ?? d.terminal_id`，**優先序相反**。同時帶兩個欄位的 row，兩個模組會認定不同的 terminal。
- 合法的「2 秒內同一 terminal 重打同一指令」會被去重丟掉，靠 spool 才救回來（F1(b) 的另一面）。這正是 DESIGN-capture-trust §2.4 要分開的「刻意忽略」與「遺失」被混成一類。

**為何過去的修補只治標。** 每次都在調整啟發式的鍵（加 subtype、加 terminalId、加跨型別規則），卻沒有引入身分。

**結構改動。**
- envelope 新增 `producer_event_id`（UUIDv7；由 producer **在觀察當下**產生，寫進 spool 檔和 relay chunk）。兩張表都加上 `UNIQUE(engagement_id, producer_event_id) WHERE producer_event_id IS NOT NULL` 的部分索引（只加索引，不違反 append-only trigger）。
- `insertEvent` 遇到衝突時回 `duplicate`，並附上 `existingId`。
- 有 id 的 row **不再**走 2 秒內容去重。shell↔agent 的跨型別「同一意圖」改成在後到的 row 加註 `same_intent_as`，不再丟棄，以符合「不把未擷取說成沒發生」。
- `lateChunkSeen` 刪除（由唯一索引取代）；causes-resolver 和 dedup 改讀同一個 `terminalIdOf()`。
- 不變式：同一個 producer event 最多一列；沒有任何 row 因內容相似而被丟。
- Gate：fault-injection 測試，讓 ingest 寫入成功但回應丟失、重送後斷言只有 1 列；再加 lint，禁止在 `src/core` 以外讀 `terminal_id`／`terminalId`。

**遷移。**
1. 加欄位與索引（舊 row 為 NULL）。
2. hooks、relay、mitm、pcap、c2、tailer（用 `transcript_uuid`）開始送 id。
3. 對帶 id 的 row 停用內容去重。
4. 觀察一個版本後，只對沒有 id 的舊 hook 保留啟發式。

**影響範圍。** `event-write.ts`、`db/index.ts` migration、所有 producer。舊專案只多一個索引，建立索引要掃全表，大專案開啟時間需量測。跨平台：PowerShell 和 Git Bash 都需要產生 UUID（`[guid]::NewGuid()`、`/proc/sys/kernel/random/uuid` 或 python）。

**驗證。**
- 單元：衝突時回 duplicate。
- 等價：一般流程下新舊兩條路徑寫出的 row 數相同。
- 真實 app：stall 注入，以及同一指令連打兩次（兩筆都要在）。

---

### F3. 遺失計帳分散成四套、走在會遺失的通道上，且多處完全不計

**機制。** 各路徑的遺失紀錄：

- HTTP：`capture_gap` spool 紀錄，加上 nonce 保護的 log 行，最後是 `unsavedGapEvents`。
- AI：`system.capture_gap`（僅限暫停）。
- relay：在**最後一筆 chunk** 的 `dropped_bytes`。
- shell：`_REDLOG_UNSAVED`，**只印在終端機**，不進紀錄。
- spool 設置：`.unattributed` 有統計並可清除。

沒有共用的 ledger，而且有幾種遺失根本不計。

**實例（皆已讀碼確認）。**
1. shell spool 達 5000 上限時（`shell-common.sh:869`），`if` 沒有 else 分支：不寫檔、不設 `_REDLOG_UNSAVED`、沒有任何訊息。**靜默遺失。** 磁碟滿或 `mv`／`printf` 失敗（`:877`、`:887`）也一樣。
2. spool 重放的 catch（`spool-replay.ts:146-149`）把**解析失敗**與 **ingest 例外**（SQLite busy、磁碟滿、body sidecar 寫入失敗，即 `http-body-store.ts:69,82` 的 throw）一律改名為 `.bad`，從此不再重試。`.bad` 在 `src/` 裡沒有任何讀取者；`result.invalid` 也沒有被記錄，`main/index.ts:946` 只 log `replayed`。暫時性的寫入錯誤因此變成永久且無人知曉的遺失；被隔離的若是 mitm 的 `capture_gap`，連「遺失的紀錄」都一起遺失。
3. relay 的 final row 帶著 `dropped_bytes`／`late_bytes`，在 `finish()` 只送一次（`redlog-relay.py:360-367`）。暫停中會被 `_drop`，換專案時被 refused，API 不可達時留在 `pending` 直到程序結束，foreground 執行緒 join 4 秒逾時也是如此（`:468-474`，只寫 trace）。reader 端 `summarizeLateOutput`（`renderer/src/lib/lateOutput.ts:17-22`）在找不到 final row 時回 `'running'`，於是**已結束的指令永遠顯示 running，而且遺失位元組數歸零**。`command_end` 上的 `output_stream_dropped` 只是 emit 當下的快照（`:590`），會低估。
4. pcap-agent 沒有 port 時直接 return（`pcap-agent.py:112-116`），`redlog-send.ps1` 用 `catch {}` 吞掉，mitm 的 4xx（F1(d)），c2 重啟時從 EOF 開始（`c2-tail.js:68`）。這些都不留任何紀錄。
5. spool 中被 `deferred`（例如 F4 的卡住檔案）的數量不會出現在任何 UI，而且這些檔案會佔用 5000 的上限。

**為何過去的修補只治標。** #460、#507、#291 把 HTTP 的 gap 做得很完整，`.unattributed` 也有了計數卡（#255），但每一次都只修一條路徑。DESIGN-capture-trust §2.4「三種結果不得互相計入」只在 tailer 實作。

**結構改動。**
- 由核心擁有一份 loss ledger：`~/.redlog/ledger/` 下的 append-only、每筆小型、帶 identity 的 gap 紀錄檔（格式就用現有 `capture_gap` 的 data shape）。所有 producer 都用 F1 的 client 寫入，寫入失敗時退回 stderr nonce 行（沿用 `unsaved-gap.ts` 已有的機制，推廣到所有 producer）。
- spool 上限、spool 寫入失敗、receipt=refused、final row 未送達，都寫成 ledger 紀錄。
- spool 重放把結果分成 `invalid`（→ `.bad`，並寫一筆 `capture_gap reason=spool-unreadable`）和 `failed`（→ 留在原處、退避重試，連續 N 次失敗後在 capture card 顯示）。
- relay 的 final row 改成「先寫 ledger，再送」。reader 對逾時未收到 final row 的指令顯示 `unknown`，不顯示 running。
- 不變式：每個 producer 對每一種非 recorded 的結果，要嘛寫出一筆 ledger 紀錄，要嘛留下 nonce 行。
- Gate：每個 producer 的 fault-injection 測試，包括寫入失敗、上限和拒絕。

**遷移。**
1. spool 重放分流 invalid／failed，並把計數放上 capture card（只改 app 端）。
2. shell 上限分支與 relay final row 先寫 ledger。
3. 其他 producer 跟進。
4. reader 加上 `unknown` 狀態。

**影響範圍。** hooks（全部）、`spool-replay.ts`、`capture-health.ts`、`CaptureHealth.tsx`、`lateOutput.ts`。磁碟上的 `.bad` 舊檔需要一次性盤點：可以在 capture card 顯示數量。

**驗證。**
- 單元：fault injection。
- 真實 app：spool 塞滿 5000、chmod 掉 bodies 目錄、暫停中結束背景 job。

---

### F4. 暫停邊界每條路徑各自實作：spool 會重放暫停中的內容，也會把暫停前的內容永久卡住

**機制。** 目前「這筆是否落在暫停期間」有四種判法：

- ingest 的 delayed gate：`outputAt <= max(eventBus.resumedAt, lastRecordingResumeTime())`（`ingest.ts:160-168`），而且只看 `command_output`／`session_output`／`command_end` 和 scanner 的串流 subtype。
- spool drain 只看**重放當下**的 `eventBus.paused`（`main/index.ts:912`）。
- queue gap 用 `pauseIntervals(recordingStateRows())` 判斷，會處理尚未結束的暫停（`queue-gap.ts:22-34`），**但只用在 gap 紀錄上**。
- tailer 自己持久化 `checkpointPaused`／`resumedAt`。

mitm 明確拒絕把內容 spool 起來，理由正是「the app may have paused while the API was unreachable」（`mitmproxy-addon.py:209-211`）；shell 和 pcap 卻 spool 全文。

**實例。**
- (a) **crash-while-paused 期間的內容被重放。** 暫停只存在記憶體（`recording-state-marker.ts`；重開時刻意不延續）。crash 時 `active-identity.json` 不會被移除，hook 便持續帶 identity spool。重開時 `drainSpool()`（`main/index.ts:949`）在寫入 `recording_resumed`（`:1061-1064`）**之前**執行。`command_start` 不受 delayed gate 管；`command_end` 的 `output_started_at` 晚於 DB 裡最後一次 resume，也會通過。暫停期間打的指令和輸出因此進入 chained 紀錄。這直接違反 DESIGN-capture-trust §3「nothing from the pause is back-filled」，以及「Crash during a pause … must all be tested not to pull paused content back in」。tailer 有這項保護，spool 沒有。諷刺的是，同一段時間的 HTTP queue gap 會被 `queueGapAgainstPauses` 判成「暫停中，不算遺失」而丟掉。
- (b) **暫停前的內容被永久卡住。** 指令在 T0（錄製中）結束，`command_end` 因逾時被 spool；T1 暫停、T2 恢復，drain 在暫停期間不跑。T2 之後 drain 時 `output_started_at=T0 <= T2`，結果是 `skipped:'paused'`，emit 回 false（`:940`），檔案留下，每 30 秒重試一次，**永遠如此**。對應的 `command_start` 已經寫入，Timeline 上於是出現一筆永不結束的指令。gate 的判準是「早於最後一次 resume」，而不是「落在暫停區間內」，所以也會誤殺任何早於最近一次 resume 的延遲內容。
- (c) late chunk 在恢復後抵達、但產生於暫停前時，同樣會被誤拒，relay 則把它算成 paused 遺失。

**為何過去的修補只治標。** #460 把區間判斷做在 gap 上，#291 處理 in-flight，`lastRecordingResumeTime` 處理跨重啟的延遲位元組。每一次都只為一種 row 加一個 gate。

**結構改動。**
- 核心提供唯一的 `recordingStateAt(t): 'recording' | 'paused' | 'unknown'`，資料來自持久化的暫停區間（`pauseIntervals`），並把「app 不在」的區間視為 `unknown`：以上次 `session_start` 與 crash 為界，暫停狀態延續到下一個 resume 或 open。
- ingest 對**每一筆**帶 source time 的 row（`occurredAt` 來源，見 `resolveOccurredAt`）套用：
  - `paused` → receipt `refused/paused-interval`，寫 ledger 計數，絕不寫入內容；
  - `unknown` → 依政策處理（建議：寫入，但加註 `recorded_while_state_unknown`）。
- spool drain 不再自行判斷；delayed gate 和 `queueGapAgainstPauses` 都改呼叫同一個函式。
- 另外，重開專案時先寫 recording-state marker，再 drain。
- 不變式：任何 row 的 `timestamp` 落在暫停區間內時，不會出現在 `events` 或 `events_logged`（system／marker 除外）。
- Gate：一個以 property 為基礎的測試，隨機產生暫停區間與帶 source time 的 row，斷言上述不變式；再加 crash-while-paused 的 spool 測試。

**遷移。**
1. 抽出 `recordingStateAt` 並讓 queue-gap 改用它（等價）。
2. ingest 的 delayed gate 改為區間判斷（修 (b)）。
3. 所有 row 都套用（修 (a)）。
4. 調整 open 的順序。

**影響範圍。** `ingest.ts`、`queue-gap.ts`、`event-queries.ts`、`main/index.ts` 的 open 流程，以及 relay 的 paused 計數語意。既有專案中已卡住的 spool 檔會在第 2 步後被正確寫入。

**驗證。**
- 單元：property 測試。
- 真實 app：手動暫停後 kill -9，在終端打指令，重開確認沒有寫入。

---

### F5. 身分欄位各 producer、各時間點自行推導；重放或重啟後的 row 歸屬錯誤

**機制。** engagement、operator、terminal、target 沒有在「觀察當下」統一蓋章：

- shell 在組 payload 時讀 `active-identity.json`（`shell-common.sh:806-811`）。
- mitm 在 request 時 pin，送出前再比對（`mitmproxy-addon.py:143-151, 1375`）。
- pcap-agent 的 live 送出**不帶 identity**，只在 spool 時才讀「當下」的 identity（`pcap-agent.py:80-93`）。換專案期間在途的事件因此會落入新專案。
- c2-tail 完全不帶 identity，落入任何開著的專案。
- relay late output 用 header pin。
- 內建終端機用 `session.identity`。
- operator：live API 用 token 解析出的 operator；spool 用檔案裡的 `_identity.operatorId`。
- **target**：ingest 對 `shell`／`marker`／`screenshot` 在**寫入當下**套用 `activeTarget`（`ingest.ts:251-255`）。

**實例。**
- (a) spool 重放時，`configureIngest({ activeTarget: config.engagement.activeTarget })`（`main/index.ts:828-833`）早於 drain，數小時前的指令會被歸到**現在**的 active target。
- (b) 重啟後，背景 job 的 late chunk 在 `lateTargetByCommand`（記憶體）裡找不到對應，會落到現在的 active target，正好違反 `ingest.ts:235-237` 的註解。
- (c) 同一情境下 `resolveIncomingCauses` 的記憶體 map 是空的，chunk 被蓋上 `data.unattributed = true`（`ingest.ts:194-196`），而且寫進雜湊鏈、**永久無法更正**。但它的 `command_id` 其實對得上已記錄的 `command_start`。這個欄位在 `src/` 裡**沒有讀取者**。
- (d) 重啟後 spool 重放的 `command_end` 沒有 `_causes`，因為 `commandIdMap` 只存在記憶體。
- (e) F2 提到的 `terminal_id`／`terminalId` 優先序相反。

**為何過去的修補只治標。** `1b6fa2c8`、`9614db7d` 讓各模組在換專案時清空記憶體狀態，修好了「跨專案污染」，卻讓「跨重啟正確性」更明顯地依賴記憶體。

**結構改動。**
- envelope 新增 `observed: { engagementId, operatorId?, terminalId?, commandId?, at }`，由 producer 在觀察當下填入（client 規格統一讀 identity 檔一次）。核心只負責驗證，不重新推導。
- `activeTarget` 只在 `occurredAt` 與 receipt 時間相差不到 N 秒，而且不是重放時套用；否則 target 只來自 row 本身，或來自**持久化**的 per-command 狀態（由 `command_id` 查 DB 中的 `command_start.target_id`）。
- `_causes` 和 late target 在記憶體 miss 時，退回 `command_id` 的 DB 查詢（同一 engagement、有索引）。
- `unattributed` 只在 DB 查詢也 miss 時才蓋。
- 不變式：row 的歸屬只由 row 自身與持久狀態決定，與 app 生命週期無關。
- Gate：「重啟等價」測試。同一串事件分別在不重啟、中途重啟、全部經 spool 三種情況下走 ingest，斷言 `target_id`、`_causes`、`unattributed` 全部相同。

**遷移。**
1. 加上 DB 退路。只改核心，行為只朝更正確的方向變。
2. activeTarget 加時間限制。
3. envelope 的 `observed`。
4. 補上 pcap 和 c2 的 identity。

**影響範圍。** `ingest.ts`、`causes-resolver.ts`、`main/index.ts`、hooks、plugins。已寫入的錯誤 `unattributed`／target 無法更正（chain 是 append-only），只能在 reader 端以 `command_id` 重新推導並顯示「記錄時的判斷」與「現在可推得的歸屬」。

**驗證。** 上述等價測試，加上真實 app 中跨重啟的背景 `nmap &`。

---

### F6. 完整性詞彙沒有收斂：producer 寫一套、reader 讀三套，描述子說不出「complete」

**機制。** DESIGN-capture-trust §4 規定「其他來源收斂到 relay 的 `completeness` 詞彙」。實際寫入的欄位：

- relay：`completeness`、`output_disposition`、`limit_hit`、`stdout_truncated`、`output_stream_dropped`。
- tailer：`data.truncated`、`full_length`、`output_length`、`tool_input_truncated`（`tailer-host.ts:776-778, 790-794, 828-833`）。
- mitm：`body.truncated`、`stream_not_queued_bytes`、`stream_state`。
- 內建終端機：`io.truncated`，以及 `completeness='partial'` 加 `output_disposition='project-boundary'`。

讀取端：

- `capturedContentIsPartial`（`content-contract.ts:93-98`）不讀 `completeness`、`output_stream_dropped`、`dropped_bytes`、`tool_input_truncated`。
- content reader 的 `probe`（`evidence-content.ts:52-62`）只讀 `$.<field>_truncated`、`$.<field>.truncated`，以及 cast 的 `completeness`。
- `lateOutput.ts` 讀第三套。
- `completeness` 本身只被 `capture-health.ts:578`（`output_disposition='captured'`）和 cast range 讀取。

**實例。**
- (a) AI 訊息或工具輸出超過 `MAX_FULL_BYTES` 時，tailer 寫 `data.truncated=true`，但 reader 查的是 `$.full_truncated`／`$.output_truncated`，所以拿到 null，`capture='unknown'`，`contentState` 回 `'available'`。**截斷的內容被當成完整顯示。** `TimelineEventDetails.tsx:242` 另外讀 `data.truncated`，兩個介面互相矛盾。（reader 部分已確認；UI 上是否有其他標籤補救則 UNCONFIRMED。）
- (b) `ContentDescriptor.capture` 的型別只有 `'partial' | 'unknown'`（`content-contract.ts:13`），**無法表達 §4 的 `complete`**；relay 明明寫了 `completeness:'complete'`。
- (c) `limit_hit`（哪個上限截斷了）沒有任何 reader 顯示，與 §4「the limit is named」不符。
- (d) relay 的 streamed 指令會刪掉 `command_end` 上的 `stdout`（`redlog-relay.py:591`）。content reader 對沒有 stdout 的 `command_end` 會走 `not-captured` 分支（`evidence-content.ts:137-142`），內容其實在 `command_output` chunk 裡（UNCONFIRMED：Reader UI 可能另由 `queryCommandOutput` 補上，需要點開一筆 streamed 指令確認）。
- (e) `data.unattributed`（F5）同樣是只寫不讀的完整性欄位。

**為何過去的修補只治標。** #591 把 `commandOutputState` 統一成一個函式，#290 加了 `bodyTruncation`。每一次都是為一類欄位加一個讀取函式，卻沒有規定 producer 必須寫什麼。

**結構改動。**
- envelope 新增由核心正規化的 `capture: { state: 'complete'|'truncated'|'metadata-only'|'excluded'|'failed'|'unknown'|'pruned', limit?: string, observedBytes?, keptBytes?, lostBytes?, reason? }`，**每個欄位一份**（`capture.fields[field]`）。
- 由核心依 producer 宣告的事實（registry：每個 `(agentType, subtype, field)` 對應哪個原始旗標）計算；ingest 寫入時一併蓋章，並納入雜湊。
- 所有 reader 只呼叫 `captureStateOf(row, field)`。刪除 `capturedContentIsPartial`、probe 的 `_truncated` 猜測和 `lateOutput` 的自行計算。
- 不變式：每個 output-bearing 欄位都有明確的 capture state。
- Gate：
  - registry 完整性測試：`tier-classifier-total` 的同類測試，所有 producer 實際送出的 `*truncated*` 等欄位都必須在 registry 中；
  - reader 測試：tailer 截斷的 fixture 必須呈現 truncated。

**遷移。**
1. 先寫 `captureStateOf` 去讀所有既有旗標（舊 row 不需 migration），三個 reader 改呼叫它。這一步就修好 (a)。
2. ingest 開始蓋 `capture`。
3. producer 改用統一詞彙。

**影響範圍。** `content-contract.ts`、`evidence-content.ts`、renderer 的多個元件、`export-plan.ts`、`har-export.ts`。磁碟資料不需改動。

**驗證。**
- 單元：每種 producer 截斷 fixture × 每個 reader。
- 真實 app：一則超大的 AI 訊息、一筆 streamed 指令。

---

### F7. 「唯一入口」只成立一半：直接 insertEvent、raw-first 從未實作、spool 繞過 API 政策、hook 版本不可見

**機制。** `ingest.ts:1-17` 宣稱自己是「the one path every event takes」。實際情況：

- 還有 **30 個**直接 `insertEvent` 的呼叫點（`main/index.ts` 11 個、`retention.ts` 5 個、`scope-recompute-run.ts` 3 個、`loot-detector.ts:251`、`alert/surface.ts:58`、`ipc/plugins.ts:57`、`index.ts:455` 的 marker 等），它們要自己記得 publish 和 redaction。
- DESIGN-plugin-kernel §3 的 `POST /api/ingest`（先存 raw、再套 mapper）**從未建立**，`plugins/manifest.ts:19-21` 自承如此。
- envelope 只在 `api`／`spool`／`derived` 三處設定 `source`；所有 in-process producer 的 `source` 和 `raw_ref` 都是 null，`mapper` 一律是 `identity@1`。
- **spool 重放直接呼叫 ingest**（`main/index.ts:931`），不經過 `isExternalEventAllowed`、marker amendment 拒絕或 20 MB 上限（`api-server.ts:338-371, 198`）。

**實例。**
- (a) 任何同使用者程序都能往 `~/.redlog/pending/` 放一個 `agent_type:'system'`（例如偽造的 `recording_resumed`）或 `marker/amended` 檔，取得**經 operator 金鑰簽章的 chained row**。同一筆經 API 送出會得到 403。可信度保證因入口而不同。
- (b) envelope 沒有 producer id 或版本，`refreshInstalledHooks`（`hooks-manager.ts:791-812`）只更新檔案，已載入舊函式的 shell 繼續送舊格式（#685 的 `terminal_id` 就是這種偏移），API 完全看不出來。
- (c) 已知的 hook 遺留問題（`redlog-send.sh:110` 的健康檢查沒有 `--max-time`；python 路徑失敗時靜默丟棄）就是同一份邏輯在 `shell-common.sh` 與 `redlog-send.sh` 各寫一份而產生偏移（docs/WORK-PLAN.md 2026-11-12 補記）。

**結構改動。**
- ingest 成為唯一能寫入 events 的模組：`insertEvent` 改為 module-private，加 lint gate，`src/core/db/event-write.ts` 以外禁止 import。
- system／marker 也走 ingest，以 `derived`／`system` 旗標略過 enrichment。
- 外部政策（`isExternalEventAllowed` 等）移入 ingest，以 `door: 'api'|'spool'|'in-process'` 參數套用；spool 與 api 同等對待。
- envelope 必填 `producer: { id, version }`，hook 從 build 時注入的常數讀取；capture-health 依 producer 版本顯示「此終端載入的是舊版 hook，請重開」。
- raw-first 不一定要做成 `/api/ingest`。至少讓 `envelope.raw` 對 API row 存 request body 的 sha256，以兌現 §3「raw = producer 送來的位元組」，或者修改設計文件，明說不做。
- 不變式：只有一個寫入函式；同一 payload 不論從哪個入口進來，結果相同。
- Gate：`verify:architecture` 加規則，禁止 import `insertEvent`；再加 door-equivalence 測試。

**遷移。**
1. 政策移入 ingest（先修 (a)）。
2. producer id／version。
3. 逐檔把 `insertEvent` 遷移到 `ingest`。
4. 收緊 export。

**影響範圍。** 約 15 個檔案。磁碟資料不需改動。

**驗證。**
- 單元：door-equivalence 測試。
- 真實 app：手動放一個 spool 檔，確認被拒並記入 ledger。

---

## 直接回答題目中的問題

- **有沒有單一的「durably recorded」定義？** 沒有。shell 以 `curl -f` exit 0 為準（含 200 `recording:false`）；relay 以 200 或 409「Duplicate」為準；mitm 以 2xx 為準，4xx 視為完成但不計；c2 以 2xx 為準；spool 以「檔案被 unlink」為準；tailer 以 `ev` 非 null 加 checkpoint rename 為準；pcap 以 urlopen 不丟例外為準。見 F1 的表。
- **at-least-once 與 at-most-once 在哪裡？** at-least-once：shell／pcap spool、relay 重試、tailer 重試、mitm gap 紀錄。at-most-once：mitm 內容、relay final row、c2 跨重啟、`redlog-send.ps1`。去重鍵不一致（F2）。
- **身分是否單點推導？** 否（F5）。
- **專案在動作與記錄之間切換時：**
  - shell：identity 在組包時蓋，API 回 409 後 spool，在原專案重放（正確）；
  - mitm：pin 並記 gap（正確）；
  - relay：用 header pin，計入遺失（正確）；
  - pcap、c2：會落入新專案（錯誤）；
  - 內建終端機：標成 `project-boundary` partial（正確）。
- **哪些遺失有計數？** HTTP（gap 加 `unsavedGapEvents`）、AI 暫停、`.unattributed`、late chunk 的 `dropped_bytes`（但會連同 final row 一起遺失）。不計的見 F3。
- **tiering 是否被誤當成遺失？** 沒有找到這種讀取者：HTTP 和 DNS 的讀取一律讀 `events_logged`（`event-queries.ts:316-318, 1012-1018`）；`getEventCount` 明確只計 chained tier。
- **`completeness`／`output_disposition` 是否每個 producer 都設、每個 reader 都遵守？** 否（F6）。只有 relay 和內建終端機會設；reader 只在 capture-health 和 cast range 讀取。

## 檢查過且健全的部分

- `insertChainedEvent` 寫入失敗時重置 chain head 快取；`insertLoggedEvent` 失敗改為 throw，不回 null（`event-write.ts:652-660, 749-755`）。
- ingest 在任何副作用之前拒絕 foreign engagement（`69c93423`）；`dbGeneration` 讓 ingest 的記憶體狀態跟著專案清空。
- mitm 路徑：不重放內容；每種原因都有 `capture_gap`；in-flight marker 提供上界；nonce 保護的 unsaved 行；spool 檔用 tmp 加 rename，名稱單調。
- tailer：progress-after-persist（`appendAndCommit` 失敗時截回）；uuid 去重從 DB 播種；暫停以 `capture_gap` 記錄並丟棄內容；checkpoint 使用原子 rename；per-message 檔寫入後才建索引（`9bba82d4`）。
- source time 驗證（2015 年下限、未來 60 秒上限），拒絕紀錄會納入雜湊（chained tier）。
- body eviction 以 `system.body_evicted` 記錄，reader 顯示 missing，不顯示不存在。
- 內建終端機的 cast 寫入失敗以 `recordingReason='recording-failed'` 呈現在 UI；跨專案的指令標成 `project-boundary`。
- shell spool 的 `.unattributed` 有計數卡，清除時只刪「已顯示的時間範圍內」的檔案。
- two-tier 分類有 total test；未知的 (agent, subtype) 預設進 chained。

## 刻意設計（不是缺陷）

- logged tier 不去重、不簽章、不做時鐘異常偵測（`event-write.ts:679-694`；DESIGN-two-tier-chain）。
- 暫停不跨重啟（`recording-state-marker.ts`）。F4 的問題在於 spool 沒有遵守這條邊界，不在於這條規則本身。
- mitm 的 4xx 不重放（`mitmproxy-addon.py:555-556`）。不重放是對的；缺的是計數（F1(d)／F3）。
- 無法歸屬的 chunk 標成 `unattributed` 而不猜測（FR-007）。缺陷只在重啟後誤標（F5）。
- shell↔agent 跨型別去重（v0.6.86 註解）。F2 建議改成加註而不丟棄，但原本是有意設計的行為。
- `system`／`marker` 不受暫停影響（`event-write.ts:376-380`）。

## UNCONFIRMED（以及如何確認）

- F1(c) 逾時造成重複：需確認 Node 在 client 已 timeout 斷線後是否仍執行 handler 並寫入。確認方式：整合測試在 handler 前人為 sleep 1.5 秒，用 `curl --max-time 1` 送出，30 秒後斷言 row 數。
- F4(a) crash-while-paused 重放：由讀碼推得（drain 順序、gate 範圍、identity 檔在 crash 時留存）。確認方式：寫一筆 `recording_paused`，放一個 source time 在其後的 spool 檔，模擬 open 流程，斷言沒有寫入。也需確認 crash 後 `active-identity.json` 確實留存（`project-runtime` 清理是否只在正常關閉時執行）。
- F6(a) UI 層：Reader 是否另有標籤補救 AI 截斷。確認方式：用超過 `MAX_FULL_BYTES` 的 fixture 打開 Activity reader。
- F6(d)：streamed 指令的 Reader 是否顯示 not-captured。確認方式：對 `output_streamed` 的 `command_end` 呼叫 `describeEventContent`。
- pcap 在換專案時落入新專案：live 送出不帶 `_identity`，API 只在 body 帶 identity 時比對，由讀碼推得；需用一個簡單的 POST 實測。
