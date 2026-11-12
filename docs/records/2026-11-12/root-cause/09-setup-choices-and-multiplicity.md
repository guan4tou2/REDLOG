# 09 · 設定時的選擇與「現實有很多個」（root-cause review）

範圍：操作者在設定或使用時必須做選擇的地方，以及現實中有多個、產品卻只模型化一個（或要操作者挑一個）的地方。重點是選錯、選了兩次、或多個都是真的時會怎樣。
基準：`origin/main@a5e90877`。本地 `main` 停在 `a087c16c`，落後 #699–#707，所以程式碼讀的是與 `origin/main` 相同的另一份工作樹。以下 `file:line` 都以該樹為準。唯讀審查，沒有執行 app，沒有在真的 shell 框架裡實跑。
已排除（不重複報）：04 的來源狀態模型（F1–F6）、8 個固定狀態與 4 個整體狀態、每個 producer 一組憑證、ProofStore、enrollment 累積（04 U5）、#700/#701/#703/#705、config 單一套用路徑與 patch 儲存、bundle v4 封存。

## 摘要（10 行）

1. 共同機制：**產品先猜「操作者用的是哪一個」，再把猜測結果當成事實寫下去、讀回來**。安裝寫進猜到的檔案，「已安裝」再從同一個檔案讀，所以猜錯也會被讀成成功；沒有任何證據回頭修正這個猜測。
2. Shell：寫入位置固定是 `~/.zshrc`、`~/.bashrc`，以及 PowerShell 的 `CurrentUserCurrentHost`。這三個位置分別漏掉 `ZDOTDIR`、macOS 上 bash 的 login shell，以及 VS Code PowerShell 擴充這類其他 host。結果都是：顯示「已安裝」，實際從不載入（F1）。
3. 「這台機器上哪些 shell 有被記錄」沒有以證據為準的答案。答案來自 `$SHELL` 與「二進位檔是否存在」。沒裝 hook 的互動 shell（fish、`exec fish`、root shell、安裝前就開著的 tmux pane、VS Code 另一個 profile）不留任何痕跡，也沒有任何地方說「這個 shell 沒在記」（F2）。
4. 「哪些 shell 能接」至少有 8 份互相獨立的表。因此會出現下列分歧：選擇器一點就安裝；Windows 上提供一個裝不起來的 Git Bash；內建終端把 `sh/ksh/dash` 標成「支援 hook」，實際卻接不上；WSL 只要裝了 zsh 就選 zsh，不看操作者實際用哪個（F3）。
5. Hook 只在安裝時對齊一次，沒有執行期的自我檢查。之後 rc 被框架或 dotfile 管理工具改寫、`PROMPT_COMMAND` 被重新指定、PowerShell 的 `prompt` 被重新定義，記錄都會安靜地停掉；與第三方工具的共存只用一個假的 DEBUG trap 測過（F4）。
6. 每開一個 shell 就在 init 期間往 stdout 印 2 行。這些行出現在每個巢狀 shell、每個 tmux pane 裡，也會撞上 instant-prompt 類框架的「init 期間禁止輸出」（未實測）。真正重要的那一行，被每次都出現的兩行稀釋掉了（F5）。
7. 單一「正在操作的目標」會被蓋到所有抽不出目標的 shell、marker、截圖列上，而且沒有標註這是推測來的。同時對兩台主機作業時，歸屬會靜默出錯；同一個機制已經造成過 T058（F6）。
8. 終端機綁定的專案一旦被切換，就**永久**停止記錄，即使切回原專案也不會恢復。同時跑兩個 engagement、或只是去另一個專案看一眼，所有開著的 pane 都會停錄，每個 pane 只提示一行（F7）。
9. 屬於每台機器或每個人的事實存在每個專案的 `config.yaml`，新專案一律回到預設值：operator 是 `operator-1/Operator`，洩漏偵測用的自有 IP 黑名單是空的，proxy 埠與 listenHost、VPN 介面樣式、瀏覽器設定也都回到預設（F8）。
10. HTTP：「proxy 在跑」被當成「你的 client 有經過它」。擷取瀏覽器的 proxy 可以指向別處，外部終端機永遠不會被導流，與操作者自己的 proxy 串接也沒有文件。結果是 HTTP 列永遠顯示「待命」，實際流量卻沒進紀錄（F9）。巢狀互動程式（shell、多工器、`docker exec -it`、`sudo -s`）沒有分類，預設走 relay，整段 session 會變成一個指令的 100 KB 輸出（F10，部分未確認）。

---

## A. Shell hook

### A.1 App 認得哪些 shell、怎麼決定提供哪一個

| 問題 | 現況（證據） |
|---|---|
| 有 adapter 的 | zsh、bash（`hooks/shell-zsh-hook.zsh`、`shell-bash-hook.sh`）；PowerShell 5.1／7 共用 `shell-hook.ps1`；WSL 的 bash／zsh 用同一份 POSIX adapter（`wsl-manager.ts:288,358,389`）；Git Bash 只在內建 pane 會被 source（`terminal-manager.ts:743-777`）。fish、nushell、sh、dash、ksh、tcsh、xonsh 都**沒有** adapter（`shell-flavour.ts:39-45` 只回 zsh／bash／ps1）。 |
| 首次使用推薦哪個 | `basename($SHELL)`（`runtime-preflight.ts:83-89`）。Windows 上有 `pwsh` 就推薦 pwsh。 |
| 「可用」怎麼判斷 | `checkAvailable`（`hooks-manager.ts:599-614`）：zsh = `$SHELL` 含 zsh 或 `/bin/zsh` 存在；bash = `/bin/bash` 存在，或在 win32 上 PATH 有 `bash`；PowerShell 只在 win32；外加 `requiresAll` python3+curl。 |
| 選擇器列出哪些 | `hostAdapterChoices`（`terminalActivation.ts:101-121`）：POSIX 列 zsh、bash，pwsh 可用時再加；win32 列 PowerShell、bash。WSL 走另一條流程，首次使用只看預設 distro，shell 規則是「有 zsh 就選 zsh」（`FirstRunView.tsx:194`）。 |
| 證據 | 被 hook 的 shell 在第一個 prompt 寫出 `~/.redlog/tool-detection/shell:<platform>:<distro>:<shell>.json`（`redlog-relay.py:2046-2064`）。這是「哪種 shell 真的帶著 hook 啟動過」的機器層級證據，**目前只拿來顯示工具卡片**（`tool-detection.ts:198`），hook 的 UI 不讀它。enrollment 檔沒有記 shell 名稱與 pid（`terminal-enrollment.ts:30-39`）。 |

