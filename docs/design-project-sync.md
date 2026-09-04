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

### 2026-09-04 · 回寫設計專案（單向鏡像首次雙向）

操作員登入 `/design-login` 後，本次把 `github.md` 寫回設計專案（8a／8b／9a／9b／5c 的落地
狀態、命名裁決、收緊後的解鎖條件、以及順手修掉的既有缺陷）。

**方向是單向的，兩邊各取所長。** 設計專案的 `docs/UIUX-STANDARD.md` 沒有被覆寫——那份有
22 節，整份寫回會蓋掉設計側的內容，規範本體仍以設計專案為著作處。反過來，repo 這份鏡像則
**改為設計稿全文**（22 節，2026-09-04 取回），原本只有 11 節的部分鏡像作廢。

鏡像加上、也只加上**實作狀態註記**：`✓ 已實作` 與 `▲ 分歧`（附原因與 commit）。敘述本身
一字不改。這樣 repo 端讀到的是完整規範，而不會重新宣稱程式碼裡沒有的東西——§6 的三種檢視
模式已 revert、搜尋頁保留、雲端分享／webhook／市集已移除，這四處若照抄設計稿就會是假的。

順帶修掉設計稿在傳輸中混進的簡體字與一處錯字（单一／实際／琳璀色／「進定要表在 9b」），
repo 全庫是繁體。

**留給設計端裁決的一項**：8b 記為部分完成——設計稿的「標記」畫面對應的 `quickmarks` 表仍可
覆寫，而 `url` 欄位只存在於該表。要嘛把它也改成附加式修訂，要嘛明確標成「書籤表，不是紀錄」。

### 2026-09-04 · 9a／9b／5c 漸進揭露落地

§22 上線。第一天側欄四格，其餘頁面在自己的資料出現後才列出；隱藏不等於不可達（⌘K
一律列全部、快捷鍵照舊、外觀頁有總開關）。首次執行改為單一路徑：內建終端機加一條會亮
起來的時間軸長條，十個擷取來源降為折疊區。

**每個「更寬鬆的版本」都會壞掉，這是本次真正的工作內容：**
- **證據**不能定義成「非 housekeeping」。alert runtime 每次開專案都啟動，IP policy 無條件
  送第一筆判定，所以幾秒內就有一筆非 housekeeping 的上鏈列——首次執行畫面會自己消失。
  改用正面述詞 `EVIDENCE_SQL`；`HOUSEKEEPING_SQL` 刻意不擴大（時間軸鏡像它，那筆判定
  該留在時間軸上）。
- **目標／範圍**只算指令推導出的目標。proxy 對每筆 HTTP／DNS、連線監控對每個 socket 都會
  蓋 `target_id`，跨型別去算的話一次瀏覽器開頁就解鎖兩頁。
- **HTTP** 等 logged 層的流量，因為那頁只查 logged 層；上鏈的 `scanner:connection` 會解鎖
  一張永遠空的頁。**標記**等 `quickmarks` 列，不是 `marker` 事件（兩個儲存區，且後者可由
  外部 POST）。
- **層級字符**在 logged 層被清空後仍在，靠的是活得比資料久的稽核列。
- **首次執行畫面用閂鎖**：直接讀 `firstRun` 的話，第一列進來的瞬間畫面就被卸載——而那正是
  它要讓人看到的一刻。e2e 抓到的。

**順手修掉兩個既有缺陷**：側欄印的是渲染位置而非視圖編號（所以一直有兩列印著 9,還有三個
開不了東西的 9／10／11）；⌘K 與快捷鍵面板用 `sidebar.http_history` 這個兩本語言檔都沒有的
鍵，直接把鍵名印給操作員。後者的守衛本來抓不到——字面鍵掃描器看不到動態鍵，而
`shortcuts.test.ts` 的 fixture 是手抄的舊清單。

**還修了一個 pty 洩漏**：TerminalView 的分頁清單在元件本地 state，離開再回來會拿空清單再
spawn 一個 pty，把前一個孤兒化——每次進出漏一個 shell。改成先接管既有工作階段，順帶也是
操作員要的（回到原本那個 session，帶著 scrollback）。

**取捨記錄**：`複數 e2e` 因為側欄會隱藏而需要重新檢視;本次全套 90 個 spec 重跑通過，
未改動任何既有 spec 的斷言——`openView` 走的 `data-view-btn` 在解鎖後才存在，而需要它的
spec 都已經先種了對應資料。

### 2026-09-04 · 8a 範圍回溯落地

允許清單存檔後會重算既有事件：不動任何既有列，另寫鏈上 `system.scope_recomputed`
（摘要與錨點）、回溯 `system.scope_violation`（帶 `judged:'retroactive'`）與
`system.scope_cleared`（撤回既有違規）。範圍頁有三數橫幅（重算／新標／解除），回溯列
帶琥珀「事後判定」chip，時間軸上也有對應徽章。

**命名裁決：** 設計稿寫 `scope.recomputed`，實際存的 subtype 是 `scope_recomputed`
（snake_case）。所有 `system` subtype 都是 snake_case,`classifyTier` 以
`agent_type:subtype` 為鍵。設計稿散文維持原寫法。

**幾個必須寫下來的判斷：**
- **撤回由「違規紀錄」算，不是重掃語料。** 語料大半在 logged tier,30 天後被清；
  重掃式的撤回會讓那些違規永遠掛著。
- **候選目標用 SQL 從 `data` 推導，不是 `target_id`。** DNS producer 存的是帶結尾點的
  FQDN，當初判定的是去點形式，而網域比對是精確比對——用 `target_id` 分組會去判定
  live 路徑從來沒看過的目標。實測分歧已寫成測試。
- **`unrelated` 不在任何出貨中的 alert floor。** 否則第一次存檔就會替操作員碰過的每個
  主機寫一筆違規。
- **不 hash alert floor。** 關掉通知只是縮小回報範圍，不是移動邊界。
- **三道閘：** 未設定範圍時跳過（`ListField` 的「刪掉唯一目標再重打」會經過該狀態兩次，
  否則每次要寫約一千筆永久簽章列）、2 秒尾端去抖動（Settings 每 350ms 自動存檔）、
  專案切換時放棄排程中的工作。

**同時修掉：** 範圍頁本來讀的是記憶體中的違規紀錄（上限 500 筆、切專案歸零、從未由 DB
補種），所以回溯列根本不可能顯示，已撤回的違規也會一直被計入。現已改由鏈供應，計數
做快取、只在三種 scope subtype 落地時失效——StatusBar 與側欄每筆事件都會問一次。

**已知取捨：** retention 的 body pinning 仍用 `matchTarget`（子字串比對，`evil` 會命中
`a.evil.example`），與 policy matcher 不同。回溯必須用 policy matcher（與當初判定一致才
有意義）；兩者的分歧已寫成測試記錄，不在本次統一。

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
- **8a 範圍回溯**：~~待做~~ → **已完成**（見下方 2026-09-04 條目）。
- **8b 標記修訂**：~~待做~~ → **部分完成**（見下方 2026-09-03 條目）。
- **9a 首次執行單一路徑**：~~待做~~ → **已完成**（見下方 2026-09-04 條目）。
- **9b 漸進揭露（§22）**：~~待做~~ → **已完成**（同上）。
- **5c「一次顯示所有頁面」開關**：~~待做~~ → **已完成**（同上，按專案存）。

**設計專案該被告知的**（2026-09-04 已回寫 `github.md`，見該檔 2026-09-04 條目）
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
