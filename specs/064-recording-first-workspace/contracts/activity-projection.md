# C1 — Activity 投影身分與工具分類

**Status**: Draft contract · 2026-10-26。穩定身分、群組查詢與來源分頁已接 core／IPC；現有列表尚未切換，完整驗收仍未完成，見 verification.md。適用 FR-008–014、FR-046、FR-050；驗收 CT-01／02／10。

## 1. Activity、Event、Evidence

Activity 是供閱讀的操作投影；Event 是已保存的來源事件；Evidence 是輸出、錄影、附件及來源內容。投影不得改寫 Event、保存 tier 或證據雜湊。Activity 同時保存來源事件集合、配對依據、配對狀態及可用的 Evidence 參照。

Activity ID 不採列表序號、目前頁碼、PID＋文字、時間接近或可變標題。規劃採具版本的確定性鍵：`act1:` 加上 canonical tuple 的 SHA-256。tuple 以固定順序 UTF-8 JSON array 編碼，不自行 trim／小寫化 opaque IDs。這是投影識別，不是證據雜湊或新寫入層。

| 操作 | 鍵的必要身分 |
| --- | --- |
| Shell 指令 | project、producer namespace、來源 Session、錄製 binding、command ID。 |
| AI Tool | project、provider、來源 Session、錄製 binding、tool-use／call ID。 |
| HTTP 交換 | project、producer namespace、錄製 binding、flow ID。 |
| AI 訊息 | project、provider、Session、binding、可靠的來源 message ID。 |
| 缺可靠來源鍵 | project、來源 Event ID；不以相似內容強行配對。 |

binding 是 [C6](capture-boundaries.md) 的歸屬邊界；若來源缺少它，沿用可證明的來源 namespace／Event fallback，不補造身分。目標、文字、時間、結果、配對狀態及排序均不得進入穩定鍵。

## 2. 晚到、重送與衝突

- Result 先到且帶可靠 Session／tool ID 時，使用與日後 Call 相同的操作鍵；補齊只更新原 Activity。Call-only、result-only、paired、interrupted、conflicted、unknown 分開，缺 Result 不直接顯示 running／failed。
- 缺少配對鍵的孤立事件維持 Event-backed 定位。日後取得可靠關聯可附屬於已知操作，但原 Event 深連結仍定位原事件；不得因重新分組使原連結失效或憑空生成第二次執行。
- 真正重送須同時核對來源鍵及內容識別；已保存的多筆 Event 仍保留參照。相同鍵卻不同內容，呈現衝突／原始版本，不採最後寫入覆蓋。
- AI Tool 與獨立 Shell／HTTP 觀測保留各自身分。只有可驗證的 execution／trace 關聯才能連為相關證據；相同文字與時間不構成此證明。建立關聯不重寫原操作 ID。

## 3. 查詢、排序及定位

投影規則有版本；同一資料邊界內，查詢方式、翻頁、重開頁面及閱讀模式不能改變操作 ID。來源時間及接收時間分開，主要排序以操作起點的穩定順序鍵及 ID 打破同時事件；結果晚到不改成結果時間排序。只有 Result 的操作日後補起點可能需要重新定位排序，但非跟隨模式須保留可見閱讀錨點並提示更新，不無聲跳頁。

群組解析必須能找回未在當頁的配對來源，不先對一頁分組後冒充全專案群組數。回傳語意區分 `matched Event IDs`、`context Event IDs`、`Activity source IDs`；背景不能增加命中數，也不能默認加入交付集合。cursor 與群組計數須綁同一查詢／資料邊界。無法取得總數就回 hasMore／部分集合，不能用當頁長度估計。

來源事件 deep link 是最小穩定落點；Activity link 同時帶投影版本與來源參照，重建後無法精確還原時回原 Event 並明示限制，不跳到相鄰事件。

## 4. AI Tool Action

工具分類依 provider 已知 schema／受控宣告，保留原始名稱、參數及結果。不得以名稱包含 Bash、回答文字或 LLM 猜測執行事實。

| Tool Action | 顯示／查詢語意 |
| --- | --- |
| execute | 已知執行工具才歸 Command；仍標 AI 回報，不能冒充獨立 Shell 觀測。 |
| file-read／file-write | 工具讀寫操作；回報寫檔不等於 RedLog 保存該檔案版本。 |
| search | 工具搜尋操作；保留查詢與結果來源。 |
| browse／network | 工具瀏覽／請求回報；不冒充 RedLog 獨立擷取的 HTTP Flow。 |
| custom／unknown | 通用 Tool Input／Result，分類未知仍可讀、可查、可匯出。 |

非 execute 工具沿既有對話／工具操作呈現，保留 toolAction 子類，不新增主選單或一律塞進 Command。兩個 provider 的 adapter 負責來源欄位正規化，共用投影負責分類語意；未知狀態不能臆造 exit code 或成功。官方範圍只有 Claude Code、Codex。

## Implementation checkpoint

`src/core/activity-projection.ts`／`activity-contract.ts` 定義 canonical key／分類與資料契約，`db/activity-queries.ts` 共用 `event-queries.ts` 的命中條件。SQLite TEMP projection 僅隨目前 read connection 存在，關專案即丟棄；它是衍生索引，不能進證據包或改寫 Event。新列增量建索引，來源清理及查詢失敗後重建。操作身分不依賴索引生命週期。

目前已有 group page、member page、snapshot 及可信 project／scope IPC，並有 query／Electron 整合證據。Activity UI／搜尋覆蓋／Reader／Export 尚未完成，不能把本 checkpoint 當導覽退場或整份 C1 驗收通過。
