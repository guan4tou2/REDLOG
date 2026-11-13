# Implementation Plan: 交付邊界與內容生命週期

**Branch**: `spec/077-personal-content-and-delivery` | **Date**: 2026-11-13 | **Spec**: [spec.md](spec.md)

## Summary

今天資料離開 RedLog 的路徑有十幾條，各自決定要排除什麼、遮什麼：計畫匯出排除 `do_not_export` 與個人流量，API 匯出不排除；bundle 與 `redact-export` 各有一份遮蔽；寫入時算的 span 只在操作者手動 `sanitize` 後才影響交付；HAR 原樣交出 `Authorization`。扣下任何一列都讓 bundle 失去連結驗證。本計畫做四件事，每件一個擁有者模組與 gate：

1. **一個交付點**（`src/core/delivery/`）：每個出口只經 `deliver()`；狀態判斷、遮蔽、stub、計數都在這裡。舊路徑刪除。
2. **交付狀態＝註記＋規則＋範圍**：操作者的決定是上鏈的註記；規則依生效時間；範圍關係只用確定的目標，名稱與位址兩面比對；其餘分組詢問。
3. **完整性不因扣下而降級**：stub 佔位、連結照常驗證；遮蔽的列連結可驗、內容宣告為不可驗。
4. **清除內容**：一條專用的 trigger 例外，加上逐一列舉的儲存。

**2026-11-13 深夜的修訂（spec 修訂 S1–S8，DECISIONS §12）**：五條不變條件各有一個 gate（`test/delivery/` 下五個檔，見「不變條件的現況」與 tasks T006–T009、T021、T022、T045）；每次交付記下 `DeliveryRecord`；範圍版本由鏈上的 `config_changed` 重放（Phase 10）。私人終端機、「個人」分類與「不記錄」取消：只有一套錄製流程，唯一的「不收集」是 Spec 071 的暫停；本規格只管交付。

## Technical Context

**Language/Version**：TypeScript（core、main、renderer）；Python 3（`tools/redlog-verify.py`、`hooks/redlog-relay.py`、`hooks/mitmproxy-addon.py`）；POSIX shell、PowerShell（hook 的 skip 規則讀取）。
**Primary Dependencies**：不新增執行期套件。property test 用 `fast-check`（若尚未在 devDependencies，Phase 1 加入，只在測試）。
**Storage**：專案 `timeline.db` 只多新種類的列（`system:delivery_mark`、`system:delivery_rule`、`system:redacted`、`system:content_cleared`、`system:name_mapping`、`system:name_resolved`）與一張只在清除交易中有內容的 `content_clear_authorized`；`derived.db` 多 `delivery_state` 投影（074）；`machine.yaml` 多 `delivery.excludeRules[]`、`network.resolveScopeNames`（073 擁有檔案；修訂 S4、S6：原為 `personal.rules[]`、`personal.followShellHistory`，且有 hook 讀的 `~/.redlog/personal-skip.json`，皆取消；排除規則的層級：兩層都可設、預設專案層，spec R24、D27）；專案 `config.yaml` 多 `delivery.rules[]`；`system:config_changed` 多鍵 `scope.effective`、`system:export_sealed` 多欄 `delivery`（不新增種類）。刪除 `do_not_export`、`sanitized_events` 兩張表。
**Testing**：Vitest（決策表、property、突變、共用向量、清除後掃描）；pytest 風格的 Python verifier 向量經 `test/evidence-vectors.test.ts` 驅動；e2e 一支（預覽＝位元組），依專案記憶交給 CI。
**Constraints**：不新增頁面；不改事件的雜湊與簽章算法；不改寫既有列（清除內容是唯一例外，FR-062）；不相容舊格式（R8）；元件不在元件內宣告。

## Constitution Check

| 原則 | 本計畫 |
|---|---|
| I 證據完整 | 扣下不刪除；清除留雜湊與紀錄；stub 保住連結 |
| II 介面誠實 | 遮蔽的列明說內容不可驗；對應的來源標明；分類改變不靜默 |
| III 單一實作 | 一個交付點、一個遮蔽引擎、一個 `classifyTarget` |
| VI 未知與空不同 | `ask` 不是 `deliver` 也不是範圍外；未知的位址不判範圍外 |
| VIII／IX | 每條規則一個 gate；刪除有 forbidden-alias gate |

## 現況（`origin/main@ea91d268`，開檔確認）

| 事實 | 位置 |
|---|---|
| 匯出格式：json、ndjson、bundle、har、timeline；沒有 CSV | `src/core/export-capabilities.ts:7,17-23` |
| 計畫匯出排除 do-not-export 與個人流量並計數 | `src/core/export-planning.ts:29,39-54,91-92` |
| 計畫執行前比對來源與政策（`policy-changed`） | `src/core/export-planning.ts:126-140` |
| 單筆遮蔽：do-not-export、個人網域 → null；套 `sanitized_events`；scope 遮罩；丟 `*_ref` | `src/core/redact-export.ts:65-114` |
| bundle 自己一份：同樣的排除、sanitize、scope 遮罩；`transformedEventIds`；`personalDropped` | `src/core/bundle-export.ts:347-416,437-475,827,842,861-866` |
| bundle 拒絕 AI 原始 transcript 與任何排除並存 | `src/core/bundle-export.ts:212-231` |
| sanitize：只用寫入時的 span；寫 `system.sanitized`；`INSERT OR REPLACE INTO sanitized_events` | `src/core/sanitize.ts:84-146` |
| `do_not_export` 旁表、可變、切換 | `src/core/db/index.ts:306-312`；`src/core/db/do-not-export.ts:3-42` |
| `sanitized_events` 表 | `src/core/db/index.ts:295-304` |
| `event_notes` 旁表 | `src/core/db/index.ts:325-330` |
| FTS contentless、可刪 | `src/core/db/index.ts:445-448` |
| append-only trigger | `src/core/db/event-write.ts:204-224` |
| 鏈的正規化 | `src/core/evidence-rules.ts:123-144`；寫入 `event-write.ts:602,619-631` |
| verifier：projection 不比 `prev_hash`、transformed 不重算 | `src/core/bundle-verify.ts:150-157,200-213`；`tools/redlog-verify.py:409-430,488-523` |
| v4 manifest 欄位白名單 | `src/core/bundle-verify.ts:45-49`；`tools/redlog-verify.py:216` |
| API：`GET /api/events`、search、count、HAR、http-body、marker、replay、bundle、sanitize | `src/core/api-server.ts:418-509,511-528,670-734,756-777,781-801` |
| API 的 HAR／bundle 沒有 `personalDomains` | `src/core/api-server.ts:488,759-762` |
| IPC：do-not-export 切換與查詢 | `src/main/ipc/events.ts:183,215` |
| IPC：計畫匯出 | `src/main/ipc/data-export.ts:93,118,150` |
| 個人網域判斷 | `src/core/scope-sanitize.ts:44-48` |
| 範圍分類器 | `src/core/scope-evaluator.ts:200-259` |
| 目標擷取策略 | `src/core/target-extractor.ts:29-60` |
| 全域目標承接 | `src/core/ingest.ts:71,240-262` |
| 出口檢查的 DNS 與 offline | `src/main/services/producers/ip-signal-producer.ts:25-60,127-135,196,222`；`src/core/config.ts:49,57,281-282` |
| addon：DNS 問答、TCP peer、TLS SAN、client peer | `hooks/mitmproxy-addon.py:747-757,1036-1048,1098-1125,1659-1730,1847,1921` |
| bash 前導空白照記 | `hooks/shell-bash-hook.sh:358-379,568-600` |
| `command-class.json` 的 wrappers | `hooks/command-class.json:87-90` |

