# RedLog｜Stitch UI/UX 整合設計規格

> **文件定位**：跨頁設計決策與 React 整合契約（Design Specification），**不是**第二套 Design System、產品功能規格或完成驗收證明。  
> **建議位置**：`docs/design/UIUX-STITCH-DESIGN.md`  
> **文件狀態**：Draft — 設計決策彙整，可供實作拆分；各頁正式驗收依下文逐項確認。  
> **整理日期**：2026-11-06（Asia/Taipei）  
> **程式碼檢查基準**：`guan4tou2/REDLOG` `main` @ `ebd9f4b105c912506121c4aa7acdbf6f117c7576`（2026-11-06 13:54:29 UTC；PR #609 已合併）。  
> **適用對象**：設計審查者、Claude Code／Codex、React 開發者、測試／PR 審查者。  
> **適用範圍**：RedLog 桌面應用程式的七個主要工作區、首次使用、專案啟動、設定與跨頁操作。

## 0. 如何使用本文件

1. 開始修改某一頁前，先閱讀本文件的「不可變更決策」與該頁條款，再確認最新 `main`、既有 Spec/Plan、目前 React 行為及使用者核准的 Stitch 版本。
2. 先寫 **差異清單**（保留／修正／不實作），再執行最小變更。禁止直接把 Stitch HTML、JavaScript、假資料或 Tailwind CDN 搬進 Renderer。
3. 有資料模型、持久化契約、權限、擷取或導覽衝突時，先更新對應 Spec/Plan 並取得決策；不能用視覺稿覆蓋已實作的安全／正確性契約。
4. 「視覺定稿」≠「React 已整合」≠「E2E 通過」≠「已發布」。每頁需獨立紀錄證據。
5. 這份文件僅是 **2026-11-06 的設計快照**。每輪 PR 應重新核對程式碼與相關 Spec 狀態，不能把以下狀態當成永久事實。

### 0.1 規格優先順序

- **產品及資料安全／既有合法持久化契約**：`docs/design/DESIGN-core-and-capture.md`、相關 `specs/*/spec.md`、實際核心／preload 契約；禁止因 UI 改版破壞證據鏈或歷史資料。
- **共用外觀與行為**：`docs/UIUX-STANDARD.md`、現行 `src/renderer` tokens／共用元件；不要在本文件複製其全部 token 表。
- **本次核准的 UX 決策**：本文件的「已確認」決策與具名 Stitch 基準。
- **具體工單／驗收**：既有 `specs/*/plan.md`、`docs/records/2026-11-04/UIUX-REMAINING-IMPLEMENTATION-PLAN.md`、測試與 PR。

**衝突處理**：若 draft spec、舊規範和最新使用者決策不一致，不擅自選一邊默默實作；在 PR 中列出衝突、建議決議與要更新的文件。尤其見 §11。

## 1. 產品目標、非目標與不可變更決策

### 1.1 產品目標

RedLog 是本機優先、**被動記錄**的滲透測試／紅隊活動工具：協助操作者知道「實際做過什麼、保存了什麼、事後在哪裡找得到」，並誠實揭露缺漏、未知與擷取異常。證據鏈與匯出是既有能力；UI 不得憑藉雜湊值推論已驗證、不可篡改或已成功交付。

### 1.2 已確認的 UX 決策（不可隨意改回）

| ID | 決策 | 驗收標準 |
|---|---|---|
| D-01 | **主要工作區使用單欄閱讀流程** | 不加入主內容左右分割詳情；列表→單欄詳情→返回。縮圖網格屬同一工作區的圖片瀏覽模式，不等於雙欄主介面。 |
| D-02 | **活動紀錄與時間軸具有獨立直接導覽入口** | 側邊欄可直接進入兩個工作區；不能只藏在活動列表工具列。時間軸內部可再提供標準／進階泳道模式。 |
| D-03 | **保留現有 App Shell** | Header、Sidebar、StatusBar、專案切換、錄製切換、全域截圖／附件／匯出使用正式元件；頁面不複製。 |
| D-04 | **Scope 是被動觀測，不做強制阻擋** | 「範圍外觀測」不得寫成已確認違規或自動阻止；未設定／讀取失敗不可當範圍內。 |
| D-05 | **範圍仍由既有 Scope 設定擁有** | 「目標與範圍」可呈現與定位；進階範圍編輯由既有設定處理。建立專案時可設定範圍的 UX 決策須與現有 Spec 邊界協調（§11）。 |
| D-06 | **證據工作區為截圖／戰利品／書籤** | 截圖清單／網格；戰利品被動特徵命中；書籤是可編輯的本機筆記，非自動上鏈證據。 |
| D-07 | **終端機沿用 xterm.js 與現有 PTY** | 不以 HTML 假指令輸出替代；PTY 錄影狀態與 Shell Hook 指令事件狀態分開。 |
| D-08 | **儀表板重視異常與擷取可用性** | 需要處理→擷取→網路／Pivot→記錄概況→專案摘要；正常時不顯示空的「一切正常」問題面板。 |
| D-09 | **Pivot 不得遺漏** | 網路區塊沿用 `IPStatusCard`／`usePivots()`；沒有可驗證的邊關係，不把時間排序畫成路由拓撲。 |
| D-10 | **不建立第二套擷取／插件管理機制** | 插件探索與信任、來源開關、各來源驗證仍按現有唯一管理權責；從異常直接導向該處。 |
| D-11 | **沿用既有搜尋、Reader、匯出契約** | 不用原型固定筆數、假命中、假的檔案預覽或成功 Toast。 |
| D-12 | **正式 UI 保留繁體中文，狀態誠實** | `loading`／`ready`／`empty`／`error`／`unknown` 各有獨立語義；不以「沒有資料」取代「讀取失敗」。 |

