# UIUX v3.2 實作與驗收整理（2026-10-29）

本紀錄取代提案中的「其餘新增工作未開始」現況描述。核對基準為 `2dd45465`，測試對象為其上的本次工作區變更，驗證當時尚未提交，未發布為正式版本。歷史 DMG 的 commit、hash 與驗收紀錄保留，不移植到這個候選版本。

本機可執行的實作及自動驗證已收斂；原生跨平台、五位使用者量測與真實磁碟滿／程序中斷仍待驗收。[公開追蹤 #457](https://github.com/guan4tou2/REDLOG/issues/457) 已建立。Spec 064 保持 Draft，不將單平台結果宣告為全部 UX／CT 門檻通過。

## 逐項對帳

| 提案 | 結果與可重現證據 | 未完成界線 |
|---|---|---|
| P0-A 原生擷取 | 保留 #326／#345 的既有修復、單元測試及 D1–D4／G1–G3 清單 | BLOCKED：Windows／WSL／Git Bash，見 #457 |
| P0-B 邊界 | `recording-pause`、`terminal-session-rotation`、`project-open-rollback` E2E 覆蓋 pause、project binding、延後 spool 重送與原始資料保留；既有 spool cap／no-sidecar 測試保留 | 真實 ENOSPC、強制中斷與跨平台完整 CT-15／16 待 #457；不關閉 #291 |
| P1-1 交付 | 逐格式拒絕、不支援政策、實際 PII 產物、scope 計數、附件明示、核准快照與固定前綴；詳見下表 | 原生平台成品矩陣仍待 #457 |
| P1-2 Baseline | 修改前跑 25 個既有原始碼 Electron 案例：pause、terminal rotation、AI 原始檔排除、export preview／filtered export、Transcript、Scope | 不是完整 UX-01–19 或真人首次接入量測 |
| P1-3 HTTP 契約 | 新增專案本地有界歷史、原子寫入、七狀態模型，綁定 project／endpoint／CA／routing／source instance；單元測試及真實 HTTPS、重啟、換專案與改 routing E2E | 沒有穩定 client identity 時只顯示歷史擷取證據；不憑 UA 恢復「目前已驗證」或 CA 信任 |
| P1-4 開啟回滾 | 設定準備、DB open／pragma、資源初始化失敗清理；picker 與 main active 一致；4 個正式 IPC E2E 見 `REVIEW-FOLLOWUP-2026-10-29.md` | 原生安裝包故障注入與實體磁碟滿待 #457 |
| P1-5 錄製真實性 | 保留 cast／shell capture 分別判定；字級快捷鍵限定終端，搜尋輸入不攔截，Electron zoom 不變；Mac 真實鍵盤 E2E | OS／Windows 鍵盤配置及真人理解驗收待 #457 |
| P1-6 權威對帳 | 本表、TRACEABILITY 與 Spec 064 覆蓋矩陣共同記錄版本、證據、限制；保留歷史紀錄 | 不以文件更新提升 spec 狀態 |
| P1-7 內容三軸 | 共用 capture partial 判斷；HTTP／Shell refs 改走版本化 EventContentReader；AI／HTTP／Shell 三種 17 MiB 來源測 hasMore 與 unknown capture；late output 讀取失敗保留舊內容 | hasMore 是讀取分頁，不當作 capture 遺失；cast 仍沿既有 replay／index 契約 |
| P2-1 HTTP UI | 現場成功後收起設定，保留重試；歷史時間與 client label 分開，不重設現場 readiness | 真實 OS CA／瀏覽器身分測試待 #457 |
| P2-2 Transcript | 失敗指令及 Loot 不再一律展開；首行預覽最多 160 字元，文字查詢顯示有界匹配脈絡；ref-only 導向 saved content | 摺疊不隱藏 exit／capture partial 狀態 |
| P2-3 HTTP scope | 明確區分未設定、範圍外、不可判定；採 canonical evaluator，政策讀取失敗不當作範圍內；預覽統計不同 flow | 未清洗原始附件有明示界線 |
| P2-4 違規詳情 | 讀回完整 source command 與記錄的 exclusion rule；歷史缺少規則明示 unknown；候選值進既有 Scope 輸入，需操作者確認才寫入 | 不另造規則編輯器、不從摘要猜原始指令 |
| P2-5 Regression | 受影響正式 renderer／preload／IPC／disk 流程、兩語系與最小 800×500 視窗；最終數量見下節 | 完整跨平台與真人回歸待 #457 |
| P2-6 終端字級 | xterm 輸入可改字級，搜尋／一般輸入及 composition 不被攔截；原生 Electron zoom 維持 | Windows／其他鍵盤配置待 #457 |
| P3 設定徽章 | 必要性檢查後不新增：既有健康狀態已提供同一資訊，未證明第二組徽章價值 | 條件未成立，非未實作承諾 |
| P3 Related Activity | 既有可信 causal graph 已有關係依據與外頁 cause 定位，保留其 E2E；不恢復 host 聚合 API | 未證明額外 graph 必要，不把同 host 時序畫成因果 |
| P3 Replay | 只為已知 initial seek anchor 加原生刻度，時間來自既有 anchor，不推算缺少的 marker | 不宣稱具備未提供的所有事件時間 |
| P3 D1／D2／D3 | 缺口是 HTTP／Shell 仍使用整檔讀取；已對齊既有版本化 Reader，刪除重複讀取狀態。Timeline／Transcript 沒有量測出需大拆分的維護缺口 | 不按行數重寫，不造 mega reader；全產品導覽改版不是本次提案必做項 |

## 格式 × 載體 × 政策

PASS 指有測試支持的契約；UNSUPPORTED 為正確拒絕；N/A 表示格式沒有該載體。PII scrub 只清操作者識別資訊，**不是秘密偵測器**。保留的 Authorization／Cookie／query／prompt 必須由明確 redact／scope 政策處理，不把仍有原始資料一概當作失敗或清洗成功。

| 載體／政策 | JSON | NDJSON | Timeline | HAR | Bundle | 證據 |
|---|---|---|---|---|---|---|
| 事件操作者 PII：開／關實際產物 | PASS | PASS | PASS | UNSUPPORTED | UNSUPPORTED | `export-plan-ipc`；三格式 × 兩政策讀回成品；不支援者拒絕 |
| 選取成員與政策凍結 | PASS | PASS | PASS | PASS | PASS | `export-plan`、`export-plan-ipc`、`filtered-export`、`export-snapshot` |
| scope／redact 邊界 | PASS | PASS | PASS | PASS | PASS | `scope-sanitize`、`redact-export`、`redaction-boundary`、`har-export`；依格式能力，不承諾 raw bytes 自動清洗 |
| HTTP body 實體 sidecar | N/A | N/A | N/A | PASS | PASS | `har-export`、`bundle-export`、`export-attachment-freeze`；前三者可有 inline event data，不等同 sidecar |
| 截圖／cast／手動附件 | N/A | N/A | N/A | N/A | PASS | `export-attachments`、`export-attachment-freeze`、`cast-slice`；明示未做內容 scope／PII 清洗 |
| cast 核准位元組前綴 | N/A | N/A | N/A | N/A | PASS | frozenBytes 與附件 hash／manifest；不做內容層裁切，不宣稱 whole-file |
| AI raw JSONL | N/A | N/A | N/A | N/A | PASS（預設排除） | `official-agent-capture`、`bundle-export`；解析後 AI events 與 raw 檔為不同載體 |
| hash／manifest／來源鏈 | PASS | PASS | PASS | PASS | PASS | `export-plan`、`bundle-logged-digest`、`bundle-two-tier`；projection 不宣稱改寫後仍是原始事件 bytes |
| 獨立離線 verifier | N/A | N/A | N/A | N/A | PASS | `bundle-export`／安裝副本 smoke；其他格式不宣稱提供 Bundle verifier |

專案名稱及 provenance metadata 不被當作操作者 PII 強制改寫；Bundle 的原始 metadata 保留契約有明示。附件更新、缺失、來源版本或 scope 政策改變後，核准計畫不能靜默交付不同成品。UI 的 raw boundary 警告與成品契約一致，未新增「已辨識所有秘密」承諾。

## 驗證環境與效能

Apple M2 Pro、10 threads、16 GiB、macOS（Darwin 27）、Node v26.13.0。使用既有 lockfile／native module rebuild；Electron 在專案要求的可啟動環境執行。使用隔離 HOME，沒有更動使用者系統 proxy 或 OS CA trust。

- 十萬事件、兩 tier 各半、200 targets：每種查詢先記錄 first call，再量 30 次 warm p50／p95。續頁檢查原先 p50 約 304 ms，單次 coverage 掃描仍約 256 ms；新增可由 SQLite 維護的 saved-content partial index 後 p50 **39.4 ms**、p95 **41.9 ms**。保留原本 200 ms median／100 ms live burst 門檻。
- scope 首頁 p50 **113.4 ms**、p95 **118.5 ms**；live burst 60×100 IDs p50 **43.5 ms**、p95 **44.7 ms**。
- 5,000 HTTP flows／約 40 MB inline body，30 次 warm：全部 p50 **118.8 ms**、p95 **171.5 ms**；4xx p50 **121.0 ms**、p95 **125.1 ms**。
- 效能與內容契約測試合計 **30 PASS**。這些是本機查詢量測，不是冷磁碟、30 分鐘操作、互動延遲或真人任務完成率。首次使用五位使用者量測仍由 #457 追蹤。

## 最終驗證

- `typecheck` → `verify:specs` → `verify:architecture` → `verify:i18n` 均 PASS；沒有新增 allow-list。
- 最終 source Electron 選取 34 案例：33 PASS；新增 Scope 案例的多行輸入定位斷言修正後單案 PASS，合計 34／34。失敗定位屬測試誤用 input selector，未為通過而更動產品行為。
- `npm run build` PASS。Apple Silicon `.app` 打包及 ad-hoc 簽章驗證 PASS。
- 安裝副本的真實錄製／HTTPS／匯出／離線 verifier／重啟 smoke：1 PASS，報告 validator 確認零 skip、零 not-exercised steps。
- 候選 build 顯示 **`2dd45465+local`**。正式 smoke 入口要求純 commit，因此本次以相同 `packaged-smoke.spec.ts` 及精確 `+local` 預期值執行，另跑同一報告 validator；首次誤傳純 baseline 的身份斷言失敗不算通過。
- `npm test`：443 檔 PASS、6 檔 SKIP；**4461 PASS、31 SKIP、0 FAIL**，147.86 秒。受限環境停滯的嘗試已停止，以上為正常本機最終執行結果。

原始完整輸出存於本機測試報告，不將生成的 screenshots、暫存 HOME 或私人路徑提交至 repo。

## 本機候選成品

本機 `dist/uiux-20261029/RedLog-0.18.4-arm64.dmg`，來源基準 `2dd45465` 加本次未提交變更。不是已發布版本，未做 notarization 或宣稱正式發布驗收。

- DMG SHA-256：`0ddf4e5456e23a5befc55c2e7866cb012e0fd81f67e681f29a9325932bb78dc8`
- `app.asar` SHA-256：`ece2cdba71ab1cded1e56e9f89273a93a2797e5cede46c2388ff4ca6b22c7ae3`
- 唯讀掛載 DMG 後，內部 `app.asar` 與 smoke 通過的安裝副本一致，並已卸載。
- 同目錄 `source-manifest.json` 記錄基準 commit、本次變更檔案 hash 與產物 hash；`.workbuddy-ai/` 不屬本次變更，未納入。

上述驗證完成後，依使用者授權將修復與文件提交並推送。DMG 仍是驗證時的 `2dd45465+local` 候選，不冒稱為後續提交重新建置的產物；未發布 release。跨平台與真人項目仍由 #457 追蹤。
