# RedLog — Stitch UI/UX 整合設計契約

用途：Stitch 原型到 React 的工程對照。全域設計決策以 [UI/UX 規範](UIUX-STANDARD.md) 為準，功能需求與驗收以各自的 Spec 為準。§10 保留舊工作區的驗收紀錄。
整理日期：2026-11-06（Asia/Taipei）。  
本機核對基準：`e176777ad9289b174e4237f26c7fd124801a692d` 加目前未提交工作區變更。  
輸入：使用者提供的 `UIUX-STITCH-DESIGN.md` 草稿、已確認的對話決策及具名 Stitch HTML。桌面原稿保持不變。

2026-11-07 已另行 fetch 並在乾淨 main `ebd9f4b105c912506121c4aa7acdbf6f117c7576` 完成局部 Electron 稽核，見 [最新 main 差異矩陣](UIUX-JOURNEY-AUDIT-2026-11-07.md)。以下本機快照不代表最新主線；側欄現為 240/48px、⌘1–7／設定 ⌘9，且 specs 065–069 已存在。以新矩陣判斷主線剩餘工作，避免重做插件、證據與設定整合。原本機仍未合併該版本；文件提交與推送不代表產品程式已整合或發布。

## 1. 文件分工、目標與限制

| 文件 | 唯一責任 |
|---|---|
| [UIUX-STANDARD.md](UIUX-STANDARD.md) | 全域字體、色彩、密度、共用元件與可用性規範；本文件不重抄 token 表。 |
| [DESIGN-core-and-capture.md](DESIGN-core-and-capture.md) | 產品定位、核心與擷取責任。 |
| 本文件 | 已確認的頁面結構、跨頁流程、狀態語義及整合邊界。 |
| [剩餘實作計畫](UIUX-REMAINING-IMPLEMENTATION-PLAN.md) | 工作排序與未完成項目；歷史日期不代表目前進度。 |
| `specs/<feature>/spec.md`、`plan.md`、`tasks.md` | 功能需求、實作步驟、影響範圍與驗收任務。 |
| [本機驗證紀錄](UIUX-CONSISTENCY-VERIFICATION-2026-11-06.md) | 實際執行的測試、平台、結果、限制與截圖位置。 |

RedLog 是本機優先的被動操作記錄工具。改版應使操作者找到保存內容、辨認來源與缺漏、完成來源設定及回溯，不新增報告產生、漏洞判定、掃描或強制阻擋功能。

**保留現有功能與資料契約，優先調整 UI 結構；只有現有元件無法滿足已確認設計時才作必要重構。** 不建立平行資料庫、事件模型、Reader、插件宿主或匯出後端。

決策適用順序：本次使用者明確指示與平台規則 → 已確認產品／資料契約 → 共用視覺規範 → 本文件的整合決策 → 原型。若涉及資料完整性或尚未決定的產品行為，列出具體衝突；已取得的決策不反覆詢問。普通版面選擇不新增批准流程。

## 2. 全域架構與決策紀錄