### 1.3 不在此次設計範圍

- 新增報告產生器、漏洞驗證／評分器、主動阻擋或掃描引擎。
- 新寫 PTY、Shell Hook、HTTP Proxy、DNS 監聽、錄影儲存、雜湊鏈、匯出核心。
- 插件 Marketplace、全新插件執行宿主、第二個擷取來源授權面板。
- 把原型的 `DEMO` 服務、固定 PID／雜湊／IP／事件數、模擬向量截圖當真實資料。
- 未經確認的跨頁重構、替換 App Shell、整套字型與設計 token。

## 2. 全域資訊架構與版面

### 2.1 正式主要導覽

依目前 `src/renderer/src/lib/sidebarOrder.ts`，七個入口的順序如下：

1. 儀表板 `dashboard`
2. 活動紀錄 `search`
3. 時間軸 `timeline`
4. HTTP 歷程 `http_history`
5. 目標與範圍 `targets`
6. 證據 `screenshots`
7. 終端機 `terminal`

設定 `settings` 為固定獨立入口。`transcript` 從屬活動、`scope` 從屬目標、`loot` 和 `bookmarks` 從屬證據；不需要為這些子檢視新增主要導覽列。

**重要**：截至基準 commit，`Sidebar.tsx` 的展開／收合寬度為 **240px／48px**，不是若干 Stitch HTML 的 150px。頁面整合一律使用正式 Sidebar；不因一頁原型另改 App Shell 尺寸。快捷鍵映射沿用 `sidebarOrder.ts`，不在畫面內硬編碼。

### 2.2 區塊排序與單欄原則

- 主工作區整體為單欄。卡片資訊可在同一行放置「標題、狀態、操作」；長內容、詳細資料以直向排列。
- 列表詳情、Reader、書籤編輯、戰利品展開不得依大視窗自動復活成「左列表＋右詳情」。
- 首要操作與異常在視線最前面；健康來源與進階說明採漸進展開。
- 各頁保持清楚的返回位置、篩選、捲動與事件選取；不要靠新建頁面繞過既有狀態。
- 主區不得出現重複的全域錄影、截圖、加入附件、匯出功能按鈕；只有明確對應空狀態／修復入口才可例外。
- 響應式依**內容容器可用寬度**處理，狀態及操作不能因窄視窗或高縮放消失。

### 2.3 樣式與可用性契約

- 使用現有 Noto Sans TC、JetBrains Mono、React 共用按鈕、Lucide icon、間距／密度 tokens。
- 正式工作區文字原則依 `UIUX-STANDARD.md` **13px 下限**（規範允許的 HUD 例外除外），不得直接移植原型 10–12px 標籤。
- 品牌紅不是錯誤紅；危險用法、計數顏色、對比與焦點 ring 遵循正式 Design System。
- 語義性狀態皆有文字，不只靠顏色；錯誤必須指出資料來源與可執行的下一步。
- `loading`、空資料、局部讀取失敗與整頁致命錯誤各自呈現；失敗不清掉已取得的其他區塊。
- 原型 HTML/JS 只當互動設計參考。React 使用安全文字渲染，禁止以使用者資料組 `innerHTML` 或行內 `onclick`。

## 3. 分頁設計契約

### 3.1 儀表板（Dashboard）

**使用者任務**：一眼得知「目前什麼需要處理、哪些來源實際可記錄、網路／Pivot 狀態與已記錄規模」。

**固定資訊順序**：

1. **需要處理**：使用既有 `DashboardIssues` 的 issue store；僅當問題存在顯示，附明確處理或跳轉。
2. **擷取狀態**：沿用 `CaptureHealthCard`、`useCaptureHealthState()`；突出指令與 HTTP(S)，其他來源依目前真實狀態逐步展開。
3. **網路／Pivot**：使用 `IPStatusCard`、`usePivots()`；內外 IP、安全／未知狀態與 Pivot 清單獨立處理，詳見 §5。
4. **記錄概況**：同一份 counts 的專案總事件數；清楚分辨已上鏈／僅記錄、錨定狀態，不把「僅記錄」寫成「緩衝待鏈」。
5. **專案摘要**：只放識別、名稱、操作員及必要範圍摘要；修改至既有設定。
6. **快捷鍵**：次要資訊，預設收合。

**四種設計情境**：需要處理／正常／讀取未知／首次使用。這是原型驗收工具列，**正式版不能保留情境控制器**。首次使用必須沿用 `FirstRunView` 的實際環境檢查、指令與 HTTP(S) 個別驗證，不新增互相阻塞的步驟。

