# Timeline 發現性細部重設計 — 滾輪與軸切換

以 **v0.11.7** 為基準。這份文件**延伸** [`DESIGN-TIMELINE-INTERACTION.md`](DESIGN-TIMELINE-INTERACTION.md)：
它把該文的 **T2（wheel-mode）** 從「事後閃現提示」深化為「常駐、恆真的模式指示」，
並**新增**該文完全未涵蓋的一整軌 —— **軸切換（source ↔ target）發現性 A1–A3**。

問題來源：[`UX-AUDIT-2026-08-13.md` §2.4](UX-AUDIT-2026-08-13.md)。
設計原則沿用既有文件：**核心手勢絕不是祕密**、**一個手勢只做一件事，狀態必須可見**。

前置縫（已存在，不重造）：`lib/timelineWheel.ts` 的 `wheelMode(ctx)`、
`lib/timelineModes.ts` 的 `activeModes(state)`、`lib/timelineAxis.ts`、`lib/targetGrouping.ts`。

---

# 第一部：滾輪發現性（延伸 T2）

## 1.1 為什麼 T2 的閃現提示還不夠

T2 已把決策抽成純函式 `wheelMode(ctx)`（`zoom` / `pan-x` / `scroll-y`），並在 `overflow` 為真時
於軌道右緣**閃現**一則提示。這解決了「決策不可測」，但**發現性仍是被動的**：

1. 提示只在 `overflow` 且**已經滾動之後**出現、幾秒後淡出 —— 操作者是**滾錯方向後**才被告知。
2. `overflow` 本身看不見：它隨視窗高度、開了幾條泳道、有沒有開詳情面板而動態改變
   （`Timeline.tsx` 依 `laneStack.scrollHeight > clientHeight + 1` 判定）。使用者無法預判「這一滾會是平移還是捲動」。
3. T1 常駐圖例寫死「`⌘-scroll to zoom`」，**從不提 `scroll-y` 或 `⇧` 逃生口**，與實際行為不一致。

> 目標：把「這一滾會做什麼、按住修飾鍵又會做什麼」變成**滾之前就看得到**的常駐資訊，
> 而不是滾之後才補救。

## 1.2 W1 — 常駐 wheel-mode 指示（affordance）

在軌道右上角放一個**低權重、恆常存在**的小指示，反映**當前語境下**無修飾鍵滾動的結果，
並在 hover／按下修飾鍵時預覽其他兩種結果。它是 T1 圖例中「zoom」那一格的動態化。

```
┌─ track ────────────────────────────────────────────────┐
│                                          ┌────────────┐ │
│ shell   ● ● ●    ●     ●●●               │ ⇔ 平移時間 │ │  ← 未溢出：滾動 = pan-x
│ agent      ● ●  ●●● ●                    └────────────┘ │
└────────────────────────────────────────────────────────┘

        溢出時（泳道被裁切在下方）：
                                          ┌────────────┐
                                          │ ⇅ 捲動泳道 │   ← 未按修飾鍵：滾動 = scroll-y
                                          │ ⇧ 改平移   │      並提示逃生口
                                          └────────────┘
```

規則：
- **恆常顯示**（不淡出），但視覺極輕（`text-2xs text-zinc-600`，見 `DESIGN-SYSTEM.md §2.3`）。
- 內容由**當前 live 語境**決定：主行程每次 `overflow` 變化即更新，所以它**先於**滾動就說出結果。
- 溢出時多顯示一行 `⇧ 改平移`（逃生口），對齊 `wheelMode` 表中 `shift → pan-x` 那列。
- `⌘/Ctrl` 一律 = zoom，這點在 T1 常駐圖例已有，指示不重複，但 hover 時可預覽（見 W2）。

## 1.3 W2 — 修飾鍵預覽（按下即顯，放開即還原）

當操作者**按住**修飾鍵（尚未滾動）時，指示即時切換到該修飾鍵的結果，形成「按住看預覽 → 滾動執行」的閉環：

| 當前按住 | 指示顯示 | 對應 `wheelMode` |
|---|---|---|
| 無 | `⇔ 平移時間`（未溢出）／`⇅ 捲動泳道`（溢出） | `pan-x` / `scroll-y` |
| `⇧` | `⇔ 平移時間`（把 scroll-y 換回 pan-x） | `pan-x` |
| `⌘`/`Ctrl` | `⤢ 縮放（游標錨點）` | `zoom` |

這讓三種模式**在同一個位置、同一個當下**被看見，取代「靠記憶＋事後提示」。

## 1.4 W3 — 純函式縫 `wheelModeLabel(ctx)`

