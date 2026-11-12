# Topic C：終端／HTTP／操作者紀錄器的設計，以及多來源狀態的呈現

讀取日期：2026-11-12。凡標「未驗證」者，是依記憶寫的，沒有取得一手來源，不可當作已查證的依據。引文都在 15 字以內。

## 0. 一頁摘要

| 主題 | 收斂設計（≥3 個系統一致） | 最小可採用版本 | 主要來源 |
|---|---|---|---|
| 1. 指令邊界 | 由 shell 自行送出 in-band 的 OSC 標記：A=提示開始、B=提示結束、(E=指令文字)、C=開始執行、D;exit=結束，另有 P;Cwd。注入點用各 shell 原生的 preexec／precmd 掛鉤。VS Code、iTerm2、kitty、Warp、Atuin 都是這套做法 | 自定一組 OSC（形式仿 633），帶 nonce。zsh 用 `preexec_functions`／`precmd_functions`；bash 用 DEBUG trap 加執行旗標，precmd 接在 `PROMPT_COMMAND`；PowerShell 包住 `prompt` 與 `PSConsoleHostReadLine`。依實際收到的序列判定 none／basic／rich，並顯示給使用者 | code.visualstudio.com shell-integration；iterm2 escape codes；kitty；warp blog |
| 2. 輸出錄製格式 | NDJSON：第一行 header，之後每行一個事件 `[time, code, data]`；預設不錄輸入；有 resize／marker／exit 事件。tlog 另加序號 `id`、絕對位置 `pos`，非法 UTF-8 拆到 `_bin` | 內部用「chunk 序號＋單調絕對毫秒 offset＋o/i/r/m/x」，可保證完整性並偵測缺口；匯出時轉成 asciicast v3（相對 interval）供播放。i 事件預設關閉。設大小上限，超過就丟棄並寫一筆缺口標記，不讓操作者等待 | asciicast v2/v3 規格、tlog log_format、script(1)、sudoers |
| 2b. 寫不進去時 | 有兩種立場：sync 失敗即中止 session（Teleport sync、sudo 預設）；async 先寫本地緩衝、事後補傳（Teleport async） | 單機工具採 fail-open，但每段遺失都要成為一筆可見的缺口事件（gap record），不得默默遺失 | goteleport session-recording；sudoers `ignore_iolog_errors` |
| 3. HTTPS 攔截上線 | CA 每台安裝一份並由使用者信任。各工具都把「proxy 在跑」「這個 client 經過它」「TLS 被信任」分開判斷：mitm.it 只有流量經過 proxy 才打得開；HTTP Toolkit 有 Connected Sources；Proxyman 會顯示「Installed and Trusted」 | 四個獨立的 condition：ProxyListening／ClientRouted（看到該 client 的第一個 request）／TlsTrusted（同一 client 有一次 handshake 成功；`unknown_ca` 一類 alert 則記為 per-host 失敗）／Recorded（flow 已寫入儲存）。每個 client 個別注入（env＋CA 檔），不改系統信任 | docs.mitmproxy certificates；httptoolkit intercept-page；proxyman docs |
| 3b. Scope | ZAP「預設沒有東西在 scope 內」；Caido 的 scope 只過濾檢視；Burp「out-of-scope 不寫入 history」是要自己打開的選項，而且常被誤解 | 全部擷取，scope 只用在顯示與標記。「尚未定義 scope」本身是一個明示的狀態，不當成全部在 scope 內 | zaproxy scope；docs.caido.io scope；portswigger scope＋forum |
| 4. 操作者紀錄 | Ghostwriter `OplogEntry`：start/end、source/dest、tool、user_context、command、description、output、comments、operator、tags、extra_fields、`entry_identifier`。TIBER 要求「附時間戳的 log」與殘留 artefact 清單 | 機器擷取的欄位一律不可變，人工註解分開存（避免 mythic_sync 那種覆蓋）；`entry_identifier` 由「來源＋原生 id」組成；附 artefact 清單（path/hash/host/IP） | Ghostwriter models.py；ghostwriter.wiki；ECB TIBER RTTR guidance 2025 |
| 5. 多來源狀態 | K8s Conditions（type、status True/False/Unknown、reason、message、lastTransitionTime；沒有該 condition 等同 Unknown）；systemd 把 load／active／enabled 分成獨立的軸；Elastic 分 expected 與 observed state；Docker 的 start-period 內失敗不計 | 每個來源只用 6 個固定詞：Off／Waiting／Live／Idle／Degraded／Broken，再加 `reason`（enum）、`message`、`since`、`firstEventAt`、`lastEventAt`，以及最多一個 action。「有證據成功過」(`firstEventAt`) 與「最近有沒有事件」分開記錄。Idle 不算錯誤 | k8s api-conventions；systemctl(1)；elastic-agent-client.proto；docker HEALTHCHECK；syncthing GUI |

---

## 1. 指令邊界：開始、結束、exit code、cwd、輸出

### 1.1 協定層：FinalTerm / OSC 133 → iTerm2 → VS Code OSC 633

**要解決的問題**：終端模擬器只看得到 byte stream，分不出哪裡是提示、哪裡是指令、哪裡是輸出。shell integration 的做法是讓 shell 在固定時點自己印出不可見的標記。