**注意**：全域 REC 開關 ≠ 所有來源健康；未知不顯示綠燈；HTTP 代理監聽 ≠ HTTPS 已由真實客戶端驗證。

**目前元件**：`DashboardView.tsx`、`DashboardIssues.tsx`、`CaptureHealth.tsx`、`IPStatusCard.tsx`、`FirstRunView.tsx`、`usePivots.ts`、`useAppCounts.ts`。

### 3.2 活動紀錄與 Reader

**使用者任務**：找到記錄，判斷來源、配對狀態、完整輸出，再定位相關時間軸事件。

- `search` 有獨立導覽；搜尋／篩選與結果清單保持同一組條件，避免條件互相覆寫。
- 選取事件保有穩定 ID 與返回位置；Activity、Timeline 與 Reader 不能各自跳到不同事件。
- `command_start` 缺少可信 `command_end` 時顯示「執行中／狀態未知」，不可推斷失敗。
- `stdout`／`stderr`：已知為空則不顯示空區塊；讀取失敗、未知、截斷或持續串流不能當成已知空白；PTY `.cast` 為混合流，不虛構為分離 stdout/stderr。
- 長輸出沿用現有 Reader 的搜尋／複製／另存；新來源使用 Generic Reader 後備，不要求新增每類專屬頁面。
- AI Session 只顯示實際已擷取的 prompt、回答、工具使用及結果；不冒充完整推理內容，也不把 AI 工具回報誤認為獨立觀測到 Shell。

**目前元件**：`SearchPanel.tsx`、`ActivityResults.tsx`、`ActivityReader.tsx`、`EventContentReader.tsx`、`TranscriptView.tsx`。  
**相關規格**：`specs/069-activity-timeline-alignment/spec.md`、`specs/064-recording-first-workspace/spec.md`。

### 3.3 獨立時間軸（Timeline）

- 時間軸保留**獨立側邊欄入口**；標準時間軸與進階泳道是時間軸內的兩種顯示方式，預設標準（詳見 Spec 069 的 D3）。
- 使用同一事件集合、時間座標、已選取事件及實際查詢範圍；切換模式不得重設選取與縮放。
- 事件數、已載入數、已上鏈／僅記錄層級來自資料；不能用固定示範統計。
- 事件詳情與 Reader 應可回到原操作；從 Loot、HTTP、範圍觀測定位到對應事件，不跳到固定 ID。
- 尊重持久化事件的實際 subtype。Scope 使用者可見文案可以改，但**不得覆寫既有 `scope_violation` 事件**，以免破壞鏈校驗。

**目前元件**：`Timeline.tsx`、`TimelineEventDetails.tsx`、`components/timeline/*`。  
**待協調**：Spec 069 文字中「活動紀錄與時間軸同一工作區」與本輪已核准的獨立導覽不一致；見 §11，**不可默默合併入口**。

### 3.4 HTTP 歷程

- 與 Activity、Timeline 相容的事件定位與瀏覽方式；Request 在上、Response 在下，保留原始換行／空白。
- HTTP 來源健康、Proxy 服務啟動、客戶端是否經過代理、CA 信任、HTTPS nonce 驗證分開，不得以「已設定」冒充「已驗證」。
- 有效的驗證動作可直接到既有 HTTP 設定／驗證流程；完成後能找到保存的測試請求。
- 對未驗證、空資料、讀取失敗、代理服務異常、憑證錯誤分別呈現；不新增另一套 HTTP 擷取後端。
- HTTP Request／Response 詳情不應因寬視窗擅自改成左右分割。

**目前元件**：`HttpHistoryPanel.tsx`、`HttpCaptureStep.tsx`、`settings/BrowserPage.tsx`、`settings/BrowserPanel.tsx`。  
**相關計畫**：`docs/records/2026-11-04/UIUX-REMAINING-IMPLEMENTATION-PLAN.md` 的 HTTP 真實客戶端驗收。

### 3.5 目標與範圍

- 目標清單與範圍觀測兩種閱讀任務共用單欄頁面，但 Scope 規則的設定主權仍留設定。
- 保留已核准的目標清單視覺與進階範圍設定入口；列出目標不等於其活動已被確認授權。
- Scope `set`／`unset`／`unknown`／讀取失敗必須分開；歷史觀測依事件當時或實際儲存狀態顯示，不能用**目前**的 Scope 讀取失敗覆蓋過去紀錄。
- 範圍提示是被動判定，不聲稱阻擋、不以假重算時間或假「設為範圍內」操作給出成功訊息。
- 搜尋、篩選、零結果和展開狀態一致；從觀測可定位相關時間軸事件。

**目前元件**：`TargetView.tsx`、`ScopeStatus.tsx`、`TargetsScopeHeader.tsx`、`settings/ScopePage.tsx`。

### 3.6 證據（Evidence）

三個子頁籤：**截圖／戰利品／書籤**。頁內不另建全域截圖、加入檔案、匯出工具列。