| ID | 已確認決策 | 工程約束 |
|---|---|---|
| D01 | 主工作區採單欄閱讀 | 列表與完整詳情垂直／切頁閱讀；圖片網格、時間軸泳道、終端內容不是第二個管理側欄。 |
| D02 | 活動紀錄與時間軸獨立入口 | 都可由側欄直接到達；時間軸須有真實時間比例、區間或並行分析價值。 |
| D03 | 沿用 App Shell | 不在各頁重建 Header、Sidebar、StatusBar、全域匯出／截圖／附件／標記。 |
| D04 | 保留進階 Scope；建立時可選填範圍 | 使用者已確認此設計意向；不強制填寫，不把進階選項變成起步門檻。舊 Spec 的範圍限制須另行協調，見 §11。 |
| D05 | Scope 是被動觀測 | 未設定是提示；未知、讀取失敗不冒充未設定或範圍內。不得改寫歷史事件判定。 |
| D06 | 證據整合截圖／戰利品／書籤 | 保留各自資料語義；可編輯書籤不宣稱不可變證據，規則命中不代表漏洞或有效憑證。 |
| D07 | 保留 xterm.js／PTY 與 Shell Hook | 兩者狀態分開；不以 HTML 模擬終端取代實際錄影、輸出和互動。 |
| D08 | Pivot 留在儀表板網路區 | IP 與 Pivot 分開處理，不依時間順序推定路由拓撲。 |
| D09 | 設定首頁 → 子頁 → 返回 | 擷取來源、專案設定、應用程式設定三組；保留搜尋、深層入口與自動保存。 |
| D10 | 插件安裝／信任與來源操作分工 | 插件是功能安裝單位；來源負責專案擷取與驗證，避免兩頁提供衝突開關。 |
| D11 | 共用事件擴充契約 | 同類來源重用 Reader，未知類型有通用後備；資料保存、搜尋、遮蔽與驗證由核心擁有。 |
| D12 | 不產生分析報告 | Markdown 是對話紀錄／目前選取內容，不額外生成評估、成本或成功結論。 |

目前主線的共用導航為 dashboard → search → timeline → http_history → targets → screenshots → terminal，快捷鍵依序為 ⌘1–7，設定為 ⌘9。側欄展開 240px、收合 48px。權威為 `sidebarOrder.ts` 與 `Sidebar.tsx`；舊本機 150px／時間軸無編號的實作不可覆蓋主線。

字型、13px 文字下限、品牌／危險色、按鈕層級與焦點遵循正式規範及 `styles/index.css`。長內容只在合適的內容區捲動；窄視窗、高縮放不能讓關鍵操作不可達。

## 3. 各頁設計契約

### 3.1 儀表板

順序為需要處理 → 擷取狀態 → 網路／Pivot → 記錄概況 → 專案摘要。問題區沒有問題時隱藏；不要用固定綠燈或模擬成功補空間。快捷鍵屬次要資訊。

沿用 issue store、Capture Health 與 counts。全域錄製開關不表示所有來源健康；總事件、已上鏈、僅記錄分開，不把僅記錄說成待上鏈。首次使用嵌入既有 `FirstRunView`。

### 3.2 活動紀錄與 Reader

全寬列表、搜尋與來源／標記篩選共用條件，交集生效。Inspector 為可關閉的快速檢視，完整 Reader 單欄；不永久壓縮主列表成左右兩欄。

- 保存 projectId、eventId、查詢、snapshot、選取及返回位置；上下筆依目前結果集合。
- 完整內容搜尋走核心索引／內容服務，包含保存的工具結果與 HTTP 本文，不能只查 DOM。
- 已知空 stdout／stderr 可隱藏；讀取失敗、未擷取、未知、截斷、串流中不當作空。
- HTTP Request／Response、附件及指令重用既有專門 Reader；未知類型用 Generic 後備。
- 「已標記」、Scope 判定、附件存在各為獨立維度，不用單一字串互相覆蓋。
- 事件資訊只顯示實際存在的欄位，不補固定 PID、耗時、退出碼或雜湊。

AI Session 使用相同資料集合渲染 prompt、助理訊息、工具呼叫／結果及 Markdown。Session 身分包含專案、擷取 Session、來源與來源 Session；重複工具 ID 不可跨 Session 配對。切換後立即清除舊閱讀狀態，非同步舊回覆不可覆蓋新選取。

僅呈現來源實際提供的內容，不推定取得內部推理，不將工具聲稱保存證據當作核心驗證。複製 Markdown 不另建匯出系統；若只含載入／篩選內容或有截斷，須標明。Session 結束、資料已載入至快照、來源持續擷取是不同狀態。

### 3.3 時間軸

獨立側欄入口。標準模式與進階泳道是時間軸內部閱讀方式；標準為設計預設，具體實作依相應 Spec 核對，不從原型判定已完成。

依真實時間／區間布局；瞬間、持續、進行中、未知時間語義不混用。兩種模式共用事件 ID、篩選、選取與縮放。從其他頁定位指定事件，返回原狀態。不因時間接近建立因果箭頭。

