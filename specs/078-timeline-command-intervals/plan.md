# Implementation Plan: 時間軸指令區間——每個終端機一條軌

**Branch**: `feat/078-timeline-command-intervals-s1`（S0、S1） | **Date**: 2026-11-18 | **Spec**: [spec.md](spec.md)

## Summary

只改標準模式。配對沿用今天的摺疊規則（`collapseCommandPairs`、`unfinishedCommandIds`、`operationPairKey`），不發明新的。有配對身分的指令畫成區間，其餘每一列照舊是事件列上的點。純模組 `lib/timelineIntervals.ts` 是 Spec 074 FR-100 落地時要換掉資料來源的接縫。

**影響派工的讀碼發現**

1. `verify:architecture` 不允許「只有測試用到的 export」（`scripts/verify-architecture.mjs`）。純模組必須和第一個 production 使用者同一個 PR，所以 S1 是「資料加軌道骨架」，不能拆成「先合純模組」。
2. 種類字面值有 ratchet（`test/kinds/kind-literal-ratchet.test.ts`，只能降）。新模組以角色表查表，不寫 `agentType === 'shell'`。
3. 既有標準模式的 jsdom 資料（`test/helpers/timeline-bridge.ts` 的 `makeEvent`）與 e2e seed 都沒有配對鍵，在本設計下照舊是點。
4. 原型的軌道標籤 `pts/3` 沒有資料來源；hook 送的是 `shell`、`pid`、`terminalId`（擁有者 Q2：用 `{shell} {pid}`）。
5. 既有缺陷：`carriesState`／`neverFold` 讀 `exitCode`，指令列帶的是 `exit_code`。另案修正（#831），不在本規格。

## 被否決的替代方案

| 決定 | 否決的方案 | 改選它的條件 |
|---|---|---|
| 一個終端機一列（擁有者 Q1） | 同時存活的終端機共用列（列數等於最大並行數） | 真實專案的終端身分數常態超過約 10 個。今天做需要「閒置多久算結束」的推論：shell hook 只在專案切換時送 `session_end`，而 074 的 `terminal-session` 區間會直接給出這個資料 |
| 無標籤欄，列內貼邊標籤（擁有者 Q3） | 標準模式加 132px 標籤欄 | e2e 顯示貼邊標籤讀不清，或擁有者要與原型一致。代價是 `labelW` 與三處釘住「標準模式沒有標籤欄」的測試（`test/timeline-track-wiring.test.ts`、`test/timeline-focus-standard.test.tsx`、`e2e/timeline-track.spec.ts`） |
| 一條基線、重疊就疊畫 | 每軌兩層 | 巢狀或重疊的比例高到名稱常被蓋住 |
| `open` 虛線畫到下一個起點（擁有者 Q4） | 一律畫到現在（074 FR-100 的字面） | 擁有者要字面一致。代價：暫停期間結束而沒被記到的指令會蓋住同一終端之後所有的指令與名稱 |
| 起點未知不用 `duration_sec` 定位 | 以 `end − duration_sec` 畫出推得的起點 | 擁有者接受「來源回報、1 秒解析度」的位置。代價：`duration_sec: 0` 的列與在載入範圍外的推得起點都要另訂規則 |
| 事件列在最上 | 事件列在最下（原型的順序） | 終端列不設可見上限時 |
| 鍵盤順序依選取列的時間 | 依起點時間 | 與卡片列、〔焦點〕記號一起改（074 之後） |
| 配對直接呼叫 `collapseCommandPairs`／`unfinishedCommandIds` | 在新模組裡另寫一份同樣的規則 | 兩個函式的介面改成無法對一段子集呼叫時 |

## 切片

**共同約束**（每一片都適用）

- gate 順序照 `CLAUDE.md`：`typecheck → verify:specs → verify:architecture → verify:i18n → 針對性的 vitest`。一次只跑一個 vitest，`--maxWorkers=2`；不跑本機 e2e，交給 CI。
- 每片從新的 `main` 開新分支；各自的 worktree；`git commit -- <paths>`。
- 不新增種類字面值的比較：用角色表 `const ROLE: Record<string, 'start'|'end'|'boundary'|'session-end'>` 查表（鏡射 072 plan D6 的 `IntervalDef('command')`）。
- renderer 不得 value-import `src/core/ingest/terminal.ts`（它 import `node:crypto`，`:25`）；直接讀 `_ingest.terminal`。
- 新的 hex 顏色只能放 `lib/timelineDomain.ts`（`test/design-palette.test.ts`）；其餘用 token class。
- 新元件宣告在模組層（`CLAUDE.md` React 一節）。
- 每個新字串兩個語系都要有，並以字面值 `t('…')` 呼叫（`test/i18n-keys.test.ts`）。能沿用的既有鍵：`timeline.command.unfinished`、`activity.result.ended`、`timeline.boundaries.termLabelFmt`、`timeline.notMatching`、`timeline.clusterMoreItems`、`transcript.metaExit`。

