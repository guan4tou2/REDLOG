# 設計筆記：核心 + 外掛架構，以及統一格式如何不失真

寫於 2026-09-06。延續 [`DESIGN-traffic-attribution.md`](DESIGN-traffic-attribution.md) 的討論，
回答兩個問題：

1. 能不能把 app 縮到最精簡的核心，擷取與正規化全部交給外掛、要用什麼自己裝？
2. 如果所有來源都被轉成統一格式，紀錄會不會失真？

短答：**可以，而且第 2 題的答案決定了第 1 題怎麼設計。** 統一格式如果是「轉換」就一定失真；
如果是「信封 + 索引」，原始位元組另存且上鏈，就不會。RedLog 現有的原則（抓完整、匿出時才
sanitize、鏈上只放 sha256）已經是這個形狀，這份筆記只是把它推到底。

---

## 1. 核心的邊界

判斷標準只有一個：**這東西壞掉或被繞過，會不會讓紀錄「不完整」或「不可信」？** 會的留核心。

| 核心 | 理由 |
|---|---|
| 事件庫、單一寫入點、暫停閘 | 「暫停就是暫停」依賴所有寫入經過同一點 |
| 證據鏈、OpenTimestamps 錨定、時鐘校正（wall / mono / NTP offset）、operator 歸屬 | 「可信」的全部來源；由核心蓋，不由外掛自報 |
| 統一格式（信封 schema）與**分層規則** | 契約本身；哪種事件上鏈、哪種進 logged 層由核心按型別決定 |
| 原始位元組儲存（sidecar）與 sha256 | 不失真的物理基礎（§4） |
| 遮蔽／sanitize 閘 | 外掛送生料，機密不能因某外掛沒遮就落地 |
| 擷取健康度 | 核心要知道有哪些來源、誰沒在餵 |
| 跨來源歸因（socket → pid → 指令） | 要看得到所有來源才能對 |
| 時間軸與 UI | 呈現層 |

底線以上全部外掛：擷取、正規化、目標抽取、loot 樣式、MITRE 標籤、C2 ingest、匯出格式。

**「核心小」≠「app 空」。** 出廠內建一包 starter pack（shell hook + 內建終端機、代理逐字稿
tailer、mitmproxy addon），預設啟用、可移除、但仍是外掛格式。否則首次執行就是一條空時間軸加
一份外掛清單——這正是 UX 審計指出「零摩擦擷取在首次執行反轉」的最壞版本。

---

## 2. 外掛的四種角色

| 角色 | 做什麼 | 跑碼？ | 在哪跑 |
|---|---|---|---|
| **producer** | 抓取：hook shell、跟 log、側錄封包、跑 proxy | 是 | **外部程式**，拿 token 打本機 API。不進 Electron 的隔離器——那會讓隔離器長出 pty／網路能力 |
| **mapper** | 把 producer 送來的原始資料對到信封的正規化欄位 | 宣告式優先（JSON 欄位對照）；複雜才 🔴 隔離程序 | 核心 ingest 路徑上，決定性、有版本 |
| **enrichment** | 目標抽取、MITRE 標籤、loot 樣式、pivot 偵測 | 否（regex／樣式） | 核心，讀正規化欄位，只**加**推論欄位 |
| **exporter** | HAR、Ghostwriter、STIX… | 依複雜度 | 核心匿出路徑 |

producer 與 mapper **分開**：抓取碰系統、風險高、以外部程式隔離；正規化只是資料變換、可以
宣告式、在核心跑。今天的 shell hook、mitmproxy addon、c2-tailer 已經是 producer 的形狀。

### manifest 草案

```jsonc
{
  "id": "pcap-pktap",
  "version": "1.0.0",
  "schemaVersion": 2,                 // 信封 schema 版本；核心能同時吃 N-1 與 N
  "kind": "producer",
  "emits": ["scanner.connection", "dns.query"],
  "install": { "method": "manual" | "script", "steps": [...] , "requires": ["tcpdump", "bpf-group"] },
  "health": { "probe": "process:tcpdump" | "lastEventWithin:60s" },
  "mapper": "pcap-flow@1",            // 指定用哪個 mapper 正規化
  "capabilities": []                  // producer 在外部跑，不需核心能力
}
```

分層（chained / logged）**不在 manifest 裡讓外掛自選**：核心按 `agent_type` 查表決定。
一個外掛不該能把一萬筆 HTTP 塞上鏈。

---

## 3. Ingest 協定：原始 = 送進來的那串位元組

```
POST /api/ingest
{ "source": "pcap-pktap@1.0.0", "raw": <bytes 或 JSON>, "hint": "scanner.connection" }
```

核心做的事，依序：

1. **先存原始**：`raw` 原封不動寫進 sidecar，算 sha256。這一步在任何解析之前。
2. 蓋信封：id、三種時間、operator（由 token 解析）、source、raw_ref。
3. 跑該 source 指定的 mapper（有版本），產出正規化欄位。
4. 跑 enrichment，產出推論欄位（一律標 `inferred` + 信心度）。
5. 遮蔽偵測只**標記 span**，不改原始。
6. 決定分層，寫入，推進鏈。

現有的 `POST /api/events` 保留，等價於 producer 直接送已正規化的信封；此時 raw 就是該次
request body 本身。**所以每一筆事件的 raw 都等於 producer 送來的那串位元組**——不失真是
建構上的性質，不是靠每個 mapper 小心。

---

## 4. 統一格式會不會失真？——雙層記錄

會失真的統一格式長這樣：把工具輸出**轉換**成 schema，然後只存轉換結果。轉不進去的欄位丟了、
轉錯的沒法回頭、下個版本 schema 一改舊資料就對不上。

