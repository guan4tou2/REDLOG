# REDLOG 全流程設計檢查與改善建議

## 結論

REDLOG 的方向應保持「本機操作紀錄與證據交付」。不需要更多頂層功能；優先讓來源覆蓋說得清楚、記下的內容找得到、操作者排除的內容確實不外流。

本輪最重要的新發現不是美觀問題，而是三個已用隔離資料重現的匯出契約缺陷：HAR 恢復了預覽排除的事件、bundle 複製了標記不匯出的截圖、附件在預覽後改變仍能成功執行。這三項應先於介面整理處理。

## 基準與驗證範圍

- 日期：2026-09-27；遠端 main：`f3a1ac4`。
- GitHub 實際 release：v0.17.1；没有開啟的 PR；#217–#226 全部 OPEN，#182 仍 OPEN。
- 本機 main：6b6af04；沒有自動 pull 或修改產品程式。以 `git archive origin/main` 建立 `/tmp/redlog-audit-20260927-GAtjzQ` 暫存副本，使用專案現有依賴。
- 檢查包含安裝設定、主導覽、Dashboard/HUD、來源、shell/HTTP/檔案/AI/截圖、搜尋/逐字稿/目標、scope/私人資料、匯出、生命週期、文件與測試。
- 覆蓋主要操作與資料契約，不是逐行審查整個 repository，也不是三平台正式安裝包驗收。

### 執行結果

| 驗證 | 結果 | 能證明什麼 |
|---|---|---|
| 最新快照 production build | 通過；有既有 browser externalization 提示 | 程式可建置，不代表功能正確 |
| 11 個來源/設定/篩選/預覽測試檔 | 59 通過、1 失敗 | 午夜時段的時間測試假設錯誤，見 F08 |
| 3 個既有 export/har/bundle 測試檔 | 45 通過 | 既有範例可運作；沒有覆蓋本輪三條負面路徑 |
| 新增的隔離回歸探針 | 3 個預期保護均失敗 | 實際重現 F01/F02/F03 |
| Electron project-flow | 3 通過 | 真 App 可建立專案、快捷切頁、驗鏈 |
| Electron first-run/HUD/export/scope/transcript/toolbar | 19 通過、1 跳過 | 在隔離 HOME 操作實際畫面；部分資料透過測試 seed，非完整來源端到端 |

合計既有單元/整合測試 104 通過、1 失敗；Electron 22 通過、1 跳過。沙盒內第一次 Electron 無法啟動；提升執行權限後，以同一隔離 HOME 流程通過，不能把首次啟動失敗當產品 bug。

未驗證：Windows/Linux 真機安裝、DPI、macOS 安裝信任流程、真實 HTTPS client 信任、tmux 多主機交戰、長時間壓力與磁碟耗盡、所有輔助科技。沒有在真實交戰資料上操作。

## 一、新發現：依影響排序

### F01 — P1：HAR 沒有服從核准的事件集合【已重現】

位置：`src/main/ipc/data-export.ts` 的 HAR execute 分支；`src/core/har-export.ts`。

重現：建立兩個 HTTP request，把其中一個標 do-not-export。resolve preview 顯示 included=1；execute HAR 成功，檔案卻含兩筆 request，包括被排除的 URL。

原因：預覽保存 selectedEventIds，但 HAR 重新按時間/target 查詢，且傳入空的 doNotExportIds，未使用 selectedEventIds。

改善：HAR serializer 消費核准事件或不可繞過的選取條件；不自行重新擴大查詢。驗收比較實際 HAR entries 的來源事件，而非只比較 manifest counts；定義 request/response 一端被排除時整個 flow 的處理。

### F02 — P1：不匯出的截圖仍進 bundle【已重現】

位置：`src/core/bundle-export.ts` screenshots 複製區段；`src/core/export-plan.ts` countExportAttachments。