情境逐一對照（「記到什麼」與「有沒有東西告訴操作者沒記到」）：

| 情境 | 記到什麼 | 有沒有提示 |
|---|---|---|
| `$SHELL`=zsh，實際在 bash 裡工作 | 只裝了 zsh 就什麼都沒記 | 沒有。首次使用的 nonce 只接受選定 shell 的事件（`terminalActivation.ts:208`），從 bash 貼過來會被拒絕；逾時理由只會說「開新分頁」（`zh-TW.json:1448`） |
| VS Code 的 terminal profile 與 login shell 不同 | 同上 | 同上 |
| `exec fish` | 父 shell 留下一筆永遠沒有結尾的 `command_start "exec fish"`，之後全部沒有 | 沒有 |
| `sudo -s`、`su -` | root 的 rc 沒有 hook。外層的 `sudo -s` 走 relay，root session 的輸出被收成這一個指令的 body（上限 100 KB，`redlog-relay.py:68`） | 沒有說「裡面的指令沒有逐筆記」（未確認，見 F10） |
| ssh 到跳板 | `ssh` 歸在 pty 類（`command-class.json` `pty`），由 PTY 錄製器收合併後的輸出；遠端指令沒有結構 | 使用者指南有寫（`USER-GUIDE.md:99`） |
| `docker exec -it`、`kubectl exec -it` | 沒有分類，預設 relayed，整段收成一個 body | 沒有（未確認） |
| `nix-shell`、`poetry shell`、`pipenv shell` | 會開新的互動 `$SHELL`，再讀一次 rc，所以有記；又印一次 banner | 有 banner |
| `conda activate` | 只改 PS1，不影響 | — |
| 安裝前就開著的 tmux／screen pane | 沒有 hook | 沒有 |
| 安裝後開的 tmux pane | 有記。限定終端 App 時 tmux 是邊界，會拒絕並印一行（`terminal_app.py:15`、`shell-common.sh:126-132`） | 有一行 |
| Windows 上 VS Code 的 PowerShell 擴充主控台 | 沒有記，見 F1 | 沒有 |

結論：除了限定終端 App 的情況，**「這個 shell 不在 RedLog 視線內」從來沒有被說出來**。

### A.2 寫入位置、重複、框架、移除

- **寫入位置**：rc 檔固定是 `join(homedir(), '.zshrc'|'.bashrc')`（`hooks-manager.ts:186,199,458-461,888-892`）。`ZDOTDIR`、`.bash_profile`、`.profile`、`.zprofile` 都不考慮；整個 repo 只有外掛的 manifest 允許 `.bash_profile`（`plugins/manifest.ts:29`）。諷刺的是，測試為了隔離環境自己設了 `ZDOTDIR`（`test/shell-terminal-app.test.ts:71`、`test/shell-hook-overhead.test.ts:93`）。PowerShell 寫入 `$PROFILE.CurrentUserCurrentHost`（`powershell-policy.ts:101`），裝的當下 PATH 上有 pwsh 才同時寫兩個 edition（`hooks-manager.ts:912-913`）。
- **防止重複**：載入時有 `_REDLOG_HOOK_LOADED_IN == $$` guard，不 export，所以子 shell 會重新載入（`shell-bash-hook.sh:13`、`shell-zsh-hook.zsh:13`）；`rcWithHook` 認得六種路徑寫法（`hooks-manager.ts:404-418`）。這部分健全。PowerShell 只防「重複保存原 prompt」，重新 dot-source 會再印一次 banner。
- **移除**：`rcWithoutHook` 是精確的逆運算（FR-016，`hooks-manager.ts:420-425`），健全。PowerShell 的移除以 `\r\n` 重新 join（`hooks-manager.ts:1022`），原本是 LF 的 profile 會整份變成 CRLF，不是 byte-identical（從程式讀出，未實跑）。
- **dotfile 管理工具**：`writeFileSync` 會穿過 symlink 寫到目標檔。stow／yadm 管理的 rc 會被寫進 dotfiles repo，而且寫的是含使用者名稱的**絕對路徑**（`hookBlock`，`:397`）；推到別台機器後，每開一個 shell 就會報找不到檔案（推論）。chezmoi `apply` 重新產生 rc 後區塊消失，`installed` 變 false，但沒有任何東西說「先前驗證過的 shell 已經不再記錄」。
- **與框架的共存**：
  - zsh 用 `add-zsh-hook`，可疊加（`shell-zsh-hook.zsh:670-673`），健全。
  - bash 每個 prompt 都用 `_redlog_trap_plan` 重新讀 DEBUG trap 並串接（`shell-bash-hook.sh:513-533`），`PROMPT_COMMAND` 支援陣列與字串（`:680-693`），註解點名 bash-preexec、starship、atuin。
  - PowerShell 覆寫 `function prompt`，並鏈接原本的 prompt（`shell-hook.ps1:151-161`）。
  - 實際測過的第三方：**沒有**。`test/bash-hook-prompt-command.test.ts:97-128`、`test/bash-auto-capture.pty.test.ts:110-133` 用的是自己寫的 `trap '…' DEBUG` 替身；oh-my-zsh、p10k、starship、atuin、bash-preexec、direnv、VS Code／iTerm2／kitty／WezTerm／Warp 的 shell integration、oh-my-posh、PSReadLine handler 都沒有出現在 test／e2e 裡（grep 確認）。
- **順序**：RedLog 附加在 rc 最後面。bash 的 trap 因為每個 prompt 重新串接，不怕別的工具晚到。不過串接用的 `PROMPT_COMMAND` 本身沒有保護：之後任何一行 `PROMPT_COMMAND=...`（不含原值）都會讓 `_redlog_prompt_command` 不再執行，trap 也不會 arm，**完全靜默**（F4）。PowerShell 同理：profile 後面再跑一次 `oh-my-posh init`／`starship init`，RedLog 的 prompt 就被換掉。

### A.3 「好幾個提示」：操作者實際看到什麼

