# Feature Specification: 交付邊界、私人內容與內容生命週期

**Feature Branch**: `spec/077-personal-content-and-delivery`
**Created**: 2026-11-13
**Status**: Draft
**Input**：擁有者 2026-11-13 的裁定（R1–R12，見下表，本規格不重開）；[2026-11-13 的決定](../../docs/records/2026-11-13/DECISIONS.md)（§4 標記與匯出、§5「戰利品偵測作為遮蔽引擎的輸入」）；[根因審查](../../docs/records/2026-11-12/ROOT-CAUSE-REVIEW.md) §4（「清除已保存事件的內容」「私人內容」「個人流量規則」）；根因報告 [11 隱私與資料保護](../../docs/records/2026-11-12/root-cause/11-privacy-and-data-protection.md)（B 的 18 條路徑與 12 處不一致、F、G）與 [10 擷取種類與呈現](../../docs/records/2026-11-12/root-cause/10-capture-kinds-and-presentation.md)（`personalDomains` 的丟棄、問題 3）；`docs/UIUX-STANDARD.md` §26；Spec 071（契約、O11、O16、O18、FR-010、FR-130–134）、072（角色、家族、閱讀器）、074（讀取契約、投影）、075（狀態讀數、每個 shell 一列）、076（Exporter、L0／L2 讀取、FR-072、Q4）。

> 本檔只寫可觀察的行為與對外契約。模組邊界、資料形狀、群組演算法、名稱解析的分析、被否決的做法、程式碼現況與 gate 的實作在 [plan.md](plan.md)；執行順序與刪除清單在 [tasks.md](tasks.md)。Spec 076 FR-072 稱之為「後續的『交付邊界與內容生命週期』規格」的，就是本規格。

## 決策與範圍

### 已決議（擁有者，2026-11-13；本規格不重開）

| # | 裁定 | 落點 |
|---|---|---|
| R1 | 「不能因為工具來改變原本使用者的習慣」：操作者工作時，任何 RedLog 專屬的東西都不是必要的——不加前綴、不需記新指令、不改變他已經在打的東西的意思 | 全部 |
| R2 | 一個 shell 混著私人與攻擊指令。**主要**處理方式是「錄了但不交付」：事後、可撤回。記錄預設維持自動且完整 | A、B、E |
| R3 | 「不記錄」是次要且選用的：已決定的私人 shell；選用、設一次的機器層忽略清單；（評估並建議預設開關）遵循 shell 自己的歷史排除設定（前導空白、忽略樣式——絕不是「忽略重複」）。依規則略過的留下計數而不留內容，在狀態讀數看得到 | I |
| R4 | 清除內容是例外的第三層：明確、不可逆、在鏈上留下操作者清除了它的紀錄 | G |
| R5 | 交付只經一處：所有讓資料離開的路徑（CSV、JSONL、bundle、HAR、API 匯出、上傳 Exporter、擴充功能的 L0 讀取 API、L2 面板）套用同一個排除與同一個遮蔽；本規格是 Spec 076 Q4 與上傳外掛所依賴的「匯出套用遮蔽」前提 | E、F、H |
| R6 | UI 標準 §26：一頁一個主動作、不新增頁面、不加說明文字、活動紀錄的固定篩選列（指令｜HTTP｜AI｜檔案｜標記）不變；主視窗只有一個標記動作且以選取為錨；匯出只有一處、匯出的是目前看到的範圍 | D |
| R7 | **交付由範圍決定**（取代「可能私人」的推測）：與目標頁同一個關係，對指令、HTTP、AI 工具呼叫、帶目標的檔案都一樣。範圍內 → 直接交付；範圍外 → 直接處理；其餘 → 標示並在匯出時分組詢問；「以後一律」把答案變成規則；答案逐專案記住。明確的私人標示永遠優先於範圍；「交付」的答案也是可撤回的註記。指令類別與個人網域只當分組的鍵 | C |
| R8 | **不需要任何相容**：產品未發行。只規定目標設計；不遷移、不讀舊格式、不並存版本、沒有棄用期；被取代的機制刪除而不包裝。唯一的殘留：app 遇到它不理解的資料不得當掉 | 全部；tasks 的刪除清單 |
| R9 | **範圍外預設不交付**；操作者可改變：逐次匯出（「這次包含範圍外」）與逐列／逐組（明確的「交付」註記，可撤回） | C、D |
| R10 | **ssh 到目標機器**：在那裡做的事要被記錄並算是該目標的。開到範圍內主機的工作階段，它的互動紀錄（作為開啟它的那條指令的輸出）確定地承接工作階段的目標，作為範圍內交付 | C（FR-022） |
| R11 | **沒有任何隱私相關的終端機指令**：刪除 `redlog private` 與任何終端機的「清除／遺忘」指令；不定義標記私人、清除或隱私的終端機動詞。全部在 app 內：私人是來源列綁定控制項上的一個選擇；清除是對選取列的動作 | B、G、I |
| R12 | **遠端 hook 只裝在操作者自己的機器**（跳板、VPS），從不裝在客戶或目標機器上。所以進入目標的工作階段，紀錄只有互動紀錄；遠端 hook 的逐指令列只存在於操作者宣告為自己的主機 | C（FR-022）；071 的修改列在報告 |
| R13 | **形狀：不設計分開的功能**。個人標示、建議、遮蔽、扣下的檢視、上傳都不是各自的功能，而是**既有匯出面**上的選項與區段：包含什麼（範圍內／範圍外＋包含開關／待確認＋就地分組回答／個人）、遮蔽（帶數字、可查看）、格式、目的地（資料夾或已安裝的 Exporter）、一個主動作「匯出」。活動紀錄中的一個鍵只是餵進同一組數字；清除內容不屬於匯出，是一個列動作 | D；US1–US3、US6、US9 |

名稱與位址（K 段）的設計依擁有者的要求定案；其中「RedLog 自己查詢名稱」的預設開關列為 Q5。

### 本規格自行決定的（理由與被否決的替代方案見 plan.md）

1. **交付狀態是投影，決定是註記**：操作者的每一個決定是一列上鏈的 `system:delivery_mark`，從不修改被指到的列；撤回是另一列（plan D1）。
2. **優先序固定**：已清除 > 最新的明確註記 > 規則 > 範圍關係 > 待確認（plan D2）。
3. **只有確定的目標承接算數**：071 的 `terminal-last` 不算；確定承接的封閉清單在 FR-022（plan D3）。
4. **一張私人規則表、兩種動作**：`withhold`（記錄、不交付）與 `skip`（不記錄）是同一張機器層表的兩個動作（plan D4）；「一律交付」只在專案層（plan D5）。
5. **規則在讀取時依生效時間評估**，不蓋進列（plan D6）。
6. **Bundle 的唯一格式**以 stub 佔位：被扣下的列只留 `id`、`hash`、`prev_hash`、理由碼，交付範圍內每個鏈位置都在，連結照常驗證（plan D7、D8）。
7. **遮蔽過的列「內容無法驗證、連結可驗證」是設計**（plan D9）。
8. **私人列不從全文索引刪除，而是讀取時排除**；token 只由清除內容移除（plan D10；Q2）。
9. **遵循 shell 歷史排除預設關**（plan D11；Q1）。
10. **在私人 shell 裡打的攻擊指令 v1 不支援補錄**；以一個標記加備註代替（plan D12）。
11. **附件跟著列走**；跨到被扣下列的整檔附件（cast 分段、AI 原始 transcript）不交付（plan D13）。
12. **在 app 內選「私人」也扣下這個終端機已記錄的列**（plan D16）。
13. **名稱與位址**：目標有名稱與位址兩面；比對規則、觀察到的對應、RedLog 自己的查詢的邊界見 K 段（plan D17–D19）。
14. **交付一律遮蔽**：匯出面沒有「不遮蔽」的選項；今天的「清洗操作者資訊」開關成為遮蔽區段內的一項（plan D20）。
15. **範圍外的「這次包含」不寫註記**，只屬於那一次匯出；要永久改變用「交付」註記（plan D21）。
16. 既有的 `do_not_export`、`personalDomains`、`sanitize`／`sanitized_events`、`system:sanitized`、`/api/sanitize`、bundle 與 `redact-export` 兩套遮蔽全部刪除（R8；tasks 刪除清單）。

### 前提更正與已確認的事實（2026-11-13 於 `origin/main@ea91d268` 開檔確認）

