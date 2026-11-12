# Implementation Plan: 擴充功能模型與機器層級的擷取來源

**Branch**: `spec/076-extensions` | **Date**: 2026-11-13 | **Spec**: [spec.md](spec.md) | **Contract**: [contracts/extension-api-v1.md](contracts/extension-api-v1.md)

## Summary

今天「外掛」是三份 schema、五台狀態機、一個只雜湊入口檔的信任模型，第三方以外沒有任何主機；擷取來源的啟用散在專案設定（`packs.<id>`、`agentTailer.sources`）與機器狀態（`state.json`）兩處。本計畫做四件事，每件一個擁有者模組與 gate：

1. **一份擴充功能契約**：manifest v1 與主機 API v1 是規範性條文、有 golden、有穩定度分級（`core/extensions/`、`src/extension-api/`）。
2. **兩層清單**：基本功能留在核心，不動；只把搬了不影響基本功能的東西宣告成擴充功能，先「宣告不搬」，搬動只在耦合證據為零時做（FR-020–023）。
3. **機器層啟用、專案層綁定**：啟用一處（`machine.yaml`）；專案只存範圍、綁定、暫停；AI 工作階段的選擇是例外的逐專案綁定。
4. **終端機的動作契約**：`src/core/actions/` 一個函式一個型別化結果；`redlog` 是不需要 Node 的薄用戶端。

## Technical Context

**Language/Version**：TypeScript（core、main、extension API）；POSIX shell＋python3（hook 的 `redlog` 動詞）；PowerShell 5.1／7；JSON Schema 2020-12。
**Primary Dependencies**：Electron `utilityProcess`（新用到的 API，非新套件）；不新增執行期套件。Schema 驗證沿用 075 D7 的決定（手寫最小驗證器；`ajv` 只在 devDependencies 用於 golden 與 `extension check`，若 075 落地時已選定則沿用）。
**Storage**：`~/.redlog/machine.yaml` 的 `extensions.*`（073 擁有檔案）；`~/.redlog/plugins/trust.json`（沿用）；新檔 `~/.redlog/session-claims.json`、`~/.redlog/extension-state/<id>.json`、`~/.redlog/extension-secrets/<id>.bin`（`safeStorage` 密文；皆 0600、原子寫入）；擴充功能設定存在 073 的兩層檔案中（`extensions.<id>` 命名空間）。專案資料庫只多新種類的列，不加表。
**Testing**：Vitest（契約 golden、import 邊界、決策表、遷移 property）；主機的整合測試以真的 `utilityProcess` 在 CI 三平台 unit leg 執行（若 Vitest 環境無法起 Electron，改為 e2e 一支 spec，見 T040）；shell 動詞在 Linux 容器（無 Node）與 Windows PowerShell 執行。
**Target Platform**：macOS、Linux、Windows。
**Performance Goals**：沒有啟動事件成立時，擴充功能相關的行程與計時器為 0；主機啟動 < 1 s；`redlog status` 在 RedLog 回應時 < 300 ms。
**Constraints**：不新增頁面；不改事件的雜湊、簽章或鏈結；不改寫既有列；基本層不搬；fuse 不變；不引入 DI 容器或全域狀態庫；元件不在元件內宣告。

## Constitution Check

| 原則 | 本計畫 |
|---|---|
| I 證據完整 | 擴充功能只能 append；每次讀與送都上鏈（FR-060、062） |
| II 介面誠實 | 擴充功能碰不到真相介面（FR-061）；未知從不顯示為安全（075 FR-025） |
| III 單一語意 | 一份 manifest、一份動作契約、一份對齊列 |
| VI 明確失敗 | 不相容、崩潰、雜湊不符都有固定的狀態與理由，遺失計數 |
| VIII／IX | 每條規則一個 gate；契約變更有 golden |

## 現況（`origin/main@624b79c4`，開檔確認）

