# Tasks: 核心蓋章的事件身分與來源、單一寫入契約

**Input**：[spec.md](spec.md)、[plan.md](plan.md)

**規則**：

- 每個 Phase 結束時 main 都可出貨，並以列出的 gate 收尾。
- 每個行為任務都先寫 RED，再實作。
- `[P]` 表示可平行（不同檔案、沒有相依）。`[USn]` 對應 spec 的故事。
- 每次 push 前依序跑五道 gate：`npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n && npm test`。

## Phase 0 — 工作流程前置

- [ ] T001 依憲章對本功能（證據、跨層契約）執行 Clarify、Checklist、Analyze，結果記入 `verification.md` 的 Gates。原開放問題 Q1–Q5 已決定為 O13–O17。新的開放問題 Q6（耐久度，spec 文末）取得擁有者答覆前，Phase 5 的 T051 與 T055 不開始（它們決定 `accepted` 之後刪交接檔的語意）；O18 的 FR 與任務展開前，Spec 074 Phase 5 的 `cause_counts` 只依今天的 `_causes`。

## Phase 1 — 釘住今天的行為（只加測試與 gate，不改程式行為）

- [x] T002 [P] [US5] `test/golden-old-rows.test.ts` 與 `test/fixtures/golden-pre071/`：用目前 main 產生專案 DB 與 bundle，涵蓋 api、spool、行程內、logged、`_raw`、`_clock_anomaly`、`_source_time_rejected`、sanitized、projection 各種列。斷言：
  - 列的位元組與雜湊不變；
  - 開啟與寫入新列後，舊列的 UPDATE 數為 0；
  - app 內驗證與 `redlog-verify.py` 的輸出不變；
  - 舊列匯出的 `events.jsonl` 逐位元組相同。
- [x] T003 [P] [US5] `test/api-events-legacy-mapping.test.ts`：表格驅動，列出 `/api/events` 每種情況今天的狀態碼與主體：accepted、2 秒去重、late chunk 去重、ingest 內跨專案、標頭 pin、paused、unrecorded、plumbing、政策 403、`marker`／`amended` 403、400、401、503、heartbeat。
- [x] T004 [P] [US6] `test/legacy-producer-decisions.test.ts`：對 mock 伺服器記錄 shell、relay、mitm、pcap-agent、pcap-capture、c2、PowerShell sender 對每種回應的反應（01-F1 的表，依實測更正：relay 只重試網路錯誤、不重試 5xx；pcap-capture 不檢查 POST 結果）。已知缺陷以 `it.fails` 標示。（在 PR #716 中，未合併前不勾）
- [x] T005 [P] `test/hash-input-pin.test.ts`：釘住 `insertChainedEvent`、`chain-anchor.canonicalHashPayload`、`redlog-verify._rebuild_shapes` 的鍵集合，以及 `PRAGMA synchronous`：寫入連線在寫入後為 FULL（2），含新專案、重開、切換專案；唯讀連線與匯出 worker 的唯讀連線維持 NORMAL（1）。（Q6 已答覆並實作：Phase 1 時這裡釘的是 NORMAL。）（在 PR #716 中，未合併前不勾）
- [ ] T006 [P] `test/single-ingest-door.test.ts`：掃描 `src/**` 中的 `insertEvent(`，基準值 31（#716 量得），只能下降（ratchet；形式同 `test/mutation-guard.test.ts`），取代 `test/canonical-ingest-sources.test.ts` 的檔案清單。
- [x] T007 [P] [US4] RED：`test/spool-bypass.test.ts`。spool 檔放 `agent_type: system`／`recording_resumed`，今天會寫出 chained 列。以 `it.fails` 標示，Phase 2 翻正。
- [x] T008 [P] [US2] RED：`test/pause-boundary-spool.test.ts`。(a) 暫停中當掉後重放會寫入；(b) 暫停前的 `command_end` 被永久卡住。以 `it.fails` 標示。
- **Gate**：五道 gate 全綠；新測試在三個平台的 unit leg 都有執行，或計為 `not-run` 並附原因。

## Phase 2 — 封住交接旁路、修正暫停判斷（不改協定）

