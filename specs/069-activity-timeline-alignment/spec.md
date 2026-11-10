# Feature Specification: 活動紀錄與時間軸 — 對齊 Stitch 設計決策

> **部分設計決策已被取代。** 活動紀錄與時間軸目前採獨立主要入口(側邊欄各有直接入口),下列「採用的設計決策」第 1 點「同一工作區」不再適用。相關歷史需求保留作為決策背景;實作應遵循最新 `docs/UIUX-STANDARD.md`(設計決策附錄 UX-002)。

**Feature Branch**: `docs/069-activity-timeline-alignment`
**Created**: 2026-11-05
**Status**: Draft
**Input**: 2026-11-05 提供的兩份 Stitch 原型（活動紀錄＋時間軸、外掛管理）與三份審查報告；使用者選定「文案語意、HTTP 上下排列、Timeline 標準／泳道切換、共用 selectedEventId＋Generic Reader」，並要求「連同識別字一起改」。

## 決策與範圍

審查報告審的是**原型**。原型的 JS 缺陷（`timeline-controls` 不存在、`navigateReader`／`saveReaderExport` 未定義、`locateFromReader()` 固定跳 `ev-1`、寫死的 `left:20%`、假的複製成功提示、5 筆對 161 筆）在 RedLog 都不存在：RedLog 已有真事件資料、`Timeline.tsx` 泳道與隱藏泳道記憶、`EventContentReader` 的視窗讀取／搜尋／複製／另存。所以本規格**只採用原型的設計決策與文案守則，不搬任何原型程式**。

「全部依照 stitch 重構」的解讀：把下列決策落到既有元件，不重寫 Timeline、不新增與記錄無關的功能（沿用 *No gratuitous features*、*No report generation*）。

採用的設計決策（來自報告）：

1. 活動紀錄與時間軸同一工作區，列表／時間軸切換在工具列。
2. 時間軸內有兩種呈現：**標準時間軸**（預設，依序閱讀）與**進階泳道**（來源重疊與密度）。
3. HTTP Request／Response 上下排列，原始內容保留換行。
4. 列表、時間軸、Reader 共用同一個選取事件；Reader 對未識別來源有後備（Generic Reader）。
5. 文案守則：Scope 是**被動範圍觀測**；AI 只呈現實際擷取到的對話與工具事件；截圖不推論漏洞或報告。
6. 計數（事件數、來源數、狀態統計）由同一份資料算出。

## 硬約束:識別字不能全部改

使用者選了「連同識別字一起改」。這在**持久化的值**上做不到，必須先決議:

- `scope_violation` 是 `events.data.subtype` 的值，**在雜湊鏈涵蓋的 `data` 內**（`chain-anchor.ts` 以 `row.data` 重建每筆雜湊）。改寫既有事件的 subtype 會讓 `chain.verify()` 失敗，等於毀掉已交付的證據。
- 同一個值也是 `scope-recompute-run.ts`、`alert/surface.ts`、`activity-projection.ts`、`scope-violation-standing.ts` 的查詢條件，以及 API／匯出（JSONL 為 canonical，藍隊交接）的對外契約。
- 舊專案、舊 `.redlog` bundle 永遠會帶 `scope_violation`。

所以「改識別字」只能是下列之一（**D1 已決議採 A**,見文末）:

| 選項 | 內容 | 風險 |
| --- | --- | --- |
| A（建議） | 改**程式內符號**（型別、函式、元件、i18n key，如 `ScopeViolation*` → `ScopeObservation*`）與**非持久化**的設定鍵；**持久化／對外的值**（`scope_violation`）維持，集中成一個具名常數與一處對照 | 低；無資料遷移 |
| B | 新事件改寫 `scope_observation`，讀取端永久同時接受兩個值 | 中；查詢、匯出、API 都要雙值，舊 bundle 與新 bundle 在同一份分析裡混用兩個詞 |
| C | 重寫既有事件 | **不可行**:破壞雜湊鏈 |

設定鍵 `warnOnViolation` 是 `config.yaml` 內的持久化值,不在 A 的改名範圍內(見文末)。

## User Scenarios & Testing

