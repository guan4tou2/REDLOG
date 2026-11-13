# Feature Specification: 擴充功能模型與機器層級的擷取來源

**Feature Branch**: `spec/076-extensions`
**Created**: 2026-11-13
**Status**: Draft
**Input**: [2026-11-13 的決定](../../docs/records/2026-11-13/DECISIONS.md)（§2、§3、§5、§7）與同日兩份審查：[13 整合與背景成本](../../docs/records/2026-11-13/13-consolidation-and-background-cost.md)（U5 單一動作契約、C 背景成本）、[14 資深滲透測試者審查](../../docs/records/2026-11-13/14-senior-pentester-review.md)（B.3 終端機控制面、D(4) 隱私、D(6) 團隊、F #2、#6、#15 與「不能照搬之處」）；[根因審查](../../docs/records/2026-11-12/ROOT-CAUSE-REVIEW.md) §3（「報告明確建議不做的」）與 §4；根因報告 [07 架構](../../docs/records/2026-11-12/root-cause/07-architecture.md)（不為了搬而搬）、[08 外掛系統](../../docs/records/2026-11-12/root-cause/08-plugin-system.md)（§1.5、§3a–3e）、[11 隱私與資料保護](../../docs/records/2026-11-12/root-cause/11-privacy-and-data-protection.md)（摘要 1、7）；`docs/UIUX-STANDARD.md` §26；Spec 071–075；2026-11-13 擁有者在起草期間的三項修訂與兩項釐清（見「決策與範圍」）。

> 本檔只寫可觀察的行為與對外契約。**擴充功能 API 第 1 版的完整條文**（manifest 每個欄位、主機 API 每個呼叫與事件、錯誤清單、版本規則）在 [contracts/extension-api-v1.md](contracts/extension-api-v1.md)，它是本規格的規範性部分；tasks T020 把它搬成 `docs/domain/SPEC-extension-api-v1.md`，屆時兩者衝突以本規格目錄中的版本為準，直到搬遷完成。模組邊界、介面草圖、被否決的做法、遷移順序與 gate 的實作在 [plan.md](plan.md)。

## 決策與範圍

### 已決議（擁有者，2026-11-13；本規格不重開）

| # | 決定 | 落點 |
|---|---|---|
| E1 | 管理方式比照程式編輯器的擴充功能：manifest 宣告貢獻；內建擴充功能隨 app 附帶、可停用；需要時才啟動；獨立的擴充功能主機行程 | A、C、D |
| E2 | 類型為 Source、Processor、Exporter（取代 Spec 075 Q5 的「去掉 Exporter」） | A、H |
| E3 | 核心保留：寫入入口與蓋章、雜湊鏈與簽章、儲存、查詢、來源狀態的計算、閱讀器、驗證與匯出封存 | B |
| E4 | 介面擴充點在 manifest 與主機設計中預留、目前不開放；外掛只能指名核心提供的閱讀器；不做市集、不自動更新 | J |
| E5 | 擷取來源屬於這台機器，不隨專案改變；專案只決定範圍、哪個終端或工作階段綁定到這個專案、暫停 | E |
| E6 | 內建終端機、擷取瀏覽器、受管代理為選用，預設關閉，不在首次使用的主線上 | B、E |
| E7 | App 永遠單人、本機；多人多機在 app 之外，只經使用者自行安裝的上傳外掛（Exporter）連接；本機紀錄是唯一的證據 | H |
| E8 | 專案開著時新開的 shell 維持自動記錄；第一次綁定時在提示字元說一次是哪個專案，並提供把這個 shell 設為私人的指令 | E |
| E9 | 團隊對帳先做可機械對齊的匯出（UTC、出口、終端、主機、目標、指令、事件 id）；上傳外掛排在其後，且以匯出確實套用遮蔽為前提 | H |
| E10 | 不可照搬編輯器擴充模型的五處（本規格的硬性要求，各有 gate）：(1) 只能經 Spec 071 寫入契約**新增**，由接收端蓋上它的來源身分，不能修改、刪除、重新簽章；(2) 核心的真相介面（記錄狀態、完整性、來源狀態）不能被取代或遮蓋；(3) 讀取依能力授權並留紀錄：Exporter 的讀取與網路能力在核准時說清楚會送出什麼，每一次讀取與送出都留下上鏈紀錄；(4) 更新需重新核准：釘住擴充功能會執行的**每一個**檔案的內容雜湊；(5) 不做市集 | G |

### 2026-11-13 之後的修訂（擁有者，起草期間；優先於上表）

| # | 修訂 | 取代 |
|---|---|---|
| R1 | **AI 工具是「來源屬於機器」的例外**：AI adapter 的安裝與啟用是機器層；但某個工作階段屬於哪個專案，必須逐專案選擇，而且可以重新選擇。專案層的工作階段選擇、工作路徑與「有活動卻未記錄」的提示（#703）照今天保留。一般規則：來源屬於機器；**資料流不天然綁定某個專案的來源**（AI 工具的工作階段）需要明確的逐專案綁定步驟，**重新綁定是第一級的動作** | E5 中 AI 的部分；DECISIONS §7 第 4 項 |
| R2 | **不是所有東西都變成擴充功能**：基本功能留在原處；只轉換「搬了不會影響基本功能」的東西。來源分兩層（基本／擴充功能），逐項以程式碼證明；會碰到基本路徑的，在耦合拿掉前不搬。前幾個階段是純粹的抽出，釘住的行為測試前後都綠；第一階段不搬任何寫入路徑上的東西 | DECISIONS §3「所有擷取來源重構為外掛」 |
| R3 | **擴充功能 API 與相容政策現在就完整定義**：manifest schema 第 1 版、主機 API 第 1 版、版本與棄用政策、穩定度分級、相容 gate，全部是規範性條文；介面擴充點的**形狀**現在定義並標為 `reserved` | E4 的「預留」改為「形狀已定、標為保留」 |
| R4 | 「讓別人做自己的工具」分三層討論（L0 外部工具、L1 宣告式檢視、L2 沙箱面板），各給 v1 的穩定度；對照程式編輯器的每一種介面貢獻；L2 依編輯器的 webview 模式完整定義，可貢獻一個分隔線下的導覽項目（與內建終端機同規則），等級由擁有者一行決定（FR-096） | E4 的介面擴充部分：「不開放」改為「由擁有者在 `experimental` 與 `reserved` 之間決定」 |

| R5 | 擴充功能需要設定：`configuration` 貢獻點（v1 stable），對齊 Spec 073 的兩層；核心繪製；secret 走 OS 憑證儲存；操作性控制不是設定 | 新增（K 段） |

### 本規格自行決定的（理由與被否決的替代方案見 plan.md）

1. **擴充功能的 runtime 有三種**：`external`（由操作者、shell 或其他工具執行的行程，經 071 的 HTTP 契約寫入）、`host`（在擴充功能主機行程中執行的 JS）、`core`（只限內建、列在允許清單、附理由；在 main 行程內，與今天相同）。第三方只能用前兩種（plan D1）。
2. **每個有 `host` 程式碼且已啟動的擴充功能各一個主機行程**（Electron `utilityProcess`），不共用一個主機（plan D2）。
3. **主機中的擴充功能與外部行程走同一條入口**：主機內的程式經迴路位址的 `POST /api/ingest`、以自己的 `plugin:<id>` 憑證寫入；不另開 MessagePort 寫入門（plan D3）。憑證在啟動時經 MessagePort 交付，不經檔案、argv 或環境變數。
4. **擴充功能的憑證類別沿用 071 的 `plugin:<id>`**；內建擴充功能保留它們今天的類別（`builtin-terminal`、`http-proxy`、`pcap-agent` 等）。072 的 `ProducerClass` 值域不變（plan D4）。
5. **檔案位置不搬**：內建擴充功能的檔案留在今天打包的位置（`hooks/`、`plugins/<id>/`、`optional-ai/`、`app.asar`），安裝的擴充功能留在 `~/.redlog/plugins/<id>/`；「擴充功能」是概念名，不是新目錄（plan D5）。
6. **Manifest 是新的、獨立版本的「擴充功能 manifest 第 1 版」**（`extensionManifest: 1`）。Spec 075 起草但從未出貨的「manifest v2」由它取代；今天的 `plugin.json` v1 照讀並轉譯（plan D6）。
7. **主機 API 以版本範圍協商**：manifest 宣告 `engines.redlogExtensionApi`（semver 範圍）；主機同時支援目前與前一個主版本；不相容時來源列顯示固定的狀態與理由，什麼都不記為該來源，遺失照計（plan D7、契約 §5）。
8. **每個專案記下「本次 session 生效的擴充功能集合」**：開專案時與集合改變時，寫一列上鏈的 `system:extensions_active`（每項 `id@版本#雜湊前 12 碼`），使行動中途換版的解析器可以追溯（plan D8；14 號審查「自動更新會碰證據的程式碼」）。
9. **讀取的稽核以彙總列上鏈**：每個擴充功能每一分鐘至多一列 `system:extension_read`（查詢數、回傳列數、種類家族、欄位層級、回傳事件 id 清單的雜湊），Exporter 每一批一列 `system:export_shipped`；不逐查詢寫列（plan D9）。
10. **終端機指令 `redlog` 不依賴 Node**：動詞在 hook 的 shell 函式（POSIX 以 python3 格式化，PowerShell 原生）中實作，只是 Spec 075 狀態 payload 與核心動作 API 的薄用戶端；`redlog-cli`（Node）保留為開發者工具（plan D10）。
11. **私人 shell 不留下存在的痕跡**：`redlog private` 在從未綁定的 shell 中什麼都不送；已綁定時只送一筆既有的 `capture_stopped`（理由 `private`），之後不逐指令計數（plan D11）。
12. **AI 工作階段一次只屬於一個專案**：機器層有一份工作階段認領索引；「記錄到這個專案」是一個明確動作，會把認領從原專案移過來，並在兩邊各留一列紀錄（plan D12）。

### 前提更正與已確認的事實（2026-11-13 於 `origin/main@624b79c4` 開檔確認）

