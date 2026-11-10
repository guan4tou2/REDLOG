# Implementation Plan: 統一探索與管理入口 — 插件列表與詳情(A 批次)

依 spec.md;S1 搜尋＋需處理 → S2 詳情＋布局 → S3 i18n＋整合＋e2e。每任務 tests→實作;A 全部 Renderer,不新增 IPC。

## Technical Context

- 「需處理」與搜尋都建立在 `plugins:list` 已回傳的全量 `PluginView` 上(`PluginView.tsx` 的 `PluginView` 型別含 `status`/`report`/`profilesError`/`apiAhead`/`terminalProfiles`/`captureInstalls`),即時運算不需新 IPC。
- 五維度 View Model:`PluginViewModel` 以 `pluginId` 為鍵;信任軸用 `status`、功能生效軸用 `report`、安裝/專案/擷取三軸 A 先保留契約(資料不足或 B 才接線時該軸顯示「不適用」而非亂填狀態)。
- 布局依 `useContainerWidth`(書籤 720 / HTTP 960 的既有模式);插件詳情列入/切換門檻預設 **720px**(與 BookmarksView 一致,設定頁本身已有側欄)。此值可調,不是規格。
- `needsAttention(p)` 純函式匯出供 list 摘要與濾器共用,單元測試直接驗。
- 新 i18n key 加完跑 `npm run gen:settings-search`(golden test 要求);`report === null`／`profilesError`／`apiAhead` 語意守住 spec 的例外,不冒充全部成功。

## Constitution Check

- 信任仍是全域(pluginId＋contentHash＋Capabilities);新 UI 只用既有 `plugins:*` IPC,審核／稽核(`config_changed`)語意原樣保留。
- 隱藏規則(isHidden)與 disabled 永遠顯示維持;新增檢視不得讓「看不到的狀態」變「無可復原」。
- 驗收以「詳情可以讀到完整診斷」為底線;摘要化不等於遺失。

## S1 — 搜尋與需處理(US1/US2)

- T002–T003:搜尋(先 RED)
- T004–T005:需處理濾器與計數(先 RED)
- T006:搜尋＋濾器並用整合

## S2 — 詳情與布局(US3)

- T007:View Model 純函式(先 RED)
- T008–T010:詳情五軸、完整 report、摘要一行＋詳情完整(先 RED)
- T011:容器寬度布局與窄幅返回

## S3 — i18n 與整合

- T012:i18n keys＋`gen:settings-search`＋既有頁面文字回歸
- T013–T014:unit＋e2e journey(搜尋→濾器→詳情→返回;既有啟用/停用/授權/撤銷/reload/read-state 回歸)
- T015:五道 gate、build、verification.md(065 的 A 切片記錄;整體仍 Draft,待 B 完成才逐項轉 Verified)

## Verification / Dependencies

- macOS arm64 原生 Electron e2e;Windows 原生布局由後續平台 gate 承接。
- A 不依賴 B/C;官方整合統一入口屬 B,不在本 plan。
- 詳情布局門檻 720 為可調預設，若接受既存偏好即照用（待 PR 審查確認）。