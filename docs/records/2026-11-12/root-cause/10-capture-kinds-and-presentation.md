# 10 · 擷取的種類與呈現：盤點、四角色模型的檢驗、整合設計（root-cause review）

基準：`wt-docs3`（= origin/main 加文件提交，HEAD `c2c11cfd`）。唯讀審查：沒有啟動 app、沒有跑測試、沒有讀任何真實專案的資料庫。以下「已確認」都是**讀程式碼**確認；凡需要實際執行或實際資料量才能確認的，標 **UNCONFIRMED** 並在文末列出確認步驟。
脈絡：根因審查 §4 的決定（未登記種類預設 logged、heartbeat 不是事件、`target_via`、終端暫停可恢復）與工作計畫的階段 0–7 視為既定；03（讀取模型）、04（來源狀態）、08（外掛）、09（多重性）已報的機制不重報，只在本題的角度引用。

## 摘要（10 行）

1. 程式能寫入的種類（`agent_type × subtype`）約 **130 個**（依 grep 與 adapter 對照表逐一計，含可變 subtype 的族以實際取值估），分屬 17 個 `agent_type`；其中 **29 個**只以原始字串標題或 JSON 呈現，**13 處**呈現方式與種類的本質矛盾（區間畫成點、狀態畫成事件、結果沒有它的動作、記錄本身的事實看起來像資料）。
2. 機制只有一個：**「種類」沒有定義處**。同一個種類的意義散在 **28 張**各自獨立的對照表（tier、暫停豁免、外部可寫、目標回填、配對、Activity 分組、Activity 動作、泳道、標題、閱讀器、內務、證據、徽章、匯出計數…），新增一個種類時要記得改的地方沒有任何東西提醒，所以每個新來源都落在 fallback。
3. 最傷的一例在輸出完整性：relay 明確寫出 `completeness: metadata-only / output_disposition: not-captured | redirected`，閱讀器卻**不讀這兩個欄位**，只看 `stdout` 是不是字串，於是顯示「未產生內容。」（`content-contract.ts:137-146`、`redlog-relay.py:556-566,983`）。「沒記到」被說成「沒有輸出」。
4. 第二例在歸屬：HTTP／DNS／連線要歸到指令，需要 process monitor 提供的父行程鏈，而它預設關閉；預設情況下這條路徑**一筆都歸屬不到**（`socket-attribution.ts:20-40,188-199`）。而且開啟後，鍵是 shell 的 `$$` 對「最近一個 command_start」，背景工作的流量會被歸到後來的指令——與該檔「must never GUESS」的註解相反。
5. 第三例在狀態：暫停帶與終端帶是從**已載入、已套用篩選**的列推出來的（`timelineIncremental.ts:473-486`），換頁或篩掉 `system` 就消失；開著的終端在 `session_end` 前沒有帶。IP、目標、proxy、pivot 這些狀態只以點事件出現。
6. 四角色模型（action／effect／state／record-fact）方向正確，但有三處錯：動作本身是**區間**而不是點；「effect 找不到 cause 就標 origin-unknown」對操作者親手用瀏覽器發出的請求是錯的（它沒有 cause，因為它就是動作）；推導出來的結論（戰利品、範圍觀測、pivot、清理、憑證使用）與操作者的標記不是 effect，需要第五個角色 **annotation**。
7. 建議的最小修正：五個角色 + 三種邊（`caused` 已證明、`candidate` 線索、`contains` 容器）+ record-fact 帶「適用區間」；角色是種類的**預設**，個別列因有無邊而落位。
8. 整合：一份資料化的 `src/core/event-kinds.ts`（純資料，main 與 renderer 共用），先取代純呈現的表（標題、泳道、閱讀器、Activity 動作），行為表（tier、外部可寫）等階段 1／4 的信封一起動；gate 用「寫入端字面值掃描 + adapter 輸出列舉」對註冊表雙向比對。
9. 區間不改既有列與雜湊：在階段 3 的查詢工作執行緒上加「區間投影」，對全專案而非已載入頁計算，開放區間明寫「未見結束」；「時間 T 的狀態」以每種狀態一條階梯函數二分搜尋回答。
10. 可在階段 1 之前先上、之後不必重做的三項：輸出完整性照實呈現、閱讀器依種類分派（含截圖在時間軸檢視器沒有圖）、移除死掉的呈現與錯名的泳道。

---

## A. 盤點

### A.1 寫入端（每列一個種類族；`*` 表示同族多個 subtype）

欄位：產生者（file:line）／預設狀態／tier（誰決定）／形狀（點 P、區間的開始 S、結束 E、片段 C、資料內帶區間 I）／附件／`_causes`／target／terminal id。tier 一律由 `classifyTier`（`src/core/db/event-write.ts:45-106`）的 `LOGGED_TIER` 決定，不在表上即 chained。