**機制**
- **OSC 133（FinalTerm，iTerm2 有文件）**：`A` 在提示開始前送出，`B` 在提示後、使用者輸入前，`C` 在輸出開始前，`D;[Ps]` 表示指令結束，`Ps` 是 exit status。兩條值得照抄的規則：先有 B、後來的 D 沒帶 `Ps`，代表指令被放棄、狀態要丟棄；之前沒有 B 也沒有 C 的 D 一律忽略。https://iterm2.com/documentation-escape-codes.html
- **iTerm2 的擴充**：`OSC 1337;CurrentDir=`、`RemoteHost=user@host`，以及合併兩者的 `OSC 7;file://host/path`。另有 `ShellIntegrationVersion=<ver>;<shell>`，iTerm2 看到版本比自己舊就會提示升級。這等於腳本版本的握手，值得借用。文件也提到這些私有碼在 tmux/screen 裡「may not work properly」。（同上）
- **VS Code OSC 633**（https://code.visualstudio.com/docs/terminal/shell-integration）：
  - A/B/C/D 的意義同 133。另外有 `E;<commandline>;<nonce>`，明確送出 shell 實際解析的指令文字；`P;Cwd=`、`P;HasRichCommandDetection=True`。
  - nonce 用來確認序列真的出自 integration 腳本，防止程式輸出偽造指令（command spoofing）。腳本啟動時把 `VSCODE_NONCE` 從環境變數讀出後立刻 unset，避免子行程讀到（見 PowerShell 腳本的註解「getting it out of the environment」）。
  - 轉義：`\` 變 `\\`，`;` 變 `\x3b`，小於 0x20 的字元變 `\xHH`。bash 腳本對 2000 字元以上的指令改走「快速路徑」，只轉義 `\` 與 `;`，控制字元不處理。這是效能上的取捨，也是一個實際的漏洞面。https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh
  - **品質等級**：None 表示未啟用；Basic 表示有啟用但偵測不完整，例如拿不到 exit status；Rich 表示序列依 A、B、E、C、D 的順序到達。等級是從實際觀察到的序列推出來的，不是從設定推出來的。這一點是本主題最可直接借用的設計。
  - **使用者看得到的狀態**：hover terminal tab 後選 Show Details。官方頁面沒有寫失敗通知。第三方擴充（Roo Code）有「5 秒內沒收到 `633;A` 就停用」的逾時判斷（https://github.com/RooCodeInc/Roo-Code/issues/2600，屬二手來源）。
- **kitty**：在 C 標記裡帶 `cmdline`（fish 用 `cmdline_url`）。zsh 的次要提示用 `k=s`。文件寫 zsh 的 B 標記被註解掉，因為 kitty 用不到。https://sw.kovidgoyal.net/kitty/shell-integration/
- **Warp**：每種 shell（bash／zsh／fish／PowerShell）各有一份 bootstrap，用 precmd／preexec（bash 走 bash-preexec）印出「escape sequence 包 JSON」，Warp 端解成 typed enum 再分派。Warp 自述這個契約很小，只需要「precmd/preexec 的等價物，加上能印任意 bytes」。https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment 。舊的 PS1 文章提到 JSON 裡的 emoji 曾讓 hook 壞掉，後來簡化了 shell 腳本（https://www.warp.dev/blog/whats-so-special-about-ps1 ，經搜尋摘要得知，未全文閱讀）。這是「payload 編碼要夠保守」的實例。

**收斂點**：VS Code、iTerm2、kitty、Warp、Ghostty 全部走「shell 在 in-band 主動報告」這條路，沒有一家靠解析輸出去猜提示。差異只在 payload 形式：VS Code 用分號分隔加轉義，Warp 用 JSON 包在 DCS 裡，kitty 是 key=value。

### 1.2 各 shell 的掛鉤點

| Shell | 指令前 | 指令後／提示前 | 拿 exit code | 坑 |
|---|---|---|---|---|
| zsh | `preexec`，有 3 個參數：使用者輸入、精簡單行、展開 alias 後的全文 | `precmd`（重繪提示時不會重跑） | precmd 第一行讀 `$?` | `zshaddhistory` 的回傳值可以決定不存（1）或只存記憶體（2）。https://zsh.sourceforge.io/Doc/Release/Functions.html 。要用 `*_functions` 陣列，不要覆寫函式本身 |
| bash | 沒有原生 preexec。常見做法是 `trap … DEBUG` 加一個「本輪已觸發」旗標 | `PROMPT_COMMAND`；5.1 起可以是陣列（bash NEWS） | 在 PROMPT_COMMAND 第一個動作讀 `$?`，之後用 `return $status` 還原 | 細節見下 |
| bash ≥4.4 | `PS0`：讀完完整指令後、執行前展開並顯示（bash NEWS 4.4） | — | — | VS Code 腳本**沒有用 PS0**，只用 DEBUG trap 或 bash-preexec。PS0 只能透過展開來印東西；裡面的 command substitution 在子 shell 執行，改不了父 shell 的狀態（後半句是記憶，未驗證） |
| fish | `fish_preexec` 事件 | `fish_postexec` 事件 | `$status` | `fish --private` 不會被 Atuin 記錄。https://docs.atuin.sh/latest/guide/shell-integration/ |
| PowerShell | 包住 `PSConsoleHostReadLine`，送出行後發 E、C | 覆寫 `function Global:Prompt`，先發 D 再發 A | VS Code **只讀 `$?`**，換成 `[int]!$?`，不讀 `$LASTEXITCODE`，所以原生程式的實際 exit code 會遺失 | 在 Windows 10 上不帶 nonce，因為「seems to echo」。https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1 。PSReadLine 的 `AddToHistoryHandler` 可以回 `MemoryAndFile`／`MemoryOnly`／`SkipAdding`。https://learn.microsoft.com/en-us/powershell/module/psreadline/set-psreadlineoption |

**VS Code bash 腳本的具體做法**（同上 bash 腳本）：
- 遞迴防護：已經有 `VSCODE_SHELL_INTEGRATION` 就直接 return。
- 偵測到 `bash_preexec_imported` 時，把自己掛進 `preexec_functions`／`precmd_functions`；否則用 `trap -p` 讀出既有的 DEBUG trap，自己的 preexec 跑完後再 `eval` 原本的 trap 內容。
- 用 `__vsc_in_command_execution` 旗標保證每個指令只觸發一次 preexec。
- 指令文字預設用 `history 1`；但 `HISTCONTROL` 含 ignoredups／ignorespace／erasedups 時改用 `$BASH_COMMAND`，代價是拿到的可能是 alias 展開後的結果。
- PROMPT_COMMAND 被當純量處理，註解自承陣列只會處理第一個元素（handling only the first entry）。這是**已知缺陷**；bash 5.1 之後應該 append 一個陣列元素。

**bash-preexec 的已知問題**（https://github.com/rcaloras/bash-preexec 與 issues 頁）：
- 必須是 profile 裡**最後一個** source 的檔案；支援 bash 3.1 以上。
- 子 shell 預設不觸發 preexec。`__bp_enable_subshells` 是實驗功能，因為和 functrace／DEBUG trap 互動有 bug（#25「Background subshells may finalize session」）。
- 其他 open issues：#162 用了 SIGINT trap 時 preexec 會被呼叫兩次；#52 被保留的 DEBUG trap 應該每次都跑；#147、#104 有些指令不觸發；#6 函式宣告不觸發；#156 含 pipeline 的指令很慢；#174 在 bash 5.3.3 無法運作。

### 1.3 歷史資料庫：Atuin（McFly 與 zsh-histdb 未取得一手來源）

- **記錄內容**：preexec 時記指令文字、時間戳、cwd，並設一個暫時的 `ATUIN_HISTORY_ID`；precmd 時補上 exit code 與 duration。這是**兩階段寫入**：開始時建一筆開放紀錄，結束時關閉。https://docs.atuin.sh/latest/guide/shell-integration/
- **bash 後端**：推薦用 ble.sh，理由是計時準確、ignorespace 正確；bash-preexec 被描述為在子 shell 與 ignorespace 上有限制。前導空白的指令即使不進 Atuin，在 bash-preexec 下仍可能留在 bash 自己的 history 裡。https://docs.atuin.sh/latest/guide/excluding-commands/
- **秘密過濾**：`secrets_filter` 預設開啟，辨識得出 AWS／GitHub／OpenAI／Anthropic 等 key 的指令整筆不記錄。`history_filter` 是不錨定的 regex。`cwd_filter` 針對目錄。過濾只影響從那之後的紀錄，舊資料要用 `atuin history prune` 清除。（同上頁）
- **已知問題**：SQLite 在部分 ZFS 設定下會拖慢 shell，在 NFS 上不可靠。https://docs.atuin.sh/latest/known-issues/ 。這提醒我們：hook 路徑上不能有同步 I/O 等待。
- **同步**：端對端加密，金鑰存在本地，遺失就無法復原，預設每小時同步一次。https://docs.atuin.sh/latest/guide/sync/ 。單機工具用不到這部分。

### 1.4 被明白寫出、至今未解的問題

| 情境 | 來源的說法 |
|---|---|
| 子 shell | VS Code 自動注入對 sub-shells 無效；bash-preexec 預設不支援；kitty 在 `exec zsh`／`sudo -E zsh`／tmux 下不會自動注入 |
| ssh 到遠端 | VS Code：純 ssh 不支援，除非用 Remote-SSH 或在遠端手動安裝；pam_tty_audit 只看本地 TTY 狀態，因此遠端輸入的密碼會被本地紀錄 |
| tmux／screen | iTerm2：私有碼在 tmux/screen 下「may not work properly」；kitty 的 tmux 不注入 |
| 複合指令、函式宣告 | bash-preexec #6、#147、#104 |
| 背景 job | bash-preexec #25；其餘專案沒有討論（未驗證） |
| 永不返回的指令 | 沒有任何來源給出設計。OSC 133 只定義了「沒有 B／C 的 D 要忽略」 |
| 被 plugin 破壞 | VS Code：某些 plugin 會 unset `VSCODE_SHELL_INTEGRATION`；PROMPT_COMMAND 格式不支援時會阻擋注入 |
| Windows ConPTY | 序列可能錯位，VS Code 用啟發式修正 |
| 繞過 PTY 層紀錄 | Teleport 承認 PTY 錄製可以被編碼、腳本、改 terminal 設定繞過，所以另外有 eBPF 的 enhanced recording。https://goteleport.com/docs/reference/architecture/session-recording/ |

### 1.5 怎麼確認 integration 真的有在運作

- VS Code 依實際序列判定 None／Basic／Rich（見 1.1）。
- iTerm2 用 `ShellIntegrationVersion` 握手，版本舊就提示升級。
- zoxide 的 `__zoxide_doctor` 每次 `z` 時檢查自己的 hook 是否還在 `precmd_functions`／`chpwd_functions` 裡，不在就印一次警告，而且每個 session 最多一次。這是**執行期自我檢查**，不是只在安裝時檢查一次。https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/templates/zsh.txt 。有回報指出某些 shell 快照工具不會保存 hook 陣列，導致 doctor 誤報（二手來源）。
- 安裝順序是共同的痛點：bash-preexec 要求放在最後；zoxide 的警告文字要求 init「at the end」。

### 1.6 什麼可以搬過來、什麼不行

- **可以搬**：OSC A/B/E/C/D/P 的狀態機、nonce、轉義規則（不要另做快速路徑）、從觀察推出品質等級、Atuin 的「開始時開放紀錄、結束時關閉」、執行期 doctor、各 shell 的掛鉤點與 PowerShell 的 exit code 缺口。
- **不能搬，或不需要**：Atuin 的同步；Warp 從 shell 反向取補全；Teleport 的 eBPF（需要 root 與 kernel 5.8 以上，單機桌面工具的成本過高）。
- 最小可採用版本見第 6 節。

---

## 2. 錄製輸出

### 2.1 格式比較

| 格式 | 時間 | 事件 | 二進位／非法 UTF-8 | 完整性 |
|---|---|---|---|---|
| `script` classic | `delay nbytes` 兩欄 | 只有輸出 | 原始 bytes 存在 typescript 檔 | 無 |
| `script` advanced | 第一欄 I/O/H/S 表示類型，加上距前一筆的時間 | 輸入、輸出、header、signal | 同上 | 無。https://man7.org/linux/man-pages/man1/script.1.html |
| sudo iolog | `timing` 檔：類型 0–7、距前一筆時間、資料 | ttyin/ttyout/stdin/stdout/stderr 分檔，另有 `log`、`log.json` 中繼資料 | 原始 bytes，gzip 壓縮 | 緩衝寫入，指令結束前不完整 |
| asciicast v2 | 自錄製開始起的絕對秒數 | o/i/m/r | JSON string escape | 無 |
| asciicast v3 | 與前一事件的**相對間隔** | o/i/m/r/**x**（exit），`#` 註解行 | 同上 | 無 |
| tlog | `pos`（絕對 ms）＋`timing` 字串（`+N` 延遲、`<N`／`>N` 文字、`[R/B`／`]R/B` bin、`=WxH` 視窗） | in/out/window | `*_txt` 放替換後的文字，`*_bin` 放被替換掉的原始 bytes | `id` 從 1 起逐筆遞增；播放器遇到亂序或缺訊息預設停止，加 `--lax` 才繼續 |

