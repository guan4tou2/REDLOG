# 12 · 功能刪減審查（feature reduction audit）

基準：`wt-docs5`（= `origin/main@e6d22684` 加兩個純文件提交，HEAD `fad30a40`）。唯讀：沒有啟動 app、沒有跑測試、沒有讀任何真實專案。
依據：`docs/UIUX-STANDARD.md` §5、§25、§26（`:610-625`）；`AGENTS.md`「UI: let the layout explain」（`:22-51`）；根因審查 §4 的全部決定；報告 03、04、09、10、11；Spec 071–075；`docs/USER-GUIDE.md`。
本報告**只提案**；§26 末段明說擁有者裁定前不授權刪除任何既有功能。

計數方法與限制（先講，免得數字被讀成實測）：
- 「控制項」是**原始碼宣告數**：每個檔案中 `<button|Button|IconButton|CopyButton` 與 `<input|select|textarea` 出現的行數（grep 計），不是畫面上實際渲染的數量；條件渲染、`map` 產生的多個控制項只算一次。
- 「i18n 鍵」是該檔以字面 `t('…')` 引用的不重複鍵數；動態組出的鍵（`` t(`sidebar.${view}`) ``）不計。
- 「首屏字串」與「概念數」是**我讀程式碼推出的估計**，標 ≈；要定案需在真的 app 首屏數一次（G 節列為每階段的實機檢查）。
- 行數為 `wc -l`。

## 摘要（10 行）

1. 產品有三件事：記錄、找、驗證。今天的導覽是 7 個編號頁＋設定（`lib/sidebarOrder.ts:27-30`），另有 4 個只能從頁籤或 ⌘K 到的子頁、12 個設定頁（`Settings.tsx:27-48`）、HUD 視窗、專案選擇器；標題列 6 個常駐控制、狀態列 7 項。三件事裡**「驗證」沒有家**：完整驗證鈕藏在 設定 ▸ 其他 ▸ 證據鏈（`Settings.tsx:449`），首頁卻有 5 個地方各自畫一份完整性。
2. 同一個問題有多份答案，是畫面變複雜的主因，也是 04／07 已指出的「沒有擁有者」：整體狀態 7 份（Spec 075 `spec.md:46`）、完整性 5 處、IP 狀態 4 處、範圍狀態 6 處、來源設定入口 4 處。§26.5「同一概念一份實作」做完，就有大約四分之一的首屏控制項跟著消失，不必另外刪文字。
3. 最大的單一刪減是**儀表板**：它的每一塊都已在別處（狀態列、HUD、設定、⌘K），它的首次使用也被 Spec 075 FR-034 定義成「同一份來源清單」。建議刪除該目的地，**活動紀錄成為 ⌘1 與開專案後的第一屏**，空狀態只有一顆「開啟終端機」。這與 Spec 075 FR-032/034 和 §5.3 的編號衝突，列為擁有者問題 1。
4. 第二層是「找」的重複：HTTP 頁、戰利品頁、目標頁的範圍分頁都是同一批事件換一種篩選；活動紀錄已有 `http` 種類（`core/activity-contract.ts:5`）。Spec 072 的閱讀器登記表與 074 的「篩選留在各頁」落地後，它們都能變成活動紀錄的種類篩選＋專屬閱讀器，共用的 FilterBar（`App.tsx:328`）也隨 074 FR-085 消失。
5. 有幾個功能不服務三件事中的任何一件，或直接違反既定方向：書籤（非證據的可編輯便條，§5-6）、逐字稿的「挑選關鍵步驟／失敗嘗試」與「複製為 Markdown」（使用手冊自稱「整理報告素材」，`USER-GUIDE.md:215`）、標記的嚴重度與 ATT&CK 式分類（`EventMarker.tsx:10-11`）、`redlog-share-worker/`（797 行、app 內零呼叫端）。
6. 設定 12 頁可收成 6 頁，之後 535 行的設定搜尋索引（`lib/settingsSearchIndex.ts`）就是補償複雜度的控制項，可一併刪除。設定檔約 50 個葉節點，**沒有死設定**：每個鍵 main 都有讀取者；6 個鍵沒有 UI（`terminal.maxCastBytes`、`redaction.*` 四個、`retention.loggedTier.sweepIntervalHours`）。
7. HUD：擁有者先前裁定「保留所有 HUD 功能」，本報告照辦，只提出把 HUD 設定頁併入網路頁（兩者都將是機器層，Spec 073 P1）。代價照列：HUD 依賴每 60 秒的外部 IP 查詢（報告 11 D.2），所以 IP 監控不能刪。
8. AX：REST API 31 個路由×方法，3 個在 repo 內沒有呼叫端（`/api/clock`、`/api/session/registered`、`/api/capture` 只有 e2e 用）；專案建立／開啟／關閉、hook 安裝、外掛啟用、加入證據檔、匯出 JSON/NDJSON 只能點畫面。刪減讓 071 的能力表變小；建議每頁的唯一主動作都對應一條宣告能力、回傳型別化結果的路由。
9. 依刪減後重算：頂層目的地 8 → 6（活動紀錄、時間軸、目標、證據、終端機、設定），設定頁 12 → 6，標題列 6 → 3，i18n 2433 鍵中 ≈ 600–750 鍵可隨功能刪除（估計），其中 156 個「次要文字類」鍵（hint/desc/subtitle/eyebrow/tagline/footer/note）是文案收斂的主要對象。
10. 次序：先上「只降不升」的 ratchet 與零損失刪除（死碼、死路由、標語），再做不依賴契約的刪除（書籤、挑選、標記欄位），最後依 075 → 072/074 → 073 的落地順序做合併。每階段可獨立上線。

---

## A. 盤點

### A.1 頂層目的地與常駐表面

| 表面 | 位置 | 內容（數量） |
|---|---|---|
| 側欄 | `Sidebar.tsx:61-67,114`；順序 `sidebarOrder.ts:27-30` | 7 個編號頁（儀表板、活動紀錄、時間軸、HTTP、目標與範圍、證據、終端機）＋設定（⌘9）；2 個計數徽章（戰利品、範圍外觀測，`Sidebar.tsx:63-64`）；收合鈕；標題「工作區導覽」 |
| 子頁（無側欄列） | `sidebarOrder.ts:32-36`、`CommandPalette.tsx:212` | 逐字稿（→活動紀錄）、範圍（→目標）、戰利品與書籤（→證據） |
| 標題列 | `App.tsx:380-455` | 關閉專案（含專案名）、匯出、啟動擷取瀏覽器、截圖、加入證據檔、標記＝6 |
| 狀態列 | `StatusBar.tsx:232-411` | 需處理數、待確認數、錄製／暫停＋運行時間、IP 安全狀態、範圍狀態、事件數、HUD 開關＝7 |
| 共用篩選列 | `App.tsx:328,474`；`FilterBar.tsx` | 出現在活動紀錄、HTTP、時間軸、戰利品：範圍內、只看上鏈、個人流量、目標、類型、時間 4 個預設＋全部、清除（≈12 控制） |
| 命令面板 | `CommandPalette.tsx:199-290` | 導覽 12、動作 3（暫停、截圖、加入檔案）、密度 1、專案 ≤8、操作者 N、主機 N（需輸入）、事件搜尋 |
| 系統匣 | `src/main/tray.ts:143-202` | 顯示、加標記、暫停/恢復、HUD 開關、解除穿透、結束＝6 |
| HUD 視窗 | `OverlayApp.tsx`（584 行）、`ipc/overlay.ts`（15 個 handler） | 外/內 IP、安全/暴露、網路、pivot 節點、REC、迷你標記表單（只有標題＋備註）、穿透、保持展開；8 個偏好（`core/hud-prefs.ts:14-37`） |
| 全域快捷鍵 | `core/shortcuts.ts:13-24` | ⌘⇧M 標記、⌘⇧P 穿透、⌘⇧2 截圖；app 內 ⌘1–7、⌘9、⌘K、⌘.、⌘F |
| 對話框 | `EventMarker.tsx`、`ExportMenu.tsx`、`ConfirmDialog.tsx`、`CreateProjectModal.tsx`、`TimelineHelpModal.tsx`、終端機「如何被擷取」（`TerminalView.tsx:548`） | — |

### A.2 每頁的量（靜態宣告數；首屏與概念為估計）