重現：截圖事件標 do-not-export，預覽正確列 excludedDoNotExport=1；execute 成功，圖片仍存在輸出 screenshots/。

原因：資料列選取與附件掃描分離。掃資料夾的路徑未服從核准事件；計數甚至可能把已排除但仍在磁碟的檔案當成 unattributed。

改善：附件由核准事件解析成明確清單；不應將「已知被排除」重新分類為「未知所以納入」。真正 orphan 檔案單獨揭露並由操作者決定，不默默掃目錄帶出。與 #222 合併設計，但這是立即修復的缺陷。

### F03 — P1：附件內容不屬於預覽快照【已重現】

位置：`src/main/ipc/data-export.ts` bundle execute 的附件計數比對。

重現：預覽包含一張截圖；預覽後改變圖片 bytes、檔名與數量不變；execute 仍回傳成功。

原因：只比 included/missing/unattributed 數量。事件內容 digest 不會反映外部附件 bytes 改變。匯出後新算的 hash 只能描述當時輸出的檔案，無法证明它是預覽時的版本。

改善：ExportPlan 附件清單包含內容身分（hash、大小、來源事件），執行驗證；或先建立不可变附件快照。對仍寫入的 cast 明確選擇已封存片段或拒絕並提示結束/重新預覽。驗收附件被改、被替換、被刪及持續增長。

### F04 — P1：HAR 固定 50,000 事件上限與預覽全量不一致【程式確認，未做大資料實測】

位置：`src/core/har-export.ts` 的 `limit: opts?.limit ?? 50000`；resolver 使用 limit:-1，execute 未傳 limit。

後果：長場次預覽數量可能超過 HAR 實際處理範圍，request/response 配對亦可能被切開。50,000 是事件而不是 50,000 筆完整往返。

改善：依核准集合串流/分批組 flow，明確表示不完整配對；移除隱含上限或將上限做成可见的拒絕條件。加入超界資料測試。不要只把 limit 調大。

### F05 — P2：閱讀篩選與匯出仍是不同能力【設計缺口，部分已有誠實文案】

位置：Timeline slice request、HttpHistoryPanel harExportRequest、ExportRequest/ExportCapabilities。

Timeline 已明講共享 filter 不套用，因此不是全都偷偷失效。但 HTTP 匯出是由已載入 filtered 流量取最小/最大時間與 host；method/status/text 等條件不能完整進 ExportRequest。JSON/NDJSON/bundle 亦不支援 bounded subset。

改善：先提供明確兩個選擇「目前查詢結果」與「全部專案」；格式不支援就禁用並解釋。ExportPlan 引用 canonical EventFilter 加上 flow 條件，不用可視/已載入 rows 推算全量查詢。將 #225 的人工選取與 #222 的附件清單一起納入同一計畫。

### F06 — P2：設定指令可能被送入正在操作的遠端 session【程式確認，未對真遠端執行】

位置：`TerminalView.tsx` 的 deliver；`lib/terminalRunner.ts`。

目前「在終端開啟設定指令」直接 terminal.write 到 activeTab 或第一個 tab。這個 pane 可能正在 ssh、SQL REPL、編輯器或其他互動程式。雖然沒有自動加 Enter，輸入本身也會改變前景程式狀態，不能當成只在安全命令列顯示文字。

改善：顯示可複製命令或建立明確的本機設定 shell；確認輸入目的地，不將設定字串直接寫進任意工作 session。保留使用者手動執行，不自動安裝/撤销系統信任。

### F07 — P2：截圖與目標頁的部分讀取錯誤仍無恢復路徑【程式確認】

ScreenshotsView loadPage/loadMore 設 loading 後 await，缺 catch/finally；失敗可停在載入中。TargetView 的選取與 loadMore 也有相同型態。

改善：沿用既有 error/retry 元件；保留舊資料並標示未更新；換目標或條件後忽略舊 request 的回覆。不要只在 Search/FilterProvider 修錯誤狀態。