**截圖**
- 單欄清單為預設；可切換真正縮圖卡片網格，保留檢視偏好。
- 觸發來源篩選與搜尋同時生效；搜尋範圍如僅限已載入項目，需清楚註明。
- 預覽使用真實截圖／既有讀取 API，不使用 CSS 模擬向量截圖。
- 刪除檔案後明示「檔案已刪除」，但原事件與刪除紀錄依既有契約保留。
- SHA-256 表示紀錄值，不等於完整性已驗證；驗證結果必須有真實執行依據。

**戰利品（Loot）**
- 表示規則命中與來源定位，不代表憑證有效或漏洞成立。
- 清單單欄、詳情就地展開，敏感摘要預設遮蔽；深度內容走現有 Reader／權限契約。
- 以實際匹配來源算數，不把「命中筆數」冒充「來源事件筆數」。

**書籤**
- 列表→單欄詳情／編輯→返回，保留搜尋、釘選排序與返回位置。
- 書籤是本機可編輯筆記，**不是自動上鏈的證據**；URL 清單須避免輕易暴露敏感查詢值。

**目前元件**：`ScreenshotsView.tsx`、`LootPanel.tsx`、`BookmarksView.tsx`。  
**已知程式進度**：**PR #609 已於本文件基準 commit 合併**，摘要包含證據頁共用標題與頁籤、截圖清單／網格、戰利品展開、書籤單欄流程。這表示相關改動已進 `main`，**不等於**已完成全平台／安裝版驗收；不得把此頁機械列成「完全未整合」。

### 3.7 終端機（Terminal）

- 保留 xterm.js、PTY 管理、互動式程式、ANSI 控制序列、搜尋 addon、字級與終端 resize；HTML 模擬輸入／輸出不是實作方案。
- 分頁標示 Shell／工作目錄／PTY 錄影狀態；**錄影流**與**Shell Hook 指令事件接入**各自維護，不依 Shell 名稱直接假設成功。
- 工作階段結束是單向生命週期；再次啟動產生新的 PTY Session 識別，不復活已結束程序。
- 可沿用分頁 UI，但新 Session 不得覆寫舊 Session 的歷史錄影異常、暫停／缺失，舊輸出不得冒用新 Session 身分。
- 已結束仍可看到「曾發生部分錄影失敗／缺失」摘要；正式版使用現有 `terminalRecordingSummary.ts`。
- 錄影異常不宣稱 Shell 已被 RedLog 阻斷；暫停 PTY 錄影不等於全部事件都停止保存。
- 終端搜尋沿用實際 xterm 內容；`⌘K` 不重新占用（保留全域命令面板）。
- Shell 清單來自實際可用／偵測環境（Windows PowerShell、PowerShell 7、WSL 等依實機），不是固定 zsh/bash/fish。
- 讀取失敗、Shell 退出、錄影異常與 Hook 未接入用不同文案；不得宣稱 `.cast`「100% 重現」或「一定保存所有輸入」。

**目前元件**：`TerminalView.tsx`、`terminalRecordingSummary.ts`、`terminalFont.ts`、`RecordTerminalFlow.tsx`。  
**設計狀態**：Stitch 視覺已完成審查，可作視覺基準；正式生命週期與資料處理依 React／PTY 既有契約，不移植原型 JS。

### 3.8 設定、插件與首次使用／專案啟動

- 設定依工作目的分組、減少資訊重複；擷取來源、插件安裝／信任與專案授權**各有唯一管理權責**。
- HTTP 的「未驗證」附近需可找到實際驗證入口；不要把 CDP 連線測試混稱 HTTPS 驗證。
- Shell 安裝列出偵測到的支援環境、接入狀態與可行操作；普通接入／驗證不是危險動作，不使用危險紅按鈕。
- 插件探索、搜尋、需要處理、列表／詳情，與專案擷取開關區分；同一插件只出現一列，安裝／信任／功能生效／專案設定／擷取健康不混成一顆綠燈。
- 專案啟動保留搜尋、鍵盤、建立與草稿；範圍狀態為 `set`／`unset`／`unknown`，不得把損毀或載入失敗顯示成「尚未設定」。
- 首次使用的兩個核心驗證：**指令擷取**、**HTTP(S)**，互不相依；內建終端可先使用，外部 Shell Hook 是另一個接入步驟。
- 可選來源以漸進揭露呈現；慢速環境 preflight、缺依賴不應無條件卡住整個工作區。
- 建立專案時提供 Scope 設定是使用者曾提出並偏好的 UX，但當前 Spec 068 明確將其列為範圍外：落地前必須另行決策與規格更新，不可默默加到此批 PR。

**目前元件**：`Settings.tsx`、`components/settings/*`、`ProjectPicker.tsx`、`FirstRunView.tsx`、`RecordTerminalFlow.tsx`。  
**相關規格**：`specs/065-*`、`066-*`、`067-*`、`068-*`、`037-*`。

## 4. 跨頁導航與閱讀狀態