| 故事 | 優先級 | 說明 |
| --- | --- | --- |
| US1 文案語意 | P1 | 使用者看到的 Scope 字樣是「範圍外觀測」，不是「違規／越界／CRITICAL」，也沒有「凍結通訊」「已確認違規」這類 RedLog 並未做的宣稱。專案未設定 Scope 時顯示「尚未判定」，不預設為範圍外。 |
| US2 HTTP 上下排列 | P2 | HTTP 詳情 Request 在上、Response 在下，原始內容保留換行與空白。 |
| US3 共用選取＋Generic Reader | P1 | 在列表選取、在時間軸定位、開啟 Reader，三處是同一個事件；Reader 上一筆／下一筆沿用同一排序。來源類型沒有專屬 Reader 時走通用 Reader，顯示實際欄位，不報錯。 |
| US5 畫面照 Stitch 重做 | P2 | 使用者追加(2026-11-05):畫面不只採用決策,而是照 Stitch 原型重做。基準為**現行 app 的 token**:#575 的 `app-reference` 用的就是現行色碼,不是另一套主題;Stitch 兩份原型彼此不一致(主色 `#d75f63` 對 `#a1373d`),且其邊框、次級文字、填色字色低於現行對比規則,不能照抄(見 implementation-notes T016)。先產出 token／版面差異清單,再依頁面分批重做;每批維持既有資料與互動,只換呈現。 |
| US6 設定導航改型 | P3 | 設定原型取消 212px 第二層側邊欄,改為首頁三區塊單欄列表(擷取來源／專案設定／其他設定)加「管理 ›」子頁與「← 返回設定」。這會牽動深層連結、設定搜尋索引與 e2e helper,**須先有獨立規格與遷移計畫**,本規格只登記。 |
| US4 標準／泳道 | P2 | 時間軸內可在「標準時間軸」與「進階泳道」間切換，預設標準；選擇會記住（沿用 Timeline 既有的 per-project 偏好機制）；選取與縮放在兩種模式間保留。 |

## Requirements

- **FR-001** 使用者可見文案不得出現「違規／越界／violation／CRITICAL／凍結／已確認」描述 Scope 觀測;改用「範圍外」「依目前 Scope 設定」。RedLog 只記錄，不阻擋，文案不得暗示阻擋。
- **FR-002** 未設定 Scope（`unset`）或讀不到（`unknown`）時，事件不得標為範圍外；顯示「尚未判定」或「範圍未知」。與 068 的徽章語意一致。
- **FR-003** AI 事件詳情只顯示實際擷取到的欄位（對話、工具名稱、參數、結果）；不得出現「Chain-of-Thought」「推理鏈」等 RedLog 並未擷取的內容宣稱。
- **FR-004** 截圖事件詳情只顯示檔名、尺寸、雜湊與使用者備註；不推論漏洞，不稱已納入報告。
- **FR-005** HTTP 詳情 Request／Response 垂直排列；內容以保留換行的區塊顯示。
- **FR-006** 單一 `selectedEventId` 為列表、時間軸、Reader 所共用；切換檢視不遺失選取;「在時間軸定位」定位到當前事件而不是固定事件。
- **FR-007** Reader 對沒有專屬實作的來源提供 Generic Reader：標題、時間、來源、原始欄位的安全顯示;新增來源不需改核心 Reader。
- **FR-008** 時間軸有「標準」與「進階泳道」兩種模式，預設標準;兩種模式共用同一時間座標與事件集合。
  - **2026-11-08 更新(底部摘要列與點擊契約)**:選取事件時,時間軸底部常駐一條摘要列(`timeline-detail-panel`):時間 · 軌道名稱 · 標題;其下只列事件真有的欄位(結束碼、耗時、`data.pid` 存在才顯示 PID、目標與「依目前範圍：範圍內／範圍外／尚未判定」——未設定範圍時為「尚未判定」,讀不到為「範圍未知」,符合 FR-002);按鈕為上一個／下一個事件、複製事件參照、開啟專屬 Reader(同一個 `EventContentReader`,僅指令結束與 HTTP 事件提供)、在活動紀錄開啟完整內容、詳情。詳情本體(因果、圖、各類型細節、重播、JSON、備註、DNE、前後文、修正、停靠與縮放)為 `timeline-detail-body`。**單擊**節點或卡片=選取並顯示摘要列,本體維持關閉(本體已開啟時,改選其他事件沿用開啟);**雙擊、Enter、摘要列「詳情」**=開啟本體。雙擊的第二下(`e.detail`≥2)不會把選取切回,只有明確的單擊(`detail`=1)再點已選取者才取消選取;鍵盤觸發的 click(`detail`=0)不取消。雙擊開啟的是**第一下點擊**所在的事件(第一下可能讓卡片展開、點位 z-index 改變而使版面位移);卡片的 stdout 摘要在選取穩定 400 ms 後才展開。Enter 在節點或卡片上為開／關本體;本體右上 X 只關本體、保留選取;叢集彈窗內單擊只選取。「開啟專屬 Reader」只在有已保存內容(指令的 stdout/stderr ref、HTTP 的已保存本文)時出現,且一律開成展開狀態。自其他頁面抵達(在時間軸定位、返回、還原選取)仍直接開啟本體。Escape 依序:說明 → 聚焦模式 → 本體 → 選取。鍵盤移動選取超出可視視窗時,視窗隨之捲動。圖例提示為「點擊節點聚焦摘要 · 雙擊開啟詳情」(原型寫「打開完整日誌」,輸出可能被截斷或未捕獲,不採用)。
