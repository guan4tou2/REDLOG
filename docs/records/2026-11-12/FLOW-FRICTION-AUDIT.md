# RedLog 互動摩擦審計：J1 / J2 / J3

範圍：只讀程式碼與昨日截圖，未執行 app。路徑前綴 `src/renderer/src/` 省略，除非另標 `core/`、`main/`。
標記「需實跑」代表只靠讀碼無法定案，章末列出觀察方法。
截圖參照：`audit/A3-first-run-1440.png`、`audit/A4-first-run-narrow.png`、`audit/B-wide-1440-dashboard.png`。

---

## 0. 先講結論（5 行）

1. J1 內建終端最短路徑 = 4 次點擊 + 2 次輸入、0 次離開 RedLog，回饋就在同一畫面（FirstRunView.tsx:249/264/350）。外部 zsh 要離開 RedLog 2 次，且必須「開新分頁」才會成功。
2. J2 的三個來源各自有一套「驗證」語意、三種完成訊號，且彼此不共用狀態；HTTPS 信任一步必須跳去終端機頁，離開後不會自動回來，還可能因離開而失去首次使用畫面。
3. 新專案第一次進儀表板，狀態列與卡片就會報「需要注意 1」「什麼都沒在記」，即使內建終端是可用的（A3 左下、B-wide 儀表板）。「沒有事件」被畫成「壞了」是本審計最大的誤讀風險。
4. J3 本身短（4–5 次點擊），但「Loot → Timeline → 活動紀錄」之後返回堆疊只有一層，會丟掉 Loot 起點（App.tsx:173-179）。
5. 沒有「來源 A 必須先完成才能用來源 B」的強制阻擋；唯一的耦合是首次使用的「準備工具」整頁取代（FirstRunView.tsx:110、186），它會順帶清掉 HTTP 驗證狀態。

---

## 1. J1　首次啟動 → 建專案 → 第一道指令被記錄且看得到

### 1A. 內建終端路徑

| # | 畫面 / 控制（file:line） | 使用者要做 | 必須事先知道或決定 | 回饋（位置） | 必要性 |
|---|---|---|---|---|---|
| 1 | ProjectPicker「建立新專案」`ProjectPicker.tsx:213`（App.tsx:308 無專案時顯示） | 點擊 | 「專案」= 一份本機紀錄；副標「初始化本地 Operation Log」（zh-TW `project.newSubtitle`）要懂 Operation Log | 開 Modal | 必要 |
| 2 | CreateProjectModal 名稱欄 `CreateProjectModal.tsx`（`project.name`，必填，空值擋下 :46） | 輸入名稱 | 取名；「預設儲存路徑」「進階設定（選填）」可忽略，但畫面上看得到 | 欄位錯誤 `project.nameRequired` | 必要（1 個輸入） |
| 3 | 「建立專案」submit（同檔 `create-project-submit`） | 點擊（或 Enter） | 無 | 進儀表板（App.tsx:308 `setView('dashboard')`）；`useVisibility` 先 null 再探測，`restoring`/`loading` 骨架短暫出現（DashboardView.tsx:203） | 必要 |
| 3a | 若缺 python3/curl/shell：整頁換成「準備擷取工具」（FirstRunView.tsx:186、CapturePreparation.tsx:131） | 點「安裝」→ 等（最多 `INSTALL_TIMEOUT_MS`）→ 或「先不安裝，繼續」「稍後處理」 | python3、curl、「相依套件」、「先不安裝」與「稍後處理」差別（`captureSetup.exitsExplained`） | 逐列錯誤、已等候秒數 | **系統自己的準備被推給使用者**（條件式，macOS 通常不觸發） |
| 3b | `preparing` 初值 true（FirstRunView.tsx:84），preflight 回來前顯示「正在檢查這台電腦可用的工具…」 | 等 | 無 | 同畫面 | 準備工作；等待時間需實跑量測 |
| 4 | 指令擷取卡內「開啟內建終端機 ↗」`FirstRunView.tsx:319` | 點擊 | 看出「內建終端機（開箱即用）」與「外部 Shell Hook（需安裝腳本）」是兩條路，並選一條（`firstRun.paths.intro`「可擇一或同時使用」）；PTY 一詞 | 下方展開 420px 內嵌終端（:372-376） | 必要；但「展開」本身是多餘一步：終端可以預設展開 |
| 5 | 內嵌 TerminalView 自動開第一個分頁（TerminalView.tsx:184-199） | 點進終端取得焦點，輸入指令 + Enter | 輸入任何指令 | 見 6 | 必要（1 個輸入 + 1 次聚焦點擊） |
| 6 | 同一卡片 `first-run-commands-status`：「○ 尚未驗證」→「✓ 已驗證」(:249)；`verifiedBuiltin`「已收到內建終端的指令。」(:264)；下方「最近紀錄」列出該指令（:350-365，300ms debounce :154） | 看 | 無 | 同畫面三處同時變化（狀態字、說明、列表）；`firstRun.core.viewRecord`「查看記錄」主按鈕出現（:208） | 回饋良好 |

**總計 J1-內建**：點擊 4（建立新專案、建立專案、開啟內建終端、聚焦終端）；文字輸入 2（專案名、指令）；頁面/視圖切換 0（建專案後進儀表板不算額外）；離開 RedLog 0；決策 2（內建 vs 外部、是否展開）；等待 2（建專案載入、指令進來 ≤0.3s + 事件管線）。

**概念（此路徑畫面上出現的詞）**：專案、Operation Log、擷取來源、指令擷取、HTTP(S) 擷取、代理與憑證、驗證、內建終端機、PTY、Hook、外部 Shell Hook、核心擷取、稍後處理。

**繞路風險**：側邊欄也有「終端機」頁（⌘7，lib/sidebarOrder.ts:28）。使用者若走那條，輸入指令後該頁沒有「已驗證」回饋，只有分頁 badge「事件已接入」（TerminalView.tsx:650）與狀態列；要回儀表板才看到 ✓。首次使用畫面並沒有說「請在這裡的內建終端輸入」以外的路。

### 1B. 外部 zsh/bash 路徑（接續 1A 的 1–3）

