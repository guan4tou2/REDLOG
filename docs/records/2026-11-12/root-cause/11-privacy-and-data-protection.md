# 11 — 隱私與資料保護（root-cause review）

基準：程式碼讀自本機 checkout 的 `main@56c9fe6c`（未追蹤檔忽略）。`origin/main@427c33eb` 與它在 `src/`、`tools/` 只差 `src/core/hooks-manager.ts`（#717），所以規格 072–075 與晚間決定讀自 `origin/main`（`git show`），程式碼讀自本機 checkout。唯讀；沒有啟動 app、沒有跑測試、沒有讀 `~/.redlog`。為了讀 072–075，本機執行過一次 `git fetch`，只更新 remote-tracking ref。

標記說明：
- 一般的 `file:line` 是本人開檔讀過的。
- 標 **†** 的，是三個唯讀子代理（對外連線盤點、檔案權限與刪除、各來源的擷取邊界）開檔取得的；其中有些經本人抽查（下文註明），其餘本人沒有逐行複核。
- **UNCONFIRMED** 列在文末，每項附最便宜的確認方式。

## 摘要（10 行）

1. 遮罩不是「一個引擎」，而是 **18 條各自為政的路徑**（B）。其中最根本的一點：**偵測和套用之間斷了線**。寫入時算出的 `data.redactions` span，只有 CLI 的 `redlog-cli sanitize <event-id>` 會用到；JSON、NDJSON、HAR、bundle 四種匯出預設都**不套用**這些 span（`redact-export.ts:65-114`、`bundle-export.ts:370-397`）。程式內兩處註解寫「layer 4 still redacts everything that leaves」（`TimelineEventInspector.tsx:483-484`、`Timeline.tsx:1661-1666`），與實際行為不符。
2. 外部審查的八項主張：**5 項成立，3 項部分成立**，沒有一項被推翻。部分成立的是 (3)、(5)、(8)：AI 原始 transcript 目前沒有任何呼叫端能匯出；POSIX 上其他使用者被兩層 0700 目錄擋住；刪除雖然語意不清，但保留期與刪除專案都有實作。
3. 新發現（審查與 05 都沒有列出）：
   - 超過 4 KiB 的 shell stdout 在偵測**之前**就被移到 sidecar，因此永遠沒有 span（`ingest.ts:257-260` 對照 `:555-557`、`http-body-store.ts:149`）。
   - entropy 門檻 4.5 bits/char 在數學上抓不到任何十六進位 secret（最多 4.0）。
   - AI 的原始 transcript 被全文索引進 `http-body-index.db` 的 `body_fts`，而這個檔案不經 `private-fs`（`http-body-index.ts:21-27,104`）。
   - bundle 對已 sanitize 的 body 欄位不移除 `*_ref`，原始 `.body` 照樣附上（`bundle-export.ts:370-377` 對照 `redact-export.ts:100-105`）。
   - API 的 HAR 與 bundle 不帶 `personalDomains`（`api-server.ts:487,759-761`）。
4. 對外連線（D.2）：**不會把事件內容送往網路**。每分鐘查公有 IP、OTS、NTP、更新檢查預設都開；air-gap 在三處沒有即時生效 †。
5. 真正的資料外洩路徑不是 RedLog 自己上網，而是 **AI agent 透過 `redlog_search`／`redlog_events` 把原文讀進自己的 context**，再由 agent 送往它的雲端 LLM。這一點已由 Spec 071 O13 決定移除，但尚未實作。
6. 子題 (2) 的答案：**今天加的規則，在任何格式中都套不到昨天的列**。可行的做法是匯出時用當前規則重掃，把替代位元組寫進既有的 `sanitized_events`，並追加一列 chained `system.sanitized`。代價是兩個 verifier 目前只把這些列當成「transformed、未驗證」，不比對 `system.sanitized` 的 replacement sha256。要讓遮蔽可驗證，需要 C2PA 式的逐部分承諾（G.ii）。
7. 結構建議：新增 Spec 076「交付邊界與內容生命週期」，負責單一遮罩引擎、匯出時重掃、隱私／歸屬 overlay、清除內容、標為私人；其餘修改併入 071／073／074／075 既有的 FR。不新增頁面，也不新增證據儲存。
8. 產品選擇（存原文、分享時遮）：支持外部審查的建議。但要指出 AI tailer 今天做的是另一種選擇（寫入前破壞性遮罩），兩種語意並存，這本身就是缺陷。
9. 靜態加密：建議**不做** SQLCipher 等級的資料庫加密，改為明說依賴全磁碟加密，並只對封存（073）提供可選的 passphrase 封裝（E）。
10. 前十項改動（I）中有 6 項可以在 071 Phase 3 之前上線且不必重做：匯出端套用 span、bundle 與 redact-export 合流、header/cookie/query 結構化遮罩、檔案權限 gate、寫入端偵測的四個洞、air-gap 即時生效。

---

## A. 資料清單（依敏感度）

欄位代號：**S** 為可能出現的敏感類別（C = 憑證或 token，K = cookie，P = 個資，D = 客戶資料，O = 操作者的私人活動，M = 金鑰）；**R** 為誰讀得到（同 UID 一律讀得到，表中只寫對其他使用者的狀況）；**W** 為寫入前是否遮罩；**Del** 為保留期、驅逐或刪除專案是否會移除它；**X** 為哪些匯出會帶出它。

POSIX 的整體情況：
- `~/.redlog` 與每個專案目錄在啟動時都被 chmod 成 0700（`private-fs.ts:82-105`）。專案一律位於 `~/.redlog/projects/<id>`（`project-manager.ts:99` 一帶，`path.join(PROJECTS_DIR, id)`）。
- 所以專案內即使有 0644 的檔案，**其他使用者仍因無法進入目錄而讀不到**。0644 的實際風險在於：目錄權限被改動時、以及檔案被複製出 `~/.redlog` 時（bundle 以外的匯出、備份）。

Windows 的整體情況：`restrictToOwner`（icacls）只套用在 token、金鑰、AI transcript 目錄（`fs-acl.ts:10-18` †），其餘一律繼承使用者設定檔的 ACL（UNCONFIRMED）。

