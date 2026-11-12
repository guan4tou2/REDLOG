# Tasks: 交付邊界、私人內容與內容生命週期

**Input**：[spec.md](spec.md)、[plan.md](plan.md)

**規則**：

- 每個 Phase 結束時 main 都可出貨，並以列出的 gate 收尾。
- 每個行為任務先寫 RED，再實作。
- `[P]` 可平行（不同檔案、沒有相依）。`[USn]` 對應 spec 的故事。
- 每次 push 前依序跑五道 gate：`npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n && npm test`。
- 不需要任何相容（R8）：沒有遷移任務、沒有並存版本、沒有棄用期。被取代的東西在同一個 Phase 刪除，列在文末「刪除清單」並由 T097 的 gate 鎖住。唯一的殘留要求：遇到不理解的資料不當掉（T005）。
- 依專案記憶，本機不跑 Electron e2e；e2e 交給 CI。
- 等待兄弟規格的地方寫明過渡做法；過渡做法不得建立第二條交付路徑。

## Phase 0 — 工作流程前置

- [ ] T000 依憲章執行 Clarify、Checklist、Analyze，結果記入 `verification.md` 的 Gates；Q1–Q5 的答覆記在 spec。Q5 答覆前，T075 只實作「操作者按下才查」的路徑。

## Phase 1 — 匯出面的包含數字端到端（單一交付點＋排除；R2 從此成立）

目標：匯出面上「範圍內／範圍外（含這次包含）／待確認／個人」四個數字在每一個出口端到端成立；活動紀錄的一個鍵餵進「個人」。待確認在本 Phase 一律扣下（分組回答在 Phase 2）；遮蔽維持今天的狀態（Phase 4 取代）；bundle 中被扣下的列在本 Phase 仍使 bundle 成為 window／projection（stub 在 Phase 3）。

- [ ] T001 [P] RED：`test/delivery/single-exit.test.ts`（FR-090）。掃描讀 `events`／`events_logged`／`http-bodies` 並寫出對外位元組的模組；今天的違規清單（至少 `redact-export.ts`、`bundle-export.ts`、`har-export.ts`、`ndjson-export.ts`、`export-events-file.ts`、`api-server.ts:418-509,670-734`）記為基準，只能下降，Phase 1 結束時為 0。
- [ ] T002 [P] RED：`test/delivery/no-withheld.property.test.ts`（FR-091）。fast-check 產生器（072 登記表的種類、兩層、sidecar、註記、規則、範圍）；每個出口一個 adapter。今天以 `it.fails` 標示 API 讀取與 API 匯出兩個出口（前提更正）。
- [ ] T003 [P] RED：`test/delivery/state.test.ts`：FR-004 優先序、FR-021 表、FR-022 確定目標清單（不含名稱／位址兩面，那在 Phase 5）的每一格。
- [ ] T004 [P] [US4] `test/delivery/session-target.test.ts`：US4 的 fixture（`ssh`、巢狀跳轉、`nc -lvnp`、遠端 hook 列）；`ssh -J`、樞紐兩案先 `it.fails`（Phase 5 的 T061 翻正）。
- [ ] T005 [P] `test/delivery/unknown-data.test.ts`：未知版本的 `delivery_mark`、未知選擇器、未知種類：不拋出，`health()` 計數，涵蓋的列為 `ask`。
- [ ] T010 072 登記 `system:delivery_mark`（`role: annotation`、`chained`、`pause: exempt`、`writers:['in-process']`）與 `system:delivery_rule`；閱讀器 `fields`。過渡：071 單一入口未落地前，由主行程經今天標記使用的寫入點（`ipc/markers.ts` 同一層）寫入。
- [ ] T011 `src/core/delivery/selectors.ts`、`state.ts`（FR-002–004）；推導列承接 `_causes`；`command_id` 涵蓋背景輸出（承接今天 `do-not-export.ts:18-42` 的邏輯）。T003 翻綠（單面部分）。
- [ ] T012 `src/core/delivery/target.ts` 的第一版 `classifyTarget`：確定目標（FR-022 第 1、2、5、6 項）＋ `classifyScope` 單面；`no-scope` → `ask`（修正 `scope-evaluator.ts:233-235` 在交付上的意義，分類器本身在 T060 改）。
- [ ] T013 `src/core/delivery/deliver.ts`：`deliver(request) → DeliveryStream`、`DeliverySummary`（FR-040）；`includeOutOfScope` 請求旗標（FR-004、D21）。在匯出 worker 上執行；API 讀取經 074 讀取服務呼叫同一函式（過渡：074 未落地前在今天的讀取路徑上呼叫，仍是同一個函式）。
- [ ] T014 `src/core/delivery/writers/`：json、ndjson、timeline、har、bundle 只吃 `DeliveryStream`；`DeliverySummary` 依 FR-045 寫入各格式。刪除 `redact-export.ts`、bundle 內的排除與 sanitize 交換（`bundle-export.ts:347-416,437-475`）、`scope-sanitize.ts` 的 `isPersonalDomain`／`scopeMaskReplacements` 的交付用途。
- [ ] T015 `export-planning.ts`：計畫由 `deliver` 的摘要產生；`ExportCounts` 改為 `{inScope, outOfScope, includedOutOfScope, unanswered, personal, cleared, reclassified}`；`validateExportSources` 比對交付狀態摘要（Edge Cases）。
- [ ] T016 `api-server.ts`：`GET /api/events`、`/api/events/search`、`/api/http-body/:sha`、`/api/terminal/replay`、`/api/export/har`、`/api/export/bundle` 全部經 `deliver`；回應帶 `excluded`（FR-037、FR-045）。T002 的 API 出口翻綠。
- [ ] T017 [US1] `ExportMenu.tsx`：包含區段（FR-031）取代 `:601-606` 的三列與 `maskScope` 開關（`:529-530`）；「這次包含」勾選；完成畫面一行摘要（FR-036）。`test/ui-copy.test.ts`、對話框快照（主動作唯一，SC-008）。
- [ ] T018 [US3] 活動紀錄的一個鍵（FR-010）、右鍵選單的選取延伸（FR-011）、收合（FR-015）、閱讀器第一行（FR-016）、目標頁不計個人列（FR-017）。先讀 `src/renderer/src/lib/shortcuts.ts` 全檔與 `useListKeyboard` 確認 `p` 未被佔用，衝突時另選並記入 plan D14。
- [ ] T019 [P] 查詢語言鍵 `delivery:`（FR-006）與 `operator` 讀取的搜尋預設排除個人列（FR-007），經 `parseQuery` 同一份契約。
- [ ] T020 刪除：`do_not_export` 表與 `db/do-not-export.ts`、IPC `events:toggleDoNotExport`／`events:isDoNotExport`、`TimelineEventInspector` 的切換鈕與四個 i18n 鍵；`scope.personalDomains` 設定鍵與其讀者；`export.preview.dropped`、`personalDropped`、`maskScope*`、`policy*` 等 i18n 鍵；`verify:i18n` 會指出斷言它們的測試，一併改寫（CLAUDE.md「Changing behaviour」）。
- **Gate**：五道 gate；T001 為 0 違規；T002、T003（單面）、T005 綠；e2e「預覽＝位元組」一支（`e2e/export-delivery-counts.spec.ts`，CI）。