### F08 — P2：時間測試在午夜自然失敗【已執行確認】

`test/filter-time-range.test.tsx:99` 使用 Date.now()-1h，卻斷言一定不含日期。本輪 00:02 執行，正確顯示跨日日期而失敗。

改善：固定測試時鐘到正午測同日，另測跨午夜、UTC/local 與 DST 邊界；不要放寬畫面正確行為配合錯誤測試。

## 二、#217–#226 全部對照與改善方向

| Issue | 目前狀態 | 建議的最小落地範圍 |
|---|---|---|
| #217 首次用途選擇 | 未完成；仍在 lit 分支內 | 新專案先選 Web/終端/兩者，不等第一筆事件 |
| #218 外部輸出/tmux | 既有 PTY、上限、缺口計數可沿用 | 驗證 output canary、pane/detach/長互動；不要另造 recorder |
| #219 session target | 全域 active target 已有；session context 待設計 | 明確 session 歸屬、顯式事件優先、切換 context 留痕，不改歷史 |
| #220 HTTP/HTTPS 驗證 | CA 存在與任一 HTTP 事件仍不足 | 指定 client 的唯一 HTTP/HTTPS 往返；精確 CA 撤銷 |
| #221 本機產物 | watcher 仍記 metadata | 選檔加入、封存/hash/來源、納入 manifest；不批次下載目標檔案 |
| #222 附件選取 | 未完成 | 先修 F02/F03，再做選取/排除與跨目標 cast 提示 |
| #223 設定生命週期 | 缺口仍存在 | 關專案前保存；scope 重試真讀 scope；StrictMode reset；初載失敗 |
| #224 敏感來源 | pack members 可關，但未設值隨 pack 開 | clipboard 明確 opt-in，顯示 pack 將啟用哪些項目 |
| #225 報告素材 | Transcript 已可 copy Markdown，不能重做當不存在 | 增加人工選取及 event/session/target 回溯；保留截斷說明，不做報告引擎 |
| #226 發版驗收 | 未發布；changelog/文件仍需對齊 | 三平台打包驗收及版本能力一致；不得以測試數代替安裝驗收 |

#182 仍開啟；已存在背景瀏覽器流量與 credential scheme 修正，不把原始描述全部當成現存 bug。本輪未重跑它的真實瀏覽器噪音情境，應針對剩餘 scope 噪音驗收再關閉。

## 三、整個 App 的 UI/UX：依操作路徑收斂

### 安裝與專案

- 保留 runtime readiness 與 scope/exclude 建立入口。先問工作在哪個環境：本機、WSL、VM；不要暗示宿主 App 自動看到客體操作。
- 只驗本次選用來源。缺 mitmproxy 不阻擋純終端工作，缺 shell runtime 不應阻擋已就緒的 HTTP 路徑。
- 顯示專案檔案位置與實際版本；scope 空白是未知，不能顯示全面安全。

### Dashboard / HUD

- 頂部只回答：正在記哪個專案、哪些来源有效、哪裡有缺口。來源設定與最近紀錄放第二層。
- HTTP 單一狀態詞已改善；其他來源也區分可用、啟用、收到資料、內容被截斷/漏失。不要把閒置當失敗，也不要把程序存活當內容完整。
- HUD 展開/收起與縮放本輪有實測通過，不再列舊按鈕故障。未測 Windows DPI，不宣稱全平台視覺通過。
- HUD、VPN/IP 輔助資訊維持選用，不當基本記錄的進場門檻。

### 終端與來源

- 每個 session 顯示「只記指令/含輸出」、target、開始時間與截斷狀態。
- 長 session 讓操作者知道還在錄、多少已保存、來源斷線是否有缺口；不中斷使用者 shell。
- pack 作為預設組合即可，不要求使用者先懂 plugin、tailer、tier 的內部差異。
- 安裝/CA 設定動作不要注入現有交戰 shell（F06）。

