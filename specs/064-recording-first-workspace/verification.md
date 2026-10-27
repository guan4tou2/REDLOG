# Verification: 紀錄優先工作區

**Date**: 2026-10-26。Feature 保持 Draft；這是局部實作與驗證 checkpoint，不是整份 Spec 064 完成。

## RED

- `test/terminal-origin.test.ts` 初跑 4 failed／1 passed：系統無法證明 origin 時，TERM_PROGRAM、WT_SESSION 及 REDLOG_TERMINAL 仍能放行；corrupt preference 也被旗標繞過。
- terminal enrollment／HooksPanel 的 unsupported platform 兩案失敗：Linux／Windows 能保存未驗證的限定 App，畫面也提供假能力。
- 真機 probe 第一輪 Warp 亦被拒：framework Python 位於 Python.app，被當成 host App。先補 fixture 重現，再忽略 verifier 自己的 bundle，保留實際祖先核對。
- 首次完整回歸：離線大輸出只剩小型 command_end，原 229 KB 內容不在 spool；已補有界本機 listener readiness，不能因有 identity／token 檔就丟掉 inline record。暫停／拒絕不走離線 fallback。
- C1 初跑：Timeline／Tool pairing 12 案失敗，重複同 PID／文字被隱藏、provider／Session／capture namespace 跨組、衝突後來者覆蓋。
- DB／Transcript 三案失敗：跨頁查詢忽略 provider／project／capture namespace；閱讀面亦跨 provider 合併。
- 搜尋映射兩案失敗：仍以 PID＋文字／裸 Session ID 高亮另一個操作。已沿同一 canonical key 修正。

## GREEN

- S1 checkpoint `npm run typecheck → verify:specs → verify:architecture → verify:i18n → npm test`：全部 gates 通過；**4294 passed、28 skipped，428 test files（423 passed／5 skipped）**。Log：`/private/tmp/redlog-064-current-unit.log`。
- 型別、來源鍵、DB counterpart／Transcript、搜尋映射相關 focused checks 通過；新增測試使用既有檔案／fixture，只有 origin 需要新的行為測試檔。
- `npm run build` 通過。隔離 macOS arm64 package 完成；`verify:package-resources` 與 bundle signature check 通過，正式 App 未覆蓋。
- 設定互動 E2E 7 passed（S1 checkpoint）：真實保存／reload、800／1600 視窗、繁中／英文、100／150／200% zoom、讀取／儲存失敗。後續 C1 不改此設定元件。
- 更新後候選的 command I/O／Transcript／packaged smoke：**9 passed、0 skipped、0 flaky**，24.7 秒。包含跨 cast part I/O、bundle 保留分段、真實擷取／匯出／驗證／重啟，以及增量閱讀位置。Report：`/private/tmp/redlog-064-current-e2e.json`。

## Operational Verification

Risk surface: capture / packaging / external integration。

使用者在真實 Warp 與另一個終端執行隔離 probe；來源檢查未改 profile／正式專案：

| 來源 | Warp 限制下送達事件 | 合成 stdout／stderr／exit 7 | spool |
| --- | --- | --- | --- |
| Warp（OS origin 辨識成功） | 起訖 2 筆 | 正確 | 0 |
| 另一終端（無匹配 origin） | 0 | 沒有保存輸出；命令本身正常結束 | 0 |

偽造環境提示不改變判斷，corrupt preference 被拒絕。根據原生工具對 Warp 的安全限制，本次由使用者手動跑兩個終端，我方讀回合成結果；沒有繞過工具限制。

packaged smoke 實跑 RELEASE-SMOKE-TEST 對應的已打包啟動、內建終端 I/O、managed proxy HTTP／HTTPS nonce（只用測試 client CA，沒有修改系統信任）、證據包／隨包 verifier／重啟讀回。JSON report 無 HTTP 未執行 annotation；不是瀏覽器全機 CA 已信任的證明。

macOS 候選：`/private/tmp/redlog-064-package/mac-arm64/RedLog.app`。基準 HEAD `853ce4a0` 加本工作樹未提交變更，不冒充已 merge／發版。

| 檔案 | SHA-256 |
| --- | --- |
| packaged app.asar | `666611d40066ce6bf3a39ee8c4d0231af3f08af0a668bdbc97f968a4c6ba0f01` |
| hooks/terminal_app.py | `d9045586383bef1ec4236f58684e75640945855fad8731cb4ffaf756b62c243f` |
| hooks/redlog-relay.py | `556b6ebe2c08e2e6d2c49c4c5d478a5ab922cf619549f9bde650dd973cc89d78` |

目前工作樹的 SQLite addon 在 package／E2E 後會還原為 Node 測試 ABI；候選包內為 Electron ABI，兩者不可混稱。

## 尚未完成／不能宣稱

- T004／T005／T006／T008 的完整有效邊界、故障注入、tmux／重接及 Windows／Kali／WSL 原生矩陣仍有缺口。28 skipped 不當作平台通過。#432 未因此合併。
- C1 的 act1 ID、群組 cursor／總數／來源集合與 IPC 已補；Activity UI、跨閱讀模式及完整覆蓋仍未完成。PowerShell 無可靠 ID 的列保留未配對。
- C2 搜尋覆蓋 metadata、C3 共用 Reader、C4 anchor、C5 新 Activity／Session 選取與跨目標錄影政策仍依 tasks 續做。
- 五入口／三閱讀方式／Settings 五分類尚未整併；全產品人工視覺、五人任務與效能量測仍 NOT RUN。沒有新增裝飾介面或官方 OpenCode。
- 沒有 commit、push、PR、merge、release 或覆蓋正式安裝。此候選未公證，不作正式發布聲明。

