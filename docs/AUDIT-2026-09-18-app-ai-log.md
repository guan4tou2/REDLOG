# RedLog 操作流程、系統與 AI log 審查

日期：2026-09-18，續查至 2026-09-19。最新原始碼核對：`a8fa47e`。本次只修改這份審查文件，未修改產品程式。

> 狀態校正：`ec53448` 之後已有多批修正。下文保留首次發現作為設計脈絡；其中 spool 專案歸屬、terminal pause、AI pause gap、來源時間、半行 checkpoint、sidecar 封存、session registry、搜尋 facets／競態、tool 配對／中斷、未知 exit status、Markdown 截斷提示、bundle 回傳契約、無上限 JSON／NDJSON、HTTP body 與附件 scope 處理等，均已在後續 source 出現對應修正。它們不再列為 `a8fa47e` 的現存缺陷，仍需以新版桌面端到端回歸確認。

## 結論與驗證範圍

RedLog 的擷取 → 保存 → 顯示 → 交付方向合理；目前不能承諾「單靠此工具完整保存所有測試流量、命令與 AI 操作」。主要缺口是來源涵蓋、暫停語意、專案歸屬、原始資料保存和匯出一致性，不是缺少更多儀表板。

證據分成三層，不能混用：

- 先前實際桌面操作：Dashboard、HTTP、Timeline、Settings、Search、Export 入口。這些是舊版畫面觀察，部分已修。
- `e9cc37e`：隔離資料的 service/parser 測試曾重現下列保存問題；終端測試使用 mocked PTY，並非真實終端端到端測試。11 個觀察測試通過代表符合被測的行為，其中包含確認缺陷，不能解讀為產品全部正確。先前暫存測試檔已清除，未將其視為本版可重跑的驗收附件。
- `ec53448`：重新核對下列現存程式路徑；本輪沒有重新跑完前述重現測試，也沒有完成新版桌面全流程。

因此這是跨層設計與缺陷審查，**不是完整 UI/UX 或端到端驗收通過證明**。新版首次啟動、實際擷取、暫停／恢复、切換專案、最終匯出檔，以及窄視窗、鍵盤與錯誤狀態仍需實機驗收。

## 優先修正：紀錄可信度

| 問題 | 操作者會遇到什麼 | 目前證據與位置 | 最小修正方向 |
|---|---|---|---|
| 離線 spool 沒有固定專案歸屬 | A 專案離線事件在開啟 B 後歸入 B | 最新 source：`src/main/index.ts:624`，直接補入目前專案，註解明示 newest project owns recovered rows | 生產時固定 project/session/operator；無法判定者待歸屬，不自動套目前專案 |
| 暫停仍写入終端 `.cast` | 畫面暫停卻仍保存輸出 | e9 service 重現；最新 `src/main/terminal-manager.ts:287` 無 pause gate | 所有檔案與 DB 保存遵守同一暫停政策，狀態顯示同步 |
| 切換專案保留舊 terminal | cast 在 A，結束事件可能使用 B 身分 | e9 mocked PTY 重現；最新 `src/main/index.ts:947` 未關閉 terminal，`terminal-manager.ts:80,131` 用可變全域身分 | 在關閉 A 的 DB 前結束／封存 A session，或將 session 永久綁 A 並隔離寫入 |
| AI 暫停期間稍後被補收 | 恢復時補入使用者以為未保存的內容 | e9 重現；最新 `tailer-host.ts:699,712` 暫停不推進來源位置 | 明確定義暫停為不保存或延後讀取；若前者，恢復時跳過期間並記錄缺口 |
| AI 來源縮短清空舊副本 | 原始對話消失，只剩 hash 與部分衍生事件 | e9 重現；最新 `tailer-host.ts:721` truncate | 舊副本封存為上一代，新來源另開檔；hash 不能取代原始內容 |

這些問題優先於介面美化。共同原因是政策散落在 DB、tailer、PTY、spool，不是各個來源都遵守同一保存邊界。

## AI log：完整性、時間與查找

| 問題 | 影響 | 證據 |
|---|---|---|
| 同一 message 多個 tool block 被覆寫成一個 turn | 前面的工具呼叫／結果不出現在結構化事件 | e9 重現；最新 `agent-transcript-tailer.ts:153` 及 assistant 分支以同一物件反覆賦值 |
| 沒有保留來源事件時間 | 舊對話匯入時看起來像現在執行，難以對照藍隊時間 | e9 重現；最新 `tailer-host.ts` 的 `ParsedTurn` 無來源時間，`insertEvent` 未傳來源時間 |
| 半行 JSONL 在重啟後漏解析 | 原始副本有資料，搜尋／時間軸卻找不到該 turn | e9 重現；最新以 sidecar 大小當 cursor，未完成行只在記憶體 `pendingLineBuffer` |
| Transcript 先取所有種類最後 2,000 筆 | 大量 HTTP 等事件可能把 AI 對話擠出畫面 | 最新 source：`TranscriptView.tsx:245` |

