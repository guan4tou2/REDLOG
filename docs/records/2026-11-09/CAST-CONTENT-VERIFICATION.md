# Cast 內容讀取驗收

基底 main `3e455574`。cast 的固定位元組範圍經非同步讀取後，投影到最多八個快取檔案。來源與事件保持原樣。文字保留 ANSI 與 UTF-8 位元組；UI 標為合併的終端輸出。來源或投影變更後，舊版本不可沿用。分段缺失、非法路徑與讀取失敗回傳可辨識的錯誤。

通用內容 API 的同步讀取核心保留；IPC 在分頁、搜尋、複製、另存與內容定位前準備投影，並在準備後重檢專案。另存逐窗重新核對可用性。已完成 2 MB、第二 MiB 搜尋、分段輪轉、UTF-8 邊界、ANSI、來源變更、缺檔與非法路徑的測試。38 項相關核心／IPC 測試及 Electron cast Reader、HTTP Reader 兩項流程通過。另存檔與預期輸出逐位元組相同。

實際 mitmdump 12.3.1 的跨專案隔離案例通過；另外兩個 queue/gap 案例與三個官方 AI 擷取案例通過。跨專案案例原受 6661 被既有 mitmdump 使用而失敗，fixture 改用正式 config.save 指定獨立埠後通過，未終止既有代理。

Kali arm64 使用系統 Bash／Python 比對 ls、ls -al、2 MB 輸出及非零結束碼／stderr，結果見 kali-output-results.jsonl。2 MB 的 terminal 輸出逐位元組相符，預設 relay cap 下的證據完整性如實標為 truncated。此案例未啟動 Linux Electron。

Windows 安裝 smoke 工作新增既有 PowerShell 5.1／7 原生 profile 矩陣，要求兩個 edition 都存在。[Windows 安裝驗收工作](https://github.com/guan4tou2/REDLOG/actions/runs/42570348305/job/129006053574) 已成功：安裝包 smoke 1 passed、兩個 edition 的原生 profile／指令配對／結束碼／Redlog-Run stdout 與 stderr 矩陣 1 passed，並完成解除安裝與 profile 清理。這是 Windows CI runner 上的原生驗證，不包含 WSL 或人工 DPI 操作。

完整本機 unit 的首次執行有 5916 passed／4 failed／41 skipped，其中一項同步 IPC 測試已改為等待非同步結果並通過複驗。其餘三項已定位為測試環境問題：relay 測試未隔離個人 home，背景 sender 測試在請求開始前以 0 ≥ 0 提早結束。修正測試隔離及等待條件後，相關 12 項測試全部通過；依序重跑 typecheck、spec、architecture、i18n 與完整 unit 後，結果為 **5920 passed／41 skipped，0 failed**。