## Release Impact

| | |
| --- | --- |
| User-visible | yes |
| Breaking | yes：受限 App 不接受環境提示；無來源身分不再猜配對 |
| Packaging affected | yes：hook support file／optional packages |
| CHANGELOG updated | yes（Unreleased） |
| Upgrade note required | yes |
| Packaged smoke required | yes，macOS 通過；其他平台未完成 |

## Gates

| Gate | Result | Date |
| --- | --- | --- |
| Clarify | 使用者八項審查已編入 C1–C6；沿既定範圍，無新增產品問題。 | 2026-10-26 |
| Checklist | requirements 16／16 checked；只代表規格品質，不是產品 PASS。 | 2026-10-26 |
| Analyze | 已交叉核對實作與 C1／C6：配對鍵必須同時供 query／Timeline／Transcript／highlight 使用；剩餘差異明列 tasks。 | 2026-10-26 |
| Converge | 尚未執行最終收斂：實作 tasks 未完成，不將局部修正宣稱全規格完成。 | 2026-10-26 |

## 2026-10-26 — Activity query checkpoint

本輪只接 C1 查詢底層與 preload／IPC，不宣稱 S2／整份 Spec 完成，未換主導覽。

- `activity-projection.ts` 以來源 tuple 產生 act1 SHA-256 身分；補 Call／Result 不改 ID，跨 provider／Session／binding／project 不配對，缺鍵保留 Event fallback。
- `activity-queries.ts` 在 SQLite 先解析全專案群組，再依操作起點／穩定鍵分頁；兩個 tier 都查，matched 與 context 分開。預覽各最多 20 IDs，原事件可另以有界 cursor 完整讀取，不改 Event／hash。
- Cursor 固定 rowid 邊界、列數及尾端 ID；新增／晚到列留到 refresh，retention／rowid 重用／已命中 body 索引變動明確失效。來源詳情缺確認 snapshot 時拒絕。
- 共用既有 Event 查詢條件、FTS／body 命中及 bare-tool 解讀。IPC 依 main 的目前 engagement 及 scope 判定；延遲畫面不能查目前另一專案。
- Claude Code／Codex 只以已知精確工具名稱分類；讀檔／寫檔／搜尋／瀏覽不冒充獨立 Shell／HTTP，未知工具不猜類型。

RED：8 項基礎 query 案最初因未實作而失敗；IPC 的專案／scope 兩案在接線前失敗；未知 filter 及缺 snapshot 的案例先各重現失敗，再修正。

GREEN：

- 四項 gates 通過；最終完整 suite **4309 passed／28 skipped，429 files（424 passed／5 skipped）**，`/private/tmp/redlog-064-activity-final-unit.log`。
- Query／IPC focused run **19 passed**，包含 snapshot 必填及索引部分建立失敗後的 rollback／重開；均已納入上述最終完整 suite。
- Build 通過；沿既有 Transcript E2E 同一 App 走真實 `/api/events` → ingest → Activity preload／IPC → source context，再驗原 Transcript；**2 passed、0 skipped／flaky**。Report `/private/tmp/redlog-064-activity-final-e2e.json`（索引版最終重跑 10.35 秒）。這是自動整合測試，不是全產品人工視覺驗收。
- E2E 後已將本工作樹 SQLite addon 還原為 Node ABI；本輪沒有重打安裝包，前面的 macOS package 僅代表 S1 checkpoint，不包含新 Activity API。

仍未完成：C2 覆蓋／索引狀態、Activity UI、C3／C4 Reader 與定位、C5 新匯出契約、Settings／五主入口、Windows／Kali／WSL 原生矩陣。T009–T015 保留未勾，不以 query PASS 代替閱讀／效能 gate。

### Activity query performance and derived-index lifecycle

同一 Apple M2 Pro、macOS arm64、Node v26.12.1，固定十萬原始 Event（五萬 tool Call／Result），30 次輪替六類查詢：全專案、FTS、Action、時間、Session、指定 Tool＋Session。每次驗證正確群組總數及首批數量；沒有以 LIMIT 先截斷來源。

- 重算版本 p95 **1193.9 ms**；連線內 SQLite TEMP 衍生索引版 p95 **905.9 ms**（下降約 24%），30 次包括第一次建立索引。
- 索引冷啟動第一次 **1653.7 ms**，其餘 **519.2–905.9 ms**；不把冷啟動成本藏掉。這份 fixture 的 p95 達到一秒目標，但尚無完整舊 UI／輸入延遲比較，**不將 SC-007 全項標完成**。
- Index 只含身分、時間、分類及 digest；不保存輸出／Prompt／Tool Input 原文。原始證據仍只由既有 Event 查詢讀回。新列增量補入；資料清理／rowid 替換、失敗 rollback 及關專案重開均驗證不沿用錯誤索引。
- Report：`/private/tmp/redlog-064-activity-indexed-performance.log`；對照 `/private/tmp/redlog-064-activity-final-performance.log`；fixture 存 `/private/tmp/redlog-064-activity-benchmark.fixture.txt`。暫存 timing test 已移除，不加入每輪 unit suite。

## 2026-10-26 — Approved full-checkpoint push

