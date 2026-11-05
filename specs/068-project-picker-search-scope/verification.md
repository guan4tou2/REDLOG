# Verification: 專案選擇畫面 — 搜尋與範圍狀態徽章

**Date**: 2026-11-05。Feature 保持 **Draft**:S1(搜尋,#574)、S2(範圍摘要查詢,#577)已在 main,本檔記錄 S3(徽章與整合)的實作與驗證 checkpoint。尚未做 Windows 原生布局驗證,CI 全綠且該項補驗前不轉 Verified。

## 成品

- `ProjectPicker` 在列表右側顯示範圍徽章,資料來自 `project:scopeSummaries`(S2)。徽章元件 `ScopeBadge` 在模組層級,不在 `ProjectPicker` 內宣告。
- 三態:`set` →「N 個目標」(中性;1 個為「1 個目標」);`unset` →「未設定範圍」(琥珀提示色、非紅、非 `role="alert"`、不含「警告」);`unknown` →「範圍未知」(中性,`title` 說明「無法讀取,不代表是空的」)。
- 查詢**不延後清單**:範圍查詢在清單回應(成功或失敗)之後才啟動,清單先 render 且可開啟(FR-018)。結果到達前徽章**留白**,不顯示「未設定」。
- 整體查詢失敗 → 每列「範圍未知」;答案缺某 id 或條目形狀不對 → 該列「範圍未知」(不是「未設定」)(FR-013)。
- 世代:`useReadState` 的依賴為清單的 phase,清單每次重讀都是新一輪,舊輪晚回來的結果被丟棄(FR-017)。徽章以 `p.id` 取值,不以列位置或篩選後索引;答案裡已不存在的 id 不顯示。
- `project:list` 回傳形狀、`ProjectMeta` 欄位未動(FR-016)。i18n 單數與複數分兩個 key(目前沒有 plural 機制);zh-TW 的單數寫成不帶佔位字元的「1 個目標」,避免 `ui-copy` 的重複字串規則。

## RED

- `test/project-scope-badge.test.tsx` 先寫,實作前 9／10 失敗(唯一過的是「待決時留白且仍可開啟」,本來就成立)。
- 實作後只剩一例失敗,原因是測試自己:它在答案到達前就取徽章;改成 `waitFor`。
- 文案守門測試各抓到一次:`i18n-terminology`(zh-TW 引用了不存在的設定頁名稱,「設定 ▸ 範圍」,改成不引用頁名)、`ui-copy`(zh 單複數同句)、`i18n-keys`(單數 key 兩語系佔位字元不一致)。皆為本批文案問題,已修。

## GREEN

- Gates:`typecheck`、`verify:specs`、`verify:architecture`、`verify:i18n` 全綠。
- 新單元:`project-scope-badge`(10)——留白、三態文案、提示非警報、整體失敗、單列缺漏、畸形條目、篩選後徽章跟著專案、改名後徽章保留、不存在的 id 忽略、舊世代晚到結果丟棄。
- 回歸單元:`project-picker-*`、`plugin-*`、`ui-copy`、`i18n-*`、`settings-search` 全綠;`npm run gen:settings-search` 已跑(索引無變動)。
- Electron e2e(macOS arm64 原生,sandbox 外):`project-picker-search-scope`(新)、`project-startup`、`project-flow`、`project-rename`、`project-open-rollback` — 10 passed。新 spec:六個專案顯示搜尋框;三目標→「3 targets」;只用範圍檔宣告→「2 targets」;損毀 `config.yaml`→「Scope unknown」;無設定→「Scope not set」;顯示徽章前後各專案 `lastOpened` 不變;篩選到單一專案按 Enter 開啟的是該專案。

## 刻意不做

- 建立專案時填寫範圍(#297 的邊界)、`listProjects` 遞迴掃描效能量測、「開啟本機專案」入口。
- 徽章不可點擊、不提供從選擇畫面改範圍(範圍仍只由 Settings ▸ Scope 持有)。

## 尚未驗證

- Windows 原生布局。
- 完整 `npm test`:本機 pretest 在 sandbox 內會中止,改以 `npx vitest run` 跑。結果 5446 passed / 128 failed(21 檔);其中 20 檔是本機環境本來就紅的 pty／shell 檔,另 1 檔 `record-terminal-adapter-selection` 在完整 suite 下失敗、單獨跑 12／12 通過,符合 CLAUDE.md 記載的「換檔案、單獨綠」flake。CI 是準據。