### 搜尋、Timeline、逐字稿、HTTP、截圖

- 不必合併所有頁面。Search 負責精確找、Timeline 看順序、Transcript 看可讀內容、HTTP 看往返；共用 target/time/來源語意。
- 詳情保留「回到原結果」的條件與位置；跨頁跳轉應能看見帶了什麼 filter。
- 篩選顯示的是全量查詢或已載入子集必須清楚。截圖畫廊目前是獨立查詢，若要當 per-target 工作面，需明確接 target/time，不能假裝全頁都服從共享篩選。
- 空白、載入、失敗、部分結果用不同狀態。優先補 F07，不再為每個頁面新增不同通知系統。
- Transcript 已有 Markdown 複製與 partial/truncated 說明；#225 應補來源回溯與人工選取，非從零開發。

### 設定與匯出

- Browser 已搬入來源分組；不再建議重搬同一件事。
- 設定的「已寫入」和「來源套用成功」分開；來源重啟失敗不應讓使用者以為配置已生效。
- 不硬砍頁數。使用來源/本場範圍/證據保存/App 外觀的操作分類，低頻數值摺進階。
- 匯出流程三步足夠：範圍 → 內容/附件核對 → 產物與驗證結果。技術指紋可摺詳細，不能取代人看得懂的內容清單。
- 對 share/merge 格式能力明確說明；不要一邊寫交付，一邊因格式不支援而無法帶附件卻不解釋。

## 四、log 擷取項目與必要邊界

| 來源 | 應保留的核心資料 | 覆蓋邊界與改善 |
|---|---|---|
| Shell hook | command、cwd、exit、duration、session | 不含普通 stdout；驗證實際 shell/pane |
| PTY/session | 輸出串流、來源、序號/時間、結束及缺口 | stdout/stderr 可能合併；遠端命令不必都有結構化事件；上限可見 |
| HTTP(S) | request/response、flow、headers、body/ref、截斷 | 僅代理路徑；body 10 MB、preview 4 KB、headers 200 項；client 信任另驗 |
| WebSocket/TCP addon | message/方向/flow/body/ref | 有 handler 不等於所有 client 都走到此來源；需實際流量驗證 |
| DNS | query/answer/error 與來源 | DNS mode/路由另配置，不宣稱全機所有解析皆收集 |
| connection/process | 採樣時間、位址/process 關聯 | 輪詢有短連線/SYN 盲區；推論不冒充完整封包 |
| pcap producer | flow 摘要與可選 pcap segment hash | 原始 pcap 外部保存；明確傳輸/保留/匯出責任 |
| 工具輸出檔 | 原檔版本、hash、來源 command/session | watcher metadata 不等於內容保存，補 #221 |
| 截圖/marker | 圖片、時間、target、操作者註記 | 不等於完整 GUI 錄影；排除必須同時約束附件 |
| AI transcripts | 支援來源、限定路徑、工具輸入/輸出與來源關係 | opt-in；不是任意 AI 通訊或不可見思考的完整記錄 |
| Clipboard | 明確授權的內容策略 | 不跟隨 host pack 默開，不當預設核心 |
| 系統稽核 | pause/resume、設定/來源變動、缺口 | 只能解釋未錄區間，不能補出不存在的證據 |

scope exclude、private、do-not-export、sanitize 必須用不同語意呈現：範圍判定、私人資料政策、事件排除、內容衍生遮蔽不能互相代替。原始紀錄與交付副本保持分離。

## 五、系統設計：只收斂必要責任