### 3.4 HTTP 歷程

Request 在上、Response 在下，保留原始換行。主流程採列表到單欄詳情；既有側邊詳情選項的遷移需明列，不能悄悄刪除能力或偏好。

代理服務、流量路由、CA 信任、HTTPS 驗證、CDP 各自呈現。未驗證附近有可用動作；成功後能定位保存的驗證請求。設定完成不等於真實 HTTPS 已擷取。

### 3.5 目標與範圍

清單與觀測閱讀保持單欄；進階規則沿用 Scope 設定。設定摘要統計有效 targets 與 Burp／ZAP 範圍檔，讀取失敗不得當作零條。歷史判定以保存的依據為準，不被目前設定錯誤覆蓋。

來源事件可定位時間軸。原型「設為範圍內」不得假成功；修改設定與重新評估須走現有契約，不能改寫證據鏈中的 `scope_violation`。

### 3.6 證據

截圖／戰利品／書籤共用工作區入口。

- 截圖清單與可選網格使用真實附件，搜尋與來源篩選同時生效；刪檔後明示缺件，保留既有事件紀錄。
- 戰利品為特徵命中，敏感摘要按核心政策呈現；可到實際來源事件，命中數不冒充事件數。
- 書籤列表 → 單欄編輯 → 返回，保留搜尋、排序與位置。可編輯筆記不是不可變鏈證據。
- 本機保存、完整性檢查、外部時間戳分開；雜湊存在不表示驗證通過。

### 3.7 終端機

保留 xterm.js、PTY、ANSI、互動、搜尋、resize 及錄影讀取。偵測到的 Shell 才可列為可用，不寫死平台清單。

PTY Session、Shell Hook 接入與錄影結果分開。結束後重啟產生新 Session，舊輸出與錄影缺失仍可追溯；暫停錄影不宣稱所有來源都停止保存。不存在「100% 回放」或安裝即成功擷取的保證。

### 3.8 設定、插件、首次使用與專案啟動

設定首頁三組入口；子頁保留直接導航、搜尋定位、保存／失敗／重試。子頁返回首頁，插件詳情返回插件列表，層級名稱明確。

插件搜尋列表 → 單一詳情 → 返回，保存查詢與焦點。詳情呈現版本、能力、授權／內容變更及貢獻診斷；安裝、信任、全域啟用、專案授權、來源健康分開。官方可選目錄僅使用實際可安裝的 manifest，不假裝已有 Marketplace 或第三方執行隔離。

首次使用採垂直流程：指令 → HTTP → 更多來源，兩種驗證互不阻塞。初始資訊漸進展開，非必要來源不阻止開始工作。正常接入按鈕不用危險色。

專案選擇單欄、搜尋與建立 Modal，保留草稿、IME、焦點及重新啟動後資料。搜尋 Enter 不默認開啟不明確的第一項；只能依已確認選取或唯一結果執行。範圍可選填及進階編輯意向見 D04，實作狀態不可從附件推定。

## 4. 跨頁流程與返回契約

| 流程 | 必須攜帶／保留 | 驗收重點 |
|---|---|---|
| 活動 → Reader → 時間軸 → 返回 | 專案、eventId、查詢、snapshot、位置 | 相同事件，上下筆不越過結果集合；返回不清空條件。 |
| Reader → 相關附件／證據 | 真實附件參照或關聯 eventId | 無檔案／無權限明示；無關聯時不虛構入口。 |
| 儀表板異常 → 對應來源設定 | issue 指定的設定頁／來源 | 直接修復原因，返回後取得真實狀態。 |
| HTTP → 事件／時間軸 | flowId 及實際事件 ID | Request／Response 配對正確，不跳固定範例。 |
| 目標／Scope → 時間軸 | 來源 eventId、時間、目標條件 | 歷史判定不變，返回條件保留。 |
| 戰利品 → 來源；書籤 → 編輯／返回 | 來源識別；書籤識別、查詢、位置 | 命中不是漏洞確認；更新與返回一致。 |
| 終端機 → 錄影 | 專案、PTY Session、內容參照 | 不混用其他分頁或重啟後 Session。 |
| 儀表板 → 網路／Pivot | IP 狀態及來源回報清單 | 不以 Pivot 數量推論 IP 安全。 |
| 插件 ↔ 擷取來源 | 對應插件／來源、作用範圍 | 通用入口與精確定位分開驗收；不得聲稱已定位但只開頁面。 |
| AI Session A → B → A | 專案、provider、captureSession、sourceSession、snapshot | 全部訊息與複製內容一致，舊回覆不覆蓋新 Session。 |

