# 05 — 信任邊界與證據完整性（root-cause review）

基準：`main` @ a087c16c，唯讀審查。單元層級確認只在 scratchpad 內建立假 bundle 跑 `tools/redlog-verify.py`（`scratchpad/rootcause/tb-probe/`），未碰 `~/.redlog`、rc 檔或網路。

## 摘要（10 行）

1. **證據簽章只保護「列」，不保護「這份交付物的邊界與附件」**：manifest 未簽，verifier 卻用它決定要驗什麼；已實測「簽章鏈截尾 + 換掉截圖」得到 `Chain: INTACT`、exit 0。App 內的 verifier 規則又和 Python 版不同（未簽列算通過、簽章狀態不顯示、anchor 表可改）。
2. **API 只有一種 token，代表全部權限**，而拿著它的正是最容易接觸敵意內容的呼叫者：AI agent（`redlog_recording`、`redlog_log_event`）、hooks、plugins、VPS。過去對 seed、amend、bookmark context、operator_id、engagement 的修補，都是在單一路由上補「持 token 者不可以 X」。
3. **來源（provenance）由呼叫者自己宣告**：`data.source='builtin-terminal'` 會影響信任判斷；真正的來源欄位 `events.source` 不進 hash，也不會匯出。
4. **遮罩（redaction）由每個 producer 在寫入時各自處理，共有三種語意**；sanitize／export 只能遮寫入當下標好的 span。`/api/marker` 完全不標 span；之後才加進 denylist 的值，無法套用到既有事件。
5. **未驗證的 SNTP 回應會寫進不可變的 hash 欄位**：一個偽造封包就能讓 5 分鐘內每一列都永久帶 `_clock_anomaly`；過短的封包還會在 main 內丟出未捕捉的例外。
6. **renderer 被 main 完全信任**：178 個 handler，各自驗證參數；`terminal:write`、`plugins:grant` 等於任意碼執行。目前靠「沒有 HTML sink + 嚴格 CSP」守住，這是做得對的部分，但沒有任何 gate 防止這件事退化。
7. 隱含的威脅模型排除同 UID 行程，這是合理的；但有幾段註解與文件把簽章、trust.json 說成能防它。
8. 做得穩的部分：Host allowlist 加上不用萬用 CORS、token 雜湊比對且不出現在 argv、renderer 沒有 HTML sink、正式版 CSP、sandbox 與導航拒絕、plugin regex 跑在 worker 並有時限、append-only trigger、test hooks 只在 smoke build 開放。
9. 排序依據：F1 是第三方唯一依賴的東西；F2/F3 是本產品特有、由敵意內容觸發的路徑；F4–F6 較小或屬預防性。
10. 修法共同方向：一份 schema 驅動的邊界層（API 路由與 IPC 共用）、依能力分權的 token、hash 涵蓋的來源欄位、匯出時集中處理的遮罩，以及 TS 與 Python 共用測試向量的單一驗證規格。

---

## F1. 簽章只承諾「列」：bundle 的邊界、附件與分層摘要靠未認證的 manifest，而驗證規則有兩份且彼此不同

**機制。** 每一列 chained event 都有 hash，並由 operator 金鑰簽 Ed25519。但「這份 bundle 涵蓋哪些列、到哪一列為止、附了哪些檔、哪些列被轉換過」全寫在 `manifest.json`，而這份 manifest 只有 `manifest.sha256`（任何人都能重算）和 `manifest.hmac`。後者的金鑰是 `token_hash`，第三方無從驗證，持有 DB 的人卻能偽造；verifier 也直接略過它（`SELF` 集合，`tools/redlog-verify.py:443`）。結果是：由 manifest 決定 verifier 要驗什麼，而 manifest 並不可信。