| 時機 | 內容 | 位置 |
|---|---|---|
| 每個 zsh／bash 啟動 | `[redlog] shell hook loaded`、`[redlog] redlog status · redlog stop`（stdout，init 期間） | `shell-common.sh:1131-1139`，由 `shell-zsh-hook.zsh:678`、`shell-bash-hook.sh:738` 呼叫 |
| 每個 PowerShell 啟動 | 兩行 `Write-Host` | `shell-hook.ps1:365-366` |
| 限定 App 以外的終端 | 一行，stderr | `shell-common.sh:131` |
| 第一個指令後連不上 RedLog | 一行 | `:1102/1104` |
| 沒開專案／被收養／專案切換 | 各一行 | `:1121,1088,387` |
| 內建 pane | 以 `clear` 蓋掉 | `terminal-manager.ts:771-773` |

- 巢狀 shell、`nix-shell`、每個 tmux pane、VS Code 每次「解析 shell 環境」跑的 `$SHELL -ilc`，都會各印 2 行。後者還會跑 `boot`，寫出一個 enrollment 檔（推論，未實跑）。
- p10k instant prompt：p10k 在 `.zshrc` 開頭啟用 instant prompt 後，init 期間有任何 console 輸出就會印警告。RedLog 的區塊在檔尾、輸出到 stdout，**預期會觸發**（UNCONFIRMED，需在容器內以 p10k 實測）。
- 沒有 `[[ $- == *i* ]]` 的互動檢查（grep 確認）。如果操作者的 `.bashrc` 開頭沒有 Debian 式的 return guard，非互動 ssh 進這台機器時 banner 會進 stdout，弄壞 scp／rsync（推論）。
- 提議（安靜的設計）：
  - init 期間**什麼都不印**。
  - 只在狀態**改變**時，於下一個 prompt 印一行到 stderr：連不上、沒有專案、被收養、被切換、被限定拒絕。每個 shell 每種狀態只說一次（已有的 `_REDLOG_WARNED_*` 機制）。
  - 「hook 已載入」與「可用指令」這類資訊移到 `redlog status` 與 app 的 shell 列。
  - 巢狀 shell（有繼承 `_REDLOG_SESSION_ID`）只在與父 shell 狀態不同時才說。

### A.4 選擇介面本身

- 首次使用只有一顆按鈕，「記我的 {推薦 shell} 終端」；按下去才出現選擇器（`RecordTerminalFlow.tsx:254-262`）。**在選擇器上點選就等於安裝**：`selectedHook` 一變就觸發 `run()`，接著 `hooks.install()`（`:198-203`，測試 `record-terminal-adapter-selection.test.tsx:282-289` 釘住了這個行為）。先點 Zsh 再點 Bash，兩個 rc 都會被寫入，但驗證只認最後點的那個。
- 設定 ▸ 指令與終端：每種 shell 一列，按鈕是「接入」或「驗證」，「驗證」會重跑安裝（冪等），另有「停用」，旁邊是 Terminal App 單選（`HooksPanel.tsx:137-149,194-211`）。
- nonce 與「實際貼進去的 shell」：nonce 只證明「選定的 shell 種類有一個分頁在這次嘗試中送出事件」，不證明操作者平常工作的那個分頁（VS Code profile、tmux）。從另一種已 hook 的 shell 送來的 nonce 會被**拒絕**，而不是當成那種 shell 的證明。
- 提議的模型：
  - 預設安裝到所有有 adapter、且在本機存在的互動 shell，並為每個 shell 保存狀態。PowerShell 已經這樣做：兩個 edition 都寫。這是現成的先例。
  - 驗證收證據不收選擇：任何 shell 送來的 nonce，都記成「該 shell 已驗證」。
  - 每個 shell 一個事實：已記錄／未記錄／無法確認。「最近用過的 shell」取自 tool-detection 報告與 hello，不取自 `$SHELL`。
  - 8 個狀態不會變成一面牆：沒有證據也沒有安裝的 shell 不列出；有 adapter 卻從沒用過的 shell，收合成「另有 N 種 shell 可接」。

### A.5 目標設計

1. **從證據偵測**：每個 hook 第一個 prompt 送出一次 `shell.hello{shell, version, host, distro, parent_session, hook_version}`（研究 §6.1 的 P;Hello），同時寫入機器層級的 shell 證據檔。tool-detection 報告已經是這份檔案的雛形。`$SHELL` 只拿來排序，不拿來決定。
2. **安裝紀錄**：每台機器一份 `~/.redlog/hook-installs.json`，鍵是 (machine, shell, edition／host, rc 實際路徑, realpath, 是否 symlink)，值是寫入的確切位元組與換行風格。移除依紀錄精確逆轉。偵測到 symlink 時先問：要寫進 symlink 的目標，還是改用 `ZDOTDIR` 或本機的 `.local` 檔。
   - zsh 寫入 `${ZDOTDIR:-$HOME}/.zshrc`。ZDOTDIR 取自互動 zsh 本身（`zsh -ic 'print -r -- $ZDOTDIR'`），或取自 hello 回報。
   - bash：macOS 上若 `.bash_profile` 不 source `.bashrc`，login shell 就讀不到。RedLog 可以寫入 `.bash_profile`，或說明原因；Linux 維持 `.bashrc`。
   - PowerShell 改寫 `CurrentUserAllHosts`（`profile.ps1`），這樣涵蓋 ConsoleHost、VS Code 擴充與 ISE。
3. **每個 shell 一個可見事實，加上「沒記到」的訊號**，兩條路，都沿用 #703 的作法：只看 mtime 或指令名稱，不讀內容。
   - 父 shell 一側：classifier 新增「進入另一個 shell」這一類，包括 `bash|zsh|fish|sh|nu|pwsh`、`exec <shell>`、`sudo -s|-i`、`su`、`docker|podman exec -it`、`kubectl exec -it`、`nix-shell`、`tmux|screen`。這類指令的 `command_end` 帶 `inner_shell: 'recorded'|'not-recorded'`，判準是期間有沒有收到 `parent_session` 等於本 session 的 hello。子 shell 從繼承的 `_REDLOG_SESSION_ID`（目前已 export，`shell-bash-hook.sh:78`）取得父 session id，然後覆寫成自己的。
   - 機器一側：歷史檔的 mtime 探針，對象是 `~/.zsh_history`、fish 的 `fish_history`、PSReadLine 的 `<Host>_history.txt`。PSReadLine 依 host 分檔，所以 `Visual Studio Code Host_history.txt` 有變動，就**直接指出**是哪個 host 沒被記錄。判準：某種 shell 的歷史檔在 T 時更新，但 T 前後 60 秒內沒有收到該種 shell 的指令事件，就提示「這台機器上有 {shell} 在使用，沒有被記錄」。bash 預設在離開時才寫歷史，訊號弱，要照實寫明。
