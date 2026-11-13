# Implementation Plan: 專案執行期、設定層級與安裝帳本

**Branch**: `spec/072-075-contracts` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/073-project-runtime-and-setting-scopes/spec.md`

## Summary

「一個專案開著」今天由約 30 個模組的單例、三份手寫清單（`startProjectResources`、`stopProject`、設定套用）與四種過時判斷拼成。本計畫讓一個 `ProjectSession` 物件擁有它：資料庫、設定檢視、身分 token、每專案快取，以及一份有序的資源清單，啟動照順序、停止反過來。設定改為四層解析一次（預設 → 機器 → 專案 → session），36 處直接讀檔收斂到一個檢視；新增 `machine.yaml`，既有專案的有效值在升級時一個都不變。生命週期加入 `project_closed`、當機補寫與唯讀的封存。外部終端機的綁定改為計算出的暫停。另加兩份機器層紀錄：安裝帳本（每一個 RedLog 在自己目錄外的寫入，可精確還原）與 AI 同意（取代把 adapter 複製到 `~/.redlog` 的「安裝」）。每一條規則都有一個會失敗的 gate。

## Technical Context

**Language/Version**：TypeScript（Electron main 與 core）；Python 3（relay 的綁定轉移，071 實作）；POSIX sh、PowerShell（帳本的目標檔）。
**Primary Dependencies**：better-sqlite3、js-yaml（既有）、TypeScript compiler API（gate，既有於 `scripts/verify-architecture.mjs`）。不新增套件。
**Storage**：新增 `~/.redlog/machine.yaml`、`~/.redlog/installs.json`、`<project>/.session-alive`、`<project>/ARCHIVED`；`config.yaml` 新格式（`configVersion: 2`）。專案資料庫的結構不變。
**Testing**：Vitest（單元、property、gate）；Playwright e2e（ubuntu CI）；真機另列。
**Target Platform**：macOS、Linux、Windows（PowerShell 5.1／7、WSL）。
**Constraints**：P9、P10、P11；開專案的主執行緒時間不得比今天長（準備階段只是把既有工作提前，不新增）。
**Scale/Scope**：約 30 個模組、約 130 個專案範圍的模組繫結；36 處直接讀設定；約 60 個設定葉節點。

## Constitution Check

| 原則 | 判定 |
|---|---|
| I Evidence Integrity | 不改寫列；`project_closed` 為追加；開專案不再覆寫設定檔（修正一個會毀掉操作者明確值的缺陷）。通過 |
| II Surface Truthfulness | 「已寫入」與「有載入」分開；被專案覆寫的設定標示來源；唯讀明示；移除報告逐項說明留下什麼。通過 |
| III Canonical Semantics | 一個 session 擁有者、一種過時判斷、一個設定檢視、一份歸屬表、一份綁定轉移表、一本帳。通過 |
| VI Explicit Failure | 設定解析失敗拒絕開啟並說明；`stop` 失敗列在關閉報告；匯出被取消時明說。通過 |
| VIII Test-First | 每個行為改動先 RED（tasks 各 Phase 的「先 RED」）。須執行 |
| IX Restraint | 新的 `src/core/session/` 解決的是 07-F1 的三份清單與四種手法；`machine.yaml` 解決 09-F8；帳本解決 08-F3。沒有 DI 容器：資源以一般建構式組裝，順序是一個陣列。見 Complexity Tracking |
| Workflow | 涉及專案歸屬與證據路徑，實作前執行 Clarify、Checklist、Analyze 並記入 `verification.md`（T001） |

## 現況（程式碼確認，`origin/main@56c9fe6c`）

- **開專案**：`startProject`（`src/main/index.ts:773-800`）→ `loadConfig` + `saveConfig`（:781-782）→ 若有開著的就 `stopProject`（:783）→ `projectRuntime.begin`（:784）→ `initDB`／`bindDBEngagement`（:786-788）→ `startProjectResources`（:802-1218，約 420 行）→ `writeSpoolIdentity`（:791）→ `activate`（:792）。失敗時 `stopProject`（:793-797）。
- **關專案**：`stopProject`（:1220-1280）手寫 27 個步驟；`projectRuntime.close()` 先跑。
- **設定套用**（#702）：`config-apply-plan.ts` 是純決策（`OPEN_SEQUENCE`、`APPLY_ORDER`、`CONFIG_DEPENDENCIES`、`NO_LIVE_EFFECT`），`config-apply.ts` 執行；`config-store.ts` 是 `config.yaml` 唯一的寫入者，以檔案為基準套用 patch（`config-patch.ts`）。
- **`ProjectRuntime`**（`src/core/project-runtime.ts`）：generation、signal、`setInterval`／`setTimeout`／`onStop`、`renameProject`、`setOperator`。`onStop` 正式碼使用 0 處。
- **過時判斷四種**：
  1. 顯式 reset：`index.ts:1258-1265`、`:810-814`；
  2. `dbGeneration()`：`cast-index.ts`（2）、`chain-anchor.ts`（6）、`ingest.ts`（3）、`socket-attribution.ts`（3）、`screenshot-agent.ts`（3）；
  3. 目錄比較：`raw-store.ts:44-50`、`http-body-store.ts:34-36`、`cast-content-source.ts:19`；
  4. project id 比較：`ipc/data-export.ts:29,32,134,137,141`、`ipc/artifacts.ts:79,106`、`ipc/terminal.ts:136`、`ipc/events.ts:73`、`main/index.ts:727,745`。
- **設定歸屬今天**：專案 `config.yaml` 裝了全部 `RedLogConfig`；機器層散在 `hook-config.json`（`services/hook-config.ts:12`）、`hud-prefs.json`、`overlay-position.json`、`window-state.json`、`terminal-mode`、`terminal-app`、`command-class.json`（後三者 shell 也讀）、`plugins/state.json`、`plugins/trust.json`、`keys/`。
- **終端機綁定**：`terminal-enrollment.ts:78-100`（TS）與 `redlog-relay.py:1172-1207`（Python）兩份轉移函式；`project-switched` 為永久（`pinBroken`）。內建 pane 由 `detachTerminalRecordings`／`resumeTerminalRecordings`（`terminal-manager.ts:306-330`）處理。
- **Hook 寫入**：`hooks-manager.ts` 的 `installHook`（:834-934）、`uninstallHook`（:936-1030）、`refreshInstalledHooks`（:791-817）、`removeInstalledHooks`（:819-832）；rc 路徑固定為 `~/.zshrc`／`~/.bashrc`（:186,199,458-461）；`claude-settings` 寫入 `~/.claude/settings.json`（:839-863）；PowerShell 以 `\r\n` 重組（:919,1022）。沒有擁有者紀錄。CA 信任 RedLog 不寫，只給指令（`caUntrustCommand`，:65）。
- **官方 AI**：`createOfficialAgentPluginManager(~/.redlog/plugins)` 在 6 處各自 new 一個（`main/index.ts:584,1563`、`ipc/plugins.ts:30,64`、`capture-health.ts:683`、`agent-tailer.ts:51`）；收據 `.official-ai-installations.json`；`resolveAgentCapture` 要求 `state === 'installed'` 且 `installationId` 相符（`agent-capture-policy.ts:26-31`）。

## 設計決策

### D1 `ProjectSession` 吸收 `ProjectRuntime`

**決定**：`src/core/session/session.ts` 的 `ProjectSession` 擁有 token（今天的 `ProjectContext`）、狀態、計時器與 cleanups（搬自 `ProjectRuntime`），再加上資料庫、設定檢視、資源清單。`ProjectRuntime` 類別刪除；`ProjectContext` 型別保留並改名 `SessionToken`（舊名保留為型別別名直到呼叫端遷完）。

**理由**：兩個擁有者等於沒有擁有者。DESIGN-project-runtime §2 把 `ProjectRuntime` 刻意限定為「不是資源登記」，理由是「一次把二十個 service 搬到介面後面會讓順序變成隱性的」。本計畫接受這個理由的前半，用兩個方法化解後半：順序是一個陣列，由快照測試釘住；搬遷一次一個資源（Phase 3）。

**否決**：
- 保留 `ProjectRuntime`、另建 session 包住它：兩個物件都有 generation 與 cleanups，`onStop` 已證明沒有人用；
- DI 容器或 service locator 註冊表：P9；問題在擁有權，不在注入語法（07「不值得做的」）。

### D2 一種過時判斷：狀態掛在 session 上，token 只用於跨 await

**決定**：
- 每個專案範圍的快取，由所屬模組提供一個工廠（`createIngestState()`、`createCausesState()`、`createBodyStoreState(dir)`……），session 建立時呼叫並持有。session 結束，物件不可達；沒有 reset。
- 核心模組取得目前狀態的方式只有一個：`currentSession()`（`src/core/session/current.ts` 的唯一可變插槽）。高扇入的 `getDB()`（53 個匯入者）改為 `currentSession()?.db`，簽名不變。
- 跨 await 的工作在開始時取 token，之後以 `isCurrent(token)` 判斷。`dbGeneration()` 刪除：資料庫屬於 session，generation 就是 token 的 generation。
- IPC handler 在進入時取 token，回覆前比對；不再比 project id（A→B→A 時會誤判，DESIGN-project-runtime §1）。

**否決**：
- 把 session 當參數傳進每一個核心函式（`insertEvent(session, …)`）：上百個呼叫點的機械改動，不會比一個插槽更安全——插槽的替換是同步的、只在 session 模組內發生；
- 每個模組各自保留 `let current` 並在 session 切換時被通知：就是今天的第一種手法換個名字。

**代價**：`currentSession()` 是一個全域讀取點。由 gate 限制它只能被讀、只能由 session 模組寫（FR-094）。

### D3 切換先準備、後交棒

**決定**：`prepareOpen(project)` 是純準備：
1. 讀並驗證專案層與機器層 → `ConfigView`；
2. 檢查封存標記；
3. 開啟 B 的資料庫連線、pragma、schema 遷移（現在由 `initDB` 做，改為回傳 handle 而不設全域）。

成功才 `closeSession(current, 'switched')`，再 `startSession(prepared)`。準備失敗時，丟棄 B 的 handle，A 不受影響。

**理由**：today 的 `config-write` 故障已經是這個形狀（`index.ts:778-783` 的註解），但只涵蓋了「寫入」。資料庫與設定的故障是最常見的開不起來，也是最不該害操作者失去 A 的。
**否決**：整個切換做成交易（失敗時重開 A）：重開 A 會換 token、重跑保留期清理，對外看起來是一次額外的關閉與開啟；準備階段已涵蓋大多數故障。
**代價**：兩個資料庫檔案短暫同時開著（B 尚未接上任何寫入者）。better-sqlite3 的同步遷移仍在主執行緒，時間與今天相同，只是提前。

### D4 單一設定檢視與四層

**決定**：
```
有效值 = session ⊕ project ⊕ machine ⊕ defaults     （⊕：左邊有值則取左邊；陣列整體取代，與今天 deepMerge 相同）
```
- `resolveConfig(layers) → ConfigView` 是純函式；`ConfigView.revision` 是各層內容摘要的雜湊。
- 驗證在解析時做，一份 schema（由登記表導出型別與值域）。`network: null` 這類型別錯誤、YAML 解析錯誤，都在準備階段拒絕。
- `ConfigView` 對每個鍵回答 `origin`。設定頁讀 `config:get` 時得到 `{effective, origins, scopes}`。
- 存檔（`ConfigStore.patch`）的每個 op 依登記表決定寫入哪一層：機器範圍的鍵預設寫 `machine.yaml`；操作者在欄位上選「只套用到此專案」時寫專案層覆寫；「改用此電腦的值」刪除專案層的鍵。
- #702 的關係：`config-apply-plan.ts` 仍是純決策，`config-patch.ts` 仍是以檔案為基準的 patch。改變的是：
  1. 計畫的輸入從「檔案內容」改為「有效設定」；
  2. 新增套用原因 `machine`；
  3. `CONFIG_DEPENDENCIES` 從「步驟 → 路徑」改為每個資源自己宣告的 `reads`，計畫器由資源清單建表；
  4. `NO_LIVE_EFFECT` 逐項重審：`network.offline` 移出；`browser`、`httpCapture.routeTerminals` 保留（在使用時讀，但經 `ConfigView`，不讀檔）；
  5. `OPEN_SEQUENCE` 與 hooks（`resetProjectCaches`、`loadPlugins`、`wireTerminalIngest`、`startProjectServices`）由資源清單取代——開啟就是依序 `start`。
- **Session 層**：正式版目前沒有鍵。保留它是為了環境變數與測試（例如 `REDLOG_OFFLINE=1`、e2e 的 `testHooks`），它們今天以各自的方式繞過設定。

**否決**：
- 每次讀取都重新讀檔（今天）：同一個值在不同時刻生效，就是 air-gap 只套一半的原因；
- 檔案 watcher 熱重載：手改 `config.yaml` 本來就不是支援的寫入路徑（`config-store.ts` 是唯一寫入者），watcher 只會讓「何時生效」再多一種答案。手改在下一次開啟時生效，設定頁顯示檔案修訂值與檢視不同時提示重開。

### D5 舊格式設定檔：不改寫、讀時判斷

**前提**：開專案會把合併後的完整設定寫回（`index.ts:782`），所以每一份既有的 `config.yaml` 都含有全部鍵的預設值。

**決定**：
- 升級不改寫任何專案檔。
- 沒有 `configVersion` 的檔案以 `LEGACY_V1_DEFAULTS`（本版凍結的舊 `DEFAULT_CONFIG` 副本）判斷：機器範圍的鍵值等於舊預設 → 不是覆寫；否則是覆寫。
- 例外（一律是覆寫）：`operator.id`、`operator.name`（簽章者；中途換人會把一份紀錄分成兩個簽章者，09-F8）；`scope.personalDomains`（預設值本身改變，且影響匯出內容）。

  > **Superseded（2026-11-13，修訂 B7）**：`operator.*` 不再是例外：它不可覆寫，專案檔中的值一律不讀（D12）。例外只剩 `scope.personalDomains`。
- 專案範圍的鍵：照讀。
- 下一次存檔時轉為新格式：只寫專案範圍的鍵與覆寫，加 `configVersion: 2`。轉換前後的有效值相同（property test）。

**不變式**：任何既有專案在升級當下，每個鍵的有效值 = 升級前 `loadConfig` 的值。因為升級當下 `machine.yaml` 不存在或為空，等於舊預設的鍵繼承的就是舊預設。之後操作者改機器值，只影響「從未選擇過」的專案鍵。

**否決**：
- 升級時把所有既有值都轉成覆寫：既有專案永遠享受不到機器層，F8 對既有專案等於沒修；
- 升級時把等於預設的鍵從檔案刪掉：改寫操作者的檔案，而且降版時舊版讀不到這些鍵；
- 問操作者：每個專案、每個鍵一題，沒有人能回答。

### D6 降版相容：operator 的鏡像

新格式檔案另寫一份 `operator: {id, name, mirror: true}`。新版的解析器認得 `mirror: true`，不把它當覆寫；舊版的 `deepMerge` 照讀 `operator.id`，所以署名不變。其他機器層的值在舊版中回到舊預設（例如 proxy 埠），這是寫進文件的已知降版行為。舊版開啟時會把它看到的完整設定寫回檔案（它仍有 `index.ts:782`），檔案保留 `configVersion: 2` 但內容被具體化。偵測方式：新版寫檔時另寫 `configWriter: {app, bodySha256}`，`bodySha256` 是除去這一行之外的檔案內容摘要；讀到摘要不符（被舊版或手動改寫過）的 v2 檔，一律改用 D5 的舊格式規則解讀。這樣被具體化的檔案與舊格式檔得到相同的解讀，而新版自己寫的覆寫不會被誤判。

> **Superseded（2026-11-13，修訂 B7）**：D6 取消。operator 只在機器層，新格式的專案檔不含 operator，也不寫鏡像；`configWriter` 摘要照舊用於偵測被改寫過的 v2 檔（D5），與 operator 無關。降版時 operator 回到舊版的預設值，不在保證之內（D12）。

### D7 `machine.yaml`

```yaml
schema: 1
operator: { id: alice, name: Alice }
network: { blacklist: [], checkInterval: 60, providers: [], confirmations: 3, ipMode: auto, showWifiName: false, vpnAdapters: [...] }
personalTraffic: []
screenshot: { quality: 85, diffThreshold: 5 }
terminal: { maxCastBytes: 52428800 }
clipboard: { pollMs: 1500 }
browser: { binary: ..., proxy: ..., cdpPort: 9222, isolateProfile: true, ignoreCertErrors: false, extraArgs: [] }
httpCapture: { port: 6661, listenHost: 127.0.0.1, routeTerminals: false }
redaction: { allowlist: [], denylist: [], entropyThreshold: 4.5, minLength: 20 }
fileWatcher: { ignorePatterns: [] }
processMonitor: { pollMs: 500, ignoreCommands: [] }
connectionMonitor: { pollMs: 2000 }
loot: { disabledRules: [jwt, generic_api_key] }
hookExclusions: { excludedPaths: [] }          # 由 hook-config.json 遷入（D7-b）
ai: { revokedAt: { claude-code: 1731400000000 }, legacyInstallations: { claude-code: "uuid" } }
```

- 鍵路徑與 `RedLogConfig` 相同（`personalTraffic` 例外，見 FR-01B），所以一個鍵在任何一層都是同一個名字。只寫與預設不同的值。
- **寫入**：`writeMachineSettings(patch, expectRevision)`：讀 → 比修訂值 → 合併 → 驗證 → `open(tmp, 'wx', 0o600)` → write → fsync → rename → fsync(dir)。Windows 的 rename 以 `MoveFileEx(REPLACE_EXISTING)` 取代（Node 的 `fs.renameSync` 行為），之後以 `restrictFile` 收緊 ACL（`private-fs.ts` 既有）。
- **兩個版本**：
  - 單一實例鎖讓同時執行罕見，但開發版與安裝版可能先後或同時存在 → 修訂值比對，衝突時重讀；
  - 較新的 `schema` → 只讀；
  - 不認得的鍵原樣保留；
  - 較舊版本的 RedLog 不讀 `machine.yaml`（D6）。
- **(b) 既有的機器層檔案**：
  - 只由 app 讀的設定（`hook-config.json` 的 `excludedPaths`）在第一次寫入時遷入 `machine.yaml`，舊檔保留一個版本後刪除；
  - shell 也讀的檔案（`terminal-mode`、`terminal-app`、`command-class.json`）維持獨立檔案，因為 shell 無法便宜地解析 YAML；它們在登記表中仍是機器範圍的鍵，`ConfigView` 經由各自的讀取函式讀它們；
  - HUD 偏好、視窗位置是介面狀態，不進登記表。

### D8 生命週期與封存

```
                prepareOpen ok
 closed ───────────────────────────► opening ──start ok──► recording ⇄ paused
   ▲                                    │                     │
   │                                start fails               │ close(reason)
   │                                    ▼                     ▼
   └──────────────────────────────── failed ◄──────────── closing ──► closed