**實例（已確認）。**
- 截尾：鏈的最後一列只要仍有有效簽章，刪掉其後的列，再拿掉 manifest 的 `chainHead`／`tiers`（verifier 對缺少這兩個欄位的處理是 `n/a` 並通過，`redlog-verify.py:382,388,391`），結果仍是 `INTACT`。
- 附件替換：screenshot 事件的 `data.sha256`（`screenshot-agent.ts:228,282`）、cast 的 `castSha256`（`terminal-manager.ts:175`）、HTTP body 的檔名本身就是 sha256，這三者都在簽章範圍內，但 verifier 只比對 manifest 的 `files[].sha256`（`redlog-verify.py:430-460`），從不拿它們和鏈上記錄的值對照。
- **實測**（`tb-probe/b3`）：建立兩列簽章鏈，第 1 列是截圖（sha256=真圖），第 2 列是指令。刪掉第 2 列、替換 jpg、重算 manifest，`--hash-only` 都不用加 → `Chain: INTACT / Signatures: 1 verified / Manifest files: 3 verified / exit=0`。`tb-probe/b2` 在未簽情況下也一樣。
- 由 exporter 宣告的 projection：manifest 把每一列都列進 `transformedEventIds`，該列的 hash 檢查就整個跳過（`redlog-verify.py:315`）。報告文字有誠實寫出 NOT VERIFIED，但只要再加上簽章，exit code 就是 0，用腳本判讀的人看不出差別（`tb-probe/b1` 是未簽情況，exit 3）。
- Logged tier：匯出時會把 `system.logged_tier_digest` 寫進鏈（`bundle-export.ts:249-260`），但 verifier 只數 `events_logged.jsonl` 的列數（`:399-416`），從不比對摘要。匯出副本若經過 sanitize 或 scope 遮罩，本來也無法比對。HTTP 與 DNS 整個 lane 都屬於 logged tier，所以它們在端到端上沒有任何可驗證的完整性。
- **App 內的 verifier 規則和 Python 版不同**：`chain-anchor.ts:440-447,584-606` 把「沒有簽章」和「有簽章但查不到 pubkey」都算成 `unsignedCount` 且 `ok:true`；`chainActions.ts:95-97` 只看 `ok` 與 anchor；`IntegrityPanel.tsx` 完全不顯示簽章狀態。Python 版在 `fee8fb14`/`20e90039` 修好了 unsigned-in-signed，app 內沒有跟著修，因為兩份是各自獨立實作的。
- 信任根是可變的：pubkey 存在 `operators.signer_pub_key`（沒有 trigger，也不在鏈上；`db/operators.ts:68`），`chain_anchors` 表會被 `UPDATE`（`chain-anchor.ts:392`），而且建立成功的 anchor 不會寫成 chained 事件（只有 `anchor_failed` 會，`:242`）。刪掉 anchor 列之後，`anchorBad` 就變成 false。

**為什麼過去只修到症狀。** 「verify tool 讓 unsigned-in-signed 過關」只修了 Python 版；「附件要算 digest」補在 manifest 上，卻沒和鏈上的值綁在一起；logged digest 寫進了鏈，卻沒有消費者。每一步都在認證核心之外加欄位，認證核心本身從未承諾這些欄位。

**結構修法。**
1. **Export seal**：匯出結束前寫一列 chained 且簽章的 `system.export_sealed`，內容包含 `{headHash, eventCount, evidenceKind, transformedEventIds 的 sha256, attachments:[{path, sha256, sourceEventId}], loggedDigest, policy}`，並在 manifest 放這一列的 id。（另一種做法：用 operator 金鑰對 manifest 做 Ed25519 簽章，寫成 `manifest.sig`。）
2. **Verifier 不信任 manifest**：只要鏈上有簽章，就必須有 seal；邊界、projection 宣告與附件清單一律以 seal 為準。每個附件都必須追溯到鏈上記錄 sha256 的那一列（screenshot `sha256`、cast `castSha256`／segments、body `*_ref.sha256` 與檔名），對不上就失敗。
3. **單一驗證規格**：把政策寫在 `docs/design/` 一處，產生共用的 golden bundle 向量（包含截尾、換附件、全 transformed、剝簽章、缺 pubkey、刪 anchor），在 vitest 裡同時跑 TS 版與 `redlog-verify.py`，兩者 verdict 必須一致。這樣 app 內與 Python 版就不會再各說各話。
4. App 內：在已啟用簽章的鏈上，unsigned 與 no-pubkey 一律算失敗；anchor 建立時寫一列 chained `system.anchor_created`，讓刪除 anchor 留下痕跡；新增 operator 時把 pubkey 寫成 chained `system.signer_enrolled`，讓 pubkey 自身也在鏈上。