| 位置 | S | R（其他使用者） | W | Del | X |
|---|---|---|---|---|---|
| `timeline.db` `events.data`（chained）：`command`、`stdout`/`stderr`/`output`（≤4 KiB 時內嵌）、HTTP `url`、`request_headers`、`cookies`、`set_cookies`、`params.body_json/body_form`、≤4 KiB 的 body、marker 的 `notes`、loot 的 `matches[].preview`、agent 的 `output` 與 `text` | C K P D O | 0600 加 0700 目錄（`db/index.ts:130-142` †） | 只算 span，不改原文；AI 例外，先破壞性遮罩（B） | 永不：append-only trigger（`event-write.ts:204-224`） | 全部格式 |
| `events_logged`（logged tier） | 同上（例如 HTTP 與 DNS lane） | 同上 | 同上 | `retention.loggedTier.keepDays`，預設 0，即永久（`config.ts:245-251`） | 全部 |
| `events_fts` / `events_logged_fts` | 每個 JSON 葉的值都成為 token，包含 secret（`db/index.ts:425-436`） | 同 DB | 否 | contentless；chained tier 沒有 delete trigger（`:444-450`）；剩餘頁不覆寫 | 否（僅限本機搜尋） |
| `sanitized_events` | 已遮罩的副本 | 同 DB | — | 永久 | bundle、redact-export |
| `bookmarks`、`event_notes` | C（註解自己寫了「pasted credentials」，`config.ts:252-258`） | 同 DB | 否 | bookmarks 有 keepDays，預設 0 | 部分（UNCONFIRMED） |
| `http-bodies/<sha>.body`：HTTP body、>4 KiB 的 shell stdout/stderr | C K D | 檔案 0600（`http-body-store.ts:79`）；目錄建立時沒帶 mode（`:38`），下次開啟才收回 † | 否；>4 KiB 的 stdout 連 span 都沒有 | keepDays/maxBytes 預設 0；驅逐會寫 chained 紀錄 † | bundle 全部附上（沒設 scope 時），HAR 讀內容 |
| `casts/*.cast`（只錄輸出 `o`/`r`，`terminal-recording.ts:89`） | C（輸出回顯的密碼、`-p` 參數）、O | 檔案 0600 †，目錄建立時是 umask † | 否 | keepDays 預設 0 | bundle：整檔，不依 scope 裁切（`bundle-export.ts:566-589`） |
| `raw/YYYYMMDD.raw` | 生產者原始位元組 | `appendFileSync` 沒帶 mode → 0644（`raw-store.ts:44-79`） | 否 | 永不清 † | 否。**今天沒有任何生產者傳 `envelope.raw`**：所有 `envelope:` 呼叫點都不帶 raw（`api-server.ts:397,525`、`index.ts:952`、`ingest.ts:316`），所以這個儲存區實際上是空的 |
| `screenshots/*.jpg`（游標所在的整個螢幕 †） | O D C（畫面上的 token） | `writeFile` 沒帶 mode → 0644，目錄 0700（`screenshot-agent.ts:249,268`） | 不可能遮罩 | keepDays 預設 0 | bundle：personal 與 out-of-scope 排除，無目標的照樣附上（`:536-561`） |
| `artifacts/` | 操作者加入的任意檔 | `copyFileSync` 沿用來源檔的 mode † | 否 | 永不 † | bundle |
| `agent-transcripts/*.jsonl`（AI 原始 transcript 副本） | C O D | 0600、0700，Windows 用 icacls † | **否**（原文） | `agentTranscripts.keepDays` 預設 0 | bundle 選項 `includeAgentTranscripts` 存在，但沒有呼叫端（只出現在 `bundle-export.ts`）；閱讀器的「儲存或複製內容」† |
| `http-body-index.db`（`body_fts` 保存原文：body、artifact、ai-raw） | C K O D | **不經 private-fs**，umask（`http-body-index.ts:21`），也不在 `restrictRedlogHome` 內（`private-fs.ts:94-99`） | 否 | body 被驅逐時刪索引 †；logged 列被刪時不刪（UNCONFIRMED） | 否 |
| `cast-index.db`（`cast_fts` 保存文字） | C O | 0600 † | 否 | 隨 cast 一起刪 † | 否 |
| `derived.db`（074，尚未存在） | 投影出的摘要 | — | — | 074 FR-033：可整個刪除 | 074 FR-033：不出現在任何匯出 |
| spool `~/.redlog/pending/*.json`、`.bad`、`.unattributed` | 整筆事件，包括指令與輸出 | 0600、0700 † | 否 | **永不刪**：刪專案不會清，`.bad` 也沒有任何程式讀（ROOT-CAUSE-REVIEW §2） | 否 |
| `~/.redlog/debug.log*` | 預設只記 id 與大小；部分呼叫帶錯誤訊息、路徑 † | 檔案沒帶 mode，位於 0700 目錄 † | — | 只在 2 MB 時輪替一次 | 否 |
| console（stdout） | engagementId、operatorId、錯誤物件 †；沒有指令或 body † | — | — | — | 否 |
| 剪貼簿 | 複製出去的事件 JSON、HTTP 內容、transcript、閱讀器文字 † | 系統全域 | 否 | **永不清除** † | — |
| HUD／overlay | IP、pivot、正在輸入的 marker 文字 †；沒有 `setContentProtection` † | 會被螢幕擷取拍到 | — | — | 間接進入截圖 |
| LootPanel 的 `preview` | 含 secret 的整行原文，最多 200 字（`loot-detector.ts:251-256,359`） | 畫面 | 否 | — | 間接 |
| `config.yaml`、`api-token`、`keys/*.key`、`active-identity.json`、`projects.json`、`hud-prefs.json` | C M | 0600 † | — | 刪專案只移除專案內的 config | 否 |
| `plugins/trust.json`、`state.json`、`terminals/*.json`、`hook-config.json`、`window-state.json`、`overlay-position.json`、`update-pending.json` | 中繼資料（專案路徑） | 沒帶 mode † | — | 刪專案時不清 | 否 |
| Windows 的 `~/.redlog/.curl-auth.$$` | C（bearer token） | 用完只截斷不刪，沒有 ACL † | — | 永不 | 否 |
| 匯出檔：預設 `<project>/exports`，或操作者指定的位置 | 全部 | bundle 完成後 `restrictTree`；outDir 本身是 umask；其他格式的 artifact 多為 0600 † | 見 B | 不追蹤 | — |

---

## B. 遮罩路徑的現況

### B.1 每一條路徑

| # | 函式（位置） | 規則集 | 時機 | 套到什麼 |
|---|---|---|---|---|
| P1 | `detectRedactions`（`ingest.ts:633-648`） | `getRules()`：操作者的 allow/deny、外掛 denylist、entropy 4.5 / 長度 20，加上本列的 loot 值 | 寫入前，結果進 hash | 固定欄位：`output`、`output_preview`、`command`、`stdout`、`stderr`、`request_body_preview`、`response_preview`、`ws_preview`、`tcp_preview`。只算 span |
| P2 | `redactFields(…, MARKER_TEXT_FIELDS)`（`ipc/markers.ts:107`、`index.ts:413-462`、`marker-amend.ts:97`） | 同 P1，但不含 loot 值 | 寫入前 | marker 的 title、notes |
| P3 | `/api/marker`（`api-server.ts:511-528`），以及經 `/api/events` 寫入的 `marker` | — | — | **無**：沒有 `redactFields`。ingest 的 P1 只看固定欄位，不含 `notes` |
| P4 | `redactSecrets`、`redactToolInput`、`outputIfPathHiddenByCommand`（`tailer-host.ts:568-630,734,775,822-826`；`secret-redaction.ts:40-60`） | `REDACT_IN_TRANSCRIPTS`，14 種形狀（`secret-patterns.ts:164-178`）。**不吃** `redaction.denylist`、外掛規則或 entropy | 寫入前，**破壞性替換** | AI 的 text、preview、tool input（依工具列出欄位；`Read` 不掃描）、tool output；路徑提示命中時整段隱藏 |
| P5 | clipboard monitor（`clipboard-monitor.ts:61-86` †） | `redact` + `maskText` | 寫入前 | 預設只存 sha256 與長度；preview 預設關閉 |
| P6 | `detectCredentialUse`（`credential-detector.ts:1-30`） | 自己的規則 | 寫入前 | `credential_use` 衍生列只存長度遮罩（`ingest.ts:364-371`） |
| P7 | loot `matches[].preview`（`loot-detector.ts:251-256`） | — | 寫入 | **原文整行**，最多 200 字；直接 `insertEvent`，不經 P1 |
| P8 | `extractTextToSidecar`（`ingest.ts:555-557`，在 P1 之前執行） | — | 寫入 | 超過 4 KiB 的 stdout/stderr 被移走，P1 看不到 → **沒有 span** |
| P9 | `sanitize()`（`sanitize.ts:84-146`），只能從 CLI 或 API 呼叫，UI 沒有入口 | 寫入時算好的 span | 事後、匯出前 | 只處理有 span 的欄位（`:92-98`） |
| P10 | `redactEventForExport`（`redact-export.ts:65-114`） | P9 的替代值加上 scope | 匯出 | JSON、NDJSON、HAR、匯出計畫的計數（`export-planning.ts:49,59,133`）、`export-events-file.ts:72` |
| P11 | bundle 自己的一份邏輯（`bundle-export.ts:341-420,424-470`） | P9 加上 scope | 匯出 | 與 P10 重複實作，且行為不同（I6） |
| P12 | `scopeMaskReplacements`（`scope-sanitize.ts:32-36,78-98`） | scope | 匯出 | 只遮內容欄位；`command`、`url`、header、`params`、cookie、`notes`、`description` 保留（`:29-31` 明寫） |
| P13 | `scrubOperatorPii`（`operator-pii.ts:13-34`） | home、user、host | 匯出 | 只在 JSON、NDJSON（`export-events-file.ts:29-30`）；bundle 不支援（`bundle-export.ts:569-570`） |
| P14 | HAR 的 `headersToHar` 與 cookie（`har-export.ts:83-120,263-275`） | — | 匯出 | **無**：Authorization、Cookie、Set-Cookie 原樣輸出；body 用 `readBodyForDelivery` 讀全文 |
| P15 | API 讀取：`GET /api/events`、`/events/search`、`/http-body/:sha`（`api-server.ts:418-509`） | `/http-body` 只套 scope | 讀取 | 事件原文（`withoutRowId`） |
| P16 | UI 顯示與複製（`TimelineEventInspector.tsx:483-488`、`Timeline.tsx:1659-1669`） | — | 讀取 | layer 3 已被刻意移除；畫面與複製都是原文 |
| P17 | 搜尋索引（`db/index.ts:425-436`；`http-body-index.ts:104,132` 的 `ai-raw`） | — | 寫入後 | 原文 token，AI transcript 的原文也在內 |
| P18 | 閱讀器的儲存與複製（`saved-content-delivery.ts:9-10` 明寫「not a scope-sanitized evidence bundle」） | — | 讀取 | 存檔的原文 |

### B.2 來源 × 時機矩陣

格內的意思：✕ 不處理、◐ 只算 span（套用要靠 P9 逐筆執行）、● 替換位元組、— 不適用。

