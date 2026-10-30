# 目前狀態

核對：2026-10-30；可靠性修正來源為 `main@9e648f7d` 加本次提交內容。此頁只提供狀態與證據入口；下一批與 gate 見 [工作計畫](WORK-PLAN.md)。

| 項目 | 狀態／證據 |
|---|---|
| 已提交程式 | [ae0544b5](https://github.com/guan4tou2/REDLOG/commit/ae0544b5bad44a7421f81f4501a01171e4e3d289)：UIUX 收斂、project rollback、HTTP history／Reader／scope／export |
| 該提交 CI | [40907105617](https://github.com/guan4tou2/REDLOG/actions/runs/40907105617) SUCCESS：Ubuntu／macOS／Windows unit 與 Ubuntu Electron E2E；不等於全部原生驗收 |
| 已驗證 Mac 成品 | `2dd45465+local` 候選，hash 與 smoke 見 [原始完成紀錄](records/2026-10-29/UIUX-COMPLETION-2026-10-29.md)；不是重新建置的 ae0544b5 成品 |
| 新 Mac 候選 | `9e648f7d+local`（打包時 tracked tree 無變更，標記來自無關未追蹤目錄）；DMG／hash／installed smoke 1 PASS 見 [063 verification](../specs/063-long-recording-segments/verification.md)；非其他平台通過，未發布 release |
| 文件整理 CI | [40913981305](https://github.com/guan4tou2/REDLOG/actions/runs/40913981305) completed／success，對應 `9e648f7d`；不含本次可靠性修正 |
| 本次可靠性修正與驗收成品 | 修正 SSE／WS 保存與 HAR、pause／identity／transport 邊界、磁碟滿載半檔；4,480 PASS／31 SKIP／0 FAIL；最終 DMG 安裝副本 5 PASS／0 SKIP，hash 與來源 diff 見 [063 verification](../specs/063-long-recording-segments/verification.md) |
| Mac 原生子項 | Finder 實體 ⌘⇧P 已由操作者確認且穿透設定保存成功，見 [062 驗收](../specs/062-recording-workflow-consolidation/mac-workflow-acceptance-20261022.md)；0.18.3→0.18.4 手動替換與證據讀回見 [061 verification](../specs/061-capture-safe-updates/verification.md) |
| 正式 spec 狀態 | [64 份索引](../specs/README.md)：44 Verified、5 Implemented、13 Draft、2 Withdrawn；不代表每份已全平台驗收 |
| 剩餘工作 | 19 open issues 的分工與下一里程碑見 [工作計畫](WORK-PLAN.md)；原生／真人由 [#457](https://github.com/guan4tou2/REDLOG/issues/457) 協調 |

已提交程式、當時驗證的工作區及安裝產物各自綁版本。文件改名或 GitHub label 變更不能產生新的 PASS；歷史 hash 與平台限制保留。