- [x] T010 [US4] 種類政策表以來源類別為鍵（`external-event-policy.ts`），舊 spool 重放也經過它；違反的檔移入 `quarantine`（`kind-not-allowed`）。T007 翻正。
- [x] T011 [US3] `spool-replay.ts`：拆開 `invalid`（隔離，檔名帶原因並附 `.why`）與 `failed`（留在原處退避重試）；隔離與拒收寫 chained `system.capture_gap`。先 RED。
- [x] T012 [P] [US3] 既有的 `.bad` 與 `.unattributed` 一次移入隔離區（`legacy-bad`、`no-project`）；#255 的卡片改讀隔離區，語意不變。
- [x] T013 [P] 開專案時的排空改為有界切片、在背景進行（`main/index.ts:968`），測試沿用 `spool-drain-slices` 的形式。
- [x] T014 [P] `active-identity.json` 改原子寫入（`main/index.ts:378-383`），加入讀到半寫內容的測試。
- [x] T015 [US2] （修訂 2026-11-13，見 spec US2 與 FR-082/083）`recordedPauses()`／`stateAt(t)` 只讀已記錄的暫停區間 `[暫停, 恢復)`（沒有恢復紀錄的暫停：本次開啟前開始的在重開時結束，之後開始的結束時間未知、排空延後），只給交接目錄用；`command_end` 另依起點與跨越規則判斷；暫停／恢復列寫入失敗時重試：暫停中不排空；暫停結束後，可用來源時間落在已記錄區間內的檔拒絕為 `paused`，其餘寫入，交接檔不再經過 `ingest.ts:160-168` 的延遲閘門。即時入口維持今天依收到時間的判斷（含該閘門）。T008 翻正，並加入 property test（T022 的雛形）。
- [x] T016 [US2] 修訂 Spec 002 FR-007（暫停時不再保留檔案），與 T015 同一個 PR。
- **Gate**：五道 gate；T002、T003 不變。

## Phase 3 — 核心蓋章（階段 1）與單一入口

- [x] T020 [US1] 先 RED：`test/ingest-stamp.test.ts`。驗證 `_ingest` 的鍵、覆寫呼叫端給的值、移除保留鍵並記入 `stripped`、只含允許的型別、大小上限（FR-005、FR-006）；`rules` 的有界形式（至多 3 項、`+<n>`）與 `rules_partial` 在最壞情況仍不超過 512 bytes（Spec 075 FR-059 的消費者，075 T091 填值）。
- [ ] T021 [US1] 實作 `src/core/ingest/stamp.ts`。engagement 由綁定 DB 決定，`'default'` 不再出現；沒有綁定 DB 時拋錯，對應 `retry`／`no-project`（FR-007）。
  - 2026-11-14 對帳（PR #765）：`engagementForWrite`（`stamp.ts`）在綁定 DB 時一律用它，兩個層的寫入都走它；都沒有綁定也沒有呼叫端的名稱時拋 `no-project`（`test/ingest-stamp.test.ts` 的「nothing bound and no engagement named」）。未達成兩處：(1) 沒有綁定 DB 時，若呼叫端帶了 engagement 仍照用，而不是拋錯（同檔 `KNOWN GAP (FR-007 / T021)`，2026-11-13 決定暫時寬鬆）；(2) 專案目錄沒有 `config.yaml` 時，`readConfig` 回 `defaults()`（`src/core/config.ts:415`、`DEFAULT_CONFIG.engagement.id = 'default'`），`main/index.ts:814` 把它綁定，新列因此寫在 `default` 引擎下（`test/config-invalid-file.test.ts` 釘住「absent 回預設值」）。
