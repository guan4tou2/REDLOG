# 04 · 擷取來源生命週期與狀態模型（root-cause review）

範圍：「這個來源能不能記、有沒有在記、我怎麼知道、我該做什麼」——首次使用、儀表板、擷取狀態卡、狀態列、設定、外掛、HUD、CLI。
基準：main `a087c16c`；PR #700（`255bb4eb`）只當脈絡引用。唯讀審查；跑過 `test/capture-health.test.ts -t "dark when no hooks"`（綠，證實新專案判 dark 是被測試釘住的契約）。

## 摘要（10 行）

1. 根因只有一個：**來源狀態沒有擁有者**。main 輸出一包原始欄位（`installed/enabled/state/lastEventAt/ownShell*/managedHttpProxy/httpsVerification`），每個畫面各自把它們拼成一個字。同一個問題至少有 4–6 份互相獨立的答案（F1）。
2. `verdict` 混了三種不相干的事實：本機 hook 有沒有裝（每台機器）、這個專案有沒有事件（每個專案）、寫入／證據鏈是否壞掉（完整性）。結果是新專案一開就判 `dark`，同一個空專案在裝過 hook 的機器上卻是 `healthy`（F2）。
3. 「驗證過」沒有持久、有範圍的記錄：shell 的 nonce 證明只存在 React state；HTTPS 證明放在記憶體裡，proxy 一停就清掉，而 proxy 每次開專案都會自動啟動。所以每次啟動，每台有 mitmdump 的機器都會變 amber（F3）。
4. 詞彙跟著畫面的 i18n 命名空間走，沒有任何地方把「狀態」對應到「字」。所以會一字兩義（未安裝、已關閉、執行中），也會一義多字（not verified 有 7 種說法，dark 有 5 種）（F4）。
5. 會改變 RedLog 狀態的動作沒有固定的家：安裝、啟用、驗證、移除在卡片、設定、外掛、首次使用各有一份；「來源 → 設定位置」的對照表也有 3 份（F5）。
6. 首次使用把系統自己的準備推給操作者：preflight 回來前整頁擋住、缺 python3 時整頁換掉（包括 HTTP 卡），「核心擷取已就緒」還要求 mitmproxy 的 HTTPS 驗證，預設了操作者會用這個工具（F6）。
7. Spec 070（Draft）FR-001–004 已經指出要有共用的 `CaptureSourceStatus`，但 T006 沒做。`core/capture-contract.ts` 的 `captureFacts` 是半步（只有 3 個呼叫端）。
8. 提案：在 `core/source-status.ts` 用一個純函式，從具名事實（標明範圍：機器／專案／執行期／終端機）導出「一個狀態 + 一個理由 + 至多一個動作」，共 8 個固定狀態字。verdict 與注意數也只由它導出。
9. 這套模型對外掛一視同仁：來源由 descriptor 宣告前置、安裝方式、存活訊號，不寫死任何工具名稱。
10. 遷移分 6 步，每一步 app 都能用。守門靠兩道：型別讓 renderer 拿不到原始欄位，再加一個 boundary 測試；每一步刻意更新的釘字串測試與要退役的 i18n key 都列在 §6。

---

## 1. 實際的狀態機（從程式抽出）

### 1.1 core 的單一來源列（`src/core/capture-health.ts`）

- `SourceState = ready|unset|off|error`（:43），由 `stateFrom`（:383-404）決定：`enabled===false → off`；有任何事件 → `ready`；`installed===false → unset`；**其他一律 `ready`**。所以 `installed` 是 undefined 的來源（screenshot、browser-console、內建終端用 `alwaysPresent`）沒做任何設定也是 `ready`（中文「可用」）。
- 之後的覆寫：live `lastError`，且之後沒有新事件 → `error`（:617-635）；內建 pane 錄製失敗 → terminal `error`（:699-703）；前置條件 `missing` 且不是 `off` → `error`（:709-714）；AI 列遇到 conflict／error／update-available／transcript 目錄不存在 → `error`（:659-661）。
- 外掛 producer（`informational`）：`running || last!==null ? ready : off`（:753）。永遠不會讓 verdict 變差（:757-768），例外是「有心跳但停送」→ partial（:779-781）。
- verdict（:795-809）：sample broken → dark；DB 寫入錯誤 → dark；`!anyWired && !everFed` → dark；source error、proxy failed、producer stalled → partial；其餘 → healthy。`anyWired` 要求 `installed===true`，沒有考慮 `alwaysPresent`（:766-768）。

### 1.2 各來源種類的獨立事實，以及誰把它們壓成哪個字

| 來源 | 存在本機 | 前置／權限 | 已安裝 | 本專案啟用 | 此刻可達／運行 | 證明過（何時、憑什麼） | 最近收到 | 降級 | 操作者暫停 |
|---|---|---|---|---|---|---|---|---|---|
| shell hook（zsh/bash/PS，每個 shell） | `available`（shell 二進位，**且** python3+curl：`hooks-manager.ts:181,194,599-614`） | preflight `neededFor`（`runtime-preflight.ts:96-107`）、PS 執行原則 | `installed`（rc 檔） | 無（每台機器）；每個終端機一份 enrollment | 無 | nonce：只在 `RecordTerminalFlow` 的 `phase` state；或從事件推（ownShell*） | `ownShellLastEventAt`（每專案 DB） | `ownShellOutputAt`（只有指令、沒輸出） | `redlog stop`（每個終端機檔） |
| 內建終端 | 永遠 | 同一支 hook（`terminal-manager.ts:742-788` 會 source 同一份腳本），所以也需要 python3/curl | — | — | pane 的 `hookSourced`、`recording-failed` | `commandEvidence().builtin` | `terminalLast` | cast 截斷 | 全域 REC |
| managed HTTP proxy | mitmdump on PATH | preflight `mitmdump` | `installed = available`（:476） | 無開關 | `stopped/starting/running/unavailable/failed` | HTTP nonce：proxy 記憶體 `proof`；history 檔（7 態） | `lastEventAt` | `unsavedGapEvents` | 全域 REC |
| HTTPS 信任 | — | CA 檔 | — | — | — | 首次使用的 `trustVerified`（有 caveat）、dashboard 的 `httpsVerification`（沒有 caveat）、history `caTrustVerified:false` | — | — | — |
| AI 整合（每種 agent） | transcript 根目錄存在 | — | 外掛 catalog：`installed/update-available/conflict/error/not-installed` | `resolveAgentCapture` 的 8 個條件 | 無存活訊號 | 無 | `lastEventAt` | — | 每個 session 排除／暫停 |
| screenshot | 永遠 | 螢幕錄製權限（`capture-prerequisites.ts:21-43`） | — | 無開關 | — | 無 | `lastEventAt` | 空畫面 → `noteCaptureError` | 全域 REC |
| 連線／行程監控、剪貼簿、file watcher | pack 外掛已啟用 | `ss/netstat`（只有連線監控有） | — | pack + member 開關 | 無 | 無 | `lastEventAt` | 預算飽和（Spec 070 FR-016，未實作） | 全域 REC |
| pcap／透明代理／c2（外掛） | manifest `requires` 壓成 `available` 布林 | 同左；renderer 再用 regex 從 description 撈出依賴名（`ExternalCaptureGroup.tsx:108`） | `installed` | 外掛頁 `disabled` | 心跳 ≤60s | 無 | `lastEventAt`（依 `emits`） | 心跳但停送 | — |

