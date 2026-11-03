# 各擷取來源的長時間 soak 與中途重啟（#291）

2026-11-02。#290 的 soak（[verification.md](verification.md)）量的是串流能不能長時間保存，以及 producer 被硬殺之後讀回什麼。本文量 #291 要的另一半：每種來源在長時間負載下，哪些被保存、哪些變成一筆 `capture_gap`、哪些**沒有任何紀錄就不見**；以及 App 在中途結束、重開同一專案之後，三者各是多少。

**結論**：四種來源各跑 25 分鐘（第 20 分鐘重啟 App），另有一輪 HTTP 以 crash 取代 quit，**沒有找到無聲遺失**：client 實際收到、但沒被保存的每個單位，都落在某筆 `capture_gap` 的時間窗內，或由 stream completion 標出缺少的數量。記憶體都有上限（main 在 SQLite page cache 填滿後持平，mitmdump 在 160 KiB/s 的 WebSocket 下持平）。找到的問題不在資料本身，而在**說明缺口的那筆紀錄**：

- addon 寫 spool 與 App 的 drain 有競態，gap 紀錄可能寫不進去；除了 `queue-full` 以外的四種寫不進去時會無聲消失（[#507](https://github.com/guan4tou2/REDLOG/issues/507)）。
- 同一專案的 App 重啟，會出現一筆 `project-switched` gap（原因標錯，數量正確）。
- App 的 API 在高寫入量下（HTTP burst、重開大型專案後）會停頓 1–6 秒，超過 addon 的 5 秒 POST timeout：這是 64-slot 佇列會滿、以及偶發 `delivery-unconfirmed` 的來源。

## 量法

[capture-soak.spec.ts](../../e2e/capture-soak.spec.ts)，opt-in 的 Playwright spec，與 #290 的兩個 soak 同一形式：

```bash
npm run build
REDLOG_SOAK_MINUTES=25 npx playwright test e2e/capture-soak.spec.ts --reporter=line
REDLOG_SOAK_MINUTES=25 REDLOG_SOAK_SOURCES=http REDLOG_SOAK_RESTART=kill npx playwright test e2e/capture-soak.spec.ts
```

- 每個來源一個 test，一次一個，各自一個隔離的 HOME／USERPROFILE（`launchWithTempHome`），從不碰真正的 `~/.redlog`。專案 scope 設為 `127.0.0.1`，流量是 in-scope 的正常情形。
- 每個單位都帶自己的序號：SSE 的 `id:`、WS server frame 的前 4 bytes、WS client 文字的 `client N`、HTTP 的 `?seq=N`、PTY 每行的 `SOAKA-0000001`。結束時依序號逐一分類：
  - **kept**：保存了（從 `timeline.db` 讀回，body 從 inline 或 `http-bodies/` sidecar 讀回後再解析序號）。
  - **covered**：沒保存，但 client 收到它的時間落在某筆 `capture_gap` 的 `gap_started_at`–`gap_ended_at` 內（各放寬 3 秒）。`delivery-unconfirmed` 沒有時間窗，以 `reported_at` 往前 5 秒（addon POST 的 timeout）當窗。沒有時間窗也沒有原因時間的 gap（App 的 `gap-unsaved`）只以數量涵蓋。
  - **silent**：沒保存，也沒有任何 gap 涵蓋。
- 每分鐘取樣：main process 與 mitmdump process tree 分開的 RSS、專案目錄依頂層項目的大小、addon 的 spool（`~/.redlog/pending`）與 in-flight marker（`~/.redlog/inflight`，其 `upper_bound` 是 64-slot 送出佇列的占用量，進位到 8）、`capture_gap` 依原因的列數與單位數。另有每秒一次的輪詢記下 marker 出現過的最高 bound，因為佇列可能在一個取樣間隔內滿了又清空。
- 計數一律由 test 自己開唯讀 SQLite 連線讀 `timeline.db`，不經 renderer，所以 soak 的讀取不算進它量的 App 記憶體（#290 PTY soak 第一次就是量到了自己）。
- 重啟（`REDLOG_SOAK_RESTART`）：`quit` 是 `app.quit()`，與 tray 的 Quit 相同（`will-quit` 殺掉 proxy、關 terminal、停 API）；`kill` 是 `taskkill /F /T` 整個 App process tree。之後以同一 HOME 重開、`project.open`、等 HTTP capture 自動啟動，來源重新連線，跑完剩下的時間；結束後等 spool drain（30 秒一次）且計數不再變動才讀判定。
- 失敗條件：main 或 mitmdump 在 warm-up（重啟前那段的前十分之一）之後成長超過 64 MiB，或結束時 spool 沒清空。

形狀（皆為預設值）：

| 來源 | 形狀 |
|---|---|
| SSE | 每 50 ms 一則，512 B pad（約 20 則／秒） |
| WS | server 每 100 ms 推一個 16 KiB binary frame；client 每 500 ms 送一則中文文字 |
| HTTP | 每秒 50 個 512 B 的 GET（keep-alive），每 5 分鐘一次 10 秒、32 並發的 closed-loop burst |
| PTY | 內建終端（Windows：Windows PowerShell）一個 `while` 迴圈，每 50 ms 印一行帶序號、100 字元的輸出；重啟後在新 pane 重來一次 |

## 環境

Windows 11 Pro 10.0.26300 x64，Node v22.23.1，Electron 由 `out/` 啟動（未打包），mitmdump 12.2.3（Python 3.12.13）。commit `77deea4f`（`main@86c72446` 加上本 spec），tree 乾淨；addon SHA-256 `92704509…`。每個來源 25 分鐘，第 20 分鐘以 `quit` 重啟。2026-11-02 08:09Z → 09:56Z，同一台機器依序執行。PTY 那次的結果檔記為 `dirty: true`：Playwright 在整輪開始時已載入 `77deea4f` 的 spec，之後本機對 spec 的修改（下方第 3 點的 API 探測與 `delivery-unconfirmed` 的時間窗）不在那一輪裡；那兩項修改在 `837e52d3`。

## 結果

### 每單位的去向

| 來源 | 階段 | client 收到 | kept | covered（gap） | silent | 串流狀態 |
|---|---|---|---|---|---|---|
| SSE | 重啟前 | 18,632 | 18,630 | 2（`delivery-interrupted`） | **0** | `completion-unknown` |
| SSE | 重啟後 | 4,377 | 4,377 | 0 | **0** | `known-partial`（client 中止） |
| WS server frame | 重啟前 | 10,391 | 10,389 | 2 | **0** | `completion-unknown`，無 `websocket_end` |
| WS client 文字 | 重啟前 | 2,235 | 2,234 | 1 | **0** | 同上 |
| WS server frame | 重啟後 | 2,136 | 2,135 | 1（`delivery-unconfirmed`，見下） | **0** | `known-partial`，observed 3,056／saved 3,055，`missing: 1` |
| WS client 文字 | 重啟後 | 460 | 460 | 0 | **0** | 同上 |
| HTTP 回應 | 全程 | 42,367 | 42,353 | 14 | **0** | — |
| PTY 行 | 重啟前 | 15,619（renderer 顯示） | 15,619 | — | **0**（無洞、無重複） | `session_end` reason `app-quit`，bytes 與 SHA-256 與檔案一致 |
| PTY 行 | 重啟後 | 4,049 | 4,049 | — | **0** | `session_end` reason `shell-exited`，一致 |

SSE 重啟前少的 2 則，正好是 quit 時留下的 in-flight marker（bound 2），重開後被收成 2 個單位的 `delivery-interrupted`：#291 的 marker 機制在真的 App quit 下按設計運作，數量完全對上。WS 重啟前少的 3 則由同一機制（bound 8 的上界）涵蓋。

PTY 沒有 gap 機制可涵蓋，所以標準更嚴：renderer 透過 `terminal.onData` 看到的最大行號，必須等於 cast 裡的最大行號，且 1 到該行號之間沒有洞。quit 時 renderer 顯示到第 15,619 行，cast 也存到第 15,619 行。main 寫 cast 與送 renderer 是同一份資料，這是預期的；這裡驗的是 quit 路徑會把 cast 寫完、`session_end` 宣稱的大小與 hash 與檔案相符。重開後頭一次取樣看到 spool 有 2 個檔（PowerShell hook 在 App 不在時的事件），下一次取樣已清空。實際速率約每秒 13 行（PowerShell 的 `Start-Sleep` 額外耗時），不是名目的 20 行。

HTTP 的 14 個缺口：21 個單位的 `queue-full`（burst 時 64-slot 佇列滿）、8 個 `delivery-interrupted`（重啟）、1 個 `project-switched`（重啟，見下）。另有 229 個回應被保存、但 client 端算失敗（burst 時超過 client 10 秒 timeout 才回來），7 個成功回應少了 `http_request_start`（也在 `queue-full` 窗內）。

### 記憶體

| 來源 | main warm → 重啟前最後 | main 高峰 | mitmdump warm → 最後 | 曲線 |
|---|---|---|---|---|
| SSE | 147.0 → 175.9 MiB（+28.9） | 176.9 | 92.6 → 93.0（+0.4） | main 第 14 分鐘起持平於 176 |
| WS | 147.2 → 166.2（+19.0） | 168.1 | 94.7 → 99.1（+4.4） | main 第 6 分鐘起在 157–163 間；mitmdump 92–100 |
| HTTP | 171.6 → 206.3（+34.7） | 256.6（第 9 分鐘） | 98.1 → 110.8（+12.7） | main 第 11 分鐘起在 199–214 間；mitmdump 105–119 |
| PTY | 142.5 → 147.9（+5.4） | 148.3 | 88.5 → 88.9（+0.4） | main 全程 142–148 |

main 的成長形狀與 [pty-memory.md](pty-memory.md) 相同：SQLite page cache 隨 DB 長大而填滿，填滿就持平。WS 在每秒 160 KiB 的 binary frame 下跑 20 分鐘，mitmdump 沒有成長：#479 讓 addon 修剪 `flow.websocket.messages`，mitmproxy 自己的 in-memory history 在長時間下確實有上限（#290 的對照組以更重的負載顯示，未修剪時 mitmdump 線性上升）。HTTP 的 main 在第 8–10 分鐘升到 257 MiB，之後回到約 205，原因未查；仍在預算內。

### 專案目錄（25 分鐘結束時）

| 來源 | `timeline.db` | `http-body-index.db` | `http-bodies/` | `casts/` | 列數 |
|---|---|---|---|---|---|
| SSE | 92.8 MB | 28.1 MB | 0 | 0 | 23,007 chunk |
| WS | 64.7 MB | 4.2 MB | 170.2 MB | 0 | 17,911 ws_message ＋ 17,913 scope 判定 |
| HTTP | 319.5 MB | 12.6 MB | 0 | 0 | 42,843 request_start ＋ 42,582 response ＋ 42,843 scope 判定 |
| PTY | 3.4 MB | — | 0 | 3.2 MB（2 個 cast） | 2 個 session，無 command_end（單一長指令） |

都是線性成長，沒有超出資料本身的部分；但每個單位的落盤成本遠大於內容：SSE 每則約 620 B 的內容，DB 加索引約 5.2 KB；HTTP 每個 512 B 的回應，三列合計約 7.5 KB。**HTTP 與 WS 的每一個單位都另寫一列 `scope_violation`**（`distance: in_scope`、`severity: clean`），佔了列數的三分之一到一半；SSE 的 chunk 則沒有。以這組形狀推算，HTTP 50 req/s 一小時約 770 MB。這是容量規劃的數字，不是缺陷；scope 判定列是否該對 in-scope 的每個單位都寫，另議。

WS 的 `http-bodies/` 在重啟後不再長大，不是沒存：server 每條連線都從 seq 1 重新編號，frame 內容可重現，body store 依內容 hash 去重，重啟後的 frame 全部命中既有檔案。

### 送出佇列與 spool

- 64-slot 佇列只在 HTTP burst 時滿過（in-flight bound 64）；SSE 最高 24，WS 最高 32，穩態都在 8 以下。
- 佇列滿時 addon 照設計拒收並記 `queue-full`，以每秒一個時間窗合併：HTTP 共 18 列、21 個單位。
- spool 在每個 run 結束時都是 0 個檔；重啟當下最多 1 個檔（549 B）。沒有成長。

### App 重啟時

| 來源 | quit 到重開完成 | 重開專案耗時 | quit 後 2 秒 mitmdump 殘留 | quit 時 in-flight marker |
|---|---|---|---|---|
| SSE | 12.2 s | 6.4 s | 0 | 1 個，bound 2 |
| WS | 27.2 s | 14.1 s | 0 | 1 個，bound 8 |
| HTTP | 44.3 s | 25.3 s | 0 | 1 個，bound 8 |
| PTY | 15.1 s | 8.3 s | 0 | 無（沒有 HTTP 流量） |

- quit 都在 60 秒內結束，mitmdump（uv shim 與其 Python 子程序）沒有殘留。
- 重開專案的時間隨 DB 變大：250 MB 的 HTTP 專案要 25 秒。這段期間來源連不上 proxy；client 那一側的請求失敗不是擷取遺失（流量根本沒經過 proxy），不列入上表。

## 發現

1. **spool 寫入與 drain 的競態**（[#507](https://github.com/guan4tou2/REDLOG/issues/507)）。`_write_spool_record` 先 glob 再逐一 `stat()` 算容量，drain 若在中間刪檔就丟 `FileNotFoundError`，整筆記錄被當作寫不進去。隔離重現 5,000 次中 136 次失敗。HTTP smoke（每 30 秒一次 burst）在 2 分鐘內就撞到一次，該筆 `queue-full` gap 降級為 App 端只有數量、沒有時間窗的 `gap-unsaved`。`project-switched`、`proxy-stopped`、`delivery-interrupted` 與 `delivery-unconfirmed` 寫不進去時沒有任何後備，會無聲消失。
2. **同專案重啟被記成 `project-switched`**。HTTP run 在最後一筆 in-flight admission 之後 0.33 秒出現 1 個單位的 `project-switched`（說明文字：「在另一個專案開啟後到達」）。`will-quit` 先殺 proxy 再停專案，但被殺的 mitmdump 在 Windows 上還多處理了一個回應，此時 active identity 已清掉。數量精確、沒有遺失；只有原因是錯的。
3. **重開後的 API 停頓**。WS 重啟後約 50 秒，一則 server frame 沒被保存；5.0 秒後 addon 寫了一筆 `delivery-unconfirmed`：一次 POST 等了整整 5 秒的 timeout。stream completion 同時標 `missing: 1`，所以紀錄是誠實的；但 App 在重開大型專案後的前一分鐘裡有超過 5 秒不回應 API，而這正好是 addon 放棄送出的門檻。本 spec 因此加了每秒一次的 `/api/health` 探測（`result.api`）；之後的 crash run 量到 burst 時最長 6.0 秒的停頓（見最後一節）。
4. **proxy 吞吐量**。HTTP 穩態 50 req/s 沒有問題；但 burst 時 32 個 closed-loop client 合計只跑出約 8 req/s，部分請求超過 10 秒才回來。瓶頸在 mitmdump 這一側（addon 的佇列滿了會拒收，不會讓 proxy 等），原因未查。

## 範圍與未做

- 只在 Windows 原生跑過；WSL／Kali／macOS 未跑本 soak。PTY 用的是 Windows PowerShell（#290 的 PTY soak 只在 kali zsh 跑過，原生 Windows PTY 是第一次）。
- 每個來源 25 分鐘，不是數小時；SSE／WS 的兩小時 run 見 [verification.md](verification.md)。
- 重啟只做了 `quit`（以及下方的 `kill` 補充）；Pause／Resume、磁碟滿、專案切換沒有在本 soak 內組合。
- 覆蓋判定以時間窗為準：一筆 gap 涵蓋窗內的「某些」單位，但 gap 不帶 id，所以「covered」是「有一筆紀錄說這段時間有缺」，不是逐一對應。

## 補充：App crash（只殺 main process）

`REDLOG_SOAK_RESTART=kill`，HTTP，6 分鐘、第 3 分鐘以 `TerminateProcess` 殺掉 main process（不殺它生出的 mitmdump，與真正的 crash 相同）。commit `d59e4fbb`，2026-11-02 10:24Z → 10:31Z。每 60 秒一次 burst，取樣 30 秒。

| 項目 | 值 |
|---|---|
| client 成功回應 | 11,494 |
| kept／covered／silent | 10,860／634／**0** |
| 涵蓋缺口的 gap | 1,144 單位 `queue-full`（354 列）、8 單位 `delivery-interrupted` |
| crash 時 in-flight marker | 1 個，bound 8 → 重開後收成 8 單位的 `delivery-interrupted` |
| crash 後 2 秒 mitmdump 殘留 | 0（main 一死，mitmdump 也結束，沒有孤兒佔住 port） |
| crash 到重開完成 | 13.1 s（重開專案 6.4 s） |
| main | 149.8 → 154.9 MiB（高峰 181.4） |

crash 與 quit 的結果相同：被殺的 proxy 手上的事件由 marker 的上界涵蓋，沒有無聲遺失。

這一輪也是第一輪帶 `/api/health` 探測的：373 次中 5 次超過 1 秒、1 次超過 5 秒（最長 6.0 秒），全部落在 burst 期間或重開之後。**burst 時 App 的 API 停頓超過 addon 的 5 秒 POST timeout**，這同時解釋了兩件事：64-slot 佇列在 burst 時會滿（4 個 worker 都卡在等 App 回應），以及 WS run 重開後的那一筆 `delivery-unconfirmed`。停頓的位置（同步 SQLite ingest、索引寫入或其他）未查；[PERF-AUDIT-2026-11](../../docs/PERF-AUDIT-2026-11.md) 的 ingest 項目是第一個該對照的地方。

### 這一節之前的兩次失敗

- 第一次 kill run（commit `837e52d3`）用 `taskkill /F /T` 殺整棵樹：一個子程序先結束時 `taskkill` 回非零，harness 當成錯誤中止；而且 `/T` 會連 mitmdump 一起殺，並不是 crash 的樣子。已改為只殺 main。同一輪在 crash 之前的穩態第 16 分鐘，又出現一筆 `gap-unsaved`：#507 的競態在一般負載下也會撞到。
- 再前一次（同 commit）在第一次啟動時 HTTP capture 就是 `failed`，當時 harness 只記狀態沒記原因；之後的四次啟動都正常。harness 已改為把 `status().error` 帶進失敗訊息。原因未知，列為未解釋。