- [x] T022 [P] [US2] 暫停 property test 完整版（至少 10,000 組；SC-005，依 2026-11-13 修訂的規則：暫停期間收到的列為 0；交接檔可用來源時間落在已記錄區間內的列為 0；暫停前的交接項目在暫停結束後寫入）。
- [ ] T023 [US1] 先 RED：`test/target-via.test.ts`（O11）。驗證 explicit、extracted、command、terminal-last、none 五種，跨重啟一致，不套用全域目前目標。
- [ ] T024 [US1] 建立 `terminal_targets` 表，寫入路徑在 commit 交易內同步寫入；**不在本規格回填**：含 071 之前事件的專案，在 Spec 074 的回填完成前不套用 `terminal-last`、寫 `none`（FR-010），先 RED 斷言這一點；回填由 074 T052 實作。`command` 的承接改從持久資料查；移除 `ingest.ts:251-255` 的自動套用（app 內操作依 O16）。Spec 072 T043（`identity.target`）同一個 PR。
- [x] T025 [P] [US1] `_ingest.terminal` 單一正規值；`causes-resolver.ts:83` 與 `event-write.ts:479` 改讀同一個函式（FR-011）。
  - 函式在 `src/core/ingest/terminal.ts`（`terminalIdentity`、讀已存列的 `rowTerminal`）；`ingest.ts` 的 cast 範圍與輸出尾段也改讀它。`test/ingest-terminal-identity.test.ts`。
  - 正規形式：存入的形式（JSON 字串的 UTF-8）在 128 bytes 以內就原樣保留；超過時取在字元邊界切下的前綴、`#`、整個 id 的 UTF-8 位元組 sha256 前 16 個 hex，總長仍在 128 bytes 內。不同的 id 不會合併。值是送出者自己的，不是接收端判定的。
  - 未改：讀已存列做投影、匯出與查詢的 `activity-projection.ts:59`、`operation-pair-key.ts:9`、`export-attachments.ts:182,198,209`、`event-queries.ts:1217`（只讀 `data.terminalId`），屬 Spec 074 的讀者；`api-server.ts:682` 與 `ipc/terminal.ts:44,71,106` 只檢查已存列有沒有終端機 id；`main/terminal-manager.ts:199,225` 在 core 之外，只處理內建終端機自己送的 `terminalId`。
- [ ] T026 [P] 帶 `_ingest` 的列，其存取與信任判斷改讀 `_ingest.producer`：`/api/terminal/replay`、`ipc/terminal.ts` 的 castPath（FR-012）。
  - 已做：castPath 只取 `_ingest.producer` 為 `in-process` 的 session 列（沒有 `_ingest` 的舊列照舊讀 `data.source`），涵蓋 `/api/terminal/replay`、IPC 的 `terminal:replay`、`replaySession`、`replayAtTime` 與重開時的孤兒復原（`src/core/ingest/builtin-terminal.ts`，`test/builtin-terminal-producer.test.ts`）。
  - 未做：replay 對 `command_end` 的判斷、`ingest.ts` 的 cast 範圍、`terminal-manager.ts` 的 lifecycle 仍讀 `data.source`。pane 內的 hook 用共用 token 經 API 送指令列，蓋章的 producer 是 `legacy`，分不出內建終端機；要等 T044 給它自己的憑證。
- [ ] T027 分層規則 D10（O8，FR-113）：**不在本 Phase**。它與 Spec 072 T040 是同一個 PR：先 RED，pcap-capture 與 c2 的種類由 plugin 憑證寫入時進 logged；`classifyTier` 改呼叫 072 的 `tierFor`；項目寫進 072 的 `TIER_CHANGES`。072 落地前，本規格的 Phase 3 照今天的 `classifyTier` 出貨。
- [x] T030 [US1] 所有入口都蓋章：api、spool、行程內、derived；`session_start` 帶 `_ingest`。重新記錄 `ingest-golden` 的摘要，commit 訊息說明「新列的證據內容改變」。（本階段的 api 入口是 `legacy-api`；契約 1 的 `api`／`handoff` 在 Phase 5。）
- [x] T031 [P] [US5] 新列的 golden 向量 `test/fixtures/provenance-vectors/`，兩個 verifier 都要接受。
- [ ] T032 [US1] 重啟等價測試：即時、中途重啟、全部經交接，三者一致（SC-003）。
  - 測試在 `test/ingest-restart-equivalence.test.ts`：即時與全部經交接、即時與在兩個指令之間重啟，SC-003 的欄位一致。
  - 未成立：在一個指令的起訖之間重啟，結束列失去 `_causes`（連結只在記憶體），以 KNOWN GAP 釘住。把連結改存在持久資料是 O18 的範圍，O18 尚未展開成 FR 或任務（spec「O18 是起草後才做的決定」），目前沒有任務會翻正它。`_ingest.target_via` 尚不存在（T023／T024）。
