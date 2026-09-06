# 設計:內建 target extractor 外掛化(E1)

寫於 2026-09-06。狀態:**設計 / 未實作**。E1 的目標是「core 不再硬編工具知識」——把
`src/core/target-extractor.ts` 的 30 條內建 extractor 從核心移出。實作前先把一個**會咬人的
發現**寫清楚,並定出安全路徑,避免弄壞 target/scope 這條大家都依賴的管線。

相關:[`DESIGN-plugin-kernel.md`](DESIGN-plugin-kernel.md)(§8 完成路徑列了 E1)、
[`PRD-COMPLETION.md`](PRD-COMPLETION.md)(E1 = P2)。

---

## 1. 會咬人的發現:宣告式契約表達不了內建 extractor

現行的 🟢 `targetExtractors` contribution 只有 `{ cmd, extract }`——一條 cmd 比對 regex + 一條
**單一捕獲組**的 extract regex。但 30 條內建 extractor **大多需要邏輯**,不是單一 regex 能表達的:

| 內建 extractor | 需要的邏輯 |
|---|---|
| `nmap` / `masscan` / `hydra` | `lastIpOrDomain(args)`——掃過所有 token 取最後一個 IP/domain,跳過旗標 |
| `curl` / `wget` | `extractUrlHost(args)`——先找 URL、退而找 IP、再退而找 domain |
| `sqlmap` / `ffuf` / `nuclei` | 從 `-u` 旗標取值 → `hostFromUrl()` 解析 host |
| `ssh` / `impacket` | `@host`,退而 `lastIpOrDomain` |
| `dig` | 第一個非旗標、非 `@` 的 domain token |
| `proxychains` | 先剝掉 `-q`/`-f`,再 `lastIpOrDomain` |

一條捕獲組 regex 做不到「先找 URL 再退回 IP」「取最後一個而非第一個」「解析 URL 的 host」。
所以**直接把內建搬成宣告式 pack 會遺失功能**。這是 E1 不能機械搬移的根因。

**同時**:如果只是把內建移進一個 bundled pack、靠 `initPlugins()` 在啟動時載入,那麼在
**外掛還沒載入的情境**(core 單元測試、api-server/ingest 測試、任何早於 initPlugins 的路徑)
target 抽取會回 null——`target-extractor.test.ts` 直接測內建、pipeline 測試斷言 `detectedTarget`,
都會紅。target 又餵給 scope 判定,連動面很大。

---

## 2. 設計:策略函式留 core,工具→策略對照變宣告式

把兩件事分開:

- **抽取機制(策略)= 留在 core。** `lastIpOrDomain`、`urlHost`、`urlFromFlag`、`afterAt`、
  `firstIpOrDomain`、`flagValue` 這些是**通用機制**,不是工具知識——它們該留在核心當一個
  具名策略庫 `STRATEGIES: Record<string, (args, param?) => string | null>`。
- **工具→策略對照(那 30 列)= 宣告式資料。** `nmap → lastIpOrDomain`、
  `sqlmap → urlFromFlag('-u')`……這才是「工具知識」。把它變成一張宣告式表。

**契約擴充**:`TargetExtractorContribution` 加 `strategy?: string` 與 `param?: string`,與既有
`extract?: string`(單一 regex)並存:

```jsonc
{ "cmd": "^nmap\\s",   "strategy": "lastIpOrDomain" }
{ "cmd": "^sqlmap\\s", "strategy": "urlFromFlag", "param": "-u" }
{ "cmd": "^myscanner", "extract": "--tgt (\\S+)" }   // 簡單的仍可用 regex
```

外掛與內建用**同一個機制**:外掛也能宣告 `strategy: 'lastIpOrDomain'`,拿到跟內建一樣的能力,
而不是被困在單一 regex。這正是 plugin-kernel 的精神——core 提供機制,宣告式資料提供知識。

---

## 3. 兩個實作選項(安全 vs 純粹)

### 選項 A(建議先做,安全):內建列留 core,但變宣告式資料

`target-extractor.ts` 的 `PATTERNS`(函式陣列)換成 `BUILTIN_ROWS`(資料陣列 `{cmd, strategy, param}`)。
`extractTargetWithProvenance` 用策略庫套用。**行為完全不變**(現有 `target-extractor.test.ts` 當守衛),
內建**永遠可用、可測**,而且 core 不再有 per-tool 的 bespoke 程式碼——只有一張資料表 + 通用策略庫。
外掛用同一個 `{cmd, strategy}` 形狀擴充或覆寫。

達成了 E1 的**精神**(工具知識宣告化、外掛同機制),但內建仍在 core 這個 repo 裡(當資料,不是散落邏輯)。

### 選項 B(純粹,較晚):內建列搬進 bundled pack

把 `BUILTIN_ROWS` 搬到 `plugins/builtin-tools/plugin.json`,宣告成預裝可移除的 🟢 pack。
要先解掉 §1 的載入順序問題:core 測試與 pipeline 測試需要在 setup 載入該 pack;啟動路徑要保證
`initPlugins()` 早於任何 target 抽取。這一步在選項 A 之後做才安全——A 先把契約與策略庫立起來,
B 只是把資料從 core 檔移到 pack 檔。

---

## 4. 測試計畫

- **不變**:`target-extractor.test.ts` 逐條驗證內建抽取結果——選項 A 下完全不用改(行為守衛)。
- **新增**:策略庫單元測試(每個 strategy 給輸入/輸出);契約測試(外掛用 `strategy` 註冊後可抽取)。
- **選項 B 才需要**:pipeline 測試(api-server/ingest)在 setup 載入 builtin-tools pack;
  或斷言改成「載入 pack 後 detectedTarget 正確」。

## 5. 為什麼分開一份文件、標未實作

E1 跟 F2/F3/F4 不同——那三個是機械改動,E1 有真實的契約缺口與載入順序風險,直接硬做會弄壞
target/scope 管線。依 PRD 的追蹤規則:**先設計(本文件)、再實作,實作後把本節標「已實作 →
見 X」。** 建議實作順序:先選項 A(契約擴充 + 策略庫 + 內建轉宣告式資料,行為守衛保證零回歸),
確認穩定後再選項 B(搬進 bundled pack,解載入順序)。E2(starter pack 預裝)、E3(schemaVersion
雙版本)接在 B 之後。