各畫面怎麼壓縮這些事實：
- 儀表板指令列：`coreCommandState` 把 terminal 與兩個 AI 來源取「任一 ready」（`CaptureHealth.tsx:102-118`），再加上「Hook 已安裝／未安裝」tag 和「正在運作」tag（:152-155）。
- 儀表板 HTTP 列：`httpCaptureState`（`lib/httpCaptureState.ts:70-101`）有 8 態，加上「已驗證／待測試流量驗證」（:143-144）和 `healthyGap`（:444）。
- 首次使用：`commandsVerification`（`lib/coreCapture.ts`）+ `commandEvidence()`（`event-queries.ts:187-198`）+ 元件內 `httpVerified`，組成「✓ 核心擷取已就緒」（`FirstRunView.tsx:173`）。
- 設定 shell 列：`available/installed` → 「已安裝／未安裝」（`HooksPanel.tsx:118-131`）。
- 設定外部來源：心跳 → 「執行中」（`ExternalCaptureGroup.tsx:96-111`）。
- 外掛頁：`officialProjectLevel/officialHealth`（`pluginViewModel.ts:292-327`）。
- 活動頁：全域 REC → 「記錄中」，加 `error && !informational` 個數（`RecordingWorkspace.tsx:33-48`）。
- 狀態列：verdict → dot、label、issue、toast（`StatusBar.tsx:130-157,252-302`）。
- HUD：只有 REC 開關（`OverlayApp.tsx:315-316`）。
- CLI：`verdict` → `recording / wired but idle / ⚠ RECORDING NOTHING`，列出 `installed===false ? 'not installed' : state`（`cli/redlog-cli.js:320-326`）。
- shell 內 `redlog status`：終端機狀態檔 → 「recording enabled」（`hooks/redlog-relay.py:1247-1259`）。

---

## 2. 發現（依「解釋多少可見錯誤 × 擋掉多少未來缺陷」排序）

### F1　來源狀態沒有擁有者：每個畫面各自從原始欄位拼出答案

**機制。** 送過 bridge 的 `CaptureHealthInfo` 是事實袋，不是答案。每加一個畫面，就多一份「把事實翻成狀態」的程式，而且這些程式各自的子集條件會隨時間分岔。`captureHealthStore.ts` 統一了「讀」（一次讀、unknown 規則），沒有統一「解讀」。`capture-contract.ts` 的 `captureFacts` 有分開事實，但只有 `httpCaptureState`、`captureReadiness`、`officialHealth` 三處在用，而且它也不產生狀態。

**實例**（各組都是同一個問題、不同程式碼，已逐一讀過）：
1. **「整體有沒有問題／注意數」有 6 份。**
   - core verdict：`capture-health.ts:795-809`。
   - 卡片：`CaptureHealth.tsx:399-450`，自己再加上 rogue、`http==='failed'`、`healthyGap`。
   - 狀態列 issue：`StatusBar.tsx:140-149`，固定只有 1 則，不管有幾個來源壞掉。
   - 活動頁：`RecordingWorkspace.tsx:33`，只算 `error && !informational`，不含 proxy failed，也不含 rogue。
   - PR #700 的 `captureIssueView`：自己再算一次 failing 集合，並加上 proxy failed。
   - CLI：`redlog-cli.js:321` 把 `partial` 印成 **"wired but idle"**。`idle` 在 2026-10-05（`6f8de71a`）已從模型移除，`partial` 現在的意思是「有來源失敗」。CLI 對 agent 說的話正好相反，而 agent skill 是靠 `redlog_status` 判斷要不要繼續的。
2. **「操作者自己的 shell 已證明」有 4 份。**
   - `capture-health.ts:567-581`：只接受 `data.shell` 等於已安裝 hook 的 shell，不套 EVIDENCE_SQL。
   - `commandEvidence()`（`event-queries.ts:187-198`）：任何非 builtin 的 shell 列，含 subtype `command`，套 EVIDENCE_SQL，不看 shell 名。
   - `isActivationEvent`（`terminalActivation.ts:174-183`）：nonce、shell、WSL distro。
   - 終端機 enrollment 檔：`redlog status` 讀這個。
   可預期的分歧：PowerShell transcript、WSL，或 hook 已移除但舊事件還在的專案。首次使用會顯示「✓ 已收到你自己終端的指令」，同時儀表板寫「你自己的終端機還沒納入 —— 裝上 shell hook…」（`capture.terminalOwnShellMissing`）。
3. **「AI 來源是否為本專案記錄」有 3 份。**
   - core `resolveAgentCapture`（`agent-capture-policy.ts:27-40`）檢查 8 項，包括 workPaths 必須是絕對路徑、startedAt 有效。
   - `AgentRow.projectRecording`（`AgentsPanel.tsx:55`）只看 3 項。
   - `officialProjectLevel`（`pluginViewModel.ts:292-300`）同樣只看 3 項。
   具體分歧：手動輸入相對路徑時 `addWorkPath` 不擋（`AgentsPanel.tsx:94-101`）。勾選後，設定列打勾，外掛頁寫「已為此專案啟用。」，core 卻不啟動 tailer；健康列 `enabled:false` → `off`，儀表板寫「已關閉」。（UNCONFIRMED-U4）
4. **「HTTPS 已驗證」有 3 份。**
   - 首次使用 `trustVerified`（`HttpCaptureStep.tsx:146,248-255`）：擷取瀏覽器那條路是 amber「◐ 已擷取 · CA 未驗證」。
   - 儀表板 `verified = http==='ready' && !!verification`（`CaptureHealth.tsx:143,172-173`）：沒有 caveat，同一次驗證會變綠色「已驗證（Chrome …）」。
   - history 檔一律寫 `caTrustVerified: false`（`main/index.ts:1047`）。
5. **「前置條件」有 6 份。**
   - `hooks-manager.ts:181,194` 的 `requiresAll`。
   - `runtime-preflight.ts:103-107` 的 `neededFor`。
   - `terminalActivation.ts:18` 的 `DEPENDENCIES`。
   - `CapturePreparation.tsx:13-22` 的 `preparationChecks`（寫死 python3/curl/mitmdump）。
   - `capture-prerequisites.ts`（只有 screenshot 和連線監控）。
   - `ExternalCaptureGroup.tsx:108` 用 regex 從描述文字撈出 `tcpdump|tshark|mitmdump|node`。
   外掛 manifest 明明有 `requires`，卻在 `detectHooks` 被壓成布林。

**為什麼之前的修補只治了症狀。**
- #435：只統一了「最後收到」那一行。
- `captureHealthStore`：只統一了讀取。
- #700：把 issue 的目的地修好了，但做法是再加一份 failing 集合，再加一份 `sourceTarget` 對照表。
- Spec 070：寫了 FR-001／003，T006 沒做。
每一次修補都讓解讀的副本多一份。