- [ ] T033 [US1] FTS 排除 `$._ingest`。只替換 trigger、不重建；用 10 萬列的 fixture 斷言開啟時沒有重建（FR-025）。
  - 2026-11-14 對帳（PR #765）：`db/index.ts:443-459` 只替換兩個 insert trigger，`test/fts-excludes-ingest.test.ts` 斷言以舊 trigger 建立的專案開啟時沒有重建語句、索引列數與每列 token 大小不變、新列找不到 stamp 的字。未達成：該測試只用 80 列（檔頭：10 萬列的量測留給 T091／CI），沒有 10 萬列的 fixture。
- [x] T034 [P] 檢查 064 的 contract coverage 與其他依 `data` 鍵集合判斷的讀者（plan「其他讀者」），斷言隨變更一起修改。
- [ ] T035 [US1] `chain-anchor.ts` 與 `redlog-verify.py` 新增來源狀態報告（已證明、自述、無法判斷；FR-022–024）；用共用向量斷言兩者一致；結束碼不變。
- [ ] T036 [US1] 入口等價測試（FR-093）。
  - 測試在 `test/ingest-door-equivalence.test.ts`，比對 in-process、legacy-api、legacy-handoff。
  - 未成立，以 KNOWN DIVERGENCE 釘住：`_ingest.producer`（`in-process`／`legacy`／`legacy-handoff`）；欄位 `source`、`mapper`（雜湊外）；交接列 data 多 `recovered_from_spool: true`（雜湊內，Timeline 讀它）。要改哪些需要擁有者決定。
  - 已修正：交接檔原本不讀 body 的 `target_id`，而 `pcap-agent.py` 在 POST 失敗時會整筆交接帶它的項目；現在兩個入口以同一個函式讀它（`src/core/ingest/body-target.ts`）。
