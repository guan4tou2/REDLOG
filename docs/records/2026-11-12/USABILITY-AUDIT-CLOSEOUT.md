# 可用性審查收尾（2026-11-11～12）

> **狀態**：record — 當次工作的快照，不是現況頁，也不是待辦清單  
> **範圍**：PR #684、#694、#696、#697、#698、#693 的內容、驗證方式與未完成事項  
> **最後核對**：2026-11-12 於 `main@aaee01fd`（合併 #698）；數字的量測條件寫在各節

現況以 [目前狀態](../../CURRENT-STATUS.md) 為準，下一步以 [工作計畫](../../WORK-PLAN.md) 為準。本頁保留當次的證據與限制。

## 1. 合併了什麼

五個 PR 以堆疊方式依序合併（每個以 merge commit 併入，`main` 在期間沒有其他變動，所以每個中間狀態都是 CI 已驗證過的樹）；#693 為文件，獨立。

| PR | 範圍 | 關聯 issue |
|---|---|---|
| #684 | 第一批可用性修正：確認對話框與輸入法組字的 Enter、寫入失敗提示（`runMutation`）、目標頁與 HTTP 歷程的讀取節流、時間軸已存查詢的到達行為、HUD 偏好改為全域（`~/.redlog/hud-prefs.json`）、導覽與拖放封鎖、`tools/redlog-verify.py` 失敗即拒絕、外部事件政策 | — |
| #694 | 擷取缺口與讀取失敗狀態、API 防護、效能 | #685、#687–#692 |
| #696 | 節流工具三合一、未處理 rejection 的全域提示、共用的輸入法組字判定 | — |
| #697 | 戰利品掃描的平方級行擷取、HAR 匯出計畫用不到索引、查詢長度上限、HTTP body 搜尋回填改為增量 | #695（部分） |
| #698 | 搜尋驗證狀態持久化、API bundle 匯出移出主行程、密鑰樣式線性化、shell hook 三項缺陷、AI session 選取依專案保存、Electron fuses 與啟動政策、正式版／冒煙版兩種建置、介面修整 | #686、#695（部分） |
| #693 | `docs/` 結構收斂（根目錄 66 → 34 份），本頁所屬 | — |

## 2. 驗證

| 項目 | 結果 | 條件 |
|---|---|---|
| 單元與元件測試 | 662 個檔、6841 個案例；6799 通過、42 略過 | macOS 本機，沙箱外，`npm test` |
| Gate | typecheck、verify:specs、verify:architecture、verify:i18n 通過 | 同上 |
| CI | 六個 PR 的 unit（三平台）、e2e（三分片，ubuntu）、install-smoke（Linux、Windows）皆通過 | 各 PR 最終 commit |
| 未簽章 macOS app（正式版） | fuses 讀回 RunAsNode、NODE_OPTIONS、inspector 皆關閉；`--inspect=9229`、`--remote-debugging-port=9222` 啟動後兩埠無監聽；行內腳本與計時器內的 `new Function` 被 CSP 擋下 | `electron-builder --mac dir --arm64`，隔離的使用者資料目錄 |
| 未簽章 macOS app（冒煙版） | Playwright 可啟動；啟動時印出冒煙版提示；以正式版模式檢查回 exit 1 | `REDLOG_SMOKE_BUILD=1` 建置加 fuse 覆寫 |
| 真實 app 功能走查 | 107 項：通過 79、失敗 13、不明 14、略過 1（修正前 71／18／17） | 隔離的暫存 HOME，僅 127.0.0.1 |
| bash 5.1 | Tab 與反斜線目錄的事件完整送出；輸入結束時無多餘事件 | 本機容器（Mac 只有 bash 3.2） |

負載量測（同一支腳本、隔離實例、約 7 萬筆已存事件）：

| 項目 | 修正前 | 修正後 |
|---|---|---|
| 灌入 8 萬筆 | 242 筆/秒 | 1183 筆/秒 |
| 即時寫入時主行程最長停頓（搜尋／活動頁） | 42.9 秒 | 約 4 秒（見 §4） |
| Timeline 即時寫入 15 秒內長任務 | 9022 ms | 0 ms |
| 開啟 10 萬筆 Timeline | 6626 ms | 37 ms |
| `POST /api/loot/scan` 5 MB | 180 秒無回應 | 413，30 ms |
| HAR 經匯出計畫 | 逾時 | 17.5 秒，主行程最長停頓 13.8 ms |

離線量測（暫存資料庫，2 萬筆 body 參照）：重複搜尋約 2.5 秒 → 約 140–190 ms；重新開啟後第一次搜尋約 1.7 秒 → 約 0.5 秒。shell hook 每指令額外延遲 zsh 26.6 → 16.8 ms、bash 3.2 173.3 → 38.4 ms（N=200）。

最後一次真實 app 負載重測時機器負載很高（load average 約 10），該次延遲數字不列入。

## 3. 行為變更