**結構性改變。**
- 新增 `core/source-status.ts`，提供 `deriveSourceStatus(descriptor, facts): SourceStatus` 與 `deriveCaptureVerdict(statuses, integrity)`，都是純函式。設計見 §3。
- main 的 `capture:health`、`/api/status`、`/api/capture` 回傳 `{ verdict, attention, statuses, integrity }`。原始事實只放在 `statuses[i].facts`，型別是 readonly，供細節列顯示。
- 刪除：`lib/captureReadiness.ts` 的 `statusFor/computeCaptureReadiness/primaryCaptureAction`、`lib/coreCapture.ts`、`lib/httpCaptureState.ts`、`CaptureHealth.tsx` 的 `ownShellKey/coreCommandState/isProblem/dark/partial/healthyGap/coreGap`、`officialProjectLevel/officialHealth`、`AgentRow.projectRecording`、`ExternalCaptureGroup` 的 stateLabel 鏈與 regex、`captureIssueView`。CLI 改成印 `status.word`。

**不變式：** 對同一 `sourceId`，任何畫面顯示的狀態字等於 `statuses[id].state` 對應的字。

**閘門：** renderer 型別上拿不到原始欄位（§6.2），再加 boundary 測試。

**影響範圍。**
- renderer：約 15 個檔案。
- core：`capture-health.ts` 改成事實收集器。
- CLI、`shell/redlog-agent.sh` 的輸出格式（agent 讀 JSON，要保留舊欄位一個版本）。
- 磁碟資料無變更，跨平台無差異。

**可能出錯的地方。** `/api/status` 是公開介面（docs/codex-tools.json、skill）。改欄位會讓外部 agent 讀錯，要並存一個版本。

**驗證方式。**
- 表格式單元測試：每種事實組合 → (state, reason, action)。
- 等價測試：沿用 `capture-health.test.ts:895` 的「每種怪列」矩陣，斷言新舊映射表。
- 實跑 U1–U6。

### F2　verdict 把「這台機器裝了什麼」「這個專案收過什麼」「完整性壞了」混成一個字；「沒有事件」被當成故障

**機制。**
- `dark = !anyWired && !everFed`（`capture-health.ts:800`）。`anyWired` 需要某個來源 `installed===true`（每台機器的事實），`everFed` 看本專案 DB（每個專案的事實）。
- 2026-10-05 合併終端列時，`alwaysPresent` 只加進了 `stateFrom`（:618），沒加進 `anyWired`。
- 同一個 `dark` 也承載 sample broken 與 DB 寫入失敗（:798-799）。所以狀態列文案只能寫成三選一的長句：`statusBar.captureDark`「紀錄可能不完整 —— 鏈結或寫入出了問題，或還沒有任何擷取來源設定好」。

**實例。**
1. 新專案、沒裝 hook：「什麼都沒在記」（`capture.dark`）＋ 注意 1 ＋ issue，導向儀表板自己（`StatusBar.tsx:148`）。#700 對 dark 仍回傳 `'dashboard'`。而內建終端此時是 `ready`「可用」，同一張卡寫著「正在運作」（`CaptureHealth.tsx:155`）。測試把它釘死了：`test/capture-health.test.ts:64`「dark when no hooks installed」（已跑，綠）。
2. 同一個空專案、hook 已裝的機器：`anyWired` 為真 → `healthy`「擷取狀態正常」。決定專案 verdict 的是一個和這個專案能不能記無關的機器事實。
3. toast：`prevVerdict` 是 StatusBar 的 ref（:89）。StatusBar 沒有 key（`App.tsx:508`），換專案不會重置，所以從健康專案切到新專案會跳 toast「紀錄可能不完整…」（UNCONFIRMED-U1）。
4. 狀態列 label：dark 與「錄製中但還沒有事件」都印「等待事件中…」（`StatusBar.tsx:302`），dot 一個是 amber、一個是紅色脈動。同一個字，兩種嚴重度。
5. 反方向：本該是故障的沒報。terminal 因 `alwaysPresent` 恆為 `ready`，但以下情況其實記不到指令：
   - POSIX 缺 python3/curl（內建 pane source 同一支 hook）。
   - pane 的 `hookSourced:false`（例如沒有 adapter 的 shell，`terminal-manager.ts:780-788`）。
   這時卡片寫「可用／正在運作」，首次使用卻因同一個缺項整頁擋住（F6）。（UNCONFIRMED-U6）
6. 文件也站在錯的一邊：`README.md:247`「RedLog captures nothing until a source is wired up」；`captureReadiness.ts:145-149` 的註解要求 fresh install 讀成 dark。內建終端開箱可記之後，兩者都不成立。

**為什麼之前的修補治標。** 移除 `idle`（`6f8de71a`）處理了「安靜 ≠ 故障」，但只處理到 per-source state，verdict 的 dark 分支沒動。flow-audit 的「把 terminal 視為 wired」也只是最小補丁，completeness 與 verdict 仍然擠在同一個欄位。

**結構性改變。**
- 完整性（chain sample、DB 寫入）移出 capture verdict，成為獨立的 `integrity` 事實。StatusBar 已有 integrity issue 管道（`StatusBar.tsx:110-127`）。
- capture verdict 只由 source statuses 導出：

| verdict | 條件 | zh / en |
|---|---|---|
| `attention` | 任一來源 `failed`；或 enabled 但 `unavailable`；或 rogue | 需要處理 / Needs attention |
| `none` | 沒有任何來源處於 `ready`／`recording`，且沒有 `off`（真的沒有路可記：例如 python3 缺且沒有其他來源） | 無可用來源 / Nothing can record |
| `waiting` | 至少一個 `ready`、沒有 `recording`、無 attention | 等待第一筆事件 / Waiting for the first event |
| `ok` | 至少一個 `recording`、無 attention | 記錄中 / Recording |

- 注意數只算 `attention` 那一類，每個來源一則。`waiting` 和 `none` 不進 issue store、不 toast。`none` 只在儀表板以空狀態三件套呈現（§5-4）。

**不變式：** 一個新專案在任何機器上的 verdict，只取決於本專案可用的來源，與其他專案和其他 hook 無關。

**影響範圍。**
- 要改：`capture-health.ts` 的 verdict、StatusBar、卡片 headline、CLI、`/api/status`。
- 要刻意更新的測試：`capture-health.test.ts:64,163-167,904`、`capture-readiness.test.ts:39-61,187`、`capture-onboarding-render.test.tsx`。
- README:247。

**風險。** 「真的什麼都記不到」必須保留成 `none`，不能被 `waiting` 吃掉。判準是「有沒有任何來源能記」，所以內建終端的前置條件必須是真事實（F1-5），否則 `none` 永遠不會出現。

**驗證方式。** 表格測試（新專案 × {有 hook, 無 hook} → `waiting`；缺 python3 且無其他來源 → `none`），再實跑 U1、U6。

### F3　「證明」沒有持久、有範圍的記錄：要嘛活不過一次重啟，要嘛只活在一個 React 元件裡，要嘛永遠不過期

**機制。** 證明（nonce 到達、HTTPS 握手成功）是一種事實，應該有範圍（機器 × adapter 版本，或機器 × CA × endpoint × routing）、有失效條件（context 改變），不靠時間。現況是三種載體，各自錯在不同地方。

