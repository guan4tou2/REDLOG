# 08 · 外掛系統：現況、矛盾與目標設計（root-cause review）

範圍：`src/core/plugins/**`、`src/main/ipc/plugins.ts`、`src/main/services/agent-tailer.ts`、`hooks-manager.ts` 的 capture registry、`capture-packs.ts`、`capture-health.ts` 的 producer 列、`external-event-policy.ts`、`bounded-regex.ts`、`plugins/**`、`optional-plugins/**`、`scripts/build-ai-plugins.mjs`、`electron-builder.yml`、設定頁的 Plugins／擷取控制／Hooks 元件，以及 DESIGN-plugin-kernel、DESIGN-E1、plugin-development.md、Spec 065/066/067/070（四份都是 **Draft**）、PLUGIN-MANAGEMENT-SPEC。
基準：main `a087c16c`。唯讀審查；沒有改 repo、沒有啟動 app。另讀了本機已安裝的 `/Applications/RedLog.app` 的檔案權限（F7）。
與其他報告的關係：狀態模型沿用 04 的 `SourceDescriptor`／8 個狀態字；信任邊界沿用 05 的同 UID 威脅模型；遵守 07「不要把內建來源改成 plugin、不要做 mapper 管線」的警告；API 權限拆分由 owner 起草中的 spec 負責，本報告只寫外掛系統需要它提供什麼（§3b-4）。

## 摘要（10 行）

1. 今天的「外掛」不是一份契約，是**三份 manifest schema**（generic `plugin.json`、hooks-manager 的 producer manifest／`builtinProducers`、官方 AI 的 `redlogAgent` 區塊）加**五台互相重疊的狀態機**（loader、official manager、專案 agent 設定、capture-health、pack 開關）。schema 宣告的能力大多沒有行為：`kind`、`capabilities`、`signature/publisher`、`schemaVersion`、頂層 `emits/health`、`hash-changed` 都沒人讀或從不產生（F1）。
2. 🔴「特權程式碼」層在 generic 系統裡**一個成員都沒有**：沒有 bundled plugin 帶 `tailers`，使用者 tailer 一律拒絕。真正在 main 跑的第三方形狀程式碼只有官方 AI adapter，而它走另一條路（F1、F2）。
3. 官方 AI adapter 被「安裝」成 `~/.redlog/plugins/<id>/adapter.cjs`，條件是位元組必須和 app 內那份完全相同。這個複製本只帶來負擔：app 更新改了 adapter → `update-available` → 該 agent 在**所有專案**停錄，直到有人去外掛頁按更新；另外還衍生出 conflict、收據損毀、TOCTOU，而且它正是 asar integrity fuses 不能開的理由（F2）。
4. 「安裝」沒有擁有者記錄：撤銷、停用、hash 變更或移除都只把 manifest 從記憶體拿掉，已寫進 rc／`~/.claude/settings.json` 的 hook 留著，而且之後連 `uninstallHook` 都找不到它；claude-settings hook 指向外掛資料夾裡的**活檔案**。核准畫面說「會安裝」，UI 卻沒有任何地方提供第三方 capture 的安裝鈕（F3）。
5. Producer 沒有身分：任何持 token 者都能用任何允許的 `agent_type` 寫入（包括 `shell`）；停用外掛不會停止接收；heartbeat 每 15 秒一筆 **chained** `system` 事件；同一類證據有兩種形狀、落在不同 tier（F5）。
6. 外掛提供的文字直接變成操作指示：未核准的使用者外掛，它的 `manualSteps`（含 `sudo "{hookFile}"`）就顯示在擷取控制頁；本機 `/Applications/RedLog.app` 裡 bundled 的 `pcap-capture.sh` 由操作者擁有、權限 755，所以「sudo 執行使用者可寫的檔案」是一條同 UID → root 的路（F7）。
7. bundled 的 8 份 manifest 裡，5 份其實是核心功能加上一份 manifest（starter-pack、builtin-tools、兩個 pack-*、官方 AI 的 pack 殼）。它們變成**機器層的隱藏開關**；使用者外掛只要用同一個 id 就能無聲取代 bundled 的版本（例如讓目標抽取與 scope 監控整個消失），而外掛頁把這些列藏了起來（F4）。
8. Processor（regex 規則）的時間上限是「每個規則集、每趟 250 ms」，不是「每個事件」：每停掉一條規則，就再同步 `Atomics.wait` 一趟；target extractor 每個指令要 1+N 趟。它們的輸出會上鏈，卻沒有記錄是哪一版規則集算出來的（F6）。
9. 目標：**一份有版本的 manifest（v2）**，種類只有 Source／Processor（Exporter 不建），全部是 core 解讀的資料或行程外程式；第三方程式碼永遠不進 RedLog 的行程；官方 adapter 視為 app 程式碼，從 app 本體載入；機器範圍（信任）與專案範圍（啟用）各有唯一的家；狀態一律經 04 的 8 個字呈現。
10. 遷移 7 步，每步都可出貨；gate 有 5 道：schema 測試、邊界測試、ingest 時間預算測試、移除無殘留測試、文件範例驗證。前 5 名改動與 5 個要 owner 決定的問題放在文末。

---

## 1. 外掛今天到底是什麼（從程式抽出）

### 1.1 實際被接受的 manifest：三份，不是一份

| schema | 定義處 | 誰讀 | 誰用 |
|---|---|---|---|
| A. generic `plugin.json` | `core/plugins/types.ts:202-225`；驗證在 `manifest.ts:191-276` | `loader.ts`（bundled `<resources>/plugins` 與 `~/.redlog/plugins`，同 id 時 user 勝出，`loader.ts:102-104`） | 全部 7 個 bundled 目錄、使用者外掛、官方 AI 安裝後的資料夾 |
| B. producer manifest（同名 `PluginManifest`，不同型別） | `hooks-manager.ts:168-230` 的 `STARTER_PACK_FALLBACK`，加上 `plugins/starter-pack/plugin.json` 的 `builtinProducers` | `loadStarterPack()`（`hooks-manager.ts:236-268`）直接按路徑讀，**不經 loader** | 內建 shell／mitmproxy／PS／WSL；欄位有 `requiresAll`、`supportFiles`、`powershell-profile`，A 都不接受 |
| C. 官方 AI `redlogAgent` | `optional-plugins/*/plugin.json`；build 時補上 `sha256`（`build-ai-plugins.mjs:24-26`）；驗證在 `official-agents.ts:74-83` | `createOfficialAgentPluginManager`（在 6 處各自 new 一個：`main/index.ts:553,1566`、`ipc/plugins.ts:30,64`、`capture-health.ts:651`、`agent-tailer.ts:51`） | Claude Code、Codex |

C 的資料夾裝好之後**也會被 A 的 loader 讀到**（`kind:"pack"`、`contributes:{}` → declarative、`active`）。`resolveAgentCapture` 要求兩邊同時成立（`agent-capture-policy.ts:30`）。所以同一個資料夾由兩個 loader 用兩套規則解讀。

### 1.2 種類：程式碼 vs 設計文件

- 設計文件（DESIGN-plugin-kernel §2）：producer／mapper／enrichment／exporter。
- 型別：`PluginKind = producer|mapper|enrichment|exporter|pack`（`types.ts:193`），驗證會接受（`manifest.ts:135`），但**沒有任何程式碼讀 `manifest.kind`**（grep 過 `src/`）。`types.ts:190-192` 說「kernel 用它判斷哪些是 capture source」，這句不實。
- 真正決定行為的是 `contributes` 的鍵：`lootPatterns`、`redaction`、`commandTags`、`targetExtractors`、`eventTypes`、`capture`、`terminalProfiles`、`tailers`。被拒絕的有 `exporters`／`monitors`／`mappers`（`manifest.ts:16-22`）。
- 歷史上一再發生「宣告了，然後退役」：marketplace（`41609a21`）、`mcpTools`（`2d4f06a0`）、code host（`ad733d68`「stop documenting isolation we don't have」）、`exporters/monitors`（Spec 027）、mappers 與 `/api/ingest`（`ae446325` 建了，後來拿掉；今天 `api-server.ts` 沒有 `/api/ingest`）。

### 1.3 信任層與各層能做什麼

