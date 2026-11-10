# Implementation Notes — 066 官方整合入口、雙向定位與擷取健康(B 批次)

記錄現況與既有能力,不把建議當成已實作。基準 `origin/main` eaa40e46(Spec 065 批次 A 已合併)。

## 現況(2026-11-04 審查)

### 官方整合管理(`src/core/plugins/official-agents.ts`)

- `createOfficialAgentPluginManager(root, packageRoot).list()` 回傳**完整目錄**:每個整合 `{ agentKind, pluginId, name, source, installationId?, state, error? }`,`state ∈ not-installed | installed | update-available | conflict | error`。
- 未安裝的整合**只在目錄裡**,磁碟上沒有 plugin 目錄,所以 `plugins:list`(讀磁碟上的 LoadedPlugin)**看不到它**。這是 B 要補的缺口:插件頁目前因此只能顯示已安裝的官方整合(且被 `isHidden` 藏起來)。
- `install(kind)`／`uninstall(kind)` 是機器層級的操作:`install` 對 `update-available` 做 staging→backup→swap,失敗回滾;`uninstall` 只刪受管檔案。稽核在 `src/main/ipc/plugins.ts` 的 `mutateOfficialAgent` 內寫 `config_changed`。
- `pluginView()`(同檔)標記 `officialAgent: official.some(e => e.pluginId === p.manifest.id)`,並把 installed 的官方整合當一般插件序列化。

### 設定→擷取來源(`AgentsPanel.tsx`,經 `CaptureControlPage`)

- `AgentRow` 目前擁有:install/update/restore 按鈕、每專案 `enabled` 開關、workPaths 的增刪與路徑選擇、sessions 排除、`sourceRoot` 變更、`emitThinking`、`captureBoundary`、`SourceLastSeen`、移除整合(uninstall，經 `confirmGraded` 說明後果)。
- `AgentsPanel` 讀 `officialAgents()` + `plugins.list()`(取 active pluginIds)+ `window.redlog.agents.sources/sessions`,並用 `useCaptureHealth(5000, signature)` 取健康快照。
- 已有 `onOpenPlugins={() => setTab('plugins')}` 從 `CaptureControlPage` 傳入(目前用於「到插件頁看 capture pack」的既有提示),B 可沿用它做「跳到該整合詳情」的定位。
- `mutate(kind, op)` 目前在 `AgentsPanel` 內呼叫 `installOfficialAgent`/`uninstallOfficialAgent` 後 `load()` + `refreshHealth()`。

### 設定→插件(`PluginsPanel.tsx`／`PluginDetailPanel.tsx`,A 批次)

- `isHidden` 目前為 `p.officialAgent === true || (OWNED_ELSEWHERE.has(p.id) && p.status !== 'disabled')`。B 要讓官方整合列可見 → 移除 `p.officialAgent` 這一項(其餘隱藏規則不動)。
- 五軸詳情:安裝軸目前只說「隨 RedLog 提供／放在插件資料夾中」;專案軸固定「依專案的擷取設定在『擷取來源』列管理」;健康軸固定「後續版本列入」。三軸在 B 要接真資料。
- `pluginViewModel.ts` 的 `install` 目前只有 `{ origin, managedBy }`;`project`/`health` 固定 `{ applicable: false }`。
- 進入點的頁面切換由 `Settings.tsx` 的 `setTab` 掌握;`PluginsPanel` 目前只收 `t`,B 需加導航 callback。

### 擷取健康(`src/core/capture-health.ts` 與 `useCaptureHealth`)

- 健康快照已含每個來源的 `id`、`label`、`installed`、`enabled`、`lastEventAt`、`state`、`lastError`;官方整合以 `agent-<agentKind>` 為 id,`lastEventAt` 由 `agent_type='agent' AND …agent=<kind>` 查詢。
- 判定語意已寫在 `capture-health.ts`:有錯誤且未恢復 → `error`;`update-available`/`conflict`/設定路徑不存在 → `error` 並帶訊息;**沒收到事件不等於故障**(`everFed`、`ACTIVE_WINDOW_MS` 等)。
- `useCaptureHealth(pollMs, signature)` 對設定列「失敗就失敗,不把舊值當現在」;`useCaptureHealthState` 給狀態列/儀表板。同一份快照是「同一問題兩處顯示不能互相矛盾」的基礎。
- `SourceLastSeen` 的措辭(`settings.source.lastReceived`/`neverReceived`)可直接沿用。

## 依賴與可重用

- 官方整合目錄(含未安裝)已由 `officialAgents()` 提供 → 插件頁列出未安裝者不需新安裝邊界,可能只需在 `plugins:list` 的回傳旁附目錄,或由 renderer 另外呼叫 `plugins.officialAgents()` 合併。**不得刪除既有 `plugins:list` 欄位。**
- 健康快照已有 `agent-<kind>` 條目與共用 store → 健康軸接線不需新 IPC。
- 設定頁已有 `setTab` 與頁面 id(`plugins`、`captureControl`);B 的雙向定位用既有頁面切換＋焦點意圖即可。
- `useContainerWidth`、`gen:settings-search`、read-state 矩陣、`e2e/official-agent-capture.spec.ts`、`e2e/capture-settings-interaction.spec.ts` 皆沿用,需同步回歸。

## 分批界線

- **B**:插件頁官方整合列可見＋安裝/更新/移除操作;AgentsPanel 去重與跳轉;雙向定位;衝突/錯誤進需處理;健康軸接線;AgentsPanel 專案設定回歸。
- **C**:本機匯入、衝突恢復、安全檢查(`official-agents.ts` 的 `inspect`/staging 更動);不覆蓋非受管檔案、不繞過信任。

## 風險

- 未安裝整合的列:資料來自目錄而非 `plugins:list`,View Model 需容忍「有 install 資料、無 trust/report 資料」——不可用一般插件的 `status` 欄位硬套(會顯示成「停用」)。
- 安裝/移除按鈕搬到插件頁後,`AgentsPanel` 的 `mutate`/`load`/`refreshHealth` 要重新整理;若只搬按鈕不移除,會出現兩套會互相矛盾的狀態。
- 健康「未知」與「故障」不可混用;讀取失敗時沿用舊值會誤導信任判斷。
- 雙向定位不得變成「跳轉即設定」;只定位,不改設定。
- `isHidden` 一改,官方整合列首次出現在插件頁;既有 `capture-settings-interaction` 的寬度/溢位檢查與 `official-agent-capture` 的流程需重跑。