使用者明確授權原隔離工作樹 178 個路徑全部提交／推送；先前獨立 Activity checkpoint 之外的剩餘 171 路徑已提交。來源驗證 commit：`deb483f9`（含 `fbd43f35` 的整批實作與 `4cf286be` 的 Activity query）。

- 在已提交來源上依序完成 typecheck、Spec、architecture、i18n、unit gates。**4309 passed、28 skipped；429 files（424 passed／5 skipped）**。Log：`/private/tmp/redlog-approved-checkpoint-unit.log`。
- 最新 production build 通過；指令 I/O 與 Transcript／Activity Electron 整合 **8 passed、0 skipped／flaky**。Report：`/private/tmp/redlog-approved-checkpoint-e2e.json`；build log：`/private/tmp/redlog-approved-checkpoint-build.log`。
- Electron 驗證後恢復 Node SQLite ABI；沒有改正式安裝或專案。
- 本次 push 包含已授權的累積實作／文件，不代表 Spec 062／063／064、原生跨平台矩陣或全產品人工驗收已完成。macOS package 證據仍僅適用上面的 S1 candidate；本次未建立新安裝包、合併或發布 release。

## 2026-10-26 — PR #444 macOS CI follow-up

Head `66aef83a` 的 macOS unit job `121474366721` 有兩個失敗：ignore-certificate-errors 警告未出現，以及 paused 驗證逾時未出現；Ubuntu／Windows unit 及 package smoke 成功，GitHub E2E 因 unit gate 失敗跳過。

- 可重現根因：HttpCaptureStep 在新 proxy／policy 已 commit 後，才於 passive effect 更換 attempt nonce 並清 timer。這個過渡狀態能接受使用者操作，之後卻丟棄回覆或取消已開始的逾時。
- RED：新增同一個 FirstRun Profiler 回歸案例，直接觀察每個 commit 的 endpoint／nonce／readiness，修正前穩定失敗；不是只靠重跑原本偶發案例。
- 修正：在同一元件的 context 改變時，先調整 attempt／timeout state 再 commit；沒有放寬 CA 警告、nonce 比對、60 秒逾時、測試條件或平台檢查。
- GREEN：FirstRun／HTTP focused checks 74 passed；完整五道 gates 通過，unit **4310 passed／28 skipped**（429 files）。補明確等待 deferred status probe 被呼叫後，FirstRun 檔 **51 passed**，不靠加長 timeout。
- Build 通過；同一 Electron App 的 managed HTTP／nonce 驗證／routing 流程 **1 passed、0 skipped／flaky**，7.78 秒。Log：`/private/tmp/redlog-444-http-race-unit.log`；Report：`/private/tmp/redlog-444-http-race-e2e.json`。這個 UI fixture 不替代真實 CA 信任或跨平台人工驗收。
- Electron 後恢復 Node SQLite ABI；遠端新 head 的 CI 需另行確認，舊 head 的紅／綠均不當成新修正驗證。


## 2026-10-26 — Activity search → saved I/O → source Event

本輪基於 `ef65ca15` 的隔離工作樹；提交／推送狀態以 Git 記錄為準。新增既有 Search 內的「操作／原始事件」呈現，未取代主 Timeline、Search、Transcript，也不代表 S2／S3／S4 全部完成。

### 行為與故障驗證

- C2：UTF-8 sidecar（包括以 base64 傳入、落盤為原始 bytes 的文字）可索引；binary 不假裝是文字。缺檔移除舊命中，稍後到達／還原可重建；相同大小改寫及還原 mtime 仍失效。損壞 ref 回報 failed coverage，不阻擋其他已驗證內容。資料邊界內的 coverage 變動使舊 Activity cursor 明確失效；邊界外新增 body 不污染舊分頁。
- C3：ContentRef 綁 project／Event／field／hash；64 KiB 視窗（UTF-8 邊界補償）、JSON／空輸出／未擷取區分、逐段字面 Find 及取消、當前視窗複製。17 MiB 尾端命中跨多次 1 MiB 掃描，不把掃描預算當成零結果。來源檔案或 body-store 目錄的 symlink、缺檔、版本改變、跨專案請求均明確拒絕；不重寫原始 Event hash。
- UI：同一 query/filter 送 SQL 群組／分頁，命中與背景分開計數。一般指令兩端皆命中時預設開結果，可切 stdout／stderr／工具參數／工具結果。新查詢等待期間不可誤點舊結果；失效分頁提供重新整理，不反覆重送舊 cursor。原始事件返回保留查詢、展開及內容位置。
- 實際截圖發現 Find 跳到尾端後 Previous 停用，已補回歸並修正，可回看前文、回到命中範圍及標亮文字。
- 移除兩個限定程式碼字面形狀的舊斷言，改以實際 Session 查詢確認 Cast 不混入無法套用條件的結果。錄影條件限制、50 筆上限及不可索引 body 只在影響判讀時顯示。

### 驗證與限制