| 層 | 內容 | 在哪執行 | 要不要核准 |
|---|---|---|---|
| 🟢 純資料 | loot／redaction denylist／commandTags／targetExtractors／eventTypes、`manual` capture | core 在 main 解讀；**使用者**規則的 regex 在 `bounded-regex` worker 跑，**bundled** 規則在 main 直接跑（`command-tagger.ts:12-15`、`target-extractor.ts:249-254`） | 不用，載入就 `active` |
| 🟢 但要核准 | `terminalProfiles`；非 `manual` 的 capture（`shell-source`／`claude-settings`） | 寫 `~/.redlog/terminal-profiles.json`；hook 由 shell／Claude Code 以使用者身分執行 | 要（`manifest.ts:81-86`） |
| 🔴 特權 | `tailers`：在 main `require()`（`contributions.ts:162-167`） | main，**沒有任何隔離** | 要；而且只接受 bundled（`contributions.ts:45-51`）。**目前沒有任何 bundled plugin 帶 `tailers`**（7 份 manifest 都看過了），所以這層是空的 |
| 官方 AI（不屬於上面任何一層） | `adapter.cjs` | main，`require(cacheKey)`（`agent-tailer.ts:28-29`），拿到 `chokidar.watch` 與 Node 的全部權限 | 不經 trust store；「安裝」＝把 app 內的 bytes 複製到 `~/.redlog`，加上一份收據（`official-agents.ts:201-214`） |

「isolated code execution」在實作上的意思：**沒有**。唯一的隔離是 regex worker，它只限制時間（05 報告已列為健全的部分）。`Capability`（`read:events`、`net:outbound`…，`types.ts:158-167`）會被驗證、顯示在核准對話框（`PluginsPanel.tsx:487-490`）、寫進 trust grant，但**沒有任何東西依它執行**。

### 1.4 外掛能讀寫什麼

- 資料類外掛：只能影響 core 的解讀，包括遮蔽（只能加，`manifest.ts:164-170`）、loot、目標、標籤、終端分類。
- 行程外 producer：讀 `~/.redlog/api-token`，打 `POST /api/events`。可以寫入 `external-event-policy.ts:12-20` 列出的任何 type，包括 `shell`，也能送 `system.producer_heartbeat` 宣稱自己是任一個 producer id（`:28-36`）。同一個 token 也能讀事件、改錄製狀態、匯出（05 F2）。它以使用者身分執行，所以 `~/.redlog` 底下的東西它都碰得到。
- 官方 adapter：main 行程能做的它都能做。

### 1.5 hash／簽章到底涵蓋什麼

- `computeContentHash`（`manifest.ts:294-310`）= 正規化後的 manifest（id、version、redlogApi、contributes、capabilities）+ `codeFilesOf`（`tailers` 模組 + 每個 `capture[].hookFile`）。**不包括**：hookFile 會呼叫的同目錄檔案（例如 `pcap-capture.sh` → `pcap-capture.js`／`pcap-parse.js`／`pcap-sidecar.js`），以及 tailer 模組 `require` 的其他檔案。
- `signature`／`publisher` 會被解析（`manifest.ts:272-273`），但**從不驗證**。
- 官方 AI：以 `sha256(adapter.cjs)` 比對 app 套件（`official-agents.ts:83`），收據比對 manifest 與 code 的 hash（`:149-153`）。檢查（`inspect`）和 `require` 之間會再讀一次檔案（TOCTOU，`main/index.ts:559` → `agent-tailer.ts:28-29`）。
- 核准的範圍：IPC `plugins:grant(id)` 只帶 id；main 拿上次載入時的 hash 去 pin（`index.ts:136`）。如果檔案在載入後被改，pin 住的是舊 hash，下次載入就回到 needs-consent，這個方向是 fail-closed，是對的。但同意的畫面在 renderer（05 F5），而且**不顯示 hash，也不顯示 hook 內容**。

### 1.6 狀態存在哪

| 狀態 | 位置 | 範圍 |
|---|---|---|
| 停用清單 | `~/.redlog/plugins/state.json`（`state.ts`） | 機器，所有專案 |
| 信任 grant | `~/.redlog/plugins/trust.json`（`trust.ts`，寫入時沒有指定 mode） | 機器；`grantedBy` 卻取當下專案的 operator id（`ipc/plugins.ts:128`） |
| 官方安裝收據 | `~/.redlog/plugins/.official-ai-installations.json`（0600） | 機器 |
| AI 專案授權 | 專案 config `agentTailer.sources.<kind>`：enabled、startedAt、workPaths、installationId… | 專案 |
| pack 開關 | 專案 config `packs.<id>` + `packMembers`；同時要求 bundled pack 外掛為 `active`（`capture-packs.ts:36-39`） | 專案 × 機器 |
| 已安裝的 hook | rc 檔、`~/.redlog/<target>`、`~/.claude/settings.json` | 機器；**沒有 RedLog 的擁有者紀錄** |
| contribution report、規則被停 | 記憶體 | app session |

### 1.7 實際的生命週期（五台機器）

```
loader（每個 plugin.json）         official manager（每個 agentKind）
  error ◄── 解析/驗證失敗             not-installed ──install──► installed
  disabled ◄── state.json              installed ──app 更新改了 bytes──► update-available ──install──► installed
  needs-consent ◄── 要核准且 hash 不符    任何檔案異動/收據不符 ──► conflict
  active                                 收據壞掉 ──► error
  (hash-changed：型別有、i18n 有、UI 有，loader 從不產生)

專案 AI 授權（resolveAgentCapture 的 8 個條件，全部成立才跑）
pack：plugin active × packs.<id> × packMembers.<m>
capture-health：ready | unset | off | error（+ informational/running for plugin producers）
```

與 spec 對照：065 FR-021 要求把「安裝／信任／功能生效／專案設定／擷取健康」**分開呈現**，等於把這五台機器原封不動搬上 UI，而不是減少它們；066 FR-003 讓官方整合的安裝只在外掛頁；067 FR-011/012 在 Draft 中要再加「移開」「重新採用」兩個狀態；070 FR-001-003 的 `CaptureSourceStatus` 沒有實作（04 F1）。四份 spec 都是 Draft，所以沒有一份能被當成必須一起改的契約（07 F6）。

---

## 2. 矛盾與機制（依影響排序）

### F1　外掛不是一份契約：三份 schema、五台狀態機，宣告了的能力大多沒有行為

**機制。** 外掛系統一直靠「先宣告未來的能力」長出來，而且沒有任何 gate 要求每個被接受的欄位都要有消費者。宣告了的東西 UI 會顯示、文件會寫、測試會測，卻沒有任何行為支撐。之後每一次清理都只退役一個鍵。
**實例。**
- `kind` 被解析，卻沒人讀（§1.2）；`mapper`／`exporter` 會通過驗證（07 F6 已指出）。
- `capabilities` 被顯示、被 pin，卻沒有執行環境（§1.3）。核准對話框列出 `net:outbound` 之類的項目，暗示真的有這種限制。
- `signature`／`publisher` 不驗證；`plugin-development.md:80` 寫「reserved」。
- `PluginStatus 'hash-changed'`：`loader.ts:38-46` 的 `statusFor` 只會回 `needs-consent`；UI 卻有 `plugins.status.hash-changed`「程式碼已變更」，`pluginViewModel.ts:130` 也有對應的 issue。
- 頂層 `emits`／`health`／`schemaVersion`（`types.ts:211-217`）沒人讀；真正被讀的是 `capture[].emits`。
- 同一個概念有三種寫法：producer 的前置條件在 A 是 `requires`（any-of），在 B 是 `requires`＋`requiresAll`，在 C 不存在；04 說 `requires` 最後被壓成一個 `available` 布林。
- 官方 AI 套件同時被兩個 loader 解讀（§1.1），IPC 還得特判（`ipc/plugins.ts:113`「Manage official AI integrations in capture sources」）。
**為什麼過去的修補只治標。** `ad733d68` 與 `795a1bd0` 刪掉了錯誤的文件；#348 讓每種 contribution 回報結果。可是 schema 本身沒有版本化的單一定義，所以下一個欄位一樣會「先宣告、後補行為」。
**結構改動。** 見 §3a：manifest v2 用一份 JSON Schema 定義，loader、測試、文件都從它產生；每個欄位都要在 gate 裡登記它的消費者。
**影響範圍。** `core/plugins/*`、`hooks-manager.ts` 的 registry、`official-agents.ts`、8 份 bundled manifest、2 份 optional、`examples/plugins/*`。