- **FR-009** 事件數、來源數、狀態統計由同一份已載入資料計算;被截斷時標示總數（沿用 *Capped views* 原則）。
- **FR-010** 識別字重命名依 D1(A):只改程式內符號;持久化值(`scope_violation`、`warnOnViolation`)不變,並有測試鎖住「既有事件重載後 `chain.verify()` 為 ok、舊 config 仍被讀取」。
- **FR-011** 視覺重做(US5)以 #575 的 Design System 為單一基準:Header、Sidebar、Footer、字型、色彩、間距沿用,不為單一頁面保留另一套 token。每個頁面分批,不一次替換整個 UI;每批須維持既有資料、鍵盤操作與 e2e。
- **FR-012** 視覺重做不得搬運原型的 JS、固定資料或假提示。
- **FR-013** 只有 `command_start`、找不到對應 `command_end` 的指令,在 Timeline 列與詳情、Activity 列都標示「執行中／狀態未知」,不得判為失敗(舊的 start 可能是被中斷的指令;已載入範圍外的 end 同理)。
- **FR-014** 指令詳情的 STDOUT 區塊與 STDERR 同規則:空內容不顯示;「已知為空」不等於「未捕獲輸出」,後者的說明維持不變。
- **FR-015** Activity 列顯示指令結果:結束碼 0 為成功,非 0 顯示結束碼,有結束事件但無結束碼顯示「已結束」;結果取自配對的 `command_end`,不另造狀態。列的標題樣式(`$ cmd → exit N`)不在本條範圍。

## 不在範圍

- 外掛管理頁的版面回歸（列首重複、分類數量寫死、展開過多）:報告指的是 Stitch 原型的回歸。RedLog 的外掛頁已由 065／066 實作並以資料計算數量;若要對齊原型的視覺，另開規格。
- 搬運 Stitch 原型的 JS、固定資料或 `alert()` 假提示。
- 新增報告產生、漏洞判定、自動分析功能。

## 已決議(2026-11-05)

| # | 決策 | 定案 |
| --- | --- | --- |
| D1 | 識別字重命名 | **採 A**:改程式內符號與非持久化的設定鍵;`scope_violation` 這類**持久化／對外的值不改**,集中成一個具名常數與一處對照。不重寫既有事件,不做雙值讀取。 |
| D2 | i18n key 範圍 | **只改與 Scope 觀測有關的 key**(`scope.*violation*`、`sidebar.violationsBadge`、`eventTitle.scopeViolation`、`statusBar.scopeViolations` 等),其餘不動。 |
| D3 | 標準時間軸 | 現有 Timeline 版面標為「進階泳道」,**另補一個單軌依序的「標準時間軸」**並設為預設;不重寫現有 Timeline。 |

D1 的後果:`warnOnViolation` 是 `config.yaml` 內的持久化鍵,屬於「持久化的值」,**本規格不改名**;只改它的使用者可見文案。若日後要改名,另開規格並附 `loadConfig` 讀舊鍵的相容測試。
