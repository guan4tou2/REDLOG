# RedLog 設計系統 — UI/UX 語言與框架

以 **v0.11.7** 現況為基準，把散落在 `tailwind.config.js`、`src/renderer/src/lib/hud.ts`、
`src/renderer/src/styles/index.css` 三處的設計決策**收斂成單一權威來源**，並標出目前的不一致。

這份文件是「規範（normative）」：新元件依此建；既有元件逐步對齊。它回答四個問題 —
**用什麼顏色、什麼字、什麼大小、什麼 icon**，以及**怎麼組成一致的版面與互動**。

配套：[`UX-AUDIT-2026-08-13.md`](UX-AUDIT-2026-08-13.md)（現況評估）、
[`DESIGN-TIMELINE-DISCOVERABILITY.md`](DESIGN-TIMELINE-DISCOVERABILITY.md)（Timeline 細部）。

外部基礎：Apple [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines)
與 [UI Design Do's and Don'ts](https://developer.apple.com/design/tips/)。RedLog 是 macOS 優先的
Electron 桌面 app，以 HIG **原則**為地基；但它是**高密度的專業／紅隊工具**，不是消費級 iOS app，
故對 HIG 的觸控級預設採「桌面校準」而非照搬（見 §0.1 的對齊與偏離表）。

---

## 0. 設計原則（本 app 的 UI/UX 語言）

1. **證據優先，冷靜呈現**：這是長時間注視的稽核工具。accent 一律用**去飽和**版本，避免在暗底上「震動」
   （已在 `soften` map 建立，見 §1）。紅色是狀態語彙的一部分（danger/exposed/recording），不是裝飾。
2. **一個手勢只做一件事**：不做「結果取決於看不見狀態」的互動；必須依狀態改變時，把狀態顯示出來
   （見 [`DESIGN-TIMELINE-INTERACTION.md`](DESIGN-TIMELINE-INTERACTION.md) 原則 2）。
3. **空狀態一律自我說明**：沒東西時要嘛引導下一步（CTA），要嘛說明「為什麼是空的」。
4. **漸進揭露**：主控制常駐；長尾收在 `?`／`Collapsible`／「進階」之後。
5. **色彩不是唯一訊號**（a11y）：狀態同時用顏色＋形狀／文字（如 REC 用紅點＋"REC" 字）。

上述五條與 Apple HIG 的三大支柱同源：**Clarity（清晰）**（原則 5 對比＋形狀）、
**Deference（讓位於內容）**（原則 1 冷靜、暗底、內容優先）、**Depth（層次）**（HUD 的框／光暈／模糊建立層級）。

---

## 0.1 與 Apple HIG 的對齊與偏離

HIG 是**桌面級**基礎；RedLog 是高密度紅隊工具，部分 HIG 觸控預設**刻意偏離**。下表對每條給
「對齊 / 偏離」判定與處置。判定為「偏離—待修」者，已回填到 [`UX-AUDIT-2026-08-13.md`](UX-AUDIT-2026-08-13.md) 的清單。

| HIG 準則 | 具體值 | RedLog 現況 | 判定 |
|---|---|---|---|
| **點擊目標大小** | 觸控 44×44pt（指標裝置可較小，但仍需舒適） | `w-5 h-5`（20px）鈕、詳情面板 4px 拖曳把手、截圖刪除 `×` 等原本遠低於此 | 🔧 **偏離—已實作 hit-slop**：桌面滑鼠可小於 44pt。規範：**互動控制的可點區 ≥ 28×28px**、拖曳把手命中區 ≥ 8px，用 `.hit-target`／`.hit-target-v` 撐命中區、**視覺仍小**（見 §0.1a） |
| **最小文字尺寸** | ≥ 11pt（≈14.7px @96dpi）供免縮放閱讀 | `text-sm`≈14.9px(≈11pt) 合格；`text-xs`≈12.8px 為本專案桌面校準下限；`text-2xs`/`text-3xs` 更小 | 🔧 **偏離—已實作 C9**：17px 基準＋可調 `--app-zoom`（0.9–1.5）為緩解。規範已落實：`text-2xs`/`text-3xs` **只給非必要裝飾性 meta**（計數、freshness、角標、chip），**必要可讀內容一律 ≥ `text-xs`**（見 §2.3 遷移狀態）。`text-3xs` 進一步收窄為**僅角標／寬度受限軸標** |
| **不需水平捲動／縮放即見主內容** | 版面貼合視窗 | 全樹僅 1 處 `md:` 斷點、`grid-cols-3/4` 寫死，800px 最小寬會擠 | ⚠ **偏離—待修**：見 §6.4 響應式斷點 |
| **控制貼近其作用的內容** | — | 多數符合（chip 在資料旁、詳情面板貼事件） | ✅ 對齊 |
| **對齊揭示資訊關係** | 文字／圖／鈕對齊 | 卡片格線、標籤欄對齊良好 | ✅ 對齊 |
| **充足對比** | 字色與底色對比足夠 | `soften` 去飽和但維持對比；中性文字 `zinc-400/500` 於 `#0a0a0a` 上足夠 | ✅ 大致對齊（`text-zinc-600/700` 用於極次要 meta 時接近下限，勿用於必要文字） |
| **高解析度資產／正確長寬比** | @2x/@3x、不變形 | 截圖 `object-cover`／`object-contain` 正確；icon 為向量字元／SVG | ✅ 對齊 |
| **一致性（平台慣例）** | 一致的控制與導覽 | 本設計系統即為此（§4 icon、§5 元件、§2 字級收斂） | ✅ 對齊中 |
| **尊重使用者偏好** | Dark Mode、動效、Dynamic Type | `prefers-reduced-motion` 已全域處理（§7）；深色為預設；UI zoom 近似 Dynamic Type | ✅ 對齊 |
| **可及性（VoiceOver 等）** | 標籤、focus、語意 | `aria-label`/`focus-visible` 多數具備；缺 modal focus-trap、Settings tab a11y、`aria-live`（§8） | ⚠ **部分**：見 §8 待補 |

**淨結論**：RedLog 在 Clarity/Deference/Depth、對比、一致性、動效偏好上與 HIG 對齊良好；
主要偏離是**點擊目標過小**與**必要文字偏小**——兩者都源自「高密度」取捨。處置不是全面放大（會犧牲密度），
而是**設下限並區分層級**：命中區 ≥28px、必要文字 ≥`text-xs`、微字級只給裝飾性 meta。

### 0.1a hit-slop utility（C8 實作，2026-08-13）

在 `styles/index.css` 定義兩個 utility，以**隱形 `::before` overlay** 擴大命中區、**不改變視覺大小**
（符合「視覺仍小」）：

| Utility | 作用 | 適用 |
|---|---|---|
| `.hit-target` | `position:relative` + `::before { inset:-6px }`：16px 控制→28px、20px→32px | 一般靜態 icon-only 小鈕 |
| `.hit-target-v` | 只在上下擴 8px（`inset:-8px 0`）：4px 把手→20px 抓取帶 | 細長全寬拖曳把手 |

**已套用（14 處）**：Timeline 詳情面板拖曳把手（`hit-target-v`）、Timeline 標頭 zoom −/reset/+、
help/filter/views/active-modes 的 `×` 與 skip-idle 等小鈕；Terminal 分頁關閉 `×`、搜尋列 ↑/↓/`×`；
截圖刪除 `×`。

**使用規範**：
- 元件若已是 `absolute`/`relative` 定位，**勿**用 `.hit-target`（它會把 position 設回 relative）；改用只加 `::before`
  的變體或手動加大。
- 兩個 hit-target 控制至少相隔 12px，slop 才只在「間隙」相接、不蓋到鄰居的字形。
- **刻意未套用**：Timeline 內嵌於 filter input 的 `absolute` 清除 `×`（slop 會蓋到輸入區、竊取點擊）；
  Settings／ProjectPicker 的 `ListField` 移除 `×`（低頻、位於表單）——留待增量套用或改用 `absolute` 變體。

---

## 1. 色彩系統

### 1.1 表面（surface）階梯 — `redlog.*`（`tailwind.config.js`）

| Token | Hex | 用途 |
|---|---|---|
| `redlog-bg` | `#0a0a0a` | 最底層背景、標題列、Sidebar |
| `redlog-surface` | `#141414` | 卡片、面板 |
| `redlog-elevated` | `#1a1a1a` | 疊在 surface 上的區塊、hover |
| `redlog-border` | `#262626` | 主要邊框 |
| `redlog-border-subtle` | `#1e1e1e` | 次要分隔線 |

文字：`redlog-text #e5e5e5`（主）、`redlog-text-dim #a1a1aa`（次）、`redlog-muted #71717a`（標籤）。
慣例上 zinc 階（`zinc-200/300/400/500/600`）已大量用於文字層級 — **視為與上表同義**，新程式優先用具語意的 `redlog-*`。

### 1.2 狀態／accent — `soften` map（`tailwind.config.js`）＋ HUD（`lib/hud.ts`）

**關鍵**：全 app 的 `red/green/amber/cyan` 已被 `soften` 重新對映，且**必須與 HUD 逐字相同**，
讓主視窗與懸浮 HUD 呈現同一組 accent。

| 語意 | Token（400 階） | Hex | 對應 HUD |
|---|---|---|---|
| danger / exposed / recording / 主 accent | `red-400` / `redlog-accent` | `#d75f63` | `HUD.red` |
| safe / active / healthy | `green-400` / `emerald-400` | `#5ecf9c` | `HUD.green` |
| unknown / idle / partial / warning | `amber-400` / `yellow-400` | `#d4ac5a` | `HUD.amber` |
| system / live / pivot / 資訊 | `cyan-400` / `redlog-cyan` | `#3fc7d6` | `HUD.cyan` |

每個語意色的 300（亮，用於 hover 文字）與 500（深，用於填底）階見 `soften`。
HUD 專屬中性色：`HUD.muted #5f7a82`（標籤）、`HUD.value #cfe8ee`（帶青的白，主要數值）。

### 1.3 語意色使用規則

- **紅**只給「危險或需要注意」：scope 違規、exposed IP、recording、刪除。不要當一般強調。
- **青**給「系統態與導覽」：LIVE、pivot、連線、可點連結、選取態。
- **綠**只給「確認安全／健康／成功」。**琥珀**給「未知／閒置／部分」。
- **中性**（zinc/redlog-text-*）給絕大多數文字。一個畫面同時出現三種以上 accent = 過載，重新分層。

### 1.4 陰影與光暈（`boxShadow`）

`card`（`0 1px 3px rgba(0,0,0,.4)`）、`card-hover`。光暈 `glow-red-*`／`glow-cyan-*` 用於強調態。

### 1.5 chrome accent drift — ✅ 已收斂（2026-08-13）

以下 chrome 硬編值原本**未跟上 `soften` 遷移**（仍是舊的搶眼亮色），本輪已修正：

| 位置 | 原值 | 現值 | 狀態 |
|---|---|---|---|
| `tailwind.config.js` `glow-red`/`glow-red-sm` | `rgba(239,68,68,…)` | `rgba(215,95,99,…)`（`#d75f63`） | ✅ |
| `tailwind.config.js` `glow-cyan`/`glow-cyan-sm` | `rgba(34,211,238,…)` | `rgba(63,199,214,…)`（`#3fc7d6`） | ✅ |
| `styles/index.css` `.drag-over` | `#ef4444` | `#d75f63` | ✅ |
| `OverlayApp.tsx` inline ×4（hair/iconBtn/scanline） | `rgba(34,211,238,…)` | `hexA(CYAN, …)` | ✅ |

**規範**：renderer 的 UI chrome 內不得再出現 raw hex accent — 一律走 tailwind class 或 `HUD.*` token。

### 1.5b 分類色盤與狀態色（**刻意保留**，另立議題）

以下三處也是硬編亮色，但它們**不是** chrome accent drift，而是各自成套的**分類／狀態色盤**，
單獨 soften 其中一色會破壞整組的可辨識性，故本輪不動，留待「統一分類色盤」的獨立設計：

| 位置 | 性質 | 為何保留 |
|---|---|---|
| `TerminalView.tsx` `red/brightCyan/cursor/selection` | 終端機 ANSI 調色盤 | 終端內容的標準鮮色，特殊表面；ANSI 全套一致鮮豔 |
| `TranscriptView.tsx` `KIND_COLOR.marker #ef4444` | 分類色盤 | 與 `#22c55e/#84cc16/#8b5cf6/#f97316` 並存，需整組一起定 |
| `Timeline.tsx:3389` fail 狀態環 `#ef4444` | 語意狀態色 | 需與 Timeline 其餘 lane/status 色一起收斂 |

**待辦（獨立 ticket）**：定義一套「lane/kind 分類色盤」與「語意狀態色」token（含 §1.2 的 danger red 對映），
再讓上述三處引用，而非各自硬編。

---

## 2. 字型系統

### 2.1 字族（family）

| 角色 | Stack | 位置 |
|---|---|---|
| UI（介面文字） | `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft JhengHei UI', system-ui, sans-serif` | `styles/index.css` body |
| 等寬（數值／ID／指令／時間戳） | `ui-monospace, 'SF Mono', Menlo, 'Cascadia Code', Consolas, 'Microsoft JhengHei UI', monospace` | 多處 `font-mono` |
| 終端機 | `'MesloLGS NF', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'SF Mono', Menlo, …` | `TerminalView.tsx:314` |

**規範**：所有「機器產物」（IP、hash、event id、port、timestamp、指令）用 `font-mono` + `tabular-nums`；
散文用 UI 字族。`Microsoft JhengHei UI` 已納入兩條 stack，確保 Windows 上中文不掉字。

### 2.2 字級（size）— 目前的問題

現況掃描（renderer 內）顯示**兩套並行的字級尺標**，且分布碎裂：

```
Tailwind rem 制：text-xs ×350   text-sm ×34   text-base ×2   text-lg ×6   text-xl ×3
硬編 px 制：     text-[11px] ×138   text-[10px] ×33   text-[13px] ×7   text-[9px] ×4   text-[8px] ×2   text-[12px] ×1
```

問題有二：
1. **兩套尺標語意重疊**：`text-xs`（=0.75rem，在 17px 基準下 ≈12.75px）與 `text-[11px]`／`text-[13px]`
   互相接近卻不成階，維護時無從判斷該用哪個。
2. **縮放行為不一致**：rem 制會跟著 `html { font-size: 17px }` 放大；硬編 px **只跟 `--app-zoom` 放大**
   （`styles/index.css` 註解已載明此權宜）。兩者在使用者調字級時步調不同。

### 2.3 規範字級尺標（type scale）

收斂成 7 級，一律用 Tailwind 具名 class（rem 制，隨基準縮放）。`text-2xs`/`text-3xs`
已於 `tailwind.config.js` `fontSize` 定義（string 形式＝只設 font-size，行為與被取代的 arbitrary 值一致）：

| 級別 | class | ≈px @17基準 | 用途 |
|---|---|---|---|
| nano | `text-3xs`（`0.5rem`） | ~8.5 | 最密的徽章／角標（取代 `text-[8px]`/`text-[9px]`） |
| micro | `text-2xs`（`0.625rem`） | ~10.6 | chip 計數、freshness 標籤、極次要 meta（取代 `text-[10px]`） |
| caption | `text-xs` | ~12.8 | **預設次要文字**（絕大多數 label、hint） |
| body | `text-sm` | ~14.9 | 主要可讀內文、表單值 |
| title | `text-base` | ~17 | 卡片／區塊標題 |
| heading | `text-lg` | ~19 | 頁面標題 |
| display | `text-xl` | ~21 | 大數字（Dashboard 統計） |

**遷移狀態**：
- ✅ 已完成（2026-08-13）：`text-[10px]` → `text-2xs`（33 處）、`text-[9px]`/`text-[8px]` → `text-3xs`（6 處）。
  這一批視覺位移極小（10→10.6px、8/9→8.5px），但字級**從此隨 17px 基準縮放**（原本只隨 `--app-zoom`）。
- ✅ C9 必要文字下限（2026-08-13）：把**必要可讀但過小**的文字提到 `text-xs` — Timeline 互動圖例（T1 legend，
  pan/zoom/filter/shortcuts）與滾輪模式提示（wheel-mode hint），兩者都是「核心手勢絕不是祕密」的導覽文字，
  8pt 太小。其餘微字級（計數、freshness、chip、footer、角標）經審視確認為裝飾性 meta，維持不變。
  `text-3xs` 僅保留給 instance 角標／count 徽章與寬度受限的軸標（3418/3429/3504/3206/3228）；palette 分類標由 `text-3xs`→`text-2xs`。
- ⏳ 待做（**非低風險**，另立）：`text-[11px]`（138 處）→ `text-xs`、`text-[13px]`（7 處）→ `text-sm`。
  這兩批會放大 ~15%（11→12.8、13→14.9），需搭配逐頁視覺 pass，故不併入 token 收斂批次。
- 例外：終端機字級（`TerminalView` 的 `⌘±`）與 HUD `scale` 是使用者可調的獨立系統，維持 px 動態計算。

### 2.4 字重與字距

- 區塊標題慣例：`text-[11px] font-semibold uppercase tracking-[0.15em] text-zinc-500`（見 Dashboard、Settings）。
  → 收斂為 utility `.section-heading`（見 §5）。
- 數值：`font-mono font-semibold tabular-nums`。
- 一般文字：`font-medium` 或預設。避免 `font-bold` 大面積使用。

---

## 3. 間距、尺寸與圓角

- **間距單位**：沿用 Tailwind 4px 網格。區塊間 `space-y-3`／`gap-3`；卡片內距 `p-4`；緊湊列 `gap-2`。
- **圓角**：卡片 `rounded-lg`；chip/按鈕 `rounded`／`rounded-md`；徽章 `rounded-full`。
  HUD 專屬斜角 `CHAMFER`/`CHAMFER_SM`（`lib/hud.ts`）僅限 overlay，勿用於主視窗。
- **控制高度**：導覽項 `h-8`；工具列鈕 `py-1`；狀態列 `h-7`；標題列 `h-10`。收斂見 §5 按鈕。
- **邊框**：一律 `border-redlog-border`；hover 態可 `border-zinc-600`。

---

## 4. Icon 系統

### 4.1 現況：ASCII glyph，無統一集

目前 icon 是散落的 Unicode 幾何字元，來源不一、隱喻不一致、辨識度低：

```
Sidebar：  ◉ dashboard  ▸ terminal  ═ timeline  ☰ transcript  ◻ screens
           ⊕ targets    ⊘ scope     ◆ loot      ⚑ marks       ⚙ settings
其他：     ⌕ search  ⚓ anchor  ⊞ 軸切換  ▤ phase ribbon  ⚡ 快速標記  ↗ 跳轉  ⠿ 拖曳把手
```

問題：`═`（timeline）、`☰`（transcript）、`◻`（screens）之間沒有共同視覺語言；
`◉/◆/◻` 都是「實心/空心幾何」但語意無關；字型 fallback 不同平台粗細不一。

### 4.2 規範：兩條路線（擇一，建議 A）

**路線 A（建議）— 導入單一 stroke icon set**
採用一套開源、線性、可設 `currentColor` 的 SVG icon（如 Lucide 風格），統一 `1.5px` stroke、24×24 grid。
每個 sidebar 項給明確隱喻：dashboard=gauge、terminal=terminal、timeline=activity/waveform、
transcript=list、screens=image、targets=crosshair、scope=shield、loot=key、marks=flag、settings=settings。
以 inline SVG 或本地 sprite 引入（Electron 無 CSP 外連問題，但沿用專案「自帶資產」慣例）。

**路線 B（低成本過渡）— 收斂現有 glyph 為一致集** — ✅ 已實作（2026-08-13）
- 建立 `src/renderer/src/lib/icons.ts`，匯出**單一來源** `ICON` map（nav 實體 + 跨切面 affordance），
  以 Sidebar 為 canonical 定義。8 個檔（Sidebar/App/StatusBar/TerminalView/LootPanel/ScopeStatus/
  TranscriptView/FindingsView）改引 `ICON.*`，非 Timeline 檔已無裸語意 glyph。
- **順帶修掉兩處實體漂移**：TranscriptView 空狀態 `▤`→`ICON.transcript`（`☰`，與 nav 一致、且解除與
  phaseRibbon 的撞號）；FindingsView 空狀態 `◈`→`ICON.marks`（`⚑`，與 nav 一致）。
  loot `◆` 原散在 3 檔（Sidebar/StatusBar/LootPanel），現同引一個 token。
- 規範：每個 glyph render 時 `aria-hidden` 且旁邊恆有文字 label／`aria-label`；大小顏色走型別／色彩 token，
  `icons.ts` 只帶 glyph。
- ⏳ 待收尾：Timeline.tsx 內 3 個單站 glyph（空狀態 `═`、軸 `⊞`、phaseRibbon `▤`）留待該檔其他
  in-flight 變更落地後再引 `ICON.*`（避免與並行工作衝突）；generic affordance（`✕`/`✎`/`+` 等）可日後增量遷入。
- 未來切路線 A 時，只需替換 `icons.ts` 這一個 map 的值，呼叫端不動。

### 4.3 通則

- icon 恆搭配文字 label 或 `aria-label`（純 icon 鈕如標題列 search `⌕` 已有 `aria-label`，維持）。
- icon 尺寸跟隨字級（`w-4 h-4` 對 `text-sm`）。
- 狀態用色遵 §1.2；不可只靠 icon 形狀傳達狀態。

---

## 5. 元件模式（component patterns）

把重複出現的 Tailwind 組合收斂為具名 pattern（可做成 `@layer components` utility 或 React 元件）。

### 5.1 卡片 Card
```
rounded-lg bg-redlog-surface border border-redlog-border p-4 shadow-card
（可 hover:shadow-card-hover）
```
頂部狀態條：`<span class="absolute top-0 inset-x-0 h-[2px] {tone}">`（見 `StatCard`、`CaptureHealthCard`）。

### 5.2 區塊標題 `.section-heading`
```
text-xs font-semibold uppercase tracking-[0.15em] text-zinc-500
```
（統一目前 `text-[11px]`/`text-[10px]` 混用；見 Dashboard vs Settings 的細微差異。）

### 5.3 Chip（篩選／狀態標籤）
- 未選：`bg-zinc-800 text-zinc-500 hover:text-zinc-300`
- 選中：`bg-red-500/20 text-red-300`（或對應語意色）
- 停用：`opacity-25 cursor-not-allowed`
- 恆帶 `focus-visible:ring-1 focus-visible:ring-red-500/40`。
**規範**：篩選 chip 的「出現閾值」統一（見 audit C4）— 不論資料量恆顯示，或恆用同一門檻，別各頁不同。

### 5.4 按鈕 Button（三級）
| 級別 | 樣式 | 用途 |
|---|---|---|
| primary | `bg-red-500/10 text-red-400 border border-red-500/15 hover:bg-red-500/20` | 主行動（Mark、儲存） |
| secondary | `bg-zinc-800 text-zinc-300 hover:bg-zinc-700` | 一般行動（Export） |
| ghost | `text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]` | 低權重／導覽 |
| danger | 同 secondary，但 hover 轉 `text-red-400`；**破壞性一律走 `confirm(..., danger=true)`** | 刪除／revoke |

### 5.5 徽章 Badge、Toast、ConfirmDialog、EmptyState、LoadingSpinner
- 已有共用元件（`Toast.tsx`、`ConfirmDialog.tsx`、`Feedback.tsx` 的 `EmptyState`/`LoadingSpinner`）。
  **規範**：所有空狀態走 `EmptyState` + `emptyStateFor()`；所有破壞性確認走 `confirmDialog`。
- Modal 一律加 **focus trap**（目前 `EventMarker` 只有 autofocus，缺 trap — audit C6）。

---

## 6. 版面與縮放框架（回應「畫面佔比可調」）

### 6.1 目前結構
`App.tsx`：標題列(`h-10`) → 主體(`Sidebar` 固定 140px + `view-root flex-1`) → `StatusBar`(`h-7`)。
全 app 唯一可拖曳縮放是 Timeline 詳情面板（`Timeline.tsx:3571`，存 localStorage）。

### 6.2 規範：共用 `<SplitPane>` — ✅ 已實作（2026-08-13）

可重用的分割元件（`components/SplitPane.tsx`），把 Timeline 詳情面板已驗證的模式一般化：

```tsx
<SplitPane id="findings-list-detail" direction="horizontal"
           defaultSize={320} min={240} max={560} otherMin={320}>
  <List />     {/* 可調整大小的第一欄；px 大小存 localStorage redlog-split-{id} */}
  <Detail />   {/* flex-1 填滿其餘 */}
</SplitPane>
```
- 拖曳把手：1px 視覺 + `.hit-target` 命中區（§0.1a），`cursor-col/row-resize`、`hover:bg-redlog-accent/50`。
- 雙擊把手 → 重設並清 localStorage；`←/→`（或 `↑/↓`）鍵每步 16px（a11y，`role="separator"`）。
- `ResizeObserver` 在容器縮小時重新 clamp，避免面板寬過頭。
- 純函式縫：`splitPaneClamp(px, min, max, containerPx, otherMin)`（`lib/splitPane.ts`，
  `test/split-pane.test.ts` 7 例）。
- **已套用**（2026-08-13）：FindingsView 左右欄（原 `w-80` 硬編 → 可拖曳）；**Loot** 清單｜詳情（詳情面板顯示
  完整值 + 複製鈕，順帶修掉 audit C1 的「preview 截斷、不能複製」）；**Transcript** feed｜詳情（詳情面板顯示
  選定交換的完整 input/output + 各自複製鈕，補足 feed 無複製、output 截斷的缺口）；**Terminal 分割窗**
  （`⌘D`／◫ 按鈕把一個 tab 分成兩個並排的 shell，每個獨立 pty，中間可拖曳調整佔比；`defaultSize` 支援分數 0.5=五五分）。
- **`defaultSize` 支援分數**：值在 (0,1] 視為容器比例（如 0.5=一半），首次量到容器時解析；持久化的一律是 px。

### 6.3 規範：Sidebar 可收合 — ✅ 已實作（2026-08-13）
- 底部 toggle（`«`/`»`）或 **`⌘/Ctrl+B`**（App 派發 `redlog:toggle-sidebar`，Sidebar 監聽）在
  icon-only（52px）↔ 展開（140px）間切換，狀態存 localStorage `redlog-sidebar-collapsed`，`transition-[width]`。
- 收合時只剩 icon（tooltip 帶 label）；count badge 改為 icon 角落小圓點；drag 重排把手僅展開時顯示。

### 6.4 規範：響應式斷點
- 目前全樹僅 1 處 `md:`。關鍵格線（Dashboard `grid-cols-3/4`、Screenshots `grid-cols-3`）
  補 `sm:`/`md:`：如 `grid-cols-1 sm:grid-cols-2 md:grid-cols-3`。
- 最小視窗 800×500 必須無水平溢出、無擠壓。

### 6.5 全域縮放（維持）
`--app-zoom`（Chromium `zoom`，0.9–1.5，`main.tsx:11`）＋ `html { font-size: 17px }` 兩段式，維持現狀；
§2.3 字級收斂後，px 硬編減少，兩段式落差自然縮小。

---

## 7. 動效（motion）

- 已定義：`pulse-slow`、`toast-in`、`blink-rec`、`spin-slow`（`tailwind.config.js`）+ HUD `alarm`。
- **規範**：轉場一律 `transition-colors`/`transition-opacity`，時長 `duration-150`；避免大位移動畫。
- **a11y**：`prefers-reduced-motion: reduce` 已在 `styles/index.css` 全域處理（凍結動效但保留顏色資訊）。
  新動效**必須**能被此 media query 凍結 — 不可用動畫傳達唯一資訊。

---

## 8. 可及性（a11y）基線

- 互動元素恆有 `focus-visible:ring`（多數已具備）。
- 純 icon 控制恆有 `aria-label`。
- 狀態不只靠顏色（§0 原則 5）。
- Modal：`role="dialog"` `aria-modal` + **focus trap** + Escape + backdrop 關閉（EventMarker 待補 trap）。
- Settings tab bar 待補 `role="tablist"`/`role="tab"`/`aria-selected`/方向鍵導覽。
- 動態結果清單（搜尋）待補 `aria-live`。

---

## 9. 採用路線（roadmap）

**Phase 1（token 收斂，低風險）** — 部分完成（2026-08-13）：
- ✅ 修 §1.5 chrome 亮色殘留（glow×4、`.drag-over`、OverlayApp inline×4）。
- ✅ `tailwind.config.js` 定義 `text-2xs`/`text-3xs`，並遷移 sub-`text-xs` 硬編（39 處）。
- ⏳ §1.5b 分類／狀態色盤（另立 ticket）；§2.3 的 `text-[11px]`/`text-[13px]` 遷移（需視覺 pass）；
  §5.2 `.section-heading` utility 化。

**Phase 2（框架化）**：抽 `<SplitPane>`（§6.2）＋ Sidebar 收合（§6.3）＋響應式斷點（§6.4）。
每項先落純函式縫再接 UI。

**Phase 3（icon 與元件對齊）**：依 §4 擇路線導入／收斂 icon；元件逐步遷到 §5 pattern；補 §8 a11y。

每個 Phase 都遵本 repo 的 red→green→integrate→cover TDD 流程
（見 [`DEV-REQUIREMENTS-capture-onboarding.md`](DEV-REQUIREMENTS-capture-onboarding.md)）。