| 來源與欄位 | 寫入 | 鏈上的值 | 搜尋 | UI | JSON/NDJSON | HAR | bundle | API 讀取 |
|---|---|---|---|---|---|---|---|---|
| shell `command` | ◐ P1 | 原文 | 原文 | 原文 | 原文（除非跑過 P9） | — | 原文（除非跑過 P9） | 原文 |
| shell stdout ≤4 KiB | ◐ | 原文 | 原文 | 原文 | 同上 | — | 同上 | 原文 |
| shell stdout >4 KiB | ✕（P8） | sidecar 原文 | body_fts 原文 | 原文 | ✕，P9 也做不到 | — | `.body` 原文 | 原文 |
| HTTP header、cookie、URL、params | ✕ | 原文 | 原文 | 原文 | 原文 | **原文**（P14） | 原文 | 原文 |
| HTTP body preview | ◐ | 原文 | 原文 | 原文 | 同上 | body 全文 | `.body` 全文，跑過 P9 後仍附上（I6） | 原文 |
| AI text、tool output | ● P4（固定 14 種形狀） | 已遮罩 | 遮罩版加上 **ai-raw 原文** | 遮罩版 | 遮罩版 | — | 遮罩版 | 遮罩版；sidecar 原文經 search 可得（UNCONFIRMED） |
| marker（IPC） | ◐ P2 | 原文 | 原文 | 原文 | 同上 | — | 同上 | 原文 |
| marker（API） | ✕ P3 | 原文 | 原文 | 原文 | ✕，P9 也做不到 | — | ✕ | 原文 |
| loot preview | ✕ P7 | 原文 | 原文 | 原文 | ✕，P9 也做不到 | — | ✕ | 原文 |
| `credential_use` | ● P6 | 遮罩 | — | 遮罩 | 遮罩 | — | 遮罩 | 遮罩 |
| 截圖、cast | ✕ | 雜湊 | cast_fts 原文 | 原文 | — | — | 原檔（cast 永遠整檔） | `/api/terminal/replay` 原文 |

**結果：18 條路徑，12 處不一致**（同一個 secret 在一條路徑被遮，在另一條路徑原樣留下）：

| 代號 | 不一致 |
|---|---|
| I1 | stdout ≤4 KiB 有 span，>4 KiB 沒有 |
| I2 | marker 經 IPC 寫入有 span，經 API 寫入沒有 |
| I3 | AI 在鏈上已遮罩，但 sidecar、`body_fts`、來源檔都是原文 |
| I4 | 同一個 Bearer：在 AI 裡被替換，在 shell 輸出裡看 entropy 是否夠高，在 HTTP header 裡完全不處理 |
| I5 | loot preview 是原文，來源事件卻可能有 span |
| I6 | bundle 不移除已 sanitize 欄位的 `*_ref`（`bundle-export.ts:370-377`、`:603-615` 只在設了 scope 時才過濾 body），P10 會移除（`redact-export.ts:100-105`） |
| I7 | API 的 HAR 與 bundle 不帶 `personalDomains`（`api-server.ts:487,759-761`），UI 匯出會丟掉 personal 列 |
| I8 | PII 清洗只在 JSON、NDJSON |
| I9 | sanitize 只認寫入當時的 span，之後新增的規則套不上去（主張 2） |
| I10 | 註解宣稱「layer 4 redacts everything that leaves」，實際上匯出預設什麼也沒遮（P10、P11） |
| I11 | 搜尋索引保存原文 token；將來「標為私人」也要求不被索引 |
| I12 | `credential_use` 遮罩，同一個值在 loot 與 command 裡是原文 |

最嚴重的三項：
- **(1) 偵測有，套用沒有**（I10、I9）：span 從不影響任何預設匯出。
- **(2) HTTP 的結構欄位完全在偵測之外**（I4、P14）：HAR 原樣交出 Authorization 與 Cookie。
- **(3) AI 原文在專案內反而最容易搜到**（I3、P17），而且索引檔 `http-body-index.db` 不經 private-fs。

另外兩個偵測規則本身的洞：
- entropy 對十六進位字串最多 4.0 bits/char，低於門檻 4.5（`redaction.ts:226-228`）。NTLM hash、十六進位 API key、RedLog 自己的 `api-token` 都不會被標記。
- `SENSITIVE_PATH_HINTS` 不含 `.redlog`（`secret-redaction.ts:50-53`）。agent 執行 `cat ~/.redlog/api-token` 時，輸出會原樣上鏈。

### B.3 四個 secret 的端到端追蹤

**(a) 在 shell 指令裡打的密碼**：`mysql -u root -pS3cretPass! -h 10.0.0.5`
- 寫入：
  - `command_start` 與 `command_end` 的 `command` 是原文。
  - P1 只對 ≥16 字元的 token 算 span（`redaction.ts:181`）；`-pS3cretPass!` 是 14 字元，而且 `!` 不在 TOKEN_RE 的字元集裡 → 沒有 span。除非 loot 偵測到它：loot 值 ≥6 字元時會併入 denylist，但也只能對 ≥16 字元的 token 生效。
  - 衍生的 `credential_use` 列是遮罩過的（P6）。
  - loot 若命中，`preview` 是整行原文（P7）。
- 磁碟上的原文：`timeline.db` 的兩列、`events_fts` 的 token、loot 列；app 沒開時還有 spool 檔。用內建終端機時，cast 會錄到回顯的指令列。另外還有 shell 自己的 history（不屬於 RedLog）。
- 匯出：JSON、NDJSON、bundle 都是原文。HAR 不含這列。即使跑 `redlog-cli sanitize`，因為沒有 span，也不會遮。
- 預覽與實際位元組：預覽的「已清洗」數字是 0，與實際一致，但預覽完全沒提到這列含有密碼。

**(b) proxy 擷取的 `Authorization: Bearer`、`Set-Cookie`、JSON body 裡的 JWT**
- 寫入：mitmproxy addon 送出所有 header、cookie、query、解析後的 body（`mitmproxy-addon.py:25-28,839-862`）。
  - ≤4 KiB 的 body 內嵌在 `data` 中；更大的進 `http-bodies/`。
  - P1 只掃 `request_body_preview` 與 `response_preview`。JWT 有可能因 entropy 在 preview 上得到 span；header、cookie、`params` 都不掃。
  - HTTP 不經 loot 偵測（ingest 的 loot 只處理 shell：`ingest.ts:486-498,510-536`）。
- 磁碟上的原文：`timeline.db`（logged 或 chained tier）、`.body`、`body_fts`、`events_fts`。
- 匯出：HAR 的 `headers` 與 `cookies` 是原文（P14），body 是全文；JSON、NDJSON 是原文；bundle 是原文，並附上 `.body`。即使對 preview 跑過 sanitize，bundle 仍附上 `.body`（I6）。

**(c) AI agent 讀 `.env` 並在 tool result 中回顯**
- 寫入：
  - Claude Code 的 `Read`：tool input 不掃描（`tailer-host.ts:592-593`）。命令快取取 `file_path`（`:636-640` 的優先序）。tool_result 先經 `redactSecrets`，再因路徑含 `.env` 被整段換成 `[output hidden — sensitive path]`（`:822-826`、`secret-redaction.ts:55-59`）。這條路徑在鏈上是安全的。
  - 改用 `grep -r KEY .`，或檔名是 `config.local`：只剩 14 種形狀的替換。`DB_PASS=hunter2hunter2` 會被 `named_secret_assignment` 換掉，但十六進位 key 不會。
  - assistant 在回覆中把值複述一遍：只經 `redactSecrets`。
- 磁碟上的原文：`agent-transcripts/*.jsonl`（RedLog 的副本）、`body_fts` 的 `ai-raw`、`~/.claude/projects/...`（來源檔，不歸 RedLog 管）。
- 匯出：events 中是遮罩版。sidecar 沒有呼叫端會附上。閱讀器的「儲存內容」可能交出原文（UNCONFIRMED：`ai-raw` 是否屬於 `evidence-content` 可讀的 ref）。

**(d) 截圖裡看得到的 token**
- 寫入：jpg 以 0644 存在 0700 目錄。沒有 OCR，也沒有索引。
- 匯出：bundle 一律附上，只排除 personal 與 out-of-scope；沒有目標的截圖照樣附上，只計數。預覽有附件清單，並有一句「原始附件不做內容層級的範圍裁切或操作者資訊清洗」（`i18n/zh-TW.json:2161`），這是**現有的、誠實的**提示。
- 預覽與實際位元組：附件清單與 bundle 一致。

---

## C. 八項主張與各提案的判定

### C.1 八項主張

