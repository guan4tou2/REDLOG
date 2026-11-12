# 擴充功能 API 第 1 版（規範性契約）

> **狀態**：Draft，Spec 076 的規範性部分。tasks T020 把本檔搬成 `docs/domain/SPEC-extension-api-v1.md`，並從 §2 產生 `extensions/extension.schema.json`（JSON Schema 2020-12）、從 §3–§4 產生 `src/extension-api/v1.d.ts`；一致性測試組（§10）讀這兩個產物。三者不一致時以本檔為準，直到搬遷完成；之後以 `docs/domain/` 的版本為準，本檔改為指標。
>
> 用詞：**必須／不得**是要求；**應**是建議。「核心」指 RedLog app 的 main 行程與 `src/core`。「主機」指擴充功能主機行程（Spec 076 FR-030）。「接收端」指 Spec 071 的寫入入口。

## 1. 範圍、版本與穩定度

### 1.1 本契約涵蓋

1. 擴充功能 manifest（`extension.json`）的每一個欄位（§2）。
2. `runtime: "host"` 的擴充功能可呼叫的每一個主機 API 與可收到的每一個事件（§3），以及錯誤清單與上限（§4）。
3. `runtime: "external"` 的擴充功能與核心之間的約定（§9）：它們使用 Spec 071 寫入契約 1 與本契約的讀取 API，本契約只補上憑證位置、存活與版本宣告。
4. 對齊列 v1（§7）與 L2 面板的保留形狀（§8）。

### 1.2 版本

- **API 版本** `1.0`。主版本改變＝§5.2 的破壞性變更；次版本改變＝§5.1 的附加變更。
- **Manifest 版本** `extensionManifest: 1`。Manifest 的結構只在 API 主版本改變時改版；附加欄位隨 API 次版本出現。
- 擴充功能以 `engines.redlogExtensionApi`（semver 範圍，例如 `"^1.0"`）宣告它支援的 API 版本。

### 1.3 穩定度

| 等級 | 意義 | 擴充功能如何使用 |
|---|---|---|
| `stable` | 依 §5 的相容政策：同一主版本內不破壞；棄用至少保留 §5.3 的期限 | 直接使用 |
| `experimental` | 可能在次版本中改變或移除；改變時主機在該擴充功能的列上顯示理由，不靜默停錄 | 必須在 manifest `experimental` 中逐項列出該介面的名稱，否則載入失敗（`experimental-not-declared`） |
| `reserved` | 形狀已定、目前不開放；出現即載入失敗 | 不得使用 |

每一個介面的等級列在 §6。等級只能往 `stable` 方向移動，或由 `experimental` 移除；`stable` 只能經 §5.3 的棄用移除。

## 2. Manifest schema v1（`extension.json`）

檔案為 UTF-8 JSON，不含註解，大小不超過 256 KiB。未知的頂層或巢狀欄位為錯誤（`unknown-field`），除非位於 `x-` 前綴的鍵下（作者自用，核心不讀、不顯示，計入雜湊）。

「讀者」欄是核心中讀該欄位的程式位置（由 Spec 076 實作建立；`test/extensions/manifest-consumers.test.ts` 斷言每一個欄位都有登記的讀者，承接 075 FR-052）。

### 2.1 頂層

| 欄位 | 型別 | 必填／預設 | 等級 | 意義 | 讀者 |
|---|---|---|---|---|---|
| `extensionManifest` | `1` | 必填 | stable | manifest 版本 | `core/extensions/manifest.ts#parseManifest` |
| `id` | string，`^[a-z0-9][a-z0-9-]{1,63}$` | 必填 | stable | 穩定 id；內建 id 保留 | `parseManifest`、`core/extensions/registry.ts#register` |
| `version` | string，semver | 必填 | stable | 擴充功能自己的版本；寫進 `system:extensions_active` | `registry.ts#activeSet` |
| `label` | string，1–48 字元，單行 | 必填 | stable | 唯一顯示的作者文字 | `core/extensions/descriptor.ts#toDescriptor` |
| `engines.redlogExtensionApi` | string，semver 範圍 | 必填 | stable | 支援的 API 版本範圍（§5.4） | `core/extensions/negotiate.ts#negotiate` |
| `kind` | `"source"` \| `"processor"` \| `"exporter"` | 必填 | stable（`exporter` 為 experimental） | 一種 | `parseManifest` |
| `runtime` | `"external"` \| `"host"` \| `"core"` | `kind≠processor` 時必填；processor 不得有 | stable（`core` 只限內建允許清單） | 在哪裡執行 | `registry.ts#plan`、`main/extension-host/launcher.ts` |
| `main` | string，相對路徑 | `runtime: host` 時必填，否則不得有 | stable | 打包好的單一入口檔（CommonJS），必須列在 `files` | `launcher.ts#start` |
| `files` | object：路徑 → `"sha256:<64 hex>"` | 必填 | stable | 資料夾中的**每一個**檔案（`extension.json` 自己除外）；多、少、不符皆錯誤 | `core/extensions/integrity.ts#verify` |
| `defaultEnabled` | boolean | `false` | stable | 機器層的預設啟用（安裝的擴充功能一律 `false`，只有內建者可為 `true`） | `registry.ts#machineDefault` |
| `activation` | array of §3.4 的值 | `["machine-enabled"]` | stable | 何時啟動 | `core/extensions/activation.ts#shouldRun` |
| `experimental` | array of §6 的實驗介面名稱 | `[]` | stable | 選用的實驗介面 | `negotiate.ts#checkExperimental` |
| `source` | object（§2.2） | `kind: source` 時必填 | stable | — | `descriptor.ts` |
| `processor` | object（§2.3） | `kind: processor` 時必填 | stable | — | `core/plugins/contributions.ts`（沿用） |
| `exporter` | object（§2.4） | `kind: exporter` 時必填 | experimental | — | `core/extensions/exporter.ts` |
| `configuration` | object（§2.6） | `{settings: [], migrations: []}` | stable | 設定項 | `core/extensions/configuration.ts` |
| `reads` | object（§2.8） | 無（＝不能讀） | stable（`levels` 中的 `command`、`content` 為 experimental） | 讀取範圍 | `core/extensions/read-scope.ts` |
| `commands` | array（§2.7） | `[]` | stable | 貢獻的指令 | `core/extensions/commands.ts` |
| `keybindings` | array（§2.7.1） | `[]` | experimental | 為自己的指令提議預設鍵 | `commands.ts#keybindings` |
| `views` | array（§8） | 省略 | `L2_CLASS`（§8.0；Spec 076 FR-096） | L2 面板 | `parseManifest`；`reserved` 時一律拒絕（`views-reserved`） |

