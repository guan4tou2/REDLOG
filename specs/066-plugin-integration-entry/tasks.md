# Tasks: 官方整合入口、雙向定位與擷取健康(B 批次)

依 plan.md 與 spec.md FR-001–033;S1→S2→S3。每故事 tests→實作→整合→e2e。沒有 [P] 的任務按依賴順序。

## Setup

- [x] T001 建 spec.md／implementation-notes.md／plan.md／tasks.md,記錄現況、批次界線與憲章決策於 specs/066-plugin-integration-entry/。

## S1 — 官方整合列與安裝入口(US4)

- [x] T002 [US4] 先 RED:在 test/plugin-integration-entry.test.tsx(或擴充 plugin-view-model.test.ts)驗——官方整合目錄(含 `not-installed`)與 `plugins:list` 以 `pluginId` 合併成一列;未安裝列存在且不被顯示成停用(FR-001、FR-004)。
- [x] T003 [US4] 先 RED:安裝軸四態(未安裝/已安裝/可更新/衝突/錯誤)由目錄 `state` 決定;一般插件仍為「插件資料夾」(FR-002)。
- [x] T004 [US4] 先 RED:官方整合 `conflict`/`error`/`update-available` 各自計入需處理,`error` 帶具體訊息(FR-005)。
- [x] T005 [US4] 插件頁列出官方整合列(移除 `isHidden` 的 `officialAgent` 項),未安裝列只顯示安裝入口、不顯示 enable/disable(FR-001、FR-004)。
- [x] T006 [US4] 詳情安裝軸狀態＋安裝/更新/解除安裝按鈕(唯一入口),呼叫既有 `installOfficialAgent`/`uninstallOfficialAgent`,完成後讀回真實列表;解除安裝前說明後果(FR-003、FR-004)。
- [x] T007 [US4] View Model `install` 擴充 `state`/`error`/`installationId`;確保主行程不刪既有 `plugins:list` 欄位(FR-006)。

## S2 — AgentsPanel 去重與雙向定位(US5)

- [x] T008 [US5] 先 RED:AgentsPanel 不再渲染 install/update/restore/remove 按鈕;改顯示「到插件頁該整合」入口(FR-010、FR-011)。
- [x] T009 [US5] 移除 `AgentsPanel` 的 `mutate` 安裝/解除安裝操作路徑;保留 `load`/`refreshHealth` 供專案設定與健康(FR-010)。
- [x] T010 [US5] 回歸:workPaths 增刪、每專案 `enabled`、sessions 排除、`sourceRoot` 變更、scopeChanged、captureBoundary、last seen 不變(FR-012)。
- [x] T011 [US5] 插件詳情加「開啟擷取來源」入口,帶 `focus`;`PluginsPanel`/`Settings` 加 `onOpenCaptureSources` 與定位(FR-020)。
- [x] T012 [US5] `AgentsPanel` 的跳轉帶 `focusPluginId`,`PluginsPanel` 接收並選取該整合(含未安裝);跳轉不寫設定(FR-021、FR-022)。

## S3 — 擷取健康與回歸(US6)

- [x] T013 [US6] 先 RED:健康軸以 `useCaptureHealth` 共用快照呈現最近事件/長時間無事件/錯誤;讀取失敗顯示「狀態未知」不沿用舊值(FR-030、FR-032)。
- [x] T014 [US6] 「沒收到事件 ≠ 故障」:未安裝、未啟用或從未收到不報故障;有 `lastError` 才顯示錯誤(FR-031)。
- [x] T015 [US6] 專案軸顯示「已安裝/未為此專案啟用」等認知層級,與健康軸分開,不合併成單一顏色(FR-033)。
- [x] T016 i18n:新增狀態/健康/跳轉 keys(en/zh-TW),跑 `npm run gen:settings-search`;`test/settings-search.test.ts` 綠(FR 全部)。
- [x] T017 既有單元與 e2e 回歸:`official-agent-capture`、`capture-settings-interaction`、`plugin-explore`、`plugins-panel-truth`、read-state(layout-read-states 契約)、`plugins-load-error` 重試(FR-012、成功標準)。
- [x] T018 五道 push gate + build;於 verification.md 記 B 切片(候選與成品、RED/GREEN、Gates);Spec 066 維持 Draft,C 完成前不逐項轉 Verified。

## 明確排除(C 承接,不在本批次)

- 本機匯入可行性、衝突恢復與安全檢查、非受管檔案保護(不改 `official-agents.ts` 的 `inspect`/staging 以「修復」衝突目錄)。