- [x] T03A [US1] 寫入端限制 `data` 的深度（FR-097，DECISIONS 2026-11-14 §1、§2 與其後續，plan D13）：`MAX_DATA_DEPTH = 64`；第 64 層含容器或為標記形狀的容器換成 `{"_collapsed": <JSON 文字>}`，`_ingest.collapsed` 計數；`restoreDataDepth` 只憑存入的列還原，字串不是 JSON 的包裝原樣保留；兩層、每個入口（含 API）；第 1–63 層與第 64 層的葉容器原樣（同一個物件、`JSON.stringify` 的位元組、無 `collapsed`）；對 JSON 能表達的值存入不超過 64 層，例外（Buffer、`toJSON`）有測試；`jsonText` 超過一百萬層拋 `RangeError`；界限之前把來源欄位轉成文字、鍵或數字的每一處經 `field-text.ts`（plan D13 的呼叫點表；七個欄位 × 三種形狀經 API 與交接檔的測試）；寫入後的步驟隔離，已寫入的列不回失敗；沒有無列的 sidecar；整個本體或交接檔超過十萬層時解析前拒絕（API 413 與 `reason`、交接檔隔離），寫缺口列，API 的缺口 60 秒合併；`operator-pii.ts` 的樣式線性時間且不越過字界與路徑段；bundle README 說明 `_ingest` 與包裝；兩個 verifier 不變。
  - 程式：`src/core/ingest/depth.ts`（`boundDataDepth`、`restoreDataDepth`、`jsonStringify`；容器文字以明確堆疊寫出，`toJSON` 收到所在的鍵，沿路複製保留原型與自有 `__proto__` 鍵，循環以 Brent 法偵測）；`event-write.ts` 兩層在加上 `_ingest` 時套用；`stamp.ts` 的 `collapsed`；`api-server.ts` 事件路由 `readJsonObject(..., { depthGate: false })`、`api-request.ts` `parseJsonObjectBody` 的 `depthGate`；`tailer-host.ts` 的 `deepRedactStrings` 改為不遞迴、大小檢查改用 `jsonStringify`；`operator-pii.ts` 的樣式在任何跳脫層數都相符。
  - 測試：`test/ingest-depth-bound.test.ts`（規則的邊界、`["[1]",[1]]` 等無法以數目區分的情形、來源的標記形狀物件在 63／64／包裝內、`JSON.stringify` 的特殊值與 `toJSON` 的鍵、原型、`__proto__`、循環、100,000 層、只用存入列還原的 property test、兩層與各寫入方式、去重、FTS 與其跳脫序列的限制、app 的 chain verifier）、`test/ingest-depth-doors.test.ts`（API 在 63／64／65／1,000／100,000 層與 5,000 層的 `params.body_json`、20 MiB 上限、交接目錄、兩個入口的重送去重）、`test/ingest-door-equivalence.test.ts`（過深項目在三個入口等價）、`test/api-route-guards.test.ts`（其他路由 10,000 層仍回 400）、`test/ingest-depth-tailer.test.ts`（80、40,000、100,000 層的 AI 工具輸入與其後一輪）、`test/tailer-redact-iterative.test.ts`（與舊的遞迴版本逐項相同）、`test/operator-pii.test.ts`（三種跳脫層數）、`test/depth-vectors.test.ts` 與 `test/fixtures/depth-vectors/`。`provenance-vectors`、`golden-pre071`、`ingest-golden` 未重錄。
  - 本任務之外仍會遺失過深觀察的地方（plan D13）：mitm addon 自己的 `json.loads`（Python 3.9 約 1,000 層 `RecursionError`，未驗證於 mitmproxy 內附的 Python）；AI 工具輸入超過 100 KiB 時只存鍵名（`MAX_FULL_BYTES`）；Codex adapter 的 `JSON.stringify(payload.output)` 在 Node 約 6,100 層時被吞掉；收到非 2xx 就丟棄的來源（`c2-tailers/follow.js`、`pcap-capture.js`、`redlog-relay.py`）。
- [ ] T037 遷移 31 處直接呼叫（下列分組依起草時的清單；確切位置以 T006 量得的清單為準），每個 PR 只遷移一個檔案群，T006 的基準值逐次下降；與 Spec 072 T045（型別化入口）同一批：
  - [ ] T037a `main/index.ts`（11 處）
  - [ ] T037b `retention.ts`（5）
  - [ ] T037c `scope-recompute-run.ts`（3）
  - [ ] T037d [P] `update-anchor.ts`（2）、`chain-anchor.ts`、`export-direct-bundle.ts`、`bundle-export.ts`、`sanitize.ts`
  - [ ] T037e [P] `loot-detector.ts`、`alert/surface.ts`、`marker-amend.ts`、`ipc/markers.ts`、`ipc/plugins.ts`
- [ ] T038 `insertEvent` 的內部閘門改為丟錯；commit 原語不再回傳 null（FR-095），改為回傳 `CommitReceipt`（FR-096，先 RED：每次 commit 一個遞增的 `seq`、rowid 水位正確、沒有任何列或表多出欄位）；T006 的基準值歸 0。Spec 074 T023 的過渡包裝在此被取代。
- [ ] T039 修訂 Spec 003（Verified）FR-004（不再允許例外），與 T038 同一個 PR。
- **Gate**：五道 gate；T002 不變；T006 為 0；ubuntu e2e 全綠（capture 相關的 spec 在 PR 前於本機逐一執行）。

## Phase 4 — 憑證與能力（O1、O6、O9）

