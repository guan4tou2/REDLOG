# RedLog：最新 main 設計差異與使用流程稽核

> **版本與用途（2026-11-07）**　以下保留 `ebd9f4b` 的實測紀錄。主線 `492ba542` 已有儀表板與 HUD 的中繼節點列表、獨立 IP／Pivot 區塊及錯誤重試。後續實作只補較舊查詢覆蓋新通知、缺少讀取介面、舊節點呈現及 CDP 重試回饋。全域決策見 [UI/UX 規範](UIUX-STANDARD.md)，各頁進度見 [設計與實作矩陣](UIUX-DESIGN-IMPLEMENTATION-MATRIX.md)。

日期：2026-11-07（Asia/Taipei）  
遠端基準：`ebd9f4b105c912506121c4aa7acdbf6f117c7576`（PR #609 合併後；本次 fetch 確認）。  
本機基準：`e176777a` 加未提交修改；**不是上述 main**。本次以遠端 git archive 的乾淨暫存副本建置、執行 Electron，未合併、覆寫本機產品修改或提交。

## 1. 裁定

停止新增 Stitch 整頁設計。側邊欄、設定首頁、插件安裝／專案擷取責任分工、證據分頁均已有正式實作，不重建。優先修正網路狀態的失敗語義及錯誤後的操作閉環，再補齊真實來源與跨平台驗收。

這份矩陣更新的是 **main 的實作事實**。[設計契約](UIUX-STITCH-DESIGN.md)原有本機驗證紀錄不能當成 main 證據；本輪通過的測試也不代表全產品視覺、效能或 Windows 已完成。

## 2. 全頁差異矩陣

狀態：A＝已實作且符合所列設計；B＝已實作但需調整；C＝尚未實作的明確能力；D＝與既有設計／文件衝突。狀態限定於每列描述；未驗證不是未實作。

下列路徑均指上述 SHA，元件位於 `src/renderer/src/`。

| 區域 | 狀態 | main 實況／證據 | 後續邊界 |
|---|---|---|---|
| App Shell／側欄 | A | `lib/sidebarOrder.ts`、`components/Sidebar.tsx`：七個主要入口、⌘1–7、設定 ⌘9；展開 240px、收合 48px。入口實測通過。 | 不重新安排；修正舊文件／HTML 的 150px 與舊快捷鍵基準。 |
| 儀表板擷取與異常 | A／B | `DashboardView.tsx` 保留 `DashboardIssues`、`CaptureHealthCard`、`FirstRunView`；網路卡位於擷取之後。 | 保留既有資料與導覽；完整來源錯誤恢復仍需逐來源驗收。 |
| IP／Pivot | B／C | `lib/usePivots.ts` 吞讀取錯誤；`IPStatusCard.tsx` 按 ts 串箭頭。卡片缺少獨立 Pivot 讀取失敗／重試狀態。 | 見 F01–03；不新增第二套狀態後端。 |
| 活動紀錄／Reader | A（已測部分） | `activity-return-state`、`http-body-search`：搜尋已保存內容、開內容、返回保留查詢；時間軸往返保留展開列與捲動。 | 尚未涵蓋所有來源、Session／進階篩選組合；不能把該結果推廣為全部上下文已通過。 |
| 獨立時間軸 | A（入口／返回） | `App.tsx` 的 `returnTo` 與獨立 TimelinePanel；七入口及返回測試通過。 | 本輪未完整重驗時間比例、重疊、縮放、關聯證據正確性。 |
| AI 對話 | A（已測部分） | 正式來源監看器、專案授權、Claude／Codex 保存與搜尋及移除後閱讀；`transcript-view` 覆蓋工具配對及新增資料不打斷閱讀。 | 外部 AI binary、所有 Session 切換競態、敏感資料顯示／複製／匯出一致性仍需專項驗收。 |
| HTTP 歷程 | A（已測部分） | 獨立平面列表、一請求一列、時間首欄、開啟 Request／Response 通過。 | seeded 內容閱讀不等於真實 HTTPS 擷取成功。 |
| HTTP／瀏覽器設定 | B | 驗證入口可鍵盤展開，窄視窗通過；`settings/BrowserPage.tsx` 同時有 HTTPS 驗證與 CDP 連線測試。 | F04：重試應回報結果；依能力分組，不再新增一套驗證。 |
| 目標與範圍 | A（結構） | 共用頁首、計數分頁、Scope 入口可到達。 | 尚未完整驗證規則變更、歷史判定、失敗後恢復；保留進階功能。 |
| 證據 | A（結構） | 截圖、戰利品、書籤共用入口與分頁，#609 後控制項可到達。 | 不重做整合；附件遺失、原始內容／雜湊驗證與匯出仍需端到端驗收。 |
| 終端機 | A（已測部分） | 沿用 xterm；真實 Zsh PTY 中 stop→start→exit 後仍顯示部分暫停錄影。 | 不代表外部 Shell Hook、`ls`／`ls -al` stdout、空 stderr、Windows PowerShell 全部通過。 |
| 設定首頁／搜尋 | A（結構） | `Settings.tsx` 單欄分類、搜尋、獨立子頁、回首頁及深層導覽。設定存取與窄視窗測試通過。 | 所有搜尋命中定位、返回焦點、鍵盤順序仍需完整抽驗。 |
| 插件 | A（已測部分） | `PluginsPanel.tsx` 官方目錄及安裝／更新／移除；搜尋→需處理→詳情→返回、窄寬切換通過。 | 不恢復舊 Marketplace；不將全域安裝當成專案授權。 |
| 擷取來源 | A（已測部分） | `CaptureControlPage.tsx`／AgentsPanel 管理專案啟用與授權；可定位插件，插件可返回來源。實際設定與錯誤恢復測試通過。 | AI／截圖／監控共處一頁不直接判錯；量測找到指定來源所需步驟再調整。 |
| 專案選擇／建立 | A（已測部分） | 六個專案顯示搜尋、單一命中 Enter 開啟、獨立範圍摘要三態；鍵盤建立、窄視窗、重啟保存通過。 | 大目錄／大量專案啟動耗時尚無本輪數據。 |
| 視覺 token／元件 | B（局部） | IP 卡仍直接使用 green/yellow/cyan；CDP 按鈕自行組 class，旁邊驗證用共用 Button。 | 不把所有非 token 顏色一律當缺陷；先按狀態語義與共用控件對齊，再做逐頁截圖／對比驗收。 |
| 設計文件／HTML 復刻 | D | 本機設計文件仍記舊 HEAD、150px、舊快捷鍵；main 無該新設計文件。065–069 已存在，不能再寫「尚未建立」。 | 本輪增加主線對照；HTML 舊快照標為舊基準，不能宣稱與新 main 一致。後續整合新 main 後再重建復刻。 |