## 模組

```
src/core/delivery/
  state.ts          deliveryOf(row, ctx)：FR-004 的優先序；純函式
  selectors.ts      選擇器的解析與比對（FR-003）
  rules.ts          排除規則與交付規則的評估（since）（修訂 S6：不再編譯 skip 規則）
  record.ts         DeliveryRecord 的組成（FR-113）；deliver 的最後一步
  scope-history.ts  範圍版本的重放、scopeAtEvent（FR-115–FR-118）
  target.ts         classifyTarget(name?, address?, at, scope, mappings)：K 段；目標頁也用
  mappings.ts       對應的讀取（observed-dns／observed-http／hosts-file／lookup），「早於 t 最接近」
  groups.ts         問題組（FR-025）
  redact.ts         redactForDelivery、scanWrite（一組規則）
  deliver.ts        deliver(request) → DeliveryStream（唯一出口）
  writers/          json、ndjson、timeline、csv、har、bundle：只吃 DeliveryStream
  clear.ts          清除內容（FR-061–063）
src/main/services/hosts-file-watch.ts   FR-104
src/main/services/scope-resolve.ts      FR-105（getaddrinfo；offline 時不存在呼叫路徑）
```

`deliver` 在匯出 worker 上執行（今天的 `export-direct-bundle`／worker 路徑），API 讀取經 074 的讀取服務（074 FR-012），兩者呼叫同一個函式。

## 資料形狀

```ts
type Selector =
  | { t: 'ids'; ids: string[]; batch?: string; query?: string }
  | { t: 'command_id'; commandId: string }
  | { t: 'terminal'; terminalId: string; from: number; to: number | null }
  | { t: 'ai_session'; sessionId: string; from?: number; to?: number }
  | { t: 'flow_ids'; flowIds: string[] }
  | { t: 'producer'; producer: string; from: number; to: number | null }
  | { t: 'host'; hostSha256: string; from?: number; to?: number }

// system:delivery_mark
{ v: 1, decision: 'withhold' | 'deliver' | 'clear',
  reason: 'operator-excluded' | 'answer', selector: Selector, note?: string }   // 修訂 S4：原為 'personal' | 'answer' | 'private-terminal'

// system:delivery_rule
{ op: 'add' | 'remove', rule_id, scope: 'machine' | 'project',
  match_kind: 'host' | 'command' | 'ai-path', pattern_sha256, pattern?, action, since }

// bundle events.jsonl 的 stub（恰好四個鍵）
{ "id": "…", "withheld": "operator-excluded|out-of-scope|unanswered|cleared", "hash": "…", "prev_hash": "…" }

// system:redacted
{ exportId, policyVersion, replacements: [{ event, field, sha256 }] }

// system:content_cleared
{ event_ids, original_hashes, cleared: { bodies, casts, screenshots, artifacts, transcripts, derived, spool }, vacuum }

// system:name_mapping / system:name_resolved
{ source: 'hosts-file', name, addresses, at }
{ name, answers, resolver: 'system', at, trigger: 'scope-added' | 'operator' }

// DeliveryRecord（FR-113）：system:export_sealed 的 delivery 欄；讀取回應的 delivery 欄
{ v: 1, exportId, at, format, destination: 'folder' | 'api' | 'cli' | `exporter:${string}`,
  basis: { chainHead: { id, hash }, scopeVersion: { id, hash } | null, scopeBasis: 'current' | 'at-event',
           policyVersion, rulesDigest, mappingsDigest, includeOutOfScope },
  result: { delivered: { chained, logged },
            withheld: { chained: { operatorExcluded, outOfScope, unanswered, cleared }, logged: { … } },
            redacted, unredactable, reclassified, selectedIdsSha256, stubIdsSha256, artifactSha256? } }

// system:config_changed 的新鍵（FR-115）；既有的 scope.* 鍵不變
changed['scope.effective'] = { from: EffectiveScope | null, to: EffectiveScope }
basis: 'saved' | 'observed'
type EffectiveScope = { hash /* scopeHash */, targets, excludeTargets,
                        scopeFile: { path, sha256, entries } | null }
```

## 決策與被否決的替代方案

### D1 交付狀態是投影，決定是註記
**決定**：`system:delivery_mark` 上鏈；狀態由 `deliveryOf` 算出，074 物化。
**被否決**：(a) 沿用 `do_not_export` 可變旁表——撤銷不留痕跡，與「處理過程本身是證據」相反；(b) 在被指到的列加欄位——列不可變；(c) 註記寫 logged 層——收件者無法驗證扣下是操作者在何時做的決定。

