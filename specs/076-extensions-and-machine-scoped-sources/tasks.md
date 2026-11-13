# Tasks: 擴充功能模型與機器層級的擷取來源

**Input**：[spec.md](spec.md)、[plan.md](plan.md)、[contracts/extension-api-v1.md](contracts/extension-api-v1.md)

**規則**：

- 每個 Phase 結束時 main 都可出貨，並以列出的 gate 收尾。
- 每個行為任務都先寫 RED，再實作。
- `[P]` 表示可平行（不同檔案、沒有相依）。`[USn]` 對應 spec 的故事。
- 每次 push 前依序跑五道 gate：`npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n && npm test`。
- **Phase 1–3 不搬任何寫入路徑上的東西**（R2、FR-023）；每個 PR 在合併前後都跑基本路徑釘住測試組（T002–T004），輸出相同。
- 需要特定環境的任務標 `[env: …]`。依專案記憶，本機不跑 Electron e2e；e2e 交給 CI。

## Phase 0 — 工作流程前置

- [ ] T001 依憲章執行 Clarify、Checklist、Analyze，結果記入 `verification.md` 的 Gates；開放問題 Q1–Q5 的答覆記在 spec。Q2（`utilityProcess`）答覆前，Phase 4 不開始；遮蔽前提的規格落地前，Phase 9 不開始。

## Phase 1 — 釘住今天的行為（只加測試與 gate，不改程式行為）

- [ ] T002 [P] [US1] `test/extensions/basic-paths-pinned.test.ts`：以 fixture 驅動 shell hook（經 `/api/events`）、AI tailer（Claude Code 與 Codex 的樣本 transcript）、mitmproxy addon 的 flow、標記（IPC、HUD、API 三個寫入點）、快捷鍵截圖、`artifact_added`；釘住每一列除 `id`、時間、`_ingest` 外的欄位與 data，以及 JSON、NDJSON、bundle 匯出的位元組。
- [ ] T003 [P] [US1] `test/extensions/disable-all.test.ts`：把 `state.json` 中每個可停用的 bundled 外掛停用、所有 pack 關閉後，T002 的同一組 fixture 輸出不變（今天的事實；Phase 3 之後以新的停用方式重跑）。
- [ ] T004 [P] [US1] `test/extensions/hud-egress-pinned.test.ts`：釘住 `IPSignalProducer` 的狀態轉移（`externalReadAt`、`stale`、`settling`）與 `ip_verdict` 的寫入時機（`policies.ts:85-94`）。
- [ ] T005 [P] `test/extensions/coupling-baseline.test.ts`：以 import 圖掃描 plan「耦合證據」表的每一列：誰 import 該模組、該模組 import 哪些寫入原語（`configureIngest`、`getDB`、`insertEvent`、`ingestEvent`）、`builtin-terminal` 字面值數（今天 32）。基準只能下降。
- [ ] T006 [P] `test/extensions/manifest-parsers.test.ts`：manifest 解析點計數（今天 3：`plugins/manifest.ts`、`hooks-manager.ts` 的 producer manifest、`official-agents.ts`），只能下降到 1。
- [ ] T007 [P] [US4] RED：`test/extensions/integrity.test.ts`。改 `plugins/c2-tailers/parse.js` 一個位元組，今天 `computeContentHash` 不變（`manifest.ts:308-323`）。以 `it.fails` 標示，Phase 2 翻正。
- [ ] T008 [P] [US2] RED：`test/extensions/activation.test.ts`。新安裝、新專案時有 mitmdump 自動啟動與 CDP 輪詢計時器的登記（13 號 C.1 #19、#23）。以 `it.fails` 標示，Phase 3 翻正。
- **Gate**：五道 gate；新測試在三平台的 unit leg 都有執行，或計 `not-run` 並附原因。

## Phase 2 — 契約成為檔案（不改執行期行為）