```
- `lifecycle.ts` 的 `transition(state, op)` 是純函式，回傳新狀態或拒絕（例如 `closing` 時要求 `pause`）。
- 暫停／恢復沿用 071 FR-080 的 app 層狀態檔；它跨 session 延續，與今天 `markerForOpen` 的語意相同（`recording-state-marker.ts`）。是否改成每專案各自的暫停，見開放問題 Q3。
- **唯讀 session**（`mode: 'read-only'`）：
  - 只啟動 `mode: 'read'` 的資源；
  - 資料庫以 `readonly: true` 開啟；
  - `ConfigView` 照常解析但 `ConfigStore` 拒寫；
  - 匯出見開放問題 Q1。
- **封存標記**：`<project>/ARCHIVED`（內容為時間與 app 版本）＋ `projects.json` 的 `archivedAt`。標記檔在專案目錄內，搬移資料夾後仍有效。
- **`project_closed`**：由 `lifecycle-records` 資源在 `stop` 時寫入（它排在寫入者之前，所以最後停）；`session_start` 由它在 `start` 時寫入（排在所有擷取資源之前）。這改變了開啟時列的先後：今天 `session_start` 寫在設定套用之後（`index.ts:1043`）。
- **存活戳記**：`<project>/.session-alive`（`{generation, pid, startedAt, aliveAt}`，原子寫入，每 60 秒）；正常關閉時刪除。
- **否決**：
  - 封存時把資料庫檔設為唯讀權限：會讓取消封存變成權限操作，也擋不住同使用者；
  - 封存寫一列鏈上紀錄：封存在專案關閉時發生，寫入它要開資料庫寫入；封存是本機整理狀態，不是證據。

### D9 安裝帳本

```jsonc
// ~/.redlog/installs.json  (0600, atomic)
{ "schema": 1, "entries": [ {
  "id": "e-7f…", "kind": "rc-block",
  "owner": { "component": "builtin-hook:zsh", "version": "0.18.0" },
  "target": { "path": "/Users/a/.config/zsh/.zshrc", "realpath": "…", "viaSymlink": false,
              "shell": "zsh", "edition": null, "host": null, "wslDistro": null },
  "change": { "bytes": "\n# >>> redlog >>>\nsource \"…\"\n# <<< redlog <<<\n", "at": "append",
              "eol": "lf", "beforeSha256": "…", "afterSha256": "…", "beforeBytesRef": "installs/e-7f.before" },
  "state": "present", "adopted": false, "recordedAt": 1731400000000, "verifiedAt": 1731400100000 } ] }
