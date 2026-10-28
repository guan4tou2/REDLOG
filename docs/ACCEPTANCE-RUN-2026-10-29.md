# 自動化驗收執行記錄（2026-10-29）

**規格書：** `ISSUE-CONVERGENCE-2026-10-29.md` §9
**執行環境：** macOS 27.0.1 / arm64 / Node v22.22.2 / vitest 5.0.1
**Commit：** `e260c968`（工作區乾淨）
**安裝包：** 無。本輪全部是原始碼層級的單元與整合測試，**不構成任何安裝包驗收**。

## 這份記錄怎麼讀

`PASS` 表示該測試檔在 `e260c968` 上通過，且其測試名稱對應此列的契約。**這不是 ID 層級的
逐條對照**——一個檔案通過不等於它斷言了規格書裡的每一個子情境。逐條對照屬於 R10。

`BLOCKED` 表示在本機 sandbox 無法完成，原因已寫明；不是產品缺陷。

`NOT RUN` 表示需要真實來源、真實客戶端或安裝包，本機不具備。

## 摘要

| 批次 | 檔案 | 測試 | 結果 |
|---|---|---|---|
| REL-1 | `spool-replay`、`relay-contract`、`relay-late-output`、`pause-gate` | 27 | PASS |
| REL-2 | `capture-unattributed-spool`、`clear-unattributed-spool`、`powershell-spool-needs-project`、`shell-spool-no-sidecar` | 20 | 19 PASS、1 BLOCKED |
| STR | `cast-slice`、`cast-index`、`truncation`、`terminal-cast-state` | 43 | PASS |
| EXP | `export-plan`、`export-plan-ipc`、`export-attachment-freeze`、`export-completeness-counts` | 53 | PASS |
| BUNDLE | `bundle-export`、`bundle-requires`、`bundle-two-tier`、`bundle-amendment` | 33 | PASS |
| HTTP | `http-body-store`、`http-body-search`、`http-capture-state`、`browser-panel-ca-untrust` | 43 | PASS |

**合計：24 個檔案、219 個測試、218 PASS、1 BLOCKED、0 FAIL。**

## BLOCKED

| 測試 | 原因 |
|---|---|
| `shell-spool-no-sidecar.test.ts` › still honours the spool cap | 150s timeout。該測試建立 5000 個檔案；本機 sandbox 建檔吞吐約 50ms/檔（實測 100 檔 5s、1000 檔 51s、2000 檔被 SIGTERM），因此必然超時。需在一般 Terminal 執行。同一原因也讓 `shell-spool-cap.test.ts` 無法在本機跑。 |

## 對應規格書條目

### REL（#291）

| 條目 | 自動化證據 | 結果 |
|---|---|---|
| REL-T02 Spool 重送 | `spool-replay` | PASS |
| REL-T03 重送不重複 | `spool-replay` | PASS |
| REL-T04 跨專案不誤歸 | `relay-contract`（命名空間分離） | PASS |
| REL-T05 停止後不保存新內容 | `pause-gate` | PASS |
| REL-T08 無身分 Spool 不自動歸屬 | `capture-unattributed-spool`、`clear-unattributed-spool`、`powershell-spool-needs-project` | PASS |
| REL-002 Spool 容量上限 | `shell-spool-no-sidecar`、`shell-spool-cap` | **BLOCKED**（環境） |
| REL-T01 API 失敗仍可繼續 | `relay-late-output` | PASS |
| REL-T06 磁碟配額不足 | 無 | NOT RUN |
| REL-T07 強制終止後重開 | 無 | NOT RUN |
| REL-T09 閒置來源不誤判故障 | 無 | NOT RUN |
| REL-T10 匯出部分保存的 Session | `export-completeness-counts` | PASS（檔案層級） |

### STR（#290）

