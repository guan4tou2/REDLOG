# Architecture

核對日期：2026-10-30；來源基準 `ae0544b5`。本頁描述目前責任與檔案位置，feature 完成度見 [Spec 索引](../specs/README.md)，後續順序見 [工作計畫](WORK-PLAN.md)。不以檔案行數、資料夾數量或舊版本能力宣告取代契約與驗收。

## 1. Process / layer model

```text
renderer（React 19；主視窗／HUD）
  ↓ window.redlog.*
preload（contextBridge；明確暴露可用操作）
  ↓ Electron IPC
main（App／專案生命週期、視窗、原生能力、services 與 IPC 接線）
  ↓ 核心 Interface／注入的協作者
core（ingest、資料庫、證據鏈、query、content、export 與領域政策）
  ↑ REST／hook／選配來源送入同一 ingest
hooks、CLI、bundled producers、optional AI integrations
```

- [src/main/index.ts](../src/main/index.ts) 是 composition root，仍有部分 IPC；已拆出的 handlers 位於 [src/main/ipc/](../src/main/ipc/)。不要再寫成「所有 IPC 都在 index」。
- [src/preload/](../src/preload/) 與 [env.d.ts](../src/renderer/src/env.d.ts) 共同形成 renderer 的 Interface；目前型別有明列定義，不能宣稱已全面自動推導。新增 IPC 要同步其契約與測試。
- [src/core/](../src/core/) 保留不依賴 Electron 的領域行為；平台能力由 main 注入。renderer 可用純資料契約，不能從閱讀面直接取得 Node／檔案系統能力。
- 原生 capture implementations 位於 main services／hooks；多個 Adapter 沿現有 seam 接入，不能每來源複製 ingest／pause／export 政策。

## 2. Startup order

### App level (`src/main/index.ts`)

App 初始化註冊 protocol／視窗／tray／IPC，管理 API server 與來源生命周期；啟動 App、開專案、來源 Running、收到實際證據是不同狀態。精確註冊與先後以 composition root 為準，本頁不保存易漂移的行號或 namespace 數量。

### Project level (`startProject()`)

1. 先讀取並準備候選專案設定；此步失敗仍保留舊專案。
2. 已有 active project 時執行 `stopProject()`，再初始化候選 DB。
3. 設定 active project，初始化來源／監視器、政策、恢復及查詢資源；同步初始化成功後才發布 spool identity。
4. 任一步初始化失敗，盡力完成全部 cleanup 並保留原錯誤；不可留下 API、spool 或 renderer 的假 active 狀態。

`stopProject()` 撤銷 API／spool binding，停止各來源、timer、索引及讀取資源；terminal recording 在 DB 關閉前 detach，shell 可以存活但不能繼續寫進舊專案。不是「關專案必定殺死所有 terminal」。

對應驗證：[project-open rollback E2E](../e2e/project-open-rollback.spec.ts)、[terminal rotation E2E](../e2e/terminal-session-rotation.spec.ts)。

## 3. Data model

每個專案使用 `timeline.db`（WAL）；[db/index.ts](../src/core/db/index.ts) 管 schema、主連線與唯讀連線，關閉或開啟失敗時撤銷專案連線身分。

| 資料 | 責任 |
|---|---|
| `events` | append-only、hash chain 的證據事件；不改歷史 hash inputs |
| `events_logged` | 較高流量的 logged tier，與 chained tier 一起納入查詢／固定選取；不能假裝每列都上鏈 |
| `operators`／`chain_anchors` | 操作者公開驗證資料與證據鏈錨定；token 不放交付公開欄位 |
| `sanitized_events`／`do_not_export` | 交付轉換與排除政策，保留原件 |
| `bookmarks`／`event_notes` | 可編輯的私有書籤／註記，不能與原始 Event 混為同一證據承諾 |
| cast／HTTP body／AI raw／手動附件 | 檔案內容及事件參照；原始 bytes、版本、hash 與可讀投影分開 |

### Migration strategy

沿既有 idempotent DDL、欄位探測與 append-only 檢查；不為搬目錄重建資料庫或回填原始事件內容。saved-content partial indexes 由 SQLite 維護，協助排除沒有內容來源的 rows；索引不是另一份證據。

### Event envelope