在既有 `wheelMode(ctx)` 旁新增一個純函式，把模式對映到顯示標籤與逃生口提示，供 W1/W2 與 T1 圖例共用：

```ts
// lib/timelineWheel.ts（延伸既有檔）
export interface WheelModeView {
  mode: WheelMode              // 'zoom' | 'pan-x' | 'scroll-y'
  labelKey: string             // i18n：⇔ 平移時間 / ⇅ 捲動泳道 / ⤢ 縮放
  escapeHintKey?: string       // 僅 scroll-y：'⇧ 改平移'
}

export function wheelModeLabel(ctx: WheelContext): WheelModeView
```

- 由 `wheelMode(ctx)` 推導，**單一事實來源**：T1 圖例、W1 指示、W2 預覽、T2 閃現提示（若保留）
  全部讀這一個函式，杜絕「圖例說 zoom、實際 scroll-y」的漂移。
- 測試 `test/timeline-wheel.test.ts` 於既有 4 列矩陣上，斷言每列對應的 `labelKey`／`escapeHintKey`。
- **a11y**：指示是文字（非純動畫），`prefers-reduced-motion` 下 W2 的切換以即時替換呈現、不做過場。

## 1.5 與 T2/T6 的關係

- W1–W3 **取代** T2(b) 的「閃現」為「常駐」；`wheelMode` 純函式（T2a）維持不動，是共同地基。
- 長期 **T6（lane 虛擬化）消除 `overflow`**：泳道永遠塞得下、`scroll-y` 不再發生，屆時 W1 溢出分支
  與逃生口提示一併移除，指示退化為單純的「`⇔ 平移／⌘ 縮放`」。W1–W3 是 T6 前的正解，也向後相容 T6。

---

# 第二部：軸切換發現性（新增 A1–A3）

> 既有 `DESIGN-TIMELINE-INTERACTION.md` **未涵蓋**軸切換。這一軌是新的。

## 2.1 問題

Timeline 有兩種讀法，由標頭一顆 `⊞` 按鈕切換（`Timeline.tsx:2659`），狀態存
`localStorage['redlog-timeline-lane-axis']`（`Timeline.tsx:1230/1233`），並可由側邊 "Targets" 深連結
（`redlog-timeline-set-axis` 事件）：

- **source 軸**：依「事件來源類型」分泳道（shell / agent / http / scanner…）——「錄到了什麼」的視角。
- **target 軸**：依「目標」分泳道（per-host / per-target）——「對每個目標做了什麼」的重建視角。

三個發現性問題：

1. **`⊞` 是個謎樣 icon**：不點下去不知道它切換什麼、也看不出當前在哪個軸。
2. **切到 target 軸會靜默讓整排 lane 篩選 chip 消失**：條件式 `laneAxis === 'source' &&`
   （`Timeline.tsx:2924`）讓 target 軸下所有泳道 chip 不渲染。操作者按一下 `⊞`，標頭右側整區突然清空，
   零說明。
3. **隱藏狀態變孤兒**：若切換前已隱藏某些泳道，`hiddenLanes` 仍存在於 state 與 localStorage，
   但**能把它們叫回來的個別 chip 沒了**（"Show all" 全部還原鈕在 `Timeline.tsx:2917`，條件 `hiddenLanes.size > 0`
   仍在，但細粒度控制消失）。

## 2.2 A1 — 讓軸變成有標籤的明確選擇（分段控制取代謎樣 icon）

把 `⊞` 換成一個**兩段式分段控制**，當前軸恆可見：

```
標頭：   … [ 來源 | 目標 ]  …          ← 選中段高亮（青，見 DESIGN-SYSTEM §1.2）
              ▔▔▔▔
hover 「目標」段 tooltip：依目標主機分組，回答「對每個 target 做了什麼」
```

- 兩段各帶簡短標籤（`來源` / `目標`）＋ hover 說明各軸意義。
- 選中段用 §1.2 的青色選中態；未選段 ghost。
- 純函式縫沿用既有 `lib/timelineAxis.ts`；此步僅換 UI 呈現，行為不變。
- 深連結（"Targets" → target 軸）維持，但落地時分段控制已明確顯示在「目標」段，操作者知道自己在哪。

## 2.3 A2 — 保住篩選能力（target 軸不該讓人失去控制）

target 軸下不能只是「拿掉 source 泳道 chip 就算了」。二選一（建議走 (a)）：

**(a) 提供對等的 target 篩選 chip（建議）**
target 軸下，把「來源泳道 chip」換成「**目標泳道 chip**」（per-host），沿用同一套 chip 元件與
solo/hidden 語意（`lib/laneVisibility.ts` 已是泛化的可見性推導）。操作者在兩個軸都有一致的篩選手感，
`hiddenLanes` 不再變孤兒 —— 它按當前軸的泳道集合運作。