**實例。**
1. shell nonce：`RecordTerminalFlow` 的 `phase==='verified'` 是元件 state。離開首次使用就不存在了；儀表板改用 ownShell 事件推論。
2. ownShell 的證明是每個專案各一份。昨天在 A 專案已證明的 zsh，到新專案 B 卡片寫「shell hook 已安裝 · 開一個新終端機跑一個指令，**安裝才算完成**」（`capture.terminalOwnShellPending`）。這是在說一台已經裝好、已經證明過的機器沒裝完。
3. HTTPS：proof 只在 `ManagedHttpProxy` 記憶體，proxy 不是 running 就清掉（`managed-http-proxy.ts:273`）。proxy 從 2026-09-29（`6ecaafdf`）起每次開專案自動啟動（`core/http-autostart.ts`）。`healthyGap`（2026-11-07 `f168a905`，`CaptureHealth.tsx:440-444`）在 `http==='ready' && !httpsVerification` 時把 headline 變 amber「部分來源待確認」。
   - 它自己的註解說「not every coreGap — an operator who does not use the proxy would otherwise see an amber headline for good」。
   - 但 autostart 讓所有裝了 mitmdump 的機器都是 `http==='ready'`。所以每次啟動、每位操作者，包括走 Burp 自己的 proxy、從不用 managed proxy 的人，都會一直是 amber，直到這次執行重新驗證。
   - history 檔明明記著「上次 HTTPS 擷取成功；需要重新驗證」（`httpVerification.previously-verified`），儀表板卻不讀它。（UNCONFIRMED-U2）
4. enrollment：外部終端機的 `~/.redlog/terminals/*.json` 不會被移除。zsh 的 `zshexit` 只刪 relay 目錄（`shell-zsh-hook.zsh:665-668`），只有內建 pane 會 `removeTerminalEnrollment`（`terminal-manager.ts:732,819,848`）。`enrolledTerminals()`（`capture-health.ts:645-649`）也不依 `engagementId` 過濾。卡片上的「{total} 個終端機中有 {recording} 個正在記錄」會累積所有專案、所有已關閉的終端機。（UNCONFIRMED-U5）
5. 反向的永不過期：`stateFrom` 的「Evidence beats detection, and it has no expiry」（:392-401）。hook 已移除（`installed:false`），但專案裡有舊事件時，列仍是 `ready`。對「這個專案是否曾記錄」這是對的；對「現在能不能記」是錯的。現況用同一個 `state` 回答這兩個問題。

**結構性改變。**
- 新增 `ProofStore`（main，機器範圍，`~/.redlog/proofs.json`，0600，有上限）。每筆是 `{ sourceId, adapterKey, context, at, by }`：
  - shell：`adapterKey` = hook 檔內容雜湊，`context` = shell 名（+ WSL distro）。
  - HTTPS：`context` = CA 指紋 + endpoint + routing + client 族群。`HttpVerificationEvidence`（`http-verification-evidence.ts`）去掉 `projectId` 後可直接沿用，它的 context 失效規則已經是對的。
- nonce 改由 main 發出並比對。ingest 看到 `redlog-ok-<nonce>`，或 addon 回報 verify 時寫入 ProofStore，不再依賴 renderer 元件還掛著。
- 狀態函式把證明當成理由（reason）：「已於 11/10 由 Zsh 驗證」或「設定已變更，需要重新驗證」。**證明從不改變 state 的嚴重度**：沒驗證的 ready 仍是 ready，不是 amber。
- enrollment 加入 `pid`（或 tty），列舉時剔除不存在的行程，並依目前專案的 `engagementId` 過濾。

**不變式：** 證明只會因為它的 context 改變而失效，與時間、重啟、換專案無關；也沒有任何證明缺席會產生 attention。

**影響範圍。**
- main：verify sink、ingest hook 偵測。
- renderer：`RecordTerminalFlow`、`HttpCaptureStep` 改讀 main 狀態。好處是首次使用與設定頁的驗證面板共用狀態，flow-audit D3 一併消失。
- 磁碟：新增一個檔案；`http-verification.json` 的每專案 history 可保留為唯讀歷史。

**風險。**
- HTTPS 的 client 身分只能靠 UA（`http-verify.ts`、`main/index.ts:332` 已承認），所以「信任」只能說到「某 client 族群」。
- enrollment 加 pid 會改到 relay 的檔案格式（`redlog-relay.py:begin_terminal`），要相容舊檔：沒有 pid 的舊檔視為未知、不計入。

**驗證方式。** ProofStore 單元測試（context 改變才失效）；實跑 U2、U3、U5。

### F4　狀態字沒有詞表：字由畫面的 i18n 命名空間決定，不由狀態決定

**機制。** 狀態 key 分散在 `capture.state.*`、`capture.http.*`、`httpCapture.state.*`、`firstRun.core.*`、`httpVerification.*`、`settings.external*`、`settings.hook*`、`plugins.healthAxis/projectAxis/installState/status.*`、`statusBar.*`、`activity.status.*`、`terminal.meta.*`，共 96 個（§6.3）。沒有測試把「狀態」對到「唯一的字」。§5.6 譯名表只管名詞，不管狀態。

**實例**（逐一對過 zh-TW.json；第一列是新發現）：
- **「未安裝」= shell 不存在，或 python3/curl 缺。** `settings.hookNotFound` 在 `!hook.available` 時顯示（`HooksPanel.tsx:128`），而 `available` 在 `requiresAll` 缺任一項時為 false（`hooks-manager.ts:599-600`）。所以一台有 zsh、沒 curl 的機器，zsh 列寫「未安裝」。
- **「已關閉」= 操作者關掉／AI 整合根本沒安裝／手動 producer 沒啟動。**
  - AI 列：`enabled = activeAgents.some(...)`（`capture-health.ts:655`），沒安裝時為 false → `stateFrom` 第一條 → `off`。
  - 外掛 producer 沒跑 → `off`（:753）。卡片印 `capture.state.off`，CLI 印 `off`，設定頁同一列卻印「沒在跑」。
- **「執行中」**（`settings.externalFeeding`）其實只代表「有心跳」，變數名叫 `feeding`（`ExternalCaptureGroup.tsx:95`），一個 key 說兩件事。
- **dark 有 5 種寫法：** 什麼都沒在記／沒有在記錄（`capture.confirmed.dark`）／紀錄可能不完整…／等待事件中…／⚠ RECORDING NOTHING（CLI）。
- **not verified 有 7 種：** ○ 尚未驗證／待測試流量驗證／HTTPS 尚未以工具驗證／HTTP 尚待工具驗證／待驗證／尚未設定驗證／上次 HTTPS 擷取成功；需要重新驗證。
- 其餘幾組 flow-audit §4 已列，本次查證屬實：「停用 vs 移除」（同一個 `removeHookWithUndo`）、「可用 vs 擷取中」（同一個 `ready`）。

**為什麼修補治標。** 每次統一都只動一個畫面，例如 #435 只統一「最後收到」那一行。`test/ui-copy.test.ts` 只抓「同一說明存在兩個 key」，抓不到「兩個 key 說同一個狀態但用不同的字」。

