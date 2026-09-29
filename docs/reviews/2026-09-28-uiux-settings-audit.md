# UI／UX 與設定流程實測（2026-09-28）

基準：`codex/evidence-workflow-completion`，`623f5b6`。使用本機 macOS ARM64 unsigned packaged App（介面版本 0.18.0）、隔離 HOME、新建測試專案，沒有修改既有使用者專案。本次為檢查，稽核當時未修改產品程式；後續修正紀錄見文末。

## 結論

已有統一視覺規範與部分共用元件；尚未做到操作流程、跨頁狀態與設定語意全部一致。優先修正可重現的流程缺陷，再簡化設定；不需要重新設計整套 UI。

## 實際走過的流程

- 從專案選擇頁填名稱、scope、exclude，按 Create。
- 新建後觀察首次引導，重新載入對照。
- 內建終端輸入安全的 printf，看到 command start/end、exit 0 與 Commands Verified。
- 設定四組十頁中的命令、瀏覽器、擷取、範圍、外觀；搜尋 JPEG 能定位到欄位。
- 800 × 850 窄視窗檢查 browser／scope／general；所測 view-root 沒有水平溢出，但雙側欄壓縮閱讀空間。
- 新增 scope 後立即回專案清單、重新開啟；後端 config 保留新增值與原 exclude。
- Timeline → Export → Everything → 預覽 → 確認，收到匯出成功。此處僅驗證操作完成，不代表本次重新逐檔驗證匯出內容或全部篩選語意。
- 設定頁保持開啟，從上方啟動／停止本機 HTTP 代理，對照後端狀態。

初次終端測試受隔離 HOME 的 zsh-newuser-install 攔截，不能算成功；第二次以空白 .zshrc fixture 排除環境因素後，確認指令成功與 Verified。沒有隱藏這個測試差異。

## 必須修正：實際重現

### P1：直接建立專案沒有進首次引導

兩次從 Create 進入，都停在一般 Dashboard；首次引導元素不存在。重新載入後，同一專案立即出現首次引導。第一次曾等待 30 秒，第二次等待 3 秒，排除單純畫面短暫切換。

程式依據：`src/renderer/src/hooks/useVisibility.ts` 初始 signals 僅在 mount 讀取，沒有隨 project identity 重新取得／重設；`App.tsx` 的 onProjectOpen 只更新 project 與 view。應以 project identity 控制 signals 與首次引導生命週期，並忽略前一專案的延遲回覆。

驗收：從真正的 Create 入口、不 reload、不使用 bridge 建立後再 reload 的 helper，新專案即出現引導；另測成熟專案切換至新專案。

### P1：HTTP 設定頁顯示過期狀態

先進 Browser & HTTP capture，再從頂部 Start HTTP capture 啟動。頂部已變成 Stop HTTP capture；後端 `state=running`、`certReady=true`，設定頁仍顯示 HTTP capture stopped 與 Start。等待後仍不更新。

程式依據：`components/settings/BrowserPanel.tsx` 只在 mount 取得 status，其他位置則更新自己的狀態。讀取失敗也被吞掉，初始 stopped 可能被誤當事實。

建議：共用代理狀態來源與 start/stop action；各 surface 同步呈現 starting/running/stopped/failed，讀取失敗呈現未知／重試。驗收涵蓋跨入口 start/stop、代理退出、IPC 失敗。

### P2：儲存說明與唯讀欄位矛盾

設定底部仍說「變更任務／操作員 ID 需重開專案」，但 engagement ID 已是建立後唯讀。繁中與英文都有這段。應明確列出可改且需重開的項目，不再暗示 engagement ID 可修改。

依據：`i18n/zh-TW.json` 的 `settings.autoSaveHint`，`Settings.tsx` 底部及 GeneralPage。

## 設計改善：不應混稱為程式故障

### 設定先呈現操作，再揭露細節

Browser 頁先顯示 binary、proxy URI、port、listen address，啟動狀態與驗證在後面。窄視窗雙側欄讓主要操作更遠。建議頁首先放啟動／狀態、開啟瀏覽器、終端導流與 HTTPS 驗證；binary／bind／CDP／profile 等放進「進階」。窄視窗讓設定目錄可收合或切換，保留既有四組架構即可。

Appearance & language 同時包含專案／操作者身分及交接功能，名稱不能完整預告內容。可在既有頁中清楚分區或調整標籤，不必再增加設定頁。

### Scope 無效輸入允許略過，需更明確選擇

