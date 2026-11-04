# Implementation Notes — 065 插件列表與詳情(A 批次)

記錄現況與既有能力,不把建議當成已實作。基準 `origin/main` f51037e0。

## 現況(2026-11-04 審查)

### 設定→插件(`PluginsPanel.tsx`,src/renderer/src/components/settings/)

- 平面清單:每列標題下內嵌 `ContributionResults`(loot/redaction/targetExtractors/commandTags/eventTypes/capture/terminalProfiles 各群組的 accepted/rejected/waiting),列一長資訊全擠在標題下。**沒有搜尋、沒有需處理篩選、沒有獨立詳情檢視。**
- 每列操作:enable/disable、Review(consent 授予)、revoke;reload 與 open folder 在頁首;consent 是 `Modal`(focus trap、Escape、不隨 backdrop 關閉)。
- 載入/空/失敗＋retry 已有(`plugins.loading`/`plugins.empty`/`plugins-load-error`)。
- `isHidden` 規則:official agent 行與 `OWNED_ELSEWHERE` 隱藏;disabled 永遠顯示(隱藏選擇不隱藏狀態)。
- 狀態軸 `PluginStatus`:`active/needs-consent/hash-changed/disabled/error`;tier 僅 privileged 顯示警示 chip。
- `apiAhead` 行:宣告式插件照常列(讀已知部分),程式型是 error。
- `profilesError` 對所有行相同,取自 `plugins:list` 回傳的第一行。

### IPC(`src/main/ipc/plugins.ts`)

- `plugins:list` 回傳 `pluginView()`:每個 LoadedPlugin 序列化成 UI 形狀,含 `officialAgent` 旗標、`status`、`report`(contribution report,`getContributionReport(pluginId)` 可能為 null)、`profilesError`、`apiAhead`、`terminalProfiles`/`captureInstalls`(審核內容)。
- `officialAgents.list()` 提供安裝維度(`not-installed/installed/update-available/conflict/error`)。
- 所有 plugin 狀態變更都走 `auditPluginChange` 寫 `config_changed` 事件(有開啟專案時)。**不得為新 UI 另開 IPC 繞過。**

### 資料模型(`src/core/plugins/types.ts`)

- `LoadedPlugin.manifest` 含 `contributes`(lootPatterns/redaction/commandTags/targetExtractors/eventTypes/capture/terminalProfiles/tailers)與 `capabilities`。
- Contribution Report 是**實際生效結果**,不是 manifest 宣告(`getContributionReport`);`report === null` = 尚無診斷,不等於成功。既有 `plugins.results.*` i18n 已區分 accepted/rejected/waiting。
- 官方 agent 也是 plugins 根目錄下的 plugin(`officialAgent: true` 由 `pluginView` 標記),所以 pluginId 就是合併鍵。

### 可重用

- `useContainerWidth`(src/renderer/src/hooks/useContainerWidth.ts):HttpHistoryPanel/BookmarksView 已用同一模式做「容器寬度 → 並排/切換」,直接沿用。
- `settingsSearchIndex`(PAGE_SOURCES.plugins)由 `npm run gen:settings-search` 產生;新 i18n key 加完要重跑,否則 `test/settings-search.test.ts` golden test 紅。
- read-state 矩陣契約:`e2e/layout-read-states.spec.ts` + `docs/LAYOUT-RELIABILITY.md`。

## 依賴

- View Model 需要 `plugins:list` 的現有欄位即可;**不需新 IPC**。
- B 批次才需要:official agent 行併入列表(改 `isHidden`)、`AgentsPanel` 安裝操作改跳轉、capture health 接線、雙向定位。

## 分批界線

- **A**:搜尋、需處理篩選、列表＋詳情、五維度 View Model、容器寬度布局。全部 Renderer 側;`plugins:list` 形狀不變(或僅加欄位,不刪)。
- **B**:官方整合統一入口(`AgentsPanel` 同步調整與回歸)、雙向定位、擷取健康維度接線。需同時改 `AgentsPanel.tsx` 與 e2e `official-agent-capture.spec.ts`/`capture-settings-interaction.spec.ts`。
- **C**:本機匯入、衝突恢復、安全檢查(`official-agents.ts` 的 `inspect`/staging 邏輯擴充)。

## 風險

- 列表截斷診斷的誘因:摘要與詳情的分離必須以「詳情完整呈現」為驗收底線,避免把「摘要化」做成「遺失」。
- 布局切換狀態只存在於 renderer,不得寫入設定;重排重進要由列表資料重建,不依賴本地快照。
- `profilesError`/`report === null` 的語意若被誤讀(全部成功)會誤導信任判斷,spec 已把兩者列為明確例外。
