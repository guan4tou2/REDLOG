# 安裝包人工驗收

這份清單補足自動測試碰不到的下載、桌面啟動、系統信任提示與操作摩擦。
自動測試入口見 [TESTING.md](TESTING.md)，既有結果與未測範圍見
[PACKAGED-SMOKE.md](PACKAGED-SMOKE.md)。不要把原始碼測試當成正式下載包驗收。

每次記錄版本、下載 URL、檔案 SHA-256、OS／架構、shell、工具版本與日期。
每項填 Action / Expected / Actual / Friction，以及 PASS / FAIL / NOT TESTED；
失敗保留原始輸出及畫面。未操作、被略過或前置條件不足均不算 PASS。

## 1. 下載與安裝

- [ ] 從正式 Release 下載與平台相符的安裝包，對照 SHA256SUMS.txt。
  Windows 使用 NSIS、Kali／Debian／Ubuntu x64 使用 DEB、macOS ARM 使用 DMG。
  不再驗收或提供 portable／AppImage。
- [ ] 在乾淨使用者或測試 VM 安裝，記錄所需步驟與系統提示。
  Linux 用 `sudo apt install ./redlog_<version>_amd64.deb`；Mac 拖入 Applications。
- [ ] 從開始選單／應用程式選單／Dock 啟動，記錄真實 Gatekeeper、SmartScreen
  或權限提示。從未隔離的建置目錄直接啟動不能替代這一步。
- [ ] 第一次畫面無別人的專案、來源、憑證或 hook。安裝流程不改既有個人設定。
- [ ] 分別計時「安裝開始到第一份可驗證的記錄」與「接入後 100 道指令」；
  不把後者當成前者，不把工具已預裝的環境當成缺依賴情境。

## 2. 建立專案與擷取設定

- [ ] 以名稱建立專案；在 Settings → Scope 設定測試 CIDR、exclude 和私人網域。
  目前建立卡不輸入 scope，排除是顯示／交付規則，不是停止本機記錄。
- [ ] 開啟 Capture setup。缺少相關工具時先 Prepare，再 Prove；
  完成工具安裝或按略過不能直接變成「已驗證」。
- [ ] 在隔離環境的 PATH／測試帳號模擬缺依賴，不移除主機的全域 Python／curl。
  按準備、取消、重試，確認等待時間、失敗原因與可執行的手動修復。
- [ ] 離開設定、重新整理、關閉 App，確認只清理它啟動的安裝程序，無關程序仍存活。
- [ ] 略過後從 Dashboard → Capture Health → Capture setup 重新進入；
  即使已有事件或重啟過也能找到，未驗證項目仍保持未驗證。
- [ ] 在 800×720 視窗用鍵盤完成操作，錯誤及修復按鈕不被裁切。

## 3. 指令與輸出

- [ ] 在內建終端立即輸入第一道指令，確認指令、stdout／stderr、退出碼及 cast。
  提示符先出現不能當成 hook 已接上；不能靠人工等待掩蓋第一筆遺漏。
- [ ] 安裝外部 shell hook 兩次只留一行；開新互動終端再做 canary。
  驗證結果要區分「指令有到」及「輸出有到」。
- [ ] 用普通 Zsh 執行 echo、printf、多行、stderr、失敗指令、pipeline 和 redirect，
  逐一對照終端、事件及輸出。Zsh 自動輸出有界；Bash／PowerShell 普通 hook
  主要記指令／退出資訊，輸出改測內建終端或對應明確錄製方式。
- [ ] `redlog-session` 長互動錄製、Ctrl-C、Ctrl-Z／fg、終端 resize 能恢復；
  區分 native nc 不擷取輸出與明確 PTY 錄製，不把刻意未錄當作完整輸出。
- [ ] 100 道不同指令逐筆核對數量、stdout、stderr、退出碼及重複事件。
  cap、暫停、工具失敗及離線皆須留下正確的完整性／缺口狀態。
- [ ] App 停止、恢復或重啟時 shell 仍可用；離線 spool 不覆寫、不進錯專案，
  身分不明的資料保留隔離。重啟後能找回已保存輸出。
- [ ] Windows PowerShell 與 Windows App＋原生 WSL 分開驗收；
  Linux 或模擬路徑的結果不代替原生 WSL。

## 4. HTTP／HTTPS

- [ ] App 準備並啟動自己的代理；程序存在或埠有 listener 不足以顯示 running。
  遇到外來 listener／啟動失敗有明確原因與 retry，不終止外來程序。
- [ ] 從受管瀏覽器或明確設好的終端送出真正測試請求，核對 request、response、
  status、headers、body 與 flow_id。開代理不代表所有工具或所有協定會自動經過它。
- [ ] HTTP、HTTPS 各完成本次 nonce 驗證；略過憑證錯誤不算信任 CA。
  測試用暫存 CA 與系統／瀏覽器信任變更分別記錄，只清理測試自己安裝的項目。
- [ ] 停止代理後狀態反映停止或失敗；記錄既有終端仍帶代理環境時的實際限制。

## 5. 證據交付與隔離

- [ ] 截圖、拖入檔案、標記均能找到原始附件，空截圖不當成有效證據。
- [ ] 兩個專案／多個 pane 同時有工作：切換後 PID／cwd／輸出仍存在，
  錄製片段與附件各屬自己的專案；停止一個 pane 不停止另一個。
- [ ] 套用時間／目標／類型等篩選後預覽並匯出，核對實際事件、數量及逐檔附件。
  預覽後修改附件不得悄悄交付不同內容。
- [ ] 包含 loopback／scope／私人內容排除的交付副本，以隨包 verifier 驗證。
  正常投影要明說省略及驗證邊界；修改一列或附件必須報錯。
- [ ] 重啟 App 仍能搜尋記錄、讀輸出及再次匯出。卸載測試 hook 後恢復自己的
  profile；移除測試安裝，但不要把刪除使用者證據當成卸載通過條件。

## 結果

每平台獨立列結果與剩餘摩擦，不設「全部已完成」的預填勾選。
原生 WSL、完整人工 Kali quickstart／首次安裝計時，以及 Mac 真正 quarantine
下載／Dock／Developer ID／公證，在沒有新證據前仍是未完成的驗收或發布限制。
