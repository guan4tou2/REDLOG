# Implementation Plan: 事件種類登記表與閱讀器契約

**Branch**: `spec/072-075-contracts` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/072-event-kind-registry-and-readers/spec.md`

## Summary

「這個種類是什麼」今天散在 33 張以種類為鍵的表裡，沒有一張是權威，加一個寫入者時也沒有任何東西提醒要改哪幾張。本計畫建立一個純資料模組 `src/core/kinds/`，一個種類一個項目，回答 tier、暫停、誰能寫、目標規則、因果、角色、區間、標題、泳道、Activity 歸類、閱讀器、內容與完整性、計數、內務、匯出、失效等問題；再用兩個方向的 gate 鎖住「寫得出的」與「登記的」相等。閱讀器改為十種依內容類型劃分的封閉列舉，第一行說出七值之一的完整性。區間、狀態與註記只以宣告存在，由 074 計算。33 張表依「操作者看得到的分歧」排序逐一摺入，每一張都先存 golden，摺疊後只允許有記錄的差異。

## Technical Context

**Language/Version**：TypeScript（core、main、preload、renderer）；寫入端另有 POSIX sh、zsh、PowerShell、Python 3、Node（`hooks/`、`plugins/`）。
**Primary Dependencies**：無新增。gate 以既有的 Vitest、`typescript` compiler API（同 `scripts/verify-architecture.mjs`）、`fast-glob` 實作。
**Storage**：無新表、無新欄位。新增一個種類 `system:project_closed`（一般事件列）。
**Testing**：Vitest（單元、golden、掃描型 gate）；Playwright e2e 只在 ubuntu；真機驗收另列。
**Target Platform**：macOS、Linux、Windows。
**Performance Goals**：`kindOf` 為一次 `Map` 查詢；`completenessOf` 為常數時間；內務 SQL 的文字與今天逐字相同或只差有記錄的修正（不觸發任何索引重建）。
**Constraints**：O8（不碰舊列）；模組不得 import Node（FR-020）；React 元件一律宣告在模組層。
**Scale/Scope**：起草時約 130 個可寫入的種類、17 個 `agent_type`（10 的 A.1）；33 張表；字面值種類比較約 274 處、62 個檔案。

## Constitution Check

| 原則 | 判定 |
|---|---|
| I Evidence Integrity | 不改寫舊列；`project_closed` 是新增列；摺疊不改任何寫入的位元組（tier 變更只來自 071 T027 並列入 `TIER_CHANGES`）。通過 |
| II Surface Truthfulness | 完整性只依來源事實，舊列說「未知」；開放區間說「未見結束」而非失敗；pivot 說「偵測於」。通過 |
| III Canonical Semantics | 一個種類一個定義；內務規則從三份變一份；標題從兩份變一份。通過 |
| VI Explicit Failure | 「未擷取」「已重導」「未知」與「沒有輸出」分開。通過 |
| VII Provenance | 註記宣告附著於來源列；AI 工具呼叫不被說成獨立觀察（角色為 action，其效應無法歸屬時不猜）。通過 |
| VIII Test-First | Phase 1 先存 golden 與 RED；每個行為修正先 RED。須執行 |
| IX Restraint | 新模組解決已量到的 33 張重複表；不引入框架、不做外掛 UI、不建 DI。通過，見 Complexity Tracking |
| Workflow | 跨層契約：實作前執行 Clarify、Checklist、Analyze，記入 verification.md（T001） |

## 現況（程式碼確認，2026-11-12，`main@56c9fe6c`）

- **tier**：`classifyTier`（`src/core/db/event-write.ts:100-107`）只查 `LOGGED_TIER`（`:45-82`），不在表上一律 chained。`'browser:console'`（`:61`）不對應任何實際寫出的 subtype（`src/main/services/cdp-connector.ts:291-296,319,344`），所以瀏覽器 console 列今天是 chained。`test/db/tier-classifier.test.ts` 沒有掃描寫入端，與 `event-write.ts:96-99` 的註解相反。
- **外部可寫**：`EXTERNAL_ALLOWED_AGENT_TYPES`（`src/core/external-event-policy.ts:12-20`）以 `agent_type` 為鍵，含 `credential_use`；同檔 `:4-8` 說推導的種類不可外部寫入。`producer_heartbeat` 例外在 `:24-40`。
- **閱讀器**：`hasSpecificEventDetail`（`src/renderer/src/lib/timelineEvents.ts:87-96`）對 `shell`、`agent`、`scanner`、`browser`、`marker`、`screenshot` 回 true；檢視器（`src/renderer/src/components/timeline/TimelineEventInspector.tsx:412-449`）對 `screenshot` 沒有分支，對整個 `scanner` 套 `HttpDetail`。通用閱讀器 `GenericEventDetail`（`src/renderer/src/components/TimelineEventDetails.tsx:380-391`）已是有標籤的欄位格，原始 JSON 是另一個切換（`TimelineEventInspector.tsx:472-476`）。
- **完整性**：relay 寫 `completeness`／`output_disposition`／`limit_hit`／`output_streamed`（`hooks/redlog-relay.py:556-592,975-1013`），`shell-common.sh:974,1011` 對 `redlog-run` 的內建指令寫 `metadata-only`／`not-captured`。讀取端 `commandOutputState`（`src/core/content-contract.ts:136-146`）與 `ioMark`（`src/renderer/src/lib/timelineDomain.ts:205-219`）都不讀這些欄位。既有的位元組層狀態 `ContentState`（`content-contract.ts:18-26`）與讀取介面 `ContentRef`／`readEventContent`（`src/core/evidence-content.ts:112,211`）可直接沿用。
- **標題**：`eventTitle`（`src/renderer/src/lib/eventTitle.ts:45-266`）依 `agentType` switch；預設分支在 `:71`（`eventTitle.shellEvent`）、`:223`（`agent: ${sub}`）、`:263`（`eventTitle.systemOther`）、`:265`（`${agentType}: ${subtype}`）。它 import `en.json` 與 `HttpDetail` 元件，只能留在 renderer。`SearchPanel.tsx:25-45` 另有一份。
- **泳道**：`LANES`、`BANDS`、`toLane`、`LANE_LABEL_KEYS`（`timelineDomain.ts:16,28-33,120-158`）；`c2_checkin` 泳道與 `eventTitle.ts:179` 的 `c2Beacon` 沒有寫入者（c2 外掛寫 `scanner:c2_*`，`plugins/c2-tailers/parse.js:33,44,55,77`）。
- **renderer 匯入 core**：約 40 個 `src/core` 模組被 renderer 匯入；以非 type import 走訪，`config.ts`、`private-fs.ts`、`agent-capture-policy.ts` 三個檔案帶進 Node 模組。目前沒有任何 gate 檢查 renderer 對 `src/core` 的純度。
- **寫入者**：在行程內，`insertEvent(` 有 33 處呼叫（含 `system` 27、`marker` 2、`loot` 1 以字面值為第一參數；本處計數範圍含 `src/core/db` 內部的呼叫。071 T006 的 ratchet 只計 commit 階段以外的正式程式碼，#716 量得 31；Phase 1 的 T002 以同一掃描重量並在 `verification.md` 寫明差異）；`system` 的 subtype 有一半經變數組出。AI adapter 的 `subtypeForClaude`（`optional-plugins/claude-code/adapter.ts:287-302`）有開放分支。外掛 manifest 已有 `emits`（`plugins/{pcap-capture,c2-tailers,transparent-proxy}/plugin.json`；`src/core/plugins/manifest.ts:176,268`）。
- **字面值種類比較**：`src/` 中 `agentType ===/!== '…'`、`agent_type =/!= '…'` 與 `case '<agent_type>':` 共約 274 處、62 個檔案（Phase 1 以 T005 的樣式重新量得基準）。
- **全文索引**：觸發器對所有種類一致（`src/core/db/index.ts:431-461`）。

## 表的清點（33 張）與落點

「欄位」指登記項目的欄位（見下節）。標為「不是種類表」的 2 張（#11、#28）不摺；#20、#22 摺掉以種類為鍵的部分，依列內容判斷的程式碼留在原處，改以登記表的欄位為鍵。

| # | 表 | 位置 | 落點 | 階段 |
|---|---|---|---|---|
| 1 | `LOGGED_TIER` | `src/core/db/event-write.ts:45-82` | `tier` | 4 |
| 2 | `PAUSE_EXEMPT_AGENT_TYPES` | `event-write.ts:380`（用於 `:452`） | `pause: 'exempt'` | 4 |
| 3 | `delayedCapture` | `src/core/ingest.ts:162-163` | `pause: 'gated-by-observation'` | 4 |
| 4 | `ACTIVE_TARGET_FALLBACK_TYPES` | `ingest.ts:71`、`:251-252` | `identity.target` | 4 |
| 5 | `EXTERNAL_ALLOWED_AGENT_TYPES` | `src/core/external-event-policy.ts:12-40` | `writers` | 4 |
| 6 | 起訖的種類判斷 | `src/core/causes-resolver.ts:98-185` | `IntervalDef` 的 start／end／members；`cause`。記憶體中的配對狀態留在 ingest（071） | 4 |
| 7 | 行程歸屬的種類 | `src/core/socket-attribution.ts:188-189` | `cause: 'socket'` | 4 |
| 8 | 範圍訊號的種類 | `src/core/alert/scope-signal.ts:51-90` | `scopeSignal`；每種的欄位抽取留為 `Record<ScopeSignalKind, …>` | 4 |
| 9 | Activity 分組集合 | `src/core/activity-projection.ts:7-10` | `activity.group` | 3 |
| 10 | `activityClassification` | `activity-projection.ts:51-64` | `activity.action` | 3 |
| 11 | `TOOL_ACTIONS` | `activity-projection.ts:36-49` | **不是種類表**（`tool_name` → 動作，只在 `agent:tool_call` 內），留 | — |
| 12 | `LANES`／`BANDS`／`toLane` | `src/renderer/src/lib/timelineDomain.ts:16,28-33,147-158` | `lane`、`band`；`LaneId` 移入 `kinds/types.ts` | 3 |
| 13 | `LANE_LABEL_KEYS`、`agentTypeLabel` | `timelineDomain.ts:120-145` | 每個泳道的 `labelKey` | 3 |
| 14 | 外掛 `eventTypes` | `src/core/event-registry.ts:1-44`；讀者 `Timeline.tsx:545-560`（`plugins.eventTypes()` 的 `label`、`lane`） | `validatePluginKind`（FR-036、037）：`label` → 外掛種類的標籤；`lane` → 依 D9 由登記表決定，外掛不再宣告；Timeline 改讀 `kindOf(row, plugins)` | 6 |
| 15 | `eventTitle` | `src/renderer/src/lib/eventTitle.ts:52-266` | `title: TitleId` + renderer `TITLES` | 3 |
| 16 | 搜尋結果標題 | `src/renderer/src/components/SearchPanel.tsx:25-45` | 刪除，改用 #15 | 3 |
| 17 | 閱讀器分派 | `timelineEvents.ts:87-96`、`TimelineEventInspector.tsx:412-449` | `reader` + renderer `READERS` | 3 |
| 18 | `HOUSEKEEPING_SQL` | `src/core/db/event-queries.ts:213-221` | `housekeeping` + 列規則 | 3 |
| 19 | `EVIDENCE_SQL`、`isEvidence` | `event-queries.ts:150-158`、`src/renderer/src/lib/housekeeping.ts:28-36` | `counts.work` | 3 |
| 20 | `computeBadges`、`ioMark`、`dotShape` | `timelineDomain.ts:205-290` | 種類相關的徽章 → `badges`；`ioMark` → `completenessOf`；`dotShape` 的列內容判斷（標記嚴重度、範圍距離）留在原處，改以 `kindOf()` 取代 `agentType` 字面值 | 3 |
| 21 | `isBoundary` | `src/renderer/src/lib/timelineIncremental.ts:481-486` | `IntervalDef`（state）；計算由 074 取代 | 5 |
| 22 | `timelineCard` | `src/renderer/src/lib/timelineCard.ts:48-114` | 卡片的 type tag 讀 `lane`；`metaOf`／`detailOf` 的內容欄位判斷留在原處，改以 `reader` 為鍵 | 3 |
| 23 | Transcript 收錄 | `src/renderer/src/components/TranscriptView.tsx:190-379` | `transcript` | 3 |
| 24 | 匯出摘要計數 | `src/core/export-plan.ts:119-180` | `export.summary` | 6 |
| 25 | 匯出附件 | `src/core/export-attachments.ts:126,153` | `export.attachment` | 6 |
| 26 | HTTP 匯出伴隨列 | `src/core/export-selection.ts:69-71` | `IntervalDef('http-flow').members` + `export.har` | 6 |
| 27 | do-not-export 串連 | `src/core/db/do-not-export.ts:21-42` | `IntervalDef('command').members` | 6 |
| 28 | capture-health 來源探測 | `src/core/capture-health.ts:527-799` | **不是登記表的欄位**：075 的來源描述列出它證明的 `KindId` | 075 |
| 29 | 內務規則第三份 | `src/renderer/src/lib/knownLists.ts:15-33` | `housekeeping` | 3 |
| 30 | 有內容的種類 | `src/core/content-contract.ts:115-121` | `content`；產生的 SQL 文字須逐字相同（部分索引） | 3 |
| 31 | 終端帶 | `src/renderer/src/lib/timelineSessionBands.ts:41-60` | `IntervalDef('terminal-session')`；計算由 074 取代 | 5 |
| 32 | 配對後隱藏 start | `src/renderer/src/components/Timeline.tsx:178`、`timelineIncremental.ts:112-165` | `IntervalDef('command')`；繪製屬於時間軸改版 | 5 |
| 33 | 「範圍／設定已變更」集合 | `ScopeStatus.tsx:14`、`TargetView.tsx:118`、`HttpHistoryPanel.tsx:142`、`timeline/TimelineDetailBar.tsx:36` | `invalidates`；訂閱由 074 的變更通知取代 | 3 |

摺疊後表數：純呈現 15 張（Phase 3）→ 行為 8 張（Phase 4）→ 宣告 3 張（Phase 5）→ 匯出與外掛 5 張（Phase 6），共 31 張；2 張不摺；計數只減不增（T005 的 ratchet）。

同時是「種類表」的文件：`docs/event-schema.md`（85 行表格）與 DESIGN-two-tier-chain §2.2–2.3。它們在 Phase 7 改為指向登記表或由它產生（T071、T072）。

## 設計決策

### D1 位置與純度：`src/core/kinds/`，一個目錄、零外部 import

**決定**：

```text
src/core/kinds/
├── types.ts      # 封閉列舉與介面：Role, Shape, ReaderId, TitleId, LaneId, BandId,
│                 # ActivityAction, Completeness, ProducerClass, PauseRule, TargetStep,
│                 # CauseRule, PairKey, OpenMeaning, KindDef, IntervalDef, StateDef
├── registry.ts   # KINDS（as const）、INTERVALS、STATES、TIER_CHANGES、KIND_REGISTRY_VERSION
├── rules.ts      # 列規則（內務的 hook 樣式、late/streamed）→ 同一份資料產生 SQL 與 JS
├── completeness.ts  # completenessOf（純函式）
├── plugin.ts     # validatePluginKind（純函式）
└── index.ts      # 公開介面
```

- 不 import 目錄外任何東西，連 `import type` 也不行；需要的列形狀在 `types.ts` 自己定義最小介面（`KindRow = {agentType: string; data: Readonly<Record<string, unknown>>}`）。
- `ActivityAction` 與 `LaneId` 搬進 `types.ts`；`activity-contract.ts` 與 `timelineDomain.ts` 改為 re-export，呼叫端不需改。
- gate：`test/kinds/registry-pure.test.ts` 以 TypeScript AST 讀 `src/core/kinds/**` 的每個 import／export-from／動態 `import()`／`require`，只允許 `./` 開頭且解析後仍在目錄內。同檔另做 FR-022 的 renderer 走訪 ratchet（基準 3）。

**否決**：

- **新的頂層 `src/shared/`**：更「乾淨」，但等於開始整批搬動 `src/core`（工作計畫明列不做）；renderer 已有直接 import `src/core` 純模組的先例（`activity-contract`、`content-contract`、`operation-pair-key`）。
- **放在 `src/core/event-kinds.ts` 單檔**（10 的 D.1）：約 130 個項目加區間與列規則，單檔可行，但純度 gate 需要以目錄為單位（一個檔案不能同時是「資料」與「SQL 產生器」又被兩邊匯入而不擴大範圍）。
- **由 preload 經 IPC 提供給 renderer**：登記表是靜態資料，經 IPC 只增加非同步與一次往返，且 renderer 的 `Record<ReaderId,…>` 需要型別，IPC 給不了。

### D2 可寫入集合：TypeScript 用型別，其他語言用掃描

**決定**：

1. **TypeScript 寫入者**：`KindId` 為 `typeof KINDS[number]['id']`。071 的行程內入口與 `insertEvent`／`ingestEvent` 的種類參數改為 `(kind: KindId, data)` 或保留 `(agentType, data)` 但 `agentType` 型別為 `KindAgentType`、`data.subtype` 型別為 `SubtypeOf<A>`。推導器（`pivot-detector.ts`、`technique-tagger.ts`、憑證偵測、`alert/surface.ts` 的 `formatEvent`）的 subtype 回傳型別改為登記表對應族的 subtype 聯集。尚未型別化的呼叫以 `test/kinds/untyped-kind-calls.test.ts` 計數（AST：種類參數的型別為 `string`），ratchet 到 0。
2. **非 TypeScript 寫入者**：`test/kinds/writers-registered.test.ts` 掃描：

   | 語言 | 檔案 | 樣式 |
   |---|---|---|
   | sh／zsh | `hooks/*.sh`、`hooks/*.zsh` | `_redlog_send_event "<sub>"`、JSON 片段中的 `\"subtype\":\"<sub>\"`、`--subtype <sub>` |
   | PowerShell | `hooks/*.ps1` | `-Subtype '<sub>'`、`subtype = '<sub>'` |
   | Python | `hooks/*.py` | `"subtype": "<sub>"`、`subtype="<sub>"`、`_emit("<sub>")` |
   | JavaScript | `plugins/**/*.js` | `subtype: '<sub>'`、`agentType`／`agent_type: '<type>'` |

   每個檔案的 `agent_type` 由測試內的 `FILE_AGENT_TYPES` 表給出（例如 `mitmproxy-addon.py → [scanner, dns]`、`pcap-agent.py → [pcap]`、`shell-*.{sh,zsh,ps1} → [shell]`）；表中沒有的檔案若命中樣式，測試失敗（新寫入者必須宣告）。外掛的 `.js` 另與其 `plugin.json` 的 `emits` 比對。
3. **AI adapter**：`optional-plugins/*/adapter.ts` 是 TypeScript，`subtypeFor` 的回傳型別改為 `SubtypeOf<'agent'>`；開放分支（`adapter.ts:297-300`）以 `agent:*` 族承接（D8 的族清單）。
4. **反向**：每個 `active` 種類的 `id` 必須被 (1) 的 AST 引用或 (2) 的掃描找到；`legacy` 種類必須兩者都找不到。

**理由**：只用字面值掃描，`system` 的 subtype 有一半找不到（經變數組出）；只用型別，shell、Python、PowerShell 與外掛的 JS 完全不在範圍內。兩者合在同一個測試檔輸出一份「寫入者 × 種類」清單，失敗訊息列出檔案與行號。

**否決**：

- **只掃描字面值**（10 的 D.1 gate 1）：漏 `alert/surface.ts` 這類組裝；而且新增 TS 寫入者時要等到測試才知道，型別在編輯器就會指出。
- **執行期攔截未登記種類並拒寫**：違反「記錄失敗不得打斷操作者」與 071 FR-113 的預設；gate 在 CI 擋，執行期只計數（Edge Cases 最後一項）。
- **新增 `npm run verify:kinds`**：會成為第六道 gate，需要改 CI 與 CLAUDE.md 的順序；Vitest 已在三個平台的 unit leg 執行，足夠。

**已知盲點**（寫在測試檔頭）：shell 中以變數組出 subtype 的呼叫；Python 中 `dict(**kw)` 組出的事件；外掛以動態字串產生 subtype。每一個盲點都有一個確認它目前不存在的負向斷言（例如 `hooks/` 中 `_redlog_send_event "$` 的次數為 0），新出現就失敗。

### D3 字面值種類比較的 ratchet

`test/kinds/kind-literal-ratchet.test.ts` 以 AST 掃描 `src/**/*.{ts,tsx}`（排除 `src/core/kinds/**`），計數：

- `BinaryExpression`，一邊是名為 `agentType`、`agent_type` 或 `.agentType` 的存取，另一邊是字串字面值；
- SQL 字串中的 `agent_type\s*(=|!=|IN)\s*'`；
- `switch (x.agentType)` 的 `case` 字面值；
- `data.subtype === '…'` 與 `subtype IN (…)`（同一規則，計入另一個計數）。

兩個計數各有基準，只能下降；允許長留的項目（例如閱讀器內部對自身內容的判斷）列在 `test/kinds/kind-literal-allowlist.json`，每項附理由；不再命中的允許項讓測試失敗。形式同 `test/mutation-guard.test.ts`。

### D4 閱讀器：十種，依內容類型

`ReaderId`（spec FR-030 的表）。renderer 端 `src/renderer/src/lib/kindPresentation.tsx`：

```ts
export const READERS: Record<ReaderId, ComponentType<ReaderProps>> = { … }   // 模組層，不在元件內
export const TITLES: Record<TitleId, (row: RedLogEvent, t: Translate) => string> = { … }
export function readerFor(row: RedLogEvent, plugin?: PluginKinds): ReaderId
```

- `ReaderProps = {projectId, event, reader /* 既有的 reader mode */, completeness}`。每個閱讀器自己決定版面，但第一行的完整性由共用的 `<CompletenessLine>` 畫（只在 `content` 非空時）。
- 時間軸檢視器、Activity 閱讀器（`EventContentReader` 的外框）與 Transcript 的單列展開共用 `READERS`。
- `TITLES` 的每個 `TitleId` 對應今天 `eventTitle` 的一個分支（一個分支一個 id），加上 10 的清單 (1) 的 29 個種類各自的新 id。`eventTitle(row)` 變成 `TITLES[kindOf(row)?.title ?? 'unregistered'](row, t)`。
- 「回到原始位元組」：每個閱讀器的動作列有「原始內容」，經 `describeEventContent`／`readEventContent`（`evidence-content.ts:112,211`）讀 `ContentRef`；`event_data` 欄位永遠可讀（FR-035）。

**否決**：

- **依 `agent_type` 一個閱讀器**（今天的做法）：`scanner` 同時是 HTTP、連線、C2 與 pcap，這正是錯配的來源。
- **讓外掛提供 React 元件**：違反「沒有 UI 外掛」。
- **每個種類一個閱讀器**：約 130 個元件，絕大多數會互相複製。

### D5 完整性：七個值，只依來源事實

**決定**：`completenessOf(kind, data, overlapsGap)` 依種類的 `content` 宣告選規則：

| 規則（`content`） | 適用 | 判定（依序，先中先決） |
|---|---|---|
| `relay-output` | `shell:command_end`（外部 shell、relay、`redlog-run`、PowerShell） | `output_disposition = redirected` → `redirected`；`= not-captured` → `not-captured`；`completeness = truncated` 或任一 `*_truncated` 或 `limit_hit` → `truncated`（已存 = 內嵌位元組或 ref 大小，共 = `*_bytes`，未知時不寫「共」）；`completeness = partial` 或 `output_streamed` → `partial`；`completeness = complete` → `complete`；以上皆無 → 交給 `cast-span`、`body-ref`，再無 → `unknown` |
| `cast-span` | 內建終端機的 `command_end`（`io`） | `io.unbracketed` → `unknown`；`io.len` 為數字 → `complete`（0 位元組時閱讀器另說「沒有輸出」） |
| `body-ref` | 有 `*_body_ref`、`stdout_ref` 的列 | `bodyTruncation()`（`content-contract.ts:103-112`）非 null → `truncated`；有 ref 或內嵌 → `complete`；`content_length = 0` → `complete` |
| `chunk` | `shell:command_output`、`shell:session_output` | 有 `incomplete`／`omittedBytes`／`pausedBytes`（`eventTitle.ts:66` 已讀）→ `truncated`；否則 `complete` |
| `transcript` | `agent:*` 有本文的列 | `truncated === true` 或 ref 截斷 → `truncated`；有本文或 ref → `complete`；否則 `unknown` |
| `image`、`stored-file` | 截圖、`artifact_added` | 檔案存在 → `complete`；不存在 → `unknown`，閱讀器另指向刪除紀錄（若有） |
| `external-file` | `scanner:pcap_segment` | `not-captured`（來源明說位元組留在擷取機上），附雜湊與路徑 |

最後一步：`overlapsGap === true` 時，任何結果都改為 `gap`（閱讀器另列原結果的位元組資訊）。`overlapsGap` 由 074 提供；074 落地前由閱讀器以已載入的缺口列判斷，且第一行加註「僅依已載入的紀錄」（Assumptions）。

- **AI 回傳內容的上游截斷**不在完整性內：完整性說的是 RedLog 是否保存了來源交給它的東西；AI 工具自己截斷的事實若在 transcript 中有記載，由 `ai-transcript` 閱讀器原樣顯示。
- 舊列沒有任何可判斷的欄位 → `unknown`。這取代今天 `commandOutputState` 對外部 shell 回 `not-captured`、對 `stdout: ""` 回 `empty` 的推斷（Spec 004、009 的斷言隨 T030 修改）。
- 顯示字串（zh-TW）：完整、截斷（已存 X，共 Y）、部分、未擷取、已重導、缺口、未知。七個 key；「沒有輸出」沿用既有的 `content.empty` 作為 `complete` 且 0 位元組時的補述。

**否決**：

- **擴充 `CommandOutputState`**：它把「位元組在哪裡」（inline／saved／recorded）與「是否完整」混在一個值裡；位置由 `ContentDescriptor` 回答，完整性另成一軸。
- **由 RedLog 推斷重導**（解析指令中的 `>`）：relay 已經做了且寫在列上；讀取端再推一次會出現第二份判斷。

### D6 區間、狀態與註記的宣告

```ts
interface IntervalDef {
  id: IntervalId; role: 'action' | 'effect' | 'state'
  start: KindId[]; end: KindId[]; members?: KindId[]; supersededBy?: KindId[]
  key: PairKey; fallbackKey?: PairKey; open: OpenMeaning
}
interface StateDef { id: StateId; transitions: KindId[]; valueField: string; groupBy: 'global' | 'terminal' }
```

起草時的宣告（074 消費；`PairKey` 的計算函式屬 074，今天的 `operationPairKey` 涵蓋 `command-id` 與 `tool-pair`）：

| id | role | start | end | members | supersededBy | key | open |
|---|---|---|---|---|---|---|---|
| `command` | action | `shell:command_start` | `shell:command_end` | `shell:command_output` | `shell:command_boundary`、同終端的 `shell:session_end` | `command-id`（後備：terminal＋pid＋command，同 `causes-resolver.ts:52-57`） | `not-seen-ended` |
| `agent-tool` | action | `agent:tool_call` | `agent:tool_result`、`agent:tool_interrupted` | — | `agent:session_end` | `tool-pair` | `not-seen-ended` |
| `terminal-session` | state | `shell:session_start` | `shell:session_end` | `shell:session_output` | — | `terminal` | `not-seen-ended` |
| `ai-session` | state | `agent:transcript_capture_started` | `agent:session_end` | `agent:*` | — | `agent-session` | `not-seen-ended` |
| `http-flow` | effect | `scanner:http_request_start` | `scanner:http_response`、`http_error`、`http_request_dropped` | `http_response_chunk`、`ws_message`、`websocket_end`、`tcp_message`、`tcp_end` | — | `flow-id` | `not-seen-ended` |
| `connection` | effect | `scanner:connection` | `scanner:connection_end` | — | — | `socket`（proto, local_port, remote_addr, remote_port；`connection-monitor.ts:203-212`） | `not-seen-ended` |
| `process` | effect | `process:process_spawn` | `process:process_exit` | — | — | `pid` | `not-seen-ended` |
| `recording-paused` | state | `system:recording_paused` | `system:recording_resumed` | — | — | `global` | `not-seen-ended` |
| `terminal-paused` | state | `shell:capture_stopped` | `shell:capture_resumed` | — | — | `terminal` | `not-seen-ended` |
| `project-open` | state | `system:session_start` | `system:project_closed` | — | 下一個 `system:session_start` | `global` | `unknown-before` |
| `pivot` | state | `pivot:tunnel_start`、`socks_up`、`port_forward`、`route_add`、`agent_connect`、`proxied`、`interactive` | `pivot:closed` | — | — | `pivot-route`（今天以指令文字，`active-pivots.ts:24-58`） | `detected-at` |
| `c2-pivot` | state | `scanner:c2_pivot`（`state = open`） | 同種類 `state = closed` | — | — | `c2-route` | `detected-at` |
| `capture-gap` | — | `scanner:capture_gap`、`system:capture_gap`（`shape: span-in-data`，`gap_started_at..gap_ended_at`） | — | — | — | `data-range` | — |

階梯狀態：`active-target`（`system:active_target_changed`）、`ip`（`system:ip_verdict`，`ip_verdict_kind`）、`proxy`（`system:http_proxy_started/stopped/failed`）、`opsec`（`system:opsec_state_changed`、`system:opsec_airgap`）。

註記的附著：`loot:*`、`pivot:*`、`cleanup:*`、`credential_use:*`、`system:scope_violation`、`file_transfer:upload/download` → `cause`；`marker:*` → `time`（`atTimestamp`）；`marker:amended` → `event`（`markerId`）。

record-fact 的適用區間欄位：`system:sanitized`、`system:retention_*`、`system:body_evicted`、`system:bookmarks_pruned` 宣告 `appliesFrom`／`appliesTo` 欄位名；今天沒有來源送，全部為 `unknown`（FR-045）。

`pivot` 的種類 `role` 是 annotation（推導的結論），它同時出現在一個 `state` 區間中：區間的角色描述區間，種類的角色描述列，兩者不衝突。

### D7 golden 與有記錄的修正

- **產生**（Phase 1，T004）：對每張要摺的表，以**今天的函式**對 `test/kinds/examples.ts` 的每個範例列求值，存成 `test/kinds/golden/<表>.json`。SQL 類（#18、#19、#30）另存 SQL 文字，並以 in-memory SQLite 對範例列求值存結果。
- **比較**（每個摺疊 PR）：`test/kinds/folded-tables.test.ts` 以新的登記表答案對 golden；差異必須恰好等於 `DOCUMENTED_FIXES` 中該表的項目。
- **起草時的 `DOCUMENTED_FIXES`**：

  | id | 表 | 種類 | 舊 → 新 | 依據 |
  |---|---|---|---|---|
  | F1 | #20、`commandOutputState` | `shell:command_end`（relay 欄位）、無欄位的舊列 | `empty`／`not-captured` → 依 D5 | US1、FR-034 |
  | F2 | #17 | `screenshot` | 無閱讀器 → `image` | US2 |
  | F3 | #17 | `scanner:connection*`、`packet_flow`、`c2_*` | `HttpDetail` → `packet-flow`；`pcap_segment` → `file`；`scanner:capture_gap` → `record-fact` | US2、10 A.4 #8 |
  | F4 | #17 | `shell:capture_stopped/resumed`、`command_boundary`、`wsl_test`、`system:*` 的 record-fact | `fields` → `record-fact`；`shell:command_output`、`session_output` → `text-output` | US2 |
  | F5 | #15 | 10 的清單 (1) 的 29 個 | 預設分支 → 專屬標題 | US2、SC-004 |
  | F6 | #16 | `SearchPanel` 有自己摘要的種類 | 搜尋摘要 → `eventTitle` | US2 |
  | F7 | #12、#13 | `pcap:*`、`scanner:connection*`、`packet_flow`、`pcap_segment` | `system`／`scanner` 泳道 → 連線泳道；`scanner:c2_*` → C2 泳道（取代無寫入者的 `c2_checkin`）；`scanner:capture_gap` → `system` 泳道；`http_navigation`、`scanner` 泳道以來源改名 | US4 |
  | F8 | #10 | `http_navigation`、`pivot`、`file_transfer:*`、`credential_use` | `other` → `network`、`network`、`evidence`、`security`；移除沒有寫入者的 `connection`、`artifact`、`file`、`alert`、`scope_violation` 項目 | US4 |
  | F9 | #19、#29 | `shell:command_*` 載入 `tlogger_prompt_command`、PowerShell profile 的那一行 | 算作工作 → 不算（與 #18 一致） | US4 |
  | F10 | #5 | `credential_use:*` 經契約 1 入口 | 允許 → `kind-not-allowed`（舊入口不變） | FR-006 |

  `activity.group` 的 `tcp_message` 依 `flow_id` 分組（10 的 E.2）**不**列入：它會改變 Activity 的 `act1` 身分雜湊（`activity-projection.ts:14-29`），屬 074 的投影版本變更。死字串 `websocket_message`、`websocket_start` 從集合中移除，不改變任何答案。

### D8 族登記

| 族 | 理由 | 閱讀器 |
|---|---|---|
| `external:*` | 外部工具經舊入口的任意 subtype（`external-event-policy.ts:12`） | `fields` |
| `terminal:*` | `redlog-cli log terminal` 的說明文字型別（`external-event-policy.ts:9-11`） | `fields` |
| `agent:*` | adapter 的開放分支；已知 subtype 各自登記，族只承接未知的 | `ai-transcript` |

族的數量是 ratchet（FR-015），基準 3。族項目的 `tier` 為 chained（071 FR-113 的核心預設）。

### D9 外掛宣告的種類

`validatePluginKind(pluginId, decl)`：`decl = {kind: string, label: string, reader?: string}`。

- `kind` 已在核心登記表 → 回傳核心項目，`labelKey` 以外不可覆寫；`label` 只在核心沒有 `labelKey` 時採用。
- 不在核心 → 產生項目：`role: 'effect'`、`tier: 'logged'`（071 FR-113）、`pause: 'gated'`、`writers: ['plugin']`、`reader: decl.reader ?? 'fields'`、`lane`：該外掛 Source 的 `agentType` 若有核心泳道則用之，否則 `system`、`title: 'plugin-label'`、`content: []`、`counts.work: true`、`housekeeping: 'never'`。
- `reader` 不在 `ReaderId` → 拒絕（`unknown-reader`）；`decl` 中 `kind`、`label`、`reader` 以外的鍵（含今天 `eventTypes` 的 `lane`、`color`、`icon`）→ 忽略並回報；泳道依上一項的規則決定。
- `family`：該外掛 Source 的 `agentType` 若有核心族則用之，否則 `signals`。
- 宣告保存在 075 的 manifest 狀態中（075 FR-055 的 `emits[] = {kind, label, reader?}`，與 `PluginKindDecl` 同形）；登記表模組不持有可變狀態，呼叫端把目前的外掛宣告傳入 `kindOf(row, plugins)`。

### D10 tier 的唯一來源與 `TIER_CHANGES`

`tierFor(agentType, subtype, producerClass)`：已登記 → `kind.tier`；未登記且 `producerClass` 為 `plugin` → logged；其他 → chained。`classifyTier` 改為呼叫它（071 D10 的四步合併為這一個函式，`CORE_CHAINED` 不另立，因為登記表本身就列出全部 chained 種類）。

`TIER_CHANGES`：每項 `{kind, from, to, since: KIND_REGISTRY_VERSION, decision}`，只影響新列。初始內容 = 071 T027（`scanner:packet_flow`、`scanner:pcap_segment`、`scanner:c2_*` 由外掛憑證寫入時 → logged）。瀏覽器 console 的實際 tier（chained）照實登記；是否改為 logged 是開放問題 Q1。

### D11 `project_closed`

- 種類與欄位屬本規格：`{reason, last_alive_at?}`，`reason` 的值域等於 073 的 `CloseReason` 加 `unclean`（`closed`、`switched`、`reopened`、`app-quit`、`update-restart`、`open-failed`、`unclean`），以 `as const` 從 073 的型別導出不可行（本目錄不得 import 目錄外，FR-020），所以在 `types.ts` 列出，並由 `test/kinds/registry-shape.test.ts` 與 073 的 `CloseReason` 比對相等。
- 寫入點屬 073：`lifecycle-records` 資源在 `stop` 時呼叫 `writeProjectClosed(reason)`（資料庫關閉之前、該 session 最後一列）；當機後由同一資源在下一次開啟的 `session_start` 之前寫 `unclean`（073 FR-034）。073 落地前，本規格 T051 掛在今天的切換專案與 `before-quit` 路徑，只產生 `switched`、`app-quit`、`update-restart`。
- 經 071 的行程內入口，身分 `in-process`；`system` 暫停豁免；失敗不阻擋關閉，寫入 capture 狀態。
- 沒有存活戳記可據的當機（073 之前的版本、戳記遺失）不補寫；那一段在 `project-open` 區間中為 `unknown-before`。

## 登記項目的欄位

```ts
interface KindDef {
  id: `${string}:${string}`                 // agent_type:subtype，或 agent_type:*
  status: 'active' | 'legacy'
  legacy?: { lastWrittenIn: string; reason: string }
  role: Role                                // action | effect | state | record-fact | annotation
  shape: Shape                              // point | start | end | chunk | span-in-data | transition
  tier: 'chained' | 'logged'                // ← #1
  pause: 'gated' | 'exempt' | 'gated-by-observation'        // ← #2、#3
  writers: readonly ProducerClass[]         // ← #5；值域 = 071 FR-071 + in-process、derived
  identity: {
    target: readonly TargetStep[]           // ← #4；071 FR-010 的哪幾步；operator-selected（071 O16）
    terminal: boolean; command: boolean; flow: boolean; agentSession: boolean
  }
  cause: CauseRule                          // ← #6、#7：none | lifecycle | flow | socket | derived | trigger | candidate
  scopeSignal: boolean                      // ← #8
  annotation?: { attachesTo: 'cause' | 'time' | 'event' }   // FR-044
  appliesRange?: { from: string; to: string }               // FR-045（record-fact）
  title: TitleId                            // ← #15、#16
  labelKey: string                          // ← #13（種類自己的名稱；泳道名在 LANE_DEFS）
  lane: LaneId; band: BandId                // ← #12
  family: KindFamily                        // 'commands'|'traffic'|'ai'|'artifacts'|'signals'|'record'；074 的 topics 與 cause_counts
  activity: { group: 'command' | 'tool' | 'http' | 'message' | 'event'; action: ActivityAction }  // ← #9、#10
  reader: ReaderId                          // ← #17
  content: readonly ContentRule[]           // ← #30、D5
  badges: readonly BadgeId[]                // ← #20
  transcript: 'command' | 'output' | 'ai' | 'http' | 'marker' | 'loot' | null      // ← #23
  counts: { work: boolean; total: boolean } // ← #19；total 供 074 的計數
  housekeeping: 'never' | 'always' | RowRuleId                // ← #18、#29
  export: { attachment: 'screenshot' | 'artifact' | 'cast' | 'transcript' | null
            summary: 'pause' | 'gap' | 'recovery' | null; har: 'flow' | 'companion' | null }  // ← #24–#26
  invalidates: readonly ('scope' | 'config')[]              // ← #33
}
```

`LANE_DEFS: Record<LaneId, {labelKey, band}>` 取代 `LANE_LABEL_KEYS` 與 `BANDS` 的成員清單。

## 模組邊界

**擁有**：登記表資料、`KIND_REGISTRY_VERSION`、全部封閉列舉、`TIER_CHANGES`、列規則、完整性規則、外掛種類的驗證規則。不擁有任何可變狀態、資料表或檔案。

**公開介面**（`src/core/kinds/index.ts`）：

```ts
export type { KindDef, KindId, Role, ReaderId, TitleId, LaneId, BandId, KindFamily, Completeness, ProducerClass,
              IntervalDef, StateDef, PluginKindDecl, KindRow } from './types'
