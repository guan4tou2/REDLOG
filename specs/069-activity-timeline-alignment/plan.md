# Implementation Plan: 活動紀錄與時間軸 — 對齊 Stitch 設計決策

依 spec.md(D1=A、D2=只改有關的 key、D3=現有版面標為進階泳道＋補單軌標準,皆已決議)。每任務 tests→實作;小步獨立 PR。S0 調查先做,其結果決定 S2 是否只需補斷言。

## S0 — 現況調查（唯讀，先做）

- HTTP 詳情現在是不是已經上下排列（`HttpHistoryPanel`／`TimelineEventDetails`）。
- `Timeline.tsx` 的 `selectedEvent` 與 `ActivityResults` 的 `selected` 兩套選取如何互通;「在時間軸定位」的現有機制（`redlog-timeline-focus-event`）。
- `EventContentReader` 對沒有專屬 descriptor 的來源會怎樣;是否已有通用後備。
- 列出所有使用者可見的 Scope／AI／截圖字串（i18n en／zh-TW），逐條標「保留／改」。
- 事件數、來源數統計目前由哪裡算。

## S1 — 文案語意（US1）

- i18n 字串改為中性的「範圍外觀測」;`warnOnViolation` 設定文案同步。
- 專案未設定 Scope 的事件標題與徽章:「尚未判定」。
- AI／截圖文案審計後只刪除多餘宣稱。
- 測試:字串守門測試（沿用 `ui-copy`）加一個黑名單斷言——使用者可見字串不含「凍結」「Chain-of-Thought」「已確認違規」等。
- e2e:搜尋舊字串的斷言一併更新（`verify:i18n` 會抓）。

## S2 — HTTP 上下排列（US2）

依 S0 結果:若已是垂直，僅補保留換行的斷言與 e2e;否則改版面。

## S3 — 共用選取＋Generic Reader（US3）

- 單一選取來源（hook 或 context），Timeline 與 ActivityResults 讀它;不再各自持有。
- 「在時間軸定位」帶 id，不帶固定事件。
- Reader 的上一筆／下一筆依目前篩選排序;Generic Reader 在沒有專屬實作時顯示通用欄位。

## S6 — 視覺重做(US5)

1. 產出 token／版面差異清單(原型 vs. `styles/index.css`、側邊欄 240 對 224、主要紅色、字型),寫入 implementation-notes.md,由使用者確認基準。
2. 依頁面分批:共用外框(Header／Sidebar／Footer)→ 活動紀錄與時間軸 → 其餘。每批獨立 PR,維持既有 e2e。

## S4 — 標準／泳道（US4）

依 D3:現有版面不重寫,標為「進階泳道」;新增單軌依序版面並設為預設。偏好以 per-project 機制保存;選取、縮放、隱藏泳道在切換時保留。

## S5 — 識別字（FR-010）

依 D1=A。先寫雜湊鏈不變與舊事件可讀的測試,再改程式內符號(型別、函式、元件、有關的 i18n key);`scope_violation` 與 `warnOnViolation` 不改,集中成具名常數。

## Verification

五道 gate;macOS arm64 原生 e2e;Windows 版面另列。