### D2 優先序
**決定**：清除 > 最新註記 > 規則（withhold 勝）> 範圍 > ask。
**被否決**：範圍優先於私人——R7 明定私人勝（修訂 S4：讀作「操作者的明確排除勝」）。規則優先於註記——操作者事後的明確決定應勝過事前寫的規則。

### D3 只有確定的目標承接算數
**決定**：FR-022 的封閉清單；`terminal-last` 不算。
**被否決**：`terminal-last` 算範圍內——`cd ~/personal`、`vim ~/notes.md` 會承接前一條 `nmap` 的目標而直接交付；它由資料決定，但不是「這一列與那個目標有關」的證據（071 O18 正是為此而存在）。工作階段指令的輸出則不同：互動紀錄**就是**那一條指令的輸出列，目標由同一列的參數擷取，沒有推測。

### D4 一張私人規則表、兩種動作
> **Superseded（2026-11-13，修訂 S4、S6）**：只剩一種動作 `withhold`，表名 `delivery.excludeRules[]`（排除規則）；`skip`（不記錄）隨「只有一套錄製流程」取消（擁有者確認）。層級依 spec Q7 的答覆：兩層都可設、預設本專案（D27）。下文保留原決定。

**決定**：`personal.rules[]` 每條 `action: withhold | skip`。兩者都需要：`withhold` 是 R2 的主路徑（可撤回、內容在本機）；`skip` 是 R3 的次路徑，給「內容連落盤都不該」的東西（密碼管理器、銀行）。
**被否決**：兩份清單（忽略清單與自動標記規則）——同一個樣式語法、同一個設定列、同一個概念（「這是私人的」）在兩處維護，違反 §26.5；把一條規則從「不交付」改成「不記錄」只是改一個欄位。**也否決**只留 `withhold`：R3 明定忽略清單存在。

### D5 「一律交付」只在專案層
> **注（2026-11-13，修訂 S4）**：本節「私人是對自己的」是排除規則放在機器層的唯一理由，R19 取消了這個分類；spec Q7 據此建議排除規則也改為專案層。「一律交付」只在專案層不變。
> **注（2026-11-13 深夜，修訂 S10）**：Q7 的答覆是兩層都可設、預設專案層（D27）；「一律交付」仍只在專案層。

**決定**：專案 `config.yaml` 的 `delivery.rules[]`。
**被否決**：機器層的「一律交付」——在 A 客戶專案答的「`cd` 一律交付」會在 B 客戶專案生效；交付是對某個客戶的承諾，私人是對自己的。

### D6 規則在讀取時依 `since` 評估
**決定**：規則不蓋進列；增刪在專案鏈上留 `system:delivery_rule`（機器規則只留雜湊）。
**被否決**：寫入時把規則 id 蓋進 `_ingest`——需要改 071 的入口；刪除規則後已蓋的列仍帶它；而規則表本來就有 `since`，讀取時評估是確定的。

### D7 stub 讓交付範圍內每個位置都在
**決定**：bundle 唯一格式；`complete-chain` 與 `window` 都逐一檢查連結。
**被否決**：(a) 沿用 projection、不檢查連結——扣下一列就失去整份的連結驗證，操作者會因此不扣下；(b) 對被扣下的列另附 Merkle 證明——鏈本來就是線性雜湊，`prev_hash` 已是最小的證明。

### D8 stub 只揭露 id、雜湊、理由碼
**決定**：`id`、`hash`、`prev_hash`、`withheld`。
**理由**：連結只需要 `hash` 與 `prev_hash`；`id` 是隨機 UUIDv4（`event-write.ts:602`），讓其他列的 `_causes` 指向「被扣下」而不是「不存在」，並滿足 verifier 的唯一 id 檢查；理由碼讓收件者知道是誰的決定（操作者私人、範圍外、未答、清除），擁有者與協調者都建議揭露它。
**被否決**：(a) 揭露種類家族——`traffic` 的 stub 在私人瀏覽時說出「這裡有流量」，比「這裡有一列」多；(b) 揭露時間——位置已夾在兩列之間，不需要更精確；(c) 不揭露理由——收件者無法區分「範圍外的觸碰」與「私人」，前者對他是有意義的事實。

### D9 遮蔽的列「連結可驗、內容不可驗」
**決定**：不重算遮蔽列的雜湊；`system:redacted` 承諾替代值；verifier 報告。
**被否決**：(a) 寫入時的內容部分承諾（G.ii）——可以讓遮蔽後仍完整驗證，但改的是 071 的列格式與寫入路徑，獨立成一項決定；(b) 遮蔽的列一律改成 stub——收件者失去整列，而他需要的是除了 secret 以外的一切。

### D10 私人列讀取時排除，不刪索引
> **Superseded（2026-11-13，修訂 S5，R20）**：讀取時也不排除：被排除的列照常出現在搜尋結果。「不刪索引；token 只由清除內容移除」不變。

**決定**：搜尋預設不回傳；token 只由清除移除。
**被否決**：標記時刪 FTS、撤回時重建——每次撤回要重讀列、重算索引；「不被搜到」已由讀取排除達成；磁碟上的 token 是清除內容的工作。列為 Q2。

### D11 遵循 shell 歷史排除預設關
> **Superseded（2026-11-13，修訂 S6）**：遵循 shell 歷史排除取消（擁有者確認）；本節的理由（前導空白會讓攻擊指令無聲遺失）也是取消它的理由之一。

**決定**：機器層開關，預設關；永遠不遵循忽略重複。
**理由**：許多發行版預設 `HISTCONTROL=ignoreboth`；從筆記或網頁貼上的指令常帶前導空白；預設開會讓攻擊指令無聲遺失，而 RedLog 的第一個承諾是完整（R2）。bash hook 的註解已記錄今天刻意照記前導空白的行（`shell-bash-hook.sh:358-379`）。
**被否決**：預設開——對已習慣用前導空白隱藏指令的人最自然，但代價是證據遺失且看不出來（只有計數）。列為 Q1。

### D12 私人終端機中的攻擊指令不補錄
> **Superseded（2026-11-13，修訂 S3）**：私人終端機取消，本節不再適用。