| 事實 | 位置 |
|---|---|
| 三份 manifest：generic `plugin.json`、hooks-manager 的 producer manifest、官方 AI 的 `redlogAgent` | `core/plugins/manifest.ts:149`（kinds 含 `producer`／`mapper`／`enrichment`／`exporter`／`pack`）、`core/hooks-manager.ts:196,263-297`、`core/plugins/official-agents.ts:75-83` |
| 雜湊只涵蓋入口 | `manifest.ts:128-137,308-323` |
| 信任紀錄 | `core/plugins/trust.ts:23-41`（`~/.redlog/plugins/trust.json`，寫入不指定 mode） |
| AI adapter 在 main `require` | `main/services/agent-tailer.ts:26-29` |
| 沒有 `utilityProcess` 且有測試擋 | `test/package-fuses.test.ts:43-59`；`electron-builder.yml` fuse 段註解 |
| `cli/` 未打包 | `electron-builder.yml:21-39`；`package.json:15` |
| shell 的 `redlog` 動詞 | `hooks/shell-zsh-hook.zsh:195-238`（status、stop、start、mode、class） |
| 受管代理 | `main/services/managed-http-proxy.ts:131-138,354`（spawn mitmdump，無 upstream） |
| 擷取瀏覽器 | `main/index.ts:1753-1764`、`main/services/cdp-connector.ts:3,176,381` |
| 內建終端機 | `main/terminal-manager.ts:1-20`（node-pty、`configureIngest`、`getDB`、`indexCast`、`configureBuiltinTerminalHealth`） |
| socket 歸屬在寫入路徑 | `core/ingest.ts` import `socket-attribution`；`process-monitor`、`connection-monitor` 也 import 它 |
| 出口位址只在記憶體 | `main/services/producers/ip-signal-producer.ts:143-155`；`core/db/event-write.ts:609,723` |
| `vps-deploy.sh` 不支援 | `hooks/vps-deploy.sh:22-27` |

## 設計決策

### D1 三種 runtime；`core` 只限允許清單

**決定**：`external`、`host`、`core`。`core` 的允許清單 `BUILTIN_CORE_RUNTIME` 在 `core/extensions/builtin.ts`，每項附理由與「何時可以搬出」的條件（FR-022）。
**被否決**：(a) 所有內建擴充功能都必須在主機中執行——會強迫搬動內建終端機與主機監看，兩者都碰寫入路徑（耦合證據）；這正是 07 報告警告的「為了搬而搬」。(b) 沒有 `core` runtime、把這些來源留在基本層——它們確實是選用的（E6），需要可停用、預設關、按需啟動；把它們放在基本層會失去這些。

### D2 每個擴充功能一個主機行程

**決定**：每個已啟動、`runtime: host` 的擴充功能一個 `utilityProcess`。
**被否決**：一個共用主機（編輯器的做法）。理由：(a) 擴充功能的數量在這個產品中很小（今天沒有任何一個；第一年估計 ≤ 5 個同時執行）；(b) 一個崩潰或無窮迴圈會拖垮其他擷取，違反「記錄失敗不得互相傳染」；(c) 停用＝殺行程，乾淨；(d) 每行程 heap 上限才有意義。代價：每個主機約 30–50 MiB（UNCONFIRMED，T040 量測）。

### D3 主機中的擴充功能經 HTTP 入口寫入

**決定**：與外部行程同一條 `POST /api/ingest`、同一組向量與一致性測試；憑證經 MessagePort 交給主機執行期，擴充功能程式碼拿不到。
**被否決**：MessagePort 直接進入行程內入口——會多一個 `door`、一套認證與一份向量；071 FR-093 的入口等價會多一條要證明的路徑。迴路 HTTP 的成本在擴充功能的事件量下可忽略。

### D4 憑證類別沿用 `plugin:<id>`

**決定**：安裝的與移到主機的內建擴充功能用 `plugin:<id>`；仍為 `core` 或 `external` 的內建擴充功能保留 071 FR-071 的既有類別。072 的 `ProducerClass` 值域不變。
**被否決**：新增 `extension:<id>` 類別——改 071、072 的值域與 tier 規則（`plugin:*` 未登記種類進 logged），沒有行為差異。

### D5 檔案位置不搬

**決定**：`hooks/`、`plugins/<id>/`、`optional-ai/`、`~/.redlog/plugins/<id>/` 原地；內建擴充功能的 manifest 放在各自資料夾（`plugins/pcap-capture/extension.json` 等），沒有資料夾的內建 `core` 擴充功能（受管代理、擷取瀏覽器、內建終端機、主機監看）的 manifest 放在 `src/core/extensions/builtin/<id>.json`，隨 `out/` 打包進 asar。
**被否決**：新的 `extensions/` 目錄——已安裝的 rc 行指向 hook 檔的路徑、`electron-builder.yml` 與 `verify-packaged-resources.mjs` 的清單都會變，換不到任何行為。

