# 目前狀態

> **狀態**：current — 「現在什麼是真的」的唯一頁面；下一步只在 [工作計畫](WORK-PLAN.md)  
> **範圍**：已合併程式、spec 正式狀態、候選產物與驗收證據的入口  
> **最後核對**：2026-11-11 於 `main@9f60882d`，只核對本 repository 可讀到的事實（git 紀錄、spec 檔、程式）；issue 狀態與 CI 結果沒有離線來源，保留各自的核對日期

其他文件裡的狀態表、待辦與「目前」敘述都是寫成當天的紀錄（[records/](records/README.md)），與本頁不一致時以本頁及其證據為準；本頁也不能取代證據本身。

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