4. **巢狀與遠端 shell 能誠實說到哪裡**：
   - 環境變數會穿過子 shell、`nix-shell`、tmux（server 啟動時的環境）。
   - `sudo` 會 env_reset；ssh 只帶 `SendEnv` 允許的變數；container 從零開始；`exec` 會換掉 hook 本身。
   - 用詞：「這個 shell 在 RedLog 看不到的地方（{原因}）：只有啟動它的那一行與它的終端輸出（如有）被記下」。原因從固定清單取：另一個 shell、另一個使用者、遠端主機、容器。
5. **與框架共存的契約**：
   - 只用各 shell 的疊加式陣列（`precmd_functions`、bash ≥5.1 的 `PROMPT_COMMAND` 陣列、bash-preexec 存在時用它的陣列）。
   - 字串形式的 `PROMPT_COMMAND` 每個 prompt 都自我檢查。
   - 永不在 init 期間輸出。
   - 每個 prompt 做一次 doctor（zoxide 式）：hook 不見了就送一次 `capture_detached` 並在 stderr 說一次，見 F4。
   - 容器測試矩陣：bash 3.2、5.1、5.2 × {無, bash-preexec, starship, atuin, direnv, VS Code bash integration}；zsh × {oh-my-zsh, p10k instant prompt, prezto, zinit, starship, atuin}；pwsh 7 × {oh-my-posh, starship, PSReadLine handler}。最後一組在 Windows runner 上跑，再加上 5.1 的 ConsoleHost 與 VS Code host。

---

## B. 其他的選擇與多重性

| 項目 | 選擇／多重性 | 預設 | 預設錯時 | 看得見？ | 最小設計 |
|---|---|---|---|---|---|
| HTTP：哪個 proxy | 一個受管 proxy；操作者可能另有自己的攔截 proxy | 開專案自動啟動（`http-autostart.ts`） | 實際流量不經過 RedLog | 否：列顯示「待命」（F9） | 以觀察到的 client 為準（研究 §3.3 的 Connected Sources）；沒有 flow 時的理由寫「沒有任何 client 經過 RedLog 的 proxy」 |
| HTTP：擷取瀏覽器的 proxy | `browser.proxy` 可指向任何地方（`managed-proxy-url.ts:1-3`；`main/index.ts:1753` 只在指向受管端點時才啟動並信任） | 受管端點 | 指向別處時瀏覽器流量完全沒記 | 否 | 啟動瀏覽器時若不是受管端點，在列上寫出事實 |
| HTTP：多個 client | 外部終端機永遠不會被導流；`routeTerminals` 只影響**新開的內建** pane（`zh-TW.json:3`） | 關閉 | — | 部分 | 同 F9 |
| HTTP：埠、listenHost | 每個專案一份 | 6661／127.0.0.1（`config.ts:305-312`） | 本機 6661 被占用、或 WSL 走 NAT 時，每個新專案都要再改一次 | 有埠衝突訊息 | 移到機器層級；被占用就自動換一個並記住（F8） |
| AI session | 多種工具 × 多個並行 session × workPaths | 未安裝、目錄空白 | 漏記 | #703 已補上 | 探針已經看得到目錄名稱。Claude Code 的目錄名稱就是編碼過的 cwd，可以拿來**建議** workPath（只顯示在本機），不必讓操作者自己猜 |
| 終端 App 限定 | 單選：全部，或 Warp／Terminal.app／iTerm2／VS Code 其中一個（`HooksPanel.tsx:197-210`） | 全部 | 同時用兩個 App 的人只能選全部或只記一個 | 被拒絕的終端會印一行 | 改成多選；預設不顯示，等操作者需要時再開 |
| 專案 | 一次只開一個；終端機綁專案 | — | 見 F7 | 一行 | 見 F7 |
| Operator | 每個專案一份 id／name，預設 `operator-1/Operator`（`config.ts:269-272`）；簽章金鑰在 `~/.redlog/keys/<id>.key`（`signing.ts:13`） | 預設值 | bundle 寫「Operator」；專案中途改 id，紀錄就分成兩個簽章者 | 否 | 每台機器問一次（F8） |
| 目標 | 單一 active target（`ingest.ts:71,253`） | 無 | 見 F6 | 否 | 見 F6 |
| Scope | UI 規則加 scope 檔 | `snapshotScope` 合併成一個值（`config.ts:434-452`） | — | — | 健全 |
| 網路身分 | VPN 介面樣式、白名單、黑名單，每個專案一份 | 黑名單空白 | 新專案沒有洩漏偵測 | 否 | F8 |
| 截圖 | 多個螢幕 | 游標所在螢幕；找不到就取第一個 source，並如實記下 `display_id`（`screenshot-agent.ts:105-153`） | 定時截圖只拍游標所在的螢幕 | 有 `display_id` | 列為延後，見 D |
| 匯出 | 5 種格式 × 範圍 × 遮罩 × 附件 | 能力表把選項擋在前面（`export-capabilities.ts:17-23`） | — | — | 健全 |
| 設定範圍 | HUD 已改成全域；`terminal-mode`、`terminal-app`、class overlay、金鑰已是機器層級；其餘全在專案 config | — | 見 F8 | — | F8 |
| 語系 | renderer 的 `localStorage('redlog-locale')`；hook 與主行程的訊息只有英文 | — | 中文介面配英文 banner | 是 | 本次不處理 |
| 更新頻道 | 未檢查 | — | — | — | UNCONFIRMED |

---

## C. 前 10 名（頻率 × 判斷錯時的靜默遺失或錯誤歸屬）

### F1　安裝寫進「猜到的那個檔」，「已安裝」再從同一個檔讀；猜錯時顯示已安裝、實際從不載入