### D6 新的擴充功能 manifest 第 1 版取代 075 的 v2

**決定**：`extension.json`，`extensionManifest: 1`。075 的「v2」從未出貨，名字留給它會讓 `plugin.json` 的 `manifestVersion: 2` 與新格式混淆。v1 `plugin.json` 照讀（FR-006）。
**被否決**：沿用 `plugin.json` 加 `manifestVersion: 2`——同一個檔名兩種語意，`extension check` 要先猜格式。

### D7 版本協商：支援 N 與 N−1

**決定**：契約 §5。
**被否決**：只支援 N（每次主版本都會停掉全部擴充功能的擷取）；無限向後相容（每一個舊介面都成為永久承諾，與 §26.5 的「一個概念一份實作」衝突）。

### D8 `system:extensions_active`

**決定**：每個 session 開始與生效集合改變時一列上鏈紀錄。
**被否決**：只在擴充功能詳情顯示目前版本——行動中途 app 更新換掉解析器時，證據裡沒有痕跡（14 號審查「自動更新…無法追溯」）。

### D9 讀取稽核以每分鐘彙總列上鏈

**決定**：每擴充功能每分鐘至多一列 `system:extension_read`，含 id 清單雜湊；Exporter 每批一列並在交出前寫。
**被否決**：(a) 每次查詢一列——一個每秒查一次的工具一天寫 86,400 列，淹沒時間軸與鏈；(b) 只寫日誌不上鏈——違反 E10 (3)。

### D10 `redlog` 不依賴 Node

**決定**：動詞在 hook 中實作；POSIX 以 python3（`redlog-relay.py` 新增子命令）做 HTTP 與格式化，PowerShell 原生。
**被否決**：(a) 把 `cli/` 加進 `extraResources` 並要求操作者有 Node——操作者機器上不一定有 Node，而 python3 已經是 POSIX 擷取的前提（071 Assumptions）；(b) 以 app 二進位執行 CLI——需要 `runAsNode` fuse 開啟，`test/package-fuses.test.ts` 擋。

### D11 私人 shell 不留痕跡

**決定**：從未綁定者什麼都不送；已綁定者只送一列 `capture_stopped{reason:"private"}`。
**被否決**：逐指令計 `private` 遺失——計數本身洩漏私人 pane 的活動量與時間。代價：已綁定後轉為私人的那段，鏈上只看到「停止」，看不到量（與 `redlog stop` 相同，可接受）。

### D12 AI 工作階段的認領索引

**決定**：`~/.redlog/session-claims.json`：`{<agentKind>:<sessionKey> → {project, at, method}}`；第一次被某專案實際讀取時認領；「記錄到這個專案」改寫認領並寫兩邊的 `system:session_rebound`。
**被否決**：(a) 沒有索引，兩個專案選了重疊的工作路徑就各記一份——同一回合出現在兩個客戶的紀錄中；(b) 把選擇整個搬到機器層——違反 R1（選擇必須是逐專案的動作）。

### D13 L2：webview 模式、一個導覽項目、建議 experimental

**決定**：契約 §8；等級由擁有者一行決定（FR-096），建議 `experimental`；放置只有分隔線下的導覽項目（與內建終端機同規則）與指令；替代檢視 slot 維持 reserved。
**被否決**：(a) 只從指令開啟——擁有者指出它增加操作摩擦，也與「終端機啟用後出現在導覽」的既有決定不一致；(b) v1 就開放替代檢視 slot——要在核心頁上加切換控制，擴充功能像素與核心真相介面相鄰，先以導覽項目驗證限制；(c) `reserved` 到有人需要——擁有者已指出拓撲與矩陣是可信的需求，而它們需要的雙向連動 L0 做不到。

## 模組邊界

