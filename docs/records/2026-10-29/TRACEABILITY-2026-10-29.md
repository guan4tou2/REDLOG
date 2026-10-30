# 規格與實作追溯表（2026-10-29，P1-6 第一批）

**基準：** `main` @ `55567a58`（v0.18.4），另含 `d1e6e363`／`cd0a8123`／`36287fa3`
**範圍：** P0 與 P1 項目；P2／P3 尚未建表

**後續核對與修復：** `2dd45465` 上的未提交工作區變更，見 [本次核對紀錄](REVIEW-FOLLOWUP-2026-10-29.md)。本次結果不覆蓋上述歷史測試基準。

規則（提案排程原則 4）：**「應該做什麼」由已核准的 contract／Spec 決定；「實際做到
什麼」由指定 commit 的程式碼與驗收證據決定。** 兩套不互換。

狀態用語：

| 欄位 | 值 |
|---|---|
| 實作狀態 | 實作存在／部分實作／未實作／待調查 |
| 驗收狀態 | PASS／FAIL／NOT RUN／BLOCKED／UNSUPPORTED／NOT APPLICABLE |

單元測試通過不等於驗收通過；驗收需要對應版本、平台與安裝包。

## 追溯表

| ID | 需求 | 權威契約 | 現有程式碼 | 測試證據 | 尚缺 | 實作／驗收 |
|---|---|---|---|---|---|---|
| P0-A1 | WSL 舊目錄不得遮蔽 Windows profile | #326；`docs/domain/SPEC-capture-source-lifecycle.md` | `hooks/shell-common.sh:18–53`（`/api/whoami` 探測） | `test/shell-wsl-directory.test.ts`（`down`／`live`／`stale-token`） | 真實 WSL、mirrored networking；D1–D4 未執行 | 實作存在／NOT RUN |
| P0-A2 | 事件內容不得經由路徑交給 curl | #345 | `hooks/shell-common.sh:399–400`（`--data-binary @-`） | `test/hook-payload-stdin.test.ts`（`d1e6e363` 新增） | Windows Git Bash 實機；G1–G3 未執行 | 實作存在／NOT RUN |
| P0-B | Spool／pause／project binding／gap | #291；Spec 064 CT-15／16 | spool identity／cap、pause gate、project rollback | `shell-spool-cap`、`shell-spool-no-sidecar`；`recording-pause`、`project-open-rollback`、`terminal-session-rotation` E2E | 真實 ENOSPC／程序中斷與其他平台 #457 | 部分驗收／Mac source PASS，完整 CT NOT RUN |
| P1-1a | 逐格式 PII 能力宣告與拒絕 | #436；Spec 064 C5 | `export-capabilities.ts`；`data-export.ts` | `export-plan-ipc`：bundle／har 拒絕、json／ndjson／timeline 實際成品 × 開關 | 跨平台成品矩陣 #457；非 secret detector | 實作存在／本機 PASS |
| P1-1b | Cast 只複製核准前綴，不做內容裁切 | #436；Spec 064 C5 | `bundle-export.ts`、`export-attachment-freeze.ts` | `export-plan-ipc` 實際 cast 原始 byte 前綴／PII 保留；`export-attachment-freeze`、`bundle-export` hash／manifest | 跨平台原生成品 #457 | 實作存在／本機 PASS |
| P1-3a | 忽略憑證錯誤不得算作 CA 信任 | #289 | `http-verify.ts`、`HttpCaptureStep.tsx`、FirstRun capture readiness | `http-verification`、`http-ca-trust-label`、`first-run-record-terminal`；真實 HTTPS E2E | 原生 client CA trust 與其他平台 #457 | 實作存在／本機 PASS |
| P1-3b | 驗證結果需持久化並綁定 client／endpoint／CA／routing | #289、#434 | `http-verification-evidence.ts`、`http-verification-history.ts`、main status wrapper | `http-verification-history`；`uiux-convergence` 真實 HTTPS／restart／project／routing | 原生 client identity／CA trust 不憑 UA 推定；其他平台待 #457 | 實作存在／macOS source PASS |
| P1-4 | DB 無法開啟時的呈現與安全失敗 | `UIUX-STANDARD.md` §12 2g | `startProject` 設定預備、DB 初始化與資源啟動失敗回滾；`stopProject` 完整清理；命令面板反映 main 的 active 狀態 | `e2e/project-open-rollback.spec.ts` 4 PASS（設定寫入、DB open／pragma、來源設定；含跨專案 spool、既有事件與原始檔保留）；`test/readonly-db.test.ts`、`test/command-palette.test.tsx` | 安裝包／Windows 故障驗收、真實磁碟滿與程序中斷 | 實作存在／原始碼 macOS E2E PASS；安裝包 NOT RUN |
| P1-5a | Cast badge 不等於 shell command／output proof | §12 2b | `TerminalView.tsx`；獨立 capture source／cast 狀態 | `terminal-cast-state`；`terminal-session-rotation` E2E | 真人理解與其他平台 #457 | 實作存在／本機 PASS，真人 NOT RUN |
| P1-5b | 終端字級鍵位與輸入焦點／Electron zoom 分離 | §12 2b | `TerminalView.tsx`、`terminalFont.ts` | `terminal-font-size`；`uiux-convergence` 原生鍵盤 | Windows／其他鍵盤配置 #457 | 實作存在／Mac PASS |
| P1-7 | 內容 capture／availability／read window 三軸分離 | Spec 064 C3 §2 | `content-contract.ts`、`evidence-content.ts`；HTTP／Shell 共用 Reader | `evidence-content` 三類 17 MiB、`http-detail-tabs`、`late-output-detail`、`transcript-completeness-ui`、export counts | 完整跨平台 CT-11／12 #457；不把 hasMore 當 capture loss | 實作存在／本機 PASS |

