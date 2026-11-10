# macOS 測試整理與未完成驗收

日期：2026-11-09。產品基準：main `c614cbf3e273760283699cbf53078c94901b8ca6`。
環境：macOS 27.0.1（26A434）arm64、Node v26.13.0、Electron 44.4.1。
本輪沒有修改產品或測試判斷，只整理文件並補跑既有插件／來源流程。
文件候選重跑四個前置 gates、16 個 design palette／token 測試及 11 份文件的本機連結檢查，均通過；完整 5932 項結果沿用同一產品基準，不為文件修改重跑整套 shell 基準。

## 執行結果與界線

| 層級 | 結果 | 可以證明／不能推論 |
| --- | --- | --- |
| main 本機 ordered gates | typecheck、spec、architecture、i18n、unit、build 通過 | architecture 是 export 可達性，不是完整模組重構 |
| macOS 完整 unit | **5932 passed／41 skipped**，549 files passed／8 skipped | 涵蓋 DB、IPC、renderer 及真實 shell 子程序；skip 原因另列，不計通過 |
| macOS 主要 Electron 選取 | **110 passed** | 正式建置／隔離 home 的跨層流程；seed、mock IPC、合成來源只證明其覆蓋邊界 |
| 本輪插件／來源補驗 | **8 passed（19.7s）**，沒有 retry／skip | 單欄列表／詳情、搜尋／需處理、報告、來源錯誤／重試、授權及雙語／窄窗；不是更新／中斷全矩陣 |
| main 遠端 CI | [run 42573715951](https://github.com/guan4tou2/REDLOG/actions/runs/42573715951) **success** | Windows／macOS／Ubuntu unit 與 Linux Electron 3 shards 全部成功；不是所有平台 GUI／安裝包驗收 |
| macOS 全新 profile 啟動 | 三次可操作專案選擇頁 1640／804／679 ms，中位數 804 ms | 同機全新 home 啟動；不是系統 cold boot 或大型專案數據 |

110 案選取為 `app-shell`、`cast-content-reader`、`export-preview`、
`timeline-track`、`network-state-recovery`、`settings-search-closeout`、
`first-run`、`evidence-views`、`external-session`、`official-agent-capture`。
本輪 8 案為 `plugin-explore`、`capture-settings-interaction`，與前組沒有重複 spec。
兩組共 118 個來源碼 Electron 案例，不將 3 個 CI shards 再加進同一個通過總數。

## 41 項跳過的來源

| 條件 | 數量 | 檔案／原因 |
| --- | ---: | --- |
| Windows／PowerShell／Git Bash／ACL | 18 | `fs-acl` 2、`git-bash-direct-send` 5、PowerShell exit/pairing 7+3、`tailer-sidecar-acl-win` 1；目前 macOS 不具備相同環境 |
| Bash 版本 | 3 | `bash-hook-prompt-command` 的 Bash ≥5.1 PROMPT_COMMAND array 案例；本機系統 Bash 不符合 |
| 明確 opt-in 效能量測 | 14 | `http-flow-query-perf` 2、`timeline-query-perf` 9、`zsh-latency.pty` 3；需 `REDLOG_PERF=1`，一般 suite 不作量測 |
| Kali traditional netcat harness | 6 | `zsh-nc-upgrade.pty` 需要 traditional nc 與其 Linux／PTY 差異測試；Mac 的其他 nc 不能當作同一環境 |

不刪除平台測試、不把 skip 改成 PASS，也不僅為消除 skip 而修改本機工具或增加不相干的測試負載。

## 證據種類

- Cast Reader 2 MB 案例使用固定已保存 cast，驗證讀取／搜尋／另存；不等於指令 producer 的 2 MB 實跑。
- 外部 PTY canary 有實際子程序；Bash／Zsh 的原生 unit 有真實 shell，但不能取代 Terminal.app／iTerm／Warp 的 App origin 與 OS 權限驗收。
- Claude Code／Codex 使用真實 watcher、manager、IPC 與檔案邊界，但輸入為合成 JSONL；不能宣稱真實 AI 客戶端已全程驗收。
- HTTP 狀態恢復使用可控制 IPC；先前實際 mitmdump 12.3.1 的隔離／queue/gap 結果在 [cast record](CAST-CONTENT-VERIFICATION.md)，不以這些結果取代瀏覽器系統 CA 信任。
- Windows 原生安裝包／PowerShell 5.1／7 已有 PR 候選證據；本輪不把它寫成 exact main c614cbf3 的 Windows 大型資料或 WSL 驗收。
- 三組視覺參考是版面證據，不是全部頁面逐像素符合 Stitch、鍵盤／原生焦點或五人使用者測試的證明。

## 下一批：macOS 優先

目前子能力、追蹤 issue 與完成條件統一留在
[Spec 064 測試覆蓋矩陣](../../../specs/064-recording-first-workspace/test-coverage-matrix.md)。
本紀錄不維護另一份全域待辦，也不提升完整 UX／CT 或 Spec 065 的狀態。
依序是新 macOS 安裝候選、真實來源操作、Reader 狀態矩陣及視覺／使用者任務。
原 Windows 大型資料與完整架構分別由 #660、#661 追蹤。

## 重跑方式

依 [TESTING](../../TESTING.md) 先確認 native ABI，並讓 Node rebuild 與 Electron rebuild 依序執行。
文件整理不重跑未變的完整 shell 基準；新增產品修改或失敗時才重跑受影響檢查。

本輪插件補驗可重現為：

```sh
npm run build
npm run e2e -- e2e/plugin-explore.spec.ts e2e/capture-settings-interaction.spec.ts --reporter=line
```

正式安裝候選先核對 exact Build／resources／簽章／hash，才使用
`REDLOG_PACKAGED_APP` 與 `REDLOG_EXPECTED_BUILD` 執行 `npm run e2e:smoke`；
來源碼通過與歷史安裝包都不能直接填成新包 PASS。
