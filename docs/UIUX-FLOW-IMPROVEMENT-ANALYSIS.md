# REDLOG 跨頁 UI/UX 改善分析與實作順序

> 遠端同步校正（2026-11-04）：本文件原檢查基準為 f51037e0。同步時遠端 main 已為 eaa40e46（PR #567），Spec 065 插件 A 批次搜尋、需處理與列表/詳情已合併；B/C 與完整驗收仍未完成。舊文中的「尚未實作／最新 spec 到064」是當時快照，不代表目前遠端。詳見 UIUX-SYNC-STATUS.md。
日期：2026-11-04
狀態：分析提案；未實作、未完成本輪 GUI QA。
GitHub issue：https://github.com/guan4tou2/REDLOG/issues/569
插件規範追蹤：https://github.com/guan4tou2/REDLOG/issues/568
基準：main f51037e07c3b6fe199338769eb809d1830dfda40。
方法：原始碼靜態核對、現有 issue 去重、外部工具官方文件比對。既有 issue 的手動驗證屬於該 issue 作者的歷史證據，不是本次重現。

## 1. 結論與排序
先確保「接入 → 驗證 → 找到紀錄 → 閱讀 → 關聯 → 匯出」完整，再改列表密度與視覺。保留既有樣式與活動紀錄/時間軸各自的任務。
P0：來源/插件狀態語意與已保存內容可讀性（#546、#550）。
P1：插件探索與安裝入口、來源定位（新插件規範、#435、#557）；Session 搜尋（#561）；前後事件與跨頁返回（#560）。
P2：逐字稿入口決策（#563）、Inspector 資訊層次、HTTP flow 閱讀；首次啟動及匯出以補驗收為主。
不以 issue 仍開啟推定功能未完成；#436 已記錄匯出結果保留與重啟恢復已合併。

## 2. 頁面與使用流程

### 2.1 擷取來源/設定
已核對 CaptureControlPage：同頁包含 AgentsPanel、截圖、host monitor pack 與 ExternalCaptureGroup；已顯示來源最後收到資料，並非完全缺乏狀態。
問題：異質任務集中長頁；全域安裝、專案操作與外部 producer 步驟混合，#435/#557 已追蹤。
提案：先加入可定位群組與穩定 sourceId 深連結，不增加設定側欄頁數。外部 producer 保留實際手動步驟，不以假開關暗示啟動。來源的必要權限、範圍及修復動作原地呈現。
借鑑 HTTP Toolkit：來源選擇與實際收到流量分開；其 Connected Sources 以攔截到的流量為依據。REDLOG 需更進一步區分心跳與證據保存。
驗收：儀表板異常 → 正確來源 → 修復 → 測試事件 → 閱讀該事件；工作目錄變更需重新確認，不能默默擴大範圍。
追蹤：#435、#557、#546；插件安裝責任變更由 PLUGIN-MANAGEMENT-SPEC.md 定義。

### 2.2 活動紀錄與 AI Session
已核對 RecordingWorkspace：共用查詢、activities/io/ai/events 四種讀法、保留已訪問 reader；已有開啟時間軸入口。不可再宣稱 Timeline 完全無畫面入口。
已核對 SourceSessionPicker：原生 select、分頁載入、保留未在當頁的選取、新事件刷新與 cursor。
提案：沿用 Session token/snapshot，改為可搜尋選擇器。搜尋必須涵蓋後端資料範圍，若只搜尋已載入資料必須明示；不能以首批資料沒命中聲稱沒有 Session。先查 API 是否支援搜尋，再決定新增有界查詢，避免無限制拉取所有資料。
借鑑 Kibana 的查詢/篩選/文件檢視分工；只加來源、時間、Session 等既有欄位操作，不引入完整 KQL/ES|QL。
驗收：至少 30 個 Session，目標在第二頁，鍵盤搜尋選取成功；快速切 provider/專案時舊結果不覆蓋；讀取失敗與沒有對話不同。數量使用權威總量，不從當頁推算。
追蹤：#561；不新增相同缺陷單。