```

- 寫入前的位元組另存 `~/.redlog/installs/<id>.before`（0600），因為 rc 檔可能很大，不放進 JSON。
- `json-entry`：記錄 JSON pointer 與值；還原時若 `afterSha256` 相符，整檔還原；否則只移除值相等的那一項，並以檔案原本的縮排重新序列化（偵測縮排；偵測不到用 2 格），報告註明「已重新格式化」。
- `instructed`：記錄步驟與驗證方式（CA：以 SHA-1／SHA-256 指紋查詢系統信任庫；查不到時狀態為 `unknown`，不是 `missing`）。
- 呼叫者：`hooks-manager.ts` 的 install／uninstall／refresh／remove（全部）、`wsl-manager.ts` 的 install／uninstall、071 的憑證發放、`powershell-policy` 的 profile 路徑。之後任何新的「寫到 RedLog 目錄外」都必須經過 `ledger.apply(planned)`，由 gate 釘住（FR-057、T075）。
- **否決**：
  - 08 的 `hook-installs.json` 與 `installs.json` 兩份：一份就能涵蓋 hook、settings、憑證；
  - 每次移除都以 manifest 重算該移除什麼（今天）：已退役的外掛找不到 manifest。

### D10 AI 同意

- 同意存在專案層：`agentTailer.sources.<kind>.consent: {at, by, adapterDigest, readRoots, emits}`。它與既有的 `enabled`、`workPaths`、`startedAt` 同處，經 `ConfigStore` 寫入並由 `config-audit` 寫鏈上紀錄（`diffSecurityConfig` 擴充涵蓋 `consent`）。
- 撤回此電腦上全部：`machine.yaml` 的 `ai.revokedAt.<kind>`；同意有效 ⇔ `consent.at > revokedAt`（或沒有 revokedAt）。
- 宣告比對：075 的 manifest 提供 `adapterDeclaration(kind) → {readRoots, emits, digest}`；`readRoots`／`emits` 與同意時的值集合相同 → 延續（`digest` 不同只代表程式更新）。
- 遷移：`ai.legacyInstallations.<kind>` 記舊 `installationId`；`resolveAgentCapture` 的條件由「`state === 'installed'` 且 `installationId` 相符」改為「同意有效，或 `installationId === legacyInstallations[kind]` 且 `enabled`（並於第一次開啟時補寫 `consent{by:'migration'}`）」。
- 載入：`agent-tailer.ts` 的 `require` 路徑改為 `optionalAgentPackagesRoot()/<id>/adapter.cjs`。續讀位置以 agent 種類與 transcript 檔為鍵（UNCONFIRMED：見「無法從程式確認」），不以模組路徑為鍵。
- **否決**：
  - 機器層同意（08 的原案）：擁有者決定以專案為單位（071 O9）；
  - 同意存進專案資料庫的專表：同意是設定，需要隨設定頁呈現與審計，已有完整路徑。

### D11 擷取健康的錯誤計數

`_lastDbError`、`_dbErrorTotal`、`_dbErrorFirstAt`、`_captureErrors`、`_lastSampleBroken`、`healthCache`、`cfgSnapshot`（`capture-health.ts:196-463`）移入 `project-state`。app 生命週期的累計只寫 debug log。理由：卡片顯示的是每個專案的健康，A 的錯誤讓 B 在 60 秒內維持 dark 是誤導（07-F1）。

### D12 operator 只在機器層（修訂 B7，2026-11-13）

擁有者對 Q4 的答覆：專案不可以覆寫 operator（DECISIONS §9）。

**今天的 main（`main@017de22c` 確認）**：沒有機器層設定檔（`src/` 中沒有 `machine.yaml`）。operator 是每個專案 `config.yaml` 的 `operator: {id, name}`（`config.ts:36-39`，預設 `operator-1`／`Operator`，`:250-253`）；在專案設定頁的 operator 分組編輯（`ProjectSettings.tsx:27-53`，id 在離開欄位時提交、不可空白）；建立專案時 `mergeInitialConfig` 合併建立卡片帶來的 `initial.operator`（`config.ts:363`）；開專案時以 `config.operator.id` 建立 runtime 的 context 與 API 的主要操作者（`main/index.ts:779,809,1018`）；開著時改 operator 由 `applyOperatorChange`（`main/operator-change.ts`）依序改 API 主要操作者、`runtime.setOperator`、交接目錄的身分檔。所以今天每個專案各有一個 operator，新專案回到 `operator-1`（09-F8）。

**決定**：

1. 登記表：`operator.id`、`operator.name` 為 `home: 'machine'`、`overridable: false`。`resolveConfig` 對這兩個鍵不讀專案層；`origin()` 只會回 `machine` 或 `default`。
2. **既有專案檔中的 `operator`**：產品尚未發布，擁有者裁定不為舊格式保留相容（2026-11-13，見下「依據」）。所以它不是覆寫、不轉成任何東西、不遷到 `machine.yaml`；它是被忽略的鍵：不讀、不顯示、不是解析錯誤（若被當成錯誤，每一個既有專案都會打不開，FR-015 只拒絕型別錯誤與不合法的值，不拒絕這個鍵）。`ConfigStore` 下一次存檔只寫專案範圍的鍵，它自然消失；開專案仍不寫檔（FR-008）。
3. **建立卡片與匯入的設定檔**：`mergeInitialConfig` 不再合併 `initial.operator`；專案選擇器的匯入與設定頁的「匯出設定檔」只含專案層（本計畫「它取代什麼」表中 `main/index.ts:1803` 一列已是如此），匯入時丟棄 `operator`。
4. **寫入**：設定頁的 operator 欄位存檔時寫 `machine.yaml`；`ConfigStore` 收到專案層的 operator op 時拒絕（`scope-not-overridable`）。即時套用沿用 `applyOperatorChange` 的順序（API 先、再 session token、再交接身分檔），觸發原因是 `machine`（FR-013）；它成為 `ProjectSession` 的一部分（`setOperator` 隨 D1 搬入 session），切換專案時新 session 從機器層取得 operator，不再從專案檔。
5. **鏡像（D6）取消**：專案檔不含 operator；較舊版本開新格式專案時署名回到它的預設值。T100 隨之取消。
6. **後果**：升級後，若某既有專案的 `config.yaml` 是 `bob` 而機器層是 `alice`（或尚未設定、為 `operator-1`），之後的新列 `operator_id` 是機器層的值；同一份紀錄出現兩個 operator id。兩者都照常驗證（每列帶自己的 `operator_id`，`operators.json` 對應各自的公鑰），只是 09-F8 所說的「一份紀錄兩個簽章者」在升級的那一刻發生一次。機器層第一次的值是預設還是從某個專案取一次，是開放問題 Q7（建議：預設，不取）。
7. **071 的蓋章**：071 FR-009「`observed.operator` 是本專案已知且未撤銷的操作者時採用」不變：那是觀察當下的機器層 operator（交接目錄延遲送達時，送達時的 operator 可能已改），「已知」的集合只由機器層 operator 曾經生效的值構成，沒有專案層的來源（071 的修訂註記）。

**依據**：DECISIONS §9 的 073 Q4 一列。「不為舊格式保留相容」是擁有者同日的裁定（不保留與 RedLog 舊版本的相容），本次修訂時尚未寫入 `docs/records/2026-11-13/DECISIONS.md`；第 2、5 項依它撰寫，若它不成立，第 2 項改為「既有值讀為機器層的初值」、第 5 項恢復 D6。

**被否決**：

- **既有專案的 operator 保留為唯讀覆寫，直到操作者按「改用此電腦的值」**（Q4 原建議的一半）：就是被裁定不存在的專案層 operator。
- **把既有專案的值當成錯誤、拒絕開啟直到操作者處理**：讓每一個既有專案打不開，換來的是一次性的提醒。
- **升級時把每個專案的 operator 改寫成機器層的值**：改寫操作者的檔案（D5 否決過同一件事），而且 FR-008 禁止開專案寫檔。

## 模組邊界（給 owner 指令的回答）

### 新增與指定的擁有者

| 模組 | 擁有 | 公開介面 | 不得匯入 | 可被誰匯入 |
|---|---|---|---|---|
| `src/core/session/session.ts` | 目前 session、狀態、計時器、資源清單的執行 | `prepareOpen`、`startSession`、`closeSession`、`ProjectSession` | `electron`、`src/main/**`、`src/renderer/**` | `src/main/index.ts`、`src/main/session-resources.ts`、`src/main/ipc/**` |
| `src/core/session/current.ts` | 唯一的專案範圍可變插槽 | `currentSession()`（讀）；`_setCurrent` 只由 `session.ts` 呼叫 | 同上 | 任何 core／main 模組（讀） |
| `src/core/session/resource.ts` | 資源介面與 `ResourceId` 列舉 | 型別 | 任何執行期模組 | 所有資源實作 |
| `src/core/session/lifecycle.ts` | 狀態轉移（純） | `transition` | 任何 I/O | session、renderer 的型別 |
| `src/core/session/config-view.ts` | 層的解析（純） | `resolveConfig`、`ConfigView` | `fs`（純函式） | session、ConfigStore |
| `src/core/settings-registry.ts` | 每個鍵的歸屬、覆寫、舊預設、例外 | `SETTINGS`、`SettingKey`、`LEGACY_V1_DEFAULTS` | 任何 I/O | config-view、ConfigStore、gate、設定頁（型別與 scope） |
| `src/core/machine-settings.ts` | `machine.yaml` 的讀寫 | `readMachineSettings`、`writeMachineSettings` | `src/main/**` | session（準備）、ConfigStore |
| `src/main/config-store.ts`（既有，擴充） | 兩個設定檔的唯一寫入者 | `patch`、`create`、`resetToMachine` | — | main 的 IPC |
| `src/main/session-resources.ts`（新） | 資源清單（陣列）與每個資源的建構 | `buildResources(deps): readonly ProjectResource[]` | `src/renderer/**` | `src/main/index.ts` |
| `src/core/install-ledger.ts` | 帳本檔與還原 | `planChange`、`apply`、`verify`、`remove`、`adopt` | `src/main/**` | `hooks-manager`、`wsl-manager`、071 `credentials.ts`、uninstall 路徑 |
| `src/core/ai-consent.ts` | 同意狀態的判斷（純）與遷移 | `consentState`、`migrateLegacyInstallations` | `src/main/**` | `agent-capture-policy`、`ipc/plugins`、071 的入口 |
| `src/core/terminal-enrollment.ts`（既有） | 綁定轉移表（TS 一側）與狀態檔 schema | `applyTerminalAction`、`bindingState` | — | 既有呼叫者 |

### 擁有權：之前與之後

| 狀態 | 今天的擁有者（file:line） | 之後 |
|---|---|---|
| 讀寫與唯讀資料庫連線、`boundEngagement`、generation | `core/db/index.ts:12-40` 模組變數 | `db` 資源；handle 在 `session.db` |
| cast 索引 | `core/cast-index.ts:66,99-100` | `cast-index` 資源 |
| body 索引與 walk 狀態 | `core/http-body-index.ts:16,74-78` | `body-index` 資源 |
| body／raw 目錄快取 | `http-body-store.ts:34`、`raw-store.ts:44`、`cast-content-source.ts:17-19` | `project-state` |
| ingest 的 per-terminal map、active target、注入的 ref | `ingest.ts:62-83,394-416` | `project-state`（map）；ref 由資源在 `start` 傳入 per-session 物件 |
| 因果解析的 6 個 map | `causes-resolver.ts:41-72` | `project-state` |
| socket 歸屬的 3 個 map 與計數 | `socket-attribution.ts:63-95` | `project-state` |
| 寫入端快取（sessionId、last hash、count、clock check） | `db/event-write.ts:109,146,180,348` | `project-state` |
| 衍生計數快取 | `scope-observation-count.ts:9`、`visibility-signals.ts:41` | `project-state` |
| 擷取健康的錯誤與快取 | `capture-health.ts:196-463` | `project-state`（D11）；provider 注入維持 app 範圍 |
| API 的專案身分與 14 個 ref | `api-server.ts:54-121` | `api-binding` 資源；伺服器本身、port、`appVersion` 維持 app 範圍 |
| 錨定、NTP 計時器 | `chain-anchor.ts:257-262`、`clock.ts:5,79` | `anchor`、`ntp` 資源（`cachedOffsetMs` 為機器範圍，保留） |
| 監看器的 cfg／timer／generation | `clipboard-monitor.ts:31-40`、`file-watcher.ts:62-69`、`process-monitor.ts:142-229`、`connection-monitor.ts:55-70`、`powershell-transcript.ts:47-61`、`cdp-connector.ts:56-82`、`opsec-state.ts:117-126`、`tailer-host.ts:309-470,1208` | 各自的資源；模組內 `generation` 計數刪除 |
| 終端機 identity 與 cast 上限 | `terminal-manager.ts:369-370` | `terminal-binding` 資源；pane 本身（`sessions`）維持 app 範圍（Spec 055） |
| 擷取瀏覽器子行程 | `browser-launcher.ts:150` | `capture-browser` 資源 |
| air-gap 旗標 | `updater.ts:342` | `updater-airgap` 資源 |
| main 的變數 | `index.ts:218,615,631,638,718-720` | 各自的資源；`showWifiName` 為機器設定，由 `ConfigView` 讀 |
| alert runtime、loot detector、screenshot agent 實例 | `index.ts:518-534`（模組層常數，內含專案狀態） | 每個 session 建一個，由資源持有 |
| 計時器與 cleanups | `ProjectRuntime`（`project-runtime.ts`） | `session.timers` |
| 有效設定 | 每個讀者自行 `loadConfig`（36 處） | `session.config` |
| 機器設定 | 每個專案的 `config.yaml`、`hook-config.json` | `machine.yaml`（`machine-settings.ts`） |
| 外部寫入的紀錄 | 無 | `install-ledger.ts` |
| AI 是否可記錄 | 收據 + 複製本 + 專案 `installationId`（`official-agents.ts`、`agent-capture-policy.ts`） | `ai-consent.ts` + 專案 `consent` + 機器 `revokedAt` |

維持 app 範圍（不屬於 session，允許清單分類 `app`）：視窗、托盤圖示物件、單一實例鎖、API 伺服器與 port、外掛載入結果（`plugins/index.ts:21`）、事件型別與標籤登記（`event-registry.ts`、`command-tagger.ts`）、簽章金鑰快取（`signing.ts`）、shell 目錄、WSL 快取、工具偵測、更新流程、`bounded-regex` worker、內建終端機 pane。

### 介面草稿

```ts
// src/core/session/resource.ts
export type ResourceId =
  | 'db' | 'project-state' | 'lifecycle-records' | 'terminal-binding' | 'body-index' | 'cast-index'
  | 'query-worker' | 'exports' | 'screenshot' | 'opsec' | 'cdp' | 'agent-tailer' | 'powershell-transcript'
  | 'connection-monitor' | 'process-monitor' | 'file-watcher' | 'clipboard' | 'alert' | 'scope-recompute'
  | 'retention' | 'handoff-drain' | 'chain-sample' | 'ntp' | 'anchor' | 'updater-airgap' | 'link-monitor'
  | 'managed-proxy' | 'capture-browser' | 'handoff-identity' | 'api-binding' | 'presentation'

export type CloseReason = 'closed' | 'switched' | 'reopened' | 'app-quit' | 'update-restart' | 'open-failed'

export interface ResourceContext {
  readonly token: SessionToken           // generation, signal, projectId, engagementId, operatorId (getter)
  readonly config: ConfigView
  readonly dir: string                   // the project directory
  readonly mode: 'capture' | 'read-only'
  readonly timers: SessionTimers         // interval/timeout bound to the token (moved from ProjectRuntime)
}

export interface ProjectResource {
  readonly id: ResourceId
  readonly use: 'capture' | 'read'       // read-only sessions start only 'read'
  readonly reads: readonly SettingKey[]  // replaces CONFIG_DEPENDENCIES for this resource
  start(ctx: ResourceContext): void      // synchronous; async follow-ups take ctx.token and check it
  apply?(change: SettingsChange, ctx: ResourceContext): void   // only called when a key in `reads` changed
  stop(reason: CloseReason): void        // synchronous; must not await
  inspect(): ResourceInspection
}

export interface ResourceInspection { projectIds: readonly string[]; timers: number; handles: number }
export interface SettingsChange { keys: readonly SettingKey[]; prev: ConfigView; next: ConfigView; reason: ConfigApplyReason }

// src/core/session/session.ts
export interface PreparedOpen { readonly project: ProjectMeta; readonly mode: 'capture' | 'read-only'; readonly config: ConfigView; /* + owned db handles */ }
export type PrepareFailure = { phase: 'config' | 'machine' | 'db' | 'archive-marker'; path: string; message: string; position?: { line: number; column: number } }
export function prepareOpen(project: ProjectMeta, deps: PrepareDeps): { ok: true; prepared: PreparedOpen } | { ok: false; failure: PrepareFailure }
export function startSession(prepared: PreparedOpen, resources: readonly ProjectResource[]): ProjectSession   // throws OpenFailed{resourceId, cause} after reverse-stopping
export function closeSession(session: ProjectSession, reason: CloseReason): CloseReport   // {failed: Array<{id, error}>}
export interface ProjectSession {
  readonly token: SessionToken
  readonly project: Readonly<ProjectMeta>
  readonly mode: 'capture' | 'read-only'
  readonly state: SessionState
  readonly config: ConfigView
  readonly db: SessionDb                  // rw (null in read-only) + ro handles
  isCurrent(token: SessionToken): boolean
  applySettings(next: ConfigView, reason: ConfigApplyReason): ConfigApplyPlan
  inspect(): ReadonlyArray<{ id: ResourceId; inspection: ResourceInspection }>
}