| 種類 | 產生者 | 預設 | tier | 形狀 | 附件 | cause | target | tid |
|---|---|---|---|---|---|---|---|---|
| `shell:command_start` | `shell-common.sh:959`、`shell-zsh-hook.zsh:473`、`shell-bash-hook.sh:443,582`、`shell-hook.ps1:192,270`、`redlog-send.*` | 需裝 hook | chained | S（`command_id`） | — | — | 指令抽取或全域目前目標回填（`ingest.ts:71,255-259`） | 有 |
| `shell:command_end` | 同上 + relay `redlog-relay.py:563,1012`；`powershell-transcript.ts:178`（Windows pack） | 需 hook | chained | E；資料內含 `duration_sec` | inline stdout/stderr、`stdout_ref`（body store）、內建終端 `io` 指向 cast | lifecycle（`causes-resolver.ts:149-185`） | 同上 | 有 |
| `shell:command_output` | relay `redlog-relay.py:290`（late／streamed） | relay 時 | chained | C | — | `command_id`（`causes-resolver.ts:140-147`）；找不到標 `unattributed`（`ingest.ts:194`） | 沿用指令（`ingest.ts:233-237`） | 有 |
| `shell:session_start/session_output/session_end` | 內建終端 `terminal-manager.ts:171,272,548`；`redlog-session.py:105,132,173`（pty 模式） | 內建終端常在；pty 模式依 `command-class.json` | chained | S／C／E（`durationMs`） | cast（內建） | — | — | 有 |
| `shell:command_boundary` | `terminal-manager.ts:163,541` | 內建終端 | chained | E（補結束） | — | — | — | 有 |
| `shell:capture_stopped/capture_resumed` | `shell-zsh-hook.zsh:196,204`、`shell-bash-hook.sh:175,183` | `redlog stop/start` | chained | 每終端的暫停 S/E | — | — | — | 有 |
| `shell:wsl_test` | `hooks/wsl-redlog-test.sh:106` | 手動 | chained | P | — | — | — | — |
| `agent:user_message/assistant_message/thinking/tool_call/tool_result/tool_interrupted/compact_summary/away_summary/model_refusal/api_error` | adapter `optional-plugins/claude-code/adapter.ts:287-300`、`codex/adapter.ts:206-231`，經 `tailer-host.ts:846` | 需專案同意 AI 擷取 | `thinking` logged，其餘 chained | P（tool_call→tool_result 由 `operationPairKey` 配對） | transcript sidecar | 父 turn（tailer 的 uuid map） | 無 | 無（`session_id`） |
| `agent:transcript_*`（capture_started、compacted、parent_missing、schema_drift、snapshot、tool_gap）、`agent:session_end` | `tailer-host.ts:716,1000,1098,1131,1161,1179,1291,1434` | 同上 | chained | 多數為 record-fact；capture_started／session_end 是 AI session 的 S/E | — | — | — | — |
| `scanner:http_request_start/http_response/http_response_chunk/http_error/http_request_dropped/ws_message/websocket_end/tcp_message/tcp_end/cookie_change` | `hooks/mitmproxy-addon.py:1252-1976`；`plugins/transparent-proxy` | 受管 proxy 預設自動啟動（有 mitmdump 時） | 全部 logged | flow 是區間（`flow_id`），列是 S/E/C | body store、`body_fts` | response→request（`flow_id`）；request→指令只經 socket 歸屬 | host | 無 |
| `scanner:capture_gap` | addon spool `mitmproxy-addon.py:214,259`；`inflight-marker.ts:79-90` | 自動 | **chained**（不在表上） | I（`gap_started_at..gap_ended_at`） | — | — | — | — |
| `dns:dns_query/dns_response` | `mitmproxy-addon.py:1675,1725` | 受管 proxy | logged | P | — | socket 歸屬 | 名稱 | — |
| `scanner:connection/connection_end` | `connection-monitor.ts:203,216-223` | host-monitors pack，預設關（`plugins/pack-host-monitors/plugin.json`） | **chained** | S/E | — | socket（`connection-monitor.ts:215`） | remote addr | — |
| `scanner:packet_flow`、`scanner:pcap_segment` | `plugins/pcap-capture/pcap-parse.js:167`、`pcap-sidecar.js:24` | 外掛、需 sudo | **chained** | P；segment 指向檔案 | `.pcap` 檔留在擷取機上，只有 sha256 上鏈 | — | — | — |
| `pcap:connection_attempt/port_scan/connection_established/connection_refused/udp_flow` | `hooks/pcap-agent.py:167-241`（手動 sudo CLI，隨 app 打包在 `hooks/`） | 手動 | logged | P | — | — | dst ip | — |
| `scanner:c2_checkin/c2_task/c2_pivot` | `plugins/c2-tailers/parse.js:30-77` | 外掛、手動設定 | **chained** | P；`c2_pivot` 帶 open/closed 狀態 | — | — | host | — |
| `http_navigation:navigation`、`browser:console_*/exception/log_entry` | `cdp-connector.ts:176,280-381` | 只有從 RedLog 啟動的擷取瀏覽器 | navigation chained、console logged | P | — | navigation 經 socket 歸屬 | host | — |
| `screenshot` | `screenshot-agent.ts:275` | 手動／指令結束自動／標記觸發 | chained | P | PNG 檔 | 指令或 marker（`screenshot-agent.ts:287-289`） | 全域目前目標回填 | — |
| `marker`、`marker:amended` | `ipc/markers.ts:107`、`api-server.ts:517`、`marker-amend.ts:97`、`index.ts:455` | 操作者 | chained；暫停豁免 | P（可帶 `atTimestamp`，`timelineDomain.ts:94-98`） | — | — | 全域目前目標 | — |
| `loot:credential_detected` | `loot-detector.ts:251` | 自動 | chained | P | — | 來源列（`loot-detector.ts:266-269`） | 來源的 | — |
| `pivot:*`（tunnel_start、agent_connect、socks_up、port_forward、route_add、proxied、interactive、closed） | `ingest.ts:327-345` 由 `pivot-detector.ts:42-93` 推導 | 自動 | chained | 開／關以**指令文字**配對 | — | 來源指令 | via | — |
| `cleanup:*`（log_clear、history_clear、file_shred、timestomp、attr_hide） | `ingest.ts:335`，`technique-tagger.ts:17-75` | 自動 | chained | P | — | 來源指令 | — | — |
| `file_transfer:upload/download` | `ingest.ts:341` | 自動 | chained | P | — | 來源指令 | — | — |
| `file_transfer:artifact_added` | `ipc/artifacts.ts:35` | 操作者加入 | chained | P | 檔案副本 | — | 全域目前目標（`ingest.ts:256`） | — |
| `file_transfer:file_created/file_modified/file_deleted` | `file-watcher.ts:117-150` | pack，預設關 | chained | P | — | 只有 `related_commands` 候選（`causes-resolver.ts:188-208`），不進 `_causes` | — | — |
| `credential_use:*` | `ingest.ts:350-365` | 自動 | chained | P | — | 來源列 | host | — |
| `clipboard:clipboard_changed` | `clipboard-monitor.ts:78` | pack，預設關 | chained | P | — | — | — | — |
| `process:process_spawn/process_exit` | `process-monitor.ts:364,380` | pack，預設關 | logged | S/E（pid） | — | 無（`process-monitor.ts:354-359` 註明已移除） | — | — |
| `system:*` 約 45 個 subtype（暫停／恢復、session_start、config_changed、sanitized、retention 類、scope 類、ip_verdict、proxy 啟停、opsec、錨定、chain_sample_broken、capture_gap、logged_tier_digest、update_pending、active_target_changed、screenshot_deleted、process/connection monitor 飽和、`producer_heartbeat` 等） | `index.ts`、`retention.ts`、`sanitize.ts`、`alert/surface.ts:58-90`、`scope-recompute-run.ts`、`tailer-host.ts:962`、`ipc/target-context.ts:42`… | 自動 | chained（`process_monitor_*` 兩個 logged） | 多數是 record-fact 或狀態轉移的點 | — | `scope_violation`→來源列 | 部分 | — |

（`external` 與 `terminal` 兩個 agent type 允許外部寫入（`external-event-policy.ts:12-20`），本 repo 沒有產生者；`terminal` 是 redlog-cli 說明文字中的型別。）

### A.2 讀取端（每個種類被哪些畫面讀）

| 種類族 | 時間軸（泳道／標題／檢視器） | Activity | 其他頁 | 匯出 |
|---|---|---|---|---|
| shell 指令 | Shell 泳道；`command_start` 在配對的 end 到達後**隱藏**（`Timeline.tsx:178-180`），點畫在結束時間；`CommandEndDetail` | command 群組（`activity-projection.ts:19-21`） | 終端頁（內建）、Targets、逐字稿 | NDJSON、bundle（cast） |
| shell session／boundary／capture_stopped／wsl_test | 終端帶只取 `session_end`；其餘標題「Shell 事件」，檢視器**無內容**（`timelineEvents.ts:87-90` 對整個 shell 回 true，但只有 end/session 有分支） | 各自一個 event | 無 | NDJSON；`capture_stopped` 不進匯出摘要（`export-plan.ts:130` 只數全域暫停） |
| agent 訊息／工具 | AI 泳道；`AgentTurnDetail` | message／tool 群組；工具 `execute` 歸類為 command 動作（`activity-projection.ts:59`） | 逐字稿 | NDJSON、bundle（transcript） |
| agent `model_refusal/api_error/transcript_capture_started` | 標題原字串 `agent: model_refusal`（`eventTitle.ts:223`） | event | 無 | NDJSON |
| scanner HTTP | 「代理」泳道；`HttpDetail` | http 群組只收 `HTTP` 集合（`activity-projection.ts:9`），`tcp_*`、`cookie_change`、`http_request_dropped` 每列各自一個 Activity | HTTP 紀錄、搜尋（body_fts） | HAR、NDJSON、bundle |
| scanner 非 HTTP（connection、c2_*、packet_flow、pcap_segment、capture_gap） | 「代理」泳道；**全部套用 `HttpDetail`**（`TimelineEventInspector.tsx:437-439`）；c2/packet_flow/pcap_segment 標題 `[c2_checkin]` 無主機（`eventTitle.ts:148`） | network | 無 | NDJSON；pcap 檔不在 bundle（刻意，`pcap-sidecar.js` 註解） |
| `pcap:*` | 不在 `LANES` → 落到**系統**泳道（`timelineDomain.ts:150-157`），標題 `pcap: port_scan`（`eventTitle.ts:261`） | network（`activity-projection.ts:61`） | 無 | NDJSON |
| http_navigation | 名為「HTTP」的泳道（`timelineDomain.ts:123`）——真正的 HTTP 在「代理」泳道 | **other**（不在 network 清單） | 不在 HTTP 紀錄 | NDJSON |
| screenshot | 截圖泳道；`hasSpecificEventDetail` 回 true 但檢視器**沒有截圖分支**（`TimelineEventInspector.tsx:413-449`）→ 沒有圖也沒有通用閱讀器 | evidence | 截圖頁 | bundle |
| marker | 標記列；`MarkerDetail` | evidence | 逐字稿、HUD | NDJSON |
| loot | 戰利品泳道 | evidence | 戰利品頁、側欄徽章、狀態列 | NDJSON |
| pivot | 泳道 + HUD（30 分鐘視窗，`active-pivots.ts:24-58`） | **other** | 儀表板、HUD | NDJSON |
| file_transfer（含 `artifact_added`） | 檔案泳道；artifact 有 `EvidenceFileDetail` | **other**（清單寫的是 `file`、`artifact`，都沒有寫入者） | 證據頁 | bundle（artifact） |
| credential_use、cleanup | 各自泳道 | other／system | 無 | NDJSON |
| system scope_violation | 移到「範圍」泳道（`timelineDomain.ts:150`） | security | 目標與範圍、狀態列 | NDJSON |
| system 其餘 | 系統泳道；約 10 個 subtype 標題為「系統事件：<subtype>」（`eventTitle.ts:259`）；暫停帶 | system | 儀表板、狀態列計數 | NDJSON、bundle 摘要 |