| # | 畫面 / 控制 | 使用者要做 | 事先知道 | 回饋 | 必要性 |
|---|---|---|---|---|---|
| 4 | 「記我的 Zsh 終端」`FirstRunView.tsx:330-336`（A3 紅色主按鈕） | 點擊 | 「記我的」= 要修改我的 shell 設定檔；**畫面上沒有確認步驟**，點擊即寫入（RecordTerminalFlow.tsx:157 `hooks.install`，由 :193 effect 自動觸發） | 「正在設定 Zsh 的擷取…」(:266) | 必要，但同意寫 rc 是隱含的 |
| 4a | AdapterPicker（RecordTerminalFlow.tsx:249，`choices.length>1` 時） | 可能要選 zsh/bash | 「選擇要記錄的 shell」「偵測建議」；macOS 有 zsh+bash 時大概率出現（需實跑） | 單選鈕 | **系統已偵測並推薦，卻仍要使用者判斷** |
| 5 | flow 顯示「開一個新的終端分頁，貼上：」+ 一串含 nonce 的指令 + 複製鈕（:290-293） | 點「複製」 | nonce、「新分頁」的原因（舊分頁不載入 hook；說明只在 60 秒超時後才出現 `reasonNewTab` :301） | 「正在等這道指令進來…」(:296) | 複製是必要；**「必須新分頁」的資訊延後到失敗才給** |
| 6 | **離開 RedLog**：切到 iTerm/Terminal 等 | 開新分頁（或新視窗）、貼上、Enter | 自己的終端 App 是哪個；`設定 ▸ 記錄哪些終端 App` 若被限定（HooksPanel.tsx:194-215），別的 App 的事件不會被認（`terminalApp.boundary`） | 外部終端無回饋 | 必要的一次 app 切換（出） |
| 7 | **回到 RedLog** | 切回 | 無（沒有任何提示要回來；若沒回來，看不到證明） | `✓ 已收到 Zsh 指令`（RecordTerminalFlow.tsx:434）+ 卡片 `verifiedExternal`「已收到你自己終端的指令。」(FirstRunView.tsx:264) + 最近紀錄 | 必要（入） |
| 8 | 選用：輸出檢查 `OutputCheck`（:480）要再貼一條 canary 指令 | 複製、切換、貼、切回 | 「指令 ≠ 輸出」；`redlog-session`、`redlog-run` | `outputVerified` 或 `outputMetadataOnly` | 選用；但「已驗證」之後仍追加第二段驗證，讀者容易以為第一段不算 |

**總計 J1-外部**（含 1–3 共通）：點擊 6–7（建立新專案、建立專案、記我的 Zsh、[選 shell]、複製、外部終端內開分頁，不計外部 App 內點擊）；文字輸入 3（專案名、在外部終端貼上、Enter）；視圖切換 0；**app 切換 2**；決策 3–4（內建/外部、shell 選擇、新分頁、哪個終端 App）；等待 3（hook 安裝、等指令、可能 60s 超時重試）。

**概念**：hook、shell、設定檔載入（新分頁）、nonce 指令（不透明字串）、指令事件 vs 輸出、`redlog-session`/`redlog-run`、執行原則（Windows）、PTY。

**死路 / 迴圈（J1）**
- 等待中（`waiting-for-activation`）沒有取消鍵，也沒有「我已經貼了但沒反應」的主動檢查；只能等 60 秒（RecordTerminalFlow.tsx:60、:221）才出現原因清單。超時後仍會繼續聽（:207 註解）— 這點好，但畫面說的是「60 秒內沒有收到」，使用者可能以為已經結束。
- `blocked`（缺 python3/curl）→「準備缺少的擷取工具」→ `onPrepare` → `openPreparation('commands')` 把整個首次使用畫面換成準備頁並 `setHttpVerified(false)`（FirstRunView.tsx:110），**HTTP 卡被卸載，已做的 HTTP 驗證進度全部消失**。這是一個「補命令擷取的相依，卻丟掉 HTTP 進度」的迴圈。
- 首次使用畫面「稍後處理」/「查看記錄」都導去時間軸（FirstRunView.tsx:209、221）；時間軸空白時沒有「回首次使用」的入口，只能點側欄儀表板（仍會是首次使用畫面，因為 `firstRun` 單調為真直到有證據列，hooks/useVisibility.ts:37-45）。這不是死路，但「稍後處理」→ 時間軸 → 空白是個沒有下一步的頁面（需實跑確認時間軸空狀態文案）。
- 無專案開著時開 shell：不記錄，只有 App.tsx:532 的黃色提示 + `capture.unattributedSpool` 的暫存檔。屬已處理的邊界，但與「建立專案之前先用過 hook」互動時，指令會進 `~/.redlog/pending/*.unattributed`，使用者看不到（需實跑）。

**重複控制（J1）**：見 §5 D1（shell hook 的安裝入口共 4 處）。

---

## 2. J2　接上來源並確認有效

### 2(a) 外部 shell hook

兩個入口，驗證語意不同：

| 入口 | file:line | 做的事 | 證明方式 |
|---|---|---|---|
| 首次使用 / 設定 ▸ 指令與終端「接入」/「驗證／修復」 | FirstRunView.tsx:330；settings/HooksPanel.tsx:138-143 | `RecordTerminalFlow`：install + nonce 指令 + 等事件 | **nonce 指令從自己的終端到達**，才顯示 ✓（RecordTerminalFlow.tsx:216） |
| 儀表板擷取狀態卡「安裝 shell hook」 | CaptureHealth.tsx:437 → `setInstalled` :338-367 | 只 `hooks.install`，無 nonce、無等待 | 卡片文字變「shell hook 已安裝 · 開一個新終端機跑一個指令，安裝才算完成」(`capture.terminalOwnShellPending`) → 任意指令後變 `terminalOwnShellCommandOnly/Included` |

步驟表（儀表板路徑，專案已有其他證據列、非首次使用畫面）：

| # | 控制 | 做什麼 | 要知道 | 回饋 | 必要？ |
|---|---|---|---|---|---|
| 1 | 擷取狀態卡「終端機」列：Tag「Hook 未安裝」＋「你自己的終端機還沒納入 —— 裝上 shell hook…」(CaptureHealth.tsx:152-161、B-wide 截圖) | 看懂 | hook、shell hook、「納入」 | 同列同時顯示綠點「可用」「正在運作」（:155、:164）——見 §4 | — |
| 2 | 按「安裝 shell hook」(:437) | 點擊 | 這會改我的 rc；無確認 | 失敗才 toast（:357-363），成功無 toast，只靠 `onRefresh` 後文字變化 | 必要 |
| 3 | 切到外部終端、**開新分頁**、跑任一指令 | app 切換 ×2 | 為何要新分頁（文字提示在 `terminalOwnShellPending`，但只在安裝成功之後才看得到，且字很小 `text-xs`） | — | 必要 |
| 4 | 回 RedLog 看同一列 | 看 | `最近指令 {時間} · 尚未記錄到指令輸出 —— 請跑 echo ok`（:32-35 的 key 邏輯） | 儀表板 `refreshCapture` 每秒最多一次（DashboardView.tsx:197） | 必要 |

**總計 J2(a)-儀表板**：點擊 1（+外部終端內 0 次點擊）；輸入 1（外部終端指令）；視圖切換 0；app 切換 2；決策 1（要不要裝）；概念 hook、shell、新分頁、納入、指令 vs 輸出；等待 1。比首次使用流程少 2 次點擊，但**沒有 nonce，證明力較弱**：任何來自該 shell 的指令（包含之前就存在的）都會讓列變綠；且此處的「完成」文字與首次使用流程的「✓ 已收到 Zsh 指令」是兩個不同字串、兩套判準。