固定欄位保存專案／操作者／來源／時間等身分；語意在 `data`。來源配對與 `_causes` 不得退化成同 PID、文字或 host 就當作同一操作。領域契約見 [target identity](domain/SPEC-target-identity.md)、[query semantics](domain/SPEC-search-query-semantics.md)。

### Activity query projection (Spec 064)

[activity-projection.ts](../src/core/activity-projection.ts) 與 [db/activity-queries.ts](../src/core/db/activity-queries.ts) 衍生操作身分／分組／背景，不改 Events。匹配事件與脈絡分開、先定群組再分頁；來源 namespace、project、provider 與 snapshot 是查詢正確性的一部分。

[content-contract.ts](../src/core/content-contract.ts) 定義 ContentRef 與有界 Read／Find；[evidence-content.ts](../src/core/evidence-content.ts) 核對 project、Event、field 與來源版本，[body-source.ts](../src/core/body-source.ts) 讀回已保存內容。capture partial、來源 availability 與讀取 hasMore 是三個軸。HTTP／Shell refs 使用既有 [EventContentReader](../src/renderer/src/components/EventContentReader.tsx)，不能恢復整檔讀入 renderer 的平行路徑。

Spec 064 整體仍 Draft；Activity 局部存在不代表所有 Reader、座標與五入口導覽已達 parity。

## 4. Capture pipeline

```text
外部 producer → REST auth／專案 gate ┐
                                   ├→ ingest → insertEvent → publish → UI／衍生資料
main 內的 producer ─────────────────┘
```

[ingest.ts](../src/core/ingest.ts) 管 pause、來源／因果、enrichment、redaction spans、保存及 publish 的共通順序。[db/event-write.ts](../src/core/db/event-write.ts) 管底層寫入，不能繞過共通政策來建立第二個正式 producer 路徑。

### Sources

| 路徑 | 實作位置／重要限制 |
|---|---|
| 外部 Bash／Zsh／PowerShell | [hooks/](../hooks/)、[shell catalog](../src/core/shell-catalog.ts)、[hooks manager](../src/core/hooks-manager.ts)；接入、command proof、output proof 與來源存活分開，不再宣稱 hook 一律沒有輸出 |
| 外部 relay／顯式 session | `hooks/redlog-relay.py` 與既有 session 路徑；專案身分、spool、pause、輸出邊界不由 UI 推測 |
| 內建 terminal | [terminal-manager.ts](../src/main/terminal-manager.ts)；PTY、cast、session rotation，作外部終端以外的備用入口 |
| HTTP／HTTPS／WS／TCP | [managed-http-proxy.ts](../src/main/services/managed-http-proxy.ts)、`hooks/mitmproxy-addon.py`；只宣稱實際經過來源的覆蓋，不等於全系統網路 |
| HTTP 驗證歷史 | [http-verification-evidence.ts](../src/core/http-verification-evidence.ts)、[http-verification-history.ts](../src/main/services/http-verification-history.ts)；專案本地有界歷史，不用 UA 當穩定 client 身分，也不從歷史恢復目前 CA trust |
| 截圖、clipboard、檔案／程序／連線 | main services 與 IPC；選用能力、讀取權限、觀測資訊與已保存原件分開 |
| AI | optional packages → tailer host，見下一節；必須明確選用及有專案授權 |

來源 lifecycle 的唯一語意見 [capture-source-lifecycle](domain/SPEC-capture-source-lifecycle.md)；沉默不當失敗，來源恢復不抹掉歷史缺口。支援平台與實測限制見各 spec／[packaged smoke](PACKAGED-SMOKE.md)，不在此抄一份綠燈矩陣。

## 5. Tailer host (AI agent capture)

[tailer-host.ts](../src/main/services/tailer-host.ts) 管來源讀取與保存，Adapter 管 provider 格式；選配整合位於 [optional-plugins/claude-code/](../optional-plugins/claude-code/) 與 [optional-plugins/codex/](../optional-plugins/codex/)。目前出貨選配僅這兩個，不恢復已移除的 OpenCode parser。

本機安裝、專案啟用與原始檔讀取授權分開；無有效 receipt／路徑不得因開設定就開始擷取。來源版本、snapshot／確認前綴、pause、自身專案排除與 redaction 要留在既有 host／policy。raw JSONL 與解析後事件是不同載體；匯出預設不等於交付 raw 對話。

## 6. Evidence chain