| # | 判定 | 依據 | 已決定或已規格化 | 真正新增的部分 |
|---|---|---|---|---|
| 1 | **成立** | B.1、B.2（18 條路徑，12 處不一致） | 05-F3 已提出；071 FR-091 與 075 FR-059 只規定 span 在寫入路徑上，**沒有單一引擎的 FR** | P8 大輸出、P7 loot preview、I6 bundle 留下 ref、十六進位 entropy |
| 2 | **成立** | `sanitize.ts:92-98`；P8 | 沒有 | 見下方「主張 (2) 的細節」 |
| 3 | **部分成立** | 鏈上是遮罩版（P4），sidecar 是原文 †，而且被 `body_fts` 索引（新）。「可匯出」：選項存在，但沒有呼叫端（`includeAgentTranscripts` 只出現在 `bundle-export.ts`），此部分不成立 | capture-trust §3「只替自己的儲存說話」 | 索引與檔案權限 |
| 4 | **成立** | `api-server.ts:187-191`（05-F2）；agent 工具含 `redlog_search`、`redlog_events`、`redlog_recording`（`docs/codex-tools.json:96,289,324`） | **已決定**：071 FR-070–078、O13（`agent-tools` 只能寫 `agent`、`marker` 與讀狀態）。**未實作** | 對外讀取與匯出的稽核紀錄（G.iv） |
| 5 | **部分成立** | 同 UID：成立，而且無法避免（05-F6）。其他使用者：POSIX 上被 0700 目錄擋住；有多個檔案是 0644（A），Windows 大多沒有 ACL † | 05-F6 的威脅模型 | 權限 gate（I #5） |
| 6 | **成立** | `scope-sanitize.ts:29-36` 刻意保留 URL、host；`command` 與 header 也保留 | 刻意設計（purple team 需要知道碰過什麼） | URL query 的值與 header 應交給遮罩引擎處理，與 scope 無關 |
| 7 | **成立** | bundle 附上截圖、cast（整檔）、`.body`、artifacts（`bundle-export.ts:513-631`） | 匯出預覽已列出附件並可逐項排除（#222） | 「無法清洗」清單；遮罩後仍附上 body（I6） |
| 8 | **部分成立** | 保留期與驅逐有實作，並寫 chained 稽核（`retention.ts` †）；預設全部永久保存（`config.ts:342-356`）；刪專案用 `rmSync`，有殘留（F） | 清除內容（晚間決定，需另立規格） | F 的真實性清單 |

**主張 (2) 的細節：今天加的規則能不能套到昨天的列？**

不能，任何格式都不能。原因有三：
- P10 與 P11 只讀 `sanitized_events`。
- P9 只認寫入時算好的 span。
- 大輸出（P8）、header、loot 根本沒有 span。

要做到，需要：
1. 一個 `redactForDelivery(event, rules)`，在匯出 worker 上以**當前**規則掃描所有字串葉節點與結構欄位。
2. 把替代位元組寫進既有的 `sanitized_events`。它已經是 append 加 `INSERT OR REPLACE`；要改為以 `(event, field, policyVersion)` 為鍵，不可覆蓋。
3. 每次匯出寫一列 chained `system.sanitized`，內容為 `replacements:[{event, field, sha256}]` 加上 `policyVersion`。這不改寫任何既有列，符合產品規則。

verifier 端的現況：
- 兩個 verifier 把這些列算進 `transformedEventIds`，結果是「Projection、source chain NOT VERIFIED」（`bundle-verify.ts:152-157,207-211`、`redlog-verify.py:413-420,505-511,852-856`）。
- 兩者都**不比對** `system.sanitized` 的 replacement sha256（grep 只在 manifest 欄位名稱出現 `sanitized`：`bundle-verify.ts:47`、`redlog-verify.py:216`）。

能補的與補不了的：
- 能補：verifier 對每個 transformed 列，要求鏈上有一列 `system.sanitized` 或 #711 的 export seal 列出它，並檢查交付的欄位位元組雜湊等於 replacement sha256。這樣就能分出三種狀態：`redacted-by-policy`、`missing`、`mismatch`。
- 補不了：其餘未遮罩的欄位是否為原文。舊列的 hash 是整列 canonical JSON 的雜湊，不是逐欄位承諾。
- 新列可以補：做法見 G.ii 的「內容部分」。

### C.2 各提案

| 提案 | 判定 | 現況或決定 | 新增 |
|---|---|---|---|
| 擷取邊界與 scope 分開 | 方向已決定 | 四個詞不共用控制（072 O10、073 P10）；個人清單移到機器層，在來源端丟棄（晚間決定）；AI work paths 已存在（`agent-capture-policy.ts:27-39` †） | 逐來源與逐 session 的呈現、遺失計數（見「擷取邊界與歸屬」） |
| 核心中單一的遮罩引擎，每種格式都經過，匯出時以最新規則重掃 | **新增**（05-F3 有提，但沒有規格） | — | Spec 076 |
| 結構化覆蓋：URL query、header、cookie、JSON、表單、終端輸出、AI tool result | 新增 | — | G.ii |
| 二進位附件不得稱為「已清洗」 | 部分已做（`rawBoundary` 提示） | — | 改成逐檔列入「無法清洗」，並計入 seal |
| OS keychain 加上每專案的靜態加密 | 不建議全面採用 | — | E |
| AI agent 預設只能寫入 | **已決定**（071 O13） | 未實作 | 過渡做法：先從文件與工具清單拿掉讀取與控制工具 |
| 不自動把原始事件送往雲端 LLM | RedLog 本身成立（D.2） | 真正的路徑是 agent 經 API 讀取（O13 會關閉） | — |
| 稽核對外讀取與匯出 | **新增** | 匯出有 seal（#711） | 讀取稽核寫 logged tier（G.iv） |
| 隱私感知的匯出：預覽等於實際位元組、命中摘要、無法清洗清單、政策版本 | 部分 | 預覽有計數、附件清單、fingerprint；但 bundle 用自己的邏輯（I6），**預覽不等於 bundle 位元組** | G.iii |
| 儲存與刪除生命週期 | 部分 | 晚間決定的清除內容、標為私人 | F、G.v |

**產品選擇。** 從程式碼看，支持「授權範圍內保存完整原文，分享時預設清洗」，理由：
- 鏈的意義是 hash 覆蓋真實位元組（`redaction.ts:192-197`、redaction-design.md）。
- capture-trust §4 規定「不得為了記錄而改變工具的行為」。
- 另一個選項（敏感資料除非明確開啟否則不落盤）需要在寫入時做分類，而 capture-trust §7 已經否決「自動分類私人與工作」。

但要明說，**今天兩種語意並存**：
- AI tailer 走的是選項二（破壞性遮罩），卻又把原文存進 sidecar 並建索引。結果是兩邊的壞處都有：證據不完整，原文也沒有少。
- 建議在 076 的引擎與 gate 上線後，AI 新列改為「原文加 span」，並標上 `_masked_at_ingest:false`；舊列不動。在那之前維持現狀，因為今天的匯出不會遮罩任何東西。

---

## 擷取邊界與歸屬（兩份外部分析的事實核對、與既有決定的對帳、overlay 設計）

### 1. 事實：每個來源何時開始記錄

| 來源 | 什麼讓它開始記錄 | 能否只暫停這一個 | UI 是否顯示它在記錄 | 私人使用同一工具時會怎樣 |
|---|---|---|---|---|
| 外部 zsh / bash（rc 已裝 hook） | 每個讀 rc 的互動 shell 都會載入 hook（`hooks-manager.ts:85-87` †）。機器模式預設 `auto`（`redlog-relay.py:1139-1148`，親讀；註解寫「D4: the installed default is auto」）。載入時 `begin` 會讀 `active-identity.json` 並綁定**當下開著的專案**（`:1211-1221`，親讀）。沒有專案開著時載入的 shell，會被之後第一個開啟的專案收養（`shell-common.sh:349-360`，親讀）。伺服器端不檢查外部 shell 是否已登記（`terminal-manager.ts:198-199` †） | 可以：`redlog stop` / `redlog start`；`redlog mode manual` 改變新 shell 的預設 † | 整體的 REC；CaptureHealth 有「已登記終端數」†；shell 內有 `redlog status`。**app 內沒有逐 shell 的列** †（UNCONFIRMED） | **專案開著時開一個私人終端，不需任何操作就會被記錄**（auto 模式） |
| 外部 PowerShell | `$PROFILE` 每個 prompt 送出 † | **不能**：沒有 stop，也沒有綁定 † | 只有整體 REC † | 記錄 |
| 專案切換（外部 shell） | 偵測到 identity 檔變更 → `recording:false, stoppedReason:project-switched`（`redlog-relay.py:1200-1207`，親讀），印出「開新終端」，`start` 無法恢復 † | — | shell 的 stderr | 停錄，**舊資料不搬**。決定中的「暫停並在返回時恢復」尚未實作 |
| 內建終端 pane | 專案開著時開 pane → cast 加登記，預設 auto †；切換專案時重新綁到新專案（`terminal-manager.ts:306-330` †） | 在 pane 裡打 `redlog stop`；沒有按鈕 † | pane 上的 chip | 記錄 |
| HTTP（受管 mitmdump） | 專案開啟時，只要 PATH 有 `mitmdump` 就自動啟動，**沒有設定開關**（`http-autostart.ts:31-33` †）；所有送到 127.0.0.1:6661 的流量都存；addon 沒有 personal 過濾 †。有專用的擷取瀏覽器（獨立 profile，由操作者啟動 †）；RedLog 不改系統 proxy † | 只能停整個 proxy | CaptureHealth † | 任何被指向 proxy 的程式都會被全量記錄；`personalDomains`（預設含 localhost，`config.ts:289` 親讀）**只在匯出與查詢時作用**（`redact-export.ts:75`、`bundle-export.ts:363` 親讀） |
| AI transcript | 預設不記錄：需要已安裝、已授權、本專案啟用、`startedAt`、絕對路徑的 `workPaths`（`agent-capture-policy.ts:27-39` †）；之後 work path 內**每一個** session 都會被 tail † | 逐 session 排除、逐來源停用 † | AgentsPanel † | work path 內的私人對話也會被記錄，並複製原文 |
| 截圖 | 週期預設關（`intervalSec: 0`）、指令觸發預設關（`config.ts:292-297` †）；手動、marker、API 是刻意的操作；**每次都拍游標所在的整個螢幕** †；手動與 API 截圖不受暫停影響 † | 把間隔設為 0 | 未找到 † | 會拍到其他視窗與通知 |
| 剪貼簿、行程、連線監視 | 預設關（`hostMonitors:false` †） | 可逐成員關閉 † | CaptureHealth † | 開啟後是整機範圍 |
| 全域目前目標 | 套到沒有自己目標的 `shell`、`marker`、`screenshot`、`artifact_added`（`ingest.ts:247-255`，親讀） | — | — | 私人指令被歸到目前目標。**已決定移除**（071 O11、O16） |