輸入 `10.77.0.1/99` 時 Create 仍可按，文字確實提示「無效項目不會保存」，所以不是靜默丟資料。對操作契約建議阻擋建立，或提供清楚的「略過無效項目並建立」操作，避免操作者以為整份貼入清單都已生效。

### 元件規範尚未全面落實

已有 tokens、Button／Modal／Field 等共用元件，但 ExportMenu 仍有硬編碼紅色按鈕；scope chip 刪除鈕實測約 26.4 px 高。應針對操作類別統一尺寸、顏色語意與 focus，而非要求所有原生 button 一律替換。刪除 chip 可維持小圖示、擴大可點擊區。

### 篩選到匯出仍有已知缺口

`specs/041-filtered-evidence-export/spec.md` 目前是 Draft，不能算完成。操作上匯出應承接完整查詢，而非從已載入頁面推導條件；要在預覽明示條件、數量、資料邊界。本次 Everything 成功不代表 filtered export 已正確。

### 設計文件需要區分現行契約與歷史註記

`docs/UIUX-STANDARD.md` 存在且涵蓋色彩、字級、密度、按鈕、狀態、對話框、快捷鍵與漸進揭露。但基準仍寫 v0.14.3，混有歷史「已實作」表，與目前四組十頁不完全一致。遵循現有鏡像文件政策，以現況註記／獨立對照表更新，不直接改寫外部設計專案原文。已實作必須附對應驗證，不能只憑元件存在。

## 建議修正順序

1. 首次建立引導與 HTTP 跨頁狀態（真正操作錯誤）。
2. 儲存文案、scope 無效項目的明確操作。
3. Browser 設定基本／進階與窄視窗目錄。
4. 按鈕一致性、現況設計對照；接續既有 Spec 041，不另開重複需求。

## 驗證限制

本次沒有從網路下載安裝、沒有重跑 Gatekeeper／Windows／WSL 真機安裝，也未做手機瀏覽器測試（產品為 Electron 桌面 App）。窄桌面不等於手機支援。本次未對全部頁面注入 loading/error、未完整驗證鍵盤 focus trap／螢幕閱讀器／所有語系。HTTP 狀態測試僅啟動本機代理，沒有據此宣稱完成新一輪外部 HTTPS 流量覆蓋。

暫存重現資料：`/tmp/redlog-ux-audit/result.json`、`followup.json`、截圖及畫面文字；含測試機資訊，不作為公開 issue 附件直接上傳。


## 同日修正與驗證

本節是稽核後的修正，不回寫抹除當時重現的缺陷。

- 兩項 P1 已修正：visibility snapshot 與首次引導綁定專案，初始及 batch 查詢會忽略失效回覆；工具列與 Browser Settings 使用共用 HTTP status hook，操作後通知刷新並輪詢外部變更，讀取失敗顯示未知與重試，start/stop rejection 不再卡住操作。
- P2 儲存說明已移除「可變更 engagement ID」暗示，保留 operator ID 的重新開啟提示。
- 使用者要求的測試整理：舊且未隔離 HOME 的 smoke 已刪除，標題檢查併入 project-flow；HUD 永久 skip 的 >720px 舊策略改成現行寬度上限下的可讀性驗證；更新入口與 CI 文件。
- TDD：visibility 2 項與 Browser Settings 前 2 項測試先失敗再通過；另補 start rejection/retry。
- 聚焦 Vitest 6 files／52 tests 通過。Electron 6 files／16 scenarios 全部驗證通過（第一次 15 過、1 項 selector 同時匹配通知與設定，限縮至設定容器後單獨重跑通過）。直接 Create 不 reload；HTTP 頂部啟動、設定停止雙向同步；窄視窗／匯出／保存驗證均涵蓋。
- 完整 Vitest：289 files passed／1 skipped，2904 tests passed／11 skipped；平台與 opt-in 跳過案例未當成通過。
- typecheck、build、architecture、Spec Kit gate 通過。現有 Spec 041 仍是 Draft，沒有把本輪 bug fixes 當成篩選匯出已完成。
- 已對 GitHub API 核對 v0.18.0 是公開 Release 且附各平台安裝包，發布時間為 2026-09-27 01:34 +08:00；CHANGELOG 的未發布註記已修正。此次程式修復屬 Unreleased，不在舊安裝包內。

設定基本／進階重排、scope 無效輸入決策、整體元件一致性，以及三平台安裝驗收仍是原列建議，沒有因兩項 P1 修好而宣稱全部設計已完成。