- [ ] T040 [US4] 先 RED：`test/route-capabilities.test.ts`。每條路由都要宣告能力；每一類來源憑證對非寫入路由都得到 403（SC-006）。
- [ ] T041 [US4] 實作 `src/core/credentials.ts`：登記檔、發放、輪替（寬限期）、撤銷、bearer 驗證、MAC 金鑰導出。登記檔以 0600 原子寫入。憑證檔的寫入與收回經 Spec 073 的 `install-ledger`（`credential-file`）；073 T071 落地前直接寫，接上帳本是 073 T076。
- [ ] T042 [US4] 在 `api-server.ts` 加入中央的 `authorize(route, credential)`；把 seed、amend、heartbeat 等現有特例改寫成能力規則。
- [ ] T043 [US5] 升級遷移（FR-078）：
  - 每個專案在第一次開啟時換新操作者憑證，舊值降為 `legacy`；
  - 鏡像改到 `credentials/operator`；
  - `api-token` 改放機器層級的 `legacy`；
  - 修訂 `per-project-token.test.ts`。
- [ ] T044 [P] [US4] app 啟動時為已安裝的 hook、`builtin-terminal`、受管代理寫憑證檔（FR-072）。
- [ ] T045 [P] [US4] 外掛 Source：第一次在任一專案啟用時依 `emits` 發放機器層的 `plugin:<id>`，機器層停用、撤銷、內容雜湊改變、移除即撤銷（O6、FR-076）；寫入 chained 的發放與撤銷紀錄。專案層的 `on`／`off` 只由 FR-07A 的政策判斷，不發放、不撤銷。觸發點是 Spec 075 T082。
- [ ] T046 [P] [US4] `system.producer_enrolled`（FR-077）。
- [ ] T047 [P] CLI 讀新的操作者憑證路徑；在 403 時說明憑證已搬家；新增 `credential create|rotate|revoke` 指令（遠端主機用）。
- [ ] T048 [US4] 擴充 `test/shell-token-not-in-argv.test.ts`，涵蓋每個來源與內建終端機 pane 的環境變數（FR-074）。
- [ ] T049 FR-07A：官方 AI adapter 依 Spec 073 `ai-consent` 的專案同意判斷；外掛 Source 依 Spec 075 的 `enabledForProject`；不是有效同意或 `on` 時回 `source-disabled`。先 RED。073 T082、075 T082 落地前，兩者以今天的對等事實（`resolveAgentCapture`、專案設定）判斷。
- **Gate**：五道 gate；`e2e/recording-pause.spec.ts` 的拒絕路徑在窄權限憑證下仍成立；真機確認升級時開著的舊 shell 仍持續記錄（US5-2）。

## Phase 5 — 契約 1：接收端、存活、帳本、交接 v1、一致性工具組

- [ ] T050 [US6] 先 RED：`test/ingest-receipt-contract.test.ts`，列舉 FR-031 的每個 reason，以及請求層級的 400、401、413、503。
- [ ] T051 [US1] `ingest_keys` 加上 `/api/ingest`。故障注入「commit 後回應遺失」1000 次（SC-002）；同 id 異內容回 `key-conflict`；`pruned` 的情況也要測。
- [ ] T052 [P] [US6] 舊入口增加 `outcome`／`reason`，並修正跨專案的錯誤文字（FR-036）；T003 只允許這兩處差異。
- [ ] T053 [US3] `ingest_instances`、`discarded` 的累計差值計算、缺口結算、寫入 `system.capture_gap`（FR-051–054）。先 RED。
- [ ] T054 [US3] 存活通道：`hello`、`alive`、`bye`；capture-health 改讀存活表；舊入口收到的 heartbeat 改送存活表、不再寫入（O7、SC-012）。同 PR：`ingest_producers` 的第一次與最近一次接受（FR-056），先 RED（保留期刪列後第一次接受不變）。
- [ ] T060 [P] `/api/whoami` 回傳呼叫者的憑證與來源狀態（FR-07B）。先 RED：每一類來源憑證得到自己的一項；沒有專案時為 `unknown`；Spec 075 Phase 2 之前一律 `unknown`。075 T064 是它的讀者。
- [ ] T055 [US4] 交接 v1：
  - `src/core/handoff-dir.ts`：每專案目錄、驗 MAC、依政策處理、commit 後刪檔、隔離區上限、tmp 孤兒；
  - 暫停狀態檔 `state/recording`（FR-080）。