- **`cli/` 沒有打包。** `electron-builder.yml:21-39` 的 `extraResources` 只有 `out/optional-ai`、`hooks`、`plugins`、`tools/redlog-verify.py`；`files:` 只有 `out/**`、`resources/**`。`redlog-cli` 只經 `package.json:15` 的 `bin` 在 npm 安裝時存在。安裝版的使用者手上沒有 `redlog-cli`。
- **外掛的內容雜湊不涵蓋被呼叫的檔案。** `computeContentHash`（`src/core/plugins/manifest.ts:308-323`）只雜湊 manifest 與 `codeFilesOf`（`:128-137`：`PRIVILEGED_KEYS` 的模組與 `capture[].hookFile`）。`plugins/c2-tailers/` 的 `follow.js`、`parse.js`，`plugins/pcap-capture/` 的 `pcap-parse.js`、`pcap-sidecar.js`、`redlog-dir.js` 不在雜湊內。
- **官方 AI adapter 在 main 以 `require` 執行**（`src/main/services/agent-tailer.ts:26-29`），拿到 Node 的全部權限；`tailer-host.ts`（1603 行）在 main 讀檔、合併、寫入前遮蔽，經行程內入口寫入。
- **App 今天沒有任何 `utilityProcess` 或 `fork`**，且 `test/package-fuses.test.ts:50-59` 斷言 `src/`、`cli/` 中不出現它們；`electron-builder.yml` 註解寫明「there is no child_process.fork or utilityProcess」。`runAsNode`、`enableNodeOptionsEnvironmentVariable`、`enableNodeCliInspectArguments` 三個 fuse 為關。
- **事件不帶出口位址**：`event-write.ts:609`（chained）與 `:723`（logged）寫死 `sourceIP: null`；`system:ip_verdict` 只有判斷字（`alert/surface.ts:111-121`），且只在判斷字改變時寫（`alert/policies.ts:85-94`）。出口位址與它的讀取時間在 `IPSignalProducer` 的記憶體中（`ip-signal-producer.ts:143-155` 的 `external`、`externalReadAt`）。本項由 Spec 071 的修訂處理（FR-120 起），本規格只讀它。
- `hooks/vps-deploy.sh:22-27` 自稱不支援並直接 `exit 1`。
- 與「基本／擴充功能」分層有關的耦合，逐項列在 FR-020 的表與 plan「耦合證據」。

## User Scenarios & Testing *(mandatory)*

| 故事 | 優先級 | 摘要 |
|---|---|---|
| US1 基本功能不受擴充功能影響 | P1 | 停用全部可停用的擴充功能，三件事照做；抽出前後，釘住的行為逐位元組相同 |
| US2 選用來源預設關閉、只在需要時跑 | P1 | 新機器上沒有受管代理、擷取瀏覽器、內建終端機的行程；啟用後才啟動 |
| US3 擴充功能只能新增、蓋不住真相 | P1 | 擴充功能的事件帶它自己的來源身分；它改不了別人的列、狀態與完整性 |
| US4 換了任何一個檔案就要重新核准 | P1 | 每個會執行的檔案都在雜湊內；不符時停錄並說明 |
| US5 來源屬於機器，專案決定綁定 | P1 | 在機器上啟用一次；每個專案只決定綁定、範圍、暫停；第一次綁定說一次 |
| US6 AI 工作階段明確地屬於某個專案，可以改 | P1 | 每個專案選擇自己的工作階段；改綁是一個動作並留紀錄 |
| US7 終端機裡就能完成控制 | P2 | `redlog status/pause/resume/mark/private/last/export/doctor`，`--json`，不需要 Node |
| US8 為 v1 寫的擴充功能在後續版本繼續可用 | P2 | 版本協商、棄用警告、不相容時固定的狀態與遺失計數 |
| US9 讓別人做自己的工具（L0） | P2 | 外部工具經授權、留紀錄的讀取 API 讀資料；貢獻指令；深連結回到 RedLog |
| US10 上傳外掛把對齊的資料送到 app 之外 | P3 | 先送 metadata；每一批上鏈；核准時說清楚無法收回 |
| US11 擴充功能作者在本機就能驗證 | P3 | 腳手架、驗證錯誤、一致性測試組、相容矩陣 |

### User Story 1 — 基本功能不受擴充功能影響（P1）

操作者停用所有可停用的擴充功能。RedLog 仍能記錄他自己 shell 裡的指令與 AI 工具的工作階段、接收已設定的 HTTP 來源送來的流量、用快捷鍵標記與截圖、在 HUD 顯示出口，並能搜尋、驗證、匯出。

**Why this priority**：R2：轉換只做在「搬了不會影響基本功能」的東西上；07 報告已說明把行程內 service 搬出去會碰到證據路徑，又換不到隔離。

**Independent Test**：「基本路徑釘住」測試組（tasks T002–T007）在每個抽出 PR 的前後都綠，且輸出（列的欄位、`_ingest` 以外的 data、匯出位元組）相同；加上「全部停用」測試：停用每個可停用的擴充功能後，跑一遍基本路徑測試組。

**Acceptance Scenarios**：

1. **Given** 每個內建擴充功能都停用，**When** 在已裝 hook 的 zsh 打指令、AI 工具寫一個回合、按標記與截圖快捷鍵，**Then** 三者都寫入，HUD 顯示出口，驗證與匯出照常。
2. **Given** 任一個從 `core` 抽到 `host` 的擴充功能，**When** 抽出前後跑同一份 fixture，**Then** 它寫出的列除 `_ingest.door`／`auth`／`credential`／`producer` 與收到時間外相同。
3. **Given** 一個會碰到基本路徑的來源（FR-020 表中標為「耦合」），**Then** 它的程式碼不搬，只有 manifest、預設與啟動時機改變。

### User Story 2 — 選用來源預設關閉、只在需要時跑（P1）

**Why this priority**：E6；13 號審查的背景成本（受管 mitmdump 常駐、CDP 每 3 秒輪詢、瀏覽器關後仍輪詢）。

**Independent Test**：新安裝、新專案：斷言沒有 mitmdump 子行程、沒有 CDP 輪詢計時器、沒有 pty、沒有擴充功能主機行程；來源列為「已關閉」。啟用受管代理後：只有在專案開著時起 mitmdump；關專案即停。

**Acceptance Scenarios**：

1. **Given** 新機器，**When** 建立專案，**Then** 受管代理、擷取瀏覽器、內建終端機的列都是「已關閉」，整體為「等待第一筆事件」或「無可用來源」，導覽沒有終端機。
2. **Given** 操作者在設定 ▸ 擴充功能啟用內建終端機，**Then** 導覽出現終端機；之後所有專案都看得到它（機器層）。
3. **Given** 一個 `activation` 只有 `project-open` 的擴充功能，**When** 關閉專案，**Then** 它的行程在 5 秒內結束，不再有它的計時器。
4. **Given** 升級前某專案正在用受管代理，**When** 升級，**Then** 機器層的受管代理被設為啟用（遷移只打開「曾被使用過」的來源），擷取不中斷。

### User Story 3 — 擴充功能只能新增、蓋不住真相（P1）

**Why this priority**：E10 (1)(2)。

**Independent Test**：以一個惡意測試擴充功能嘗試：寫 `system` 種類、寫別人 `emits` 的種類、自填 `_ingest`、呼叫非寫入路由、在 manifest 宣告 `views`、以自己的事件冒充來源狀態。全部被拒並計數；狀態列與 HUD 不變。

**Acceptance Scenarios**：

1. **Given** 擴充功能送出 `emits` 以外的種類，**Then** `rejected`／`kind-not-allowed`，計數。
2. **Given** 擴充功能的憑證呼叫 `/api/recording`、`/api/export/*`、`/api/sanitize`、任何 `DELETE`，**Then** 403，沒有狀態改變。
3. **Given** manifest 含 `views` 而沒有在 `experimental` 中宣告（或 FR-096 選了 `reserved`），**Then** 載入失敗，錯誤 `views-reserved` 或 `experimental-not-declared`，該擴充功能的列「失敗」並說明。
4. **Given** 擴充功能回報 `captureError`，**Then** 只成為它自己那一列的理由；整體字、完整性、記錄狀態的計算不讀擴充功能提供的任何文字。

### User Story 4 — 換了任何一個檔案就要重新核准（P1）

**Why this priority**：E10 (4)；08 §1.5 與本規格「前提更正」：今天的雜湊不涵蓋被呼叫的檔案。

**Independent Test**：對 `files` 中的每一個檔案逐一改一個位元組、加一個未列出的檔、刪一個列出的檔：每一種都使下一次載入為「未設定・需要重新核准」，憑證撤銷，主機不啟動該擴充功能；主機載入的位元組是核心驗過的那一份（TOCTOU 測試：驗證後、載入前替換檔案，載入的仍是驗過的位元組，或載入中止）。

**Acceptance Scenarios**：

1. **Given** 已核准的 c2-tailers 類擴充功能，**When** 它 `require` 的 `parse.js` 被改，**Then** 停錄並顯示「內容已變更，需要重新核准」；不是靜默繼續。
2. **Given** 內建擴充功能的打包檔被改（例如 `resources/plugins/pcap-capture/pcap-parse.js`），**Then** 與建置時產生的雜湊清單不符，該擴充功能為「失敗」，理由「內建檔案與此版本不符」。
3. **Given** app 更新使一個內建擴充功能的雜湊改變，**When** 開專案，**Then** 寫一列 `system:extensions_active`，列出新舊雜湊；不需要操作者核准（內建由 app 簽章涵蓋）。

### User Story 5 — 來源屬於機器，專案決定綁定（P1）

操作者在這台機器上裝了 zsh 與 bash 的 hook，啟用了 pcap。開任何專案都不需要再啟用一次。開專案 A 後新開的 pane 在第一次被綁定時，提示字元下印一行「→ A」；他在私人 pane 打 `redlog private`，那個 pane 從此不記，也不留下存在的痕跡。

**Why this priority**：E5、E8；14 號審查 D(4)：每個 hook shell 在專案開著時都被記錄，私人 pane 也是。

**Independent Test**：(a) 機器層啟用一次後，建立三個專案，三個都不需要啟用動作；(b) 終端機狀態表：{從未綁定、已綁定} × {`redlog private`、`redlog stop`} × {A 開、B 開、無專案}，斷言送出的項目、計數與提示行；(c) 第一次綁定的提示行每個 shell 只出現一次，且只在 prompt 時，不在 shell 初始化期間。

**Acceptance Scenarios**：

