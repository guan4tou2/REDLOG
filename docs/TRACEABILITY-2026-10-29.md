# 規格與實作追溯表（2026-10-29，P1-6 第一批）

**基準：** `main` @ `55567a58`（v0.18.4），另含 `d1e6e363`／`cd0a8123`／`36287fa3`
**範圍：** P0 與 P1 項目；P2／P3 尚未建表

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
| P0-B | Spool／pause／project binding／gap | #291；Spec 064 CT-15／16 | `hooks/shell-common.sh` spool 區塊、`active-identity.json` 檢查 | `test/shell-spool-cap.test.ts`、`test/shell-spool-no-sidecar.test.ts` | 故障注入與跨專案驗收 | 部分實作／NOT RUN |
| P1-1a | 匯出格式的 PII 清洗能力必須逐格式宣告且可拒絕 | #436；Spec 064 C5 | `src/core/export-capabilities.ts:18–22`；拒絕點 `src/main/ipc/data-export.ts:69` | `test/export-plan-ipc.test.ts`（bundle／har 拒絕、json／ndjson／timeline 接受）；`test/operator-pii.test.ts` 只測替換函式 | 原生／安裝包驗收 | 實作存在／NOT RUN |
| P1-1b | Cast 只複製核准前綴，且不做內容裁切 | #436；Spec 064 C5 | `src/core/bundle-export.ts:438–441, 453` | 無 | 前綴長度與 manifest `attachments.casts` 一致性 | 實作存在／NOT RUN |
| P1-3a | 忽略憑證錯誤不得算作 CA 信任 | #289 | `src/core/http-verify.ts`；`HttpCaptureStep.tsx:253` 的 `trustVerified`，狀態列分 `proven`／`unproven` | `test/http-verification.test.ts:47`（邏輯）、`test/http-ca-trust-label.test.tsx`（標籤） | 驗證結果的持久化與失效判定（P1-3b） | 實作存在／NOT RUN |
| P1-3b | 驗證結果需持久化並綁定 client／endpoint／CA／routing | #289、#434 | 無持久化 | 無 | 7 狀態模型、跨重啟與跨專案失效判定 | 未實作／NOT RUN |
| P1-4 | DB 無法開啟時的呈現與安全失敗 | `UIUX-STANDARD.md` §12 2g | `src/main` 無 `SQLITE_BUSY`／`SQLITE_CORRUPT` 專門處理 | 無 | 開啟失敗的呈現路徑待調查 | 待調查／NOT RUN |
| P1-5a | 終端錄製徽章不得讓「錄 cast」被讀成「指令與輸出已保存」 | §12 2b | `TerminalView.tsx:258–268` | `test/terminal-cast-state.test.ts` | 文案語意真實性未驗 | 實作存在／NOT RUN |
| P1-5b | `⌘+`／`⌘−`／`⌘0` 調整終端字級 | §12 2b | `TerminalView.tsx:220–250` 綁鍵；`src/renderer/src/lib/terminalFont.ts` 為共用範圍 | `test/terminal-font-size.test.ts` | 原生鍵位驗收（鍵盤配置、與 OS 快捷鍵共存） | 實作存在／NOT RUN |
| P1-7 | 內容狀態為三軸，不得壓成單一值 | Spec 064 C3 §2 | `contracts/content-viewer.md` §2；`src/core/evidence-content.ts` | `test/evidence-content.test.ts` | Activity／I-O／AI／HTTP／Reader／Export 的跨面一致性 | 部分實作／NOT RUN |

## 已確認過期的現況宣告

這些說法曾被當作現況引用，實測不成立，後續不得再作為依據：

| 宣告 | 實測 | 依據 |
|---|---|---|
| 「scrubPii 開啟時全匯出路徑套用」 | 只有 JSON／NDJSON／Timeline 支援；Bundle、HAR 不支援 | `export-capabilities.ts:18–22` |
| 「Cast never trimmed」 | 不做內容裁切，但只複製核准的 `frozenBytes` 前綴 | `bundle-export.ts:438–441, 453` |
| 「HTTP 驗證只有一個成功狀態」 | v0.18.4 時邏輯層已分開、UI 層合併；現已拆成 `proven`／`unproven` | `HttpCaptureStep.tsx:145, 253` |
| 「2b per-pane 記錄 chip 未實作」 | 已實作 | `TerminalView.tsx:258–268` |

## 下一步

1. **P0-A 的 D1–D4／G1–G3** 在真機執行，回填 `ACCEPTANCE-326-345-2026-10-29.md`。
2. **P1-3b** 驗證結果的持久化與失效判定——這是 B2a 剩下的部分，UI 標籤已拆。
3. **P1-4** 需要先讀 `src/core/project-manager.ts` 與 DB 開啟路徑，再決定要不要畫面。
4. P2／P3 待 P1 的第一批證據出現後再建表。

已於本批完成：P1-1a 的拒絕測試、P1-3a 的標籤拆分、P1-5b 的鍵位實作。
