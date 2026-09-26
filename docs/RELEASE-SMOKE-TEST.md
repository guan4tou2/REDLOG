# 發版 Smoke Test

每次發版（含 patch）都用**打包好的安裝檔**，在**乾淨環境**跑一遍：沒裝過 RedLog、沒有
`~/.redlog`、沒有 hook、沒裝 mitmproxy。不要用 `npm run dev`，開發環境會掩蓋打包問題
（例如下方 EXPORT 一節的已知缺漏）。

順序：**Kali / Debian → Windows（PowerShell、WSL）→ macOS ARM**，最後跑 UPGRADE。

每一項照這個格式記，**Friction 最重要**：

| 欄位 | 內容 |
|---|---|
| Action | 做了什麼 |
| Expected | 以為接下來會怎樣 |
| Actual | 實際發生什麼 |
| Friction | 有沒有停下來思考、查文件或進設定（無／低／高） |

勾選框代表「照預期」。沒勾的，在表格裡記下 Actual 與 Friction，不要只寫「有 bug」。

---

## INSTALL

- [ ] **下載檔對得上 checksum**。在下載目錄：`sha256sum -c SHA256SUMS.txt --ignore-missing`
  （macOS 用 `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`）→ 你下載的那個檔 `OK`。
- [ ] **安裝**。
  - Kali：`sudo apt install ./redlog_*.deb`，沒有相依錯誤。
  - Windows：SmartScreen 選「其他資訊 → 仍要執行」。
  - macOS：拖進 `/Applications`，右鍵 ▸ 打開。
  - 以上都照 README 的說明就過得去。
- [ ] **啟動**。從選單 / Dock / 開始功能表開（**不是**從終端機），視窗出現。
- [ ] **Runtime 就緒卡**。第一次啟動時，專案選擇畫面旁邊會出現：
  - 列出 python3、curl、你的 shell、mitmproxy（選用）；
  - 缺少的項目附上可複製的安裝指令；
  - 「開始使用」永遠可以按。
- [ ] **故意少一個**：移除或改名 python3 後重新檢查，就緒卡點名 python3，並說明內建終端仍可記錄。
  - 失敗時查：`src/core/runtime-preflight.ts`、`RuntimeReadiness.tsx`。
- [ ] **PATH（macOS/Linux）**：先 `uv tool install mitmproxy`，再從 Dock / 選單開 app，就緒卡的 mitmproxy 顯示已找到。
  - 失敗時查：`src/main/login-path.ts`。

## PROJECT

- [ ] **建立專案時貼上範圍**。範圍貼 `10.10.11.0/24, *.corp.local, bad$host`：
  - `bad$host` 當場被標成無效；
  - 建好後，設定 ▸ 範圍 只列出前兩筆。
- [ ] **範圍留空也能建立**，卡片顯示「無法判斷越界」的說明。
- [ ] **排除目標**：貼一個 IP，建好後出現在排除清單。
- [ ] **忽略本機流量**：勾選後建立，設定 ▸ 範圍 的個人流量**同時**有本機 IP 與 `127.0.0.0/8`、`::1`、`localhost`（預設值沒被蓋掉）。

## BUILTIN TERMINAL

- [ ] 新專案開在「讓這場開始被完整記錄」畫面，右側並列「指令與終端」與「HTTP(S)」，兩項都是「○ 尚未驗證」；沒有「Web／主機／兩者」選項，HTTP(S) 不需先跑指令就能開始。
- [ ] 在內建終端執行 `echo first-test`：
  - 「指令與終端」變成「✓ 已驗證」，並寫明外部終端尚未接上；
  - 「HTTP(S)」仍是「○ 尚未驗證」。
- [ ] 按「稍後處理」離開 → 儀表板「核心擷取」列顯示 HTTP(S) 尚未完成。
- [ ] 時間軸出現一筆 `command_start` 和一筆 `command_end`，結束碼是 0。
- [ ] 專案目錄的 `casts/` 下有 `.cast` 檔（`~/.redlog/projects/<id>/casts/`），逐字稿看得到輸出。

## EXTERNAL SHELL

- [ ] **按「記我的 Zsh／Bash／PowerShell 終端」**：
  - 畫面顯示 `echo redlog-ok-xxxx`；
  - `~/.zshrc`（或 `~/.bashrc`、`$PROFILE`）多一行 source，而且**只多一行**。
- [ ] **沒開新分頁就貼**：在**已經開著**的終端貼上，不會通過驗證。60 秒後列出原因，第一條是「開一個新的分頁」。
- [ ] **開新分頁貼上** → 顯示「✓ … 已連線」。
- [ ] **（#159 合併後）** 已連線的畫面寫明「不含輸出」，並提供 `redlog-session`（PowerShell 則是建議內建終端或 Windows 輸出 pack）。
- [ ] 在外部終端執行 `pwd`、`whoami`、`nmap -sV 127.0.0.1`，三道指令都進時間軸，而且有結束碼、耗時、工作目錄。
- [ ] **比較三種記錄方式**。在外部終端依序：
  - 直接跑 `nmap -sV 127.0.0.1`：只有中繼資料，沒有輸出；
  - `redlog-run nmap -sV 127.0.0.1`：有輸出；
  - `redlog-session`，然後跑同一道指令，再 `exit`：有輸出。
  - 記下：你**直覺**以為第一種會不會記到輸出？
- [ ] **WSL（Windows）**：「記我的 WSL 終端」流程與上面相同，nonce 能驗證通過。
- [ ] **破壞測試**：
  - 關掉 RedLog 後打指令：不記錄（這是設計）。重開後，你能不能理解剛才為什麼沒記到？
  - 關掉專案（回到專案選擇）後打指令：一樣不記錄。
  - 失敗時查：`hooks/shell-common.sh`、`RecordTerminalFlow.tsx`、`lib/terminalActivation.ts`。