**結構性改變。**
- 狀態字只存在 `source.state.<state>`（8 個）。理由只存在 `source.reason.<code>`（固定清單，§3.4），動作只存在 `source.action.<code>`。
- verdict 只存在 `capture.verdict.<v>`（4 個）。
- 測試 `test/source-status-vocabulary.test.ts`：
  - `SourceState`、`ReasonCode`、`ActionCode` 的每個成員在兩個語系都恰有一個 key。
  - 其他命名空間的值不得與這些狀態字完全相同（防止別處再造一份「可用」「已關閉」）。

**影響範圍：** i18n 與釘字串的 test/e2e（verify:i18n 會列出，見 §6）。

**風險：** 文案變動大，要一次在同一個 PR 改測試。

### F5　會改變 RedLog 狀態的動作沒有唯一的家；「來源 → 設定位置」有 3 份對照

**機制。** 每做一個新畫面，就為了少一次跳轉把動作複製過去。flow-audit D1–D6 是結果。複本各有一套成功判準（#700 修的 nonce 落差就是其一），而且各有一份「這個來源在哪裡設定」的表：
- `CaptureHealth.tsx:150,168`：寫死 hooks／browser。
- `CaptureHealth.tsx:292,537-539,583-585`：`isAgentRow` → captureControl。
- #700 的 `captureIssue.ts` `sourceTarget`。

下一個來源（Burp 外掛，Spec 070 US6）會需要第四份。

**實例**（main 上）：
- 安裝 shell hook：`CaptureHealth.tsx:437`（cta）、`:567-575`（manage 安裝／移除）、`HooksPanel.tsx:138-148`、`FirstRunView.tsx:330`。
- 開關 pack member：`CaptureHealth.tsx:558-566` 與 `CaptureControlPage`。
- HTTP 啟停：`HttpCaptureStep.tsx:214,443` 與 `settings/BrowserPanel.tsx:90-95`。
- HTTPS 驗證面板：首次使用與 `BrowserPage.tsx:54-55` 各有自己的 `attempt` state。

**結構性改變：** 見 §4。每個 descriptor 宣告 `owner`（設定頁的列錨點）。其他畫面只顯示 state、reason，以及一個「前往 {owner}」連結。唯一的例外是「只開 OS 面板或複製指令」的修復，因為它不改 RedLog 狀態，可在顯示理由的地方就地提供。

**不變式：** 會寫 config、hook 檔、外掛狀態或 proof 的 handler，每個來源只有一處 UI 會呼叫。用 boundary 測試列出允許呼叫 `hooks.install/uninstall`、`config.save(...packMembers|packs...)`、`httpCapture.start/stop`、`plugins.install` 的檔案。

### F6　首次使用把系統的準備推給操作者，並預設操作者會用 mitmproxy

**機制。** 首次使用自己維護一套「就緒」定義（`coreCaptureReady`），自己跑 preflight，自己決定整頁替換，跟儀表板的模型無關。

**實例。**
- `preparing` 初值為 true（`FirstRunView.tsx:84`）。preflight 回來前整頁只顯示「正在檢查…」。
- 初次載入時若有指令擷取阻礙，`CapturePreparation` 會整頁取代（:186）。#700 加了 `keepPage`，但它的初值是 false，所以初次進入仍整頁取代，HTTP 卡也一起不見，雖然 HTTP 並不需要 python3。
- 「✓ 核心擷取已就緒」需要 `http: httpVerified`（:173），而這只能經由 managed proxy 的 nonce 達成。走 Burp 等自己 proxy 的操作者永遠到不了「就緒」。這違反「不預設工具」的既定決策。
- 「開啟內建終端機 ↗」要多按一次（flow-audit 已提）。

**結構性改變：** 見 §5。

---

## 3. 單一模型設計

### 3.1 位置與形狀

```ts
// core/source-status.ts — pure, no IO
type Scope = 'machine' | 'project' | 'runtime' | 'terminal'
interface SourceDescriptor {           // core sources + plugin manifests, same shape
  id: string; label: string            // label from manifest or i18n key
  kind: 'adapter' | 'service' | 'integration' | 'resident' | 'producer'
  requires: PrereqSpec[]               // from manifest `requires`/`requiresAll`, preflight table, OS permissions
  install?: 'machine'                  // has an install step at all
  enable?: { path: string }            // per-project switch, if any
  liveness: 'process' | 'heartbeat' | 'pane' | 'none'
  startedBy: 'redlog' | 'operator' | 'always'
  proof?: 'nonce-shell' | 'nonce-http' // what counts as proven
  owner: SettingsAnchor                // the ONE place its state-changing actions live
}
interface SourceFacts {                // each fact carries its scope implicitly by field
  present: boolean | null                         // machine
  prereqs: Array<{ id; state: 'ok'|'missing'|'unknown'; fix? }>  // machine
  installed: boolean | null                       // machine
  integration?: 'ok'|'update-required'|'conflict'|'error'   // machine
  enabled: boolean | null                         // project (null = no switch)
  authorizationValid?: boolean                    // project (AI: resolveAgentCapture result)
  running: 'yes'|'no'|'starting'|'failed'|null    // runtime
  lastError?: { at; code; message }               // runtime
  lastStoredAt: number | null                     // project
  writingWhileOff: boolean                        // project+runtime (rogue)
  gaps?: { unsaved?: number; truncated?: boolean; outputMissing?: boolean } // project
  proof?: { at; by; valid: boolean }              // machine (ProofStore)
  terminals?: { live: number; recording: number } // terminal, filtered to this project + live pids
  read: 'ok'|'unknown'
}
interface SourceStatus { id; state: SourceState; reason?: Reason; action?: Action; facts: Readonly<SourceFacts> }
```

收集事實（`collectSourceFacts`）留在 main 的 `capture-health.ts`，它變成收集器。導出只在這個純函式。HooksPanel、ExternalCaptureGroup、AgentRow、外掛頁都改讀 `statuses`，不再各自呼叫 `hooks.detect()` 去解讀；`detect()` 仍可用來取 manualSteps 這類「內容」。

### 3.2 固定的狀態（8 個）與優先序（由上往下取第一個成立者）

| # | state | 條件 | zh-TW | en | 色調 | 進 attention？ |
|---|---|---|---|---|---|---|
| 1 | `unknown` | `read==='unknown'` | 無法確認 | Unknown | neutral | 否 |
| 2 | `failed` | rogue（off 且仍在寫）；`lastError` live 且之後無事件；`running==='failed'`；有心跳但停送；pane 錄製失敗 | 失敗 | Failed | danger | **是** |
| 3 | `off` | `enabled===false` | 已關閉 | Off | neutral | 否 |
| 4 | `unavailable` | `present===false`；任一 prereq `missing`；`integration` 為 conflict／error／update-required | 無法使用 | Unavailable | neutral；若 `enabled===true` 則 warn | 僅在 `enabled===true` 時 |
| 5 | `not-set-up` | 需要安裝但 `installed!==true`；或 AI 未授權／缺 workdir | 未設定 | Not set up | neutral | 否 |
| 6 | `stopped` | `startedBy!=='always'` 且 `running==='no'`（proxy 未啟動、手動 producer 未跑） | 未啟動 | Stopped | neutral | 否 |
| 7 | `ready` | 能記，本專案尚無事件 | 待命 | Ready | neutral | 否 |
| 8 | `recording` | 能記，且本專案已有事件 | 記錄中 | Recording | safe | 否 |

