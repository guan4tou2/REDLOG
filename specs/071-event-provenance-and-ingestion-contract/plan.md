# Implementation Plan: 核心蓋章的事件身分與來源、單一寫入契約

**Branch**: `spec/ingestion-contract` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/071-event-provenance-and-ingestion-contract/spec.md`

## Summary

`ingest()` 已經是大多數事件的入口，但有三件事它沒有擁有：

1. 事件的身分與來源由呼叫端自帶；
2. 「已寫入」沒有統一定義，八個來源各自解讀 201、200、409；
3. 遺失沒有帳。

本計畫讓核心在每一列新事件上蓋 `data._ingest`，並沿用既有的雜湊公式，所以舊列與新列走同一條驗證規則。在旁邊加一個逐項回執的入口 `/api/ingest`，舊的 `/api/events` 對舊來源回完全相同的狀態碼。用（來源、`event_id`）永久去重，用序號推導缺口，缺口以既有的 `system.capture_gap` 上鏈。交接目錄改成 `tmp → new` 加隔離區，並用憑證 MAC 與 API 相同的政策關掉 spool 旁路。憑證依能力分級：每個來源只能寫入，舊 token 降級，操作者憑證換到新路徑。

## Technical Context

**Language/Version**：TypeScript（Electron main 與 core）；Python 3（hooks）；POSIX sh（bash 3.2 與 5、zsh）；PowerShell 5.1 與 7；Node（外掛）。

**Primary Dependencies**：better-sqlite3、Node `crypto`、Python `hmac`／`hashlib`、.NET `HMACSHA256`。不新增套件。

**Storage**：專案 DB 新增三張簿記表（`ingest_keys`、`ingest_instances`、`ingest_producers`）、一張可重建的 `terminal_targets` 與兩個可為 NULL 的去正規化欄位；新增機器層級的憑證登記檔；交接目錄。事件表結構、雜湊、觸發器都不變。

**Testing**：Vitest（單元、整合、property、共用向量的驅動）；`tools/redlog-verify.py` 經 Vitest 呼叫；Playwright e2e 只在 ubuntu。真機驗收另列。

**Target Platform**：macOS、Linux、Windows（原生 PowerShell、Git Bash、WSL）。

**Performance Goals**：每項的去重額外工作不超過一次索引查詢加一次插入；`_ingest` 典型不超過 320 bytes；交接排空以有界切片進行（沿用 `drainInSlices`，每片 10 檔）。

**Constraints**：O3（不碰舊列）；O4（不打斷操作者）；成功送達的路徑上，shell 不得多啟動任何行程；憑證不進 argv 與環境變數。

**Scale/Scope**：每專案 10 萬 chained 列、100 萬 logged 列；一個工作天有數千個 shell instance。

## Constitution Check

| 原則 | 判定 |
|---|---|
| I Evidence Integrity | 不改寫舊列；隔離區的清除與憑證輪替、撤銷都寫 chained 列；遺失寫成缺口列。通過 |
| II Surface Truthfulness | 來源狀態分「已證明／自述／無法判斷」；logged 層不得說成已證明；「待確認」與「遺失」分開。通過 |
| III Canonical Semantics | 一個入口、一張種類政策表、一個暫停判斷、一個目標決定規則、一個終端機身分。通過 |
| VI Explicit Failure | commit 原語不再靜默回傳 null；`retry` 與 `rejected` 分開。通過 |
| VII Provenance | 觀察時間、事件時間、收到時間三者可區分；來源在雜湊內。通過 |
| VIII Test-First | 每個階段先寫 RED（tasks Phase 1 與各階段的「先 RED」任務）。須執行 |
| IX Restraint | 新的簿記表、憑證登記、交接格式都解決目前的重複問題（8 個來源各寫一份傳輸契約，07-F3）。不引入框架、不做階段管線框架（07 拒絕 R2）。通過，理由見 Complexity Tracking |
| Workflow | 本功能涉及證據、隱私、跨層契約，實作前須執行 Clarify、Checklist、Analyze 並記入 verification.md（T001） |

## 現況（程式碼確認，2026-11-12，`main@a5e90877`）

- **雜湊輸入**：`event-write.ts:601-631` 對 `{id, timestamp, engagementId, sessionId, operatorId, agentType, hostname, sourceIP, targetId, data, prevHash, createdAt, monotonicNs, ntpOffsetMs, tier:'chained'}` 做 `canonicalStringify`（鍵排序；`undefined` 丟棄；`null` 保留）後取 sha256；Ed25519 簽同一字串。
  - **不在雜湊內**的欄位：`subtype`、`signature`、`raw_ref`、`mapper`、`schema_version`、`ts_source`、`source`、`transcript_uuid`。
  - 接收端早已把事實摺進 `data` 再雜湊：`_raw`（:12-30）、`_clock_anomaly`、`_source_time_rejected`（:596-599）。
  - 兩個 verifier 以固定鍵集合重建（`chain-anchor.ts:514-542`、`redlog-verify.py:141-170`）。logged 層不逐列雜湊，只在匯出時算 digest（:285-319）。
- **API**：`api-server.ts:398-414`。`paused` 與 `unrecorded` 回 200；`dedup` 與 `plumbing` 回 409 `Duplicate event (dedup window)`；ingest 內的跨專案拒絕也被回報為 `dedup`（`ingest.ts:142-146`）。
- **旁路**：spool 重放直接呼叫 `ingest`（`main/index.ts:929-968`），不經 `isExternalEventAllowed`（`api-server.ts:341`）。`.bad` 沒有讀者（`spool-replay.ts:146-149`）。開專案時的排空沒有上限（`main/index.ts:968`）。
- **token**：每個專案一把，鏡像到 `~/.redlog/api-token`（`api-server.ts:909-937`），代表全部能力（:187-191）。shell 每個事件都重讀這個檔（`shell-common.sh:686-691`）。
- **全文索引**：對整個 `data` 的 `json_tree`（含鍵名）建 FTS（`db/index.ts:424-438`）。insert trigger 的文字一改就會觸發全量重建（:439-463）。
- **分層**：未知的（agent, subtype）一律進 chained（`event-write.ts:94-107`）。pcap-capture 的 `scanner.packet_flow`／`pcap_segment` 與 c2 的 `scanner.c2_checkin` 因此目前都是 chained。
- **心跳**：`system.producer_heartbeat` 是被允許的外部 `system` 例外（`external-event-policy.ts:24-40`），pcap-capture 每 15 秒寫一列（`pcap-capture.js:53-58`），capture-health 從 DB 讀它（`capture-health.ts:790-798`）。

## 設計決策

### D1 蓋章放在 `data._ingest`，雜湊公式不變（不引入雜湊版本）

**決定**：接收端把來源資料寫進新列 `data` 的唯一保留鍵 `_ingest`。舊列沒有這個鍵，新列有，兩者的雜湊公式相同。

**用什麼區分版本**：每列的 `_ingest.v`（在雜湊內），加上「同一 `session_id` 的 `session_start` 也帶 `_ingest`」這條規則（FR-022）。後者必要，因為 071 之前的接收端不會移除來源自填的 `_ingest`：舊列上的 `_ingest` 可能是偽造的。而 capture session 是每次開專案時由接收端產生、寫在雜湊內的身分（glossary：「用於 provenance」）。降版又升版時，舊版 session 的列自然被歸為「自述」。

**理由**：

- 兩個 verifier 與已出貨 bundle 內附的 verifier 不需修改就能驗證新列（O3）；
- bundle 的 `events.jsonl` 欄位不變，所有匯出格式自動帶上來源資料；05-F2 抱怨的是 `events.source` 不進雜湊也不匯出；
- 不需要改不可變觸發器的欄位清單；
- 與既有的 `_raw`、`_clock_anomaly` 同一模式。

**否決**：

- **新欄位加雜湊版本（`hash_v=2`，雜湊輸入多一個 `provenance` 鍵）**。舊版或第三方手上的 `redlog-verify.py` 驗新 bundle 時，會把新列判為 BROKEN；兩個 verifier、匯出的 SELECT（`bundle-export.ts:271-275`）、觸發器、bundle 格式都要同步改，與 #711 的 bundle 第 4 版互相牽動。
- **DSSE 式「簽實際位元組」的新列格式**（PRIOR-ART-A §5）。對新格式是正確方向，但屬於 Merkle 與 checkpoint 那一階段的工作，不在範圍。

若之後要改用位元組簽章，再引入真正的列格式版本。

**代價**：`data` 不再純粹是來源的 payload。讀 `data` 的地方要知道 `_ingest` 是保留鍵（見「其他讀者與寫者」）。

> **修訂（2026-11-13，Phase 3 審查 G）**：上面「兩個 verifier 與已出貨 bundle 內附的 verifier 不需修改就能驗證新列」對一般列成立，對**封印列**不成立。封印列（`subtype: export_sealed`）也經由接收端寫入，因此同樣帶 `_ingest`；而兩個 verifier 對封印列的 `data` 採鍵名白名單，071 之前的白名單沒有 `_ingest`（也漏了既有的 `_clock_anomaly`）。所以 071 之前的 `redlog-verify.py` 與 app 內驗證，遇到 071 之後匯出的 bundle 會回報 `UNSUPPORTED: seal version 1 with field(s) _ingest … the seal was not checked`（`redlog-verify.py` 結束碼 2，app 判定 `malformed`）。T021 已把兩個白名單都補上 `_ingest` 與 `_clock_anomaly`（共用向量 `test/fixtures/provenance-vectors`）。
>
> **決定**：接受這個不相容。依 Spec 077 R8（產品未發行，不需要任何相容：不並存版本、沒有棄用期），**不**為此引入雜湊版本或封印版本、**不**讓封印列免蓋章、也不在新 verifier 裡為舊 verifier 留特例。舊 bundle 由新 verifier 驗證不受影響（SC-001、`test/golden-old-rows.test.ts`）。上面的否決理由「舊版 `redlog-verify.py` 會把新列判為 BROKEN」因此只剩「不必改雜湊公式」這一半仍成立。

### D2 身分與時間的蓋章規則

- **專案**：取綁定的 DB（FR-007）。`ingest()` 與 `insertEvent` 的 `engagementId` 參數保留型別相容，但不再作為來源；與綁定值不同時回 `retry`／`foreign-project`。
- **操作者**：見 FR-009，讀機器層級設定（O12）。
- **時間**：沿用 `timestamp`（來源時間）與 `created_at`（收到時間）的雙時間設計。另記觀察時間 `observed_at`（OTel 的 Timestamp 與 ObservedTimestamp）。目標承接用觀察時間。暫停判斷**不**用觀察時間（修訂 2026-11-13）：即時入口依收到時間；交接目錄只在暫停結束後、以可用的來源時間對照已記錄的暫停區間（spec FR-082）。觀察時間是來源的自述；Phase 2 審查以 probe 證明信任它會在來源時鐘偏慢、relay chunk 延遲送出、系統時鐘倒退三種情況寫入暫停內容。
- **目標**（O11）：`explicit` → `extracted` → `command` → `terminal-last` → `none`。
  - `terminal-last` 與 `command` 改從持久資料查，取代 `ingest.ts:83,399` 只存在記憶體的 map（01-F5(a)(b)）。
  - 新增衍生、可重建的 `terminal_targets(terminal, observed_at, target)` 表，放在專案 DB，本規格擁有；寫入路徑在同一個 commit 交易內寫入（Spec 074 的投影執行器在此呼叫 `advanceInTransaction`）。
  - **回填**（含 071 之前事件的專案）不在本規格做：由 Spec 074 的 `heavy` 執行緒以唯讀連線計算，分批交回主行程，由寫入者以小交易依序寫入（074 plan D5 的 `tt-backfill`）。回填完成前，這種專案的新列不套用 `terminal-last`，寫 `target_via: "none"`，永久（spec FR-010）。回填是否完成由 074 回報（`terminal_targets` 投影的狀態）；寫入路徑在記憶體中保存最近一次的回報，未知時（含 074 尚未落地）視為未完成。不需要回填的專案（沒有 071 之前的事件）視為已完成。
  - 不再套用 `ingest.ts:251-255` 的全域目前目標（app 內操作見 O16）。
- **否決**：由來源在觀察當下宣告目標。那樣要把目前目標寫進 identity 檔，每次改目標都改變每個 shell 的 stamp（`shell-common.sh:334-341`），而且來源宣告的目標不可信。

### D3 新入口 `/api/ingest` 加逐項回執；`/api/events` 保持狀態碼

**決定**：契約 1 走 `POST /api/ingest`，請求為 `{contract:1, items:[…]}`，回應見下方「資料形狀」。舊入口對每種情況回與今天相同的狀態碼，只**增加** `outcome`／`reason` 欄位（01-F1 的遷移第 2 步）。

**理由**：Kinesis PutRecords 的逐項回執（同序、同長）、OTLP 與 PRW 2.0 的「可重試與永久拒絕二分」、PRW 2.0 的寫入計數自檢（PRIOR-ART-B §1）。舊來源的反應依附在狀態碼與一個錯誤字串上（`redlog-relay.py:333-338`），只要改狀態碼就會改變它們的行為。最明顯的例子：把 2 秒去重的 409 改成 200，舊 shell 就不再 spool，而那個合法的、2 秒內重打的指令今天正是靠 spool 救回來的（01-F2）。

**否決**：

- 同一路由依主體中的 `contract` 切換語意：較少一條路由，但舊流量與新流量無法分開量測，回應語意也混在同一個 handler；
- 版本放在標頭：shell 與 PowerShell 容易漏帶；
- Splunk HEC 的兩段式 ack：本機是同步 commit，回應時已經落盤，不需要。

**名稱**：`/api/ingest` 原本是 DESIGN-plugin-kernel §3 規劃的「先存原始位元組 + mapper」入口，從未建立（`plugins/manifest.ts:19-21`），07 也建議不做 mapper。本規格沿用這個名稱作為信封契約，並在 T082 修改該設計文件。

### D4 冪等：（來源、`event_id`）永久唯一，另立一張表

**決定**：

```sql
ingest_keys(producer TEXT, event_id TEXT, digest BLOB(16), tier INTEGER, row INTEGER, observed_at INTEGER,
            PRIMARY KEY(producer, event_id)) WITHOUT ROWID