最小 AI 紀錄模型：

1. 固定 `project_id`、`source`、`session_id`、`message_id`、`block_index`，讓多個 tool block 各自成為事件，重讀可去重。
2. 分別保存來源時間與接收時間；來源沒有時間就標示未知，不能悄悄以接收時間冒充。
3. 分開 user message、assistant message、tool call、tool result；call/result 以來源與 session 內的 tool ID 關聯。
4. 保留原始檔代次、byte offset、hash、截斷與解析狀態。checkpoint 應以已完成的解析單位為準。
5. UI 以 session 分組，call/result 可展開；標示「尚未收到結果」「已截斷」「來源有缺口」。AI 說成功不等於工具執行成功；工具結果也不等於外部目標一定發生預期效果。

這些是紀錄工具必要的可追溯性，不需要加入 agent 任務排程、評分、成本分析平台或自動攻擊管理。

原始 transcript 與畫面遮罩必須分開說明。目前原始副本可能保存敏感內容；不顯示 thinking 不等於原始來源沒有保存 thinking。證據包預設不含原始 agent transcripts 是合理設計，應保留並在交付選項說明。

## 搜尋、篩選與匯出

| 問題 | 最新來源核對 | 建議 |
|---|---|---|
| 類型 filter 由目前 200 筆結果產生 | `SearchPanel.tsx`：`byType` 只數 results，且 `types.length > 1` 才顯示；200 筆全 shell 時 scanner 無入口 | 固定類型選單或獨立 facets 查詢；不能以第一頁結果決定可搜尋種類 |
| 空結果時清除 filter 入口消失 | 清除按鈕置於 `results.length > 0` 區塊；Esc 可解除但不夠可發現 | 搜尋列常駐顯示已套條件与清除 |
| 搜尋沒有非同步請求序號保護 | 舊請求完成可覆蓋新結果；主要 events search 無 catch | 只接收最後請求，提供錯誤與重試狀態 |
| 證據包成功後 UI 可能顯示失敗 | `ExportMenu.tsx:161` 讀 `zipPath`；`main/ipc/data-export.ts:68` 回 `outDir` | 共用回傳型別，成功訊息顯示真實輸出位置 |
| 「全部」JSON／NDJSON 只取 100,000 筆 | `main/ipc/data-export.ts:120,141` | 分頁／串流匯出，完成後核對筆數，不以靜默上限冒充全部 |
| 匯出承接時間，不代表承接完整目前視圖 | Timeline 已提供時間切片，但不等於 lane／文字／target 條件 | 共用 filter 資料結構，確認頁列出時間、目標、類型及筆數 |
| 外部 HTTP body 沒一起交付 | `bundle-export.ts` 複製 screenshots/casts 等但無 `http-bodies/` | 依所選事件收集合法 refs，打包後檢查是否有缺檔；大 body 保持外部檔案即可 |
| 非標的 body 物件未遮蔽 | `scope-sanitize.ts` 只處理 string；`redact-export.ts` 只在字串成功遮蔽後清 ref | 同時處理文字、結構化／base64 body 和 refs；不能靠 preview 存不存在決定遮蔽 |
| 附件與文字 scope 政策不一致 | bundle 直接複製 screenshots/casts；e9 已重現非標的 cast 被包含 | 交付前可排除附件，無法判定歸屬者明示；不承諾自動裁切即可安全 |

最後兩項的 e9 重現包含合成 base64 body 与非標的 cast；最新版 source 路徑仍相同，但尚未重跑成品檔驗證。

Scope 目前是「保留 metadata、遮蔽部分內容」，並不是「整筆非標的事件排除」。command、URL query、headers、cookies 可能含內容或秘密；是否保留需明確選擇交付政策，不能僅以 metadata 名稱判定安全。無 target／未設定 scope 應標「未分類」，不代表 in-scope。原始證據保存與對外交付衍生副本應保持分離。

## UI/UX 最小改善

主要操作路徑應是：選專案 → 確認來源正在記錄 → 找事件 → 看原始細節與相關結果 → 確認交付條件 → 匯出。

- 狀態至少區分「未啟用、等待資料、記錄中、暫停、錯誤」，並顯示最後收到資料時間；程序存活不能代替實際收到事件。
- 搜尋／HTTP／AI 使用一致的時間、目標、來源篩選；常用條件直接可見，其他放進展開區。
- 詳情留在原頁，原始內容按需展開；跨日事件顯示日期與時區。
- 匯出前展示實際條件、事件數、附件選擇、遮蔽政策；完成後顯示實際路徑與遺漏項。
- 不另造四套搜尋器或更多主導覽入口；先讓現有畫面共用查詢與交付規則。