## 已確認過期的現況宣告

這些說法曾被當作現況引用，實測不成立，後續不得再作為依據：

| 宣告 | 實測 | 依據 |
|---|---|---|
| 「scrubPii 開啟時全匯出路徑套用」 | 只有 JSON／NDJSON／Timeline 支援；Bundle、HAR 不支援 | `export-capabilities.ts:18–22` |
| 「Cast never trimmed」 | 不做內容裁切，但只複製核准的 `frozenBytes` 前綴 | `bundle-export.ts:438–441, 453` |
| 「HTTP 驗證只有一個成功狀態」 | v0.18.4 時邏輯層已分開、UI 層合併；現已拆成 `proven`／`unproven` | `HttpCaptureStep.tsx:145, 253` |
| 「2b per-pane 記錄 chip 未實作」 | 已實作 | `TerminalView.tsx:258–268` |

## 本次收斂與待驗收

本表已按本次實作更新；歷史核對依據與尚未取得的原生證據分開記錄。所有 P0–P3 的最新逐項對帳、實際匯出政策矩陣與性能量測統一見 [UIUX 完成紀錄](UIUX-COMPLETION-2026-10-29.md)。

- P1-1 增加三格式 × PII 開關實際成品驗證、附件 raw boundary 與範圍外 exchanges 計數。
- P1-7／P3 Reader：HTTP／Shell 改走既有版本化 content API；17 MiB Shell／AI／HTTP 資料測有界搜尋，避免把讀取分頁當作 capture partial。
- P2：HTTP 歷史狀態、Transcript 有界預覽、HTTP scope、完整違規詳情與顯式候選規則、終端焦點快捷鍵已有實作及回歸。
- P3：回放只標示已知 anchor；設定徽章／額外關聯圖經必要性檢查未新增；不以行數為由拆分。
- Windows／WSL／Git Bash／Linux、真實磁碟滿／中斷、完整真人 UX 與五位使用者量測統一追蹤 [#457](https://github.com/guan4tou2/REDLOG/issues/457)。Spec 064 保持 Draft。