### F2　官方 AI adapter 被複製進使用者可寫的目錄才執行；這份複製本只產生狀態與風險

**機制。** 「安裝」的定義是「把 app 內的 bytes 複製到 `~/.redlog/plugins/<id>/`」，而載入條件又是「bytes 必須與 app 內那份相同」（`official-agents.ts:155,165-168`）。所以複製本**不可能**帶來 app 本體沒有的東西；它唯一的作用是成為一個會偏離、會損毀、會被替換的第二份。
**實例。**
- app 更新只要改了 adapter 的建置輸出，`inspect` 就回 `update-available`，`modulePath` 回 `undefined`（`:167`），`applyCapturePacks` 就不再給這個 agent integration（`main/index.ts:557-560`）。因為狀態在機器範圍，**每個專案**的該 agent 都停錄，直到操作者去外掛頁按更新。不是無聲的（`capture-health.ts:659-660` 會把列標成 error），但它是一個由更新本身造成的停錄。
- Spec 067 的 US8（收據損毀）、US9（衝突恢復）、D2（重新採用）、D3（移開）全都是因為有這份複製本才存在的問題。
- `electron-builder.yml:53-56` 寫明：`enableEmbeddedAsarIntegrityValidation`／`onlyLoadAppFromAsar` 不開的理由之一，就是 main 會 `require()` `~/.redlog/plugins/<id>/adapter.cjs`。
- `inspect` 與 `require` 之間的 TOCTOU（§1.5）。在同 UID 的威脅模型下影響不大，但它代表「我們驗證的」和「我們執行的」不是同一次讀取。
- install 會順手把被停用的 generic 外掛重新啟用（`ipc/plugins.ts:70-76`），又多一條狀態路徑。
**結構改動。** adapter 從 app 本體載入（`<resources>/optional-ai/<id>/adapter.cjs`；之後可以搬進 asar）。「安裝」改成一筆**同意收據**（agentKind、同意時間、同意當下 adapter 宣告會讀的根目錄與會產生的事件種類），不再複製檔案。之後的 app 更新只要宣告的讀取範圍沒變，同意就延續。`update-available`、`conflict`、收據 hash 比對都刪掉。
**遷移。** (1) 新版啟動時：若 `~/.redlog/plugins/official-ai-*` 存在且收據有效，就把收據轉成同意收據，**`installationId` 保持不變**，所以專案設定裡的 `installationId` 不會失效；舊資料夾留著不刪，只是不再執行它。(2) 外掛頁的「移除」改成撤回同意，並且說明舊資料夾仍在。(3) 下一版再評估 fuses。
**風險。** 舊版 app 回頭讀到只有收據、沒有資料夾的狀態：舊版會顯示 not-installed，這是可接受的降級。打包時 `optional-ai` 漏檔：`verify:package-resources` 已經會檢查 `out/optional-ai`（要確認）。
**驗證。** manager 單元測試（收據轉換、同 id 延續）；實機：安裝 → 換一版 adapter 的 build → 啟動後仍在錄；mac 與 Windows 的打包版各跑一次；fuses 用 `verify-fuses.mjs` 讀回。

### F3　安裝沒有擁有者紀錄：收回不了、移除不了，核准還指向一個不存在的動作

**機制。** 「RedLog 在這台機器上寫了什麼」只能從**目前載入的 manifest** 反推（`allManifests()`）。一旦 manifest 不在了（停用、撤銷、hash 變更、刪除資料夾、starter-pack 被停用），RedLog 就再也認不得自己寫進去的東西。
**實例。**
- `unregisterCapturePlugins` 只把 manifest 移到 `retiredCaptures`（`hooks-manager.ts:334-341`）；`uninstallHook` 只查 `allManifests()`（`:936-938`），所以對已退役的 capture 會回「Unknown plugin」。rc 裡的 `source` 行與 `~/.claude/settings.json` 的 PostToolUse 項目就成了孤兒。
- `claude-settings` 安裝寫進去的是外掛資料夾裡的**原檔路徑**（`hooks-manager.ts:852-860`，`command: hookFile`），不是 pin 住的複本。hash 變更之後外掛雖然回到 needs-consent，Claude Code 每次工具呼叫仍會執行改過的那個檔案。核准 pin 的是 hash，執行的卻是活檔案。
- 停用 starter-pack 會讓內建 shell hook 從 `allManifests()` 消失（`:366`），已安裝的 hook 也就無法從 RedLog 移除。
- **死路**：一個使用者外掛宣告 `shell-source`／`claude-settings` capture，核准對話框說「會把 X 裝進你的 shell」（`PluginsPanel.tsx:512-518`），但 HooksPanel 只列 `hook.builtin`（`HooksPanel.tsx:95`，註解 `:190-192` 說外掛的 capture 在外掛頁），外掛頁和 ExternalCaptureGroup 都只顯示手動步驟（`ExternalCaptureGroup.tsx:138`）。`hooks.install` 在 renderer 只有 `RecordTerminalFlow` 會呼叫（只給內建 shell）。所以「核准 → 安裝」這條路在 UI 上不存在，`plugin-development.md:275-281` 卻寫成「one-click install」。
**為什麼過去的修補只治標。** `b1d8620f` 讓 uninstall 只刪 RedLog 寫的那一筆，但前提是 manifest 還在；FR-016 修的是 rc 位元組的可逆性，不是「誰擁有這筆寫入」。
**結構改動。** 新增一份**安裝帳本**（`~/.redlog/installs.json`，0600，原子寫入），每一筆記錄寫入的類型（rc 行、settings 項目、複製的檔案、CA、profile 快照）、精確的位元組或路徑、來源（plugin id、hash）、時間。安裝寫帳本，移除讀帳本，**不讀 manifest**。claude-settings 一律指向 pin 住的複本（`~/.redlog/hooks/<plugin>/<hash>/…`）。撤銷、停用、hash 變更時：先把屬於該外掛的寫入收回（或在來源狀態列標為「失敗：有殘留」，附移除動作）。第三方外掛的 install method 依 Q1 的決定：建議只允許 `manual`，這樣整條死路連同它的核准分支一起刪掉。
**驗證。** 安裝 → 停用／撤銷／改 hookFile／刪資料夾 → 斷言 rc 與 settings 恢復到位元組相同；帳本為空；Windows 的 PowerShell profile 也跑一次。

### F4　bundled「外掛」多半是核心功能加上 manifest，變成機器層的隱藏開關，而且可以被同 id 無聲取代

**機制。** 為了實現「core 小」，核心功能被包成 manifest。包起來之後，它們就繼承了外掛的機器層開關與 id 覆蓋規則，但 UI 又因為「它們不是選擇」而把它們藏起來（`PluginsPanel.tsx:36-60` 的 `OWNED_ELSEWHERE`，註解直接寫「They ship with RedLog, so they are not plugins」）。
**實例。**
- `starter-pack`：被 loader 列出，`contributes` 卻是空的；真正的內容在 `builtinProducers`，由 hooks-manager 按路徑讀，壞掉時退回程式內的副本，兩邊靠 parity 測試保持同步（`hooks-manager.ts:168-176`）。停用它會移除內建 shell producer（`:359-366`）。
- `pack-host-monitors`／`pack-windows-output`：manifest 是空的，唯一的作用是「存在且 active」（`capture-packs.ts:36-39`）。結果同一件事有兩個開關，一個是專案層 `packs.<id>`，一個是機器層 `state.json`；設定頁還為此加了「修復」鈕，從擷取控制頁直接改外掛狀態（`CapturePackGroup.tsx:112`）。
- **id 覆蓋**：`loader.ts:102-104` 讓使用者外掛勝過 bundled。在 `~/.redlog/plugins/builtin-tools/plugin.json` 放一份 `contributes:{}` 的 manifest，就會讓 32 條內建 tool→target 規則消失，而且這是 declarative → `active`，不需核准；`builtin-tools` 又在 `OWNED_ELSEWHERE` 裡，只有停用時才顯示，所以這種取代在 UI 上看不到。目標抽取與它支撐的 scope 監控就這樣變暗。用 `pack-*` 的 id 覆蓋會讓 pack 變成不可用（`isPackAvailable` 要求 `source==='bundled'`）。沒有測試涵蓋這件事。（從程式碼讀出來的；沒有實際執行，見「未確認」）
- 官方 AI 套件在 generic 系統裡也是一個空殼 pack（§1.1）。
**結構改動。** 見 §3e：starter-pack 與 pack-* 不再是外掛（成為 core 的 source descriptor）；builtin-tools 保留為資料包（E1 的理由成立，也符合「不預設工具」），但 **bundled id 保留**，使用者外掛用到這些 id 時一律報錯。

