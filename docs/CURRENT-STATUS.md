# 目前狀態

> **狀態**：current — 「現在什麼是真的」的唯一頁面；下一步只在 [工作計畫](WORK-PLAN.md)  
> **範圍**：已合併程式、spec 正式狀態、候選產物與驗收證據的入口  
> **最後核對**：2026-11-12 於 `main@aaee01fd`（第一節）；其餘各節保留自己的核對日期。只核對本 repository 可讀到的事實（git 紀錄、spec 檔、程式）；issue 狀態與 CI 結果沒有離線來源，保留各自的核對日期

其他文件裡的狀態表、待辦與「目前」敘述都是寫成當天的紀錄（[records/](records/README.md)），與本頁不一致時以本頁及其證據為準；本頁也不能取代證據本身。

## 2026-11-12 核對（`main@aaee01fd`）

| 項目 | 狀態／證據 |
|---|---|
| 程式基準 | `aaee01fd`（合併 #698，2026-11-12）。自 `9f60882d` 起合併 #684、#694、#696、#697、#698（可用性審查的修正、效能、安全與 hook）；逐項內容、量測條件與限制見 [可用性審查收尾](records/2026-11-12/USABILITY-AUDIT-CLOSEOUT.md) |
| CI | 上述五個 PR 與 #693 的最終 commit：unit（ubuntu、macOS、Windows）、e2e 三分片（ubuntu）、install-smoke（Linux、Windows）通過。五個 PR 以 merge commit 依序併入、期間 `main` 無其他變動，`main` 的樹與 #698 最終 commit 相同；`main` 上各 merge commit 自己的 CI 執行未在此核對 |
| 測試規模 | 單元與元件 662 個檔、6841 個案例（macOS 本機 6799 通過、42 略過）；e2e 52 個規格，只在 ubuntu 的 CI 執行 |
| 建置變體 | 正式版（預設）與冒煙版（`REDLOG_SMOKE_BUILD=1` 加 fuse 覆寫）在建置時決定。正式版關閉 inspector、忽略 `--remote-debugging-port` 與 `REDLOG_E2E*`；冒煙版只供 install-smoke 流程。`verify:package-resources` 以正式版模式檢查冒煙版會失敗。見 [Releasing](releasing.md) 的 Build variants |
| Electron fuses | RunAsNode、NODE_OPTIONS、inspector 關閉（`electron-builder.yml` 的 `electronFuses`）；asar 完整性與 only-load-from-asar 未開 |
| 打包版 CSP | 以回應標頭送出，於未簽章 macOS app 實測在 `file://` 上生效（行內腳本與 `new Function` 被擋）；Windows、Linux 未實測 |
| HUD 設定 | 全域偏好（`~/.redlog/hud-prefs.json`），不隨專案變動 |
| AI session 選取 | 依 engagement 保存於記憶體，專案關閉時清除；設定儲存不再清掉（#686） |
| 搜尋索引 | `http-body-index.db` `user_version` 11（v9 加入 JSON `\uXXXX` 解碼文字、文字型媒體類型依宣告字元集解碼、截斷與結尾解碼失敗記為 partial；覆蓋率讀索引表，不再每次搜尋重算每列；v10 以「事件＋欄位」為 ref 鍵，請求與回應同雜湊時算兩個 ref；v11 每個 ref 有不重用的整數編號（AUTOINCREMENT），文件 rowid 由編號推算：`ref×4096 + 種類×2048 + 序號`，種類 0 為保存文字、1 為解碼文字。每種最多 2048 份（約 2 GiB）：預設 10 MiB 上限的本體每種最多 12 份；從 app 加入的 artifact 預設上限 200 MiB，transcript 與經 ingest 進來的 artifact 沒有上限。超出者索引到上限為止、記為 partial（`too-large`），`indexed_bytes` 記錄已寫文件涵蓋的位元組（重疊只算一次），不寫進下一個 ref 的範圍；上限按種類計，但任一種類先滿就結束整個讀取，另一種類之後的文字也不索引；ref 編號上限 2^41，rowid 低於 2^53。ref 列記錄各種類的文件數，刪除是逐份依 rowid 的點刪除，不用 rowid 區間；文件一律以 `INSERT OR REPLACE` 寫入；讀取沒有以文字結束時，該 ref 的文件當場刪除。`body_docs` 已移除，搜尋以 `rowid / 4096` 對應 ref 主鍵。FTS 表為無內容表（`content=''`、`contentless_delete=1`），不存本體文字的副本，`snippet()`／`rebuild` 不可用。以 `LARGE_SHAPE` 合成專案量測（22,000 份文件）：索引檔 139.7 MiB → 52.5 MiB；冷建與搜尋的計數工作不變，修剪 1,000 個本體的敘述 6,000 → 5,000）。舊索引在升級後第一次搜尋時於主行程重建：每個保存本文重讀、重算雜湊，含跳脫的本文多寫一份解碼文件；在本機（負載下）200 MB 全含跳脫的保存本文約 17 s（約 85 s/GB，v9 時量測，v10、v11 重建做同樣的事、未重量），origin/main 同條件約 9 s（約 45 s/GB）；重建期間該次搜尋不回應，移出主行程屬 Spec 074。驗證狀態隨索引列保存，回填為增量。新索引以一次 commit 建立，已是當前版本的索引開啟時不寫入；只有主行程的讀寫來源連線寫共用索引（sync、ingest 連結、prune）；唯讀來源連線（匯出 worker：唯讀開啟、整個匯出一個讀交易）除了為缺少或舊版本的索引建立 schema 外不寫它：不走訪、不修剪、不移動水位。每次讀取都在共用索引為該連線所見來源背書的範圍內讀共用索引，其餘讀入該連線自己的 TEMP 表：水位之上的列、共用索引已不保留的最新 transcript 前綴，以及唯讀連線所見中檔案已變或 missing/failed 的 ref；TEMP 只保留上一次呼叫所需。快照只在讀取時過濾。來源視圖落後水位的唯讀連線：在落後的 tier 中，只有當索引在該視圖最高 rowid 以下持有 ref 的列數，等於該視圖在那裡的 content-ref 列數（transcript 前綴只算水位持有的），且索引在那裡的最後一列在該視圖中是同一事件、同一 rowid，才信任共用索引；在持平或超前的 tier 中，水位描述的前綴必須在該視圖中完整。任一 tier 不符（視圖建立後被保留期刪除的列、所有列刪光後重用的 rowid、換過的資料庫、不產生 ref 的列）就不信任共用索引，該視圖全由 TEMP 回答：較慢，不會錯；換過的資料庫由主行程下一次 sync 重建。共用索引的寫入函式（ingest 連結、兩種 prune）在唯讀來源連線上不做事。走訪水位存在索引資料庫裡，與它擔保的列同一個交易寫入。主行程的 sync 在以下情況做完整走訪：沒有水位（新建或重建的索引、prune、目錄被換）、水位描述的前綴已不完整（水位以下有列被刪、資料庫被換）、成為最新的 transcript 前綴不是新列，或有 missing/failed ref 找不到來源列；否則只讀水位之後新增的列，加上每次重試的 missing/failed ref；沒有內文的列不花任何列。另一個連線佔住寫鎖時，主行程的搜尋最多等 1 s，然後把水位未涵蓋的部分讀入 TEMP 回答，不寫共用索引。SQLite 自行回滾索引交易時（磁碟滿 `SQLITE_FULL`、`SQLITE_IOERR` 等；本版本上這時 `inTransaction` 已為 false），任何索引敘述丟出錯誤後若交易已不在，就不再寫任何一列，水位更不寫：回滾帶走該次交易的一切（ref、文件、驗證、`directories`、新水位），存著的仍是上一次、仍然為真的水位。該次搜尋與鎖住時一樣，把水位未涵蓋的列讀入 TEMP 回答；TEMP 也寫不下時，只回答共用索引背書的部分，其餘覆蓋率記為 pending；下一次搜尋重新 sync 修好索引。不回滾交易的敘述錯誤（約束、格式錯誤的輸入）照舊只讓該 ref 記為 failed。以計數量測（3,500 列專案，4 個 missing 保存本文）：插入一筆無內文的列後下一次搜尋讀 4 個來源列、0 個 inline 重掃（修正前 502 列、498 個重掃）；新增一筆回應讀 5 列；live count 與快照查詢交替不觸發走訪。視圖落後 20 列的匯出 worker 搜尋修正前每次走訪其整個視圖並把共用索引修剪到該視圖（refs/docs 25/25 → 5/5），修正後讀 0 個來源列、共用索引不變。牆鐘時間未重量。放寬條件見收尾紀錄 §3 |
| 戰利品單筆上限 | 一筆 loot 事件最多存 500 個新 match，超過時該列加 `matches_truncated`／`matches_total`，未存的值留給下次出現時記錄；戰利品頁、逐字稿與側欄徽章（「N+」）標示為部分（#695） |
| API 上限 | `/api/loot/scan` 文字 128 KiB；查詢 1000 字元；JSON body 必須是物件且深度 ≤ 64（`src/core/api-request.ts`、`src/core/query/contract.ts`） |
| 已知未完成 | 開啟後第一次搜尋的主行程停頓（Spec 074）、8 MiB 相異雜湊輸出的遮蔽 denylist 時間（loot 列已有上限）、時間軸刻度重疊等，見收尾紀錄 §4；排程在 [工作計畫](WORK-PLAN.md) |
| 未驗證的環境 | Windows PowerShell 與 Git Bash、WSL、Linux 非 UTF-8 目錄、真實輸入法、多螢幕、簽章與公證 |

