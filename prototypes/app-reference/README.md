# REDLOG — Stitch UI reference

此交付是依目前 renderer 元件重建的獨立 HTML 視覺參考，並非原生 Electron 執行結果，也不是已完成的新產品 UI。

## 開啟與交付

- 雙擊 `index.html` 即可離線使用，不需要 build、CDN、網路或伺服器。設定頁使用同目錄的 `settings-interactive.html`，移動或分享時須一併保留。
- 主入口從專案選擇開始，點選專案進入工作區。建立專案對話框以名稱必填驗證帶入首次準備畫面；不會建立真實專案。
- `pages/*.html` 可各自開啟；設定頁仍依賴上層目錄的 `settings-interactive.html`。
- Stitch 若提供程式碼匯入／貼上入口，使用對應 HTML 原始碼；若僅接受圖片，使用 `screenshots/*-1440.png` 作視覺參考並貼入該頁 HTML。Stitch 各版本能力不同，此交付不保證平台直接解析完整 HTML。
- 建議逐頁輸入：「保留 REDLOG 的既有 tokens、資訊架構與頁面布局，依這份 HTML 與截圖進行修改；不要改為通用卡片儀表板。」
- 原型截圖包含 1440×900 和 900×700 兩種視窗。`layout-inventory.json` 列出各原型畫面可見標題、控制項與連結。
- `electron-reference/` 是以隔離空專案擷取的現行 Electron 畫面與 DOM 快照，可用來辨認原型的差異；DOM 快照是分析資料，並非可獨立執行的 HTML。網路位址與本機路徑已遮蔽。

## 忠實度與差異

來源以 `implementation/src/renderer/src` 的現行程式碼為準；`docs/UIUX-STANDARD.md` 是輔助規範。實際 tokens：bg #121214、surface #1a1a1d、elevated #212126、border #74747c、subtle #4a4a53、accent #d75f63；沿用 Noto Sans TC / JetBrains Mono、0.9 app zoom、150px 側欄、34px 按鈕與 40px 列高。圖示為本地 inline SVG、以 Lucide 的 16px/1.5px 描邊規格重建。可讀性與結構相近，但 HTML 並非直接編譯原 React 元件，不能主張 pixel-perfect。

保留活動四閱讀入口、六個主要工作區、設定五組十二頁、底部 Inspector、HTTP 資料表與 split detail。現行插件頁為卡片清單；另列 `plugins-proposed`，明確標示提案且依 Draft 規範重建。該提案不是已實作現況。

截圖縮圖是以 HTML 畫出的佔位示意，非實際網站證據。所有網域/IP/人名/時間/版本狀態/事件數均為固定示例，使用保留的 example.test、192.0.2.0/24、203.0.113.0/24。正文字型採既有字型的字元子集，其他新輸入字元可能使用系統 fallback。

## 互動範圍

可操作：跨頁導覽、專案搜尋／新增名稱驗證、活動搜尋與輸出展開、工作區分頁、終端樣本分頁／字級／搜尋計數、HTTP 搜尋與列選取／請求回應頁籤、時間軸事件選取與 Inspector、設定搜尋／密度、插件搜尋／篩選／選取、對話框與焦點圈限、Escape 關閉。篩選與示例控制只影響記憶體中的畫面。

不執行：Shell、daemon、瀏覽器啟動、網路擷取、資料庫讀寫、鏈驗證、信任授權、安裝/解除安裝、設定持久化、真實匯出、截圖擷取、上鏈標記、刪除、通知外送。沒有後端的動作會明示限制，不顯示假成功。設定欄位可編輯但不保存。部分狀態頁與 modal 使用簡化內容，非完整原生操作行為。

## 頁面／來源對照

