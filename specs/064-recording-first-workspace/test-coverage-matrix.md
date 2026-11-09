# Spec 064：目前測試覆蓋與執行責任

## 目前來源碼驗證（2026-11-09）

基準：main `c614cbf3`，macOS 27.0.1 arm64、Node v26.13.0、Electron 44.4.1。完整 unit **5932 passed／41 skipped**；主要 Electron 使用流程 **110 passed**，插件／來源設定另補 **8 passed**，兩組選取沒有重複 spec。此為來源碼正式建置，不是新安裝包或全平台人工驗收。

[main CI](https://github.com/guan4tou2/REDLOG/actions/runs/42573715951) 的 Windows／macOS／Ubuntu unit 與 Linux Electron 三個 shard 已全部成功。CI 的「architecture」只驗 export 可達性，不代表完整架構收斂完成。

| 能力 | 目前證據／覆蓋責任 | 尚缺的驗收 |
| --- | --- | --- |
| 專案、主導覽、首次設定 | `e2e/app-shell.spec.ts`、`e2e/first-run.spec.ts`；七個主入口、設定、Scope、來源導向、重複 Enter 與終端返回 | 新 macOS 安裝包、全新使用者完成率及 OS 權限 |
| 活動／Session／Transcript | `e2e/evidence-views.spec.ts`；Session、查詢、Reader、Timeline 往返、閱讀中新增事件、跨專案清理 | CT-01／02 全部配對與錨點組合、真實使用者任務量測 |
| 已保存 cast／外部 PTY | `e2e/cast-content-reader.spec.ts` 的固定 2 MB cast 分頁、尾端搜尋、逐位元組另存；`e2e/external-session.spec.ts` 的實際 PTY canary | 新包的真實長指令／多終端／Terminal App origin；固定 cast fixture 不代表真實 producer 擷取 |
| HTTP 與恢復 | `e2e/network-state-recovery.spec.ts` 的 failed → starting → running；HTTP Reader／scope／request-response 在主要 110 案內 | 系統 CA／真實瀏覽器信任與路由；先前真實 mitmdump 證據見 dated record，不以 UI seed 取代 |
| 官方 AI 安裝與授權 | `e2e/official-agent-capture.spec.ts`：經插件頁安裝、返回來源、授權、正式 watcher 讀 JSONL、排除／停用／移除、歷史讀回 | JSONL 為合成 fixture，未驗證真實 Claude Code／Codex 客戶端產生完整流程 |
| 插件探索／來源設定 | 補驗 `e2e/plugin-explore.spec.ts`、`e2e/capture-settings-interaction.spec.ts`，8 passed；搜尋、需處理、單欄返回、讀取失敗、保存重試、雙語及 800px／200% | 更新／解除安裝中斷與非受管檔案的完整失敗矩陣；本機匯入屬另批能力 |
| 匯出 | `e2e/export-preview.spec.ts` 與 `evidence-views` 的預覽／固定選取／政策／重試／成品讀回；unit owns snapshot／hash／遮蔽 | CT-05–07 的完整附件／跨目標成品矩陣；完整有界查詢與 bundle／HAR 收斂另由 #661 |
| Reader 狀態 | 共用 ContentDescriptor／ContentRef、cast／HTTP／AI 的現有 unit 與 E2E | #591：Shell／HTTP／AI × 五種內容狀態 × 活動／Timeline／Reader 的同資料結論矩陣 |
| Pivot／IP／CDP | `e2e/network-state-recovery.spec.ts` 與對應 unit；失敗不等於無節點、IP 獨立恢復、CDP timeout／retry | 真實瀏覽器掉線／重新接入及系統環境人工驗收 |
| 版面／色彩 | `visual-reference` 三組截圖、實際檢視部分主要頁面；design tokens／palette unit | 截圖擷取不是全部頁面像素驗收；#592 的任意值 hex 守門與按鈕語意仍需處理 |

詳細執行選取、41 項 skip 原因與證據層級見 [本輪執行紀錄](../../docs/records/2026-11-09/MACOS-TEST-CLOSEOUT.md)。完整 UX／CT 仍以 [acceptance.md](acceptance.md) 及 [contract-acceptance.md](contract-acceptance.md) 逐項為準，不因 unit 或 GUI 通過數量直接升級全部契約。

## 尚未完成：依 macOS 優先排序

| 順序 | 工作與完成條件 | 追蹤 |
| --- | --- | --- |
| 1 | 從固定乾淨 commit 建立 macOS 安裝候選；核對 Build／資源／簽章／hash，跑 installed recording → export → restart smoke；另驗 Gatekeeper、權限與一般退出提示 | #226、#457 |
| 2 | 真實 Terminal App／Shell、實際瀏覽器 HTTPS 與 AI 客戶端，各完成接入 → 新資料保存 → Reader → 交付；保留失敗恢復與來源依據 | #593、#434、#489；CT-08／09 不以環境旗標取代 |
| 3 | 補齊 Reader 五種狀態的跨視圖矩陣、特殊 producer payload 與讀取失敗重試；區分未知／未擷取／已保存不可讀 | #591、#546、PR #565 |
| 4 | 確認 token 任意 hex 守門及按鈕例外，完成空／載入／錯誤、鍵盤與視覺人工檢查；五人使用者量測仍未執行 | #592、#558、#457 |
| 延後 | 原 Windows 約 200k 事件端到端效能；不以 macOS 子基準或 PowerShell 安裝 smoke 代替 | #660（#587 子項） |
| 獨立工程 | Timeline 剩餘 controllers、匯出查詢陣列／bundle／HAR、共用來源與事件契約 | #661、PR #584（規格 Draft） |

Marketplace、本機匯入、第三方可執行 UI、Burp／DNS 等新增來源不得因本表自動變成當前版本必做的驗收項。

## 歷史子能力盤點（d2917021 安裝包）

以下保留舊 Mac arm64 DMG，SHA-256 `0a3042357c6c4c5da7166f0da814a69ad963dad431edc93edf5ff2836a13de7e` 的證據。它不是 c614cbf3 安裝版；下表的舊進度不取代上方目前來源碼矩陣，也不回填完整 UX／CT 的 NOT RUN。

| 能力／對應 | Unit／DB contract 責任 | Electron／安裝版證據 | 原生人工／尚缺 |
| --- | --- | --- | --- |
| Shell I/O／UX-01、04、05 | ingest、external-session、relay-late-output、terminal-origin | d291 DMG：真實外部來源 recovery、內建終端 exit／cast、bundle verifier、重啟讀回 | Windows／WSL／Kali 新候選 NOT RUN；多終端全部邊界未完成 |
| HTTP(S)／UX-02 | http-verify、managed-http-capture、http-body-store | d291 DMG：真實 loopback HTTP、HTTPS nonce，client --cacert | 系統 CA／下載 Gatekeeper／真實瀏覽器 trust 人工 NOT RUN；不能用 curl 信任代替 |
| AI／UX-08、14 | agent policy、parser／durability／Session boundaries | d291 DMG：Claude Code／Codex 合成 JSONL、選裝／授權／排除／移除 | 真實 AI 客戶端完整人工流程 NOT RUN；不把 fixture 當真人對話 |
| Activity query／UX-06、CT-01–04 | activity-query、http-body-search、cast-index、query-page、read-state | d291 DMG：17 MiB body、匹配/context、來源內容、原始 Event 返回；2026-10-28 source build：保存文字附件／AI prefix／cast 搜尋與原文讀回 | 新增搜尋範圍尚未做安裝包／其他 OS 驗收；binary 不做 OCR／格式解析 |
| Reader／UX-07、10、CT-11–14 | evidence-content、ContentRef 與來源版本 | d291 DMG：有界視窗、Find、stdout／stderr、原生 resize | 全閱讀模式位置復原／fragment anchor 尚缺 |
| Activity／Session export／UX-13、CT-05–07 | filtered-export、export-plan、export-attachment-freeze | d291 DMG：JSON／Bundle、附件 opt-in／prefix、成品讀回；NDJSON 固定成員及部分故障由 DB／IPC 測驗證 | 完整 C5／全部平台／跨來源矩陣未齊 |
| 安裝與首次接入／UX-01、03 | build-source-status、來源設定狀態測試 | d291 DMG：mount／ditto 安裝副本、About exact Build、FirstRun 11 cases | 全新使用者無人協助完成率與 OS 權限 NOT RUN |
| 關窗／退出／UX-17 | quit policy／lifecycle unit | E2E 會略過退出確認，不能作原生提示證據 | d291 DMG、非 E2E：實際確認代理停止警告；取消／關窗服務繼續，停止並結束後 API／proxy 停止 |
| 五頁導覽／Settings 整併／UX-19 | 尚未全面實作 | NOT RUN | NOT RUN |

## 避免重複驗證

- Unit／DB owns 配對、完整性、固定選取、失敗及來源隔離。Fixture 依現有 export-fixtures／各 domain 特殊身分使用；不把 capture/provider namespace 隱藏在一份萬用預設裡。大量 SQL fixture 使用 transaction，不以增加 timeout 代替。
- E2E owns 真正跨 renderer／preload／IPC／disk 的一條任務；不為每個按鈕另開 App。正常錄製交付的本機預設只跑 `npm run e2e:smoke`；其餘依 [TESTING](../../docs/TESTING.md) 變更矩陣選取。
- Installed smoke owns 真實 resources、native modules、hook、verifier 及重啟。重建後只跑受影響選取，不串入未變的 AI／FirstRun／Settings 全量。
- Native acceptance owns OS／終端 App 身分／權限／一般模式確認；不把 E2E bypass 視為通過。
- Timeline 仍在產品內。排序、定位、虛擬化等契約保留；等 Activity parity 完成才遷移泳道特有斷言。本批不刪舊 UI 測試、不加相容 shim。

## 歷史整理批次的驗證界線

當時的整理批次沒有啟動 App。CI path／單一 smoke 入口／report validator 使用非 GUI 測試；FirstRun 固定等待改為明確畫面與 PID 條件，只做 Playwright collection。這些歷史結果不取代頁首目前候選的實際執行證據。

## 2026-10-29 後續來源碼驗證

本次核對基準為 `2dd45465`，測試對象是其上的未提交工作區修復，並非上表 DMG。
歷史成品 SHA-256 與測試基準保留原值。

- `e2e/project-open-rollback.spec.ts`：macOS 原始碼 Electron 4 PASS；設定寫入、DB open／pragma、來源設定初始化失敗，以及重開與跨專案 spool 歸屬。
- FirstRun 父子整合測試：HTTPS capture 與 CA trust 分開；未證明 CA 信任時核心擷取就緒仍只代表 capture，重試撤銷 readiness。
- 安裝包／Windows／WSL／Git Bash、真實磁碟滿及程序中斷矩陣仍 NOT RUN；本次不將 CT-15／16 或 UX-01–19 整體改為 PASS。

完整執行證據與限制見 [核對與修復紀錄](../../docs/records/2026-10-29/REVIEW-FOLLOWUP-2026-10-29.md)。


## 2026-10-29 UIUX v3.2 工作區候選

詳細逐項結果、格式／載體政策矩陣、30 次 warm 效能 p50／p95 與最終執行結果見 [UIUX 完成紀錄](../../docs/records/2026-10-29/UIUX-COMPLETION-2026-10-29.md)。本候選以 `2dd45465` 加未提交修改建立，不沿用歷史 DMG 的 SHA-256 或原生驗收狀態。

新增涵蓋 HTTP 驗證歷史與失效、HTTPS 真實 capture、跨專案隔離；scope 讀取失敗狀態與規則候選顯式確認；三類 17 MiB 內容與共用 Reader；三格式實際 PII 成品、原始附件警告及終端焦點／zoom。既有 pause／rotation／export／causal graph／rollback 依變更重測。

Windows／WSL／Git Bash／Linux、五位使用者任務、原生權限與真實 ENOSPC／程序中斷統一由 [#457](https://github.com/guan4tou2/REDLOG/issues/457) 追蹤；未執行格維持 NOT RUN／BLOCKED，Spec 064 不改為 Verified。


## 可檢查的 CT 映射

[coverage-manifest.json](coverage-manifest.json) 連結全部 CT-01–16 與既有測試、平台限制及原驗收證據。`npm run verify:specs` 會檢查 ID 完整性、檔案存在與 `contract-acceptance.md` 狀態一致。此檢查不是執行測試、不判定原生 PASS，也不從這張能力盤點反推完整 CT 通過。