## 5. 資料來源與狀態契約

| 領域 | 本機現有權威入口 | 狀態規則 |
|---|---|---|
| Capture Health | `lib/useCaptureHealth.ts`、`components/CaptureHealth.tsx` | 健康、部分缺失、不可用、未知分開；全域 REC 不代表每個來源正常。 |
| HTTP 驗證 | `HttpCaptureStep.tsx`、`settings/BrowserPage.tsx` | 入口可點與實際請求已保存分開驗收；不以定時器給成功。 |
| 事件與搜尋 | `ActivityResults.tsx`、`SearchPanel.tsx`、`EventContentReader.tsx` | 真實 query／snapshot／內容版本；完整內容與摘要有明確界線。 |
| Session 與工具配對 | `SourceSessionPicker.tsx`、`TranscriptView.tsx`、核心 source-sessions／operation-pair-key | 資料隔離包含專案與來源，不能只用 tool_use_id。 |
| Scope | `ScopeStatus.tsx`、`settings/ScopePage.tsx` | set／unset／unknown 與歷史判定分開；不吞讀取錯誤當空。 |
| PTY | `TerminalView.tsx`、`lib/terminalRecordingSummary.ts` | 執行生命週期與錄影缺漏獨立；結束後仍能揭露歷史失敗。 |
| 完整性 | 核心鏈／驗證 API、`settings/IntegrityPanel.tsx` | 已保存、未檢查、通過、失敗分開；結果須對應實際資料範圍。 |
| 插件 | `settings/PluginsPanel.tsx`、既有 plugin API | 信任不等於隔離，載入不等於每個貢獻有效；失敗不冒充空清單。 |

通用讀取狀態：loading 是等待；empty 必須是成功查詢的空結果；error 提供來源與重試；unknown 不給成功結論。若保留上次資料須標過時及時間。局部錯誤不能清掉其他來源的有效結果。

### 5.1 Pivot 與 IP

`lib/usePivots.ts` 使用 `pivots.getActive()`／`onChange`；現有 `ActivePivot` 僅有 `via`、`tool`、可選 `route` 與 `ts`，沒有節點連線／拓撲欄位。

- 成功空結果時隱藏拓撲／Pivot 子區塊；一個或多個結果以來源回報清單呈現。
- 沒有可信 edge 時不畫「本機 → 出口 → 所有跳板」的完整路徑；`ts` 只表示時間。
- IP safe／exposed／unknown 與 Pivot 獨立，不從 Pivot 推論流量確實經過某節點。
- 本機缺口：hook 初次讀取失敗被吞成初始空陣列；`IPStatusCard` 在沒有 IP status 時提前返回；按時間排序畫鏈也不構成路由證據。這些是**待實作修正**，本文件不聲稱已完成。
- 最小修正應沿用 hook／卡片，擴充讀取狀態並解耦呈現；同步檢查 HUD 消費端，不另建 API。
- 驗收：0／1／多節點、長名稱／缺 route、更新／移除、IP 成敗 × Pivot 成敗、取消訂閱及窄視窗。

## 6. React 元件對照與重用邊界

以下路徑均相對 `src/renderer/src/`，已於本機確認存在。

