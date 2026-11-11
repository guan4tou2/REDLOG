# 審查與驗收紀錄

跨 feature 的當次審查、提案與驗收快照依 `YYYY-MM-DD/` 保存。單一 feature 的測試結果仍放在該 spec 的 verification／acceptance，避免兩邊維護同一份結果。

目前做什麼見 [工作計畫](../WORK-PLAN.md)，feature 狀態見 [Spec 索引](../../specs/README.md)。本目錄保留證據，不是另一份 roadmap；日期、commit、產物 hash 與未測限制不因搬移改寫。已失效設計放 [archive/](../archive/README.md)。

## 2026-08-01 至 2026-09-19（2026-11-11 自 `docs/` 根目錄移入）

| 紀錄 | 用途 |
|---|---|
| [Windows compatibility audit](2026-08-01/WINDOWS_COMPAT_AUDIT.md) | POSIX 假設的唯讀審查；含 2026-08-18 已修項目 |
| [Correctness audit](2026-08-08/AUDIT-2026-08-08.md) | v0.9.3 全樹審查的發現 |
| [UX & complexity audit](2026-08-10/UX-AUDIT-2026-08.md) | v0.11.5 的 UX 與複雜度審查 |
| [操作流程與 AI log 審查](2026-09-18/AUDIT-2026-09-18-app-ai-log.md)、[回應與修復](2026-09-18/AUDIT-2026-09-18-RESPONSE.md) | 2026-09-18 的審查與 PR #114 的回應 |
| [現存問題整理](2026-09-19/AUDIT-2026-09-19-current-findings.md)、[工程方法檢查](2026-09-19/AUDIT-2026-09-19-engineering-methods.md) | 2026-09-19 的發現與 TDD／DDD／SDD 檢查 |

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

## 2026-11-01（2026-11-11 移入）

| 紀錄 | 用途 |
|---|---|
| [Performance audit](2026-11-01/PERF-AUDIT-2026-11.md) | `07a32ee4`（v0.18.6）的啟動、Timeline、ingest、匯出、bundle 與記憶體量測；腳本在 [perf-audit-2026-11/](2026-11-01/perf-audit-2026-11/)，從 repo 根目錄執行；`bench-event-delivery.ts` 引用的 `src/core/export-stream` 已在 `6f1ff450` 移除，該腳本目前無法執行 |

## 2026-11-04 至 2026-11-07（2026-11-11 自 `docs/` 根目錄移入）

這批原本各自寫有「目前狀態」與待辦；仍可能未完成的項目已併入 [工作計畫](../WORK-PLAN.md) 的 2026-11-11 補記。

| 紀錄 | 用途 |
|---|---|
| [UIUX 需求重新核對](2026-11-04/UIUX-RECHECK-2026-11-04.md) | `f51037e0` 上逐項需求的結果與缺口 |
| [issue／spec 一致性檢查](2026-11-04/ISSUE-SPEC-REVIEW.md) | #568／#569 與既有 spec 的對照 |
| [擷取閱讀與驗證入口修正](2026-11-04/UIUX-CAPTURE-FIX-VERIFICATION.md) | 空 stderr、streamed output 與 HTTPS 驗證入口的修正與驗證 |
| [專案啟動畫面實作計畫](2026-11-04/PROJECT-STARTUP-IMPLEMENTATION-PLAN.md)、[驗證](2026-11-04/PROJECT-STARTUP-VERIFICATION-2026-11-04.md) | 專案選擇與建立流程的決策、結果與當時的完整 unit 失敗 |
| [跨頁 UI/UX 改善分析](2026-11-04/UIUX-FLOW-IMPROVEMENT-ANALYSIS.md) | #569 的分析與排序 |
| [剩餘 UI/UX 與擷取流程實作計畫](2026-11-04/UIUX-REMAINING-IMPLEMENTATION-PLAN.md) | 批次 A–E 與 HTML 參考稿的當日計畫 |
| [插件探索與管理規範](2026-11-04/PLUGIN-MANAGEMENT-SPEC.md) | #568 的原始提案；執行由 Spec 065–067 承接 |
| [UIUX 遠端同步狀態](2026-11-05/UIUX-SYNC-STATUS.md) | 2026-11-05 同步到 PR 的範圍與整合驗證 |
| [UI/UX 設計與實作差異矩陣](2026-11-07/UIUX-DESIGN-IMPLEMENTATION-MATRIX.md) | `9ca36509` 上各工作區與 Stitch 原型的差異和裁定；2026-11-11 有補記 |

## 2026-11-09

| 紀錄 | 用途 |
|---|---|
| [Cast 內容讀取驗收](2026-11-09/CAST-CONTENT-VERIFICATION.md) | `3e455574` 上 cast 位元組範圍的讀取與投影 |
| [儀表板最終稿比對](2026-11-09/DASHBOARD-STITCH.md) | 與 `prototypes/stitch/dashboard-2026-11-09.html` 的比對 |
| [背景匯出與 Timeline 控制狀態](2026-11-09/EXPORT-TIMELINE-VERIFICATION.md) | 匯出 Worker 批次與 Timeline 控制 |
| [macOS 測試整理](2026-11-09/MACOS-TEST-CLOSEOUT.md) | `c614cbf3` 上的結果與未完成驗收 |
| [審查處理紀錄](2026-11-09/REVIEW-CLOSEOUT.md) | 11 月 9 日審查的處理結果 |
| [Capture and network recovery](2026-11-09/STATE-RECOVERY-VERIFICATION.md) | 受管 HTTP 失敗與網路讀取恢復 |
| [UI 一致性檢查](2026-11-09/UI-STYLE-CONSISTENCY.md) | 色彩、邊框與間距 |

同目錄的 `.json`／`.jsonl`／`.py` 是上述紀錄引用的量測資料與腳本。

## 2026-11-10

| 紀錄 | 用途 |
|---|---|
| [macOS Reader、Timeline 與匯出整合驗收](2026-11-10/MACOS-WORKFLOW-CLOSEOUT.md) | `3dd84052` 加當批實作的 macOS 驗收；資料在 `export-workflow-macos.json` |

## 2026-11-11

| 紀錄 | 用途 |
|---|---|
| [文件盤點](2026-11-11/DOCS-INVENTORY.md) | 整理前每份 Markdown 的類型、時效、引用者與去處 |

## 放置與維護

新紀錄先標日期、測試對象／commit、平台與結果。相同實驗的截圖或大產物放既有測試輸出／artifact，文件只連結必要證據；不把暫存 HOME、私密資料或產物副本塞進 docs。

移動 Markdown 時一起更新相對連結、inline repo 路徑與索引；固定 commit／release 的 GitHub URL 保留原指向。新增目錄不代表舊結果失效，也不代表取得新的 PASS。
