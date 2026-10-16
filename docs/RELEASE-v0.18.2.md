# RedLog v0.18.2

本版以「安裝後能開始記錄，並能核對交付證據」為主。

v0.18.1 在 macOS 錄製回歸中被擋下，沒有發布安裝包；本版包含該輪安裝簡化及漏記修復。

## 安裝

- Windows x64：`RedLog.Setup.0.18.2.exe`。
- Kali／Debian／Ubuntu x64：`redlog_0.18.2_amd64.deb`，以 `sudo apt install ./redlog_0.18.2_amd64.deb` 安裝。
- macOS Apple Silicon：`RedLog-0.18.2-arm64.dmg`，拖入 Applications。
- 每份安裝包都列在 `SHA256SUMS.txt`。macOS ZIP 保留為配套封裝；一般安裝使用 DMG。
- 本版起不再發布 Windows portable 與 Linux AppImage。其他 Linux 發行版可從原始碼建置。

## 主要改善

- macOS 自動 Zsh 擷取會先讀完排隊的 stdout／stderr，再關閉 PTY 寫入端，避免短指令完成太快而漏記輸出。

- 擷取設定可從 Dashboard → Capture Health → Capture setup 重新進入，略過設定不會被當成已驗證。
- 缺少工具時可準備、重試或取消。慢下載有十五分鐘上限與已等待時間；離開、重新整理或關閉 App 會清理自己的安裝程序。
- 內建終端先載入擷取 hook，再接受輸入，修正第一道指令可能漏記。
- 切換專案保留執行中的終端及工作，各專案使用獨立錄製片段；停止某個 pane 也停止其原始錄影。
- 修正離線 spool 碰撞、身分歸屬與 PTY 暫時 EOF/EIO 造成的遺漏。
- HTTP 必須收到本次受管 addon 的私有就緒回應才顯示啟動。HTTP／HTTPS 仍分別以實際請求驗證。
- 篩選匯出固定選取事件與附件內容；證據包驗證器能區分交付投影與完整來源鏈。

## 驗證與限制

合併前的 Windows NSIS、Linux x64 DEB 與 macOS ARM 安裝副本已跑過記錄、輸出、匯出驗證及重啟流程；正式發版另以本標籤建置並檢查資產版本、完整性與更新資訊。

- macOS 為 ad-hoc 封裝簽章，沒有 Developer ID 或 Apple 公證；Gatekeeper 可能阻擋。Windows 可能出現 SmartScreen 提示。
- 原生 WSL、完整人工 Kali quickstart／首次安裝計時、macOS 真正 quarantine 下載／Dock 啟動尚未完成驗收；不宣稱所有平台流程已驗證。
- 外部 Zsh 可自動留下有界輸出；Bash／PowerShell 的普通 hook 主要記錄指令與退出資訊，輸出請使用已驗證的內建終端或對應錄製方式。
- 來源狀態、工具安裝成功與完整流量覆蓋是不同的事；請完成 Capture setup 的指令、輸出及 HTTP／HTTPS 驗證。

詳細變更見 CHANGELOG，驗收邊界見 `docs/PACKAGED-SMOKE.md`。