[證據模型](audit-trail.md) 與 [evidence-chain.ts](../src/core/evidence-chain.ts) 描述 chained Events、簽章與錨定。完整鏈驗證、抽樣與錨定有不同保證；logged tier、書籤、UI 推導不能被稱作原始 chained Events。

原始 bytes 的完整性與經清洗 projection 的交付完整性分開。hash 能驗成品未變，不自行證明投影等於原始事件；轉換與排除需有 provenance 與 manifest 說明。

## 7. Export & delivery

[export-plan.ts](../src/core/export-plan.ts) 與 [data-export IPC](../src/main/ipc/data-export.ts) 管核准的固定集合、政策與附件；preview 和 execute 沿同一計畫。來源變更／缺失或政策改變不能靜默產生不同成品。格式 writer 各有能力，不創建前端另一套統計。

Bundle／HAR 是主要交付入口；既有 JSON／NDJSON／Timeline 保留。operator PII 清洗不等於秘密偵測，Bundle／HAR 不支援的政策要明確拒絕。原始附件不做內容層 scope／PII 清洗；cast 可僅複製核准 byte prefix，不能宣稱完整原檔或自行改寫內容。

選取契約見 [export-event-selection](domain/SPEC-export-event-selection.md)；產物／manifest／離線 verifier 及 restart 由 [packaged smoke](PACKAGED-SMOKE.md) 依實際格式驗證。[redlog-share-worker/](../redlog-share-worker/) 是獨立分享服務，不把本機交付驗收當成已部署或分享成功。

## 8. Plugin system

[core/plugins/](../src/core/plugins/) 管 manifest、啟用與貢獻；[plugins/](../plugins/) 放 bundled 宣告／producer；[optional-plugins/](../optional-plugins/) 放明確選用的 AI 整合。

受信任的 bundled tailer 與宣告式 contribution 有不同執行風險；不新增任意第三方 code host、商城或平行設定工作流。詳見 [plugin development](plugin-development.md)；舊 design 提案的能力清單不能取代當前 manifest 契約。

## 9. IPC conventions

- renderer 經 preload 呼叫 main；`invoke`／`handle` 管 request-response，訂閱回傳 unsubscribe；專案切換與過時回覆不得沿用舊資料身分。
- handlers 已按行為拆於 [main/ipc/](../src/main/ipc/)；`index.ts` 負責依賴注入與剩餘接線，不能為分類造沒有行為的轉送層。
- 大內容用 versioned bounded content Interface，不以「詳情」操作整檔傳輸。
- loading、empty、failed、unknown、stale 分開；來源失敗保留 query／已讀內容，重試不自動重播破壞性操作。
- E2E-only 能力依既有 `REDLOG_E2E` gate，不當作正式模式或原生權限驗收。

## 10. Repository layout and placement

| 路徑 | 放什麼／不放什麼 |
|---|---|
| `src/core/`、`db/`、`query/`、`alert/`、`plugins/` | 領域 Module、純契約、持久化與查詢；不引入 Electron 來方便 UI |
| `src/main/`、`ipc/`、`services/` | Electron／OS Adapter、生命週期與 seam 接線；不複製 core 政策 |
| `src/preload/` | renderer 可呼叫的明確 Interface；同步型別與授權／錯誤語意 |
| `src/renderer/src/components/`、`lib/`、`i18n/` | 既有閱讀／設定／操作、純投影與兩語系；沿用 controls／tokens |
| `hooks/`、`shell/`、`cli/` | 外部接入、傳輸、工具入口；不另存一套 project identity 或 pause 契約 |
| `plugins/`、`optional-plugins/`、`resources/` | bundled 貢獻、選配整合與打包靜態資源；runtime 可變設定不寫回這裡 |
| `test/`、`e2e/`、`scripts/`、`tools/` | 行為測試、實際 App 任務、工程 gate、離線 verifier；沿用 fixture 與測試選取，不按新文件分類搬測試 |
| `specs/NNN-slug/` | feature spec／plan／tasks／verification；穩定編號，不搬到 active／done 子目錄 |
| `docs/`、`domain/`、`records/`、`archive/` | 長期入口／標準、領域契約、日期證據、過期提案；見 [文件入口](README.md) |
| `design/`、`examples/` | 設計來源、可維護的公開範例；不是執行紀錄 |
| `out/`、`dist/`、`test-results/` 等生成輸出 | build／候選／測試 artifacts；不當作來源或搬入 docs，依 `.gitignore` 管理 |