- [ ] T056 [P] [US3] 故障注入：滿、寫入失敗、損毀、tmp 孤兒、撤銷、未送 bye 當掉、提權寫入的檔（SC-004）。
- [ ] T057 [US7] 一致性工具組：`test/conformance/ingestion/` 的向量、mock receiver（真實管線加可注入的結果）、驅動程式、`xfail` ratchet；`scripts/conformance-matrix.mjs`；CI 上傳 artifact。
- [ ] T058 [P] [US3] 隔離區的狀態事實，以及「開啟所在資料夾」與「清除」（清除寫 chained 紀錄）；沿用 #255 卡片的形式；跑 `test/ui-copy.test.ts`。
- [ ] T059 [P] `api-server.ts` 的死狀態 `castProbe`、`castOffsetAtStart`（07-F6）與本 Phase 的路由一併移除。
- [ ] T061 [P] perf lane：一百萬項的 `ingest_keys` 大小、每項的工作量計數（SC-009）。
- **Gate**：五道 gate；一致性驅動程式對 mock receiver 自身的向量全綠。

## Phase 6 — 來源逐一換上契約（每個來源一個 PR，各附一致性結果）

- [ ] T070 [P] [US7] `hooks/redlog_client.py`（POST、回執處理、交接寫入加 MAC、累計計數狀態檔、hello 與 bye）。
- [ ] T071 [US7] mitm addon 改用 `redlog_client`；4xx 交給接收端計數；`capture_gap` 改為 `discarded`。依賴 T070。
- [ ] T072 [P] [US7] `pcap-agent.py`：沒有 port 時寫交接檔，不再丟棄。依賴 T070。
- [ ] T073 [US7] `redlog-relay.py` 與 `redlog-session.py`：每個指令一個 instance；最後一列走契約；`bye`。依賴 T070。
- [ ] T074 [US7] `shell-common.sh`（bash 3.2 與 5、zsh）：
  - `event_id` 與序號；
  - 觀察點暫停；
  - 交接寫入交給 python helper；
  - 載入時零輸出；
  - 第一次綁定時送 `hello`；
  - 成功送達不多啟動行程（FR-103）。
- [ ] T075 [US2] 外部終端機切換專案即暫停，綁定專案重開時送 `capture_resumed`（O10、D11）。修訂 Spec 052 FR-010 與 `shell-common.sh:312-325` 的註解；`test/terminal-enrollment-agreement.test.ts` 的狀態表與 Spec 073 T060 共用，與 073 T060／T061 同一個 PR 或同日配對 PR。
- [ ] T076 [P] [US7] PowerShell client（`shell-hook.ps1`、`redlog-send.ps1`，5.1 與 7），移除 `catch {}` 吞錯。
- [ ] T077 [P] [US7] JS client：`plugins/_shared/redlog-client.js`；c2-tail 的 offset 在被接受後才持久化；pcap-capture 的 heartbeat 改成 `alive`，並依回執處理每一次 POST：沒有連線與 `retry` 寫交接檔，任何非 2xx 都不再被當成已送達（FR-058）。
- [ ] T078 [P] [US1] 行程內來源的決定性 `event_id`：tailer 用 transcript uuid；terminal-manager 用 recording id 加 command id（FR-043）。
- [ ] T079 [P] `redlog-cli log` 改走契約 1。
- **Gate**：五道 gate；每個來源都在其支援平台通過一致性測試（SC-008）。T004 的 `it.fails` 逐一翻正，或依新契約改寫。

## Phase 7 — 文件與領域契約

- [ ] T080 新增 `docs/domain/SPEC-ingestion-contract.md`（用戶端規格本文，契約 1）；glossary 加入 Producer、Producer Instance、Credential、Handoff Directory、Receipt、Loss Ledger、Observation Time。
- [ ] T081 [P] 更新 `docs/api-reference.md`（`/api/ingest`、`/api/whoami`、舊入口新增的欄位、能力表）與 `docs/agent-integration.md`（依 O13）。
- [ ] T082 [P] 修訂 `DESIGN-plugin-kernel.md` §3（`/api/ingest` 的新定義）、`DESIGN-two-tier-chain.md` §2.1（外掛種類預設為 logged）、`DESIGN-capture-trust.md` §3（暫停改以區間判斷）。
- [ ] T083 [P] 遠端主機部署：`hooks/vps-deploy.sh` 因把 API token 複製到遠端已移除（2026-11-13）；若要恢復，以 `remote:<名稱>` 憑證重建，不得複製 API token。
- **Gate**：五道 gate；`verify:specs`。