| HTML | 畫面 | renderer 元件（components/） |
|---|---|---|
| `pages/projects.html` | 專案選擇 | `ProjectPicker.tsx` |
| `pages/first-run.html` | 首次準備 | `FirstRunView.tsx, CapturePreparation.tsx, HttpCaptureStep.tsx` |
| `pages/dashboard.html` | 總覽 | `DashboardView.tsx, CaptureHealth.tsx, IPStatusCard.tsx` |
| `pages/activity.html` | 活動紀錄 · 操作 | `SearchPanel.tsx, ActivityResults.tsx` |
| `pages/activity-io.html` | 活動紀錄 · 輸入／輸出 | `SearchPanel.tsx, ActivityResults.tsx, SourceSessionPicker.tsx` |
| `pages/activity-ai.html` | 活動紀錄 · AI 對話 | `ActivityResults.tsx, AgentConversation.tsx, SourceSessionPicker.tsx` |
| `pages/activity-raw.html` | 活動紀錄 · 原始事件 | `SearchPanel.tsx, ActivityResults.tsx, timeline/TimelineEventLog.tsx` |
| `pages/terminal.html` | 終端機 | `TerminalView.tsx` |
| `pages/timeline.html` | 時間軸與 Inspector | `Timeline.tsx, timeline/TimelineEventInspector.tsx, TimelineEventDetails.tsx` |
| `pages/event-stream.html` | 事件流 | `timeline/TimelineEventLog.tsx` |
| `pages/http.html` | HTTP 歷程 | `HttpHistoryPanel.tsx, HttpDetail.tsx` |
| `pages/targets.html` | 目標與範圍 | `TargetView.tsx, TargetScopeWorkspace.tsx` |
| `pages/scope.html` | 範圍 | `TargetScopeWorkspace.tsx, ScopeStatus.tsx, settings/ScopePage.tsx` |
| `pages/evidence.html` | 證據 · 截圖與附件 | `ScreenshotsView.tsx, EvidenceWorkspace.tsx` |
| `pages/loot.html` | 證據 · 戰利品 | `LootPanel.tsx` |
| `pages/bookmarks.html` | 證據 · 書籤 | `BookmarksView.tsx` |
| `pages/settings-shell.html` | Shell 指令 | `Settings.tsx, settings/HooksPanel.tsx` |
| `pages/settings-http.html` | HTTP(S) | `Settings.tsx, settings/BrowserPage.tsx, BrowserPanel.tsx` |
| `pages/settings-sources.html` | 其他擷取來源 | `Settings.tsx, settings/CaptureControlPage.tsx, CapturePackGroup.tsx, AgentsPanel.tsx` |
| `pages/settings-project.html` | 專案與範圍 | `Settings.tsx, settings/ProjectSettings.tsx, ScopePage.tsx` |
| `pages/settings-network.html` | 網路與身分 | `Settings.tsx, settings/NetworkPage.tsx` |
| `pages/settings-loot.html` | 戰利品偵測 | `Settings.tsx, settings/LootRulesGroup.tsx` |
| `pages/settings-retention.html` | 資料保留 | `Settings.tsx, settings/RetentionPage.tsx` |
| `pages/settings-integrity.html` | 完整性 | `Settings.tsx, settings/IntegrityPanel.tsx` |
| `pages/settings-general.html` | 一般 | `Settings.tsx, settings/GeneralPage.tsx` |
| `pages/settings-hud.html` | HUD | `Settings.tsx, settings/HudPage.tsx` |
| `pages/settings-about.html` | 關於 | `Settings.tsx, settings/AboutPage.tsx` |
| `pages/settings-plugins.html` | 插件 | `Settings.tsx, settings/PluginsPanel.tsx, PluginSampleTester.tsx` |
| `pages/plugins-proposed.html` | 插件探索 · 提案 | `../docs/PLUGIN-MANAGEMENT-SPEC.md (Draft, not implemented)` |

## 驗證

本份檔案由先前的本機產生腳本恢復；原有驗證紀錄沒有保留。新產生的 `validation.json` 記錄 Chrome 在兩種尺寸切換 29 個路由時的執行錯誤，`screenshots/` 為原型截圖；尚未逐項驗證互動或視覺一致性。另用現行 build 擷取 20 個 Electron 空專案畫面，見 `electron-reference/manifest.json`。這不代表完整使用流程、真實擷取或後端驗證通過。

Electron 的首次使用畫面與舊原型已有可見差異，必須以 Electron 截圖和目前元件為準；目前不能宣稱完全對照。未涵蓋的狀態包含有資料的工作區、各對話框、載入及錯誤狀態與窄視窗 Electron 畫面。

設定頁已整合先前的互動原型。以 Chrome 實際點選 12 個設定頁並驗證獨立頁入口；各頁內部所有控制項尚未逐項驗證。設定原型包含標示為提案的外掛行為，不能視為現行 App 的實作。

## 字型授權

內嵌 Noto Sans TC 與 JetBrains Mono 來自目前 repo 的 @fontsource 依賴（SIL Open Font License）。原始授權另附 `FONT-LICENSES/`。