**機制。** 安裝目標是每種 shell 一個寫死的路徑；`checkInstalled` 讀的是同一個路徑（`hooks-manager.ts:513-520,579-590`）。shell 實際讀哪個檔，取決於 `ZDOTDIR`、是否為 login shell、PowerShell 的 host。產品沒有問 shell，也沒有看證據。nonce 逾時時只列「開新分頁、執行原則、缺依賴」三個理由，所以錯誤會被解讀成操作者操作錯。

**實例。**
1. **zsh 加 `ZDOTDIR`**：寫入 `~/.zshrc`（`:186,888-892`），zsh 卻讀 `$ZDOTDIR/.zshrc`。設定頁顯示已安裝；首次使用逾時並叫操作者「開新分頁」。
2. **macOS 上的 bash**：Terminal.app 與 iTerm2 預設開 login shell，login shell 讀 `.bash_profile` 而不讀 `.bashrc`。RedLog 只寫 `.bashrc`（`:199`），而 macOS 的 `.bash_profile` 預設不 source `.bashrc`。
3. **PowerShell 的其他 host**：寫入 `CurrentUserCurrentHost`（`powershell-policy.ts:101`），所以 ConsoleHost 以外的 host 不會載入，包括 VS Code PowerShell 擴充的 `Microsoft.VSCode_profile.ps1` 與 ISE。
4. **後來才裝的 pwsh**：安裝時只對 PATH 上已有的 edition 寫入（`:913`）。之後裝的 pwsh 7 沒有 hook，`isPowershellProfileInstalled` 卻因為「任一 profile 有」而回報已安裝（`:570-577`）。
5. **WSL**：首次使用只要 distro 裡**存在** zsh 就選 zsh（`FirstRunView.tsx:194`），不看使用者的 login shell。

**為什麼之前的修補治標。** #94 加了 shell 選擇器，`powershell-policy` 改成詢問 OneDrive 重導後的路徑，`hookSpellings` 解決了重複的寫法。每一次都在「猜得更準」，沒有一次把猜測換成證據。

**目標設計。**
- 每台機器一份安裝紀錄，見 A.5-2。寫入位置問 shell 本身：zsh 問 `ZDOTDIR`；bash 判斷 login／互動的組合；PowerShell 改寫 `CurrentUserAllHosts`。
- 「已安裝」降級成理由。狀態只看 hello 證據：檔案寫好、但從沒收到 hello，就是「已安裝 · 尚未在任何 {shell} 看到」。
- nonce 逾時的理由加上「{shell} 讀的是 {實際路徑}」。

**需要的階段。** 狀態模型（04）的 `installed` 事實改由紀錄提供；ProofStore 收 hello。

**影響範圍。** `hooks-manager.ts`、`wsl-manager.ts`、`powershell-policy.ts`、`RecordTerminalFlow`、hooks（hello）。磁碟：新增一個紀錄檔。已安裝的機器：第一次啟動時以現有的 rc 內容重建紀錄。

**驗證。** macOS 實機：Terminal.app 加 bash。容器：zsh 配 `ZDOTDIR`。Windows：VS Code PowerShell 擴充與 ISE，以及先裝 RedLog、後裝 pwsh 的順序。

### F2　沒有「哪些 shell 有被記錄」的證據帳；沒裝 hook 的互動 shell 不留痕跡

**機制。** 機器上「被 hook 的 shell」只有兩個來源：安裝事實，以及每個專案的 ownShell 事件。tool-detection 已經在寫每種 shell 環境的啟動證據（`redlog-relay.py:2046-2064`），但 hook 相關的 UI 不讀它。至於沒有 hook 的 shell，本來就不會產生任何事件，所以「沒有事件」與「沒有在用」在畫面上分不出來。這正是產品規則「沒有事件不得看起來像什麼都沒發生」的漏洞。

**實例。** A.1 表中 9 個情境裡有 8 個沒有任何提示：`exec fish` 留下一筆沒有結尾的 command_start；安裝前就開著的 tmux pane；`sudo -s`；VS Code 的另一個 profile；fish、nushell 使用者；Windows 上的 VS Code PowerShell 擴充。#703 為 AI 工具解決的就是同一個形狀，shell 還沒有。

**目標設計。** A.5-1 的 hello 與機器層級證據帳；A.5-3 的兩種「沒記到」訊號（父 shell 側的 inner-shell 分類、歷史檔 mtime 探針）。訊號沿用 #703 的呈現：只在例外時列出，每種 shell 一則，可略過。

**需要的階段。** 寫入契約（階段 4）新增 `shell.hello` 與 `inner_shell` 欄位；狀態模型的理由加上 `unrecorded-shell-active{shell, host?}`。

**影響範圍。** hooks（hello、classifier 的一個類別）、`command-class.json`、新的探針模組（仿 `agent-activity-probe.ts` 的「不讀內容」測試）。

**風險。** 歷史檔路徑可被設定（`HISTFILE`），bash 預設離開時才寫，所以只能稱為提示，不能稱為證明。

**驗證。** 容器：zsh 父 shell 下 `exec fish`、`bash`、`sudo -s`。Windows：PSReadLine 的多個 host 檔。macOS：tmux。

### F3　「哪些 shell 能接」有 8 份互不相干的表

**機制。** 每加一個畫面就再定義一次 shell 支援。列出的位置有：
- `HOST_ADAPTERS`（`terminalActivation.ts:59-63`）
- `SHELL_HOOKS`（`runtime-preflight.ts:46-51`）
- `POSIX_SHELLS` 與 `shellAdapterFilename`（`shell-flavour.ts:15,39-45`）
- starter-pack 的 `builtinProducers` 與 `STARTER_PACK_FALLBACK`（`hooks-manager.ts:174-230`）
- `checkAvailable` 的特例（`:599-614`）
- `POSIX_SHELL_PATHS`（`shell-catalog.ts:51`）
- `isForeignShellHook` 的兩個集合（`hookPlatform.ts:10-11`）
- `wsl-manager` 的 rc 對照（`:288`）