**全程不得動**：泳道模式的繪製；`buildClusters` 的語意（`lib/timelineGeometry.ts:248-278`）；`collapseCommandPairs`／`drawnEvents` 的摺疊（卡片列與泳道靠它）；`useTimelinePages`、`useTimelineLive`；密度條；卡片列；工具列；`src/core/**`、`hooks/**`。

### S0 文件（可與 S1 平行）
- 檔案：`specs/078-timeline-command-intervals/{spec.md,plan.md,tasks.md}`、`specs/README.md` 索引一列。
- 風險：無。

### S1 區間資料加軌道骨架（看得到、不能點）
純模組必須有 production 使用者（發現 1），所以和第一次繪製合成一片。

- **新檔 `src/renderer/src/lib/timelineIntervals.ts`**：C 節的型別，加上
  - `buildCommandIntervals(rows: readonly RedLogEvent[]): TimelineIntervalSet`
  - `terminalTrackKey(e: Pick<RedLogEvent,'agentType'|'data'>): string | null`
  - `nextTrackOrder(prev: readonly string[], tracks: readonly TimelineTrack[]): string[]`
- **改 `lib/timelineIncremental.ts`**：加 `export const commandIntervals: Derivation<TimelineIntervalSet>`。`build` 等於 `buildCommandIntervals`；`extend` 在尾段沒有任何指令角色的列時回傳 `prev`，否則回 `null`。這與 `drawnEvents.extend` 在配對閉合時重建的作法相同（`:131-133`）。
- **新檔 `components/timeline/TimelineCommandTracks.tsx`**：`memo` 元件，這一片只畫每段區間的線（`aria-hidden`、`pointer-events-none`）與列標籤。
- **改 `Timeline.tsx`**：
  - `:188` 之後加 `useTimelineDerived(commandIntervals, rawEvents)`。
  - `visibleRows`（`:693-704`）標準模式改為 `[STANDARD_ROW, ...trackOrder]`。
  - `maxHeight`（`:2219`）標準模式改為 `min(列數, 4) * laneH + axisH`。
  - 點的迴圈（`:2505-2707`）之後渲染 `<TimelineCommandTracks/>`。
- **先寫的紅測試**：`test/timeline-intervals.test.ts`「把一對 start／end 配成一段區間，起訖取兩列的 timestamp」。接著是缺半、衝突、文字不符、重複 start、`command_boundary`、`session_end`、亂序，以及 SC-001 的性質測試。
- **改的既有測試**：`test/timeline-incremental-equivalence.test.ts` 加一行 `equivalent('command intervals', commandIntervals, …)`。`makeRow` 已有 `shell`／`terminalId`／`command_id`（`:34`），把 `terminalId` 改為依既有的 `cmd` 變數分 `t1`／`t2`，不增加亂數呼叫。
- **新的 jsdom 測試**：`test/timeline-command-tracks.test.tsx`。兩個終端機出現兩個終端列；`makeEvent` 的預設資料出現零個終端列，且 `[data-timeline-event]` 數不變。
- **過渡狀態**：有配對鍵的指令同時是事件列上的點與終端列上的線。這是刻意的，S3 才切換。
- **風險**：
  - 起點比第一個畫出的列早超過 pad 時，線的起點會在軌道外（`computeDomainBounds` 只看畫出的列，`lib/timelineTimeMap.ts:124-147`）。這一片先以 `Math.max(0, x0)` 裁切並在測試中標明是過渡，S3 修正時間範圍。
  - 貼邊標籤的 `position: sticky` 在絕對定位的列內、`body{zoom:0.9}` 下的行為未經執行驗證。

