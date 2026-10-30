# Verification

**Status**: In progress; not Verified.

RED: `/private/tmp/redlog-stream-red.log`: 2 expected failures (capacity stops append; second cast part loses terminal/target attribution). Small Scope/Target defects: `/private/tmp/redlog-scope-target-green.log`, 16 passing tests across 3 files. Further implementation results recorded as executed, not assumed.

Workflow: Specify, question-free Clarify, Checklist, Plan and Analyze recorded here and adjacent artifacts; no extension hooks configured. Converge and final gates pending. Existing feature 062 remains Draft; no unrelated task is promoted.

Platform inventory 2026-10-26: macOS host available; no pwsh; VMware reports 0 running VMs. #432 open, mergeable=false at 53812e84; reviewed only, not merged. Native Windows/WSL/Kali pending.

## Checkpoint before UI specification work

The user subsequently requested specification-only UI consolidation (Spec 064).
Implementation changes for 063 remain uncommitted in the existing isolated tree.
Targeted runs: 218 tests / 19 files (`redlog-current-regression.log`), 111 tests /
9 files (`redlog-stream-complete-unit.log`), and 75 tests / 5 files after the
pause-boundary fix (`redlog-stream-pause-green.log`). These overlap, not totals.
Typecheck passed after that fix (`redlog-stream-type-pause.log`).

Mac candidate: packaged resources passed and 13 Electron journeys passed
(`redlog-stream-e2e.log`), including actual cross-part replay and exported file
comparison. This package predates the later delayed-pause boundary fix; do NOT
call it final acceptance of the current working tree. New-build verification
of that fix, HTTP/SSE/WS, and native Windows/WSL/Kali remain open.

#432's WSL stale-token tests failed before and passed after the focused hook
transplant (9 tests / 2 files with redlog-run, `redlog-432-green.log`); no PR merge.
VMware inventory points at a removed isolated Kali copy; no guest ran. No pwsh
was available. No Windows/WSL/Kali native or new Release claim is made.


## 2026-10-30 指定提交候選與可靠性回歸

來源 `9e648f7d`，打包時 tracked working tree 無變更，只有無關 `.workbuddy-ai/` 未追蹤目錄。依既有 build 規則顯示 `9e648f7d+local`，不移除標記冒稱乾淨 build。

- Apple Silicon Mac DMG：`dist/candidate-9e648f7d/RedLog-0.18.4-arm64.dmg`。
- DMG SHA-256：`8a77a5e9cf6d3d878341bc0f3437c86fb8883467fab0444b3ff1cf6526ce2af9`。
- app.asar SHA-256：`f627b43c228bc54f271dec52aba70c6be72aa6ceddb5750ab347200ecffa7066`。
- 安裝副本 `packaged-smoke` 1 PASS（15.5 秒）；真實錄製、HTTPS、匯出、離線 verifier、重啟；同一 report validator 確認零 skipped／not-exercised。以精確 `+local` 預期值執行既有 smoke，沒有發布 release。
- terminal-recording、relay-late-output、spool-replay、shell-spool-cap、shell-spool-no-sidecar、mitmproxy-addon-hooks 合計 6 檔 29 PASS。涵蓋分段、部分寫入失敗、pause 拒絕與不同專案拒絕重送；不是實體磁碟滿或全來源故障驗收。

當時的 #290 保存盤點（以下已由本頁後續驗收部分取代）：HTTP body 於 `hooks/mitmproxy-addon.py` 的 response hook 取得，不能據此宣稱無限 SSE 在 response 結束前已持續落盤；WebSocket 是 per-message hook，與 SSE 不同。持續 SSE、來源途中中斷與實體 ENOSPC 的完整產品修復／驗收仍未完成；T005／T007 不勾。Windows／WSL／Git Bash／Kali 及五位使用者仍缺環境，沿 #457。

## 2026-10-30：HTTP／SSE／WebSocket 與保存故障收尾

