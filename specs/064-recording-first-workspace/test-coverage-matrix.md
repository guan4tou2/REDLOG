# Spec 064：目前測試覆蓋與執行責任

基準：main `d2917021`／Mac arm64 DMG，SHA-256 `0a3042357c6c4c5da7166f0da814a69ad963dad431edc93edf5ff2836a13de7e`。這張是目前子能力盤點；[acceptance.md](acceptance.md) 的完整 UX／CT 及五人／全平台門檻仍未全部通過，不回填歷史 NOT RUN 為全面 PASS。

| 能力／對應 | Unit／DB contract 責任 | Electron／安裝版證據 | 原生人工／尚缺 |
| --- | --- | --- | --- |
| Shell I/O／UX-01、04、05 | ingest、external-session、relay-late-output、terminal-origin | d291 DMG：真實外部來源 recovery、內建終端 exit／cast、bundle verifier、重啟讀回 | Windows／WSL／Kali 新候選 NOT RUN；多終端全部邊界未完成 |
| HTTP(S)／UX-02 | http-verify、managed-http-capture、http-body-store | d291 DMG：真實 loopback HTTP、HTTPS nonce，client --cacert | 系統 CA／下載 Gatekeeper／真實瀏覽器 trust 人工 NOT RUN；不能用 curl 信任代替 |
| AI／UX-08、14 | agent policy、parser／durability／Session boundaries | d291 DMG：Claude Code／Codex 合成 JSONL、選裝／授權／排除／移除 | 真實 AI 客戶端完整人工流程 NOT RUN；不把 fixture 當真人對話 |
| Activity query／UX-06、CT-01–04 | activity-query、http-body-search | d291 DMG：17 MiB body、匹配/context、來源內容、原始 Event 返回 | Cast generation、raw JSONL／一般附件覆蓋尚缺 |
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
