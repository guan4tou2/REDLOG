# macOS Reader、Timeline 與匯出整合驗收

產品基準：main `3dd84052` 加本批實作；沿用既有 Stitch 定稿、UI token、單欄 Reader 與獨立 Timeline。本紀錄不取代 `docs/UIUX-STANDARD.md`，也不將 Spec 064／070 或跨平台人工驗收整體提升為 Verified。

## 實作與責任邊界

| 範圍 | 本批變更 | 可觀察契約 |
| --- | --- | --- |
| #591 內容語義 | `contentState(ContentDescriptor)` 統一 available／empty／not-captured／unreadable／truncated；Shell、HTTP、Activity AI、Timeline AI 皆沿用核心 Reader | 零位元組且 partial 仍是截斷；缺檔不說未擷取；空 stderr 不新增選項，但保存後讀取失敗仍可見 |
| #661 Timeline | `useTimelinePages`、`useTimelineLive`、`useTimelineInspector`、`useTimelineViewport` 與既有 summary／pan hooks 分責任 | 頁面 generation／cursor 防競爭；live 最新修訂勝出；大集合 250 ms 合併、小集合 frame 路徑；Reader 不轉移到下一個事件 |
| #661 匯出 | iterator 分頁選取與摘要；preview／來源重檢／Bundle／HAR 在唯讀 worker；JSON／NDJSON／Timeline 以確認批次串流寫出 | snapshot／核准 ID／內容 digest／DoNotExport／設定／sanitization 重檢；專案切換中止；私有 staging 通過交付重檢才發布 |
| #661 來源契約 | 核心 `captureFacts` 分開設定、服務、連線、保存與讀取新鮮度，現有 HTTP／onboarding／官方插件 View Model 使用相同保存事實 | 歷史 HTTP 流量不證明目前代理正在運作；讀取失敗時 HTTP／命令列皆明確未知、撤銷快取的 Running 標籤；不新增 Manifest 欄位、事件儲存或第三方 UI 執行 |
| 未知來源 | Generic Reader 可讀完整事件 JSON，沿用 ContentRef 的 project／version／Find／視窗服務 | 插件不在場仍可閱讀歷史；已知欄位的缺失／讀取錯誤不會被通用 JSON 假裝成有輸出 |

Timeline 的 `sliceWithAmendments`／`markerIdsIn` 是舊同步匯出的失效輔助函式，已移除。原先只呼叫這兩個函式的測試，改以真實 preview → execute → 成品斷言：已核准的 marker／correction 各一次，核准範圍外或 snapshot 後的 correction 不會偷偷加入。Bundle 的雜湊鏈／修訂保存契約與 verifier 測試保留。

未改變資料庫 schema、舊插件驗證、核心證據保存權限或一般附件警告。

## 回歸證據

- `reader-content-state`：Shell／HTTP／Activity AI／Timeline AI 的五態一致及空 stderr；`evidence-content` 驗證真實 DB／檔案／未知來源、project 與 version 防護。
- `export-runner`：正式 worker 的唯讀 HAR、專案切換取消、完成時政策拒絕、暫存目錄被替換時不刪除別人的資料。
- `har-stream`：530 exchanges 與 partial／WebSocket，含重複 request、相同時間與 snapshot 後資料，和原 HAR 逐位元組相同。
- `export-stream`：JSON／NDJSON／Timeline 成品與原序列化內容一致，含空集合、PII、取消及交付前拒絕。
- `timeline-pages`／`timeline-live`／`timeline-controllers`：過期回覆、頁面競爭、重試、最新 live 修訂、合併刷新、Reader 生命週期、CSS 座標與縮放保存。

| 執行 | 結果與界線 |
| --- | --- |
| typecheck／spec／architecture／i18n | 四項通過；architecture 404 source files，沒有新增 allowlist |
| 完整 macOS unit（最後小修前） | 5,949 passed／1 failed／42 skipped；唯一失敗是既有 Bash PTY 的 `setpgid: Operation not permitted` 插入了終端文字，計數本身為 1 |
| 該 PTY 檔案單獨重驗 | 5 passed，19.19 s；不隱藏完整 suite 的偶發失敗，也未放寬斷言或修改 shell 產品碼 |
| 正式 build | 通過，含獨立 export worker |
| 來源碼 Electron | **117 passed，3.0 min，零 retry／skip**；12 份受影響 spec，含窄窗／雙語／縮放、來源修復、插件、Session、Find／閱讀位置返回及匯出 |
| 最後小修補驗 | 競爭／交付 15 項、狀態／Reader／worker 33 項通過；Timeline／export Electron 38 項再次通過（與 117 有重疊，不相加） |
| installed macOS 候選 | **1 passed，10.1 s**，兩次 App 啟動，沒有 skipped／not-exercised；資源、native module、Bundle worker 與 verifier 皆實際執行 |

來源碼選取：`app-shell`、`cast-content-reader`、`export-preview`、`timeline-track`、`network-state-recovery`、`settings-search-closeout`、`first-run`、`evidence-views`、`external-session`、`official-agent-capture`、`plugin-explore`、`capture-settings-interaction`。不把 unit、CI shard 或安裝 smoke 的重複覆蓋加進同一個通過總數。

### 六條操作流程的證據