- **今天沒有 CSV 匯出。** 格式只有 `json`、`ndjson`、`bundle`、`har`、`timeline`（`src/core/export-capabilities.ts:7,17-23`）。CSV 是 Spec 076 FR-084 的對齊列。
- **「不得匯出」是一張可變的旁表**：`do_not_export`（`src/core/db/index.ts:306-312`，「INSERT = mark; DELETE = unmark」），切換在 `src/core/db/do-not-export.ts:3-12`，不上鏈、撤銷不留痕跡；它把背景輸出一併算入（`:18-42`）。
- **個人流量的丟棄只在經計畫的匯出被計數**：預覽列出 `excludedDoNotExport`、`excludedPersonal`（`export-planning.ts:47-48,91-92`；`ExportMenu.tsx:604-605`），bundle manifest 有 `personalDropped`、`doNotExportDropped`（`bundle-export.ts:349-366,865-866`）。**仍是靜默的**：API 的 HAR 與 bundle 不帶 `personalDomains`（`api-server.ts:488,759-762`）；`GET /api/events`、`/api/events/search`（`api-server.ts:418-469`）既不排除 `do_not_export` 也不排除個人流量。報告 10 引用的 `bundle-export.ts:298-301` 行號已過時。
- **任何列被省略的 bundle 都變成 projection，而 projection 不檢查連結**：`bundle-export.ts:827`；兩個 verifier 只在非 projection 時比對 `prev_hash`（`bundle-verify.ts:200`、`tools/redlog-verify.py:488`），轉換過的列不重算雜湊（`bundle-verify.ts:207-211`）。今天扣下一列的代價是整份 bundle 不再驗證連結。
- **鏈的雜湊涵蓋整個 `data`**：`chainedRowCanonical`（`src/core/evidence-rules.ts:123-144`）；寫入在 `event-write.ts:619-631`。`no_update_events_hash` 禁止 UPDATE `data` 等欄位（`event-write.ts:214-224`），`no_delete_events` 禁止刪除（`:205-212`）。
- **事件 id 是隨機 UUIDv4**（`event-write.ts:602`），不含時間。
- **全文索引是 contentless 且允許以 rowid 刪除**（`db/index.ts:445-448`）。
- **範圍分類只有一個**：`classifyScope`（`scope-evaluator.ts:229-259`）。有允許清單時，兩份清單都沒有的主機是 `out-of-scope`；沒有允許清單時是 `no-scope`，而它的 `distance` 是 `in_scope`（`:233-235,244`）——今天的匯出遮罩把「沒設範圍」當成範圍內。分類器不區分名稱與位址，也不使用任何名稱對應。
- **目標擷取只看指令參數**，不看輸出（`target-extractor.ts:29-60`）。`sshHost` 取第一個 `@` 之後的字（`:31`），所以 `ssh -J jump@j user@target` 得到跳板；`sshuttle`、`chisel`、`ligolo` 取的是樞紐主機（`:57-59`）。
- **今天的目標承接**：`ACTIVE_TARGET_FALLBACK_TYPES = shell, marker, screenshot` 承接全域目前目標（`ingest.ts:71,250-254`）；071 FR-010 已決定改為 `explicit`／`extracted`／`command`／`terminal-last`／`none` 並寫 `target_via`；O18 的確定因果尚未實作。
- **`hooks/command-class.json` 不是工作／私人的分類**：它決定執行方式（`:46-47`；`ssh` 是 `pty`）；其 `wrappers`（`:87-88`）可用來解析真正的可執行檔名，只適合當分組的鍵。
- **今天的 shell hook 不遵循歷史排除**：bash 在前導空白時退回 `$BASH_COMMAND` 照樣記錄（`hooks/shell-bash-hook.sh:358-379`）；zsh 的 `preexec` 收到整行（`hooks/shell-zsh-hook.zsh:424,687`）；沒有 hook 讀 `HISTIGNORE`／`HISTORY_IGNORE`。
- **名稱解析的現況**：(a) RedLog 程式碼中唯一的 DNS 呼叫是出口位址檢查：`Resolver` 對 `208.67.222.222`、`216.239.32.10` 查 `myip.opendns.com`、`o-o.myaddr.l.google.com`（`src/main/services/producers/ip-signal-producer.ts:25-60`），`ipMode` 預設 `auto`、`offline` 預設 `false`（`src/core/config.ts:49,57,281-282`），offline 時拒絕（`ip-signal-producer.ts:222`）；**沒有任何目標或範圍的程式做 DNS 查詢**（`src/` 中 `dns` 模組的使用只有這一處）。(b) 被動的對應只在操作者以 mitmproxy 的 DNS 模式執行 addon 時存在：`dns_query`（`hooks/mitmproxy-addon.py:1659-1693`）與帶 `answers` 的 `dns_response`（`:1700-1730` 一帶）。(c) HTTP 列記錄 URL 主機、TLS 憑證的 SAN（`:1098-1125`），**不記錄連線的遠端位址**；只有 TCP 流記錄 `_tcp_peer`（`:747-757,1847,1921`）。(d) 沒有任何程式讀 hosts 檔（`/etc/hosts`、`drivers\etc\hosts`，grep 無結果）。
- 遮罩的 18 條路徑與 12 處不一致以報告 11 B 段為準；本規格抽查了 P9–P11、P14 與 API 讀取（`sanitize.ts:84-146`、`redact-export.ts:65-114`、`bundle-export.ts:357-416`、`api-server.ts:418-509`），其餘依報告。

## User Scenarios & Testing *(mandatory)*

本規格只有**一個操作者面**：既有的匯出對話框（`ExportMenu`，標題列的按鈕開啟，`App.tsx:419`、`ExportMenu.tsx:441-468`）。「交付什麼」在那裡被決定、也在那裡被看見：包含什麼（範圍內／範圍外／待確認／個人，各帶數字）、遮蔽（帶數字、可查看）、格式、目的地（資料夾或已安裝的 Exporter），一個主動作「匯出」。其餘一切——註記、規則、範圍分類、名稱對應、單一交付點、stub、遮蔽引擎、讀取 API 規則——都是這一面背後的機制。活動紀錄中的一個鍵與來源列的「私人」只是把數字餵給這一面；清除內容是一個列動作，不屬於匯出。

| 故事 | 優先級 | 摘要 |
|---|---|---|
| US1 在匯出面上看見並決定交付 | P1 | 四個包含數字、範圍外的包含開關、一個匯出動作，端到端：預覽的數字＝交出的位元組 |
| US2 待確認在同一面上分組回答 | P1 | 不另開對話框；每組一個回答；未回答的扣下；「以後一律」 |
| US3 活動紀錄裡的一個鍵，餵進同一組數字 | P1 | 選取列、一個鍵 → 「個人」數加 N；可撤回 |
| US4 進入目標的工作階段算是那個目標的 | P1 | ssh 等工作階段的互動紀錄承接開啟它的指令的目標 |
| US5 扣下列之後 bundle 仍完整驗證 | P1 | stub 佔位；verifier 說「N 列由操作者扣下」 |
| US6 遮蔽是匯出面上的一個區段 | P1 | 預設開、帶數字、可查看；每個出口同一個引擎 |
| US7 名稱與位址不會互相矛盾地分類 | P2 | 名稱或位址任一在範圍內；衝突時進待確認；對應是有時間的事實 |
| US8 一律規則與私人終端機 | P2 | 規則從「以後一律」產生；私人是來源列綁定控制項的一個值；略過的只留計數 |
| US9 Exporter 是目的地清單中的一項 | P2 | 同一面、同一組數字；擴充功能的讀取經同一交付點 |
| US10 清除內容是一個列動作 | P2 | 不可逆、上鏈、驗證說「內容已由操作者清除」 |

### User Story 1 — 在匯出面上看見並決定交付（P1）

操作者打開匯出（它匯出目前看到的範圍）。在既有的格式、範圍、附件、目的地之間，包含區段寫：

```
範圍內      1,384   交付
範圍外          1   不交付    [ ] 這次包含
待確認        612   不交付    ▸
個人           14   不交付
遮蔽          9 個欄位         ▸
```

他按「匯出」。bundle 中 1,384 列完整、627 個位置是 stub；manifest 與對話框的數字逐一相同。

**Why this priority**：R5、R7、R9 與擁有者對形狀的指示——交付只在一處被決定與看見。這是 Phase 1 的全部可見成果：數字在每個出口端到端成立（待確認在 Phase 1 一律扣下，分組回答在 Phase 2）。

**Independent Test**：(a) e2e：同一份 fixture 經對話框匯出 json、ndjson、bundle、HAR，對話框的四個數字與遮蔽數等於檔案中的 `delivery` 摘要或 manifest；(b) 交付點 property test（FR-091）：任何被扣下列的內容不出現在任何出口；(c) 決策表：{範圍內、排除、範圍外、`no-scope`、衝突、無目標} × {無註記、withhold、deliver} × {無規則、withhold 規則、deliver 規則} × {包含範圍外 開、關} 的每一格。

**Acceptance Scenarios**：

1. **Given** 一列 `target_via: extracted`、目標在允許清單，**Then** 計入「範圍內」並交付。
2. **Given** 一列範圍外，**Then** 計入「範圍外」，不交付；紀錄與 `scope_violation` 照常看得到。
3. **Given** 勾「這次包含」，**Then** 範圍外的列本次交付（經遮蔽），不寫任何註記；下一次打開時又是不勾。
4. **Given** 一列範圍內但被標為個人，**Then** 計入「個人」，不交付（R7：個人優先）。
5. **Given** 以 API（`/api/export/bundle`、`GET /api/events`）取資料，**Then** 套用同樣的狀態，回應帶同樣的計數（`excluded`）；沒有任何出口繞過這一面的規則。

### User Story 2 — 待確認在同一面上分組回答（P1）

「待確認 612」展開後，在**同一個對話框裡**是約 20 組：`cd · 212`、`ls · 140`、`vim · 31`、`AI 工作階段 3f2a · 44`、`nc · 3`……每組一列，兩個選擇「交付／不交付」與一個勾選「以後一律」。他回答了六組就按匯出；其餘仍是不交付。第二天再匯出，只出現新的列所屬的組。

**Why this priority**：R7。逐列詢問不可行；推測「可能私人」已被否決。這是匯出面的一個區段，不是另一個對話框。

**Independent Test**：(a) 問題組的鍵（FR-025）每條一案例；(b) 問題數（SC-003）；(c) 回答後重新解析計畫，數字即時移動（「待確認」減、「範圍內」或「個人」不變而「交付」增）。

**Acceptance Scenarios**：

1. **Given** 一列 `target_via: terminal-last`，**Then** 在「待確認」中，依可執行檔分組；組的標籤附上該終端機最後的確定目標作為提示，不作判定。
2. **Given** 對 `cd` 組選「交付」，**Then** 鏈上一列 `delivery_mark{decision:"deliver", reason:"answer", selector:{ids:[…]}}`，計畫重新解析；第二次匯出不再問這些列；新的 `cd` 列再問，除非勾了「以後一律」（成為專案層交付規則）。
3. **Given** 未回答就匯出，**Then** 未回答的列不交付（stub `unanswered`）；匯出從不被擋。
4. **Given** 一組太粗，**When** 選「依終端機分開」，**Then** 那一組在原處變成每個終端機一組。

