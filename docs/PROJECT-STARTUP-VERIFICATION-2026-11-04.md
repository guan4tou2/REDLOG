# 專案啟動畫面驗證

> 遠端同步校正（2026-11-04）：本文件原檢查基準為 f51037e0。同步時遠端 main 已為 eaa40e46（PR #567），Spec 065 插件 A 批次搜尋、需處理與列表/詳情已合併；B/C 與完整驗收仍未完成。舊文中的「尚未實作／最新 spec 到064」是當時快照，不代表目前遠端。詳見 UIUX-SYNC-STATUS.md。

日期：2026-11-04。環境：macOS arm64、Node 26.13.0、repo lockfile 依賴、Electron 44.4.1。測試使用隔離 temporary HOME，未寫入使用者實際專案。

## 結果

- `npm run typecheck`、`verify:specs`、`verify:architecture`、`verify:i18n` 依 CLAUDE.md 順序通過；最終 `git diff --check` 通過。
- `npm run build` 通過；只見既有 renderer browser-externalization 提示。
- picker 三組、profile resolver、UI copy、buttons、truncation 相關測試通過。名稱欄位另加入 IME guard；`isComposing`／229 選字 Enter 不建立，結束後 Enter 才建立，focused create-card 21/21 通過。
- 真實 Electron GUI：`profile-import` 8、`project-flow` 3、`project-rename` 1、`scope-entry` 1 皆通過；新增 `project-startup` 1 修正測試假設後通過，共 14 cases。
- 完整 unit 最終：496 files passed、8 skipped、2 failed；5479 tests passed、41 skipped、3 failed（5523 total）。完整 suite 非綠；剩餘失敗在未修改的 shell/relay 測試。IME guard 在該次 full suite 收集 create-card 後才完成，因此另以 focused 21/21 驗證。

## 已實際走過的流程

- 由 New Project 按鈕按 Enter 開啟 Modal，名稱取得焦點；Shift+Tab 回到最後一個可操作按鈕，Escape 關閉並返回來源焦點。
- 名稱輸入後取消，再開啟仍保留草稿；按 Enter 真實建立，進入既有 dashboard，核對磁碟專案列表只有一筆。
- 真實最近列表搜尋無結果，再改回名稱找到專案；原生按鈕以鍵盤再次開啟。
- 主視窗要求縮至 760×600，Electron 最小寬度限制後約 800×600；以 125% 介面倍率（產品 CSS zoom 1.125）檢查列表無水平溢出，建立 Modal 與 Cancel 保持可達。截圖已實際查看。
- 關閉整個 app 再用同一隔離 HOME 啟動；依既有行為回最近列表，重新開啟後 ID、path 與名稱均一致。未新增「啟動自動開啟上次專案」行為。
- profile 匯入替換、重複匯入、JSON/YAML、false 與空清單、排除項目、清除、語法錯誤、欄位類型錯誤、未知結構、檔案不存在與取消；核對建立後 config，關閉再開啟仍保持。
- 真實匯入測試僅替換 Electron native file picker 回覆路徑；IPC、讀檔、parser、建立與儲存均走產品實作。未宣稱驗證原生檔案選擇器本身。

## 限制與執行紀錄

- 完整 unit 首輪 495 files passed、8 skipped、3 failed。兩項本次靜態檢查（同檔兩個 primary、截斷名稱未提供 title）已修正並隔離通過。
- 未修改的 `test/relay-contract.test.ts`：最終完整及隔離都失敗 2 assertions，隔離 5/7 通過；首輪完整則 7/7 通過。現象為 event 的 stdout/stderr 不存在，而既有 relay 在 streaming 時會省略這些欄位；原因未完整診斷，不能據此宣稱已確認是 flake。
- 未修改的 `test/shell-token-not-in-argv.test.ts` 中 standalone sender case，完整及隔離都出現 `nothing was recorded, so nothing was checked`。其背景送出等待條件容許 done=0、argv=0 提早結束，可能是測試同步問題；本輪未修改 shell/hook 邏輯，不宣稱整套全綠。
- 第一次在受限執行環境跑完整 unit，既有本機 server/PTY 測試初始化失敗或卡住，已停止並切換可用本機埠/PTY 的執行環境；依 repo 指示，Electron GUI 全部在允許原生啟動的環境執行。
- 沒有執行完整全專案 e2e 或正式安裝包 smoke；本輪範圍為啟動與專案建立／開啟。未驗證 Windows/Linux GUI，未聲稱手機 App 支援。
- 既有 API 沒有任意本機資料夾開啟；本輪沒有新增 API、假按鈕或專案搬移。
- 截圖位於 workspace `artifacts/project-startup-2026-11-04/`，不把生成 QA 圖片加入產品提交。
- 未 commit、push、merge 或部署。
