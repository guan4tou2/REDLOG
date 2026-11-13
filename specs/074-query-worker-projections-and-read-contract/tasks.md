# Tasks: 查詢工作執行緒、增量投影與讀取契約

**Input**：[spec.md](spec.md)、[plan.md](plan.md)

**規則**：

- 每個 Phase 結束時 main 都可出貨，並以列出的 gate 收尾。
- 每個行為任務都先寫 RED（`it.fails` 或失敗的斷言），再實作。
- `[P]` 表示可平行（不同檔案、沒有相依）。`[USn]` 對應 spec 的故事。
- 每次 push 前依序跑五道 gate：`npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n && npm test`。
- 不在本機跑 Electron e2e；e2e 交給 ubuntu CI。標 **[Win]**、**[Linux]**、**[real app]**、**[real shell]** 的任務需要該環境，沒有時在 `verification.md` 記 NOT RUN 與原因。
- 「決定／實作／驗證」在 `verification.md` 分三欄記錄，不互相代替。

## Phase 0 — 工作流程前置

- [ ] T001 依憲章對本功能執行 Clarify、Checklist、Analyze，結果記入 `verification.md`。本規格沒有自己的開放問題（spec 文末）；不因他規格的問題阻擋任何 Phase。
- [ ] T002 確認 plan「對相鄰規格」表中的每一項仍與兄弟規格一致（2026-11-12 已對帳：071 FR-096 提交回執、071 FR-010 回填期間 `none`、073 的 `ProjectResource` 照抄、072 的 `family`／`INTERVALS`／`kindOf(row, plugins?)`）；之後的差異記入 `verification.md`。

## Phase 1 — 釘住今天的行為（只加測試與 gate，不改程式行為）

- [ ] T010 [P] [US1][US4] `test/query-work-counts.test.ts`：沿用 `work/1112-search` 的計數方式（包 `Database.prototype.prepare` 計語句與回傳列、包 `fs.lstatSync`／`openSync`），在 1 萬與 10 萬列（含 body 參照）的專案上，量 plan「主行程上的讀取」表中每個 `service` 與 `indexed` 讀取。斷言今天的值作為基準（不隨列數成長的斷言在 Phase 3–4 翻正；今天會成長的以 `it.fails` 標示：文字搜尋的 coverage、Activity 每頁的 rowid 範圍 COUNT、`aggregateTargets`、`distinctHosts`）。結果寫入 `verification.md`，作為憲章 IX 要求的量測證據。
- [ ] T011 [P] `src/main/ipc/register-handler.ts` 與 `test/main-thread-handlers.test.ts`：`registerHandler(channel, {cost}, fn)` 只登記並轉呼叫，行為不變；把 179 個 `ipcMain.handle`／`on` 改經它（每個 IPC 模組一個 commit），依 plan 的分級標上 `cost`。測試：掃描裸呼叫（白名單 `context-menu.ts` 等，只降）；列出 `service` 等級的數目作為基準。
- [ ] T012 [P] `test/query-import-boundary.test.ts`：掃描 `src/main/**` 與 `src/core/api-server.ts` 對 plan 列出的讀取服務專屬符號（`getReadonlyDB`、`openReadOnlyDB`、`db/activity-queries`、`db/event-aggregates`、`http-body-index`、`cast-index` 的寫入、`executeEventQuery`、`queryEvents`、`countEvents`、`spanEvents`、`querySourceSessions`、`queryEventCausalChain`、`queryScreenshotPage`、`queryHttpFlowPage`、`queryEventsPage`、`distinctAgentTypes`、`getLootCount`）的匯入，記基準，只降。
- [ ] T013 [P] [US3][US4] `test/projection-equivalence.test.ts` 的骨架與第一組：今天的 TEMP Activity 投影，隨機事件腳本（兩層交錯、同毫秒、logged retention、logged 最大 rowid 被刪後重用、切片中斷）下「逐步 `syncProjection`」與「一次全建」的 `activity_groups_v1` 相同。今天 rowid 重用的情形會整個清掉重建，結果仍應相同；若不同，以 `it.fails` 標示並在 `verification.md` 記錄。
- [ ] T014 [P] [US5] RED 特徵化：`test/screenshots-count.test.tsx`（已載入全部 5 張後即時插入 1 張，今天顯示 shown 6 / total 5，`it.fails`）；`test/app-counts-snapshot.test.ts`（`useAppCounts` 在兩次 `set` 之間有一次 eventCount 與 chainLen 不一致的渲染，`it.fails`；任一讀取失敗時畫成 0，`it.fails`）。
- [ ] T015 [P] [US2] RED：`test/event-content-identity.test.tsx`：Inspector 從 command A 換到 B，B 的內容回來前不得出現 A 的欄位（今天 `EventContentReader` 沒有 key，`it.fails`）；`LateOutput` 同理。
- [ ] T016 [P] [US3] RED：`test/timeline-bands-filter.test.tsx`：暫停 1 分鐘後只看「Shell」類型，暫停帶消失（`it.fails`）；效應數只算已載入列（`it.fails`）。
- [ ] T017 [P] [US6] 特徵化：列出並釘住今天斷言共用篩選的測試清單（spec「衝突」表），寫入 `verification.md`；不改它們。
- [ ] T018 [P] [US1] 事件迴圈探針（階段 0 的遺留，本規格接手）：`src/main/loop-probe.ts`（只在 `testHooks.e2e` 啟用：`monitorEventLoopDelay({resolution: 10})`、`registerHandler` 與 API 派送的計時，>100 ms 記 `{name, ms, at}`），測試專用路由 `GET /api/test/loop`（只在 `testHooks.e2e` 註冊，同 `/api/events/seed`）。`e2e/fixtures/loop-probe.ts`：每個 spec 的 `afterEach` 讀取並斷言開專案 2 秒後無 >500 ms 停頓，失敗訊息列出最慢的處理程式（CLAUDE.md「make it name something」）。**先以只記錄不斷言上線一輪 CI**，看清今天的停頓再開斷言；今天會失敗的 spec 以明列的白名單暫時排除，白名單只降。
- [ ] T019 [P] 單元：`test/loop-probe.test.ts`，探針在非 e2e 建置不註冊路由、不取樣。
- **Gate**：五道 gate；T010 的基準記入 `verification.md`；探針在 CI 的一輪 e2e 有產出 artifact。