### User Story 3 — 活動紀錄裡的一個鍵，餵進同一組數字（P1）

操作者在已綁定的 zsh 裡查了自己的銀行網站、`cat` 了自己的筆記。下午他在活動紀錄選取那幾列、按一個鍵。它們仍在紀錄裡（收合成一列）；下一次打開匯出，「個人」多了那幾列。選錯一列，再按一次，那一列回到原來的分類。

**Why this priority**：R2 的主路徑。它沒有自己的介面：它只是改變匯出面上的數字。

**Independent Test**：按鍵前後解析同一個計畫，「個人」數的差等於選取數加連帶列；撤回後回到原值。

**Acceptance Scenarios**：

1. **Given** 選取三列，**When** 按鍵，**Then** 鏈上一列 `delivery_mark{decision:"withhold", reason:"personal", selector:{ids:[…]}}`，三列在活動紀錄收合為一列。
2. **Given** 上一步，**When** 選取其中一列再按，**Then** 一列 `decision:"clear"`，該列回到規則與範圍的結果。
3. **Given** 一列 `command_end` 被扣下，**Then** 同一指令的 `command_start`、背景輸出列、推導列（`loot`、`credential_use`、`scope_violation`）一併扣下。

### User Story 4 — 進入目標的工作階段算是那個目標的（P1）

操作者在綁定的 shell 打 `ssh admin@10.0.0.5`，在遠端跑了半小時，`exit`。這整段互動是 `ssh` 這一條指令的輸出；目標由指令擷取為 `10.0.0.5`，範圍內，整段計入「範圍內」。他接著打 `ssh -J me@jump.mine admin@10.0.0.9`：目標是 `10.0.0.9`，不是跳板。

**Why this priority**：R10、R12。

**Independent Test**：fixture：`ssh` 的 start／output／end；`ssh -J`；`ssh -D`＋`proxychains nmap`；`evil-winrm -i`；`nc -lvnp` 收到的反向 shell；操作者自己跳板上的遠端 hook 列。斷言每一列的範圍關係與 `target_basis`（FR-022）。

**Acceptance Scenarios**：

1. **Given** `ssh admin@10.0.0.5` 在範圍內，**Then** 它的 start、end 與每一個輸出列計入範圍內，`target_basis: session-command`。
2. **Given** 在工作階段裡又打 `ssh 10.0.0.77`（巢狀跳轉），**Then** 那段互動仍是外層指令的輸出，屬於 `10.0.0.5`；RedLog 不切開輸出。
3. **Given** `nc -lvnp 4444` 接到反向 shell，**Then** 沒有確定的目標，整段進待確認，組 `cmd:nc`。
4. **Given** 操作者自己的跳板上的遠端 hook 送來 `nmap 10.0.0.12`，**Then** 依擷取的目標分類；同一主機上的 `ls` 進待確認，組 `remote:<名稱>`；跳板本身從不是目標。

### User Story 5 — 扣下列之後 bundle 仍完整驗證（P1）

bundle 中 40 列被扣下（12 個人、20 範圍外、8 待確認）。客戶執行 `redlog-verify.py`：`VERIFIED`，另一行「40 rows withheld by the operator (personal 12, out-of-scope 20, unanswered 8)」；從第一列到 head 每一個位置都在，連結逐一檢查。

**Independent Test**：雙 verifier 共用向量：stub 在中間、開頭、最後（由 seal 的 `headHash` 承諾）、連續 1,000 個；stub 的 `hash` 被改；stub 被刪；manifest 的扣下數與 stub 數不符；stub 帶額外欄位。

**Acceptance Scenarios**：

1. **Given** 上述 bundle，**Then** 兩個 verifier 結束碼 0，輸出扣下總數與各理由的數。
2. **Given** 有人把 stub 換成捏造的完整列，**Then** 雜湊重算不符 → 1。
3. **Given** 有人把交付的列換成 stub，**Then** 扣下數與 seal 不符 → 1 或 5。

### User Story 6 — 遮蔽是匯出面上的一個區段（P1）

`mysql -u root -pS3cretPass! -h 10.0.0.5` 範圍內，照常交付；交付的 `command` 是 `mysql -u root -p[REDACTED:password-flag] -h 10.0.0.5`。匯出面的「遮蔽 9 個欄位 ▸」展開後，在同一個對話框裡逐項列出：哪一列、哪個欄位、哪條規則（不顯示原值）。「無法遮蔽」的附件在既有的附件清單中標明，可逐項取消。

**Why this priority**：R5；076 Q4 依賴它。今天 HAR 原樣交出 `Authorization`，四種匯出預設都不套用偵測到的 span。

**Independent Test**：遮蔽 property test（FR-092）；預覽的遮蔽數＝輸出的替代數。

**Acceptance Scenarios**：

1. **Given** 今天才加的 denylist 值，**When** 匯出昨天的列，**Then** 套用（交付時以目前政策重掃）。
2. **Given** 一列被遮蔽，**Then** bundle 的 `system:redacted` 列出 `{event, field, sha256}`，verifier 報告「N rows redacted by policy <版本>; their content cannot be checked against the chain」。
3. **Given** >4 KiB 的 stdout 在 sidecar，**Then** 同樣重掃，遮蔽後以 `http-bodies/<原 sha>.redacted` 交付；二進位 body、截圖、cast 列為無法遮蔽。

### User Story 7 — 名稱與位址不會互相矛盾地分類（P2）

範圍寫 `*.client.example`，`nmap` 打的是 `203.0.113.10`。代理在 09:12 觀察到 `app.client.example → 203.0.113.10`。09:30 的 `nmap 203.0.113.10` 計入範圍內，閱讀器寫「範圍內·依 09:12 觀察到的對應」。`curl -H 'Host: other.example' http://203.0.113.10/` 計入範圍外。

**Independent Test**：比對表（FR-101、plan D17）逐格；對應的時間選擇；查詢與觀察不一致時觀察勝並顯示；`offline` 時查詢為 0。

**Acceptance Scenarios**：

1. **Given** 範圍只有名稱、列只有位址、沒有對應，**Then** 待確認，不是範圍外。
2. **Given** 名稱在範圍內、位址被明確排除，**Then** 待確認，組 `conflict:`，標籤寫出兩邊。
3. **Given** 一列已交付後，晚到的事實使它的分類改變，**Then** 下一次匯出面多一行「分類改變 k」，從不靜默。

### User Story 8 — 一律規則與私人終端機（P2）

在待確認區段勾「以後一律」不交付 `host: *.mybank.example`，之後所有專案中它都直接計入「個人」。在設定既有的「私人」一列下，他把一條規則的動作從「不交付」改為「不記錄」。在來源列上，他把一個 tmux pane 的綁定改為「私人」。

**Independent Test**：(a) 規則評估表；(b) `skip` 規則的 hook 向量：不送、不寫交接檔、用掉序號、計 `ignored-rule`；(c) `since` 之前的列不受影響；(d) 綁定控制項「私人」：寫終端機狀態檔的停止原因，hook 下一個 prompt 停送；該終端機已記錄的列計入「個人」。

**Acceptance Scenarios**：

1. **Given** `withhold` 規則 10:00 加入，**Then** 10:00 之後符合的列計入「個人」；專案鏈上一列 `system:delivery_rule`，只含主機的雜湊。
2. **Given** `skip` 規則，**Then** 符合的內容從未到達 RedLog 的磁碟；狀態讀數該來源的列寫「略過 N」。
3. **Given** 開啟「遵循 shell 歷史排除」且 `HISTCONTROL` 含 `ignorespace`，**When** 打 `␠curl …`，**Then** 不記錄、計 `shell-history-rule`；`ignoredups` 永遠不被遵循。
4. **Given** 在來源列把 pane 設為「私人」，**Then** 它之後不送任何項目，已記錄的列計入「個人」；改回「綁定」後恢復記錄，先前的扣下仍在。

### User Story 9 — Exporter 是目的地清單中的一項（P2）

操作者安裝並核准了一個上傳 Exporter（076），在本專案啟用。匯出面的「目的地」除了資料夾，多了那個 Exporter。選它時格式固定為對齊列，層級取自它的核准；包含與遮蔽的數字與選資料夾時相同；按「匯出」送出一批。

**Why this priority**：R5；076 E9 以「匯出確實套用遮蔽」為前提。上傳不是另一個流程，是另一個目的地。

**Independent Test**：同一計畫選資料夾與選 Exporter，交付的列 id 集合與遮蔽替代相同；`system:export_shipped` 帶 `withheld`；L0 讀取與 L2 面板的資料經同一交付點，被扣下的列不回傳（除非 `reads.withheld` 明列）；Exporter 宣告 `reads.withheld` 含 `personal` 時載入失敗。

**Acceptance Scenarios**：

1. **Given** 本規格 Phase 1 與 Phase 4 已合併，**Then** 076 的 `command`／`content` 層級可以啟用（FR-074）；之前目的地清單中的 Exporter 只能 `meta`。
2. **Given** L2 面板收到被扣下列的 `selectionChanged`，**Then** 面板拿到 `null` 與 `excluded:1`。

### User Story 10 — 清除內容是一個列動作（P2）

操作者在指令列貼了自己的私人密碼，扣下不夠，他要它從磁碟上消失。他選取那一列，右鍵「清除內容」，輸入確認。之後 app 內的驗證與任何 bundle 都說「1 row's content cleared by the operator」。

**Independent Test**：清除後掃描：臨時 home 中寫入帶標記字串的指令（含 >4 KiB 輸出、loot 命中、FTS、交接檔、隔離檔），清除，checkpoint；grep 整個臨時 home 出現 0 次；兩種驗證都為 0 並報告 cleared 1。