來源為 `main@9e648f7d` 加本輪未提交修正；build ID 同為 `9e648f7d+local`，**不能與上方舊候選混用**。產品 diff SHA-256：`54f03664cab52a48d55192205f04c17ffe3cbddc51a10eff34de4b329a19a0ba`。逐檔來源 hash 與測試報告保存在本機候選目錄 `dist/candidate-recording-20261030-final/source-manifest.json`。

| 成品／檢查 | 結果 |
|---|---|
| Apple Silicon Mac DMG | `dist/candidate-recording-20261030-final/RedLog-0.18.4-arm64.dmg`，SHA-256 `85608c424ef6a98dc0fe1a140847a36a9adf973bc6bd420a76412a69391c72bc` |
| app.asar | SHA-256 `1d91d43edc420b2c3c4495bd959e1e4beb9b2c799d8e1e844896b836cd720e9c`；建置、唯讀 DMG 與安裝副本一致 |
| 簽章／資源 | `codesign --verify --deep --strict` 與 packaged resource contract PASS；ad-hoc 簽署，未 notarize、未發布 release |
| 依序完整 gate | typecheck → verify:specs → verify:architecture → verify:i18n → npm test PASS；446 files PASS／6 SKIP，4,480 tests PASS／31 SKIP／0 FAIL |
| 安裝副本驗收 | 5 PASS／0 SKIP／0 FAIL，25.6 秒；報告 validator 確認沒有 not-exercised 步驟 |

### 實際可觀察結果

- [SSE／WS E2E](../../e2e/sse-preservation.spec.ts)：真實 mitmdump 與 App 在 SSE 尚未 EOF 時已有 logged Event；原始 segments 可從實際 HAR 讀回。Pause 期間內容仍到達網路 client，但不保存、不於 Resume 後補入；seq 留缺口。另一條 SSE 中斷如實標記 interrupted。雙向 WebSocket 的文字／binary 在 close 前保存，HAR binary bytes 一致，強制斷線有終止狀態。
- [真實 ENOSPC E2E](../../e2e/disk-full-preservation.spec.ts)：在有容量防護的 64 MiB 隔離 HFS+ image 內放置專案，實際寫滿該 volume。修正前重現「失敗寫入留下 hash 命名半檔」；修正後 POST 500、不發布正式 body 或留下 temp，釋放空間重試 201、原件 bytes 不變。沒有填滿主機磁碟。
- [一般安裝 smoke](../../e2e/packaged-smoke.spec.ts)：錄製、HTTPS、匯出、離線 verifier 與重啟通過。
- [Mac 手動升級](../061-capture-safe-updates/verification.md)：官方 0.18.3 → 此候選的實際替換、舊 Event IDs 讀回與升級後 HTTP 錄製通過。

### 修正與邊界

Producer 固定 flow 的 project identity、傳送時 port/token 與觀察時間；4 個 worker／64 admitted events，不再每個 segment 無界建立 thread。明確拒絕不重送；未確認 delivery 的 spool 只存 project-bound capture-gap metadata，不存 URL／headers／body，避免暫停時 transport failure 落下被拒原文。代價是無法從此 spool 復原失敗原文；`capture_delivery: unknown` 不冒充零損失。細節見 [event schema](../../docs/event-schema.md)。

保存的 SSE bytes 不改寫壓縮／UTF-8；HTTP 查詢配對不被大量 chunks 擠出，核准匯出只帶 snapshot 內 companions。HAR 保留原始 SSE／WS segments，已知裁切或中斷與未知完整性不冒充完整 response。Body 先寫 temp 再發布，既存 hash 檔必須核對內容，部分寫入不能被下次重試當成成功。

上述完成 T005／T006 的本機子項，並非整份 063 完成：多小時持續運行、mitmproxy 自身 WS history 的記憶體上限、全來源／跨平台故障矩陣與原生 Windows／WSL／Git Bash／Kali 仍未驗證；五位使用者量測也缺環境，沿 #457。保留原任務完整 gate 與 Draft 狀態。