不接受（v1 為錯誤，訊息說明原因）：`signature`、`publisher`、`capabilities`、`description`、`contributes`、`redlogApi`、`manifestVersion`（屬舊 `plugin.json`）、`eventTypes`、`color`、`icon`、`lane`、`marketplace`、`updateUrl`、`repository`。

### 2.2 `source`

| 欄位 | 型別 | 必填／預設 | 意義 |
|---|---|---|---|
| `producer` | string，`^[a-z0-9][a-z0-9-]{1,63}$` | 預設等於 `id` | 接收端蓋章的名稱；憑證為 `plugin:<id>`（內建者沿用 071 FR-071 的類別） |
| `emits` | array of `{kind, label, reader?, volume?}` | 必填，≥1 | `kind` 形如 `agentType:subtype`（072 `KindId`）；`label` 1–48 字元；`reader` ∈ 072 `ReaderId`，預設 `fields`；`volume` ∈ `normal`／`high`（提示）。決定憑證允許的種類，恰好此清單 |
| `requires` | array of 前置條件 | `[]` | `{binary: string[], mode?: "any"\|"all"}`、`{permission: "screen-recording"\|"accessibility"\|"root"}`、`{platform: ("darwin"\|"linux"\|"win32")[]}`、`{file: string}`；由核心檢查（075 FR-004） |
| `liveness` | `"hello"` \| `"alive"` \| `"process"` \| `"none"` | `"alive"` | 存活訊號（075 FR-001） |
| `binding` | `"terminal"` \| `"explicit"` \| `"none"` | `"none"` | 資料流與專案的關係（Spec 076 FR-042–046）：`terminal`＝在啟動時 pin 到開著的專案；`explicit`＝逐專案選擇、可改綁；`none`＝寫到觀察當下開著的專案 |
| `start` | `{by: "operator"\|"redlog", steps: Step[]}` | `{by:"redlog", steps:[]}` | `Step = {label, run, args?: string[], elevated?: boolean}`；`run` 必須列在 `files` |
| `stop` | `{steps: Step[]}` | `{steps: []}` | 停止步驟（例如還原系統設定） |
| `setup` | array（§2.5） | `[]` | 首次使用清單的步驟 |

### 2.3 `processor`

只有資料，由核心解讀，沒有 runtime（075 FR-059 的規則照舊）：`lootPatterns`、`redaction.denylist`、`commandTags`、`targetExtractors`、`terminalProfiles`。每個子欄位的形狀與今天 `src/core/plugins/types.ts` 的同名欄位相同（T020 從該型別產生 schema，並在 golden 中釘住）。`terminalProfiles` 是唯一需要核准的 Processor 內容。

### 2.4 `exporter`（experimental）

| 欄位 | 型別 | 必填／預設 | 意義 |
|---|---|---|---|
| `destinations` | array of `{scheme: "https"\|"http"\|"file", host?: string, port?: integer, path?: string}` | 必填，≥1 | 核准時顯示；鏈上紀錄寫的是這些值（無法強制，見 Spec 076 Assumptions） |
| `levels` | array of `"meta"`\|`"command"`\|`"content"` | `["meta"]` | 可要求的最高層級；`command`／`content` 需要遮蔽前提（Spec 076 FR-072） |
| `format` | `"aligned-v1"` | `"aligned-v1"` | 批次的列格式（§7） |
| `schedule` | `{mode: "on-demand"}` \| `{mode: "interval", minutes: 5..1440}` | `{mode:"on-demand"}` | 何時產生批次 |
| `batch` | `{maxRows: 1..10000, maxBytes: 1024..16777216}` | `{maxRows: 1000, maxBytes: 4194304}` | 一批的上限 |