### A.3 清單 (1)：擷取了卻從未呈現，或只以原始字串／JSON 呈現 — **29 個種類**

依 `eventTitle` fallback（`eventTitle.ts:72,223,259,261`）與 `hasSpecificEventDetail`（`timelineEvents.ts:87-96`）逐一核對：

- `pcap:*` 5 個；`scanner:packet_flow`、`scanner:pcap_segment`；`scanner:c2_checkin/c2_task/c2_pivot` 3 個（c2 外掛寫成 `scanner`，專為它準備的 `c2_checkin` 泳道與 `c2Beacon` 標題永遠用不到）。
- `shell:capture_stopped/capture_resumed`、一般 `shell:command_boundary`、`shell:wsl_test`：「Shell 事件」，檢視器空白。
- `agent:model_refusal/api_error/transcript_capture_started`。
- `system:capture_gap`（AI tailer 的暫停缺口，無 `reason`）以及 `sanitized`、`update_pending`、`retention_pruned_logged`、`bookmarks_pruned`、`body_evicted`、`logged_tier_digest`、`producer_heartbeat`、`process_monitor_saturated`、`process_monitor_ps_unavailable`、`active_target_changed`：「系統事件：<subtype>」。

最重要的五個：**`pcap:*`／`scanner:packet_flow`**（同一類證據兩種形狀、兩種 tier、兩個泳道，見 B）、**`shell:capture_stopped`**（每終端的暫停，看起來像資料）、**`system:capture_gap`（AI）**、**`scanner:c2_*`**、**`sanitized`／`retention_*`**（改寫或刪除了記錄的事實，只有原始 subtype 名）。

### A.4 清單 (2)：呈現方式與本質矛盾 — **13 處**

| # | 矛盾 | 證據 |
|---|---|---|
| 1 | **輸出「沒記到／被重導」顯示成「未產生內容」**；時間軸點上也沒有「未捕獲」缺角 | `content-contract.ts:137-146` 不讀 `completeness`／`output_disposition`；relay 在 metadata-only 與 redirected 時送 `stdout: ""`（`redlog-relay.py:556-570,983-1001`）；`ioMark` 對空字串回 `io: null`（`timelineDomain.ts:209-213`）；字串 `content.empty`「未產生內容。」 |
| 2 | **指令是區間，畫成結束時刻的一個點**；它造成的流量畫在它「之前」 | `Timeline.tsx:178-180` 隱藏已配對的 start；沒有任何 duration 繪製 |
| 3 | **狀態帶由已載入、已篩選的列推得**：換頁、篩掉系統、搜尋都會讓暫停帶消失；開著的終端沒有帶 | `timelineIncremental.ts:473-486`、`timelineSessionBands.ts:41-56`；`rawEvents` 已套共用篩選（`Timeline.tsx:160-166`） |
| 4 | IP／VPN、目前目標、opsec、proxy 啟停都是**狀態**，只以點事件出現在系統泳道 | `alert/surface.ts:82`、`ipc/target-context.ts:42`、`index.ts:200,982` |
| 5 | Pivot 的開／關以**指令文字**配對，結束不明時以 30 分鐘猜測，HUD 呈現為目前有效 | `active-pivots.ts:24-58`；`c2_pivot` 的 open/closed 不被讀 |
| 6 | **流量沒有它的動作**：預設歸屬率為 0（見 D.3）；檢視器的「效應」清單只算已載入列，〈只看上鏈〉時 HTTP 效應全部消失而計數不說 | `Timeline.tsx:963`（`effectsIndex` 對 `events`）；HTTP 為 logged |
| 7 | `capture_gap` 帶有起訖時間，畫成寫入時刻的一個點；且同一件事（HTTP 遺失）分在「代理」與「系統」兩個泳道 | `inflight-marker.ts:79-90`（scanner）、`unsaved-gap.ts:52-60`（system） |
| 8 | 連線監控、C2、pcap 外掛的列放在名為「代理」的泳道，用 HTTP 檢視器打開 | `timelineDomain.ts:16,124`、`TimelineEventInspector.tsx:437` |
| 9 | 截圖在時間軸檢視器**沒有圖**，也被擋在通用閱讀器之外 | `timelineEvents.ts:89` vs `TimelineEventInspector.tsx:413-449` |
| 10 | 狀態列總數包含時間軸隱藏的內務列與 heartbeat——**計入總數卻打不開** | `StatusBar.tsx:397`（chained+logged 全數）vs `event-queries.ts:212-220` |
| 11 | 開專案的 `system:session_start` 被內務規則藏起，且沒有「關閉」紀錄：「app 沒開」與「沒有事件」無從區分；〈略過閒置〉把暫停、關閉、安靜一律壓縮成同一種空白 | `event-queries.ts:214`、`index.ts:1043`、`timelineTimeMap.ts:30-36` |
| 12 | 每終端的 `redlog stop` 是 record-fact，畫成「Shell 事件」點；匯出摘要只數全域暫停 | `export-plan.ts:130` |
| 13 | AI 工具 `execute` 在 Activity 被當成指令，但它跑出的流量與檔案永遠無法歸給它（沒有 shell 列可對、也沒有 pid） | `activity-projection.ts:59`；`socket-attribution.ts:188-199` 只對 shell 的 pid |

最重要的五個：#1、#6、#3、#2、#11。

### A.5 有讀取端、沒有寫入端（死的呈現）

- `c2_checkin` agent type：泳道（`timelineDomain.ts:16,30`）、標題 `c2Beacon`（`eventTitle.ts:179`）、`timelineSelection.ts`。
- `system:ip_transition`、`system:secret_revealed` 的標題（`eventTitle.ts:239,249`）；`index.ts:665` 註明 ip_transition 已不寫。
- `system:api_started`（`HOUSEKEEPING_SQL`，`event-queries.ts:214`；`capture-health.ts`）。
- `scanner:websocket_message`、`websocket_start`（`activity-projection.ts:9`；addon 的 `websocket_message` 是 hook 方法名，送出的 subtype 是 `ws_message`）。
- Activity 動作表的 `connection`、`artifact`、`file`、`alert`、`scope_violation` 五個 agent type（`activity-projection.ts:61-64`）。
- `event-registry.ts` 的外掛 `eventTypes`：機制完整，bundled 外掛沒有一個宣告（grep `plugins/*/plugin.json`）。
- `shell:command`（舊格式）在標題與內務規則仍被讀：屬舊專案相容，保留但應在註冊表標 `legacy`。