| 頁面／責任 | 現有元件／模組 |
|---|---|
| App Shell／導航 | `App.tsx`、`components/Sidebar.tsx`、`lib/sidebarOrder.ts` |
| 儀表板／問題 | `components/DashboardView.tsx`、`components/DashboardIssues.tsx` |
| 擷取健康／IP／Pivot | `components/CaptureHealth.tsx`、`components/IPStatusCard.tsx`、`lib/usePivots.ts` |
| 活動／Session | `components/RecordingWorkspace.tsx`、`components/ActivityResults.tsx`、`components/SearchPanel.tsx`、`components/SourceSessionPicker.tsx`、`components/TranscriptView.tsx` |
| Reader／時間軸 | `components/EventContentReader.tsx`、`components/Timeline.tsx`、`components/TimelineEventDetails.tsx`、`components/timeline/TimelineEventInspector.tsx` |
| HTTP | `components/HttpHistoryPanel.tsx`、`components/HttpDetail.tsx`、`components/HttpCaptureStep.tsx`、`components/settings/BrowserPage.tsx` |
| 目標／Scope | `components/TargetView.tsx`、`components/ScopeStatus.tsx`、`components/settings/ScopePage.tsx` |
| 證據 | `components/ScreenshotsView.tsx`、`components/LootPanel.tsx`、`components/BookmarksView.tsx` |
| 終端／首次使用 | `components/TerminalView.tsx`、`components/RecordTerminalFlow.tsx`、`components/FirstRunView.tsx` |
| 設定／插件／啟動 | `components/Settings.tsx`、`components/settings/PluginsPanel.tsx`、`components/settings/CaptureControlPage.tsx`、`components/ProjectPicker.tsx` |
| 共用控制 | `components/Button.tsx`、`components/Modal.tsx`、`components/CopyButton.tsx`、`components/settings/SettingsShared.tsx`（FieldGroup） |
| 全域匯出 | `components/ExportMenu.tsx`、`lib/exportScope.ts` |

附件中的 `ActivityReader.tsx`、`TargetsScopeHeader.tsx` 不存在於本機基準；不得據此新增同名替代元件，先核對目標分支與既有實作。事件擴充另見 [Event Extension Contract](ACTIVITY-EVENT-EXTENSION-CONTRACT-v1.md)，不是本輪已完成的第三方插件平台。

## 7. 原型資產與正式版差異

具名原始資產與 SHA-256 見 [資產索引](UIUX-STITCH-ASSETS.md)。原稿及離線復刻目前位於本機 repo 外的 `../design-reference/`，**不會隨 implementation 的 commit 自動交付**。跨機協作前須另行封裝或納入核准資產目錄，不能提供不存在的 repo 相對連結。

| 類型 | 使用方式 |
|---|---|
| Stitch 原稿 | 視覺及動線依據，保留原文；不能當成功功能測試。 |
| `redlog-activity.html` | 互動示例，具示例搜尋／Reader／時間軸；十欄摘要非正式證據匯出格式。 |
| settings／startup／transcript／plugins React 復刻 | 正式 DOM 測試快照、正式 build CSS 與字型；可用的導航依腳本提供，寫入／擷取／驗證停用。 |
| React Electron | 真實 API、事件與狀態的驗收對象；測試播種資料仍非真實外部來源擷取。 |

原型的尺寸、色彩與快捷鍵若和正式系統不同，以共用設計規則及目標分支一致性為準。不能把文字「已複製」當剪貼簿成功，不能把 HTML 開啟成功當全流程驗收。

## 8. 禁止移植的原型行為

- 固定版本、事件數、時間、PID、退出碼、費用、雜湊、IP 或來源健康。
- setTimeout 後宣稱已安裝、驗證、重連、補齊記錄缺口或保存證據。
- 只換 Session 標頭／部分 DOM，保留另一 Session 的工具與回答。
- 全域固定 Markdown、錯誤 Turn 數、DOM 搜尋冒充完整內容搜尋。
- DOM 替換冒充敏感資料保護；未經核心政策將 raw secret 傳入複製／匯出。
- 額外報告產生器、第二套 Export Modal、Marketplace 或任意第三方 React／JS 注入。
- 重複 HTML 文件、結尾後追加腳本、重複函式、CDN Tailwind 作為正式 Renderer。
- 固定 LIVE／ACTIVE LISTENER／Audited 等無真實依據的保證。

