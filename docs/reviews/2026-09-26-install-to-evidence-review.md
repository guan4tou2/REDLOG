# REDLOG：從安裝到滲透證據交付的流程盤點

日期：2026-09-26。程式基準：遠端 main `f3a1ac4`；實際下載版：v0.17.1。

## 查核範圍與限制

本文件是依 release assets、README、首次啟動與設定元件、擷取來源、匯出程式所做的完整流程盤點。不是三平台安裝實測報告：未安裝新套件、改 shell profile、信任 CA、啟動真實擷取或執行真實交戰。新 main 的功能不能當成 v0.17.1 安裝包已具備。本機仍在 6b6af04，本輪以 git show 讀取最新遠端，未切換或改動產品程式。

結論：REDLOG 適合集中記錄與交付，但不能承諾「開 App 就完整記下一切」。是否有記到取決於工作發生的位置、選用的來源、流量路徑、擷取上限與附件保存。

## 一、今天下載後，應怎麼開始

### 1. 選對安裝位置與版本

安裝在實際執行測試的操作者環境。工具在 Kali VM 裡跑，最直接的是在 Kali 裝 REDLOG；只在宿主 macOS 開 App，不會自動看到 VM 內的終端輸出與網路。Windows + WSL 是兩個環境，需分別接線驗證。

從 GitHub releases 下載平台安裝包並比對 SHA256SUMS。現有發版提供 Linux x64 deb/AppImage、Windows x64 安裝/portable、macOS ARM dmg/zip；沒有 Intel Mac 安裝包。使用目前穩定版的人不會得到尚未發布的 main 修正。

### 2. 首次啟動確認依賴與權限

POSIX shell 記錄需要 python3/curl；HTTP(S) 需要 mitmproxy。最新 main 的 deb 已宣告 python3/curl 依賴，但不能倒推 v0.17.1 也有。AppImage/macOS 仍應看實際偵測，不假設系統自帶。Windows PowerShell 的路徑不能照搬 POSIX 依賴。

要截圖再確認螢幕錄製權限；要抓 raw packets 才另處理 tcpdump/tshark/npcap 與權限。不要為基本 log 一次啟用所有來源。

### 3. 建立一個交戰專案

填名稱、scope、exclude、私人流量。Scope 是判定與閱讀/交付政策，不是防火牆，也不保證來源不收集範圍外內容。保留範圍外原始紀錄與交付時排除/遮蔽是不同事情。

確認操作者與目前 target，為工作產物選一個專案專用目錄。不要直接監看整個家目錄。

### 4. 選定終端記錄方式

- 內建終端：最短起步路徑，包含 PTY .cast 輸出；先跑不涉及目標的唯一測試字串，檢查事件與 replay。
- 自己的 bash/zsh：安裝 hook，開新 shell，完成 nonce 驗證。這只證明 command/exit/duration/cwd 能抵達。
- 自己的 bash/zsh 要整段輸出：進入 redlog-session 再工作；單一道命令可用 redlog-run。
- PowerShell：內建終端或 Windows output pack；必須另驗證輸出，不能把 hook 成功當成輸出成功。
- tmux、WSL、遠端 ssh、互動式工具：在實際要用的那個 pane/session 驗證；新建 shell、遠端 shell 不應假設自然繼承完整擷取。

### 5. 接上 HTTP(S)

安裝並啟動 App 管理的 mitmproxy，開代理瀏覽器；使用授權測試站或受控測試端點驗證 HTTP 與 HTTPS 的 request/response/body。

終端代理選項只影響新開的內建終端；外部 shell、Firefox、工具自己的代理配置要另外確認。HTTP_PROXY/HTTPS_PROXY 也不保證所有 HTTP client 都會遵守。

CA 檔案存在不代表目標 client 信任它。應確認實際要用的 browser、curl、Python 等 client；不要把關閉憑證驗證當成普遍解法。保留撤銷信任方法。

### 6. 按需求接上附件與其他來源

監看工作產物目錄只能記檔案事件，目前不是自動封存 nmap XML、報告、腳本或下載檔。需要交付的原檔仍要主動保存。

GUI 操作以截圖、標記補充；截圖後確認實際圖片可開並掛對 target。AI、剪貼簿、程序、連線是選用來源，各自設定範圍；不要因為想看 connection 就順便收下所有 clipboard。

### 7. 開工前做一次最小驗證

| 驗證動作 | 必須看到的結果 |
|---|---|
| 在實際使用的終端跑唯一字串 | 正確專案中的指令、exit、cwd |
| 同一 session 輸出另一字串 | transcript/replay 可讀到輸出，不只有命令 |
| 以实际 client 發 HTTP 與 HTTPS | 各自能找到往返，檢查 body 與截斷狀態 |
| 寫出一個測試產物 | 檔案事件與保留的原檔；不能只看路徑就算保存 |
| 做一次截圖與 marker | 能開圖片、看到時間與 target |
| 匯出小型證據包 | 換到獨立目錄後驗證成功且附件可開 |

### 8. 測試中與結束時