輸入 1 的六項主張：

| 主張 | 判定 |
|---|---|
| 安裝 hook 就會記錄機器上每一個 shell | **成立**，條件是專案開著；機器模式 auto |
| 啟用 HTTP 就會記錄所有瀏覽器流量 | **不成立**：只記錄指向 proxy 的流量，而 RedLog 不改系統 proxy |
| 安裝 AI adapter 就會記錄所有 AI 對話 | **部分成立**：記錄 work path 內的全部 session |
| 切換專案會把既有 session 的資料搬到新專案 | **不成立**：外部 shell 停錄；內建 pane 重新綁定，但只影響之後的資料 |
| 有週期性全螢幕截圖，而且可能預設開啟 | **部分成立**：功能存在、預設關閉，但開啟後是全螢幕 |
| 單一全域目前目標套用到各來源 | **成立**，已決定移除 |

### 2. 與既有決定對帳

**兩份輸入同意既有決定的部分**（大部分）：
- 暫停期間不保留內容（capture-trust §3）。
- 切換專案改為暫停並在返回時恢復（§4 的決定）。
- 8 個來源狀態，包括「待命」與「已關閉」的區分（075 FR-090）。
- 四個詞不共用控制。
- 個人清單移到機器層，在來源端丟棄並計為有意的遺失。
- 事後標為私人，鏈上留標記。
- 清除內容是一條獨立的明確流程。
- 註記是與效果不同的角色（072）。
- `target_via` 記錄目標是怎麼決定的（071）。
- 候選邊與因果邊分開（報告 10）。
- 不從指令內容推論私人與工作（capture-trust §7）。

**兩份輸入新增的部分**：
- 四值的相關性 overlay：已確認、可能相關（附依據）、未知、標為無關或私人。
- 匯出前的檢查：依類別計數。
- 「無法真正停止的來源，不得宣稱已停止」：今天全域暫停時，hook 與 proxy 仍在運作，只是伺服器丟棄資料；075 的「待命」與「已關閉」可以表達這一點，需要 FR 明文規定。PowerShell 沒有逐 shell 的停止。
- HTTP 偏好使用專用的工作來源：擷取瀏覽器已經存在，但 proxy 會收下所有指向它的流量。
- 預設不做週期性全螢幕截圖：今天預設已是關閉。

**衝突的部分**：輸入 1 主張「裝了 hook ≠ shell 被記錄」，既有決定是「裝到每個有 adapter 的 shell，綁定後即記錄（D4 auto）」。

- 今天：未表態的 shell，只要專案開著或之後被收養，**就會被記錄**。
- 決定後的設計（hello 加綁定）：仍然會被記錄。
- 最小的同意步驟其實已經存在：機器層的 `redlog mode manual`，加上逐 shell 的 `redlog start`。所以這是**預設值**的問題，不是缺少機制。

兩條路的比較：
- 「只記錄由 RedLog 啟動、或明確 `redlog start` 過的終端」：等於把預設改成 manual。缺點是工作 shell 忘了 start 就整段遺失，而這種遺失看不出來是遺失，違反「沒有事件不得看起來像什麼都沒發生」。
- 維持 auto，但讓「綁定」本身被看見：輸入 2 的 L1 也採這個方向。

建議維持 auto，並補上三件事：
1. 綁定（包括收養）是一次狀態變更，依既有決定在下一個 prompt 印一行到 stderr，例如「記錄到 <專案>；`redlog stop` 停止」。
2. 擷取控制中每個 shell 一列（075 FR-018 已經有 `lastHello` 的事實）。
3. 「標為私人」的區段操作（見下文第 3 節）。

### 3. Overlay 設計（放在既有規格內，不新增頁面，也不新增證據儲存）

**兩種資料，分開存放。**

| | 操作者的決定 | 推論 |
|---|---|---|
| 內容 | 這段是私人的；這列與本次任務無關；這列確認相關 | 可能相關、未知 |
| 存放 | chained 的 `annotation` 角色種類（072 登記表新增 `privacy:mark`），經 071 的入口寫入 | 074 的 `derived.db` 中的投影 `event_relevance(event_id, relevance, basis[], policy_version)` |
| 性質 | 處理過程本身就是證據 | 可刪除、可重建、不進匯出、**不上鏈** |

`privacy:mark` 的資料形狀：

```
{
  action: 'private' | 'unprivate' | 'unrelated' | 'confirmed',
  selector: {eventIds[]} | {from, to, sources?[]} | {host} | {terminalId, from, to},
  reason?,
  supersedes?
}
```

選擇器只放 id、時間、host，不複製被標記的內容。撤回就是再寫一列 `unprivate`，所以編輯歷史就是鏈本身。

**依據（basis）的封閉詞表**：

| 類別 | 值 |
|---|---|
| 綁定 | `bound-terminal`（綁定本專案的終端或 pane）、`managed-proxy`、`ai-work-path` |
| 目標 | `target-in-scope`、`target-out-of-scope`、`target-via:<071 的值>` |
| 因果 | `caused-by:<event>`（O18 的確定邊）、`candidate-of:<event>`（候選邊，最多只能得到「可能相關」） |
| 操作者 | `operator-mark` |
| 無 | `none` |

規則：
- 「已確認」只能來自 `operator-mark`、`target-in-scope`，或指向已確認列的 `caused-by`。
- **不得**從指令內容推論。

**匯出如何讀取**：
- 匯出計畫（`export-planning.ts`）讀投影與 `privacy:mark`，算出 `{confirmed, possiblyRelated, unknown, private, personal, outOfScope, sensitiveHits}`。
- 私人與個人兩類一律排除。

**預設是否排除「未知」**：
- 不建議用「只匯出已確認」作預設。大量合法證據沒有目標（`ls`、`cat`、AI 回合），會落在「未知」，預設排除等於靜默地少交證據。
- 建議預設是「已確認，加上來自綁定來源的未知」。對話框把「未知 N 筆」列成一列，可以用一個動作排除。
- 排除後，seal 記錄 `omitted:{unknown:N, private:M, …}` 與 `policyVersion`（#711 的 seal 本來就承諾範圍與省略），讓「部分」永遠看得出是部分。
- 這一項列入擁有者問題 Q4。

**對既有規格的影響**：
- 072：新增 `privacy:mark` 種類。FR-008 規定「全文索引對所有種類一致」，**標為私人需要依標記而不是依種類排除索引**，這需要修訂 FR-008。
- 074：新增 `event_relevance` 投影，並納入 FR-033 的「可整個刪除」。
- 071：讓 `privacy:mark` 可經操作者入口寫入（不給 `agent-tools`）。
- 076：匯出與 seal 的欄位。

---

## D. 威脅模型

### D.1 各類對手