來源：https://docs.asciinema.org/manual/asciicast/v2/ ，https://docs.asciinema.org/manual/asciicast/v3/ ，https://github.com/Scribery/tlog/blob/main/doc/log_format.md ，https://github.com/Scribery/tlog ，https://www.sudo.ws/docs/man/sudoers.man/

**改版教訓（價值最高的部分）**
- **v1→v2**：從單一 JSON 改成 NDJSON，好處是可以增量寫入、記憶體用量低，**錄到一半中斷也不會整份遺失**。
- **v2→v3**：改用相對時間，因為絕對時間下「新增、刪除、修改一個事件，之後所有事件的時間戳都得調整」。https://blog.asciinema.org/post/three-point-o/ 。v3 的 header 把 terminal 資訊收進 `term`，新增 `x` exit 事件，以及 `#` 註解。規格也要求取捨入時用 error diffusion（Bresenham）避免累積漂移，並規定未知的 header 欄位與事件 code 都必須忽略。
- **對本系統的含意**：v3 是為了**方便編輯**才改用相對時間；而 system of record 不希望被編輯，反而需要絕對 offset 才能逐 chunk 驗證、偵測缺口。tlog 兩者都有，`pos` 是絕對值，`timing` 是 chunk 內的相對值。**建議儲存時用 tlog 的思路，匯出時轉成 v3。**
- tlog 的 `ver` 用 major.minor：minor 增加是相容的新增，舊程式忽略即可。

### 2.2 錄製器架構

- asciinema、script、sudo 的 log_input／log_output 都是開一個 PTY，在 master 端複製讀到的 bytes。sudo 文件明講只要有 terminal，就在 pseudo-terminal 裡執行指令。asciinema CLI 的錄製器細節頁面 404，PTY 部分是記憶，未驗證。
- tlog 不自己定檔案格式，**直接把訊息丟給 journald／syslog**，分 2kB 的 payload（rsyslog 的 `$MaxMessageSize` 要再大約 1k）。
- 防竄改：`tlog-rec-session` 建議用專屬的 SUID/SGID 使用者執行，讓被錄的人碰不到錄製行程。

### 2.3 大小、速率、輸出量爆量

- `script -o/--output-limit`：超過上限就**停止子行程**。這是 fail-closed，對操作者干擾很大。
- tlog 的 `limit-rate`／`limit-burst`／`limit-action` 有三種動作：`pass`（預設，不限）、`delay`（**拖慢使用者的 terminal**）、`drop`（丟掉超出的部分）。
- sudo：`iolog_flush` 預設關閉；打開後每次寫入都 flush，可以即時觀看，但壓縮效果變差。`compress_io` 預設開。
- mitmproxy 對大 body 的處理類似：串流的 body 不存（見 3.1）。
- 對 alternate-screen 應用（vim／less／top），這幾個格式都只是照錄 bytes，靠播放器去重現。沒有找到任何格式另外標記「進入或離開 alt-screen」。Warp 對 full-screen app 有獨立的顯示處理（https://docs.warp.dev/terminal/more-features/full-screen-apps ），但沒有說明怎麼存。這點未驗證。