**Acceptance Scenarios**：

1. **Given** 清除一列，**Then** 它的 `data` 變成 `{"_content_cleared":"<清除紀錄 id>"}`，`hash`、`prev_hash`、`signature` 不變；鏈上一列 `system:content_cleared`。
2. **Given** 清除後，**When** 嘗試交付，**Then** 不可能：清除的列永遠是 stub（`cleared`），計入匯出面的「個人」之外的一行「已清除 d」（只在 d > 0 時出現）。
3. **Given** 清除內建終端機的一列，**Then** 確認時寫出同一 cast 分段中一起失去回放的列數。

### 情境對照

| 情境 | 本規格的處理 |
|---|---|
| 在綁定的 shell 打了一條私人指令 | 照記；在活動紀錄選取、按鍵，匯出面的「個人」加一（US3）。符合機器規則則自動（US8） |
| 事後才想起來 | 任何時候都可以；已交付的副本無法收回，鏈上的 `export_sealed`／`export_shipped` 記著它曾離開 |
| 從錄製中的 shell `ssh` 到私人主機，直到 `exit` | `ssh` 是一條 pty 類指令，整段互動是它的輸出（US4）。主機不在範圍內 → 範圍外，預設不交付（R9）；要明確 → 扣下這一條指令（選擇器 `command_id`，涵蓋 start、end、全部輸出）。私人主機上不會有遠端 hook（R12） |
| 經擷取代理的私人瀏覽 | 主機不在範圍內 → 範圍外，預設不交付；「以後一律」→ 機器層 `host` 規則；連記錄都不要 → 同一規則改 `skip`，在 addon 端丟棄並計數 |
| 綁定的 AI 工作階段裡問了私人問題 | AI 回合沒有目標 → 待確認，依工作階段分組；在閱讀器選那幾個回合扣下（選擇器 `ai_session`＋區間） |
| 標錯、撤回 | 另一列 `clear` 註記；最新的有效；兩列都在鏈上。清除內容不可撤回 |
| 交出一份扣下 40 列的 bundle | US5 |
| 指令列貼了 secret | 交付時遮蔽，匯出面的遮蔽區段可查看（US6）；要從磁碟上消失 → 清除內容（US10） |
| 在私人終端機打了攻擊指令 | **v1 不支援補錄**：私人終端機什麼都不送，沒有可補的內容；保留私人內容的緩衝等於把「不記錄」變成「記錄但藏起來」。以一個標記（可指定時間，DECISIONS §4）加備註記下它；改回「綁定」後的指令照常記錄 |

### Edge Cases

- 被扣下的列已經在之前交付過：新的註記只影響之後的交付；`export_sealed` 的 `selectedEventIds` 可查。
- 時間區間型選擇器在讀取時評估，晚到的列（`timestamp` 落在區間內）一樣被涵蓋；id 型選擇器不涵蓋它。
- 一列同時符合 `withhold` 與 `deliver` 規則：`withhold` 勝。
- 範圍在行動中改變：範圍關係以匯出計畫凍結的範圍快照計算（`export-plan.ts:323-337`）。
- 推導列（`loot`、`credential_use`、`pivot`、`scope_violation`）的狀態等於它第一個 `_causes` 來源列的狀態；沒有來源者依自己的目標。
- 系統列與標記：預設交付；只有 id 型選擇器能扣下它們；時間區間型選擇器只涵蓋 `commands`、`traffic`、`ai`、`artifacts` 四個家族（072 `KindFamily`）。
- `system:delivery_mark`、`system:delivery_rule`、`system:name_resolved` 一律交付；它們不複製被扣下的內容，機器層規則只記雜湊。
- 匯出計畫建立後、執行前有新註記（例如在另一個視窗按了鍵）：以 `policy-changed` 拒絕（今天 `export-planning.ts:126-140` 的形式），匯出面重新解析並更新數字。
- 清除的列被另一列的 `_causes` 指到：那一列照常交付，`_causes` 指向 stub。
- 綁定控制項設為「私人」時，該 shell 從未送過任何項目：它不出現在來源列（075 的 shell 列來自 `hello`），所以無從設定；這是 R2 的預設——先記錄，再扣下。
- app 遇到不理解的資料（未知版本的註記、未知的選擇器、未知的種類）：忽略該項並在讀取服務的 `health()` 計數，不當掉（R8）。被忽略的選擇器涵蓋的列狀態為「待確認」，不是「交付」。

## Requirements *(mandatory)*

### Functional Requirements

#### A. 交付狀態（R2、R7）

- **FR-001** 每一列（兩層）在任一時刻恰好有一個**交付狀態**：`deliver`、`withhold` 或 `ask`；以及一個**理由**：`in-scope`、`answer`、`rule`、`included-this-export`（`deliver`）；`personal`、`out-of-scope`、`unanswered`、`cleared`（`withhold`；`ask` 在交付時成為 `withhold`／`unanswered`）。
- **FR-002** 操作者的決定只以一種形式存在：上鏈的 `system:delivery_mark`（`role: annotation`、`tier: chained`、`pause: exempt`、`writers: ['in-process']`，072 登記），欄位 `{v:1, decision:'withhold'|'deliver'|'clear', reason:'personal'|'answer'|'private-terminal', selector, note?}`。`clear` 撤回之前對這些列的決定。它從不修改被指到的列。只有操作者憑證（app 內的動作）能寫它。
- **FR-003** 選擇器是封閉聯集（形狀見 plan「資料形狀」）：`ids`（≤ 5000，超過時分多列並以 `batch` 相連）、`command_id`、`terminal`（終端機 id＋`from`／`to`）、`ai_session`（＋可選 `from`／`to`）、`flow_ids`、`producer`（＋`from`／`to`）、`host`（只存 `sha256(正規化主機)`＋時間界）。「目前篩選的全部列」解析成 `ids` 寫入（附查詢字串供閱讀），不存查詢本身。
- **FR-004** 狀態由純函式 `deliveryOf(row, context)`（`src/core/delivery/state.ts`）決定，優先序：(1) 已清除 → `withhold`／`cleared`；(2) 涵蓋該列的最新一筆不是 `clear` 的 `delivery_mark` → 其決定；(3) 生效中的規則（FR-020、FR-023），兩者都符合時 `withhold`；(4) 範圍關係（FR-021、K 段）；(5) `ask`。推導列先改用來源列的結果。匯出請求的「這次包含範圍外」只把 (4) 的 `out-of-scope` 改為 `deliver`／`included-this-export`。
- **FR-005** 074 新增投影 `delivery_state(event_id, tier, mark_state, rule_id?, target_name?, target_addr?, target_basis)`，放在 `derived.db`，遵守 074 FR-030–040。範圍關係依賴範圍與對應，在讀取時以請求的快照計算；投影只物化 (1)–(3) 與目標的兩面。
- **FR-006** 074 的讀取契約加共用參數 `delivery: 'operator' | 'deliver'`：`operator`（app 內的操作者讀取）回傳全部列並附 `delivery` 欄；`deliver`（每一個交付出口）只回傳交付的列與 stub 計數。查詢語言加鍵 `delivery:`（值 `deliver`、`withhold`、`ask`、`personal`、`out-of-scope`），只是篩選。
- **FR-007** 私人列在 `operator` 讀取中**預設不出現在搜尋結果**（`/api/events/search`、⌘K、活動紀錄的文字搜尋）；查詢含 `delivery:personal` 時才出現。

#### B. 餵進匯出面的輸入（R1、R6、R11）

這一段的每一項都沒有自己的介面：它們只改變匯出面（D 段）上的數字。

- **FR-010** 活動紀錄：選取一列或多列後，一個鍵（`lib/shortcuts.ts` 單一表中的一個鍵，預設 `p`，plan D14）切換「個人」：選取中有任何列不是 `withhold`／`personal` → 對全部寫 `withhold`；否則寫 `clear`。同一動作在列的右鍵選單出現一次。它**不是**標記（DECISIONS §4 的單一標記動作不變），不在工具列放按鈕。
- **FR-011** 選取延伸沿用既有的清單鍵盤與 Shift 選取；另外三個延伸只在同一右鍵選單：「這個終端機從這裡到……」（`terminal` 選擇器）、「這個指令」（`command_id`）、「這個 AI 工作階段」（`ai_session`）；「目前篩選的全部列」也在此。
- **FR-012** **沒有任何隱私、個人、扣下或清除的終端機動詞**（R11）。
- **FR-013** 「以後一律」只出現在匯出面待確認區段的每一組（FR-026），以及 FR-010 的右鍵選單：`withhold` → 機器層私人規則（FR-020）；`deliver` → 專案層交付規則（FR-023）。規則的 `match` 取自分組鍵。規則在設定既有的「資料與隱私」分組中的一列（「私人」）下檢視、編輯動作（不交付／不記錄）或刪除；不新增設定頁。
- **FR-014** 私人終端機（R3、R11）：075 每個 shell 一列的來源列上，既有的綁定控制項有兩個值「綁定到本專案」「私人」。選「私人」：app 寫終端機狀態檔的停止原因 `private`（073 FR-041 的封閉清單），hook 在下一個 prompt 讀到後不送任何項目、不寫交接檔、不計數；app 同時寫一列 `delivery_mark{decision:'withhold', reason:'private-terminal', selector:{terminal, from:<該終端機第一列>, to:<現在>}}`。改回「綁定」撤銷停止原因；先前的扣下不自動撤回。
- **FR-015** 活動紀錄與時間軸：`withhold`／`personal` 的連續列（同一來源、中間沒有其他列）收合為一列：固定符號＋數字，沒有說明文字；展開後以次要文字色顯示。範圍外與待確認的列不改外觀。固定篩選列不變；交付狀態只經篩選選單或查詢鍵 `delivery:`。
- **FR-016** 閱讀器（072）的第一行加一個字：`交付`、`不交付·個人`、`不交付·範圍外`、`待確認`、`內容已清除`；範圍關係依對應而來時加「依 HH:MM 觀察到的對應」或「依 RedLog 查詢」（K 段）。
- **FR-017** 目標頁：每個目標的事件數不計個人列；清單中依 FR-015 收合。目標頁與匯出面讀同一個 `classifyTarget`（FR-107）。
- **FR-018** 狀態讀數（075）只多一種事實：每個來源的「略過 N」（071 的有意遺失原因 `ignored-rule`、`shell-history-rule`）。個人、範圍外、待確認不進狀態讀數——它們的家是匯出面。