### F5　Producer 沒有身分，liveness 寫進證據鏈，而 tier 由 agent_type 決定，結果同一類證據落在兩個 tier

**機制。** 外掛的 `capture[].emits` 只拿來做健康探針，沒有被當成寫入權限。API 只有一個 token，所以「誰寫的」由資料自己說。
**實例。**
- 停用一個外部 producer 不會停止接收它的事件；UI 還特地為此做了「已停用但仍在送」的狀態（`ExternalCaptureGroup.tsx:100-104`）。這表示停用只是顯示上的狀態。
- heartbeat 是 `system.producer_heartbeat`（`pcap-capture.js:53-58,171-172`），而 `system:producer_heartbeat` 不在 `LOGGED_TIER`（`event-write.ts:45-80`），所以它是 **chained**：一個 producer 每天約 5,760 筆。`producer` 欄位是自己宣稱的（`external-event-policy.ts:28-36`）。
- 同一類網路證據：`hooks/pcap-agent.py:137` 送 `pcap:*`（logged tier），bundled 外掛 `pcap-capture` 送 `scanner:packet_flow`（**chained**，因為不在表上）。DESIGN-plugin-kernel §2 寫的「一個外掛不該能把一萬筆 HTTP 塞上鏈」，在這裡正好被 packet_flow 違反。這也是「把 capture source 當成 activity type」的典型：tier 是由 agent_type 決定，而 agent_type 是 producer 自己挑的。
- `PROXY_MODE_PRODUCERS` 與 `checkAvailable` 都寫死了 producer id（`capture-health.ts:731`、`hooks-manager.ts:602-608`）。
**結構改動（外掛系統需要 API 拆分 spec 提供的東西）。** 見 §3b-4。

### F6　Processor 在寫入路徑上同步執行：上限是每個規則集每趟，不是每個事件；上鏈的推導結果沒有記錄規則版本

**機制。** 使用者 regex 的隔離是「worker + 同步等待」（Spec 033 刻意如此），上限的單位是一趟 worker 呼叫。
**實例。**
- `runBoundedRules`（`bounded-regex.ts:125-140`）每停掉一條規則，就重跑其餘規則一趟。k 條病態規則 → 同一個事件最多阻塞 main k × 250 ms，然後才全部停掉。loot、redaction、commandTags、targetExtractors 各有各的規則集，各跑各的趟。
- `extractTargetWithProvenance` 每個指令先跑一趟 `cmd`，再對每條 cmd 命中的規則各跑一趟 `extract`（`target-extractor.ts:227-246`）。而它的輸入也包括網站自己決定的頁面網址（`plugin-development.md:149-151`）。
- 第一次啟動 worker 時最多等 5 s（`bounded-regex.ts:95`）。
- 「停掉的規則」只存在記憶體，重新載入就恢復；狀態不會出現在來源狀態裡。
- 上鏈的推導（loot 事件、`data.redactions`、MITRE stamp、`detectedTarget`）只帶 `pattern_name`／`extractor_name`，不帶規則集的 hash 或版本。外掛更新後，無法分辨某筆推導是哪一版規則算出來的。
**結構改動。** 見 §3a「Processor」。

### F7　外掛提供的文字直接變成操作指示，包括 root 權限的指令

**機制。** manifest 的 prose（description、manualSteps 的 label 與 command）直接以 RedLog 的口吻顯示，沒有經過核准，也不標示來源；程式邏輯還反過來從 prose 裡撈資料。
**實例。**
- `manual` capture 不需核准（`manifest.ts:40-42`），但 `ExternalCaptureGroup` 會列出每個帶點的 id，也就包括使用者外掛（`:31,40`），並把它的 `manualSteps` 當成設定步驟顯示（`:138`）。所以一個被丟進資料夾的外掛，就能讓 RedLog 的擷取控制頁顯示一行 `sudo "<它的檔案>"`。
- `sudo "{hookFile}"` 執行的是**操作者可寫**的檔案：使用者外掛在 `~/.redlog/plugins`；bundled 的那一份，本機實際安裝的 `/Applications/RedLog.app/Contents/Resources/plugins/pcap-capture/hooks/pcap-capture.sh` 擁有者是操作者、權限 755（已用 `ls -l` 看過）。任何以操作者身分執行的程式都能改它，等操作者下次照步驟執行時取得 root。這跨出了 05 的「同 UID」模型。另外，hash 本來就沒涵蓋它呼叫的 `pcap-capture.js` 等檔案（§1.5）。
- 依賴名稱是用 `hook.description.match(/tcpdump|tshark|mitmdump|node/)` 撈出來的（`ExternalCaptureGroup.tsx:108`）：工具名稱寫死在 UI，資料來源是作者寫的 prose。
- bundled manifest 的 description 裡有 spec 編號、文件路徑，全是英文；外掛頁只好另外維護翻譯過的描述（`PluginsPanel.tsx:73-80`）。
**結構改動。** prerequisite 改成結構化資料（§3a）；顯示給操作者的只有 label（短）與結構化的需求。需要提權的步驟必須在**同一次 sudo** 裡，先複製到 root 擁有的位置、驗證 manifest 檔案清單裡的 sha256，再從那裡執行。第三方外掛的步驟在核准之前不顯示，核准後顯示時標出來源外掛。

### F8　文件、spec 與程式不一致（plugin-development.md 的錯誤清單）

| 位置 | 文件說 | 程式實際 |
|---|---|---|
| `:3-5` | 外掛可提供「agent-operable tools」 | 沒有這種 contribution（`mcpTools` 已在 `2d4f06a0` 退役） |
| `:51-55` | layout 有 `code/tools.js` 🔴 模組 | 唯一的程式碼鍵是 `tailers`，而且使用者的一律拒絕 |
| `:84-86` | 比 host 新的 API「rejected rather than half-loaded」 | 新一版的會以 declarative 方式讀進來（`apiAhead`，`manifest.ts:201-208`、`loader.ts:73-77`） |
| `:275-281`、`:367-368` | capture 出現在「Settings ▸ Hooks」，可以一鍵安裝 | HooksPanel 只列內建（`HooksPanel.tsx:95`）；第三方 capture 沒有安裝鈕（F3） |
| `:364-365` | 可以放在「your project's `.redlog/plugins/`」 | loader 只看 bundled 與 `~/.redlog/plugins`（`loader.ts:22-24`） |
| `:391-392` | bundled tailer 經 trust gate | 沒有 bundled tailer；官方 AI 不經 trust store |
| `:416-420` | 會進入「CODE CHANGED」狀態；撤銷時「isolated process is killed」 | `hash-changed` 從不產生；沒有任何 isolated process |
| `:442` | `examples/plugins/geoip-tool` | 不存在（只有 `codex-hook`、`recon-pack`） |
| `:460-462` vs `:394` | exporters／monitors「reserved」vs「refused」 | refused |
| `:475` | 🔴 是「isolated, capability-scoped」 | 文件自己在 `:386-388` 說不是 |
| `:117-121` | 被停掉的規則在「Settings ▸ Capture ▸ Loot detection」標示 | 未核對頁面位置（UNCONFIRMED） |
| `:290-291` | 經 API「cannot change existing events」 | 正確；但它可以用任何允許的 type 寫入，包括 `shell`（F5），文件沒有提 |