### 2.3 活動紀錄 ↔ 時間軸
#560 記錄「前後事件」只在時間軸詳情，活動紀錄需繞路；本輪未重新操作重現。
提案：活動詳情提供「查看前後事件」，以 eventId、timestamp、projectId 建立查詢；導航保留來源查詢、Session、捲動、選取與時間範圍。
借鑑 Grafana 的 context-sensitive correlation links；Jaeger 的標籤優先級與相關連結。前後時間鄰近不是因果關係，UI 必須區分已知關聯與時間附近。
驗收：搜尋 → 前後事件 → 時間軸定位 → 返回，查詢與原位置不丟；同毫秒事件依穩定排序；被刪除/無法讀取事件顯示明確結果。
不重寫 Timeline、不增加模式切換、不把所有瞬時事件畫成 span。
Sidebar 目前沒有 Timeline 一級項，但活動紀錄 header 已有入口。是否提升到一級導航需量測，不再當作缺陷直接新增。
追蹤：#560、#558、#317。

### 2.4 Inspector / 內容閱讀
#546 報告非標準 agent subtype/output_preview 存入後無法在一般閱讀器找到；#550 報告 cast slice 已擷取但內容欄位稱未擷取。這些應先修資料契約再調排版。
提案：固定呈現結果/主要內容/完整性，再漸進展開 metadata、原始 JSON、關聯 ID。區分「無輸出」「未擷取」「已擷取但目前讀取失敗」「內容在附件/回放」「截斷」。
借鑑 Sentry 詳情頁的資訊組織；此排序是 REDLOG 的設計建議，不是聲稱 Sentry 使用相同證據模型。
驗收：從已保存事件開啟內容，實際核對 bytes/附件；零長度與讀取錯誤不同；原始事件始終可達。高優先資訊不藏入進階區。
追蹤：#546、#550、#542。

### 2.5 HTTP 接入與 HTTP 歷程
已核對 HttpCaptureStep：已有 own/capture browser 路徑、CA 指紋、驗證歷史、HTTPS 檢查、逾時原因、重試。因此不另建驗證中心。
提案：BrowserPage/首次啟動入口共用相同驗證結果與狀態語意，驗證成功可直達對應 HTTP 紀錄；CA/代理/客戶端變更後失效狀態必須可見。
借鑑 HTTP Toolkit 的客戶端來源接入、mitmproxy flow → request/response/detail 的分層閱讀。此次讀取的是 mitmproxy 終端 UI 官方教程，不能把它當作已檢查 mitmweb 視覺畫面。
HTTP 歷程的「列表選取是否在持續流量下跳動、request/response 切換是否保留位置」列為待實測，不宣稱已發現缺陷。
驗收：從實際客戶端發 HTTPS → 正確專案保存 → 開啟該交換 → 檢查內容；服務 running 不等於 HTTPS verified，更不表示所有應用流量都已涵蓋。
追蹤：#289、#293、#435。

### 2.6 指令與終端
借鑑 VS Code Shell Integration 的命令邊界、退出狀態與命令導航。接入後應能跑一個可辨識測試命令並跳到其輸入、輸出與結果，而非只顯示 hook 檔案存在。
此頁本輪未完整審閱，使用 #434/#550 既有證據規劃，不提出新的確定缺陷。
驗收：Bash/Zsh/PowerShell 分別驗證命令、stdout、stderr、exit code；無法擷取輸出時保留明確降級。先辨識平台/環境限制，再判斷產品 bug。
追蹤：#434、#550、#288。

