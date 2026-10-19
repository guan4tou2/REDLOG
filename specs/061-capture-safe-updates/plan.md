# Plan

Surveyed against the code on 2026-10-18. The updater is one main-process file
(`src/main/services/updater.ts`) that talks through native dialogs. Windows uses
electron-updater; macOS and Linux fetch the GitHub latest release and open its
page. Almost nothing in the spec is built, so this plan orders the work by what
can lose evidence first, and cuts what the spec does not need.

## Slice 1 — download and restart become two actions (FR-004, FR-005, part of FR-011)

The one real hazard. Today a finished download goes straight to `allowQuit()`,
an 800 ms delay and `quitAndInstall`, and the dialog even says it will install
and restart on its own. The only consent is the first click. `allowQuit()`
also bypasses the existing quit-guard, so nothing lists what the restart ends.

- Split `download` and `installAndRestart`. Remove the automatic
  `quitAndInstall`. A finished download says "ready", nothing more.
- `installAndRestart` computes `quitImpact` (terminals, proxy, external shells)
  at that moment, shows it, and defaults to "later". Cancelling leaves every
  terminal, the proxy and recording as they were. Re-checked when confirmed.
- Remove the non-closable, always-on-top progress window.
- Windows-only code path. Unit tests drive a fake updater; real upgrade is
  NOT RUN here (this is a macOS machine).

## Slice 2 — update state in the About page (FR-001, FR-002, FR-011, US1, US2)

A main-side status (idle, checking, available, downloading, ready, installing,
failed, unavailable) with a single-flight guard, pushed to the renderer over IPC
and shown in About: version, install type, platform applicability, target
version, notes, last result, cancel and retry. Replaces the native dialogs and
moves the hard-coded zh-TW/English text into i18n. It is state in the existing
About page, not a new panel, and the restart confirmation names only what the
restart would actually end. "No matching installer" is
told apart from "up to date" and from a failed check.

## Slice 3 — evidence around the restart (FR-006, FR-007, FR-009)

The anchor before restart exists (`update-anchor.ts`) but its failure is
swallowed and nothing is written after. Make a local write failure abort the
install with retry or cancel; report an external timestamp failure separately
and never as a blocker. Store the target version; on first launch compare it to
`app.getVersion()`, write an after-update event, re-check only the sources an update can
affect (the proxy, and a shell hook that differs from the new version; prompt
a reload only then), and say that PTY and proxy sessions did not survive. Flush recording before quit.

## Slice 4 — honest manual paths (FR-003, FR-010, US4)

macOS and Linux keep the link-to-release path. Keep an "update not finished"
state that is resolved only by the running version, never by opening the page.
Add the auto-check switch (air-gap already wins). Say plainly on macOS that the
build is ad-hoc signed and install is a replace-the-app step.

## Not planned, and why

- **FR-008 publisher verification.** electron-updater checks the sha512 from the
  release metadata; publisher identity needs a code-signing certificate
  (Windows is unsigned, macOS ad-hoc). Code cannot meet it. The limit is
  stated in About and in the verification record instead.
- **FR-012 persisted diagnostics.** The update-pending and after-update events
  already carry version, stage and time, and no project data leaves the
  machine. A separate diagnostics store is not added unless asked for.
- **SC-003 real-device upgrades** on every platform: a manual matrix, NOT RUN
  until someone has the machines and a candidate build.

Verification: Vitest per slice with a fake updater, the five gates, and the
affected Electron journey. Every claim about a platform not run is labelled.