本次實際調整的是文件入口與日期紀錄。產品來源保留原位置：只有觀測到同一知識跨多個呼叫點漂移，或兩個真實 Adapter 需要同一 Interface，才在相關 feature 批次調整 seam／Module。先畫責任與測試面，再做必要搬移；不按行數拆檔、不新增泛用 `common/`／barrel 只為讓目錄看起來整齊。

## 這個 codebase 會咬人的地方

> 原載於 2026-09 交接文件（已歸檔），仍然有效。

接手前讀完這一節，可以省下我這輪踩過的每一個坑。

### native module 的 ABI 陷阱

`better-sqlite3` 是原生模組，**vitest 需要 Node ABI，e2e 需要 Electron ABI**。切換：

```bash
npx electron-rebuild -f -w better-sqlite3   # 換成 Electron ABI（跑 e2e 前）
npm rebuild better-sqlite3                  # 換回 Node ABI（跑 unit 前）
```

忘了換回來的症狀是 **unit 測試整批 skip 而不是失敗**——DB 相關的 suite 用
`describe.skipIf(!available)` 保護。看到 `Tests 8 skipped (8)` 就是這件事。

那個保護的正確寫法在 `test/cast-index.test.ts:11-21`：**必須 `new Database(':memory:')` 探測**，
只 import 是不夠的（binding 是延遲載入的，import-only 的守衛會回報「可用」然後在被測模組內部炸掉）。

### TDZ：只在打包後才出現的崩潰

React hook 的 dep array 在 render 時求值。一個 hook 若引用**宣告在它下面**的 `const`，在
esbuild 打包後會是 temporal-dead-zone 崩潰——而 **vitest 看不到**，因為它是逐檔轉譯原始碼。

這個 codebase 已經被咬過**三次**（`TargetView` 的 listNav、`Timeline` 的 `collapsedBands`、
`App` 的 visibility memo）。相關檔案裡都寫了契約註解，照著擺：`Timeline.tsx` 的 fold memo 在
`effectsById` 之後、`badgesById` 之前，`App.tsx` 的 visibility memo 緊接狀態區。

**e2e 是唯一的守衛。** 動過 Timeline.tsx 或 App.tsx 的 hook 順序就跑 `npm run build && npm run e2e`。

### 兩層事件表

`events`（上鏈）與 `events_logged`（支撐證據，30 天後清）。`classifyTier` 決定去哪一張，
未列出的 pair 預設 chained。**任何 join 或聚合都必須考慮兩張表**——語料大半在 logged 層
（所有 HTTP、DNS、browser console、agent thinking）。

已知的例外：`searchEvents` 只查 `events`。這是既有行為，不是這輪造成的。

### 腳本化編輯要 assert

我這輪犯過一次：一個 `s.replace(old, new)` 的錨點不符、靜默跳過，害 `scopeSignalFor` 的 import
沒落地。dispatch 在 insert 之前，所以**任何帶目標的 shell POST 都會 500,連事件都沒寫進去**——
擷取靜默停掉，三個 commit 後才被 e2e 抓到。

現在有 typecheck 會接住這一類。但仍然：批次編輯後，grep 一下該編輯應該引入的識別字。

### 不要對正在編輯的檔案下 `git checkout --`

它會還原到 HEAD，包含未提交的工作。我用它撤銷一行故意改壞的測試，連帶清掉了同一個檔案裡
一小時的改動。

### 從原始碼解析的守衛測試

這個 repo 有一批測試是讀 `.ts` 原始碼、用 regex 斷言規則的（`design-tokens`、`lane-colours`、
`buttons`、`truncation`、`danger-not-on-numbers`、`list-keyboard`、`i18n-keys`、
`housekeeping-parity`、`redaction-boundary`、`typecheck-guard`）。改 UI 前先看它們要什麼。

兩個容易忘的：**截斷的 span 一定要有 `title`**；**危險紅絕不出現在數字上**（`tabular-nums` 與
danger 類名不能出現在同一個 className）。

### i18n 掃描器看不到動態鍵

`test/i18n-keys.test.ts` 只掃字面 `t('a.b')`。用變數組出來的鍵它看不到——`sidebar.http_history`
就是這樣漏掉的，那個鍵兩本語言檔都沒有，直接把鍵名印給操作員。

掃描器現在也認 `reasonKey: 'a.b'` 字面值。再有這種模式，記得一起加進去。

---