## Phase 2 — 讀取服務骨架（一個讀取經 worker；RYW；打包）

- [ ] T020 [US1] `src/core/read-contract.ts`：型別與 `stableKey`；無任何匯入（`test/read-contract-imports.test.ts` 斷言，同 `event-order.ts` 的規矩）。
- [ ] T021 [US1] `src/main/services/query-worker.ts` 與 `query-service.ts`：兩條 worker（`interactive`、`heavy`），`open`／`req`／`cancel`／`close` 協定；以 `openReadonlyProjectDB` 的同一個函式開唯讀連線；實作 073 定義的 `ProjectResource`（073 T031i 之前以 `ProjectRuntime.onStop` 呼叫同一個 `stop`）。先 RED：`test/query-service.test.ts`（generation 不符的請求在送出前與回覆後被丟棄；A → B → A 的第一次 A 回覆不被採用；`stop()` 冪等）。
- [ ] T022 [US1] 第一個 `kind`：`aggregateTargets` 經讀取服務；`events:aggregateTargets` 成為代理。等價測試：經 worker 與直接呼叫 deep-equal。順便改為分頁或上限（今天回傳全部目標），renderer 介面不變。
- [ ] T023 [US2] 提交回執：在 `insertEvent` 的回傳點包一層產生 `CommitReceipt`（過渡；071 T038 落地後改由 commit 原語提供，071 FR-096）；派送者記 `lastCommitted`；寫入型 IPC 回傳 `seq`。先 RED：`test/read-your-writes.test.ts`（10,000 組隨機寫入→帶 `minSeq` 讀取，含讀取服務在中間重啟、排隊、generation 切換；`minSeq` 大於下一個序號回 `bad-request`）。
- [ ] T024 [US1] FR-008：worker 每個請求一個讀取交易；`test/query-worker-no-held-txn.test.ts` 斷言請求之間沒有開著的交易。
- [ ] T025 [US7] 崩潰與重啟：退避 1–30 秒、5 次／5 分鐘上限、`health()`；進行中請求以 `service-restarting` 失敗；主行程不回退執行（FR-010）。先 RED：`test/query-service-restart.test.ts`（終止 worker、啟動失敗、達上限）。
- [ ] T026 [US1] 背壓與取代：佇列上限、`supersedes`、超過預算且被取代時終止 `heavy`。先 RED：`test/query-service-queue.test.ts`。
- [ ] T027 [P] 打包：`electron.worker.config.ts` 與 `scripts/build-export-worker.mjs` 改為多入口（`export-worker`、`query-worker`），`pretest`／`build` 不變；`test/bundle-requires.test.ts` 擴充；`scripts/verify-packaged-resources.mjs` 斷言 `query-worker.js` 存在、`derived.db` 不存在（release-only 檢查，見記憶「Release-only checks」）。`test/package-fuses.test.ts` 不改。
- [ ] T028 [P] [Win] [Linux] 正式版啟動：三平台打包後讀取服務進入 `ready`（以既有 smoke 或階段 0／7 的自檢旗標；沒有自檢旗標時記 NOT RUN 並以 smoke 版代替，明說差異）。
- [ ] T029 [P] `test/query-kinds.test.ts`：每個 `kind` 恰好宣告一條執行緒；TEMP 依賴的查詢表與實際註冊一致。
- **Gate**：五道 gate；T011 的 `service` 基準減 1；T012 的基準減 1；CI 三平台 unit 與打包綠燈。