| 工單流程 | 本批來源碼驗證 | 保留界線 |
| --- | --- | --- |
| 首次使用 | FirstRun 接入／驗證、外部 Shell recovery；既有 Scope 不被新畫面重寫 | 一般使用者無人協助與 OS 權限尚未量測 |
| HTTP | 真實 HTTPS canary 與保存／Reader；狀態測試區分歷史、失敗、啟動中、運作 | 系統 CA 信任不等於隔離 client `--cacert` |
| AI | Claude Code／Codex 授權、watcher、對話搜尋、交付、停用／移除後歷史可讀 | 合成 JSONL，不宣稱登入真實 AI 帳號操作 |
| 事後查找 #589 | Source filter＋query＋Reader Find＋內容視窗／scroll＋event，Timeline 返回逐項斷言；另驗 AI provider／Session／query | 同一事件與跨專案隔離，不以 Toast 假導航 |
| 異常修復 #590 | 設定搜尋／深層定位、真實設定寫入拒絕後重試、外部來源恢復後新事件；IP／Pivot／CDP 可控失敗恢復 | 可控 IPC 案例只證明 UI 與恢復路徑，不冒充實際網路故障 |
| 證據交付 | preview／政策變更／成品讀回、原始附件警告、verifier | 各格式保留既有遮蔽及可攜範圍，未開放報告產生器 |

## 固定 macOS 安裝候選

- 版本 **0.18.6**，產品提交 **`f10c6645`**；之後僅更新測試／文件，不冒用後續文件提交作為已建置版本。
- `electron-builder --mac dir --arm64 --publish never`，複製成獨立 `.app` 副本；不是公開 release、DMG 下載或覆蓋既有 `/Applications/RedLog.app`。
- resources／optional AI checksum／native resources 與 `codesign --verify --deep --strict` 通過；**ad-hoc 簽章**，沒有 notarization 或經認證的發行者身分。
- `app.asar` SHA-256：`c50a57b34ca15c6960ea66ddf634e90b88901b7501444218062c3010eb477c86`。
- ASAR 內確認 `out/main/export-worker.js`、`fs-extra`、`@dagrejs/graphlib`、`@tanstack/virtual-core` 等必要依賴；安裝版 Bundle 實際透過 worker 執行，驗證 native SQLite 與封裝路徑。
- smoke 涵蓋開專案前 API、內建終端、外部 Shell、實際 mitmdump／HTTP／HTTPS canary、擷取驗證、Bundle verifier 與重啟讀回；report validator 確認無跳過步驟。

初次封裝在測試用的 `node_modules` 連結下漏收間接依賴，未作為通過候選；改以同一 lockfile 的隔離 `npm ci`／必要 runtime rebuild 重建。沒有修改 lockfile 或引入新套件。

首次安裝 smoke 被已執行五天的使用者 RedLog 代理佔用 `6661` 阻擋，狀態有正確顯示 PID 與衝突原因。第二次只改設定但未重新啟動，仍保留失敗狀態；測試現透過正式設定與 stop／start 為隔離專案配置獨立埠，不終止既有代理。修正後完整 smoke 通過；兩次診斷失敗沒有算進 PASS，也沒有降低原斷言。

## 完整匯出 workload

macOS arm64／Node v26.13.0；2,500 Shell 事件，各 8,704 B stdout，500 HTTP exchanges（1,000 logged events）。測量包含正式 IPC preview → 核准 → execute → 成品交付，沒有把 worker 的單一序列化子基準當作全流程。

| 格式 | 全流程 ms | 起始／峰值 RSS MiB | 主程序最長排程延遲 ms | 成品內容核對 |
| --- | ---: | ---: | ---: | --- |
| JSON | 1042 | 188／261 | 13 | 3,500 events；每筆 stdout 完整 |
| NDJSON | 1025 | 308／404 | 10 | 3,500 events；每筆 stdout 完整 |
| Bundle | 2713 | 425／428 | 1 | 2,500 chained＋1,000 logged；每筆 stdout 完整 |
| HAR | 997 | 443／451 | 1 | 500 exchanges；每筆 response body 完整 |

同一程序依序量測；RSS 包含 worker，後一格式的起始值包含先前成品驗證造成的配置，不能拿各列峰值相減當作獨立程序基準。成品解析在計時與採樣停止後才執行。Bundle fixture 的 SQL 雜湊值是合成值，本 workload 只核對成品資料，真實鏈由既有 Bundle verifier 與 installed smoke 負責。

記憶體界線是選取 ID／flow metadata，加上一頁至多 1,000 事件（snapshot 掃描為 512）、16 筆交付批次及目前單一 HTTP flow 的內容；不是與事件大小無關的固定 RSS。極大單筆事件或單一 flow 仍會增加記憶體。原 Windows 198k–200k／Defender／原硬體效能由 #660 保留，沒有用本數字代替。

重現：

```sh
npm test -- test/export-workflow-perf.test.ts
REDLOG_PERF=1 REDLOG_PERF_REPORT=/tmp/redlog-export-workflow-macos.json npx vitest run test/export-workflow-perf.test.ts
```

第一行只準備 Node native ABI／正式 worker 並列出 opt-in skip，第二行才執行量測。不要與其他測試或 Electron native rebuild 同時進行。

## 尚須外部條件的驗收

- #660 原 Windows workload、Defender 與原機；Windows／WSL 原生人工接入。
- 真正下載來源的 Gatekeeper／notarization、系統 CA 信任與 OS 權限提示；E2E 的隔離 profile／`REDLOG_E2E` 不代表一般模式人工通過。
- 實際 AI 客戶端帳號的完整操作與五位使用者無人協助量測；JSONL fixture 不冒充真人對話。

這些項目仍為 NOT RUN，不因本批可自動化工程完成而關閉其驗收工單。
