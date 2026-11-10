# Tasks

## Slice 1
- [x] T001 Test: a finished download does not quit or install; only an explicit install does.
- [x] T002 Split download and installAndRestart in updater.ts; remove automatic quitAndInstall and the unclosable progress window.
- [ ] T003 Test: install confirmation lists live terminals, proxy and external shells, defaults to later, and re-checks on confirm. (Open: only "re-checks on confirm" is tested, in update-flow.test.ts. The list comes from quitDialog and is tested in quit-guard.test.ts for the quit dialog, but nothing asserts the update's own confirmRestart dialog uses it or that its default button is "Later" — that is only updater.ts:163-170.)
- [x] T004 Route installAndRestart through quitImpact instead of allowQuit().

## Slice 2
- [x] T010 Main-side update status with single-flight guard; IPC state and events; preload API.
- [ ] T011 About page: version, install type, applicability, target, notes, last result, cancel, retry (i18n en and zh-TW). (Open: version, dev-build/method, target, last result, cancel, retry and both locales exist; release notes are not shown anywhere, and "install type" is only packaged vs development, not the installer kind.)
- [x] T012 Tell "no matching installer" apart from "up to date" and from a failed check.

## Slice 3
- [x] T020 Local anchor failure aborts the install with retry or cancel; external timestamp failure is reported separately.
- [ ] T021 Record target version; first-launch check against app.getVersion(), after-update event, re-check only affected sources (reload prompt only when a loaded hook differs), no claim that sessions survived. (Open: the marker, the first-launch judgement, the update_completed/update_not_applied event and "sessions_resumed: false" exist and are tested. Nothing re-checks affected sources or prompts a reload when a loaded hook differs; test/hook-update-mixed-version.test.ts covers policy-name compatibility, not that prompt.)
- [x] T022 Flush recording before quit.

## Slice 4
- [x] T030 Manual path: unfinished state resolved only by the running version.
- [x] T031 Auto-check switch in settings; air-gap still wins.
- [x] T032 macOS and Linux wording for what is and is not automatic.

## 2026-10-30 執行對帳入口

依 [工作計畫批次 0／3](../../docs/WORK-PLAN.md) 接續；unchecked 代表完整任務未結，不表示現有 updater 應重新開發。本次只建立對應，不代勾完成或升級 Draft。

| 既有任務 | 先核對現有實作／測試 | 下一個完成門檻 |
|---|---|---|
| T001–T004 | [UpdateFlow](../../src/main/services/update-flow.ts)、[update-flow tests](../../test/update-flow.test.ts)、quit guard 接線 | 真實候選下載、稍後、取消與確認重啟；當下 live impact 一致 |
| T010–T012 | [update-status](../../src/main/services/update-status.ts)、[About tests](../../test/about-update-status.test.tsx)、[status tests](../../test/update-status.test.ts) | 成功／失敗／離線／不適用安裝包的原生 About 流程與精確版本 |
| T020–T022 | [update-anchor](../../src/core/update-anchor.ts)、[update-marker](../../src/main/services/update-marker.ts)、[anchor tests](../../test/update-anchor.test.ts) | 實際保存／錨定失敗、重試／取消、更新前後證據讀回與版本結果 |
| T030–T032 | [update-prefs](../../src/main/services/update-prefs.ts)、[prefs tests](../../test/update-prefs.test.ts)、各平台更新路徑 | Windows App 更新、Mac 手動替換、Linux 套件路徑各自實測；air-gap 與不適用狀態正確 |

每組先列出已滿足／缺額，再補必要程式或驗收。完整結果留在此 feature 的 verification；跨 feature 最終更新驗收仍由 Spec 062 T012／T013 承接，不新增平行 updater 或第二份原生矩陣。

## 2026-11-10 程式與測試對帳

逐項對照 `src/main/services/updater.ts`、`update-flow.ts`、`update-status.ts`、`update-prefs.ts`、`update-marker.ts`、`src/core/update-anchor.ts`、`src/main/index.ts` 與下列測試；`update-flow`／`update-status`／`update-anchor`／`update-marker`／`update-prefs`／`about-update-status`／`quit-guard` 共 7 檔 77 項在本次對帳時通過。勾選只代表**程式碼存在且有測試或可直接讀出**，不代表原生驗收（見 verification.md）；Spec 狀態維持 Draft。

| 任務 | 結果 | 依據 |
|---|---|---|
| T001 | 勾 | `update-flow.test.ts`「a finished download only says ready」 |
| T002 | 勾 | `UpdateFlow` 拆開 download／install；`updater.ts:100-101` `autoDownload=false`、`autoInstallOnAppQuit=false`；唯一 `quitAndInstall` 在 port（`:136`）；wiring 測試斷言無 `BrowserWindow`／`alwaysOnTop` |
| T003 | 未勾 | 只有「確認時重新取得影響」有測試；更新確認框本身預設「稍後」只在 `updater.ts:163-170`，沒有測試斷言 |
| T004 | 勾 | `setUpdateImpactProvider(currentQuitImpact)`（`index.ts`）→ `quitImpact`；`allowQuit` 只在確認、`beforeRestart` 成功之後呼叫（`update-flow.test.ts`「happens only when the operator picks it…」） |
| T010 | 勾 | `UpdateStatusStore`、`inFlight` 單一檢查（wiring 測試）、`app:updateStatus` 等 IPC（`index.ts`）與 preload |
| T011 | 未勾 | 缺更新說明（release notes）；「安裝類型」只分已封裝／開發版 |
| T012 | 勾 | `hasInstallerFor` + `result: 'noInstaller'`；`update-status.test.ts`、`about-update-status.test.tsx` |
| T020 | 勾 | 本機錨定失敗 → `beforeRestart` 拋出 → 重試／取消（`update-status.test.ts`「save before a restart fails」）；外部時間戳另列 `external`（`update-anchor.test.ts`） |
| T021 | 未勾 | 缺「只重新檢查受影響來源、hook 有差異才提示重載」；其餘（marker、首次啟動判斷、事件、`sessions_resumed: false`）已有 |
| T022 | 勾 | `stopProject()` 在 `will-quit` 先 `detachTerminalRecordings` 再 `closeDB`；測試是原始碼順序斷言，不是行為測試 |
| T030 | 勾 | `restoreUnfinishedUpdate` + `judgeUpdateOutcome` 只看執行中版本；手動未完成時 `index.ts` 不寫事件、不清 marker |
| T031 | 勾 | `update-prefs` 旗標檔、About 開關、`runCheck` 先判斷 air-gap 再發請求 |
| T032 | 勾 | About macOS／Linux 文案（en、zh-TW 皆有）與 `updater.ts` macOS 對話框說明；測試只驗選到哪個 key，文案內容靠人讀 |

未能確認：真實 Windows 安裝包的 `quitAndInstall` 是否經過 `will-quit` 完成 T022 的收尾（未實機執行）、各平台實際升級路徑、更新確認框的原生外觀與預設鍵。