## 2026-11-11 核對（`main@9f60882d`）

| 項目 | 狀態／證據 |
|---|---|
| 程式基準 | `9f60882d`（合併 #682，2026-11-11）。2026-10-30 之後合併的 PR 由 `git log` 可見，包括 Stitch 各頁對齊（#609–#635）、時間軸 05 系列（#641–#650）、設定單欄與首頁（#598 等，#590）、來源警告直達設定列（#677）、#546 輸出預覽與插件狀態（#671）、#591 逐字稿空 inline 輸出（#676）、#560 前後事件（#682）、#561 可搜尋 AI session 選擇器（#681）、匯出選取移入 worker（#683）、#489／#499 安全收尾（#674）、CI 強化（#680）、Spec 061 對帳（#679）、macOS workflow 收尾（#668） |
| 該提交 CI | 未離線核對；以 GitHub Actions 該 commit 的執行為準 |
| 正式 spec 狀態 | 70 份：Verified 44、Implemented 5、Draft 19、Withdrawn 2（各 `spec.md` 的 `**Status**` 行；`npm run verify:specs` 於此 commit 通過）。索引見 [specs/README.md](../specs/README.md)；不代表每份已全平台驗收 |
| 設定首頁 | 三區塊（capture／project／other），見 `src/renderer/src/components/Settings.tsx` 的 `HOME_SECTIONS`（`351b7741`，#590）。舊紀錄寫「五組」者為當時說法 |
| 建立專案時的範圍 | 建立對話框可填授權目標與排除目標，並可匯入設定檔（`CreateProjectModal.tsx`）；這是現有能力，不是待立規格的新功能 |
| 側欄與快捷鍵 | 7 個編號入口：儀表板、活動紀錄、時間軸、HTTP、目標與範圍、證據、終端機（⌘／Ctrl+1–7），設定為 ⌘／Ctrl+9；逐字稿、範圍、戰利品、書籤沒有編號，各自歸入主入口（`lib/sidebarOrder.ts`、`lib/shortcuts.ts`） |
| 最近的跨 feature 驗收紀錄 | [2026-11-10 macOS workflow closeout](records/2026-11-10/MACOS-WORKFLOW-CLOSEOUT.md)、[2026-11-09 紀錄](records/README.md)；結論與限制以原文為準 |
| 文件結構 | 2026-11-11 依 [文件入口](README.md) 的放置規則整理：日期審查與計畫移入 `records/`，現行設計移入 `design/`，研究筆記移入 `research/`；清單見 [文件盤點](records/2026-11-11/DOCS-INVENTORY.md) |

