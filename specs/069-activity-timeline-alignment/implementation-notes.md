# Implementation Notes: 069 現況調查(S0, 2026-11-05)

## 結論

審查報告裡能落到 RedLog 的缺口,比規格草稿假設的小。逐項:

| 項目 | 現況 | 結論 |
| --- | --- | --- |
| HTTP 排列(US2/FR-005) | ~~各段垂直堆疊,已滿足~~ **更正(T005/T006)**:段內垂直、保留換行沒錯,但 Request／Response 之間是**頁籤**,一次只看一半 | 已改為上下兩段(S2 完成) |
| 選取與定位(US3/FR-006) | `App.tsx` 持有 `focusEvent`,`openInTimeline(id, ts)` 帶事件 id;Search、Activity、Scope 都走它。Timeline 內另有自己的 `selectedEvent`,`ActivityResults` 有自己的 `selected`(下拉選來源事件) | 跨檢視定位**已用 id**。缺口只在 Timeline 與 ActivityResults 各持選取,沒有「一個選取」;範圍比草稿小 |
| Reader(US3/FR-007) | `EventContentReader` 以 `ContentDescriptor { field, status, format, capture }` 為單位,`status` 含 unavailable 各狀態;不是依來源類型分支 | 已是欄位導向的通用讀取;「新增來源不用改核心」大致成立。待確認:沒有 content 欄位的事件類型在詳情裡怎麼顯示 |
| 文案(US1/FR-001) | 見下表 | S1 已處理 |
| 未設定 Scope(FR-002) | `classifyScope`:無 targets 且無 exclude → `{ status: 'no-scope', distance: 'in_scope' }`,不會被標為範圍外;`issues.scopeUnsetDetail` 已寫明「在宣告目標之前,沒有任何東西會被標記為範圍內或範圍外」 | **已滿足**;加測試鎖住 |
| AI(FR-003) | 沒有「Chain-of-Thought」「推理鏈」字樣。`timeline.detail.agentThinking`／`settings.agents.emitThinking` 是**實際擷取到的 thinking 區塊**,屬真實資料 | 已滿足;加黑名單測試鎖住 |
| 截圖(FR-004) | 沒有推論漏洞或報告的字樣 | 已滿足;加黑名單測試鎖住 |

## 使用者可見的 Scope 字串(D2 範圍內)

改為「範圍外觀測」:`scope.recentViolations`、`scope.truncated`、`scope.violationsLabel`、`scope.violationsCountLabel`、`scope.clearedHint`、`scope.detailFailed`、`sidebar.violationsBadge`、`eventTitle.scopeViolation`(「⚠ 範圍外:{target}」)、`statusBar.scopeViolations`(zh)、`export.preview.outOfScope`(zh)、`project.importFailedEmpty`(zh)。

保留:`targets.outOfScope`、`httpScope.out-of-scope`、`export.preview.outOfScopeHttp` 等本來就是「範圍外」的字;`settings.warnOnViolation` 的**文案**本來就是「碰到範圍外目標時示警」,key 名與 `config.yaml` 的 `warnOnViolation` 不動(D1)。`marker.severity.critical`／`marker.field.severity` 是操作員自己標記的嚴重度,不是 Scope 判定,不動。

## 順手發現

- `verify:i18n` 只比對「被刪除的字串字面值」,抓不到用 **regex** 斷言標題的測試:`test/scope-tally-display.test.ts` 的 `/violation/i` 與 `e2e/timeline-encoding.spec.ts` (now in e2e/timeline-track.spec.ts) 的 `/scope violation/i` 都是在字串改掉之後才被單元測試／e2e 抓到。後者要靠 e2e 才會發現。
- `e2e/uiux-convergence.spec.ts` 的「real HTTPS evidence」在本機等不到 `certReady`(mitmdump 憑證);與本批字串無關,但本機沒有對照 `main` 的結果,以 CI 為準。

## 範圍變更:要求「照著 Stitch 重做畫面」

使用者在 S0 進行中追加:不只採用決策,而是**畫面照 Stitch 重做**。這是新的一軌(見 spec US5),需要先決定的事:Design System 以 PR #575 的 `prototypes/app-reference/index.html` 為準(兩份審查報告都這樣建議);目前 app 的 token(`styles/index.css`:`--color-redlog-bg #121214`、`surface #1a1a1d`、`accent #d75f63`)與原型(`primary #a1373d`、`surface #1a1a1d`、`surface-raised #212126`)不同,主要紅色就不一致。不先列出差異清單就動手,會與「不要各自保留一套主題」衝突。

## T016 差異清單:Stitch 原型 vs. 現行 app(2026-11-05)

比較對象:現行 `styles/index.css` 與 `Sidebar.tsx`／`Settings.tsx`、#575 的 `prototypes/app-reference/index.html`、兩份 Stitch 原型(活動紀錄、設定)。

### 1. 先修正一個前提:#575 不是另一套 Design System

#575 的 `app-reference/index.html` 用的色碼(`#d75f63`、`#74747c`、`#4a4a53`、`#bebec8`、`#6e6e78`、`#5ecf9c`、`#d4ac5a`)就是現行 app 的 token。它是**現行 app 的參考圖**,不是 Stitch 的產物。所以報告說「以 #575 為準」等於「以現行 app token 為準」,不存在要在兩套主題間選一套的問題。