先前 scope 空設定顯示正常、HTTP 點擊跳 Timeline、body 截斷提示等問題已有後續 source 修正，不重列為本版未修缺陷；仍需新版實機回歸確認視覺與操作。

## 擷取涵蓋與插件

專案已存在 `src/core/plugins/` 與 tailer registry，宜強化既有介面，不再建立另一套插件框架。插件应宣告來源識別、schema 版本、專案歸屬、時間、健康狀態、checkpoint／去重策略和附件引用；核心統一保存、暫停、遮蔽、查詢、匯出。任意插件程式不能僅靠 manifest 就視為隔離安全。

以下是應列入「涵蓋矩陣」的驗收項目，而非全部確認缺失：

| 類型 | 要驗證的邊界 |
|---|---|
| 命令與終端 | 外部 terminal、遠端 SSH、tmux、背景工作、互動輸入、stdout/stderr、exit status；錄影不能保證還原每個結構化命令 |
| HTTP(S) | 是否實際經過 proxy／瀏覽器來源、未信任 CA／pinning、HTTP/3、串流、壓縮／二進位、大 body、重導／重試與配對不全 |
| 其他流量 | DNS、WebSocket、原始 TCP/UDP、工具自帶網路堆疊；連線 metadata 與完整封包內容應分開描述 |
| AI | 一訊息多工具、平行／子 session、重試、中斷、compaction、重啟半行、版本格式漂移、原始／接收時間 |
| 證據附件 | 截圖、cast、HTTP body、外部工具報告／pcap 的存在、hash、引用、scope 和交付選擇 |
| 持續性 | 磁碟滿、權限失敗、崩潰、睡眠恢復、來源輪替、離線補送、專案切換、保留期限 |

RedLog 可以作為統一紀錄入口，但沒有接上的來源不能宣稱已完整保存。用來源狀態與缺口資訊表達涵蓋度，比承諾「全部抓到」可信。

## 建議執行順序

1. 暫停語意與專案歸屬：PTY、AI、spool 一起驗收。
2. AI 原始保存與解析：多 block、來源時間、半行 checkpoint、來源輪替。
3. 交付正確性：回傳契約、scope body、附件引用、完整筆數。
4. 共用搜尋／匯出 filter 與畫面狀態，完成新版桌面與窄視窗操作驗收。

不建議此階段增加協查案件管理、清理任務追蹤、完整 SIEM 規則平台或 agent 編排。讓每筆紀錄知道「從哪裡來、屬於誰、何時發生、是否完整、如何交付」即可服務滲透、紅隊與紫隊協查需求。

## 補充核對：容易被誤讀的紀錄

以下於同日再次核對 `ec53448`。前三項以 TypeScript 編譯現有 `TranscriptView.tsx` 的 `buildBlocks` 純函式，再輸入合成事件重現；未啟動 UI、未接觸實際專案資料。其餘為 source review。

1. **AI 工具結果可能配錯 session。** 配對 map 只用 `tool_use_id`。合成 A/B session 使用相同 ID 時，A 的 result 被接到 B 的 call，A 留在 pending。需要 `(agent, session_id, tool_use_id)` 複合鍵；來源是否保證全域唯一不能由 renderer 自行假設。
2. **未知 exit status 被顯示成成功。** `Number(d.exit_code ?? 0)` 讓缺少 exit code 的 `command_end` 顯示 `exit 0`，純函式已重現。未知應顯示未提供，不能補成成功。
3. **已中斷的 AI 工具仍顯示 pending。** `buildBlocks` 不處理 `tool_interrupted`；輸入 call + interrupted 後仍只有 pending call，已重現。應呈現中斷，並区分沒有收到結果與仍在執行。
4. **複製 Markdown 靜默截斷輸出。** `copyAsMarkdown` 使用 `b.output.slice(0, MAX_INLINE)`，上限 4,096 字元，未在複製內容加截斷標記。畫面預覽長度不應默默成為交付長度；複製摘要需明示，完整內容另給入口。
5. **AI session 登記限制跨專案保留。** `tailer-host.ts` 的 `sessionRegistry` 為模組全域，空集合表示接受全部；登記第一個 ID 後改為 allowlist。`stopHost` 清 sessions 和 seed index，卻未清 registry；`src` 內未找到 `clearSessionRegistry` 呼叫。A 登記後切 B，B 新 session 可能被拒收。應讓 registry 綁專案生命週期，並在 UI 顯示目前是全部或指定 sessions。
6. **紀錄寫入錯誤會自動從健康狀態消失。** `capture-health.ts` 只保存最後一筆 DB error，60 秒後清除，毋須成功重試或操作者確認。這不能證明期間沒有缺資料；建議分開「目前可正常寫入」與「本次專案曾有未解決紀錄缺口」，保留来源、發生區間與恢復狀態。此項未主張其他日誌完全沒有錯誤資訊。

