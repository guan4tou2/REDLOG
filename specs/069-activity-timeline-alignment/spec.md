# Feature Specification: 活動紀錄與時間軸 — 對齊 Stitch 設計決策

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
- **FR-009** 事件數、來源數、狀態統計由同一份已載入資料計算;被截斷時標示總數（沿用 *Capped views* 原則）。
- **FR-010** 識別字重命名依 D1(A):只改程式內符號;持久化值(`scope_violation`、`warnOnViolation`)不變,並有測試鎖住「既有事件重載後 `chain.verify()` 為 ok、舊 config 仍被讀取」。
- **FR-011** 不更動 068 的專案選擇畫面、不更動外掛管理頁（本規格不含報告第二份的外掛頁修正，見下）。

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