測試中確認目前專案、target、來源最後事件時間與截斷提示。長 session 結束後確認 cast 收尾。結束時先完成保存，再停止來源/關閉專案。

以 target、時間、類型篩選，確認私人流量與範圍外處理，再匯出。檢查 .cast 是否夾帶其他目標，將外部工具產物與 pcap 一併保管。撤銷這場新增的代理與 CA 設定。證據驗章只能證明納入內容的完整性，不能證明未擷取的事情沒發生。

## 二、哪些 log 能記到

| 需要保留的內容 | 目前路徑 | 不能誤認的部分 |
|---|---|---|
| 指令、cwd、exit、耗時 | shell hook / 內建終端 | 只限接好的 shell；非全系統命令稽核 |
| 終端輸出與長互動 session | 內建 PTY、redlog-session、redlog-run；Windows output pack | 普通 hook 不含輸出；PTY 是畫面串流，不保證 stdout/stderr 分流與遠端命令逐條結構化 |
| HTTP request/response、headers/body | mitmproxy addon | 只限路由經過來源的流量；預設 body 上限 10 MB，preview 4 KB，headers 200 項 |
| WebSocket | addon 有 message handler | 需實際經過代理，仍受內容上限；不是全機通訊 |
| HTTPS | MITM 代理與 client 配置 | 信任庫、pinning、mTLS 等需個別驗證；不能宣稱全部可解密 |
| DNS | 最新 main 的 DNS hooks / 對應模式 | 不自動變成全機 DNS 稽核；DoH 等路徑不能假設涵蓋 |
| SYN/UDP/raw TCP 等 | 選用 pcap producer | 一般 connection monitor 是輪詢；pcap producer 預設送 flow 摘要，完整 bytes 另開 pcap-out |
| SMB/LDAP/RDP 內容 | 原生 HTTP 路徑無法完整提供 | 封包與工具輸出可補；加密封包不等於可讀應用操作 |
| nmap -oA / 工具輸出檔 | watcher 記建立/修改、路徑、size、mtime | watcher 不複製檔案內容，也不保證哪道命令產生它 |
| GUI / BloodHound / RDP 畫面 | 截圖與 marker | 不等於點擊錄影、所有視窗文字或完整 session |
| AI 使用紀錄 | opt-in transcript 來源 | 只限支援並授權監看的來源/路徑；不涵蓋任意網頁 AI 或未記錄的內部推理 |
| clipboard | opt-in monitor | 非每次複製必有完整內容；敏感且不必作為基本來源 |
| 遠端主機系統 log | 主動取得或來源整合 | 本機 App 不會自動取得 Windows Event Log、syslog 或遠端工具產物 |
| 暫停、設定變更、來源缺口 | 系統稽核事件 | 解釋狀態，無法補回當時未錄到的內容 |

內建 cast 預設上限 50 MB。保留期限與單次擷取上限不同；keep forever 不代表某次輸出沒有被截斷。

## 三、核心與可選功能

### 核心：必須讓新使用者走通

1. 專案隔離、操作者/target 與 scope。
2. 指令加輸出：能清楚選到會保存輸出的工作方式。
3. HTTP(S) 擷取與實際流量驗證。
4. 截圖、marker、證據附件保存。
5. 搜尋/篩選/回放、明確失敗與缺口提示。
6. 可預覽、可驗證、附件齊全的交付包。

### 可選：保留，但不應阻擋首次使用

AI transcripts、clipboard、程序/連線監看、raw packet capture、遠端 tailer、HUD、進階 loot 規則與 IP/VPN 顯示。沒有使用需求時不必設定。

### 應簡化或降級

- 第一次先介紹 pack/plugin、各種內部事件名稱：改問「你在哪裡操作、要保留什麼」。
- 同一個狀態多處有不同說法：HTTP 正在收斂，其他來源沿用同一能力/狀態來源。
- 將 command-derived pivot、credential-use、MITRE 推論展示成已證實的行為：保留來源關係，標為推論。
- 開啟 host pack 便預設啟用所有未指定成員：clipboard 建議單獨明確 opt-in。
- 不需要額外做案件管理、協作平台、攻擊編排、報告編輯器或新的「寫報告模式」。

## 四、需要改善的問題與驗收

