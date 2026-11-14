# 2026-11-14 的決定

> **狀態**：record — 當日由擁有者做出的決定，以及實作者據此做的解讀  
> **範圍**：承接 [2026-11-13 的決定](../2026-11-13/DECISIONS.md)；同日稍早的版面裁定記在該檔 §13。這裡只記決定，執行順序由[工作計畫](../../WORK-PLAN.md)接續  
> **最後核對**：2026-11-14 於 `main@ec01c37f`

每一項分開標明「擁有者的話」與「實作者的解讀」。後者不是擁有者的決定，擁有者可以推翻。

## 1. 過深的 `data`：寫入端限制深度

### 問題

兩個 verifier 重算雜湊時都遞迴走列的 `data`。`tools/redlog-verify.py`（隨 bundle 交給客戶的那一個）會在 Python 的遞迴上限停下：`data` 巢狀超過約 332 層陣列（Python 3.9、3.11；3.12 以上約 497 層）的列，在那裡被報成 **CHAIN BROKEN**，雖然列完好無損。能送 `data` 的來源——交接檔、AI 工具的輸入、代理解析出的 JSON 請求本體——自己決定它有多深，所以一筆真實的擷取可以在客戶執行的 verifier 中看起來像被竄改過。

實測（2026-11-14，本機，變更前）：寫入端收下 `data` 至 1,000 層（超過時 FTS 的 `json_tree` 失敗，整列不寫入）；app 自己的 verifier 約在 2,300 層失敗；`POST /api/events` 在解析前以 400 拒絕超過 64 層的請求本體（9aa28ed3；即 `data` 超過 63 層，見 §2）。數字與版本見 [Spec 071 plan D13](../../../specs/071-event-provenance-and-ingestion-contract/plan.md)。

### 考慮過的三個做法

| 做法 | 內容 |
|---|---|
| verifier 回報「此處無法檢查」 | 過深的列不判為斷鏈，改報無法驗證；verifier 要改，已出貨的 bundle 內附的 verifier 不會變 |
| 寫入端限制深度 | 寫入時就不讓 `data` 深到任何 verifier 走不動 |
| 調高遞迴上限 | Python verifier 執行時調高 `sys.setrecursionlimit`；上限與 C 堆疊相依，調太高會換成直譯器當掉 |

### 擁有者的決定

「寫入端限制深度」

### 實作者的解讀（不是擁有者的話）

| 項目 | 解讀 | 理由 |
|---|---|---|
| 怎麼限制 | **無損、可自行還原的折疊**：第 63 層以內原樣；第 64 層含容器或為標記形狀的容器，換成 `{"_collapsed": "<其 JSON 文字>"}`（與 `JSON.stringify` 逐位元組相同）；來源自己在第 64 層的標記形狀物件也包起來，所以第 64 層的標記形狀物件全是寫入端做的，`restoreDataDepth` 只憑存入的列還原；`_ingest.collapsed` 記數目 | 拒收或截斷會遺失證據，違反 2026-11-13 §12 的完整擷取。第一版把容器換成裸字串、只記數目，經獨立審查證明讀者分不出包裝與來源送來的 JSON 字串（`["[1]",[1]]` 與 `[[1],"[1]"]` 存成同樣的位元組），因此改為包裝物件 |
| 上限 | **64**（`data` 本身為第 1 層，純量不計層） | repo 內 fixture 最深 3 層；本機 323,816 筆 AI 工具呼叫的輸入最深 5 層；Python verifier 最不利的形狀在 332 層失敗，約 5 倍餘裕。API 原本的 64 層計的是請求本體，對 `data` 而言是 63 層，不是同一個數 |
| 已寫入的列 | **不遷移、不改寫** | 產品未發行，不做相容（Spec 077 R8） |
| 兩個 verifier | 不改 | 受限後的列對兩者都在上限內；以新的共用向量 `test/fixtures/depth-vectors` 證明 |

規格：[Spec 071](../../../specs/071-event-provenance-and-ingestion-contract/spec.md) FR-097、FR-005 的 `collapsed` 列、FR-006 的註記；plan D13；tasks T03A。

## 2. API 入口不再以深度拒絕事件

### 問題

`POST /api/events` 在解析之前就以 400 拒絕巢狀超過 64 層的請求本體（即 `data` 超過 63 層；9aa28ed3 為防遞迴走訪溢位而加的、所有 JSON 路由共用的閘門）。這個 400 在伺服器端無聲：沒有 log、沒有 capture-health 註記、沒有缺口列。mitm addon 收到 4xx 既不寫交接檔也不記錄，而它正是會送出由目標或測試者決定的巢狀 JSON（解析後的 HTTP 請求本體）的來源，所以那筆觀察就此遺失；同一個項目經交接目錄則以折疊形式保存。

### 考慮過的兩個做法

| 做法 | 內容 |
|---|---|
| 收下並摺疊 | 事件路由不以深度拒絕，交給寫入端的界限 |
| 維持拒絕並寫缺口列 | 仍回 400，但寫一列缺口，記下有項目因深度被拒 |

### 擁有者的決定

「收下並摺疊」

### 實作者的解讀（不是擁有者的話）

| 項目 | 解讀 |
|---|---|
| 範圍 | 只有事件路由（`POST /api/events`，與共用 handler 的 `/api/events/seed`；Phase 5 的 `/api/ingest` 寫在規格中）不再以深度拒絕；其他 JSON 路由（標記、書籤、設定、錄製、loot 掃描等）的 64 層閘門照舊，因為它們遞迴走自己的本體，也不是證據擷取 |
| 請求本體的大小上限 | 20 MiB 不變 |
| 變更之後仍會遺失過深觀察的地方 | mitm addon 自己的 `json.loads`（Python 3.9 約 1,000 層 `RecursionError`，`_extract_params` 接不到；未對 mitmproxy 內附的 Python 驗證）；AI 工具輸入超過 100 KiB 時只存鍵名；Codex adapter 的 `JSON.stringify(payload.output)` 在 Node 約 6,100 層失敗並被吞掉；收到非 2xx 就丟棄的來源（`c2-tailers/follow.js`、`pcap-capture.js`、`redlog-relay.py`）。皆未在本次修改 |
