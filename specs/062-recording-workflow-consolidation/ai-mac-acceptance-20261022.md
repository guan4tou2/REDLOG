# AI 擷取插件：Mac 原生操作驗收

日期：2026-10-22。候選程式對應 `c15f2186`；本輪沒有修改產品程式碼。使用原生視窗逐步點選及鍵盤操作，沒有以 Playwright 代替這次人工流程；合成來源準備、SQLite 唯讀核對及檔案雜湊另由本機檢查完成。

## 環境與隔離

- macOS 27.0.1 / 26A434，arm64。
- 候選：`/private/tmp/redlog-ai-capture-20261022-dist/mac-arm64/RedLog.app`，0.18.3 / Electron 44.4.1。
- `app.asar` SHA-256：`aa5e8b33ccc4ab631b45b6fbd296bad4f4ccae1fd0e9c356153671172613cc5c`。
- 隔離 HOME：`/private/tmp/redlog-ai-native-20261022/home`；獨立 Chromium profile；沒有開啟真實專案或私人 AI 對話。
- 新建專案 `AI-Native-Acceptance`；允許目錄 `client-work`，另一個 `private-work` 不授權。兩個 Codex JSONL 來源均為合成資料，建立於啟用之前。
- 此為乾淨設定檔的 **packaged .app** 操作驗收，沒有重新執行 DMG 安裝、Gatekeeper、公證或其他平台安裝驗收。

## 實際步驟與結果

| 操作 | 實際結果 |
|---|---|
| 建立專案，進入「設定 → 擷取來源 → AI 代理」 | Claude Code、Codex、OpenCode 三列均顯示未安裝。HUD 依預設出現；為操作主視窗而手動隱藏。 |
| 只按 Codex「安裝擷取插件」 | Codex 顯示已安裝；另外兩項仍未安裝。無工作目錄時，記錄 checkbox disabled 且未勾選。 |
| 按「加入工作目錄…」 | 真正開啟 macOS 資料夾選擇器。以「前往資料夾」選取隔離 `client-work`，選定後顯示路徑，自動儲存成功；沒有自行勾選記錄。 |
| 明確勾選「在此專案記錄新對話」 | 保存啟用設定，資料庫出現 `transcript_capture_started`；未自動匯入既有對話。 |
| 追加合成新 prompt、tool input、tool output；另對 private-work 追加未授權內容 | 新 prompt / tool_call / tool_result 確實保存。用原生搜尋操作找到工具輸出；未授權內容搜尋顯示沒有結果。SQLite/sidecar 同時確認沒有舊歷史及 private-work sentinel。這些是來源報告的工具輸入／輸出，並未真的執行其中的命令。 |
| 離開設定，返回同一來源頁 | 已選目錄及啟用狀態保留。 |
| 以 Tab 到達開關，Space 停用 | checkbox 變為未勾選；讀回專案設定確認 enabled=false，再追加新內容。該內容沒有出現在事件或 sidecar。 |
| 按「解除安裝插件」 | 回到未安裝狀態；managed plugin 目錄移除。已記錄內容仍在，sidecar SHA-256 完全不變。 |
| 再次安裝 Codex | 工作目錄仍保留，但記錄沒有自動開啟。實際安裝 receipt 與原專案 receipt 不同；追加內容仍未保存。 |
| 清理本次擷取整合並正常結束 | 再次解除安裝，按正常退出並確認「停止並結束」。受管代理隨 App 結束，程序 exit 0；證據保留。 |

Sidecar 在停用、兩次解除安裝及重裝後均為：

`3bb08bf98a0abd1538b85bb68b7e39f805f7e19ff3f3e57f1f66d2574d71ff69`

最終唯讀核對：新 prompt、工具輸入／輸出存在；舊歷史、private-work、停用後、重裝但未啟用的五類 sentinel 均不存在。檢查只使用本次隔離目錄。

## 收斂與限制

- Mac 原生 AI 安裝／選目錄／明確啟用／停用／卸載／重裝流程通過。T019 的 Mac packaged-candidate 人工部分完成；T007 的安裝與專案授權實作切片完成。
- 「未安裝零讀取」的實際檔案存取觀察，來自前一輪 packaged Electron instrumentation；本輪人工 SQLite 空結果沒有被拿來冒充零讀取證明。
- 發現文件把入口寫成「Other sources／其他來源」，但目前實際選單是「Capture sources／擷取來源」；本輪將相關文件對齊，沒有另改設定導覽。
- 未實測的內容仍保留：Windows/Linux 原生安裝、其他工具／版本的原生捕捉矩陣、macOS DMG 重裝與公證，以及完整 062 的其餘故事驗收。完整跨平台矩陣沒有因此全標 PASS，Spec 062 維持 Draft。