1. **Given** zsh hook 已裝、A 開著，**When** 開一個新 pane 並打第一條指令，**Then** 下一個 prompt 前 stderr 有一行指出專案 A 與 `redlog private`；之後不再印。
2. **Given** 從未綁定的 pane，**When** 打 `redlog private`，**Then** 該 pane 不送 `hello`、不送任何項目、不寫交接檔、不計數。
3. **Given** 已綁定 A 的 pane，**When** 打 `redlog private`，**Then** A 收到一列 `capture_stopped{reason:"private"}`，之後該 pane 的指令一筆都不送。
4. **Given** 機器層停用 pcap，**Then** 所有專案的 pcap 列為「已關閉」，憑證撤銷（071 FR-076）。

### User Story 6 — AI 工作階段明確地屬於某個專案，可以改（P1）

**Why this priority**：R1。AI 工具的工作階段不像 shell 一樣在開啟時就綁定到開著的專案；同一個工作路徑可能先後服務兩個任務。

**Independent Test**：兩個專案選了重疊的工作路徑：一個工作階段只被記到認領它的專案；在另一個專案按「記錄到這個專案」，之後的回合寫到新專案，兩邊各有一列 `system:session_rebound`，舊專案已寫的列不動。

**Acceptance Scenarios**：

1. **Given** Claude Code adapter 在這台機器啟用，**When** 新專案沒有選工作路徑或工作階段，**Then** 該列為「未設定」，理由「此專案未選擇工作階段」；AI 工具有活動時理由為 `in-use-not-recorded`（#703），不進需要處理。
2. **Given** A 已認領工作階段 S，**When** 在 B 選擇 S，**Then** B 的列出現「S 目前記錄到 A」與一個動作「記錄到這個專案」；按下後 S 之後的回合寫入 B。
3. **Given** S 已改綁到 B，**When** 之後開 A，**Then** A 寫一列 `system:session_rebound{to:"other-project"}`，時間為改綁時刻；A 不再讀 S。

### User Story 7 — 終端機裡就能完成控制（P2）

**Why this priority**：14 號審查 B.3：安裝版沒有 `redlog-cli`；shell 函式只有 `status/start/stop/mode/class`。13 號審查 U5：同一動作三種實作。

**Independent Test**：對每個動詞，以 mock receiver 與真的核心動作函式各跑一次，斷言 `--json` 輸出與 app 的同一動作（IPC）回傳的型別化結果相同；每個錯誤碼一個案例；在沒有 Node 的容器中執行（POSIX）。

**Acceptance Scenarios**：

1. `redlog status` 印這個 shell 的狀態字、綁定的專案、出口（位址與讀取時間，或「未知」）、範圍摘要、最近一筆事件距今；`--json` 為 075 payload 中該來源的一項加上這三個欄位。
2. RedLog 沒開時，每個動詞回錯誤碼 `not-running`，結束碼 3；沒有專案時 `no-project`（4）；被拒時 `denied`（5）。
3. `redlog mark "開始打 10.0.0.5"` 寫一列標記，與 app 的標記同一個核心函式（13 號 U1），結果中帶事件 id。
4. `redlog export --since 14:00 --format csv` 輸出對齊列格式（FR-084），經與 app 相同的匯出計畫器。

### User Story 8 — 為 v1 寫的擴充功能在後續版本繼續可用（P2）

**Why this priority**：R3。

**Independent Test**：相容測試組：以 v1.0 的範例擴充功能對「目前版本的主機」跑一致性測試；改動 schema 或 API 宣告而不改版本號時，golden 測試失敗；宣告 `engines.redlogExtensionApi: ">=2"` 的擴充功能在 v1 主機上得到固定的狀態與理由。

**Acceptance Scenarios**：

1. **Given** 擴充功能用了一個被標為棄用的欄位，**Then** 照常運作；它的列理由帶「使用已棄用的介面」，不改狀態、不進需要處理；`extension check` 印出警告與移除版本。
2. **Given** 擴充功能要求的 API 主版本高於主機支援的，**Then** 它的列為「無法使用」，理由 `api-too-new`；不啟動、不發憑證；若它是外部行程且仍在送，每一項 `rejected`／`credential-revoked` 並計數。
3. **Given** 擴充功能要求的 API 主版本已退役，**Then** 「無法使用」，理由 `api-retired`；同上。

### User Story 9 — 讓別人做自己的工具（L0，P2）

一位操作者寫了自己的小工具：讀 RedLog 裡的指令事件，畫出他自己想要的時間表。他把它裝成一個擴充功能：宣告它要讀的種類家族與欄位層級；在活動紀錄的列動作中多一個「在我的工具中開啟」；他的工具以 `redlog://event/<id>` 把他帶回 RedLog 的那一列。

**Why this priority**：R4。多數「我要自己的工具」不需要在 RedLog 裡執行第三方介面程式碼。

**Independent Test**：以宣告 `reads: {families:["commands"], levels:["meta"]}` 的測試擴充功能：讀取只回傳 `commands` 家族、只含 meta 欄位；每分鐘至多一列 `system:extension_read`，其中的列數與事件 id 雜湊等於實際回傳；貢獻的指令只在宣告的位置出現；深連結開啟對應事件，從不執行動作。

**Acceptance Scenarios**：

1. **Given** 擴充功能只宣告 `meta`，**When** 查詢含指令輸出的事件，**Then** 回應不含 `command`、輸出或任何內容欄位。
2. **Given** 被標為不得匯出（`do_not_export`）的列，**Then** 讀取 API 不回傳它，回應帶「排除 N 筆」。
3. **Given** `redlog://event/<不存在的 id>` 或格式錯誤，**Then** RedLog 只顯示「找不到這筆事件」，不做其他事。

### User Story 10 — 上傳外掛把對齊的資料送到 app 之外（P3）

**Why this priority**：E7、E9；14 號審查 D(6) 的七條最小可信形狀。

**Independent Test**：以假收集端：預設只送 meta 層級；每一批在送出前上鏈一列 `system:export_shipped`；被標為私人的列不送；核准對話框列出目的地、層級與「送出後無法收回」。內容層級在遮蔽前提成立前無法啟用。

**Acceptance Scenarios**：

1. **Given** Exporter 已核准、在專案 A 開啟，**When** 送出一批，**Then** A 的鏈上先有一列 `system:export_shipped`（擴充功能、目的地、層級、列數、事件 id 範圍與清單雜湊），再交給擴充功能。
2. **Given** 送出失敗，**Then** 那一列仍在（記的是「交出了」），另寫一列 `system:export_failed`；不重送已交出的批次，除非操作者明確重送。
3. **Given** 遮蔽前提的規格尚未落地，**When** 嘗試啟用 `command` 或 `content` 層級，**Then** 拒絕，理由「匯出尚未套用遮蔽」。

### User Story 11 — 擴充功能作者在本機就能驗證（P3）

**Independent Test**：`redlog-cli extension init --kind source|processor|exporter` 產生的骨架直接通過 `extension check` 與 `extension test`；故意寫錯的 manifest 得到 JSON pointer、期望值與實際值。

**Acceptance Scenarios**：

1. `extension check` 重算 `files` 的雜湊，列出不符、缺少、多出的檔案。
2. `extension test` 使用 071 的共用向量、mock receiver，以及本規格的主機模擬器，輸出與 CI 相同格式的結果列，可直接併入相容矩陣。

### Edge Cases

- 主機行程當掉：核心以 1、2、4、…、60 秒退避重啟；10 分鐘內第 5 次失敗後停止重啟，該列「失敗」並帶理由與動作「重新啟動」。已送達的項目已 commit；在途項目由 071 的序號帳以 `ended-unclean` 計入，不打斷操作者、不跳對話框。
- 主機行程超過記憶體上限（預設 512 MiB）或在 `deactivate` 後 5 秒仍未結束：核心終止它，理由「超過資源上限」或「未正常結束」。
- 兩個擴充功能宣告同一個 `producer` 或同一個 `id`：後載入者為錯誤；內建 id 保留。
- 擴充功能被移除，它寫過的列仍在專案中：種類沿用最後一次已知的宣告，閱讀器與標題不刪除（072 的規則）；狀態列不再列出它，但「本專案寫過它的列」的事實保留在擴充功能詳情。
- 擴充功能 manifest 宣告 `runtime: core`：非內建者一律錯誤；內建者必須在允許清單內。
- 主機要求的 Electron 能力在某平台不可用（`utilityProcess` 啟動失敗）：所有 `host` 擴充功能為「無法使用」，理由「擴充功能主機無法啟動」；`external` 與 `core` 的不受影響。
- 沒有開著的專案時，`activation: project-open` 的擴充功能不跑；`machine-enabled` 的照跑，但它送的項目依 071 進交接目錄或回 `retry`／`no-project`。
- 暫停中：擴充功能依 071 在觀察點檢查暫停（主機 API `recording.isPaused()`）；暫停的判斷規則以 071 修訂中的 FR-080–084 為準，本規格不另定。
- 第一次綁定時 shell 的 stderr 不是終端機（被重導）：不印提示行，事實照記。
- `redlog private` 之後的 pane 執行 `redlog start`：恢復記錄；若該 pane 從未綁定，視同新 pane 的第一次綁定（提示一次）。
- AI 工作階段的工作路徑同時被兩個專案選擇且兩者都沒認領過：第一個實際讀到該工作階段的專案認領它；另一個專案的列顯示「S 目前記錄到 A」。
- Exporter 宣告的目的地與實際連線不同：不可強制（同使用者行程，見 Assumptions）；鏈上的紀錄寫的是「宣告的目的地」並明說。
- 深連結在 RedLog 沒開時被點：開啟 app；若事件屬於未開啟的專案，顯示專案名與「開啟此專案」，不自動切換。

## Requirements *(mandatory)*

### Functional Requirements

#### A. 擴充功能是什麼（E1、E2、R3）