**實例。**
1. `/bin/sh`、`ksh`、`dash`：`shellFlavour` 判為 posix，`isHookable` 為真，所以內建終端的選擇器標成「支援 hook」（`TerminalView.tsx:463-465`）；但 `shellAdapterFilename` 回 null，pane 開出來是 `hookSourced:false`。
2. Windows 的 `shell-bash`：只要 PATH 上有 `bash`（裝了 WSL 就有 `System32\bash.exe`）就可用，於是出現在首次使用的選擇器裡；`installHook` 卻在 win32 上一律拒絕（`:873-878`），點下去只會得到「安裝失敗」。
3. WSL 的 pane 固定開 `/bin/bash`（`shell-catalog.ts:93-97`），不管 distro 的預設 shell。
4. 選擇器一點就安裝（`RecordTerminalFlow.tsx:198-203`）：「選擇」與「動作」是同一件事，換一個選項就多寫一個 rc。

**目標設計。**
- 一份 `core/shell-registry.ts`。每種 shell 記錄：adapter 檔、平台、安裝方式、rc 位置的解析函式、hello 的 shell 名稱、能不能自動擷取輸出。
- 其他所有地方都從它導出，加一個 boundary 測試：`src/` 不得出現 shell 名稱的字面陣列。
- 選擇器只**選**，「安裝」另外一顆按鈕；或依 A.4 改成全部安裝，不需要選。

**影響範圍。** renderer 4 個檔案、core 5 個檔案。

**驗證。** 單元測試比對新舊對照表；Windows 實機確認 Git Bash 列不再出現在裝不起來的地方。

### F4　Hook 只在安裝時對齊一次；執行期被拆掉時完全靜默

**機制。** 確認 hook 是否還在只有兩種方式：安裝時讀 rc 文字，以及首次使用的 nonce。shell 本身不檢查自己的掛點是否還在。唯一的例外是 bash 每個 prompt 重新串接 DEBUG trap，但這段程式住在 `PROMPT_COMMAND` 裡，而 `PROMPT_COMMAND` 本身沒有保護。

**實例。**
1. bash：之後任何一行 `PROMPT_COMMAND='history -a'` 都會讓 `_redlog_prompt_command` 與 `_redlog_arm` 不再執行（`shell-bash-hook.sh:678-693`）。之後一個指令都沒記，也沒有任何輸出。
2. PowerShell：profile 裡位於 RedLog 之後的 `oh-my-posh init`／`starship init` 會重新定義 `prompt`（`shell-hook.ps1:161` 被覆蓋）。
3. chezmoi 重新產生 rc：區塊消失，下次 detect 時 `installed:false`，但先前的驗證、儀表板的「已收到你自己終端的指令」都還在。
4. 共存測試只用替身 trap（A.2），所以真實框架的行為沒有任何測試保護。研究也指出 VS Code bash integration 會把既有 trap eval 進自己的 trap；RedLog 每個 prompt 再串一次時，有沒有重複觸發，未確認。

**目標設計。**
- 每個 prompt 做一次 doctor，成本是讀幾個陣列或變數，不 fork：zsh 查 `precmd_functions`；bash 查 `PROMPT_COMMAND` 是否仍含自己；PowerShell 查 `$function:prompt` 是否仍是自己的。
- 被移除時送一次 `capture_detached{by:'prompt-reassigned'|...}`，並在 stderr 說一次。RedLog 依此把該 shell 列成「失敗」並附理由。
- 版本握手：hello 帶 `hook_version`，舊的就提示開新終端。
- 加上 A.5-5 的容器矩陣。

**需要的階段。** 階段 7 的多版本 shell 容器測試；寫入契約新增 detached 事件。

**驗證。** 容器矩陣；PowerShell 上的 oh-my-posh。

### F5　每個 shell 啟動時往 stdout 印 2 行；init 期間的輸出與框架衝突，重要的提示被稀釋

**機制。** 「hook 已載入」被當成必須告訴操作者的事，所以每次啟動都印，即使沒有任何問題。

**實例。** 見 A.3：
- bash／zsh 各 2 行（`shell-common.sh:1134-1138`），PowerShell 2 行（`shell-hook.ps1:365-366`）。巢狀 shell、tmux pane、`nix-shell` 各再印一次。
- 印在 stdout、而且在 init 期間：p10k 會警告（UNCONFIRMED）；沒有互動檢查時會弄壞 scp（推論）。
- 程式自己的註解也說「Loading the adapter is not proof of recording」（`:1129-1130`），但還是印了。

**目標設計。** init 期間不輸出；只在狀態改變時印、印到 stderr、每種狀態只說一次；`redlog status` 與 app 是查狀態的地方（A.3）。

**影響範圍。** 3 個 hook 檔；`test/shell-announce.test.ts` 要刻意改寫；文件中提到 banner 的段落一併更新。

**風險。** 有人把 banner 當成「hook 有載入」的確認。替代方式是 app 的 shell 列，以及 `redlog status`。

**驗證。** 容器：p10k instant prompt（預期不再有警告）；`ssh host true`、scp 進一台 `.bashrc` 沒有 guard 的機器。

### F6　單一 active target 被蓋到所有抽不出目標的操作上，沒有標註來源

**機制。** `ACTIVE_TARGET_FALLBACK_TYPES = {shell, marker, screenshot}`（`ingest.ts:71`）。shell 指令抽不出目標時，就填入全域唯一的 active target（`:253-255`），而且沒有任何欄位說「這是推測的」。active target 存在專案 config 裡，跨重啟延續。

**實例。**
1. T058（`72e7b94b`）：fallback 把 `session_start` 與 hook source 列也蓋上目標，Targets 的計數因此多於 Timeline。這是同一機制已經造成過的缺陷，修法只是在計數時排除 housekeeping。
2. 同時開兩個終端分別打 A、B 兩台主機時，B 終端裡的 `cat loot.txt`、`vim notes`、`cd`、`./exploit` 都會歸到 A；定時截圖也是。依目標匯出時，這些列會跟著進入 A 的交付物。
3. 隔天沒清掉的 active target，會繼續蓋到新一天的本機操作上。

**目標設計。**
- 一律標註推測來源：`target_via: 'extracted'|'active-target'`，並納入雜湊（階段 1 的核心蓋章）。
- shell 列的 fallback 改成以**終端機**為單位：每個 terminal session 有自己最近一次抽出的目標，同一終端裡沒抽出目標的指令沿用它。全域 active target 只用於 marker 與手動截圖。
- 依目標匯出時，`active-target` 推得的列預設附註，不靜默混入。

**需要的階段。** 階段 1（核心蓋章）、階段 4（信封）。

