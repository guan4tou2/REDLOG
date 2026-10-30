# 審查與驗收紀錄

跨 feature 的當次審查、提案與驗收快照依 `YYYY-MM-DD/` 保存。單一 feature 的測試結果仍放在該 spec 的 verification／acceptance，避免兩邊維護同一份結果。

目前做什麼見 [工作計畫](../WORK-PLAN.md)，feature 狀態見 [Spec 索引](../../specs/README.md)。本目錄保留證據，不是另一份 roadmap；日期、commit、產物 hash 與未測限制不因搬移改寫。已失效設計放 [archive/](../archive/README.md)。

## 2026-10-29

| 紀錄 | 用途 |
|---|---|
| [UIUX 完成對帳](2026-10-29/UIUX-COMPLETION-2026-10-29.md) | `ae0544b5` 前工作區候選的逐項實作、測試、政策矩陣與 DMG hash |
| [核對後修復](2026-10-29/REVIEW-FOLLOWUP-2026-10-29.md) | 專案開啟回滾、FirstRun HTTP 與後續結果 |
| [來源追溯](2026-10-29/TRACEABILITY-2026-10-29.md) | 原需求、程式與測試的對應 |
| [原始審查](2026-10-29/REVIEW-2026-10-29.md) | 當時的發現與裁定，不當成今日未修清單 |
| [UIUX v3.2 提案](2026-10-29/UIUX-PROPOSAL-2026-10-29.md) | 原始要求、條件與歷史修正 |
| [Issues 收斂提案](2026-10-29/ISSUE-CONVERGENCE-2026-10-29.md) | 當時 18 issues 的分析；執行順序已由工作計畫接續 |
| [WSL／Git Bash 驗收](2026-10-29/ACCEPTANCE-326-345-2026-10-29.md) | D1–D4／G1–G3，保留待實機格 |
| [當次驗收執行](2026-10-29/ACCEPTANCE-RUN-2026-10-29.md) | 當次版本、平台與執行邊界 |
| [#457 發布內容](2026-10-29/UIUX-NATIVE-ACCEPTANCE-ISSUE-DRAFT.md) | 已公開追蹤單的原始草稿留存，不再當待發布任務 |

## 放置與維護

新紀錄先標日期、測試對象／commit、平台與結果。相同實驗的截圖或大產物放既有測試輸出／artifact，文件只連結必要證據；不把暫存 HOME、私密資料或產物副本塞進 docs。

移動 Markdown 時一起更新相對連結、inline repo 路徑與索引；固定 commit／release 的 GitHub URL 保留原指向。新增目錄不代表舊結果失效，也不代表取得新的 PASS。