## Phase 3 — 依成本移動讀取（每個 PR 一組，基準逐次下降）

每一項：先加「經 worker 與直接呼叫 deep-equal」的等價測試；改通道為代理；T011／T012 的基準下降；T010 對應的 `it.fails` 若因此翻正則翻正。

- [ ] T030 [US1] `executeEventQuery`（`events:runQuery` 與 `GET /api/events/search`，`heavy`，`supersedes` = 搜尋框）。
- [ ] T031 [US1] `queryActivityPage`／`Members`、`querySourceSessions`（`heavy`；TEMP 投影固定在 `heavy` 的讀取連線，FR-007）。
- [ ] T032 [P] [US1] `distinctHosts`、`distinctAgentTypes`、`getLootCount`、`casts:search`（含 `backfillCastIndex`）。
- [ ] T033 [P] [US1] `countEvents`、`spanEvents`、`queryEvents`（並夾限 `limit`）、`GET /api/events`、`/api/events/count`。
- [ ] T034 [P] [US1] `matchEventIds`、`queryEventsPage`、`queryHttpFlowPage`、`queryScreenshotPage`、`commandOutput`／`commandEnds`／`queryByFlowId`／`streamCompletion`／`toolCounterparts`（`interactive`）；`causalChain`、`content:*`、`httpBody:read`、`/api/http-body/:sha`（`heavy`）。
- [ ] T035 [P] `GET /api/export/har` 改走既有匯出 worker（`runExportTask` 的 `har`），主行程不再組字串。
- [ ] T036 [US1] 主行程不再匯入 `getReadonlyDB`；刪除 `db/index.ts:516-529` 與 `event-queries.ts:353` 的錯誤前提註解，改寫為「主行程只有寫入連線；讀取在讀取服務」。T012 的基準到 0。
- [ ] T037 [US1] 開啟探針的斷言：T018 的白名單只剩與讀取無關的項目（例如開專案的 spool 排空，屬 071 T013）。
- [ ] T038 [Win] e2e：Windows 上專案切換時有查詢在途（記憶：Windows 只能手動或另有 runner）。
- **Gate**：五道 gate；T011 的 `service` 等級在主行程為 0（全是代理）；探針在 ubuntu e2e 全綠。

## Phase 4 — 衍生資料庫與投影（`activity`、`body_coverage`、`kind_totals`、`target_totals`）