**遷移步驟**（每一步完成後 app 都能運作）：(a) 先加 golden 向量與雙 verifier 測試，標出目前會錯判的案例；(b) verifier 增加附件對鏈的交叉比對（純讀取，舊 bundle 只要附件沒被換過就照樣通過）；(c) exporter 寫入 seal，bundleVersion 升為 4；verifier 對 v3 給出新的 verdict「NOT SEALED」，而不是 INTACT；(d) app 內規則對齊；(e) 加入 enrolled 與 anchor_created 事件（只往後追加，不重寫既有資料）。

**影響範圍。** `bundle-export.ts`、`redlog-verify.py`（隨 bundle 一起出貨的副本）、`chain-anchor.ts`、`db/operators.ts`、IntegrityPanel。舊專案不必遷移，只是新 bundle 多一列事件。跨平台風險只在 Python 端。
**可能出錯的地方。** 同時有 projection 與 scope 遮罩的 bundle，附件清單必須和 seal 完全一致；cast 的 segments 必須逐段對應。
**驗證方式。** 雙 verifier 的 golden 向量測試；用真實 app 匯出一個簽章 bundle，各種手動竄改都必須 exit≠0；Windows 上跑 Python verifier（`_extended_length`）。

---

## F2. 單一 bearer token 代表全部權限，而且發給了最暴露在敵意內容下的呼叫者

**機制。** `api-server.ts:187-191`：通過驗證的結果只有「是哪個 operator」，沒有「能做什麼」。同一把 token（`~/.redlog/api-token`，同 UID 都讀得到）可以：寫入任何允許的 agent_type（`external-event-policy.ts:12-20`，包含 `shell`、`marker`、`credential_use`）、暫停或恢復錄製、`/api/sanitize`、匯出整份 bundle、讀出所有事件（含 loot 值）與 HTTP body、讀 config 與 scope、截圖、觸發對外的 OTS 網路請求。真正拿著這把 token 的是：
- **AI agent**：`docs/codex-tools.json` 與 `docs/agent-integration.md:283-290` 直接把 `redlog_recording`、`redlog_log_event`、`redlog_search`、`redlog_config` 等工具交給 agent。而 agent 的 context 正是目標主機輸出（敵意內容）最常流入的地方。`event-bus.ts:16-21` 的註解自己也寫了「an agent holding a token can call redlog_recording and go dark」。
- hooks、`pcap-capture.js:28` 這類 plugin，以及 VPS。`hooks/vps-deploy.sh:63-93` 明確寫著「A VPS only needs to append events … there is no narrower token to create」。

**實例：同一機制產生的逐路由修補。** `/api/events/seed` 獨立成一個入口（`:305-317`）；amend marker 403（`:360-371`）；bookmark 不接受 `context`（`:627-632`）；剝除偽造的 `operator_id`（`:377-385`）；engagement pin／重新檢查（`:319-335`）；只允許 producer heartbeat 這一種 system 事件（`external-event-policy.ts`）。這些都是在問「持 token 者不該能做 X」，每一條都是一個特例。

**來源由呼叫者自己宣告（同一機制的另一面）。** ingest 會把 `envelope.source='api'` 存進 `events.source`，但這個欄位不在 hash 裡（`event-write.ts:620`），也不在不可變 trigger 的欄位清單中（`:215-219`），bundle 匯出時的 SELECT 也沒有選它（`bundle-export.ts:271-275`）。反過來，`data.source==='builtin-terminal'` 是 payload 裡的欄位，任何持 token 者都能填，卻有 25 處程式依它分流或取證（例如 `event-queries.ts:191,806`、`ipc/terminal.ts:45,73`、`api-server.ts:678`）。castPath 讀任意檔案是靠 containment 擋下的（P0-D），但「誰說這是內建終端機」這個問題依然存在。透過 API 寫入的事件，`operator_id` 就是 primary operator 本人，並以本人金鑰簽章，所以紀錄上會寫成「operator 打了這個指令」。