- [ ] T020 把 `contracts/extension-api-v1.md` 搬成 `docs/domain/SPEC-extension-api-v1.md`；本目錄的檔改為指標。從 §2 產生 `extensions/extension.schema.json`，從 §3–§4 產生 `src/extension-api/v1.d.ts`。
- [ ] T021 [P] `test/extension-api/golden.test.ts`：schema 與 `.d.ts` 正規化後的雜湊對應 `EXTENSION_API_VERSION`；含 §10 的破壞性變更分類器（移除、改型別、改必填 → 必須升主版本）。
- [ ] T022 [P] `src/core/extensions/manifest.ts`：`parseManifest`、載入錯誤的封閉清單（契約 §4.2），錯誤附 JSON pointer、期望值、實際值。`test/extensions/manifest-consumers.test.ts`：每一個 schema 欄位都有登記的讀者（承接 075 FR-052）。
- [ ] T023 [US4] `src/core/extensions/integrity.ts`：契約 §2.9 的雜湊；`files` 必須完整。T007 翻正（新 manifest）；v1 `plugin.json` 保留舊算法並帶理由（FR-006）。
- [ ] T024 [P] [US3] `test/extensions/manifest-reserved.test.ts`：`views` → `views-reserved`；未宣告的實驗介面 → `experimental-not-declared`；契約 §2.1 末的不接受欄位各一案例。
- [ ] T025 [P] `src/core/extensions/negotiate.ts` 與 `test/extensions/negotiate.test.ts`：契約 §5.4–§5.5 的每一列。
- [ ] T026 [P] `test/extensions/public-api-only.test.ts`：`src/extensions/**` 與 `examples/extensions/**` 只 import `src/extension-api/**` 與 Node 內建（今天為空目錄，gate 先綠）。
- [ ] T027 [P] [US3] `test/extensions/no-network-install.test.ts`（FR-064）。
- [ ] T028 [P] [US11] `redlog-cli extension init|check|test`（開發者工具，Node）：`check` 驗 schema、重算 `files`；`test` 跑 071 的向量、mock receiver 與主機模擬器，輸出 CI 相同的結果列。`examples/extensions/{source,processor,exporter}/`。
- [ ] T029 [P] `translateV1(raw)`：v1 `plugin.json` → 內部形狀（075 FR-070 的規則）；既有 grant 不失效的遷移測試。
- **Gate**：五道 gate；T002–T004 不變。

## Phase 3 — 宣告內建擴充功能（不搬程式碼）

- [ ] T030 [P] `plugins/pcap-capture/extension.json`、`plugins/c2-tailers/extension.json`：`files` 涵蓋全部檔案；`runtime: external`；`defaultEnabled: false`。`plugins/builtin-tools/extension.json` 為 Processor（基本層，不可停用）。建置時產生 `out/extensions-builtin.json`（每個內建擴充功能的雜湊），`verify-packaged-resources.mjs` 斷言存在。
- [ ] T031 [P] `src/core/extensions/builtin/{managed-http-proxy,capture-browser,builtin-terminal,host-monitors}.json`；`BUILTIN_CORE_RUNTIME` 允許清單與 `test/extensions/core-runtime-allowlist.test.ts`（只降）。同一 PR 依 075 的修訂（2026-11-13）讓 075 的描述表由這些 manifest 與核心描述合成（`toDescriptor`）。
- [ ] T032 [US2] RED→GREEN：受管代理、擷取瀏覽器、內建終端機預設關閉；`activation` 只有在啟用且條件成立時才起 mitmdump、CDP 輪詢、pty。T008 翻正。導覽中的終端機只在啟用時出現（DECISIONS §4）。斷言舊的預設行為的 test 與 e2e 是本任務的一部分（`grep -rn` 列出：首次使用、終端機頁、HTTP 自動啟動相關 spec）。
- [ ] T033 [US2] CDP 輪詢在瀏覽器 `exit` 時停止（13 號 C.4）；擷取瀏覽器的計時器登記在關專案時為 0。
- [x] T034 刪除 `plugins/transparent-proxy/`；075 的描述與 i18n 一併（`electron-builder.yml`、`verify-packaged-resources.mjs` 原本就沒有引用它）。已安裝者的移除不走帳本也不在設定頁顯示：外掛已不存在，升級前的 `down` 步驟寫在 CHANGELOG。
- [ ] T035 [P] [US3] `test/extensions/truth-surfaces.test.ts`（plan Gates）。
- [ ] T036 [P] [US9] 擴充功能種類在活動紀錄「篩選」選單中的分組（L1，FR-094）；用 072 的登記表與 `validatePluginKind`，等 072 Phase 2。
- [ ] T037 [P] `test/extensions/removed-kinds-readable.test.ts`（契約 §5.6）。
- [ ] T038 [US4] `system:extensions_active` 的寫入（FR-065）；種類由 072 登記（072 已加指標）。
- [ ] T039 每個 PR 前後跑 T002–T005；T005 的基準不升。
- **Gate**：五道 gate；T002–T004 不變；T005、T006 不升。

## Phase 4 — 擴充功能主機（只有測試用擴充功能）