| 優先度 | 問題與證據 | 改善與驗收 |
|---|---|---|
| 高 | 安裝版仍 v0.17.1，main 文件/功能已到下一版 | 發版前完成打包 smoke；下載頁、README、changelog 與實際包一致 |
| 高 | FirstRunView 的 focus/HttpCaptureStep 仍在 lit 分支下 | 用途選擇放在第一筆事件之前；Web 使用者不用先跑終端即可啟動並驗證 HTTP |
| 高 | hook nonce 成功只驗 metadata，容易誤解成輸出已保留 | 把「含輸出錄製」作為清楚的主要選項；另驗 output canary，頁面固定顯示覆蓋範圍 |
| 高 | certReady 只檢查 CA 檔案存在；HTTP 驗證接受任一 request_start/response | 分別標示代理存活、HTTP 往返、HTTPS 往返；驗證指定 client 與唯一測試請求，不把憑證存在當信任完成 |
| 高 | file-watcher 僅記事件、pcap 在外部；bundle 目前有專用 screenshots/casts/http-bodies 處理 | 提供明確「加入證據」動作，保存原檔/hash/來源連結並納入 manifest；不必自動抄整個目錄 |
| 高 | bundle 對 casts 明示 scopeFiltered=false，session 可跨目標 | 交付前呈現附件清單與選取/排除；保持原始 cast 不變，不假裝自動遮蔽已完成 |
| 高 | 上輪設定關閉專案時補存順序、scope 重試、StrictMode live 旗標仍未修 | 各做最小修正及對應回歸，不再以 issue closed 代替行為驗收 |
| 中 | Host pack 未設定 member 時視為開；含 clipboard | 將敏感來源獨立確認，pack 畫面明示將啟用哪些來源 |
| 中 | 「缺 Python 內建仍可記錄」在 RELEASE-SMOKE-TEST 仍存在，README 尚有 records everything/no manual note-taking 與過時 loot/plugin 描述 | 文件對照目前能力與程式；驗收文件也必須刪除失效斷言 |
| 中 | CA 移除以通用名稱/固定路徑，可能碰到共用 mitmproxy CA | 明示信任範圍並辨識實際指紋與原先是否受信任；只撤销本場新增變更 |

## 五、建議的最小產品流程

下載 → 環境檢查 → 建專案 → 選「終端含輸出／Web／兩者」 → 驗證真實紀錄 → 開始工作 → 搜尋/挑選 → 檢查附件 → 匯出驗證 → 還原本場環境變更。

不要把這條流程變成每次都要填寫的長精靈。首次設定後保存選擇，下一次只顯示變更與失敗。

工程上先修缺陷與文件，再做兩個有界變更：A「開工前覆蓋驗證」，B「附件保存與交付選取」。沿用現有 ingest、ExportPlan、來源與插件，不另建平行擷取引擎。

## 主要依據

以下均以 main `f3a1ac4` 查讀：README.md；electron-builder.yml；docs/RELEASE-SMOKE-TEST.md；src/renderer/src/components/{FirstRunView,HttpCaptureStep,RecordTerminalFlow}.tsx；src/renderer/src/lib/httpVerification.ts；src/main/services/{managed-http-proxy,file-watcher}.ts；src/core/{config,capture-packs,bundle-export}.ts；hooks/mitmproxy-addon.py；plugins/pcap-capture/README.md。

[固定版本原始碼](https://github.com/guan4tou2/REDLOG/tree/f3a1ac4) · [實際發版](https://github.com/guan4tou2/REDLOG/releases/tag/v0.17.1)

## 六、OSCP 型操作情境與已發布追蹤

優先次序：先修保存/重試缺陷，再驗外部 shell + tmux 輸出，接著處理並行 session 目標、本機產物保存及人工挑選報告素材。不要新增考試模式、flag/proof 收集、評分或 AI 報告。

OffSec 官方要求報告包含步驟、命令與 console output；本工具以被動記錄為目標，不宣稱取得考試核准。考試期间不可使用 AI chatbots/LLMs；目標檔案下載另受官方限制，因此附件例子以自行產生的本機輸出及筆記為準。

來源：[OSCP+ Exam Guide](https://help.offsec.com/hc/en-us/articles/360040165632-OSCP-Exam-Guide)。此處是流程設計對照，不在進行真實考試協助。

- [217 — onboarding: 在第一筆事件之前提供 Web／終端用途選擇](https://github.com/guan4tou2/REDLOG/issues/217)
- [218 — capture UX: 驗證外部 shell 輸出與 tmux 長 session 的完整性](https://github.com/guan4tou2/REDLOG/issues/218)
- [219 — target UX: 為並行終端提供 session target，避免全域目前目標影響其他工作](https://github.com/guan4tou2/REDLOG/issues/219)
- [220 — http verification: 分別驗證 client 的 HTTP／HTTPS，區分 CA 存在與已受信任](https://github.com/guan4tou2/REDLOG/issues/220)
- [221 — evidence: 將本機工具產物加入證據，保存原檔、hash 與來源關係](https://github.com/guan4tou2/REDLOG/issues/221)
- [222 — export: 交付前逐項選取附件，明示 cast 未依 scope 自動裁切](https://github.com/guan4tou2/REDLOG/issues/222)
- [223 — follow-up #191/#195: 完成設定關閉流程、scope 重試與 StrictMode 回歸](https://github.com/guan4tou2/REDLOG/issues/223)
- [224 — capture defaults: clipboard 與 AI 等敏感來源維持個別明確 opt-in](https://github.com/guan4tou2/REDLOG/issues/224)
- [225 — review UX: 人工挑選每台目標的操作與輸出，匯出可回溯的報告素材](https://github.com/guan4tou2/REDLOG/issues/225)
- [226 — release readiness: 對齊安裝包、能力宣稱與 Kali／Windows／macOS 真機驗收](https://github.com/guan4tou2/REDLOG/issues/226)
