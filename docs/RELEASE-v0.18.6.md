# RedLog v0.18.6

本版是正式版，取代 v0.18.3 成為目前的下載版本。v0.18.4 與 v0.18.5 兩個預發行版本的內容都包含在內，
修正與改善的完整列表見 CHANGELOG。

## 安裝

- Windows x64：`RedLog.Setup.0.18.6.exe`。
- Kali／Debian／Ubuntu x64：`redlog_0.18.6_amd64.deb`，以 `sudo apt install ./redlog_0.18.6_amd64.deb` 安裝。
- macOS Apple Silicon：`RedLog-0.18.6-arm64.dmg`，拖入 Applications。
- 每份安裝包都列在 `SHA256SUMS.txt`。安裝前請先核對。
- 從舊版升級：直接執行新的安裝包即可，專案資料會保留。Windows 版的應用程式內更新也會提供本版。

## 本版修正

- **PowerShell 的結束碼**：原生指令之後失敗的 cmdlet，不會再沿用前一個原生指令的結束碼。
- **WSL**：
  - 以管線把指令送進互動式 bash 時，hook 載入期間不會再把整段輸入吃掉。
  - NAT networking 下，WSL 連不到 RedLog 的 API，事件改由暫存檔送達，最多約延遲 30 秒。建議使用 mirrored networking。
- **長時間串流**：
  - WebSocket 與 TCP 串流不再讓 mitmdump 的記憶體無限成長。
  - TCP 串流會記錄連線結束，以及是正常關閉還是中斷。
  - 超過擷取上限而被截斷的內容，會註明「已存 10.0 MB／共 16.0 MB」，或「總長未知」。
- **當機後的終端錄影**：
  - 程式異常結束後，復原的錄影會列出已存檔的片段與雜湊。
  - 當時還在執行的指令會標示為「中斷」，不再一直停在執行中。
  - 匯出預覽會顯示被中斷的錄影與指令數量。已結束的終端分頁也會標示錄影的狀況。
- **長時間錄影的記憶體**：
  - 每個指令結束時不再重讀跳板清單，避免記憶體隨指令數成長。
  - 已關閉的通道，之後無論再執行多少指令都不會重新出現。
- **Windows 升級**：安裝包不再帶 MSBuild 的中間檔，安裝在很深的資料夾時升級也不會失敗。

## 驗證與限制

- CI（Windows、macOS、Ubuntu）全數通過，包含以真實 mitmdump 跑的擷取驗收。
- 已在真實環境驗收：
  - Windows 安裝、從 v0.18.4 升級與移除；
  - Kali（WSL2）`dpkg -i` 安裝與移除；
  - PowerShell 5.1／7 實際 profile 的矩陣；
  - WSL mirrored 與 NAT；
  - 2 小時的 SSE／WebSocket 長時間擷取；
  - 60 分鐘的終端錄影長測。
- **未驗證**：
  - macOS DMG 的實機安裝；
  - 原生（非 WSL）的 Kali 桌面環境；
  - 8 小時以上的終端錄影。
- **已知遺失**：強制結束代理時，最多 64 筆已進入佇列、尚未送達的事件，以及最後約一秒內被拒收的計數，可能遺失且沒有紀錄。
- 安裝包未簽章：Windows 可能出現 SmartScreen（「其他資訊 → 仍要執行」），macOS 可能被 Gatekeeper 阻擋。

詳細變更見 CHANGELOG。