### 2.7 首次啟動
已核對 FirstRunView：更多來源已收合，內建終端按需展開；不能把漸進揭露當尚未完成的新功能。
提案：沿「建立專案 → 主要 Shell → 實際紀錄 → 進入工作區」驗收；來源準備失敗提供可恢復路徑，不因可選 HTTP/AI 阻擋其餘工作。
GitHub Desktop 的官方入門是安裝/認證/設定/專案操作順序；REDLOG 的 task-first 精簡是本提案推導，非直接複製其現行畫面。
量測首次到可操作時間、第一筆可閱讀紀錄時間、離開再進入是否保留進度；沒有量測前不宣稱載入效能有缺陷。
追蹤：#317、#457。

### 2.8 匯出與交付
#436 已記錄單一 ExportPlan、完成結果保留、每專案最近成功匯出及 Mac 重啟恢復驗證；不重做。
提案：補齊不同入口範圍承接、Windows/Linux 與產物實際驗證；取消/失敗不得覆蓋最近成功結果。將這條成功模式沿用至插件變更：操作結果可回查，不只一閃即逝的 toast。
驗收：選範圍 → 預覽 → 匯出 → 找到檔案 → 打開驗證；頁面筆數不代替完整查詢範圍。
追蹤：#436、#457。

### 2.9 逐字稿入口
#563 已描述獨立 transcript 與 io/ai reader 的重疊；本輪不直接刪除能力。
建議先確認是否存在跨來源合併閱讀的獨有用途。若無，將舊入口導向活動紀錄適當讀法，更新命令面板與測試；若有，保留為既有閱讀模式，避免再增加一級頁。
驗收：常用任務有可見入口，舊命令不失效或有可理解替代；測試中的 fixme 有實際決策後才移除。
追蹤：#563、#558。

## 3. 交付與驗證策略
1. 先統一安裝/註冊/運行/已收到證據語意，修內容讀取契約。
2. 插件 A/B 與來源定位同期整合。
3. Session 搜尋及前後事件導航各為獨立小批次。
4. 完成跨頁 QA，再決定 Inspector 密度、Timeline 一級導航與其他視覺改造。
每批使用既有元件、i18n、tokens、密度；無需求不加 helper line/tooltip/巢狀卡片。
測試桌面、最小支援視窗、較大字級、鍵盤；如有行動網頁交付再補手機真機，不把桌面窄視窗冒充手機支援。
每條路徑都涵蓋載入/空/失敗/取消/重試；必要時測試來源切換、專案切換與快速連續操作。
測試驗證真正的目的地、記錄內容與產物；不能只斷言按鈕存在或頁面開得起來。
本輪沒有跑應用程式、量測性能或完成視覺 QA；以上待實測項目須在實作前補基線。

## 4. 原始資料與參考
程式基準：[REDLOG f51037e](https://github.com/guan4tou2/REDLOG/tree/f51037e07c3b6fe199338769eb809d1830dfda40)。
本輪讀取：PluginsPanel、official-agents、manifest、trust、CaptureControlPage、RecordingWorkspace、SourceSessionPicker、Sidebar、HttpCaptureStep、FirstRunView、AGENTS、CLAUDE、UIUX-STANDARD；其他頁面標示為 issue 證據或待驗證。
- [HTTP Toolkit Intercept](https://httptoolkit.com/docs/reference/intercept-page/)
- [Kibana Discover](https://www.elastic.co/docs/explore-analyze/discover)
- [Jaeger UI configuration](https://www.jaegertracing.io/docs/2.22/deployment/frontend-ui/)
- [Grafana trace correlations](https://grafana.com/docs/grafana/latest/datasources/tempo/configure-tempo-data-source/trace-correlations/)
- [VS Code Shell Integration](https://code.visualstudio.com/docs/terminal/shell-integration)
- [Sentry Issue Details](https://sentry.io/changelog/new-issue-details-ui-now-available/)
- [mitmproxy UI tutorial](https://docs.mitmproxy.org/stable/mitmproxytutorial-userinterface/)
- [GitHub Desktop getting started](https://docs.github.com/en/desktop/overview/getting-started-with-github-desktop)
上述為互動設計參考，不引入其品牌、技術堆疊或完整功能範圍。