- 完整 typecheck → specs → architecture → i18n → unit 通過：**4328 passed、28 skipped（426 passed／5 skipped files）**。Log：`/private/tmp/redlog-064-content-unit-final.log`。之前一次未修改的 Bash PTY 測試受 `setpgid: Operation not permitted` 干擾；未改斷言，完整重跑通過。
- 後續 UI 來源選擇、等待及失效分頁恢復以受影響檢查驗證；最後 focused **70 passed／9 files**，結果見 `/private/tmp/redlog-064-content-focused-final.log`，不倒灌成前一次完整測試數。
- Production build 通過：`/private/tmp/redlog-064-content-build-final.log`。
- Electron 自動操作：原有 query contract 與 Activity workflow 2 passed；擴充同一 workflow 驗 Shell stdout／stderr、Claude 工具結果、HTTP body、前後段、原始事件返回及 800×700 視窗，最新 **1 passed、0 skipped／flaky**，6.11 秒。Report：`/private/tmp/redlog-064-content-e2e-final.json`。之後的失效分頁恢復按鈕由 UI 故障注入驗證、build 通過，未為此重開 App。
- 已檢視實際截圖：`/private/tmp/redlog-064-activity-desktop.png`、`/private/tmp/redlog-064-activity-narrow.png`。這是合成持久化資料的 Electron 操作及視覺檢查，**不是人工全 App、真實 AI vendor、Windows／WSL／Kali 驗收**。
- 十萬個 inline Event、30 次代表查詢：p95 **932.9 ms**、冷啟動 **1838.1 ms**。已移除重複 coverage 掃描；report：`/private/tmp/redlog-064-content-performance-final.log`。不代表大量 sidecar、持續寫入負載或完整 SC-007 通過；暫存量測腳本已刪除。
- 本輪未建立新安裝包、合併或發版；Electron 後恢復 Node SQLite ABI。

### 仍未完成的契約

- FTS 每份 body 上限 **16 MiB**；超過時明示 limited，原件不刪／不截短，仍能用來源 Reader 及完整 Find 讀取。不能宣稱所有保存內容皆已進入全域索引。
- Cast generation、AI raw JSONL／一般附件的 C2 覆蓋，C3 其他 Reader／完整 raw/readable 映射及跨模式恢復、C4 片段 anchor，仍依原 tasks 維持未勾。
- 目前匯出 canonical query 命中事件，沿用 ExportPlan；尚未提供 Activity 全背景／跨目標 Session 附件的固定選取，不將這輪當成 C5 完成。
- 五主頁面、Settings 整併及全產品人工／跨平台矩陣依原 gate 繼續，不提前刪除舊入口。


### Push preparation

- 新增故障回歸：來源分頁出現匹配的 Result 時，不得自動切走正在閱讀的 Call。先重現來源從 start 跳到 end，再固定首次選擇，保留明確切換控制。
- 已在來源提交 `b14d18ee` 依序完成 typecheck → specs → architecture → i18n → unit，全部通過；unit **4330 passed、28 skipped（426 passed／5 skipped files）**，140.12 秒，log：`/private/tmp/redlog-064-push-unit.log`。此提交的 production build 亦通過，log：`/private/tmp/redlog-064-push-build.log`。前述 4328／70 保留為當時的實際結果。
- 本輪提交包含 Activity 搜尋、內容 Reader、body index、相關 IPC／UI／測試與 Spec 紀錄；不把其餘未勾的 Session 匯出／跨平台驗收等項目列為完成。


## 2026-10-26 — Windows CI export follow-up

遠端 head `82073921`：Ubuntu／macOS unit、Linux package smoke 及 Windows install smoke 通過；Windows unit job `121567924365` 失敗兩項，E2E 因 unit gate 未通過而跳過。此結果不是跨平台手動驗收。

- 附件排除重新解析的焦點還原原本在 passive effect。Profiler 在已更新、可操作的附件列 commit 時穩定觀察到 focus 仍在 body（RED），不是只重跑偶發失敗。改為 layout effect 並等待 previewLoading 結束，在畫面交還操作者前恢復焦點；保留不搶走其他控制項焦點的條件。
- 大量輸出測試在 Windows 超過原 15 秒預算。前置資料逐筆自動提交，包含 2005 筆 chunk；改為一個批次 transaction 建立同一資料集。520 筆查詢、505 對 HTTP fixture 亦改批次；預覽後的新增資料仍在獨立 transaction，2006 筆交付及快照排除斷言不變。不改產品 SQLite durability 設定、不延長 testTimeout、不跳過 Windows。
- 修正後兩檔 8 passed；本機長輸出案例 671 → 367 ms、整批 2.41 → 1.20 秒（含 RED／GREEN 執行差異，僅作前置成本參考，不當 Windows 效能證明）。Log：`/private/tmp/redlog-444-export-ci-red.log`、`/private/tmp/redlog-444-export-ci-green.log`。
- 來源提交 `8768c5c0` 五道 gates 全通過，unit **4330 passed／28 skipped**；production build 通過，單一 Electron App 的匯出操作 **8 passed、0 skipped／flaky**，6.22 秒（含附件 Space 勾選、焦點、小視窗、預覽／執行、失敗重試及成品找回）。Logs：`/private/tmp/redlog-444-export-ci-unit.log`、`/private/tmp/redlog-444-export-ci-build.log`；report：`/private/tmp/redlog-444-export-ci-e2e.json`。Electron 後已恢復 Node SQLite ABI。新的 Windows CI 通過前不宣稱已在 Windows 驗收完成。


### Linux E2E artifact path follow-up

- Head `6632a486` 的三平台 unit 與兩項 package／install smoke 全部通過。CI 完整 E2E：157 passed、7 skipped、1 failed；失敗是新增 Activity workflow 將畫面截圖寫到 macOS 專用 `/private/tmp`，Linux runner 無此路徑。匯出焦點及其他操作已通過，不將此次腳本錯誤描述成產品讀取失敗。
- 改為 `testInfo.outputPath()` 儲存 desktop／narrow 圖片，留在 Playwright 每次測試的成品目錄，隨既有 CI `test-results/` artifact 上傳。保留原來所有操作、結果及版面斷言，不跳過 Linux 或取消截圖。