- **FR-001** 擴充功能是一個資料夾，含一份擴充功能 manifest（`extension.json`，`extensionManifest: 1`）與 manifest `files` 列出的每一個檔案。manifest 的每個欄位、型別、預設值與它的讀者，見 [契約 §2](contracts/extension-api-v1.md)。
- **FR-002** `kind` 恰好一種：`source`、`processor`、`exporter`。需要多種就做成多個擴充功能。
- **FR-003** `runtime` 恰好一種：`external`、`host`、`core`。`core` 只接受內建且列在 `BUILTIN_CORE_RUNTIME` 允許清單（plan「允許清單」）中的 id，每項附理由；`processor` 沒有 runtime（它是核心解讀的資料）。
- **FR-004** 內建擴充功能隨 app 附帶，由 app 簽章涵蓋，不需逐一核准；每個內建擴充功能可在機器層停用，除非它在基本層（FR-020）。內建 id 保留，安裝的擴充功能不得使用。
- **FR-005** 安裝的擴充功能只能從本機資料夾安裝（`redlog-cli extension install <dir>` 或設定頁選資料夾），複製到 `~/.redlog/plugins/<id>/` 後核准。沒有任何從網路下載、搜尋或更新擴充功能的程式路徑（E10 (5)）。
- **FR-006** 今天的 `plugin.json`（v1）照讀，轉譯為擴充功能 manifest 的內部形狀；轉譯規則與 Spec 075 FR-070 相同（`capture`＋規則拆成 Source 與 Processor，共用 id 與核准）。v1 的雜湊算法保留給 v1 manifest；既有核准不失效，但 v1 的使用者 Source 在改寫成 v1 擴充功能 manifest 前，只能以 `external` 執行，且狀態列帶理由「舊格式：雜湊未涵蓋全部檔案」。

#### B. 核心保留什麼（E3、R2）

- **FR-010** 核心擁有且不提供任何擴充點的：寫入入口與接收端蓋章（071）、雜湊鏈與簽章、儲存、查詢（074）、來源狀態的計算（075）、閱讀器（072）、驗證、匯出計畫與封存、出口讀取與蓋章（071 FR-120）、範圍評估、寫入路徑上的遮蔽偵測（071 FR-091）、記錄狀態與暫停、HUD。擴充功能只能經契約提供事實（存活、擷取錯誤、遺失計數）與資料（Processor）。
- **FR-011** 任何擴充功能提供的字串（`label`、錯誤訊息、設定標題）只出現在它自己的列、詳情、它貢獻的指令、分隔線下它的導覽項目與 L2 面板的核心標題列上；不出現在整體字、完整性、記錄狀態、HUD、標題列，也不作為任何狀態計算的輸入。

#### C. 基本層與擴充功能層（R2）

- **FR-020** 每個今天存在的擷取或相關功能屬於兩層之一。下表是本規格的分層決定；每一列的程式碼證據在 plan「耦合證據」。

  | 功能 | 層 | 本規格內的變化 | 程式碼搬動 |
  |---|---|---|---|
  | 寫入入口、蓋章、鏈與簽章、儲存、查詢、狀態計算、閱讀器、驗證、匯出封存 | 基本 | 無 | 不搬 |
  | Shell hook 的接收路徑與 hook 安裝（zsh、bash、PowerShell、WSL、relay、session recorder） | 基本 | 每個 shell 的 adapter 仍可個別安裝與移除（073 帳本）；整個類別不可停用 | 不搬（hook 本來就在操作者的 shell 裡執行） |
  | AI 工具擷取（`agent-tailer`、`tailer-host`、官方 adapter） | 基本 | adapter 的啟用改為機器層；工作階段選擇維持逐專案（R1） | 不搬（寫入前遮蔽與行程內入口在 `tailer-host.ts:567` 等處，搬動會碰證據路徑） |
  | HTTP 的接收路徑（http 種類的入口、body 儲存、`/api/http-verify`、HAR） | 基本 | 無 | 不搬 |
  | 標記、快捷鍵截圖、加入證據檔 | 基本 | 無 | 不搬；週期截圖已裁定刪除，與快捷鍵截圖共用 `screenshot-agent`，刪除時拆開 |
  | HUD、出口／VPN／opsec 監看 | 基本 | 出口改為蓋進每一列（071 修訂） | 不搬 |
  | `builtin-tools`（工具知識、目標擷取規則） | 基本（資料） | 檔案格式改為 Processor 擴充功能 manifest，但不可停用（`electron-builder.yml:27-31` 的註解：缺了它目標擷取會無聲失效） | 不搬 |
  | `pcap-capture`、`c2-tailers` | 擴充功能（內建，`external`） | 改寫成擴充功能 manifest，`files` 涵蓋全部檔案；預設關閉 | 不搬（本來就在行程外） |
  | `hooks/pcap-agent.py` | 擴充功能（內建，`external`） | 併入 `pcap-capture` 擴充功能，同一組種類（08 §3e） | 後期 |
  | 受管 HTTP 代理（`managed-http-proxy.ts` 的監督者、`mitmproxy-addon.py`） | 擴充功能（內建，`core`） | 預設關閉；只在專案開著且啟用時起 mitmdump | 監督者暫不搬（見 FR-022） |
  | 擷取瀏覽器（`launchCaptureBrowser`、`cdp-connector.ts`） | 擴充功能（內建，`core` → 後期 `host`） | 預設關閉；瀏覽器結束即停輪詢 | 後期搬到主機（需要 071 契約 1） |
  | 內建終端機（`terminal-manager.ts`、node-pty） | 擴充功能（內建，`core`） | 預設關閉；導覽只在啟用時出現 | 不搬（見 FR-022） |
  | 主機監看（行程、連線、檔案） | 擴充功能（內建，`core`） | 預設關閉（今天已是） | 不搬，直到耦合解除（FR-022） |
  | `transparent-proxy` | — | 移除（DECISIONS §5「停止做的事」） | 刪除 |
  | 剪貼簿監看、週期截圖、指令完成截圖 | — | 已裁定刪除（根因審查 §4 第 7 項）；不轉換 | 由刪除變更處理 |
  | Exporter／上傳外掛 | 擴充功能（只能安裝，`host` 或 `external`） | 新增（H 段） | — |
  | AI 工具整合（`agent-tools` 憑證的 MCP 工具） | 外部用戶端，不是擴充功能 | 無（071 O13） | — |

- **FR-021** 基本層的功能沒有「整類停用」的開關，也不經擴充功能的生命週期；它們的來源描述由核心直接提供（075 FR-002 的核心描述表），與擴充功能 manifest 產生的描述合成同一份清單。
- **FR-022** 一個擴充功能的程式碼只在下列條件全部成立時才從 main 搬到主機或外部行程：(a) 它不 import 寫入入口以外的核心寫入原語（`configureIngest`、`getDB`、`insertEvent`、`ingestEvent`）；(b) 沒有基本層的模組讀它的狀態；(c) 它寫的種類只經 071 契約 1 寫入；(d) 搬動帶來可量測的收益（主執行緒喚醒、崩潰隔離）。今天的耦合（plan「耦合證據」）：
  - 內建終端機：`terminal-manager.ts:7,11,13,19` import `configureIngest`、`getDB`、`configureBuiltinTerminalHealth`、`indexCast`；`builtin-terminal` 字面值在 `src/core`、`src/main` 出現 32 處（071 FR-012 處理）；keystroke 經 pty 的延遲不允許多一跳。結論：不搬，以 `runtime: core` 留在允許清單。
  - 主機監看：`process-monitor`、`connection-monitor` 餵 `socket-attribution`，而 `core/ingest.ts` import `socket-attribution`（HTTP 的行程歸屬在寫入路徑上）。結論：不搬，直到 13 號審查 U4（單一 socket 表）把這條依賴改為核心擁有的事實。
  - 受管代理：監督者只管生命週期，寫入走 addon 的 HTTP；`core/http-autostart.ts` 只 import 型別。可搬，但沒有可量測的收益（它不在主執行緒上輪詢）。結論：本規格不搬。
  - 擷取瀏覽器：`cdp-connector.ts:3,176,381` 以行程內 `ingestEvent` 寫入、每 3 秒輪詢（13 號 C.1 #19）。結論：071 契約 1 落地後搬到主機（tasks Phase 8），是第一個搬動的內建擴充功能。
- **FR-023** 每個抽出步驟在合併前後都通過基本路徑釘住測試組（T002–T007）；Phase 3 之前不搬任何寫入路徑上的東西。

#### D. 擴充功能主機與啟動（E1）

- **FR-030** 每個 `runtime: host` 且已啟動的擴充功能在自己的 Electron `utilityProcess` 中執行，由 main 中唯一的啟動模組建立（`src/main/extension-host/launcher.ts`）。主機行程不開資料庫、不讀專案檔案、不 import 核心模組；它只載入擴充功能 API 的執行期（`src/extension-api/runtime/`）與該擴充功能的程式碼。
- **FR-031** 主機載入的程式碼是核心讀出、驗證過雜湊後經 MessagePort 交給主機的位元組；主機不從磁碟路徑 `require` 擴充功能的檔案。擴充功能的程式碼是一個打包好的入口檔（`main`），加上列在 `files` 中的資料檔；入口檔以外的 JS 模組不被載入。
- **FR-032** 啟動事件為封閉清單（契約 §3.4）：`machine-enabled`、`project-open`、`binding:<terminal|session>`、`operator-start`、`export-due`。沒有任何啟動事件成立時，該擴充功能沒有行程、沒有計時器。
- **FR-033** 生命週期：`activate(ctx)` 有 10 秒時限；`deactivate()` 有 5 秒時限，逾時即終止。崩潰時依 Edge Cases 的退避重啟。每次啟動是 071 的一個新 instance（新的 `hello`），前一個 instance 若無 `bye` 依 071 結算為 `ended-unclean`。
- **FR-034** 資源上限：每個主機行程的 V8 heap 上限預設 512 MiB（契約 §4.6）；超過時終止並記理由。擴充功能不得建立子行程以外的主機行程；`external` 的擴充功能不受主機限制（它們在操作者的控制下執行）。
- **FR-035** 主機中的擴充功能寫入時，經迴路位址的 `POST /api/ingest`，以 071 的 `plugin:<id>` 憑證；憑證在 `activate` 前由 main 經 MessagePort 交給主機的執行期，從不出現在 argv、環境變數或擴充功能可讀的檔案中。擴充功能的程式碼拿不到憑證本身，只能呼叫 `ctx.ingest`。
- **FR-036** 主機或擴充功能的任何失敗都不打斷操作者：不跳對話框、不阻塞 UI、不阻塞其他來源；只改變該列的狀態與理由，並由 071 的遺失帳本計數。

#### E. 機器層級的來源與專案層的綁定（E5、E8、R1）