**影響範圍。** `ingest.ts`、目標頁的計數、匯出選擇。既有資料：舊列沒有 `target_via`，視為未知，不回填。

**驗證。** 單元測試：兩個 session 交錯；e2e：依目標匯出的列數。

### F7　終端機的專案綁定一旦被切換就永久失效；切回原專案也不恢復

**機制。** `pin_broken = stoppedReason == 'project-switched'`。在 pin 失效的狀態下，`start` 與 `mode` 都不再恢復記錄（`redlog-relay.py:1170-1206`、`terminal-enrollment.ts:77-99`）；`project` 動作只會把 recording 設成 false。所以專案 A 的終端機在 A 重新打開後，仍然停著。

**實例。**
1. 同時跑兩個 engagement，或只是開 B 查一件事：所有 tmux pane 都停錄，每個 pane 只在下一個指令後印一行（`shell-common.sh:387`）。重新打開 A 之後，操作者必須重開所有 pane，否則接下來的指令全都沒有記錄。
2. 內建 pane 有 `resumeTerminalRecordings`（`terminal-manager.ts:323-328`），切回時會重新開始；外部終端沒有。同一件事，兩種行為。

**為什麼是刻意的、以及刻意的部分在保護什麼。** FR-010 防的是「A 的指令被歸到 B」。「回到 A 時恢復」不會把 A 的指令歸到 B，FR-010 的不變式完全保留。

**目標設計。**
- pin 失效改成「暫停」：開著的專案不等於 pin 時不記；等於 pin 時自動恢復，並寫入 `capture_resumed{reason:'pinned-project-reopened'}`，留下的空白由既有的 `capture_stopped`／`capture_resumed` 成對框住。
- `redlog stop` 的永久性（FR-022）不受影響。

**需要的階段。** 專案執行期（階段 2）擁有「開著的專案」，終端狀態依它判斷。

**影響範圍。** relay 與 TS 兩份轉移函式（兩份必須一起改，有 agreement 測試），以及 `test/shell-project-switch.test.ts`。

**驗證。** 實機：開 A，開 tmux，切到 B，再切回 A，確認接下來的指令有記錄。

### F8　每台機器、每個人的事實存在每個專案；新專案靜默回到預設值

**機制。** `project:create` 把 `mergeInitialConfig(loadConfig(新目錄), …)` 寫進新的 `config.yaml`（`main/index.ts:1514`）。新目錄沒有檔案，所以讀到的就是 `DEFAULT_CONFIG`。唯一的帶入方式是手動匯入 profile（`CreateProjectModal.tsx:93`）。

**實例**（`config.ts:264-358`）：
- operator `operator-1/Operator`：bundle 的署名，也是金鑰檔名。
- `network.blacklist: []`：「你自己的固定 IP，看到就代表身分外洩」（`:41`），所以**每個新專案都沒有洩漏偵測**，而且畫面不會說。
- `vpnAdapters`、`showWifiName`、`httpCapture.port/listenHost`：在 WSL NAT 機器上，每個專案都要再設一次 `0.0.0.0`。
- `browser.binary/cdpPort`、`redaction` 的 allow／deny、`loot.disabledRules`、`screenshot.quality`。
- 相對地，hook、CA、外掛、終端 App、class overlay、HUD 已經是機器層級的。

**目標設計。**
- 一份機器層級的 `~/.redlog/machine.yaml`（operator、自有 IP、網路介面、proxy 端點、瀏覽器、遮蔽規則的預設）。
- 專案 config 只存 engagement 的事實：scope、目標、active target、離線模式、AI 授權、packs、保留期限。專案只在明確覆寫時才存差異。
- 新專案建立時不再複製機器層級的值，而是讀取時合併。這與 04 的範圍劃分（機器／專案／執行期）一致。

**需要的階段。** 專案執行期（階段 2）的單一設定檢視。

**影響範圍。** config 載入、設定頁的每個欄位標上範圍、profile 匯出／匯入。既有專案：讀取時，專案值優先。

**驗證。** 單元測試（合併順序）；遷移測試（既有 config 不變）。

### F9　「proxy 在跑」被當成「你的 client 經過它」；與操作者自己的 proxy 串接沒有文件

**機制。** HTTP 列的「待命／記錄中」只看受管 proxy 的執行狀態與本專案的事件。沒有「哪些 client 被看到過」這個事實（研究 §3.3：三家工具都不把 proxy 在跑當成功）。

**實例。**
1. 擷取瀏覽器的 `browser.proxy` 可以指向任何 proxy（`managed-proxy-url.ts:1-3`）。指向別處時，瀏覽器的流量完全沒記，列仍是「待命」。
2. 外部終端機永遠不會被導流：`routeTerminals` 只作用於新開的內建 pane（`zh-TW.json:3`）。
3. 操作者自己的攔截 proxy，可以把 RedLog 設成它的上游，但 repo 的文件與 UI 都沒提（grep `upstream`／`上游`：0 筆）。不預設操作者用哪種工具，正是要說明「不經過 RedLog 的 HTTP 不會被記錄」。
4. 04-F3 的「每次啟動都 amber」是同一機制的另一面。

**目標設計。**
- 以 flow 推出「觀察到的 client」：UA 族群，加上 `socket-attribution` 可得時的程序名稱。HTTP 列的理由寫成「已看到：{client 清單}」或「尚未有任何 client 經過」。
- 擷取瀏覽器的 proxy 不是受管端點時，理由寫「擷取瀏覽器送往 {proxy}，不經過 RedLog」。
- 在 HTTP 設定頁的說明裡，寫一句「另一個 proxy 可以把 RedLog 當成上游」。這不是新頁，也不點名任何工具。

**需要的階段。** 狀態模型（04）的理由清單、寫入契約（client 欄位）。

**驗證。** 實跑：擷取瀏覽器指向一個不存在的 proxy；外部終端執行 curl；另一個 proxy 以 RedLog 為上游。

### F10　巢狀互動程式沒有分類，預設走 relay（部分 UNCONFIRMED）

**機制。** class 只有 native、pty、repl 三個名單（`command-class.json`）。shell、`tmux`／`screen`、`top`／`htop`／`watch`、`docker|kubectl exec -it`、`sudo -s`、`su`、`nix-shell` 都不在名單上，所以是 relayed。relay 的 body 上限是 100 KB（`redlog-relay.py:68`），也不處理 alternate screen（grep：0 筆）。