## 9. 驗收條件

| ID | 必驗流程 | 最低證據 |
|---|---|---|
| A01 | 活動／時間軸直接入口與返回 | 真正點擊入口，保留查詢、事件及位置；不能用命令面板替代缺失入口。 |
| A02 | 長 stdout、空 stderr、未擷取與串流 | 核對保存內容；`ls` 與 `ls -al`／PTY 錄影等實際來源另驗。 |
| A03 | AI Session 切換、同 tool ID、Markdown | 不同來源／Session 內容隔離，舊回覆無效；搜尋收合工具結果。 |
| A04 | HTTP 設定 → 真實 HTTPS → 保存 → Reader | 服務、CA、路由與驗證結果各自正確；入口測試不能代替此項。 |
| A05 | Scope 與歷史判定 | 未設定、檔案損毀、讀取失敗、僅範圍檔的專案分開。 |
| A06 | 證據搜尋／預覽／編輯／來源 | 真實附件及事件 ID；刪檔留紀錄，書籤返回位置保留。 |
| A07 | PTY 失敗 → 恢復 → 結束 → 重啟 | Session 隔離，舊錄影異常保留；Hook 與錄影分開。 |
| A08 | IP／Pivot 組合狀態 | §5.1 全部案例，不畫推定路由。 |
| A09 | 設定首頁、子頁與深層入口 | 搜尋、返回、保存失敗重試與專案切換正確。 |
| A10 | 插件列表 → 詳情 → 授權／啟停 → 來源 | 真實 API 結果、全域／專案範圍清楚、返回查詢與焦點。 |
| A11 | 初始設置及專案啟動 | 寬窗仍單欄、來源驗證獨立、Modal 草稿／IME／焦點／重啟保存。 |

每頁須涵蓋正常、loading、empty、error／retry 與適用的 unknown／stale。檢查桌面、窄視窗、高縮放、長文、鍵盤與可達操作；HTML 390px 與 Electron 有最小視窗限制的測試分開記錄。

使用既有 runtime／lockfile／驗證命令。需要提交 PR 的檢查沿用 `CLAUDE.md`；測試失敗、略過、未驗證平台如實列出。安裝版、Windows Shell／WSL、Linux、真實擷取、效能都不能由 macOS 測試資料推定完成。

## 10. 歷史本機實作與驗收快照（2026-11-06）

**本節不作為現行待辦。** 最新主線的逐頁狀態以 [稽核矩陣](UIUX-JOURNEY-AUDIT-2026-11-07.md) 為準；保留此節以對應舊測試證據。

四個階段的定義：**設計已確認**＝決策固定；**實作中**＝目標契約尚有缺口；**已實作**＝指定基準中存在行為；**已驗收**＝指定案例、資料及平台有證據。必須標範圍，某個測試通過不將整頁升級為全部已驗收。發布是另一個維度。