### 2.5 `setup` 步驟

| 欄位 | 型別 | 意義 |
|---|---|---|
| `id` | string | 穩定 id |
| `prerequisite` | 前置條件（同 §2.2 `requires` 的一項）或省略 | 這一步之前要成立的條件 |
| `action` | `{label, run?: string, args?: string[]}` \| `{label, core: "install-hook"\|"open-settings"\|"copy-command"}` | **唯一**的一個動作 |
| `terminal` | string | 等效的終端機指令（可複製；不得含秘密） |
| `evidence` | `"hello"` \| `{firstEvent: KindId}` \| `{file: string}` \| `{binary: string}` \| `"alive"` | 怎樣算完成；只能由核心觀察到的事實打勾，不能由按鈕打勾 |

### 2.6 `configuration`（stable）

```jsonc
"configuration": {
  "settings": [{
    "key": "port",                       // ^[a-z][a-zA-Z0-9]{0,31}$；在擴充功能內唯一
    "label": "Listen port",              // 1–48 字元，單行；沒有說明段落（UIUX §26.4）
    "synonyms": ["proxy port"],          // 0–5 個，供指令面板搜尋
    "type": "number",                    // 見下表（封閉）
    "scope": "machine",                  // "machine" | "project"，恰好一個
    "default": 6661,                     // 選填；沒有 default 且 required 時見 Spec 076 FR-113
    "required": false,
    "restart": "none",                   // "none" | "extension"
    "affectsCapture": true               // Source 與 Exporter 預設 true；false 時必須明寫
  }],
  "migrations": [                        // 擴充功能版本之間的破壞性變更（§2.6.3）
    { "from": "listenPort", "to": "port" }
  ]
}
```

#### 2.6.1 型別（封閉）

| `type` | 額外欄位 | 值 |
|---|---|---|
| `boolean` | — | `true`／`false` |
| `number` | `min`、`max`、`step?`、`unit?`（`ms`\|`s`\|`min`\|`bytes`\|`KiB`\|`MiB`\|`port`） | 有限數 |
| `string` | `pattern?`（ECMAScript，載入時做線性檢查）、`maxLength?`（≤ 1024） | 字串 |
| `enum` | `options: string[]`（每項 1–48 字元），或 `optionsFrom`（核心提供的封閉清單：`shells`、`wsl-distros`、`network-interfaces`） | 其中一個 |
| `path` | `kind: "file"\|"dir"`、`mustExist?` | 絕對路徑；以系統選擇器輸入 |
| `list` | `items: "string"\|"path"`、`maxItems`（≤ 64）、`pattern?`／`kind?` 同上 | 陣列 |
| `secret` | — | 字串；見 §2.6.2 |

每個擴充功能的設定數軟上限 **12**：超過時照常載入，`extension check` 與擴充功能詳情顯示警告 `configuration-too-large`。

#### 2.6.2 儲存

- `scope: "machine"` → `~/.redlog/machine.yaml` 的 `extensions.<id>.config.<key>`（Spec 073 的機器層檔案、原子寫入、修訂值比對）。
- `scope: "project"` → 專案 `config.yaml` 的 `extensions.<id>.<key>`（Spec 073 的專案層）。
- `secret` → OS 的憑證儲存：以 Electron `safeStorage` 加密（金鑰由 macOS Keychain、Windows DPAPI、Linux Secret Service／kwallet 持有），密文存 `~/.redlog/extension-secrets/<id>.bin`（0600）；`safeStorage` 的後端為 `basic_text`（Linux 沒有金鑰圈）時拒絕儲存，該擴充功能為「無法使用」，理由 `secret-store-unavailable`。secret 從不進設定檔、事件、日誌、匯出或 bundle；輸入後從不顯示（只顯示「已設定」與「清除」）。
- 擴充功能被移除或降版後留在檔案中的未知鍵：忽略、不刪除（073 FR-023 的規則）。

#### 2.6.3 相容

- 新增設定＝擴充功能的次版本變更。
- 移除、改名、改型別、改 scope＝擴充功能的破壞性變更，必須在 `migrations` 中宣告：`{from, to}`（改名）、`{from, to, map: {<舊值>: <新值>}}`（enum 改值）、`{from, drop: true}`（移除）；改 scope 只能是 `drop` 加新鍵。沒有宣告就改變時，載入錯誤 `configuration-migration-missing`。
- 更新後已存的值不再通過驗證：不刪除、不改為預設值；該設定在列上標為無效，擴充功能為「未設定」、理由 `setting-invalid-after-update`，唯一的動作是前往該設定。

### 2.6.4 不是設定的

