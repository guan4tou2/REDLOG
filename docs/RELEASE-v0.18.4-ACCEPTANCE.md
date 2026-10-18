# v0.18.4 發版與內測驗收清單

範圍：macOS Apple Silicon ＋ Zsh 的內部測試。Windows、Linux 安裝包由 CI 建置與冒煙
測試；原生 WSL 不在這一輪。這份清單補的是自動測試碰不到的部分：真實下載、Gatekeeper、
Dock 啟動，以及別人第一次用會卡在哪。通用流程見 [RELEASE-SMOKE-TEST.md](RELEASE-SMOKE-TEST.md)，
發版步驟見 [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)。

每項填 PASS / FAIL / NOT TESTED 與實際看到的畫面或輸出。沒做的不算通過。

## A. 發版前（維護者）

- [ ] 本分支（版本號、README、CHANGELOG、RELEASE-v0.18.4）經確認後合併；**取得發佈授權之前不合併**，
  因為 README 已指向尚不存在的 v0.18.4 下載連結。
- [ ] 合併後 main 上五道 gate 與 CI 全綠：`npm run typecheck && npm run verify:specs &&
  npm run verify:architecture && npm run verify:i18n && npm test`。記錄實際通過與略過數。
- [ ] `CHANGELOG.md` 的 `Unreleased` 標題改為 `v0.18.4 — <日期>`。
- [ ] 在 main 的目標提交上建立**新** tag `v0.18.4`（不移動既有 tag）。release workflow 建置三平台，
  產出 NSIS、DEB、DMG、Mac ZIP、Windows 更新資訊與 `SHA256SUMS.txt`。
- [ ] Release 存在且公開；逐一下載資產核對 SHA-256；`latest.yml` 版本、檔名、大小吻合。
- [ ] `verify:package-resources` 只在 tag 建置跑：確認該步驟通過（ad-hoc 簽章下的簽章警告是預期）。

## B. 乾淨 Mac 上的驗收（另一台沒裝過 RedLog 的 Apple Silicon Mac）

先備好：一個沒有 RedLog 的使用者帳號、系統預設的 Zsh、能連網、Chrome。

1. **下載與安裝**
   - [ ] 從 Release 頁下載 `RedLog-0.18.4-arm64.dmg` 與 `SHA256SUMS.txt`；
     `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` 通過。
   - [ ] 開啟 DMG，拖入 Applications。記錄每一步與系統提示。
   - [ ] 從 Dock／Launchpad 第一次啟動（不是從終端機）。記錄真實的 Gatekeeper 訊息；
     依 README 的「右鍵 → 打開」或「仍要打開」可啟動。若出現「已損毀」，用 README 的
     `xattr` 指令後可啟動，並記下這是否讓人卡關。
   - [ ] 第一個畫面沒有別人的專案、來源或憑證；沒有改動既有的 `~/.zshrc`。
2. **建立專案與第一道指令**
   - [ ] 建立專案；首次設定頁沒有孤立的步驟編號，文字沒有跑版。
   - [ ] 按「記我的 Zsh 終端」（或依畫面指示接上）。開**新的** Terminal.app 視窗，打
     `echo beta-1`、`ls /nonexistent`、`whoami`。
   - [ ] 回 App：指令卡變「已驗證」；時間軸、逐字稿看得到三筆，`ls` 的結束碼為 1，輸出在。
   - [ ] 計時：從開啟 App 到第一筆被驗證的紀錄，共幾分鐘、卡在哪一步。
3. **短指令不漏輸出（#333）**
   - [ ] 在已接上的 Terminal.app 連續打 30 道短指令（`echo n`、`true`、`date`），
     逐筆核對逐字稿數量與輸出沒有缺。
   - [ ] `redlog-session -- /bin/echo canary` 重複 20 次，每次終端有輸出、逐字稿也有。
4. **HTTP／HTTPS（預設路線：自己的瀏覽器）**
   - [ ] 依畫面把 Chrome（或 FoxyProxy）指向顯示的 proxy 位址。
   - [ ] 依畫面信任 CA（`sudo security add-trusted-cert …`，會改系統信任，測完要移除）。
   - [ ] 瀏覽一個 http 與一個 https 網站，HTTP 歷程出現 request／response，狀態、主機、大小正確。
   - [ ] 兩條驗證列各自完成；故意不信任 CA 時，HTTPS 不得顯示已驗證。
   - [ ] 停止擷取：狀態反映停止；若有終端仍帶 proxy，畫面說明有幾個窗格受影響。
   - [ ] 測完用畫面上的「移除信任」指令把 CA 拿掉，確認 Keychain 裡已無該憑證。
5. **範圍、匯出與重啟**
   - [ ] 在設定加一個範圍目標，狀態列變「範圍 OK」；範圍內的請求在時間軸顯示「範圍內」，
     不是違規；加一個範圍外目標再請求一次，才出現違規。
   - [ ] 匯出一份證據包，用隨包 verifier 驗證通過；改動一列後驗證失敗。
   - [ ] 結束 App（會跳出確認）、重開，記錄仍可搜尋、輸出仍在。
6. **移除與結束**
   - [ ] 設定 → 移除 Zsh hook：已開的終端被停止，畫面說明新終端不會記錄。
   - [ ] 刪除 `/Applications/RedLog.app`，確認 `~/.zshrc` 仍可用、沒有殘留的錯誤訊息。
7. **除錯日誌**
   - [ ] 設定 → 關於 → 打開除錯日誌，開新終端打幾道指令，`~/.redlog/debug.log` 有 `session`／`relay`／`app`
     行；檔案裡**搜不到**你打的指令、路徑或輸出文字。關閉後不再增長。

## C. 已在開發機驗過、不需重做（但不等於別台通過）

- 打包後 App：建專案、裝 hook、真實 zsh 指令與失敗結束碼、受管 proxy 的 GET／POST、各頁面畫面、
  範圍內命中不再顯示為違規、狀態列隨範圍更新、除錯日誌不外洩內容。
- #333：CPU 飽和下 1600 次中 15 次遺失，修正後 0／1600。
- 窄視窗狀態列：1280×800、800×600 的 100／150／200% 縮放，加 420×600。

## D. 尚未驗證（發佈說明已如實列出）

真實 Chrome 加系統 CA 的 HTTPS、另一台 Mac 的 DMG／Gatekeeper／Dock、完整人工首次安裝計時、
Windows／Linux 的人工操作、原生 WSL。

## E. 交給內測者

- 告知範圍：macOS Apple Silicon ＋ Zsh；Bash／PowerShell 只記指令與退出資訊。
- 遇到漏記或怪行為：先開「設定 → 關於 → 除錯日誌」，重現一次，附上 `~/.redlog/debug.log` 與 App 版本。
- 提醒：測試用的 CA 信任要自己移除；macOS 版沒有 Developer ID，第一次啟動需手動放行。