**決定**：v1 不支援；以標記代替。
**被否決**：私人終端機在本機緩衝內容以便事後補錄——等於「記錄但藏起來」，私人終端機就不再是不記錄；緩衝本身是要保護的東西。

### D13 跨到被扣下列的整檔附件不交付
**決定**：cast 分段、AI 原始 transcript 只要涵蓋任何被扣下的列就不附，不能勾回。
**被否決**：(a) 依時間切 cast——cast 的輸出與指令沒有可靠的位元組界線（`api-server.ts:702-720` 的回放就需要時間窗備援）；(b) 讓操作者勾回——勾回就交出了他剛扣下的內容。

### D14 「不交付」的鍵
**決定**：`lib/shortcuts.ts` 的單一表中一個鍵，預設 `p`（UNCONFIRMED 是否已被佔用；tasks T018 確認，衝突時另選並記在本節）。不放按鈕，避免與唯一的標記動作競爭（§26.3、DECISIONS §4）。
**被否決**：工具列按鈕——第二個主動作；終端機指令——R11。

### D15 問題組與量測
**分組演算法**（每列恰好一組，依序取第一個成立的鍵）：
0. （修訂 S11）`rule:<rule_id>`：機器層排除規則與範圍衝突的列（`rule-scope-conflict`），一條規則一組。
1. `ai:<session>`：AI 種類，以工作階段 id。
2. `remote:<名稱>`：`_ingest.producer = remote:*`。
3. `conflict:<名稱>|<位址>`：K 段第 2 條。
4. `host:<可註冊網域>` 或 `host:<IPv4 /24>`／`<IPv6 /64>`：有確定目標但無法確認。
5. `cmd:<可執行檔>`：`wrappers` 解析後的第一個字（與 `terminal-class.ts` 同一套解析）；`sudo vim x` 為 `cmd:vim`。
6. `file:<種類>`：截圖、artifact。
7. `kind:<家族>`：其他。
組依列數由多到少；「依終端機分開」把一組拆成 `<鍵>@<終端機>`。

**量測**：`test/fixtures/delivery/engagement-a.ndjson`（2,000 列）與 `engagement-a-day2.ndjson`（+500 列），每列帶標註 `_label: deliver | exclude`（修訂 S4：原為 `work | personal`）。來源：以公開 walkthrough 的指令序列合成的行動（`nmap`、`curl`、`ssh`、`impacket`、AI 回合）穿插典型的不該交付的操作（`cd`、`ls`、`vim ~/notes`、瀏覽、`brew`），比例依擁有者描述的實際混合（約 30% 沒有目標）；擁有者自己的匿名化樣本若可取得，另以同一腳本在本機量測、不進 repo。`scripts/measure-delivery-questions.mjs` 以「每組依多數標註回答、勾以後一律」模擬操作者，印出：第一次回答數、第二次回答數、分組錯誤列數（組內少數標註的列數）。門檻見 SC-003。（修訂 S9）fixture 包含範圍外的 DNS 列與樞紐建立指令，它們現在依 `host:` 成組詢問；擁有者接受組變多的代價，三個數字照常印出，門檻是否需要調整由 T030 的第一次量測決定並記在本節。
**被否決**：(a) 依終端機區段分組為主——一個終端機混著工作與私人，正是 R2 的前提；(b) 依指令類別（`command-class.json`）——它是執行方式（relay／pty／native），`vim` 與 `nc` 同為 native；(c) 推測「可能私人」的訊號——R7 已否決。

### D16 在 app 內選「私人」也扣下已記錄的列
> **Superseded（2026-11-13，修訂 S3）**：私人終端機取消，本節不再適用。要扣下一個終端機的一段，用 `terminal` 選擇器（FR-011）。

**決定**：選「私人」寫停止原因，並以 `terminal` 選擇器扣下該終端機至今的列。
**理由**：操作者把一個 pane 設為私人時，意思是「這個 pane 是私人的」，而它在被看見之前至少送過一條（`hello`）。只停錄而留下已記錄的列交付，與他的意思相反；扣下可撤回。
**被否決**：只停錄——事後還要再找出那些列。

### D17 名稱與位址的比對表
| 名稱＼位址 | 在範圍內 | 排除 | 不在範圍內 | 未知 |
|---|---|---|---|---|
| 在範圍內 | 範圍內 | 衝突→詢問 | 範圍內 | 範圍內 |
| 排除 | 衝突→詢問 | 範圍外 | 範圍外 | 範圍外 |
| 不在範圍內 | 詢問（共用主機） | 範圍外 | 範圍外＊ | 範圍外＊ |
| 未知 | 範圍內 | 範圍外 | 範圍外＊ | 詢問 |

＊ 只有當範圍中有與該面同型的項目時；否則先用對應換成另一面再比，仍無法比 → 詢問（FR-101 第 6 條）。`no-scope` 時整表為詢問。
**理由**：名稱是操作者選擇交談的對象（CDN 的位址服務他人不改變名稱的歸屬）；位址在範圍內而名稱是另一個已知、未列入的名稱，是共用主機上其他客戶的典型情況，必須問。
**被否決**：(a) 位址決定一切——CDN 背後的範圍內名稱會被判範圍外；(b) 名稱決定一切——共用主機上的他人虛擬主機會被判範圍外而不問，這其實是對的方向，但當範圍明確以位址宣告時，客戶的意思常常是「這台機器上的一切」，所以問；(c) 只有一面時判範圍外——範圍以名稱宣告而 `nmap` 打位址，是最常見的情況，判範圍外會把主要工作扣下。

### D18 RedLog 自己的名稱查詢（分析）
**擁有者的看法**：查詢應該可以接受。逐點核對：