#### C. 交付由範圍決定、分組詢問（R7、R9、R10、R12）

- **FR-020** 機器層私人規則：`~/.redlog/machine.yaml` 的 `personal.rules[]`（073 擁有檔案），每條 `{id, match:{kind:'host'|'command'|'ai-path', pattern}, action:'withhold'|'skip', since}`。`host` 用 `classifyScope` 的樣式語法，對名稱與位址兩面都比對（K 段）；`command` 是可執行檔名或整行 glob；`ai-path` 是工作路徑前綴。規則只影響 `created_at ≥ since` 的列。這張表取代 `scope.personalDomains` 與 073 FR-01B 的 `personalTraffic`。
- **FR-021** **範圍關係**以凍結的範圍快照、K 段的比對規則計算，只用確定的目標（FR-022）：
  | 目標 | 關係 |
  |---|---|
  | 確定的目標，K 段判為範圍內 | `deliver`／`in-scope` |
  | 確定的目標，K 段判為範圍外（含宣告的排除 `!host`） | `withhold`／`out-of-scope`（R9） |
  | 確定的目標，K 段判為無法確認（`no-scope`、衝突、只有一面且沒有對應） | `ask` |
  | 沒有確定的目標 | `ask` |
  | 標記、`system:*` | `deliver`／`in-scope` |
- **FR-022** **確定的目標**是封閉清單（plan D3）：
  1. `target_via: explicit`、`extracted`、`operator-selected`（071 FR-010、O16）。
  2. `target_via: command`：背景輸出承接它所屬的指令。
  3. **工作階段指令的輸出**：開啟互動工作階段的指令（`ssh`、`evil-winrm`、`psexec.py` 等，擷取規則能從參數取出主機者）的整段互動是那一條指令的輸出列；它們承接該指令擷取的目標，`target_basis: session-command`。目標是**最終目的地**：`ssh -J`／`-o ProxyJump`／`ProxyCommand` 指名的主機是跳轉，不是目標（目標擷取的改動見 tasks）。互動中的巢狀跳轉（在遠端再 `ssh` 到另一台）仍屬外層指令的輸出，承接外層的目標；RedLog 不切開輸出。
  4. **經樞紐的工具**：`proxychains`、SOCKS 等包裝下的指令，以被包裝工具的參數擷取目標（`wrappers` 解析）；樞紐本身（`ssh -D`、`sshuttle -r`、`chisel client`、`ligolo -connect` 的主機）不是那些流量的目標，那一條指令自己的目標是樞紐主機。
  5. 推導列承接第一個 `_causes` 來源列；O18 的確定因果落地後，帶確定 `_causes` 的列依其來源。
  6. 遠端 hook 的列（`_ingest.producer = remote:*`）：依 1–5 擷取它自己的目標；遠端主機本身是操作者自己的機器（R12），從不作為目標。
  **不是**確定的目標，因此進「詢問」：`terminal-last`；`none`；沒有目標參數的工作階段（`nc -lvnp` 收到的反向 shell、`msfconsole`、本機的 REPL）；只出現在輸出文字中的主機。
- **FR-023** 專案層交付規則：專案 `config.yaml` 的 `delivery.rules[]`，形狀同 FR-020，`action` 只有 `deliver`；只在該專案生效。沒有機器層的「一律交付」。
- **FR-024** 規則的增刪在受影響的專案鏈上寫 `system:delivery_rule{op:'add'|'remove', rule_id, scope:'machine'|'project', match_kind, pattern_sha256, action, since}`；機器層規則的原文從不寫進專案，專案層的寫 `pattern`。機器規則在專案關著時改變：下一次開專案時寫。
- **FR-025** 匯出時每一列 `ask` 恰好屬於一個**問題組**；分組鍵依序取第一個成立的（演算法與量測見 plan D15）：`ai:<工作階段>`、`remote:<名稱>`、`conflict:<名稱>|<位址>`、`host:<可註冊網域或 /24>`（有目標但無法確認）、`cmd:<可執行檔>`（`wrappers` 解析）、`file:<種類>`、`kind:<家族>`。組依列數排列；每組顯示鍵、列數、跨幾個終端機或工作階段、該終端機最後的確定目標（只是提示）。
- **FR-026** 每組恰好一個回答：「交付」或「不交付」，加「以後一律」勾選。回答寫一列 `delivery_mark{reason:'answer'}`，選擇器是該組在本次計畫快照中的 `ids`。組可「依終端機分開」成多組。沒有逐列回答的介面；逐列回到活動紀錄用 FR-010。
- **FR-027** 未回答的組本次為 `withhold`／`unanswered`；匯出從不被擋。回答在鏈上，所以下一次只出現新的 `ask` 列。
- **FR-028** 量測目標：SC-003。

#### D. 匯出面：交付唯一被決定與被看見的地方（R5、R6、R7、R9）

今天的匯出對話框（`src/renderer/src/components/ExportMenu.tsx`）：標題列按鈕開啟的模態對話框（`:441-468`）；範圍（目前檢視／全部）與格式選單（`:482-500`）；「清洗操作者資訊」與「遮罩範圍外」兩個開關（`:527-530`）；預覽區塊的格式、範圍、政策列（`:536-575`）、目的地與「變更」（`:578-585`）、數字列（`:601-637`，含 `excludedDoNotExport`、`excludedPersonal`、`sanitized`）、附件清單（`AttachmentList`，`:81-135`）；一個主要按鈕（`:669`）。本規格**延伸它**，不新增任何對話框、頁面或流程。

- **FR-030** 匯出面維持一個主動作「匯出」與既有的範圍、格式、附件清單。新增或取代的只有下列區段，全部在同一個對話框內，數字由同一個 `deliver` 在計畫解析時算出（FR-041）：
- **FR-031** **包含區段**取代 `excludedDoNotExport`、`excludedPersonal`、`maskedOutOfScope` 三列與「遮罩範圍外」開關：
  | 行 | 數字 | 預設 | 操作者可改 |
  |---|---|---|---|
  | 範圍內 | `deliver` 的列 | 交付 | 經 FR-010 改為個人 |
  | 範圍外 | `withhold`／`out-of-scope` | 不交付 | 一個勾選「這次包含」（只對本次匯出，不寫註記）；逐列或逐組以「交付」註記永久改變（R9） |
  | 待確認 | `ask` | 不交付 | 展開為問題組（FR-025–027），就地回答 |
  | 個人 | `withhold`／`personal` | 不交付 | 回到活動紀錄撤回（FR-010） |
  | 已清除 | `withhold`／`cleared` | 不交付 | 不可改；只在 > 0 時出現 |
  | 分類改變 | FR-106 | — | 展開列出；只在 > 0 時出現 |
  數字為 0 的行（範圍內除外）不顯示。沒有說明文字。
- **FR-032** **遮蔽區段**取代 `sanitized` 列與「清洗操作者資訊」開關：一行「遮蔽 N 個欄位」，永遠開啟（交付不提供不遮蔽的選項，plan D20）；展開後就地逐項列出 `列標題 · 欄位 · 規則 id`，不顯示原值；其中一項「也遮蔽操作者資訊（家目錄、使用者、主機名）」是今天 `scrubPii` 的同一個選項，移到這裡，且所有格式都支援。既有附件清單中無法遮蔽的附件標上「無法遮蔽」，可逐項取消（FR-054）。
- **FR-033** **目的地**：既有的目的地列（`:578-585`）成為一個選單：「資料夾」（今天的路徑與「變更」）＋本專案已啟用的 Exporter 擴充功能（076 FR-071）。選 Exporter 時格式固定為對齊列（076 FR-084），層級取自它的核准；包含與遮蔽的數字不變。沒有另一個上傳流程。
- **FR-034** 範圍選單的「目前檢視」維持匯出目前看到的範圍（DECISIONS §4）；包含區段的數字只算這個範圍內的列。
- **FR-035** 回答待確認、勾「這次包含」或改目的地，計畫立即重新解析（今天的 `resolveExportPlan`，`ExportMenu.tsx:252`），數字就地更新；回答寫的註記在匯出前就已上鏈，即使操作者最後沒有按匯出。
- **FR-036** 完成畫面（`:478-485`）多一行與包含區段相同的扣下摘要（`DeliverySummary` 的四個理由），與 manifest 一致。
- **FR-037** API 與 076 的 `redlog export` 沒有畫面，但取得同一個計畫：未指定時「這次包含範圍外」為否、待確認一律扣下；回應帶同一個 `DeliverySummary`。

#### E. 單一交付點與完整性（R5、R8）

