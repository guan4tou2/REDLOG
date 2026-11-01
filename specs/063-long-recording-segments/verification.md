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

## 2026-10-31：#290 長時間 soak（SSE／WS 兩小時、PTY 一小時）

工具與來源盤點見 [inventory.md](inventory.md)。以下兩個 soak 都是 opt-in 的 Playwright spec，使用本機測試服務，記憶體預算在執行前由環境變數固定（預設各 64 MiB，從前十分之一時間後的 warm-up 起算）；超過就失敗，不交由讀者判斷。逐分鐘樣本另存 `.samples.jsonl`。

### SSE／雙向 WS：[stream-soak.spec.ts](../../e2e/stream-soak.spec.ts)，120 分鐘，PASS

| 項目 | 值 |
|---|---|
| OS／Node | Windows 11 10.0.26300 x64／v22.23.1；未打包（`out/`），非 installer |
| mitmdump | 12.2.3（Python 3.12.13，OpenSSL 4.0.1） |
| commit／addon | `5dc69e6b`（含 #479 有界 history 與 #481 TCP 結束），tree 乾淨；addon SHA-256 `ad77051d…` |
| 起迄 | 2026-10-31 11:32:16Z → 13:33:58Z |
| 形狀 | SSE 每秒一則（512 B pad）；WS 伺服器每秒推 4 KiB binary，client 每 2 秒送中文文字、每 5 則加一個 binary |
| 一次性形狀 | 16 MiB body 存 10,485,760 B 並標 truncated；慢 response（20 段）完成後保存；`/disconnect` 記一筆 error |
| App RSS（所有 Electron process） | warm 528.9 → 末 521.8 MiB（−7.1），區間 496–560 |
| mitmdump RSS | warm 109.7 → 末 72.4 MiB（−37.3），區間 72–116 |
| 硬殺 mitmdump 後穩定值 | SSE 7,017 chunks、WS 15,469 messages；兩者 `completion-unknown`，不冒充結束 |
| App 重啟讀回 | 同為 7,017／15,469；SSE seq 無缺口、無重複 |
| 匯出 HAR | SSE 4,129,692 B，與 client 收到的 4,129,103 B 在共同長度內逐位相同（HAR 多 589 B，約一則 event 的長度，應是 client 計數之後才到的最後一則）；WS 15,469 則 |

對照（5 分鐘、每 100 ms 推 64 KiB WS，同一 spec）：`main` 的 addon 使 mitmdump 由 129.8 增至 305.0 MiB（+175.2，線性上升），有界 history 版本 110.1 → 110.9 MiB（+0.8）。兩小時那次的負載較輕，用來量長時間穩定性，不用來證明有界；有界的證據是這組對照與 #479 的單元測試。

### PTY：[terminal-soak.spec.ts](../../e2e/terminal-soak.spec.ts)，60 分鐘，資料 PASS、記憶體量法修正

WSL2 kali（Linux 6.18.54.1）、Node v24.15.0、xvfb、zsh；commit `894c7a5b`（本 spec 在移到新 main 之前的本機 commit；產品碼為 `main@5e2533b8`，spec 內容除下述量法修正外相同），tree 乾淨。內建終端每 2 秒印 20 行帶序號的輸出，視窗每 15 秒在兩種大小間切換，最後 `exit`，從磁碟讀回 cast。

- 1,792 個指令、35,840 行：讀回 35,840 行，全部出現一次且依序，無缺、無重。
- 239 次 resize：cast 有 239 個 `r` frame。
- cast 5,029,600 B，單一 part；bytes 與 SHA-256 均等於 `session_end` 宣稱值。
- 1,792 筆 `command_end`；chain verify 通過（3,595 筆 event）。
- 記憶體：session 期間 App RSS 由 752（第 6 分鐘）緩升至 803 MiB（第 59 分鐘），約 +51 MiB、每分鐘約 1 MiB，未見平台。該次以 `exit` 後、spec 自己三次讀入全部 shell event 之後的 961 MiB 判定（+208.9）而失敗；那是檢查本身的花費，已改為在 session 結束、讀回前判定，讀回後的值另列。

修正後重跑（本機 commit `5558f3ff`，產品碼 `main@5e2533b8`，spec 與本 PR 相同；2026-10-31 14:10:15Z → 15:10:21Z），**PASS**：同樣 1,792 指令／35,840 行全數依序、無重；239／239 resize frame；cast 5,029,868 B 與 `session_end` 的 bytes／SHA-256 一致；1,792 筆 `command_end`；chain verify 通過。App RSS warm 753.7 → session 結束 803.4 MiB（+49.6，預算 64 內），讀回後 948.4 MiB。

**但曲線沒有平台**：兩次 60 分鐘都是約每分鐘 +1 MiB 的穩定上升（第 6 分鐘 754 → 第 59 分鐘 803）。照此斜率，約 70 分鐘會超過 64 MiB 預算；增長來源（renderer 的 xterm scrollback、Timeline 的 live event 或其他）未查。這是通過 60 分鐘的預算，不是有界的證明。

前兩次 60／30 分鐘 PTY 執行在第 13／2 分鐘中止，原因是同機另一工作階段對 WSL 執行 `wsl --shutdown`（模式切換驗收），不是 App 行為；同一時段 Windows 上 WSL 驅動的 zsh 單元測試也因此失敗，事後重跑通過。

### 仍未完成

- Pause／Resume、App 重啟（未殺 producer）、高負載、隔離 volume 容量逼近上限在長時間下的組合；本輪只做 producer 硬殺與 App 重啟。
- mitmdump 硬殺時未送出的已排隊 event 仍會遺失，無記錄（#291）。
- PTY 的 App 記憶體每分鐘約 +1 MiB、未見平台，原因未查；兩小時以上 PTY 未跑，照斜率會超過 64 MiB 預算。
- 原生 Windows PTY（PowerShell）、macOS、installer 版本均未跑此 soak。CI 的 e2e 使用 mitmproxy 11.0.2，本機為 12.2.3。

T005 仍不勾。