DESIGN-plugin-kernel：§1 的 starter pack 包含「代理逐字稿 tailer」（已拆成官方可選套件）；§3 的 `/api/ingest` 與 mapper 沒有建；§5 第 5 步「擷取健康度改讀 manifest」只有部分完成。`types.ts:4-28` 與 `:190-192` 的註解，也有一部分與程式不符（F1）。

---

## 3. 目標設計

### 3a. 契約：一份 manifest v2

**原則：** 外掛只有兩種會被建的種類，**Source** 與 **Processor**。兩者都是 core 解讀的資料，或行程外程式；**第三方程式碼永遠不進 RedLog 的行程**。Exporter 不建（理由見下）。一個資料夾只有一個種類；需要多個種類就做成多個外掛。`pack` 不再是一種種類。

```jsonc
{
  "manifestVersion": 2,                       // 這份 schema 的版本；loader 讀 1 與 2
  "id": "pcap-capture", "version": "1.1.0",
  "engines": { "pluginApi": 2 },              // 取代 redlogApi；可再加 "redlog": ">=0.18"
  "kind": "source",                           // "source" | "processor"
  "label": "Packet capture",                  // 唯一會顯示的作者文字：短、單行
  "files": { "hooks/pcap-capture.sh": "sha256:…", "pcap-capture.js": "sha256:…", … },  // 完整清單；未列出的檔案 = 錯誤
  "source": {
    "producer": "pcap-capture",               // 由伺服端蓋章的名字 = 憑證範圍
    "emits": [ { "agentType": "scanner", "subtype": "packet_flow", "volume": "high" } ],
    "requires": [ { "binary": ["tcpdump"] }, { "privilege": "root" }, { "platform": ["darwin","linux"] } ],
    "start": { "by": "operator", "steps": [ { "label": "…", "run": "hooks/pcap-capture.sh", "args": ["<iface>"], "elevated": true } ] },
    "stop":  { "steps": [ … ] },              // transparent-proxy 的 teardown 在這裡
    "liveness": "heartbeat"                   // "heartbeat" | "events" | "none"
  },
  "processor": {                              // kind=processor 時才有
    "lootPatterns": [], "redaction": { "denylist": [] }, "targetExtractors": [], "commandTags": [],
    "terminalProfiles": []                    // 唯一需要核准的 processor 內容
  }
}
```

- **刪除**：`kind:pack|mapper|enrichment|exporter`、`capabilities`、`signature`／`publisher`（Q5）、頂層 `emits`／`health`／`schemaVersion`、`contributes.tailers`（使用者外掛本來就拒絕；保留在 RETIRED 清單，給出明確錯誤）、`eventTypes` 的 `color`／`icon`／`lane`（不做 UI 外掛；subtype 的標籤併入 `emits[].label`，lane 由 core 依 agentType 決定）、`description`（不再顯示；作者說明放 README）。
- **`requires` 結構化**：binary（any-of／all-of）、privilege、platform、file。由 core 檢查，輸出到 04 的 descriptor；UI 不再解析任何 prose。
- **Source 欄位剛好就是 04 的 `SourceDescriptor` 需要的**：`requires` → 前置條件事實；`start.by` → `startedBy`；`liveness` → 存活訊號；`emits` → `lastStoredAt` 探針與憑證範圍；設定動作的擁有者固定為「擷取控制 ▸ 該來源列」（由 kind 決定，不讓外掛宣告）。
- **tier 不給外掛選**（沿用設計文件），但 `volume:"high"` 是一個提示：core 對外掛宣告的 subtype，若不在 core 的表上，預設寫入 logged tier（Q3）。
- **Processor**：只有資料。執行規則：
  - 會上鏈的推導（lootPatterns → loot 事件與 denylist；redaction → `data.redactions` 的 span；commandTags → shell 事件的欄位；targetExtractors → `detectedTarget`、`extractor_name`）：必須**有決定性、有界、可取消**，而且每筆推導都要帶 `processor: { plugin, version, contentHash }`，讓 07 F4 與設計文件 §4-2「可重推」有依據。
  - 不上鏈的推導（顯示用標籤）：不在寫入路徑上。
  - 時間預算的單位改成「**每個事件的總預算**」（所有使用者規則加總，例如 250 ms）。超過預算時，該事件的使用者推導標成 `partial`（寫進 `processor` 欄位），並停掉造成超時的規則；不再「停一條、再跑一趟」。執行位置跟著 02 報告的推導 worker 走（main 只做閘門與排序）；在那之前，至少把迴圈改成共用同一個 deadline。
  - 規則被停掉時，要出現在來源狀態與外掛詳情裡，並保留到下次核准為止（不是只在記憶體裡）。
  - 載入時先做靜態檢查（拒絕巢狀量詞、backreference 等已知的非線性形狀），讓大多數病態規則在載入時就被擋下，而不是等執行時超時。這只是補強，worker 預算仍然是最終的保證。
- **Exporter：不建。** 產品不做報告產生；HAR／JSON／NDJSON／bundle 都在 core，並已走 snapshot／seal（bundle v4）。若將來真的需要第三方格式，契約是「**一個讀 sealed bundle 或 NDJSON 匯出檔的外部程式**」，而不是外掛：它天生就只能經過 seal 路徑讀資料，不需要 RedLog 提供任何 host。把 `exporter` 從型別刪掉（07 F6）。

### 3b. 信任與隔離

1. **每種東西在哪裡執行**

| 東西 | 執行位置 | 能做什麼 |
|---|---|---|
| Processor 資料 | core 解讀（使用者規則在 worker，有每事件預算） | 只能加遮蔽、加推導；不能刪、不能放行 |
| Source（第三方） | 行程外，以使用者身分執行，由操作者啟動 | 經 RedLog：只能 append 到自己宣告的 `emits`，伺服端蓋上 `producer` |
| 官方 AI adapter | app 程式碼，從 app 本體載入（F2）；之後可以搬到推導 worker 解析 | 視同 core |
| 第三方 in-process 程式碼 | **不存在** | — |

   不建 utilityProcess host 的理由：Spec 027 已移除；它擋不住同 UID 的檔案存取（行程外的 Source 本來就以使用者身分執行）；現在也沒有需要它的外掛。若將來 owner 決定要支援第三方 tailer，條件是：在沒有 Node 權限的 worker 裡跑純 `parseUnit(bytes) → envelope[]`，由 core 負責讀檔與寫入，而不是把 Node 的權限交出去。這件事本報告不建議現在做。

2. **核准涵蓋什麼。** 使用者外掛 = `sha256(正規化 manifest ‖ 依路徑排序的每個 files 項目)`。所有檔案都在 `files` 清單裡；hash 在核准當下 pin 住，**每次載入時重算**，並在每次「執行或安裝動作」之前再驗一次（elevated 步驟則在 root 擁有的複本上驗）。bundled 與官方：由 app 簽章涵蓋，不需要逐一核准；但 bundled id 保留（F4）。不做 publisher key（Q5）。

3. **同意畫面。** 由 main 用原生 `dialog.showMessageBox` 顯示（05 F5），內容由 main 從自己載入的 manifest 產生：外掛 id 與版本、hash 前 12 碼、會產生的 `emits`、會寫入哪些檔案（terminal profiles 的影響），以及需要的提權。IPC 改成 `plugins:grant(id, expectedHash)`：main 在顯示前與確認後各驗一次，兩次 hash 都必須等於 `expectedHash`。renderer 只負責發起請求。

4. **外掛系統需要 API 權限拆分 spec 提供的東西**（不重新設計，只列需求）：
   - 每個 Source（plugin id × source producer）各一個 **append-only 憑證**，範圍 = manifest 的 `emits`（agentType × subtype）。用這個憑證不能讀、不能匯出、不能改錄製狀態、不能寫 `system` 或其他 producer 的 subtype。
   - 伺服端蓋章：`producer`、`producer_version`、`manifest_hash`，**不接受**呼叫端自己帶。
   - 停用、撤銷、hash 變更、移除時**撤銷憑證**，這樣「停用」才是真的停止（F5 的「已停用但仍在送」會變成「被拒絕」，並記成來源狀態「已關閉」，附上被拒的次數）。
   - 憑證的交付方式要適用於提權執行與非 Node 的 producer（例如 070 US6 的 Burp extension，Java）。具體做法：`~/.redlog/producers/<id>.cred`（0600），提權步驟以 `SUDO_USER` 的 home 解析（沿用 `redlog-dir.js` 的作法）；或者由 RedLog 產生一行帶憑證的啟動指令，讓操作者複製。
   - liveness 走**不上鏈**的通道（例如 `POST /api/producer/heartbeat`，更新記憶體或 logged-tier 的狀態），不再是 chained 事件。
   - 07 F3 的交接目錄契約（handoff dir）要把 producer 憑證檔納進去。