#### S1 實作時與上述計畫不同之處（讀碼與執行的結果）
- **E-1 的答案是「不能」，且有兩層。** 滾輪的判斷問的是外層量測容器，它從不 overflow（overflow 在 `timeline-lane-scroll`），所以兩種模式下滾輪一律水平平移；改問 `timeline-lane-scroll`。這也改到泳道模式，恢復該處註解（v0.9.4 P0-2）所說的行為。第二層只在瀏覽器中看得到：標準模式沒有標籤欄，軌道捲動區被拉伸到上限高度並以 `overflow-y-hidden` 裁掉自己的第 4、5 列，外層永遠不 overflow，任何方式都捲不到。有終端列時軌道捲動區改為內容高度（`self-start`），上限加上它的水平捲軸厚度（傳統捲軸平台上 10px，否則三列就多出 10px、滾輪變成垂直）。沒有終端列時兩者都不套用（FR-016）。
- **E-6**：標籤不用 `position: sticky`，以面板已追蹤的水平捲動位置（`view.left`）放在可視左緣加 4px。
- **`terminalTrackKey`** 照抄核心 `rowTerminal` 的整個規則，包括 `api`／`handoff` 入口沒有記下終端時為無；計畫原寫「直接讀 `_ingest.terminal`」。測試鎖住兩者一致。
- **配對**直接呼叫 `collapseCommandPairs` 與 `unfinishedCommandIds`（只對指令列的子集，結果相同），不另寫規則；只有「沒有起點列的結束」需要自己判斷衝突，與摺疊用同一個 `sameSourceContent`。
- **SC-001 的「起點集合」**：重複的起點全部被摺疊，但區間的 `startId` 只有最早一筆，所以性質測試比的是「`observed` 區間中角色為起點的成員」等於被摺疊的起點，而不是 `startId` 的集合。
- **測試環境**：jsdom 中軌道寬度從不改變，滾輪處理器只在 `TRACK_W` 改變時綁定，所以 E-1 的測試以回報一次寬度的 `ResizeObserver` 讓它綁定。
- **S1 尚未處理、留給後續切片**：寬度不到 1px 的線（1 秒的指令）看不見（S2 的 point）；只看範圍內等篩選下 `open` 仍畫到下一個起點或右緣（S4 的 FR-025）；有 4 個以上終端列而向下捲動時，時間尺隨內容捲出視野（泳道模式今天也是如此）。

### S2 版面：狀態、名稱、密度（仍不能點）
- **新檔 `src/renderer/src/lib/timelineIntervalLayout.ts`**：`layoutIntervalMarks(input: IntervalLayoutInput): IntervalMark[]`、`filterVisibleMarks(...)`，常數 `TRACK_LINE_Y = 28`、`INTERVAL_MIN_LINE_PX = 14`、`LABEL_MIN_PX = 48`、`LABEL_MAX_PX = 320`、`OPEN_STUB_PX = 16`、`SPAN_DEPTH = 2`。
- **改 `TimelineCommandTracks.tsx`**：依 `IntervalMark` 畫 span／point／cluster、四種終點、名稱（CSS 省略號加 inline `maxWidth`；不用 `max-w-*` class，因為 `test/page-width.test.ts` 有白名單）。
- **改 `Timeline.tsx`**：`useMemo(layoutIntervalMarks, [intervalSet, rowOf, toX, TRACK_W, laneH, endsMayBeMissing])`；`filterVisibleMarks` 依 `view` 與垂直捲動的列範圍。
- **先寫的紅測試**：`test/timeline-interval-layout.test.ts`「寬度不足 14px 的區間是 point，不是 span」。接著是同格合併與計數、聯集線、深度上限、`open` 畫到下一個起點、`endsMayBeMissing` 時只有 16px、起點未知只有 stub、名稱左右擇側與 48px 門檻、SC-003、SC-004。
- **不改的既有測試**：`timeline-geometry`、`timeline-cluster-spacing`。
- **風險**：名稱寬度是 CSS 截斷，jsdom 量不到，「至少 6 個字元」只能在 e2e（SC-005）驗。

### S3 互動與切換
- **改 `TimelineCommandTracks.tsx`**：記號成為 `<button data-timeline-event data-timeline-interval>`，內含 `[data-timeline-mark]`（e2e 的 `markBoxes` 對每個 `[data-timeline-event]` 都取這個子元素，`e2e/timeline-track.spec.ts:827-831`）；inline `width`／`height` 不小於 27（`test/timeline-hit-targets.test.tsx` 讀 inline 尺寸）；選取外環；`onClick` 先檢查 `didPan.current`。
- **改 `Timeline.tsx`**：
  - `rowEvents[STANDARD_ROW]`（`:835-838`）扣掉 `intervalSet.claimed`。
  - `nextSelection` 的 `laneOf`（`:1575-1582`）改為依事件：區間成員回終端列的鍵，否則回 `STANDARD_ROW`。
  - `isTabStop`（`:2576`）把區間記號算進去。
  - 計數記號呼叫既有的 `setCluster`。
  - 走到捲出的列時垂直捲入。
  - 時間範圍納入區間起點：`lib/timelineTimeMap.ts` 的 `computeDomainBounds(events, extend?: { lo: number; hi: number })`，只加參數。