| 對手 | 今天的保護 | 已決定的工作會保護到 | 不會保護到 |
|---|---|---|---|
| 網頁、敵意的擷取內容（XSS、終端跳脫序列） | Host allowlist、CORS、Bearer、沒有 HTML sink、CSP（05 已驗證） | 05-F5 的 IPC schema | replay 的 OSC 序列（05-F5 的預防項） |
| 只能讀檔的 agent（例如 AI 的 Read 工具） | 無：同 UID 可讀 DB、body、transcript、`api-token` | 071 的憑證改為逐來源，但每個憑證檔同樣是 0600、同 UID 可讀 | **全部**。這也是 B.2 指出 `.redlog` 不在路徑提示的原因：agent 讀 token 時，token 本身會上鏈 |
| 拿著 RedLog 工具、讀到敵意內容的 AI agent（prompt injection → 經工具外洩） | 無：`redlog_search`、`redlog_events` 回傳原文與 loot；`redlog_recording` 能暫停錄製；`redlog_screenshot` 拍全螢幕（`docs/codex-tools.json`；`docs/agent-integration.md:266-290`） | O13：`agent-tools` 只能寫 `agent`、`marker` 與讀狀態 | agent 自己的 transcript，以及它對 LLM 供應商的傳輸，不歸 RedLog 管 |
| 第三方外掛 | 外掛 Source 是外部程序，用同一把 token（例如 `pcap-capture.js` 用 127.0.0.1，05-F2）；能讀全部 | 071 的 `plugin:<id>`：只能 append，停用即撤銷（FR-076） | 同 UID 的讀檔（同上） |
| 其他本機使用者 | POSIX：0700 的 `~/.redlog` 與專案目錄（`private-fs.ts:82-105`）。Windows：大多只有設定檔繼承下來的 ACL（UNCONFIRMED） | — | root 或 Administrator |
| 同 UID 的程序 | 無（05-F6 的威脅模型刻意排除） | — | 全部，包括執行中 app 的記憶體 |
| bundle 或匯出的接收者 | scope 遮罩、personal、do-not-export、P9、附件清單 | #711 seal | **今天：偵測到的 secret、header、cookie、截圖、cast、body 全部原文**；bundle 有 hostname 與 `operators.json`；PII 清洗在 bundle 不可用 |
| 拿到磁碟、備份、Time Machine、雲端同步資料夾的人 | 無（redaction-design.md「Doesn't catch」明寫應依賴 FileVault 或 BitLocker） | — | `~/.redlog` 在 home 內，Time Machine 預設會備份（UNCONFIRMED 未查排除清單）；匯出若存到 iCloud 同步的 Desktop 或 Documents 就會上雲 |

### D.2 每一個對外請求 †

（OTS 與 IP 查詢經本人抽查：`chain-anchor.ts:35-39`、`ip-signal-producer.ts:30-39`、`config.ts:274-281`、`shell-common.sh:143-157`。）

| 請求 | 目的地 | 預設 | 帶出的資料 |
|---|---|---|---|
| OTS 提交 | a/b.pool.opentimestamps.org、finney.calendar.eternitywall.com | **開**：開專案 30 秒後，之後每小時（head 有變才送） | 32 bytes：sha256(head‖count)。另外暴露 IP 與時間 |
| OTS 升級 | 同上 | **開**：每 6 小時 | head hash 的十六進位 |
| NTP | pool.ntp.org（UDP） | **開**：每 5 分鐘 | 48 bytes 的請求 |
| 公有 IP（DNS） | 208.67.222.222、216.239.32.10 | **開**：每 60 秒 | 只有 DNS 查詢。等於每分鐘向 OpenDNS 與 Google 報告操作者的出口 IP 與「RedLog 正在執行」 |
| 公有 IP（HTTP 備援） | api.ipify.org、ipinfo.io、api.my-ip.io | DNS 失敗時 | GET |
| 更新檢查 | api.github.com | 正式版**開**，啟動 5 秒後 | GET，UA 為 RedLog |
| electron-updater | GitHub releases | 僅 Windows，需操作者同意 | metadata |
| 相依套件安裝 | PyPI、brew、winget | 操作者按下時 | 套件管理器自己的請求 |
| `openExternal` | 書籤或擷取到的 URL、GitHub | 操作者點擊時 | URL 本身 |
| WSL hook 的閘道備援 | Windows 主機的 vEthernet，明文 HTTP | 只在 WSL 內 127.0.0.1 不通時 | **完整的 shell 事件與 bearer token**。目的地是主機上的 RedLog；但 API 只綁 127.0.0.1，除非改了 listenHost 才會成功（UNCONFIRMED） |
| 錯誤回報 | github.com/issues/new 的 URL query | 點擊時 | 清洗過的 stack trace |

另外：
- 沒有遙測，沒有 crashReporter，沒有任何雲端分享程式碼。`config.ts:140` 的 share-worker 是殘留的註解 †。
- **沒有任何請求帶出事件內容**。
- air-gap 的缺口 †：NTP 迴圈與 updater 的旗標只在開專案時決定；啟動 5 秒後的更新檢查早於任何專案開啟，所以不受專案的 air-gap 設定約束。

---

## E. 靜態加密

| 對手 | 每專案資料庫加 sidecar 加密（金鑰放 keychain 或 safeStorage）能換到什麼 |
|---|---|
| 同 UID 程序、只能讀檔的 agent | 對執行中的 app **沒有幫助**：safeStorage 與 Keychain 會把金鑰交給同使用者的程序（macOS 的 ACL 綁 app 身分，但目前是 ad-hoc 簽章，05-F6）；app 執行中，DB 頁面在記憶體與 WAL。只有在 app 沒開、而且 Keychain ACL 有效時才有防護 |
| 其他使用者 | 0700 已經擋住 |
| 磁碟、備份、雲端 | **有防護**，這是唯一明顯的收益。但全磁碟加密已涵蓋磁碟遺失；備份與雲端端看是否加密 |
| 匯出接收者 | 無（匯出必須是明文才能驗證） |

這個 codebase 要付的成本：
- better-sqlite3 沒有 SQLCipher，要換成自行編譯的原生模組，三個平台加上 asar 與 fuses。074 的 worker 與匯出 worker 都要帶金鑰。
- sidecar（body、cast、截圖、transcript）要逐檔做 AEAD，而 `body` 的檔名就是內容的 sha256（加密後內容雜湊的語意要重新定義）。
- `tools/redlog-verify.py` 的設計是「不需要 app 就能驗證」，對加密的專案無效。bundle 本來就是明文，所以 bundle 不受影響。
- 寫入路徑是同步的，每列都要加密（071 FR-091 的寫入延遲預算）。
- 金鑰遺失 = 證據全部遺失。對一個「系統紀錄」來說，這是最壞的失敗模式。
- 鑑識價值下降：沒有 app 就無法讀取自己的紀錄。

替代方案：
- (a) 明文寫進威脅模型：依賴全磁碟加密，在設定或首次執行時**偵測並顯示** FileVault 或 BitLocker 的狀態（只有一行文字，不新增頁面）。
- (b) 只加密 sidecar：收益小、成本中等。
- (c) **封存（073）時可選一個 passphrase**，用 age 或 libsodium 封裝整個專案目錄。這類資料最常被備份和搬移，又不在同步寫入路徑上。

**建議 (a) 加 (c)**，並把「為什麼不做資料庫加密」寫進威脅模型。

---

## F. 刪除與保留期的現況

- **保留期**（`retention.ts` †，預設全部 0 = 永久）：
  - 依天數刪除 cast、截圖、transcript、body，同時刪除對應的 `cast_fts` 或 `body_fts`，每個檔案寫一列 chained 稽核。
  - logged tier 依天數刪列，FTS 經 delete trigger 同步刪除，並寫一列 chained 摘要。
  - **chained 的 `events`、`raw/`、`artifacts/` 永不刪除。**
  - logged 列被刪時，對應的 `.body` 與 body 索引是否一起刪：UNCONFIRMED。
- **驅逐**：依大小預算刪 body、cast、截圖，並寫 chained 摘要 †。
- **刪除專案**：`fs.rmSync(project.path)`（`project-manager.ts:95-100`，親讀），不是丟到垃圾桶，接著從 `projects.json` 移除 †。
  - 會刪掉：專案目錄內的一切，包括 WAL 與 SHM、三個索引資料庫、匯出的預設位置。
  - 留下 †：`~/.redlog/pending` 的 spool（含 `.bad`）、`terminals/*.json`、`debug.log`、其他位置的匯出、`recent-exports`、`update-pending.json`、Windows 的 `.curl-auth`。
  - 作業系統層的殘留（UNCONFIRMED）：Spotlight 與 Quick Look 對截圖的快取、最近使用項目。
- **SQLite 的特性**：
  - 沒有設定 `secure_delete`，也沒有 VACUUM †。刪除的內容會留在 free pages，直到被覆寫；WAL 在 checkpoint 之前保有舊頁。
  - `events_fts` 是 contentless，但 token 仍在索引裡；`body_fts` 與 `cast_fts` 保存全文。