- `ee9f41ff` 五道 gates 通過，unit **4330 passed／28 skipped**；build 通過。修正後 Activity workflow **1 passed、0 skipped／flaky**（5.84 秒），desktop／narrow 圖片實際產生於 `test-results/http-body-search-*/`。Logs：`/private/tmp/redlog-444-portable-e2e-unit.log`、`/private/tmp/redlog-444-portable-e2e-build.log`；report：`/private/tmp/redlog-444-portable-e2e-local.json`。Electron 後已恢復 Node SQLite ABI；完整 Linux CI 結果仍須讀新 head，不能沿用本機或舊 head 的綠燈。

## 2026-10-27 — macOS Activity / Session export and large saved-output search

基底 `05949443`，本次在隔離工作樹完成並交付至候選分支；未發版、不更新公開安裝包。上述 2026-10-26 checkpoint 的「16 MiB 整份不入全域索引」及「只匯出命中 Event」限制，已由這個 slice 取代。整份 Spec 064 不升 Verified。

### Behaviour

- Search → Operations 展開後，可在同一匯出入口選操作或來源 Session；後端固定完整成員，不只包含搜尋命中列。未知 Session 不可選，Claude／Codex 同名 Session 不混合，project 不符拒絕。
- 保留 query snapshot 的來源集合；預覽後的新 Event／cast part 不加入。cast 預設不選，預覽依完整來源顯示跨目標歸因。無關截圖／body 不交付。明選的錄影保留核准 prefix；出包後 digest 再核對；新增 do-not-export 拒絕舊 plan。
- 17 MiB HTTP body 的檔尾可全域命中、開啟完整 Reader、Find／Previous／Next／原始事件返回。另以 >16 MiB 中英文輸出驗多段 AND、不同 ref 不拼湊、長 token／URL 邊界及來源改寫失效。

### Checks and actual app flow

- Ordered typecheck → verify:specs → verify:architecture → verify:i18n → unit：**4338 passed / 28 skipped**。之後追加成品-copy 故障注入與 AI provider 隔離，最新針對性回歸 **66 passed**（匯出／Bundle／UI）及 **19 passed**（搜尋／固定選取）；不把先前全套數量改寫為追加後的全套實跑。
- Production build 通過；本機原生 Electron 匯出流程 **8 passed**（JSON preview/execute、recent delivery、窄窗、附件鍵盤 focus、失敗重試／缺檔／切專案）。
- 更新的 Search → large body Reader → Shell／AI → Activity／Session JSON export 流程 **1 passed / 6.6s**。實際讀回成品，兩種選取皆含未命中搜尋文字的 command_start 與 command_end／stdout；不是只核對成功通知。
- UI screenshots 已查看：`test-results/http-body-search-Search-op-c05e0-ce-without-losing-the-query/activity-narrow.png` 與 `activity-wide.png`（不提交產生圖片）。
- 這是 macOS source-built Electron 的自動操作與畫面檢視，不是新 DMG 的乾淨安裝或 Windows／WSL／Kali 真機人工驗收。

### Layout defect in acceptance method

使用者指出測試視窗大片空白。診斷實測：Electron native content `[1400,900]`，舊 `page.setViewportSize` 將 renderer 固定為 `[800,700]`。只測 `scrollWidth <= clientWidth` 會漏掉縮小視區沒有填滿實體視窗的問題。改用既有 `resizeMainWindow`，以真實 800×700 與 1600×1000 視窗核對 native content、renderer viewport、root 及 status-bar 邊界；移除診斷用模擬與 CDP 程式碼。未為測試視區問題任意修改產品 CSS，也不宣稱所有頁面版面已全面人工驗收。

剩餘：AI raw JSONL／一般附件／Cast generation 搜尋覆蓋、完整 reader／fragment 契約、導覽整併及跨平台人工驗收；不屬於本次兩項功能已完成的範圍。

### Push gate — 2026-10-27

重新 fetch 遠端後，最終修改依序通過 typecheck、verify:specs、verify:architecture、verify:i18n、完整 unit：**4340 passed / 28 skipped**（426 passed / 5 skipped files，126.32s）。沒有把先前 05949443 的遠端 CI 綠燈套到本次提交；新提交的跨平台 CI 以 PR #444 checks 為準。

## 2026-10-27 — installed macOS candidate d2917021

開發基底為已合併的 main `d2917021`。本輪工作分支 `codex/macos-internal-acceptance` 只修建置來源狀態與驗收入口；候選仍鎖定 d2917021 的 application source，不把未提交的驗收修改編進候選。

### Artifact

- `dist/RedLog-0.18.3-internal-d2917021-arm64.dmg`，約 207 MiB；Mac Apple Silicon。
- SHA-256：`0a3042357c6c4c5da7166f0da814a69ad963dad431edc93edf5ff2836a13de7e`。
- `dist/SHA256SUMS-d2917021.txt`、`dist/INTERNAL-TEST-d2917021.md` 為內測交付附件，不提交大型 binary。
- DMG checksum、`codesign --verify --deep --strict`、package resources contract 均通過。ad-hoc，不是 Developer ID／公證。沒有 publish、修改 release 或更新 feed。
- readonly mount DMG，用 ditto 安裝至 `/private/tmp/redlog-internal-d2917021/Applications/RedLog.app`，再卸載 image。正式 `/Applications/RedLog.app`、使用者 shell profile／系統 proxy／系統 CA 均未修改。