啟動／停止、綁定到專案、標為私人、Exporter 在本專案的啟用：都是來源列上的動作（Spec 076 FR-117），不能宣告為設定。

### 2.7 `commands`

`[{id, title, where: ("palette"|"row-action")[], kinds?: KindId[], run: {openUrl: string} | {exec: string, args?: string[]} | {openView: string}}]`（`openView` 只在 `views` 被接受時有效，§8）。`openUrl` 只接受 `https:`、`http://127.0.0.1`、`http://localhost` 與 `redlog:`；範本只能代入 `{eventId}`、`{projectId}`。`exec` 必須列在 `files`。`row-action` 只在 `kinds` 中的種類的列上出現；沒有 `kinds` 時只能是 `palette`。

#### 2.7.1 `keybindings`（experimental）

`[{command: <自己的 command id>, key: string}]`。與核心鍵或其他擴充功能衝突時不綁定，擴充功能詳情顯示衝突。

### 2.8 `reads`

`{families: ("commands"|"traffic"|"ai"|"artifacts"|"annotations"|"signals"|"record")[], levels: ("meta"|"command"|"content")[]}`。家族即 072 的 `KindFamily`（`annotations` 對應 `role: annotation`）。超出範圍的資料在伺服端過濾。

### 2.9 雜湊

內容雜湊 = `sha256("extension\0" ‖ canonical(extension.json) ‖ for each path in sort(files): "\0file\0" ‖ path ‖ "\0" ‖ bytes)`。`canonical` 為鍵排序、無空白的 JSON。核准釘住此值（Spec 076 FR-063）。

## 3. 主機 API v1（`runtime: "host"`）

### 3.1 模組形狀

入口檔匯出：

```ts
export function activate(ctx: ExtensionContext): void | Promise<void>   // ≤ 10 s
export function deactivate(): void | Promise<void>                      // ≤ 5 s
```

主機以核心驗證過的位元組載入入口檔；入口檔可以使用 Node 內建模組（不受限，見威脅模型），不得 `require` 入口檔以外的擴充功能檔案（主機的 `require` 對擴充功能資料夾內的路徑丟出 `module-not-bundled`）。資料檔以 `ctx.files.read` 取得。

### 3.2 `ExtensionContext`

```ts
interface ExtensionContext {
  readonly api: { version: '1.0' | `1.${number}`; experimental: readonly string[] }   // stable
  readonly extension: { id: string; version: string }                               // stable
  readonly files: { read(path: string): Promise<Uint8Array> }                       // stable；只限 files 中的資料檔
  readonly configuration: {                                                         // stable
    get(): Readonly<Record<string, ConfigValue>>                                   // 已由核心驗證；不含 secret
    onDidChange(fn: (e: { keys: readonly string[]; next: Readonly<Record<string, ConfigValue>> }) => void): Disposable
    // restart: "extension" 的設定改變時不送事件：核心以 deactivate → 新 instance 重啟主機
  }
  readonly secrets: {                                                               // stable；只有宣告了 secret 設定的擴充功能有
    get(key: string): Promise<string | undefined>                                   // 每次呼叫計入 system:extension_read 的 secret_reads（只記鍵，不記值）
  }
  readonly state: {                                                                 // stable；每個擴充功能 ≤ 1 MiB JSON
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>                                 // 原子；超限 → storage-full
  }
  readonly project: {                                                               // stable
    current(): ProjectRef | null                                                    // 開著的專案；唯讀 session 為 null
    onDidChange(fn: (p: ProjectRef | null) => void): Disposable
  }
  readonly recording: {                                                             // stable
    isPaused(): boolean                                                             // 依 071 的暫停狀態；判斷規則以 071 為準
    onDidChange(fn: (paused: boolean) => void): Disposable
  }
  readonly source?: SourceApi                                                       // kind = source
  readonly reader?: ReadApi                                                         // manifest 有 reads
  readonly exporter?: ExporterApi                                                   // kind = exporter（experimental）
  readonly log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void }  // stable；寫擴充功能日誌，不是事件
}
interface ProjectRef { id: string; name: string }
type ConfigValue = boolean | number | string | readonly string[]
interface Disposable { dispose(): void }
```

### 3.3 `SourceApi`、`ReadApi`、`ExporterApi`