```

- 與事件列同一個交易寫入；
- 保留期刪除 logged 列時不刪這張表，它本身就是墓碑；
- `digest` 是接收端對項目（扣除 `sent_at`、`discarded` 等傳輸欄位）做 `canonicalStringify` 後 sha256 的前 16 bytes。正規化只在接收端做，用於比較「同 id 異內容」，來源不需要 canonical JSON。

**範圍以來源為單位的理由**：天然鍵導出的 id（transcript uuid）可以預測；若全域唯一，一個來源可以搶先佔用別的來源的 id，壓掉它之後的列。

**否決**：

- 在兩張事件表各加欄位並建部分唯一索引（01-F2 的提案）：跨層需要兩次查詢，同 id 異型別會分別寫入兩層，保留期刪列後也需要另外的墓碑；
- Stripe 24 小時、SQS 5 分鐘、NATS 2 分鐘的時間窗：本機單一 DB 永久保存的成本低，而且鏈本身要求每筆只出現一次（PRIOR-ART-B §2.3）；
- 以內容雜湊去重：測試本來就常重送相同請求（070 FR-011）。

**大小**：每列約 24–36 bytes 的 id + 16 bytes 摘要 + 少量整數 + B-tree 開銷，約 70–90 bytes；一百萬項約 70–90 MB。perf lane 量測（T061）。

**沒有 `event_id` 的舊項目**：接收端產生 UUIDv7 寫進 `_ingest.event_id`，並仍套用今天的 2 秒啟發式。

### D5 遺失帳本：累計計數加序號缺口

**決定**：

- 來源回報 Sentry client report 形狀的計數，但用累計值而非差值，接收端存最後一次的累計值，重送不會重複計；
- Vector 的 `intentional` 維度；
- Kafka、`/dev/kmsg` 的序號缺口推導：只有序號能涵蓋來源自己當掉的那一刻；
- perf `PERF_RECORD_LOST` 式的原位缺口紀錄。

簿記表：

```sql
ingest_instances(producer, instance, project_bound, hello_at, bye_seq, contiguous_through,
                 out_of_order TEXT /* ≤1024 個 seq */, discarded_cum TEXT, last_item_at, settled_through)