**死路 / 迴圈（2a）**
- 若 hook 安裝後使用者在**已開著**的終端機跑指令：不會被記錄，卡片停在 `terminalOwnShellPending`，沒有計時器、沒有「已 N 秒沒收到」；與首次使用流程的 60 秒超時原因清單不是同一套（首次使用有、儀表板卡沒有）。
- 「Hook 已安裝（Zsh）」Tag（CaptureHealth.tsx:153）與「正在運作」Tag（:155）可同列並存，但 `正在運作` 其實來自內建終端的 `ready`（`alwaysPresent`，core/capture-health.ts:~618/670），不是使用者自己的 shell。

### 2(b) HTTP(S) 經 managed proxy + HTTPS 信任

入口：首次使用的 `HttpCaptureStep`（HttpCaptureStep.tsx:122）；之後只在 設定 ▸「HTTP 擷取」頁頂的「驗證 HTTPS 擷取」展開（settings/BrowserPage.tsx:54-55）。啟停另在 `BrowserPanel.tsx:162`。

前置：mitmdump 必須已安裝；若缺 → `first-run-http-unavailable`「mitmproxy 尚未安裝」+「準備缺少的擷取工具」(HttpCaptureStep.tsx:305-309) → 整頁換成準備頁（FirstRunView.tsx:110，`source='web'`）→ 安裝（最多數分鐘）→ 回來。

| # | 控制（file:line） | 做什麼 | 要知道/決定 | 回饋 | 必要？ |
|---|---|---|---|---|---|
| 1 | 「啟動 HTTP 擷取」`HttpCaptureStep.tsx:443` | 點擊 | proxy、mitmproxy、HTTP 擷取 | 「正在啟動 HTTP…」(:435) 後出現 proxy 位址；**啟動失敗（例如埠被佔用）只顯示 `status.error`**（:441），要到「設定 → 瀏覽器與 HTTP 擷取」改埠（`capture.proxyPortInUse` 文案），此卡內沒有連結 | **系統自己的準備：既然使用者進了首次使用且要驗證 HTTP，可自動啟動**；目前要手動 |
| 2 | 二選一：「自己的瀏覽器」/「RedLog 擷取瀏覽器」(:313-320) | 點擊 | 決策：我用哪個瀏覽器；你的瀏覽器有沒有走 proxy | 切換說明區 | 必要的決策，但預設 `own`（:141）是比較高成本的路 |
| 3a（自己的瀏覽器） | 步驟 1：把瀏覽器指向 `127.0.0.1:6661`（:326-333，有複製鈕） | **app 切換**：去瀏覽器/FoxyProxy/系統設定填 host:port | proxy 設定在哪、HTTP 與 HTTPS 都要設 | 無（RedLog 側無回饋） | 必要（外部系統的設定） |
| 3b | 步驟 2：「HTTPS 憑證」連結展開 → 信任指令（macOS `sudo security add-trusted-cert …`）+ 複製 + 「在終端機執行」(:339-383；`CaCommand` :78-94) | 展開（預設收起 :140）、複製或按「在終端機執行」 | CA、信任庫、sudo、也看得到「移除信任」指令；mitm.it 另一路 | 「在終端機執行」→ `requestRunInTerminal` → **App.tsx:86 `setView('terminal')`：離開儀表板並卸載首次使用畫面**；指令只被「打進去但不執行」(`settings.hookRunHint`)，使用者要按 Enter、輸入 sudo 密碼 | 必要，但**此步是整個 J2 最大的斷點**：離開後沒有「回到驗證」的鈕 |
| 3c | 步驟 3：「開啟驗證網址」`first-run-http-verify-own` (:392) | 點擊 → **開預設瀏覽器** | 預設瀏覽器不一定是剛才設了 proxy 的那個（app 切換 ×1~2） | 回 RedLog 後 `VerifyRow`「✓ 已驗證（Chrome …）」(:399-406、`verifiedVia`) | 必要 |
| 3' | （擷取瀏覽器路徑）「用擷取瀏覽器驗證」(:419) | 點擊 → 瀏覽器自動開、載入驗證網址 | 該瀏覽器自信任 CA | 結果是 amber「◐ 已擷取 · CA 未驗證」＋ caveat（:248-255、:289；`inCaptureBrowser` 永遠視為不證明信任） | 最短路徑（2 次點擊 + 1 次 app 切換），但**永遠拿不到綠色 ✓ 已驗證** |
| 4 | 60 秒未收到 → `first-run-http-timeout` 原因清單 + 「或用你實際會用的工具驗證」curl 指令 + 「重新驗證」(:408-432) | 讀、複製、重試 | 暫停錄製、終端未路由、CA 被拒… | 是（好的失敗回饋） | 失敗路徑 |

**總計 J2(b)**：
- 擷取瀏覽器捷徑：點擊 3（啟動、選擷取瀏覽器、驗證）、輸入 0、視圖切換 0、app 切換 1（瀏覽器出現，非必須切回）、等待 2（proxy 啟動、瀏覽器載入）、決策 1。結果 = 部分驗證。
- 自己的瀏覽器 + 信任 CA：點擊 ≥7（啟動、展開憑證、複製、在終端機執行、[Enter]、回儀表板、開啟驗證網址）、輸入 3（瀏覽器 proxy 設定 host、port、sudo 密碼）、**視圖切換 2**（儀表板→終端機→儀表板）、app 切換 ≥3、決策 3、等待 3。
- 概念：HTTP(S) 擷取、代理（proxy）、憑證/CA、信任庫、mitmproxy/mitmdump、loopback、驗證 nonce（網址中的 token）、FoxyProxy、暫停錄製、`-k/--insecure`。

**死路 / 迴圈（2b）**
1. **「在終端機執行」把人帶離儀表板，且不帶回。** 首次使用畫面是否還在，取決於 `visibility.firstRun`：驗證請求本身是 HTTP 事件，若 `isEvidence` 為真則 `evidenceSeen=true`，離開儀表板那一刻 `firstRunActive` 被清掉（hooks/useVisibility.ts:37-45、:123-125）。回到儀表板時顯示的是一般儀表板，HTTP 驗證卡消失，只剩設定頁的「驗證 HTTPS 擷取」。**需實跑**：先跑一次 `https://…` 驗證請求→ 切到終端機→ 回儀表板，看 HttpCaptureStep 是否還在。
2. `HttpCaptureStep` 的 `attempt`/`showCa`/`browserPath` 都是元件區域 state（:130-148）；任何離開都歸零。唯一殘留是 `status.verificationState` 歷史列（:293-298）。
3. 啟動失敗（埠被佔用，B-wide 截圖卡片中的紅字就是此狀況）：唯一動作是「重試」（:443-445）。重試不會改埠，所以**是迴圈**；解法在另一頁。
4. `coreCaptureReady`（core 判定，lib/coreCapture.ts:26）只看 `http === verified`（FirstRunView.tsx:173 傳入的是 `verified`，不是 `trustVerified`），所以擷取瀏覽器路徑會顯示「✓ 核心擷取已就緒」(:215)，同一畫面 HTTP 卡徽章卻是 amber「◐ 已擷取 · CA 未驗證」(:289)。兩個判準並存。
5. 儀表板卡之後的 HTTP 列：`capture.http.ready`「擷取中」+ Tag「HTTPS 尚未以工具驗證」(CaptureHealth.tsx:172-174)。要補驗證，最近入口是「HTTP(S) 請求」列標題（:168，跳設定 ▸ 瀏覽器）→ 再按「驗證 HTTPS 擷取」→ 再選瀏覽器路徑。3 層。