- HUD 設定為全域偏好，不隨專案變動。
- 無專案時開啟的終端機，會被下一個開啟的專案納入並提示一次；`redlog status` 之後顯示錄製中。
- shell hook 小事件送出期限 2 秒 → 1 秒；回應超過 1 秒時該事件會同時送達與 spool，由去重處理。
- 終端錄製改為 50 ms／64 KiB 緩衝寫入；當機時最多少最後 50 ms 輸出。
- `/api/loot/scan` 文字上限 128 KiB（超過回 413）；查詢字串上限 1000 字元，API、搜尋介面與已存篩選共用。
- API bundle 匯出以請求當下擷取的邊界為準；請求排隊；匯出途中切換專案回 500。
- 搜尋索引（`http-body-index.db`）升到 `user_version` 7，升級後第一次啟動重建一次。驗證過的參照在檔案簽章（dev、inode、size、mtime、ctime）不變時直接信任；app 關閉期間被原地改寫且五項皆不變的檔案，搜尋不會察覺。讀取內容時的雜湊驗證不變。
- 關閉 NODE_OPTIONS fuse 後，主行程不再讀 `NODE_EXTRA_CA_CERTS`；在攔截 TLS 的代理後面，鏈錨定的對外請求可能失敗。
- 正式版忽略 `REDLOG_E2E*`、`--remote-debugging-port`、`--js-flags`、`REDLOG_KEYS_DIR`，inspector 關閉。要對打包後的 app 跑 Playwright 規格，必須建冒煙版（見 [Releasing](../../releasing.md) 的 Build variants）。
- 時間軸標題顯示「已載入 N 筆事件」；它依 Spec 038 排除內部事件，與狀態列的總數本來就不同。

## 4. 未完成

缺陷與量測缺口：

- 開啟後第一次搜尋仍走訪全部參照列並逐檔 lstat；約 7 萬筆、即時寫入下量到一次約 4–5 秒的主行程停頓。未確認這就是活動頁那次停頓的全部成因。
- 8 MiB 全為相異雜湊值的指令輸出，擷取約 8.5 秒：時間在把數十萬筆命中寫成單一戰利品事件。需要為單一事件的命中數設上限。
- 時間軸刻度頭尾標籤仍會重疊；時間軸下方事件列表的「範圍未判定」仍是一筆一列（收合只做在活動頁，且交錯出現時不收合）。
- 設定儲存失敗時頁面顯示失敗，但表單內容沒有留在畫面上。
- 功能走查仍失敗的 13 項中，約半數是腳本找不到元素，無法判定；其餘為 HTTP 完整度訊息未含筆數、在時間軸上匯出未指明範圍、三個頁面無共用篩選提示、戰利品頁無載入中狀態。
- Timeline 搜尋框在即時寫入時是否失焦：腳本點擊逾時，修正前後皆然，無法判定。
- hook 另外讀到的四處未修（`redlog-run` 的 `mktemp -t`、Python 路徑失敗時靜默丟棄、`redlog-send.sh` 健康檢查無 `--max-time`、engagement id 含跳脫引號時被截斷）。
- 兩個 fuse 未開（`enableEmbeddedAsarIntegrityValidation`、`onlyLoadAppFromAsar`）：主行程會從 asar 之外載入程式碼。
- 測試：依賴實際時間的比例測試改為 `REDLOG_PERF=1` 才執行，常駐的是寬鬆的絕對時限，較輕微的效能退化不會被 CI 攔下。`first-run-record-terminal`、`record-terminal-adapter-selection` 各有一次以上因 1 秒等待逾時而失敗，前者已放寬等待，根因未查。

需要決定：

- 設定頁內容寬度的標準（現有 720px 置中、900px 靠左、不設上限三種）。
- 時間軸文字是否拉到 [UIUX Standard](../../UIUX-STANDARD.md) §2 的 13px 下限（目前多為 12px，這次只保證 11px）。
- `native`／`relayed`、tier 標章、品牌標語是否中文化。
- lint 是否做成第六道 gate；是否建立統一的鍵盤層；首次使用的主要按鈕是否改為內建終端機；時間軸右側停靠的去留；時間軸縮放 1 倍是否一次載完全部歷史。

未驗證的環境：Windows PowerShell 與 Git Bash、WSL、Linux 上真實的非 UTF-8 目錄、真實 `ps` 的終端 app 判定、PTY relay 路徑的 hook 延遲、真實輸入法、macOS TCC 狀態呼叫、多螢幕、簽章與公證。

## 5. 文件裡仍指向舊路徑的引用

以下不在這次修改範圍，原因各異：

- `CHANGELOG.md`：歷史條目，保留當時的路徑。
- `src/core/db/index.ts` 三處（SQL 內的註解，會存進 `sqlite_master`）、三個內建外掛的 `plugin.json` 描述：改動會影響已存的 schema 文字或外掛清單內容，需另行評估。對應文件現在位於 `docs/design/`。
- `src/core/db/event-write.ts` 的錯誤訊息提到 `docs/operators.md`，該檔不存在。