---

## B. 對照表

### B.1 清點：28 張表把「種類」對應到某件事

| # | 表 | 位置 | 對應到 |
|---|---|---|---|
| 1 | `LOGGED_TIER` | `event-write.ts:45` | tier |
| 2 | `PAUSE_EXEMPT_AGENT_TYPES` | `event-write.ts:380` | 暫停時是否寫入 |
| 3 | `delayedCapture` | `ingest.ts:162-163` | 恢復後的遲到內容是否丟棄 |
| 4 | `ACTIVE_TARGET_FALLBACK_TYPES` | `ingest.ts:71` | 是否回填全域目前目標 |
| 5 | `EXTERNAL_ALLOWED_AGENT_TYPES` | `external-event-policy.ts:12` | 外部可否寫入 |
| 6 | `resolveIncomingCauses`／`noteStartEvent` | `causes-resolver.ts:63-185` | 起訖配對、cause |
| 7 | `socketCausesFor` 的型別 | `socket-attribution.ts:189` | 是否嘗試行程歸屬 |
| 8 | `scopeSignalFor` | `alert/scope-signal.ts` | 是否做範圍判斷 |
| 9 | Activity 分組集合 SHELL/TOOLS/HTTP/MESSAGES | `activity-projection.ts:7-10` | Activity 群組 |
| 10 | `activityClassification` | `activity-projection.ts:59-64` | Activity 動作篩選 |
| 11 | `TOOL_ACTIONS` | `activity-projection.ts:36` | 工具動作 |
| 12 | `LANES`／`BANDS`／`toLane` | `timelineDomain.ts:16-157` | 泳道、帶 |
| 13 | `LANE_LABEL_KEYS` | `timelineDomain.ts:120` | 泳道名，也是共用篩選的類型名 |
| 14 | 外掛 `eventTypes` | `event-registry.ts` | 外掛的標籤／泳道 |
| 15 | `eventTitle` | `eventTitle.ts:54-262` | 一行標題（也是搜尋用的英文標題） |
| 16 | `SearchPanel` 的標題 | `SearchPanel.tsx:29` | 搜尋結果標題（第二份） |
| 17 | `hasSpecificEventDetail` + 檢視器分支 | `timelineEvents.ts:87`、`TimelineEventInspector.tsx:413-480` | 閱讀器 |
| 18 | `HOUSEKEEPING_SQL` | `event-queries.ts:212` | 時間軸是否顯示 |
| 19 | `EVIDENCE_SQL` + `isEvidence` | `event-queries.ts:149`、`housekeeping.ts:28` | 是否算操作者的工作 |
| 20 | `computeBadges`／`dotShape`／`ioMark` | `timelineDomain.ts:198-290` | 徽章與點形 |
| 21 | `isBoundary` | `timelineIncremental.ts:481` | 狀態帶 |
| 22 | `timelineCard.ts` | 同檔 | 卡片摘要 |
| 23 | 逐字稿收哪些種類 | `TranscriptView.tsx` | 逐字稿 |
| 24 | 匯出計數（暫停、缺口、復原） | `export-plan.ts:119-180` | 匯出摘要 |
| 25 | 匯出附件 | `export-attachments.ts:126,153` | bundle 附件 |
| 26 | HTTP 匯出伴隨列 | `export-selection.ts:69-71` | HTTP 選取包含哪些列 |
| 27 | do-not-export 串連 | `db/do-not-export.ts:21-42` | 不匯出的延伸 |
| 28 | capture-health 的來源型別 | `capture-health.ts:527` 等 | 來源「最近收到」 |

### B.2 同一種類在不同表上的分歧（★＝操作者看得到）

- ★ **pcap**：CLI 版 `pcap:*` 為 logged、系統泳道、Activity「network」；外掛版 `scanner:packet_flow` 為 chained、「代理」泳道、HTTP 檢視器。同一類事實，兩個 tier、兩個泳道、兩種閱讀器（08 已指出兩種形狀，這裡補上呈現面）。100k 筆 packet_flow 會進雜湊鏈（UNCONFIRMED 量測）。
- ★ **連線**：`scanner:connection` chained，`pcap:connection_established` logged；前者在「代理」泳道。
- ★ **`capture_gap`**：scanner（chained、代理泳道、有專屬標題）與 system（AI 版無標題）。
- ★ **file_transfer／artifact_added**：時間軸放在「artifacts」帶（`timelineDomain.ts:31`），Activity 卻歸「other」；`evidence` 動作篩不到操作者自己加入的檔案。
- ★ **http_navigation**：時間軸泳道名「HTTP」，Activity「other」，不在 HTTP 紀錄；真正的 HTTP 叫「代理」。
- ★ **pivot**：時間軸有泳道、HUD 有節點，Activity「other」。
- **credential_use**：在 ingest 由 RedLog 推導（`ingest.ts:350-365`），卻在外部可寫清單上；同為推導的 loot／pivot／cleanup 則被拒絕（`external-event-policy.ts:4-8` 的理由同樣適用）。
- **內務規則兩份**：`HOUSEKEEPING_SQL` 多了 `tlogger_prompt_command` 與 `Microsoft.PowerShell_profile.ps1` 兩個樣式，`EVIDENCE_SQL`／`isEvidence` 沒有 → 載入 PowerShell profile 的那一行在時間軸被藏起來，卻會讓「首次使用」判定已有證據。
- ★ **共用篩選的「類型」**以 raw `agent_type` 篩（`FilterContext.tsx:130,199`），時間軸以 `toLane` 分泳道：篩 `system` 也會連帶 scope 泳道；`pcap` 在下拉選單以原字串出現。
- **暫停**：全域暫停豁免 `system`、`marker`；每終端的 `capture_stopped` 自身是 shell 列，全域暫停時會被丟掉，所以「哪個終端在何時停了」在全域暫停期間不留紀錄。

結論：分歧不是個別錯字，而是「沒有一個地方說這個種類是什麼」的直接結果。每一張表都對，合起來就互相矛盾。

---

## C. 四角色模型的檢驗

### C.1 指派

| 角色 | 種類 |
|---|---|
| action | shell 指令（start/end/output 為同一動作的三部分）、AI `tool_call/tool_result`、marker（操作者動作）、手動截圖、`artifact_added`、`redlog-session` 的 pty session |
| effect | HTTP flow、DNS、連線、pcap、process、file 變更、CDP navigation／console、自動截圖、`command_output` 中的背景輸出 |
| state | 終端 session、AI session、全域暫停、每終端暫停、IP／VPN、目前目標、proxy 啟停、opsec／air-gap、pivot 存續、「app 有沒有開」 |
| record-fact | capture_gap、sanitized、retention／eviction、config_changed、錨定、chain_sample_broken、logged_tier_digest、transcript_schema_drift／tool_gap／parent_missing、schema 漂移 |

### C.2 不合的地方

