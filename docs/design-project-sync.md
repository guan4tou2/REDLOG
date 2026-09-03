# Design project ↔ repo sync

Mirror of `github.md` in the Claude Design project "RedLog 設計規範". That
project is where `UIUX-STANDARD.md` and the phase PR templates are authored;
this file records which repo files each design screen was drawn from, so a
change to a component tells you which screen went stale.

---

repo: guan4tou2/REDLOG
branch: main
path: src/renderer

## Last sync

date: 2026-08-24T02:30:00Z

### 2026-09-03 · 8b 標記修訂落地（部分）

`marker` 事件已上修訂模型：鏈上 `marker` + `data.subtype='amended'`（帶 `markerId` 與
`_causes`，只夾帶變更欄位）、Inspector 內編輯標題／嚴重度／備註、時間軸與搜尋顯示
「已修訂 N 次」、匯出與鏈驗證都涵蓋。原列一個位元組都沒動——`events` 的
append-only trigger 本來就不允許，這正是把修訂做成新事件而非 UPDATE 的理由。

**與設計稿的三處落差，都是設計稿描述的欄位在 repo 不存在：**
- **沒有 `url` 欄位**。`marker` 事件只有 title/notes/severity/category（+ 選填
  `atTimestamp`）。`url` 屬於 `quickmarks` 表。
- **截圖不是 marker 的欄位**。截圖是另一筆鏈上事件，由它以 `_causes` 指回標記；
  Inspector 讀反向關係。
- **「來源事件」目前沒有產生者會設**。marker 自己的 `_causes` 是空的，所以那一列
  只在真的有值時出現，不做假的「無」。

**為何記為部分完成：** 設計稿的「標記」畫面對應的是側欄 `marks` 頁
（`FindingsView.tsx` → `quickmarks` 表），那張表至今仍是可覆寫的書籤表
（`findings.ts` 的 UPDATE / DELETE），也是設計稿那個 `url` 欄位真正的所在，而且原樣
倒進證據包。若標成「已完成」，等於告訴設計專案「紀錄可修、不可篡改」對「標記」成立
——但目前只對兩個叫這名字的東西之一成立。quickmarks 那一半仍留在「設計新增、repo
未做」，是本次之後最該裁決的一項。

**順手修掉三個既有缺陷**（都不是本功能造成的）：`marker:create` 丟掉
`atTimestamp`、標記事件發布時未 `bypassPause`（暫停中寫的標記進了鏈卻不顯示）、
標記文字沒有 redaction spans（第四層因此永遠遮不掉標記備註裡的密碼）。

**留待處理：** Timeline `eventCompare` 的 BigInt tiebreak 是死碼（`padMonoNs` 會寫出
帶連字號的前綴，`BigInt()` 直接丟例外），同毫秒事件實際上以 UUID 排序；
`marker.atTimestamp` 的 i18n 用單大括號，對每位操作員都是字面渲染。兩者都不在 8b
的渲染路徑上，另案處理。

### 2026-08-24 · 設計專案 turn 7–9 對帳（22 節 vs 鏡像 11 節）

設計專案自 08-20 後獨立成長到 **22 節、25+ 區塊**，repo 鏡像停在 11 節；同期 repo 實作跑完三期並做了核心修訂
（`DESIGN-core-and-capture.md`），**兩邊互不知道對方動了**。本次以 repo 為準記錄三類差異：

**設計新增、repo 已有（設計稿不知道）**
- **§21 七條 CI 規則測試** — 六條早已是 repo 守衛：對比度與 3:1（`design-tokens.test.ts`）、填色配深字與「白字必不過 AA」反向斷言（`buttons.test.ts:117`）、13px 下限（`design-tokens.test.ts:94`）、泳道單色（`lane-colours.test.ts`）、ConfirmDialog（`confirm-dialog.test.tsx`）。只缺 #6「危險紅不上數值」，本次補上 `test/danger-not-on-numbers.test.ts`。
- **7a 流量歷史** — 已實作，且按 `DESIGN-core` §3 收成活動視圖（點/線），非設計稿的逐連線表格。
- **7c 錄影內搜尋** — 已實作（`cast-index.ts`，FTS5）。

**設計與 repo 分歧（repo 依核心修訂走了另一條路）**
- **§6 三檢視模式（作業中／稽核／除錯）** — repo 曾實作後 **revert**（`59ff5fc`：它把人設硬套在旗標組合上，預設落在「除錯」）。改為按作用分組 + 罕用項 overflow（`48713ba`）。
- **7b 四閘模型 / 2a 證據包上傳** — 雲端分享整個移除（散佈基礎設施，非核心）；證據包留在單一匯出控制項。
- **§10 側欄搜尋頁刪除** — repo **復原**了搜尋頁（事後找證據是核心用途，下拉不是對的形狀）。
- **§10 外掛信任 / registry 發行者** — 市集整個移除；設計稿 §0 也已把 2f 市集面板標為移除，方向一致。
- **§10 藍隊 webhook redaction** — deconfliction webhook 已移除。
- **18 泳道** — 設計稿只做單色化；repo 進一步按擷取組分帶（`183b9ac`）。