- [ ] T040 [US4] `src/core/projections/{registry,runner}.ts` 與 `derived.db`（`projection_state`、`user_version`）。先 RED：`test/projection-runner.test.ts`（版本不符只重建該投影、整檔損毀重建、切片推進與狀態在同一交易、retention 摘要列觸發 `onLoggedPruned`、開啟時的背景檢查偵測 logged rowid 重用）。
- [ ] T041 [US4] `test/projection-registry.test.ts`：每個登記的投影在 `projection-equivalence.test.ts` 有一組；宣告的 `costPerRow` 與 T010 的計數一致。
- [ ] T042 [US4] `activity` 投影：TEMP 表搬到 `derived.db`（schema 原樣，v2），移除 `register()` 的 TEMP 建立與讀取時追趕；`readActivitySnapshot` 不再每頁做 rowid 範圍 COUNT（FR-041）。改寫 `activity-queries.ts:46-47` 的註解，保留「不進 bundle」並由 T046 測試。T013 擴充為新投影的等價測試；T010 中 Activity 的 `it.fails` 翻正。
- [ ] T043 [US4] 落後：讀取依賴的投影 `lag ≤ 5000` 就地補算，否則回 `behind(lag)`；`projection:<name>` 通知。先 RED：`test/projection-behind.test.ts`。
- [ ] T044 [US4] `body_coverage`：`http-body-index.db` `user_version` 8，`coverage_counts` 由 `body_event_refs` 的狀態變更以差量維護，`revision` 為整數；`bodySearchCoverage` 不再走訪；`recheck` 改背景切片。**先與 `work/1112-search` 的作者對齊**，以本條為準併入，不並存兩份。等價：「計數器 == 全走訪」沿用 `test/http-body-index-incremental.test.ts` 的形式；T010 的 coverage `it.fails` 翻正。
- [ ] T045 [US4] 衍生檔單一寫入者：ingest 的 `linkHttpBodyEvent`、retention 的 `pruneHttpBodyIndex`／`pruneSavedFileIndex`／`pruneCast`、終端的 `indexCast` 改送 `derived-op`。先 RED：`test/derived-single-writer.test.ts`。
- [ ] T046 [P] `test/derived-not-exported.test.ts`：bundle、NDJSON、HAR、`direct-bundle` 的產物與打包資源都不含 `derived.db`。
- [ ] T047 [P] [US5] `kind_totals`、`target_totals`；`aggregateTargets`、`distinctAgentTypes`、`getLootCount`、`counts:snapshot` 的 logged 數改讀它們；等價測試。
- [ ] T048 [P] [real app] 以 ≥25 萬列、≥10 萬 body 參照的專案升級開啟：Activity 立即可用並顯示落後、追上後更新；重複搜尋不再走訪。記入 `verification.md`（工作量數字，不是牆鐘）。
- **Gate**：五道 gate；四個投影的等價測試各 ≥1,000 組；SC-003 達成。

## Phase 5 — 區間、狀態與因果計數（需要 072 註冊表、071 的 `_causes` 指令 id）

