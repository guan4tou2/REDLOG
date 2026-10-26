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