| 起點 | 操作 | 目標 | 保留／驗收 |
|---|---|---|---|
| 儀表板問題列 | 點「處理／前往」 | 相應設定、完整性或 Scope | 顯示該問題對應的實際操作，處理失敗不假報成功。 |
| 儀表板擷取 | 點來源或驗證入口 | 對應擷取設定／終端機 | 不建立另一套來源開關；返回時狀態更新。 |
| 儀表板 Pivot | 檢視偵測到的中繼 | `IPStatusCard` 網路區塊／既有 HUD | 同一份 `usePivots()` 資料，不新增假路由表。 |
| 活動紀錄 | 選指令／搜尋結果 | Reader | 保留 event ID、搜尋條件、列表位置。 |
| Reader | 點「在時間軸定位」 | 獨立時間軸 | 定位**目前選取**事件，可返回原頁。 |
| HTTP 歷程 | 點請求或來源事件 | HTTP 詳情／時間軸 | Request/Response 真實內容；範圍與時間定位一致。 |
| 目標與範圍 | 點觀測紀錄 | 時間軸 | 保留實際 Scope 語義，未知不當作違規。 |
| 證據／戰利品 | 點來源事件 | 時間軸／Reader | 來源 Event ID 正確，避免跳到固定 demo 事件。 |
| 證據／書籤 | 點「編輯／返回」 | 書籤列表／單欄詳情 | 搜尋與捲動保留，編輯後列表更新。 |
| 終端機 | 點分頁／搜尋 | 當前 PTY Session | 搜尋只對該分頁，Session 狀態不與其他分頁混淆。 |
| 首次使用 | 完成某來源驗證 | 既有工作區 | 真實記錄到達後更新，不要求另一來源先完成。 |

**不得由時間鄰近自動宣稱不同來源間存在因果關係**。若無可信的關聯 ID，僅能標示「相關背景／候選關聯」。

## 5. 網路狀態與 Pivot（必須保留）

### 5.1 現有資料契約

- `src/renderer/src/lib/usePivots.ts`：`usePivots()` 由 main process 的 `pivots.getActive()` 與 `pivots.onChange` 提供資料。
- `ActivePivot` 現有欄位：`via: string`、`tool: string`、`route?: string`、`ts: number`。
- `IPStatusCard.tsx` 負責內部／外部 IP、暴露／未知狀態與 Pivot 呈現；不再平行建立新 Pivot API 或新儀表板元件來複製狀態。
- Pivot 來源稱「active」係資料來源回報；**不表示 RedLog 已驗證每次流量都確實經過該節點**。

### 5.2 顯示規則

1. **有 Pivot**：在「網路狀態」卡片內展示偵測到／來源回報的 Pivot，能看到 `tool`、`via`、已知 `route` 與時間資訊（正確格式化）；資料不足以判定作用中時，標示「狀態待確認」。
2. **無 Pivot**：確認來源成功回傳空陣列時，可隱藏 Pivot 子區塊；不增加空的卡片或第二層管理入口。
3. **Pivot 讀取失敗**：不得偽裝成「目前沒有 Pivot」。現有 `usePivots()` 對初始 `getActive()` 失敗會回傳初始空陣列；**若產品需區分讀取失敗與真正空陣列，必須另定最小狀態擴充並測試**，不得聲稱既有 hook 已能區分。
4. **IP 讀取失敗**：不應因此丟掉獨立取得的 Pivot。現在 `IPStatusCard` 在 `!status` 會直接返回「檢查中」，導致 Pivot 暫時不可見；若此 UX 需要調整，應在該元件內小幅解耦渲染，而非另建一套卡片。
5. **路由箭頭**：`ts` 是時間、**不是 topology edge**。目前以排序結果串箭頭僅能作清單式示意；除非取得可信上游／下游關係，否則建議採「已偵測的 Pivot」節點／列表，不宣稱「本機→出口→所有跳板」是實際轉送鏈。
6. **OPSEC 狀態**：IP safe/exposed/unknown 依 `IPStatus` 真實資料，不由 Pivot 數量推定。使用者查看 Pivot 時，不能遮蔽「IP 暴露狀態未知」提示。

### 5.3 Pivot 驗收案例

- 0、1、多個 Pivot；節點很長、`route` 缺失、同工具多節點、更新／移除後排序；窄視窗可讀。
- IP 成功／失敗 × Pivot 成功／失敗的組合；不捏造成功或空結果。
- 資料只有 `ts`，畫面不得推定節點間的網路路由；沒有 route 時顯示「—」或不顯示該欄。
- `pivots.onChange` 更新網路區塊，離開頁面後取消訂閱。

## 6. 共用資料與狀態契約

