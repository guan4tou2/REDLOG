# UI/UX 與 HTML 復刻同步驗證

基準：本機 e176777a 加工作區變更。沒有提交、推送或合併遠端 main。

## 本輪完成

- 獨立時間軸加入主導航，保留既有 1–6 與 9 的快捷鍵；時間軸選中不再誤亮活動紀錄。
- 設定頁桌面與窄視窗共用單欄內容、上方分類選單及搜尋；保存、錯誤重試及來源授權沿用原邏輯。
- 更新依賴舊設定導航的 e2e，增加真實 Electron 分類與時間軸導航驗證。
- HTML 復刻讀取正式主題、內嵌相同字型，對齊文字下限、狀態色、按鈕前景及側欄寬度；修正窄螢幕抽屜標題／操作重疊。

## 驗證證據

- typecheck、verify:specs、verify:architecture、verify:i18n、正式 build 通過。
- settings IA、autosave、sidebar numbering、shortcuts、palette、copy：57 項通過。
- Capture Health／資料庫查詢計畫：10 項通過。既有程式已有 discriminator 索引，不依舊稽核數字加入新的快取。
- Electron：活動本文搜尋、上下筆、標記保存、事件定位；HTTP 驗證入口；主導航；設定中英文與 100/150/200% 字級、外部 terminal 限制保存、錯誤重試、AI 整合恢復與專案授權通過。
- 獨立 transcript 入口測試仍為既有 fixme，未計入通過。
- HTML：六種 Reader、命中導航、十欄示例摘要匯出、時間軸及 390px 窄螢幕；未註冊來源及不可信呈現資料回歸通過。
- 實際截圖：工作區 `artifacts/ui-consistency/`，包含 React 設定、時間軸以及 HTML 桌面／手機寬度。HTML 檢查另外記錄實際 computed tokens。

## 邊界與未完成工作

- HTML 是示例資料原型，十欄活動摘要不是正式證據匯出格式。原型不等於完整 React 應用的所有頁面。
- 未重新完成 Windows 安裝版／PowerShell、跨平台實機，以及 20 萬筆專案的端到端效能測量；查詢計畫通過不能替代載入時間與畫面流暢度測量。
- 本輪未重跑全部單元測試。先前完整測試仍有 4 項 Shell 測試失敗，不宣稱整體測試全綠。
- 工作區有先前尚未提交的專案啟動、來源管理及規範修改，保留原內容。HTML 在 implementation Git repo 外，需另行納入交付／版本管理才能隨 repo 推送。

## 設定首頁與最新設計整合補充

本機後續已完成設定首頁（三個分組）、12 個子頁入口及返回首頁，保留搜尋、深層連結、自動保存與錯誤重試；此前「僅上方分類選單」的限制已解除。初始設置改為固定單欄，1600px 寬視窗實測 HTTP 區塊位於指令區塊下方。專案選擇與建立視窗的背景、邊線、主要按鈕改用正式 design tokens。

- 相關 7 個單元測試檔案共 83 項通過。
- 活動閱讀、設定互動、專案啟動及首頁導航 10 項 Electron 測試通過；另補驗初始設置垂直布局通過。
- typecheck、specs、architecture、i18n 與 build 通過。
- `design-reference/redlog-settings.html` 與 `redlog-startup.html` 由 Electron 實際 DOM 快照和正式 build CSS／字型產生；設定含首頁與 12 子頁。離線版僅開放導航，資料為測試快照，真實寫入／擷取／驗證控制停用。桌面1360px與手機390px導航、溢出及頁面錯誤檢查通過。
- 三份新的 Stitch 原稿保存於 `design-reference/stitch-originals/`，與整合後版本分開，不採用其定時器假成功狀態。

此輪無需另請 Stitch 設計。仍以本機工作區成果為準，未提交／推送，未宣稱遠端 main、Windows 或完整 HTTPS 實機測試已完成。

## Transcript Session 一致性修正

附件是 AI Transcript 視覺參考，不作為插件頁驗收。正式程式保留共用 Transcript 與全域匯出，未移植原型的固定 Markdown、模擬驗證、監聽宣稱或額外 Export Modal。

修正兩個正式程式缺口：外部 Session 查詢不再等待 300ms debounce 才生效，首個請求即限定來源；各閱讀分頁保留自己的 Session 條件，切換來源／Session 時重建 Reader 狀態並使舊非同步讀取失效。相同 Session 的分頁切換仍保留閱讀實例。

驗證：29 項相關測試通過；Electron 建立 Claude Code／Codex 兩組 Session，刻意共用 tool_use_id，驗證反覆切換、Markdown、保存工具結果搜尋及返回分頁均沒有跨 Session 內容。typecheck、specs、architecture、i18n、build 通過。

HTML `redlog-transcript.html` 由上述實際 React 測試快照產生，能切換兩個示例 Session；1360px／390px 操作、內容隔離與溢出檢查通過。離線複製／寫入停用，不代表真實擷取程序。原稿留在 stitch-originals。

限制：此輪沒有新增遮蔽政策或宣稱完成所有敏感資料通道稽核；沿用既有內容服務與複製規則。Markdown 仍是目前已載入／篩選的區塊，既有截斷與部分內容提示保留，不宣稱全 Session 完整匯出。插件頁單欄列表／詳情仍需獨立驗收。

## 插件列表／詳情驗收

本輪將既有插件頁改為搜尋列表與單一詳情切換。版本、能力、貢獻診斷、授權和啟停控制移入詳情；列表維持名稱、描述與狀態。返回保留搜尋及焦點；空清單、搜尋無結果、讀取失敗分開呈現。加入前往既有擷取來源頁的入口，維持全域插件啟用與專案擷取設定的區分。開啟插件資料夾失敗會回報錯誤，啟用控制改用一般操作色。

驗證：42 項單元測試、9 項 Electron 流程測試通過，另重驗插件停用後 HTML 快照一致性；typecheck、specs、architecture、i18n、build 通過。Electron 以隔離專案的兩個宣告式測試插件驗證搜尋、詳情、實際停用狀態、返回焦點及來源入口。離線 HTML 的列表與詳情取自同一時點，保留真實 React 樣式，寫入／安裝停用。

這不是 Marketplace 或新的插件 API；官方 AI 整合仍由既有擷取來源入口管理。尚未新增定位到指定來源的深層連結或全新官方插件目錄；第三方執行隔離和跨平台安裝驗證不在本輪完成範圍。