1. **ExportPlan 管事件與附件的完整核准集合。** serializer 不再自由重查/掃目錄；計數、實際檔案、manifest 全部由同一集合產生。先解決 F01–F04，不新增第二個 export framework。
2. **設定更新由 main 統一驗證、保存、稽核與套用。** 帶 project identity、局部 patch/必要版本檢查；UI 不保留多份可覆蓋整份設定的舊快照。關閉流程先 await 保存。
3. **來源能力與來源健康分開。** 能收什麼、是否啟動、最後收到、丟失/截斷、最近錯誤有穩定欄位；Dashboard/HUD/設定讀同一份來源狀態。不是建一套插件框架。
4. **Session context 是歸屬，不是猜測。** 來源明示 target 優先；無法確定就保留未知/候選。全域 active target 是 fallback，不能事後改歷史。
5. **大查詢與交付不阻塞 ingest。** 目前主行程同步全量 query/serialize/write 值得量測。先設長場次效能驗收，證實卡頓再抽 worker/streaming；不可只為架構美觀全面重寫。
6. **錯誤與完整性是共同契約。** query 的 hasMore/error、擷取 dropped/truncated、附件 missing，跨 renderer/IPC/core 不應被改成空陣列或成功 toast。

## 六、核心、可選與不做

核心：專案與scope、command+output、HTTP(S)、截圖/marker、附件保存、搜尋回放、可驗證交付、可见缺口。

可選：AI、clipboard、process/connection、pcap、C2/遠端來源、HUD、loot/分類推論。保留有用能力，但不佔新手主流程。

不做：flag/proof 收集、評分、攻擊編排、多人案件系統、AI 自動攻擊結論、完整報告編輯器。不要將 OSCP 使用情境做成額外考試產品。

## 七、建議執行順序與驗收出口

### 第一批：阻止錯誤交付與靜默丟失

F01/F02/F03/F04、#223。出口：排除不外流、附件不漂移、完整查詢不靜默截斷、關閉不丟設定。新增測試必須檢查真正 artifact bytes/entries，而非只檢查 response counts。

### 第二批：讓來源設定走得通

#217/#218/#220/#224 加 F06/F07。出口：新的 Kali 使用者能接自己終端與 Web，分別驗證 command/output/HTTPS；失敗知道怎麼重試；不影響既有遠端 shell。

### 第三批：讓多目標操作與整理接得起來

#219/#221/#222/#225 加 F05。出口：兩台主機並行不混、產物原檔可保存、人工挑出重現步驟、選取範圍与附件一起交付。

### 第四批：發布驗收

#226、F08。出口：安裝版、README、CHANGELOG 與能力矩陣一致；平台未測項清楚列出；安裝包完成最小端到端。

#223/F07/F08 等明確 bug 用小修正與回歸即可。事件+附件計畫、session context、來源驗證等跨層契約用有界 Spec，引用既有 domain 文件，避免再寫整個 REDLOG 的巨大 spec。

## 重現附件與程式引用

三個匯出失敗探針：[export-regression.patch](evidence/2026-09-27-export-regression.patch)。僅保存在文件附件，未套用到工作區測試或產品程式；可在 f3a1ac4 隔離 checkout 套用後執行 `vitest run test/export-plan-ipc.test.ts -t 'audit:'`。fixture 圖片為合成 bytes，驗的是排除與快照，不是圖片解碼。

主要程式均來自 [main f3a1ac4](https://github.com/guan4tou2/REDLOG/tree/f3a1ac4)：

- `src/main/ipc/data-export.ts`、`src/core/{export-plan,bundle-export,har-export,export-capabilities}.ts`
- `src/renderer/src/components/{FirstRunView,HttpCaptureStep,Settings,TerminalView,FilterBar,ScreenshotsView,TargetView,TranscriptView,Timeline,HttpHistoryPanel}.tsx`
- `src/renderer/src/lib/{FilterContext,httpVerification,terminalRunner}.ts(x)`
- `src/core/{ingest,capture-packs,capture-health,config}.ts`
- `hooks/redlog-session.py`、`hooks/mitmproxy-addon.py`

未在本輪新增或修改 GitHub issues；本文件可用於下一輪更新既有追蹤，避免重複開單。
