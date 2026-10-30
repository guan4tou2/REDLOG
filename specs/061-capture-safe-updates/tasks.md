# Tasks

## Slice 1
- [ ] T001 Test: a finished download does not quit or install; only an explicit install does.
- [ ] T002 Split download and installAndRestart in updater.ts; remove automatic quitAndInstall and the unclosable progress window.
- [ ] T003 Test: install confirmation lists live terminals, proxy and external shells, defaults to later, and re-checks on confirm.
- [ ] T004 Route installAndRestart through quitImpact instead of allowQuit().

## Slice 2
- [ ] T010 Main-side update status with single-flight guard; IPC state and events; preload API.
- [ ] T011 About page: version, install type, applicability, target, notes, last result, cancel, retry (i18n en and zh-TW).
- [ ] T012 Tell "no matching installer" apart from "up to date" and from a failed check.

## Slice 3
- [ ] T020 Local anchor failure aborts the install with retry or cancel; external timestamp failure is reported separately.
- [ ] T021 Record target version; first-launch check against app.getVersion(), after-update event, re-check only affected sources (reload prompt only when a loaded hook differs), no claim that sessions survived.
- [ ] T022 Flush recording before quit.

## Slice 4
- [ ] T030 Manual path: unfinished state resolved only by the running version.
- [ ] T031 Auto-check switch in settings; air-gap still wins.
- [ ] T032 macOS and Linux wording for what is and is not automatic.

## 2026-10-30 執行對帳入口

依 [工作計畫批次 0／3](../../docs/WORK-PLAN.md) 接續；unchecked 代表完整任務未結，不表示現有 updater 應重新開發。本次只建立對應，不代勾完成或升級 Draft。

| 既有任務 | 先核對現有實作／測試 | 下一個完成門檻 |
|---|---|---|
| T001–T004 | [UpdateFlow](../../src/main/services/update-flow.ts)、[update-flow tests](../../test/update-flow.test.ts)、quit guard 接線 | 真實候選下載、稍後、取消與確認重啟；當下 live impact 一致 |
| T010–T012 | [update-status](../../src/main/services/update-status.ts)、[About tests](../../test/about-update-status.test.tsx)、[status tests](../../test/update-status.test.ts) | 成功／失敗／離線／不適用安裝包的原生 About 流程與精確版本 |
| T020–T022 | [update-anchor](../../src/core/update-anchor.ts)、[update-marker](../../src/main/services/update-marker.ts)、[anchor tests](../../test/update-anchor.test.ts) | 實際保存／錨定失敗、重試／取消、更新前後證據讀回與版本結果 |
| T030–T032 | [update-prefs](../../src/main/services/update-prefs.ts)、[prefs tests](../../test/update-prefs.test.ts)、各平台更新路徑 | Windows App 更新、Mac 手動替換、Linux 套件路徑各自實測；air-gap 與不適用狀態正確 |

每組先列出已滿足／缺額，再補必要程式或驗收。完整結果留在此 feature 的 verification；跨 feature 最終更新驗收仍由 Spec 062 T012／T013 承接，不新增平行 updater 或第二份原生矩陣。