**前提與影響。** 前提：敵意的目標輸出進入一個裝有 RedLog 工具的 AI agent（prompt injection），或任何同 UID 行程，或 VPS 被拿下。影響：錄製被暫停，且只留下兩列括號事件；以 operator 的名義、簽章寫入偽造的指令與標記；透過 search 把 loot 讀回 agent 的 context；對任意事件做 sanitize（`system.sanitized` 會稽核，但遮罩已經生效）。

**結構修法。**
1. **依能力劃分的 token**：`append:<types>`、`mark`、`read`、`control:recording`、`export`、`admin`。路由表為每條路由宣告所需能力，由一個中央 `authorize(route, token)` 判斷；目前的特例（seed、amend、system heartbeat）都改成能力規則。
2. **每個 producer 各自發 token**：內建終端機在 spawn PTY 時，把只限該 `terminalId` 寫入 `shell` 的 token 注入環境變數；外部 hooks 用 `append:shell`；AI agent 預設 `append:agent,mark,read:status`，`control:recording` 必須由 operator 明確授權；VPS 用 `append:*`。`~/.redlog/api-token` 只保留給 CLI 的 admin 用途，或改成 operator 手動解鎖。
3. **來源由伺服器蓋章並納入 hash**：ingest 以 token 的身分寫入 `data._producer = {kind, id}`（例如 `builtin-terminal:<tid>`、`hook:zsh`、`agent:claude`），在算 hash 之前放進去，匯出與 UI 都看得到。`data.source` 不再當成信任判斷的依據；原本讀 `data.source==='builtin-terminal'` 的 25 處改讀 `_producer`。

**遷移步驟。** (a) 加入 token 表 `api_tokens(id, hash, caps, producer, created_at, revoked_at)`，primary token 先授予全部能力，行為不變；(b) 路由宣告所需能力，加一個 gate 測試：每條路由都必須宣告，否則測試失敗；(c) 內建終端機改用 per-session token，`_producer` 開始寫入（新事件才有，舊事件保持不變）；(d) 把 hooks／agent 文件改成發窄權限 token，CLI 增加 `token create --caps`；(e) 讀 `data.source` 的地方改讀 `_producer`，`_producer` 不存在時退回舊欄位，但 UI 標示「來源自報」。

**影響範圍。** `api-server.ts`、`ingest.ts`、`terminal-manager.ts`、各 hook 腳本、`cli/redlog-cli.js`、agent 文件；DB 新增一張表。舊專案照常可用，只是舊事件沒有 `_producer`。
**可能出錯的地方。** hook 拿不到新 token 會導致擷取默默停止。要沿用 `noteDbError('api-external-rejected')` 的做法讓 401/403 顯示出來；WSL／VPS 的 token 分發。
**驗證方式。** 路由能力表的單元測試；e2e 檢查 `recording-pause.spec.ts` 的拒絕路徑在窄權限 token 下照樣成立；真實 app 中，內建終端機的指令應帶 `_producer`。

---

## F3. 遮罩是 producer 寫入時的責任，語意有三種；sanitize 與匯出只能遮寫入時標好的部分