- **FR-040** 「在這台機器上啟用」是 `~/.redlog/machine.yaml` 中 `extensions.<id>.enabled`（布林，Spec 073 的機器層設定），預設值取自 manifest 的 `defaultEnabled`；E6 的三個來源為 `false`。核准紀錄（雜湊）在 `~/.redlog/plugins/trust.json`；憑證依 071 FR-072 在機器層第一次啟用時發放，停用即撤銷（071 FR-076）。
- **FR-041** 專案層只保存：範圍（073）、綁定（終端機的 pin，073 FR-040；AI 工作階段的選擇，FR-045）、暫停（071／073）。專案設定中出現的來源啟用鍵（今天的 `packs.<id>`、`packMembers`）讀到時轉為機器層的初值（FR-047），之後忽略；不從使用者的檔案刪除。
- **FR-042** 綁定是擷取的邊界，不是來源的開關（14 號審查 D(4)）：一個機器層啟用的來源，只有綁定到開著專案的資料流才會寫入該專案。
- **FR-043** Shell 第一次綁定到某個專案時，hook 在下一個 prompt 前於 stderr 印恰好一行，含專案名稱與 `redlog private`；每個 shell 每個專案至多一次；shell 初始化期間不輸出（071 O10）；stderr 不是終端機時不印。這是來源端的行為，向量在 071（071 FR-086）。
- **FR-044** `redlog private`：從未綁定的 shell 從此不綁定、不送任何項目、不計數；已綁定的 shell 送一列 `capture_stopped{reason:"private"}` 後停止，之後不逐指令計數。`redlog start` 撤銷它。這是來源端行為（071 FR-087）。
- **FR-045** 資料流不天然綁定專案的來源（今天只有 AI 工具的工作階段）在 manifest 或核心描述中宣告 `binding: "explicit"`。它們的專案層選擇（工作路徑、選取的工作階段、`startedAt`）保留在專案設定的 `agentTailer.sources.<kind>`（073 F 段修訂）；機器層有一份工作階段認領索引（`~/.redlog/session-claims.json`，0600，原子寫入），一個工作階段同時只被一個專案認領。
- **FR-046** 重新綁定是一個明確動作（「記錄到這個專案」）：把認領從原專案移到開著的專案，在開著的專案寫一列 `system:session_rebound{session, from, at}`；原專案下次開啟時寫一列 `system:session_rebound{session, to:"other-project", at}`。已寫入原專案的列不動。
- **FR-047** 遷移：升級後第一次啟動時，任何專案的設定中「曾被使用」的選用來源（受管代理有過 HTTP 列、擷取瀏覽器有過 `browser` 列、內建終端機有過 session、pack 為開），在機器層設為啟用，並寫一份遷移報告到設定頁的擴充功能區；其餘選用來源維持預設關閉。AI adapter：有效的安裝收據 → 機器層啟用（方式 `migration`），各專案的選擇原樣保留。

#### F. 終端機的動作契約（14 號 B.3、13 號 U5）

- **FR-050** 每個操作者動作在 `src/core/actions/` 有恰好一個函式與一個型別化結果（`ActionResult<T> = {ok: true, value: T} | {ok: false, error: ActionError}`）。IPC、HTTP API、`redlog`（shell）、`redlog-cli` 只做身分驗證與序列化。本規格涵蓋的動作：`status`、`pause`、`resume`、`mark`、`private`（來源端，不經核心）、`last`、`export`、`doctor`。
- **FR-051** `ActionError` 為封閉列舉：`not-running`（3）、`no-project`（4）、`denied`（5）、`invalid`（2）、`busy`（6）、`failed`（1）；括號內是 shell 動詞的結束碼。`--json` 在錯誤時輸出 `{ok:false, error, message}`，結束碼相同。
- **FR-052** `redlog status` 的資料是 075 payload 中呼叫者來源的一項（071 FR-07B），加上 `binding`（專案 id 與名稱）、`egress`（071 FR-122 的形狀）、`scope`（範圍內／外目標數）、`last_event_at`。人類可讀輸出每項一行；任何未知的值印 `unknown`，絕不印 `safe` 或同義字（075 FR-025）。
- **FR-053** `pause`、`resume`、`mark`、`last`、`export` 需要操作者憑證（071 FR-070 的 `control`、`append(marker)`、`read`、`export`），由 shell 函式在操作者輸入該動詞時讀 `~/.redlog/credentials/operator`；hook 的自動路徑從不讀它（071 O1 的範圍不變：hook 的憑證只能寫入）。
- **FR-054** `last [N] [--since T] [--until T]` 回傳最近 N 筆（預設 20）的對齊列（FR-084）；有上限時回應帶總數，人類可讀輸出最後一行寫「顯示 N／共 M」（有上限的檢視不得看起來完整）。
- **FR-055** `doctor` 只讀：hook 是否載入（本 shell 的 `hello` 是否被接受）、憑證檔權限、交接目錄計數、隔離數、與 app 的版本是否相容、最近 100 條指令的 hook 延遲中位與 p95（14 號 F #10）。
- **FR-056** 動詞在 POSIX hook（以 python3 的 relay 做格式化與 HTTP）與 PowerShell hook 中實作；不需要 Node。`redlog-cli` 是開發者工具，保留但不打包；`docs/USER-GUIDE` 改寫為以 `redlog` 為主（tasks）。
- **FR-057** API 的匯出（`/api/export/*`）與 `redlog export` 走與 app 相同的匯出計畫器（13 號 U5、A.4）；回應帶「排除 N 筆」。

#### G. 五個不可照搬的硬性要求（E10）

- **FR-060（只能新增）** 擴充功能的唯一寫入能力是 071 契約 1 的 `append`，種類範圍恰好是 manifest 的 `emits`；接收端蓋上 `_ingest.producer = plugin:<id>`。擴充功能 API 沒有更新、刪除、修訂、簽章、遮蔽、清除、匯入的呼叫。`plugin:*` 憑證對每一條非寫入路由得到 403（071 FR-070 路由能力表擴充）。
- **FR-061（蓋不住真相）** 擴充功能不能宣告或提供：狀態字、整體字、完整性、記錄狀態、HUD 內容、標題列、對話框、通知。它對狀態的唯一影響是 075 FR-010 的具名事實（`lastAlive`、`captureError`、`loss`）。manifest 的 `views`（L2）依 FR-096：`reserved` 時載入即拒絕；`experimental` 時只在宣告了 `"views"` 且核准點名面板能力時載入，並受 FR-095 的限制。
- **FR-062（讀取授權並留紀錄）** 讀取需要 manifest 的 `reads` 宣告（種類家族與欄位層級）並在核准時顯示；每個擴充功能每分鐘至多一列上鏈的 `system:extension_read` 彙總它在那一分鐘的全部讀取；Exporter 每一批一列 `system:export_shipped`，在交給擴充功能**之前**寫入。沒有 `reads` 的擴充功能讀不到任何事件。
- **FR-063（更新需重新核准）** 內容雜湊 = sha256（正規化 manifest ‖ 依路徑排序的 `files` 每一項的路徑與位元組）。`files` 必須列出資料夾中的每一個檔案；未列出的檔案、缺少的檔案、雜湊不符都使載入失敗。核准時釘住；每次載入、每次啟動前、每次執行步驟或發放憑證前重算。不符時：「未設定・需要重新核准」，憑證撤銷，主機不啟動。內建擴充功能另以建置時產生的雜湊清單（`out/extensions-builtin.json`）在每次載入時比對。
- **FR-064（沒有市集）** 程式中沒有擴充功能的網路來源、清單、搜尋、更新檢查或自動安裝；gate 掃描 `src/**` 中與擴充功能安裝相關的模組不得 import 任何網路模組。
- **FR-065** 每個專案在 session 開始時、以及生效集合改變時，寫一列上鏈的 `system:extensions_active`，列出生效的擴充功能 `id@版本#雜湊前 12 碼`（FR-008 之決定 8）。

#### H. Exporter（E2、E7、E9）

- **FR-070** Exporter 在 v1 是 `experimental`（契約 §6）：manifest 必須在 `experimental` 中列出 `"exporter"`，否則載入失敗。
- **FR-071** Exporter 的啟用是**逐專案**的明確動作，預設關閉（它不是擷取來源，E5 不適用）；核准是機器層。核准對話框由 main 以原生對話框顯示：擴充功能 id、版本、雜湊前 12 碼、宣告的目的地（主機、埠、協定）、欄位層級、頻率，以及固定一句「送出的資料無法收回」。
- **FR-072** 送出的選取 = 目前專案中：未被標為不得匯出或私人的列，且通過個人流量規則（073 FR-01B）；`command` 與 `content` 層級另外要求「匯出套用遮蔽」已成立。**「匯出套用遮蔽」是本規格的前提，不在本規格設計**：今天四種匯出預設不套用寫入時算出的 span（11 號報告摘要 1）；它由後續的「交付邊界與內容生命週期」規格擁有（11 號報告建議的規格，尚未編號）。在它落地前，只有 `meta` 層級可以啟用。
  > **指標（2026-11-13）**：「交付邊界與內容生命週期」規格是 [Spec 077](../077-personal-content-and-delivery/spec.md)；本條的「選取」在 077 中為交付狀態 `deliver` 的列（077 FR-070），Q4 的解鎖條件是 077 FR-074；Exporter 是 077 匯出面目的地選單中的一項（077 FR-033）。
- **FR-073** 欄位層級：`meta`（UTC 時間、本機時區偏移、出口、操作者、終端機（tty／pane）、主機、使用者、目標、種類、結果碼、事件 id、鏈位置）；`command`（加上指令列）；`content`（加上輸出與內容）。預設 `meta`。
- **FR-074** 每一批：核心依選取與層級產生對齊列（FR-084），先寫 `system:export_shipped{extension, destination, level, count, first_event_id, last_event_id, ids_sha256, batch_sha256}`，再經主機 API 交給擴充功能；擴充功能回報結果後寫 `system:export_failed`（失敗時）。擴充功能讀不到批次以外的任何資料。
- **FR-075** 收集端是衍生物，從不是證據：對齊列帶事件 id 與鏈位置，讓收集端的任何一列都能回到操作者本機的簽章紀錄（14 號 D(6) 第 1 條）。

#### I. 對齊列格式（E9）

- **FR-084** 「對齊列 v1」是 Exporter、`redlog last`、`redlog export --format csv|ndjson` 與 app 的 CSV 匯出共用的列格式（欄位見契約 §7）：`time_utc`（ISO 8601，毫秒，`Z`）、`tz_offset_min`、`egress`（位址或空）、`egress_read_at`、`egress_state`、`operator`、`host`、`user`、`terminal`（tty 或 pane）、`target`、`kind`、`command`（層級允許時）、`result`、`event_id`、`chain_seq`。欄位順序固定；未知值為空字串，不寫猜測值。新增欄位只能附加在尾端（契約 §5 的相容規則）。