```ts
interface SourceApi {                                                               // stable
  ingest(items: readonly IngestItem[]): Promise<readonly Receipt[]>                 // 1–100 項；071 契約 1
  discarded(reason: SourceLossReason, n?: number): void                             // 來源端遺失計數（071 FR-050 中「由來源計」的原因）
  reportError(code: string, message?: string): void                                 // → 075 的 captureError 事實；code ^[a-z-]{1,32}$
  clearError(): void
  binding: {                                                                        // stable；binding = explicit 的來源
    current(): readonly BindingRef[]                                                // 開著的專案為這個來源選擇的工作階段或路徑
    onDidChange(fn: (b: readonly BindingRef[]) => void): Disposable
  }
}
interface IngestItem {
  event_id?: string        // 省略時由執行期產生；有天然穩定鍵時應提供（071 FR-043）
  type: KindId             // 必須在 emits 中
  data: Record<string, unknown>   // 不得含 _ 開頭的鍵，_causes 除外
  occurred_at?: number
  target?: string
  observed?: { terminal?: string; command?: string }
}
// 執行期補上 kind:"event"、producer、instance、seq、observed.at、observed.project，並送 hello/alive/bye
type Receipt =
  | { outcome: 'accepted'; id: string }
  | { outcome: 'duplicate'; id: string; present: boolean }
  | { outcome: 'rejected'; reason: string }        // 071 FR-031 的 reason；未知值視為 rejected
  | { outcome: 'retry'; reason: string; after_ms: number | null }   // 執行期已自行寫交接檔或重送；擴充功能不需處理
type SourceLossReason = 'paused' | 'handoff-full' | 'handoff-write-failed' | 'encode-failed'
interface BindingRef { kind: 'session' | 'path'; value: string }

interface ReadApi {                                                                 // stable（meta 層級）
  query(q: { query?: string; families?: string[]; since?: number; until?: number; limit?: number; cursor?: string }):
    Promise<{ rows: AlignedRow[]; total: number; excluded: number; cursor: string | null }>
  event(id: string): Promise<{ row: AlignedRow; content?: unknown; completeness: string } | null>   // content 只在 content 層級
  subscribe(topics: readonly string[], fn: (t: { topic: string; seq: number }) => void): Disposable  // 074 的主題
}

interface ExporterApi {                                                             // experimental: "exporter"
  onBatch(fn: (b: ExportBatch) => Promise<{ ok: true } | { ok: false; code: string; message?: string }>): Disposable
  requestBatch(): Promise<void>                                                     // schedule = on-demand 時由操作者觸發的路徑也走這裡
}
interface ExportBatch { id: string; level: 'meta' | 'command' | 'content'; destination: number; rows: AlignedRow[]; shippedRecordId: string }
```

`AlignedRow` 見 §7。

### 3.4 啟動事件（封閉清單）

| 值 | 成立條件 |
|---|---|
| `machine-enabled` | 在本機啟用（app 開著即成立） |
| `project-open` | 有一個一般（非唯讀）專案開著 |
| `binding:terminal` | 有終端機綁定到開著的專案 |
| `binding:session` | 開著的專案為這個來源選擇了至少一個工作階段或路徑 |
| `operator-start` | 操作者執行了 `start` 步驟，直到 `stop` |
| `export-due` | 有一批 Exporter 待送（schedule 到期或操作者要求） |

任何一個列出的事件成立即啟動；全部不成立後 30 秒內停止（呼叫 `deactivate`）。

## 4. 錯誤與上限

### 4.1 錯誤（封閉清單，API 呼叫以 `ExtensionApiError{code}` 拒絕）

`not-activated`、`capability-denied`（呼叫了 manifest 沒有宣告的能力）、`invalid-argument`、`kind-not-declared`、`too-large`、`rate-limited`、`storage-full`、`no-project`、`host-shutting-down`、`experimental-not-declared`、`module-not-bundled`、`internal`。次版本可以新增錯誤碼；擴充功能必須把未知的錯誤碼當作 `internal`。

### 4.2 載入錯誤（封閉清單，顯示在擴充功能的列與詳情）

`manifest-invalid`（附 JSON pointer、期望值、實際值）、`unknown-field`、`files-mismatch`（附檔名）、`hash-changed`、`api-too-new`、`api-retired`、`experimental-not-declared`、`views-reserved`、`view-imitates-status`、`configuration-migration-missing`、`configuration-invalid`（手改的設定檔不通過驗證）、`secret-store-unavailable`、`id-reserved`、`id-conflict`、`runtime-not-allowed`、`platform-unsupported`、`host-unavailable`。

### 4.3–4.6 上限

| 項目 | 上限 |
|---|---|
| `ingest` | 每次 1–100 項、20 MiB；每秒 50 次呼叫，超過 `rate-limited` |
| `state` | 每個擴充功能 1 MiB |
| `query` | `limit` ≤ 1000；每分鐘 600 次 |
| 主機 heap | 512 MiB（內建可在允許清單中另定） |
| `activate`／`deactivate` | 10 s／5 s |

## 5. 版本與相容政策

### 5.1 附加變更（次版本）

新增選填的 manifest 欄位（有預設值，預設值保留舊行為）；新增 API 方法、事件、選填參數與回傳欄位；新增錯誤碼、理由碼、主題、啟動事件、`ReaderId`、`KindFamily`（擴充功能必須容忍未知值）；在對齊列尾端新增欄位；把介面由 `experimental` 升為 `stable`。

### 5.2 破壞性變更（主版本）

移除或改名欄位、方法、事件、對齊列欄位；改變型別、單位、語意或預設值；把選填改為必填；縮小接受的值；改變雜湊算法；改變 `stable` 介面的錯誤條件。

### 5.3 棄用