## 2026-10-30 核對（保留，未重新驗證）

核對：2026-10-30；可靠性修正來源為 `main@9e648f7d` 加當次提交內容。

| 項目 | 狀態／證據 |
|---|---|
| 已提交程式 | [ae0544b5](https://github.com/guan4tou2/REDLOG/commit/ae0544b5bad44a7421f81f4501a01171e4e3d289)：UIUX 收斂、project rollback、HTTP history／Reader／scope／export |
| 該提交 CI | [40907105617](https://github.com/guan4tou2/REDLOG/actions/runs/40907105617) SUCCESS：Ubuntu／macOS／Windows unit 與 Ubuntu Electron E2E；不等於全部原生驗收 |
| 已驗證 Mac 成品 | `2dd45465+local` 候選，hash 與 smoke 見 [原始完成紀錄](records/2026-10-29/UIUX-COMPLETION-2026-10-29.md)；不是重新建置的 ae0544b5 成品 |
| 新 Mac 候選 | `9e648f7d+local`（打包時 tracked tree 無變更，標記來自無關未追蹤目錄）；DMG／hash／installed smoke 1 PASS 見 [063 verification](../specs/063-long-recording-segments/verification.md)；非其他平台通過，未發布 release |
| 文件整理 CI | [40913981305](https://github.com/guan4tou2/REDLOG/actions/runs/40913981305) completed／success，對應 `9e648f7d`；不含當次可靠性修正 |
| 當次可靠性修正與驗收成品 | 修正 SSE／WS 保存與 HAR、pause／identity／transport 邊界、磁碟滿載半檔；4,480 PASS／31 SKIP／0 FAIL；最終 DMG 安裝副本 5 PASS／0 SKIP，hash 與來源 diff 見 [063 verification](../specs/063-long-recording-segments/verification.md) |
| Mac 原生子項 | Finder 實體 ⌘⇧P 已由操作者確認且穿透設定保存成功，見 [062 驗收](../specs/062-recording-workflow-consolidation/mac-workflow-acceptance-20261022.md)；0.18.3→0.18.4 手動替換與證據讀回見 [061 verification](../specs/061-capture-safe-updates/verification.md) |
| 剩餘工作 | 當時 19 open issues 的分工見 [工作計畫](WORK-PLAN.md)；原生／真人由 [#457](https://github.com/guan4tou2/REDLOG/issues/457) 協調。issue 狀態最後核對於 2026-10-30 |

已提交程式、當時驗證的工作區及安裝產物各自綁版本。文件改名或 GitHub label 變更不能產生新的 PASS；歷史 hash 與平台限制保留。