- [ ] T040 [env: CI 三平台正式版產物] 確認 `utilityProcess.fork` 在 `runAsNode`、`enableNodeOptionsEnvironmentVariable`、`enableNodeCliInspectArguments` 皆關的正式版中可用、能從 `app.asar` 載入主機執行期、`execArgv` 能設 heap 上限；量測每主機記憶體。不可行時停下回報（spec Q2）。
- [ ] T041 改寫 `test/package-fuses.test.ts:50-59`：`utilityProcess` 只允許 `src/main/extension-host/launcher.ts`；更新 `electron-builder.yml` 的註解。
- [ ] T042 `src/extension-api/runtime/`：`bootHost(port)`，載入核心交來的位元組（不讀磁碟路徑），`ctx` 的 stable 介面；`require` 擴充功能資料夾內路徑丟 `module-not-bundled`。
- [ ] T043 `src/main/extension-host/{launcher,supervisor}.ts`：啟動事件（契約 §3.4）、`activate`／`deactivate` 時限、退避重啟、heap 上限、憑證經 MessagePort 交付（FR-035）。
- [ ] T044 [US3] RED→GREEN：惡意測試擴充功能的 7 種越權（SC-003）。
- [ ] T045 [US1] 主機 `kill -9` 故障注入：操作者無中斷、`ended-unclean` 計入、退避與「失敗」理由（Edge Cases）。
- [ ] T046 [US8] 不相容與棄用的狀態與理由（契約 §5.3、§5.5），讀 075 的理由碼（075 的修訂新增 `api-too-new`、`api-retired`、`experimental-changed`、`uses-deprecated`、`hash-changed` 已有）。
- **Gate**：五道 gate；T002–T005 不變；T040 的結果記入 `verification.md`。

## Phase 5 — 機器層啟用與專案層綁定（需要 073 Phase 4、071 Phase 4）

- [ ] T050 [US5] `machine.yaml` 的 `extensions.<id>.enabled`（073 的修訂鍵）；設定頁擴充功能區只做機器層動作，對話框寫「影響所有專案」。專案設定中的 `packs.<id>`、`packMembers` 讀到時忽略（FR-041）。
- [ ] T051 [US3] 071 路由能力表擴充到 `plugin:*`：每一條非寫入路由 403（FR-060）；憑證發放與撤銷改為機器層（071 FR-072、FR-07A 的修訂）。
- [ ] T052 [US5] 遷移（FR-047）：「曾被使用」的選用來源在機器層打開，遷移報告；property test：升級前在擷取的來源，升級後不是仍在擷取就是帶理由的非記錄狀態。
- [ ] T053 [US6] `src/core/bindings/`：認領索引、「記錄到這個專案」動作、`system:session_rebound` 兩邊各一列（FR-045、FR-046）；tailer-host 只讀被開著專案認領的工作階段。073 F 段修訂的配對任務。
- [ ] T054 [US5] 與 071 的 FR-086、FR-087 配對：設定頁的終端機列顯示「N 個終端機為私人」不顯示（私人不計數）；只顯示綁定與暫停的數目（073 FR-043）。
- [ ] T055 [P] 擴充功能設定（K 段）：`core/extensions/configuration.ts` 的驗證與兩層儲存；設定列由核心繪製；必填未填 → 「未設定」與首次使用步驟；手改不合法 → 「無法使用」；`restart: extension`；`system:extension_config_changed`（只記鍵）；⌘K 登記；`migrations`。每一條 FR-110–11A 一個 RED 案例。
- [ ] T056 [P] secret：`safeStorage` 儲存、`basic_text` 後端時拒絕、`ctx.secrets.get` 的稽核計數；掃描測試斷言 secret 值不出現在任何設定檔、事件、日誌、匯出與 bundle。
- [ ] T057 受管代理的 `httpCapture.port`／`listenHost` 以 `migrations` 搬入其擴充功能設定；有效值不變的 property test（073 SC-006 的形式）。
- **Gate**：五道 gate；T002–T005 不變；US5、US6 的獨立測試通過。

## Phase 6 — L0：讀取 API、指令、深連結（需要 074 的讀取服務）

> **裁定（2026-11-13，DECISIONS §8 第 4 項）**：整段等 Spec 077 Phase 4 的遮蔽引擎完成後才開始，`meta` 也不先開放。

- [ ] T060 [US9] `/api/v1/query`、`/api/v1/events/<id>`、`/api/v1/topics`：074 讀取服務的另一個傳輸；`reads` 範圍在伺服端過濾；私人與不得匯出的列排除並計數。
- [ ] T061 [US9] `system:extension_read` 每分鐘彙總（D9）；`test/extensions/read-audit.test.ts`。
- [ ] T062 [P] [US9] 貢獻的指令（指令面板、列動作，只在宣告的種類）；第一次執行的確認。
- [ ] T063 [P] [US9] `redlog://` 協定註冊與只導覽的處理；格式錯誤、未開啟的專案。
- [ ] T064 [P] keybindings（experimental）：只綁自己的指令，衝突不綁定。
- **Gate**：五道 gate；真機檢查指令面板與深連結（驗收規則 2）。

## Phase 7 — 動作契約與終端機的 `redlog`（需要 075 的 payload、071 FR-07B、FR-122）