設計說明：
- rogue 排在 `off` 之前。這是現況已有的判斷（`CaptureHealth.tsx:394-399`），模型把它收進來。
- `starting` 不另立 state，歸在 `stopped`，理由是「啟動中」。
- `recording` 只說「本專案收過且現在沒壞」。最近一筆的時間以 age 當資料顯示，不分級（沿用 `idle` 已移除的決策）。
- 全域 REC 暫停不是來源狀態。它是一個頂層事實，狀態列與 HUD 已經顯示。模型在 REC 關閉時給每個 `ready/recording` 列加上理由「錄製已暫停」，不改 state。

### 3.3 一個新專案、什麼都沒接時要說什麼

| 情況 | 說什麼 |
|---|---|
| macOS／Linux，有 python3 | 內建終端 `ready`「待命」；verdict `waiting`「等待第一筆事件」；無注意數、無 toast；儀表板的唯一動作「開啟終端機」。shell hook 列 `not-set-up`（理由「只記錄 RedLog 內的終端機」），動作連到 owner。HTTP 列 `ready`（autostart）或 `unavailable`（缺 mitmdump，未啟用 → neutral、不進注意）。 |
| 缺 python3 | 內建終端 `unavailable`（理由「找不到 python3」，動作「準備」）。若沒有其他來源可記 → verdict `none`「無可用來源」，空狀態三件套：會出現什麼、為什麼沒有（缺 python3）、一顆「準備」。仍不 toast：這是 setup，不是事件。 |

「等待第一筆事件」與「什麼都記不到」的差別只有一條：是否存在 `ready` 的來源。這是事實，不是猜測。

### 3.4 理由（reason）與動作（action）的固定清單

reason（每列至多一個，依優先序挑）：
- 失敗類：`writing-while-off`、`port-in-use{address,holder}`、`start-failed{message}`、`capture-error{message}`、`producer-stalled`、`pane-recording-failed`。
- 無法使用類：`missing-command{cmd}`、`permission{kind}`、`shell-not-found{shell}`、`integration-update-required`、`integration-conflict`。
- 未設定類：`no-workdir`、`scope-changed`、`own-terminals-not-included`、`manual-start`。
- 待命／記錄中類：`awaiting-first-event`、`proven{at,by}`、`proof-invalidated`、`recording-paused`、`unsaved-gap{n}`、`output-not-recorded`、`terminals{live,recording}`。

action（至多一個）：`fix-prereq`（就地；只開 OS 面板或複製指令）、`prepare`（安裝依賴，就地）、`open-owner`（其他一切）、`start`（只在 owner）、`retry`（失敗後，§25.6）。

### 3.5 驗證（verified）如何呈現與老化

- 證明是 reason，不是 state，也不影響色調。「待命 · 已於 11/10 由 Zsh 驗證」與「待命」同一個綠色程度。
- 失效只看 context（adapter 雜湊、CA 指紋、endpoint、routing）。失效時理由變「設定已變更」，動作 `open-owner`（去驗證）。
- 首次使用與設定頁的驗證面板讀同一份 ProofStore。
- HTTPS：證明說的是「{client 族群} 已完成 TLS 經 RedLog CA」。擷取瀏覽器那條路寫成 `proven{by:'capture-browser'}`，並固定加上「不代表其他 client 信任」。儀表板與首次使用說同一句話。

### 3.6 每台機器 vs 每個專案 vs 每個終端機

| 事實 | 範圍 | 理由 |
|---|---|---|
| present、prereqs、installed、integration、proof、CA | 機器 | 換專案不會改變；也是今天「安裝才算完成」錯誤的來源 |
| enabled、authorization、lastStoredAt、gaps、writingWhileOff | 專案 | 證據屬於專案 |
| running、lastError | 執行期 | 重啟即失效，本來就該如此 |
| enrollment、`redlog stop`、hookSourced | 終端機 | 只以「本專案、存活中」的終端機彙總成 terminals reason |

verdict 只讀「專案 + 執行期」為主的 state（機器事實經由 state 進入）。不再有機器事實直接決定專案 verdict 的分支（例如 `anyWired`）。

### 3.7 對外掛與未知來源

外掛 producer 的 descriptor 由 manifest 產生：`requires` 不再壓成布林，`emits` 決定 lastStoredAt 探針，`liveness: heartbeat`，`startedBy: operator`，`owner` 為外部擷取來源列。沒宣告的欄位取保守預設（`liveness:'none'`、`startedBy:'always'`），所以未知來源最多是 `ready/recording`，不會產生 attention。現有的不對稱保證（`informational` 永不讓 verdict 變差）由規則 2 只在有明確失敗訊號時成立來延續。模型不出現任何工具名稱：mitmproxy、Burp、瀏覽器都只是某個 descriptor 的 `label`。

---

## 4. 動作的擁有者

| 來源 | install | enable（本專案） | verify | configure | remove | repair／前置 | 其他畫面顯示 |
|---|---|---|---|---|---|---|---|
| shell hook（各 shell） | 設定 ▸ 指令與終端（HooksPanel + RecordTerminalFlow） | — | 同左（nonce） | 同左（終端 App） | 同左，字「移除」 | 同左；prereq 就地修 | state + reason + 「前往」 |
| 內建終端 | — | — | 自然產生 | — | — | 設定 ▸ 指令與終端的準備列（prereq 就地修） | 同上；首次使用嵌入同一元件 |
| managed HTTP + HTTPS | 準備 mitmdump：設定 ▸ HTTP 擷取 | — | 同頁（唯一的驗證面板元件） | 同頁（埠、routing） | — | 埠衝突：同頁 | 同上；首次使用嵌入同一元件 |
| AI 整合 | 外掛頁（Spec 066 FR-003，既定） | 設定 ▸ 其他擷取來源 列 | — | 同列（workdir） | 外掛頁 | 外掛頁 | 同上 |
| pack 成員、screenshot、連線監控 | （pack 外掛）外掛頁 | 設定 ▸ 其他擷取來源 列 | — | 同列 | — | prereq 就地修 | 同上 |
| 外部 producer（pcap／透明代理／c2） | 外掛頁 | 外掛頁 | — | 外部擷取來源列（設定步驟） | 外掛頁 | 同列 | 同上 |

> 「首次使用嵌入同一元件」不算重複：用同一個元件、讀同一份 main 狀態。重複指的是另一份 handler、另一份 state。

