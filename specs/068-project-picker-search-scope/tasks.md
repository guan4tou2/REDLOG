# Tasks: 專案選擇畫面 — 搜尋與範圍狀態徽章

依 plan.md 與 spec.md FR-001–018;S1→S2→S3。每故事 tests→實作→整合。

## Setup

- [ ] T001 開工前確認 #571 是否已改動 `ProjectPicker.tsx`;若是,以其為基底。

## S1 — 搜尋(US1)

- [x] T002 [US1] 先 RED:`matchesQuery` 從 `pluginViewModel.ts` 抽到 `lib/textQuery.ts`,兩處引用同一份;既有插件測試維持綠(FR-002)。
- [x] T003 [US1] 先 RED(`test/project-picker-search.test.tsx`):5 個專案不顯示搜尋框、6 個顯示;以篩選前總數判斷(FR-001)。
- [x] T004 [US1] 先 RED:輸入使結果為 0 或 1 筆,搜尋框仍在且 `document.activeElement` 是它(FR-001)。
- [x] T005 [US1] 先 RED:0 筆顯示「沒有符合」與清除,與「還沒有任何專案」文案不同;清除後回到完整清單(FR-003)。
- [x] T006 [US1] 先 RED:Enter 規則——非空白＋恰好 1 筆才開啟;0 筆、多筆、純空白、組字中(`isComposing`／keyCode 229)都不開啟,查詢與焦點保留(FR-004)。
- [x] T007 [US1] 實作搜尋框、符合數、`role="status"` 告知與 aria-label(FR-005);方向鍵不觸發列表導覽。
- [x] T008 [US1] 回歸:鍵盤開啟列表、建立欄位焦點、載入／空／失敗三態、改名／刪除在篩選中運作(FR-002、FR-004)。

## S2 — 範圍摘要查詢(US2 資料層)

- [x] T009 [US2] 先 RED(`test/project-scope-summary.test.ts`):`config.yaml` 不存在 → `unset`;存在但空 → `unset`;有 targets → `set(count)`(FR-010)。
- [x] T010 [US2] 先 RED:只用範圍檔宣告 → 計入條目;與 `scope.targets` 重複者去重(FR-010)。
- [x] T011 [US2] 先 RED:`config.yaml` 損毀／無法讀取 → `unknown`,不是 `unset`;範圍檔 `unreadable`／`invalid` → `unknown`;兩個範圍檔其一失敗 → 整體 `unknown`、不含部分數量(FR-011)。
- [x] T012 實作 `readProjectScope`(不經 `loadConfig`、不呼叫會吞錯的 `snapshotScope`);抽出與 `snapshotScope` 共用的去重規則。
- [x] T013 [US2] 先 RED:`project:scopeSummaries` 單一專案例外只影響該 id;唯讀——呼叫前後 `projects.json` 的 `lastOpened` 與專案檔案不變(FR-012、FR-013)。
- [x] T014 實作 IPC handler、preload 與 `env.d.ts` 型別;`project:list` 回傳形狀不變(FR-016)。

## S3 — 徽章與整合(US2 畫面)

- [x] T015 [US2] 先 RED:清單先 render 且可開啟，徽章在結果到達前留白，不顯示「未設定範圍」(FR-018、D4)。
- [x] T016 [US2] 先 RED:三態文案——「N 個目標」(中性)、「未設定範圍」(提示色、非警報)、「範圍未知」;整體查詢失敗每列「範圍未知」;單列失敗不影響他列(FR-013、FR-014)。
- [x] T017 [US2] 先 RED:世代／id 對應——舊世代晚到的結果丟棄；篩選、改名、刪除之後結果仍貼在正確的專案；已不存在的 id 丟棄(FR-017)。
- [x] T018 實作世代與 id 對應、徽章元件(模組層級)與 i18n(en／zh-TW),跑 `npm run gen:settings-search`(FR-015)。
- [x] T019 e2e(`e2e/project-picker-search-scope.spec.ts`):6 個專案顯示搜尋框;損毀 `config.yaml` 的專案顯示「範圍未知」;只用範圍檔的專案顯示數量;篩選至單一專案後 Enter 開啟的是正確專案。
- [x] T020 回歸:既有專案清單 e2e、`project-list-status`、鍵盤開啟、插件頁搜尋(因 T002 的抽取)。
- [ ] T021 五道 push gate + build;於 verification.md 記實作與驗證;Spec 068 在全部任務完成並驗證前維持 Draft。

## 明確排除

- 建立專案時填寫範圍(#297 的邊界)。
- `listProjects` 遞迴掃描的效能量測(另案)。
- 「開啟本機專案」入口、設計稿的假資料與視覺細節。