- **先寫的紅測試**：`test/timeline-interval-select.test.tsx`「點一段區間，摘要列顯示它的 `command_end`；事件列上不再有同一個指令的點」。接著是雙擊、Enter、↑/↓ 換列、←/→ 的順序、單一 Tab 停留點、FR-007 在 DOM 上的版本。
- **改的既有測試**：`test/timeline-hit-targets.test.tsx` 加一組含 span／point／cluster 的標準模式資料；`test/timeline-time-map.test.ts` 加 `extend` 參數的案例。
- **不必改**（資料沒有配對鍵）：`timeline-focus-standard`、`timeline-select-keys`、`timeline-pan-not-click`、`timeline-track-wiring`、`timeline-session-bands`。
- **風險**：這是唯一移除既有可見物的一片（點變區間）。合併前必須在 CI 跑完整的 e2e。可見列上限下，滾輪能否垂直捲動未確認（E-1）。
- **建議的前置 PR**：修正 `carriesState`／`neverFold` 的 `exitCode`（發現 5）。

### S4 疊層與誠實規則
- **改**：
  - 變暗：區間以 `memberIds` 對 `filterMatches`／`focusChain` 判斷，`Timeline.tsx:2532-2542` 的規則搬到區間。
  - 終點記號上的 `ioMark` 與徽章。
  - `endsMayBeMissing = !!(eventFilter.targetId || eventFilter.inScopeOnly || eventFilter.hidePersonal || eventFilter.before != null) || liveError !== null`。
  - 可及名稱與 `title` 的 i18n 鍵；終端列的群組名稱。
- **先寫的紅測試**：`test/timeline-interval-honesty.test.tsx`「設了結束時間的篩選下，只有 start 的指令不延伸到右緣」。接著是 `/` 命中 start 時區間點亮（`test/timeline-text-query.test.tsx:221-232` 的標準模式版）、焦點鏈、`hasMore` 時的計數寫法、讀取失敗時的狀態。
- **風險**：`test/ui-copy.test.ts`（tooltip 不得重複旁邊的可見文字）與 i18n 鍵數的 ratchet。

### S5 e2e、文件、效能
- **改**：`e2e/timeline-track.spec.ts` 新增 describe `timeline-command-tracks`，seed 帶 `shell`、`terminalId`、`command_id`、`source_timestamp`，涵蓋 SC-005、SC-006；`:525` 的標題與註解；`docs/UIUX-STANDARD.md` §6（擁有者核可後）；`test/timeline-query-perf.test.ts` 旁新增 `REDLOG_PERF` 的區間量測。
- **風險**：seed 入口是否原樣保存這些欄位（E-3）。

### 可平行的部分
- **S1 的純模組與 S2 的版面模組**：兩個檔、兩個測試檔互不重疊。前提是先把 C 節的型別原樣提交成 `timelineIntervals.ts` 的第一個 commit，兩人都從它分支。接線（`Timeline.tsx`、`TimelineCommandTracks.tsx`）只能一個人做，依序合併 S1 再 S2。
- **S0 與任何一片**。
- **S5 的 e2e 撰寫與 S4**：S3 合併後 testid 與 `data-` 屬性已固定。
- **不可平行**：任何兩片同時改 `Timeline.tsx`。

## 接縫：純模組的輸入與輸出