## 3. 可採取行動的問題

### F01 — P1：Pivot 查詢失敗被當成沒有資料

`lib/usePivots.ts:23–29` 只回傳陣列，初值 `[]`，拒絕被空 catch 吞掉。使用者無從區分「沒有偵測到」與「讀取失敗」。

修改：沿用現有 read-state 慣例，區分 loading／ready-empty／ready-data／failed，失敗提供重試；若保留上次資料，標示過期。驗收需涵蓋第一次失敗、重試成功、訂閱後的初始請求晚到不覆蓋新狀態。

### F02 — P1：偵測順序被畫成已知路徑

`components/IPStatusCard.tsx:54–89` 將 Pivot 依 ts 排序，畫 internal→external→各節點。`ActivePivot` 只有 via/tool/route/ts，沒有前後節點／拓撲邊證據。

修改：先呈現已觀測節點及來源工具；只有具備明確關係證據才畫邊。不自行推斷完整攻擊路徑。驗收兩個互不相關節點、只有單節點與未知 route。

### F03 — P1：IP 讀取失敗阻擋獨立 Pivot 資料

`IPStatusCard.tsx:13–24` 初始 getStatus 無 catch，status 空時直接返回「Checking IP」。在沒有後續成功通知時，已載入 Pivot 也無法呈現。

修改：IP 與 Pivot 各自呈現讀取狀態；查詢失敗提供重試，未知安全分類不能冒充成功。這是有條件的錯誤路徑，不代表正常啟動必然卡住。

### F04 — P1：CDP 重試沒有可見結果

`settings/BrowserPage.tsx:48–62` 失敗 Toast 的 retry 只 `void getTab()`，未重新判讀 connected 或更新結果；首次測試的 Promise 失敗也無局部處理。

修改：共用一個有 pending／成功／失敗結果的測試動作，初次與重試都走同一流程。CDP 的「瀏覽器連線」與 HTTPS 的「請求是否被保存」各自命名／呈現結果；不以 CDP 成功宣稱 HTTPS 已驗證。

### F05 — P2：文件里程碑落後實作，易造成重做

065／066／068 verification 是分批 checkpoint，spec 仍 Draft 有其明確理由（包括跨平台未驗證），不可直接改 Verified。但「B/C 尚未開始」等歷史描述應附主線現況與剩餘驗收，避免新 Agent 重建插件管理。保留歷史紀錄，不覆寫成虛假的全綠驗證。

## 4. 使用流程驗收與證據範圍