| 領域 | 權威來源（現有程式） | UI 原則 |
|---|---|---|
| 擷取健康 | `useCaptureHealthState()`、`CaptureHealthCard` | `healthy`／`partial`／`dark`／`unknown` 不混同；過時最後快照須標時間。 |
| 指令／HTTP | 真實來源事件、各自驗證流程 | 服務啟動 ≠ hook 有效 ≠ 事件已接收 ≠ HTTPS 已驗證。 |
| 事件與層級 | `useAppCounts()`、事件查詢與鏈 API | 總數含已上鏈與僅記錄；鏈一致性只比較相應層級。 |
| Scope | `ScopeStatus`、`ScopePage`、scope 統計 | `set/unset/unknown` 和歷史判定分開；持久化 subtype 不重寫。 |
| Pivot | `usePivots()`、`IPStatusCard` | 來源回報的清單不等於完整實際路徑；失敗和空需區分。 |
| 截圖 | `ScreenshotsView`、既有 Screenshot API | 真實縮圖、刪檔留事件、雜湊不等於鏈驗證。 |
| Loot | `LootPanel`、既有規則查詢 | 特徵命中非確證；秘密預設安全呈現。 |
| 書籤 | `BookmarksView`、既有書籤 API | 可編輯筆記，非不可變鏈紀錄。 |
| PTY Session | `TerminalView`、`terminalRecordingSummary` | 分頁／Session 分離，保存失敗與部分缺失歷史。 |
| 插件／來源 | `PluginsPanel`、Agents／Hooks／Browser 設定 | 安裝、信任、啟用、驗證、健康各自獨立。 |

**通用錯誤規範**：

- `loading`：只在確實等待資料時顯示。
- `ready`：顯示資料值及必要的更新時間。
- `empty`：確知查詢成功且結果為空才顯示。
- `error`：告知失敗來源、已知原因與重試方式。
- `unknown`：無法取得可信目前狀態；不使用上次快照做當前成功推論。
- `stale`（若資料層提供）：上次成功時間可保留，但必須明示它不是當前驗證結果。
- 局部失敗不得連帶清除其他來源的有效資料；計數不可固定寫死。

## 7. Stitch 原型資產與轉譯規則

> 以下是設計會議中的可參照檔名／類型，**不表示已提交 Git repo**。實作 PR 應把核准的原型版本放到可追溯的附件或指定設計資產目錄，記錄 SHA-256／版本；不要用不明確的「最新一版」。

| 介面 | 已有視覺基準／參照 | 工程使用方式 |
|---|---|---|
| 儀表板 | `RedLog_儀表板_單欄Stitch設計基準.html`、後續 717 行 Stitch 精修 HTML | 採用資訊階層；Pivot 採 §5 修正，不複製模擬 IP、事件數或成功狀態。 |
| 活動紀錄／Reader | `RedLog_活動紀錄與Reader_Stitch原型.html` 等討論版 | 元件對照與操作動線；以目前核准版本＋Spec 069 核對。 |
| 時間軸 | `RedLog_時間軸_Stitch原型.html` 等討論版 | 保持直接導覽、模式切換與事件定位；不搬固定刻度與假筆數。 |
| 目標與範圍 | `RedLog_目標與範圍_新設計提案.html`、使用者審閱的 Stitch 修訂 | 保留單欄與觀測分區；歷史狀態與範圍規則依實際資料。 |
| 證據 | `RedLog_證據頁_單欄新設計提案.html`、後續 Stitch 修訂 | 參照視覺；實作已部分合併（PR #609），先比對現況再改。 |
| 終端機 | `RedLog_終端機_單欄Stitch設計基準.html`、後續 952 行 Stitch 版本 | 只採外框與狀態文案；不搬模擬 terminal/PID/Session JS。 |
| HTTP、設定、專案啟動 | 相關先前原型與既有 React | 若沒有明確核准的最終版本，先列為「待核對」；禁止假稱全部已定稿。 |

### 7.1 每頁差異清單模板

```text
頁面／基準：
現行 main commit：
原型附件（檔名／hash／核准日期）：

保留現有：
- [ ] 資料來源、API、持久化與事件鏈
- [ ] 搜尋、Reader、鍵盤、空／失敗狀態

依設計調整：
- [ ] 版面與資訊層級
- [ ] 狀態文案與操作入口
- [ ] 窄視窗／高縮放

不移植：
- [ ] 示範資料、假成功提示與 HTML 互動模擬
- [ ] 重複 App Shell、來源管理或新後端

待決策衝突：
驗收測試：
PR／commit／人工驗收證據：
```

## 8. 建議實作順序與任務拆分

> **原則**：先核對已合併內容、再做高風險正確性、最後統整視覺。此順序不是聲稱所有項目都尚未實作。

| 批次 | 範圍 | 主要工作 | 完成條件 |
|---|---|---|---|
| 0：基準凍結 | 全部頁面 | 固定核准 HTML 版本；重驗 `main`；整理 Spec 衝突與元件差異清單。 | 每項有 owner、版本、保留／修改／不做。 |
| 1：正確性 | 活動／Reader、HTTP、終端 | 查找並驗證缺失輸出、HTTP 真實驗證、PTY 結束與錄影缺漏語義。 | 真實來源驗收，不以 mock 或單元成功代替。 |
| 2：現有頁對齊 | 目標、證據、時間軸 | 優先檢查已合併 PR（尤其證據 #609），只補未達 Stitch 決策的部分。 | 原有操作、e2e、事件鏈不退化。 |
| 3：儀表板與 Pivot | Dashboard／IP／Pivot | 壓縮冗餘、保持 issue store；修正 Pivot 路徑與讀取狀態語義。 | 0／1／多 Pivot、失敗／未知、IP 與 Pivot 組合驗收。 |
| 4：設定與首次使用 | Settings、Plugins、ProjectPicker、FirstRun | 去重單一入口、環境偵測、實際 HTTP/Shell 驗證；協調 Scope 建立期決策。 | 首次操作可走通，失敗可恢復，Windows 真機條件清楚。 |
| 5：跨頁與平台 | 全部 | 導航／返回、選取事件、鍵盤、主視窗縮放、macOS/Windows/Linux、效能。 | 對照 §4、§9 的 E2E 矩陣逐項有證據。 |