### Build identity defect and repair

首次包的 About 顯示 `d2917021+local`，不作為最終交付。原因由 electron-vite 5.0.0 的 `loadConfigFormBundledFile` 原始碼確認：它先在 configRoot 寫出 `electron.vite.config.<timestamp>.mjs`，再評估 Git status。即使來源在建置前後皆乾淨，評估當刻也把自己的產物當未追蹤來源。

補一個實際 temp Git repo 的 RED→GREEN regression：編譯產物不算 dirty，修改 tracked config／新增一般 untracked source 仍算 dirty；`.gitignore` 只加根目錄對應 pattern。不移除 dirty check、不硬蓋 Build ID。

為保留指定 d2917021 候選，本輪只暫存並還原自己的驗收修改，以乾淨 d2917021 重建；建置 subprocess 的 `core.excludesFile` 僅排除該已確認的編譯產物，其他來源照常檢查。沒有改 shared Git exclude／其他工作樹。重建後以實際 About 內容確定為 `RedLog v0.18.3 · d2917021`。

### Final installed-package automated acceptance

同一最終 DMG 副本，`REDLOG_PACKAGED_APP` 指向其實際 executable，About 比對 `REDLOG_EXPECTED_BUILD=d2917021`：**25 passed / 1.1m**，沒有將 source-launched 結果當安裝版通過。

- Export dialog／external source recovery：8 cases，含真實 shell、附件、失敗重試、recent result、窄窗及 project switch。
- FirstRun：11 cases 在同一 App 連續操作，驗證來源獨立、安裝 hook、略過／返回／修復與不遺失既有紀錄；此組部分 proof 是 fixture，不冒充真人從終端輸入。
- Activity／saved output：1 case，實際 About、17 MiB body 搜尋／Find／原始 Event 返回、原生 resize、操作／Session JSON 匯出讀回。
- Official AI：3 capture cases + 1 installation case，Claude Code／Codex 的合成 JSONL、明確授權／排除／暫停／移除；不宣稱啟動真人 AI provider client。
- Packaged smoke：1 case，UI 建專案、真實終端／exit／cast、已存在 mitmdump 12.3.1 的真實 loopback HTTP 與 HTTPS nonce（client --cacert，不變更系統 trust）、bundle verifier，以及重啟後內容／cast 搜尋。

Logs：`/private/tmp/redlog-d2917021-final-installed-acceptance.log`、`redlog-d2917021-final-resources.log`、`redlog-d2917021-final-dmg-verify.log`。測試 artifacts 不提交；若再跑其他 Playwright 項目需先保存想保留的截圖。

### Native, non-E2E exit acceptance

使用同一安裝副本、獨立 native-home，`REDLOG_E2E=0`，透過原生 UI 建立 `native-exit-d2917021`。未透過 Playwright／IPC 代替退出確認。

- ⌘Q 實際出現原生確認，明示「受管網頁擷取代理：經由它的工具會失去代理服務」及外部終端後續指令不再記錄。
- 點「留在背景」後可繼續專案。送出關窗操作後，authenticated health 為 `{ok:true,projectOpen:true}`，proxy 仍 listening。
- 再次 ⌘Q →「停止並結束」，原生工具回 App quit，程序 exit 0；回環 API 與 proxy 皆停止。
- 注意：E2E 模式原本會略過退出確認，因此沒有用那 25 個自動案例冒充此原生結果。

### Remaining friction / not run

- 網路下載後 Gatekeeper 與 macOS 系統 CA 授權未人工驗收；不以本機 build 或 client --cacert 當成通過。未做 Windows／WSL／Kali 此候選真機驗收。
- 原生首次畫面在本輪未執行使用者指令前，等待一段時間後出現「指令跑了，但沒有東西進來」；目前只能確認文案／觸發時機可能誤導，仍需核對狀態條件，未宣稱已修。
- 本輪是隔離安裝副本與工程驗收，不等於 2–3 名新使用者的無人協助完成率／時間量測。

交付副本保存在 `/Users/guantou/Desktop/REDLOG/dist/internal-d2917021/`（DMG／SHA256SUMS／內測說明），避免隔離 worktree 後續清理時遺失 binary；不進 Git。共用 Desktop checkout 的既有三份規格 WIP 與未追蹤 DB 未變更。

## 2026-10-27 — test execution consolidation (no GUI run)

先前已有 docs 規則但沒有本機 default selector。上輪約 20 次 App 啟動：第一包的 AI／package 六次、export／Activity 二次、FirstRun／About 二次、重建後 25-case 全選九次，以及非測試原生退出一次。關鍵錯誤是把 metadata 重建當作整組 AI／FirstRun／UI 重跑理由；不是每次都需要全量。

本批新增 `npm run e2e:smoke`：只選 packaged recording/export/restart 一案，正常二次啟動（第二次是明確重啟讀回），禁自動 retry；要求 executable／預期 commit／mitmdump，report 保存在獨立暫存目錄並經既有 strict validator。`--list` 不啟動 Electron。Build ID 檢查抽到共用 helper，在既有 App 執行。