### 2.4 不回顯的密碼與輸入紀錄

這一項的收斂程度很高：**輸入紀錄預設關閉**，而且每家都明講原因。
- asciinema：`i` 事件預設不錄，其他錄製器「不應」錄，除非使用者明確要求；`env` 只抓 `SHELL`。（v3 規格）
- `script(1)`：log 會包含所有輸入，「independently of the terminal echo flag」。
- sudo：開了 log_input，密碼「will still be present」在 I/O log 裡。1.9.10 起把 `log_passwords` 設為 false，就會用 `passprompt_regex`（預設 `[Pp]assword[: ]*`）比對**輸出中的提示字串**，把之後的輸入替換成 `*`，直到換行。
- pam_tty_audit：預設不記 echo 關閉且處於 canonical mode 時的輸入，`log_passwd` 才會記。但它承認經由 ssh 時，遠端輸入的密碼仍會被本地紀錄，因為判斷只看本地 TTY 的狀態。https://man7.org/linux/man-pages/man8/pam_tty_audit.8.html
- **兩種識別法**：一是看 echo flag（pam_tty_audit，需要能讀 tty 的 termios），二是用 regex 比對提示字串（sudo）。兩種都會漏，pam 的文件自己就點出 ssh 的漏洞。

### 2.5 寫不進稽核後端時：fail-closed 或繼續運作

- **Teleport**：sync 模式下「failure to emit a recording event is considered fatal」，session 直接中止，資料不落地。async 模式先寫本地磁碟，session 結束後上傳，Auth 掛了 session 照樣繼續。代價是需要磁碟空間，而且資料在上傳前比較容易被竄改；upload completer 每 5 分鐘跑一次，所以補傳最多要等約 35 分鐘。https://goteleport.com/docs/reference/architecture/session-recording/
- **sudo**：`ignore_iolog_errors` 預設關閉，也就是 I/O log 寫不進去時**中止指令**。連 log server 的 keepalive 斷線同樣會中止指令。I/O log 只送遠端，event log 本地與遠端都寫。
- **Teleport enhanced recording（eBPF）**：`session.command` 事件帶 `argv`、`path`、`pid`、`ppid`、`return_code`、`cgroup_id`；`session.network` 事件帶 dst/src 位址與 port。限制包括：root 可以干擾錄製；systemd／cron 啟動的行程不在錄製範圍內；完整路徑、LD_PRELOAD、環境變數可能拿不到。https://goteleport.com/docs/enroll-resources/server-access/guides/bpf-session-recording/
- auditd TTY 只記輸入、不記輸出，用 `aureport --tty` 查看。

**判斷**：fail-closed 的系統都是「組織對使用者」的合規錄製，被錄的人不可信。本系統是操作者自己錄自己，中止操作者的工作沒有任何好處。應採 Teleport async 的做法，但要補上 Teleport 沒做的一件事：**遺失本身要寫成紀錄**。

### 2.6 什麼可以搬過來、什麼不行
- **可以搬**：NDJSON＋header；o/i/r/m/x 事件；tlog 的 `id`＋`pos` 與 `_bin` 拆分；script 的 `--flush` 與 SIGUSR1 按需 flush；sudo 的提示 regex 遮罩；輸入預設關閉。
- **不能搬**：tlog 送 syslog 與 SUID 隔離（單一使用者，沒有對手）；sudo 的 log server；Teleport 的 proxy／node 模式與 upload completer（沒有遠端）。

---

## 3. 攔截 proxy 的 HTTP(S) 歷史

### 3.1 資料模型與大 body

- **mitmproxy**：每個 flow 有 request、response、error 三部分。filter 可以表達 `~q`（有 request 還沒有 response）、`~s`（有 response）、`~e`（有錯誤）、`~marked`、`~replay`、`~websocket`。https://docs.mitmproxy.org/stable/concepts/filters/ 。也就是說，**「沒有 response」與「錯誤」是可以查詢的正式狀態**，不是缺資料。
- `stream_large_bodies` 超過門檻就直接串流，**這個 body 在 mitmproxy 內無法取用，也不能修改**，header 仍會完整緩衝。https://docs.mitmproxy.org/stable/overview/features/
- 存檔與顯示是兩個獨立的 filter：`save_stream_file` 加 `save_stream_filter` 決定寫入哪些，`view_filter` 決定看到哪些；`hardump` 在結束時存 HAR；`ignore_hosts` 讓流量完全不經處理直接轉送。https://docs.mitmproxy.org/stable/concepts/options/ 。flow 檔的內部編碼（tnetstring）是記憶，未驗證。
- **Burp**：Status 欄空白表示沒收到 response，此時沒有 Response 分頁（PortSwigger 論壇客服的回覆，屬二手來源：https://forum.portswigger.net/thread/no-details-for-proxy-history-7377130d ）。有舊版本回報專案檔重開後 history 筆數變少（2020.1）。
- **Caido**：scope preset 只比對 host（Host header 或目的 IP），path 要用 HTTPQL filter preset；preset 綁定在專案上。https://docs.caido.io/guides/scope 。findings 與 history 的關係沒有取得一手來源，未驗證。

### 3.2 HAR 1.2 的限制

- 規格頁本身標示「DO NOT USE」，並說明 W3C 從未發布、已經放棄。https://webperfwg.org/specs/HAR/Overview.html
- 未知的大小填 -1，不適用的 timings 填 -1，`text` 可以是 base64 加上 `encoding`；自訂欄位必須以 `_` 開頭，parser 要忽略不是自己寫的自訂欄位。
- 規格沒有涵蓋 WebSocket、HTTP/2、串流與截斷標記，也沒有「沒有 response」的正式表示法。Chrome 用 `_webSocketMessages`、`_initiator` 等欄位補足，這部分是記憶，未驗證。
- 規格要求工具在使用者分享 HAR 前**提醒其中可能含敏感資料**。

### 3.3 CA 信任上線：如何分辨四個層次

| 層次 | mitmproxy | HTTP Toolkit | Proxyman |
|---|---|---|---|
| proxy 在跑 | 自行啟動 | app 內 | app 內 |
| **這個 client 有經過 proxy** | 在裝置上打開 `mitm.it`：只有流量經過 proxy 時這頁才打得開，因此打得開本身就是證明 | 「Connected Sources」只列出**真的被攔截到流量**的 client；設定正確但還沒發 request 的不會出現 | iOS 指引最後要確認畫面顯示「Ready to intercept」 |
| **TLS 被信任** | 每個平台有各自的手動步驟；iOS 另外要打開 full trust；pinning 的 app 一定失敗，建議 ignore 該 host | 每個 client 個別注入：新開的 terminal 帶 `HTTP_PROXY` 等環境變數，並用 PATH wrapper（例如 `node`）注入 CA，不改系統信任；JVM attach 成功時顯示綠勾 | macOS 顯示「Installed and Trusted」；SSL Proxying 依 app／domain 個別開啟 |
| 已記錄 | 看 `save_stream_file` 的設定 | — | — |