**機制。** layer-4 的 `sanitize()` 對沒有 `data.redactions` span 的事件或欄位直接 `continue`（`sanitize.ts:92-98`），而且不會用當前規則重新偵測。span 是寫入時由各 producer 自行產生的：
- `ingest.ts:631-646`：只掃 `REDACTED_FIELDS` 這張固定欄位清單（output、command、stdout…），`url`、`request_headers`、`request_body`、`notes` 都不在清單中。
- markers：IPC 與快捷鍵路徑會呼叫 `redactFields(…, MARKER_TEXT_FIELDS)`（`ipc/markers.ts:107-120`、`index.ts:455-462`），**`/api/marker` 卻沒有**（`api-server.ts:517-524`）。透過 `/api/events` 送進來的 `agent_type:'marker'` 也一樣。`index.ts:413-420` 的註解描述的正是這個後果：「`redlog-cli sanitize` reports success on a marker note and ships the secret」。
- AI tailer 走另一套模組 `secret-redaction.ts`，使用另一組樣式 `REDACT_IN_TRANSCRIPTS`，**在寫入前就破壞性地替換**原文（`tailer-host.ts:568-630,733,774,821`），不吃 operator 的 `disabledRules`、denylist 或 plugin 規則；鏈上記錄的是已經遮過的文字，而原始 transcript 檔仍留在磁碟上，匯出時還可選擇附上未遮罩版本（`bundle-export.ts:69-70`）。
- clipboard 只存遮過的 preview（`clipboard-monitor.ts:61-65`）。

**後果。** (1) operator 事後才知道某個客戶密碼，把它加進 denylist，也無法套用到已經記錄的事件，只能等下一次寫入；(2) 不在欄位清單裡的地方（URL query 裡的 token、HTTP header）永遠無法 sanitize；(3) 同一個 secret，在 shell 輸出裡是「原文上鏈＋匯出可遮」，在 AI tool_result 裡是「遮過的文字上鏈」，兩者的證據語意不一致。

**為什麼過去只修到症狀。** markers 的修法是「每個 producer 記得呼叫 `redactFields`」，結果漏了 API；tailer 的效能修法是「依工具名稱列欄位允許清單」（`TOOL_INPUT_SCAN_FIELDS`）。兩者都是在 producer 端補洞。

**結構修法。** 遮罩改成**匯出／讀取時的單一服務**：`redactionPlan(event, rules)` 依「型別 schema 宣告的敏感欄位，加上所有字串葉節點」用**當前**規則計算 span。`sanitize()` 改為呼叫它，不再依賴 `data.redactions`；`redactEventForExport` 也走同一條路。producer 不再自行遮罩。`data.redactions` 降級為寫入時的提示，可保留以相容舊資料。AI tailer 是否繼續在上鏈前遮罩，是需要明確做的產品決定。若保留，應改用同一套規則引擎，並在事件上標記 `_masked_at_ingest:true`，讓證據語意寫在紀錄裡；若取消，就讓它和 shell 一致：原文上鏈、匯出時遮。
**gate。** property test：對每一種已知事件型別與每一種匯出格式（JSON、NDJSON、HAR、bundle），任何字串欄位只要含有 denylist 值，匯出後都不得再出現該值；再加一個靜態測試，禁止 `src/main/**` 的 producer import `secret-redaction`。
**遷移步驟。** (a) 新增 `redactionPlan`，先只讓 `sanitize` 使用（舊事件也能被遮，純粹是加強）；(b) 匯出走同一條路；(c) 移除各 producer 的 `redactFields`；(d) 對 tailer 做出決定並遷移。
**影響範圍。** `sanitize.ts`、`redact-export.ts`、`ingest.ts`、`tailer-host.ts`、`secret-redaction.ts`、markers。不需改 DB schema。
**可能出錯的地方。** 匯出時才掃描會增加大型匯出的 CPU 成本，但它本來就在 export worker 上；hash 不受影響，因為原文不動。
**驗證方式。** 上述 property test；在真實 app 中：用 `/api/marker` 建一個帶 secret 的 marker，接著 sanitize，再匯出，secret 不得出現。

---

## F4. 網路取得的時間值未經驗證就寫進不可變的 hash 欄位