#### J. 讓別人做自己的工具（R4）

- **FR-090** 三個層級與 v1 的穩定度：

  | 層 | 是什麼 | v1 | 理由摘要（完整論證見下方小節） |
  |---|---|---|---|
  | L0 外部工具 | 讀取 API（074 的查詢契約、內容與完整性、變更主題）＋貢獻的指令＋深連結 `redlog://event/<id>` | **stable**（`meta` 層級）；`command`、`content` 層級為 `experimental`，遮蔽前提落地後升為 stable | 不在 app 內執行第三方介面程式碼；讀取可授權、可稽核 |
  | L1 宣告式檢視 | 擴充功能的種類自動得到活動紀錄的篩選與 072 的閱讀器；由核心繪製 | **stable**，只有自動的部分；manifest 沒有額外的 L1 欄位 | 072 FR-036、075 已隱含；多一個欄位就是多一份承諾，目前沒有需要它的擴充功能 |
  | L2 沙箱面板 | 擴充功能自己的介面程式碼在隔離的面板中執行（程式編輯器的 webview 模式），經稽核的讀取 API 取得資料，與核心雙向連動 | 由 FR-096 的一行決定；本規格建議 **experimental**（manifest 選用＋逐擴充功能核准，無穩定承諾），替代為 **reserved** | 拓撲圖、矩陣是可信的真實需求（擁有者，2026-11-13）；風險是偽造真相介面與資料外流，由 FR-095 的限制處理 |

- **FR-091（L0）** 讀取 API 為 `GET /api/v1/query`（074 的查詢契約，同一個 `parseQuery`）、`GET /api/v1/events/<id>`（內容與 072 的完整性事實）、`GET /api/v1/topics`（074 的變更主題，SSE）。每個請求以擴充功能的 `plugin:<id>` 憑證帶 `read` 能力，範圍為 manifest `reads`；超出範圍的家族或層級在伺服端過濾（不是拒絕），回應帶「排除 N 筆」。
- **FR-092（L0）** 貢獻的指令：manifest `commands[]` 宣告 `id`、`title`、`where`（`palette`、`row-action`）、`kinds`（只在這些種類的列上出現）、`run`（`open-url` 的 URL 範本或 `exec` 一個列在 `files` 中的程式），參數只能代入 `{eventId}`、`{projectId}`；不能代入內容。執行前顯示一次（每個指令每台機器一次）要開啟的程式或網址。
- **FR-093（L0）** 深連結 `redlog://event/<id>`、`redlog://project/<id>`：只做導覽（開啟專案選擇或定位事件），從不執行任何動作、不帶任何參數以外的內容；id 不合格式時只顯示「找不到」。協定註冊是 app 自己的機器層設定，不是擴充功能貢獻。
- **FR-094（L1）** 擴充功能 `emits` 中宣告的種類，在活動紀錄的「篩選」選單中以擴充功能 label 為一組出現（固定篩選列不變，13 號 A.2 規則 1），開啟時用它宣告的 `reader`（072 的 `ReaderId`）或 `fields`。不需要也不接受任何其他 L1 宣告。
- **FR-095（L2）** `views[]` 的形狀在契約 §8 完整定義，沿用程式編輯器的 webview 模式：獨立 origin 的隔離 frame；沒有 node、preload、IPC，只有訊息；本機資源只經核心發出、以擴充功能自己資料夾為根的資源 URI；強制的 CSP（沒有遠端 script；沒有網路，除非擴充功能持有網路能力）；只開放非語意的主題 token 作為 CSS 變數；以小型 get／set 保存狀態；隱藏即銷毀，除非宣告保留。RedLog 另加的限制：
  1. **放置**：一個核准的面板擴充功能可以貢獻**一個導覽項目**，規則與內建終端機相同——只在擴充功能啟用且核准時出現；位於核心目的地之後的分隔線下方；名稱與標記由核心依 manifest 繪製（名稱＋固定集合中的一個標記，不接受自訂圖示）；使用者可以隱藏或重新排序分隔線下的項目；它有一個快捷鍵（取自擴充功能保留區；可重新對應要等鍵盤對應機制，見編輯器對照表的 keybindings）。核心目的地固定在分隔線上方，不能被隱藏、重新排序或模仿。面板也可以從貢獻的指令開啟。
  2. **第二種放置（替代檢視）**：面板可以宣告在既有核心頁上的一個 slot，作為同一份資料的另一種呈現（例如目標頁的「清單｜圖」）。**本規格建議 v1 不開放，slot 維持 reserved**：它要在核心頁上加一個切換控制（§26.3 一頁一個主動作），且讓擴充功能的像素出現在核心頁的內容欄內、與核心的真相介面相鄰；先以導覽項目驗證 L2 的限制，再決定。
  3. **畫面**：在內容欄內繪製，上方是核心繪製、不可隱藏的標題列（擴充功能名稱、「擴充功能提供」、雜湊前 12 碼）；核心的狀態讀數維持可見、位於 frame 之外；frame 不能全視窗、不能繪製覆蓋層、不能取得全域鍵的鍵盤焦點。
  4. **資料**：全部經 L0 的讀取 API（同一個 `reads` 能力、同一個稽核，FR-062）；**沒有任何寫入事件的路徑**。
  5. **雙向連動**（它存在的理由）：核心 → 面板 `selectionChanged(eventId|null)`、`rangeChanged({since,until}|null)`、`filterChanged(filter)`；面板 → 核心 `revealEvent(id)`、`setFilter(filter)`（只限操作者能手動設定的篩選）、`openReader(id)`。訊息的完整形狀在契約 §8.4。

  與 §26「不新增頁面」的關係：該規則約束的是**核心**；使用者自己安裝並核准的擴充功能所貢獻的項目屬於使用者；沒有安裝任何面板擴充功能時，導覽與今天的決定（DECISIONS §4）完全相同。
- **FR-096（L2 的 v1 等級，擁有者一行決定）**：**L2 的 v1 等級＝`experimental`**（替代：`reserved`）。選 `experimental` 時：manifest 必須在 `experimental` 列出 `"views"`；核准對話框另外點名「面板」能力；開放時間不早於 Phase 6（稽核的讀取 API 上線）；`reads.levels` 在遮蔽前提落地前只能是 `meta`；契約 §8.6 的 gate 全部存在。選 `reserved` 時：manifest 含 `views` 即載入失敗（`views-reserved`），開放條件為 (a) 一個真實的擴充功能無法以 L0／L1 做到；(b) FR-062 的讀取稽核與 FR-072 的遮蔽前提已上線；(c) 對契約 §8 的偽造面做過獨立審查；(d) §8.6 的 gate 全部為綠。
  **建議 `experimental`**：(1) 拓撲與矩陣不能以 L0／L1 做到——它們要的是與活動紀錄、時間軸的選取雙向連動，外部頁面只能單向（深連結回來）；(2) 面板只讀 `meta`、沒有寫入路徑、所有讀取已稽核，資料面的風險與 L0 相同；(3) 偽造面由核心繪製的標題列、frame 外的狀態讀數、不能覆蓋與全視窗、狀態字掃描處理；(4) `experimental` 沒有穩定承諾，若審查發現問題可以在次版本收回而不違反相容政策。

- **FR-097（核心應補的通用閱讀器）**：在 072 的 `ReaderId` 加四個通用閱讀器（072 的附加變更；指標已加在 072）。每一個都讓一類擴充功能不需要 L2：

  | 閱讀器 | 內容 | 不再需要 L2 的擴充功能 |
  |---|---|---|
  | `table` | 列與欄（有表頭的結構化結果） | 掃描結果匯入（主機／服務表）、C2 task 清單、戰利品與工作階段清單 |
  | `hex` | 位元組（含偏移與 ASCII 欄） | 封包內容、二進位 payload、C2 原始 task |
  | `diff` | 前後兩版文字 | 設定檔或系統檔變更、提權前後的檔案 |
  | `key-value` | 巢狀鍵值（可摺疊） | 憑證與工作階段紀錄、目錄服務物件屬性、結構化的 API 回應 |

  `image` 已在 072（截圖）；`fields` 是今天的通用格。

**可能的擴充功能與它們需要的層級**：

| 擴充功能 | 需要 | 說明 |
|---|---|---|
| 擷取來源（任何工具的 tailer、匯入器） | Source＋L1 | 種類自動得到篩選與閱讀器 |
| 設定表單 | `configuration`（K 段） | 核心繪製 |
| Exporter／上傳 | Exporter（H 段） | 不需要介面 |
| 戰利品、工作階段清單 | L1＋`table` 閱讀器 | — |
| 檢查清單（每場行動的步驟） | `setup[]` 或 L0 外部工具 | 首次使用清單由核心繪製 |
| AI 助手 | L0（讀取 API＋指令） | 在 app 外執行；讀取經稽核 |
| 特殊內容閱讀器 | FR-097 的通用閱讀器 | 不接受自訂閱讀器 |
| 拓撲／攻擊路徑圖、技術矩陣、活動熱圖 | L2，或 L0 的外部頁面＋深連結 | 雙向連動需要 L2 |
| 請求重送器（repeater） | 不在範圍 | DECISIONS §5 #4：RedLog 不當另一個代理 |
| 報告產生器 | 不在範圍 | 產品不做報告（記憶與根因審查 §4） |

#### 讓別人做自己的工具（論證）

| | L0 外部工具 | L1 宣告式檢視 | L2 沙箱面板 |
|---|---|---|---|
| 誰需要 | 想用自己的語言、自己的畫面看資料的人；想把 RedLog 接進自己流程的人（例如在自己的筆記工具裡點回事件）。多數「我要自己的工具」屬於這一層 | 寫了 Source 的人，希望他的事件在 RedLog 裡可被篩選與閱讀 | 要在 RedLog 內與選取雙向連動的視覺化：拓撲／攻擊路徑圖、技術矩陣、活動熱圖 |
| 核心要維持的承諾 | 一份讀取 API（就是 074 的查詢契約加權限過濾）、一個指令貢獻點、一個深連結格式；全部有版本 | 無新增：072 的閱讀器清單與 075 的種類宣告本來就要維持 | 一個面板宿主、六種連動訊息、資源 URI、CSP、標題列、分隔線下的導覽項目，以及「它不能做什麼」的長期保證；`experimental` 期間不承諾穩定 |
| 對證據紀錄器的特定風險 | 讀出的資料離開 RedLog 後不受控（工具可能送到雲端）；以授權、欄位層級、上鏈稽核與「排除 N 筆」緩解 | 幾乎沒有：核心繪製，擴充功能只提供資料與名字 | 偽造：一塊能任意繪製的區域可以畫出看起來像「記錄中」「鏈完整」的東西；資料外流：面板拿到的資料加上網路能力 |
| Gate | 讀取範圍測試（家族、層級、私人列）；`extension_read` 計數等於實際回傳；指令只在宣告位置出現；深連結不執行動作 | 外掛種類的篩選與閱讀器由登記表產生的測試（072 US5） | 契約 §8.6：沙箱與 CSP 快照、沒有 bridge、標題列與狀態讀數不被覆蓋的幾何測試、狀態字掃描、讀取稽核計數、導覽分隔線上方不可變的測試 |