export { KINDS, INTERVALS, STATES, LANE_DEFS, TIER_CHANGES, KIND_REGISTRY_VERSION } from './registry'
export function kindOf(row: KindRow, plugins?: ReadonlyMap<string, KindDef>): KindDef | undefined
export function requireKind(id: KindId): KindDef
export function tierFor(agentType: string, subtype: string, producer: ProducerClass): 'chained' | 'logged'
export function mayWrite(agentType: string, subtype: string, producer: ProducerClass): boolean
export function pauseRuleOf(agentType: string, subtype: string): KindDef['pause']
export function completenessOf(kind: KindDef, data: KindRow['data'], overlapsGap: boolean): Completeness
export function housekeepingSql(): string            // 逐字等於今天 HOUSEKEEPING_SQL（＋F9）
export function isHousekeeping(row: KindRow): boolean
export function workSql(): string; export function isWork(row: KindRow): boolean
export function validatePluginKind(pluginId: string, decl: PluginKindDecl):
  { ok: true; kind: KindDef } | { ok: false; reason: 'unknown-reader' | 'malformed' }
export function intervalsOf(id: KindId): readonly IntervalDef[]
```

**不得 import**：目錄外的任何模組（FR-020）。

**誰可以 import**：所有層。renderer 只在 `kindPresentation.tsx`（`TITLES`、`READERS`）把 `TitleId`／`ReaderId` 對應到程式；其他 renderer 檔案以 `kindOf()` 的欄位判斷，不以 `agentType` 字面值（D3 的 ratchet）。

**renderer 端的對應**：`src/renderer/src/lib/kindPresentation.tsx`（`TITLES`、`READERS`、`readerFor`）。它是唯一可以依 `TitleId`／`ReaderId` 分支的地方。

## 遷移順序

依「操作者看得到的分歧」排序（10 的 A.4、B.2 ★）：

1. **Phase 3a** 完整性（F1）—— 操作者會依它下錯結論。
2. **Phase 3b** 閱讀器分派（F2–F4）—— 截圖沒有圖、連線用 HTTP 檢視器；併入 `work/1112-present` 的手寫分派（FR-054）。
3. **Phase 3c** 標題（F5、F6）。
4. **Phase 3d** 泳道與標籤（F7）—— 「HTTP」與「代理」錯名、pcap 分兩處、`capture_gap` 分兩處。
5. **Phase 3e** 內務與計數（F9）—— 三份規則。
6. **Phase 3f** Activity 歸類（F8）。
7. **Phase 3g** 徽章、卡片、Transcript、`BODY_SOURCE_PREDICATE`、失效集合（無可見差異，純摺疊）。
8. **Phase 4** 行為表（與 071 Phase 3 同步）：tier → 暫停 → 寫入者（F10）→ 目標步驟 → 因果與範圍訊號 → 型別化入口。
9. **Phase 5** 區間宣告交給 074；`project_closed`。
10. **Phase 6** 匯出與外掛。

每一步一個 PR，五道 gate 全綠，D3 的計數與表數同時下降。跨 071–075 的順序只寫在 [specs/README.md](../README.md)「071–075 的跨規格順序」。

## 與兄弟規格的介面

| 兄弟 | 本規格需要 | 本規格提供 | 誰擁有重疊處 |
|---|---|---|---|
| 071 寫入契約（Draft，已合併） | 行程內入口接受 `KindId`；`classifyTier` 改呼叫 `tierFor`（071 D10 已於 2026-11-12 改寫為取用本規格）；種類政策（071 T010、FR-065）讀 `writers`；暫停判斷（071 T015）讀 `pause`；目標決定（071 T024）讀 `identity.target`；`project_closed` 與其他新列走它的入口（071 FR-092） | 登記表即 FR-113 的「核心表」；`ProducerClass` 值域 = 071 FR-071（含 O13 的 `agent-tools`）+ `in-process`、`derived`，外掛記為 `plugin` | 種類的**資料**歸 072；強制、時間基準、目標演算法、回執歸 071 |
| 073 專案執行期 | 關閉序列中、資料庫關閉前的掛鉤與 reason 判定（073 FR-033、FR-034） | `project_closed` 的種類與欄位（`reason`、`last_alive_at`） | 關閉流程、reason 的值與時機歸 073；紀錄的形狀歸 072 |
| 074 查詢與投影 | 「列是否與缺口重疊」（074 FR-048 的 `gapOverlaps`）；以 `counts.total` 計數的總數查詢（074 的 `kind_totals`、`counts:snapshot`）；區間、狀態帶、`stateAt`、效應總數的計算；`invalidates` 的變更通知；`PairKey` 的計算函式 | `INTERVALS`、`STATES`、`role`、`family`、`annotation`、`appliesRange`、`housekeepingSql()`、`workSql()`、`invalidates`、`KIND_REGISTRY_VERSION`；`kindOf(row, plugins?)` | 宣告歸 072；計算與查詢歸 074；074 的投影不得另寫種類表：`src/core/projections/**` 在本規格的 `kind-literal-ratchet` 中允許數為 0（074 plan 的閘門表引用它） |
| 075 來源描述與 manifest v2 | manifest 中每個 `emits` 項目的 `{kind, label, reader?}`；來源描述列出它證明的 `KindId`（取代 #28） | `validatePluginKind`、`requireKind`、`ReaderId`、`LaneId`、`KindId` | manifest 格式、外掛頁的拒絕呈現、來源狀態歸 075；種類項目的預設值歸 072 |

## 驗證策略

- **golden**：33 張表中要摺的 31 張，每張一個 golden（D7）；071 T002 的舊列 golden 不變（SC-010）。
- **gate**：

  | 規則 | gate |
  |---|---|
  | 模組純度、renderer 的 Node 走訪 ratchet | `test/kinds/registry-pure.test.ts` |
  | 登記項目合法、區間一致、族 ratchet、FTS 不依種類 | `test/kinds/registry-shape.test.ts` |
  | 寫入者 ↔ 登記（雙向）、legacy | `test/kinds/writers-registered.test.ts` |
  | TS 寫入者型別化 | `npm run typecheck` + `test/kinds/untyped-kind-calls.test.ts`（ratchet） |
  | 每個種類可呈現 | typecheck（`Record`）+ `test/kinds/every-kind-presentable.test.tsx` |
  | 字面值比較 ratchet | `test/kinds/kind-literal-ratchet.test.ts` |
  | 摺疊等價 | `test/kinds/folded-tables.test.ts` |
  | 完整性一致 | `test/kinds/completeness.test.ts` |
  | 外掛種類驗證 | `test/kinds/plugin-kinds.test.ts` |
  | 新匯出可達 | 既有 `verify:architecture`（Phase 2 期間以 allowlist 附理由，Phase 3 第一個 PR 移除） |

  **沒有 gate 的規則**：一個種類的**角色**是否選對。這是語意判斷，由 PR 審查依 DESIGN-two-tier-chain 的問題式與本計畫 D6 判定；gate 只保證它有值且區間一致。

- **真機**（不能以單元測試取代；接觸到的畫面在契約落地時於真實 app 檢查）：
  - 畫面：時間軸（泳道、標題、檢視器的每一種閱讀器）、Activity 工作區（動作篩選、閱讀器）、搜尋結果、Transcript、目標頁的證據清單（內務）、首次使用（`isWork`）、匯出對話框摘要（不應變化）、HTTP 紀錄（不應變化）。
  - macOS：外部 zsh（relay）跑 `ls`、`ls -al`、`nmap -oN x 127.0.0.1`、`vim`、背景工作；bash 3.2；內建終端機；受管代理 `curl`；手動截圖；`redlog stop`／`start`；全域暫停；切換專案、結束 app、`kill -9` 後重開（`project_closed` 有無）；claude-code adapter 一段對話。
  - Linux 或 Kali：pcap-capture 外掛與 `hooks/pcap-agent.py`（sudo）、host-monitors pack 的連線監控、c2 tailer 以範例日誌；檢查三者同泳道同閱讀器。
  - Windows：PowerShell transcript pack 的 `command_end` 完整性欄位（10 的 UNCONFIRMED 10）。

## 風險

| 風險 | 處理 |
|---|---|
| `BODY_SOURCE_PREDICATE`、`HOUSEKEEPING_SQL` 產生的 SQL 文字與今天不同，觸發部分索引重建或查詢計畫改變 | golden 存 SQL 文字並逐字比較；F9 是唯一允許的文字差異，且只影響 `EVIDENCE_SQL`（不是索引述詞） |
| 摺疊閱讀器時 e2e 依元件的 `data-testid` 或文字定位 | 每個 Phase 3 PR 先 grep `e2e/` 與 `test/` 的對應字串與 test id（記憶：Orca worker 看不到 e2e），在 PR 前跑受影響的 spec |
| `work/1112-present` 與 Phase 3b 同時改檢視器 | FR-054：誰先合併，另一方以它為 golden；不並存兩份分派 |
| 型別化入口牽動 33 處呼叫與 071 的 T037 遷移 | 與 071 T037 同一批 PR 處理同一檔案群；ratchet 只降 |
| 登記表成為新的「大檔」 | 依資料生命週期而非行數：登記表就是資料，一個項目一行物件；不拆 |
| 外掛宣告的種類在外掛停用後仍有舊列 | Edge Cases：沿用最後宣告或 `fields`，不隱藏 |

## Project Structure

### Documentation (this feature)

```text
specs/072-event-kind-registry-and-readers/
├── spec.md
├── plan.md
├── tasks.md
└── verification.md        # T080 建立
```

### Source Code

```text
src/core/kinds/{types,registry,rules,completeness,plugin,index}.ts      # 新增
src/renderer/src/lib/kindPresentation.tsx                               # 新增：TITLES、READERS
src/renderer/src/components/readers/{Image,PacketFlow,RecordFact,TextOutput}Reader.tsx  # 新增的閱讀器
test/kinds/{registry-pure,registry-shape,writers-registered,untyped-kind-calls,every-kind-presentable,
            kind-literal-ratchet,folded-tables,completeness,plugin-kinds}.test.ts(x)
test/kinds/{examples.ts,golden/,kind-literal-allowlist.json}
# 改為讀登記表：event-write.ts、ingest.ts、external-event-policy.ts、causes-resolver.ts、socket-attribution.ts、
# alert/scope-signal.ts、activity-projection.ts、event-queries.ts、content-contract.ts、export-*.ts、
# do-not-export.ts、event-registry.ts（移除）、timelineDomain.ts、eventTitle.ts、timelineEvents.ts、
# TimelineEventInspector.tsx、SearchPanel.tsx、housekeeping.ts、knownLists.ts、TranscriptView.tsx、timelineCard.ts
```

**Structure Decision**：在 `src/core` 下新增一個目錄，不搬動既有檔案；`activity-contract.ts`、`timelineDomain.ts` 以 re-export 保持呼叫端不變。

## Complexity Tracking

| 新增 | 解決的現存問題 | 較簡單做法為何不夠 |
|---|---|---|
| `src/core/kinds/` 模組 | 33 張以種類為鍵的表、三份內務規則、兩份標題（10 B.1、03 F2） | 在各表旁加註解「記得同步」就是今天的做法 |
| 十種閱讀器的封閉列舉 | 依 `agent_type` 分派造成的 6 處錯配（10 A.4 #1、#8、#9） | 逐一補分支會在下一個來源再錯一次 |
| 寫入端掃描測試 | 聲稱存在的 totality 測試不存在 | 只靠型別看不到 `hooks/` 與外掛 |
| golden + `DOCUMENTED_FIXES` | 摺疊時無法分辨「修正」與「回歸」 | 只跑既有測試：既有測試不涵蓋多數種類 |