### 2. 兩份 Stitch 原型彼此不一致

| 項目 | 設定原型 | 活動紀錄原型 | 現行 app |
| --- | --- | --- | --- |
| 底色／面／浮起面 | `#121214`／`#1a1a1d`／`#212126` | `#1a1a1d`／—／`#212126` | `#121214`／`#1a1a1d`／`#212126` |
| 主色 | `#d75f63` | **`#a1373d`**(`#c14f53` hover) | `#d75f63` |
| 邊框 | `#33333a` | `#33333a` | **`#74747c`**(對底色 ≥ 3:1) |
| 次級文字 | `#a1a1aa`／`#71717a` | `#bebec8`／`#a9a9b4` | `#bebec8`／`#a9a9b4`／muted `#91919c` |
| 側邊欄寬 | 224px(`w-56`) | 240px(`w-60`) | 150px(收合 48px) |
| 導覽快捷鍵 | HTTP ⌘3、目標 ⌘4、證據 ⌘5、終端 ⌘6 | HTTP ⌘4、目標 ⌘5、證據 ⌘6、終端 ⌘7 | 以 `App.tsx` 為準,兩份原型都不能照抄 |
| 字型 | Noto Sans TC + JetBrains Mono | Noto Sans + JetBrains Mono | 以 `index.css` 為準 |

設定原型的底色、面、浮起面、主色**與現行 app 完全相同**;活動紀錄原型的主色是另一個色。Stitch 自己在兩頁間沒有共用一套 token,這正是報告說的落差。

### 3. 不能照抄原型的地方(現行 app 的規則比原型嚴)

- **邊框**:app 的 `border` 是 `#74747c`,理由寫在 `index.css`(WCAG 1.4.11:控制項邊界要 3:1)。原型的 `#33333a` 對 `#121214` 遠低於 3:1;照抄會讓 `border` 對比測試失敗。`border-subtle`(`#4a4a53`)才是刻意低於 3:1 的「列間分隔」。
- **次級文字**:原型 `#71717a` 對 `#121214` 低於 `text-dim ≥ 4.5:1` 的守門測試門檻(`UIUX-STANDARD.md`);保留 app 的 `muted #91919c`。
- **填色上的字色**:app 每個填色 token 都有 `on-*` 且 ≥ 4.5:1,規則明寫「白字在任何填色上都不過」。原型常用白字壓在主色上,不能照抄。我沒有量測原型 `#a1373d` 上的白字(它比 app 的 `#d75f63` 深,可能過),只標記為**未驗證**。
- **縮放**:app 的 `body` 以 `zoom: 0.9` 渲染,原型的 px 尺寸不能直接比。

### 4. 結構差異(這才是「重做畫面」的實質)

| 區塊 | 原型 | 現行 app | 影響 |
| --- | --- | --- | --- |
| 共用外框 | 40px Header、可收合 Sidebar、24–28px Footer | 已有同類外框(150px Sidebar,`StatusBar`);寬度與間距不同 | 只調尺寸與間距,不換結構;最低風險 |
| 活動紀錄／時間軸 | 單欄、列表／時間軸切換、標準＋泳道、Reader | 已有真實版本(見 S0);缺「標準時間軸」與單一選取 | S3、S4 範圍 |
| **設定** | **無第二層側邊欄**;首頁三區塊單欄列表(擷取來源／專案設定／其他設定),每列「管理 ›」進子頁,子頁有「← 返回設定」 | **212px 左側導覽 + 內容區**(`Settings.tsx`);頁面有 General/Capture/Scope/Plugins/Retention/HUD… | **整個設定導航改型**:牽動深層連結(`pluginFocus`／`captureFocus`)、`gen:settings-search`、`openSettingsPage` 等 e2e helper、`SettingsPage` 型別。風險最高,需獨立規格(US6) |
| 外掛管理 | 報告:恢復緊湊單欄、就地展開;權限不要預設雙欄攤開 | 已是單欄列表+詳情(065/066),數量由資料算出 | 原型回歸不在 RedLog;不動 |
| 其他擷取來源 | 通用來源清單(Claude Code、Codex、Sliver、BloodHound…),來源專屬欄位由插件配置提供 | `AgentsPanel` 只列官方 AI 整合;非 AI 來源在其他群組 | 與 066 的「通用來源」方向一致;屬設定重構的一部分 |
| Shell 進階 | 完整指令忽略清單**預設為空**,不預設 `history -c`／`clear`(審查報告的要求) | `config.ts` 的 `ignoreCommands` 預設已是 `[]` | **已滿足**,不需改;原型的範例規則只是示範資料 |

### 5. 建議的批次順序

1. **共用外框尺寸與間距**(Sidebar 寬度、Header／Footer 高度、間距),沿用現行 token,不換色。低風險,先做。
2. **活動紀錄／時間軸**:S3(單一選取)、S4(標準／泳道)。
3. **設定導航改型**(US6):首頁三區塊 + 子頁,取代 212px 側欄。先寫獨立規格與遷移計畫(深層連結、搜尋索引、e2e helper),再動手。
4. 其餘頁面依批次。

不照抄的色碼與對比規則見第 3 節;若使用者要的是原型的色碼本身(例如主色改 `#a1373d`),那是修改現行 token 並重跑對比測試,應單獨決議。
