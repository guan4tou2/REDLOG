# RedLog v0.18.4（內測預發行）

本版為內測用的預發行版本，不是正式版。正式下載仍以 v0.18.3 為準。

## 安裝

- Windows x64：`RedLog.Setup.0.18.4.exe`。
- Kali／Debian／Ubuntu x64：`redlog_0.18.4_amd64.deb`，以 `sudo apt install ./redlog_0.18.4_amd64.deb` 安裝。
- macOS Apple Silicon：`RedLog-0.18.4-arm64.dmg`，拖入 Applications。
- 每份安裝包都列在 `SHA256SUMS.txt`。安裝前請先核對。
- 內測流程、升級、結束與移除方式見 `docs/INTERNAL-TESTING.md`。

## 主要改善

- **Windows 解除安裝會移除接入**：PowerShell profile 與各 WSL 發行版 rc 中 RedLog 的那一行會一併拿掉；升級不會。專案資料仍保留，需要時自行刪除 `%USERPROFILE%\.redlog` 與 `%APPDATA%\redlog`。
- **主視窗**：在不繪製隱藏視窗的顯示環境上，非最大化啟動不會再一直隱藏。
- **升級後 hook**：啟動時會把已接入 shell 的 hook 副本更新為新版；升級前已開著的終端分頁仍需重開。
- **PowerShell**：同一道指令的開始與結束正確配對。
- **WSL**：rc 指向其他安裝位置時不再顯示「已安裝」，重新安裝會改正。
- **WSL 來源選擇**：發行版裡留有舊 `~/.redlog` 時，只有它的 token 仍被接受才會沿用；token 已失效就改用 Windows profile。之前只要該目錄的 port 有回應（mirrored networking 下那個 port 就是 Windows App）就採用它，事件因此全數 spool 到沒有人讀取的目錄。
- **Git Bash**：hook 改由 stdin 送出事件內容，Windows 上的 curl 不再需要解析 MSYS 路徑。設定 `MSYS_NO_PATHCONV=1` 時，指令不再延遲約 30 秒才入庫。
- **Windows 介面**：系統匣選單跟隨 App 語言；HUD 與設定改稱系統匣與 Ctrl+Shift+P；結束確認改為一般按鈕。
- 搜尋涵蓋已保存的文字附件與已確認的 AI 紀錄前段；另存內容讀取、匯出與導覽的整理見 CHANGELOG。

## 驗證與限制

- Windows：本機實裝驗收涵蓋安裝、PowerShell 接入、閱讀模式、設定、125% 縮放、結束、升級與解除安裝；CI 在乾淨機器上跑安裝、首次啟動、主視窗顯示、記錄／匯出／重啟與解除安裝。
- 未驗證：Windows 上的 HTTP 擷取與 PowerShell 輸出擷取、AI 工具擷取、100%／150%／200% 縮放、macOS 與 Kali 安裝包的實機驗收。
- 未驗證：WSL 來源選擇與 Git Bash 的實際送出。兩項修復在本版只有單元／整合測試，尚未在真實 WSL 發行版與 Windows Git Bash 上驗收。
- 安裝包未簽章：Windows 可能出現 SmartScreen（「其他資訊 → 仍要執行」），macOS 可能被 Gatekeeper 阻擋。

詳細變更見 CHANGELOG。
