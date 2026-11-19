# Tasks: 時間軸指令區間——每個終端機一條軌

**Input**：[spec.md](spec.md)、[plan.md](plan.md)

**規則**：

- 每個行為任務先寫 RED，再實作；紅的原因記在 commit 訊息。
- 每片一個 PR，從新的 `main` 開分支。任何兩片不同時改 `Timeline.tsx`。
- push 前依序跑：`npm run typecheck && npm run verify:specs && npm run verify:architecture && npm run verify:i18n`，再跑碰到的測試檔。本機不跑 e2e。
- 不新增種類字面值的比較（`test/kinds/kind-literal-ratchet.test.ts`）；renderer 不 value-import `src/core/ingest/terminal.ts`。

## S0 文件

- [x] T000 `spec.md`（含擁有者 2026-11-18 的 P1、Q1–Q4 決定）、`plan.md`、`tasks.md`；`specs/README.md` 加一列。狀態 Draft。

## S1 區間資料加軌道骨架（看得到、不能點）

- [x] T010 RED：`test/timeline-intervals.test.ts`：一對、缺半（兩個方向）、衝突的結束、指令文字不符、重複的起點、`command_boundary`、`session_end`、亂序、結束早於開始；SC-001 的性質測試（固定種子的偽亂數列）。
- [x] T011 `src/renderer/src/lib/timelineIntervals.ts`：plan「接縫」的型別、`buildCommandIntervals`、`terminalTrackKey`、`nextTrackOrder`；配對呼叫 `collapseCommandPairs`／`unfinishedCommandIds`，角色以查表判斷。
- [x] T012 `lib/timelineIncremental.ts` 的 `commandIntervals` 推導；`test/timeline-incremental-equivalence.test.ts` 加入它（SC-002）。
- [x] T013 RED：`test/timeline-command-tracks.test.tsx`：兩個終端機兩個終端列與其標籤；`makeEvent` 的預設資料沒有終端列，`[data-timeline-event]` 數不變（FR-016）；可見列上限與滾輪的垂直捲動（plan E-1）。
- [x] T014 `components/timeline/TimelineCommandTracks.tsx`（只畫標籤與線，`aria-hidden`、`pointer-events-none`）；`Timeline.tsx` 的列順序、可見高度上限與繪製。

## S2 版面：狀態、名稱、密度（仍不能點）

- [x] T020 RED：`test/timeline-interval-layout.test.ts`（寬度不足 14px 是 point、同格合併與計數、聯集線、深度上限、`open` 畫到下一個起點、`endsMayBeMissing` 時只有 16px、起點未知只有 stub、名稱擇側與 48px 門檻、SC-003、SC-004）。
- [x] T021 `lib/timelineIntervalLayout.ts`：`layoutIntervalMarks`、`filterVisibleMarks`。
- [x] T022 `TimelineCommandTracks.tsx` 依 `IntervalMark` 畫 span／point／cluster、四種終點與名稱；`Timeline.tsx` 依可視範圍篩選。

## S3 互動與切換

- [x] T030 RED：`test/timeline-interval-select.test.tsx`（點一段區間選到它的 `command_end`、事件列上不再有同一個指令的點；雙擊、Enter、↑/↓、←/→、單一 Tab 停留點、FR-007 的 DOM 版）。
- [x] T031 區間記號成為按鈕；事件列扣掉 `claimed`；`nextSelection` 的列依事件；計數記號開叢集清單；走到捲出的列時垂直捲入。
- [x] T032 `computeDomainBounds` 納入區間起點（FR-065），移除 S1 的左緣裁切。
- [x] T033 `test/timeline-hit-targets.test.tsx`、`test/timeline-time-map.test.ts` 加區間的案例；已更新受影響的 e2e specs，本機依 brief 不執行。合併前仍須 CI 跑完整 e2e。

## S4 疊層與誠實規則

- [ ] T040 RED：`test/timeline-interval-honesty.test.tsx`：
  - [x] S3 round 2 提前：`/` 命中 start 時區間點亮、焦點鏈與計數變暗、終點徽章與 `ioMark`。
  - [ ] S4：設了結束時間時只有 start 的指令不延伸、`hasMore` 的計數寫法、讀取失敗時的狀態。
- [ ] T041 疊層與誠實規則：
  - [x] S3 round 2 提前：變暗搬到區間；終點記號上的 `ioMark` 與徽章；計數依所有成員變暗並提升最嚴重徽章。
  - [ ] S4：`endsMayBeMissing`（FR-025）；精確可及名稱、計數可及名稱、`title` 與終端列群組名稱的 i18n 鍵。

## S5 e2e、文件、效能

- [ ] T050 `e2e/timeline-track.spec.ts` 新增 describe `timeline-command-tracks`（SC-005、SC-006）；更新 `:525` 的標題與註解。
- [ ] T051 擁有者核可後修訂 `docs/UIUX-STANDARD.md` §6 與 Spec 069 FR-008（spec「與既有文件的衝突」）。
- [ ] T052 `REDLOG_PERF` 的區間量測（FR-083）。
- [ ] T053 `docs/domain/glossary.md` 加入指令區間、終端軌、選取列、事件列。