- **「清除內容」要真實，必須做到**：
  1. 在一個交易內開 `PRAGMA secure_delete=ON`（只對該連線生效）。
  2. 處理鏈上的列：舊列的 `data` 受 UPDATE trigger 保護（`event-write.ts:214-223`），這條操作需要一條專用、留下審計紀錄的例外，替換為 `{_content_cleared: purgeId}`。替換後**這列的 hash 無法再重算**，verifier 依清除紀錄顯示「已由操作者清除」。
  3. 刪除對應的 sidecar、`events_fts` 的 rowid、`body_fts`、`cast_fts`、`sanitized_events`、`derived.db` 的投影，以及 spool 中同一筆事件。
  4. 執行 `wal_checkpoint(TRUNCATE)`，並可選擇 `VACUUM`（較慢，需告知）。
  5. 寫一列 chained 的 `system.content_purged`，內容為 `{eventIds, partDigests, originalRowHashes, reason}`。

  它**永遠不能承諾**：已匯出的副本、備份、檔案系統快照、Time Machine、SSD 的區塊重映射、其他程式（例如 shell history、`~/.claude`）的原始資料。對話框必須列出這些，用最少的文字。

---

## G. 設計（放進 071–075 的既有結構，另新增 Spec 076）

**(i) 擷取邊界**（073 的 machine.yaml 加 071 的遺失帳本，再加 075 的狀態）
- `machine.yaml` 新增 `private: {hosts[], apps[], windows[], aiPaths[]}`。
- 在來源端丟棄：
  - HTTP：在 addon 或 ingest 的政策階段，依 host 判斷。
  - 截圖：依視窗或 app 判斷；改為拍攝前景視窗而不是整個螢幕需要擁有者決定（Q5）。
  - 剪貼簿：依來源 app 判斷。
  - AI：沿用既有的 `excludedPaths`。
- 每次丟棄計為 071 FR-050 的有意遺失（新原因 `private-boundary`），所以「沒有記錄」看得出是被排除，而不是什麼都沒發生。
- 取代 `scope.personalDomains` 的匯出期作用（`redact-export.ts:73-75`、`bundle-export.ts:363,443,540`）。舊專案仍依 073 US2 的第 3 個情境照舊排除。
- Gate：每個來源的政策表都必須宣告邊界欄位。
- 需要實機驗證：截圖的視窗排除、mitm 的 host 丟棄。

**(ii) 單一遮罩引擎**（Spec 076，模組 `src/core/delivery-redaction/`）

```ts
interface RedactionPolicy { version: string; rules: CompiledRules }

scanWrite(kind, data) => Span[]
  // 寫入路徑，結果進 hash，071 FR-091

redactForDelivery(event, policy) => {
  data, replacements[], unsanitisable[], hits:{shape,count}[]
}
```

- **結構感知**（依 072 登記表上各種類宣告的欄位形狀）：
  - URL query 的值、header（Authorization、Cookie、Set-Cookie、Proxy-Authorization、`x-*-key`、`x-*-token`）、cookie 的值、JSON 葉節點、表單欄位、終端輸出、AI 的 tool input 與 result。
  - 外加以字串葉節點為單位的形狀規則與 entropy 規則。
  - 補上十六進位形狀（長度 ≥32 的 hex 加上上下文關鍵字）。
- **執行時機**：
  - 寫入時：`scanWrite` 取代 P1 與 P2，並修正 P3（API marker）、P7（loot preview 改存遮罩版與 span）、P8（先掃再移到 sidecar，span 標 `field:'stdout_ref'`）。只影響新列。
  - 匯出時：在匯出 worker 上以當前政策執行 `redactForDelivery`。結果寫進 `sanitized_events`（鍵加上 `policyVersion`），並追加 chained 的 `system.sanitized{policyVersion}`。P10、P11、P13、P14 全部改為呼叫它；`bundle-export.ts:341-470` 的重複邏輯刪除，改呼叫 `redact-export`。
  - P9 保留為「逐筆指定」的入口，但改用引擎。
- **必須拒絕宣稱的**：截圖、cast、二進位 body、artifact。這些一律列入 `unsanitisable[]`，由操作者逐項決定附上或排除；對話框與 seal 都不得稱它們為「已清洗」。
- **新列的可驗證遮蔽**：寫入時把敏感欄位一律外移成內容部分（content part），列上只留 `{sha256, size}`。今天 >4 KiB 的 stdout 與 body 已經是這個形狀，所以交付時可以省略或替換某個部分，而列的 hash 仍然成立。verifier 依 seal 或清除紀錄分出 `withheld`、`missing`、`mismatch` 三種狀態（PRIOR-ART-A:13,199-201）。這只對新列生效，不改舊列。是否降低 4 KiB 的門檻，屬於 071 的格式決定。
- **Gate**：
  1. 靜態檢查：`src/core/**` 中寫出匯出檔或回應 API 讀取的模組，必須 import `redactForDelivery`，不得直接 `JSON.stringify(events)`。
  2. property test：對每一種已登記種類與每一種格式（JSON、NDJSON、HAR、bundle、API 讀取），任何葉節點含有 denylist 值時，輸出中都不得再出現該值。
  3. 雙 verifier 的 golden 向量加入 sanitized 案例。
- 取代的程式：`ingest.ts:633-648`、`redaction.ts:276-291` 的呼叫端、`secret-redaction.ts`（AI 改用引擎，時機見 Q6）、`scope-sanitize.ts` 併入成為一條規則、`operator-pii.ts` 併入。
- 驗證：單元測試加 property test 為主；用真實 app 匯出一個 bundle，跑 Python verifier。

**(iii) 隱私感知的匯出**（076，沿用 `ExportMenu` 的預覽，不新增頁面）
- 預覽新增四列：
  - 「偵測到的敏感值：N（依形狀）」
  - 「無法清洗的附件：M」
  - 「未知歸屬、私人、個人：a / b / c」
  - 「政策版本」
- 預覽由同一個 `redactForDelivery` 在 worker 上計算，計畫的 fingerprint 涵蓋替代值的雜湊，所以**預覽等於實際位元組**（今天的 bundle 不成立，見 I6）。
- seal（#711）記錄 `policyVersion`、`hits`、`unsanitisable`、`omitted`。
- Gate：e2e 匯出後比對預覽計數與 manifest 的值（需要 e2e）。

**(iv) agent 與工具的讀取邊界**（071 的 G 節）
- 加上 O13 之後，新增 FR：所有 `read` 能力的回應都經 `redactForDelivery`，預設政策是「交付」。
- 每次 `read` 或 `export` 能力的使用，寫一列 **logged tier** 的 `system.external_read{credential, route, count, bytes}`；每次匯出寫 chained 紀錄（已有 seal）。
- 過渡做法：`docs/codex-tools.json` 與 `docs/agent-integration.md` 先移除 `redlog_search`、`redlog_events`、`redlog_recording`、`redlog_config` 的預設建議。只改文件，不會被之後的實作推翻。

**(v) 刪除的生命週期**（076）
- 清除內容：見 F 的五步。
- 標為私人：chained 的 `privacy:mark`；以 rowid 刪除 FTS 與 body 索引；從投影移除；匯出永不包含；閱讀器中收合顯示。
- verifier：新增狀態碼 `content-cleared`、`private-withheld`，與 `mismatch` 分開。
- 刪除專案：列出並清掉 F 列出的殘留（spool 依 engagement、`terminals`、`.curl-auth`），說明快照與備份不在範圍內。
- Gate：一個「刪除後掃描」測試，在臨時 home 中建立專案、寫入一個帶標記的 secret、刪除，再 grep 整個臨時 home，斷言找不到。

**(vi) 診斷的衛生**
- `private-fs` 的覆蓋 gate：`src/**` 中寫入 `~/.redlog` 或專案目錄的 `fs.write*`、`mkdir*`、`new Database`、`copyFile`，必須經 private-fs，或在白名單中說明理由。基準是 A 中列為「NO」的那些，只能下降。
- Windows：在專案根目錄建立時呼叫一次 `restrictToOwner`，讓子項繼承。
- 剪貼簿：複製含 span 或 loot 的內容後，若 60 秒後剪貼簿未被改動就清除（不新增 UI）。
- `SENSITIVE_PATH_HINTS` 加入 `.redlog`。
- air-gap 改在設定套用時即時生效。
- HUD 視窗設定 `setContentProtection(true)`（需要擁有者確認：會讓 HUD 從操作者自己的螢幕錄影中消失）。

各項歸屬：(i) 修訂 073 與 071；(ii)、(iii)、(v) 放進新 Spec 076；(iv) 修訂 071；(vi) 放進 076，其中權限 gate 可以先做。

---

## H. 驗收情境

欄位代號：U = 可寫成單元測試，E = 需要 e2e，M = 需要真實機器。