今天的重複，以及要刪的那份：
1. `CaptureHealth.tsx:430-438`：cta「安裝 shell hook」（#700 改走 nonce flow）。**刪**。卡片只留 `open-owner`。
2. `CaptureHealth.tsx:567-575`：manage 模式的安裝／移除（含 mitmproxy 那顆，語意不明，flow-audit R6）。**刪**。
3. `CaptureHealth.tsx:558-566`：manage 模式的開啟／關閉。**刪**，owner 是 `CaptureControlPage`。卡片 manage 模式退化成唯讀清單 + 「管理來源」（:684 已存在）。
4. `HooksPanel.tsx:146-148`：「停用」。**保留**（owner），字改「移除」；退役 `settings.hookDisable`。
5. `HttpCaptureStep.tsx` 的 start（:214、:443）與 `BrowserPanel.tsx:90-95` 的 toggle：保留 BrowserPanel 的 handler；HttpCaptureStep 改用同一個 `HttpCaptureControl` 元件。
6. 首次使用的 HTTPS 驗證面板與 `BrowserPage.tsx:54-55` 的面板：同一個元件，`attempt` 移到 main（F3）。
7. 「來源 → 位置」對照：`CaptureHealth.tsx:150,168,292,538,584` 與 #700 `captureIssue.ts`。**全刪**，改讀 `descriptor.owner`。
8. `AgentRow` 與 `pluginViewModel` 的本專案啟用判斷：**刪**，讀 `status`（F1-3）。
9. `ExternalCaptureGroup.tsx:96-111` 的狀態鏈與 regex：**刪**。

---

## 5. 首次使用

**第一筆紀錄出現前真正必要的：**
1. 開著一個專案；
2. 全域 REC 開；
3. 至少一條指令路徑的前置成立。POSIX 上是 python3 + curl：內建 pane 也 source 同一支 hook（`terminal-manager.ts:742-788`）。Windows 上是 PowerShell 執行原則（`terminalActivation.ts:148`）。

外部 hook、HTTP、HTTPS 信任、AI、截圖都不是必要。

**系統自己的準備，卻推給了操作者：**
- 等 preflight（`FirstRunView.tsx:84`）。
- 缺依賴時整頁換掉，連 HTTP 卡一起（:186；#700 後初次載入仍是如此）。
- 「核心擷取已就緒」綁 managed proxy 的 HTTPS 驗證（:173），預設了工具。
- 手動展開內建終端。

**工作區沒有被不該擋的東西擋住：** 側欄無閘門，「稍後處理」可離開，`firstRun` latch 只看證據列（`lib/visibility.ts:55`）。這部分是健康的。

**提案（單欄、無新頁）：**
- 首次使用就是儀表板上的同一份來源清單，從模型 render，只是預設展開。
- 每列依 state 顯示它唯一的動作。缺依賴時只在需要它的那一列就地出現 `prepare`（`RuntimePreparation` 已有就地用法，`HooksPanel.tsx:243`），其他列不受影響。
- 刪掉「核心擷取已就緒」與 `coreCaptureReady`。頂部只顯示 verdict（「等待第一筆事件」／「記錄中」）。
- 內建終端在 `ready` 且尚無事件時預設展開。flow-audit 擔心 PTY 的 `session_start` 會點亮證據：`commandEvidence` 只算指令列，`isEvidence` 排除 housekeeping，所以不會（`event-queries.ts:187-198`；UNCONFIRMED 視覺上需實跑）。
- 非同步：preflight、`detectHooks`、外掛 catalog、proxy autostart 都在背景跑。列先以 `unknown`「無法確認」畫出來再補上，不擋整頁。

---

## 6. 遷移

### 6.1 順序（每步 app 都能用）

1. **導入模型，不改 UI。** 新增 `core/source-status.ts` + descriptors（core 來源寫死在一處，外掛由 manifest 產生）+ 表格測試。`capture:health` 多回 `statuses/verdict2/attention` 欄位。等價測試以 `capture-health.test.ts:895` 的矩陣斷言新舊對照表（文件化每個差異，例如新專案 dark → waiting）。
2. **ProofStore 與 enrollment 修正。** nonce 改由 main 發出並比對；HTTPS proof 改成機器範圍；enrollment 加 pid、依專案過濾。這一步只新增事實，舊 UI 不受影響。
3. **verdict 換源。** StatusBar（issue、toast、label、`captureIssueView`）、卡片 headline、`RecordingWorkspace` alert、CLI、`/api/status`（舊 `verdict` 欄位並存一版，標 deprecated）。完整性 dark 移到 integrity issue。此步消掉新專案 dark、toast、自指連結，以及每次啟動的 amber（`healthyGap` 刪除）。刻意更新 `capture-health.test.ts:64,163-167,904`、`capture-readiness.test.ts`、`capture-onboarding-render.test.tsx`、`statusbar-narrow.test.tsx`、`capture-health-unknown.test.tsx`，以及 #700 的 `capture-issue-route.test.tsx`；README:247 一起改。這是契約變更，要在 Spec 070 FR-001 下記錄。
4. **列換源。** 依序換：CaptureHealthCard 列 → HooksPanel tag → AgentRow／外掛頁 axes → ExternalCaptureGroup → SourceLastSeen → 終端 badge（`terminal.meta.hookOn/Off`，改讀 pane 的 `hookSourced`，字對齊 state）。每換一處就刪掉它的本地導出（§2 F1 清單）。
5. **刪重複動作（§4）。** 加上 handler boundary 測試。
6. **首次使用重構（§5），退役 i18n key（§6.3）。** verify:i18n 會列出斷言已刪字串的 test/e2e。至少這些 e2e 含狀態字，需逐一確認：`e2e/first-run.spec.ts`、`app-shell.spec.ts`、`uiux-convergence.spec.ts`、`packaged-smoke.spec.ts`、`hud-overlay.spec.ts`、`timeline-track.spec.ts`。

### 6.2 閘門（防止畫面再自己算狀態）

- **型別：** bridge 型別 `CaptureHealthInfo` 改為 `{ verdict; attention; statuses: SourceStatus[]; integrity }`。原始欄位只在 `status.facts`（readonly）。renderer 想讀 `source.installed` 會 typecheck 失敗，這是第一道。
- **`test/source-status-boundary.test.ts`**（仿 `canonical-ingest-sources.test.ts`）：
  - `src/renderer/**` 除 `lib/sourceStatusView.ts` 外，不得出現 `.facts.`、`ownShellLastEventAt`、`httpsVerification`、`managedHttpProxy`、`.verdict ===`、`captureFacts(`。
  - `src/core/**` 中只有 `source-status.ts` 可以寫出 `SourceState` 的字面值指派。
  - `hooks.install|uninstall`、`httpCapture.start|stop`、`plugins.install|update|remove` 只能出現在 owner 檔案清單。
- **`test/source-status-vocabulary.test.ts`**：見 F4。
- **CLI：** `test/cli-status.test.ts` 斷言 CLI 的每個字等於 `source.state.*` 的 en 值。

### 6.3 會退役的 i18n key（96 個中預計退役或合併的）

- 合併成 `capture.verdict.{attention,none,waiting,ok}`：
  - `capture.dark/partial/healthy/healthyGap`
  - `capture.confirmed.{dark,healthy,partial}`
  - `statusBar.captureDark/capturePartial/captureWaiting`
  - `issues.captureDetail`
  - `activity.status.sourceAlert`
- 合併成 `source.state.*`：
  - `capture.state.{ready,unset,off,error}`
  - `capture.http.{ready,unset,stopped,recorded,failed,off,starting,unknown}`
  - `httpCapture.state.{stopped,running,unavailable,failed,starting}`
  - `capture.tag.running`
  - `settings.external{Feeding,Idle,NotRunning,Disabled,Unknown,LastKnown}`
  - `plugins.healthAxis.{error,inactive,unknown}`
  - `plugins.projectAxis.{notInstalled,installedNotEnabled,recording,unavailable,unknown}`
  - `capture.passive`
  - `terminal.meta.hookOn/hookOff`