## 9. 驗收矩陣與品質門檻

### 9.1 互動／資料驗收

| ID | 場景 | 必須成立的結果 |
|---|---|---|
| A-01 | Sidebar 直接進活動／時間軸 | 入口分離、不需透過命令面板；返回位置正確。 |
| A-02 | 長指令與 `ls`／`ls -al` | 能在對應 Reader／錄影找到保存輸出；空 stderr 不顯示，未擷取不冒充空。 |
| A-03 | HTTP 代理運作但 HTTPS 未驗證 | 顯示未驗證且有明確驗證入口；成功後可讀到對應保存流量。 |
| A-04 | Scope 未設定／讀取失敗 | 不誤顯示觀測為已確定範圍外；歷史狀態不被目前錯誤覆寫。 |
| A-05 | 截圖搜尋＋來源篩選＋預覽 | 交集正確、切換預覽顯示真正圖片；刪除後留事件。 |
| A-06 | Loot 命中與來源 | 不宣稱漏洞／有效憑證；定位到實際 Event ID。 |
| A-07 | 書籤搜尋、編輯、釘選 | 所選資料正確更新；返回保留位置；不冒充鏈上證據。 |
| A-08 | PTY 失敗→恢復→結束→重啟 | 舊錄影缺失可追溯，新 Session 獨立；無假重啟或覆寫舊輸出。 |
| A-09 | Pivot 0／1／多個 | 真實資料與排序；不捏造完整網路路由。 |
| A-10 | IP 讀取失敗但 Pivot 可用 | 不消除已取得 Pivot，也不聲稱 IP 安全。 |
| A-11 | 插件安裝／信任／來源啟用 | 資料軸與唯一入口一致，不存在衝突開關或假成功。 |
| A-12 | 首次使用指令與 HTTP | 彼此獨立；僅真實事件／nonce 驗證成功才顯示完成。 |

### 9.2 UI 與平台驗收

- 每頁：正常、載入、空、部分錯誤、整頁失敗及重試。
- 內容寬 530px、800px 及一般桌面；系統縮放與高 DPI；主區無不可達操作、非必要水平捲動。
- 鍵盤／焦點／IME：分頁、modal、Enter／Escape、搜尋、返回、全域快捷鍵無衝突。
- macOS Electron 原生 E2E；Windows PowerShell／PowerShell 7／WSL 真機安裝與操作驗收；Linux Shell／檔案對話框依既有測試矩陣。
- UI token、TypeScript、i18n、architecture gate、相關單元及 E2E；完整測試若存在環境型失敗，明列其範圍與證據，不能宣稱全綠。
- 原型測試通過 **不能** 當成實際 Electron／真實擷取完成；PR 中需要真實資料與來源證據。
- 未經明確授權不 push、merge、release 或部署。

### 9.3 實作完成紀錄（每個 PR 必填）

```text
設計版本／原型 SHA：
程式碼基準／目標 PR：
影響元件與 API：
保留與修改契約：
已通過（含數量、平台及命令）：
未通過／略過（原因、影響）：
人工 GUI 驗收證據：
是否已 merge／release／部署：
仍待決議項目：
```

## 10. 設計與實作現況（截至本文件基準）

狀態用三個獨立欄位表達：**設計**、**程式**、**驗收**。未知必須寫「待查」，不自動推成未做或已做。

| 頁面 | 設計階段 | 程式整合（此基準可證事項） | 實際驗收 |
|---|---|---|---|
| 儀表板（含 Pivot） | 單欄方向已確立；最新 Stitch 717 行稿待 Pivot 語義修正 | 既有 Dashboard/CaptureHealth/IP/Pivot 元件已存在 | Stitch 原型非正式驗收；實機待查 |
| 活動紀錄／Reader | 有 Stitch 基準與 Spec 069 設計決策 | 既有搜尋、Reader、輸出元件已存在 | 跨頁／真實輸出端到端待查 |
| 獨立時間軸 | 直接入口決策已確認；模式設計依 Spec 069 | 現有 `timeline` 導覽及 `Timeline.tsx` | 新標準模式與整合狀態待查 |
| HTTP 歷程 | 上下閱讀與驗證語義已明確 | HTTP History 與擷取設定既有 | 真實 HTTPS、跨來源驗收待查 |
| 目標與範圍 | 單欄 Stitch 方向已確認 | 既有 Target／Scope 元件及 Header 存在 | 歷史觀測及情境驗收待查 |
| 證據 | Stitch 視覺已定稿 | **PR #609 已合併**，含主要單欄／頁籤／清單改動 | PR 列有相關 E2E；跨平台／安裝版未據此判定完成 |
| 終端機 | Stitch 視覺已定稿 | 既有 xterm.js／PTY 元件存在；原型未作實作依據 | 生命週期與真實擷取待查 |
| 設定／插件 | 有既有 Spec 065–067／設計稿 | 已有 Plugins／Settings 等元件 | 各批 B/C、跨平台進度重新確認 |
| 專案啟動／首次使用 | 有既有 Spec 068、FirstRun 流程 | ProjectPicker／FirstRunView 存在 | 真實首錄、冷啟效能與 Scope 建立期待查 |