- [ ] T050 [US3] `intervals` 投影、`stateAt(ts[], keys[])` 與 `gapOverlaps(rowIds[])`（FR-048）（皆 `interactive` 的 `kind`）。依 072 的 `INTERVALS`／`STATES` 宣告建立；072 未落地時只處理今天已知種類並列入 `legacy` 清單（072 落地時刪除）。結束依據四種（FR-043）。先 RED：`test/intervals.test.ts`（指令、終端 session、全域／每終端暫停、tunnel、IP／VPN、目前目標、專案開／關含 `project_closed{unclean}` 與「未知」段、缺口重疊）。`gapOverlaps` 落地後通知 072 移除閱讀器的過渡判斷（072 plan D5）。
- [ ] T051 [US3] `cause_counts`：`caused` 與 `candidate` 分開、每列 32 個上限與 `truncated`、retention 扣除。先 RED：`test/cause-counts.test.ts`。
- [ ] T052 [US3] `terminal_targets` 投影契約：071 T024 建表後，納入登記表與等價測試；舊專案的回填由 `heavy` 計算、`tt-backfill` 訊息交給主行程以小交易寫入；完成時通知寫入路徑開始套用 `terminal-last`。先 RED：回填期間寫入的列為 `target_via: "none"`，回填完成後新列為 `terminal-last`，已寫入的列不變（071 FR-010）。
- [ ] T053 [US3] HUD 與 `pivots:getActive` 改讀 `intervals` 的 tunnel，移除 `active-pivots.ts` 的 30 分鐘猜測；呈現仍為「偵測於」（UX-005）。
- [ ] T054 [P] 等價測試擴充到 `intervals`、`cause_counts`、`terminal_targets`（SC-004）。
- [ ] T055 [P] [real shell] 真實 zsh hook 與 mitmproxy：`ffuf … &` 加前景指令、暫停一分鐘、`ssh -L` tunnel；以 `stateAt` 與 `cause_counts` 讀回，與資料庫查詢對照。
- [ ] T056 [US3] （修訂 E1）FR-049：`intervals` 的 `rebuild` 對任意一組列執行。先 RED：`test/intervals-subset.test.ts`：(a) 以 in-memory 資料庫對一個子集執行，不呼叫 `getDB`／`getReadonlyDB`、不開 `derived.db`（以替身斷言）；(b) 起點不在子集中的區間產生 `start_id = null` 的一行而不丟錯；終點不在子集中的區間 `end_basis = open`；(c) 對全部列執行的結果與 `derived.db` 的 `intervals` 表相同（等價測試的一組）。072 T064 依賴本任務。
- **Gate**：五道 gate；七個投影都在登記表且有等價測試。

## Phase 6 — 畫面的讀取模型、變更通知與計數

- [ ] T060 [US2] `src/renderer/src/lib/query/registry.ts`、`useQuery.ts`：key、`status`／`fetching` 分開、`dataKey`、`isPlaceholder`、`(key, requestId)` 與 `asOf.seq` 丟棄晚到回覆、可見性暫停、每個 key 的最小間隔（內部用 `createThrottledRead`）。`useReadState` 改為它的薄包裝（行為除身分外不變）。先 RED：`test/use-query.test.ts`。T015 翻正。
- [ ] T061 [US2] `<ReadStatus>`（模組層級元件）：六種狀態；先用在 `LateOutput`、`EventContentReader`、`ScopeStatus`（刷新失敗不再整頁替換）。
- [ ] T062 [US2] `change-topics.ts` 與 `data:changed`：commit 後處理送出 topics；設定存檔出口（073）發 `config`；書籤、註記、不匯出標記的寫入 IPC 發各自的 topic；preload 加一個 channel。先 RED：`test/change-topics.test.ts`（每條寫入路徑至少一個 topic；分類與 072 的 housekeeping 規則對同一組列一致）。
- [ ] T063 [US5] `formatCount` 與清單登記表；`test/count-semantics.test.ts`（登記完整、i18n 成對鍵只在 formatter、`shown ≤ exact total` 性質）。三組 `*.recentSubset` 收成一組。T014 的截圖 `it.fails` 翻正。
- [ ] T064 [US5] `counts:snapshot`（`heavy`，一個讀取交易回傳 chained、logged、chainLen、loot、scope 觀察數）；`useAppCounts` 一次套用；失敗為 `unknown`。T014 的 drift `it.fails` 翻正。
- [ ] T065 [US5] `usePagedQuery`：`useLivePagedQuery` 改建立在 registry 上，`live.affects` 改為 topics；HTTP、Loot、截圖、目標證據四個消費者遷移。
- [ ] T066 [P] 遷移：四處飢餓 debounce、`ScopeStatus` 每批的 `chain.length`、`LateOutput` 每批 retry、四個 window CustomEvent、`ActivityResults` 的 key remount、`SourceSessionPicker` 的 request 回聲；每項一個 commit，T067 的數字逐次下降。
- [ ] T067 [P] `test/read-guard.test.ts`：三個數字（FR-097）記基準、只降。
- [ ] T068 [US3] 時間軸讀 `intervals` 畫狀態帶、讀 `cause_counts` 取效應數與註記數；移除 `sessionBoundaries` 與 `effectsIndex` 對已載入列的推導。T016 翻正。外觀依 UIUX-STANDARD，不在本任務決定。
- [ ] T069 [real app] 檢查：時間軸、Activity、HTTP History、Loot、截圖、目標頁、範圍頁、儀表板、狀態列、側欄徽章、HUD，在持續擷取下逐頁看計數、落後標示、失敗狀態（以測試 preload 注入讀取失敗）。
- **Gate**：五道 gate（`verify:i18n` 會檢查被刪的字串）；SC-006、SC-008 的數字記入 `verification.md`。

