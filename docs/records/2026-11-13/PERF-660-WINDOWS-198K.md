# #660 Windows 約 198k 事件的效能重測

> **狀態**：record — 在原基準的同一台筆電上重測，數字只屬於這台機器、這個時間點  
> **範圍**：[#660](https://github.com/guan4tou2/REDLOG/issues/660)（[#587](https://github.com/guan4tou2/REDLOG/issues/587) 的 Windows 驗收子項）。對照的原基準是 [PERF-AUDIT-2026-11](../2026-11-01/PERF-AUDIT-2026-11.md)  
> **測試對象**：`main@72796837` 建置的 `out/`（`npm run build`，未打包安裝檔）。量測腳本的修改在本分支，產品程式未動

## 1. 環境

| | |
|---|---|
| 機器 | 與原基準同一台：Lenovo、Intel i7-1265U（2P＋8E，12 執行緒）、32 GB、NVMe |
| OS | Windows 11 專業版 build 26300；Defender 即時防護**開啟**（未為量測關閉） |
| Runtime | Node 22.23.1、Electron 44.4.1、better-sqlite3 13 |
| 負載 | 量測期間可用記憶體只有 2.7～3.9 GB（WSL 的 vmmem 約 8 GB 常駐、Edge WebView2、Chrome、其他 Claude 工作階段同時在跑）。與原基準一樣不是乾淨環境，絕對值只供參考，比值與剖面佔比才是結論 |
| 專案 | `seed-project.ts` 植入 198,360 列（chained 90,367、logged 108,000），5 天分布，`timeline.db` 約 602 MB；原基準 198,360 列、598 MB。HTTP body 不在磁碟上（與原基準相同限制） |

## 2. 專案開啟與 Timeline

`measure-app.mjs project`，同一個專案連續執行：

| 項目 | 原基準 | 本次 |
|---|---:|---|
| 點擊專案 → `view-root` | 29.8 s | **27.0 s（植入後第一次）**；之後 4 次：4.0、3.5、3.4、3.1 s；複製成新檔後前兩次：3.2、3.2 s |
| Timeline 首批點 → range status | 未列 | 3.3～4.7 s ／ 3.6～5.1 s |
| 捲動 120 步 frame p50 | 未列 | 30.6～31.2 ms |
| 捲動 frame p95 | 約 106 ms | 112、180、192、135、123 ms（五輪；複製檔 146、150）。**沒有改善，且變異大** |
| 捲動 long task | 未列 | 12～33 個，1.2～3.0 s |
| `count all`（「N of M」） | 約 1,200 ms | 1,100～1,500 ms |
| `aggregateTargets`／`distinctHosts` | 約 1,100／1,900 ms | 1,300～1,540／1,660～1,830 ms |
| 文字查詢（「ffuf」，50 列） | 約 1,800～2,500 ms | 2,550～3,300 ms |

- 原基準開啟時間的 79% 是 `getCaptureHealth`，那一項已不在剖面中。暖狀態開啟剩約 3～4 s。
- **27 s 那次沒有解釋。** 該次主程序剖面 32 s 中 24.5 s 是 `aggregateTargets` 的自身時間；單次呼叫在這台機器約 1.2～1.35 s，所以當時不是被呼叫了約 19 次，就是單次異常慢。之後加計數的那一輪只呼叫 2 次（各 1.4～2.0 s）。複製成新檔案（會被 Defender 重新掃描）沒有重現。**未證實是冷快取、Defender 或其他**；此後 6 次開啟都沒再出現。
- 沒有取得純冷快取數字：這台機器沒有可用的方式清掉檔案快取而不動系統設定。
- 搜尋頁的 type-to-results 量測每輪都逾時（`measure-app.mjs` 搜尋頁的點擊選擇器過期，原基準同樣沒量到）。**NOT RUN**；查詢本身的時間見上表，來自 preload bridge 的同樣請求。

## 3. 匯出（198k 事件、預設選項、不遮蔽）

`measure-app.mjs export`，每種格式一次全新啟動。「resolve」是 `data:resolveExportPlan`（預覽），「execute」是 `data:executeExportPlan`。第二輪沒有程序樹取樣（取樣器每 0.3 s 起一個 PowerShell，第一輪已看出它拖慢計時；第一輪只用於記憶體）。

| 格式 | 事件 | resolve | execute | 合計 | 原基準合計 | 成品 |
|---|---:|---:|---:|---:|---:|---:|
| NDJSON | 198,417 | 116.5 s | 39.5 s | **156 s** | 97 s（29＋68） | 288 MiB |
| JSON | 198,421 | 104.0 s | 42.4 s | **146 s** | 92 s（27＋65） | 377 MiB |
| HAR | 108,000 | 106.2 s | 53.5 s | **160 s** | 38 s（9.5＋28.6） | 176 MiB |
| bundle | 198,429 | 270.1 s | 289.3 s | **559 s** | 98 s（29＋69.5） | 283 MiB |

第一輪（有取樣器）的 resolve 為 129～246 s、execute 為 51～306 s，方向相同。

### 主程序與畫面是否被佔住

| 格式 | 主程序最長停頓（20 ms 計時器的最大延遲） | >100 ms 次數 | 視窗最長 frame 間隔 | 主程序峰值 working set |
|---|---:|---:|---:|---:|
| NDJSON | 119 ms（第一輪 171） | 1 | 63 ms | 387 MiB |
| JSON | 104 ms（第一輪 536） | 1 | 63 ms | 392 MiB |
| HAR | 158 ms（第一輪 162） | 1 | 62 ms | 415 MiB |
| bundle | 369 ms，**第一輪 50,993 ms** | 8 | 157 ms（第一輪 63） | 917 MiB |

- 原基準：三種事件格式都是主執行緒被佔住 92～98 s、窗口完全不重繪、主程序峰值 2.7～4.6 GB。**事件格式的這一項已改善**：窗口全程能重繪、主程序峰值不到 0.5 GB。
- 程序樹峰值（第一輪、有取樣器）：NDJSON 1,068 MiB、JSON 969 MiB、HAR 995 MiB、bundle 1,360 MiB；匯出前約 590 MiB。
- **bundle 的主程序停頓兩輪差很大（51 s 與 0.37 s）**，不能下結論；它仍在主程序上做事（#661／#695 已列）。
- 成品完整性：NDJSON 的行數 198,417 等於選取數 198,417；HAR 兩輪的 sha256 相同（`460322d7cdde…`，輸入固定、輸出決定性）。NDJSON／JSON 兩輪不同是因為每次啟動都會多寫幾列系統事件（198,399→198,417），不是不決定性。

## 4. 為什麼端到端變慢：預覽階段讀了 8 遍整個專案

預覽（resolve）要 100～270 s，比原基準的 27～29 s 慢。把 `buildExportPlan` 單獨拿出來量（`bench-export-plan.ts`，同一份 198k 專案，無 Electron）：137 s，**`iterateSnapshotEvents` 完整走訪 8 次**。

`src/core/export-planning.ts` 裡的 `selectedEvents` 是一個每次迭代都重新從資料庫讀整個快照的可迭代物件。`buildExportPlan` 先用一遍選出事件，之後 `countOutOfScopeHttpFlows`、`countReferencedAttachments`（此格式不支援附件時）、`countTruncatedOutputs`、`countPauseWindows`、`countCaptureGaps`、`countInterrupted`、`fingerprintSequence` 各走一遍；每遍都是 388 頁、每頁讀兩個層級各 513 列、轉成事件、再逐筆遮蔽。

- 單遍成本：只做分頁讀取約 12 s（`bench-snapshot-pages.ts`：388 頁、每頁 9～53 ms，**不隨深度增加**）；加上 `rowToEvent` 與 `redactEventForExport`（`getSanitizedFields` 每筆 `prepare`，剖面 24 s／13.5%）約 16～17 s。
- 剖面（`--cpu-prof`，178 s）：`queryTierPage` 自身 126 s（70.7%）、`getSanitizedFields` 24 s（13.5%）、`rowToEvent` 11 s（6.2%）。
- 再加上 execute 前的 `validate`（又一遍）與 execute 本身，所以合計超過 100 s 的整體時間大多是同一份資料被重讀。
- 這個重複讀取在原基準時就存在（原審計把「materialises the project several times」列為第 2 項熱點）。#683 把選取與寫檔移到 worker，所以畫面不再被卡住，但沒有減少遍數。本表 resolve 比原基準慢，**沒有**逐項歸因到某個 commit；兩次量測的條件也不同（負載、記憶體餘量、Defender 狀態），所以 27→104 s 不能全算成退化。

## 5. 未做與限制

- **沒有取消、專案切換、政策變更、失敗清理的驗證**（#660 清單的一項）。NOT RUN。
- 沒有檢查證據鏈在匯出前後不變（匯出本身唯讀，但沒有量這一項）。NOT RUN。
- bundle 沒有用獨立驗證器驗證：`tools/redlog-verify.py` 需要 Python `cryptography`，這台機器未安裝。只有 app 自己的 `check` 欄位。
- 沒有冷啟動（重開機後）、沒有基準版與候選版的並排比較（基準是 2026-11-01 的紀錄，不是同日重跑舊 commit）。
- 沒有打包安裝檔；`out/` 與安裝檔跑同樣的 JavaScript，ASAR 與簽章不在這些數字內。
- 單一環境、單日、每種匯出各 2 輪；變異大的項目（捲動 p95、bundle 停頓、27 s 開啟）不能由此排名。

## 6. 對 #660／#587 的結論（依數據）

1. **開啟**：暖狀態 3～4 s（原 29.8 s）；一次未解釋的 27 s，需要再在冷快取下觀察才能關閉這一項。
2. **匯出不再佔住主執行緒**（JSON／NDJSON／HAR，停頓 ≤0.2 s，記憶體峰值降到 0.4 GB 主程序、約 1 GB 程序樹）；bundle 尚未，且其兩輪停頓差異大。
3. **端到端變慢**：下一個改善目標應是預覽階段的 8 遍走訪（一遍就能算完所有計數與摘要），其次是 `getSanitizedFields` 的逐筆 `prepare`。這是 Spec／審查範圍內的變更（動到匯出的選取與摘要），開 PR 前要做獨立的對抗審查。
4. Timeline 捲動 p95 沒有改善，仍在 110～190 ms，屬於 #587 的渲染端工作。

## 7. 重現

量測腳本在 [`../2026-11-01/perf-audit-2026-11/`](../2026-11-01/perf-audit-2026-11/)：`measure-app.mjs create|project|export`、`seed-project.ts`、本次新增的 `bench-export-plan.ts`（預覽階段）與 `bench-snapshot-pages.ts`（逐頁成本）。

本次對 `measure-app.mjs` 的修改：專案列要雙擊才會開啟（原本單擊，已過期）；`export` 新增主程序最長停頓、視窗最長 frame 間隔、成品 sha256／NDJSON 行數，以及選用的程序樹記憶體取樣（`PERF_TREE=1`；預設關閉，因為取樣本身會拖慢匯出）。