- `stable` 介面的棄用：在契約的變更紀錄寫明替代與移除版本；保留至少**兩個 app 次版本且至少 180 天**，取較晚者；移除只能在下一個 API 主版本。
- 擴充功能看到的：它的列與詳情帶理由「使用已棄用的介面：<名稱>，將於 <版本> 移除」；狀態不變、不進需要處理；`extension check` 印同樣的警告。擷取不因棄用而停止。
- `experimental` 介面可在次版本改變或移除；改變時使用它的擴充功能為「無法使用」，理由 `experimental-changed`，並在詳情列出改變。

### 5.4 協商

主機支援目前主版本 N 與前一主版本 N−1。載入時：`range ∩ {N.x, (N−1).x}` 取最高者，經 `ctx.api.version` 告知；擴充功能只能使用該版本的介面。

### 5.5 不相容時

| 情況 | 狀態（075） | 理由 | 擷取 |
|---|---|---|---|
| 範圍全部高於 N | 無法使用 | `api-too-new` | 不啟動、不發憑證；外部行程若仍在送，每項 `rejected`／`credential-revoked`，計數 |
| 範圍全部低於 N−1 | 無法使用 | `api-retired` | 同上 |
| 用了未宣告的實驗介面 | 失敗 | `experimental-not-declared` | 不啟動 |
| 實驗介面改變 | 無法使用 | `experimental-changed` | 不啟動 |

機器層啟用中的擴充功能為「無法使用」時進入需要處理（075 FR-021 修訂）。不相容從不使其他來源停止。

### 5.6 資料的前向相容

擴充功能寫過的種類，在擴充功能移除、停用或不相容之後仍可讀：閱讀器與標題沿用最後一次已知的宣告（072 規則：已寫入種類的閱讀器與標題永不刪除）；核心在擴充功能第一次被接受時，把它的 `emits` 宣告複製到專案的種類宣告快照（`derived` 以外的專案檔，072 擁有位置）。對齊列 v1 的欄位語意在主版本內不變。

## 6. 介面與穩定度一覽

| 介面 | v1 等級 |
|---|---|
| Manifest 頂層欄位（§2.1，除下列） | stable |
| `kind: "exporter"`、`exporter`（§2.4）、`ExporterApi` | experimental（名稱 `exporter`） |
| `reads.levels` 的 `command`、`content` | experimental（名稱 `read-command`、`read-content`） |
| `keybindings` | experimental（名稱 `keybindings`） |
| `runtime: "core"` | stable，只限內建允許清單 |
| `source`、`processor`、`setup`、`configuration`（含 `migrations`）、`commands`、`reads`（meta） | stable |
| `ctx.api`、`extension`、`files`、`configuration`、`secrets`、`state`、`project`、`recording`、`log` | stable |
| `SourceApi`（含 `binding`） | stable |
| `ReadApi`（meta 層級） | stable |
| 外部行程約定（§9） | stable |
| 對齊列 v1（§7） | stable |
| 深連結 `redlog://event/<id>`、`redlog://project/<id>` | stable |
| L1：擴充功能種類的篩選與閱讀器（自動） | stable（無 manifest 欄位） |
| data-provider 清單（`lists`，未定義欄位） | experimental，v1 未提供欄位：名稱保留給次版本 |
| `views`（L2，§8）：導覽項目放置、面板訊息、資源 URI、`state` | `L2_CLASS`（建議 experimental，名稱 `views`） |
| `views[].slot`（替代檢視） | reserved |
| 通用閱讀器 `table`、`hex`、`diff`、`key-value`（072 的 `ReaderId` 附加） | stable（落地後） |
| 狀態列項目、核心版面、核心導覽、主題、圖示主題、自訂編輯器、自訂閱讀器 | 不提供（不是 API 的一部分） |

## 7. 對齊列 v1

順序固定；CSV 以此順序為欄；NDJSON 以這些鍵；未知值為空字串（CSV）或 `null`（NDJSON），不寫猜測值。

| # | 欄位 | 型別 | 層級 | 來源 |
|---|---|---|---|---|
| 1 | `time_utc` | ISO 8601，毫秒，`Z` | meta | 列的 `timestamp` |
| 2 | `tz_offset_min` | integer | meta | 匯出當下的本機偏移 |
| 3 | `egress` | string | meta | `source_ip`（071 FR-120） |
| 4 | `egress_read_at` | ISO 8601 或空 | meta | `_ingest.egress_at` |
| 5 | `egress_state` | `current`\|`changing`\|`stale`\|`none`\|`airgap`\|`remote`\|空（舊列） | meta | `_ingest.egress` |
| 6 | `operator` | string | meta | `operator_id` |
| 7 | `host` | string | meta | 遠端時為 `data.term.host`，否則 `hostname` |
| 8 | `user` | string | meta | `data.term.user` |
| 9 | `terminal` | string | meta | `data.term.pane` 或 `data.term.tty` 或 `_ingest.terminal` |
| 10 | `target` | string | meta | `target_id` |
| 11 | `kind` | `agentType:subtype` | meta | 列 |
| 12 | `command` | string | command | 指令列（遮蔽後） |
| 13 | `result` | string | meta | 結束碼、HTTP 狀態碼或空 |
| 14 | `event_id` | string | meta | 列 id |
| 15 | `chain_seq` | integer 或空 | meta | 鏈上位置（logged 為空） |