5. **被入侵的外掛能做與不能做的事。**
   - Processor：可以多遮蔽（造成資料遺失的感覺，但原文在 sidecar／原始輸入仍然存在）、可以產生錯誤的推導（推導都有標記與 provenance）；不能刪事件、不能放行機密、不能拖住 main 超過每事件預算。
   - Source：可以在自己的 `emits` 範圍內寫入假事件（伺服端蓋章會標出是它寫的）；**不能**冒充 shell 或其他 producer、不能停錄、不能讀資料。但它以使用者身分執行，所以可以讀 `~/.redlog` 底下的任何檔案（包括其他憑證、簽章私鑰、DB）。這是 05 的同 UID 模型，憑證拆分不會改變它；文件要把這一點寫明，不要讓人以為有更強的保證。
   - 提權步驟：在新設計下，執行的只能是驗證過 hash 的 root 擁有複本（F7）。

6. **更新。** 使用者外掛的 hash 變了 → 狀態變成「未設定：需重新核准」（04 的 `unset`，附一個動作），憑證撤銷。這會停錄，但會**明說**，不是無聲的。官方 adapter 跟著 app 一起更新；只要同意收據記錄的讀取範圍沒變，同意就延續，**不停錄**（F2）。bundled 外掛跟 app 一起更新，不需要核准。

### 3c. 生命週期與擁有權：一台狀態機，每個動作只有一個家

```
機器範圍（Settings ▸ 外掛，只列使用者外掛與官方 AI 的同意）
  discovered ──驗證失敗──► invalid
  discovered ──不需核准(只有 manual source / 無 profiles 的 processor)──► trusted
  discovered ──需核准──► awaiting-approval ──原生對話框確認──► trusted(pinned hash)
  trusted ──hash 不符──► awaiting-approval      trusted ──操作者停用──► disabled
  任何狀態 ──移除──► removed（依安裝帳本收回；列出收不回的項目）

專案範圍（Settings ▸ 擷取控制 ▸ 來源列；只有 Source 有）
  not-enabled ──在此專案記錄──► enabled ──► 執行期事實 ──► 04 的 8 個狀態字
```

- 對應到 04 的 8 個狀態字（只有 Source 會出現）：invalid → **失敗**；awaiting-approval → **未設定**（動作：核准）；disabled → **已關閉**；`requires` 不滿足或平台不符 → **無法使用**；trusted 但 not-enabled → **未設定**（動作：在此專案記錄）；enabled 但沒有 heartbeat、沒有事件，且 `start.by=operator` → **未啟動**（動作：顯示步驟）；有 heartbeat 但沒有事件 → **待命**；有事件 → **記錄中**；狀態讀取失敗 → **無法確認**。Processor 沒有來源狀態，它的問題（被拒、被停）只出現在外掛詳情裡。
- **每個動作的家：** 核准、停用、移除、診斷、樣本測試 → 外掛頁；在此專案記錄、執行步驟、驗證、看狀態 → 擷取控制的來源列；儀表板與狀態列只顯示狀態並**連過去**。刪除：`CapturePackGroup` 的「修復」（`:112`，pack 不再是外掛之後自然消失）、`mutateOfficialAgent` 順手重新啟用（`ipc/plugins.ts:70-76`）、AgentsPanel 的「到外掛頁安裝」來回跳轉（官方 AI 的同意改在來源列的「在此專案記錄」第一次觸發時，由原生對話框完成；外掛頁只保留撤回）。
- **範圍明說：** 外掛頁的每個動作都是機器範圍，對話框裡要寫「影響所有專案」；來源列的每個動作都是專案範圍。trust grant 不再記錄專案的 operator id。
- **移除不留殘留：** 依安裝帳本（F3）收回 hook、rc 行、settings 項目、profile 快照、憑證；transparent-proxy 這類有系統副作用的來源，若帳本記錄它「已啟動」但沒有記錄「已停止」，就在來源列顯示「失敗：有殘留」並給出 `stop` 步驟。移除的結果要列出「已收回 N 項；這些 M 項無法收回：…」。

### 3d. 開發者體驗

- `npx redlog-plugin init --kind source|processor`（或 `redlog-cli plugin init`）：產生 manifest v2、`files` 清單產生器、範例 producer（用 07 F3 的 `redlog_client.py`，或一支 Node client）。
- `redlog-cli plugin check <dir>`：用同一份 JSON Schema 驗證，錯誤訊息要指出 JSON pointer、期望值與附近的欄位；重算 `files` 的 hash；跑規則的線性檢查。
- 本機測試工具：mock core（只開 `/api/events` 與 heartbeat 的小伺服器，套用和 core 相同的 `emits` 範圍與蓋章規則），加上 07 F3 交接契約的 conformance 向量（沒有專案、401、spool 等）；processor 則有 `testSample` 的 CLI 版本（`core/plugins/test-sample.ts` 已經是純函式）。
- 版本相容：`engines.pluginApi`，core 讀 N 與 N-1；declarative 外掛的 N+1「只讀已知部分」保留（`apiAhead` 是好設計）。
- 文件：`plugin-development.md` 從 schema 產生欄位參考；手寫的部分只留概念。F8 那張表上的每一項都要修正，或在改寫時刪掉。

### 3e. 什麼該停止當外掛、什麼該變成外掛

| 項目 | 現在 | 目標 | 理由 |
|---|---|---|---|
| `starter-pack` | 空 contributes + `builtinProducers` + 程式內 fallback + parity 測試 | **刪 manifest**；內建 producer 成為 04 的 core descriptor（只寫在一個地方） | 本質是核心（操作者自己的 shell、RedLog 自己的 proxy）；停用它會讓擷取變暗，而 UI 也從來沒有提供這個選擇 |
| `pack-host-monitors`、`pack-windows-output` | 空 manifest 當機器層開關 | **刪 manifest**；`CAPTURE_PACKS` 本身就是 core descriptor；只保留專案層的 `packs.<id>` | `capture-packs.ts:7-9` 已經說明程式碼留在 core；兩個開關會互相矛盾（Q4） |
| `builtin-tools` | bundled 資料包 | **保留為 bundled Processor**，id 保留不可覆蓋 | E1 的理由成立；工具知識是資料，而且不預設操作者用哪些工具 |
| `pcap-capture`、`transparent-proxy`、`c2-tailers` | bundled、manual 的 capture | **保留，它們是 Source 外掛的範本**；改用 v2 的 `files`、`requires`、`stop`、`elevated` | 行程外、需要提權、可有可無，正是外掛該有的形狀 |
| 官方 AI adapter | 複製進 `~/.redlog` 才執行 | **app 程式碼 + 機器層同意收據 + 專案啟用**；在 UI 上是一個 Source 列 | F2 |
| `hooks/pcap-agent.py`（`pcap:*`） | 與 pcap-capture 並存的第二種形狀 | 選一種形狀；另一個改成發同樣的 subtype（或標明它是 VPS 專用） | 同一類證據兩種 tier（F5）；這屬於 07 F3 的交接整併 |

**不值得做的**（遵守 07 的警告）：把 shell hook、managed proxy、screenshot、host monitors 改成外掛；建 mapper 管線或 `/api/ingest`；建第三方程式碼的 host；做 exporter 外掛；做 publisher 簽章或 registry。**core 裡沒有東西現在該變成外掛**：工具知識已經移出去了（E1）；剩下寫死工具名稱的地方（`ExternalCaptureGroup.tsx:108` 的 regex、`checkAvailable` 的 id 分支、`PROXY_MODE_PRODUCERS`）該改成 descriptor 資料，不是改成外掛。

---

## 4. 遷移（每一步都讓 main 可以出貨）