```ts
// src/renderer/src/lib/timelineIntervals.ts
import type { RedLogEvent } from '../../../core/db/event-types'

/** 074 FR-043 的封閉列舉中，指令用得到的三個。 */
export type IntervalEndBasis = 'observed' | 'superseded' | 'open'

/** 純資料：不含事件物件，所以 074 的投影列可以直接轉成它。 */
export interface TimelineInterval {
  /** `command:${operationPairKey}`。React key 與測試識別。 */
  id: string
  kind: 'command'
  /** 074 intervals.key：`terminal:<id>`。 */
  trackKey: string
  /** null：起點列不在輸入的列中（074 FR-049 的語意）。 */
  startId: string | null
  startTs: number | null
  /** 只有 endBasis === 'observed' 時有值：配對的 command_end。 */
  endId: string | null
  /** observed：command_end 的時間；superseded：取代它的列的時間；open：null。 */
  endTs: number | null
  endBasis: IntervalEndBasis
  /** superseded 時，取代它的列（command_boundary 或 session_end）。它仍是事件列上的點。 */
  supersededById: string | null
  /** 選取這段區間時選到的列：endId ?? startId。 */
  anchorId: string
  /** 這段區間在圖上代表的列（所有同鍵的 start，以及 end）。事件列不再畫它們。 */
  memberIds: readonly string[]
  /** 印在圖上的指令文字，未經 safeDisplay；取起點列，沒有則取終點列。 */
  command: string
  /** observed 且有數值結束碼時為該數值，其餘為 null。 */
  exitCode: number | null
  /** 終點列的 duration_sec（來源回報）；沒有則 null。只用在起點未知時的 title。 */
  reportedDurationSec: number | null
  /** endTs < startTs。 */
  reversed: boolean
}

export interface TimelineTrack {
  /** `terminal:<id>`。 */
  key: string
  terminalId: string
  /** 標籤的事實，取該軌最早的列；不推論。 */
  shell: string | null
  pid: number | null
  builtin: boolean
  /** 該軌所有區間中最早與最晚的已知時間。 */
  firstTs: number
  lastTs: number
  intervalCount: number
}

export interface TimelineIntervalSet {
  /** 依 key 排序（穩定）。列的順序由 nextTrackOrder 決定，不在這裡。 */
  tracks: readonly TimelineTrack[]
  /** 依 (trackKey, startTs ?? endTs, id) 排序。 */
  intervals: readonly TimelineInterval[]
  /** 所有 memberIds 的聯集。 */
  claimed: ReadonlySet<string>
  byMemberId: ReadonlyMap<string, TimelineInterval>
}

/** 今天的實作：由本頁已載入的列（compareEventOrder 順序）配對。
 *  074 FR-100 落地時，以 intervalsFromProjection(...) 產生同一個型別取代它。 */
export function buildCommandIntervals(rows: readonly RedLogEvent[]): TimelineIntervalSet
```

```ts
// src/renderer/src/lib/timelineIntervalLayout.ts —— 只吃 TimelineIntervalSet，074 之後不改
export type IntervalStartCap = 'mark' | 'unloaded'
export type IntervalEndCap = 'ok' | 'failed' | 'no-result' | 'open' | 'open-stub'

export interface IntervalMark {
  key: string
  /** visibleRows 的索引。 */
  row: number
  kind: 'span' | 'point' | 'cluster'
  /** 軌道座標，CSS px。point 的 x1 === x0。 */
  x0: number
  x1: number
  /** 線的中心：row * laneH + TRACK_LINE_Y。 */
  y: number
  /** 點擊區域，寬不小於 MARK_HIT_PX，與鄰居相接於中點。 */
  hitLeft: number
  hitWidth: number
  /** span／point 為 1 段；cluster 為 n 段，依起點排序。 */
  intervals: readonly TimelineInterval[]
  startCap: IntervalStartCap
  /** cluster 取成員中最需要注意的：failed > open > no-result > ok。 */
  endCap: IntervalEndCap
  failed: number
  open: number
  /** null：不印名稱。 */
  label: { side: 'right' | 'left'; maxW: number } | null
}

export interface IntervalLayoutInput {
  set: TimelineIntervalSet
  /** trackKey → 列索引；不在表上的軌不畫。 */
  rowOf: ReadonlyMap<string, number>
  toX: (ts: number) => number
  trackW: number
  laneH: number
  clusterPx: number
  /** 本頁的讀取可能缺少結束列（FR-025）。 */
  endsMayBeMissing: boolean
}

export function layoutIntervalMarks(input: IntervalLayoutInput): IntervalMark[]
export function filterVisibleMarks(
  marks: readonly IntervalMark[], trackW: number, viewLeft: number, viewWidth: number,
  rows: { first: number; last: number }
): IntervalMark[]
```

**兩個要寫進測試的不變式**

1. `buildCommandIntervals` 的配對與 `collapseCommandPairs`（`lib/timelineEvents.ts:38-54`）、`unfinishedCommandIds`（`:61-75`）一致。
2. 與 Activity 投影的狀態對應：`paired` 對兩端俱全、`call-only` 對只有起點、`result-only` 對只有終點、`conflicted` 對不畫區間（`src/core/db/activity-queries.ts:276-278`）。

**已知的既有差異（觀察）**：Activity 不要求兩列的指令文字相等，時間軸的摺疊要求（`timelineIncremental.ts:103`）。本設計跟時間軸的摺疊，否則 FR-007 的分割不成立。074 以 `command_id` 配對時這個差異會消失。
