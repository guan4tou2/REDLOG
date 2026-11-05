# Implementation Plan: 專案選擇畫面 — 搜尋與範圍狀態徽章

依 spec.md(D1–D4 已決議);S1 搜尋(US1)→ S2 範圍摘要查詢(US2 資料層)→ S3 徽章與整合(US2 畫面)。每任務 tests→實作。不改建立流程、不改 `project:list` 形狀。

## Technical Context

- **比對函式**:現有的空白分詞 AND 比對是 `pluginViewModel.ts` 的 `matchesQuery`,只有插件頁用。搜尋要用同一個語意,所以抽成共用模組(`lib/textQuery.ts`),兩處改引用,不複製第三份;`verify:architecture` 會擋住殘留的重複匯出。
- **搜尋元件狀態**:查詢字串是 `ProjectPicker` 內的狀態,不持久化。顯示條件看 `projects.length`(篩選前)。搜尋框要在 `projects.map` 區塊之外穩定存在,不能隨結果數卸載(D1 焦點要求)。
- **Enter 與輸入法**:`onKeyDown` 檢查 `e.nativeEvent.isComposing` 與 `keyCode === 229`;只有「非空白查詢且 matches.length === 1」才呼叫既有的 `handleOpen`。
- **範圍摘要(資料層)**:新增 `core` 的純函式 `readProjectScope(projectDir)`,回傳 `set | unset | unknown`,**不經過 `loadConfig`**:
  1. `config.yaml` 不存在 → `unset`;存在但讀取／YAML 解析失敗 → `unknown`。
  2. 取 `scope.targets`;若有 `scope.scopeFile`,用 `readScopeFile`(它會回報 `unreadable`／`invalid`)——失敗 → 整體 `unknown`,不回報部分數量。
  3. 合併去重(與 `snapshotScope` 同一語意)後計數;0 → `unset`。
  `snapshotScope` 本身吞掉範圍檔錯誤,所以不直接呼叫它;去重規則抽成共用的小函式讓兩者共用,避免「範圍」有兩種意思。
- **IPC**:新 handler `project:scopeSummaries`(唯讀):對 `listProjects()` 的每個專案各自 try/catch 呼叫 `readProjectScope`,回傳以專案 id 為鍵的結果;單一專案例外只影響該 id。不更新 `lastOpened`、不開資料庫(FR-012)。preload 與 `env.d.ts` 加型別。
- **渲染端查詢世代**:選擇畫面進入或重新整理時遞增世代編號;回傳時比對世代與專案 id,不符丟棄(FR-017)。結果存成 `Map<id, summary>`,列以 `p.id` 取值,不以索引。清單先 render,徽章位置在結果到達前留白(不是「未設定」)。查詢整體 reject → 每列「範圍未知」。
- **徽章元件**:模組層級的小元件(不在 `ProjectPicker` 內宣告,見 CLAUDE.md React 規則)。三態文案走 i18n;`unset` 用提示色而非警報色,沿用 `scopeIssue` 的語氣。
- **i18n**:`project.search`(aria-label)、`project.searchPlaceholder`、`project.searchCount`、`project.noMatches`、`project.clearSearch`、`project.scope.set`(單複數安全)、`project.scope.unset`、`project.scope.unknown`;en／zh-TW 同步,跑 `gen:settings-search`。
- **已存在可沿用**:`useReadState`／`project-list-status`(載入／空／失敗)、`formatSize`、同名專案顯示日期。

## Constitution Check

- 沒有寫入:範圍摘要只讀,不碰 `lastOpened`、不開專案資料庫。
- 「讀取失敗不是空」:範圍讀不到是 `unknown`,不是 `unset`;整體失敗是每列「範圍未知」。
- 範圍仍只由 Settings ▸ Scope 持有;選擇畫面只顯示。
- 鍵盤開啟、建立欄位焦點、載入／空／失敗狀態不退化。

## S1 — 搜尋(US1)

- 抽出 `lib/textQuery.ts`(`matchesQuery`),插件頁改引用,既有插件測試維持綠。
- `ProjectPicker`:搜尋框（≥ 6 總數）、符合數、0 筆文案與清除、Enter 規則、IME 保護、焦點保留。

## S2 — 範圍摘要查詢(US2 資料層)

- `readProjectScope` 純函式與單元測試:不存在／空／有 targets／只有範圍檔／範圍檔壞掉／config 損毀／兩個範圍檔其一壞掉。
- `project:scopeSummaries` IPC、preload、型別;單一專案失敗隔離;唯讀斷言(`lastOpened` 與檔案不變)。

## S3 — 徽章與整合(US2 畫面)

- 世代／id 對應、留白、整體失敗、單列失敗;徽章元件與 i18n。
- e2e:6 個專案顯示搜尋框;損毀 `config.yaml` 的專案顯示「範圍未知」;只用範圍檔的專案顯示數量;篩選後開啟的是正確專案。
- 回歸:專案清單相關 e2e 與鍵盤開啟、`project-list-status` 三態。

## Verification / Dependencies

- macOS arm64 原生 Electron e2e;Windows 路徑與檔案鎖由單元測試涵蓋。
- 不依賴 067 C 批次;與 #571(啟動與 UI 規劃)可能同動 `ProjectPicker.tsx`,開工前先看該 PR 是否已觸碰同一區塊。