**機制。** `clock.ts:24-62` 的 SNTP 實作：不檢查來源位址與埠、不檢查 originate timestamp 是否回傳、不檢查 mode／stratum（包含 KoD），也不檢查封包長度。只要收到封包就讀 byte 40-47，然後 `cachedOffsetMs` 生效 5 分鐘。`event-write.ts:355-357`：只要 `|ntpOffset|>30s`，**每一列** chained 事件都會在算 hash 前被加上 `_clock_anomaly`，此外 `ntp_offset_ms` 欄位本身也在 hash 內。
**實例。** (1) 一個偽造回應就能讓之後 5 分鐘內的所有列永久帶著「時鐘異常」，事後無法移除，因為移除會破壞鏈；(2) 小於 48 bytes 的封包會讓 `msg.readUInt32BE(40)` 在 dgram 的 `message` listener 中拋出 RangeError，而 main 沒有 `uncaughtException` 處理器（`rg` 結果為空）。對照組：`resolveOccurredAt`（`event-write.ts:407-429`）在把 producer 時間寫進不可變欄位前有先驗證，說明同一個 repo 已經知道正確做法，只是 NTP 路徑沒有套用。
**前提。** 在 operator 網路路徑上的攻擊者，或能控制 `pool.ntp.org` 的 DNS。滲透測試時接在目標網段或 VPN 上是常態。
**結構修法。** 外部觀測值一律不直接寫進每一列：NTP 樣本改記為獨立的 `system.ntp_sample` 事件（帶 server、stratum、RTT），「時鐘異常」改成 verify 或 view 時推導出來的結果；`queryNtp` 驗證長度、mode=4、stratum 1–15、originate 回傳值，並以 `connect()` 綁定來源；至少要兩次樣本一致才採用。
**遷移、影響與驗證。** 先修 `queryNtp` 的驗證並補單元測試（餵入短封包、KoD、錯誤的 originate）；接著停止逐列蓋章，舊列保持原樣，verify 改成同時理解兩種形式。影響範圍是 `clock.ts`、`event-write.ts`、`chain-anchor.ts` 的 anomaly 回報。

---

## F5. renderer 被 main 完全信任：IPC 參數驗證分散在各處，特權動作的同意只發生在 renderer

**機制。** 共 178 個 `ipcMain.handle/on`（76 個在 `index.ts`）。參數多半只有 TS 型別註記，沒有執行期 schema（例如 `project:create(name, initialConfig)`、`cdp:setPort(port)`、`agents:sources(roots)`、`bookmarks:update(id, data)`、`casts:readRange(castRel, off, len)`）。renderer 能直接要求：`terminal:spawn` 加 `terminal:write`（等於任意指令）、`plugins:grant`（讓 main 去 `require()` 程式碼；同意與否只看 renderer 端的 React 對話框，main 不會再確認，`ipc/plugins.ts:126-139`）、`hooks:install`（修改 rc 檔）、`runtime:install`。所以「整台機器的安全」等於「renderer 不被攻陷」。
**目前守住了，而且是靠結構守住的**：`src/renderer` 沒有任何 `dangerouslySetInnerHTML`、`innerHTML`、`srcdoc`、`iframe`、`eval`，也沒有從資料組出 `href`；正式版 CSP 是 `script-src 'self'`、`object-src 'none'`、`base-uri 'none'`（`csp.ts`）；`sandbox:true`、`contextIsolation:true`；`setWindowOpenHandler` 一律拒絕，`will-navigate` 也有限制（`windows.ts:18-23`）。
**缺口（預防性）。** (1) 沒有 eslint，也沒有任何測試禁止 HTML sink，只要一個 PR 就能讓 XSS 一路升級成 RCE；(2) `SessionReplayPlayer.tsx:94,131` 把錄下的位元組原樣寫進 xterm，OSC 8、標題、各種查詢序列都由 xterm 的預設行為處理。目前沒有可利用的路徑（未載入 ClipboardAddon，`window.open` 也被拒），但這同樣靠「沒有人打開某個選項」；(3) openExternal 的 allow-list 只在 `app:openExternal` 生效，`updater.ts:335` 與 `capture-prerequisites.ts:105` 各自直接呼叫 `shell.openExternal`。過去的 openExternal、navigation／drop 修補都是逐站修的。
**結構修法。** IPC 註冊表加 schema：每個 channel 宣告 zod 之類的 schema，由 `registerChannel(name, schema, handler)` 統一驗證，preload 也從同一張表產生，gate 測試確認沒有任何 `ipcMain.handle` 繞過註冊表。特權動作（plugin grant、hook install、runtime install、terminal profile）在 **main 端**以原生 `dialog.showMessageBox` 顯示 content hash 與將執行的內容，由 operator 在這裡確認，不再只靠 renderer。新增一個 `UntrustedText` 元件與 lint 或靜態測試，禁止 HTML sink；replay 前經過一個 sanitizer，剝除 OSC 52／8／0-2 與 DCS。所有 openExternal 一律經過 `externalUrlAllowed`。
**遷移。** 先加 gate（禁止 HTML sink、openExternal 單一入口），這一步成本最低；再逐檔把 handler 移進註冊表；最後把同意流程搬到 main。影響：`src/main/**` 全部的 handler、preload、`env.d.ts`。