**設計新增、repo 未做（待裁決）**
- **8a 範圍回溯**：允許清單存檔後重算既有事件，不改事件、另寫 `scope.recomputed`；橫幅三數（重算／新標／解除）；回溯標記的違規列帶琥珀 chip。
- **8b 標記修訂**：~~待做~~ → **部分完成**（見下方 2026-09-03 條目）。
- **9a 首次執行單一路徑**：一個畫面一件事（內建終端機打指令 → 時間軸亮起），2e 九來源降為第二步。
- **9b 漸進揭露（§22）**：名詞在其資料存在前不出現；第一天側欄四格；`visibility.ts` 由資料推導、不存使用者狀態；⌘ 編號不因隱藏改變。
- **5c「一次顯示所有頁面」開關**：9b 的關閉處。

**設計專案該被告知的（本次無法回寫：DesignSync 需 `/design-login`）**
核心修訂（防竄改 → 可知性）、三期已全部完成、上述五處分歧。設計稿最後一則建議「實作第一期 tokens」已過時——三期皆併入 `main`。

抽取方式備註：DesignSync 無授權、沙盒瀏覽器撞登入牆、Chrome 擴充套件對 design SPA 的分頁反覆 park；最終以設計專案的對話紀錄 + 編輯器前 47 行（§0、§1 逐字）為據，其餘章節為敘述層級對帳。

### 2026-08-20 · §10 裁決後同步

- §10 新增兩條規則，把「為什麼」寫進規範本身，避免下次重新裁決一次：
  移除 hook 屬第一級（非第二級），以及暫停錄製的文案不得聲稱「不會擷取任何東西」。
- 1c 的第二級範例由「移除 Shell hook」換成「信任外掛發行者」——前者是可復原的，
  真正的風險（悄悄停止擷取）由常駐的〈需要注意 N〉指示器承接，而不是一次性的對話框文字。
- 兩條規則在 `main` 上都已成立：hook 移除走 `toastDeferred`，暫停文案已修正。

### Updated in this project
- 對照 main（v0.14.3 + 未發布 commit）確認設計 tokens 未變：`tailwind.config.js`、`lib/hud.ts` 逐字節相同。
- `styles/index.css` 已變動（新增殼層 `user-select: none`），規範的 index.css 建議片段已同步保留該段。
- 新增原生右鍵選單子系統（`src/main/context-menu.ts`），規範新增右鍵互動規則，並標記它與時間軸「右鍵落標記」的衝突。
- 產出 `docs/UIUX-STANDARD.md`（規範摘要 + 三期檢查表）與三張分期 PR 模板。

## Screen map

| 專案畫面 | 依據的 repo 檔案 |
|---|---|
| 1a 規範 · 色彩 tokens | `tailwind.config.js`, `src/renderer/src/lib/hud.ts`, `src/renderer/src/styles/index.css` |
| 1a 規範 · 泳道配色 | `src/renderer/src/components/Timeline.tsx`（LANES / LANE_COLORS）, `test/lane-colours.test.ts` |
| 1a 規範 · 快捷鍵表 | `src/renderer/src/App.tsx`, `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/lib/sidebarOrder.ts` |
| 1a 規範 · 術語與譯名 | `src/renderer/src/i18n/zh-TW.json` |
| 1b 儀表板 | `src/renderer/src/App.tsx`（DashboardView / CaptureHealthCard / StatCard）, `src/renderer/src/components/IPStatusCard.tsx` |
| 1b 時間軸 | `src/renderer/src/components/Timeline.tsx` |
| 1b 逐字稿 | `src/renderer/src/components/TranscriptView.tsx` |
| 1b 目標 | `src/renderer/src/components/TargetView.tsx` |
| 1b 範圍 | `src/renderer/src/components/ScopeStatus.tsx` |
| 1b 戰利品 | `src/renderer/src/components/LootPanel.tsx` |
| 1b 標記 | `src/renderer/src/components/FindingsView.tsx` |
| 1b 設定 | `src/renderer/src/components/Settings.tsx` |
| 1b 狀態列 | `src/renderer/src/components/StatusBar.tsx` |
| 1b 側欄／標題列 | `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/App.tsx` |
| 1b Project Picker | `src/renderer/src/components/ProjectPicker.tsx` |
| 1b / 1c HUD Overlay | `src/renderer/src/OverlayApp.tsx`, `src/renderer/src/lib/hud.ts` |
| 1c 全部改良畫面 | 以上各檔為基準，套用 1a 規範 |