**預期的結果**（從程式推得，未實跑）：
- 整段巢狀 session 變成一個指令的 body，帶 TUI 重繪，100 KB 後截斷。
- 如果子 shell 本身也有 hook，就會雙重記錄：外層的 body 與內層逐筆的事件。
- relay 為該指令設定的 `PAGER=cat` 會被子 shell 繼承，整個巢狀 session 都沒有 pager（`shell-zsh-hook.zsh:354`）。
- 唯一確定的部分：這些程式沒有被分類，`*-transparency.pty.test.ts` 也沒有巢狀互動程式的案例。

**目標設計。** 新增 `enters-shell` 與 `fullscreen` 兩個類別。
- `enters-shell`：走 native（不 relay），`command_end` 帶 `inner_shell`（F2）。
- `fullscreen`：走 native，`output_disposition: 'interactive'`。

**驗證。** 容器 PTY 測試：從 zsh 裡跑 `bash`、`tmux`、`htop`、`sudo -s`，看 body 與事件數。

---

## D. 應該消失的步驟，以及應延後的選擇

**系統可以自己做或推得，應該消失：**
1. **選 shell**：預設安裝到所有有 adapter 且本機存在的 shell，並保留精確的 undo 紀錄；驗證收任何 shell 的證據（A.4）。PowerShell 兩個 edition 已經這樣做。
2. **貼 `echo redlog-ok-<nonce>`**：改由 hook 第一個 prompt 的 hello 證明「這種 shell 已接上」。輸出 canary 保留為選用。
3. **WSL 選 shell**：問 distro 裡的 `getent passwd $USER`，不看「有沒有安裝 zsh」。
4. **每個專案再設一次 operator、自有 IP、proxy 埠與 listenHost、VPN 樣式、瀏覽器**（F8）。
5. **埠被占用時手動換埠**：自動換一個空的埠並記在機器層級。
6. **AI workPath 讓操作者猜**：用探針看到的目錄名稱提出建議（只在本機顯示，仍需確認）。

**應延後到證據顯示需要時再問：**
1. 終端 App 限定：預設「全部」；只有操作者提起時才出現，而且改成多選。
2. 截圖要拍哪個螢幕：維持游標所在螢幕，並記下 `display_id`，等有人要求再說。
3. 與其他 proxy 串接：只在觀察到「受管 proxy 沒有流量、但有 `HTTP_PROXY` 指向別處」時，才說那一句。
4. fish、nushell 的 adapter：等歷史檔探針真的回報 fish／nu 在使用時，再做。

---

## 查過、沒問題的

- `rcWithHook`／`rcWithoutHook` 認得六種寫法，而且是精確逆運算（FR-016，`hooks-manager.ts:397-425`）。只有 PowerShell 的換行風格例外（A.2）。
- 載入 guard 是 `$$`、不 export，子 shell 會重新載入（`shell-*-hook:13`）。
- bash DEBUG trap 每個 prompt 重新串接、陣列形式的 `PROMPT_COMMAND`、EXIT trap 的串接（`shell-bash-hook.sh:513-533,680-727`），設計與研究 §6.1 一致。
- zsh 用 `add-zsh-hook`，可疊加。
- 終端 App 的歸屬判斷用 OS 的程序樹，不信任繼承來的環境變數；tmux、ssh、wsl 視為邊界（`terminal_app.py:15`、`shell-common.sh:90-122`）。
- 匯出的能力表把不合理的組合擋在選單之前（`export-capabilities.ts`）。
- `snapshotScope` 把 UI 規則與 scope 檔合併成單一值（`config.ts:434-452`）。
- 截圖記下實際的 `display_id`。
- AI 的「有活動、未記錄」探針不讀內容，有測試掃描（`agent-activity-probe.ts:5-10`）。這是 F2 的範本。

## 看起來不對、其實是刻意的

- `nc`、`ncat`、編輯器走 native，`ssh` 走 pty（`command-class.json` 的說明；`USER-GUIDE.md:85-100`）。
- Windows 不做 shell-source 安裝，以免寫進一個捏造的 `.bashrc`（`hooks-manager.ts:869-878`，Audit P0-3）。錯的是選擇器仍提供 Git Bash（F3）。
- `redlog stop` 是永久的（FR-022），終端不會被說服回到別的專案（FR-010）。F7 只把「回到同一個專案」改成恢復，不碰這兩條。
- 內建 pane 以 `-ExecutionPolicy Bypass` 啟動，所以在 Restricted 下仍會記錄（`RecordTerminalFlow.tsx:392-399`）。
- `routeTerminals` 預設關閉，而且只作用於新的 pane（`zh-TW.json:3`）。

## UNCONFIRMED（需實跑）

- U1：p10k instant prompt 下，RedLog 的 banner 是否觸發警告。容器：zsh、oh-my-zsh、p10k、預設的 `POWERLEVEL9K_INSTANT_PROMPT`。
- U2：macOS Terminal.app 預設的 login bash，`.bash_profile` 不 source `.bashrc` 時，安裝後新開分頁是否沒有 hook、設定頁是否顯示已安裝。
- U3：Windows 的 VS Code PowerShell 擴充主控台與 ISE 是否不載入 hook；安裝 RedLog 之後才裝 pwsh 7 的情況。
- U4：zsh 父 shell 裡跑 `bash`、`tmux`、`htop`、`sudo -s`、`docker exec -it` 時，relay 的 body、事件數、`PAGER` 的繼承（F10）。
- U5：VS Code bash shell integration 與 RedLog 每個 prompt 重新串接 DEBUG trap 時，是否重複觸發。
- U6：VS Code「解析 shell 環境」的 `$SHELL -ilc` 是否每次都留下一個 enrollment 檔與 tool-detection 報告。
- U7：stow 管理的 `.zshrc`：安裝後 dotfiles repo 是否出現帶絕對路徑的區塊。
- U8：Windows 上裝了 WSL 的機器，首次使用的選擇器是否出現可點的 Bash，點下去是否得到「安裝失敗」。
- U9：PowerShell 移除後，原本是 LF 的 profile 是否變成 CRLF。
- 更新頻道的範圍與選擇：本次沒有檢查。