**不變式（一次寫明）**：擴充功能從不碰 app 的 DOM；除了 L2 面板內部，每一個像素都由核心繪製。

**對照程式編輯器的每一種介面貢獻**（2026-11-13 擁有者追問「像編輯器那樣改介面呢？」；協調者提出的分級中有兩項依程式碼改判，標「改判」）：

| 編輯器的貢獻 | RedLog 的對應 | v1 | 理由 |
|---|---|---|---|
| commands | 指令面板與列動作，只在宣告的位置與種類出現（FR-092） | stable | L0 的核心；不在 app 內執行介面程式碼 |
| keybindings | 擴充功能為**自己貢獻的指令**提議一個預設鍵；與核心鍵衝突時不綁定 | experimental（**改判**，原提 stable） | 今天沒有使用者重新對應快捷鍵的機制：`src/renderer/src/lib/shortcuts.ts` 是一張靜態表，UIUX §19 要求快捷鍵只有一個來源。承諾 stable 等於要先建重新對應與衝突處理；在那之前只能試用 |
| colour themes | 不提供 | not offered（**改判**，原提 stable 限非語意 token） | 今天沒有任何主題系統（renderer 中沒有 `data-theme`、`prefers-color-scheme` 或主題設定）；開放主題等於新建一套 token 承諾來服務一個沒人要求的需求（§26.1）。若將來開放，限制照協調者所提：狀態色（記錄中、安全、警示、錯誤、強調）與種類符號不可改，載入時檢查對比，使「沒在錄」永遠不能看起來像「在錄」 |
| 活動紀錄篩選＋閱讀器（擴充功能自己的種類） | 自動產生（FR-094）；閱讀器只能從 072 的封閉清單選 | stable | 072 FR-036、075 已隱含；L1 |
| data-provider 清單（tree view） | 擴充功能提供列、核心以標準列欄位繪製；只在宣告的區域（該擴充功能的詳情，或活動紀錄中它的篩選組內），從不是新的導覽目的地 | experimental | 有用但會長大；§26：不新增頁面 |
| status-bar items | 不提供 | not offered | 狀態讀數是核心的真相介面（E10 (2)）；擴充功能的狀態只出現在它自己的來源列，由核心繪製 |
| webview panels／custom views | L2 沙箱面板（契約 §8）；一個分隔線下的導覽項目 | FR-096 的一行決定（建議 experimental） | 拓撲、矩陣需要雙向連動（FR-095） |
| 版面重排、移動面板、自訂核心導覽 | 不提供；分隔線下的擴充功能項目可由使用者隱藏與排序 | not offered（核心部分） | 單欄、核心導覽固定（§26、DECISIONS §4） |
| product icon themes | 不提供 | not offered | 種類符號是語意，不是裝飾 |
| custom editors | 不提供 | not offered | 紀錄不可編輯；閱讀器是封閉清單 |
| walkthroughs | Source 的 `setup[]` 步驟（前置條件、一個動作、終端機等效指令、以證據打勾），由核心畫進首次使用清單（契約 §2.5） | stable | 是資料、不是介面；首次使用清單本來就由 075 的狀態驅動（DECISIONS §4「首次使用」） |
| configuration | `configuration`（K 段、契約 §2.6）：核心在設定中該擴充功能的列下繪製一般設定列 | stable | 資料；擴充功能從不畫自己的設定介面（L2 也一樣） |

**建議（擁有者可一行接受或推翻）**：v1 開放 L0（`meta` 為 stable）與 L1（只有自動的部分，加 FR-097 的四個通用閱讀器）；L2 以 `experimental` 開放、只有導覽項目一種放置、只讀 `meta`，在 Phase 6 之後（FR-096）。

#### K. 擴充功能的設定（configuration，2026-11-13 擁有者追加；v1 stable）

- **FR-110** 擴充功能以 manifest 的 `configuration` 宣告設定（契約 §2.6）：型別為封閉清單 boolean、number（min／max／unit）、string（pattern）、enum（固定選項或核心提供的 `optionsFrom`）、path（file／dir）、list（string 或 path）、secret；每項一行標籤、至多 5 個同義詞，沒有說明段落（UIUX §26.4）。每個擴充功能軟上限 12 項，超過時載入照常、顯示警告。
- **FR-111** 核心在設定中該擴充功能的列下，把每一項繪成一般的設定列；擴充功能從不繪製自己的設定介面，L2 面板也一樣（不變式：擴充功能不碰 app 的 DOM）。不新增頁面或分頁。
- **FR-112** 每項宣告 `scope: machine` 或 `project`（恰好一個），儲存在 Spec 073 對該層的檔案中，以擴充功能 id 為命名空間（`machine.yaml` 的 `extensions.<id>.config`、專案 `config.yaml` 的 `extensions.<id>`）；擴充功能移除或降版後留下的未知鍵忽略、不刪除。
- **FR-113** 必填且沒有預設值的設定未填時：該擴充功能的來源列為「未設定」，唯一的列動作前往那個設定；同時成為一個宣告的首次使用清單步驟（`evidence`：該設定已通過驗證）。不跳出任何對話框。
- **FR-114** 核心在擴充功能看到值之前依 schema 驗證：設定頁輸入不合法的值時拒絕存檔，以與設定存檔失敗相同的單行失敗樣式顯示（#721 的模式；本規格未開檔核對 #721，依擁有者描述）；手改的設定檔不合法時，該擴充功能為「無法使用」，理由 `configuration-invalid` 並指出鍵與檔案，從不靜默改用預設值。
- **FR-115** 變更不需重啟 app：核心送 `configuration.onDidChange`；宣告 `restart: "extension"` 的設定改變時，核心以 `deactivate` → 新 instance 重啟該擴充功能的主機行程（`external` 者改為顯示「需要重新啟動」與它的 `start` 步驟），期間遺失依 071 計數（正常 `bye` 時沒有缺口）。
- **FR-116** **證據相關的設定變更上鏈**：Source 與 Exporter 擴充功能的設定改變時，在開著的專案（`scope: project` 者為該專案；`machine` 者為當時開著的專案，若無則在下一個開啟的專案）寫一列 `system:extension_config_changed{extension, version, keys, scope}`——只記鍵名，不記值（secret 永不，其他值也不記，因為路徑與主機名可能屬於私人）。**預設所有 Source 與 Exporter 的設定都記**；manifest 只能以 `affectsCapture: false` 明確排除（例如字型大小）。理由：作者忘記標記時，寧可多一列紀錄，也不要讓「改了擷取範圍」沒有痕跡；排除是可在 `extension check` 中看見的明確宣告。Processor 的設定（若有）一律記，因為它改變寫入路徑上的推導。
- **FR-117** 操作性的控制（啟動／停止、綁定到專案、標為私人、Exporter 在本專案的啟用）**不是**設定，是來源列上的動作；只有「設一次」的值是設定。manifest 宣告的設定鍵與這些動作同名時為錯誤。
- **FR-118** 每一項設定以標籤與同義詞登記到全域指令面板（⌘K），選擇後前往該設定列。這不是設定頁的搜尋框（已裁定刪除，根因審查 §4 第 8 項）；⌘K 是既有的單一入口。
- **FR-119** secret：以 OS 的憑證儲存保管（契約 §2.6.2），從不寫入設定檔、事件、日誌、匯出或 bundle，輸入後從不顯示；擴充功能只能經 `ctx.secrets.get(key)` 取得，該呼叫需要 manifest 宣告了該 secret 設定，且每次呼叫計入當分鐘的 `system:extension_read`（`secret_reads`，只記鍵）。
- **FR-11A** 相容：新增設定是擴充功能的次版本；移除、改名、改型別、改 scope 是破壞性變更，必須宣告 `migrations`，否則載入錯誤；更新後已存值不再通過驗證時不刪除、不改預設，擴充功能為「未設定」並指向該設定（契約 §2.6.3）。

**內建擴充功能預計宣告的設定**（檢查型別清單是否足夠）：

| 擴充功能 | 設定（型別，scope） | 備註 |
|---|---|---|
| 受管 HTTP 代理 | `port`（number，unit port，machine）、`listenHost`（enum `127.0.0.1`／`::1`，machine）、`mitmdumpPath`（path file，machine）、`upstream`（string pattern `host:port`，machine；保留給 upstream 模式） | 今天的 `httpCapture.port`／`listenHost`（073 已定為機器層）以 `migrations` 搬入 |
| 擷取瀏覽器 | `browserPath`（path file，machine）、`cdpPort`（number，unit port，machine） | 瀏覽器 profile 今天在專案目錄（`main/index.ts:1258`），是事實不是設定 |
| 內建終端機 | `defaultShell`（enum `optionsFrom: shells`，machine）、`wslDistro`（enum `optionsFrom: wsl-distros`，machine）、`fontSize`（number，machine，`affectsCapture: false`）、`scrollback`（number，machine，`affectsCapture: false`） | 需要 `optionsFrom`；沒有它只能用 string，失去選單 |
| pcap | `interface`（enum `optionsFrom: network-interfaces`，machine）、`bpfFilter`（string，machine）、`snaplen`（number，unit bytes，machine） | 需要 `optionsFrom` |
| C2 tailers | `logPaths`（list of path，machine）、`timestampField`（string，machine）、`project`（— 不是設定：綁定是動作，見 FR-117） | 14 號 F #9：綁專案而非「當時開著的」，以綁定動作處理 |
| 主機監看 | `pollMs`（number，unit ms，min 500，machine）、`watchDirs`（list of path，machine）、`ignoreProcesses`（list of string，machine） | — |
| 範例上傳 Exporter | `endpoint`（string pattern `https://…`，machine）、`token`（secret，machine）、`level`（enum `meta`／`command`／`content`，project）、`intervalMinutes`（number，unit min，project） | `endpoint` 必須落在 manifest `destinations` 中，否則驗證失敗 |