| # | 情境 | 今天 | 目標 | 類型 |
|---|---|---|---|---|
| 1 | shell 指令帶密碼（`-p`、長度 ≥16 的 token、十六進位 key、>4 KiB 的輸出） | 短密碼與十六進位值沒有 span；大輸出沒有 span；四種匯出都是原文 | 匯出以當前政策遮罩；預覽顯示命中數；`redlog stop` 之後沒有紀錄 | U（引擎、匯出）+ E |
| 2 | proxy 擷取的登入（Authorization、Set-Cookie、JWT、表單密碼） | HAR 與 bundle 原文；跑過 sanitize 後 `.body` 仍附上 | header、cookie、query、表單在每種格式都被替換；`.body` 列入無法清洗或重新產生 | U + E |
| 3 | AI 讀 `.env`、`~/.redlog/api-token` | `.env` 被隱藏；token 原文上鏈；sidecar 原文且可被搜尋 | 路徑提示含 `.redlog`；ai-raw 依標記不索引；匯出遮罩 | U（tailer）+ M（真的 Claude Code session） |
| 4 | 切換客戶專案 | 外部 shell 停錄；pane 重新綁定；active-target 被套用 | 暫停，返回時恢復並寫 `capture_resumed`；沒有全域目標的回填 | U（relay 狀態機）+ M（兩個專案、三個終端） |
| 5 | 截圖拍到其他 app 或通知 | 整個螢幕；bundle 照樣附上無目標的截圖 | 依機器層清單排除視窗並計數；匯出列為無法清洗 | M（三平台） |
| 6 | 搜尋敏感資料（FTS、snippet、剪貼簿、快取） | 全部可搜；剪貼簿不清除 | 私人區段不可搜；複製後剪貼簿自動清除；`http-body-index.db` 為 0600 | U（索引）+ E |
| 7 | 停用或移除外掛 | 共用 token 無法撤銷 | 071 FR-076 撤銷；075 列出殘留 | U + E |
| 8 | 診斷與錯誤回報 | debug log 可能含路徑；console 有錯誤物件 | 權限 gate；回報內容只有清洗過的資料 | U（gate） |
| 9 | 刪除專案 | `rmSync`；spool、`terminals`、`.curl-auth`、外部匯出殘留 | 清掉 F 的殘留並列出不在範圍內的項目；刪除後 grep 找不到 | U（臨時 home） |
| 10 | 匯出到共享資料夾 | 預覽與 bundle 位元組不一致（I6）；outDir 是 umask | 預覽等於位元組；seal 記錄政策；對話框列出無法清洗與省略項目 | E + M（iCloud 或 SMB 路徑） |

---

## I. 前十項改動（依 避免的暴露 ÷ 波及範圍 排序）

標 ★ 的可以在 071 Phase 3 之前上線，且之後不必重做。

| # | 改動 | 理由 |
|---|---|---|
| 1 ★ | 匯出時以當前規則套用遮罩：先把既有 span 套到 JSON、NDJSON、HAR、bundle，再接上重掃 | 主張 1、2，以及 I10 |
| 2 ★ | HAR、JSON 的 header、cookie、URL query、`params` 結構化遮罩 | B.3(b) |
| 3 ★ | bundle 改呼叫 `redact-export`：移除已遮罩欄位的 ref 與 `.body`；API 匯出帶 `personalDomains` | I6、I7 |
| 4 | 071 O13 的 agent 讀取邊界，加上讀取稽核（★ 的部分：先修文件與工具清單） | D.1 中最大的實際外洩路徑 |
| 5 ★ | 權限 gate 加上補齊 private-fs：截圖、`http-body-index.db`、artifacts、`raw`、外掛狀態檔；Windows 根目錄的 ACL | A |
| 6 ★ | 寫入端的四個洞：大輸出先掃再移、API marker、loot preview、十六進位形狀，加上 `.redlog` 路徑提示（只影響新列） | P3、P7、P8 |
| 7 | AI 原始 transcript 的索引與權限，配合「標為私人」不被索引 | I3、P17 |
| 8 | 機器層的個人清單在來源端丟棄並計為遺失（依賴 073 的 machine.yaml） | 擷取邊界 |
| 9 | Spec 076：清除內容、標為私人、verifier 狀態碼、刪除殘留 | F |
| 10 ★ | air-gap 即時生效、剪貼簿自動清除、HUD 的內容保護 | D.2 與 A |

---

## 檢查過、結構健全

- **沒有遙測、沒有 crash 上傳、沒有任何請求帶出事件內容**（D.2）。OTS 只送雜湊。
- `credential_use` 只存長度遮罩（P6）。剪貼簿預設只存雜湊。
- body 寫入是 0600 的 `wx` 暫存檔加上 hard link，雜湊不符就拋錯（`http-body-store.ts:66-88`）。
- bundle 拒絕把原始 AI transcript 與 selection、scope、snapshot、personal、do-not-export 組合在一起（`bundle-export.ts:209-231`）。
- 擷取瀏覽器使用獨立 profile，並抑制 Chrome 的背景流量 †。
- AI 預設不擷取，需要 work path 加上本專案啟用 †。
- `saveEventContent` 拒絕寫入專案目錄內，並且不覆寫既有檔案（`saved-content-delivery.ts:11-30`）。

## 刻意的設計（附依據）

- 畫面上不做 layer 3 遮罩（`Timeline.tsx:1659-1666`），但它附帶的理由「layer 4 遮罩所有離開的資料」不成立，應改寫註解或補上 1★。
- scope 遮罩保留 URL、host、狀態碼（`scope-sanitize.ts:29-31`）。
- sanitize 不修改來源列（`sanitize.ts:8-22`）。
- 暫停期間不保留內容（capture-trust §3）。
- 預設不做私人與工作的自動分類（capture-trust §7）。

## 需要擁有者決定的問題（附建議）

1. **產品選擇**：「存原文、分享時清洗」或「敏感資料預設不落盤」？
   **建議前者**，並要求 AI tailer 在 076 引擎與 gate 上線後也改為原文加 span，讓兩種語意不再並存。
2. **靜態加密**：要不要做資料庫加 sidecar 加密？
   **建議不做**。改為明寫依賴全磁碟加密並顯示其狀態，並在封存時提供可選的 passphrase 封裝。
3. **專案開著時，不是由 RedLog 啟動的外部 shell 預設要不要記錄？**
   **建議維持 auto（D4）**，但綁定與收養時在下一個 prompt 印一行，並在擷取控制中每個 shell 一列；需要嚴格同意的操作者改用 `redlog mode manual`。
4. **匯出預設是否只包含「已確認」？**
   **建議否**。預設是「已確認，加上來自綁定來源的未知」；私人與個人永遠排除；未知單獨一列計數，可一鍵排除，並記入 seal。
5. **週期截圖是否保留？**
   **建議移除週期性全螢幕截圖**；保留手動與 marker 截圖。若保留週期截圖，改為只拍前景視窗並套用機器層的排除清單。
6. **AI tailer 的破壞性遮罩何時取消？**
   **建議在 1★ 與 076 的 property gate 上線之後**，只對新列取消，並以 `_masked_at_ingest` 標記；在那之前維持現狀。

## UNCONFIRMED

| 項目 | 最便宜的確認方式 |
|---|---|
| Windows 上專案目錄繼承到的 ACL | 在 Windows 建立專案後執行 `icacls %USERPROFILE%\.redlog\projects\<id>` |
| 閱讀器的「儲存或複製內容」能否交出 `ai-raw` 原文 | 讀 `evidence-content.ts` 的 ref 分派，或用一個專案實際操作一次 |
| `GET /api/events/search` 是否回傳 `body_fts` 中 ai-raw 的命中 | 讀 `executeEventQuery` 是否合併 body 搜尋 |
| logged tier 被保留期刪除時，`.body` 與 body 索引是否一起刪 | 讀 `retention.ts:176-200` 是否呼叫 `pruneHttpBodyIndex` |
| WSL 的閘道備援在 listenHost 為 127.0.0.1 時能否連上 | 在 WSL2 的 NAT 模式執行 `curl http://<gw>:<port>/api/health` |
| 外部 shell 在 app 內是否沒有逐 shell 的狀態列 † | 搜尋 CaptureHealth 是否讀取 `terminals/*.json` |
| Time Machine 與 Spotlight 是否涵蓋 `~/.redlog` | 執行 `tmutil isexcluded ~/.redlog`、`mdutil -s` |
| HUD 是否出現在 RedLog 自己的截圖中 | 實機上開啟 HUD 後手動截圖一次 |
| 標 † 的事實 | 由子代理開檔取得，本人沒有逐行複核（已抽查：relay 的 auto 預設、專案切換停錄、`shell-common.sh` 的收養邏輯、IP 查詢目的地、OTS 目的地、WSL 閘道、personalDomains 預設值、截圖檔案沒帶 mode、raw-store 與 http-body-index 的權限） |