來源：https://docs.mitmproxy.org/stable/concepts/certificates/ ，https://httptoolkit.com/docs/reference/intercept-page/ ，https://docs.proxyman.com/debug-devices/macos ，https://proxyman.com/posts/2021-10-17-Getting-Started-With-Proxyman-For-iOS ，https://docs.proxyman.com/features/ssl-proxying 。HTTP Toolkit 用 `SSL_CERT_FILE` 一類變數只見於第三方文章，未驗證。Charles 的 session 檔與上線流程沒有取得來源，未驗證。

**收斂點**：沒有一家拿「proxy 在跑」當成功。三家都有「這個 client 已經被看到」的獨立訊號。HTTP Toolkit 的 Connected Sources 是最乾淨的設計：**狀態由觀察到的流量推出，不由設定推出**。這與 VS Code 從序列推出品質等級是同一個原則。

### 3.4 Scope：影響擷取、顯示，還是測試動作

- **ZAP**：scope 由 Context 組成，「By default nothing is in scope」。Protected mode 下危險動作只能對 scope 內執行；ATTACK mode 會自動掃描新發現的 in-scope 節點；History 分頁的顯示受 scope 影響。out-of-scope 流量是否仍寫進 session DB，頁面沒寫，未驗證。https://www.zaproxy.org/docs/desktop/start/features/scope/
- **Burp**：分 normal（URL prefix）與 advanced（protocol／host regex／port／path 全部要符合）兩種。scope 可以用來過濾 history 與 site map 的顯示、只 intercept in-scope、讓 live task 只掃 in-scope。https://portswigger.net/burp/documentation/desktop/tools/target/scope 。「Don't send items to Proxy history or live tasks, if out of scope」是 1.7.18 加入的選項，第一次加入 scope 時會詢問。使用者常搞混 history logging 設定與這個 Misc 選項，有人以為已經停止記錄，實際上仍在記錄（論壇，屬二手來源：https://forum.portswigger.net/thread/cannot-re-disable-logging-out-of-scope-items-to-the-history-eee4baa9 ）。
- **Caido**：Out of Scope 清單是 deny list，會從 traffic table 與操作中「excluded」。是否仍存進專案，文件沒寫，未驗證。
- **收斂點**：三家都把 scope 主要當作**顯示與主動動作的閘門**；「擷取時就丟棄」要嘛不存在，要嘛是要自己打開、而且容易誤會的選項。ZAP 明確把「未定義 scope」設為空集合。

### 3.5 什麼可以搬過來、什麼不行
- **可以搬**：flow 的 request／response／error 三態，以及「還沒有 response」可以查詢；大 body 只存 metadata、雜湊與截斷旗標（借 mitmproxy stream 的語意，但要**明示**被略過）；存檔 filter 與檢視 filter 分開；HAR 匯出用 `_` 欄位並附上提醒；client 由觀察推出（Connected Sources）；scope 只管顯示。
- **不能搬**：Burp／ZAP 的主動掃描與 ATTACK mode（本系統不是攻擊工具）；裝置 VPN 攔截（行動裝置不在範圍內）。

---

## 4. 攻擊方的操作者／engagement 紀錄

### 4.1 Ghostwriter oplog（收斂度最高的公開資料模型）

`OplogEntry` 的欄位，取自 https://github.com/GhostManager/Ghostwriter/blob/master/ghostwriter/oplog/models.py ：
`entry_identifier`（help text 說給 integration 追蹤用；**不是 unique**，只有和 `oplog_id` 組成的非唯一索引）、`start_date`、`end_date`、`source_ip`（Source IP / Hostname）、`dest_ip`、`tool`、`user_context`、`command`、`description`（「why you executed」）、`output`、`comments`、`operator_name`、`tags`、`extra_fields`（JSON）、`updated_at`、`oplog_id`。

**同步設計的教訓**（https://www.ghostwriter.wiki/features/operation-logs/setting-up-automated-logging.md ）：
- **cobalt_sync**：Cobalt Strike 不會把 console 輸出和產生它的指令連起來，所以**無法自動填 output**。
- **mythic_sync**：Mythic 會把輸出連到指令，所以輸出到達時會**更新先前建立的紀錄**，同時**覆蓋**使用者在 Ghostwriter 裡先加上的內容。這是「機器欄位與人工欄位混在同一列」的直接後果。
- 建議用範圍限定在單一 oplog 的 service token，不要用代表使用者全部權限的 API token。

**Sanitization 稽核**（https://www.ghostwriter.wiki/features/operation-logs/auditing-oplogs.md ）：消毒的定義是保留 metadata 與時間軸，移除主機名、密碼、hash 等內容。系統用「最新 entry 的 `updatedAt` 晚於 `sanitizedAt`」判定需要重審，前提是 `updated_at` 只在內容變更時更新、tag 變更不算（https://www.ghostwriter.wiki/development/database-models/oplog-models.md ）。這是一個很小但完整的「事後修改偵測」設計。Ghostwriter 也支援把 asciinema 錄影附加到 log entry（wiki 索引頁有列出，未展開閱讀）。

### 4.2 其他系統

- **Mythic**：event feed 是即時的操作稽核流，包含 callback、payload build、操作者登入、服務狀態、警告與錯誤；錯誤會一直維持 unresolved，直到有操作者標記為已解決，而且保留在歷史中。artifacts 頁追蹤可能的 IOC，供 deconfliction 使用。https://docs.mythic-c2.net/version-4.0/operational-pieces/event-feed ，https://docs.specterops.io/mythic-docs/reporting/artifacts 。task 與操作者之間的對應有沒有寫進報告，文件中沒找到，未驗證。
- **RedELK**：集中多個 teamserver 的操作 log 與 redirector 流量 log，提供截圖、IOC、keystroke 的檢視。兩個目標：一是長期、多團隊下的搜尋與監督（例如給 White Team 唯讀檢視），二是「Spot the Blue Team」。enrichment 的細節頁面沒寫。https://github.com/outflanknl/RedELK
- **Cobalt Strike**：官方文件連線失敗（TLS 錯誤），logs 目錄的結構未驗證。
- **VECTR**：每個 test case 分紅藍兩側；紅方有 start/stop time、technique、attacker tool、target assets、status；藍方填 outcome（Blocked／Alerted／Logged／none）。只取得第三方來源（https://sra.io/blog/vectr-fundamentals-why-execute-test-cases/ 、https://labs.jumpsec.com/articles/2023/09/2023-09-29-vectr-for-purple-team-engagements ），欄位名稱未驗證。
- **TIBER-EU（ECB 2025 RTTR guidance）**：報告要附「A timeline with the relevant logs」給藍隊重建事件。Artefacts 一節要列出可能殘留的 artefact，用 filename、path、hash、hostname、IP、email、domain 描述，且「must substantiate…with clear evidence (e.g. log files with timestamp, screenshots)」。https://ecb.europa.eu/pub/pdf/annex/ecb.tiber_red_team_test_report_guidance_2025.en.pdf
- PTES／OSSTMM 的紀錄要求、Sliver／Havoc 的 log 格式：未取得一手來源，未驗證。

### 4.3 實務上的痛點（有來源者）
- 手動記錄負擔太重。Ghostwriter 的 oplog 目標寫明要「Reduce the manual logging overhead」，並希望不論用哪個工具都能自動記錄每個指令；shell history、ssh、proxychains 也列在擴充目標內。https://specterops.io/blog/2020/09/30/updates-to-ghostwriter-ui-and-operation-logs/
- 輸出與指令連不起來（cobalt_sync）。
- 自動更新覆蓋人工註解（mythic_sync）。
- 有學術論文指出 red team log 普遍雜亂、不一致（ICCWS 論文，僅見搜尋摘要，未全文閱讀，未驗證）。

