# PTY 長時間錄製的 App 記憶體成長（#290）

2026-11-01。[verification.md](verification.md) 記下的 PTY soak（60 分鐘）中，App RSS 每分鐘約 +1 MiB、看不到平台。本文記錄成長來自哪裡、修了什麼，以及剩下的部分為什麼有上限。

**結論**：這不是洩漏。成長有兩個來源，都在 main process，不在 renderer：

1. **每個 `command_end` 都重算一次 HUD 的 active pivots**：每次讀 40 筆 pivot 與 120 筆 shell event 並逐筆解析，不管當時有沒有任何 pivot。這是固定成本的重複工作，不是累積；但在指令密集時，它就是 main 配置量的大宗，也讓 V8 heap 撐大。已修正：只在確實有 pivot 開著時才重算（`src/main/pivot-refresh.ts`）。
2. **SQLite page cache 隨資料庫成長慢慢填滿**。better-sqlite3 13.0.3 編譯時用 `SQLITE_DEFAULT_CACHE_SIZE=-16000`，每條連線的上限約 15.6 MiB；main 對事件庫開兩條（讀寫一條、快取的唯讀一條），合計上限約 31 MiB。預設 soak 每小時寫入約 19.5 MB，所以這段成長大約要一小時才會到頂。這就是 60 分鐘 soak「沒有平台」的主要原因：60 分鐘剛好停在快到頂的位置。

## 量法

全部在 WSL2 kali（Node v24.15.0、xvfb、zsh），使用 [terminal-soak.spec.ts](../../e2e/terminal-soak.spec.ts)。本次替它加上：

- 每分鐘樣本依 process type 拆 RSS，並記錄 main 與 renderer 的 JS heap（`process.memoryUsage()`、CDP `Runtime.getHeapUsage`）以及 DOM 計數。
- `REDLOG_SOAK_GC=1`：取樣前在兩個 heap 都強制 full GC。
- `REDLOG_SOAK_PROFILE_AT=<分>`：從那一分鐘起，在兩個 heap 各做一分鐘 V8 配置取樣（含已回收的物件），存成 `.heapprofile`。
- `REDLOG_SOAK_RESIZE_VIA=cdp`：改用 CDP 改 viewport 來 resize，不經過 main 的 JS（排除測試框架自身的 inspector 呼叫）。

main process 的 mapping 由 `/proc/<pid>/smaps` 每 2 分鐘取一次。Electron 的 main 用 Chromium 的 PartitionAlloc 當 malloc，所以 Node 與 SQLite 的原生配置都算在 `[anon:partition_alloc]`，V8 heap 則在 `[anon:v8-sandbox]`。

形狀代號：**預設** = 每 2 秒一個指令、每個印 20 行、每 15 秒 resize（與 verification.md 相同）；**指令密集** = 每 400 ms 一個指令、每個印 1 行；**輸出密集** = 每 2 秒、每個印 200 行。

## 第一步：成長在哪個 process

| run | 形狀 | 時長 | main（Browser） | renderer（Tab） | 備註 |
|---|---|---|---|---|---|
| A | 預設，強制 GC | 20 分 | 209 → 219 MiB | 281 → 約 300 後持平 | main JS heap 10.9 → 12.7 MiB |
| B | 預設 | 20 分 | 205 → 221.5 MiB | 290 → 約 310 後持平 | smaps 2→20 分：partition_alloc +10.8、v8-sandbox +5.0 MiB |

renderer 的成長是 xterm 5,000 行 scrollback 在前幾分鐘填滿，之後持平。main 才是一直線往上的那個，而且在強制 GC 下 JS heap 幾乎不動：主要成長在 JS heap 之外。

## 第二步：跟什麼成比例

| run | 形狀 | 時長 | main |
|---|---|---|---|
| C | 輸出密集（與 D 同時跑） | 11 分 | 208 → 231 MiB |
| D | 指令密集（與 C 同時跑） | 11 分 | 208 → 280 MiB，heapTotal 17 → 69 MiB |

成長跟指令數有關，跟輸出位元組數沒什麼關係。在指令密集下做配置取樣（run E，第 6 分鐘起一分鐘）：main 取樣到 63.0 MiB，其中 `queryEvents` + `rowToEvent` 佔 37.4 MiB，**全部**來自同一條堆疊：

```
queryEvents < getActivePivots < eventBus 'event' listener（src/main/index.ts）
```

對照（指令密集、單獨跑、9 分鐘）：

| run | 內容 | main | heapTotal |
|---|---|---|---|
| G | 修正前 | 210 → 253 MiB（+43） | 18 → 47 MiB |
| F | 本機診斷開關停用該重算（未 commit） | 206 → 222 MiB（+16） | 18 → 21 MiB |
| H | 修正後（`aa8bb8e8`） | 209 → 223 MiB（+14） | 18 → 21.5 MiB |