環境：macOS 原生 Electron、隔離 HOME、main 建置；共用本機既有 node_modules（main 與本機 package/lock 無差異）。非封裝安裝版、非 Windows、非完整單元／CI gate 驗證。

| 流程 | 本輪結果 | 不能據此宣稱 |
|---|---|---|
| 七入口／活動→時間軸→返回 | 通過；查詢、展開列、捲動實測 | 所有 Session、進階篩選與深層返回組合 |
| 插件→授權→AI 保存→搜尋／移除 | Claude、Codex 與排除／暫停案例通過 | 真實 vendor 工具版本已驗證；fixture 是來源格式檔案，正式 watcher／IPC 真實運行 |
| HTTP 入口→驗證面板→歷程／內容 | 窄視窗鍵盤入口、seeded Request／Response、內文搜尋通過 | 瀏覽器憑證信任、真實 HTTPS 流量與驗證 nonce 已全程通過 |
| 設定失敗→重試／儲存 | 寫入拒絕重試、外部來源讀取失敗／執行中分離通過 | CDP 重試問題已修復 |
| 終端 stop→start→exit | 真實 Zsh PTY 保留部分暫停狀態通過 | 外部終端安裝、完整 stdout、PowerShell 原生驗收 |
| 專案建立／搜尋／範圍 | 建立鍵盤、窄視窗、重啟、範圍三態測試通過 | 大專案啟動效能達標 |

執行批次：

- 第一批：`view-reachability`、`http-verification-entry`、`project-startup`、`official-agent-capture`、`http-history-view`：**16 passed / 1 skipped**。略過為既有 transcript route `fixme`，不計為通過，也不等同整個 AI Reader 缺失。
- 第二批：`activity-return-state`、`plugin-explore`、`terminal-ended-recording`、`http-body-search`、`capture-settings-interaction`：**11 passed**。
- 第三批既有測試：`project-picker-search-scope`、`transcript-view`：**3 passed**。
- 因此正式既有流程測試合計 **30 passed / 1 skipped**；此數字不包含稽核新增的故障重現測試。

## 5. 尚需完成的驗收，不偽裝成程式缺陷

1. 真實 Shell：偵測全部可用 shell→安裝→執行 `ls` 和 `ls -al`→stdout 可找回；空 stderr 不出現無用區塊；Windows 原生 PowerShell 與 macOS 分別測試。
2. 真實 HTTPS：乾淨憑證狀態、信任失敗、正確 nonce、保存 request/response body、驗證後狀態及失敗重試。已偵測本機有 mitmdump，本輪未執行完整鏈路，不能以入口通過替代。
3. 所有頁面的載入／空／錯誤／未知、深層入口與返回焦點；桌面與窄視窗。本產品為 Electron，手機原生支援不在本輪承諾；仍需檢查窄版布局。
4. 證據關聯→原始內容→匯出檔案內容與完整性；不能只看下載成功。
5. 首次啟動／已有大型專案：分開量測啟動到專案清單、開啟到可操作、摘要補齊時間，至少記資料量與重複次數；未量測前不設定虛假的達標數字。
6. 全頁視覺對比：每頁相同視窗／縮放／語系、實際資料；按鈕、焦點、狀態色、字體、間距。現有局部截圖不等於全面一致。

## 6. 實作順序與停止條件

1. **網路狀態小批次**：F01–03，保留 DashboardIssues／CaptureHealth／FirstRun；補失敗注入與重試測試，再做 Electron 驗收。
2. **HTTP 恢復小批次**：F04，補真實 HTTPS 從設定到保存驗證；若發現擷取遺失，提升為 P0，先於視覺工作。
3. **Shell 可靠性與終端**：補第 5 節第一項，依實測修復，不重寫 xterm 或建立第二套 Hook 安裝流程。
4. **跨頁／視覺收尾**：沿既有已通過的導航整合，補未覆蓋組合，再同步 HTML 復刻與資產指紋。不要先把舊本機頁面覆蓋到新 main。
5. 每批提交／PR 前依 CLAUDE.md 完成必要 gate；本輪僅稽核文件與測試證據，未宣稱五項提交 gate 全綠。

不需要再交 Stitch 設計。只有實作中發現現有布局確實無法表達必要狀態，才提出小範圍設計問題。

## 7. 故障重現與保存位置

另加暫存 `audit-network-state.spec.ts`，在真實 Electron 主程序注入拒絕的 IPC 回應，並抑制後續 IP/Pivot 成功通知，確認 F01／F03 的條件式失敗狀態。**1 passed 是成功重現缺陷，不是缺陷已修復。** 初次測試受背景成功通知覆蓋而失敗；修正稽核隔離後重跑通過，未修改產品碼。