| 條目 | 自動化證據 | 結果 |
|---|---|---|
| STR-T01 長時間 PTY 結束前可讀 | `cast-slice`、`cast-index` | PASS（檔案層級） |
| STR-T04 Binary 不轉文字 | `truncation` | PASS |
| STR-T05 中途 Kill 後已落盤可讀 | `cast-index` | PASS（檔案層級） |
| STR-T08 匯出部分錄影標 Partial | `terminal-cast-state`、`export-completeness-counts` | PASS（檔案層級） |
| STR-T02 SSE、STR-T03 WebSocket | 無 | NOT RUN（需真實客戶端） |
| STR-T06 App 強制結束、STR-T07 大量資料 | 無 | NOT RUN |

### EXP（#436）

| 條目 | 自動化證據 | 結果 |
|---|---|---|
| EXP-T01 超過一頁的完整集合 | `export-plan-ipc`（1005 列） | PASS |
| EXP-T02 預覽後新增事件不加入 | `export-attachment-freeze`、`export-plan-ipc` | PASS |
| EXP-T03 預覽後附件改動被拒 | `export-attachment-freeze` | PASS |
| EXP-T05 排除附件不進成品 | `bundle-export`、`export-plan-ipc` | PASS |
| EXP-T06 跨目標 PTY 明示範圍 | `bundle-export`（casts targets） | PASS（檔案層級） |
| EXP-T08 Verifier 拒絕被改的成品 | `bundle-requires`、`bundle-two-tier` | PASS（檔案層級） |
| EXP-T04 空 Scope | 無 | NOT RUN |
| EXP-T07 成功後重啟可找回 | 無 | NOT RUN |
| EXP-T09 Windows 匯出 | 無 | NOT RUN（需安裝包） |
| EXP-T10 Linux／macOS 成品一致 | 無 | NOT RUN（需安裝包） |

### HTTP（#289、#293）

| 條目 | 自動化證據 | 結果 |
|---|---|---|
| HTTP-T03 CA 未信任不顯示已解密 | `browser-panel-ca-untrust`、`http-ca-trust-label`、`http-verification` | PASS |
| HTTP-T05 Port 衝突 | `http-capture-state` | PASS（檔案層級） |
| HTTP-T06 程序死亡不再 Running | `http-capture-state` | PASS（檔案層級） |
| HTTP-T09 未經代理不宣稱擷取 | `http-capture-state` | PASS（檔案層級） |
| HTTP-T01 缺 mitmproxy 的處理入口 | `http-autostart` | PASS |
| HTTP-T02／T04 真實 HTTP／HTTPS 交換 | 無 | NOT RUN（需真實客戶端） |
| HTTP-T07 重啟後恢復 | 無 | NOT RUN（需安裝包） |
| HTTP-T08 切換專案不誤歸 | 無 | NOT RUN |
| HTTP-T10 既有 Proxy／NO_PROXY | 無 | NOT RUN |

## 本輪沒有回答的問題

規格書 §12 的五個 Gate 一個都還沒通過。這份記錄只說明：**底層契約的單元與整合層比
規格書假設的完整**——219 個測試在跑，218 個綠。缺的不是測試數量，是原生環境。

依 Gate 列出仍缺的最小集合：

| Gate | 仍缺 |
|---|---|
| A 擷取可信 | #326 D1–D4、#345 G1–G3、REL-T06/T07/T09 |
| B 接入可信 | HTTP-T02/T04/T07/T08/T10、#434 三 Shell 矩陣、#226 安裝包 |
| C 證據交付可信 | EXP-T04/T07/T09/T10、STR-T02/T03 |
| D 操作流程可信 | Spec 062 M01–M28、Spec 064 UX-01–UX-19（全 NOT RUN） |
| E 文件與發行一致 | `test-coverage-matrix.md` 仍以 `d2917021` 為基準 |

## 建議的下一步

1. 兩個 spool cap 測試移到一般 Terminal 執行，補上 REL-002 的結果。
2. Gate D 的 M01–M28 與 UX-01–UX-19 是最大的一塊，且完全不依賴程式碼改動，只依賴排時間。
3. `test-coverage-matrix.md` 的基準更新到 `e260c968`，並把本表的 PASS 對應進去。
