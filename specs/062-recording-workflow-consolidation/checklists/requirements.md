# Specification Quality Checklist: 紀錄工作流程與操作入口整合

**Purpose**: 檢查規格品質，不是產品通過驗收。
**Created**: 2026-10-19
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] spec 描述使用者行為；程式定位集中於 audit.md。
- [x] 聚焦可用的紀錄流程，沒有新增市場、模型閘道或 HUD 模式。
- [x] 明確區分使用者要求與草案預設。
- [x] 包含情境、需求、實體、成功條件與假設。

## Requirement Completeness

- [x] 無未解的 NEEDS CLARIFICATION 標記；可調整細節列為草案預設。
- [x] FR-001 至 FR-016 均對應可觀察驗收情境。
- [x] 成功條件可驗證，沒有無依據秒數/人數/大小門檻。
- [x] 包含錯誤、空、載入、專案切換與取消。
- [x] 明確限制桌面範圍、實際來源能力與非目標。
- [x] 列出既有領域契約、規格與待整合分支。

## Feature Readiness

- [x] 已核對 main 與相關分支；不把已落地項目列為未實作。
- [x] 主要流程有人工驗收矩陣，尚未跑的明列 NOT RUN。
- [x] 已提出可獨立實作順序，不要求單一巨大 PR。
- [x] 本階段可進入規劃；不宣稱已 Implemented 或 Verified。

## Notes

本次為單人靜態規格審閱。2026-10-21–22 已補 US6 的 Plan/Tasks/Analyze 與實作；Converge／最後驗收結果見 verification.md。其他故事仍有未執行項目，不以匯出測試取代它們。完整跨平台產品驗收 28 項尚未全部執行；2026-10-21 Mac 子步驟結果見 mac-acceptance-20261021.md。
.specify/extensions.yml 不存在，無前後 hooks。使用現有模板解析器，未建立/切換分支。