截圖可見 IP 卡停在 Checking IP，已載入 Pivot 未呈現；另一張確認 Pivot 讀取拒絕沒有錯誤提示。截圖同時有本機 6661 port 已被 mitmdump 使用的提示，因此不將該環境當成 HTTPS 擷取驗收；未終止既有程序。

證據位於 workspace `artifacts/ux-audit-2026-11-07/`（**implementation Git repo 外**）：三批流程 log、故障重現 log／測試原始碼、建置 log、兩張故障截圖。保留第三批首次失敗紀錄，不隱藏測試環境修正過程。既有流程 30 通過／1 略過的計數不含此稽核測試。

## 8. 提交前主線增量核對

2026-11-07 再次 fetch：主線已至 `9ca36509d185d930540787af2027ea6ce6ac2a2b`，新增 #610 終端機 Stitch 對齊（頁首、擷取說明、每個 pane 的狀態列與文字換行），另擴充兩個 E2E 和 terminal-session-meta 單元測試。此增量沒有修改 F01–04 涉及的 IP／Pivot／BrowserPage。

§4 的 30 passed／1 skipped 僅屬 `ebd9f4b`，不能當成 #610 的測試結果。文件分支以 `9ca36509` 建立；保留原工作區的所有程式修改。終端新布局列為「已實作；此次尚未操作驗收」，不再列成待開發。

## 9. 下一批實作的可勾選驗收

以下尚未完成，不能因本文件提交而勾選：

- [ ] F01：Pivot 初次讀取失敗顯示未知／錯誤；重試成功可清除舊錯誤；空列表與失敗不同。
- [ ] F01：訂閱收到更新後，較舊初始請求不得覆蓋新資料。
- [ ] F02：沒有關係證據的兩個 Pivot 不畫成先後路徑；未知 route 不補假值。
- [ ] F03：IP 失敗仍呈現成功載入的 Pivot；Pivot 失敗不遮住 IP；各自可重試。
- [ ] F04：初次 CDP 檢查與重試都回報成功／失敗，連續點擊有處理中狀態；IPC 拒絕不留下無回應按鈕。
- [ ] 真實 HTTPS：失敗→修正→驗證→歷程→保存內容，在同一專案完成並記錄證據。
- [ ] 真實 Shell：短／長／空輸出、合併 PTY 與獨立 stderr 語義、離線補送，按實際來源驗收。
- [ ] 新主線整合後重建 HTML，更新資產 hash；舊本機頁面不覆蓋已合併功能。

每項結案附「commit、平台、資料來源、步驟、可觀察結果、證據位置」。產品修正與文件狀態同批更新；舊驗收日誌保持原版本，不改寫歷史。

## 10. 使用者裁定：下一批修正範圍（2026-11-07）

本節取代 §3 原稽核的排程優先級：F01–04 統一列為 **P0 實作批次**，順序為狀態正確性→失敗恢復。原 P1 是發現當時分級，保留作紀錄。

修正分支／PR 主題：`fix(ui): correct pivot read states, route display and CDP retry feedback`。只含四項修正與相應測試，不調整整體儀表板、設定 IA 或逐字稿。優先重用既有 read-state 工具；保留 lastData 時明示過期，不宣稱目前仍運作。

新增自動化驗收：IP/Pivot 同時成功；IP 成功且 Pivot 確定為空；IP 失敗且 Pivot 成功；IP 成功且 Pivot 失敗；兩者同時失敗；CDP 失敗重試成功、重試仍失敗及逾時，並檢查所有結果回饋。原 30 passed／1 skipped 為舊基準，不能替代修正後測試。

第二批為 P1：真實 HTTPS、完整 Shell 輸出／PTY、Windows PowerShell／PowerShell 7／WSL、冷啟動／專案開啟／來源檢測、逐字稿、視覺一致性。**逐字稿獨立路由、Session 搜尋、使用者與工具輸入輸出、時間軸定位及返回**必須獨立驗收，不能因整合進活動紀錄而省略。

## 11. 文件提交檢查（9ca36509 基底）

本輪只有文件變更。typecheck、verify:specs、verify:architecture、verify:i18n、相對文件連結與 diff whitespace 檢查通過。受限制環境的 unit 首跑因 Shell／PTY 停滯中止；改以原生本機環境完整執行 `npm test`，結果 **5690 passed / 3 failed / 42 skipped**（532 檔）。失敗為 relay-contract 兩案例與 shell-token-not-in-argv 一案例；產品碼與主線相同，故記為此主線在本機的既有失敗，未宣稱全綠，也未為文件提交修改 Shell 契約。

這不等於新 P0 修正分支的驗收結果。該分支須另跑新增的狀態／恢復測試及相關 Electron 回歸。