## Phase 8 — 驗收

- [ ] T090 建立 `verification.md`（依 `.specify/templates/overrides/verification-template.md`）：
  - RED（T007、T008、T020、T023、T040、T050、T053 失敗的原因）；
  - GREEN；
  - Gates（Clarify、Checklist、Analyze、Converge）。
- [ ] T091 真機驗收：
  - macOS：升級時有開著的舊 shell；暫停中 `kill -9` 後打指令再重開；`nmap &` 跨重啟；斷網跑錨定一小時，確認沒有 `'default'` 列。
  - Kali 或 Linux：受管代理、sudo 下的 pcap。
  - Windows：PowerShell 5.1 與 7、WSL。
  - 打包版：跑 `redlog-verify.py` 的來源報告，以及 `docs/RELEASE-SMOKE-TEST.md` 的 INSTALL、EXTERNAL SHELL、HTTP 節。
- [ ] T092 更新 `specs/README.md` 的索引；全部完成並驗證前，Spec 071 維持 Draft。

## Phase 9 — 修訂（2026-11-13）的任務

每項都先 RED；不改 FR-080–084（修訂 A5）。

- [ ] T100 [P] RED：`test/egress-stamp.test.ts`。對 FR-121 的六種狀態各一案例（以注入的 `IPProducerState`）：`source_ip` 與 `_ingest.egress`、`egress_at`、`egress_via`；舊列不變（T002 不變）；`_ingest` 大小仍在 FR-006 內。共用向量加「`source_ip` 非 null 的 chained 列」，兩個 verifier 結果一致。
- [ ] T101 `event-write.ts:609,723` 改由入口傳入的出口填值（入口在蓋章階段讀一次出口讀取器的快照）；T100 翻正。
- [ ] T102 [P] `system:egress_changed`（FR-123）：寫入時機的狀態表測試；與 072 的登記同 PR。
- [ ] T103 [P] `Egress` 形狀進 `/api/whoami` 與 075 payload（FR-122）；075 FR-025 的「未知不顯示為安全」測試共用同一組案例。
- [ ] T104 [P] FR-088 的 `data.term`：zsh、bash、PowerShell 的 hook 與向量；`tty` 快取、不多起行程（FR-103 的計數測試）。
- [ ] T105 [P] FR-086、FR-087：第一次綁定的提示行、`redlog private` 的 (a)(b)；共用向量；與 Spec 073 FR-041 的停止原因清單同 PR。
- [ ] T106 FR-07C：刪除專案層外掛啟用的接收端檢查（FR-07A 的外掛部分），改為只看憑證；FR-072 的發放時機改為機器層啟用（Spec 076 T050–T051 配對）。
- [ ] T107 [env: Linux 跳板＋ssh 反向轉送] FR-130–134：`redlog remote add|revoke|uninstall`、遠端佇列、`--no-spool`；遠端永不存放項目的檔案掃描測試；刪除 `hooks/vps-deploy.sh`。
- **Gate**：五道 gate；T002、T003 不變。

## Dependencies & Execution Order

- 依序：Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8。跨 071–075 的順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」。
- 依賴兄弟規格的任務（其餘任務都不等它們）：T027 ＝ 072 T040（同 PR）；T024 與 072 T043 同 PR，回填在 074 T052；T060 的狀態值在 075 Phase 2 之後才非 `unknown`；T075 與 073 T060／T061 配對；T041 的帳本接線在 073 T076。
- 可平行的範圍：Phase 1 的全部任務；T022、T025、T026 與 T031–T036 互相平行；Phase 6 的 T072、T076–T079 在 T070 完成後平行。
- T037 一次只遷移一個檔案群（`main/index.ts` 同時只能有一人修改，DESIGN-project-runtime §4）。

## 明確排除

見 spec「不在範圍」。