**阻擋順序**：無強制。`HttpCaptureStep` 不依賴命令驗證（FirstRunView.tsx:20-26 註解與 `firstRun.hint`「互不依賴」）；唯一耦合是 `openPreparation()` 的整頁取代（見 1B）。

### 2(c) AI session 來源

此來源**不在首次使用主流程裡**，只在「準備其他擷取來源（AI 代理、截圖）」摺疊內（FirstRunView.tsx:380-395 → `renderCaptureCard`）。

| # | 控制 | 做什麼 | 要知道/決定 | 回饋 | 必要？ |
|---|---|---|---|---|---|
| 1 | 首次使用「準備其他擷取來源」展開（FirstRunView.tsx:382） | 點擊 | 「AI 代理」就是我用的 Claude Code/Codex | 展開整張擷取狀態卡 | 必要（或側欄 設定） |
| 2 | 卡片內再展開「其他擷取來源與狀態（N）」(CaptureHealth.tsx:670-677) | 點擊 | 「來源」 | 完整清單；agent 列在 `manage` 模式有「AI 代理擷取」連結（:584）。**非 manage 模式只有 agent 出錯時才露出連結**（:537-539） | 必要（第二次展開） |
| 3 | 「AI 代理擷取」連結 → `settingsTarget('captureControl',{source})`（:538/:584） | 點擊 → **視圖切換**到設定 ▸ 其他擷取來源，並捲到該列 | 頁名「其他擷取來源」與列名「AI 代理擷取」不同詞 | 捲到 `AgentRow` | 必要 |
| 4 | `AgentRow` 未安裝：按鈕「到插件頁安裝」(AgentsPanel.tsx:142 `MANAGE_KEY['not-installed']`) | 點擊 → **視圖切換**到 設定 ▸ 外掛 該整合詳情 | 「插件／外掛」兩種寫法；安裝在「別的頁」 | 進 `PluginDetailPanel` | **系統自己的準備被推給使用者**：AI 來源要先去外掛頁安裝才回來設定 |
| 5 | 「安裝擷取整合」(settings/PluginDetailPanel.tsx:141-142) | 點擊 | 安裝只動這台電腦 | `plugins.installState.installed`「已安裝」 | 必要 |
| 6 | 主按鈕「在擷取來源中開啟」(:138-139) | 點擊 → 視圖切換回 captureControl | — | 回到 `AgentRow` | 必要；**這是唯一的返回路，要看到它才知道回得去**（Settings 頂部的 `← 返回設定` 只回首頁，Settings.tsx:290-296） |
| 7 | 若狀態是 installed 但外掛不是 active：按鈕變「到插件頁啟用」(AgentsPanel.tsx:142 `inactive`) | 再次離開 | `plugins.status.*`「待同意/已停用/程式碼已變更」 | **第二次繞路**；是否必然發生需實跑 | 條件式 |
| 8 | 「加入工作目錄…」(AgentsPanel.tsx:150) 或貼路徑 + 「加入」(:152-153) | 開 OS 資料夾對話框選目錄 | **決策：記錄哪個目錄的對話**；`workPaths`、授權範圍（`settings.agents.captureBoundary`） | 路徑出現在清單 | 必要的授權決策 |
| 9 | 勾「在此專案記錄新對話」(:136-141) | 點擊 | 沒有工作目錄時此勾選為 disabled（:139 `!paths.length`），**沒有就地說明為什麼不能勾** | 自動儲存（Settings 350ms debounce，Settings.tsx:142-147，底部「已儲存」） | 必要 |
| 10 | **app 切換**：去跑 Claude Code/Codex | 跑一段對話 | 工作目錄要符合 | — | 必要 |
| 11 | 回來看：`SourceLastSeen`「最後收到 {時間}」/「尚未收到資料」(settings/SourceLastSeen.tsx:26-31)；儀表板卡 agent 列；活動紀錄「AI 對話」分頁 | 看 | 對話是「按 session 檔輪詢」，延遲未知（需實跑） | 同 5s 輪詢 `useCaptureHealth(5000)`（AgentsPanel.tsx:208） | — |

**總計 J2(c)**：點擊 ≈ 9–10（首次使用展開 1、卡內展開 1、AI 代理擷取 1、到插件頁安裝 1、安裝擷取整合 1、在擷取來源中開啟 1、加入工作目錄 1 + 選目錄 1、勾選 1，之後查看）；文字輸入 0–1（可選：貼路徑）；視圖切換 3–4；app 切換 1（agent）+ 1（OS 資料夾對話框）；決策 3（安裝？哪個目錄？要不要 thinking blocks / 原始副本，Agents 面板下方 `emitThinking`、`rawCopy` 兩段長文）；概念 ≈ 9：AI 代理擷取、擷取整合、插件/外掛、信任、工作目錄、授權範圍、對話資料夾、session、thinking blocks、原始副本。

**死路 / 迴圈（2c）**
- 在首次使用摺疊的卡片內，agent 列若非問題狀態、也不在 manage 模式，**沒有任何連結到設定**（CaptureHealth.tsx:537）；必須先展開第二層。
- 擷取來源卡把 agent 併進「終端機（指令）」群組（lib/captureReadiness.ts:58 `commands: ['terminal','agent-claude-code','agent-codex']`，CaptureHealth.tsx:102-117 `coreCommandState`）：只要任一來源 `ready`，「指令」列就顯示「可用 / 指令已接入」。因此 **AI 整合裝好但從未收過一筆時，主列仍是綠的**（原因與 2a 同）。唯一「從未收到」的訊號在設定頁的 `SourceLastSeen`。
- `scopeChanged` 後必須重新勾「確認範圍並記錄」（AgentsPanel.tsx:47、:141）：變更目錄會把 `enabled` 設為 false（:73-77）。這是正確的安全設計，但使用者新增第二個目錄後「突然停止記錄」，唯一提示是列內 amber 小字。
- 另有第二個 AI 入口：HooksPanel 的 `codex` hook（`settings.hookDesc.codex`「包住 Codex 的 shell」，與「其他擷取來源」的 Codex CLI 是兩個東西；需實跑確認是否同時顯示）。

---

## 3. J3　找證據

### 3A. 活動紀錄搜尋 → 閱讀 → 時間軸 → 返回