## Phase 7 — 導覽堆疊與各頁篩選（取代 Spec 038 的共用篩選）

- [ ] T070 [US6] `navigation.ts`：`NavEntry`、`navReducer`、`ViewVisibility`；`App` 只保留 `route`；先以深度 1 與今天等價，再開放深度 3；`returnTrail.ts`、`keptOrigin.ts` 移除；捲動以錨點列還原；`active` prop 移除；匯出的「此頁」只接受可見頁；選中事件的鍵帶專案 id（含一次舊鍵遷移）。先 RED：`test/nav-reducer.test.ts`、`test/view-visibility.test.tsx`。
- [ ] T071 [US6] 各頁篩選：`pageFilters.ts`；`FilterContext` 縮為 `FilterOptions`（高頻的 known lists）；`TargetView` 不再寫全域目標；`reveal` 契約（此頁篩選之外的事件仍呈現並標示，總數不變）。同一個 PR 更新 `test/shared-filter-views.test.tsx`、`test/shared-filter-live-lists.test.tsx`、`test/targets-open-in-timeline.test.tsx`、`test/filter-bar-tier.test.tsx` 及 T017 列出的其餘測試。
- [ ] T072 [US6] 同一個 PR 更新 e2e：`e2e/timeline-evidence.spec.ts:115-176`（`target-focus` 一組）、`e2e/timeline-track.spec.ts:637-664`、`e2e/app-shell.spec.ts:143`；重讀 `e2e/layout-reliability.spec.ts:116-129`、`e2e/layout-read-states.spec.ts:81`，確認只斷言版面者不改。新增：範圍頁 → 時間軸（`inScopeOnly` 開著）事件可見並標示；目標頁 → 時間軸 → 返回，目標頁狀態不變。依 CLAUDE.md「Changing behaviour」，這些不是後續工作。
- [ ] T073 同一個 PR 改寫文件：`docs/UIUX-STANDARD.md:190,196`、`docs/domain/SPEC-target-identity.md:16,113`、`docs/domain/SPEC-search-query-semantics.md:4,25,51,90,168-170`；在 Spec 038 的 FR-001、FR-004、FR-005、FR-011 旁標註「由 Spec 074 FR-085–FR-088 取代」（只加標註，不改其驗證紀錄）。
- [ ] T074 [real app] 跳轉與返回的完整走查（範圍頁、目標頁、Activity、時間軸），含鍵盤返回。
- **Gate**：五道 gate；ubuntu e2e 三個 shard 全綠（e2e 不等 unit，見 CLAUDE.md）。

## Phase 8 — 收緊與文件

- [ ] T080 白名單收斂：T011（裸處理程式）、T012（匯入邊界）、T018（探針排除）、T067（讀取守門）各自記最終值；能到 0 的到 0。
- [ ] T081 [P] `REDLOG_PERF=1` 的手動規模測試：25 萬列資料集，讀取執行期間主行程最長停頓（`setInterval(2ms)` 取樣，同 `test/export-main-thread-stall.test.ts`）。只手動執行（O9），結果記入 `verification.md`。
- [ ] T090 `docs/domain/SPEC-read-contract.md`：查詢鍵、結果項目、topics、計數與完整度、導覽項目、跨頁語境；glossary 加入提交回執、投影、主題、計數種類。`docs/design/DESIGN-project-runtime.md` 補上讀取服務這個資源。
- [ ] T091 `verification.md` 收尾：每條 FR 的「決定／實作／驗證」三欄；未在 Windows／Linux 執行的項目列 NOT RUN 與原因；spec 狀態依 `verify:specs` 的規則更新。
- **Gate**：五道 gate。