| 模組 | 擁有 | 公開介面（草圖） | 不得 import | 誰可以 import |
|---|---|---|---|---|
| `src/extension-api/`（新） | 契約的型別與主機執行期 | `v1.d.ts`（契約 §3）；`runtime/index.ts`：`bootHost(port: MessagePort)` | `src/core/**`、`src/main/**`、`electron` | 主機行程、`src/extensions/**`、`examples/extensions/**` |
| `src/core/extensions/`（新） | 擴充功能登記、manifest 解析與驗證、雜湊、協商、啟動判斷、讀取範圍、指令、內建清單 | `loadAll(): ExtensionRecord[]`；`parseManifest(raw): Result<Manifest, LoadError>`；`verify(rec): IntegrityResult`；`negotiate(range): ApiVersion \| LoadError`；`shouldRun(rec, facts): boolean`；`toDescriptor(rec): SourceDescriptor`（給 075）；`activeSet(): string[]` | `electron`、`src/main/**`、`src/renderer/**`、`src/extension-api/runtime/**` | `src/main/**`、`src/core/source-status/**`（075） |
| `src/main/extension-host/`（新） | `utilityProcess` 的建立、監督、退避、資源上限、憑證交付 | `startHost(rec): HostHandle`；`stopHost(id)`；`HostHandle.onExit` | `src/renderer/**` | `src/main/index.ts` 的資源清單（073 `ProjectResource` 或 app 層） |
| `src/core/actions/`（新） | 操作者動作與型別化結果 | `status(ctx)`、`pause`、`resume`、`mark(input)`、`last(q)`、`exportAligned(q)`、`doctor()`；皆回 `ActionResult<T>` | `electron`、`src/renderer/**` | IPC handler、API route、`/api/v1/*` |
| `src/core/bindings/`（新） | 工作階段認領索引 | `claim(kind, key, project)`、`rebind(...)`、`ownerOf(...)` | `electron` | `tailer-host`、`src/core/actions` |
| `src/extensions/<id>/`（新，主機程式碼） | 移到主機的內建擴充功能 | 只有 `activate`／`deactivate` | 除 `src/extension-api/**` 與 Node 內建外的任何東西 | 無（由主機載入） |
| `src/core/plugins/`（既有） | 縮小為 v1 `plugin.json` 的轉譯與 Processor 資料 | `translateV1(raw): Manifest` | — | `core/extensions` |

不變式：只有 `src/main/extension-host/launcher.ts` 可以出現 `utilityProcess`；只有 `core/extensions/integrity.ts` 讀擴充功能檔案的位元組；只有 `core/actions/` 被 API route 與 IPC handler 呼叫來做這八個動作。

## 它取代什麼（依序折入，數量只降）

| # | 今天 | 位置 | 取代為 | Phase |
|---|---|---|---|---|
| 1 | 三份 manifest 解析 | `manifest.ts`、`hooks-manager.ts:196-297`（`STARTER_PACK_FALLBACK`、`builtinProducers`）、`official-agents.ts:75-83` | `core/extensions/manifest.ts` 一份；v1 經 `translateV1` | 2→3 |
| 2 | 只雜湊入口的 `computeContentHash` | `manifest.ts:308-323` | `integrity.ts`（`files` 全部） | 2 |
| 3 | 機器層停用 `state.json` 與專案層 `packs.<id>`、`packMembers` | `core/plugins/state.ts`、`capture-packs.ts:36-39` | `machine.yaml` 的 `extensions.<id>.enabled` | 5 |
| 4 | AI adapter 的機器層「安裝」與收據 | `official-agents.ts:140-214`、`~/.redlog/plugins/.official-ai-installations.json` | 機器層啟用＋同意（073 修訂）；選擇仍在專案 | 5 |
| 5 | 寫死的來源 id 分支 | `capture-health.ts:338-340` `PROXY_MODE_PRODUCERS`；`hooks-manager.ts` `checkAvailable` | manifest 資料（075 FR-005） | 3 |
| 6 | 同一動作的多份實作（標記、匯出、狀態） | `api-server.ts:476-490,511-527,579-592,756-762`；`ipc/markers.ts:95-125`；`index.ts:447-468,1838` | `core/actions/` | 7 |
| 7 | `redlog-cli` 作為終端機入口 | `cli/redlog-cli.js:103-125` | hook 的 `redlog` 動詞 | 7 |
| 8 | `transparent-proxy` | `plugins/transparent-proxy/` | 刪除 | 3 |
| 9 | `vps-deploy.sh` | `hooks/vps-deploy.sh` | 071 的遠端 hook | 071 的修訂任務 |

