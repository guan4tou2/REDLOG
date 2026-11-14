# 2026-11-14 的決定

> **狀態**：record — 當日由擁有者做出的決定，以及實作者據此做的解讀  
> **範圍**：承接 [2026-11-13 的決定](../2026-11-13/DECISIONS.md)；同日稍早的版面裁定記在該檔 §13。這裡只記決定，執行順序由[工作計畫](../../WORK-PLAN.md)接續  
> **最後核對**：2026-11-14 於 `main@50075b8b`

每一項分開標明「擁有者的話」與「實作者的解讀」。後者不是擁有者的決定，擁有者可以推翻。

## 1. 過深的 `data`：寫入端限制深度

### 問題

兩個 verifier 重算雜湊時都遞迴走列的 `data`。`tools/redlog-verify.py`（隨 bundle 交給客戶的那一個）會在 Python 的遞迴上限停下：`data` 巢狀超過約 332 層陣列（Python 3.9、3.11；3.12 以上約 497 層）的列，在那裡被報成 **CHAIN BROKEN**，雖然列完好無損。能送 `data` 的來源——交接檔、AI 工具的輸入、代理解析出的 JSON 請求本體——自己決定它有多深，所以一筆真實的擷取可以在客戶執行的 verifier 中看起來像被竄改過。

實測（2026-11-14，本機）：寫入端今天收下 `data` 至 1,000 層（超過時 FTS 的 `json_tree` 失敗，整列不寫入）；app 自己的 verifier 約在 2,300 層失敗；`POST /api/events` 早已在解析前以 400 拒絕超過 64 層的請求本體（#695）。數字與版本見 [Spec 071 plan D13](../../../specs/071-event-provenance-and-ingestion-contract/plan.md)。

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
| 怎麼限制 | **無損折疊**：會位於第 65 層的容器，在原位置換成其 JSON 文字（與 `JSON.stringify` 逐位元組相同），`JSON.parse` 即得回原內容；`_ingest.collapsed` 記下折疊了幾個 | 拒收或截斷會遺失證據，違反 2026-11-13 §12 的完整擷取 |
| 上限 | **64**（`data` 本身為第 1 層，純量不計層） | repo 內 fixture 最深 3 層；本機 323,816 筆 AI 工具呼叫的輸入最深 5 層；Python verifier 最不利的形狀在 332 層失敗，約 5 倍餘裕；與 API 既有的 64 層一致 |
| 已寫入的列 | **不遷移、不改寫** | 產品未發行，不做相容（Spec 077 R8） |
| 兩個 verifier | 不改 | 折疊後的列對兩者都在上限內；以新的共用向量 `test/fixtures/depth-vectors` 證明 |

規格：[Spec 071](../../../specs/071-event-provenance-and-ingestion-contract/spec.md) FR-097、FR-005 的 `collapsed` 列、FR-006 的註記；plan D13；tasks T03A。

### 帶出的問題（待擁有者）

`POST /api/events` 以 400 拒絕巢狀超過 64 層的請求本體，項目不被記錄，mitm addon 對 4xx 也不寫交接檔。寫入端的折疊因此到不了 API 入口，同一個過深項目經 API 遺失、經交接目錄保存（Spec 071 Q9，附建議）。實作沒有替擁有者改這一點。