1. **動作是區間**。`nmap` 跑一小時，它的 pcap 與 HTTP 都落在動作「之內」。把動作當點（今天的做法，A.4 #2）讓 effect 跑到動作前面。模型要說：action 有起訖、可能開放（未結束）。
2. **操作者親手在瀏覽器發的請求不是「找不到 cause 的 effect」**。它沒有上游，因為它本身就是操作者的動作，只是經由一個 client。標成「來源不明」是錯的陳述，與 `socket-attribution.ts:38-41`「wrong edge is a false claim」同一個原則的反面：缺邊不是證據不足的 effect，而是「沒有被觀察到的上游」。應該寫出**它來自哪個 client／來源**（擷取瀏覽器、透明 proxy、外部終端），而不是「不明」。
3. **AI 工具呼叫執行指令**：一個動作，不是兩個。它的上層是 AI 的那一輪（意圖），所以需要 `contains` 關係（AI session → turn → tool_call），不是第二個 action。今天 Activity 把它算成 command，時間軸放在 AI 泳道，兩邊都只對一半。
4. **長時間互動 session（ssh、內建終端、`docker exec -it`）**：同時是狀態（「我在哪台機器上」）與容器（裡面的指令只在 cast 裡）。它是 `contains` 其他動作的區間；遠端指令沒有 hook 時只能指向 cast 片段。
5. **截圖**：手動是動作，指令結束自動拍是 effect，標記觸發是附屬於標記的附件。同一 `agent_type`，角色依觸發者而定 → 角色是**預設值**，由列上的 `trigger`／邊決定。
6. **戰利品、範圍觀測、pivot、cleanup、credential_use、technique**：都是 RedLog 依規則從**另一列**算出來的結論，不是世界上發生的 effect。它們應附著在來源列上（徽章），而且要記錄是哪一版規則（08-F6 已指出未記錄）。把它們畫成與指令並列的點，會讓一條 `ssh -D` 指令在時間軸上看起來像兩件事。→ 需要第五個角色 **annotation**。
7. **marker／note**：操作者寫的註記，可被 `amended`。是 annotation（人工層），不是 action；Ghostwriter 的教訓（PRIOR-ART-C §4.1）是機器欄位與人工欄位不能混在同一列。手動「記下這個」的那一刻仍可視為操作者的動作，但閱讀上它是對某時刻或某列的註解。
8. **file_created 的 `related_commands`**：是**候選**，不是 cause。模型只有「有 cause／沒有」兩態，會逼人把候選升級成 cause 或丟掉。需要第二種邊。
9. **record-fact 有「適用區間」**：retention 在 T2 刪掉 [a,b] 的內容；sanitize 改寫的是過去的列。只標在 T2 會讓讀 [a,b] 的人看不到「這裡被刪過」。
10. **heartbeat**：不是任何角色——已決定它不是事件（§4）。

### C.3 修正後的模型（最小變更）

五個角色：**action**（區間）、**effect**、**state**（區間，可開放）、**record-fact**（帶適用區間）、**annotation**（推導或人工，附著於一列或一個時刻）。三種邊：`caused`（由產生者或核心證明）、`candidate`（線索，永不升級）、`contains`（session／turn／指令包含其下）。角色是種類的預設；列的實際位置由邊決定：有 `caused`／`contains` 就掛在上游下面；沒有就以自己的**來源**名稱站在動作層，不加「不明」字樣。

外部參照（不預設操作者使用任何一個）：

- **OTel／Jaeger**：span 是區間、有 parent（= `contains`），span links 表示非樹狀因果（= `caused` 跨樹），span 內的 event 是點。三種關係分開，正是 C.2 #1、#3、#8 要的。
- **Zeek**：`conn.log` 是連線區間（狀態），`http.log`／`dns.log` 以 `uid` 掛在連線下；Wireshark 的 conversation 統計同理。對應 100k flow 的密度問題：先看會話、再展開封包。
- **瀏覽器 DevTools 效能面板**：多條 track，主執行緒的 task 是巢狀區間，網路請求在自己的 track 上畫成區間，user timing marks 是點。狀態與動作不同 track，但共用時間軸——就是 state band + action spine。
- **Timesketch／Velociraptor**：事件列平鋪，標籤、星號、註解另存（= annotation 不改機器列）。
- **asciinema markers**：標記是錄影中的點，不是錄影的一部分。
- **Burp／Caido／ZAP history**：流量是平坦的清單，scope 只過濾顯示——佐證「流量可以獨立站在動作層」與 E.6 的分離。
- **SIEM 時間軸**：缺口與資料來源中斷通常另外以「data gap／ingestion lag」呈現，不混在事件裡。

---

## D. 整合設計

### D.1 註冊表

位置：`src/core/event-kinds.ts`，純資料與純函式，main、preload、renderer 共用（與 `activity-contract.ts` 同一層）；外掛的種類由 manifest v2 宣告後經核心驗證併入（08 的 v2 manifest）。

```ts
interface EventKind {
  agentType: string; subtype: string | '*'
  role: 'action' | 'effect' | 'state' | 'record-fact' | 'annotation'
  shape: 'point' | 'start' | 'end' | 'chunk' | 'interval-in-data'
  pair?: 'command_id' | 'flow_id' | 'terminal' | 'session' | 'data-range'  // 起訖如何配對
  tier: 'chained' | 'logged'            // 只能鎖定既有值；新種類預設 logged（§4 決定）
  pauseExempt: boolean; externalWritable: boolean
  cause: 'lifecycle' | 'flow' | 'socket' | 'derived' | 'trigger' | 'none'
  target: 'own' | 'terminal-last' | 'active-fallback' | 'none'
  sidecar?: 'cast' | 'body' | 'image' | 'artifact' | 'pcap-external' | 'transcript' | 'raw'
  reader: 'command' | 'agent-turn' | 'http' | 'console' | 'image' | 'artifact' | 'marker' | 'gap' | 'state-change' | 'generic'
  family: 'commands' | 'traffic' | 'ai' | 'artifacts' | 'signals' | 'record'   // 取代 BANDS 與 Activity 動作
  labelKey: string; housekeeping?: boolean; legacy?: string   // legacy：最後寫入它的版本
}
```

先取代（只動呈現，不碰資料）：#15 `eventTitle` 的 fallback、#17 閱讀器分派、#12/#13 泳道與標籤、#10 Activity 動作、#21 狀態帶、#18/#19 內務規則（SQL 由註冊表產生，一份）。之後隨階段 1／4：#1 tier、#2 暫停、#5 外部可寫、#4 目標回填、#6/#7 cause。**不改任何既有種類的 tier**（`event-write.ts:96-99` 已說明 chained→logged 需要升版）；`scanner:packet_flow` 的 tier 問題用「新寫入改用新 subtype」解，不改舊列。

Gate（進 `verify:architecture` 同一層，或獨立 `verify:kinds`）：
1. 寫入端掃描：`src/`、`hooks/`、`plugins/`、`optional-plugins/` 的 subtype 字面值、`_redlog_send_event "<x>"`、`-Subtype '<x>'`、`_emit("<x>")`，以及兩個 adapter 的 `subtypeFor` 回傳值（可由單元測試列舉）——每個都必須在註冊表上，或在 allow-list 中標註「由外掛宣告」。本報告 A.1 用的就是這組 grep。
2. 反向：註冊表上每個非 `legacy` 種類都必須有寫入端；`legacy` 必須寫明版本。這會抓到 A.5 全部。
3. `reader: 'generic'` 必須明寫；沒有任何種類因為 fallback 而落到 generic。
4. 每個 `shape: 'start'` 必須有對應的 `end` 種類與 `pair`。

### D.2 區間：不改既有列與雜湊

在階段 3 的每專案查詢工作執行緒上加**區間投影**（衍生、不上鏈、可重建）：

`intervals(kind, key, start_id, end_id?, start_ts, end_ts?, end_basis)`，`end_basis ∈ observed | data-range | superseded | open`。

| 區間 | 來源列 | 結束不來時 |
|---|---|---|
| 指令 | `command_start`/`command_end` 以 `command_id`；沒有 id 時 `tid|pid|cmd`（同 `causes-resolver.ts:52-57`） | `open`；`command_boundary` 或終端結束時記 `superseded`，不寫成失敗 |
| 終端 session | `session_start`/`session_end`（內建）、`redlog-session` | `open`（今天完全不畫） |
| 全域暫停、每終端暫停 | `recording_paused/resumed`、`capture_stopped/resumed` | `open` |
| app／專案開著 | `system:session_start` → 下一個 `session_start` | 現在只能是 `open-until-next-open`；**新增**一個 `project_closed` record-fact（加法，不影響舊列）才能說「這段沒有在錄」 |
| HTTP flow | `flow_id` | `open`（今天 HTTP 紀錄已這樣做，見 `event-queries.ts:315-340`） |
| capture_gap | `gap_started_at/gap_ended_at`（資料內） | 不會開放 |
| IP／目標／proxy／opsec | 狀態轉移列做成階梯函數 | 最後一段延伸到現在或專案關閉 |
| pivot | `tunnel_start` … `closed` | `open`，呈現為「偵測於 T」而非「開著」（與 UX-005 一致） |