Windows／Linux installed workflow 路徑補 core／main／preload／optional packages 及 build inputs；純 i18n／docs／spec 不因此重建安裝包，保留 workflow_dispatch。FirstRun 六處固定 wait 改狀態／元件／PID 判定。現況改由 test-coverage-matrix.md 對照，不更寫舊 NOT RUN。未批次移動 tests、未刪產品仍使用的泳道測試，也不以這個整理宣稱 C2–C6 缺口完成。

這輪只跑非 GUI unit、type/gates 與 Playwright --list；不為驗證這個整理再次開關 App。新 FirstRun 等待邏輯與 smoke runner 的實際執行留待下一次必要 E2E／CI；不能將 collection 通過寫成 UI 操作已通過。

本批非 GUI 檢查：13 tests passed（installed-smoke-policy／smoke-report／build-source-status）、typecheck／Spec／architecture／i18n gates 通過。`e2e:smoke -- --list` 精確列出 1 test；FirstRun＋Activity collection 共 14 tests。這些列出與檢查均未啟動 App，新的 GUI 等待條件仍未執行。

### Test consolidation submission — 2026-10-27

本批15個路徑獨立收尾：依序通過 typecheck、verify:specs、verify:architecture、verify:i18n 與完整 npm test（4,347 passed / 28 skipped，121.76s）。未啟動 GUI；新 smoke selector 的實際安裝包執行將沿用合併後候選，避免另外啟動一次只驗證 selector。


## 2026-10-27 — shared reading workspace candidate

Base: `main/37b6d74f`; branch `codex/recording-workspace-integration`. This is a source UI candidate, not the previously delivered installed DMG and not a public release.

### Implemented scope

- `RecordingWorkspace`: one query and keyboard-accessible reading tabs over the existing Search entry. Empty queries browse Activities. Raw Events and Cast results retain the same store query and coverage restrictions.
- `TranscriptView`: I/O and AI modes constrain source buckets before database pagination. Workspace reads open saved results on load, including matching Tool Results. Standalone continuous Transcript remains reachable until parity.
- `ActivityResults`／`EventContentReader`: visited reading modes, source events and output fields retain their individual windows and Find text. New batches signal refresh without replacing the active Activity snapshot. Hidden narrative readers catch up on return instead of querying every incoming batch.
- `exportScope`: only the owner may clear its contribution; an older reader unmount cannot erase the active reader selection. Query transitions discard stale operation selection and preview the latest typed query through ExportPlan, without freezing a transient searching state. Operation/session export still uses the canonical frozen ExportPlan.
- `Settings`: five groups, unchanged routes, field search, auto-save, project ownership and source permissions. No new integration lifecycle or duplicate source switch.

### Automated evidence so far

- Workspace test began RED because the new module did not exist; the shared-query/mode/reader-preservation journey passes after implementation.
- Focused behavioral checks: 56 passed in 10 files before final layout checks, including source-field restoration, scoped backend queries, inactive-reader refresh and export ownership.
- Full unit suite: 4,354 passed, 28 skipped. The previous source-regex test requiring unconditional `current = null` was removed and replaced by an actual two-reader ownership/unmount test. The single-control API-call-site guard remains.
- Electron saved-content journey passed after catching and fixing a real collapsed matching Tool Result. Its final native-size/zoom capture and expanded regression are recorded below when complete.

### Boundaries

This batch does not claim complete C2–C4 parity, a finished Session selector, generalized Markdown/raw coordinate maps, raw AI JSONL/general attachment full-text indexing, S1 source failure matrices, other-OS native acceptance or five-user task metrics. Existing main Timeline/Transcript routes are retained as required by the retirement gate; no old-hook or schema compatibility shim was added. Spec remains Draft and the compound tasks remain unchecked.


### Final automated / visual results for this slice

- `typecheck`, `verify:specs`, `verify:architecture`, `verify:i18n`, production build passed. Full unit suite: 4,354 passed / 28 skipped; later query/export refinements additionally passed 12 focused cases. No skip was counted as a pass.
- 14 distinct Electron cases across `capture-settings-interaction`, `filtered-export` (both locales), `http-body-search`, `layout-reliability`, `search-query-contract`, and `transcript-view` passed. The first batch passed 12; failed export cases were diagnosed and rerun with the shared saved-content journey, all 3 then passed. No automatic retry masked these failures.
- The export failures exposed a real transient-state freeze; latest typed query now goes directly through the canonical preview. Raw result locators were also narrowed to visible semantic rows; hidden visited readers remain mounted intentionally.
- The saved-content journey uses one App for raw body search beyond 16 MiB, Activity source selection, full-content Find, original Event/back, stdout/stderr, selected Activity/Session export with artifact readback, all reading modes, empty-query browsing, and native 800×600 / 150% zoom.
- Captured native zoom screenshot with `BrowserWindow.capturePage()` after sidebar transition settles. Chromium `page.screenshot` at non-default Electron zoom clipped the frame and was not used as native layout proof. Reviewed wide and native narrow screenshots directly; shared tabs, search, status bar and actions fit. Generated artifacts are under ignored `dist/uiqa-workspace-20261027/`, not committed.
- The five-component layout matrix also passed 120 native size/zoom/locale combinations. Settings interaction checks passed English/Traditional Chinese at 800px and 100/150/200% zoom.
- A separate isolated source-build window with synthetic Shell and Claude data is open for native interaction. CUA reported the Mac locked; requested unlock. Native clicks are NOT RUN until unlock, and this is not presented as installed-package acceptance.