計數 gate：`test/extensions/manifest-parsers.test.ts` 掃描 manifest 解析點（今天 3），只降到 1。

## 耦合證據（FR-020、FR-022）

| 擴充功能 | import 它的 | 它 import 的寫入原語 | 基本層讀它的狀態？ | 釘住它的測試 | 結論 |
|---|---|---|---|---|---|
| `pcap-capture`、`c2-tailers` | 無（行程外，`plugins/`） | 無（經 API） | 否 | `test/legacy-producer-decisions.test.ts`（071 T004） | Phase 3 宣告；不需搬 |
| `transparent-proxy` | 無 | 無 | 否 | — | 刪除 |
| 擷取瀏覽器 | `main/index.ts` 唯一 | `ingestEvent`（`cdp-connector.ts:3`） | 否 | `test/cdp-*`（T005 列出） | Phase 3 宣告；Phase 8 搬（需 071 契約 1） |
| 受管代理 | `main/index.ts`；`core/http-autostart.ts`（型別） | 無（addon 經 API） | `capture-health` 的 HTTP 事實（075 FR-030 改由描述資料） | `test/managed-http-proxy*.test.ts` | Phase 3 宣告；不搬（無收益） |
| 內建終端機 | `main/index.ts`、`main/ipc/terminal.ts` | `configureIngest`、`getDB`、`indexCast` | 是：32 處 `builtin-terminal` 字面值、`/api/terminal/replay` 的信任判斷 | `test/terminal-*`、Spec 055 的輪替測試 | Phase 3 宣告；不搬 |
| 主機監看 | `main/index.ts` | 行程內寫入 | 是：`socket-attribution`（`core/ingest.ts` import） | `test/socket-attribution*.test.ts` | Phase 3 宣告；不搬，直到 U4 |
| AI 工具擷取 | `main/index.ts`；`agent-tailer` ↔ `tailer-host` | 行程內入口、`deepRedactStrings`（`tailer-host.ts:567`） | 是（基本層） | Spec 050、058 相關測試 | 基本層，不搬 |

Phase 1 的 T005 以 import 圖掃描把這張表變成測試：每一列的「import 它的」與「它 import 的寫入原語」各是一個基準；任何抽出 PR 使它們變多即失敗。

## 允許清單（`BUILTIN_CORE_RUNTIME`）

| id | 理由 | 可搬出的條件 |
|---|---|---|
| `builtin-terminal` | node-pty 在 main；鍵盤延遲；寫入路徑耦合 | 071 FR-012 完成（字面值 0）、073 session 擁有 ingest 設定；且量測證明多一跳不影響輸入延遲 |
| `managed-http-proxy` | 監督者只管生命週期；無收益 | 有收益時（例如 upstream 模式需要長駐邏輯） |
| `capture-browser` | 行程內寫入 | 071 契約 1 → Phase 8 移除本項 |
| `host-monitors` | `socket-attribution` 耦合 | 13 號 U4 完成 |

允許清單只能變短（ratchet）。

## Gates