投影以 `(chainedMaxRowId, loggedMaxRowId)` 為游標增量推進（與 `ActivitySnapshot` 同形），計算對象是**整個專案**，與任何頁面的載入範圍或篩選無關——這直接消除 A.4 #3。

### D.3 「時間 T 的狀態」

每種狀態一條排序好的階梯陣列（`[ts, value]`），每終端的狀態（目前目標、`capture_stopped`、session）以 `terminalId` 分組。查詢：二分搜尋 O(log n)；一頁 200 列一次批次查詢。查詢工作執行緒要提供：(a) 投影的增量推進與「落後 N 筆」；(b) `stateAt(ts[], keys)` 批次 API；(c) 區間的範圍查詢（給時間軸畫帶）；(d) 每個動作的 effect **總數**（`GROUP BY cause`，不是已載入列）。

### D.4 cause 的實際覆蓋（從程式量）

| effect | 能否得到 `_causes` | 條件 |
|---|---|---|
| `command_end`／`command_output` → `command_start` | 能 | 同一個 app 行程內；記憶體 map 上限 1 萬（`causes-resolver.ts:5-26`）；**重開 app 後到達的 end 沒有 cause**（UNCONFIRMED 實測） |
| `http_response/http_error/http_request_dropped` → request | 能 | 同上，以 `flow_id` |
| `http_request_start`、`dns_*`、`navigation`、`connection` → 指令 | **預設不能** | 需 process-monitor 的 ppid（pack 預設關，`process-monitor.ts:254`）；macOS 上 socket 擁有者可能取不到（`socket-attribution.ts:36-38`）；`attributionBlind` 會在時間軸說出來（`Timeline.tsx:1343`），這是對的 |
| 同上，pack 開啟時 | 能，但**會猜錯** | `pidCmd` 以 shell 的 `$$` 為鍵、只 set 不清（`socket-attribution.ts:126-130`），背景工作 `ffuf … &` 之後再跑 `ls`，ffuf 的流量會沿父鏈找到 shell pid，對到 `ls`（UNCONFIRMED 實測；推理見程式） |
| `http_response_chunk/ws_message/tcp_*` | 無（以 `flow_id` 分組代替） | — |
| pivot、cleanup、file_transfer 上下傳、credential_use、loot、scope_violation | 永遠有 | 推導自來源列 |
| 自動截圖、標記觸發截圖 | 有 | `screenshot-agent.ts:287-289` |
| `file_created/modified` | 只有 `candidate` | `related_commands`（刻意，`causes-resolver.ts:186-187`） |
| `process_spawn/exit` | 無 | `process-monitor.ts:354-359` |
| AI `tool_call` 執行的指令所產生的一切 | **永遠不能** | 沒有 shell 列、沒有 pid |
| `pcap:*`、`packet_flow`、`c2_*`、clipboard | 無 | — |

### D.5 寫入契約（階段 1／4）該攜帶什麼，讓歸屬不再用猜的

- 產生者蓋章的信封（已決定）之外，effect 產生者送**它知道的端點事實**：socket 擁有者 pid、可得時的 ppid 鏈、本機埠、client 執行檔名；不送推論。
- Shell hook 在 `preexec` 為每個指令匯出 `REDLOG_COMMAND_ID`（子行程繼承）。有了它，process 觀察者（Linux `/proc/<pid>/environ`、macOS 同 UID 的 `KERN_PROCARGS2`）可以把 pid 對到確定的指令，取代「shell pid → 最近一個指令」。另一條不需要讀 env 的路：`preexec` 把 `HTTP(S)_PROXY` 設成帶 userinfo 的受管 proxy URL（`http://<terminal>:<command>@127.0.0.1:<port>`），proxy 從 `Proxy-Authorization` 得到終端與指令——對遵守 proxy 環境變數的工具是確定的（UNCONFIRMED：各工具是否保留 userinfo、mitmproxy 的 proxyauth 模式能否只讀不擋）。
- 每列帶 `target_via ∈ command-arg | terminal-last | producer | flow-host | active-global | none`（已決定方向），呈現端據此決定是否顯示「推測」。
- AI adapter 對 `execute` 類工具送出它能取得的子行程資訊（多半沒有）；沒有就明確送 `cause_capability: none`，讓呈現端不去猜。
- record-fact 送 `applies_from/applies_to`。

---

## E. 呈現設計（文字）

### E.1 時間軸

- **骨幹（action）**：動作畫成區間——起點一個點、到結束的一條細線、結束端以形狀表示結束碼；未結束的動作線延伸到現在並以虛線收尾。取代「配對後隱藏 start」（`Timeline.tsx:178-180`）。
- **effect**：預設不與動作並列成點；動作旁顯示 `+N`，N 來自 D.3(d) 的總數查詢；超過上限寫 `N+`。展開時在動作的區間內畫一條密度帶（不是 5,000 個點），點開進 Activity 的成員清單（分頁、有總數）。未歸屬的 effect 留在自己的來源泳道，以來源命名。
- **state**：泳道上方一條狀態帶，固定順序：app 開著／暫停（全域與每終端）／缺口（斜線）／終端 session／proxy／IP 與 VPN／目前目標。由 D.2 的投影供應，**不受任何篩選影響**——篩選只篩列，不篩狀態。
- **record-fact**：就地斷開。暫停、缺口、app 沒開畫成整欄的斜線區（與「安靜」的空白不同）；〈略過閒置〉只壓縮「在錄、但沒事」的空白，不壓縮這三種。sanitize／retention／config_changed 在狀態帶上一個刻度，懸停顯示適用區間。
- **annotation**：戰利品、範圍觀測、清理、憑證使用、pivot 偵測成為來源動作上的徽章；保留各自的泳道作為「全部列出」的檢視（UIUX §7 的跳轉需要）。marker 保留自己的列。

### E.2 Activity

群組 = 動作（指令、工具呼叫、AI turn、HTTP flow 作為獨立動作時）；成員 = 它的 effect 與輸出片段，依 `contains`／`caused` 收進來，`candidate` 另列「可能相關」。`tcp_message` 依 `flow_id` 收成一組（今天每列一組）。AI session 是外層容器。

### E.3 單一閱讀器，依附件分派

每個種類只走一個閱讀器（註冊表 `reader`），時間軸檢視器與 Activity 閱讀器共用：`command`（inline／body ref／cast 片段＋完整性）、`agent-turn`、`http`（請求／回應／分段／body）、`image`（截圖）、`artifact`（檔名、大小、雜湊、路徑）、`pcap-external`（只有雜湊與路徑，明說「封包不在 RedLog」）、`gap`（起訖、數量、原因）、`state-change`（前後值）、`generic`。最上方固定一行完整性，見 E.4。

### E.4 輸出完整性（協調者補充 1）

閱讀器必須說出下列其中一個，而且只依產生者送來的事實：`完整`／`截斷（已存 X，共 Y）`／`部分（背景仍在輸出）`／`未擷取`／`已重導（輸出去了檔案）`／`缺口`。今天各來源實際提供的：