| 論點 | 程式現況與分析 | 結論 |
|---|---|---|
| RedLog 本來就自己連網 | 是：出口檢查每 `checkInterval`（預設 60 s）以 DNS 查 OpenDNS 與 Google（`ip-signal-producer.ts:25-60`；`config.ts:278-282`），失敗時 HTTP 備援；OTS、NTP 亦然（報告 11 D.2）。但那些查詢的內容是 RedLog 自己的出口，不含任何客戶的名稱 | 「RedLog 有流量」不是新的；「RedLog 的流量帶客戶的名稱」是新的 |
| 操作者的工具本來就會解析這些名稱 | 是，但在**它們**的時刻、經**它們**的路徑（VPN 已起、經 SOCKS 時在遠端解析） | 同一個名稱、不同的時刻與路徑 |
| (1) vantage | 系統解析器的答案可能與工具看到的不同：分割 DNS、內部名稱、經 SOCKS／樞紐時在遠端解析（`proxychains` 的 `proxy_dns`）。分類若用 RedLog 的答案，可能把工具實際連的位址判錯 | 觀察到的對應必須勝過查詢（FR-103、FR-105 第 6 條） |
| (2) 洩漏 | 經系統解析器的查詢不經操作者的樞紐或 SOCKS；加入範圍的時刻常早於 VPN 就緒，查詢會把客戶的（含內部）名稱送到當時的 ISP、公司或公用解析器；直接對客戶的權威伺服器查詢則從操作者未打算使用的位址出現 | 預設不在加入時自動查（Q5 建議關）；查詢只在操作者按下時 |
| (3) 第三方 | 為觀察到的任意名稱查詢，會產生關於非範圍對象的流量 | 只查宣告在範圍內的名稱；萬用字元只查根 |
| (4) 記錄者成為行動者 | RedLog 的查詢會出現在客戶的 DNS 日誌，沒有指令可以解釋 | 每次查詢上鏈（`system:name_resolved`），在交付中可被解釋 |
| (5) 反向查詢 | PTR 由位址擁有者控制，常缺或錯（雲端、CDN） | 從不做反向查詢 |
| 離線開關 | `network.offline` 已控制出口檢查（`ip-signal-producer.ts:222`）與 OTS（`chain-anchor.ts:43-45`） | 查詢服從同一開關 |

**決定**：被動觀察是主要來源（代理的 DNS 模式、直接連線的 HTTP、hosts 檔）；查詢是**有界的補充**：正向、只查宣告在範圍內的名稱、只在加入時（開關開）或操作者按下時、服從 offline、每次上鏈、標明來源、與觀察不一致時觀察勝。解析器用系統的 `getaddrinfo`，因為它與本機工具同一個 vantage（尊重 hosts 檔與 VPN 的分割 DNS），而指定外部解析器會讓洩漏面更大且答案更不像工具看到的。
**被否決**：(a) 從不查詢（協調者原本的硬性規則）——範圍以名稱宣告、工具以位址工作、又沒有開代理的行動，將有大量列只能詢問；(b) 對每個觀察到的名稱查詢——(3)(4) 全部成立；(c) 週期重查——每次都是新的流量，而對應改變時觀察到的事實已經會告訴我們。

### D19 hosts 檔是對應來源
**決定**：讀 hosts 檔中**提到範圍項目**的條目，寫成上鏈的 `system:name_mapping`。今天沒有任何程式讀它（grep 無結果）。
**理由**：實驗環境與許多行動中，操作者把目標名稱寫進 `/etc/hosts`；那是他在本機明確宣告的對應，零網路流量。
**被否決**：讀整個 hosts 檔——其他條目可能是私人的（公司內網、家用裝置）。

### D20 交付一律遮蔽
**決定**：匯出面沒有「不遮蔽」；`scrubPii` 成為遮蔽區段內的一項。
**被否決**：遮蔽開關——「不遮蔽」只對操作者自己的備份有意義，而操作者自己的副本是專案目錄本身（或 073 的封存），不是交付；開關會讓 076 Q4 的前提變成一個可以關掉的選項。

### D21 「這次包含範圍外」不寫註記
**決定**：只屬於那一次匯出，記在計畫與 manifest（`includedOutOfScope`）。
**被否決**：寫一列 `deliver` 註記——下一次匯出會靜默地包含同一批範圍外的列；R9 說預設不交付，例外要每次都看得見。

## 匯出面：既有元件與本計畫的改動

| 既有（`ExportMenu.tsx`） | 改動 |
|---|---|
| 標題列按鈕、模態對話框（`:441-468`）、完成畫面（`:478-485`） | 不變；完成畫面加扣下摘要一行 |
| 範圍與格式選單（`:482-500`） | 不變；選 Exporter 目的地時格式固定 |
| `scrubPii` 開關（`:527-528`） | 移入遮蔽區段，所有格式支援 |
| `maskScope` 開關（`:529-530`）與 `export.preview.policy*` | 刪除（範圍外不再「遮內容後交付」，R9）；改為包含區段「範圍外」行的「這次包含」勾選 |
| 預覽數字列（`:601-606`：`total`、`outOfScopeHttp`、`outOfScope`、`dropped`、`personalDropped`、`sanitized`） | 由包含區段（範圍內／範圍外／待確認／已排除（修訂 S4：原為「個人」）／已清除／分類改變）與遮蔽區段取代 |
| 其他預覽數字列（`:617-637`：附件、截斷、暫停、缺口、中斷、部分 HTTP 流） | 不變 |
| `AttachmentList`（`:81-135`） | 每項加「無法遮蔽」標記；跨到被扣下列的整檔附件顯示為 `contains-withheld`、不可勾回 |
| 目的地列（`:578-585`） | 成為選單：資料夾＋本專案已啟用的 Exporter |
| 主要按鈕（`:669`） | 不變，唯一的主動作 |
| `resolveExportPlan`（`:252`）／`executeExportPlan`（`:389`） | 不變的流程；計畫由 `deliver` 產生；回答待確認後重新解析 |

**沒有折進匯出面、也沒有新增介面的**：活動紀錄中的一個鍵（R13 明定保留）；閱讀器第一行的一個字（含 FR-117 的「當時範圍外」）；列上的「不交付」符號（FR-015 修訂）；設定「資料與隱私」分組中既有位置的一列「排除規則」（規則的檢視與刪除，不屬於某一次匯出）；（修訂 S3、S4：原文另有來源列綁定控制項的「私人」值，已取消）範圍設定中的「解析範圍內的名稱」動作（屬於範圍的編輯，FR-105）；清除內容的輸入確認（UIUX 規定的危險操作確認，用既有的 `ConfirmDialog`）。

