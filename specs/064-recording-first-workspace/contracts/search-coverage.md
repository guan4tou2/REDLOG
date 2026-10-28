# C2 — 搜尋覆蓋、索引及命中位置

**Status**: Draft contract · 2026-10-26。適用 FR-015–021、FR-047；驗收 CT-03／04。全域搜尋、整份內容搜尋與目前載入區塊尋找是不同範圍。

## 1. 覆蓋清單

每次專案搜尋須能取得覆蓋清單：project、查詢／資料邊界、內容類型與呈現版本、索引 revision／watermark、已涵蓋內容長度或範圍、支援／已套用／不支援的條件、定位精度及狀態。狀態至少區分 covered、partial、pending、unsupported、failed、unavailable；不能以單一「索引完成」代表全部證據。

| 內容 | 必須核對的覆蓋與限制 |
| --- | --- |
| Event inline 文字／JSON | 兩個 tier 的實際索引欄位及文字上限；事件有附件不代表附件已入索引。 |
| stdout／stderr／HTTP 文字 sidecar | 依各 ref 判定是否已索引、已涵蓋 bytes 及來源版本，不依檔名推測。 |
| base64／binary 輸出 | 原字串、解碼文字與原始 bytes 是不同表示；未做解碼索引不能宣稱可搜解碼後內容。 |
| PTY cast | 哪些 Session／實體分段／完整 frame 已入索引；尚在追加的尾端另標 pending／partial。 |
| AI 原始 JSONL | Event 已保存的訊息與完整 raw sidecar 分開；前者可搜不表示後者全部可搜。 |
| 一般附件 | 檔名／metadata 搜尋與內容全文搜尋分開；只列檔名不算內容索引。 |
| 圖片及非文字檔 | 不承諾 OCR、二進位語意搜尋或新解析器；明示不支援的內容範圍。 |

現況盤點：Event FTS、文字 body index、cast index 可以沿用。文字 ref 的 backfill 涵蓋登錄欄位，live link 的來源路徑與 base64 支援並不相同；cast 可能等待結束／backfill；一般附件及 AI raw JSONL 沒有一律全文索引保證。這些是待補覆蓋回報的依據，不是新增引擎的理由。

## 2. 完整性、條件與計數

- 查詢先套全部條件再分頁。某類索引缺少 target／來源／時間等必要 metadata 時，不混入未篩選的結果；可以排除此類並標部分覆蓋，或要求明確調整條件。不得靜默忽略條件。
- 零命中只代表已涵蓋的資料範圍；未索引、失敗、不支援、被授權拒絕不能當作零筆證據。完整覆蓋且成功時不另加一大段說明；只在限制影響判讀時顯示必要狀態及動作。
- `hasMore`、已知總數與未知總數分開；cursor、計數與命中固定同一 query snapshot／index watermark。持續新增資料不使已翻完的集合突然被宣稱全量最新。
- 同一內容的 Event 預覽與 sidecar 命中可去除重複呈現，但保留所有來源參照；不得當作兩次獨立操作。原始 Event 命中數、內容片段數、操作群組數及背景數各有單位。
- 索引只能涵蓋此專案已獲准保存的內容。搜尋不能重新讀取未授權的 vendor Session 或以索引作為繞過暫停／排除的入口。

## 3. 定位及生命週期

命中包含來源 Event／Session／Evidence ref、版本與 [C4 anchor](evidence-anchor.md)。全文命中可開 [C3 Viewer](content-viewer.md) 對應範圍；只取得檔案／時間定位就如實標精度，不虛構 byte offset。命中折疊子事件時展開該操作，背景另標示。

索引狀態必須與原始內容版本或已確認的不可變 prefix 連結。追加只影響新增範圍；改寫、截短、retention、附件遺失應使索引失效或標陳舊。既有索引片段不冒充目前可讀原件；清理政策也涵蓋衍生索引，不能清掉原件卻無聲留存全文。

完整內容內搜尋可採有界掃描或既有索引，不要求每種來源先做永久索引。若只能搜已載入區塊，控制名稱及結果範圍必須限定該區塊，不能叫「搜尋完整內容」。取消／失敗保留既有閱讀位置，不回報成功零結果。

## 2026-10-27 implemented slice

登錄的 UTF-8 body refs 不再因單份超過 16 MiB 而整份略過。衍生索引升為 v4，自動重建，來源 Event／body 不改寫；每次讀入最多 1 MiB，以 tokenizer 邊界分段並保留有界重疊。巨大單一 token 沿 SQLite FTS5 自身 32768-byte 上限處理，不將 token 尾端另造假命中。多關鍵字交集可跨同一 body 的各段，不能把同 Event 的 stdout／stderr 不同檔案湊成同份全文命中。

每次查詢仍核對來源版本，遺失／改寫保留 coverage 錯誤並移除舊命中；binary 不冒充文字索引。這不新增 AI raw JSONL、一般附件、圖片 OCR 或所有 Cast 的全文覆蓋承諾。

## 2026-10-28 implemented slice — saved source coverage

- 沿用 body FTS，衍生 schema v6；只重建 cache。一般附件只讀 `artifact_added` 登錄的專案 `artifacts/` 副本，核對完整 size／SHA-256；不追讀原始匯入路徑。UTF-8 文字可搜，binary／圖片不做 OCR 或格式解析。小型 inline base64（encoded ≤16 KiB）與 Reader 共用解碼；超限明示 limited，不把編碼字串冒充解碼全文。
- AI raw 只讀 `transcript_snapshot` 確認的專案 `agent-transcripts/` prefix，核對 cumulative bytes／hash；每個 dataset 內每實體檔案只索引最新確認 prefix，避免累積 snapshots 重複全文。舊查詢沿其 snapshot 選舊 prefix；明選舊 Event 仍可讀其確認版本。capture_started 無確認 prefix、尚未確認的追加尾端維持 pending，不讀 vendor 檔案或追補排除區間。
- Raw prefix 只有檔案精度，不能證明其中每行的 target／時間／tool／event／operator／source／scope／privacy／tier 歸屬；這些條件排除 raw 全文匹配並回 unsupported filters。已保存 Event 的對應欄位仍依 canonical query 求值，不因此整案失敗。Session／provider 等可靠擁有者條件仍依 owning Event 求值。
- Coverage 列出 project／dataset、events／saved body／artifact／raw 的 representation、revision、來源與索引 bytes、適用條件、定位精度及 covered／partial／pending／unsupported／failed／unavailable。完整成功時維持安靜；失敗、缺件、binary、pending 與超限顯示必要狀態。Event 與 Activity 的文字查詢 cursor 固定 dataset 與 coverage revision，count 同邊界；範圍內來源改變要求 refresh，新增範圍外 Event 不混入舊頁。
- Cast schema v2 只索引 newline 完整 frame 的確認 prefix，命中綁 prefix hash／bytes 與實體 part 的 raw byte range；開啟前後再驗版本。追加尾端 partial／pending，同大小改寫與缺檔清掉舊全文；清理保留無全文的 unavailable metadata，不冒充全部就緒。保留既有每檔 60 MiB 上限，單行緩衝超過 1 MiB 明示 unsupported；壞 JSON／UTF-8 failed。AND 可跨同一實體錄影片段，不能跨檔湊命中；frame 切點不另造 token 邊界。

這一批不改 SQLite FTS token／prefix 語意，不新增文件解析器，也不宣告 C3/C4 全閱讀模式／轉換座標對等或整份 Spec 064 Verified。