```

缺口結算後寫一列 chained `system.capture_gap`（FR-054）。

另一張小表給 Spec 075 的「曾經成功過」事實（FR-056）：

```sql
ingest_producers(producer TEXT PRIMARY KEY, first_accepted_at INTEGER, last_accepted_at INTEGER)
```

每個來源一列；`first_accepted_at` 第一次 `accepted` 時寫入、之後不改，保留期刪列不影響它；`last_accepted_at` 每次 `accepted` 更新（同一個交易）。`ingest_instances` 會在 30 天後壓縮刪除，不能承擔這個里程碑。`ingest_instances.hello_at` 之外，這張表是 075 唯一需要的新持久事實，不另建 proof 檔（075 D10）。

**否決**：

- 獨立的 `loss_ledger` 表加上匯出時附 `loss_ledger.jsonl`（PRIOR-ART-B §9.5）：會改變 bundle 格式；用缺口列就能進鏈、上時間軸、隨匯出走；
- 每個 producer 寫 ledger 檔的目錄（01-F3 的 `~/.redlog/ledger/`）：多一個沒有身分的寫入方；
- DESIGN-capture-trust §2「不寫逐項回執列」：本設計遵守，`ingest_keys` 不是事件。

### D6 交接目錄與檔案認證

- **結構與流程**：maildir 的 `tmp → new` 原子改名；Postfix 的 `corrupt` 與 Fluent Bit 檔名帶原因的隔離；Logstash 的「只有不可重試才隔離、有上限、不自動重送」。
- **為什麼依專案分子目錄**：今天每 30 秒都要重新解析別的專案的檔才能把它們留在原地（`spool-replay.ts:128-131`）；分目錄後，排空成本只與自己的檔數有關。
- **滿了丟最新**：已寫進目錄的是已觀察到的事實，丟它等於改寫歷史；阻塞則等於卡住操作者的 shell（PRIOR-ART-B §4.2）。
- **檔案認證用 HMAC，且對位元組計算、驗過再解析**：這是 DSSE 與 Latacora 的教訓；canonical JSON 在 shell 與 PowerShell 做不可靠（PRIOR-ART-A §5）。
  - 金鑰：`mac_key = HMAC-SHA256(secret, "redlog-handoff-mac/1")`。
  - 計算對象：`"RLI1\n" + 項目位元組`（以前綴防跨協定混用）。
  - shell 交由 python helper（`hooks/redlog_client.py handoff`）計算：helper 從憑證檔讀金鑰，從 stdin 讀位元組，金鑰從不經 argv。只在 POST 失敗時才走這條路（FR-103）。
- **否決**：
  - `openssl dgst -hmac`：金鑰在 argv；
  - `sha256(secret || body)`：有長度延伸問題；
  - 只靠目錄權限：無法區分來源；
  - 把 bearer secret 寫進檔案：會隨隔離區或分享外流。
- **MAC 能防什麼**：沒有執行程式碼能力的寫入者，例如只有檔案寫入工具的代理、解壓縮、同步工具。它**不**防同使用者程序。真正關掉 01-F7(a) 的，是 FR-065 的種類政策；MAC 提供的是歸屬。
- **否決 OSC 133／633 帶內傳遞**：目標主機的輸出可以印出同樣的序列，需要 nonce 機制，另案處理。

### D7 憑證：機器層級的來源憑證加上 per-project 操作者憑證

- **來源憑證放機器層級**：來源跨專案存活；歸屬由 `observed.project` 決定，不由憑證決定。若做成 per-project，每次切換專案都要重新發放給每個來源。
- **操作者憑證維持 per-project**：保留現有的祕密隔離（`api-server.ts:909-918`），只把鏡像路徑改到 `~/.redlog/credentials/operator`。
- **外掛 Source 的憑證與專案啟用**：憑證機器層級，第一次在任一專案 `on` 時發放；專案層的 `on`／`off` 不發放也不撤銷，由接收端的政策階段依專案判斷（FR-07A，`source-disabled`）。這保住了「切換專案不重新發放」，又讓 Spec 075 的專案層開關有真正的效果。
- **發放經安裝帳本**：寫 `<producer>.cred` 經 Spec 073 的 `install-ledger.apply`（`credential-file`），撤銷與移除依帳本收回（073 T076）。
- **登記檔** `~/.redlog/credentials/registry.json`（0600，只有 app 會寫），每筆 `{id, producer, class, kinds, project?, generations:[{gen, secret_sha256, mac_key, issued_at, retired_at?}], revoked_at?}`。
- **來源的檔案** `<producer>.cred` 只有一行：`rlc1.<id>.<gen>.<secret b64url>`。bearer 值就是整行；shell 不必解析 JSON。
- **內建終端機用一把 `builtin-terminal` 憑證，不做每個 pane 一把**：在本威脅模型下，每 pane 一把不增加安全性，卻帶來交接檔在 pane 關閉後的退休問題。
- **否決**：
  - 把憑證放進 PTY 環境變數（05-F2 的提案）：子行程會繼承，操作者打 `env` 或 `printenv` 時會被**錄進紀錄並匯出**；
  - macaroons 或 Biscuit 的權限衰減（PRIOR-ART-A §6）：只有一個接收端，不需要。
- **升級時的 token 降級**（FR-078）：舊的 token 值已經散到 `~/.redlog/api-token`、VPS、外掛。降為 `legacy` 能讓這些持有者不中斷地繼續記錄，同時失去控制能力，符合 O1。

### D8 單一入口：階段明確、不框架化

`ingest()` 拆成以函式表達的階段，不做 stage 框架（07 拒絕 R2 框架化；02 的同步與 commit 後劃分）：

```
authenticate(door) → validate → stamp → dedup → settle → gate → derive → commit → receipt → postCommit
```

- `insertEvent` 只剩 `src/core/ingest/commit.ts` 可以呼叫；`test/**` 仍可直接匯入以佈置測試資料。
- 31 處直接呼叫（#716 量得）依檔案遷移，由 ratchet gate 鎖住。
- `insertEvent` 內部的暫停與跨專案閘門改成會丟錯的斷言（FR-095）。
- `commit` 回傳 `CommitReceipt {seq, chainedMaxRowId, loggedMaxRowId}`（FR-096）。`seq` 是 `commit.ts` 模組內、每次開啟歸零的計數；Spec 073 落地後它屬於 session 的 `project-state`，不是模組層變數。rowid 取自剛插入的列，不另查。
- `postCommit` 依序：publish、scope 派送、companion 列、存活狀態更新，以及 Spec 074 落地後的 `queryService.notifyCommit(receipt)`、`topicsForCommit(rows, writes)` 與 HTTP body 索引連結（改送 074 的 `derived-op`，取代 `ingest.ts:290` 的直接寫入）。
- 推導階段若有使用者 Processor 參與，蓋章階段寫 `_ingest.rules`／`rules_partial`（FR-005、FR-006；Spec 075 FR-059）。蓋章在推導之前，所以這兩個鍵在推導完成後、commit 之前補入同一個 `_ingest`，仍在雜湊內。

### D13 深度上限：寫入原語在蓋章那一步包起過深的容器（FR-097，2026-11-14）

**問題**：兩個 verifier 都遞迴走 `data` 重算雜湊。Python 的會在遞迴上限停下，把完好的列報成 CHAIN BROKEN；能送 `data` 的來源（交接檔、AI 工具輸入、代理解析出的 JSON 請求本體、RedLog 自己的程式）自己決定有多深。

**實測**（2026-11-14，本機；變更前）：

| 誰 | 在 `data` 多深時失敗 | 版本 |
|---|---|---|
| `tools/redlog-verify.py` 重建一列（`_rebuild_shapes`），全為陣列 | 332 層（`RecursionError`） | Python 3.9.6、3.11.18 |
| 同上 | 497 層 | Python 3.12.16、3.13、3.14、3.15.2 |
| 同上，全為物件 | 991 層（`json.loads` 失敗，`_parsed_data` 退回原字串，讀成雜湊不符）／989 層 | 3.9／3.11；3.12 以上 |
| 寫入端：FTS 的 insert trigger（`json_tree`） | 1,001 層，`SqliteError: malformed JSON`，整列不寫入 | SQLite 3.54.1（better-sqlite3） |
| 寫入端：`canonicalStringify`／`JSON.stringify` | 約 2,300 層陣列／約 6,100 層，`RangeError` | Node 24.12；Electron 45.3.1（Node 24.22）的 `JSON.stringify` 到 2,000,000 層都不失敗 |
| app 的 verifier（`canonicalStringify`） | 約 2,300 層陣列 | Node 24.12 |
| `JSON.parse` | 2,000,000 層仍不失敗（V8 的解析不遞迴） | Node 24.12、Electron 45.3.1 |
| AI tailer 的 `deepRedactStrings`（`tailer-host.ts`） | 1,563 層陣列，`RangeError`；該工具呼叫與其後同一個工作階段的每一輪都沒有寫入，`scheduleRetry` 重試同一個位移直到上限 | Node 24.12 |
| `POST /api/events` | 請求本體超過 64 層（`data` 超過 63 層）在解析前回 400，項目不被記錄（9aa28ed3） | — |

**規則**（spec FR-097）：第 63 層以內原樣；第 64 層的容器只有在不含容器、且不是標記形狀時保留，否則換成包裝物件 `{"_collapsed": "<JSON 文字>"}`。包裝物件本身是容器，所以它只能放在第 64 層，原本「第 65 層的容器換成字串」的寫法往上移了一層。存入的列只記數目時，`["[1]", [1]]` 與 `[[1], "[1]"]` 會存成同樣的位元組，讀者分不出哪個字串是寫入端做的；改成包裝物件、並把來源自己在第 64 層的標記形狀物件也包起來之後，「第 64 層的標記形狀物件都是包裝」這條規則沒有例外，`restoreDataDepth` 只看存入的列就能還原。

**上限 64 的根據**：本 repo 的 fixture 與 golden 中最深的 `data` 是 3 層；本機 323,816 筆 Claude Code 與 Codex 工具呼叫中最深的輸入是 5 層（存成 `data.tool_input` 為 6 層）；代理解析出的 JSON 請求本體位於 `data.params.body_json`（第 3 層），所以 61 層以內的請求本體原樣保存（最內層只含純量時 62 層）。Python verifier 對最不利的形狀（全陣列）在 332 層失敗，是 64 的 5.2 倍；測試斷言 4 倍（256 層，再加 100 個額外的堆疊框架）仍能重建。API 既有的閘門計的是請求本體的層數，對 `data` 而言是 63，不是 64。沒有找到正當超過 64 層的真實來源；會碰到的是測試者自己送的深層 JSON 請求本體，那正是要無損保存的。

**套用點**：`insertEvent`（`event-write.ts`）的兩個層，在加上 `_ingest` 的那一行：chained 層在 `_clock_anomaly`、`_source_time_rejected` 之後、`canonicalStringify` 之前；logged 層在 `_raw` 之後。理由：

- 每一列——API、交接、行程內、`derived`、尚未遷移的 31 處直接呼叫——都經過這裡，而且只有這裡同時決定雜湊輸入與存入的值；放在 `ingest()` 會漏掉直接呼叫，放在入口會有五個副本。
- `ingest()` 在寫入前讀的都是頂層欄位（`command`、`stdout`、`subtype`、`flow_id`、`pid`、`_causes`、`mtime`、`path`），遮罩 span 也只看頂層的字串欄位；頂層欄位是第 1 層的值，不會被換掉。所以去重、`_causes`、目標擷取、loot、遮罩 span 看到的與先前相同。
- `_source_time_rejected.value` 是來源的值，比 `data.source_timestamp` 深一層，所以在它加入之後才處理。

**API 入口**（擁有者 2026-11-14「收下並摺疊」）：`POST /api/events`（與共用 handler 的 `/api/events/seed`）自己讀本體（`parseJsonObjectBody(raw, { maxDepth: EVENT_NESTING_CEILING })`），十萬層以內不以深度拒絕；其他路由的 64 層閘門不變。

第一版在這裡寫「從讀本體到 `insertEvent` 的每一步都只讀頂層欄位、不遞迴」，**這不成立**（第三次審查）：`String(x)` 與模板字串對陣列會呼叫 `Array.prototype.join`，而 `join` 對巢狀陣列遞迴；`Number(陣列)` 也一樣。5,000 層的陣列放在 `agent_type`、`target_id`、`data.command`（agent）、`data.pid`（shell）、`data.host`、`data.method`（scanner）、`data.query_type`（dns）時堆疊溢位，API 回 500：有的在寫入之前（什麼都沒存），有的在寫入之後（列已存入卻回 500，hook 因此改寫交接檔，同一筆觀察存成兩列）。修正是一類，不是七個補丁：

- `src/core/ingest/field-text.ts` 的 `fieldText`／`fieldNumber`：字串是自己；數字、布林、bigint 是 `String`／`Number` 的結果（與先前逐位元組相同）；物件、陣列、null 等視為沒有這個欄位（`fieldNumber` 給 NaN）。界限之前把來源欄位變成文字、鍵或數字的每一處都改用它（呼叫點清單見下表）。
- `agent_type` 不是字串時 API 回 400（交接檔原本就以 `malformed` 隔離），不再退成 `external`；403 與交接檔隔離說明中的 `agent_type` 只引用前 64 字元。
- HTTP 本體的位元組（`*_body.data`）不是字串時不移入 sidecar：`Buffer.from` 會把它當數字陣列讀（巢狀陣列逐層轉換，`{"length": 1e9}` 配置 1 GB）。原樣留在列上並受界限。
- 偵測 HTTP 憑證（`detectHttpCredential`）移到本體移入 sidecar 之前：先跑所有可能失敗的步驟，再寫 sidecar，失敗時不會留下沒有列的 sidecar 檔。
- 寫入之後的步驟（終端機狀態、延遲輸出的記帳、發佈、因果連結、scope 判定、loot）各自以 `step()` 隔離：失敗記在 log 與 capture-health（`ingest-post-commit`），其餘步驟照跑，`ingest()` 回傳已寫入的列。API 另外接住帶有 `committedEvent` 的錯誤並回 201。

| 呼叫點 | 原本 | 現在 |
|---|---|---|
| `api-server.ts` 事件路由 `agent_type` | `String(body.agent_type \|\| body.agentType \|\| 'external')` | 非字串回 400 |
| `api-server.ts` 403 訊息 | 引用整個 `agent_type` | 前 64 字元 |
| `api-server.ts` `ingest()` 呼叫 | 寫入後的錯誤回 500 | `committedEventOf` → 201 |
| `ingest/body-target.ts` `bodyTargetId` | 取 `target_id`／`targetId` 的值，型別未檢查 | `fieldText` |
| `ingest.ts` `delayedCapture` | `String(data.subtype)` | `fieldText` |
| `ingest.ts` shell 的 enrich | `data.command as string`（陣列進 `tagCommand` 等偵測器時拋 TypeError） | `fieldText(data.command)`，非純量時不 enrich |
| `ingest.ts` 長指令判斷 | `Number(data.duration_sec)` | `fieldNumber` |
| `ingest.ts` `detectHttpCredential` | `String(data.host)`；標頭清單未檢查型別 | `fieldText`；名或值非純量的標頭略過；移到 sidecar 之前 |
| `ingest.ts` `detectRedactions` | `(data.redactions ?? [])` 展開（非陣列時拋錯） | 不是陣列時視為空 |
| `ingest.ts` loot 的 `source` | `data.command as string` | `fieldText` |
| `ingest.ts` 寫入後 | 任一步拋錯即回失敗 | 各步隔離 |
| `http-body-store.ts` `extractBodyToSidecar` | `Buffer.from(body.data)` | 只處理字串 |
| `db/event-write.ts` 去重（新列與候選列） | `String(data.command)`、`String(data.subtype)`、`String(data.pid)` | `fieldText`；`command` 非純量時不做去重 |
| `causes-resolver.ts` `shellKey` | `String(data.pid)`、`String(data.command)` | `fieldText` |
| `alert/scope-signal.ts` `scopeSignalFor` | `data.host`、`method`、`url`、`direction`、`command`、`detectedTarget`、`query_name`、`query_type` 進模板字串 | `fieldText`；非純量的目標視為沒有目標，`method`／`query_type` 用預設值 |
| `queue-gap.ts` | `String(data.reason)`、`Number(data.gap_*)` | `fieldText`／`fieldNumber` |
| `spool-drain.ts` | `Number(spooled.gap_*)`、`String(data.reason)`（讀存入的缺口列） | `fieldNumber`／`fieldText` |
| `spool-drain.ts` `kind-not-allowed` 的說明 | 引用整個 `agent_type` | 前 64 字元 |
| `main/terminal-manager.ts` | `` `${data.pid}\|${data.command}` ``、`String(data.subtype)` | `fieldText` |

查過、不需改的：`isExternalEventAllowed`（`Set.has`，不轉型）、`isCapturePlumbing`（先檢查 `typeof`）、`socketCausesFor`／`resolveByPid`／`portOfSourceAddr`（先檢查 `typeof`）、`relatedCommandCandidates`（先檢查 `typeof data.path`）、`extractTextToSidecar`（先檢查 `typeof`）、`noteCommandPid`（先檢查 `typeof`）、`sourceTimeRejection`（先檢查 `typeof`）、loot 掃描的 `textToScan`（只取字串）。讀**存入後**的列的讀者（`activity-projection.ts`、`export-plan.ts`、`scope-recompute-run.ts` 的 `String(d.x)`）面對的是已受限、至多 64 層的值，`join` 的遞迴至多 64 層。

測試：`test/ingest-field-coercion.test.ts` 經真實 handler 與交接檔，七個欄位各送 5,000 層陣列、一個物件、一個 5 MB 字串（以 HEAD 的原始碼執行時 15 個中 12 個失敗：API 回 500、交接檔重試；3 個交接檔案例原本就通過，因為交接檔已檢查 `agent_type` 的型別，`method`／`query_type` 的溢位在寫入之後、已由排空接住）。

**十萬層的上限**（擁有者 2026-11-14：被問「事件 API 超過十萬層就拒絕並記缺口，可以嗎？」，答「可以」；以下是實作者的解讀）：

- `EVENT_NESTING_CEILING = 100,000`（`ingest/depth.ts`），數整個請求本體或交接檔（根為第 1 層），在解析前以 `jsonDepthExceeds` 線性掃描；恰好 100,000 層照常收下。
- API：`413`，`{"error": "event is nested more than 100,000 levels deep; not recorded", "reason": "nested-too-deep"}`。在重新確認專案未切換之後才判斷，缺口列寫進收到本體時開著的專案。
- API 的缺口列（`ingest/nesting-ceiling.ts`）：`system`／`capture_gap`，`source: "api"`、`door: "legacy-api"`、`reason: "nested-too-deep"`、`intentional: false`、`skipped_units`（被拒的項目數）、`bytes`（其本體位元組總數）、`max_nesting: 100000`、`gap_started_at`、`gap_ended_at`、`description`；`occurredAt` 為第一次拒絕的時間。不含被拒項目的任何內容。
- 合併：以開著的專案的 DB handle 為鍵（`WeakMap`，handle 關閉即消失）。第一次拒絕立刻寫一列；其後 60 秒內的拒絕累加，視窗結束時由 `unref` 的計時器寫成一列；視窗結束後的下一次拒絕先寫出累加的，再當作第一次。視窗結束前專案已關閉時，累加的數目不寫入任何專案，只記 log 與 capture-health（`api-nesting-gap`）——已知限制。
- 交接檔：同一上限，不解析；`engagementInText` 讀出的專案是別的專案時留給它；否則移入隔離區（`nested-too-deep`），計入該次排空每個原因一列的缺口列（`source: "hook-spool"`，既有欄位，`description` 為「nested more than 100,000 levels deep」）。
- 量測（本機 Node 24.12，各一次）：100,001 層的本體在 0.8 ms 內判定拒絕；20 MiB 全為 `[` 的本體在 3.1 ms 內判定（第 100,001 個 `[` 即停；掃到底 80 ms）；恰好 100,000 層的本體 `JSON.parse` 11 ms、折疊 13 ms、尖峰 RSS +27 MB（先前記的 17 ms、約 +19 MB 為另一次量測）。
- 測試：`test/ingest-depth-doors.test.ts`（100,000 層收下、100,001 層 413 與缺口列、60 秒合併成 `[1, 4]`、交接檔隔離與缺口列）；以 HEAD 的 `api-server.ts`、`spool-replay.ts`、`api-request.ts` 執行時三者皆失敗（201／全部寫入）；把視窗改為 0 時合併測試失敗（`[1,1,1,1,1]`）。

**放大（已知限制）**：被包起來的最小容器是 `[[]]`，在請求本體中 5 bytes（含逗號），存成 `{"_collapsed":"[[]]"}` 加逗號 22 bytes。20 MiB 的請求本體約可含 419 萬個；審查的量測：4,193,904 個包裝、存入的列 88 MiB、DB 增加 101 MiB、寫入 14.3 s（不折疊的同大小本體 7.5 s）。不另設上限：折疊不遺失內容，而列的大小仍與送來的本體同級（約 4.4 倍以內）。

**遮罩**：
- AI 工具輸入的遮罩（`redactToolInput` → `deepRedactStrings`）在 tailer 內、進入 `ingest()` 之前完成，所以包裝物件中的文字已經是遮罩後的。`deepRedactStrings` 與其後的大小檢查已改為不遞迴（`jsonStringify`），輸出與舊的遞迴版本逐項相同（`test/tailer-redact-iterative.test.ts`）。仍然成立的限制：工具輸入的 JSON 文字超過 100 KiB（`MAX_FULL_BYTES`，早於本變更）時只存頂層鍵名（`tool_input_truncated`），所以 100,000 層的輸入（200 KB 的括號）存成鍵名，內容不在列上；40,000 層的輸入完整保存並受限。Codex adapter 對工具輸出做 `JSON.stringify(payload.output)`，在 Node 約 6,100 層時失敗並被 `catch` 吞掉（輸出遺失；Electron 的 V8 不會失敗）。
- 匯出時的遮罩：`redactEventForExport`、`sanitize.ts`、`scopeMaskReplacements` 以頂層欄位為單位（`sanitize` 只處理有遮罩 span 的頂層字串欄位；scope 遮罩把整個頂層欄位換成說明文字，不論其內容是否含包裝物件），不受影響。`operator-pii.ts` 是在序列化後的文字上做的，包裝物件的內容比原本多一層跳脫，所以它的樣式改為任何跳脫層數都相符（每個 JSON 會跳脫的字元前允許任意長度的反斜線；使用者名稱的字界也在 `\n`、`\uXXXX` 之後成立）。

**全文搜尋**：包裝物件的字串是一個 `json_tree` 葉值，內容是 JSON 文字；unicode61 依標點切詞，字與鍵名找得到，但緊接在以字母結尾的跳脫序列之後的字找不到（`line1\nword` 變成 `line1`、`nword`）。不改 trigger：在文字上再跑 `json_tree` 會碰到 SQLite 的深度上限而拒收整列。

**資源**（本機，Node 24.12，`data` 為單一長鏈，各一次量測）：10 萬層 17–21 ms；100 萬層約 100 ms（尖峰 RSS 比解析後多約 140 MB）；1,000 萬層（20 MB 的交接檔）1.1–1.4 s，尖峰 RSS 比解析後多約 460–750 MB（第一版：3.3 s、約 1,190 MB），解析本身的尖峰已約 1.2–1.7 GB。容器文字以三個平行陣列記錄路徑（容器、鍵、`2 × 下一個索引 + 是否已寫出`；第一版是四個），以 Brent 法在路徑上偵測循環（不保留已走訪的集合），輸出每 4,096 段合併一次；路徑超過一百萬層時拋 `RangeError`（`JSON_TEXT_MAX_DEPTH`），不再無限制地成長——`toJSON` 無止盡產生新巢狀的值原本會耗盡記憶體。一百萬層 85 ms、RSS +121 MB（四個陣列的版本 109 ms、+123 MB；記憶體由其他部分主導）。變更前同一個檔在 `canonicalStringify` 以 `RangeError` 迅速失敗。交接檔沒有大小上限（`spool-replay.ts`），本變更不加；巢狀超過十萬層的交接檔在解析前隔離（見上）。

**否決的做法**（擁有者的決定只有「寫入端限制深度」與「收下並摺疊」；以下理由是實作者的）：
- verifier 對過深的列回報「此處無法檢查」：未被選。實作者的理由：收件方仍看到一列無法驗證的證據。
- 調高 Python 的遞迴上限：未被選。實作者的理由：上限與 C 堆疊相依，調高會換成直譯器當掉，而且已出貨 bundle 內的 verifier 不會變。
- 拒收或丟棄過深的項目：實作者的理由：違反 §12 的完整擷取（已啟用來源觀測到的內容一律保存）。
- 截斷過深的部分：實作者的理由：遺失內容。
- 只記數目、把容器換成裸字串（本變更的第一版）：讀者分不出包裝與來源送來的 JSON 字串（見上）。

**讀者看到什麼**（未實作還原，只記現況）：沒有任何 app 內的讀者呼叫 `restoreDataDepth`。Inspector 的原始 JSON 檢視（`TimelineEventInspector.tsx` 的 `JSON.stringify(event.data, null, 2)`）在第 64 層顯示 `{"_collapsed": "<跳脫過的 JSON 文字>"}`；其他讀者（HTTP 詳情、Activity Reader、搜尋結果、Timeline 詳情列）讀的是具名的頂層欄位，只有當它們顯示的值本身含第 64 層的容器時才看到包裝物件。全文搜尋找得到包裝內的字（上述跳脫後的限制除外）。匯出的 bundle 原樣帶著包裝物件，README 說明如何讀。未在執行中的 app 中確認。

**已寫入的列**不改寫、不遷移（產品未發行）。

### D9 存活通道（O7）

- `hello`、`alive`、`bye` 寫入 `ingest_instances` 與記憶體中的存活表，不寫事件。
- capture-health 改讀存活表，取代 `capture-health.ts:790-798` 對 heartbeat 列的查詢。
- 舊入口收到的 heartbeat 改送存活表，回 200（pcap-capture 只檢查 `r.ok`，`pcap-capture.js:49`）。
- 舊專案裡既有的 heartbeat 列不動。

### D10 分層規則（O8）：取用 072 的 `tierFor`

**決定**（2026-11-12 跨規格對帳後）：本規格不另立 tier 表。Spec 072 的種類登記表是唯一一張「哪些種類 chained」的表；`classifyTier(producerClass, agentType, subtype)` 只呼叫 072 的 `tierFor(agentType, subtype, producerClass)`：已登記 → 登記的 `tier`；未登記且來源類別為 `plugin` → logged；其他 → chained（今天的安全預設，用於核心來源與舊入口）。本規格原先規劃的 `CORE_CHAINED` 表與「`LOGGED_TIER`／`CORE_CHAINED` 互斥」測試取消；pcap-capture 與 c2 的種類由外掛憑證寫入時改為 logged，記在 072 的 `TIER_CHANGES`（072 T040）。

**過渡**：072 的登記表落地前，本規格照今天的 `classifyTier` 出貨，外掛種類仍是 chained；FR-113 在 072 T040 合併時才生效。完整性檢查（每個寫出的種類都有 tier）是 072 的 `writers-registered` gate，不是本規格的。

### D11 外部終端機切換專案即暫停（O10）

在 relay 的 `apply_terminal_action`，`project-switched` 從永久停止改為「綁定專案不符時暫停」；綁定的專案再開時送 `capture_resumed`。這改的是 Spec 052 FR-010 與 `shell-common.sh:312-325` 的契約；依 CLAUDE.md「Changing behaviour」，相關 spec 與測試屬於本變更（T075）。relay 一側屬本規格；TS 一側（`terminal-enrollment.ts` 的 `bindingState`）、終端機狀態檔的 schema 與 app 端的呈現屬 Spec 073 FR-040–045。兩側共用一個 agreement 測試：`test/terminal-enrollment-agreement.test.ts`（本規格 T075、073 T060）。

### D12 暫停狀態檔

`~/.redlog/state/recording`：暫停時存在。

**否決**：把暫停狀態寫進 `active-identity.json`。那會改變每個 shell 的 stamp，每次切換暫停都觸發一次 relay 呼叫（`shell-common.sh:343-366`）。

## 資料形狀

**請求**

```json
{"contract":1,"items":[{
  "event_id":"k7f3q9x2m4p8r1t6.000042","kind":"event",
  "producer":{"name":"zsh-hook","version":"0.18.0+c1"},
  "instance":"k7f3q9x2m4p8r1t6","seq":42,
  "observed":{"at":1731400000123,"project":"p-2c9…","operator":"op-1","terminal":"t-ab12","command":"c-77"},
  "type":"shell","data":{"subtype":"command_end","command":"nmap -sV 10.0.0.5","exit_code":0},
  "discarded":{"paused":3}
}]}
```

**回應**

```json
{"contract":1,"written":1,"items":[
  {"event_id":"k7f3q9x2m4p8r1t6.000042","outcome":"accepted","id":"9b1e…"}
]}
```

其他結果：

- `{"outcome":"duplicate","id":"…","original":"pruned"}`
- `{"outcome":"rejected","reason":"kind-not-allowed"}`
- `{"outcome":"retry","reason":"busy","after_ms":2000}`

**新列的 `data._ingest`**（chained）

```json
{"v":1,"door":"api","producer":"shell","credential":"c4kq2…:1","auth":"bearer",
 "event_id":"k7f3q9x2m4p8r1t6.000042","instance":"k7f3q9x2m4p8r1t6","seq":42,
 "terminal":"t-ab12","target_via":"extracted","claimed":{"producer":"zsh-hook@0.18.0+c1"}}
```

logged 列省略 `claimed`；instance 的自述資料在 `ingest_instances` 中。

**交接檔** `handoff/<project>/new/1731400000123-k7f3q9x2m4p8r1t6-0000000042.rli`

```
RLI1 c4kq2… 1 hmac-sha256 3f9a…
{"event_id":"k7f3q9x2m4p8r1t6.000042",…}
```

**去正規化欄位**（`migrateAddedColumns` 的既有機制，NULLABLE，不回填）：兩張事件表各加 `event_key`，`events` 另加 `terminal`。`schema_version` 對新列寫 2，只是方便查詢，不具權威。

## 「版本」方案與驗證

- 雜湊沒有版本差異（D1），verifier 的雜湊程式不改。
- 兩個 verifier 都新增「來源狀態」報告：已證明、自述、無法判斷三種數目，加上 logged 層「不逐列防竄改」的說明。結束碼不變（FR-023）。
- golden：
  1. **舊列**（T002）：以目前 main 產生的專案 DB 與 bundle，含 api、spool、行程內、logged、`_raw`、`_clock_anomaly`、`_source_time_rejected`、sanitized、projection 各種列。釘住列的位元組、雜湊、兩個 verifier 的輸出、匯出的位元組。之後每個階段都跑。
  2. **新列**（T031）：固定時鐘、id、金鑰，對一組輸入產生固定的雜湊；兩個 verifier 都要接受；共用向量放在 `test/fixtures/provenance-vectors/`。
  3. `test/ingest-golden.test.ts` 的摘要會因新列多了 `_ingest` 而改變，在 T030 的 commit 中明說「新列的證據內容改變」並重新記錄（該檔標頭的既定流程）。
- **FTS**：insert trigger 的 `json_tree` 排除 `$._ingest` 子樹。因為沒有任何既有列含接收端的 `_ingest`，把「只差這個排除條件」的定義變更視為「替換 trigger、不重建」（`db/index.ts:439-463` 增加這個例外與測試，T033）。

## 遷移與相容

| 對象 | 做法 |
|---|---|
| 舊專案 | 新表與欄位以既有的增欄機制加入；不 UPDATE、不回填；`ingest_keys` 從空開始；FTS 只換 trigger |
| 舊入口 | 狀態碼不變（FR-036）；`outcome`／`reason` 為新增欄位；保留期限見 FR-037 |
| 舊 hook（已載入、未重新 source） | 每個事件都讀 `~/.redlog/api-token`，現在讀到的是 `legacy` 憑證，經舊入口繼續寫入，只能寫入 |
| 新 hook（重新 source 後） | 讀 `credentials/shell.cred` 或 `credentials/builtin-terminal.cred`，走契約 1 |
| CLI | 讀 `credentials/operator`；找不到時退回舊路徑，並在 403 時說明憑證已搬家 |
| VPS 與外掛手上的舊 token | 降為 `legacy`；遠端主機由操作者以 CLI 重新發放 `remote:<名稱>` |
| `pending/` | 過渡期內排空（legacy-handoff）；`.bad` 與 `.unattributed` 一次移入隔離區 |
| 降版 | 舊版不認得 `/api/ingest`（404），新來源把項目放進交接目錄並保留；舊版不排空 `handoff/`，升回來後補寫。舊版 session 寫的列由 verifier 報為「自述」 |
| AI 代理工具（`docs/agent-integration.md`） | 若繼續讀 `api-token`，只剩寫入；能力預設見 O13（`agent-tools`） |

## 與兄弟規格的介面（2026-11-12 對帳）

| 兄弟 | 本規格需要 | 本規格提供 |
|---|---|---|
| 072 種類登記表 | `tierFor`（D10）；`writers`（種類政策，T010）；`pause`（暫停豁免，T015）；`identity.target`（目標步驟，T024）；`KindId` 型別（行程內入口，072 T045） | 強制、時間基準、目標演算法、回執；`ProducerClass` 的值域（FR-071）；`system.project_closed` 經本入口寫入 |
| 073 專案執行期 | session 的 token 與綁定的 engagement（FR-007）；機器層的目前操作者（FR-009）；AI 同意狀態（FR-07A）；安裝帳本（憑證檔，FR-072）；TS 一側的終端機綁定（FR-085） | `handoff-dir.ts` 的 RedLog 根目錄解析（073 FR-020）；FR-080 暫停狀態檔；relay 一側的綁定與 `capture_resumed`；共用 agreement 測試 |
| 074 讀取服務與投影 | `notifyCommit`、`topicsForCommit`、`derived-op`（postCommit，D8）；`terminal_targets` 的回填（D2） | `CommitReceipt`（FR-096）；`terminal_targets` 表與同步寫入；`_ingest.terminal` 正規值（FR-011）；`_causes` 的指令 id（O18，FR 未展開，見 spec 的注記） |
| 075 來源狀態 | 來源狀態 payload（FR-07B 的 `/api/whoami`）；`enabledForProject`（FR-07A）；外掛 `emits`（憑證範圍）與啟用時刻（發放時機） | FR-056 的事實（存活、第一次與最近一次接受、遺失帳本依 FR-050 原因名稱、停用後被拒、隔離、舊入口）；`_ingest.rules`／`rules_partial`；憑證登記狀態與發放、撤銷 |

跨規格的實作順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」；下方是本規格自己的 Phase 順序。

## 依賴順序

1. **Phase 1** 釘住現況（只加測試與 gate）。
2. **Phase 2** 封住旁路、修暫停判斷（不改協定）。
3. **Phase 3** 核心蓋章（階段 1）與單一入口。
4. **Phase 4** 憑證與能力。
5. **Phase 5** 契約 1 的接收端、存活通道、帳本、交接 v1、一致性工具組。
6. **Phase 6** 各來源逐一換上契約。
7. **Phase 7** 狀態事實與文件。
8. **Phase 8** 驗收。

Phase 4 必須早於 5，因為逐項回執要有接收端認定的來源身分。Phase 2 可以與 Phase 3 的測試平行準備。

## 其他讀者與寫者（邊界清單）

**讀 `data` 的地方**（會看見 `_ingest`）：

- 全文索引：要排除；
- Activity 投影的 UDF、`capture-health` 的 `json_extract`、遮罩（固定欄位清單）、sanitize（以欄位為單位）、HAR 匯出（自己的 `_redlog` 鍵）、Timeline 的細節窗格（顯示原始 `data`，可以接受）、logged digest（涵蓋 `data`，正確）：都不受影響；
- `ingest-golden` 的摘要：重新記錄；
- 064 的 contract coverage：要檢查是否斷言 `data` 的鍵集合（T034）。

**寫 `_ingest` 或 `data` 的地方**：

- 來源：移除；
- 行程內複製別列 `data` 的寫入者，例如 `marker-amend.ts`、companions、spool 的 `{...data}`：由蓋章階段一律覆寫。

**讀 token 檔的地方**（散在各處，07-F3）：

- `shell-common.sh`、`redlog-send.sh`／`.ps1`、`shell-hook.ps1`、`redlog-relay.py`、`redlog-session.py`、`mitmproxy-addon.py`、`pcap-agent.py`、`pcap-capture.js`、`c2-tail.js`、`cli/redlog-cli.js`、`wsl-redlog-test.sh`（`vps-deploy.sh` 已移除，見 T083）。
- 全部在 Phase 6 換成共用的 client：python 一份、sh 一組函式、ps1 一份、js 一份。

**寫 identity 檔的地方**：`main/index.ts:378-383` 一處，改成原子寫入。

**讀 heartbeat 的地方**：`capture-health.ts:790-798` 一處。

## 風險

| 風險 | 處理 |
|---|---|
| 漏掉某個依 `data` 鍵集合做事的讀者 | 先 grep `Object.keys(data`、`json_each(data`；契約 golden（064 的 coverage） |
| FTS 例外判斷寫錯，導致大專案開啟時全量重建 | T033 用 10 萬列的 fixture 斷言開啟時沒有重建 |
| shell 交接路徑多一個 python 行程、Git Bash 沒有 python | FR-103 量測；Q3 |
| 舊 hook 在升級瞬間讀到半寫的 `api-token` | 以原子替換寫入；舊 shell 讀不到時本來就會 spool |
| 輪替瞬間在途的請求 | 10 分鐘寬限 |
| 每天數千個 instance 讓 `ingest_instances` 增長 | 結算後壓縮成一列；超過 30 天、已結算的刪除（簿記，不是證據） |
| WSL `/mnt/c` 不強制權限 | 記入已知限制；與今天的 `api-token` 相同 |
| 階段 3 未落地前，大事件仍在主執行緒同步推導 | 本規格不惡化：多一次索引查詢；02 的 (c) 留給後續 |
| PowerShell 5.1 遇到 4xx 會丟例外 | client 改用 `Invoke-WebRequest` 加 `-SkipHttpErrorCheck`（7+）或 `try/catch` 讀 `Response`（5.1）；有向量涵蓋 |

## 驗證策略

- **golden**：舊列（T002）、新列（T031）、兩個 verifier 結果一致。
- **特徵化**：舊入口的每種情況（T003）；舊來源的反應表（T004，以 `it.fails` 標出已知缺陷）。
- **property**：暫停不變式（T022）；重啟等價（T032）；入口等價（T036）。
- **故障注入**：commit 後回應遺失（T051）；交接目錄滿、寫入失敗、損毀、tmp 孤兒、憑證撤銷、instance 未送 bye 當掉（T056）。
- **一致性**：`test/conformance/ingestion/` 內的向量、mock receiver（真實管線加可注入的結果）、各 runtime 的入口；CI 三平台的 unit leg 跑可用的 runtime：ubuntu 有 bash 5、zsh、pwsh 7、python、node；macOS 有 bash 3.2、zsh；Windows 有 PowerShell 5.1 與 7、Git Bash。矩陣由 `scripts/conformance-matrix.mjs` 從 JSON 結果產生並作為 artifact 上傳；xfail 用 ratchet 管控。
- **規模**（`REDLOG_PERF`，每週排程）：一百萬項的 `ingest_keys` 大小；每項的工作量計數。
- **真機**（不能以單元測試取代）：
  - macOS：升級時有開著的舊 shell；暫停中 `kill -9` 後繼續打指令再重開；`nmap &` 跨重啟；斷網跑錨定一小時，確認沒有 `'default'` 列。
  - Linux 或 Kali：受管代理、pcap 在 sudo 下的交接檔歸屬。
  - Windows：PowerShell 5.1 與 7 的 hook、WSL 讀 Windows 端憑證。
  - 依 `docs/RELEASE-SMOKE-TEST.md` 的 INSTALL、EXTERNAL SHELL、HTTP 節，在打包版上驗證 `redlog-verify.py` 的來源報告。

## Project Structure

### Documentation (this feature)

```text
specs/071-event-provenance-and-ingestion-contract/
├── spec.md
├── plan.md
├── tasks.md
└── verification.md        # T090 建立
docs/domain/SPEC-ingestion-contract.md   # 用戶端規格本文（T080）
```

### Source Code

```text
src/core/ingest.ts → src/core/ingest/{index,stamp,dedup,gate,commit,receipt,ledger,liveness}.ts
src/core/db/event-write.ts            # insertEvent 只供 commit；classifyTier 依 D10
src/core/db/index.ts                  # ingest_keys、ingest_instances、ingest_producers、terminal_targets；FTS 例外
src/core/api-server.ts                # /api/ingest；路由能力表；舊入口加欄位
src/core/external-event-policy.ts     # 種類政策表（依來源類別）
src/core/credentials.ts               # 登記、發放、輪替、撤銷、認證、MAC
src/core/handoff-dir.ts               # 根目錄解析、排空、隔離（取代 spool-replay 的實作）
src/core/chain-anchor.ts, tools/redlog-verify.py   # 來源狀態報告
hooks/redlog_client.py, hooks/shell-common.sh, hooks/RedLogClient.ps1, plugins/_shared/redlog-client.js
test/conformance/ingestion/{vectors,driver,mock-receiver,entries,xfail}/
scripts/conformance-matrix.mjs
```

**Structure Decision**：沿用 `src/core` 與 `hooks/` 的既有分層。`ingest.ts` 依階段拆成同一目錄下的模組，不搬動其他 `src/core` 檔案。

## Complexity Tracking

| 新增 | 解決的現存問題 | 較簡單做法為何不夠 |
|---|---|---|
| `ingest_keys` 表 | 三條至少一次的路徑各有一套身分，或根本沒有（01-F2） | 2 秒內容啟發式會誤丟合法的重打，也會漏掉延遲的重送 |
| `ingest_instances` 表 | 來源自己當掉時的遺失無法計數（01-F3） | 只用記憶體計數，會隨來源當掉一起消失 |
| 憑證登記檔 | 一把 token 代表全部權限（05-F2） | 逐條路由打補丁正是 05-F2 描述的症狀 |
| 交接格式（標頭行加 MAC） | 放入的檔可以拿到簽章列（01-F7(a)） | 只靠政策能擋型別，但無法歸屬到來源 |