| 步 | 內容 | 對既有安裝與專案的相容 | gate |
|---|---|---|---|
| M0 | 加 gate、刪掉沒有行為的宣告：`kind` 的 mapper／exporter、`capabilities` 的 UI（欄位仍接受但忽略，並出警告）、`hash-changed`（改成真的產生它：trust 有 grant 但 hash 不符時回 `hash-changed`；或者刪掉它）、`signature/publisher` 的文件；修正 F8 的文件 | 不影響行為 | G1 schema 測試以「現況」為準先綠燈 |
| M1 | 安裝帳本 + 能卸載退役的 manifest + claude-settings 指向 pin 住的複本 + 撤銷時收回 | 第一次啟動時掃描 rc、settings、profile，把認得的 RedLog 寫入**補登**到帳本（沿用 `hookSpellings` 的比對）；認不得的不動 | G4 移除無殘留 |
| M2 | 官方 adapter 從 app 本體載入；收據改為同意（F2） | `installationId` 延續，專案設定不失效；舊資料夾保留不刪 | 單元測試 + 實機 |
| M3 | 提權步驟改成 root 擁有的複本 + hash 驗證；未核准的使用者外掛不顯示步驟；`requires` 結構化，刪掉 description 的 regex | bundled 三個外掛同一個版本內改好 | G2 邊界測試的一部分 |
| M4 | manifest v2 + JSON Schema；loader 讀 v1（轉譯成 v2 的內部形狀）與 v2；bundled 改成 v2；刪 starter-pack／pack-* manifest，`state.json` 裡相關的停用旗標轉成一次性通知（Q4） | 使用者外掛的 v1 繼續可用；v1 的 hash 演算法保留，直到該外掛改寫成 v2，所以既有的 grant 不會失效 | G1 改成以 v2 schema 為準 |
| M5 | Source descriptor 接上 04 的 `source-status.ts`；來源列成為唯一的專案動作；原生同意對話框 | 純 UI 與 IPC 改動 | 04 的 owner 檔案 boundary 測試 |
| M6 | 等 API 拆分 spec 落地：每個 Source 一個憑證、伺服端蓋章、off-chain heartbeat、停用 = 撤銷 | N-1 相容：舊的 producer 仍可用全域 token，但事件會被蓋上 `producer: unknown`，並在來源狀態列提示「需更新」；一個版本之後拒絕 | 憑證範圍測試 |
| M7 | Processor 每事件預算 + provenance + 跟著 02 移到推導 worker | 新事件多一個欄位；舊事件不回填 | G3 |

**Gates：**
- **G1 manifest schema**：`plugins/plugin.schema.json` 是唯一的定義。測試驗證所有 `plugins/*`、`optional-plugins/*`、`examples/plugins/*`；loader 的驗證由同一份 schema 產生；每個 schema 欄位都要在一張表裡登記它的消費者（檔案:符號），沒有消費者就 fail，用來擋下 F1 的「宣告了卻沒行為」。
- **G2 邊界**：`src/**` 不得 `require`／`import` 任何 `plugins/**`、`~/.redlog/**` 的路徑；動態 `require(` 有 allowlist（只有官方 adapter 的 loader，而且路徑必須在 `process.resourcesPath` 底下）；`plugins/**` 的 JS 不得 import `src/**`；processor registry 只接受資料（型別上不能是函式）。另外有一個測試確認 elevated 步驟一定經過「複製 → 驗證 → 執行」的包裝。
- **G3 ingest 時間預算**：註冊 k 條病態使用者規則，對一個事件做 ingest，斷言 main 被阻塞的總時間 ≤ 每事件預算（加上一點餘裕），**不隨 k 成長**；還要斷言所有寫入路徑上的 processor 都會在事件上留下 `processor` provenance。
- **G4 移除無殘留**：安裝 → {停用、撤銷、改 hash、刪資料夾、移除} → rc／settings／profile 的位元組與安裝前相同，帳本為空；或者移除結果列出收不回的項目，且來源列狀態為「失敗」。
- **G5 文件**：抽出 `plugin-development.md` 裡的 jsonc 區塊，用 G1 的 schema 驗證；文件提到的每個 `examples/` 路徑都必須存在。

---

## 5. 操作者看到的流程（文字，不附 mockup）

**一條流程，兩個家。** 來源（包括外掛帶來的來源）只在「設定 ▸ 擷取控制」以**一列**出現，狀態永遠是 8 個字之一，加上至多一個動作。外掛頁只回答「這台機器上裝了哪些不是 RedLog 自帶的東西、我同意了什麼」。

1. **發現**：使用者外掛放進 `~/.redlog/plugins` 之後，外掛頁出現一列；它帶來的來源也在擷取控制出現一列，狀態「未設定」，動作是「核准」（跳到外掛頁的那一列）。官方 AI 直接以來源列出現，狀態「未設定」，不需要先去外掛頁。
2. **核准**：原生對話框（§3b-3）。外掛頁這一列變成已核准。
3. **啟用（此專案）**：在來源列按一下；官方 AI 要求先選工作目錄（原生選擇器），第一次在這台機器上啟用時，原生同意對話框也一併出現。
4. **啟動**：`start.by=operator` 的來源，在列上展開步驟（只顯示 label 與指令，提權步驟註明需要 root），狀態是「未啟動」。
5. **驗證**：沒有獨立的動作。heartbeat 讓狀態變成「待命」，第一筆事件讓狀態變成「記錄中」，列上同時顯示最近儲存的時間（04）。
6. **移除**：外掛頁，機器範圍；結果列出收回了什麼、留下了什麼。

**今天該拿掉的 UI：** 外掛頁的 `OWNED_ELSEWHERE` 機制（bundled 不再是外掛列）；核准對話框的 capabilities 清單；AgentsPanel 的「到外掛頁安裝／更新」按鈕與 `update-available` 的整套字；ExternalCaptureGroup 依 description 推依賴的程式；`CapturePackGroup` 的外掛修復鈕；外掛頁的「開啟資料夾」只保留在使用者外掛出錯時；外掛詳情的五個維度卡片縮成「信任」與「生效」兩個，專案與健康改成連到來源列。

**點擊與頁面數（從程式數，起點都是主畫面）：**

| 目標 | 今天 | 目標 |
|---|---|---|
| Claude Code／Codex 在此專案被記錄 | 設定(1) → 擷取控制(1) → 該列「到外掛頁」(1) → 安裝(1) → 「開啟擷取來源」(1) → 選工作目錄(1) + 原生選擇器確認(≥1) → 勾「在此專案記錄」(1) = **≥8 次、2 個設定頁、1 個原生對話框** | 設定(1) → 擷取控制(1) → 「在此專案記錄」(1) → 選擇器(1) → 原生同意(1，每台機器只有第一次) = **5 次（之後的專案 4 次）、1 頁** |
| pcap（bundled、manual） | 設定(1) → 擷取控制(1) → 複製步驟(1) → 終端機 = **3 次 + 終端機** | 設定(1) → 擷取控制(1) → 在此專案記錄(1) → 複製步驟(1) → 終端機 = **4 次**（多一次，換來專案範圍的憑證與真正的停用）。如果 Q1 的決定讓 bundled source 預設對每個專案啟用，就是 3 次 |
| 使用者外掛的 shell-source capture | 核准之後**沒有任何安裝路徑**（F3），點擊數無法計算 | 依 Q1：改為 manual → 核准(外掛頁 2 次 + 原生 1 次) + 來源列 2 次 = **≈5 次** |

---

## 6. 前 5 個最高槓桿的改動（排序）