### Native interaction follow-up — completed after unlock

Same isolated source-build process, synthetic Shell and Claude events, Traditional Chinese. No second App launch was needed; one renderer reload loaded the small cleanup built during this check. This is native interaction through CUA, not Playwright driving the following actions.

- Typed `synthetic-output`, expanded its Activity, searched its saved content, opened the original Event and returned. Query, selected source, content Find text and highlight remained present.
- Switched I/O and AI modes. Both displayed saved output immediately. Chose stderr via the native dropdown, then returned to stdout; the Find input and output selection were preserved. Arrow keys switched AI/Raw tabs, and Cmd+F selected the common query field.
- Inspected the five Settings categories at the original window size. Used macOS Window > Move & Resize > Left to resize the actual window, then increased zoom until the source settings switched to the compact category dropdown. Source cards and primary actions remained readable and reachable.
- Found and removed legacy Transcript heading and unrelated kind buttons inside scoped I/O/AI modes. Standalone Transcript retains its mixed-type controls. Shortened the coverage warning to reflect saved body indexing and the separate recording-search path. `typecheck`, 25 affected unit cases and production build passed after this cleanup; reloaded and inspected the result natively.
- Opened the selected Claude operation's actual Export dialog. The preview showed exactly its two source events and the selected operation boundary; canceled the preview without writing another artifact.
- Saved `native-settings-narrow.png`, `native-ai-reading.png`, `native-export-preview.png` under ignored `dist/uiqa-workspace-20261027/`. These synthetic-project screenshots remain local, not public fixtures.
- Quit the isolated App through Cmd+Q. CUA returned `App quit`. No user shell profile, official project, system proxy preference or system CA was changed. The source window used E2E mode for synthetic seeding, so this quit is cleanup, not a replacement for production native-exit acceptance.

T036 is complete for this bounded UI integration. The broader compound tasks and unsupported/unrun platform and user studies remain unchanged; this does not upgrade the whole Spec to Verified.


## 2026-10-27 — Windows internal candidate `42601438`

Product commit `4260143897ffe732b61662c4ae2cc483e1db243d` on `integrate/spec064-internal`: `main/37b6d74f` + `codex/recording-workspace-integration` (e7dbf331) + `codex/session-without-project` (960ff12c) + the part of `fix/windows-followups` (#432) not already on main — only the first-run rejected-start mock. Its WSL token probe and stdin payload reached main separately. This record is a docs-only commit on top; the installer was not rebuilt for it.

Host: Windows 11 Pro 26300 x64, Node 22.23.1; e2e in WSL kali-linux under `xvfb-run`, as CI does.

### Gates and suites

- `typecheck`, `verify:specs`, `verify:architecture` (341 files), `verify:i18n` (9 removed strings, none asserted): passed on Windows.
- Unit, Windows: **4,191 passed / 51 failed / 148 skipped** (435 files, 443 s). All 51 failures are in 10 files that drive zsh through `wsl -d kali-linux` (`zsh-*.pty`, `zsh-builtin-source`, `zsh-divert-missing-pts`, `zsh-pty-harness`, `relay-contract`); every other file passed. Rerun alone: same 10 files fail. Run natively inside kali (no `wsl.exe` hop) they fail too, and `zsh-pty-harness`/`zsh-redlog-command`/`relay-contract` fail **15/25 on both main `37b6d74f` and this candidate**. Main CI (ubuntu unit + e2e) is green on `37b6d74f`. The likely cause is `WSL_DISTRO_NAME` steering the hook to the Windows profile (`hooks/shell-common.sh`) instead of the harness collector; not proven. Counted as environment, **not** as a pass.
- e2e, full suite in WSL: **150 passed / 3 failed / 7 skipped** (12.2 min). The 3 failures — `dependency-cancel` (prepare button never clickable), `export-preview:26` (`record-terminal-verified` absent), one `layout-reliability` bookmarks scroll case at 200% (size combination differs per run) — reproduce alone with `--retries=0`, and reproduce identically on main `37b6d74f` in the same distro. Not regressions of this candidate; also not a pass.

### Windows package

- Local VS 2026 lacks the Spectre-mitigated libraries (MSB8040), so `node-pty` cannot rebuild from source here. Packaged with `-c.npmRebuild=false`: `node-pty` 1.1.0 loads its N-API prebuild, `better-sqlite3` 13 is N-API. This differs from CI packaging, which rebuilds; the PR's `Windows install smoke` artifact is the authoritative installer.
- `RedLog.Setup-0.18.3-internal-42601438.exe` SHA-256 `d9355641411b7f1c715b05ce2daab646771ed593e69aa2a54c2c6787391b2e87`; `app.asar` SHA-256 `71411e2a72223c90706c58402e2b6021406e56dff7aaaa7deef746ef0743fac2`. Not committed.
- `verify:package-resources` passed on `dist/win-unpacked`.
- `npm run e2e:smoke` against `dist/win-unpacked/RedLog.exe`, `REDLOG_EXPECTED_BUILD=42601438`: **1 passed**, strict report: no skipped tests or not-exercised steps. `packaged-session-smoke` is POSIX-only and skipped on win32 by design.

### NOT RUN

Silent install/uninstall on this machine (CI does it on a clean runner), native manual Windows interaction — PowerShell enrollment canary, the three reading modes, Settings five groups, display DPI — and T004/T008 Windows rows. The local Windows→WSL zsh harness needs its own fix before it can say anything about the adapter on this host.