// src/core/session/config-view.ts
export type SettingOrigin = 'default' | 'machine' | 'project' | 'session'
export interface ConfigView {
  readonly revision: string
  effective(): Readonly<RedLogConfig>
  get<K extends SettingKey>(key: K): SettingValue<K>
  origin(key: SettingKey): SettingOrigin
}
export function resolveConfig(layers: { machine: MachineLayer; project: ProjectLayer; session?: SessionLayer }): { ok: true; view: ConfigView } | { ok: false; error: ConfigError }

// src/core/settings-registry.ts
export interface SettingDef { home: 'machine' | 'project'; overridable: boolean; pinnedOnLegacy?: true; store?: 'machine.yaml' | 'terminal-mode' | 'terminal-app' | 'command-class.json' }
export const SETTINGS: Readonly<Record<SettingKey, SettingDef>>

// src/core/install-ledger.ts
export type LedgerKind = 'rc-block' | 'profile-line' | 'json-entry' | 'file-copy' | 'credential-file' | 'instructed'
export function apply(change: PlannedChange): LedgerEntry                 // intent → write → mark present
export function verify(): ReadonlyArray<{ entry: LedgerEntry; state: 'present' | 'missing' | 'modified' | 'unknown' }>
export function remove(component: string): RemovalReport                 // {removed: LedgerEntry[]; left: Array<{entry; reason: 'modified'|'unwritable'|'unreachable'|'instructed'}>}
export function adopt(scan: AdoptionScan): LedgerEntry[]