### 4.4 什麼可以搬過來、什麼不行
- **可以搬**：Ghostwriter 的欄位集；以 `entry_identifier` 對應原生來源 id；「updatedAt 與 sanitizedAt 比較」的消毒稽核；Mythic 的「錯誤必須明確 resolve，並留在歷史裡」；TIBER 的 artefact 欄位。
- **不能搬**：C2 同步（本系統是被動記錄者）；多操作者協作與 token 權限（單一使用者）；RedELK 的 redirector 監控（屬攻擊基礎設施）。

---

## 5. 多來源狀態的呈現

### 5.1 各系統的狀態詞彙

| 系統 | 詞彙 | 設計重點 |
|---|---|---|
| K8s Conditions | `type`、`status`=True/False/Unknown、`reason`（必填，CamelCase）、`message`、`lastTransitionTime`、`observedGeneration` | **沒有該 condition 等同 Unknown**；controller 第一次處理資源時就要設一個 Unknown，代表已經開始協調。棄用 `phase` 狀態機，因為新增 enum 值會破壞相容性；conditions 是觀察結果，不是狀態機。polarity 依人類可讀性選，不強求「True 一定代表好」。https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md |
| K8s probes | startup／liveness／readiness | startup 成功前，另外兩種 probe 不跑；liveness 失敗就重啟；readiness 失敗只是不接流量、不重啟。文件警告 liveness 實作錯誤會造成連鎖失敗。https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/ |
| systemd | LOAD（定義是否成功解析）、ACTIVE（active／inactive／failed／activating…）、SUB（依 unit 類型而定的細節）；enable 是獨立的另一軸 | enable 與 start「orthogonal」。failed 和 inactive 的差別只在於「因錯誤而停止」。https://www.freedesktop.org/software/systemd/man/latest/systemctl.html |
| Docker HEALTHCHECK | starting → healthy／unhealthy | `--start-period` 內的失敗**不計入** retries；期間內只要成功一次就視為已啟動；`--retries` 預設 3。https://docs.docker.com/reference/dockerfile/ |
| Elastic Agent（unit 層） | STARTING／CONFIGURING／HEALTHY／DEGRADED（非致命錯誤）／FAILED（致命錯誤）／STOPPING／STOPPED；外加 `message` 給人看 | 分成 **expected state 與 observed state**。https://github.com/elastic/elastic-agent-client/blob/main/elastic-agent-client.proto |
| Elastic Fleet（agent 層） | Healthy／Unhealthy／Updating／Offline（5 分鐘沒有 check-in，固定值）／Inactive／Unenrolled／Orphaned | degraded 與 error 都對應到 unhealthy；`unhealthy_reason` 分 input／output／other。https://www.elastic.co/docs/reference/fleet/monitor-elastic-agent |
| Grafana Alloy | Unknown／Healthy／Unhealthy／Exited | 由「參數評估」「執行期」「元件自報」三者合成。**元件的健康不受它引用的元件影響**。評估失敗時標為 unhealthy，但用上一份有效設定繼續跑。https://grafana.com/docs/alloy/latest/get-started/component_controller/ |
| Fluent Bit | healthy／unhealthy | 在 `HC_Period`（60s）內，錯誤數或 retry 失敗數超過門檻（各 5）才算 unhealthy。input 被暫停另有 `ingestion_paused` 這個 gauge。https://docs.fluentbit.io/manual/administration/monitoring |
| Datadog Agent | Running Checks 清單，每個 check 顯示 Total Runs、Metric Samples、Events、Service Checks、Average Execution Time | 文件說，設定正確的 integration 會出現在 Running Checks 而且沒有警告。https://docs.datadoghq.com/agent/configuration/agent-commands/ 。Instance 的 OK／WARNING／ERROR 與「Last Successful Execution Date」是記憶，未驗證 |
| Statuspage | Operational／Degraded performance／Partial outage／Major outage／Under maintenance | 頂層彙總：任一元件 Major outage，頂層就顯示「Partial System Outage」，**並不是直接取最壞的那個詞**。https://support.atlassian.com/statuspage/docs/top-level-status-and-incident-impact-calculations （搜尋摘要） |
| Syncthing | Unknown（GUI 載入中）／Unshared／Paused／Stopped（遇錯停止）／Up to Date／Waiting to Scan／Scanning／Waiting to Sync／Preparing to Sync／Syncing／Cleaning Versions／Local Additions | 「排隊中」與「執行中」分開；Unknown 只代表 UI 還沒拿到資料。https://docs.syncthing.net/intro/gui |

OBS、VS Code language server 狀態列、GitHub Actions、Dropbox／Time Machine／Backblaze 的用詞都沒有取得一手來源，未驗證。

### 5.2 從這些系統抽出的設計規則

1. **把軸分開**：「有沒有設定或啟用」（systemd enable、LOAD）、「有沒有在跑」（ACTIVE）、「健不健康」（Elastic observed 對比 expected）、「有沒有成功過」（Docker start-period 的「一次成功就算已啟動」）是不同問題。systemd 明說 enable 與 start 正交；Elastic 把 expected 與 observed 分開。
2. **Unknown 是正式值，不是空白**（K8s）；開始處理時就先設 Unknown（K8s 的首次處理、Alloy 的預設值、Syncthing 的 GUI 載入中）。
3. **啟動寬限期**：Docker 的 start-period 與 K8s 的 startup probe 都規定「還沒證明過能運作之前，失敗不計」。
4. **用時間窗口加門檻判定，不因一次錯誤就翻紅**（Fluent Bit 的 HC_Period、Docker 的 retries）。
5. **不要讓上游的問題傳染**：Alloy 的元件健康不受依賴的元件影響；用上一份有效設定繼續跑，同時標為 unhealthy。
6. **彙總不要只取最壞的**：Statuspage 的頂層用詞比元件用詞溫和；Fleet 把 unhealthy 依原因分類計數。單純「最壞的子項代表全部」會讓一個被停用的來源把整體染紅。
7. **reason 是給機器的 enum，message 是給人的文字**（K8s、Elastic 的 `message`）。
8. **lastTransitionTime 要分開記**：狀態從什麼時候開始，和最後一次事件是什麼時候，是兩件事。
9. **錯誤要能被確認、並留在歷史中**（Mythic 的 unresolved 機制）。

### 5.3 需要使用者授權才能運作的工具，其上線模式

- **CLI 掛鉤**：`init` 只負責印出要 eval 的片段，使用者自己貼進 rc；之後靠執行期 doctor 自我檢查（zoxide）、版本握手（iTerm2）、從觀察推出品質（VS Code）。direnv 與 starship 的 verify UX 沒有取得來源，未驗證。
- **macOS TCC**：Apple 論壇指出 `CGPreflightScreenCaptureAccess()` 可以安全地只查詢狀態、不觸發提示；授權後 app 要重啟才會生效；在迴圈裡輪詢 preflight 可能一直回傳 false；權限綁定在 code signing identity 上。https://developer.apple.com/forums/thread/818415 、https://developer.apple.com/forums/thread/819406 （屬論壇二手來源）。Loom／CleanShot／Raycast 的實際流程沒有取得來源，未驗證。
- **HTTP Toolkit**：每個 interceptor 依環境決定可不可用，例如沒裝該 browser 就停用、ADB 要有裝置連上才可用；成功時當場顯示綠勾。