## Phase 2 — 待確認就地分組回答；規則；私人終端機

- [ ] T030 [P] `test/fixtures/delivery/engagement-a.ndjson`（2,000 列）、`engagement-a-day2.ndjson`（+500）與標註；`scripts/measure-delivery-questions.mjs`（plan D15）。RED：門檻（SC-003）。
- [ ] T031 `src/core/delivery/groups.ts`（FR-025）；「依終端機分開」。
- [ ] T032 [US2] `ExportMenu.tsx`：待確認行展開為問題組（FR-026、FR-035）；回答寫 `delivery_mark{reason:'answer'}` 並重新解析計畫。
- [ ] T033 [US8] `src/core/delivery/rules.ts`：機器層 `personal.rules[]`（073 的 `machine.yaml`；過渡：073 Phase 4 前存在 `~/.redlog/personal-rules.json`，0600，073 落地時搬入，不留兩份）、專案層 `delivery.rules[]`；`since`；`system:delivery_rule`（FR-020、FR-023、FR-024）。「以後一律」勾選（FR-013）。
- [ ] T034 [US8] 設定「資料與隱私」分組中既有位置的一列「私人」：檢視、改動作、刪除規則。不新增頁面。
- [ ] T035 [US8] 來源列綁定控制項的「私人」值（FR-014）；需要 075 每個 shell 一列的來源列與 073 FR-041 的停止原因（等待 075 Phase 3–6；之前不實作，不以其他介面代替）。
- [ ] T036 刪除 076 FR-050／T071 計畫中的 `private` 動詞與 hook 中的 `redlog private`（若已實作）；協調者修改 071／073／076 的條文後執行（R11）。
- **Gate**：SC-003 的三個數字在 CI 印出且達標；決策表含規則的格全綠。

## Phase 3 — Stub 與 bundle 的唯一格式

