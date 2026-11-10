# Implementation Plan: 官方整合入口、雙向定位與擷取健康(B 批次)

依 spec.md;S1 官方整合列與安裝入口(US4)→ S2 去重與雙向定位(US5)→ S3 擷取健康與回歸(US6)。每任務 tests→實作。B 止於 Renderer 與唯讀合併查詢;不新增可執行插件能力、不繞過信任或 `config_changed` 稽核。

## Technical Context

- **資料合併**:官方整合目錄 `plugins.officialAgents()` 已有全部整合與 `state`(含 `not-installed`);`plugins:list` 只有磁碟上的 `LoadedPlugin`。合併鍵是 `pluginId`(目錄的 `pluginId` ＝ 已安裝插件的 `manifest.id`)。未安裝者只有目錄側資料,View Model 需容忍「有 install、無 trust/report」——**不得用一般插件的 `status` 欄位硬套**(會顯示成「停用」)。可能做法:主行程在 `pluginView()` 旁附目錄,或 renderer 另外呼叫 `officialAgents()` 合併;不刪既有欄位。
- **未安裝列的辨識**:`officialAgents()` 的 `state` 是唯一真值;插件頁啟用/停用只對已載入插件有意義,未安裝列不得出現 enable/disable。
- **安裝/更新/移除**:既有 IPC `plugins:installOfficialAgent(kind)`／`uninstallOfficialAgent(kind)`,主行程已有 staging/backup/rollback 與 `config_changed` 稽核;UI 只呼叫,完成後讀回真實狀態(不先畫結果)。解除安裝沿用 `confirmGraded` 的後果說明。
- **雙向定位**:設定頁由 `Settings.tsx` 的 `setTab(page)` 切換;`CaptureControlPage` 已收 `onOpenPlugins`。B 加:插件詳情的 `onOpenCaptureSources(focus)`、`AgentsPanel` 的 `onOpenPlugins(focusPluginId)`;`PluginsPanel` 接收 `focusPluginId` 開啟選取。純檢視定位,不寫設定。
- **擷取健康**:`useCaptureHealth(pollMs, signature)` 共用快照(與狀態列/儀表板同一份),官方整合以 `agent-<agentKind>` 為 id,含 `lastEventAt`/`state`/`lastError`。判定沿用 `capture-health.ts` 的既有語意(沒收到事件 ≠ 故障;讀取失敗 → 未知)。
- **布局**:沿用 `useContainerWidth`(<720 切換)與 A 批次的列表/詳情;官方整合列只是多一種列的內容,不新增第三層。
- **i18n**:新 key 加完跑 `npm run gen:settings-search`;狀態字串(未安裝/已安裝/可更新/衝突/錯誤、健康未知)走 i18n,不硬編。

## Constitution Check

- 信任仍全域(pluginId＋contentHash＋Capabilities);官方整合是 bundled 來源,狀態照實顯示,不宣稱成專案授權。
- 既有 IPC 與稽核不繞過;新入口不得另開可執行路徑。
- 隱藏規則僅官方整合列解除(`isHidden` 移除 `officialAgent` 一項),其余與 disabled 永遠顯示維持。
- read-state 矩陣、consent、容器寬度布局與窄版返回維持。
- 「診斷不遺失」:需處理新增 conflict/error/update-available,詳情仍完整呈現。

## S1 — 官方整合列與安裝入口(US4)

- T002–T004:先 RED——官方整合目錄(含未安裝)併入列表、以 pluginId 合併為一列;未安裝顯示「未安裝」而非停用;`conflict`/`error`/`update-available` 進需處理。
- T005–T007:詳情安裝軸顯示四態;安裝/更新/解除安裝按鈕(唯一入口),完成後讀回;解除安裝後果說明。
- View Model 擴充:`install` 從 `{origin,managedBy}` 擴為同時帶官方整合 `state`/`error`/`installationId`(一般插件保持 `pluginFolder`)。

## S2 — AgentsPanel 去重與雙向定位(US5)

- T008–T010:先 RED——`AgentsPanel` 不再有 install/update/remove 按鈕;需要動作時給「到插件頁該整合」的入口;專案擷取設定(workPaths/sessions/enabled/sourceRoot/emitThinking)不變。
- T011–T012:雙向定位——插件詳情 `onOpenCaptureSources(focus)`;`AgentsPanel` 的 `onOpenPlugins(focusPluginId)`;定位到具體列/詳情(含未安裝),不寫設定。
- 回歸:`AgentsPanel` 的 session 排除、scopeChanged、captureBoundary、last seen 與既有 e2e 流程。

## S3 — 擷取健康與回歸(US6)

- T013–T014:健康軸接 `useCaptureHealth`;顯示最近事件/長時間無事件/錯誤/未知;「沒收到 ≠ 故障」;讀取失敗顯示未知。
- T015:專案軸顯示「已安裝/未為此專案啟用」等認知層級,與健康軸分開。
- T016:既有插件與 AgentsPanel 測試、`e2e/official-agent-capture`／`capture-settings-interaction`／`plugin-explore` 回歸;i18n＋`gen:settings-search`。
- T017:五道 gate、build、verification.md(B 切片記錄);Spec 066 維持 Draft,C 完成後才逐項轉 Verified。065 的 A 切片在 B 完成後可一併轉 Verified(仍依 B/C 整體界線)。

## Verification / Dependencies

- macOS arm64 原生 Electron e2e;Windows 原生布局與安裝包由後續平台 gate 承接。
- B 依賴 A(已合併於 `main` eaa40e46);C 不依賴 B。
- 健康判定與 +SourceLastSeen 文字沿用既有 snapshot,不另造第二套。
