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