## 8. L2 面板（程式編輯器的 webview 模式）

### 8.0 等級（擁有者一行決定）

`L2_CLASS = experimental`（替代：`reserved`）。見 Spec 076 FR-096。`experimental` 時：manifest 的 `experimental` 必須含 `"views"`；核准對話框另外點名「面板」能力；`reads.levels` 在遮蔽前提落地前只能是 `meta`。`reserved` 時：`views` 一律 `views-reserved`。

### 8.1 宣告

```jsonc
"views": [{                                  // v1 至多一項
  "id": "attack-graph",                      // ^[a-z][a-z0-9-]{1,31}$
  "title": "Attack graph",                   // 1–48 字元；核心用它畫導覽項目與標題列
  "mark": "graph",                           // 固定集合：graph | matrix | map | table | timeline | list；不接受自訂圖示
  "entry": "views/attack-graph.html",        // 必須列在 files
  "placement": { "navigation": true },       // v1 唯一開放的放置；另可由 commands 開啟
  "slot": null,                              // reserved：{"page":"targets","as":"alternate-view"}；v1 非 null 即錯誤
  "retainWhenHidden": false,                 // true：隱藏時保留（記憶體計入主機上限）；false：隱藏即銷毀
  "network": false                           // true 需要 §2.4 形狀的 destinations 宣告與核准；否則 CSP 不允許任何連線
}]
```

### 8.2 放置

- **導覽項目**：核心導覽（活動紀錄、時間軸、目標、證據、啟用時的終端機，加設定；DECISIONS §4）固定在一條分隔線之上，不能被隱藏、重新排序或模仿。每個啟用且核准的面板擴充功能在分隔線下有一個項目，名稱與 `mark` 由核心繪製；使用者可隱藏或重新排序分隔線下的項目（存在機器層）。項目的快捷鍵取自擴充功能保留區（例如 ⌥⌘1–9，依項目順序）；重新對應要等鍵盤對應機制（keybindings 為 experimental）。沒有安裝任何面板擴充功能時，沒有分隔線，導覽與今天相同。
- **從指令開啟**：`commands[].run` 可為 `{openView: "<view id>"}`，開啟同一個面板。
- **替代檢視 slot**：reserved（Spec 076 FR-095 第 2 點）。

### 8.3 沙箱

- 每個面板一個 `WebContentsView`：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、沒有 preload、沒有 IPC；獨立的 partition 與 origin（`redlog-ext://<id>/`），不共用 cookie、storage。
- 本機資源只經核心發出的資源 URI：`redlog-ext://<id>/<path>`，根為該擴充功能的資料夾，只供應列在 `files` 中、雜湊相符的檔案；其他路徑 404。
- 強制的 CSP（核心以回應標頭設定，擴充功能不能放寬）：`default-src 'none'; script-src redlog-ext://<id>; style-src redlog-ext://<id>; img-src redlog-ext://<id> data:; font-src redlog-ext://<id>; connect-src 'none'`；`network: true` 時 `connect-src` 只加宣告的目的地。沒有 `unsafe-eval`、沒有遠端 script。
- 主題：核心注入非語意 token 為 CSS 變數（`--rl-bg`、`--rl-fg`、`--rl-muted`、`--rl-border`、`--rl-font-mono`、`--rl-font-sans`、`--rl-space-*`）；狀態色與種類符號**不**提供。
- 狀態保存：`getState()`／`setState(obj)`（JSON，≤ 256 KiB，存在 `~/.redlog/extension-state/<id>.json` 的面板分區）。
- 生命週期：導覽離開即銷毀（`retainWhenHidden: false`）；重新進入時重新載入並送一次目前的選取、範圍與篩選。擴充功能停用、雜湊不符或主機不相容時，面板立即銷毀，導覽項目消失。

### 8.4 訊息（`postMessage`，唯一的通道）

核心 → 面板：

| 訊息 | 形狀 | 何時 |
|---|---|---|
| `init` | `{api:"1.x", project: {id,name}|null, selection, range, filter, theme}` | 載入後一次 |
| `selectionChanged` | `{eventId: string | null}` | 操作者在活動紀錄、時間軸、目標頁的選取改變 |
| `rangeChanged` | `{since: number, until: number} | null` | 時間範圍改變 |
| `filterChanged` | `{filter: Filter}`（074 序列化的篩選物件） | 篩選改變 |
| `result` | `{id, ok: true, value} | {id, ok: false, code}` | 回應面板的請求；`value` 同 `ReadApi` 的回傳 |
| `topic` | `{topic, seq}` | 訂閱的主題有變更 |
| `projectChanged` | `{project: {id,name} | null}` | 專案切換或關閉（面板應清空） |

面板 → 核心：