H 的配置取樣：main 26.6 MiB／分鐘，`queryEvents` 不再出現；剩下的是 `insertChainedEvent`、`canonicalStringify`、API server 的 request 處理等，都是每筆 event 本來就要做的事。

## 第三步：修正後，預設形狀剩下的斜率

| run | 形狀 | 時長 | main | 備註 |
|---|---|---|---|---|
| I | 預設，修正後 | 60 分 | 205 → 246.5 MiB | smaps 2→60 分：partition_alloc +30.5、v8-sandbox +6.5 MiB；heapTotal 約 21 MiB 持平 |
| J | 預設，不 resize | 20 分 | 203 → 222 MiB | |
| K | 預設，CDP viewport resize | 20 分 | 205 → 225 MiB | |

預設形狀下修正前後的斜率差不多（B 與 I 在第 1 到第 19 分鐘都是 +17～20 MiB），因為每 2 秒一個指令時，那個重算只占小部分。J、K 與 I 一樣，所以 resize 與測試框架經 inspector 對 main 的呼叫也都不是來源。

剩下的 partition_alloc +30.5 MiB 對上兩條連線各 15.6 MiB 的 page cache 上限。run I 結束時 `timeline.db` 是 19.5 MB（另有 4.5 MB WAL），而 main 的 RSS 在 cache 快滿時明顯變平：

| smaps 時點 | main RSS |
|---|---|
| 32 分 | 237.2 MB |
| 40 分 | 242.2 MB |
| 48 分 | 247.7 MB |
| 56 分 | 248.3 MB |

兩個對照直接驗證這一點（兩者同時跑，彼此的干擾相同）：

| run | 內容 | 時長 | main | 資料庫 |
|---|---|---|---|---|
| M | 預設形狀，本機診斷開關把兩條連線的 cache 降為 2 MiB（未 commit） | 20 分 | 第 5→19 分 212.6 → 215.5 MiB（+3）；partition_alloc 14 分 +2.1 MiB | 6.7 MB |
| L | 輸出密集，預設 cache，讓資料庫很快超過 cache 上限 | 30 分 | 第 16 分到約 232 MiB 後持平至第 29 分；smaps 約第 26→32 分 236.0 → 236.5 MB | 35.5 MB |

同一段時間，預設 cache 的 I／J／K 都是約 +13 MiB。cache 變小，成長跟著消失；資料庫超過 cache 之後，成長停在那裡。

**以 8 小時估算**：main 會在 cache 填滿時（預設形狀約錄到第 50–60 分鐘）停在約 +31 MiB（page cache）加上數 MiB 的 V8 heap，之後持平，不是照 1 MiB／分鐘外推的 +480 MiB。這個估算是兩個 30 分鐘以內的對照加上一次 60 分鐘 run 推出來的，**沒有**實際跑 8 小時。

## 沒有修的

- **SQLite cache 上限**：兩條連線合計約 31 MiB，是 better-sqlite3 的預設，不是錯誤。要不要調小（例如唯讀連線）是取捨，不在本 PR。
- **renderer 每批 event 的重繪**：配置取樣中，renderer 每分鐘約 6.5 MiB 花在 lucide icon 節點重建（StatusBar／Sidebar 每批 event 由 `useAppCounts` 觸發多次 setState）。這是 churn，renderer RSS 持平，不是成長來源。
- **輸出中間插進提示列**：輸出密集形狀（每指令 200 行）時，soak 判定少了行（C：47 次 resize、77 行；L：119 次 resize、159 行），但 cast 裡那些行的位元組都在：zsh 的 PROMPT_SP 序列（反白的 `%`、一整行空白、`\r \r`）插進了一行中間，`SOAK-(\d{6}) 0*\d+\r?\n` 這個 regex 對不上。和 resize 無關：抽查 C 的 20 筆，多數離最近的 resize 有 4–16 秒，第一筆發生在任何 resize 之前。cast 沒有掉資料，但終端機畫面上提示列會出現在輸出中間；原因（例如 hook relay 的輸出晚於提示列）沒有查。預設形狀（每指令 20 行）在 verification.md 的兩次與本次 run I（都是 60 分鐘）都沒有出現。
- **`getActivePivots` 的 120 筆視窗**：「已關閉的前景 tunnel」只從最近 120 筆 shell event 找；60 個指令之後，一個已關閉的 pivot 會在下次重算時重新出現（在 30 分鐘時效內）。修正後，若它關閉時已沒有其他 pivot 開著，之後的 `command_end` 不再重算，它不會因此回來；但下一個 pivot event 或 HUD 重新讀取時仍會。機制本身沒改。**後續已修**：關閉改從 pivot row 本身讀（ingest 早已把前景 tunnel 的結束記成 `subtype: 'closed'` 的 pivot row），不再讀 shell row；見 `src/main/active-pivots.ts` 與 `test/active-pivots.test.ts`。
