# UIUX 需求重新核對

> 遠端同步校正（2026-11-04）：本文件原檢查基準為 f51037e0。同步時遠端 main 已為 eaa40e46（PR #567），Spec 065 插件 A 批次搜尋、需處理與列表/詳情已合併；B/C 與完整驗收仍未完成。舊文中的「尚未實作／最新 spec 到064」是當時快照，不代表目前遠端。詳見 UIUX-SYNC-STATUS.md。

基準：implementation main f51037e0，加本輪尚未提交的 ProjectPicker 改善。不是使用者已安裝版本的驗證。

|需求|結果|證據與缺口|
|活動紀錄直接到時間軸|本機實際通過|view-reachability：3 passed、1 skipped；從活動標頭按鈕進入 timeline，不用命令面板。獨立 transcript 仍 skipped。|
|設定重複與來源分組|未完成|CaptureControlPage 仍依序 AgentsPanel、截圖、host monitors、ExternalCaptureGroup；新規範沒有變成產品改版。|
|首次設置混亂與慢|只局部完成|ProjectPicker 已改善，不等於 FirstRunView/來源準備完成。未量測首次載入耗時；不能判定瓶頸。|
|ls 有 stdout，ls -al 沒有|未解決確認|內容層已有 cast-recording 描述，但 cast 未作文字讀取；另有 inline、ref、streamed 多路徑。尚未實際重現這兩條命令，不能說是漏記或修好。|
|無 stderr 不顯示|仍有確定缺口|CommandEndDetail 用 typeof stderr === string，包括空字串；CollapsibleStream 顯示空標頭及空內容提示。LateOutput 則已有空字串不顯示，兩條路徑不一致。|
|列出所有 Shell 並可安裝|部分已有|HooksPanel 依偵測結果呈現來源與接入/驗證，外平台另組。尚未驗證 Windows pwsh/Windows PowerShell 多版本與真機行為。|
|Windows PS 紅按鈕含意|未確認|HooksPanel 主要接入按鈕預設 secondary；不能據此猜測使用者看到的是安裝、政策阻擋或別處主要動作。需原畫面/Windows環境。|
|HTTP 未驗證且找不到入口|入口可發現性仍有缺口|BrowserPage 的「驗證 HTTPS 擷取」在預設關閉 details；BrowserPanel 狀態、HttpCaptureStep 及 CDP 測試並置。CDP 測試連線不等於 HTTPS 擷取驗證。|

## 額外問題
- 獨立 transcript 仍沒有已通過的可見入口測試（既有 #563）。
- 串流輸出存在時仍可能進入 IoAbsenceNote：其條件未排除 output_streamed/late_output；是否實際顯示互斥訊息需資料重現。
- #568 與 Spec 062 來源管理入口需同批修訂，不能只有新文件。
- 全套 unit 仍非綠：未修改 shell-token-not-in-argv/relay-contract 有失敗，不能對整體擷取宣稱完成。

## 本次實際執行
在隔離 Electron 測試環境執行 e2e/view-reachability.spec.ts (now in e2e/app-shell.spec.ts)：六主要工作區、活動→時間軸、目標與證據分頁共3案例通過；獨立 transcript 1 skipped。
其餘為程式檢查與既有驗證紀錄，不冒充本次跨平台或真實命令擷取驗證。

## 後續優先順序
1. 真實重現 ls/ls -al 的擷取→保存→閱讀，區分 inline/ref/cast/streamed；處理空 stderr 與互斥狀態。
2. HTTP 狀態旁直接提供驗證動作，區分 CDP/HTTPS 與來源能力。
3. 來源頁分組定位、安裝與專案授權責任去重。
4. 量測 FirstRun 各段耗時，按瓶頸改善，補 Windows Shell 安裝/政策實測。

HTML 參考稿子代理用量限制中止，尚未交付；不列為已完成。