---

## F6. 隱含的威脅模型沒有寫下來，幾段註解把機制說得比實際能做到的更強

**觀察。** 簽章私鑰（`~/.redlog/keys/*.key`，0600）、API token、`plugins/trust.json`（寫入時沒有指定 mode，`trust.ts:41`）、bundled tailer plugins（在 asar 之外的 `Resources/plugins`，由 main `require()`；mac 只有 `identity: "-"` ad-hoc 簽章，fuses 沒有開 asar integrity 與 onlyLoadAppFromAsar），全部對同 UID 開放。這代表同 UID 行程可以讀出私鑰、改寫 DB 並重新簽章，在 app 內驗證時不會被發現，唯一的外部錨點是 OTS，而 Python verifier 不驗 OTS（F1）。這本身是合理的威脅模型；問題在於有些描述讓人以為不是這樣：`signing.ts:7-9` 寫「closes the ≤59-minute rewrite window」，`trust.ts:10` 寫「keeps an audit tool from executing arbitrary third-party code」，`signing.ts:30` 在正式版也讀 `REDLOG_KEYS_DIR`。
**修法。** 把威脅模型寫進 `.specify/memory/constitution.md` 或 ARCHITECTURE：防的是 (a) 瀏覽器或網頁、(b) 敵意的錄製內容、(c) bundle 的持有者或接收者，**不防**同 UID 行程。修正上述註解；`REDLOG_KEYS_DIR` 只在測試建置中讀取（比照 `test-hooks.ts` 的 build-time 常數）。若之後要提高到能防同 UID 讀檔，可把簽章金鑰放進 OS keystore（Keychain、DPAPI、libsecret）並設為不可匯出，但在 ad-hoc 簽章下 ACL 綁不到 app 身分，所以這屬於長期項目。

---

## 檢查過、結構健全（下一位不必重查）