- [ ] T040 [P] RED：`test/evidence-vectors.test.ts` 新案例（US5 的每一個竄改）；兩個 verifier 同結果。
- [ ] T041 `evidence-rules.ts`：`BUNDLE_VERSION = 5`、seal 新版、stub 的形狀與規則、`window` 與 `complete-chain`（FR-042）；刪除 `projection`、`transformedEventIds`、`sanitized*`、`personalDropped`、`doNotExportDropped` 欄位與 v4 白名單（`bundle-verify.ts:45-49`）。
- [ ] T042 `bundle-verify.ts` 與 `tools/redlog-verify.py`：stub 的連結檢查、扣下摘要的輸出行（FR-043）；不再接受第 5 版以外的 bundle。
- [ ] T043 bundle writer：交付範圍內每個位置寫完整列或 stub；附件跟著列（FR-046，`contains-withheld`）。
- [ ] T044 app 內驗證（`chain-anchor.ts` 的 `verifyChainFullAsync`、證據頁）認得清除過的列（FR-044；與 Phase 7 一起生效）。
- **Gate**：T040 綠；SC-004。

## Phase 4 — 遮蔽引擎（076 Q4 的前提之一）

- [ ] T050 [P] RED：`test/delivery/redact.property.test.ts`（FR-092）；報告 11 的 I1–I12 各一案例。
- [ ] T051 `src/core/delivery/redact.ts`：規則集（FR-050）、`policyVersion`、結構規則、十六進位規則、loot 值、PII；`scanWrite` 給寫入路徑的 P1、P2、P3、P7（只算 span）。
- [ ] T052 `deliver` 每個出口套用 `redactForDelivery`；sidecar 重掃；`http-bodies/<sha>.redacted`；`system:redacted`（FR-051–053）。
- [ ] T053 verifier：遮蔽列的替代雜湊核對與報告行（FR-053）；共用向量。
- [ ] T054 [US6] `ExportMenu.tsx` 遮蔽區段（FR-032）：數字、就地展開的清單、PII 項；附件清單的「無法遮蔽」（FR-054）。
- [ ] T055 刪除：`sanitize.ts`、`sanitized_events` 表、`/api/sanitize`、`redlog-cli sanitize`、`system:sanitized` 的寫入、`operator-pii.ts` 的獨立入口；`docs/redaction-design.md` 改寫為「寫入時偵測、交付時遮蔽」。
- [ ] T056 突變檢查（FR-093），CI 步驟；正式產物不含突變分支的 gate。
- **Gate**：T050、T056 綠；FR-074 的 (b) 成立。

## Phase 5 — 名稱與位址

- [ ] T060 `scope-evaluator.ts`：範圍項目分型（名稱／位址）；`classifyTarget(name?, address?, at, scope, mappings)` 依 FR-101 與 plan D17；目標頁改用它（FR-107）。決策表逐格（FR-102）。
- [ ] T061 `target-extractor.ts`：`ssh` 的最終目的地（`-J`、`-o ProxyJump`、`ProxyCommand` 指名的主機是跳轉，`:31`）；`sshuttle`／`chisel`／`ligolo` 的樞紐主機不作為被包裝工具的目標；`proxychains` 經 `wrappers` 解析（FR-022 第 3、4 項）。T004 翻綠。
- [ ] T062 `hooks/mitmproxy-addon.py`：HTTP 流記錄 `server_addr`（`server_conn.peername`）與 `server_addr_via: direct | upstream`；SNI／Host／URL 不一致時記錄；先以真實 mitmdump 確認直接連線時 `peername` 可靠（plan UNCONFIRMED）。
- [ ] T063 `src/core/delivery/mappings.ts`：`observed-dns`（`dns_response`）、`observed-http`（T062）、`hosts-file`、`lookup` 的讀取與「早於 t 最接近」（FR-103）。
- [ ] T064 `src/main/services/hosts-file-watch.ts`：只把提到範圍項目的條目寫成 `system:name_mapping`（FR-104）。
- [ ] T065 `src/main/services/scope-resolve.ts`：FR-105 的全部條件；`network.offline` 時呼叫路徑不存在（注入的解析器計數 = 0，SC-010）；`system:name_resolved`；範圍設定中的「解析範圍內的名稱」動作；開關 `network.resolveScopeNames` 的預設依 Q5。
- [ ] T066 FR-106：`delivery_state` 記住每列上次交付時的關係；匯出面「分類改變」行。
- [ ] T067 [P] 072 登記 `system:name_mapping`、`system:name_resolved`、`system:redacted`、`system:content_cleared`。
- [ ] T068 [P] 閱讀器第一行的對應來源字（FR-016）。
- **Gate**：US7 的測試；SC-010。

## Phase 6 — 不記錄（R3，選用）