// src/core/ai-consent.ts
export type ConsentState = 'valid' | 'none' | 'revoked' | 'scope-changed' | 'legacy-installation'
export function consentState(source: AgentCaptureSourceConfig | undefined, machine: MachineAi, declaration: AdapterDeclaration): ConsentState

// src/core/terminal-enrollment.ts (changed)
export type TerminalStopReason = 'operator' | 'hook-removed'             // 'project-switched' read as absent
export function bindingState(e: TerminalEnrollment, openEngagementId: string | null): 'recording' | 'bound-elsewhere' | 'stopped'
```

### 資源清單（啟動順序；停止為相反）

| # | id | 用途 | 包含（今天的位置） |
|---|---|---|---|
| 1 | `db` | read | `initDB`、`bindDBEngagement`、`restrictProjectDirs`（`index.ts:786-788`）；`closeDB` |
| 2 | `project-state` | read | ingest、causes、socket-attribution、body／raw store 目錄、visibility、observation count、event-write 快取、capture-health 計數的 per-session 物件 |
| 3 | `lifecycle-records` | capture | 當機補寫、`session_start`、暫停沿用標記、`opsec_airgap` 列、存活戳記；停止時寫 `project_closed` |
| 4 | `terminal-binding` | capture | `recoverOrphanSessions`、`resumeTerminalRecordings`（`:916-920`）；停止時 `detachTerminalRecordings`（`:1261`） |
| 5 | `body-index` | read | `closeHttpBodyIndex` |
| 6 | `cast-index` | read | `backfillCastIndex`（`:1216`，唯讀時不回填）；`closeCastIndex` |
| 7 | `query-worker` | read | Spec 074 |
| 8 | `exports` | read | 進行中的匯出登記；停止時取消 |
| 9 | `screenshot` | capture | `screenshotAgent` |
| 10 | `opsec` | capture | `configureOpsecMonitor`／`startOpsecMonitor`（`:978-990`） |
| 11 | `cdp` | capture | `stopCdpMonitor` |
| 12 | `agent-tailer` | capture | `configureAgentTailer`、tailer contribution 的專案部分 |
| 13 | `powershell-transcript` | capture | |
| 14 | `connection-monitor` | capture | |
| 15 | `process-monitor` | capture | |
| 16 | `file-watcher` | capture | |
| 17 | `clipboard` | capture | |
| 18 | `alert` | capture | `alertRuntime`、IP producer、loot detector 的專案部分 |
| 19 | `scope-recompute` | capture | `recomputeTimer`／`recomputePending`／`recomputeRunning`（`:718-768`） |
| 20 | `retention` | capture | `startProjectServices` 的清理與週期計時器（`:853-910`） |
| 21 | `handoff-drain` | capture | `drainSpool` 與週期排空（`:929-974`；071 改寫內容） |
| 22 | `chain-sample` | capture | `:1096-1143` |
| 23 | `ntp` | capture | `startNtpLoop`／`stopNtpLoop`；讀 `network.offline` |
| 24 | `anchor` | capture | `startAnchorLoop`／`stopAnchorLoop`；讀 `network.offline`（取代 `chain-anchor.ts:51` 自行讀檔） |
| 25 | `updater-airgap` | capture | `setUpdaterAirgap`；讀 `network.offline` |
| 26 | `link-monitor` | capture | `startLinkMonitor`（`:649-661`，今天沒有 stop） |
| 27 | `managed-proxy` | capture | 自動啟動（`:1192-1205`）、`managedStartQueue`；停止時 `stopManagedHttpCapture(false)` |
| 28 | `capture-browser` | capture | 停止時 `stopBrowser`（按需啟動，但屬於 session） |
| 29 | `handoff-identity` | capture | `writeSpoolIdentity`／`clearSpoolIdentity` |
| 30 | `api-binding` | capture | `configureApi`、`onApiProjectOpen`／`onApiProjectClose` |
| 31 | `presentation` | read | HUD REC、托盤、IP 曝露狀態、唯讀標示 |

停止前的第 0 步：中止 token 的 signal、停止 session 計時器（今天 `projectRuntime.close()` 的角色）。

與今天 `stopProject` 順序的刻意差異（快照測試的初始值寫明這三點）：
1. HUD／托盤從最後移到最先（FR-006：對外標示最先撤下）；
2. `anchor` 與 `ntp` 互換（無依賴）；
3. `project_closed` 是新的。

`api-binding` 在 `handoff-identity` 之後啟動、之前停止，保持今天「API 先於 identity 撤銷」的契約。

### 給 074 的資源介面

這份是 `ProjectResource` 唯一的定義；074 plan 引用它，不另寫一份。`QueryService` 對外另有的 `query`、`notifyCommit`、`health` 是它自己的方法，不屬於資源介面。

`query-worker` 實作 `ProjectResource`，另須：
- `use: 'read'`（唯讀 session 也啟動）；
- `start(ctx)`：以 `ctx.dir` 下的資料庫路徑與唯讀模式建立 worker；不得自行開啟讀寫連線；
- 每個請求帶 `ctx.token.generation`；回覆時 token 已非目前的，回覆被丟棄，呼叫端得到 `session-closed`；
- `stop()`：同步地終止 worker（`worker.terminate()` 不等待），對所有進行中的請求以 `session-closed` 拒絕；不得延遲 `db` 的關閉；
- `inspect()`：回報 worker 開的資料庫所屬專案 id、進行中的請求數；
- 不持有任何模組層狀態（FR-090 的 gate 同樣適用於 074 的檔案）。

## 它取代什麼（依序，計數只降不升）

| 順序 | 取代的東西 | 位置 | 由誰取代 | 計數 |
|---|---|---|---|---|
| 1 | `stopProject` 本體 | `index.ts:1220-1280` | 反向停止資源清單 | 27 個步驟 → 0 |
| 2 | `startProjectResources` 本體與 `OPEN_SEQUENCE` hooks | `index.ts:802-1218`；`config-apply-plan.ts:68-103` | 依序啟動資源清單 | 1 個 420 行函式 → 0 |
| 3 | `ProjectRuntime` 類別 | `core/project-runtime.ts` | `ProjectSession` | 1 → 0 |
| 4 | 顯式 reset | `resetBodiesDirCache`、`resetCausesResolver`、`configureIngest({activeTarget:null})`、`resetVisibilitySignalsCache`、`invalidateObservationCount`、`recomputePending=null`、`clearSampleBroken` | per-session 物件 | 7 → 0 |
| 5 | `dbGeneration()` 懶重設與判斷 | 5 個檔案、17 處 | token | 17 → 0（R1c 的寫入守衛保留，它不用 generation） |
| 6 | 目錄比較快取 | `raw-store.ts:44`、`http-body-store.ts:34`、`cast-content-source.ts:19` | per-session 物件 | 3 → 0 |
| 7 | project id 比較 | 前述 12 處 | token | 12 → 0 |
| 8 | 模組層專案範圍繫結 | 約 30 個模組，Phase 1 gate 產生確切清單 | per-session 物件 | 基準 → 0 |
| 9 | 直接讀設定檔 | 36 處（下表） | `ConfigView` | 36 → 0 |
| 10 | 6 處各自 new 的官方 agent manager | 見現況 | 一個 `aiCatalog()`（從 bundle 讀，app 範圍） | 6 → 1 |
| 11 | 無擁有者的外部寫入 | `hooks-manager.ts` 的 `writeFileSync`（:804,862,892,919,959,978,1022）、`wsl-manager` install／uninstall | `install-ledger.apply`／`remove` | 9 → 0 |

**36 處直接讀設定**（`loadConfig(` 在 `src/core/config.ts` 以外）與去處：

| 位置 | 讀什麼 | 去處 |
|---|---|---|
| `core/chain-anchor.ts:51` | `network.offline` | `anchor` 資源的 `reads`（apply 時停／啟迴圈） |
| `core/export-planning.ts:22,140` | 匯出政策 | `session.config` |
| `main/config-store.ts:46,73` | 寫入者讀自己的檔 | 保留（FR-012 的允許處） |
| `main/ipc/target-context.ts:24,34,39` | active target | `session.config`；寫入走 ConfigStore |
| `main/ipc/plugins.ts:93,128` | `loot.disabledRules`、operator | `session.config`；operator 讀 token |
| `main/ipc/artifacts.ts:24` | 身分與 scope | token 與 `session.config` |
| `main/ipc/events.ts:34` | scope 快照 | `session.config` |
| `main/ipc/markers.ts:98,130` | 身分 | token |
| `main/ipc/data-export.ts:34,144,157,162` | 政策指紋、可匯出的設定 | `session.config`（指紋以有效設定計算，含來源） |
| `main/index.ts:254,345,1027` | proxy 端點、驗證脈絡 | `managed-proxy` 資源 |
| `main/index.ts:611` | 重新套用 | `session.applySettings` |
| `main/index.ts:749` | scope 重算 | `scope-recompute` 資源 |
| `main/index.ts:781` | 開專案 | `prepareOpen` |
| `main/index.ts:847` | `routeTerminals` | `session.config`（按需讀） |
| `main/index.ts:1008-1010` | API 的 config loader | `api-binding` 資源傳入 `session.config` |
| `main/index.ts:1514` | 建立專案的種子 | `ConfigStore.create`（只寫專案鍵與卡片值） |
| `main/index.ts:1552,1560` | `config:get`、`agents:sources` | `session.config`（`config:get` 回 `{effective, origins, scopes}`） |
| `main/index.ts:1603,1667,1675` | scope 目標、scope 檔 | `session.config` |
| `main/index.ts:1748` | 擷取瀏覽器 | `capture-browser` 資源 |
| `main/index.ts:1803` | 匯出設定檔 | `session.config`（匯出只含專案層；機器層另一個動作） |

## 設定歸屬表

「錯置」欄：今天存在專案、但依本表歸屬機器的鍵。歸屬機器的鍵一律可在專案覆寫（`overridable`），除非註明。

| 鍵 | 歸屬 | 錯置 | 註 |
|---|---|---|---|
| `engagement.id` | 專案 | | 不可變，等於專案 id |
| `engagement.activeTarget` | 專案 | | 071 O11 後只用於 app 內操作 |
| `operator.id`、`operator.name` | 機器 | ✔ | 舊檔一律視為覆寫（D5）；新檔另寫鏡像（D6）。**Superseded（2026-11-13，修訂 B7）**：不可覆寫；專案檔中的值一律不讀，新檔不寫鏡像（D12） |
| `network.whitelist` | 專案 | | 攻擊用出口（VPS／VPN）屬於該次任務；見開放問題 Q5 |
| `network.blacklist` | 機器 | ✔ | 操作者自有 IP |
| `network.checkInterval`、`providers`、`confirmations`、`ipMode` | 機器 | ✔ | 這台機器如何查自己的 IP |
| `network.offline` | 專案 | | OPSEC 是任務的事實；有即時效果（FR-014） |
| `network.showWifiName` | 機器 | ✔ | 不可覆寫（純本機呈現） |
| `network.vpnAdapters` | 機器 | ✔ | |
| `scope.warnOnViolation`、`targets`、`excludeTargets`、`scopeFile` | 專案 | | |
| `scope.personalDomains` → `personalTraffic` | 機器 | ✔ | 改名；預設空；舊檔一律視為覆寫 |
| `screenshot.quality`、`diffThreshold` | 機器 | ✔ | |
| `screenshot.intervalSec`、`captureOnCommand` | 專案 | | 擷取政策 |
| `terminal.maxCastBytes` | 機器 | ✔ | 本機磁碟預算 |
| `clipboard.pollMs` | 機器 | ✔ | |
| `clipboard.storePreview` | 專案 | | 隱私選擇屬於任務 |
| `browser.binary`、`proxy`、`cdpPort`、`isolateProfile`、`ignoreCertErrors`、`extraArgs` | 機器 | ✔ | |
| `browser.startUrl` | 專案 | | 任務的起始頁 |
| `httpCapture.port`、`listenHost` | 機器 | ✔ | 有即時效果（重啟 proxy，既有 `managedProxy` 步驟） |
| `httpCapture.routeTerminals` | 機器 | ✔ | |
| `redaction.allowlist`、`denylist`、`entropyThreshold`、`minLength` | 機器 | ✔ | |
| `fileWatcher.watchPaths` | 專案 | | 任務資料夾 |
| `fileWatcher.ignorePatterns` | 機器 | ✔ | |
| `processMonitor.pollMs`、`ignoreCommands` | 機器 | ✔ | |
| `connectionMonitor.pollMs` | 機器 | ✔ | |
| `packs.hostMonitors`、`windowsOutput` | 專案 | | |
| `packMembers.*`（5 個） | 專案 | | 缺省即開（`config.ts:188-190`）；遷移不具體化缺省 |
| `agentTailer.sources.<kind>.*`（含新增的 `consent`） | 專案 | | D10 |
| `agentTailer.emitThinking` | 專案 | | |
| `loot.disabledRules` | 機器 | ✔ | |
| `retention.*`（casts、screenshots、httpBodies、agentTranscripts、loggedTier、bookmarks） | 專案 | | |
| `overlay`（舊區塊） | 機器 | ✔ | 已由 `hud-prefs` 取代；只在開啟時讀一次做種子（`index.ts:806`） |
| `hookExclusions.excludedPaths`（今天 `hook-config.json`） | 機器 | | 遷入 `machine.yaml`（D7-b） |
| `terminal-mode`、`terminal-app`、`command-class`（今天獨立檔） | 機器 | | 維持獨立檔；登記但不遷移 |
| `ai.revokedAt.*`、`ai.legacyInstallations.*` | 機器 | | 新增；不可覆寫 |

錯置的鍵共 32 個葉節點：`operator` 2、`network` 7、`personalDomains` 1、`screenshot` 2、`terminal` 1、`clipboard` 1、`browser` 6、`httpCapture` 3、`redaction` 4、`fileWatcher` 1、`processMonitor` 2、`connectionMonitor` 1、`loot` 1；舊的 `overlay` 區塊另計。精確清單由登記表的完整性測試列出。

## Gate（每一條規則的會失敗的檢查）

| 規則 | Gate | 形式 |
|---|---|---|
| 專案範圍狀態只在 session（FR-003、FR-090） | `scripts/verify-architecture.mjs` 新增 module-state 規則 + `scripts/module-state-allowlist.json` | AST：模組層 `let`／`var`／以 `new`、`[]`、`create*()`、`new Map/Set/BoundedMap` 初始化的 `const`；分類 `app`／`machine`／`constant`／`test-seam`／`session-slot`／`project-legacy`；`project-legacy` 計數 ratchet 只降；清單中失效項目也失敗；`session-slot` 恰好 1 |
| 不直接讀設定（FR-012、FR-091） | `test/config-direct-read.test.ts` | ratchet，基準 36（形式同 `test/mutation-guard.test.ts`） |
| 資源順序（FR-002） | `test/session-resource-order.test.ts` | 快照 `RESOURCE_ORDER`；停止順序為反向；`api-binding` 在 `handoff-identity` 之後、`terminal-binding` 在 `db` 之後等成對約束另以斷言列出 |
| 切換不洩漏（US1、FR-092） | `test/session-switch-leak.test.ts` | 由 `ResourceId` 列舉產生案例；缺案例即失敗 |
| 開啟不留半開（US2） | `test/session-open-failure.test.ts`（單元，注入第 k 個資源失敗，k 走遍全部）+ `e2e/project-open-rollback.spec.ts`（六種故障） | |
| 設定歸屬完整（FR-011、FR-093） | `test/settings-registry-complete.test.ts` | TS compiler 走訪 `RedLogConfig` 的葉節點；每個都在 `SETTINGS`；每個鍵被某資源 `reads` 或列在 `NO_LIVE_EFFECT`（附理由） |
| operator 只在機器層（FR-01D，修訂 B7） | `test/operator-machine-only.test.ts` | 專案檔帶 operator 時有效值仍是機器層、`origin` 為 `machine`／`default`、開啟不被拒、檔案不被寫；`ConfigStore` 拒絕專案層 operator op；建立與匯入丟棄 `operator`；登記表 `overridable: false` |
| 遷移無損（FR-016、FR-017、SC-006） | `test/config-legacy-equivalence.test.ts` | property test：隨機舊檔 × 隨機機器層 → 有效值 = 舊 `loadConfig`；存檔轉換前後相同 |
| 開專案不寫設定（FR-008、FR-015） | `test/open-never-writes-config.test.ts` | 開啟前後 `config.yaml` 位元組與 mtime 不變；壞檔被拒且不變 |
| `machine.yaml` 契約（FR-020–024） | `test/machine-settings-file.test.ts` | 權限、rename 前當掉留下舊檔、修訂衝突、新 schema 唯讀、未知鍵保留 |
| air-gap 即時（US3、SC-005） | `test/airgap-live.test.ts` | 網路替身計數 |
| 生命週期（FR-030–035） | `test/session-lifecycle.test.ts`（轉移表全組合）+ `test/project-closed-record.test.ts`（6 種結束） | |
| 終端機綁定（FR-040–045） | 擴充 `test/terminal-enrollment-agreement.test.ts` 的狀態表 + `test/shell-project-switch.test.ts` 改寫 | 兩份實作同表 |
| 帳本（FR-050–05A） | `test/install-ledger-roundtrip.test.ts`；`test/no-unledgered-external-writes.test.ts` | 後者掃描 `src/**`：寫入路徑含 `homedir()` 但不在 `.redlog` 之下的 `writeFileSync`／`rmSync`／`copyFileSync` 只能出現在 `install-ledger.ts`；ratchet 基準 9 |
| 同意與載入路徑（FR-060–067） | `test/ai-consent.test.ts`；`test/official-adapter-load-path.test.ts` | 後者：`require(` 的動態路徑只能在 `optionalAgentPackagesRoot()` 之下 |
| 匯入邊界（FR-094） | `test/session-boundary.test.ts` | 誰能匯入 `core/session/*`、誰能呼叫 `_setCurrent`、`start`／`stop` |
| 沒有新頁面（P10） | 既有 `test/settings-ia.test.ts` 的 `PAGES` 與 `FieldGroup` 預算 | |

沒有 gate 的規則與理由：
- 「新格式檔案的 operator 鏡像讓舊版署名不變」只能以舊版 app 實跑驗證：列為真機項目（T100）。（2026-11-13，修訂 B7：鏡像取消，本項與 T100 不再適用。）
- 「存活戳記每 60 秒」以假時鐘單元測試涵蓋，但「當機後補寫的時間接近實際」只能真機 `kill -9` 驗證。

## 遷移與相容

| 對象 | 做法 |
|---|---|
| 既有專案的 `config.yaml` | 不改寫；讀時依 D5；下一次存檔轉新格式 |
| `hook-config.json` | 第一次寫入時遷入 `machine.yaml`；舊檔保留一版 |
| 既有的終端機狀態檔（`project-switched`） | 讀為沒有停止原因（FR-041）；不改寫檔案，下一次寫入時自然消失 |
| 已安裝的 hook、孤兒項目 | 第一次啟動補登（FR-058） |
| `~/.redlog/plugins/official-ai-*` 與收據 | 第一次啟動遷移（FR-065）；資料夾不刪不執行 |
| 專案 `config.yaml` 的 `agentTailer.sources.<kind>.installationId` | 與 `legacyInstallations` 相符者視為已同意；第一次開啟補寫 `consent{by:'migration'}` |
| 舊版 app 開新格式專案 | D6 |
| 舊版 app 讀 `machine.yaml` | 不讀（不存在於舊版） |
| `e2e/project-open-rollback.spec.ts` | 期望值改為 US2（T020，先 RED） |

## 驗證策略

- **單元／property**：上表的 gate；遷移等價 10,000 組。
- **特徵化**（Phase 1，改動前）：`stopProject` 今天的順序以替身記錄成 golden；開啟時寫入的列與順序；每個 IPC 對「切換中」的回答。
- **e2e**（ubuntu CI）：`project-open-rollback`（六種）、`terminal-session-rotation`、`capture-browser-project-switch`、新增 `project-archive-readonly`、`settings-machine-override`。
- **真機**（不能以單元測試取代）：
  - macOS：A→B→A 加 air-gap 切換，以 `lsof -i`／`nettop` 看對外連線；tmux 切換恢復；`kill -9` 後重開看 `project_closed{unclean}`；`ZDOTDIR` 與 Terminal.app 的 login bash 安裝 → 移除位元組相同；Claude Code 升級不停錄。
  - Linux：同上的 hook 安裝移除；stow 管理的 `.zshrc`（symlink 詢問）。
  - Windows：PowerShell 5.1 與 7、`CurrentUserAllHosts` 與 VS Code host 的 profile 安裝移除（LF 不變 CRLF）；`machine.yaml` 的原子取代在檔案被另一個程序開著時；WSL distro 的 rc。
  - 舊版 app 開新格式專案（降版），確認署名不變。（修訂 B7：不再適用，見 D12。）
  - （修訂 B7）帶 operator `bob` 的既有專案、機器層 `alice`：升級後開啟，新列為 `alice`，設定頁沒有專案層的 operator；改 operator 後切到另一個專案仍是新值。
- **實機 UI 檢查**（契約落地時，依工作計畫的驗收規則二）：
  - 專案選擇器：封存標籤、封存與取消封存、開啟失敗的訊息、準備失敗時 A 仍在；
  - 設定頁：每個機器欄位的來源標示、「改用此電腦的值」、`machine.yaml` 錯誤與新 schema 唯讀；
  - 擷取控制：終端機列的「N 個綁定其他專案」、AI 來源列的同意對話框與「讀取範圍已變更」；
  - 指令與終端設定頁：多個 shell 的「已寫入 · 尚未看到」、移除報告；
  - 外掛頁：撤回同意、舊複製本的說明；
  - 唯讀標示與離開確認列出進行中的匯出。
- 決定、實作、驗證分開記錄在 `verification.md`：每一條 FR 三欄。

## Project Structure

### Documentation (this feature)

```text
specs/073-project-runtime-and-setting-scopes/
├── spec.md
├── plan.md
├── tasks.md
└── verification.md        # T001 建立
docs/design/DESIGN-project-runtime.md   # T090 改寫 §2–§4
docs/domain/glossary.md                 # T091
```

### Source Code

```text
src/core/session/{session,current,resource,lifecycle,config-view,timers}.ts   # 新
src/core/settings-registry.ts           # 新
src/core/machine-settings.ts            # 新
src/core/install-ledger.ts              # 新
src/core/ai-consent.ts                  # 新
src/core/project-runtime.ts             # 刪除（Phase 3 結束）
src/core/config.ts                      # LEGACY_V1_DEFAULTS、personalTraffic；loadConfig 只剩 ConfigStore 用
src/core/config-apply-plan.ts           # 輸入改為有效設定；reads 由資源提供；NO_LIVE_EFFECT 重審
src/main/config-apply.ts                # 執行者改為 session.applySettings 派發資源 apply
src/main/config-store.ts                # 兩個檔的寫入者；create、resetToMachine
src/main/session-resources.ts           # 新：資源陣列
src/main/index.ts                       # startProject/stopProject/startProjectResources 刪除
src/core/terminal-enrollment.ts         # bindingState；停止原因縮減
src/core/hooks-manager.ts, src/core/wsl-manager.ts   # 經帳本寫入
src/core/plugins/official-agents.ts     # 只讀 bundle；收據遷移
src/core/agent-capture-policy.ts        # consent 條件
scripts/verify-architecture.mjs, scripts/module-state-allowlist.json
```

**Structure Decision**：新模組放在 `src/core/session/` 一個目錄（它們彼此是同一個擁有者的不同面）；其他新模組各一個檔放在 `src/core` 根目錄，與既有慣例一致。不搬動既有檔案。

## Complexity Tracking

| 新增 | 解決的現存問題 | 較簡單做法為何不夠 |
|---|---|---|
| `src/core/session/`（6 個檔） | 三份手寫清單、四種過時判斷、0 個 `onStop` 使用者（07-F1） | 只在 `stopProject` 加更多 reset：就是 8 次以上修正的形狀 |
| `ProjectResource` 介面 | 開、關、套用三份清單對不齊（air-gap 實例） | 保持清單、加註解：#702 已證明光是套用一份就要一個模組 |
| 設定登記表 | 「哪個值屬於哪裡」沒有答案（09-F8、Spec 051） | 在 `config.ts` 加註解：無法由測試檢查 |
| `machine.yaml` | 機器事實每個專案重設（09-F8） | 「複製上一個專案的設定」：新專案仍各自一份，改一次要改 N 次 |
| 安裝帳本 | 孤兒 hook、不可逆移除（08-F3、09-A.2） | 以 manifest 重算：manifest 不在了就算不出來 |
| 同意記錄 | 複製本造成全專案停錄（08-F2） | 保留複製、自動更新：仍有 TOCTOU、仍擋 fuses |

## 開放問題（需要擁有者）

Q1–Q5 移到 [spec.md](spec.md)「開放問題（需要擁有者）」，與其他四份規格同一個位置與標題。

## 無法從程式確認的事項與最便宜的檢查

| 事項 | 最便宜的檢查 |
|---|---|
| `loadYamlDocument` 對壞 YAML 會丟錯（所以 `loadConfig` 回預設、開專案覆寫檔案） | 一個單元測試：寫入 `a: [`，呼叫 `startProject` 的準備路徑，比對檔案位元組（T010，預期 RED） |
| AI tailer 的續讀位置不以模組路徑為鍵 | 讀 `tailer-host.ts` 的 `resumeBoundary`、sidecar 鍵的組成（`agent-tailer.ts:26` 的 `cacheKey` 只用於 `loaded` map） |
| better-sqlite3 在 `-shm` 不可寫時能否以唯讀開 WAL 資料庫 | 在 tmp 目錄 chmod 後開啟一次 |
| 進行中的 hook 寫入位置變更（`ZDOTDIR`、bash login 檔）實際寫哪些檔 | `work/1112-hooks` 分支目前沒有 commit；向擁有者或該 session 取得檔案清單 |
| Windows 上 `fs.renameSync` 取代被另一程序以讀開啟的檔案是否成功 | Windows CI 的 unit leg 加一個測試 |
| 舊版 app 讀到 `operator.mirror: true` 時 `deepMerge` 是否保留且不影響 | 以 v0.18 的 `config.ts` 單元執行一次（2026-11-13，修訂 B7：鏡像取消，不需檢查） |