### 5.4 什麼可以搬過來、什麼不行
- **可以搬**：K8s condition 的欄位形狀；Docker 的 start-period；Alloy 的「不傳染」；Fluent Bit 的窗口門檻；Syncthing 的「排隊」與「執行」分開；Statuspage 的溫和頂層。
- **不能搬**：Fleet 的 check-in、Offline、Inactive（沒有遠端 agent）；K8s 依 liveness 自動重啟（單機上的自動重啟應該做成一個 action，讓使用者按，不要靜默執行）；Statuspage 的 incident 流程。

---

## 6. 最小可採用版本

### 6.1 指令邊界擷取（適用 bash 3.2/5.x、zsh、PowerShell）

**協定**（仿 633，用自己的 OSC 編號，避免與 VS Code 衝突）：
```
A                          提示開始
B                          提示結束
E;<escaped cmd>;<nonce>    指令文字（shell 實際解析的那一份）
C                          開始執行（輸出從這裡開始）
D;<exit>[;<nonce>]         結束；沒有 exit 表示被放棄
P;Cwd=<escaped>;<nonce>    / P;Hello=<ver>;<shell>;<nonce>（握手）
```
- 轉義一律用 `\` 開頭加 `\xHH`（處理 `\`、`;`、小於 0x20 的字元），**不設長度快速路徑**。nonce 在啟動時從環境變數讀出後立即 unset。
- **狀態機**：照抄 OSC 133 的規則，「沒有 B 或 C 的 D 忽略」「沒有 exit 的 D 表示放棄」。收到 C 之後若一直沒有 D，在 UI 上標為 `Open`（仍在執行），**不要猜結束時間**。session 結束時仍沒有 D 的，寫成 `end=unknown`。
- **zsh**：`autoload add-zsh-hook`，掛在 `preexec`／`precmd`（`$3` 是展開後的全文，`$1` 是使用者輸入，兩者都存）。precmd 第一行先讀 `$?`。
- **bash 3.2 到 5.x**（相容 3.2，因為 macOS 內建的就是這版）：
  - 偵測到 `bash_preexec_imported` 就改掛進它的陣列。
  - 否則用 DEBUG trap 加 `__x_in_exec` 旗標，並且鏈接既有的 trap（`trap -p` 解析後 eval），precmd 會清掉旗標。
  - `PROMPT_COMMAND`：若 `declare -p PROMPT_COMMAND` 顯示是陣列（5.1 以上），**append 一個元素**；否則插在字串最前面。第一個動作讀 `$?`，最後用 `return $s` 還原。
  - 指令文字：`HISTCONTROL` 沒有 ignore 類設定時用 `history 1`，否則用 `$BASH_COMMAND`，並標記 `cmd_source=bash_command`，讓品質可以降級。
  - 不依賴 PS0（3.2 沒有，而且無法改變父 shell 的狀態）。
- **PowerShell**：保留原本的 `$function:prompt` 再包一層，D 用 `$?` 加上「`$LASTEXITCODE` 在本次是否改變」（要在 E 時記下快照）來補 VS Code 的缺口；E、C 由包住的 `PSConsoleHostReadLine` 送出。
- **品質等級（從觀察推出，不從設定推出）**：`none` 表示 shell 啟動 N 秒內沒收到 Hello 或 A；`basic` 表示有 A／D 但缺 E 或 exit；`rich` 表示依序收到 A、B、E、C、D 且帶 nonce。每個 terminal 各自判定，結果顯示在 UI 上並寫進紀錄（`capture_quality` 欄位）。
- **執行期 doctor**：每次 precmd 確認自己的函式仍在 hook 陣列或 PROMPT_COMMAND 裡；被移除就送一次 `P;Detached`。版本舊於 app 時提示更新（iTerm2 的握手）。
- **擷取的範圍要對使用者明說**：外部 terminal 只能拿到指令、cwd、exit、時間；**只有內建 PTY 才能把 C 到 D 之間的 bytes 當成該指令的輸出**。子 shell、ssh 遠端、tmux 內，除非在那一層也裝了 hook，否則看不到，這一點在 UI 上要明示，不要隱藏。

### 6.2 錄製格式

- **儲存（每段 PTY 錄製）**：`session(id, started_at_wall, term{cols,rows,type}, shell, cwd)`，以及 `chunk(session_id, seq, pos_ms, code, data, data_bin?)`。
  - `seq` 從 1 起連續遞增，`pos_ms` 單調遞增；chunk 是 hash chain 的單位。
  - `code ∈ {o,i,r,m,x,gap}`。非法 UTF-8 照 tlog 的做法拆到 `data_bin`，或整段 base64 加旗標。
- **i 預設關閉**。打開時套用 sudo 式的提示 regex 遮罩（預設 `[Pp]assword[: ]*`、`passphrase`、`token`），擁有 PTY 時再加上 termios 的 ECHO 旗標判斷（pam_tty_audit 式）。兩者任一命中就遮罩，並寫 `m` 標記為「已遮罩輸入」。
- **界限**：每段設 bytes 上限與速率上限，超過時採 **drop 並寫一筆 `gap{reason:"rate_limit"|"size_limit", dropped_bytes}`**。不採 tlog 的 `delay`（會拖慢操作者），也不採 script 的停止子行程。
- **寫入失敗**：fail-open 加本地緩衝，緩衝滿了同樣寫 gap。gap 本身也進 hash chain，所以驗證者看得出缺口，但不會誤判為竄改。
- **匯出**：轉成 asciicast v3（相對 interval、`x` exit、`m` 標記以指令邊界為章節、`#` 註解行放 bundle 的 hash），讓任何 asciinema player 都能播放。必須保留未知欄位與未知 code 時的「忽略」語意。

### 6.3 HTTPS 攔截上線：四個 condition

每個 client（以 terminal session、或 browser profile 為單位）各有一組，形狀仿 K8s condition：
| condition | True 的證據 | False 時的 reason 範例 | 唯一的 action |
|---|---|---|---|
| ProxyListening | listener 已 bind | `PortInUse`、`BindDenied` | 換一個 port |
| ClientRouted | 這個 client **至少一個 request** 進到 proxy（HTTP Toolkit 的 Connected Sources） | `NoTrafficYet`（不算錯誤）、`EnvNotApplied` | 「在這個 terminal 執行：…」 |
| TlsTrusted | 同一 client 至少一次 handshake 用我們的 leaf cert 成功 | `UnknownCA`（client 送出 alert）、`Pinned(host)` 依 host 分開記、`NotTried` | 安裝或信任 CA（依平台給一條指令），pinned 則建議 ignore 該 host |
| Recorded | flow 已提交到儲存並進入 hash chain | `BodySkipped(size)`、`WriteFailed` | 開啟 log |