- 合併成 `source.reason.*`：
  - `capture.httpVerified`、`capture.httpAwaitingTraffic`、`capture.httpsUnverified`、`capture.listeningIsNotTrust`
  - `capture.summary.http.*`、`capture.summary.cmd.*`、`capture.summary.compose/core`、`capture.sub.byReport/verified`
  - `capture.tag.hookInstalled/hookMissing/shell`
  - `capture.terminalOwnShell{Missing,Pending,Included,CommandOnly}`
  - `capture.http.listening`
  - `firstRun.core.{pending,verified,capturedTrustUnproven,ready}`
  - `httpVerification.*`（7 個）
  - `settings.externalDisabledFeeding`、`settings.externalMissing`
  - `settings.hookNotFound`、`settings.shellInstalled`
  - `settings.source.{lastReceived,neverReceived}`
- 動作：
  - `settings.hookDisable` → `source.action.remove`，與 `capture.uninstall` 合併。
  - `capture.install`、`capture.ctaInstallShellHook`、`capture.ctaOpenTerminal`、`capture.ctaRunCommand` → `source.action.*`。
- 保留：`plugins.installState.*` 與 `plugins.status.*`。它們是外掛頁的安裝／信任軸，不是擷取狀態；但不得再被擷取列引用。

---

## 7. 查過、沒問題的

- `captureHealthStore.ts`：單一讀取、`unknown` 不沿用舊 verdict、stall 與排序都正確。它正好是新模型要的「讀」半邊。
- `eventBus` 事件會清掉 health cache（`capture-health.ts:381`）：第一筆事件後卡片不會停在舊值。
- `noteCaptureError` 與 `noteDbError` 分流（:225-239）：單一來源失敗是 partial，寫入失敗是 dark。方向對，只是 dark 不該跟「沒接」共用。
- `http-verification-evidence.ts` 的 context 失效規則（endpoint／CA／routing）設計正確，可作 ProofStore 範本。
- 外掛 producer 的不對稱保證，以及 rogue（off 且仍在寫）的偵測，都對。
- `SourceLastSeen`：卡片與設定讀同一個 snapshot（#435）。
- enrollment 的 FR-010／FR-022（pin 專案、stop 不會自己恢復）語意正確，問題只在列舉時沒過濾。
- `firstRun` latch 只看證據列，側欄無閘門。
- `shouldAutoStartHttpCapture`（`http-autostart.ts`）本身合理。問題在下游把「running」當成「該驗證了」。

## 8. 看起來不對、其實是刻意的

- 沒有 `idle`（`capture-health.ts:30-42`，`6f8de71a`）：安靜不是故障。新模型延續；Spec 070 US2 的「閒置」與此衝突，建議 070 改掉。
- `informational` 來源不得讓 verdict 變差（:757-762，測試釘住）。
- AI 整合的安裝只在外掛頁（Spec 066 FR-003，`PluginsPanel.tsx:296` 註解）。本模型保留，其他畫面只連過去。
- 擷取瀏覽器不證明 CA 信任（`HttpCaptureStep.tsx:248-255`）。正確；錯的是儀表板沒套用它。
- 改 workdir 會停止 AI 擷取（`AgentsPanel.tsx:60-79`）：安全設計。模型以 `not-set-up` 加理由 `scope-changed` 呈現。
- mitmproxy 的 `installed = available`（:468-476）：managed proxy 用 `-s`，沒有 standalone 安裝。
- 全域 REC 是唯一的暫停，不是每個來源各一個。

## 9. UNCONFIRMED（需實跑）

- **U1 換專案 toast。** 開一個有事件的專案 A（verdict healthy），再建新專案 B、什麼都不做。預期右下 toast「紀錄可能不完整…」、狀態列「需要注意 1」、儀表板「什麼都沒在記」。對照：全新 userData 第一次建專案，預期有注意數、沒有 toast（`prevVerdict` 為 null）。
- **U2 每次啟動都 amber。** 在有 mitmdump 的機器用自己的瀏覽器完成 HTTPS 驗證 → 結束 app → 重開 → 開同一專案。觀察儀表板 badge 是否為「部分來源待確認」、HTTP 列是否為「HTTPS 尚未以工具驗證」，同時 `http-verification-history` 是否寫「上次 HTTPS 擷取成功；需要重新驗證」。另測一個只用 Burp、不碰 managed proxy 的專案，看 amber 是否永不消失。
- **U3 擷取瀏覽器驗證兩處不一致。** 首次使用選「RedLog 擷取瀏覽器」→ 驗證 → 首次使用顯示「◐ 已擷取 · CA 未驗證」。離開首次使用，到儀表板看 HTTP 列 tag 是否為綠色「已驗證（Chrome …）」。
- **U4 AI 相對路徑。** 設定 ▸ 其他擷取來源 ▸ AI，手動輸入 `foo` → 加入 → 勾「在此專案記錄新對話」。觀察外掛詳情是否寫「已為此專案啟用。」、儀表板該列是否為「已關閉」；再跑一段 Claude Code 對話，確認沒有被記錄。
- **U5 enrollment 累積。** 裝 zsh hook，開關外部終端機分頁 3 次（每次跑一個指令），再換到另一專案。`ls ~/.redlog/terminals` 應有 3 個以上 json；儀表板「其他擷取來源」terminal 列的「N 個終端機中有 M 個正在記錄」是否計入已關閉與其他專案的終端機。
- **U6 terminal 被誤報為可用。**
  - (a) Linux 容器移除 python3（或改 PATH）後開新專案：卡片指令列是否為「可用」，首次使用是否整頁準備，內建 pane 輸入指令是否沒有 `command_end`。
  - (b) 用沒有 adapter 的 shell（如 fish）當預設 shell 開內建 pane：pane badge「事件未接入」，卡片是否仍為「可用／正在運作」。
- **U7 螢幕錄製權限（macOS）。** `tccutil reset ScreenCapture <app bundle id>` → 開專案 → 截圖列在 not-determined 時應為 `unknown`，目前會顯示「可用」→ 觸發一次截圖，看系統提示 → 拒絕 → 列是否變「擷取失敗 · 未授予螢幕錄製權限」並帶「開啟系統設定」。另確認拒絕後 `desktopCapturer` 是否回傳只有桌布的圖（`capture-prerequisites.ts:31-32` 的假設）。
- **U8 PowerShell。** Windows 上 `Set-ExecutionPolicy Restricted -Scope CurrentUser` → 新專案 → 首次使用是否整頁擋住（`commandCaptureBlockers` 的 execution-policy）；內建 PowerShell pane 是否仍能記（`. hook *> $null` 在 Restricted 下是否被拒），以及卡片怎麼說。
- **U9 HTTPS 信任與真實瀏覽器。** 用自有信任庫的瀏覽器（Firefox）走「自己的瀏覽器」路徑，只把 CA 加進系統信任庫，預期 `rejected`；再加進 Firefox 自己的信任庫，預期成功。用來確認「client 族群」作為證明範圍是否足夠。
- **U10 CLI。** 讓 screenshot 失敗（拒權限）後跑 `redlog-cli status`，確認是否印出「wired but idle」。
