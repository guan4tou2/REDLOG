# Tasks: 統一探索與管理入口 — 插件列表與詳情(A 批次)

依 plan.md 與 spec FR-001–041;S1→S2→S3。每故事 tests→實作→整合→e2e。沒有 [P] 的任務按依賴順序。

## Setup

- [x] T001 建 spec.md／implementation-notes.md／plan.md,記錄現況、批次界線與憲章決策於 specs/065-plugin-explore-and-manage/。

## S1 — 搜尋與需處理(US1/US2)

- [x] T002 [US1] 在 test/plugin-explore-search.test.tsx 先驗(Red)：搜尋比對名稱、id、作者、描述、capabilities、contributes 種類;內建 pack 以翻譯後描述命中;找不到顯示空結果而非全列表消失(FR-010)。
- [x] T003 [US1] 於 PluginsPanel 或其子元件接搜尋框即時過濾;與既有 read-state(載入/空/失敗)並存(FR-011 交集、FR-030 之後接布局)。
- [x] T004 [US2] 在 test/plugin-needs-attention.test.ts 先驗純函式 `needsAttention(p)`：載入錯誤、hash 變更待重授、待授權、apiAhead、contribution 被拒/部分被拒/等待、profilesError 各算一項;`report === null` 與乾淨正常不算;disabled 但乾淨不算(FR-011)。
- [x] T005 [US2] 接「需處理」濾器:計數徽章、開啟後無結果顯示「全部已處理」而非空列表;摘要只列最重要異常(FR-011、FR-003)。
- [x] T006 [US1/2] 搜尋＋濾器並用(交集)與各自可清除的元件測試;邊界:無描述、超長 capabilities。

## S2 — 詳情與布局(US3)

- [x] T007 [US3] 在 test/plugin-view-model.test.ts 先驗 `PluginViewModel` 純建構：以 pluginId 去重、五軸各自獨立不併成單一 status、資料缺失與「不適用」可區分、官方 agent 行保留隱藏但目前不重複(《同一插件只有一列》)(FR-001、FR-040–041)。
- [x] T008 [US3] 在 test/plugin-explore-detail.test.tsx 先驗詳情：report === null 顯示「尚無診斷」不顯示成功;逐類 contribution 的 accepted/rejected/waiting 與被拒名稱＋原因;apiAhead 與 error 的具體訊息;capabilities／terminalProfiles／captureInstalls 審核內容(FR-022、FR-021)。
- [x] T009 [US3] 列表每行一行異常摘要＋詳情完整呈現;profilesError 照實呈現不冒充插件自身錯誤(《診斷不遺失》)(FR-003、FR-021)。
- [x] T010 [US3] 詳情對該插件保留既有操作(啟用/停用、授予/撤銷、reload),與列表同源、不造第二套(FR-023)。
- [x] T011 [US1–3] 以 `useContainerWidth` 接列表/詳情布局:≥720 並排、<720 切換並提供返回;重排/卸載後由列表資料重建、不依賴本地快照(FR-030–031)。

## S3 — i18n 與整合

- [x] T012 新增 i18n keys(en/zh-TW)(搜尋、需處理、尚無診斷、全部已處理、詳情五軸、返回等),跑 `npm run gen:settings-search`;`test/settings-search.test.ts` 綠(FR 全部)。
- [x] T013 既有插件頁測試與 e2e 回歸全綠:啟用/停用/授權/撤銷/reload/open folder、consent dialog、read-state(layout-read-states 契約)、`plugins-load-error` 重試。
- [ ] T014 新 e2e journey(e2e/plugin-explore.spec.ts):搜尋→切需處理→開詳情→讀完整 report→返回;窄/寬布局各一遍(若 e2e 環境可切容器寬度)。
- [ ] T015 五道 push gate + build;於 verification.md 記 A 切片(候選與成品、RED/GREEN、Gates);整體 Spec 065 維持 Draft,B/C 完成前不逐項轉 Verified。

## 明確排除(B/C 承接,不在本批次)

- 官方整合在插件頁的安裝/更新/解除安裝入口、`AgentsPanel` 操作改跳轉與回歸、插件↔擷取來源雙向定位、capture health 維度接線(B)。
- 本機匯入、衝突恢復與安全檢查、非受管檔案保護(C)。