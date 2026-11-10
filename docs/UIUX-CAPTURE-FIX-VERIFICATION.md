# 擷取閱讀與驗證入口修正

> 遠端同步校正（2026-11-04）：本文件原檢查基準為 f51037e0。同步時遠端 main 已為 eaa40e46（PR #567），Spec 065 插件 A 批次搜尋、需處理與列表/詳情已合併；B/C 與完整驗收仍未完成。舊文中的「尚未實作／最新 spec 到064」是當時快照，不代表目前遠端。詳見 UIUX-SYNC-STATUS.md。

2026-11-04，本機未提交。

## 變更
- CommandEndDetail 不呈現已知空 stderr；非空內容、正 bytes、截斷訊號仍保留。
- 有 command_id 的 streamed/late output 使用自己的讀取狀態，不再同時落入一般「未擷取」提示。
- BrowserPage 將 HTTPS 驗證從收合摘要改為可見按鈕，鍵盤可開啟既有驗證流程。

## 驗證
- 10 個相關 Vitest 通過；typecheck、verify:specs、verify:architecture、verify:i18n、build 通過，diff check 通過。
- 真實 Electron HTTP 入口測試 1 passed；900×700、鍵盤 Enter 開啟/收合，截圖已查看。
- 該 GUI 環境實際顯示代理連接埠被現有 mitmdump 占用；未停止現有程序。此測試只證明驗證入口與真實錯誤流程，並非 HTTPS 成功擷取驗收。
- 隔離 HOME、400 個測試檔，直接執行產品 relay 的 ls 與 ls -al：終端輸出與 event stdout 逐 bytes 相同（6400 / 26915 bytes），兩者 exit 0、stderr 0。這是無接收端的 inline relay 路徑，不代表使用者的自動 shell、線上串流或內建 PTY 問題已修復。
- 未重跑完整 suite；上輪全套仍有未診斷完成的 shell/relay 失敗，不能稱整套全綠。

## 未完成
ls/ls -al 在使用者實際來源的差異重現、cast 文字閱讀、設定頁去重、FirstRun 效能量測、Windows Shell 真機驗證與 HTML 參考稿。