- [ ] T070 [P] RED：hook 共用向量（071 格式）：`skip` 命令規則、`followShellHistory` 的 bash／zsh 各規則、`ignoredups` 永遠不遵循。
- [ ] T071 app 寫 `~/.redlog/personal-skip.json`；`hooks/redlog-relay.py`、`shell-bash-hook.sh`、`shell-zsh-hook.zsh` 在觀察點讀它與歷史設定；略過用掉序號並計 `ignored-rule`／`shell-history-rule`（需要 071 FR-050 加這兩個原因）。PowerShell：只有 `skip` 命令規則。
- [ ] T072 addon 與接收端的 `host` skip 規則在 commit 前評估（FR-081）；AI 的 `ai-path` 經 `excludedPaths`。
- [ ] T073 075 狀態讀數的「略過 N」（FR-018）。
- **Gate**：T070 綠；US8 情境 2、3。

## Phase 7 — 清除內容（R4）

- [ ] T080 [P] RED：清除後掃描（FR-096，臨時 home）；trigger 例外的單元測試（plan「清除的範圍」UNCONFIRMED 一項）。
- [ ] T081 `event-write.ts`：`no_update_events_hash` 的例外與 `content_clear_authorized` 表（FR-062）。
- [ ] T082 `src/core/delivery/clear.ts`：FR-061 的每一個儲存、`system:content_cleared`、checkpoint、選用 VACUUM。
- [ ] T083 [US10] 活動紀錄與閱讀器右鍵選單的「清除內容」，以既有 `ConfirmDialog` 的輸入確認；確認中列出 FR-065 的項目與連帶失去的回放。
- **Gate**：T080 綠；SC-006。

## Phase 8 — 擴充功能的讀取與 Exporter 目的地（依 076）

- [ ] T090 [US9] 076 的 L0 讀取 API、L2 面板資料、Exporter 批次只經 `deliver`；`reads.withheld`；Exporter 不得含 `personal`（FR-070–073）。等待 076 Phase 6 與 Exporter 的 Phase。
- [ ] T091 [US9] 匯出面目的地選單加入本專案已啟用的 Exporter（FR-033）；選它時格式固定為對齊列；`system:export_shipped` 帶 `withheld`。
- [ ] T092 FR-074 的核心檢查：三個條件任一不成立時拒絕啟用 `command`／`content` 層級。
- [ ] T093 076 對齊列的最後一列 `kind = "redlog:delivery"`（FR-045；076 契約 §7 由協調者加入後）。
- **Gate**：US9 的測試；SC-009。

## Phase 9 — 文件與驗收

- [ ] T095 `docs/domain/glossary.md` 新增術語（spec Domain References）；`docs/USER-GUIDE` 的匯出一節依匯出面改寫；`docs/audit-trail.md` 寫 stub、遮蔽與清除各證明什麼、不證明什麼。
- [ ] T096 `verification.md`：每個 SC 的證據；實機：真實 mitmdump 的 `server_addr`、hosts 檔監看（macOS／Linux／Windows）。
- [ ] T097 刪除清單 gate（FR-097）：把下列名稱加入 `scripts/verify-specs.mjs` 的 forbidden alias。

## 刪除清單（R8：刪除，不包裝）

| 刪除 | 由什麼取代 | Phase |
|---|---|---|
| `do_not_export` 表、`db/do-not-export.ts`、IPC `events:toggleDoNotExport`／`isDoNotExport`、Inspector 的切換鈕與 i18n 鍵 | `system:delivery_mark`、活動紀錄的一個鍵 | 1 |
| `scope.personalDomains`、`isPersonalDomain`、`excludedPersonal`、`personalDropped` | 機器層私人規則（`host`） | 1 |
| `redact-export.ts`（`redactEventForExport`、`BODY_REF_FOR` 的交付用途） | `deliver`＋`redactForDelivery` | 1／4 |
| `bundle-export.ts` 內的排除、sanitize 交換、scope 遮罩 | `deliver` | 1 |
| `scopeMaskReplacements`、`scopeBodyRefsToDrop` 的交付用途、`maskOutOfScope`／`scopeOnly` 請求欄位、匯出面的 `maskScope` 開關 | 範圍外預設不交付＋「這次包含」 | 1 |
| `sanitize.ts`、`sanitized_events` 表、`system:sanitized` 的寫入、`/api/sanitize`、`redlog-cli sanitize` | 交付時遮蔽、`system:redacted` | 4 |
| `operator-pii.ts` 的獨立入口、`scrubPii` 的格式限制 | 遮蔽規則集的 `pii` | 4 |
| bundle v4 的 `projection`、`transformedEventIds`、`sanitized*`、`doNotExportDropped` 與 verifier 對它們的理解；所有舊版 bundle 的讀取 | 唯一格式（stub、`window`、`withheld`） | 3 |
| `redlog private` 與任何終端機的私人／清除動詞 | 來源列的「私人」、列動作「清除內容」 | 2（R11） |
| `TimelineEventInspector.tsx:483-484`、`Timeline.tsx:1661-1666` 宣稱 layer 4 的註解 | — | 1 |