## 18 條路徑的去向（報告 11 B.1）

| # | 今天 | 本計畫 |
|---|---|---|
| P1 `detectRedactions`（`ingest.ts:633-648`） | 寫入時算 span | 改呼叫 `scanWrite`（同一規則集）；交付不讀 span |
| P2 marker 的 `redactFields` | 同上 | 同上 |
| P3 `/api/marker` 沒有 span | — | 經 071 單一入口後同上（I2） |
| P4 AI 寫入前破壞性遮罩 | — | 不改（Assumptions） |
| P5 剪貼簿監看 | — | 已裁定刪除（根因審查 §4 第 7 項） |
| P6 `credential_use` 長度遮罩 | — | 不改 |
| P7 loot preview 原文 | — | loot 值成為交付規則集的輸入；preview 交付時被遮（I5、I12） |
| P8 >4 KiB 先移到 sidecar | 沒有 span | 交付時重掃 sidecar（I1） |
| P9 `sanitize()` | 逐筆、只用 span | **刪除**；`/api/sanitize` 刪除 |
| P10 `redactEventForExport` | 交付端 | **刪除**，由 `deliver` 取代 |
| P11 bundle 自己一份 | 交付端 | **刪除**（I6） |
| P12 `scopeMaskReplacements` | 範圍外遮內容 | **刪除**：範圍外預設扣下（R9）；「這次包含範圍外」時經同一遮蔽引擎 |
| P13 `scrubOperatorPii` | 只在 JSON/NDJSON | 併入規則集的 `pii`，每個出口都可（I8） |
| P14 HAR header／cookie 原文 | — | 結構規則（I4） |
| P15 API 讀取原文 | — | 經 `deliver`（I7） |
| P16 UI 顯示與複製 | 原文 | 不變（操作者自己的畫面）；註解改寫（I10） |
| P17 搜尋索引 | 原文 token | 讀取時排除私人；清除時刪除（I3、I11）。修訂 S5：讀取時不排除，只由清除刪除 |
| P18 閱讀器存檔與複製 | 原文 | 不變（操作者自己的動作，不是交付） |

I9（新規則套不到舊列）由 FR-051 的重掃解決。

## 清除的範圍（FR-061）

| 儲存 | 位置 | 處理 |
|---|---|---|
| chained 列的 `data` | `events` | 換成 `{"_content_cleared":id}`，經 FR-062 的 trigger 例外 |
| logged 列 | `events_logged` | 刪除（logged 層本來可刪，retention 已這樣做） |
| 全文索引 | `events_fts`、`events_logged_fts`（`db/index.ts:445-448`） | rowid 刪除 |
| body sidecar | `http-bodies/<sha>.body`（`http-body-store.ts`） | 只被清除列引用者刪除 |
| body 索引 | `http-body-index.db` 的 `body_fts`（報告 11 A） | 刪對應項 |
| cast | `casts/*.cast` 的分段；`cast-index.db` | 涵蓋者整檔刪除 |
| 截圖、artifact | `screenshots/`、`artifacts/` | 刪除 |
| AI transcript 副本 | `agent-transcripts/*.jsonl`、`ai-raw` 索引 | 涵蓋者整檔刪除 |
| 推導列 | `loot`、`credential_use`、`pivot`、`scope_violation`（`_causes`） | 同樣清除 |
| 操作者註解 | `event_notes`（`db/index.ts:325-330`） | 刪除 |
| 投影 | `derived.db`（074） | 刪除並重算 |
| 交接與隔離 | `~/.redlog/pending/*.json`、`.bad`、`.unattributed`（`spool-replay.ts:74,148`、`inflight-marker.ts:104`）、071 FR-066 的隔離檔 | 含該事件 id 者刪除 |
| 原始位元組 | `raw/YYYYMMDD.raw`（報告 11：今天沒有生產者寫入） | 若有，刪除 |
| WAL | `timeline.db-wal` | `wal_checkpoint(TRUNCATE)` |
| 不能保證 | 已匯出／上傳的副本、備份、快照、SSD 重映射、shell history、AI 工具自己的 transcript、剪貼簿 | 對話框列出 |

trigger 例外：SQLite 的主資料庫 trigger 不能參照 temp 表，所以 `content_clear_authorized` 是主資料庫中的一般表，只在清除交易中有內容；trigger 的 `WHEN` 條件同時檢查該表與新值的形狀（UNCONFIRMED：以單元測試確認 trigger 在 `better-sqlite3` 的交易中如預期）。

## 不變條件的現況（spec 修訂 S1；2026-11-13 於 `main@b2d56fb7` 開檔確認）

| 不變條件 | 事實 | 位置 |
|---|---|---|
| I1 | 寫入路徑的直接 import 中，與範圍有關的只有 `scopeSignalFor`；它在 insert 之後派送，結果是新增一列 | `src/core/ingest.ts:25,328-331` |
| I1 | `db/event-write.ts`、`spool-drain.ts`、`spool-replay.ts` 不 import 任何範圍或設定模組；`POST /api/events` 只做驗證後交給 `ingest` | `src/core/api-server.ts:319-417` |
| I1 | `ingest.ts` 的遞移閉包經 `db/event-queries.ts:17` 走到 `scope-evaluator.ts`（讀取輔助，不在寫入決策上）——所以 gate 用名稱 ratchet、不用閉包 | 以 import 圖量測 |
| I1 | `hooks/` 沒有任何範圍或個人網域的讀取（唯一的 "scope" 是 `pcap-agent.py:135` 的註解） | grep |
| I1 | `scope.personalDomains` 只在查詢與匯出時讀，`config-apply-plan.ts:187` 自己寫明 "read when exporting and querying" | `export-selection.ts:41`；`export-planning.ts:27,84`；`scope-sanitize.ts:44-48` |
| I2 | 範圍重算在一個交易內只寫新列：`scope_recomputed` 摘要與 flag／regrade／clear 列 | `src/core/scope-recompute-run.ts:252-300` |
| I2 | 不可改寫：`no_update_events_hash`、`no_delete_events` | `src/core/db/event-write.ts:204-224` |
| I3 | 沒設範圍時分類為 `in_scope`；重算在沒有允許項目時不跑 | `scope-evaluator.ts:233-235,244`；`scope-recompute-run.ts:208` |
| I4 | 只有 bundle 留鏈上紀錄（`export_sealed`） | `evidence-rules.ts:17`；`bundle-export.ts:94-98` |
| I5 | 扣下任何一列即成為 projection、不檢查連結 | `bundle-export.ts:827`；`bundle-verify.ts:200`；`tools/redlog-verify.py:488` |

