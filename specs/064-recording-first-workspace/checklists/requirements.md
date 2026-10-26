# Specification Quality Checklist: 紀錄優先工作區

**Purpose**: 驗證規格品質，非宣稱實作或人機驗收通過。
**Created**: 2026-10-26
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] 主規格描述使用者成果及界線，資料契約／責任位置分置 contracts、traceability 及 implementation-notes。
- [x] 聚焦接入、記錄、找回、交付；易用性優先於視覺及頁數。
- [x] 可供非開發者閱讀；內部詞彙只在必要的來源／證據語意使用。
- [x] 必要 user stories、edge cases、requirements、entities、success criteria、assumptions 皆有內容。

## Requirement Completeness

- [x] 無未解決的 NEEDS CLARIFICATION；已採使用者後續決定並記錄合理預設。
- [x] 每項需求可觀察驗證；不以 Enabled／綠燈／舊候選代替真實結果。
- [x] 成功條件有任務、時間／動作／正確性／效能及量測方法。
- [x] 成功條件不綁特定框架或新資料表。
- [x] 主要流程都有 Given／When／Then 及對應驗收任務。
- [x] 已處理亂序／跨頁配對、未配對、長內容、權限、缺口、跨專案及未知來源。
- [x] 非目標明確：不新增 AI／聊天／SIEM／Burp 引擎／商城／移轉／報告模式。
- [x] 原工單、既有能力、候選與 main／新需求分開；可靠性依賴及分批 gate 明示。

## Feature Readiness

- [x] FR-001–053 均在 traceability 對應責任位置／契約、UX-01–19 或 CT-01–16 及四階段交付。
- [x] 七個 user journeys 依 P0／P1／P2 及 S1–S4 區分；基礎授權／修復不因設定改版較晚而延後。
- [x] 結果包含實際成品與原始資料核對，非只依截圖／DOM／測試數字。
- [x] 六份 canonical 契約明定身分、覆蓋、Viewer、錨點、快照及擷取有效邊界；不宣稱現有程式已通過。

## Notes

- 完成規格檢查，可進入 Plan；不等於任何 UX 任務 PASS。
- 檢查時已解決：保留／移除泳道、頁數與完整閱讀、Scope 編輯位置、Thinking 保存用語、Marker／Bookmark、AI 回報歸因、官方 AI 範圍、紀錄優先順序。
- `.specify/extensions.yml` 不存在，沒有 before_specify／after_specify hooks。
- 本次僅文件檢查及 Spec Kit gate，不為文書整理重跑整套 App 測試。

Validation: 53 個唯一 FR 全部有責任位置／契約／驗收／階段對照；19 個唯一 UX、16 個唯一 CT、六份跨層契約；14 份 Markdown 的相對連結、範本占位符與 code fence 檢查通過。`npm run verify:specs`、`git diff --check` 通過。這是規格文件檢查，全部產品任務仍為 NOT RUN。
