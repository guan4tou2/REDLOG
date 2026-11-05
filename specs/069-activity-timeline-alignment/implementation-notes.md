# Implementation Notes: 069 現況調查(S0, 2026-11-05)

## 結論

審查報告裡能落到 RedLog 的缺口,比規格草稿假設的小。逐項:

| 項目 | 現況 | 結論 |
| --- | --- | --- |
| HTTP 排列(US2/FR-005) | `HttpDetail.tsx` 各段垂直堆疊,內容用 `<pre … whitespace-pre-wrap>`,已保留換行 | **已滿足**;S2 只補斷言 |
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

- `verify:i18n` 只比對「被刪除的字串字面值」,抓不到用 **regex** 斷言標題的測試:`test/scope-tally-display.test.ts` 的 `/violation/i` 與 `e2e/timeline-encoding.spec.ts` 的 `/scope violation/i` 都是在字串改掉之後才被單元測試／e2e 抓到。後者要靠 e2e 才會發現。
- `e2e/uiux-convergence.spec.ts` 的「real HTTPS evidence」在本機等不到 `certReady`(mitmdump 憑證);與本批字串無關,但本機沒有對照 `main` 的結果,以 CI 為準。

## 範圍變更:要求「照著 Stitch 重做畫面」

使用者在 S0 進行中追加:不只採用決策,而是**畫面照 Stitch 重做**。這是新的一軌(見 spec US5),需要先決定的事:Design System 以 PR #575 的 `prototypes/app-reference/index.html` 為準(兩份審查報告都這樣建議);目前 app 的 token(`styles/index.css`:`--color-redlog-bg #121214`、`surface #1a1a1d`、`accent #d75f63`)與原型(`primary #a1373d`、`surface #1a1a1d`、`surface-raised #212126`)不同,主要紅色就不一致。不先列出差異清單就動手,會與「不要各自保留一套主題」衝突。
