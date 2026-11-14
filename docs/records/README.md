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

## 2026-11-12

| 紀錄 | 用途 |
|---|---|
| [可用性審查收尾](2026-11-12/USABILITY-AUDIT-CLOSEOUT.md) | #684、#694、#696、#697、#698、#693 的內容、驗證條件、行為變更與未完成事項（`main@aaee01fd`） |
| [根因審查與落地計畫](2026-11-12/ROOT-CAUSE-REVIEW.md) | 七份根因審查的整合、抽查結果、落地階段與當日決定（`main@a087c16c`） |
| 根因審查原文：[01 擷取完整性](2026-11-12/root-cause/01-capture-integrity.md)、[02 主行程回應性](2026-11-12/root-cause/02-main-thread.md)、[03 介面狀態與資料流](2026-11-12/root-cause/03-renderer-state.md)、[04 來源生命週期](2026-11-12/root-cause/04-source-lifecycle.md)、[05 信任邊界](2026-11-12/root-cause/05-trust-boundaries.md)、[06 驗證](2026-11-12/root-cause/06-verification.md)、[07 架構](2026-11-12/root-cause/07-architecture.md) | 唯讀審查者依程式碼推得的原始報告；未經逐項確認，抽查結果見整合頁 §2 |
| [08 外掛系統](2026-11-12/root-cause/08-plugin-system.md)、[09 設定時的選擇與多重性](2026-11-12/root-cause/09-setup-choices-and-multiplicity.md) | 後續兩份唯讀審查：外掛的契約、信任與生命週期；shell 安裝等「猜一個當事實」的設定（`main@a5e90877`）。抽查了四項主張成立（同 id 覆蓋 bundled、rc 檔固定路徑、移除找不到外掛、以說明文字比對依賴），其餘未逐項確認，各有未實跑清單 |
| [12 功能刪減審查](2026-11-12/root-cause/12-feature-reduction-audit.md) | 依 UI 標準 §26 逐頁盤點控制項、字串與概念數，各頁唯一的主要意圖，刪除／合併／收合的建議與連帶可移除的程式量，以及與先前決定的衝突（`main@e6d22684`）。唯讀；數量為原始碼宣告數與估計，未在真實 app 驗證；建議待擁有者裁定 |
| [11 隱私與資料保護](2026-11-12/root-cause/11-privacy-and-data-protection.md) | 各儲存處的敏感資料盤點、18 條遮蔽路徑與 12 處不一致、對外請求清單、擷取邊界與歸屬、刪除語意（`main@56c9fe6c`）。唯讀審查，未實跑；部分結論出自其子審查，未逐項確認 |
| [10 擷取種類與呈現](2026-11-12/root-cause/10-capture-kinds-and-presentation.md) | 每一種可寫入事件的產生者、層級、讀取處；有擷取但只以原始字串呈現的 29 種、呈現與性質矛盾的 13 處；對「四種角色」模型的修正（`main@a5e90877`）。抽查三項成立（閱讀器不讀 `output_disposition`、狀態帶取自已載入的列、個人網域在 bundle 中直接丟棄）；其餘未逐項確認，十項需實跑 |
| [操作摩擦盤點](2026-11-12/FLOW-FRICTION-AUDIT.md) | 三條流程的操作步數與概念數（依程式路徑計數，非真人操作）；十項排名中兩項經查不成立，見整合頁 §2 |

## 2026-11-13

| 紀錄 | 用途 |
|---|---|
| [當日的決定](2026-11-13/DECISIONS.md) | 產品邊界（單人、來源屬於機器、多人多機在 app 之外）、外掛模型、介面、資深滲透測試者審查的六題、實作中的修訂；逐項標明取代了哪些既有決定。皆為決定，尚未實作 |
| [當日狀況、需求彙整與未涵蓋事項](2026-11-13/STATUS.md) | 當日結束時的進度（已合併、開著的 PR、進行中）、到目前為止的需求與規範單一清單及各自出處、待裁定的七題、十七項尚未涵蓋的功能與設計（`main@4769fa1d`）。彙整，不新增決定；缺口為觀察，未逐項查證 |
| [13 整合與背景成本](2026-11-13/13-consolidation-and-background-cost.md) | 「兩件事其實是一件事」的整合清單、儀表板的用途、app 閒置時的背景工作與處置。唯讀；耗電量級為讀碼推估，未量測 |
| [14 資深滲透測試者角度的審查](2026-11-13/14-senior-pentester-review.md) | 三種任務類型逐步走查、採用阻礙、各功能的實際使用頻率、七項要務的現況、十五項建議與停止做的事。唯讀；「事件不帶出口位址」已對照程式碼確認，其餘未逐項確認 |
| [#660 Windows 約 198k 事件的效能重測](2026-11-13/PERF-660-WINDOWS-198K.md) | 原基準同一台筆電、`main@72796837` 的 `out/`：專案開啟、Timeline、四種匯出的耗時、主程序停頓與記憶體；預覽階段走訪 8 遍快照的根因；未做項目。單一環境、單日，取消／專案切換／證據鏈未驗 |

## 放置與維護

新紀錄先標日期、測試對象／commit、平台與結果。相同實驗的截圖或大產物放既有測試輸出／artifact，文件只連結必要證據；不把暫存 HOME、私密資料或產物副本塞進 docs。

移動 Markdown 時一起更新相對連結、inline repo 路徑與索引；固定 commit／release 的 GitHub URL 保留原指向。新增目錄不代表舊結果失效，也不代表取得新的 PASS。