### D22 用詞對照只寫一次
**決定**：「納入／排除／待確認」＝`deliver`／`withhold`／`ask`，寫在 spec L 段開頭；其餘一律用後者。
**被否決**：改用擁有者的三個詞——本規格的識別字已被 072 登記表、074 讀取參數、076 的 `reads.withheld` 引用；換名只換來同義詞的第二套。

### D23 I1 的 gate 是名稱 ratchet，不是閉包
**決定**：寫入路徑每個檔直接綁定的範圍相關名稱等於基準（今天一項），雙向失敗；另加每個入口的行為測試。
**被否決**：(a) 遞移閉包不得到達 `scope-evaluator.ts`——第一天就紅，原因與擷取無關（讀取輔助在同一個 barrel）；(b) 只有行為測試——新入口或新的提早 return 要等有人想到要測。

### D24 交付紀錄：產物上鏈，讀取不上鏈
**決定**：產生檔案的交付寫一列 `system:export_sealed`（bundle 沿用它的 seal 列）；串流式讀取在回應中帶同樣的欄位。
**理由**：「保留政策版本與結果」的對象是交出去、之後要被解釋的東西；一份檔案恰好一列。API 讀取可以每秒數次（`redlog-cli` 的查詢、本機 AI 工具），逐次上鏈會讓鏈以讀取為主；擴充功能的讀取另有 076 的 `system:extension_read`。
**被否決**：(a) 新種類 `system:delivery_recorded`——與 seal 同一件事，bundle 會有兩列；(b) 只寫在檔案內——檔案離開後，本機無從回答「那次交出了什麼」。

### D25 範圍版本：沿用 `config_changed`，加「觀察到」的列；不監看設定檔
**決定**：`scope.effective {from,to}` 寫在既有的 `config_changed`；開專案、套用存檔、建立匯出計畫前比對磁碟與鏈，不同就先寫 `basis:'observed'`。
**理由**：今天每次存檔已經上鏈，缺的是建立時、手改與 `scopeFile` 內容三個缺口（spec「範圍在鏈上的現況」）；三個時點都是 RedLog 本來就讀設定檔的時刻，不多一個監看者。`observed` 的 `from` 與前一列的 `to` 不相接時，中間的列在 FR-117 中可能是 `unknown`——這是誠實的答案，不是缺陷。
**被否決**：(a) 新種類 `system:scope_version`——重放要讀兩種列；(b) 監看 `config.yaml` 與 `scopeFile`——多一個常駐資源與它的錯誤狀態，換來的只是把「觀察到的時間」提早，仍不是「被改的時間」；(c) 只重放既有的 `scope.targets` 鍵——不含 `scopeFile` 的內容，建立時的範圍也不在。

### D26 部分交付的 bundle：證明與標示都做
**決定**：stub＋seal 是選取證明；另在 manifest 寫 `evidence.selection: filtered`，兩個 verifier 各印一行說明它不是完整的原始鏈。
**理由**：條文允許二擇一，但 stub 只證明「哪些位置被扣下、理由碼是什麼」，不證明理由正確；收件者若只看 `VERIFIED` 與 `complete-chain`，會把它讀成完整的原始鏈——這正是條文禁止的。一個欄位與一行輸出的代價很小。
**被否決**：只做其一。

### D27 排除規則兩層、預設專案層（擁有者對 Q7 的答覆）
**決定**：專案層存在 `config.yaml` 的 `delivery.rules[]`（`action: deliver | withhold`），機器層存在 `machine.yaml` 的 `delivery.excludeRules[]`（只有 `withhold`）。「以後一律」勾選旁的層級值預設「本專案」，兩項選單的另一項是「這台機器的所有專案」。交付規則只有專案層。
**理由**：擁有者的第三種答案；層級是那一次回答的一個值，不是另一個控制項或頁面（R6、R13、UIUX §26）。
**被否決**：(a) 第二個勾選「套用到所有專案」——兩個並排的勾選需要說明它們的關係；(b) 在設定中改層級——同一條規則換層級等於換對象，刪除重答更清楚，且機器層規則在其他專案的鏈上已留紀錄。

### D28 機器層排除規則與範圍衝突 → `ask`（擁有者裁定）
**決定**：FR-004 (3b)：機器層規則只在本專案沒有自己的判斷時生效；本專案的範圍或交付規則說「交付」時，成為 `ask`／`rule-scope-conflict`，一條規則一組。專案層排除規則不是衝突。
**理由**：機器層規則是在別的專案裡做的決定；範圍與專案層規則是這個專案的決定。兩者相反時，任何一方靜默勝出都是用一個專案的事實覆寫另一個（R25）。把「專案層交付規則」與「範圍內」同樣看待是本計畫的延伸：兩者都是本專案說「交付」。
**被否決**：(a) 規則勝（原 FR-004 的優先序）——擁有者裁定否決；(b) 範圍勝——機器層規則形同不存在於範圍內的列，而它正是為範圍無法判斷的情況（另一個客戶的主機）而設。

## 順序（spec R22，擁有者的優先順序）

Spec 071 擷取完整性 → 本規格的交付邊界 → 範圍版本與交付重新判定 → 匯入與匯出的操作體驗。