**(b) 若暫不做對等 chip**：至少在 chip 區顯示一行說明，而非靜默清空：
```
目標軸：泳道依主機分組，來源篩選暫不適用 · [切回來源軸]
```

無論 (a)/(b)，**"Show all" 還原鈕維持**，確保永遠有一條把隱藏泳道叫回來的路。

## 2.4 A3 — 切換當下的轉場說明（用既有 active-modes 機制）

軸切換是「改變畫面意義」的操作，理應像 T3 的其他 sticky mode 一樣**自我說明**。當軸為非預設（target）時，
於 T3「Active:」列加一枚 chip（沿用 `lib/timelineModes.ts` 的 `activeModes` 縫）：

```
│ Active:  [⊞ 目標軸 ✕]  [solo: 10.0.0.5 ✕]                         clear all │
```

- chip 的 `✕` = 切回 source 軸（`clearAction: 'axis:source'`）。
- 這把「我現在為什麼看起來不一樣」寫在畫面上，與 wheel（第一部）同一套「狀態必須可見」原則。
- 純函式擴充：`TimelineModeState` 加 `laneAxis: 'source' | 'target'` 欄位；`activeModes` 在
  `laneAxis === 'target'` 時輸出一枚 chip；`source`（預設）時不輸出，維持「預設無列」不變式。

## 2.5 相位軸附註（phase ribbon `▤`）

同一標頭還有 phase ribbon 切換（`Timeline.tsx:2669`，`▤`）與 source/target **正交**。它同樣是謎樣 icon，
建議一併給文字標籤（`相位`）並納入 A1 的處理慣例，但其開關已有 T3 表格涵蓋（`⇘`/焦點等），此處不重複規範。

---

# 建置順序與縫（皆純函式先行、可獨立出貨）

| 步 | 項目 | 純函式縫 | 測試斷言 |
|---|---|---|---|
| 1 | W3 | `lib/timelineWheel.ts` `wheelModeLabel(ctx)` | 4 列矩陣各對應正確 label／escape hint |
| 2 | W1 | （UI，讀 W3；live `overflow`） | 未溢出顯示 pan-x、溢出顯示 scroll-y+逃生口 |
| 3 | W2 | （UI，讀 W3；監聽 keydown/keyup 修飾鍵） | 按 ⇧/⌘ 時預覽切換、放開還原 |
| 4 | A1 | `lib/timelineAxis.ts`（既有） | 分段控制反映當前軸；點擊切換 |
| 5 | A2 | `lib/laneVisibility.ts`（既有，泛化到 target 泳道） | target 軸有對等 chip；hidden 不成孤兒 |
| 6 | A3 | `lib/timelineModes.ts` 擴 `laneAxis` 欄 | target→一枚 chip；source→`[]` 不變式維持 |

每步遵本 repo 的 red→green→integrate→cover 流程
（[`DEV-REQUIREMENTS-capture-onboarding.md`](DEV-REQUIREMENTS-capture-onboarding.md)），
不觸及擷取管線或證據鏈。

# 驗收準則（acceptance）

- **W**：任一時刻，無修飾鍵滾動的結果**在滾動前**就顯示於軌道；按住 `⇧`/`⌘` 即時預覽對應結果；
  圖例、指示、預覽三處文案由 `wheelModeLabel` 單一來源產生，永不相互矛盾。
- **A**：當前軸**恆可見且有文字標籤**；切到 target 軸後仍有對等篩選能力，且必有還原路徑；
  非預設軸在「Active:」列有可一鍵清除的 chip；切回 source 後 chip 消失、篩選 chip 復原。
- **不變式**：全部預設（source 軸、無 sticky mode）時，「Active:」列不渲染（延續 T3）。

# 給維護者的開放問題

1. **W1 指示位置**：軌道右上角（上方 ASCII）vs. 併入 T1 底部圖例動態化？後者更集中但離游標較遠。
2. **A2 走 (a) 對等 chip vs (b) 說明**：per-host 泳道在目標很多的交戰中可能爆量，
   是否需要對 target 泳道 chip 先做 top-N + 「更多」收合（呼應 cluster 的 50 筆上限慣例）？
3. **phase ribbon**：是否值得在本輪一併把 `▤`/`⊞`/tz 等標頭 icon 全數文字化（呼應 `DESIGN-SYSTEM §4` icon 收斂），
   或留待 T4「⋯ View」選單重構時一起處理？
