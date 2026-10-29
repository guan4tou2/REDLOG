# 最新更新審查核對與修復（2026-10-29）

程式碼核對基準：`2dd454651be91e23436e15bafb2224f7339424b3`。
本次修復與測試對象：該提交上的未提交工作區變更；不是既有 Release 成品。
歷史驗收的 commit 與安裝包基準保持原值，不以本次檢查覆蓋。

## 報告核對

| 報告內容 | 核對結果 |
| --- | --- |
| main 為 `2dd45465`；`v0.18.4` 是 prerelease、正式版是 `v0.18.3` | GitHub API 核對符合 |
| CI run `40820908802` 四項成功 | 符合；精確測試 commit 是 `280959c5`，不是 `2dd45465` |
| 24 檔／219 PASS | 符合既有驗收紀錄的選定批次，不是全產品情境或全 suite 的總數 |
| `startProject` 在 DB 前設定 active 與 spool 身分 | 符合；也會在設定載入／寫入前關閉舊專案，缺少回滾。Picker 的 IPC 拒絕不會直接呼叫成功回呼，但 `project:active` 與重載後畫面會讀到錯誤狀態 |
| `loadConfig()` 錯誤也需要處理 | 需補充：目前讀取／YAML 解析失敗會回傳預設值，不直接拋錯；設定寫入及後續使用無效設定仍可能拋錯。本次不改既有 fallback 契約 |
| HTTP 卡片分開捕獲與 CA 信任，但父層仍收到 capture boolean | 符合；`coreCaptureReady` 既有契約是兩種擷取已收到證據，不代表所有 client 的 CA trust。保留契約並加上父子整合測試 |
| Terminal 字級監聽 window，缺少焦點判斷 | 符合；僅在 TerminalView 掛載時有效，焦點／原生鍵位驗收仍未執行 |
| #326 的 503 先於 token 驗證，hook 保留 native 目錄 | 符合 `api-server.ts` 與 `shell-common.sh`；D4 限制仍存在 |
| #326／#345 D1–D4、G1–G3 尚未真機驗收 | 文件仍為 NOT RUN；本次不冒充 Windows／WSL／Git Bash 驗收 |
| ExportPlan 格式能力測試、Terminal 尺寸限制與搜尋索引更新 | 對應實作與測試存在；不等於安裝包或跨平台驗收完成 |
| 追溯表與 Spec 064 仍有歷史基準 | 符合；應新增本次證據，而非把舊測試的基準改成最新提交 |

外部來源：[main](https://github.com/guan4tou2/REDLOG/tree/main)、[Releases](https://github.com/guan4tou2/REDLOG/releases)、[CI run](https://github.com/guan4tou2/REDLOG/actions/runs/40820908802)。

## 本次修復邊界

- 先準備設定；此階段失敗保留既有有效專案。
- DB 初始化成功後才設定 active；同步資源初始化全部成功後才發布 spool identity。
- 初始化失敗時執行所有清理步驟，一個清理錯誤不阻斷後續步驟；原始初始化錯誤回到 IPC caller。
- API project binding、spool 身分、專案身分、DB／唯讀 DB 與待排程 recompute 均撤銷；背景 backfill 與 HTTP auto-start 延後至同步初始化完成後排程。
- 命令面板切換失敗時重新確認 active；若舊專案已關閉，回到 ProjectPicker 並保留錯誤訊息。
- 這是執行期資源與 binding 回滾，不是檔案系統或 DB 的全域交易；不刪除、還原或重寫已追加的證據，也不承諾復活已關閉的舊專案。

## 驗證

- `test/first-run-record-terminal.test.tsx`：父層 readiness、CA proven／unproven、重新驗證撤銷 readiness。
- `test/command-palette.test.tsx`：切換失敗後，依 main 的 active 狀態保留工作區或返回 picker。
- `test/readonly-db.test.ts`：關閉後禁止重開舊 DB；可寫 handle 關閉拋錯仍撤銷所有 handle 並關閉唯讀 handle。
- `e2e/project-open-rollback.spec.ts`：設定寫入、DB constructor、DB pragma、來源設定四種失敗；檢查 IPC active／API 503／identity、原始檔與既有事件不變、跨專案 spool 延遲重播、重試只入庫一次、chain 完整性。

### 執行結果

環境：macOS arm64，Node `26.13.0`；來源碼建置的 Electron，全部使用隔離的臨時 HOME。

| 檢查 | 結果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run verify:specs` | PASS |
| `npm run verify:architecture` | PASS |
| `npm run verify:i18n` | PASS；本次沒有刪除 UI 字串 |
| `npm test`（最終完整執行，2026-10-29 17:03:19 Asia/Taipei 起） | 440 檔 PASS、6 檔 SKIP；4435 PASS、31 SKIP、0 FAIL；122.60 秒 |
| `npm run build` | PASS |
| `e2e/project-open-rollback.spec.ts` | 4 PASS；6.3 秒 |
| `e2e/project-flow.spec.ts` | 3 PASS |
| `e2e/first-run.spec.ts`、`e2e/terminal-session-rotation.spec.ts` | 14 PASS；16.4 秒 |

共 21 項 Electron 使用流程通過。最終執行 log：
`/private/tmp/redlog-final-all-tests.log`、`/private/tmp/redlog-rollback-e2e-final.log`、
`/private/tmp/redlog-rollback-e2e.log`（其中 project-flow 的 3 項通過；同輪 pragma 故障 fixture 曾被 SQLite WAL 恢復，修正 fixture 後四項回滾均通過）、
`/private/tmp/redlog-neighbor-e2e.log`。

過程中的非最終結果：受限環境的完整測試曾停滯；改用一般本機權限後，執行期間 Node 從 `26.12.1` 更新，該輪以子程序 `ENOTCONN` 終止。更新後完整測試找到一項依賴舊呼叫形式的 `update-status` 順序斷言，已更新；上表是修正後完整重跑的結果。未把這些中斷或失敗記成 PASS。

Windows／WSL／Git Bash、安裝包、磁碟滿與程序中斷完整矩陣仍 NOT RUN。


## UIUX v3.2 後續收斂

以上保留此輪最初核對時的證據。後續 UIUX、HTTP 歷史、Reader、scope、逐格式交付與效能修正的最新結果見 [完整對帳](UIUX-COMPLETION-2026-10-29.md)：完整單元 4461 PASS／31 SKIP；受影響 source E2E 34／34，Mac 安裝副本 smoke 1 PASS。候選 `2dd45465+local` 的 DMG 與來源 manifest 位於本機 `dist/uiux-20261029/`；不是歷史 DMG 或正式發布。剩餘原生與使用者驗收由 [#457](https://github.com/guan4tou2/REDLOG/issues/457) 追蹤。