| 可以現在開始（不等 074 的讀取契約） | 要等 |
|---|---|
| Phase 0；Phase 1 的 gate 與決策表 T001–T009（I1、I2 的守衛只讀今天的寫入路徑；T006 的基準在 071 單一入口合併時移到新檔）；純函式 T011–T013；T014 的 writer；T015；T016 以今天的讀取路徑呼叫同一個 `deliver`（過渡，T013 已寫明）；T021、T022 | T019（查詢鍵，需要 074 的 `parseQuery` 契約）；FR-005 的 `delivery_state` 投影（074 Phase 4–5）；FR-006 讀取參數的正式形狀；FR-022 第 1 項的 `target_via`（071 FR-010；之前以今天的承接過渡，T012） |
| Phase 3（stub、bundle 第 5 版，與 072 T063–T065 配對）；Phase 4（遮蔽） | Phase 2 的 T033 機器層規則的儲存（073 Phase 4；過渡已寫明）；專案層規則在今天的 `config.yaml` 即可 |
| — | Phase 10（範圍版本）：依擁有者順序排在 Phase 1–4 之後；T100 動到 073 的 `config-store`，與 073 Phase 4 協調 |
| — | 匯入與匯出的操作體驗（DECISIONS §12「同時定下的幾件事」）不屬本規格 |

## 跨規格的依賴與需要的修改

| 規格 | 本規格需要 | 處置 |
|---|---|---|
| 071 | `append(delivery_mark)` 能力；有意遺失原因 `ignored-rule`、`shell-history-rule`；skip 規則在 hook 的觀察點；`target_via` 落地；遠端 hook 只裝在自己的主機（R12）；`redlog private` 移除（R11）。**修訂 S3、S6**：不需要 `ignored-rule`、`shell-history-rule` 與 hook 的 skip 觀察點；FR-087 的私人終端機取消；暫停（FR-080–FR-084）是唯一的「不收集」；單一入口落地時加入 FR-110 的擷取路徑清單 | 指標已加（2026-11-13 深夜） |
| 072 | 新種類：`system:delivery_mark`、`system:delivery_rule`、`system:redacted`、`system:content_cleared`、`system:name_mapping`、`system:name_resolved`；閱讀器第一行的交付字。**修訂 S1、S2**：不新增種類；既有 `system:config_changed` 多 `scope.effective` 鍵與 `basis` 欄，既有 `system:export_sealed` 多 `delivery` 欄，且每種格式的交付都寫；`kinds.json`、`intervals.jsonl` 照 DECISIONS §11 併入第 5 版 | tasks T010、T022、T100；指標已加 |
| 073 | `machine.yaml` 的 `personal.*`、`network.resolveScopeNames`；專案 `delivery.rules[]`；終端機狀態檔停止原因 `private`（由 app 寫）；刪除 `personalTraffic`。**修訂 S2、S3、S4、S6**：`personal.*` 改為 `delivery.excludeRules[]`（機器層；專案層的排除規則在專案 `delivery.rules[]`，修訂 S10），沒有 `followShellHistory`；停止原因沒有 `private`；`config-store` 在開專案、套用存檔、建立匯出計畫前做 FR-115 的觀察檢查 | 指標已加（2026-11-13 深夜） |
| 074 | `delivery_state` 投影；讀取參數 `delivery`；查詢鍵 `delivery:`；topic `delivery`；刪除兩張證據表。**修訂 S2、S4、S5**：查詢值 `operator-excluded`（原 `personal`）；查詢鍵 `scope-then:`；`operator` 讀取不隱藏任何列 | 指標已加（2026-11-13 深夜） |
| 075 | 狀態讀數的「略過 N」；shell 列的綁定控制項「私人」。**修訂 S3、S6**：兩者都不需要；本規格對 075 沒有需求 | 指標已加（2026-11-13 深夜） |
| 076 | Exporter、L0、L2 經 `deliver`；`reads.withheld`；對齊列的最後一列；Q4 條件。**修訂 S3、S4**：FR-043 提示中的 `redlog private`、FR-044 與 `capture_stopped{reason:"private"}` 取消；`reads.withheld` 的理由 `operator-excluded`（原 `personal`） | 指標已加（2026-11-13 深夜） |

## Gate 實作

- 單一出口：以 `scripts/verify-architecture.mjs` 的 import 圖為基礎，加一張「讀證據表的模組」清單；允許清單只有 `src/core/delivery/**` 與 074 的讀取服務（後者的回應在交付出口仍經 `deliver`）。
- property：fast-check；產生器從 072 的登記表取每個種類的欄位形狀；每個出口一個 adapter 把輸出攤平成位元組。
- 突變：以環境變數 `REDLOG_DELIVERY_MUTANT=<名>` 讓 `deliver` 走對應的錯誤分支；只在 CI 的突變步驟開啟，正式碼中這個分支在建置時移除（`import.meta.env` 常數），gate 確認正式產物不含它。
- 刪除：`verify:specs` 的 forbidden alias 機制（`scripts/verify-specs.mjs:113-133`）。

## UNCONFIRMED

| 項目 | 最便宜的確認方式 |
|---|---|
| `p` 鍵是否已被 `shortcuts.ts` 或清單鍵盤佔用 | 讀 `src/renderer/src/lib/shortcuts.ts` 全檔與 `useListKeyboard` |
| mitmproxy 的 HTTP 流 `server_conn.peername` 在直接連線時是否可靠、經上游代理時是否為代理位址 | addon 單元測試加真實 mitmdump 一次 |
| pcap 外掛是否解析 DNS 回答（可作為另一個被動對應來源） | 讀 `plugins/pcap-capture/pcap-parse.js` |
| trigger 的 `WHEN` 條件引用主資料庫一般表在交易中的行為 | 單元測試 |
| `http-body-index.db` 的 `ai-raw` 是否可由交付出口讀到（報告 11 UNCONFIRMED） | 讀 `evidence-content.ts` 的 ref 分派 |
| 報告 11 中標 † 的 18 條路徑細節（本計畫只抽查 P9–P11、P14、P15） | 實作 Phase 4 時逐條開檔 |
| `ACTIVE_TARGET_FALLBACK_TYPES` 在 071 落地後是否已移除 | 071 Phase 2 合併後重讀 `ingest.ts` |
| `src/main/index.ts` 與 `official-agents.ts` 中出現的 "backup" 是否為專案資料的備份 | 讀兩處 |