| 頁面／工作 | 設計 | 本機實作階段 | 驗收範圍／缺口 |
|---|---|---|---|
| 儀表板／Pivot | 方向已確認；未取得全部具名精修稿 | 實作中：既有元件；§5.1 缺口未修 | 新布局、IP／Pivot 成敗組合待驗。 |
| 活動／Reader | 已確認 | 已實作：查詢、Reader、標記、定位 | 已驗收部分 macOS 播種事件流程；真實全來源輸出、完整視覺仍需對照。 |
| AI Transcript | 已確認 | 已實作：Session 條件立即生效及隔離 | 29 項相關測試、雙 Session Electron 案例；未宣稱所有遮蔽通道已稽核。 |
| 時間軸 | 獨立入口已確認 | 入口已實作；標準／進階最新整合待同步核對 | 已驗收入口；全模式、效能及跨頁完整矩陣未完成。 |
| HTTP | 上下閱讀／驗證分工已確認 | 既有 Reader／驗證入口，全面對齊中 | 入口與部分保存本文流程通過；真實 HTTPS 完整鏈待驗。 |
| 目標與範圍 | 單欄方向已確認 | 既有功能；新視覺整合待核對 | 歷史判定／新布局全面驗收待補。 |
| 證據 | 使用者確認方向；附件聲稱遠端 #609 已合併 | 本機未據此標為同步完成 | 需核對遠端差異與實機證據，不能列成完全未做或已驗收。 |
| 終端機 | 保留 xterm／PTY 已確認 | 既有功能；新視覺與生命週期覆蓋待核對 | Windows／WSL 與實際錄影未完成本輪驗收。 |
| 設定首頁 | 已確認 | 已實作：三組、12 子頁、返回／搜尋 | 已驗收 macOS 中英文、窄窗／高縮放、保存與重試。 |
| 插件 | 單欄列表／詳情已確認 | 已實作；官方目錄與指定來源定位尚未完成 | 42 項相關測試、9 項含設定的 Electron 流程；第三方執行隔離不在本輪。 |
| 專案啟動／首次使用 | 單欄、選填 Scope 意向已確認 | 單欄／Modal 已實作；Scope 建立期需同步核對 | 建立／搜尋／重啟／寬窗垂直流程通過；大專案冷啟與真實首錄待驗。 |

詳細證據及檢查限制以 [驗證紀錄](UIUX-CONSISTENCY-VERIFICATION-2026-11-06.md) 為準。上列是本機未提交工作區狀態，不能代表遠端、安裝版或發布版。

## 11. 版本差異與協調事項

| ID | 發現 | 處理 |
|---|---|---|
| C01 | 本機 HEAD／origin/main 與附件聲稱遠端基準不同 | 後續整合先取得目標版本差異，保留未提交修改；本文件不自行 pull／merge。 |
| C02 | 舊 checkout 缺少新 Spec；main 已有 065–069 | 使用主線既有 Spec 與 verification，不重建同號文件；Draft 不等於完全未實作。 |
| C03 | Scope 建立期意向與舊 #297／068 邊界不同 | 使用者已確認可選填方向；同步後核對既有實作及 Spec，更新適用範圍，不在搜尋徽章任務偷偷加入其他行為。 |
| C04 | 導覽順序、快捷鍵及側欄寬度兩版本不同 | 採本文件 §2 已核對的主線順序、快捷鍵與寬度；不沿用舊本機值。 |
| C05 | 舊本機缺少主線文件 | 主線已有 [同步紀錄](UIUX-SYNC-STATUS.md)，已補現況導覽；元件對照仍需按目標版本核對。 |
| C06 | Pivot 清單被畫為完整路由、錯誤當空 | 依 §5.1 作最小契約修正與測試，不假稱已做到。 |
| C07 | 原型及復刻不在 Git repo 內 | 資產索引明示本機位置與 hash；分享／提交前處理交付方式。 |

## 12. 實作順序與交付紀錄

1. **版本與規格對齊**：先核對目標分支、已合併工作與未提交修改；差異分為保留／修正／不移植。避免重做遠端已完成項目。
2. **資料正確性**：補真實 HTTPS、Shell／PTY、Scope、Session／返回狀態的未覆蓋案例；保留本輪已修正項。
3. **儀表板與 Pivot**：修正 unknown／empty、IP 獨立呈現與無依據路徑。
4. **剩餘頁面對齊**：HTTP、目標、證據、終端逐頁核對，重用原元件。
5. **插件驗收收尾**：官方目錄與指定來源定位已存在，補未覆蓋的平台及失敗案例；不重做、不新增 Marketplace。
6. **跨頁／平台／效能驗收**：依 §9 矩陣記錄平台及資料規模；未通過不得被原型截圖取代。

每次交付記錄：設計資產及 hash、程式基準／工作區差異、影響元件與資料契約、通過／失敗／略過案例、GUI 證據、尚欠項目、commit／merge／release 狀態。沿用現有 Spec/Plan，不為每頁建立另一套 design.md 流程。