| 來源 | 指令＋結束碼 | 解析後的 stdout/stderr | 原始 PTY 錄影 | 未取得／截斷／缺口的陳述 | 閱讀器今天顯示 |
|---|---|---|---|---|---|
| 外部 zsh/bash hook，relayed（預設，`command-class.json` 第 4 層） | 有 | 有，至上限；`completeness`、`output_disposition`、`limit_hit` | 無 | relay 寫得完整（`redlog-relay.py:556-566,983-1001`） | 有內容時正確；**metadata-only 與 redirected 顯示「未產生內容」**，點上無缺角 |
| 外部 hook，native（vim、nc、claude…） | 有 | 無 | 無 | `not-captured`（無 `stdout` 欄位） | 「未捕獲輸出 — 外部 shell 只記錄指令本身…」——此句與 relayed 為預設的現況不符 |
| 外部 hook，pty 模式（ssh、socat） | `session_start/end`，結束碼 | 無 | `session_output` 片段 | `incomplete`、`omittedBytes`、`pausedBytes`（`eventTitle.ts:66`） | 片段標題「PTY #n」，無串接閱讀器 |
| `redlog-run` 包裝 | 有 | 有 | 無 | 有 | 同 relayed |
| 內建終端 | 有 | 由 cast 括號區段推得 | 有（cast） | `io.len`、`unbracketed` | `recorded`／`empty`／`unbracketed` 三種，正確 |
| PowerShell 外部 + transcript（Windows pack） | 有 | transcript 文字 | 無 | 未見明確欄位（UNCONFIRMED） | 依 inline 規則 |
| AI 的 Bash 工具 | 指令在 `tool_call` 輸入；結束碼不一定 | `tool_result`，可能已被 AI 工具本身截斷 | 無 | 只有 `output_length`（部分） | 顯示輸出，不說是否被上游截斷 |

`ls` 有輸出、`ls -al` 沒有：從程式無法判定是哪一層造成（UNCONFIRMED，步驟見文末）。可以確定的是：不論原因，今天的閱讀器**無法區分**「印了空白」「沒記到」「被重導」，因為 `commandOutputState` 不讀產生者的完整性欄位。修正是讓 `commandOutputState` 先讀 `output_disposition`／`completeness`，再看內容；`ioMark` 同步。

### E.5 密度

- 一個指令 5,000 個請求：動作上 `+5000`、密度帶、Activity 成員分頁；HTTP 紀錄照舊是平坦清單。
- pcap 100k flow：投影成「會話」（src、dst、port、proto、次數、首末時間，Zeek conn 的形狀），時間軸只畫會話區間；個別 flow 只在閱讀器分頁讀。新的 pcap 寫入一律 logged。
- 上限一律以 `N+` 或「已載入 N／共 M」呈現（UIUX §9、capped views 原則）。

### E.6 範圍、擷取政策、顯示篩選、匯出選取不得共用控制項或詞（協調者補充 2）

今天混在一起的地方：

| 控制項／設定 | 混了什麼 | 證據 |
|---|---|---|
| `scope.personalDomains`（設定在「專案與範圍」） | 範圍設定 → 顯示篩選（〈已隱藏非工作流量〉預設開，`FilterContext.tsx:130`）→ 匯出選取（bundle 直接丟棄這些列，`bundle-export.ts:298-301`；匯出篩選鍵 `hidePersonal`，`export-plan.ts:370`）。預設含 `127.0.0.0/8`、`localhost`（`config.ts:288`），經 `ssh -L` 轉到本機埠的目標流量預設被藏、匯出時被丟（UNCONFIRMED：這類 flow 的 `target_id` 是否為 127.0.0.1） |
| 〈範圍內〉晶片 | 用「範圍」一詞做顯示篩選，且被匯出沿用 | `filter.inScopeOnly`、`export-plan.ts:370` |
| 〈⛓ 只看上鏈〉 | 以儲存／完整性層命名的顯示篩選；HAR 匯出另外強制 logged（`export-selection.ts:38`） | `filter.chainedOnly` |
| body 淘汰以範圍為釘選 | 範圍決定儲存政策：範圍外的 body 先被淘汰 | `body-eviction.ts:24-27`、`settings.rotationHint` |
| 匯出「依網頁 scope 遮蔽範圍外內容」 | 範圍決定匯出內容（遮蔽）；可接受，但用詞「網頁 scope」與範圍頁不一致 | `export.maskScope` |
| 「範圍」一詞 | 同時指授權範圍、篩選涵蓋（「不在目前的篩選範圍內」）、已載入視窗（「已在目前範圍之外結束」）、時間範圍、匯出範圍 | `timeline.outsideFilter`、`timeline.command.unfinishedHint`、`timeline.minimapHint`、`export.rangeLabel` |
| 〈略過閒置〉 | 顯示控制把擷取政策（暫停）與安靜混為同一種空白 | `timelineTimeMap.ts:30-36` |
| 共用篩選的類型清單 | 以儲存名稱（`scanner`→「代理」、`pcap` 原字串）作顯示詞 | `FilterContext.tsx:199`、`timelineDomain.ts:142-144` |

原則：「範圍」只用於授權與觀測；「保存／不保存」只出現在設定；「顯示」只在各頁的篩選列；「匯出」只在匯出對話框，且匯出明列它沿用了什麼。個人流量規則搬出範圍設定，成為機器層設定（09 的 `machine.yaml`），顯示與匯出各自明確選用。

### E.7 跨頁語境（協調者補充 3）

跨頁只帶專案、時間範圍、選中的事件；篩選留在各頁。這與 Spec 038 的「共用篩選套用到每個事件視圖」相反，所以屬於契約替換：`FilterContext` 的目標、類型、範圍內、個人、tier 五項改為每頁持有；從目標頁跳時間軸改為「選中事件＋時間範圍」而不是設定目標晶片。03-F4（跳轉後事件被篩選藏起來）因此消失。要一起改的：`useFilter` 的消費者、`toEventFilter` 的呼叫端、跳轉 API、e2e 中斷言共用篩選的 spec（`CLAUDE.md`「Changing behaviour」）。

### E.8 儀表板與狀態列，依家族

- 指令：每個終端最後一筆的時間；完整性分布（完整／截斷／未擷取）。
- 流量：flow 數；歸屬「X／Y」（擴充既有 `attributionBlind`）；缺口數。
- AI：記錄中的 session 數；缺口。
- 證據：截圖、檔案、戰利品數。
- 記錄本身：目前是否暫停（全域／幾個終端）、最近一次缺口。
- 狀態列的總數只算註冊表上非 housekeeping 的列，與時間軸同一定義（03-F3 的計數詞彙在這裡落地）。

### E.9 匯出

NDJSON 照舊每列一行（不改格式），另附 `kinds.json`（註冊表版本與每列種類的角色）與 `intervals.jsonl`（D.2 投影，標明為衍生）；bundle 摘要加入每終端暫停、app 未開的區間。HAR 只含 HTTP effect。不產生報告。

### E.10 要移除的

`c2_checkin` 泳道與 `c2Beacon` 標題；「HTTP」／「代理」兩個錯名的泳道（改以來源命名）；配對後隱藏 `command_start` 的處理；以已載入列計算的效應清單；「Shell 事件」「系統事件：x」fallback；非 HTTP 的 scanner 列套用 `HttpDetail`；內務規則的 JS／SQL 雙份；Activity 動作的 ad-hoc 清單與 A.5 的死字串；狀態列計入看不見的列。

### E.11 每項的取代、影響範圍與驗證