這六項仍屬紀錄的正確解讀、完整取用與來源狀態，無須新增大型功能。另需維持產品用語邊界：hash／驗章可協助檢查已保存資料的完整性，不能證明所有來源都被擷取，也不能證明來源所描述的行為確實發生。

## 2026-09-19 續查：協查與交付仍有的落差

以下以 `a8fa47e` source review 為準，尚未宣稱完成桌面實機驗收。

### 1. 「共用篩選」未真正套用所有顯示頁

頂端 FilterBar 同時提供 target、type、time 與 in-scope only，操作語意會讓使用者合理預期四項在 Search、Transcript、HTTP 與 Timeline 一致生效；目前實際套用如下：

| 頁面 | target | type | time | in-scope only |
|---|---:|---:|---:|---:|
| Timeline | 有 | 需再核對 lane 行為 | 有 | 有 |
| Search | **未傳後端** | 有 | 有 | **未套用** |
| Transcript | **未套用** | **未套用** | 有 | **未套用** |
| HTTP | 有 | 固定 scanner，無實質差異 | 有 | **未套用** |

具體原因：`searchEvents()` 與 IPC options 只有 `agentType/since/before`，Search 沒有傳 target；Transcript 的 `shown` 只檢查 time；HTTP 的 filtered 只承接 target/time。這是協查風險，不只是 UI 不一致：藍隊要求「某目標、某一小時內的 AI／shell 操作」時，切頁後會看到範圍外資料，還可能誤以為那是同一批結果。

最小修正不是再加 filter，而是建立一個可序列化的共用 filter contract，讓每個頁面明確回報「已套用／此頁不適用」。無法套用的條件應停用或標示，不能讓 chip 保持啟用卻被忽略。

### 2. 匯出預覽與實際匯出集合不一定相同

`ExportMenu.loadPreview()` 只把 `sharing` 傳給 `data:exportPreview`；後端 preview 永遠統計全專案。可是「目前 Timeline 視窗」和 HTTP HAR 實際匯出的是各自 slice/filter。結果是預覽顯示的 total、included、scope、body refs、screenshots 並非即將輸出的集合。

此外，ExportMenu 的「自用／交付」切換顯示在格式選單上方，視覺上涵蓋 evidence bundle；preview 也會按 sharing 計算 blacklist 與 metadata 規則，但 bundle 呼叫只傳 `maskOutOfScope`，bundle options 沒有 sharing／maskMetadata／blacklist。Bundle 本身會處理 do-not-export、personal domain 與 scope，卻不等於 preview 所呈現的 sharing 規則。這會造成「預覽說已排除，成品政策卻不同」的高風險落差。

最小修正：preview 與 execute 共用同一個 `ExportRequest`，包含 format、view filter、sharing、scope policy 與附件政策；後端先解析成一個確定的 export plan，預覽與執行都使用該 plan。成品 manifest 再列出實際包含／排除數量，避免只信執行前預估。

### 3. Search 後端失敗仍像正常的空白／舊結果

Search 的 promise catch 只關閉 searching，沒有 error 狀態、原因或 retry；cast search 失敗則直接設空陣列。對一般 App 只是體驗問題，對紀錄工具會把「查詢失敗」誤讀為「沒有事件」。應將 no result、indexing、query failed、partial source failed 分開顯示，並保留重新查詢入口。

### 4. AI Transcript 仍是有上限的閱讀視圖，不是完整查詢結果

目前已改善為按類型平衡查詢，但仍為固定上限：agent 800、shell 400、scanner 300 等，再合併後在前端搜尋。這避免單一來源擠掉其他來源，卻仍可能漏掉較舊的指定事件，而且頁面沒有顯示「只載入最近 N 筆／仍有更多」。藍隊按 session、tool ID、event ID 找事件時，不應依賴這個前端子集。

建議沿用目前新增的 `EventCursor + QueryPage` 分頁 primitive：Transcript 顯示載入範圍與 load more；精準搜尋走後端，至少支援 event ID、session ID、tool-use ID、flow ID、operator、target 和時間。這仍是紀錄取用能力，不是 SIEM。

### 本輪收斂後的優先順序

1. 讓 preview 與實際 export 使用同一份 plan，先消除交付政策誤述。
2. 統一 shared filter contract，特別是 Search target／scope 與 Transcript target／type／scope。
3. Search 顯示 query failure，避免把失敗當成零結果。
4. Transcript 接上後端分頁與精準識別欄位查找。

這四項都直接服務「快速找到某事件」與「確認匯出的確是眼前這批資料」，沒有偏離 RedLog 的核心。