1. **官方 AI adapter 從 app 本體執行，「安裝」改成同意收據（F2）。** 一次刪掉 `update-available` 造成的全專案停錄、conflict／收據損毀、TOCTOU、067 的 US8/US9/D2/D3，以及 asar fuses 不能開的理由。影響範圍：`official-agents.ts`、`agent-tailer.ts`、`main/index.ts:552-560,1566`、`capture-health.ts:651-661`、外掛頁、AgentsPanel、詳情頁、Spec 066/067；磁碟上有 `~/.redlog/plugins/official-ai-*` 與專案的 `installationId`。驗證：manager 單元測試（收據轉換、id 延續）；在 mac 與 Windows 打包版上，換一版 adapter 之後確認持續錄製；`verify-fuses`。
2. **安裝帳本與真正可逆的移除，並收掉核准的死路（F3 + Q1）。** 影響範圍：`hooks-manager.ts`（install／uninstall／registry）、`ipc/plugins.ts`、`contributions.ts`、外掛頁；磁碟上有 rc、`~/.claude/settings.json`、`terminal-profiles.json`。驗證：G4；macOS、Linux 與 Windows（PowerShell profile）的實機安裝與移除。
3. **一份 manifest v2 + JSON Schema + 消費者登記 gate；starter-pack／pack-* 回到 core；bundled id 保留（F1、F4、F8）。** 影響範圍：`core/plugins/*`、`hooks-manager.ts` 的 registry 與 fallback、`capture-packs.ts`、8 份 bundled manifest、文件、`examples/`、`state.json` 的遷移。驗證：G1、G5；v1 使用者外掛的相容測試（grant 不失效）；`starter-pack.test.ts`、`capture-packs.test.ts` 的語意改寫。
4. **Producer 身分：每個 Source 一個 append-only 憑證，範圍取自 manifest `emits`；伺服端蓋章；heartbeat 不上鏈；停用 = 撤銷（F5）。** 依賴 owner 的 API 拆分 spec。影響範圍：`api-server.ts`、`external-event-policy.ts`、`capture-health.ts` 的 producer 列、`event-write.ts` 的 tier 預設、bundled producer 的 client、交接目錄（07 F3）。驗證：憑證範圍的表格測試（冒充 `shell`、冒充其他 producer、停用後送出）；pcap 在 sudo 下的實機測試；chain 筆數在跑 producer 一小時之後不隨 heartbeat 成長。
5. **提權步驟只執行驗證過的 root 擁有複本；外掛 prose 不再成為指示或邏輯（F7）。** 影響範圍：三個 bundled manual 外掛的步驟與腳本、`ExternalCaptureGroup.tsx`、`contributions.ts` 的 `fillHookPath`、v2 的 `requires`／`files`。驗證：在 mac 與 Linux 上，以非 root 使用者修改 hookFile 後，執行顯示的步驟必須失敗並說明原因；Windows 的 `-ExecutionPolicy Bypass` 步驟同樣處理。

（第 6 名是 F6 的每事件預算與 provenance。它很重要，但應該併進 02 報告的推導 worker 一起做，單獨做的槓桿較低。）

## 7. 需要 owner 決定的問題（建議在前）

1. **第三方外掛的 Source 只允許 `manual`（由操作者啟動），不再讓 RedLog 把第三方腳本裝進 shell rc 或 `~/.claude/settings.json`？** 建議：是。UI 從來沒有提供這條路（F3）；`claude-settings` 本身就預設了一種工具；把第三方腳本放進每個 shell 執行，是整個模型裡權限最大的動作。內建 hook 不受影響。
2. **官方 AI 整合取消「機器層安裝」這一步，改成第一次在某專案啟用時，用原生對話框取得機器層同意？** 建議：是（F2、§5）。外掛頁只保留「撤回同意」。
3. **外掛宣告、但不在 core 表上的事件 subtype，預設寫入哪一層？** 建議：logged；core 的表可以把特定 subtype 升為 chained；heartbeat 永遠不是事件。這會讓 `scanner.packet_flow` 改到 logged（與 `pcap:*` 一致）。
4. **刪掉 bundled pack 與 starter-pack 的機器層停用（`state.json`）？** 建議：刪。pack 已經是專案層開關，內建 producer 是核心。既有的停用旗標轉成一次性通知，不轉成任何設定。
5. **永久移除 `signature`／`publisher`（不做簽章發佈），信任只看本機的 content hash？** 建議：是。marketplace 已經移除，產品是單人本機；保留這兩個欄位只會暗示一個不存在的保證。

---

## 已檢查、確認健全

- 驗證失敗以外掛為單位隔離：`loadOne` 的 try/catch（`loader.ts:50-56`）、`applyAll` 把丟例外的外掛標成 error，其他外掛照常套用（`index.ts:27-42`）、`initPlugins` 的 `finally` 一定會重寫 profile 快照（`:64-76`）。
- 官方套件目錄讀取的失敗隔離（067 US7，`official-agents.ts:63-95`）；收據的原子寫入與 0600（`:119-128`）；更新是 staging 加 swap 加回滾（`:174-199`）；不採用外來目錄、不覆寫被改過的檔案（`:139-144`）。這些在 F2 之後大部分會變得不需要，但目前的寫法是正確的。
- 資料夾內路徑安全：`isAbsolute` 加 `..`，Windows 形式也涵蓋（`manifest.ts:246-256`）；install 欄位是 enum 加固定形狀（`:49-70`）。
- 遮蔽只能加：拒絕 plugin allowlist（`manifest.ts:164-170`）。
- 特權程式碼不會在核准前執行（`contributions.ts:135-160`）；使用者 tailer 不論信任狀態都拒絕。
- 外掛狀態變更會寫進 chain 稽核（`ipc/plugins.ts:52-60,112-147`）。
- `apiAhead` 的「只讀已知的 declarative 部分、拒絕新版程式碼」是好的相容設計。
- `testSample` 是純函式，不寫入、不停用 live 規則（`test-sample.ts`）。
- 外掛 producer 不會讓 verdict 變差的不對稱保證（`capture-health.ts:757-781`，04 也確認過）。

## 刻意的設計（附依據）

- 可選 pack 的程式碼留在 core（Spec 027、`capture-packs.ts:7-9`）。本報告延續這一點，只是把 manifest 拿掉。
- bounded regex 讓呼叫端保持同步（Spec 033、`bounded-regex.ts:7`）。本報告不改這個契約，只把預算單位改成每個事件，並跟著 02 的推導 worker 一起搬。
- tier 不讓外掛選（DESIGN-plugin-kernel §2）。延續；Q3 只決定「不在表上」時的預設。
- 外掛頁不提供 marketplace、遠端 registry、本機匯入可執行 adapter（PLUGIN-MANAGEMENT-SPEC §5、067 D1）。延續。
- bundled 規則不經 worker（`command-tagger.ts:12-15`）：bundled 規則隨 app 一起測試（`builtin-tools-pack.test.ts`）。延續；前提是 bundled id 不可被覆蓋（F4）。

## 未確認（UNCONFIRMED）以及怎麼確認

- **U1 用 bundled id 覆蓋**：在 `~/.redlog/plugins/builtin-tools/plugin.json` 放一份 `{"id":"builtin-tools","name":"x","version":"1.0.0","redlogApi":1,"contributes":{}}` → 重新載入 → 在內建終端執行 `nmap 10.0.0.1`，確認事件沒有 `detectedTarget`，而且外掛頁沒有顯示這一列。（程式碼路徑：`loader.ts:102-104` → `contributions.ts:83-86` → `target-extractor.ts:249`。）
- **U2 孤兒 hook**：用一個 `claude-settings` capture 的使用者外掛，透過 devtools 呼叫 `hooks.install` → 改 hookFile → 確認 `~/.claude/settings.json` 仍指向原檔路徑，且 `hooks.uninstall` 回「Unknown plugin」。
- **U3 macOS App Management**：macOS 13 之後，其他 app 修改 `/Applications/RedLog.app`（ad-hoc 簽章）內的檔案時，會不會被 App Management 擋下？要用另一個以使用者身分執行的程序實際寫入一次才知道。檔案權限本身已確認是操作者擁有、755。Windows 的 NSIS 若是 per-user 安裝，路徑在 `%LOCALAPPDATA%`，也是使用者可寫的（待確認安裝模式）。
- **U4** `plugin-development.md:117-121` 所說的「被停掉的規則顯示在哪一頁」沒有核對。
- **U5** `verify:package-resources` 是否檢查 `optional-ai/*/adapter.cjs` 的存在與 sha256（M2 依賴這一點）。
- **U6** 多條病態規則對單一事件的實際阻塞時間（F6 的 k × 250 ms 是從程式碼推出來的）：在 `test/plugin-regex-time-bound.test.ts` 的形狀上加 k=4 量測即可確認；本次沒有執行，以免改動 repo。