不失真的統一格式長這樣：

```
信封（核心擁有，上鏈，小）
├─ id / ts_received / ts_mono / ntp_offset / operator / source / tier
├─ raw_ref: { sha256, stream, off, len, encoding }      ← 指向原始位元組
├─ mapper: { id, version }                              ← 誰、哪版把它正規化的
├─ 正規化欄位（Ghostwriter 相容鍵：dest_ip, dest_host, command, description…）  ← 衍生
└─ 推論欄位（mitre_ttp, target, loot type, scope verdict）＋ inferred:true ＋ confidence  ← 衍生

原始（sidecar，不上鏈，只有 sha256 上鏈）
└─ producer 送來的位元組，原封不動
```

**統一的是信封，不是內容。** 正規化欄位是原始的**索引與摘要**，讓時間軸能畫、搜尋能找、
匯出能對到 Ghostwriter；它們可以不完整，因為它們不是紀錄本身。

### 這給了五個保證

1. **無損**：原始永遠在。正規化是摘要，摘要本來就會少東西，但少的東西沒有消失。
2. **可重推**：mapper 有版本。發現某版 mapper 有 bug，對原始重跑，**追加**新的衍生列（跟標記
   修訂同一個模式），不 UPDATE。時間軸顯示最新一版，舊版仍在鏈上。
3. **可溯源**：每個正規化欄位都能指回 raw_ref 的 offset，Inspector 的〈原始〉分頁就是直接顯示
   那段位元組。
4. **解讀有標記**：所有推論欄位帶 `inferred` 與信心度（DESIGN-PRINCIPLES §3），操作員可一鍵
   升格為權威標記。
5. **不認得的不丟**：mapper 對不進 schema 的欄位放進 `extra` 原樣保留——其實有 raw 就夠，
   `extra` 只是讓搜尋碰得到。

### 失真會從哪裡溜進來，以及守則

| 來源 | 現象 | 守則 |
|---|---|---|
| **時間** | 用 RedLog 收到的時間蓋掉工具自己的時間，或反過來 | 兩個都存：`ts_source`（工具說的）與 `ts_received`（核心校正過的）。時間軸預設用後者，Inspector 顯示兩者與差值 |
| **編碼** | 二進位輸出被轉成 UTF-8 替代字元（shell hook 註解裡自己承認的 TODO） | raw 一律是位元組（檔案或 base64），字串只是衍生 |
| **截斷** | stdout 100 KB 上限，超過的部分不見 | 信封必記 `truncated: true`、原始長度、若能取得則全量 sha256；UI 顯示「已截斷」不顯示假的完整 |
| **彙整** | pcap 只變成 flow 摘要 | 摘要是衍生、pcap 是 raw；查詢時用 tshark 切原始 |
| **枚舉壓縮** | 工具的 7 級嚴重度被塞進 4 級 | 正規化欄位放對照後的值，`extra` 放原值 |
| **遮蔽** | ingest 時就把機密改成 `***` | **最大的失真來源。** 抓完整、遮蔽只記 span、UI 上遮、匿出才 sanitize（`redaction-design.md` 既有立場）。原始在 sidecar 受存取控制，不是被改寫 |
| **排序** | 用收到順序當事件順序 | 已有 `eventOrder.ts` 以單調時鐘排序；信封帶 mono 就不會錯 |
| **schema 演進** | 新版 schema 讓舊事件缺欄位 | 信封帶 `schemaVersion`；核心讀 N-1；不回填舊列，需要時對 raw 重跑新版 mapper 追加衍生列 |

### 一個可以自動化的測試

對每個內建 mapper：給定 raw fixture，(a) `sha256(raw)` 等於信封 `raw_ref.sha256`；
(b) 用 mapper 輸出 + raw 能重建 UI 顯示的每個字；(c) 隨機 fixture 走一遍 ingest 再從 sidecar
讀回，位元組相等。三條過了，「不失真」就不是一句話而是一個 CI 守衛。

---

## 5. 遷移路徑（不重寫）

現有 `events.data` JSON 事實上就是 raw。要做的只有：

1. 信封加 `raw_ref`、`mapper`、`schemaVersion`、`ts_source` 四欄；既有列 `raw_ref` 指向自己的
   `data`（offset 0、全長）。
2. 新增 `POST /api/ingest`；`POST /api/events` 保留。
3. 把 `target-extractor.ts` 的 30 幾條 regex 搬成內建 🟢 enrichment pack；核心不再直接認工具。
4. 第一批新 producer：pcap（pktap／tcpdump）、透明代理設定、socket→pid→指令 對照器
   （後者是核心服務，不是外掛）。
5. manifest 加 `schemaVersion` 與 `health`，擷取健康度改讀 manifest 而非寫死清單。

每一步都可以獨立出貨，且不動既有資料。

---

## 6. 代價

- 外掛 API 變成公開契約：改 schema 就是 N 個外掛的遷移，`schemaVersion` 與雙版本讀取不可省。
- 測試分兩層：核心測契約（§4 的三條守衛），內建包留在 repo 進 CI。
- raw sidecar 會大（pcap 尤其）：走現有 retention（依時間／大小輪替、`system.*_pruned` 事件）。
  被 prune 的 raw，其 sha256 仍在鏈上——「內容已不在磁碟」而不是「事實被抹除」。

一句話：**核心保「一定記得到、記到的可信」，外掛保「認得這是什麼」；統一格式是信封不是轉換，
原始位元組永遠另存並以 sha256 上鏈，所以正規化再怎麼錯都只是摘要錯，紀錄不會錯。**