- **API 與瀏覽器之間**：只綁 `127.0.0.1`（`api-server.ts:891,901`）；Host allowlist 能擋 DNS rebinding（`:258-264`）；CORS 只反射 `app|file|http://localhost|127.0.0.1|[::1]`，regex 結尾要求 `:`、`$` 或 `/`，所以 `localhost.evil` 不會通過；一律要求 `Authorization: Bearer`，跨來源請求必須先 preflight，而網頁拿不到 token，所以 CSRF 不成立。即使某個本機頁面（例如 `localhost:8000`）拿到反射的 CORS，沒有 token 也只能讀 `/api/health`。剩下的小點：`/api/health` 不需驗證，會回傳版本與 `projectOpen`，可被用來指紋辨識。
- **token**：32 bytes 隨機值，檔案 0600 並經 `restrictToOwner`；DB 只存 sha256，以 hash 查找，所以沒有 timing 問題；shell hook 用 `curl -K /dev/fd/4` 傳遞，不會出現在 argv（#489，`shell-common.sh:609-644`）。
- **請求大小與形狀**：20 MiB 上限、JSON 深度掃描、非 object 一律 400、limit／time 參數夾限（`api-request.ts`）。500 回應不帶細節（`internalError`），唯一例外是 `/api/events/search` 的 `detail: e.message`（`:465`）。
- **renderer**：見 F5 的「目前守住了」。
- **regex**：plugin 規則（loot、redaction、target、command tag）都跑在 `bounded-regex.ts` 的 worker 中並有時限；內建 secret shapes 有 linear 測試（`test/secret-patterns-linear.test.ts`）。
- **鏈的寫入端**：canonical 序列化；raw bytes 的 digest 在算 hash 前併入 data（`event-write.ts:15-22`）；有 delete 與 update trigger，舊版 trigger 會自動升級；寫入失敗時重設 head cache；跨 engagement 的寫入會被拒絕（`:460-464`）；producer 提供的時間會先驗證，`created_at` 也在 hash 內。
- **官方 AI adapter**：`require()` 前會比對內容是否與打包版本完全一致，並檢查 receipt（`official-agents.ts:139-155`）。使用者 plugin 的 tailer 一律拒絕；特權程式碼必須等狀態變成 `active` 才會 `require`（`contributions.ts:136-160`）；content hash 涵蓋 hookFile。
- **子行程**：沒有 `shell:true`；`exec(cmd)` 只出現在 `network-info.ts`／`opsec-state.ts`，字串是固定的或來自 OS 指令輸出，不含錄製內容；CA 不會自動安裝，只顯示指令讓 operator 自己執行；mitmdump 預設 listen `127.0.0.1`。
- **test hooks**：`resolveTestHooks` 要求 `!isPackaged || smokeBuild`，且 smoke 是 build-time 常數。fuses 已關閉 runAsNode、NODE_OPTIONS、inspect。
- **Python verifier**：解 zip 用 `zipfile.extractall`（會清理路徑）；unsigned-in-signed 判為失敗；有輸出公鑰指紋。

## 刻意的設計（附依據）

- Logged tier 不進鏈、不簽章（`event-write.ts:274-284`，`docs/design/DESIGN-two-tier-chain.md` §7.5/§8）。F1 只主張「既然已經算了摘要，就應該有人去驗」，不主張改變分層。
- sanitize 不修改原始列，而是追加 `system.sanitized`（`sanitize.ts:8-22`）。
- `httpCapture.listenHost` 可設為非 loopback（`config.ts:130`），供 WSL／VM 使用；設定後，LAN 上的任何人都能把流量寫進紀錄，這是 operator 自己的選擇。
- `/api/events` 允許 `shell`、`marker` 等外部型別，因為 CLI、hook 與內建終端機都走這條路（`external-event-policy.ts:9-11`）。F2 的修法是分權，不是收窄型別。
- VPS 不給 primary token，除非明確指定（`vps-deploy.sh:63-93`）。

## UNCONFIRMED

- F4 的短封包：從 Node 語意判斷必定會拋例外；在 Electron main 中最後是彈出對話框還是行程退出，未實測。KoD 封包的 transmit timestamp 是否為 0、是否因此產生巨大的 offset，也未實測。確認方式：在本機 UDP 單元測試中餵入 20 bytes 的封包，以及 stratum 0 的封包。
- ingest 路徑上的內建 regex（`target-extractor`、`pivot-detector`、`technique-tagger`、`credential-detector`）沒有被任何 linear gate 涵蓋；粗略 grep 沒有找到巢狀量詞，但未逐一實測。確認方式：把 `secret-patterns-linear` 的方法推廣到這些模組匯出的所有 RegExp。
- Windows NSIS 更新：`electron-builder.yml` 沒有 `publisherName` 或簽章設定，electron-updater 的完整性只依賴同一個 GitHub release 上的 `latest.yml` sha512。未查 electron-updater 在這種情況下是否另外驗證 Authenticode。
- AI agent 的輸出沒有經過 ingest 的 loot 掃描（`ingest.ts:486-498` 只處理 shell）；tailer 是否有另一條 loot 路徑，以及上鏈前的遮罩是否讓 loot 永遠找不到該 secret，未追查。