| 規則 | Gate | Phase |
|---|---|---|
| 基本路徑不變 | `test/extensions/basic-paths-pinned.test.ts`（T002–T004 的組合）；每個抽出 PR 前後同輸出 | 1 |
| 耦合不增加 | `test/extensions/coupling-baseline.test.ts`（T005） | 1 |
| manifest 每欄有讀者 | `test/extensions/manifest-consumers.test.ts` | 2 |
| 契約 golden | `test/extension-api/golden.test.ts` | 2 |
| 只用公開 API | `test/extensions/public-api-only.test.ts` | 2 |
| 雜湊涵蓋全部檔案 | `test/extensions/integrity.test.ts`（逐檔改位元組、多檔、少檔、TOCTOU） | 2 |
| `views` 依 `L2_CLASS` 拒絕或要求宣告；未宣告實驗介面拒絕 | `test/extensions/manifest-reserved.test.ts` | 2 |
| L2 的沙箱、CSP、資源 URI、無 bridge、核心導覽不可變、狀態字掃描、訊息型別 golden | 契約 §8.7 | 10 |
| 沒有市集 | `test/extensions/no-network-install.test.ts`：`core/extensions/**`、`main/extension-host/**` 不 import `http`、`https`、`net`、`electron.net`、`fetch` 呼叫 | 2 |
| 只能 append | 071 的路由能力表擴充到 `plugin:*`（T051） | 5 |
| 真相介面不可覆蓋 | `test/extensions/truth-surfaces.test.ts`：075 的狀態函式與 HUD、狀態列元件的輸入型別不含任何擴充功能提供的字串欄位；renderer 不 import 擴充功能資料以外的 label | 3 |
| 讀取稽核 | `test/extensions/read-audit.test.ts`：列數與 id 雜湊等於實際回傳 | 6 |
| `utilityProcess` 只在一檔 | 改寫 `test/package-fuses.test.ts` 為允許清單（T041） | 4 |
| 預設關閉與按需啟動 | `test/extensions/activation.test.ts`：沒有啟動事件時，行程與計時器登記為 0 | 3、4 |
| 允許清單只降 | `test/extensions/core-runtime-allowlist.test.ts` | 3 |
| 動作只有一份 | `test/actions/single-implementation.test.ts`：API route 與 IPC handler 不 import `db/events` 的寫入函式（13 號 A.4 的 gate） | 7 |
| 資料前向相容 | `test/extensions/removed-kinds-readable.test.ts` | 3 |

## 遷移與相容

- 第一次以新版啟動、在任何專案開啟前：(1) 讀每個專案的設定，依 FR-047 決定選用來源的機器層初值，寫遷移報告；(2) 官方 AI 收據 → 機器層啟用與同意（073 修訂）；(3) `state.json` 的停用旗標 → 機器層 `enabled: false`（使用者外掛）或一次性通知（bundled pack，075 FR-072）。不改任何專案檔。
- 舊版 app 開啟：`machine.yaml` 的 `extensions.*` 被忽略（073 FR-023 保留未知鍵）；舊版照它自己的專案設定運作。
- 已安裝的 v1 使用者外掛：照讀、核准延續，狀態列帶「舊格式」理由（FR-006）。

## 與兄弟規格的介面

| 規格 | 本規格需要 | 本規格提供 |
|---|---|---|
| 071 | 契約 1、`plugin:<id>` 憑證的發放與撤銷改為機器層（071 修訂 FR-072、FR-07A）；`/api/v1/*` 讀取路由的能力（`read` 限範圍）；FR-086、FR-087（第一次綁定提示、`private`）；FR-120–123（出口） | `plugin:*` 的種類範圍＝manifest `emits`；`system:extension_read`、`export_shipped`、`export_failed`、`extensions_active`、`session_rebound`、`extension_config_changed` 的寫入時機（行程內，`system`） |
| 072 | 上列六個新種類與 `system:egress_changed`（071 FR-123）的登記；FR-097 的四個通用閱讀器（指標已加在 072）；`ReaderId`、`KindFamily` 封閉清單；「已寫入種類的閱讀器與標題永不刪除」 | 擴充功能 `emits` 的宣告快照（契約 §5.6） |
| 073 | `machine.yaml` 的 `extensions.*` 鍵與寫入（FR-020–024）；安裝帳本記錄擴充功能的寫入與憑證檔；AI 同意改為機器層、選擇留在專案（073 修訂） | 機器層啟用的語意；認領索引 |
| 074 | 查詢契約（`parseQuery`、分頁、計數）與變更主題，作為 L0 讀取 API 的實作 | `/api/v1/*` 是 074 讀取服務的另一個傳輸，不另寫查詢 |
| 075 | 狀態函式與 payload；`enabledOnMachine`、`boundToProject` 事實（075 修訂）；FR-025 未知不顯示為安全 | `toDescriptor(rec)`：從擴充功能 manifest 產生 `SourceDescriptor`；載入錯誤 → 理由碼；manifest 欄位歸本規格（075 FR-050–063 已標為移交） |
| 後續「交付邊界與內容生命週期」規格 | 匯出套用遮蔽、標為私人 | Exporter `command`／`content` 與 L0 `read-command`／`read-content` 的開放條件 |

## 驗收（工作計畫的三條規則）

