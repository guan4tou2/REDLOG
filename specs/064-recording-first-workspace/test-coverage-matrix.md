# Spec 064：目前測試覆蓋與執行責任

基準：main `d2917021`／Mac arm64 DMG，SHA-256 `0a3042357c6c4c5da7166f0da814a69ad963dad431edc93edf5ff2836a13de7e`。這張是目前子能力盤點；[acceptance.md](acceptance.md) 的完整 UX／CT 及五人／全平台門檻仍未全部通過，不回填歷史 NOT RUN 為全面 PASS。

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

## 本批驗證界線

本批整理不啟動 App。CI path／單一 smoke 入口／report validator 使用非 GUI 測試；FirstRun 固定等待改為明確畫面與 PID 條件，只做 Playwright collection。新的等待條件須在下一次已安排的 E2E／CI 驗證，不能因此把本批標成全產品 E2E 通過。

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