| # | 控制（file:line） | 做什麼 | 要知道/決定 | 回饋 | 必要？ |
|---|---|---|---|---|---|
| 1 | 側欄「活動紀錄」⌘2（sidebarOrder.ts:28） | 點擊（視圖切換 1） | 活動紀錄 = 「操作紀錄」分頁 = 預設閱讀模式（RecordingWorkspace.tsx:70） | 頁面標題、`RecordingStatus`「記錄中 · N 事件 · 各來源狀態個別確認」(:35-43) | 必要 |
| 2 | 搜尋框 `search-input`（:112，placeholder「搜尋指令、URL、事件內容…」） | 輸入 | 可直接輸入文字；`event:<id>`、`source:`、`provider:` 等語法是進階（:75） | 「N 個活動 · M 筆來源事件」(ActivityResults.tsx:106) | 必要 |
| 3 | 等待結果（`search.loading`） | 等 | — | `role=status` | 必要（時間需實跑量測） |
| 4 | 點結果列（ActivityResults.tsx:127-128） | 點擊（展開） | 列標：時間、來源類別、核心內容；「命中 N · 相關 M」是什麼 | `activity-summary` 展開 | **多餘的一步**：兩個動作鈕（閱讀/定位）只在展開後出現 |
| 5 | 「閱讀活動 ↗」`activity-read`（:150）→ 全螢幕 modal Reader（ActivityReader.tsx:185-187，focus trap） | 點擊 | 「活動閱讀器」；Reader 內自動選「最能說明的來源事件」（:125） | 輸出內容、事件資訊、雜湊（折疊） | 必要（若只要看內容） |
| 6 | Reader 內「在時間軸定位」`reader-locate`（:214；`disabled={!current}`） | 點擊 | 「時間軸」是另一頁 | App.tsx:158-163 `openInTimeline`：`returnTo='search'`、視圖切換 | 必要 |
| 7 | 時間軸到達；上方列「← 返回活動紀錄 ⌘[」（App.tsx:480-490） | 看 | 事件是否被居中/選取（Timeline.tsx:1417-1440） | 時間軸居中並選取該事件 | — |
| 8 | 點「← 返回活動紀錄」或 ⌘[（App.tsx:200-208、:219-235） | 點擊（視圖切換） | — | 回活動紀錄；`RecordingWorkspace` 因 `workspaceProject` 保持掛載（App.tsx:103-106、:492），搜尋文字、展開列都在 | 必要 |
| 9 | Reader 是否仍開著 | 若是，要 Esc/關閉 | ActivityReader.tsx 註解「Reader stays open under the Timeline…(#589)」 | **需實跑**：返回後是 Reader 直接回到眼前還是列表 | 可能多一次點擊 |

**總計 J3-A**：點擊 5（側欄、展開列、閱讀活動、在時間軸定位、返回）+ 可能 1（關閉 Reader）；文字輸入 1；視圖切換 3（儀表板→活動→時間軸→活動）；app 切換 0；決策 1（用哪個關鍵字）；等待 1–2（搜尋、時間軸載入）。
捷徑：略過 Reader，展開列後直接「在時間軸定位」（ActivityResults.tsx:151）= 4 次點擊。

**概念**：活動 / 操作 / 事件 / 來源事件 / 命中 / 相關 / 工作階段 / 閱讀器 / 定位 / 時間軸。同一件東西的名字：頁名「活動紀錄」、分頁「操作紀錄」（`workspace.reading.activities`）、計數「活動」（`activity.count`）、按鈕「閱讀活動」、modal「活動閱讀器」、「原始事件」分頁。

**死路 / 迴圈（J3-A）**
- 共享篩選（`FilterProvider`，App.tsx:330）跨頁保留：在活動紀錄用「來源」下拉選了類型，到時間軸仍套用（FilterBar 對 `search/http_history/timeline/loot` 都顯示，App.tsx:317）。若設定的是某來源，再定位另一類事件，時間軸會因篩選看不到它；`filter.unappliedTitle` 之類的提示只在特定頁（http/transcript/loot）。**需實跑**：在活動紀錄選來源=HTTP，開一筆 AI 活動不可能；較可能的是「僅範圍內」「只看上鏈」造成差異 — 觀察時間軸是否顯示「沒有符合目前篩選的事件」(`timeline.emptyFiltered`) 而非定位成功。
- 返回堆疊一層：`openActivity`/`openInActivity` 先 `setKept(null)` 並覆寫 `returnTo`（App.tsx:173-188）。

### 3B. Loot → 來源事件

| # | 控制 | 做什麼 | 回饋 |
|---|---|---|---|
| 1 | 側欄「證據」⌘6（預設落在截圖，sidebarOrder.ts:34、primaryViewFor） | 點擊（視圖切換） | 證據頁 + 三個分頁（EvidenceHeader.tsx:55-70） |
| 2 | 分頁「戰利品」 | 點擊（視圖切換） | Loot 列表；上方 FilterBar（App.tsx:463）、免責橫幅 `loot.disclaimerTitle` |
| 3 | （選）類型 chip / 搜尋（LootPanel.tsx:223-245） | 點擊/輸入 | 篩選；`searchLoadedOnly` 提醒只搜已載入的 |
| 4 | 點列展開（:297） | 點擊 | `loot-detail`、`loot.hitNotProof` |
| 5 | 「在時間軸開啟 →」`loot-locate`（:333） | 點擊 | Timeline 居中；「← 返回戰利品」；Loot 因 `KEEPABLE` 保持掛載並還原捲動（lib/keptOrigin.ts:12、:27-35） |

總計：點擊 4–5、輸入 0–1、視圖切換 3（含返回）、app 切換 0、決策 0。

**死路 / 迴圈（J3-B）**
- Loot 沒有「閱讀內容」入口。要看該事件內容要「時間軸 → 開啟活動紀錄」(`onOpenInActivity`)，此時 `setReturnTo('timeline')`、`setKept(null)`（App.tsx:173-179）：**返回鍵變成「返回時間軸」，Loot 起點與其捲動位置遺失**。兩跳之後回不到 Loot（需實跑確認時間軸「開啟活動紀錄」按鈕的位置與文案）。
- 側欄無「戰利品」，它是證據頁的分頁；對只用過 Activity 的人，「戰利品」找不到入口（只能靠 ⌘K 或證據頁）。

---

## 4. 狀態字（所有「來源狀態」可見字串）

依其回答的問題分組。標 ⚠ = 同問題不同詞，或同詞不同問題。

### 4.1 已安裝？（installed）
| 字串 | 出處 | 說明 |
|---|---|---|
| 已安裝（shell） | `settings.shellInstalled`，HooksPanel.tsx:120 | hook 檔已寫入 |
| Hook 已安裝（{shell}） / Hook 未安裝 | `capture.tag.hookInstalled/hookMissing`，CaptureHealth.tsx:152-154 | 同上，不同詞序 ⚠ |
| **未安裝** | `settings.hookNotFound`，HooksPanel.tsx:128 | ⚠ 這裡是「找不到該 shell 程式」，不是 hook 沒裝，與上一列同字不同義 |
| 未設定 | `capture.state.unset` | 來源未設置 |
| 未安裝 mitmproxy / mitmproxy 尚未安裝 / 找不到 mitmdump | `capture.http.unset`、`firstRun.http.missing`、`httpCapture.state.unavailable` | ⚠ 三種說法、兩個名詞（mitmproxy vs mitmdump） |
| 已安裝 / 未安裝 / 可更新 / 衝突 / 錯誤 | `plugins.installState.*`（AI 整合） | 另一套 |
| 找不到 {command} / 未授予螢幕錄製權限 | `capture.prereq.*` | 前置條件 |

### 4.2 已啟用/開啟？（enabled）
| 字串 | 出處 |
|---|---|
| 已關閉 | `capture.state.off`、`capture.http.off` |
| 開啟 / 關閉（按鈕） | `capture.turnOn/turnOff`，CaptureHealth.tsx:564 |
| 停用（按鈕，**實際是移除 hook**） | `settings.hookDisable`，HooksPanel.tsx:147 ⚠ 與儀表板「移除」(`capture.uninstall` CaptureHealth.tsx:573) 同一動作兩個詞；與「已關閉」又是另一軸 |
| 已停用 / 已在外掛頁停用 / 已停用，但資料還在進來 | `plugins.status.disabled`、`settings.externalDisabled(Feeding)` |
| 已安裝，尚未為此專案啟用 / 已為此專案啟用 | `plugins.projectAxis.*` |
| 在此專案記錄新對話（勾選） | `settings.agents.enableProject` |

### 4.3 可連線/運行中？（reachable / running）
| 字串 | 出處 |
|---|---|
| HTTP 擷取已停止 / 啟動中 / 擷取中 / 找不到 mitmdump / 失敗 | `httpCapture.state.*`（設定頁 BrowserPanel.tsx:157） |
| 尚未啟動 / 啟動中 / 擷取中 / 失敗 / 未知 / 曾保存流量；目前代理狀態未確認 | `capture.http.*`（儀表板） ⚠ 同一狀態兩套：「HTTP 擷取已停止」≈「尚未啟動」；「HTTP 擷取中」≈「擷取中」 |
| 正在監聽 {addr} | `capture.http.listening` |
| 執行中 / 曾經擷取過，目前沒在跑 / 沒在跑 | `settings.externalFeeding/Idle/NotRunning` |

### 4.4 已驗證？（verified）
| 字串 | 出處 |
|---|---|
| ○ 尚未驗證 / ✓ 已驗證 / ◐ 已擷取 · CA 未驗證 / ✗ 有 client 拒絕了 RedLog 的憑證 | `firstRun.core.*`、`firstRun.http.rejected`（首次使用） |
| 已驗證 / 待測試流量驗證 | `capture.httpVerified/httpAwaitingTraffic`（儀表板卡，CaptureHealth.tsx:144） |
| HTTPS 尚未以工具驗證 / HTTP 尚待工具驗證 / 注意：HTTP 代理監聽中不代表 HTTPS 憑證信任已完成 | `capture.httpsUnverified`、`capture.summary.http.unverified`、`capture.listeningIsNotTrust` ⚠ 「尚未驗證 / 待測試流量驗證 / 尚未以工具驗證 / 尚待工具驗證 / 待驗證」同一問題 5 種說法 |
| 待驗證 / 目前設定已驗證 / 設定已變更；需要重新驗證 / 驗證失敗 / 無法確認驗證紀錄 / 尚未設定驗證 | `httpVerification.*`（HttpCaptureStep.tsx:293-298 歷史列） |
| ✓ 已收到 Zsh 指令 / ✓ 輸出已記錄（經由…） | `firstRun.record.verified/outputVerified` |
| 事件已接入 / 事件未接入（終端分頁 badge） | `terminal.meta.hookOn/hookOff`，TerminalView.tsx:649-650 ⚠ 「接入」在別處是指「shell 接上 RedLog」（設定頁按鈕「接入」`settings.shellConnect`） |

### 4.5 正在接收？（receiving）
| 字串 | 出處 |
|---|---|
| 最後收到 {時間} / 尚未收到資料 | `settings.source.*`（設定頁來源列） |
| N s/m/h 前（或「—」，或空白） | `fmtAge`（CaptureHealth.tsx:384-392 回 `—`；CoreCaptureLine :165/184 `age()` 回空字串）⚠ 同卡內同一概念兩種空值 |
| 最後事件：{時間} / 尚未收到任何事件 / 等待事件中… | `statusBar.lastEvent/lastEventNever/captureWaiting` |
| shell hook 已安裝 · 開一個新終端機跑一個指令，安裝才算完成 / …最近指令 … 尚未記錄到指令輸出 | `capture.terminalOwnShell*` |
| 擷取中 / 已暫停 / 已排除（AI session） | `settings.agents.session*` |

### 4.6 整體健康？（healthy）
| 字串 | 出處 |
|---|---|
| 擷取狀態正常 / 部分來源回報異常 / **什麼都沒在記** / 部分來源待確認 / 讀取失敗 | `capture.healthy/partial/dark/healthyGap/readFailed` |
| 主要來源運作中 / 指令已接入，HTTP… | `capture.summary.*` |
| 可用 / 未設定 / 已關閉 / 擷取失敗 | `capture.state.ready/unset/off/error`；`ready` 譯「可用」，同卡 HTTP `ready` 譯「擷取中」 ⚠ |
| 正在運作 | `capture.tag.running` |
| 錄製 / 已暫停 / 等待事件中… | `statusBar.rec/paused/captureWaiting` |
| 記錄中 / 已暫停 / 記錄狀態未知 | `activity.status.*`（活動紀錄頁） ⚠ 「錄製」vs「記錄中」vs「擷取中」vs「正在運作」vs「執行中」 |
| 有擷取來源失敗了 —— 到儀表板看是哪一個 / 紀錄可能不完整 —— … | `statusBar.capturePartial/captureDark` |

### 4.7「沒有事件」被讀成「壞了」的位置（證據）
1. **新專案、零事件 → 「什麼都沒在記」**：`core/capture-health.ts` 的 `else if (!anyWired && !everFed) verdict = 'dark'`（約 :790）。`terminal` 列 `alwaysPresent`，但 `anyWired` 要求 `s.installed === true`；沒裝 hook 就不算。結果：狀態列「需要注意 1」、toast「有擷取來源失敗了」、儀表板 Tag「什麼都沒在記」，而內建終端其實可用。截圖：A3（左下「需要注意 1」＋右下 toast，且狀態列同時寫「等待事件中…」）、B-wide（「需要處理 2」紅卡）。
2. **自我指向的死路**：該問題項 `view: 'dashboard'`（StatusBar.tsx 約 :150）；使用者已經在儀表板按「前往」，什麼都不會發生（B-wide 截圖第一張紅卡的「前往」）。文案說「到儀表板看是哪一個」，但儀表板上卡片只顯示「部分來源回報異常」，並未標出是哪一個——在 B-wide 例子中，答案是 HTTP 埠被佔用，在另一行小字裡。
3. `statusBar.captureWaiting`「等待事件中…」在 `dark` 或「錄製中但從未收過事件」兩種情況都顯示（StatusBar.tsx:302），前者是壞、後者只是還沒打字，文字相同。
4. 擷取卡同列並存「Hook 未安裝」+「正在運作」+綠點「可用」（B-wide）：對一個人而言既是裝了又沒裝。
5. 設定頁 AI 列：啟用後「尚未收到資料」(settings/SourceLastSeen.tsx:30) 與「已啟用」同畫面，看不出是延遲、目錄不符還是壞了。
6. HTTP：`擷取中` + `HTTPS 尚未以工具驗證`（amber）在無流量的 proxy 上永久並存；`capture.http.ready` 註解（lib/httpCaptureState.ts:32-38）已明言「無流量 ≠ 壞」，但 amber 色（:146 httpTone）讀起來仍像警告。

---

## 5. 重複控制（同一件事多處可切換）

| ID | 事項 | 位置 | 會不會不一致 |
|---|---|---|---|
| D1 | 安裝 shell hook | ① FirstRunView.tsx:330（經 RecordTerminalFlow.tsx:157）② settings/HooksPanel.tsx:138「接入／驗證／修復」（同一 flow）③ CaptureHealth.tsx:437 cta「安裝 shell hook」④ CaptureHealth.tsx:570「安裝/移除」（manage） | 會。①②有 nonce 驗證，③④沒有；③④的「已安裝」只代表檔案存在。移除另有 HooksPanel.tsx:147「停用」與 CaptureHealth.tsx:573「移除」，皆走 `removeHookWithUndo`（8 秒復原），同一動作兩個詞 |
| D2 | HTTP proxy 啟動/停止 | ① HttpCaptureStep.tsx:214/443（首次使用；設定頁驗證面板內也有一份）② settings/BrowserPanel.tsx:90-95 `toggleCapture` ③ CaptureHealth.tsx:679 mitmproxy 列的 `hookId:'mitmproxy'` 會在 manage 顯示「安裝/移除」（core/capture-health.ts:679；core :396 註解說明 managed proxy 不裝 standalone hook）| ①每 3 秒輪詢（HttpCaptureStep.tsx:202-207）；②需實跑確認其輪詢；①②可短暫不一致。③顯示一顆與 ①② 語意不同的鈕（需實跑確認是否真的出現在 mitmproxy 列） |
| D3 | HTTPS 驗證面板 | 首次使用卡 + 設定 ▸ HTTP 擷取「驗證 HTTPS 擷取」(BrowserPage.tsx:54-55) | 各自 `attempt` state；其一完成，另一邊只靠 `status.verificationState` 歷史列顯示 |
| D4 | 啟動擷取瀏覽器 | 標題列 `LaunchBrowserButton`（App.tsx:411、DashboardView.tsx:76）、BrowserPanel.tsx:246、首次使用「用擷取瀏覽器驗證」（HttpCaptureStep.tsx:222）| 標題列在掛載/聚焦/退出事件更新狀態；其他兩處不更新它 → 可能顯示「啟動」而實際已開 |
| D5 | 暫停/恢復錄製 | 狀態列按鈕、命令面板、快捷鍵，皆經 lib/recordingToggle.ts:18 | 一致；但首次使用只在 `paused` 時才提示（HttpCaptureStep `paused`、FirstRunView.tsx:266） |
| D6 | AI 整合安裝/啟用 | 外掛頁詳情（PluginDetailPanel.tsx:141-151）、AgentRow（AgentsPanel.tsx:136-142）、儀表板卡 agent 列連結 | 兩軸：「已安裝」在外掛頁、「此專案啟用」在來源頁；`active` 來自外掛狀態（AgentsPanel.tsx:214），可能出現「已安裝但仍要去外掛頁啟用」 |
| D7 | 終端機 | 側欄「終端機」頁 + 首次使用內嵌 TerminalView（FirstRunView.tsx:372） | 兩個 view 掛載；分頁清單 `terminal.list()` 重播（TerminalView.tsx:230-245）。需實跑：同時開時分頁是否重複 |
| D8 | 「HTTP 擷取」頁名 | `settings.home.browser.title`「HTTP 擷取」、`settings.pageBrowser`「瀏覽器與 HTTP 擷取」、`capture.group.http`「HTTP(S) 請求」、`firstRun.http.title`「HTTP(S) 擷取（代理與憑證）」、側欄「HTTP」| 同處四個名字 |
| D9 | 「定位到時間軸」 | `activity-locate`（ActivityResults.tsx:151）、`reader-locate`（ActivityReader.tsx:214）、「開啟時間軸」分頁旁連結（RecordingWorkspace.tsx:138，無事件聚焦）| 文案不同：「在時間軸定位」vs「開啟時間軸 ↗」 |

---

## 6. 阻擋順序（來源 A 是否為使用 B 的前置）

程式碼實際強制的：
1. **無**側欄閘門：`lib/visibility.ts` 開頭註解明說已移除隱藏頁面；Sidebar 永遠十一列（DEFAULT_ORDER 七個 + 設定）。
2. **無** HTTP 必須先驗證才能進工作區：`firstRun` 只看是否出現過非 system/cleanup 的事件（lib/visibility.ts:55 `firstRun: !signals.evidenceSeen`），「稍後處理」直接 `onNavigate('timeline')`（FirstRunView.tsx:221/:209）。
3. **首次使用內部**：`preparing` 初值 true，`CapturePreparation` 取代整個首次使用畫面，直到 `preparationChecks(preflight,'commands').length===0` 或「尚未手動要求且沒有命令擷取阻礙」才放行（FirstRunView.tsx:107-109）。因此「缺 python3/curl/shell」會**阻擋整個首次使用畫面**，包括與其無關的 HTTP 卡；缺 mitmdump 則不阻擋（source 預設 `'commands'`）。
4. `openPreparation('web')`（HTTP 卡）也走同一個整頁替換，並重置 `httpVerified`（:110）→ 補 mitmproxy 會讓整頁換成準備頁，指令那一半的 UI 狀態（含展開的內建終端、`recording` flow）被卸載。
5. 首次使用畫面「退場」由 `firstRunActive` latch 決定（hooks/useVisibility.ts:57-62、:123-125）：有證據列且離開儀表板即永遠關閉；與兩個核心來源是否驗證無關。`firstRun.core.laterWhy`「尚未驗證的核心擷取會一直標示在儀表板上，直到完成」— 我在 DashboardView / DashboardIssues 讀到的標示只有擷取卡內的 Tag 與 `healthyGap`；是否有專用「未完成核心驗證」提示 **需實跑**（在驗證前離開首次使用，回儀表板看是否有提醒）。
6. AI 來源：必須先在外掛頁安裝且外掛 active，AgentRow 才出現勾選（AgentsPanel.tsx:136）；再要有工作目錄才可勾（:139）。這是 AI 來源內部的三層前置，不影響其他來源。

---

## 7. 需實跑清單（觀察方法）

| # | 要確認 | 怎麼做 | 觀察 |
|---|---|---|---|
| R1 | 新專案第一幀是否就有「需要注意 1」toast 與紅 Tag | 全新 `userData`，建專案，不做任何事 | 狀態列、toast、儀表板 Tag 文字與出現時間 |
| R2 | HTTPS 驗證事件是否算 `isEvidence`、離開儀表板後首次使用畫面是否消失 | 啟 proxy → 跑驗證 → 點「在終端機執行」→ 回儀表板 | HttpCaptureStep 是否仍在 |
| R3 | macOS 上 AdapterPicker 是否出現（zsh+bash） | 按「記我的 Zsh 終端」 | 是否多一個選擇列 |
| R4 | 活動紀錄 Reader 在「在時間軸定位 → 返回」後是否仍開著 | 開 Reader → 定位 → 返回 | 是否直接看到 Reader |
| R5 | AI 整合安裝後是否還要到外掛頁啟用 | 安裝後看 AgentRow 按鈕文字 | 是否為「到插件頁啟用」 |
| R6 | 儀表板卡 mitmproxy 列在 manage 下是否有「安裝/移除」 | 開「其他擷取來源與狀態」 | 該列控制項 |
| R7 | 共享篩選造成時間軸看不到定位目標 | 活動紀錄選「僅範圍內」或某來源後定位 | 時間軸是否空白或沒選取 |
| R8 | 各步驟等待時間 | 計時：建專案→儀表板、hook 安裝、搜尋、時間軸到達 | 秒數 |

---

## 8. 最高摩擦排序（前 10）

排序依：發生頻率 × 中斷成本 × 誤讀後果。

**1. 新專案零事件被判 `dark`，報「什麼都沒在記」＋「需要注意 1」＋toast**
- 證據：core/capture-health.ts 約 :790（`!anyWired && !everFed`）、StatusBar.tsx:140-160、`audit/A3-first-run-1440.png` 左下與右下、`B-wide-1440-dashboard.png` 紅卡。
- 最小改動：把內建終端的 `terminal` 列視為 wired（`alwaysPresent` 且專案已開），或在「完全沒有事件」時不判 dark、只走 `waiting`。
- 風險：真的什麼都沒接上的案例（例如專案開著但錄製暫停/DB 寫入失敗）要保留 dark；需確認 `lastDbError`、暫停路徑仍會觸發。

**2. 問題項「前往」導回儀表板本身（self-link）**
- 證據：StatusBar.tsx 約 :150 `view: 'dashboard'`；B-wide 第一張紅卡的「前往」。
- 最小改動：capture 問題項的 `view` 改為具體來源（HTTP 失敗→`settingsTarget('browser')`；hook→`settingsTarget('hooks')`），或在儀表板上不顯示該項的「前往」。
- 風險：多來源同時失敗時要選一個；用最嚴重者。

**3. HTTPS 信任步驟的「在終端機執行」把人帶離並不帶回**
- 證據：HttpCaptureStep.tsx:91 → App.tsx:86。
- 最小改動：保持在儀表板，改成複製 + 提示「在你的終端機貼上」；或終端頁頂部加既有的返回列（`returnTo` 機制）。
- 風險：App.tsx:86 同時服務 Settings 的其他「在終端機執行」，改動要區分來源；sudo 在 RedLog 內建終端輸入密碼本身也是一個風險點，改為外部終端反而更合理。

**4. 外部 hook：「必須開新分頁」只在 60 秒超時後才說**
- 證據：RecordTerminalFlow.tsx:290-301；儀表板路徑 `capture.terminalOwnShellPending` 只在安裝後出現。
- 最小改動：把 `reasonNewTab` 前置到「開一個新的終端分頁，貼上：」同一行（`firstRun.record.paste` 已寫「新的」，只需加一句已開分頁無效）。
- 風險：文案變長，窄寬度（A4）換行。

**5. 同一動作兩套驗證判準：首次使用 nonce vs 儀表板「安裝 shell hook」無 nonce**
- 證據：CaptureHealth.tsx:437 vs RecordTerminalFlow.tsx:216。
- 最小改動：儀表板 cta 不直接 `hooks.install`，改為打開設定 ▸ 指令與終端的同一 `RecordTerminalFlow`（已存在 HooksPanel.tsx:138），或把 cta 文案改成「接入我的終端」並走同一元件。
- 風險：多一個視圖切換；若 cta 要留在儀表板，需把 flow 內嵌（受 React「不可在 component 內宣告 component」規則約束，需模組層級元件）。

**6. 擷取瀏覽器驗證永遠只得 amber，但頁頭同時寫「✓ 核心擷取已就緒」**
- 證據：FirstRunView.tsx:173、:215 vs HttpCaptureStep.tsx:248-255、:289。
- 最小改動：`coreCaptureReady` 傳入 `trustVerified`，或把「已就緒」旁加 CA 未驗證的同色提示。
- 風險：使用者只用擷取瀏覽器（本就自信任 CA）時，就永遠無法「就緒」；需要決定這是否為想要的行為（較安全，但更嚴）。

**7. 「準備工具」整頁替換並重置 HTTP 進度**
- 證據：FirstRunView.tsx:110、186。
- 最小改動：`openPreparation` 不呼叫 `setHttpVerified(false)`；準備頁改為就地展開在觸發它的那張卡內（`RuntimePreparation` 已存在，HooksPanel.tsx:243 的用法）。
- 風險：兩處各自出現準備 UI，需防止同時安裝同一相依（`activeDependencyInstalls` 已有 ref）。

**8. AI 來源要跨三頁才完成，且 agent 列在首次使用摺疊內預設沒有連結**
- 證據：CaptureHealth.tsx:537-539、AgentsPanel.tsx:142、PluginDetailPanel.tsx:138-142。
- 最小改動：agent 列在非 manage 模式也顯示「AI 代理擷取」連結（只改 `!manage && isAgentRow` 的條件，不要求 problem）；`AgentRow` 未安裝時，把「安裝擷取整合」按鈕直接放在該列（`mutateOfficial` 已是獨立函式）。
- 風險：安裝邏輯目前刻意只在外掛頁（PluginsPanel.tsx:296 註解「the only place they happen (FR-003)」），移動會違反既有規格；較安全的最小版本只做連結一項。

**9. 狀態詞不統一（同一問題 3–5 種說法）**
- 證據：§4。尤其「尚未驗證 / 待測試流量驗證 / 尚未以工具驗證 / 尚待工具驗證」、「停用 vs 移除」、「未安裝（hook）vs 未安裝（shell）」、「可用 vs 擷取中」。
- 最小改動：只動 zh-TW.json：統一為一個詞（建議「尚未驗證」「移除」「找不到 {shell}」），不新增概念。
- 風險：e2e/test 對字串有斷言（`verify:i18n` 會抓刪除的字串）；改字要同步 test。

**10. 內建終端「開啟內建終端機 ↗」需多按一次才能開始、側欄終端頁沒有驗證回饋**
- 證據：FirstRunView.tsx:319-321、:372-376；A3 截圖。
- 最小改動：首次使用且無證據時預設展開（`showBuiltin` 初值 true）。
- 風險：每次進首次使用都掛載 xterm，增加首繪成本；啟動 PTY 的副作用（產生 shell 事件）會讓 `evidenceSeen` 判斷提早變 true，需實跑確認不會誤點亮「已驗證」（`commandEvidence` 為準，FirstRunView.tsx:129）。

---

附註：J3 的主要問題（Loot→時間軸→活動紀錄後起點遺失；共享篩選跨頁）未列入前 10，因為頻率或後果較低，但見 §3B 與 R4、R7。