## 11. 已知衝突與待決策（不得默默執行）

| ID | 衝突／缺口 | 本文件採取的處理 |
|---|---|---|
| C-01 | Spec 069 寫「活動紀錄與時間軸同一工作區」，使用者先前明確要求時間軸**獨立頁**，且目前 Sidebar 有獨立 `timeline`。 | 保留獨立直接入口；標準／進階泳道是時間軸內部模式。實作前修訂／註明 Spec 069 的導覽用語，避免誤刪入口。 |
| C-02 | 使用者偏好建立專案時能設定 Scope，但 Spec 068 限定本次僅專案搜尋及徽章，範圍設定不在建立流程。 | 保留 UX 意向、列為獨立規格決策；**不**在 068 工作中私自擴充。 |
| C-03 | 最新 Stitch 的 Pivot 畫出「本機→出口→跳板」，現有 `ActivePivot` 無 edge 拓撲模型。 | 以已偵測 Pivot 清單呈現；真拓撲需資料來源可證明。 |
| C-04 | `usePivots()` 目前初次查詢失敗會吞掉例外並回傳空陣列；設計上要分清「未知」與「空」。 | 若要完整達成，提出小幅 read-state 契約調整及測試，不聲稱現有已做到。 |
| C-05 | 現行 Sidebar 展開 240px／收合 48px；部分自行製作的 HTML 使用 150px。 | React 以現有 Sidebar 為準；如要更改寬度，必須全域獨立決策與 E2E。 |
| C-06 | 最新 Stitch 例子會固定成功狀態、假時間、雜湊、IP、recording timer。 | demo 僅供視覺，正式 UI 一律依實際結果；未知保持未知。 |
| C-07 | 既有 `UIUX-STANDARD.md` 含歷史實作狀態；新的 PR（例如 #609）可能已更新現況。 | PR 前以最新 `main`、tests、變更紀錄重新核實；本文件不覆蓋實作事實。 |

## 12. 最終驗收與核准條件

本次 RedLog UI/UX 整合只有在以下情況同時成立才可標「完成」：

- [ ] 七主要工作區與子檢視有一致的導航、單欄閱讀動線、返回與選取狀態。
- [ ] 已核准的 Stitch 視覺基準有具名版本／資產存放位置，無任意二次重設計。
- [ ] 各頁程式未複製 App Shell、狀態 API、擷取／匯出後端或模擬資料。
- [ ] 真實指令輸出、HTTP(S)、PTY、證據與範圍觀測已依完整性規格驗收。
- [ ] 儀表板 **Pivot** 資料和 IP 分開處理；沒有推定的路由鏈與假「安全」狀態。
- [ ] 誤導性文案（不可篡改、100% 回放、Hook 安裝即擷取成功、已確認漏洞）已清除。
- [ ] 空資料／未知／局部錯誤／已過時／失敗各有誠實狀態與可行重試。
- [ ] 導覽／Reader／時間軸／Evidence／終端所有核心流程有跨頁 E2E。
- [ ] 字級／對比／鍵盤／密度／窄視窗與三平台限制已依規範驗收。
- [ ] 各 PR 記錄測試、未解問題與 merge/release 狀態；使用者核准後才推送。

---

### 參考文件（RedLog repo 內）

- `docs/UIUX-STANDARD.md`：全域 Design System；以正式程式中的 tokens 和元件為準。
- `docs/design/DESIGN-core-and-capture.md`、`docs/design/DESIGN-PRINCIPLES.md`：產品定位與核心設計。後者有歷史 §1 已被前者取代的註記。
- `docs/records/2026-11-04/UIUX-REMAINING-IMPLEMENTATION-PLAN.md`、`docs/records/2026-11-05/UIUX-SYNC-STATUS.md`：既有工序與歷史同步記錄；日期可能落後於本文件基準。
- `specs/064-recording-first-workspace/spec.md`：記錄優先、Reader、來源與首次使用工作流。
- `specs/065-plugin-explore-and-manage/spec.md`、`066-*`、`067-*`：插件與安裝／信任邊界。
- `specs/068-project-picker-search-scope/spec.md`：專案清單搜尋、範圍狀態與建立流程邊界。
- `specs/069-activity-timeline-alignment/spec.md`：活動、時間軸與 Reader 的設計決策；注意 §11 的入口衝突。
- `src/renderer/src/lib/sidebarOrder.ts`、`components/Sidebar.tsx`：目前正式導航與尺寸。
- `src/renderer/src/lib/usePivots.ts`、`components/IPStatusCard.tsx`：Pivot 與 IP 顯示。

**文件維護原則**：更新設計決策與驗收證據，不把「曾討論」寫成「已發布」，不以最新 Stitch 原型替代實際 RedLog 契約。