| 提案 | 取代 | 影響範圍 | 驗證 |
|---|---|---|---|
| 完整性照實呈現 | `commandOutputState`、`ioMark` | `content-contract.ts`、`TimelineEventDetails.tsx`、`TranscriptView.tsx` | 單元：relay 的五種 disposition 各一筆；實機：外部 zsh 跑 `ls`、`ls -al`、`nmap -oN x`、`vim` |
| 閱讀器依註冊表分派 | `hasSpecificEventDetail` 與分支 | 檢視器、Activity 閱讀器 | 單元：每個註冊種類有 reader；e2e：選截圖看到圖 |
| 區間投影＋狀態帶 | `sessionBoundaries`、`active-pivots` | 階段 3 工作執行緒、`Timeline.tsx` | 等價測試：投影 vs 全表重算；實機：暫停跨頁、篩掉系統仍看得到 |
| effect 計數與附著 | `effectsIndex` | 時間軸、Activity | 實際量：一個 `ffuf` 打 5,000 請求 |
| 確定性歸屬 | `pidCmd` 推測 | hook、addon、ingest | 實機：背景工作＋前景指令交錯；三個平台 |
| pcap 會話投影 | `packet_flow` 逐點 | 外掛、投影 | 實際量：10 萬 flow |
| 四概念分離 | `personalDomains` 位置、詞彙 | 設定、篩選列、匯出 | `ui-copy` 測試＋人工走查 |
| 跨頁只帶三項 | Spec 038 共用篩選 | `FilterContext` 全部消費者、e2e | e2e 跳轉 spec |

---

## F. 排序（避免的誤讀 ÷ 影響範圍）

| # | 變更 | 階段 |
|---|---|---|
| 1 | 輸出完整性照實呈現（讀 `completeness`／`output_disposition`；「未擷取」「已重導」不再說成空） | 獨立 |
| 2 | 閱讀器依種類分派，消除 fallback（截圖有圖、非 HTTP 的 scanner 列不再用 HTTP 檢視器、`capture_stopped` 等有標題） | 獨立 → 併入註冊表 |
| 3 | 移除死的呈現與錯名泳道（A.5、「HTTP」／「代理」改以來源命名） | 獨立 |
| 4 | `event-kinds.ts` 註冊表＋雙向 gate（先呈現表） | 0（gate）、6（呈現） |
| 5 | 狀態帶改由全專案投影提供，不受篩選與分頁影響；新增 `project_closed` | 3 |
| 6 | 停止猜測歸屬：`pidCmd` 不再以 shell pid 對「最近指令」；改送 `REDLOG_COMMAND_ID`／proxy userinfo | 1／4 |
| 7 | 指令畫成區間，effect 以總數附著於動作 | 3、6 |
| 8 | 範圍／擷取／顯示／匯出四者分離（個人流量規則移出範圍、詞彙表） | 2（機器層設定）、6 |
| 9 | 推導結論改為 annotation 並記錄規則版本 | 4 |
| 10 | pcap 單一形狀（logged）＋會話投影；跨頁只帶專案／時間／選中事件 | 4（pcap）、6（跨頁） |

可在階段 1 之前上、之後不必重做的三項：**#1、#2、#3**。#1 只讀既有欄位；#2 的分派表日後原封搬進註冊表的 `reader` 欄；#3 只刪東西。三者都不碰資料、雜湊或寫入路徑。

---

## 需要 owner 決定的問題（4 個）

1. **推導結論（戰利品、範圍觀測、pivot、清理、憑證使用）在時間軸上是附著在來源指令的徽章，還是維持各自的泳道？** 建議：預設附著為徽章，泳道保留為可展開的「全部列出」；狀態列與側欄計數不變。
2. **新增 `project_closed` record-fact（加法，不改既有列）以區分「app 沒開」與「沒有事件」？** 建議：新增；舊專案顯示「此段是否在錄：未知」。
3. **個人流量規則（`personalDomains`）搬出範圍設定，且預設不再包含 `localhost`／`127.0.0.0/8`？** 建議：搬到機器層設定；預設清單保留但 bundle 不再靜默丟棄，改在匯出對話框明列「排除個人流量 N 筆」並可取消。
4. **確定性歸屬採哪一條：`REDLOG_COMMAND_ID` 環境變數（需讀行程環境）或 proxy URL userinfo（只涵蓋遵守 proxy 變數的工具），或兩者？** 建議：兩者都做，userinfo 先上（不需特權、可在受管 proxy 內完成），環境變數作為 process 觀察者開啟時的補強；兩者都取不到時不寫 `_causes`。

## 檢查過且無誤

- `socket-attribution` 在無法確定時不寫邊，時間軸以 `attributionBlind` 說出「全部歸屬失敗」——方向正確（問題只在 D.4 的猜測情況）。
- relay 對完整性的判斷本身是誠實且細的（重導、drain timeout、背景、截斷各有值）；問題完全在讀取端。
- `file_created` 的指令關聯刻意只放候選、不進 `_causes`（`causes-resolver.ts:186-187`）。
- HTTP 紀錄以 `flow_id` 在 SQL 層組成 flow（`event-queries.ts:315-340`），已是「區間投影」的雛形。
- 搜尋索引對所有種類一視同仁（FTS 觸發器涵蓋兩個 tier 的 `data`，`db/index.ts:431-452`），沒有種類被漏索引。
- 效應 chip 有 20 個上限並說出剩餘數量（`TimelineEventInspector.tsx:340-366`）；問題在總數的來源，不在上限的呈現。

## 刻意的（附依據）

- `marker` 與 `system` 暫停豁免（`event-write.ts:376-380` 註解）。
- `scope_violation` 存成 `system` 再於呈現時移到範圍泳道（`timelineDomain.ts:146-150`）。
- pcap 原始檔不進 bundle，只上雜湊（`pcap-sidecar.js` 註解）。
- HUD 的 pivot 只列「偵測到的節點」、不畫鏈（UX-005）；30 分鐘視窗是已知的退而求其次（`active-pivots.ts:12-23`）。本報告只要求把它在時間軸上呈現為「偵測於」而非「開著」。
- 以範圍釘選 body（`body-eviction.ts:24-27`）是刻意設計；本報告只指出它讓範圍兼任儲存政策，需在詞彙上分開。

## UNCONFIRMED 與確認步驟

1. **`ls` 有輸出、`ls -al` 沒有**：在外部 zsh（`$SHELL`）與內建終端各跑兩次，讀兩筆 `command_end` 的 `completeness`、`output_disposition`、`stdout_bytes`、`captured_by`、`io`、`source`；若 `ls` 為 alias 或函式，再以 `command ls -al` 重跑。
2. **預設歸屬率為 0**：在 pack 關閉的專案跑 `curl https://example.com` 經受管 proxy，查 `SELECT COUNT(*) FROM events_logged WHERE agent_type='scanner' AND subtype='http_request_start' AND json_extract(data,'$._causes') IS NOT NULL`。
3. **背景工作被歸到後來的指令**：pack 開啟，`ffuf …&` 後立刻 `ls`，比對 ffuf 請求的 `_causes` 指向哪個 `command_start`。
4. **重開 app 後的 `command_end` 沒有 cause**：長指令執行中重開 app，查該 end 的 `_causes`。
5. **暫停帶在篩選下消失**：暫停 1 分鐘後，共用篩選選「Shell」類型，看時間軸是否仍有暫停帶。
6. **截圖在時間軸檢視器無圖**：手動截圖後在時間軸選中該點。
7. **`packet_flow` 進雜湊鏈的量**：pcap 外掛跑一次 nmap 掃描，比較 `events` 與 `events_logged` 的增量。
8. **`ssh -L` 轉發的流量被藏與被丟**：`ssh -L 8080:target:80`，`curl http://127.0.0.1:8080`，看 flow 的 `target_id`、時間軸預設是否顯示、bundle 的 `personalDropped`。
9. **proxy URL userinfo 的可行性**：以 `curl`、`python requests`、`go` 工具各送一次帶 userinfo 的 `HTTP_PROXY`，看 mitmproxy 是否收到 `Proxy-Authorization` 且不擋。
10. **PowerShell transcript 的完整性欄位**：Windows 上讀 `powershell-transcript.ts:175-190` 產生的列（需 Windows 環境）。