## HTTP

- [ ] **沒裝 mitmproxy**：首次畫面的 HTTP 卡顯示「mitmproxy 尚未安裝」和 `uv tool install mitmproxy`；裝好後按重新檢查，就能啟動。
- [ ] **按「開始 HTTP 擷取」**，顯示正在監聽 `127.0.0.1:<port>`。
- [ ] **背景流量不會讓驗證通過（#220）**：啟動擷取瀏覽器但不按驗證，等 30 秒——HTTP、HTTPS 都仍是「○ 尚未驗證」。
- [ ] 什麼都不做 60 秒：
  - 列出原因：瀏覽器、HTTPS 憑證（未就緒時才出現）、終端代理選項；
  - 之後再驗證一次，仍然會變成「✓ HTTP 擷取已驗證」。
- [ ] **按「用擷取瀏覽器驗證」**：HTTP、HTTPS 都顯示「✓ 已驗證（Chromium）」，HTTPS 附帶「擷取瀏覽器會忽略憑證錯誤」的提醒；時間軸與 HTTP 頁**沒有** `redlog.verify.invalid` 的紀錄。
- [ ] **終端驗證（CA 未信任）**：在內建終端跑畫面上的 HTTPS 指令 → curl 失敗，HTTPS 列顯示「有 client 拒絕了 RedLog 的憑證」。
- [ ] **信任後再驗證**：跑「HTTPS 憑證」裡的信任指令，按「重新驗證」後再跑 HTTPS 指令 → 「✓ 已驗證（curl/…）」，沒有提醒。
- [ ] **移除信任**：跑移除指令，確認它以指紋（Windows／macOS）或 `redlog-mitmproxy-<指紋>.crt`（Linux）移除；另一個工具的 mitmproxy CA（若有）仍在。重新驗證 HTTPS 指令應再次失敗。
- [ ] **打開一個 HTTP 網站**，HTTP 頁出現這筆往返（有 request 和 response）。
- [ ] **終端走代理的選項**：
  - 關閉時：內建終端的 `curl http://example.com` 不進 HTTP 頁；
  - 打開後**新開**內建終端，再 `curl` 一次：會進 HTTP 頁；
  - `nmap` 永遠不會進 HTTP 頁。確認 UI 沒讓你以為「所有網路流量都會被擷取」。
- [ ] **HTTP 流量走 Burp 時**：記下 RedLog 看得到什麼、看不到什麼，以及 UI 有沒有講清楚。

## SEARCH

- [ ] 搜尋頁搜 `whoami` → 找到外部終端那筆指令。
- [ ] 搜剛才瀏覽的網域 → 找到 HTTP 那筆。
- [ ] 對範圍內的一個 lab 目標跑 `nmap`，目標頁出現那個 IP（從指令自動編目），點進去看得到相關證據。
  （不要用 `127.0.0.1`：它在預設的個人流量裡。）

## EXPORT

- [ ] 標題列「匯出 ▸ 證據包（含驗證器）」：
  - 預覽列出事件總數、包含數與丟棄數；
  - 按執行，產出一個資料夾。
- [ ] 資料夾裡有 `manifest.json`、`manifest.sha256`、`events.jsonl`、**`redlog-verify.py`、`verify.sh`、`verify.cmd`、`README.md`**。
  - v0.17.0 以前的版本會少掉後面四個檔：打包版沒有附上 `tools/redlog-verify.py`。v0.17.1 已修正（#157），
    現在找不到驗證器時，匯出會直接失敗並說明原因。
- [ ] 在資料夾裡跑 `bash verify.sh`（Windows 用 `verify.cmd`），exit 0，並回報 chain 完整。
- [ ] 改掉 `events.jsonl` 的任一個字元再驗證 → 失敗（exit 不是 0）。

## UPGRADE（從 v0.16 以前升級）

準備：在乾淨的帳號，於 `~/.zshrc` 加上 `source ~/.redlog/shell-preexec-hook.sh`，然後安裝新版。

- [ ] 啟動後出現舊 hook 的提示，並指出是哪個檔案。
- [ ] 按一下更新：
  - 產生 `~/.zshrc.redlog-bak-<時間戳>`，內容就是更新前的原檔；
  - 舊的那行被移除，新的 source 行只有**一行**。
- [ ] 開新分頁 → 用 nonce 驗證通過。
- [ ] 重開 app → **不再**出現提示。
- [ ] **故意讓遷移失敗**：先把 `~/.zshrc` 改成唯讀再按更新 →
  - 顯示失敗原因；
  - `.zshrc` 內容不變，沒有寫出一半的檔（可能會留下一份備份檔，這沒關係）。
- [ ] **pack 設定**：用舊版開過剪貼簿或 AI agent 監聽的專案，升級後照 CHANGELOG「Upgrading」的說明在 設定 ▸ 擷取 打開 pack，就恢復記錄。
- [ ] **剪貼簿要另外勾選（#224）**：新專案打開「主機監看」pack → 行程／連線／檔案監看開始記錄，剪貼簿**沒有**；儀表板的剪貼簿列顯示關閉。勾選剪貼簿後才開始記錄。

## 真實工作流（30–60 分鐘，每個大版本一次）

在 lab 或 HTB 正常操作：recon、nmap、ffuf、curl、ssh、瀏覽器、代理、戰利品、截圖、標記、搜尋、匯出。

只記錄一件事：**RedLog 有沒有逼你停下手上的工作去照顧它？**

例如：
- 我是不是要去看擷取健康度？
- HTTP 擷取還開著嗎？
- 這個輸出有沒有被記到？
- 我是不是該用 `redlog-run`？

結束後，回頭找三件你一小時前做過的事，每件記下花了多久才找到。