- 驗證頁仿 `mitm.it`：proxy 自己回應一個只有經過 proxy 才拿得到的 URL，打得開就同時證明 ClientRouted 與（HTTPS 下的）TlsTrusted。
- 依 client 注入：terminal 用 env（`HTTP(S)_PROXY`，加上 CA bundle 變數），不改系統信任庫，關閉 terminal 時即失效。
- flow 有三態：`pending`（`~q`）、`completed`、`error`。沒有 response 是正式狀態，不是缺資料。大 body 只存 metadata、hash、`truncated=true`。
- **Scope**：全部擷取；scope 只決定顯示與標記；狀態有 `ScopeUndefined`、`InScope`、`OutOfScope` 三種，「未定義」不等於全部在 scope 內。HAR 匯出時，自訂欄位一律加 `_` 前綴，並附上含敏感資料的提醒。

### 6.4 來源狀態模型

**固定 6 個詞**（每個來源一個值），再加上欄位：
| 狀態 | 定義 | 是否算問題 |
|---|---|---|
| `Off` | 未設定或已停用（systemd 的 disabled） | 否，不參與彙總 |
| `Waiting` | 已啟用、正在跑、**還沒有任何事件**（`firstEventAt=null`），處於 start-period 內 | 否 |
| `Live` | `lastEventAt` 在窗口內 | 否 |
| `Idle` | 已經有證據成功過（`firstEventAt≠null`）、程序健康，但最近沒有事件 | **否**。被動紀錄器沒有事件，通常只是使用者沒在用 |
| `Degraded` | 在跑，但窗口內錯誤或丟棄超過門檻（Fluent Bit 式），或品質是 `basic` | 是，黃色 |
| `Broken` | 無法運作，例如 bind 失敗、hook 被移除、權限不足、寫入失敗 | 是，紅色 |

- 欄位：`reason`（CamelCase enum，必填）、`message`（給人看）、`since`（lastTransitionTime）、`firstEventAt`、`lastEventAt`、`counters{events, dropped, errors}`（窗口內）、`action?`（**最多一個**，例如「重新安裝 hook」或「信任 CA」）。
- **proven once**：`firstEventAt` 一旦設定就永不清除（除非重新安裝）。它把 `Waiting` 和 `Idle` 區分開：同樣是沒有事件，一個代表「還沒證明過」，另一個代表「證明過、目前安靜」。
- **no events yet**：在 start-period（例如第一次啟用後 10 分鐘，或在使用者開了第一個 terminal 之前）內維持 `Waiting`；超過之後仍沒有事件，就**轉為 `Waiting`，reason 設為 `NoEventsSinceEnabled`，並附 action「做一次測試」**，而不是轉為 `Broken`。只有存在主動證據（例如 hook doctor 回報被移除、bind 失敗）時才判為 `Broken`。
- **彙總**：頂層只看 enabled 的來源，`Off` 與 `Idle` 不參與；顯示「N 個 Live、M 個需要注意」，不顯示單一個最壞的詞。依賴關係不傳染（Alloy 式），例如 proxy 是 `Broken` 時，TLS 相關的 condition 標為 `Unknown`，而不是另外也標成 `Broken`。
- 錯誤轉換（進入 `Degraded` 或 `Broken`）本身也寫成一筆事件，需要使用者確認後才算 resolved（Mythic 式），並留在時間軸上。這對 system of record 很重要：**擷取中斷的區間本身就是證據的一部分**。

### 6.5 操作者紀錄的欄位集

以 Ghostwriter 的欄位為基礎，分兩層：機器擷取（不可變，進 hash chain）與人工註解（另一張表，可編輯，也有自己的 hash 鏈）。

**機器層**：
- `id`、`entry_identifier`（由 `source_kind:native_id` 組成，例如 shell 的 `session_id:seq`，或 proxy 的 `flow_id`）
- `start_ts`、`end_ts`（可為 null，表示 Open）、`operator`（本機使用者）、`source_host`、`source_ip`、`dest_host`、`dest_ip`／`dest_port`（可為 null）
- `tool`（argv[0] 或 client 名）、`user_context`（uid、sudo、遠端使用者）、`cwd`、`command`（原文）、`command_expanded?`、`exit_code`、`result_kind`（ok／error／aborted／unknown）
- `output_ref`（chunk 範圍、bytes、hash、`truncated`）、`source_kind`（shell_hook／builtin_pty／proxy／agent_tailer／screenshot）、`capture_quality`（none／basic／rich）、`scope_status`

**人工層**：
- `description`（「為什麼要跑」，沿用 Ghostwriter 的 help text）、`comments`、`tags`、`artefacts[]{path, hash, host, ip, note}`（TIBER 的 artefact 欄位）、`extra_fields{}`

**消毒稽核**：照搬 Ghostwriter 的做法，比較最新的機器層或人工層修改時間與 `sanitizedAt`，判斷是否需要重審。匯出時說明「消毒套用到了哪些欄位」。

---

## 7. 無法驗證或未取得一手來源的項目

- FinalTerm 與 freedesktop 的 semantic-prompts 原始提案（被 Anubis 擋下），因此 `aid=`、`133;L`／`N`、巢狀 shell 的規則都沒有驗證。
- VS Code 是否有正式的「shell integration activated/failed」通知與相關設定（官方頁只寫了 hover 品質）；`failed to activate` 的字樣只見於 issue。
- bash `PS0` 內 command substitution 無法改變父 shell 狀態（記憶）；bash 5.3 對 DEBUG trap 的變更（NEWS 沒提）。
- McFly、zsh-histdb 的資料模型；Atuin 的 record store、衝突處理、資料表結構。
- asciinema 錄製器的 PTY 架構（文件頁 404）；以及任何格式對 alt-screen 的特別處理。
- tlog 輸入紀錄的預設值及其理由（README 沒寫）；tlog 的延遲設定。
- Teleport 在稽核 log 後端（不同於 Auth）失效時 session 的行為。
- mitmproxy flow 檔的編碼（tnetstring）；Burp 專案檔的格式與 temporary／disk 的差別；Burp「Don't send … if out of scope」在現行版本的確切路徑（只有論壇與 release note 摘要）；ZAP 與 Caido 是否仍儲存 out-of-scope 流量；ZAP 的 passive scan tagging；Caido 的 findings 與 history。
- Charles 的 session 檔與 CA 上線流程；HTTP Toolkit 用 `SSL_CERT_FILE` 一類變數（只見於第三方文章）。
- HAR 的 `_` 欄位實例（Chrome 的 `_webSocketMessages` 等）。
- Cobalt Strike 的 logs 目錄結構（官方文件 TLS 連線失敗）；Mythic 的 task 與操作者對應寫進報告的方式；Sliver、Havoc 的 log；PTES、OSSTMM 的紀錄要求；VECTR 的正式欄位名（只取得第三方來源）。
- Datadog 每個 instance 的 OK／WARNING／ERROR 與「Last Successful Execution」；OBS 的 stream health；VS Code language server 狀態項目；GitHub Actions 的狀態詞彙；Dropbox／Time Machine／Backblaze 的用詞；Grafana Alloy UI 的彙總規則。
- direnv、starship 的 init 與 verify UX；Loom、CleanShot、Raycast 的 macOS 權限流程（只取得 Apple 論壇的二手描述）。
- Warp 的 subshell 與 ssh「warpify」機制；它早期的設計錯誤（只有 emoji 那件事，來自搜尋摘要）。
