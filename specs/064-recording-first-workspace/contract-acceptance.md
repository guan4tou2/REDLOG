# 跨層契約驗收案例

**Status**: 端到端未完成；C1 查詢與 macOS origin 有局部驗證，見 verification.md · 2026-10-26。CT 是語意驗收 ID，不代表新增十六支 E2E 或每案重開 App。沿 [acceptance.md](acceptance.md) 的版本／平台／成品證據規則，同 fixture 優先在適合的 query／reader／ingest／export 邊界驗證；真實 Terminal App 及原生權限另做手動驗收。

| ID／階段 | Given／When | Then：可觀察通過條件 | 契約／需求／狀態 |
| --- | --- | --- | --- |
| CT-01 · S2 | 同一來源有 command／tool ID；Result 晚到、重送、跨頁，切換查詢／閱讀模式再重建投影。 | Activity ID 不變、沒有第二次操作；原 Event 深連結可達；全量翻頁命中／群組集合正確。新資料不搶閱讀位置。 | C1 · FR-008/010/012/017/018/046 · PARTIAL：query／IPC 已驗，閱讀錨點未驗 |
| CT-02 · S2 | Result 先到、缺鍵孤立、同 ID 跨 provider／Session、同鍵不同 payload；後來取得可靠來源關聯。 | 有鍵可補同組，無鍵不猜配對；衝突可查原版本；原 Event 仍能定位，缺 Result 不當 running／failed。 | C1 · FR-009/010/013/014/046 · PARTIAL：query／IPC 已驗，完整 UI 未驗 |
| CT-03 · S2 | 關鍵字分別只在 Event、文字 body／stdout／stderr ref、base64 解碼內容、AI raw JSONL、cast 尾端、一般附件及圖片。 | 每類回實際 covered／partial／pending／unsupported 等狀態與版本／範圍；可讀不冒充可搜，未索引不說零證據；命中定位精度真實。 | C2 · FR-019/020/047 · PASS：2026-10-28 DB／unit＋macOS source Electron；只含確認保存範圍、binary 不解析，見 verification |
| CT-04 · S2 | 同查詢套 target／來源／時間條件；部分 cast 缺 metadata，索引失敗、追加、改寫或 retention，並有新事件與慢舊回覆。 | 條件先於分頁，不混未篩選結果；watermark／cursor／計數同邊界，陳舊命中如實處理；新查詢不被舊回覆覆蓋。 | C2 · FR-015–021/047 · PASS：2026-10-28 query／pagination／read-state／retention＋macOS source Electron；新安裝包及其他 OS 未驗 |
| CT-05 · S3 | 預覽固定 Event／附件，接著 Result、stdout chunk、cast 新分段到達，原檔只追加。 | 成品只含確認時 IDs／必要 companions／附件 prefix；後到內容不加入，原 prefix hash 相符；更新預覽才擴大集合。 | C5 · FR-037/038/048 · NOT RUN |
| CT-06 · S3 | 預覽後附件同大小改寫、截短、同名替換、清理；讀取到複製間改寫，或政策收緊／切專案。 | 具體失敗或重新確認，不無聲少交／換件；不能繞過收緊政策；已執行 A 不改歸 B，失敗成品不冒充成功。 | C5 · FR-024/038/048 · NOT RUN |
| CT-07 · S3 | 一段 PTY 含 A／B 目標及無歸屬片段；只選 A 的事件，或明確選整 Session。 | 子集合匯出不預選跨目標／未知整段 cast；可逐項加入並重新確認。整 Session 明示範圍及政策限制，無法裁切不宣稱 scope-clean。 | C5 · FR-037–039/048 · NOT RUN |
| CT-08 · S1 | 同一 OS 的真實 Warp 與另一 App 跑相同 Shell；環境提示偽裝、缺失或與程序身分衝突；選只記 Warp。 | 只接受可信正向 origin；其他／unknown／conflict 無新增落盤、sidecar／spool。只有環境條件測試不能標通過。 | C6 · FR-004/029/049 · NOT RUN |
| CT-09 · S1 | 已辨識來源開子 Bash／Zsh、PID 重用、背景輸出、tmux detach／重接、SSH／WSL；另測偽造內建 PTY 旗標。 | 只有可證明 lineage 才繼承；來源鏈斷須重驗或拒絕。內建來源由 owned PTY 證明，不因任意旗標繞過；unsupported 環境不宣稱隔離。 | C6 · FR-004/006/049/053 · NOT RUN |
| CT-10 · S2 | Claude Code／Codex 的 execute、file-read／write、search、browse、custom／unknown 工具與一般回答。 | 只把已知執行工具分類 Command；其他 I/O 可讀可查，保留原名／來源／未知；不推定已保存檔案、獨立 HTTP／Shell 或成功。無 OpenCode 官方入口。 | C1 · FR-009/013/014/027/050 · PARTIAL：query 分類已驗，共用 Reader 未驗 |
| CT-11 · S3 | Shell、AI、HTTP 均有十 MiB 文字，唯一關鍵字在未載入尾端；分段讀取、全文 Find、取消，另有 binary／缺件。 | 三者遵循同一來源版本與 cursor 語意、無無界讀入；能找完整已保存範圍的命中，受限範圍／失敗不當零結果；不需要相同視覺。 | C2/C3 · FR-020/022–024/051 · NOT RUN |
| CT-12 · S3 | 選片段／複製全部／取 raw；側欄全寬切換、返回、live 追加、讀取失敗重試或來源版本改變；含 ANSI／Markdown。 | 複製範圍正確無偷偷裁切，位置／搜尋／選取保留；版本不同不無聲換內容；重試不重跑命令；閱讀無網路、執行及剪貼簿副作用。 | C3 · FR-022–027/044/051 · NOT RUN |
| CT-13 · S3 | 含 emoji／多 byte 中文、CRLF、ANSI 游標移動、跨 UTF-8 視窗及三個 cast part；建立搜尋命中／正式標記再重開。 | byte／文字／cast 座標分開且綁版本；精確映射可驗原 bytes，無映射降級；不得把 UTF-16 index、時間或邏輯跨檔 offset 冒充實體 raw 位置。 | C4 · FR-035/052 · NOT RUN |
| CT-14 · S3 | 標記後來源移動、同名替換、內容改寫、retention／附件不可讀或索引尚留舊片段。 | 原 Event／標記仍在，原件或位置不可用如實顯示；保留摘錄不冒充原件，不跳同名新檔；依清理政策處理衍生索引。 | C2/C4 · FR-024/034/035/047/052 · NOT RUN |
| CT-15 · S1 | A→B→A 切專案；外部 enrollment、仍活著的內建 PTY、AI vendor Session、HTTP flow、來源重啟及舊 spool。 | binding／檔案／Event 正確分離；不以目前專案收舊資料，舊 generation 不寫 B，恢復 UI 不等於程序延續；新授權不追補未授權區間。 | C6 · FR-006/007/030/032/053 · NOT RUN |
| CT-16 · S1 | 暫停／停止／改授權目錄／排除 Session 時已有 queue、來源批次跨邊界及延遲送達；保存失敗後恢復／重試。 | 後端 ack 後才宣稱生效；已准許 prefix 可讀，被拒原文不落 sidecar／索引／spool，不在恢復後追補；未知缺口不填零，失敗不推進為成功。 | C6 · FR-011/024/029–032/053 · NOT RUN |

## 結果紀錄

每案記錄來源輸入／預期集合／實際 Event IDs、binding、檔案內容 hash／prefix、查詢覆蓋及必要成品。文件定義、合成 fixture、環境變數分支、單平台 CI 不能取代來源實跑或別的平台結果。

失敗注入需區分缺少環境與產品缺陷；相同資料可合併為少量 table-driven／integration tests，不要求十六個 GUI 流程。平台不支援可信 App origin 時，CT-08／09 的安全降級可驗證，但該平台「只記 Warp」仍須標 UNSUPPORTED，不可混寫功能通過。

## 2026-10-30 局部補驗

CT-15／16 的 HTTP flow identity、暫停／延遲 segments、拒絕不 spool 與實際 ENOSPC 重試，以及 snapshot 內 SSE／WS HAR companions，已補 source／成品案例，來源 hash 與實際結果見 [063 verification](../063-long-recording-segments/verification.md)。這些是局部證據，不涵蓋表列所有來源與操作；原 CT 狀態保持。契約映射檢查只驗結構與文件存在，不執行測試或自行升級狀態。