1. **擷取信任以真實來源端到端驗證**：(a) 真機上停用全部可停用擴充功能，zsh、bash、PowerShell 各打 10 條指令、Claude Code 跑一個回合、快捷鍵標記與截圖，全部寫入並驗證通過；(b) 啟用 pcap（Linux、macOS 真機，root）與 c2-tailers（測試 JSONL），事件帶 `plugin:` 或既有類別的 `_ingest.producer`；(c) 主機中的測試擴充功能被 `kill -9` 時，操作者沒有任何中斷，`capture_gap` 出現且帳平衡。
2. **讀契約的介面在契約落地時於真機檢查**：設定 ▸ 擴充功能區（機器層啟用、核准對話框、遷移報告）；設定 ▸ 擷取來源的列（狀態字與理由，含「使用已棄用的介面」「api-too-new」）；活動紀錄的「篩選」選單中擴充功能的種類組；首次使用清單中的 `setup` 步驟；指令面板中貢獻的指令；`redlog://event/<id>` 深連結；終端機中的 `redlog status`。
3. **「已決定／已實作／已驗證」分開**：`verification.md` 每一列分三欄記錄；本規格的決定（E1–E10、R1–R4）在 spec 中，實作與驗證只在 `verification.md` 標記。

需要特定環境的：T040（三平台正式版產物中的 `utilityProcess`）、T071（沒有 Node 的 Linux 容器、Windows PowerShell 5.1 與 7）、驗收 (b)（root、真機網路介面）。依記憶「不在本機跑 Electron e2e」，e2e 交給 CI。

## 風險

| 風險 | 緩解 |
|---|---|
| `utilityProcess` 在 `runAsNode` 關閉或 asar 下不可用 | T040 在 Phase 4 開頭驗證；不可行時停下回報（Q2） |
| 擴充功能概念讓「全部都要變外掛」的壓力回來 | FR-022 的四個條件與允許清單 ratchet；搬動需要量測收益 |
| 遷移把不該打開的來源打開 | 只打開「曾被使用」者；遷移報告列出每一項與依據 |
| Exporter 被當成可以送任何東西 | experimental＋遮蔽前提＋送前上鏈＋核准文字 |
| 讀取 API 讓 AI agent 把原文讀進雲端（11 號摘要 5） | `meta` 才是 stable；`command`／`content` 等遮蔽前提；071 O13 對 `agent-tools` 的限制不變 |

## Project Structure

```text
specs/076-extensions-and-machine-scoped-sources/
├── spec.md
├── plan.md
├── tasks.md
└── contracts/extension-api-v1.md     # 規範性；T020 搬到 docs/domain/

src/extension-api/{v1.d.ts,runtime/}   # 新
src/core/extensions/                    # 新：manifest、integrity、negotiate、activation、registry、builtin、read-scope、commands、exporter、settings
src/core/extensions/builtin/*.json      # 沒有資料夾的內建擴充功能 manifest
src/core/actions/                       # 新
src/core/bindings/                      # 新
src/main/extension-host/                # 新：launcher、supervisor
src/extensions/<id>/                    # 移到主機的內建擴充功能（Phase 8 起）
extensions/extension.schema.json        # 由契約產生、golden 釘住
examples/extensions/{source,processor,exporter}/
plugins/{pcap-capture,c2-tailers,builtin-tools}/extension.json
hooks/{shell-common.sh,shell-zsh-hook.zsh,shell-bash-hook.sh,shell-hook.ps1,redlog-relay.py}   # redlog 動詞
```

## Complexity Tracking

| 新增 | 為什麼需要 | 更簡單的替代為何不夠 |
|---|---|---|
| 擴充功能主機行程 | 擁有者決定（E1）；第三方程式碼與 Exporter 不得在 main 執行 | 只允許 `external`：Exporter 與 L0 工具仍可用，但「安裝一個擴充功能就能用」需要操作者自己起行程。若 Q2 答「不用 `utilityProcess`」，退回此做法 |
| 穩定度三級與協商 | R3 | 單一版本號：無法讓實驗介面在不破壞承諾下試用 |
| 認領索引 | R1 的「一次只屬於一個專案」 | 無索引：重疊工作路徑會把同一回合寫進兩個客戶的紀錄 |