- **FR-040** 只有一個模組產生離開本機的事件資料：`src/core/delivery/`。唯一入口 `deliver(request) → DeliveryStream`，產出 `DeliveredRow`（已遮蔽）或 `Stub`，最後產出 `DeliverySummary{withheld:{personal,outOfScope,unanswered,cleared}, includedOutOfScope, redacted, unredactable, reclassified, policyVersion, rulesDigest, scopeSnapshot, mappingsDigest}`。下列出口全部只經它：匯出計畫的預覽與執行（json、ndjson、timeline、bundle、HAR、CSV）、`/api/export/har`、`/api/export/bundle`、`GET /api/events`、`/api/events/search`、`/api/http-body/:sha`、`/api/terminal/replay`、076 的 `redlog last`／`redlog export`、L0 讀取 API、L2 面板的資料、Exporter 批次。舊的各條路徑刪除（tasks 刪除清單）。
- **FR-041** 計畫與執行一致：預覽的每個數字由同一個 `deliver` 在 worker 上算出；計畫的指紋涵蓋交付狀態摘要、對應快照與遮蔽替代值的雜湊；執行時不符即以 `policy-changed` 拒絕。
- **FR-042** **Bundle 格式**（`BUNDLE_VERSION = 5` 是唯一的版本；verifier 只理解它，其他一律 `UNSUPPORTED`）：
  1. `events.jsonl` 從交付範圍的第一個鏈位置到最後一個，每個位置是完整的列或 stub；stub 恰好四個欄位 `{"id","withheld","hash","prev_hash"}`，`withheld` ∈ {`personal`,`out-of-scope`,`unanswered`,`cleared`}。stub 不帶時間、種類、家族、操作者、目標或任何 `data`（plan D8）。
  2. `evidence.kind` 只有 `complete-chain`（鏈的第一列到 head）與 `window`（連續的一段；manifest 寫 `window.firstPrevHash` 與它在來源鏈中的位置）；兩者都逐一檢查連結。
  3. manifest 有 `withheld:{chained:{…四個理由}, logged:{…}}`、`includedOutOfScope`、`redacted:{rows, policyVersion}`、`unredactable:[{path, reason}]`，沒有 `sanitized`、`sanitizedOutOfScope`、`personalDropped`、`doNotExportDropped`、`transformedEventIds`。
  4. seal 另外承諾 `withheld` 的計數與 stub id 清單的雜湊。
  5. logged 層沒有鏈：被扣下的 logged 列不留 stub，只計數；`tiers.loggedDigest` 只涵蓋交付的 logged 列。
- **FR-043** verifier（`tools/redlog-verify.py` 與 `bundle-verify.ts`，規則在 `evidence-rules.ts`）對 stub：檢查 `prev_hash` 連續、不重算雜湊、不檢查簽章；stub 的雜湊由下一列的 `prev_hash`（及其簽章）證明，最後一個位置由 seal 的 `headHash` 證明。輸出一行 `N rows withheld by the operator (personal a, out-of-scope b, unanswered c, content cleared d)`；計數與 manifest、seal 不符為失敗。扣下本身不改變結束碼。
- **FR-044** app 內驗證（`verifyChainFullAsync`、證據頁）對**清除**過的列套用同一規則；其他理由的列在專案資料庫中不是 stub，照常完整驗證。
- **FR-045** 沒有鏈的格式各帶明確的扣下計數：JSON 的頂層 `delivery`（`DeliverySummary`）；NDJSON 的最後一行 `{"_delivery": …}`；CSV（076 對齊列）的最後一列 `kind = "redlog:delivery"`、`result = "personal=a;out-of-scope=b;unanswered=c;cleared=d;redacted=e"`；HAR 的 `log.comment` 加 `log._redlog.delivery`；API 讀取回應的 `excluded`（076 FR-091 的「排除 N 筆」即此）；Exporter 的 `system:export_shipped` 加 `withheld`。
- **FR-046** 附件跟著列：截圖、artifact 跟著它的列；http body 跟著引用它的交付列；cast 分段與 AI 原始 transcript 只要涵蓋任何被扣下的列就整檔不附，宣告於 `omittedAttachments`，理由 `contains-withheld`，不能勾回（plan D13）。

#### F. 遮蔽（R5；DECISIONS §5）