| 訊息 | 形狀 | 效果 |
|---|---|---|
| `query` | `{id, query}`（同 `ReadApi.query`） | 讀取；範圍與稽核同 L0 |
| `event` | `{id, eventId}` | 讀一筆 |
| `subscribe` | `{topics: string[]}` | 訂閱 074 的主題 |
| `revealEvent` | `{eventId}` | 核心在活動紀錄（或時間軸，若目前在那裡）定位該列；不切換專案 |
| `setFilter` | `{filter: Filter}` | 只接受操作者能在篩選列手動設定的值（家族、目標、時間、查詢字串）；其他值 `invalid-argument` |
| `openReader` | `{eventId}` | 以 072 的閱讀器開啟該列 |
| `getState`／`setState` | `{id}`／`{id, state}` | §8.3 |

沒有任何寫入事件、改變狀態、改變設定、匯出、標記、暫停或導覽到核心以外目的地的訊息。未知的訊息類型被忽略並計入擴充功能詳情。

### 8.5 標示與畫面

- 面板在內容欄內繪製；上方是核心繪製、固定高度、不可隱藏的標題列：擴充功能 label、「擴充功能提供」、雜湊前 12 碼；標題列與外框為中性色，不使用狀態色。
- 核心的狀態讀數（活動紀錄頂端的狀態行、狀態列）維持可見並位於 frame 之外；HUD 不受影響。
- frame 不能全視窗、不能浮動、不能繪製覆蓋層或對話框、不能改變大小以外的版面；全域快捷鍵由核心先處理，frame 不能攔截。

### 8.6 永遠不能遮蓋或模仿

狀態讀數、整體字、完整性、記錄狀態、暫停、HUD、標題列、核心導覽、來源列、鏈驗證結果、對話框與通知。面板的 `entry` 與它載入的資源中不得出現 075 的十二個狀態字（載入時掃描；執行中由核心定期抽查 frame 的文字）；違反即銷毀並在擴充功能列顯示「失敗」與理由 `view-imitates-status`。

### 8.7 Gate

- `reserved` 時：manifest 含 `views` → `views-reserved`（`test/extensions/manifest-reserved.test.ts`）。
- `experimental` 時另加：`WebContentsView` 的 webPreferences 快照；CSP 標頭快照；資源 URI 只供應 `files` 中且雜湊相符的檔；面板拿不到任何 bridge（`window.redlog` 為 undefined）；標題列與狀態讀數不被 frame 覆蓋的幾何測試（offset 系列，CLAUDE.md「Measuring geometry in e2e」）；分隔線上方的核心導覽不可隱藏、排序、模仿（名稱不得等於核心目的地名稱）；狀態字掃描；`setFilter` 只接受手動可設的值；讀取稽核計數與 L0 相同；沒有寫入訊息（訊息型別清單的 golden）。

## 9. 外部行程（`runtime: "external"`）

- 寫入：Spec 071 契約 1（`POST /api/ingest`、交接目錄、回執、遺失計數、`hello`／`alive`／`bye`），憑證檔 `~/.redlog/credentials/plugin-<id>.cred`（0600）。內建擴充功能沿用 071 FR-071 的類別與檔名。
- 讀取：`GET /api/v1/query`、`/api/v1/events/<id>`、`/api/v1/topics`（SSE），同一憑證，範圍＝`reads`；回應形狀同 `ReadApi`。
- 版本：`producer.version` 帶 `ext-api/<版本>`；接收端以 manifest 的 `engines` 判斷相容（§5.4），不以自報值。
- 擴充功能的步驟（`start`、`stop`、`setup`）由核心顯示；`elevated` 步驟依 075 FR-063 只執行驗證過的 root 擁有複本。

## 10. 一致性與 gate

- **Golden**：`test/extension-api/golden.test.ts` 對 `extensions/extension.schema.json` 與 `src/extension-api/v1.d.ts` 的正規化內容各存一個雜湊，並對應 `EXTENSION_API_VERSION`；任一改變而版本未改 → 失敗；版本改了但變更屬於 §5.2 而只升次版本 → 失敗（以 schema 差異的分類器判斷：移除、改型別、改必填）。
- **公開 API 邊界**：`src/extensions/**`（內建擴充功能的 host 程式碼）只能 import `src/extension-api/**` 與 Node 內建模組（`test/extensions/public-api-only.test.ts`）。
- **一致性測試組**：`redlog-cli extension test <dir>`：071 的共用向量＋mock receiver＋主機模擬器（執行 `activate`、送啟動事件、注入每一種 Receipt 與錯誤），輸出與 CI 相同的結果列。
- **相容矩陣**：CI 對每個內建與 `examples/extensions/*` × {N, N−1} 執行一致性測試組，由結果產生 `docs/domain/extension-compat-matrix.md`；不是自報。
- **資料前向相容**：移除一個寫過列的擴充功能後，那些列的標題與閱讀器不變（`test/extensions/removed-kinds-readable.test.ts`）。

## 變更紀錄

- 1.0（Draft，2026-11-13）：初版。