結論：原提的七種型別加上 enum 的 `optionsFrom`（核心提供的三個封閉清單）與 list 的 `items: path` 就足夠；沒有需要巢狀物件或自由 JSON 的設定。

### Key Entities

- **擴充功能（Extension）**：一個資料夾＋擴充功能 manifest；kind、runtime、層（內建／安裝）。
- **擴充功能 manifest 第 1 版**：契約 §2。
- **主機 API 第 1 版**：契約 §3–§4。
- **擴充功能主機行程**：每個已啟動的 `host` 擴充功能一個。
- **啟動事件**：契約 §3.4 的封閉清單。
- **機器層啟用**：`machine.yaml` 的 `extensions.<id>.enabled`。
- **綁定**：終端機 pin、AI 工作階段的專案選擇與認領索引。
- **動作與動作結果**：`src/core/actions/` 的函式與 `ActionResult`。
- **對齊列 v1**：契約 §7。
- **穩定度**：`stable`、`experimental`、`reserved`（契約 §1.3）。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** 基本路徑釘住測試組在每一個抽出 PR 的合併前後都綠，輸出相同（US1）；「全部停用」測試通過。
- **SC-002** 新安裝的閒置 app（專案開著、沒有啟用選用來源）：mitmdump、pty、擴充功能主機行程的數目為 0；CDP 輪詢計時器為 0（以測試中的計時器與子行程登記斷言；真機以 `ps` 與 13 號 C.6 的方法確認）。
- **SC-003** 以惡意測試擴充功能做的 7 種越權嘗試（US3）全部被拒並計數；狀態 payload 逐位元組不變。
- **SC-004** 對 `files` 中每一個檔案的單一位元組修改、新增未列出檔、刪除列出檔：100% 使下一次載入停在「需要重新核准」（US4）。
- **SC-005** 擴充功能 manifest schema 與主機 API 宣告的 golden 測試存在；任何不改版本號的變更都使其失敗。
- **SC-006** 每個內建擴充功能的 `host` 程式碼只 import `src/extension-api/**`（import 邊界 gate 為 0 違規）。
- **SC-007** 機器層啟用一次後，新專案需要的啟用動作為 0（US5）；AI 工作階段的重新綁定為 1 個動作（US6）。
- **SC-008** `redlog` 的 8 個動詞在沒有 Node 的 POSIX 容器與 PowerShell 5.1／7 中通過（US7）；`--json` 與 IPC 的結果型別一致。
- **SC-009** 相容矩陣由測試結果產生，列出每個內建與範例擴充功能 × API 版本；v1.0 範例在目前主機通過。
- **SC-010** 每一列 `system:extension_read` 的列數與事件 id 雜湊等於實際回傳；每一批 Exporter 送出前恰好一列 `system:export_shipped`。
- **SC-011** 沒有新增頁面或路由；新增介面字串每個語系不超過 24 個 key，通過 `test/ui-copy.test.ts`。

## Assumptions

- 單一使用者、單機。**威脅模型**沿用 071 與 05-F6：防的是瀏覽器與網頁、敵意的錄製內容、只有檔案工具的代理、bundle 的持有者；**不防**能執行任意程式碼的同使用者程序。擴充功能（不論 `host` 或 `external`）以使用者身分執行，能讀 `~/.redlog` 底下任何檔案、能連任何網路；主機行程的隔離帶來的是崩潰隔離、資源上限與「核心不載入它的程式碼」，**不是**安全邊界。Exporter 宣告的目的地無法強制；鏈上紀錄寫的是宣告值。文件與核准對話框都要寫明這一點。
- Electron `utilityProcess` 在 `runAsNode` 關閉時可用，且能從 `app.asar` 載入主機執行期（UNCONFIRMED；tasks T040 在三平台的正式版產物中確認，失敗則 FR-030 改用「app 二進位以外的 Node」之前先回報擁有者）。
- 主機行程的 heap 上限能以 `utilityProcess.fork` 的 `execArgv` 設定，且不受 `enableNodeOptionsEnvironmentVariable` 關閉影響（UNCONFIRMED；T040 一併確認）。
- AI 工具擷取、shell hook 的寫入路徑、HTTP 接收、HUD 的程式碼本規格不動；它們的變更屬於 071–075。

## 不在範圍

- 匯出套用遮蔽、標為私人、清除內容（後續「交付邊界與內容生命週期」規格；本規格只把它列為 Exporter `command`／`content` 層級與 L0 讀取 `command`／`content` 層級的前提）。
- 受管代理的 upstream 模式與「與操作者的代理並存」（DECISIONS §5 #4；屬 075 的 HTTP 來源或另一變更）。
- 寫入契約本身、出口蓋章、遠端 hook、終端機事實（Spec 071 的修訂）；狀態詞表與決策表（075）；種類登記（072）；查詢契約與變更主題（074）；設定層級與安裝帳本（073）。
- L2 的替代檢視 slot（FR-095 第 2 點，建議維持 reserved）。市集、自動更新、publisher 簽章。（L2 的導覽項目放置若 FR-096 選 `experimental`，在 tasks Phase 10 實作。）
- 多人或中央架構；收集端本身。
- 把 AI 工具擷取、shell hook、HTTP 接收搬出核心。

## 與既有文件、程式註解、已驗證規格與兄弟規格的矛盾

| 位置 | 現在的說法 | 本規格 | 處置 |
|---|---|---|---|
| 根因審查 §3「報告明確建議不做的：把內建來源改成外掛」、07 F 段 | 不把內建來源改成外掛 | 擁有者 2026-11-13 改決定（DECISIONS §3），再由 R2 收窄：只轉換搬了不影響基本功能的 | 記錄即可；07 的警告保留為 FR-022 的條件 |
| 08 §3a「Exporter：不建」、§3b「不建 utilityProcess host」 | 不建 | E2、E1 | 記錄即可；08 的理由（同 UID、無隔離收益）寫進 Assumptions |
| Spec 075 P11、FR-051、FR-060、FR-061、Q5；決定 7 | 只有 Source／Processor；不建 Exporter；內建來源不改成外掛 | E2、FR-020 | 075 的修訂（2026-11-13）已標示；T031 |
| Spec 075 FR-050–063（manifest v2） | manifest v2 歸 075 | 擴充功能 manifest 第 1 版歸本規格；075 只保留狀態需要的描述欄位 | 075 的修訂已標示 |
| Spec 071 O9、FR-07A、FR-072；073 P5、決定 8、FR-061–065；075 P4、FR-010 `enabledForProject`、FR-074、FR-076 | 來源與 AI 同意以專案為單位 | E5、R1：機器層啟用；AI 的專案選擇保留 | 三份規格的修訂已標示 |
| Spec 075 US1 情境 1 | 內建終端機為「待命」 | 「已關閉」 | 075 的修訂已標示 |
| `test/package-fuses.test.ts:50-59`；`electron-builder.yml` 註解「there is no … utilityProcess」 | 正式碼不得出現 `utilityProcess` | 只允許 `src/main/extension-host/launcher.ts` | T041 改寫該測試為允許清單（只此一檔）並改註解 |
| Spec 074 決定 2、FR-011 | 查詢執行緒不用 `utilityProcess` | 不衝突：074 的理由（原生模組）只適用它的 worker；擴充功能主機不開資料庫 | 記錄即可 |
| `docs/plugin-development.md`、`DESIGN-plugin-kernel.md` | 舊的 kinds、capabilities、無 host | 本規格 | T091 改寫 |
| `hooks/vps-deploy.sh` | 存在但 `exit 1` | 由 071 的遠端 hook 取代 | 071 修訂的任務移除它 |
| `docs/USER-GUIDE`、`cli/redlog-cli.js:107` | `redlog-cli mark --severity`；以 `redlog-cli` 為終端機入口 | `redlog` 為入口；標記只收標題與備註（裁定 5） | T072 |

## 開放問題（需要擁有者）

| # | 問題 | 建議 |
|---|---|---|
| Q1 | 選用來源的「已啟用」：狀態列要不要另用一個「已啟用」字，還是只用 075 的八個字（已關閉＝未啟用；其他任何字＝已啟用）？ | 只用八個字；加字會讓「已啟用」與「待命」「記錄中」並存在同一列，違反固定詞表。此題同時列在 075 **已裁定（2026-11-13，DECISIONS §9）**：只用八個字 |
| Q2 | 擴充功能主機用 Electron `utilityProcess`（需要改寫 fuse 守門測試為只允許一檔），還是要求操作者自己的 Node？ | `utilityProcess`：不需要操作者裝 Node，fuse 不必改；若 T040 證明不可行再議 **已裁定（2026-11-13，DECISIONS §9）**：`utilityProcess`；T040 證明不可行時再議 |
| Q3 | 遷移時「曾被使用過」的選用來源要不要自動在機器層打開？ | 要（FR-047）；否則升級當下就靜默停錄，違反「擷取不得靜默停止」 **已裁定（2026-11-13，DECISIONS §9）**：要 |
| Q4 | L0 讀取 API 的 `command` 層級（指令列含密碼的風險）是否等遮蔽前提才開放？ | 等；`meta` 先開放，已足夠做時間表、拓撲、對帳類工具。**已裁定（2026-11-13，DECISIONS §8 第 4 項）**：整個 L0 等遮蔽完成，`meta` 也不先開放 |
| Q5 | L2 的 v1 等級（FR-096 的一行）：`experimental` 還是 `reserved`？替代檢視 slot 是否在 v1 開放？ | `experimental`、只有導覽項目一種放置、只讀 `meta`、Phase 6 之後；slot 維持 reserved（見 J 段）。**已裁定（2026-11-13，DECISIONS §8 第 1 項）**：`experimental` |

## Domain References

- `.specify/memory/constitution.md` I、II、III、VI、VIII、IX。
- `docs/domain/glossary.md`：Event、Chained／Logged Event、Recording；本規格新增的術語（Extension、Extension Host、Activation Event、Binding、Stability Class、Aligned Row）在 T092 寫入。
- `docs/UIUX-STANDARD.md` §26（5、6）。
- Spec 027、033、035、055、065–067、070、071–075。