- **FR-050** 一個引擎、一組規則：`src/core/delivery/redact.ts` 的 `redactForDelivery(row, policy) → {data, replacements[], unredactable[], hits[]}`。規則集 = `secret-patterns.ts` 的形狀＋結構規則（header `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`x-*-key`、`x-*-token`；cookie 值；URL query 值；表單欄位值；JSON 葉；指令列的 `-p<值>`、`--password[= ]<值>`、URL userinfo）＋十六進位規則（長度 ≥ 32 且有上下文關鍵字）＋操作者 denylist（073 機器層）＋**本專案 loot 偵測到的值**＋選用的操作者 PII（家目錄、使用者名、主機名）。`policyVersion` = 規則集正規化後 sha256 的前 12 碼。
- **FR-051** 交付時以**目前**政策對每個交付列的每個字串葉重掃（依 072 的欄位形狀，sidecar 一併讀出）；寫入時算的 `data.redactions` 不是交付的依據。
- **FR-052** 替代值是 `[REDACTED:<規則 id>]`（封閉清單：`bearer`、`cookie`、`query`、`password-flag`、`hex-key`、`loot`、`denylist`、`pii` 等）；不保留原值長度或前後綴。
- **FR-053** 有任何替代時，在交付快照之後、seal 之前寫一列上鏈的 `system:redacted{exportId, policyVersion, replacements:[{event, field, sha256}]}`；遮蔽後的 body 以 `http-bodies/<原 sha>.redacted` 附上並列在同一列。verifier 對被遮蔽的列：連結照 FR-043 檢查，不重算雜湊，交付的欄位位元組雜湊必須等於該列中的值；報告 `N rows redacted by policy <版本>; their content cannot be checked against the chain`。可證明的是「這一列存在、在這個位置、沒被換成別的列、交付的替代值是匯出當時宣告的」；不能證明未遮蔽的欄位等於原文（plan D9）。
- **FR-054** 無法遮蔽的（截圖、cast、二進位 body、artifact、AI 原始 transcript）從不被稱為「已遮蔽」：列入 `unredactable`，預設附上並在「無法遮蔽 M」中逐項可取消。
- **FR-055** 報告 11 的 18 條路徑歸併（逐條見 plan「18 條路徑的去向」）：交付端的 P9–P16、P18 由 FR-040／FR-050 取代並刪除；寫入端的 P1、P2、P3、P7、P8 改呼叫同一引擎的 `scanWrite`；P4、P5、P6 不改（Assumptions）；P17 由 FR-007 與 G 段處理。I1–I12 各對應一個測試。

#### G. 清除內容（R4、R11）

- **FR-060** 「清除內容」是活動紀錄與閱讀器右鍵選單中的破壞性動作（UIUX 危險操作的最高一級：輸入確認），作用於選取的列；沒有批次的「清除全部私人」，也沒有終端機指令。
- **FR-061** 一次清除在一個交易內（`PRAGMA secure_delete=ON`）處理只屬於被清除列的儲存（plan「清除的範圍」逐項附程式位置）：chained 列的 `data` 換成 `{"_content_cleared":"<清除紀錄 id>"}`；logged 列刪除；`events_fts`／`events_logged_fts` 以 rowid 刪除；只被清除列引用的 `http-bodies/*.body` 與 `http-body-index.db` 的索引；截圖檔；artifact 檔；涵蓋被清除列的 cast 分段與 `cast-index.db` 項；涵蓋被清除列的 AI transcript 副本與 `ai-raw` 索引；推導列（`_causes` 指向它者）同樣清除；`event_notes` 中它的註解；`derived.db` 中它的投影；`~/.redlog/pending` 中含該事件 id 的交接檔、`.bad`、`.unattributed` 與 071 的隔離檔；`raw/` 中的對應位元組。之後 `wal_checkpoint(TRUNCATE)`；`VACUUM` 是對話框中的選項，預設不勾。
- **FR-062** `no_update_events_hash` trigger：只有當 `content_clear_authorized` 表中有該列 id、且新的 `data` 恰好是 `{"_content_cleared":…}` 時才允許更新 `data`；其他欄位（含 `hash`、`prev_hash`、`signature`）仍不可改。該表只在清除交易中寫入並在同一交易中刪空。
- **FR-063** 清除寫一列上鏈的 `system:content_cleared{event_ids, original_hashes, cleared:{bodies, casts, screenshots, artifacts, transcripts, derived, spool}, vacuum}`，與被清除列的更新同一交易、在其之前。
- **FR-064** 驗證：app 內「N 列的內容已由操作者清除」；bundle 中清除的列一律是 stub（`cleared`）。清除的列的雜湊仍在鏈中：「這裡曾有一列」永遠可證明，內容永遠不可證明。
- **FR-065** 確認對話框以最少的文字列出無法保證的：已匯出或已上傳的副本、備份與快照、SSD 的區塊重映射、其他程式自己的紀錄（shell history、AI 工具的 transcript）、剪貼簿；以及連帶失去的：同一 cast 分段中其他列的回放、同一 AI transcript 副本。

#### H. 擴充功能的讀取（R5；076 L0／L2、Exporter）

- **FR-070** 076 的 L0 讀取 API、L2 面板的資料、Exporter 批次全部經 `deliver`，參數 `delivery:'deliver'`；擴充功能拿不到 `operator` 讀取。
- **FR-071** 被扣下的列在任何層級都不回傳，除非 manifest 的 `reads.withheld` 明確列出理由（`out-of-scope`、`unanswered`、`personal`）且核准對話框點名它們；`cleared` 不能列出。**Exporter 的 `reads.withheld` 不得含 `personal`**，否則載入失敗（`withheld-personal-not-allowed`）。
- **FR-072** `command` 與 `content` 層級的每個回應都經 FR-050 的遮蔽，沒有退出選項；`meta` 層級的欄位也經遮蔽（主機名與 URL 可能帶 token）。
- **FR-073** 回應帶 `excluded`（FR-045）；076 的 `system:extension_read` 加上 `withheld` 計數。
- **FR-074** **076 Q4 的解鎖條件**：076 的 `command`／`content` 層級只在下列全部成立時可啟用——(a) 本規格 Phase 1 已合併，每個交付出口經 `deliver`，FR-091 在 CI 綠；(b) Phase 4 已合併，FR-092 在 L0 讀取與 Exporter 批次兩個出口上綠；(c) FR-090 為 0 違規。任一項為紅時，核心拒絕並回理由「匯出尚未套用遮蔽」（076 US10 情境 3）。

#### I. 不記錄（R3，次要、選用）

- **FR-080** 不記錄只有三種，全部選用：(a) 私人終端機（FR-014）；(b) 機器層規則 `action: skip`（FR-020）；(c) 遵循 shell 自己的歷史排除（FR-082）。沒有一種預設開啟，沒有一種需要操作者改變輸入方式。
- **FR-081** `skip` 規則在來源端評估：`command` 規則由 hook（app 寫出編譯後的 `~/.redlog/personal-skip.json`，0600，與 `command-class.json` 的 overlay 同一讀法）；`host` 規則由 mitmproxy addon 與接收端在 commit 前評估（內容不落盤）；`ai-path` 規則由 AI tailer 的 `excludedPaths`。每次略過用掉一個序號並計為 071 的有意遺失 `ignored-rule`。
- **FR-082** 「遵循 shell 歷史排除」是機器層布林 `personal.followShellHistory`，**預設關**（Q1）。開啟時：bash 的 `HISTCONTROL` 含 `ignorespace`／`ignoreboth` 時前導空白的行、`HISTIGNORE`；zsh 的 `HIST_IGNORE_SPACE`、`HISTORY_IGNORE`；PowerShell 不支援（PSReadLine 的 `AddToHistoryHandler` 是任意程式碼）。`ignoredups`、`HIST_IGNORE_DUPS`、`HistoryNoDuplicates` **永遠不被遵循**。略過計 `shell-history-rule`。
- **FR-083** 依規則略過的只有計數，出現在狀態讀數該來源的列（FR-018）。私人終端機不計數（計數本身會洩漏私人 pane 的活動量）。

#### J. Gate 與測試

- **FR-090** 單一出口 gate（`test/delivery/single-exit.test.ts`）：`src/**` 中寫出匯出檔、回應 API 讀取、交給擴充功能主機的模組，若讀取 `events`／`events_logged` 或 `http-bodies`，必須只經 `src/core/delivery/`；以 import 圖與呼叫點掃描，允許清單為空；另掃描作用於事件陣列的 `JSON.stringify(`。
- **FR-091** 「沒有出口能帶出被扣下的列」property test：fast-check 產生事件（每個登記的種類、兩層、含 sidecar）、註記、規則、範圍、對應；對每個出口執行；斷言被扣下列的每個 ≥ 4 字元的字串葉都不出現在輸出位元組中（含附件），stub 數等於 `withheld.chained`。
- **FR-092** 遮蔽 property test：同上的產生器，在任意字串葉植入 denylist 值、loot 值、各結構規則的 secret；斷言每個出口的輸出不含它們，預覽計數等於實際替代數。
- **FR-093** 突變檢查：逐一把 `deliver` 換成「略過狀態判斷」「略過遮蔽」「略過推導列承接」「把 `ask` 當 `deliver`」「忽略排除」，FR-091／092 必須失敗。
- **FR-094** 雙 verifier 共用向量（`test/evidence-vectors.test.ts`）涵蓋 US5、US6 情境 2、US10。
- **FR-095** 決策表測試涵蓋 FR-004、FR-021、FR-022、FR-102 的每一格；問題組測試涵蓋 FR-025 的每一條鍵。
- **FR-096** 清除後掃描（US10）。
- **FR-097** 已刪除機制的 gate：`do_not_export`、`personalDomains`、`isPersonalDomain`、`sanitized_events`、`redactEventForExport`、`subtype: 'sanitized'` 的寫入、`/api/sanitize` 在 `src/**`、`tools/**`、`hooks/**` 中出現 0 次（`verify:specs` 的 forbidden alias 機制）。

#### K. 名稱與位址（範圍分類的契約）

- **FR-100** 一個目標有兩面：**名稱**（DNS 名稱）與**位址**（IP）。每一種列各自的來源：
  | 列 | 名稱 | 位址 |
  |---|---|---|
  | 指令 | 參數中寫的字面值，若它是名稱 | 參數中寫的字面值，若它是位址 |
  | HTTP（代理擷取） | URL 主機／`Host` header／TLS SNI（三者不同時以 SNI 為準，並記錄不一致） | 連線的遠端位址（`server_conn.peername`），**只在代理直接連線時**；經上游代理或 SOCKS 樞紐時位址是那個代理的，記為未知 |
  | DNS（addon 的 DNS 模式） | `query_name` | `answers`（成為對應，FR-103） |
  | TCP（addon） | — | `_tcp_peer` |
  | 經樞紐的流量（解析在遠端） | 工具參數中的名稱 | 未知 |
  範圍項目同樣分為名稱型（網域、萬用字元）與位址型（IP、CIDR）。
- **FR-101** **比對規則**（取代 `classifyScope` 的單面比對；`classifyScope` 改為對兩面各分類一次）：
  1. 任一面明確排除，且另一面沒有明確在範圍內 → **範圍外**。
  2. 一面明確在範圍內、另一面明確排除 → **衝突 → 無法確認**（詢問，組鍵 `conflict:`）。
  3. 名稱在範圍內（不論位址）→ **範圍內**（名稱是操作者選擇的對象；CDN 或共用主機背後的位址服務他人不改變這點）。
  4. 位址在範圍內、名稱已知且不在範圍內也未排除 → **無法確認**（共用主機上的其他虛擬主機是典型的範圍陷阱；詢問，組鍵 `host:<名稱>`）。
  5. 位址在範圍內、名稱未知 → **範圍內**。
  6. 兩面都不在範圍內：只有當範圍中**有與該面同型的項目**時，那一面才能判「範圍外」；列只有位址而範圍只有名稱項目（或反之）時，先用對應（FR-103）換成另一面再比；沒有對應 → **無法確認**。
  7. 範圍沒有任何允許項目（`no-scope`）→ **無法確認**。
- **FR-102** 比對表（FR-101 的 7 條 × 名稱｛在內、排除、不在、未知｝× 位址｛同｝）在 plan D17 列出全部格；測試逐格斷言。
- **FR-103** **對應是有時間的紀錄事實**：`(名稱 → 位址, 觀察時間, 來源)`，來源為封閉清單：`observed-dns`（addon 的 `dns_response`）、`observed-http`（同一 HTTP 流的 SNI／Host 與 `server_conn.peername`，只在直接連線時）、`hosts-file`（FR-104）、`lookup`（FR-105）。分類一列時，用**早於該列時間、最接近的**對應；同一時間點 `observed-*` 與 `hosts-file` 優先於 `lookup`。用了對應的分類在閱讀器中標明「依 HH:MM 觀察到的對應」或「依 RedLog 查詢」（FR-016），從不靜默。TLS 憑證的 SAN 不是對應（共用憑證）。
- **FR-104** **hosts 檔**：在專案開著時讀 `/etc/hosts`（Windows 為 `%SystemRoot%\System32\drivers\etc\hosts`）一次並監看變更；只把**提到範圍項目的名稱或位址**的條目寫成上鏈的 `system:name_mapping{source:'hosts-file', name, addresses, at}`；其他條目不讀進來。它是操作者自己在本機宣告的對應，不產生任何網路流量。
- **FR-105** **RedLog 自己的查詢**（分析見 plan D18）：
  1. 只做**正向解析**，只對操作者**宣告在範圍內的名稱**（不含萬用字元的前綴部分；`*.x` 只查 `x`）；從不對觀察到的任意名稱、範圍外或排除的名稱查詢；從不做反向查詢。
  2. 時機：範圍項目加入時（開關開啟時）與操作者在範圍設定中按「重新解析」時；沒有週期查詢。
  3. 用系統解析器（`getaddrinfo`，與本機工具同一個 vantage，尊重 hosts 檔與 VPN 的分割 DNS），不指定外部解析器。
  4. 服從與出口檢查相同的離線開關：`network.offline` 為真時不查（`ip-signal-producer.ts:222` 的同一判斷）；分類退回觀察到的對應與詢問。
  5. 每次查詢寫一列上鏈的 `system:name_resolved{name, answers, resolver:'system', at, trigger:'scope-added'|'operator'}`，讓 RedLog 自己的流量可被解釋。
  6. 查詢得到的對應來源為 `lookup`；與觀察到的對應不一致時，觀察到的勝，閱讀器與目標頁顯示兩者。
  7. 機器層開關 `network.resolveScopeNames`；不在離線時的預設值為 Q5。
- **FR-106** 對應改變（重新解析、DHCP、輪替）只影響它之後的列；先前的列用它們當時最接近的對應。一列已交付後若因晚到的事實（例如延遲送達的 DNS 列）而分類改變，下一次匯出的對話框寫「分類改變 k」並逐組列出，manifest 記 `reclassified`；從不靜默重新分類已交付的列。
- **FR-107** 歸屬：本段的分類契約屬本規格（交付依賴它）；`classifyScope`、目標擷取、addon 與目標頁的改動以 tasks 列出（T060–T068），目標頁與交付讀同一個 `classifyTarget(name?, address?, at, scope, mappings)`。

### Key Entities

- **交付狀態**：`deliver`／`withhold`／`ask`＋理由（FR-001）。
- **交付註記**：`system:delivery_mark`（FR-002）。
- **選擇器**：FR-003。
- **私人規則**：機器層，`withhold`／`skip`（FR-020）。
- **交付規則**：專案層，`deliver`（FR-023）。
- **確定的目標**：FR-022。
- **範圍關係**：FR-021、FR-101。
- **對應**：`system:name_mapping`、`system:name_resolved`、`dns_response`（FR-103–105）。
- **問題組**：FR-025。
- **交付點**：`src/core/delivery/` 的 `deliver`（FR-040）。
- **Stub**：FR-042。
- **遮蔽政策**：FR-050。
- **清除紀錄**：`system:content_cleared`（FR-063）。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** 單一出口 gate 0 違規；FR-091 在每個出口、10,000 個產生案例下 0 次帶出被扣下的內容；FR-093 的突變全部被殺死。
- **SC-002** FR-092 在每個出口 0 次帶出植入的 secret；報告 11 的 I1–I12 各有一個測試且全綠。
- **SC-003** 問題數：在 `test/fixtures/delivery/` 的 2,000 列標註樣本（plan D15）上，第一次匯出需要的回答 ≤ 30；加 500 列後第二次 ≤ 10；依組回答後與標註不一致的列 ≤ 1%（20 列）。`scripts/measure-delivery-questions.mjs` 印出三個數字，CI 以 gate 執行。
- **SC-004** 扣下 40 列的 bundle 在兩個 verifier 上結束碼 0 並印出正確的理由數；FR-094 的每個竄改案例得到規定的結束碼。
- **SC-005** 預覽與位元組一致：e2e 匯出後對話框的每個數字等於 manifest 中對應的值。
- **SC-006** 清除後掃描：標記字串在臨時 home 中出現 0 次。
- **SC-007** 從決定「這列不交付」到完成：1 次選取＋1 個鍵；撤回同樣 2 步；不需要任何終端機指令。
- **SC-008** 沒有新增頁面、路由、對話框或設定頁；匯出面的主動作仍只有一個（快照測試）；新增介面字串每個語系 ≤ 24 個 key；`test/ui-copy.test.ts` 通過；固定篩選列快照不變。
- **SC-009** 076 的 `command`／`content` 層級在 FR-074 的三個條件之前無法啟用。
- **SC-010** `network.offline` 為真時，RedLog 為範圍分類發出的 DNS 查詢為 0（以注入的解析器計數）；為假且開關開啟時，每次查詢恰好一列 `system:name_resolved`。

## Assumptions

- 威脅模型沿用 071 與 076：同使用者的程序不在防護範圍內；交付邊界防的是「接收者拿到不該拿的」。
- **AI tailer 寫入前的破壞性遮罩（P4）本規格不改**；那是寫入路徑與證據語意的變更，需另行裁定。交付引擎照常重掃 AI 的已遮蔽文字。
- **寫入時的內容部分承諾**（敏感欄位外移、列上只留 `{sha256,size}`，使遮蔽後仍可完整驗證；報告 11 G.ii）屬 071 的列格式，本規格不定。
- 交付註記、規則變更、對應紀錄由主行程的寫入者經 071 的單一入口寫入；操作者憑證需要能力 `append(delivery_mark)`；`agent-tools`、`plugin:*`、`remote:*`、hook 的憑證沒有它。
- mitmproxy 在直接連線時 `server_conn.peername` 可取得（`_tcp_peer` 已用它；HTTP 流是否同樣可靠：UNCONFIRMED，tasks T062 確認）。
- `getaddrinfo` 不告訴呼叫者實際用了哪個解析器；紀錄寫 `resolver:'system'`，不宣稱更多。
- 截圖依視窗排除、addon 端 host 丟棄的實機效果需要實機驗證。
- `shortcuts.ts` 尚未查證 `p` 是否已被佔用（plan UNCONFIRMED）。

## 不在範圍

- 報告產生、發現管理（產品不做）；收回已交付的資料；多人或中央架構；靜態加密。
- AI 寫入前遮蔽的取消；寫入時的內容部分承諾（Assumptions）。
- 截圖依視窗排除、剪貼簿自動清除、HUD 的內容保護、air-gap 即時生效、刪除專案的殘留清理（報告 11 G.vi、F）。
- 在私人終端機中補錄指令（plan D12）。
- 反向查詢、為觀察到的任意名稱查詢（FR-105）。

## 與既有文件、程式註解、已驗證規格與兄弟規格的矛盾

| 位置 | 現在的說法 | 本規格 | 處置 |
|---|---|---|---|
| `redact-export.ts:6-11`、`TimelineEventInspector.tsx:483-484`、`Timeline.tsx:1661-1666`（報告 11 摘要 1） | 「單一出口」「layer 4 遮蔽一切離開的」 | 今天不成立；FR-040／050 才成立 | 註解隨模組刪除 |
| 根因審查 §4「Bundle 版本：較早版本照舊驗證」 | verifier 讀舊版 | R8：只有一個版本 | 記錄即可 |
| 根因審查 §4 晚間「標為私人（收合、不索引、不匯出）」 | 不索引 | 讀取時排除；token 只由清除內容移除（FR-007） | Q2 |
| 報告 11「擷取邊界」§3 與問題 4（四值相關性 overlay、`privacy:mark`、匯出預設「已確認＋綁定來源的未知」） | 推測的相關性 | R7：範圍決定；分組詢問；`system:delivery_mark` | 記錄即可 |
| `classifyScope`（`scope-evaluator.ts:229-259`） | 單面比對；`no-scope` 的 distance 為 `in_scope` | FR-101：兩面、`no-scope` 為無法確認 | tasks T060 |
| `target-extractor.ts:31,57-59` | `ssh -J` 取跳板；樞紐指令取樞紐主機 | FR-022：最終目的地；樞紐不是被包裝工具的目標 | tasks T061 |
| DECISIONS §5 #1「提供把這個 shell 設為私人的指令」；071 A6、FR-086、FR-087；073 B4；076 決定 11、US5、FR-043、FR-044、FR-050 | `redlog private` 終端機指令 | R11：只在 app 的綁定控制項（FR-014） | 由協調者修改（報告列出） |
| Spec 071 FR-130–134（遠端 hook） | 沒有限制安裝主機 | R12：只裝在操作者自己的主機 | 由協調者修改（報告列出） |
| Spec 072 FR-008 | 索引不依種類過濾 | 不衝突：排除在讀取時 | 記錄即可 |
| Spec 073 FR-01B `personalTraffic`；US4 情境 3 | 機器層的個人流量清單，匯出時排除 | `personal.rules[]`（`host`） | 073 需改寫（報告列出） |
| Spec 074 FR-032（`sanitized_events`、`do_not_export`）、FR-065 的「不匯出標記」topic | 兩表存在 | 刪除；topic 為 `delivery` | 指標已加 |
| Spec 076 FR-072（「不得匯出或私人」「個人流量規則」）、US9 情境 2 | 舊機制名 | 「交付狀態為 `deliver` 的列」（FR-070） | 指標已加 |
| Spec 076 FR-084 對齊列 | 沒有摘要列 | FR-045 的最後一列 | 076 契約 §7 需加 |
| Spec 071 FR-050 的有意遺失原因、FR-070 的能力表 | 沒有 `ignored-rule`、`shell-history-rule`、`append(delivery_mark)` | 需要 | 指標已加 |
| Spec 071 FR-091、075 FR-059 | span 是遮蔽依據 | span 仍可寫，交付不讀 | 記錄即可 |
| `docs/redaction-design.md` 四層模型 | layer 4 = sanitize | 交付點取代 | tasks |

## 開放問題（需要擁有者）

| # | 問題 | 建議 |
|---|---|---|
| Q1 | 「遵循 shell 歷史排除」預設開或關？ | **關**。Ubuntu 等預設 `HISTCONTROL=ignoreboth`，從筆記貼上的指令常帶前導空白；預設開會讓攻擊指令無聲地不被記錄，違反 R2。開啟是機器層一個開關 **已裁定（2026-11-13，DECISIONS §9）**：不適用：「不記錄」已暫緩（DECISIONS §8 第 6 項），重新排入時再答 |
| Q2 | 「不索引」：私人列要不要從全文索引實際移除？ | 不移除；讀取時排除（FR-007），實際移除只由清除內容。撤回時不需重建索引；「不被搜到」已達成；磁碟上不留內容是 R4 的工作 **已裁定（2026-11-13，DECISIONS §9）**：不移除，讀取時排除 |
| Q3 | `terminal-last` 承接的目標不算（FR-022），所以沒有目標的本機指令一律詢問。接受嗎？ | 接受。這是「只允許確定的承接」的直接結果；代價由分組（SC-003）吸收；O18 落地後自動改善 **已裁定（2026-11-13，DECISIONS §9）**：接受 |
| Q4 | 未回答就匯出時，待確認的列扣下還是交付？ | 扣下（stub `unanswered`），對話框寫數字，從不擋匯出。交付出去的無法收回，扣下的下一次可以補交 **已裁定（2026-11-13，DECISIONS §9）**：扣下 |
| Q5 | 不在離線時，RedLog 查詢範圍內名稱（FR-105）預設開或關？ | **關**；範圍設定中一個「解析範圍內的名稱」動作，按一次查一次。理由見 plan D18：加入範圍項目的時刻常早於 VPN 或樞紐就緒，系統解析器會把客戶的名稱（含內部名稱）送到當時的 ISP、公司或公用解析器；被動的對應（代理、DNS 模式、hosts 檔）在大多數行動中已足夠，不足時操作者明確按一次，且每次都上鏈 **已裁定（2026-11-13，DECISIONS §9）**：關 |

## Domain References

- `.specify/memory/constitution.md` I、II、III、VI、VIII、IX。
- `docs/domain/glossary.md`：本規格新增 Delivery State、Withheld、Stub、Delivery Mark、Personal Rule、Definite Target、Scope Relation、Name Mapping、Question Group、Redaction Policy、Content Cleared（tasks T090）。
- `docs/UIUX-STANDARD.md` §26（3、4、5）、§19。
- Spec 001、021、023、025、031–033、040、056、071–076。
