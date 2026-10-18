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
- [ ] T021 Record target version; first-launch check against app.getVersion(), after-update event, source re-check, no claim that sessions survived.
- [ ] T022 Flush recording before quit.

## Slice 4
- [ ] T030 Manual path: unfinished state resolved only by the running version.
- [ ] T031 Auto-check switch in settings; air-gap still wins.
- [ ] T032 macOS and Linux wording for what is and is not automatic.