- [ ] T070 [US7] `src/core/actions/`：`status`、`pause`、`resume`、`mark`、`last`、`exportAligned`、`doctor`，回 `ActionResult`；IPC、API、`/api/v1/*` 改呼叫它們；`test/actions/single-implementation.test.ts`。標記沿用 13 號 U1 的單一寫入函式（若已落地）或在此建立。
- [ ] T071 [US7] [env: 無 Node 的 Linux 容器、Windows PowerShell 5.1／7] hook 的 `redlog` 動詞：`status`、`pause`、`resume`、`mark`、`private`、`last`、`export`、`doctor`，皆有 `--json`；錯誤碼與結束碼（FR-051）；控制動詞讀操作者憑證（FR-053）。POSIX 以 `redlog-relay.py` 子命令實作 HTTP 與格式化。
- [ ] T072 [P] `docs/USER-GUIDE` 改以 `redlog` 為終端機入口；`cli/redlog-cli.js` 的 `--severity` 說明刪除（裁定 5）；`redlog-cli` 標為開發者工具。`electron-builder.yml` 不加 `cli/`（D10），在 `docs/releasing.md` 寫明。
- [ ] T073 [P] 對齊列 v1（契約 §7）：`last`、`export --format csv|ndjson` 與 app 的 CSV 匯出共用一個序列化器；golden 測試釘住欄位順序。
- [ ] T074 API 的 `/api/export/*` 走匯出計畫器（FR-057），回應帶「排除 N 筆」。
- **Gate**：五道 gate；US7 的獨立測試在兩種環境通過。

## Phase 8 — 第一個搬動：擷取瀏覽器到主機（需要 071 Phase 6 契約 1）

- [ ] T080 確認 FR-022 的四個條件對擷取瀏覽器成立（T005 的基準：只剩 `ingestEvent` 一處）；量測搬動前的主執行緒喚醒（13 號 C.6）。
- [ ] T081 `src/extensions/capture-browser/`：CDP 連線與導覽、console 事件經 `ctx.source.ingest`；從允許清單移除 `capture-browser`。抽出前後 T002 的瀏覽器 fixture 除 `_ingest` 的四個欄位外相同。
- [ ] T082 量測搬動後的主執行緒喚醒；寫入 `verification.md`。
- **Gate**：五道 gate；T002–T005 不變；允許清單少一項。

## Phase 9 — Exporter（experimental；需要「交付邊界與內容生命週期」規格的遮蔽前提才能開 `command`／`content`）

> **暫緩（2026-11-13，DECISIONS §8 第 2 項）**：不排入第一版。任務保留，重新排入前不要動手。

- [ ] T090 [US10] `ExporterApi`、批次產生、`system:export_shipped` 先寫後交、`system:export_failed`；逐專案啟用；核准原生對話框（FR-071）。
- [ ] T093 [P] [US10] 假收集端的整合測試（SC-010）；`command`／`content` 在前提未成立時拒絕。
- **Gate**：五道 gate。

## Phase 10 — L2 面板（只在 FR-096 選 `experimental` 時；需要 Phase 6）

> **裁定（2026-11-13，DECISIONS §8 第 1 項）**：FR-096 選 `experimental`，本段要做。它依賴 Phase 6，而 Phase 6 等遮蔽引擎（第 4 項），所以本段排在那之後。

- [ ] T100 [P] 向 072 提出 FR-097 的四個通用閱讀器（`table`、`hex`、`diff`、`key-value`），以 072 的附加變更實作；本任務只追蹤，實作屬 072。
- [ ] T101 `redlog-ext://` 協定：只供應 `files` 中雜湊相符的檔；CSP 回應標頭（契約 §8.3）。
- [ ] T102 面板宿主：`WebContentsView`、沒有 preload、訊息表（契約 §8.4）、`getState`／`setState`、隱藏即銷毀。
- [ ] T103 導覽分隔線與擴充功能項目（契約 §8.2）：隱藏、排序存在機器層；核心目的地不可變的測試。
- [ ] T104 契約 §8.7 的全部 gate；幾何測試交給 CI 的 e2e。
- **Gate**：五道 gate；沒有安裝面板擴充功能時導覽快照與今天相同。

## Phase 11 — 文件與驗收

- [ ] T091 [P] 改寫 `docs/plugin-development.md` 為擴充功能開發文件（欄位參考由 schema 產生；075 FR-083 列出的錯誤一併修正）；`DESIGN-plugin-kernel.md` 標為被本規格取代。
- [ ] T092 [P] glossary：Extension、Extension Host、Activation Event、Binding、Stability Class、Aligned Row。
- [ ] T094 相容矩陣由 CI 結果產生（契約 §10）。
- [ ] T095 [env: 真機 macOS、Linux、Windows] plan「驗收」的三條規則；結果分「已決定／已實作／已驗證」記入 `verification.md`。