| 頁 | 主要檔案（行） | 控制項 | 字面 i18n 鍵 | 首屏字串 ≈ | 概念 ≈ |
|---|---|---|---|---|---|
| 專案選擇器 | ProjectPicker 293、CreateProjectModal 228 | 8＋7 | 39＋31 | 12 | 5（專案、儲存目錄、範圍、匯入設定檔、Operation Log） |
| 首次使用（儀表板變體） | FirstRunView 416、HttpCaptureStep 450、RecordTerminalFlow 516、CapturePreparation 180、CaptureHealth 728 | 10＋13＋13＋10＋14 | 39＋35＋37＋21＋70 | 25 | 13（FLOW-FRICTION J1 列的概念：專案、Operation Log、擷取來源、指令擷取、HTTP(S)、代理與憑證、驗證、內建終端、PTY、Hook、外部 Hook、核心擷取、稍後處理） |
| 儀表板 | DashboardView 358、DashboardIssues 128、CaptureHealth 728、IPStatusCard 166 | 5＋2＋14＋3 | 32＋4＋70＋28 | 30 | 12（擷取來源、Hook、HTTP 驗證、外部 IP、安全/暴露、上鏈、僅本機、錨定、專案 ID、操作者、範圍、快捷鍵） |
| 活動紀錄 | RecordingWorkspace 163、SearchPanel 553、ActivityResults 199、ActivityReader 224、TranscriptView 1101、SourceSessionPicker 159＋FilterBar 236 | 6＋11＋10＋7＋15＋5＋10 | 16＋32＋29＋35＋57＋7＋23 | 22 | 12（4 個頁籤各一、來源、時區、範圍內、上鏈、個人流量、目標、類型、時間） |
| 時間軸 | Timeline 2910 ＋ timeline/* 11 檔 ≈1900＋FilterBar | 21＋≈40＋10 | 64＋≈100＋23 | 25 | 10＋（泳道、模式、範圍、縮放、焦點鏈、斷鏈、錨點…） |
| HTTP | HttpHistoryPanel 710、HttpDetail 458＋FilterBar | 17＋3＋10 | 37＋29＋23 | 15 | 8 |
| 目標與範圍 | TargetsScopeHeader 100、TargetView 436、ScopeStatus 325 | 4＋9＋8 | 14＋40＋36 | 14 | 7（目標、範圍內/外、觀測、撤回、追溯判定、完整性、規則在設定） |
| 證據 | EvidenceHeader 69、ScreenshotsView 434、LootPanel 350、BookmarksView 518 | 1＋14＋7＋18 | 2＋48＋27＋48 | 14 | 9（截圖、觸發來源、清單/網格、戰利品、類型、命中≠證明、書籤、不上鏈、標記 vs 書籤） |
| 終端機 | TerminalView 942 | 16 | 62 | 8 | 5（分頁、.cast、hook、PTY、事件已接入） |
| 設定首頁＋12 頁 | Settings 475＋settings/* 26 檔 ≈3900＋WslPanel 286 | ≈90 | ≈560（`settings.*` 410＋`plugins.*` 143） | 首頁 ≈40（12 列×標題＋徽章＋描述＋動作） | 首頁 12 個頁名＋3 種徽章 |
| HUD | OverlayApp 584、HudPage 143 | 10＋3 | 44＋14 | 8 | 6 |

i18n 總數：`en.json` **2433 鍵**。前十大前綴：`settings` 410、`timeline` 274、`plugins` 143、`export` 123、`firstRun` 112、`capture` 107、`activity` 91、`project` 73、`marker` 70、`eventTitle` 65。次要文字類（鍵名含 hint/desc/subtitle/intro/eyebrow/tagline/footer/caption/note）共 **156** 個，其中 `settings` 66、`timeline` 21、`firstRun` 8。另有 72 個鍵在 `src/` 找不到字面或前綴引用（含 `sidebar.ops`、`sidebar.intel`、`sidebar.http_history`，這三個我確認無引用；其餘如 `tray.*`、`quit.*` 可能由 main 以別的方式組出，**UNCONFIRMED**）。

### A.3 設定檔（`core/config.ts:30-262`；預設值 `:264-345`）

約 50 個葉節點，逐一以鍵名 grep 了 renderer 與 main/core 的引用（`config.ts` 本身不計）：

| 區塊 | 鍵 | UI 在哪 | main 有讀取 |
|---|---|---|---|
| engagement / operator | id、activeTarget、operator.id/name | 範圍頁的 ProjectSettings、儀表板摘要 | 是 |
| network | whitelist、blacklist、checkInterval、providers、confirmations、ipMode、offline、showWifiName、vpnAdapters（9） | 網路頁（`NetworkPage.tsx`，21 個鍵） | 是 |
| scope | warnOnViolation、targets、excludeTargets、personalDomains、scopeFile | 範圍頁、建立專案「進階」 | 是 |
| screenshot | quality、intervalSec、diffThreshold、captureOnCommand | 擷取控制頁（`CaptureControlPage.tsx:105-108`） | 是 |
| terminal | maxCastBytes | **無** | 是 |
| clipboard | pollMs、storePreview | 擷取控制頁 | 是 |
| browser | binary、proxy、cdpPort、isolateProfile、ignoreCertErrors、startUrl、extraArgs（7） | 瀏覽器頁 | 是 |
| httpCapture | port、listenHost、routeTerminals | 瀏覽器頁（BrowserPanel） | 是 |
| redaction | allowlist、denylist、entropyThreshold、minLength | **無** | 是（`core/redaction.ts:226-228`、`main/config-apply.ts:149`） |
| fileWatcher / processMonitor / connectionMonitor | watchPaths、ignorePatterns、pollMs×2、ignoreCommands | 擷取控制頁 | 是 |
| packs / packMembers | hostMonitors、windowsOutput；5 個成員 | 擷取控制頁、hooks 頁 | 是 |
| agentTailer | sources、emitThinking | 擷取控制頁（AgentsPanel） | 是 |
| loot | disabledRules | 戰利品規則頁 | 是 |
| retention | casts、screenshots、httpBodies、agentTranscripts、loggedTier.keepDays、loggedTier.sweepIntervalHours、bookmarks.keepDays | 保留期限頁（sweepIntervalHours **無**） | 是 |

結論：**沒有死設定**。殘留的只有 `config.ts:140` 的雲端分享註解（見 B 的 share-worker）。另有一份不在設定檔內的機器偏好：HUD 8 項（`hud-prefs.json`）、介面縮放、密度、語言、時區（localStorage）。

### A.4 main 程序

- IPC handler 179 個（命名空間前幾名：events 29、overlay 13、plugins 11、terminal 10、project 9、app 9、scope 7、content 7）。
- 背景計時器 18 處 `setInterval`（`main/` 與 `core/`）：剪貼簿、HUD 追蹤、匯出進度、CDP 輪詢 3 秒、行程監控、連線監控、opsec 30 秒、截圖週期、IP 查詢 60 秒、proxy 就緒、NTP、OTS 每小時與每 6 小時、專案執行期 3 個、匣圖示閃爍、網路連結 20 秒（`index.ts:660`）。
- 對外請求（報告 11 D.2，抽查過 OTS 與 IP）：OTS 提交／升級、NTP、每分鐘公有 IP、啟動 5 秒的更新檢查，預設都開。

API 路由與呼叫端（`core/api-server.ts:283-871`；呼叫端在 `cli/ hooks/ shell/ plugins/ src/ e2e/` grep）：

| 路由 | repo 內呼叫端 |
|---|---|
| `GET /api/health`、`/api/whoami`、`POST /api/events` | hook、relay、CLI、外掛（核心寫入面） |
| `/api/events/search`、`/api/marker`、`/api/loot/scan`、`/api/screenshot`、`/api/status`、`/api/bookmarks` GET/POST、`/api/recording`、`/api/operators`、`/api/terminal/replay`、`/api/chain`、`/api/anchors` GET/POST、`/api/anchors/verify`、`/api/anchors/upgrade-all`、`/api/export/bundle`、`/api/sanitize` | CLI 和/或 `shell/redlog-agent.sh` |
| `/api/config`、`/api/scope`、`/api/session/register` | 只有 `shell/redlog-agent.sh` |
| `/api/http-verify` | `hooks/mitmproxy-addon.py` |
| `/api/events/seed` | 測試建置與 e2e |
| `/api/events/count` | 只有 `hooks/wsl-redlog-test.sh` |
| `/api/capture` | 只有 e2e `screenshot-capture.spec.ts:34` |
| `/api/export/har` | 無（`redact-export.ts:11` 只是註解提到） |
| `/api/clock`、`/api/session/registered` | **無**（`docs/agent-integration.md:227` 有文件，沒有程式呼叫） |

外部代理或使用者腳本可能呼叫這些路由，repo 看不到，所以「無呼叫端」只代表 repo 內（**UNCONFIRMED** 對外使用）。

### A.5 同一個問題的多份答案（§26.5 的對象）

| 問題 | 回答它的地方 |
|---|---|
| 整體有沒有問題 | 7 份判斷（Spec 075 `spec.md:46,94`）：core verdict、儀表板卡、狀態列、活動紀錄 RecordingStatus（`RecordingWorkspace.tsx:21,107`）、#700 captureIssueView、首次使用 coreCaptureReady、CLI |
| 證據鏈完整嗎 | 儀表板「記錄概況」上鏈數／錨定（`DashboardView.tsx:52-60`）、目標與範圍頁的「記錄完整性」區塊（`ScopeStatus.tsx:308-321`）、設定 ▸ 證據鏈（`Settings.tsx:449`）、狀態列 integrity issue（`StatusBar.tsx:124-125`）、時間軸斷鏈橫幅（`timeline.brokenChain.*`） |
| 我暴露了嗎 | 儀表板 IP 卡（`DashboardView.tsx:276-280`）、狀態列（`StatusBar.tsx:209,329`）、HUD、書籤的 lastKnownIp（`BookmarksView.tsx:503`） |
| 範圍設了沒／有沒有越界 | 儀表板摘要（`DashboardView.tsx:327-334`）、狀態列（`StatusBar.tsx:347-374`）、側欄徽章（`Sidebar.tsx:64`）、目標頁、範圍頁、FilterBar「只看範圍內」（`FilterBar.tsx:68-70`） |
| 這個來源在哪設定 | 首次使用、儀表板卡、設定（hooks／瀏覽器／擷取控制三頁）、外掛頁（04 F5；075 `spec.md:94`「8 處」） |
| 記到多少了 | 儀表板記錄概況、狀態列事件數（`StatusBar.tsx:397`）、時間軸 loadedEvents/rangeOfTotal |

---

## B. 功能清單與判決

欄位：工作（R＝記錄、F＝找、V＝驗證、—＝都不是）；證據（核心路徑？幾次點擊？e2e？手冊？重複？）；成本（行數／鍵／設定／IPC／計時器／對外）；判決。e2e 欄是 `e2e/*.spec.ts` 中提到該表面的檔案數（grep，粗略）。

| # | 功能 | 工作 | 證據 | 成本 | 判決 |
|---|---|---|---|---|---|
| 1 | 儀表板（一般態） | — 本身不做事，全是轉述 | 每一塊都有別處：狀態列、HUD、設定、⌘K；14 個 e2e 提到 `dashboard` | DashboardView 358＋Issues 128＋IPStatusCard 166；`dashboard.*` 42 鍵、`issues.*` 23、`ip.*` 16 | **DELETE**（目的地），內容分流：見 C |
| 2 | 首次使用 | R | 核心路徑；FLOW-FRICTION J1：內建終端 4 擊；075 FR-034 已定為「同一份來源清單」並刪「核心擷取已就緒」 | FirstRunView 416＋HttpCaptureStep 450＋CapturePreparation 180；`firstRun.*` 112 鍵 | **MERGE** 進活動紀錄的空狀態（一顆「開啟終端機」）＋設定 ▸ 擷取來源（同一份 075 清單）；RecordTerminalFlow 保留（外部 shell 的必要流程） |
| 3 | 擷取健康卡 CaptureHealth | R | 被儀表板與首次使用共用；13 份來源狀態的主要一份 | 728 行、70 鍵 | **MERGE** 成 075 的單一來源列，住在設定 ▸ 擷取來源 |
| 4 | 活動紀錄 | F | 核心；手冊、e2e 多 | — | **KEEP**，成為 ⌘1 與首屏 |
| 5 | 活動紀錄的 4 個頁籤（操作／原始事件／輸入輸出／AI） | F | UX-004 把逐字稿併進來時以頁籤承接；AI 頁籤的 provider 選單寫死 Claude Code 與 Codex（`RecordingWorkspace.tsx:140-142`），違反「不預設工具」 | 頁籤＋2 個選單＋SourceSessionPicker 159 | **MERGE**：一份清單，點 shell／AI session 列由 072 閱讀器開逐字稿；「原始事件」收進篩選選單 |
| 6 | 共用 FilterBar | F（補償） | 074 O3／FR-085 已決定篩選留各頁；它存在是因為沒有讀取契約 | 236 行、`filter.*` 35 鍵、跨 4 頁 | **DELETE**（隨 074），每頁一個「篩選」選單 |
| 7 | 時間軸 | F | 固定決策：自己的頁 | — | **KEEP**；工具列的說明鈕、模式切換收進一個選單（D 節） |
| 8 | HTTP 頁 | F | 活動紀錄已有 `http` 種類（`activity-contract.ts:5`）；HTTP 本文索引已讓活動紀錄搜得到本文（`workspace.coverageBoundary`）；手冊 ⌘4 | HttpHistoryPanel 710、`httpHistory.*` 27 鍵；HttpDetail 458 留作閱讀器 | **MERGE** 進活動紀錄（種類篩選＋HTTP 閱讀器）——擁有者問題 2 |
| 9 | 目標頁 | F | 核心問題「這台主機發生了什麼」；10 個 e2e | TargetView 436 | **KEEP** |
| 10 | 範圍分頁（觀測清單） | F/V | 是目標的一種篩選（範圍外）；附帶一個重複的完整性區塊 | ScopeStatus 325、TargetsScopeHeader 100、`scope.*` 46、`targetsScope.*` 13 | **MERGE** 進目標頁（「範圍外」篩選＋列上標示）；完整性區塊 **DELETE** |
| 11 | 戰利品頁 | F | 10 §A、072 O2：推導註記預設附著在來源指令；側欄徽章已計數；`loot.hitNotProof` 說明它不是證據 | LootPanel 350、`loot.*` 37 鍵 | **MERGE** 進活動紀錄（種類篩選＋列上註記）；偵測器與規則保留 |
| 12 | 書籤 | — | §5-6：不上鏈、不簽章、可刪、不進證據包；`bookmarks.emptyReason` 本身在叫人改用標記；手冊 3 處 | BookmarksView 518、`db/bookmarks.ts` 110、IPC 5、API 2、`retention.bookmarks`、`bookmarks.*` 42 鍵、6 個 e2e | **DELETE**（先一次性匯出既有書籤）——擁有者問題 3 |
| 13 | 截圖（含加入的證據檔） | R/V | 帶 SHA-256 的檔案證據 | ScreenshotsView 434 | **KEEP**，成為證據頁本體 |
| 14 | 證據鏈驗證／錨定（設定 ▸ 證據鏈） | V | 唯一的完整驗證入口，深度 3 擊 | IntegrityPanel 183、`settings.integrity*` ≈25 鍵；chain-anchor 893 | **MOVE** 到證據頁，作為該頁唯一主動作「驗證」——擁有者問題 6 |
| 15 | 終端機頁 | R | 零設定的記錄路徑；23 個 e2e | TerminalView 942 | **KEEP**；「如何被擷取」對話框與 `terminal.hint` 刪 |
| 16 | 標記 | R | 核心；⌘⇧M、HUD、匣 | EventMarker 230 | **KEEP**；**MERGE** 欄位：新標記只要標題＋備註（＋截圖），與 HUD 迷你表單相同；嚴重度 3 值、分類 6 值、URL 從對話框刪除——擁有者問題 5 |
| 17 | 標記修訂（amend） | V | append-only 修正，證據語意 | marker-amend、MarkerDetail 334 | **KEEP** |
| 18 | 逐字稿「挑選」＋「只看已挑選」＋「複製為 Markdown」 | —（報告素材） | `USER-GUIDE.md:215`「整理報告素材」；`TranscriptView.tsx:427-428,711-765,827-832`；0 個 e2e | transcriptPicks 36＋transcriptSnippet 138＋TranscriptView ≈90 行、≈10 鍵、`marker.category.key_step/failed_attempt` | **DELETE**（單步複製保留）——擁有者問題 4 |
| 19 | 匯出 | V（交付） | 標題列唯一入口；12 個 e2e | ExportMenu 682、`export.*` 123 鍵；格式 bundle／HAR（依頁）／JSON／NDJSON／timeline（依頁）×範圍 2×去個資×遮範圍外 ＝ 名目 40 種組合（`ExportMenu.tsx:209-214,430-433`），另加逐檔附件勾選 | **KEEP**；**DEMOTE** JSON/NDJSON/timeline 到「其他格式」（已部分如此），範圍選項只在有篩選時出現（UNCONFIRMED 現況是否已如此，需實機） |
| 20 | 擷取瀏覽器（啟動鈕、CDP、隔離設定檔） | R | 標題列常駐（`App.tsx:418-420`），但它是設定性動作；預設操作者用 Chromium | browser-launcher 224、cdp-connector 445、BrowserPanel 255、BrowserPage 77、`browser.*` 7 個設定、CDP 3 秒輪詢 | **DEMOTE**：從標題列移到設定 ▸ 擷取來源的一列＋⌘K |
| 21 | 截圖與加入證據檔的標題列按鈕 | R | 有 ⌘⇧2、拖放、⌘K 三條替代路徑 | 2 控制 | **DEMOTE**：收進標題列的一個「＋」選單 |
| 22 | 週期截圖＋指令完成時截圖＋差異門檻＋品質 | R | 預設關（`config.ts:292-297`）；0 個 e2e 提到 `intervalSec`；手冊未提 | 4 個設定、1 個計時器、screenshot-agent 一部分 | **DELETE**（只留手動與隨標記）——擁有者問題 7 |
| 23 | 剪貼簿監控 | R | 預設關；報告 11：記錄操作者機器上任何複製內容，連 config 註解都在辯護它的特殊性（`config.ts:178-192`） | clipboard-monitor 126、2 設定、1.5 秒輪詢、1 個 e2e | **DELETE**——擁有者問題 7 |
| 24 | 行程／連線／檔案監控（host monitors pack） | R | 預設關；歸屬需要行程監控（報告 10 摘要 4） | ≈1237 行（含 pack 機制） | **KEEP**，只住在擷取來源頁的一列 |
| 25 | pcap、透明代理、C2 tailers | R | 已是外掛（`plugins/`） | 外掛本身 | **KEEP** 為外掛；`ExternalCaptureGroup` 不再在核心設定另列（外掛頁唯一） |
| 26 | Windows output pack、WSL 面板 | R | 平台必要，只在 Windows 顯示（`Settings.tsx:436-441`） | WslPanel 286、wsl-manager | **KEEP** |
| 27 | IP／VPN 監控與外部 IP 查詢 | —（操作安全；HUD 依賴） | 先前決定保留 HUD 全部功能 → 不能刪 | ip-signal-producer 304、opsec-state 182、network-info 94、IPStatusCard 166；每 60 秒 DNS 查詢 | **KEEP** 服務；**DELETE** 儀表板 IP 卡；網路頁 9 個設定中 providers、confirmations、ipMode、checkInterval **DEMOTE** 到 `machine.yaml` 不給 UI |
| 28 | OpenTimestamps 錨定 | V | 外部時間證明 | chain-anchor 893；每小時＋6 小時對外 | **KEEP**；「立即錨定」「全部升級」收進證據頁的次要選單 |
| 29 | NTP | V（時鐘異常） | 驗證報告會列時鐘異常 | clock 93、5 分鐘計時器 | **KEEP**；`/api/clock` 無呼叫端 → **DELETE** 路由 |
| 30 | 更新檢查 | — | 啟動 5 秒自動、早於 air-gap 生效（報告 11） | updater 394＋update-flow 143＋3 檔；`update.*` 29 鍵 | **DEMOTE**：只在「關於」手動檢查；刪啟動自動檢查——擁有者問題 7 |
| 31 | 設定檔匯入／匯出（profile） | — | 建立專案「進階」與範圍頁各一入口；073 machine.yaml 落地後，跨專案帶設定的需要大幅消失；`scopeFile` 已能匯入範圍 | profile-* 210 行、8 個測試、1 個 e2e | **DELETE**（073 之後）；先降為只剩匯入 |
| 32 | 密度＋介面縮放 | — | 兩條軸，且縮放已隱含密度（`GeneralPage.tsx` 註解「bigger zoom implies tight density」）；密度只在 ⌘K | density 42、uiScale 49 | **MERGE**：只留介面縮放；刪 ⌘K 密度項 |
| 33 | 語言、顯示時區 | F | 時間是證據的一部分 | — | **KEEP**（設定 ▸ 一般）；活動紀錄首屏的時區標籤刪 |
| 34 | ⌘K 的操作者、主機段 | F | 主機段回答「這台主機發生什麼」，與目標頁重疊；操作者段在單人產品中幾乎恆為 1 項 | ≈30 行 | 主機 **KEEP**（需輸入才出現）；操作者 **DELETE** |
| 35 | 外掛頁 | R（機器信任） | 075：外掛頁只留機器層動作（核准、停用、移除、撤回同意） | PluginsPanel 547＋Detail 237＋SampleTester 70；`plugins.*` 143 | **KEEP**；SampleTester **DEMOTE** 到外掛詳情的次要選單 |
| 36 | HUD 與其 8 個偏好 | —（操作安全）＋R（迷你標記） | **擁有者先前裁定保留全部** | OverlayApp 584、ipc/overlay 353、HudPage 143、`overlay.*` 41 鍵、追蹤計時器 | **KEEP 全部**；HudPage 併入「網路與 HUD」設定頁 |
| 37 | 設定搜尋 | —（補償） | 12 頁才需要搜；6 頁不需要 | settingsSearchIndex 535 行；`settings-search-closeout.spec.ts` | **DELETE**（設定收斂之後） |
| 38 | 時間軸說明對話框 | — | §25.2-4：要靠說明的介面，說明是證據 | TimelineHelpModal 52、`timeline.help.*` | **DEMOTE** 到 ⌘K「鍵盤快捷鍵」一項（與儀表板的快捷鍵 details 合一） |
| 39 | 工作階段重播 | F/V | 讀 .cast 的唯一方式 | 574 行 | **KEEP** |
| 40 | 因果圖 | F | 產品差異化（因果鏈） | CausalGraph 344 | **KEEP** |
| 41 | `redlog-share-worker/` | —（違反「無中央架構」） | app 內零呼叫端；README 說的「Settings ▸ Cloud share」不存在；`config.ts:140` 殘留註解 | 797 行、dependabot 項 | **DELETE**（零損失） |
| 42 | 死路由 | — | `/api/clock`、`/api/session/registered` 無呼叫端；`/api/capture` 只有 e2e | 3 段 handler、文件 2 列 | **DELETE**（`/api/capture` 的 e2e 改用 `/api/status`） |

---

## C. 每頁提案

以 §26.2 的三問測今天的首屏：我在哪、能做什麼、下一步按哪裡。「今天會讀成」依標題、最大元素、第一個控制推論。

### C.0 導覽

| | 今天 | 提案 |
|---|---|---|
| 編號目的地 | 7：儀表板、活動紀錄、時間軸、HTTP、目標與範圍、證據、終端機 | 5：**活動紀錄 ⌘1、時間軸 ⌘2、目標 ⌘3、證據 ⌘4、終端機 ⌘5** |
| 非編號 | 設定 ⌘9；4 個子頁（逐字稿、範圍、戰利品、書籤） | 設定 ⌘9；子頁 0（全部變成篩選或閱讀器） |
| 開專案後第一屏 | 儀表板（新專案則是首次使用） | 活動紀錄（空時即首次使用） |
| app 第一屏 | 專案選擇器 | 專案選擇器（刪標語與鍵盤提示） |
| 設定頁 | 12 | 6：擷取來源、範圍、網路與 HUD、保留期限、外掛、一般（含關於） |
| 標題列常駐 | 6 | 3：專案名（關閉）、標記（主動作）、匯出；「＋」選單收截圖與加入檔案 |
| 狀態列 | 7 項 | 4：整體狀態（075 的四個字之一，可點到唯一的擁有者）、完整性（點到證據頁）、IP（HUD 的鏡像）、HUD 開關；需處理／待確認併入整體狀態；事件數與範圍狀態刪 |

不新增頁面；時間軸保留自己的頁；單欄不變。

### C.1 專案選擇器
- 今天會讀成：大字 Wordmark＋「RED TEAM OPERATION LOG」，再來是「建立新專案」與清單。看得懂是專案清單，但最大的元素是品牌（`ProjectPicker.tsx:206-207`）。
- 主要意圖：開一個專案。主動作：建立新專案（清單為空時）或 Enter 開啟選中的專案。
- 首屏留：搜尋、清單、建立鈕。刪：tagline、`project.newSubtitle`「初始化本地 Operation Log」、頁尾「REDLOG 安全作業紀錄系統 · 本地優先儲存」（`:288`）、鍵盤提示列（`:282-283`）。
- 建立對話框：名稱＋建立；「進階（範圍）」保留為折疊（UX-006），「匯入設定檔」隨 #31 刪除。
- 前→後：字串 ≈12 → 5；概念 5 → 2（專案、範圍）。

### C.2 儀表板 → 刪除
- 今天會讀成（一般態）：小標「總覽」、大標「儀表板」、一句說明、一個框住的「狀態以各來源最後回報為準」（`DashboardView.tsx:242-249`）；最大的元素是擷取健康卡。讀成「監控主控台」，沒有主動作（「開啟活動紀錄」鈕在第三區塊裡，`:60`）。違反 §26.3。
- 首次使用態：「第一次使用：確認所需擷取來源能正常記錄」＋一段說明，兩張卡（指令、HTTP）。讀成「設定精靈」，而且把 mitmproxy 驗證當成就緒條件（04 F6）。
- 各塊去向：

| 區塊 | 去向 |
|---|---|
| 需處理（DashboardIssues） | 狀態列的整體狀態；點擊到該來源的唯一擁有者（075 US 故事 2 已這樣要求） |
| 擷取健康卡 | 設定 ▸ 擷取來源（075 單一來源清單） |
| 網路狀態（IPStatusCard） | 刪；HUD 與狀態列已有 |
| 記錄概況（上鏈數、僅本機、錨定時間） | 證據頁（驗證的上下文）；總數刪（狀態列已刪，時間軸自己有範圍計數） |
| 專案摘要（ID、操作者、範圍） | 設定 ▸ 範圍（已有） |
| 鍵盤快捷鍵 details | ⌘K「鍵盤快捷鍵」一項 |
| 首次使用 | 活動紀錄的空狀態 |

- 前→後：這一頁的 24 個靜態控制、≈30 首屏字串、12 個概念全部離開首屏。
- 損失：一眼看到「IP、記了多少、範圍、來源」的總覽。誰會想念：開場確認一切就緒的操作者。替代：狀態列一個字＋HUD。

### C.3 活動紀錄（新 ⌘1、新第一屏）
- 今天會讀成：「活動紀錄」＋錄製狀態＋搜尋框，下面一行時區、四個頁籤、FilterBar（`RecordingWorkspace.tsx:104-151`、`App.tsx:474`）。最大元素是結果清單 → 讀成「搜尋」，與目的相符；但 4 個頁籤、來源選單、FilterBar 的 12 個控制讓首屏有 ≈12 個概念。
- 主要意圖：找到一筆紀錄並打開它。主動作：在搜尋框輸入（Enter 開啟選中的列）。
- 首屏留：標題、搜尋框、一個「篩選」選單、列表；空時為空狀態（「還沒有紀錄」＋「開啟終端機」，次要連結「接上我的 shell」到設定 ▸ 擷取來源）。
- 收進「篩選」選單：種類（指令、HTTP、AI、戰利品、截圖、原始事件）、目標、時間、只看上鏈、個人流量。
- 移走：時區標籤 → 設定 ▸ 一般；「開啟時間軸」→ 列的開啟動作與 ⌘2。
- 吸收：HTTP 頁（種類＝HTTP，列以方法／狀態／主機呈現，閱讀器＝HttpDetail）、戰利品頁（種類＝戰利品，列上註記）、逐字稿與 AI 頁籤（點 session 列開 072 的閱讀器）。
- 刪：錄製狀態元件 RecordingStatus（第 4 份整體判斷）、AI provider 寫死選單。
- 前→後：靜態控制（本頁＋FilterBar）≈37 → ≈6；首屏字串 ≈22 → ≈4；概念 ≈12 → 3（活動、篩選、閱讀器）。
- 實話：這是把三頁的能力收進一頁的篩選選單——「收合只是藏起來」的風險在這裡最大（H 節）。成立的前提是 072 的閱讀器依種類分派、074 的分頁與計數契約，兩者沒落地前**不要動**。

### C.4 時間軸
- 今天會讀成：工具列（範圍 2 段、縮放 3 鈕、說明、模式）、FilterBar、泳道圖。讀成「時間圖」，相符。
- 主要意圖：看一段時間裡的順序與因果。主動作：選取一個事件（開 Inspector）。
- 首屏留：範圍、縮放、搜尋、圖。收進一個選單：模式（標準／進階泳道）、說明（→⌘K）、焦點鏈。刪：FilterBar（074）、`timeline.search.hint`。推導註記改附著在指令上（10、072 O2），泳道數自然下降。
- 前→後：工具列控制 ≈12 → ≈6；概念 ≈10 → ≈6。

### C.5 目標（吸收範圍分頁）
- 今天會讀成：大標「目標與範圍」＋一句說明（`TargetsScopeHeader.tsx:58-59`），兩個頁籤，「已觀測目標」面板＋搜尋＋說明段（`TargetView.tsx:276-283,433`）；範圍頁籤又有「記錄完整性」區塊（`ScopeStatus.tsx:308-321`）。讀成「目標清單」，相符；完整性區塊不相符。
- 主要意圖：這台主機發生了什麼。主動作：選一個目標（開它的事件）。
- 首屏留：搜尋、目標列（列上標示範圍內／外／未知）。篩選選單：範圍外觀測、撤回的觀測。範圍規則入口 → 一個「範圍設定」次要連結。刪：頁籤、完整性區塊、兩段說明。
- 前→後：控制 ≈21 → ≈5；字串 ≈14 → ≈4；概念 7 → 3。

### C.6 證據（成為「驗證」的家）
- 今天會讀成：大標「證據」＋「查看截圖、戰利品與書籤。新增檔案與匯出請用頂端操作。」（`EvidenceHeader.tsx:47-50`）——這句話在解釋版面，正是 §26.4 的反例；再一層「截圖紀錄」＋說明（`ScreenshotsView.tsx:291-292`）。讀成「截圖庫」。
- 主要意圖：證明紀錄沒被動過。主動作：**驗證**（完整走鏈＋錨點比對，現在在 `Settings.tsx:449`）。
- 首屏留：驗證鈕與其結果一行（完整／斷在第 N 筆／未錨定）、證據檔清單（截圖、加入的檔案，含 SHA-256），清單／網格切換。次要選單：立即錨定、全部升級、觸發來源篩選。
- 移走：戰利品 → 活動紀錄；書籤 → 刪除。
- 前→後：控制 ≈40 → ≈8；字串 ≈14 → ≈5；概念 9 → 4（證據檔、雜湊、驗證、錨定）。
- 擁有者問題 6。

### C.7 終端機
- 今天會讀成：「終端機」＋「多工作階段 PTY 與指令雙軌記錄軌道」（`TerminalView.tsx:610-611`）＋分頁＋終端；另有「終端機如何被擷取」對話框（`:548-560`）。讀成終端機，相符。
- 主要意圖：在被記錄的終端裡工作。主動作：新分頁。
- 刪：`terminal.hint`、about 對話框（說明屬 spec）、`terminal.aboutCast*`、`aboutHook*`。分頁徽章「事件已接入」改用 075 的來源狀態字。
- 前→後：字串 ≈8 → 3；概念 5 → 2。

### C.8 設定（12 → 6）
- 今天會讀成：「設定」＋副標「管理 RedLog 擷取管道、專案範疇與系統環境」＋搜尋＋三區塊 12 列，每列標題、適用範圍徽章（本機／目前專案／依專案啟用）、一行描述、動作（`Settings.tsx:39-80`）。讀成「很多設定」，需要搜尋才找得到東西。
- 主要意圖：改一個設定。主動作：開一頁（首頁沒有其他動作）。
- 新結構：

| 新頁 | 由哪些頁併成 | 層級（073） |
|---|---|---|
| 擷取來源 | hooks、瀏覽器、擷取控制、戰利品規則、WSL（Windows）；075 單一來源清單 | 機器＋專案 |
| 範圍 | 範圍、ProjectSettings | 專案 |
| 網路與 HUD | 網路（安全/暴露 IP、VPN、air-gap）、HUD 8 項 | 機器 |
| 保留期限 | 保留期限 | 專案 |
| 外掛 | 外掛 | 機器 |
| 一般 | 一般、關於、除錯紀錄 | 機器 |

證據鏈頁移到證據頁（C.6）。
- 刪：設定搜尋、首頁副標、每列描述（`HOME_DESC`，`:51-56`）、適用範圍徽章（層級改由頁的分組表達，或在 073 落地後只標「機器」那一組的標題）、頁尾「修改會自動儲存」（`:456`；保留失敗與重試狀態）。
- 前→後：首頁列 12 → 6；首頁字串 ≈40 → ≈7；設定鍵（UI 上可改的）≈50 → ≈40（DEMOTE 4 個 IP 細項、刪週期截圖 4 項、剪貼簿 2 項）。

### C.9 HUD
- 先前裁定保留全部功能。本報告不刪 HUD 的任何功能，只把 HudPage 併入「網路與 HUD」。照列代價：584＋353＋143 行、15 個 IPC、41 鍵、一個追蹤計時器、每 60 秒的外部 IP 查詢。
- 唯一建議（不是刪除）：HUD 迷你標記表單（標題＋備註）就是 C/B#16 主標記對話框的目標形狀，兩者共用一個元件。

---

## D. 架構後果（DX）

| 刪除／合併 | 跟著走的程式 | 設定與資料遷移 | 與 071–075 的關係 |
|---|---|---|---|
| 儀表板 | DashboardView、DashboardIssues、IPStatusCard、`eventTileStatus`、LaunchBrowserButton 搬家；`dashboard.*` 42、`issues.*` 大部分、`ip.*` 部分；約 650 行 | 無資料；`view==='dashboard'` 的舊深連結（`settingsTarget`、e2e、`redlog:navigate`）導向活動紀錄 | 075 FR-032 的渲染者少一個；FR-034「首次使用就是儀表板上的同一份來源清單」要改寫成「設定 ▸ 擷取來源」——**規格衝突**，需擁有者改 |
| FilterBar | FilterBar 236、`useSharedFilter` 的共用部分、`filter.*` 35 | localStorage 的共用篩選鍵忽略即可 | 就是 074 FR-085 的實作；本報告不加工作，只把「刪 FilterBar」寫成該 FR 的完成條件 |
| HTTP 頁 | HttpHistoryPanel 710、`httpHistory.*` 27；HttpDetail 留作 072 的 HTTP 閱讀器 | 無；HTTP 事件照舊 | 072：HTTP 種類的閱讀器與列呈現由登記表宣告；074：活動紀錄的投影需涵蓋 logged 層的 HTTP 列（**UNCONFIRMED** 現在的活動投影是否已含 logged 層；`SearchPanel.tsx:207` 有 `sharedFilter.tier`） |
| 戰利品頁 | LootPanel 350、`loot.*` 一半 | 無；loot 事件照舊 | 072 O2 已決定附著在來源動作；少一個 projection 消費者 |
| 範圍分頁 | ScopeStatus 325 大部分、TargetsScopeHeader 100、EvidenceHeader 69 | 無 | 074 的觀測投影改由目標頁消費 |
| 書籤 | BookmarksView 518、`db/bookmarks.ts` 110、IPC 5、`/api/bookmarks` GET/POST、`retention.bookmarks`、`bookmarks.*` 42、CLI 與 agent 腳本的 bookmark 指令 | **不能丟資料**：升級時把既有 bookmarks 表一次性寫成專案目錄下的 `bookmarks-export.json`（或保留表、只讀），並在下一次開專案時以一則通知告知位置；`retention.bookmarks` 讀到時忽略 | 071 能力表少兩條路由 |
| 標記欄位 | EventMarker 的嚴重度、分類、URL 區塊；`marker.severity.*`、`marker.category.*`（9 鍵）不能刪——**舊事件仍要讀得出來** | 舊標記的 severity/category/url 由閱讀器照舊顯示（報告 10 的「死呈現」規則：已寫入種類的呈現不得刪） | 072 標記閱讀器宣告這三個為「舊欄位，只讀」 |
| 挑選 | transcriptPicks 36、transcriptSnippet 中的多步彙整、TranscriptView ≈90 行 | 已寫入的 `key_step/failed_attempt` 標記仍是標記，照舊顯示 | 無 |
| 設定收斂 | settingsSearchIndex 535、`settings.home.*` 28、各 `*Hint` 鍵 | 設定檔鍵不變，只是 UI 位置改；網路的 4 個細項保留在檔案（073 搬到 `machine.yaml`） | 073 的層級決定頁的分組 |
| 週期截圖／指令截圖 | screenshot-agent 的 interval 與 onCommand 路徑、4 個設定、1 計時器 | `screenshot.intervalSec/captureOnCommand/diffThreshold` 讀到時忽略並記一次 `config_audit`；既有自動截圖事件照舊可讀 | 072 少一種觸發子類的新寫入（舊子類保留閱讀器） |
| 剪貼簿 | clipboard-monitor 126、IPC 2、pack 成員 1、2 設定 | `packMembers.clipboard`、`clipboard.*` 忽略；既有 clipboard 事件照舊可讀 | 075 少一個來源描述；報告 11 的一條外洩路徑消失 |
| share-worker | 整個目錄 797 行、dependabot 條目、`config.ts:140-142` 註解 | 無 | 無 |
| 死路由 | 三段 handler、`docs/agent-integration.md:210,227` | 無 | 071 FR-070「每條路由宣告恰好一個能力」要宣告的路由變少 |

估計合計：刪除或併走 ≈6,000–7,000 行 renderer＋≈1,500 行 main/core，i18n ≈600–750 鍵（**估計**，依上表加總；精確數字要在每階段用 ratchet 的「now」值讀出）。

遷移原則（每一項都適用）：
1. 設定鍵「讀到時忽略」，不從使用者的檔案刪除；記一筆 config audit。
2. 已寫入的事件種類，閱讀器與標題永不刪除（報告 10 對死呈現的規則）；刪的是**產生新事件**的路徑與**輸入**控制。
3. 非事件的資料（書籤）先匯出成檔案再移除介面。
4. 舊導覽目標（`dashboard`、`http_history`、`loot`、`bookmarks`、`scope`）保留為別名，導向新位置一個版本，再移除。

---

## E. 智能體經驗（AX）

今天的穩定表面：REST 31 個路由×方法（A.4）、`cli/redlog-cli.js`（564 行）、`shell/redlog-agent.sh` 11 個函式（`redlog_mark/event/note/search/loot/scope/config/bookmark/screenshot/status/session_register`）、`docs/agent-integration.md`、`docs/codex-tools.json`。

只能點畫面的動作（沒有路由）：
- 專案建立／開啟／關閉／刪除（`project:*` 9 個 IPC，無 `/api/project`）。
- hook 安裝／移除、外掛核准／停用、AI 整合同意（`hooks:*`、`plugins:*` IPC）。
- 任何設定寫入（`/api/config` 只有 GET）。
- 加入證據檔（`artifacts:*` IPC）、刪截圖檔。
- 匯出 JSON／NDJSON（API 只有 bundle 與 HAR）。
- 完整驗證有路由，但名字藏在 `/api/anchors/verify?full=1`（`api-server.ts:812-817`），智能體不會猜到「驗證證據鏈」在 anchors 底下。

沒有機器可讀結果的地方：⌘K 的動作與標題列按鈕只回 toast；CLI 把 `partial` 印成「wired but idle」，與模型相反（04 §1.2）。

刪減如何讓契約變小、變清楚：
1. 每頁一個主動作 → 每個主動作一條路由，宣告 071 FR-070 的一個能力，回傳型別化結果：搜尋 ↔ `/api/events/search`（`read`，071 O13 已決定 agent-tools 憑證不含搜尋內容）；標記 ↔ `/api/marker`（`append`）；匯出 ↔ `/api/export/bundle`（`export`）；驗證 ↔ 建議別名 `GET /api/verify`（`read`），舊路徑保留；開終端機 → 無路由（操作者動作，不給智能體）。
2. 刪書籤、`/api/clock`、`/api/session/registered`、`/api/capture`：路由 31 → 26，能力表與 SC-006 的測試矩陣跟著縮。
3. 狀態只有 075 的一份 payload：`/api/status`、CLI、`redlog status` 讀同一份；智能體不需要理解 7 種整體判斷。
4. 不建議為了 AX 補「專案建立」等路由——那是操作者的決定，不屬於智能體的能力；只需在 `docs/agent-integration.md` 寫明「這些只能由操作者在 app 中做」。

---

## F. 功能刪減之後剩下的文案

規則：留下的只有錯誤、擷取失敗、證據不完整、敏感匯出、破壞性確認、空狀態、可及名稱。其餘列出刪除（不改寫）。

| 頁 | 留下（理由） | 刪除（鍵） |
|---|---|---|
| 專案選擇器 | `project.listFailed`、`openFailed*`、`openMissing*`（錯誤）；`confirm.deleteProject*`（破壞性）；`project.listEmpty`（空狀態）；`project.search`（可及名稱） | `project.tagline`、`project.newSubtitle`、`project.pageFooter`、`project.keyPress/keyBrowse/keyOpen`、`project.openHint`（tooltip 重複「按兩下開啟」） |
| 活動紀錄 | 空狀態一句＋按鈕；`search.*Failed`；`workspace.coverageBoundary`（搜尋涵蓋不完整＝證據不完整，保留但只在搜尋有涵蓋缺口時顯示，不是 details 常駐） | `search.hint`、`activity.zone`、`workspace.searchCoverage` 的常駐 summary、`workspace.reading.*`（頁籤消失）、`workspace.provider/allProviders` |
| 時間軸 | `timeline.brokenChain.banner`（完整性）、`timeline.totalUnavailable`、`focusChain.failed/truncated` | `timeline.search.hint`、`timeline.help.*`（移 ⌘K）、`filter.presetIsSnapshot` tooltip |
| 目標 | 讀取失敗、截斷（`scope.truncated`）、空狀態 | `targetsScope.hint`、`targets.hint`、`scope.integrityTitle/integrityCaption/entries`、`scope.rulesLiveInSettings`、`scope.judged.retroactiveHint`、`scope.clearedHint`（改由列狀態表達） |
| 證據 | 驗證結果（完整／斷鏈位置／簽章失敗／未錨定）、`screenshots.deleteConfirm`（破壞性）、`screenshots.deletedKept`（檔案刪了但事件仍在＝證據不完整）、`imageUnavailable` | `evidence.hint`、`screenshots.sectionTitle/sectionHint`、`settings.integrityHint`、`settings.integrityNoAnchorsWhy` 以外的說明句 |
| 終端機 | `terminal.noProjectRecording`（擷取狀態）、錄製失敗 | `terminal.hint`、`terminal.about*` |
| 設定 | 每頁的欄位名、輸入錯誤（如 `httpCapturePortInvalid`）、`httpCaptureExposedWarning`（安全邊界）、`clipboardScopeWarn` 隨剪貼簿刪、`settings.save.failed/retry` | `settings.home.subtitle`、`settings.home.*.desc`、`settings.home.badge.*`、`settings.autoSaveHint`、`settings.searchSettings/noSettingMatches/searchResults`；`*Hint` 66 個逐一過 §25.2，預估留 ≤15 個（安全邊界與不可逆設定） |
| 標記對話框 | 儲存失敗、`marker.immutableHint`（不可修訂＝證據語意，保留） | `marker.fieldUrl*`、`marker.field.severity/category` 的輸入（值鍵保留給閱讀器） |
| 匯出 | 敏感內容警告、排除 N 筆、跨多目標的錄影、失敗 | `export.formatHelp.*` 只留 bundle 一則；`export.presentationNotice`（無引用，UNCONFIRMED） |
| 側欄 | 頁名、計數徽章的 aria | `sidebar.workspaces`、`sidebar.ops`、`sidebar.intel`、`sidebar.http_history`（後三個無引用） |
| 儀表板／首次使用 | 隨頁刪除；首次使用的錯誤與遠端修復步驟（`captureSetup.*`）跟著 075 的來源列走 | `dashboard.*`、`firstRun.title/hint/eyebrow/paths.intro`、`issues.*` 中的說明句 |

---

## G. 工作次序

每階段可獨立上線。gate 的寫法沿用 `test/raw-button-ratchet.test.ts`（只降不升、要升須在同一 PR 改基準並說明）。

| 階段 | 內容 | 前提 | 守住它的 gate | 實機檢查 | 受影響的 e2e |
|---|---|---|---|---|---|
| P0 | 新增四個 ratchet：頂層目的地數（`DEFAULT_ORDER.length`＋`SettingsPage` 聯集成員數）、i18n 總鍵數與「次要文字類」鍵數、`RedLogConfig` 葉節點數、API 路由數（每條路由需在 repo 內有呼叫端清單或標 `external`）。刪 share-worker、3 條死路由、確認無引用的 i18n 鍵 | — | 上述四個 ratchet | 無 | `screenshot-capture.spec.ts`（改用 `/api/status`） |
| P1 | 零契約依賴的刪除：專案選擇器標語、書籤（含一次性匯出）、逐字稿挑選與多步 Markdown、標記對話框欄位（輸入）、⌘K 操作者段與密度、儀表板 IP 卡、範圍頁完整性區塊、標題列收成 3 個、時間軸說明對話框移 ⌘K | 擁有者裁定 Q3–Q5 | 鍵數 ratchet 下修；新增「`bookmarks` 不在 `SidebarViewId`」斷言 | 選擇器首屏、標記對話框、標題列在 1440 與窄窗 | `app-shell`、`layout-read-states`、`layout-reliability`、`visual-reference`、`ui-closeout`、`cli-smoke`、`http-body-search`（bookmark）；`evidence-views`、`timeline-evidence`、`timeline-track`、`recording-pause`、`capture-settings-interaction`（severity） |
| P2 | 075 落地後：設定 ▸ 擷取來源成為唯一來源清單；刪儀表板，活動紀錄成 ⌘1 與首屏，空狀態即首次使用；狀態列收成 4 項 | 075 階段 B／C；擁有者 Q1 | 目的地 ratchet 8 → 7；「整體狀態只由 `source-status` 匯出」的 boundary 測試（075 已規劃） | 新專案首屏 3 秒測試；已有事件專案首屏；狀態列點擊到擁有者 | 14 個提到 `dashboard` 的 spec（A.2 grep 清單）、`first-run.spec.ts`（反覆失敗那支，2026-11-12 決定找根因，順便重寫） |
| P3 | 072 閱讀器＋074 讀取契約落地後：HTTP 頁、戰利品頁、範圍分頁、活動紀錄頁籤併入篩選與閱讀器；FilterBar 刪除 | 072、074；擁有者 Q2 | 目的地 ratchet 7 → 6；每頁首屏控制數 ratchet（在 `app-shell.spec.ts` 數 `role=button|textbox|combobox`，CI 只降不升） | 25 萬筆專案的活動紀錄篩選 HTTP 的速度；HTTP 列的欄位可讀性 | `http-body-search`、`managed-http-capture`、`plugin-explore`、`terminal-session-rotation`、`timeline-track`、`cast-content-reader`、`source-session-picker`、`official-agent-capture`、`external-session` |
| P4 | 073 落地後：設定 12 → 6；網路細項移 `machine.yaml`；刪設定搜尋、profile 匯入匯出 | 073 | `SettingsPage` 成員 ratchet；設定鍵 ratchet | 每個設定頁在窄窗 | `settings-search-closeout`（刪）、`settings-source-deep-link`、`capture-settings-interaction`、`profile-import`、`network-state-recovery` |
| P5 | 證據頁成為驗證的家（Integrity 移入）、錨定動作進次要選單 | 擁有者 Q6 | 「`verifyChain` 只有一個 renderer 呼叫端」斷言 | 斷鏈專案的驗證結果呈現 | `evidence-views`、`visual-reference` |
| P6 | 可選擷取收斂：週期截圖、指令截圖、剪貼簿、啟動更新檢查 | 擁有者 Q7 | 設定鍵 ratchet；計時器數 ratchet（`setInterval` 呼叫點數） | Windows 與 macOS 各一次升級舊專案（含這些鍵）不報錯 | `screenshot-capture`（若涉及週期）；`packaged-*`（更新） |

依記憶中的規則：worker 不能跑 Electron e2e，搬動 UI 前先 grep `e2e/` 並在 PR 前跑受影響的 spec；本機不跑 e2e 視窗（擁有者偏好），交給 CI。

---

## H. 風險，照直說

1. **收合只是把複雜藏起來**：活動紀錄吸收 HTTP、戰利品、逐字稿、AI 之後，所有能力都在一個「篩選」選單裡。若選單本身變成 15 個選項，首屏是乾淨了，第二屏更難。對策：種類篩選用 072 登記表自動產生，選單只列「本專案有資料的種類」；P3 的實機檢查要數第二屏。
2. **熟手依賴、程式看不出來的東西**：HTTP 頁的密集表格（方法、狀態、主機、大小一列看完）對做 web 的操作者是肌肉記憶；⌘4 這個鍵位本身；週期截圖在 GUI 工作時是唯一的視覺紀錄；書籤被當成「待回訪網址」清單用；挑選＋複製 Markdown 很可能正被用來寫報告。程式無法告訴我們使用頻率——RedLog 沒有遙測（報告 11），這是刻意的。
3. **與先前裁定衝突，需擁有者重裁**：
   - 「保留所有 HUD 功能」：本報告不刪 HUD 功能；但因此 IP 監控與每分鐘外部查詢必須保留（與報告 11 的隱私方向有張力）。
   - UIUX §5.3、Spec 064／069 的 ⌘1–7 順序；UX-002（活動與時間軸各有入口——本提案保留）。
   - Spec 075 FR-032、FR-034（儀表板卡、首次使用在儀表板）。
   - §5-6 註記：「標記與書籤是兩種東西，差別正是這個產品的賣點」——刪書籤直接推翻這段。
   - USER-GUIDE「整理報告素材」與「不做報告生成」並存；兩者至少有一個要改。
   - `settings-search-closeout.spec.ts` 代表先前有一輪設定搜尋的收尾工作。
   - 根因審查 §4「推導出的註記…原本的泳道保留為可展開的完整清單」：本報告把戰利品**頁**併掉，但時間軸的戰利品泳道照該決定保留為可展開清單，不衝突。
4. **刪除前置於契約之前的風險**：P2、P3 若早於 075／072／074，會把「沒有擁有者」的判斷搬到新位置，而不是消除它。表格中的前提欄不是建議，是硬條件。
5. **舊資料**：每一個 DELETE 都只刪輸入與產生新事件的路徑；若有人把對應的閱讀器、標題或 i18n 值鍵也一起刪，舊專案會出現原始 JSON 或 key 字串。`i18n-keys.test.ts` 抓不到動態組出的值鍵，需要在 072 登記表的 gate 補上「每個已知種類都有標題」的反向檢查。
6. **AX 的方向性**：把驗證露成 `/api/verify` 不增加風險（唯讀）；但若有人據「每頁主動作要有路由」去補專案建立路由，會擴大智能體的能力面，違反 071 O13 的精神。

---

## 檢查過、沒有問題的

- 設定檔沒有死鍵：約 50 個葉節點逐一在 main/core 找到讀取者（A.3）。
- `redaction.*` 雖然沒有 UI，確實被讀（`redaction.ts:226-228`、`config-apply.ts:149`）。
- HTTP 與活動紀錄的重疊是真的：`ActivityKind` 含 `http`（`activity-contract.ts:5`）。
- HUD 迷你標記只有標題＋備註，證明「沒有嚴重度與分類的標記」在現有產品裡已經存在且被接受（`overlay.markTitlePlaceholder`、`overlay.markNotesPlaceholder`）。
- 側欄已是固定順序、不可拖曳（`sidebarOrder.ts:1-17`），所以目的地 ratchet 只要數一個陣列。

## 刻意的設計（附依據）

- 時間軸與活動紀錄分頁：UX-002、§5-3 註記（使用者在活動頁底下找不到時間軸）。保留。
- 截圖與加入檔案在標題列：§10 與 UI/UX 稽核 F8（`App.tsx:422-423` 註解，原本只能從 ⌘K 到）。本報告改為收進「＋」選單而非移回 ⌘K，仍保持一擊可達。
- 匯出只在標題列：§10「one export control」（`App.tsx:413-415`）。保留。
- 書籤的 retention 預設保留：`config.ts` 註解寫明是便條而非證據；刪書籤後此鍵忽略。

## UNCONFIRMED（與最便宜的確認方式）

1. 首屏字串與概念數全為讀碼估計 → 在 1440 寬、新專案與有資料專案各截一次首屏，人工數。
2. 活動紀錄投影是否已含 logged 層的 HTTP 列 → 在有 HTTP 流量的專案，活動紀錄以種類 http 篩選，與 HTTP 頁比總數。
3. 匯出選單的實際可選組合數（能力閘控後）→ 逐格式打開匯出選單記錄可用選項。
4. 72 個無字面引用的 i18n 鍵中，哪些由 main（`tray.*`、`quit.*`）或其他方式組出 → grep `src/main` 的 i18n 取值方式。
5. `/api/clock`、`/api/session/registered`、`/api/export/har` 是否有 repo 外的使用者 → 問擁有者，或在一個版本中對這些路由記 deprecation log。
6. 行數合計（≈6–7k renderer、≈1.5k main/core）與鍵數（≈600–750）→ 每階段由 ratchet 的「now」值讀出實數。

---

## 一頁總表

| 頁 | 唯一主要意圖 | 首屏保留 | 收進一個次要選單 | 移走／刪除 | 控制 前→後 ≈ | 概念 前→後 ≈ |
|---|---|---|---|---|---|---|
| 專案選擇器 | 開一個專案 | 搜尋、清單、建立 | 進階（範圍） | 標語、頁尾、鍵盤提示、匯入設定檔 | 15→9 | 5→2 |
| 儀表板 | — | — | — | 整頁刪除，內容分流 | 24→0 | 12→0 |
| 活動紀錄（⌘1、首屏） | 找到並打開一筆紀錄 | 標題、搜尋、篩選鈕、列表／空狀態 | 種類、目標、時間、上鏈、個人流量 | 頁籤、時區、錄製狀態、FilterBar；吸收 HTTP、戰利品、逐字稿、AI | 37→6 | 12→3 |
| 時間軸 | 看順序與因果 | 範圍、縮放、搜尋、圖 | 模式、焦點鏈 | FilterBar、說明對話框 | ≈22→6 | 10→6 |
| 目標 | 這台主機發生了什麼 | 搜尋、目標列（含範圍狀態） | 範圍外觀測、撤回 | 範圍頁籤、完整性區塊、說明段 | 21→5 | 7→3 |
| 證據 | 證明紀錄沒被動過 | 驗證鈕＋結果、證據檔清單 | 立即錨定、全部升級、觸發篩選 | 戰利品（→活動）、書籤（刪）、說明 | ≈40→8 | 9→4 |
| 終端機 | 在被記錄的終端裡工作 | 分頁、終端 | — | hint、about 對話框 | 16→14 | 5→2 |
| 設定 | 改一個設定 | 6 列 | — | 搜尋、副標、描述、徽章、自動儲存提示；6 頁併入、證據鏈移出 | 首頁 ≈30→6 | 15→6 |
| HUD | （保留全部） | 不變 | — | HudPage 併入網路與 HUD | 不變 | 不變 |

## 回報最大的 10 項（概念＋程式移除 ÷ 損失）

1. **刪除儀表板**（活動紀錄成首屏）：首屏 −12 概念、≈650 行＋≈80 鍵；損失一眼總覽（狀態列＋HUD 補）。
2. **刪除 `redlog-share-worker/`**：797 行、零損失。
3. **刪除共用 FilterBar**（隨 074）：4 頁各 −6 概念、236 行＋35 鍵；損失跨頁共用篩選（074 已決定不要）。
4. **HTTP 頁併入活動紀錄**：−1 目的地、710 行＋27 鍵；損失 proxy history 式密集表格。
5. **刪除書籤**：−1 子頁、−2 路由、≈630 行＋42 鍵＋1 設定；損失可編輯的網址便條。
6. **設定 12 → 6 頁並刪設定搜尋**：首頁 −6 列、535＋≈300 行、≈60 鍵；損失以搜尋直達冷門設定。
7. **完整性 5 處 → 證據頁 1 處**：−4 個重複表面、≈150 行；損失在儀表板順手看到錨定時間。
8. **戰利品頁與範圍分頁併入**：−2 子頁、≈700 行＋≈60 鍵；損失戰利品的專用分組列表。
9. **刪逐字稿挑選＋多步 Markdown**：≈260 行＋≈10 鍵、0 個 e2e；損失報告素材整理（本來就違反方向）。
10. **標記對話框收成標題＋備註**（與 HUD 同形）：−3 個輸入、−2 概念；損失新標記的嚴重度與分類（舊資料照讀）。

## 需要擁有者決定的問題

1. **刪除儀表板，活動紀錄成為 ⌘1 與開專案後的第一屏，首次使用變成活動紀錄的空狀態＋設定 ▸ 擷取來源？** 建議：是。損失：一眼總覽；要改 §5.3、Spec 064/069 的編號與 Spec 075 FR-032/034。
2. **HTTP 頁併入活動紀錄（種類篩選＋HTTP 閱讀器）？** 建議：是，但只在 072/074 落地後。損失：HTTP 專用的密集表格與 ⌘4。
3. **刪除書籤（升級時一次性匯出成檔案）？** 建議：是。損失：可編輯的網址便條；推翻 §5-6「標記與書籤之別是賣點」。
4. **刪除逐字稿的挑選、只看已挑選、多步複製 Markdown，並刪 USER-GUIDE「整理報告素材」一節？** 建議：是（「不做報告生成」）。損失：寫報告時的素材整理；已寫入的挑選標記照常顯示。
5. **新標記只收標題＋備註（＋截圖），刪嚴重度、分類、URL 輸入？** 建議：是。損失：標記上的分級與 ATT&CK 式分類；舊標記照讀。
6. **證據頁成為「驗證」的家（設定的證據鏈頁移入、戰利品移到活動紀錄）？** 建議：是。損失：設定裡的證據鏈入口；驗證從 3 擊變 1 擊。
7. **可選擷取收斂：刪週期截圖與指令截圖、刪剪貼簿監控、更新檢查改為只手動？** 建議：三者皆是。損失：GUI 工作的連續視覺紀錄、複製內容的紀錄、自動得知新版。
8. **設定 12 → 6 頁並刪設定搜尋，網路的 4 個細項（providers、confirmations、ipMode、checkInterval）只留在 `machine.yaml`？** 建議：是（在 073 之後）。損失：從 UI 調 IP 查詢細節、以搜尋直達設定；HUD 功能不受影響。
