# Verification: Capture Setup Wizard

Date: 2026-10-14 · initial main@9f8bf28; integrated main@3d89ffc
Branch: fix/recording-closeout-opencode, PR #335.
Status: Implemented; not merged, not fully Verified.

## RED

- A recorded project had no fixed capture-open-setup entry in real Electron.
- CapturePreparation behavior tests failed before the preparation module
  existed; the existing screen had no Prepare → Prove transition.
- Proxy status retained unavailable after a successful tool installation.
  The new test could not restart it; current preflight now controls whether
  tools need preparation, rather than an old proxy failure.

## GREEN

- Prepared hosts advance automatically to Commands/HTTP. Missing tools for the
  selected shell and HTTP appear once, with runtime.install as the sole UI
  installation entry. Optional shells are not installation requirements.
- Every failed install keeps its cause, exact manual remedy, prerequisite
  link if needed and retry. Successful installation rechecks availability;
  neither installation nor skipping verifies recording. Failed/unknown
  preflight has a distinct state and retry.
- Command and HTTP missing-tool actions return to preparation. Leaving or
  skipping preparation/proof is possible without a persisted seen flag.
- Capture Health reopens the same setup, even for recorded projects or failed
  health reads. Evidence/config/scope/identity/enrollment are preserved.
- HTTP parent readiness resets when preparation replaces its nonce attempt,
  so a new unverified card cannot inherit a previous attempt's ready footer.
- Focused setup/HTTP regression: 3 files, 48 tests PASS. Installer core: 8 PASS.
- Source Electron FirstRun: 10 PASS, including 800×720 keyboard recovery,
  skipped setup/reload, persistent failure and failure→success→unverified
  proof cards. Visual inspection includes wrapping manual commands.
- Packaged macOS actual installer: PATH initially excludes mitmdump; the UI
  runs uv into private tool/cache directories, observes the new executable,
  advances, restarts the real proxy and verifies an HTTP nonce. HTTPS and
  Commands correctly remain unverified. No system trust/profile changes.
- Historical local DMG SHA-256: 9d964ea671e39d3441e1c3c8f216841feacdedee6582655dca49783572180686.
  Installed via read-only mount and copy to an isolated directory.
  Superseded after strict signing verification found its missing resource seal;
  see docs/PACKAGED-SMOKE.md for the replacement signed candidate and separately
  recorded checks. The replacement's dependency-install download initially
  times out at 180 seconds; earlier success is not relabeled as that run's result.
- Final installed-candidate counts are recorded with its hash in the delivery
  artifact. Direct UI launchers now honor REDLOG_PACKAGED_APP and assert
  app.isPackaged; their earlier source runs are not counted as package runs.
  Linux proof/enrollment journeys use the visible preparation skip when tools
  are missing. A prepared host may advance automatically during that action;
  the driver accepts only the actual proof view, not a swallowed error.
- Actual isolated dependency installation exposed another RED: after five
  seconds a live but non-listening mitmdump was labeled running and curl got
  connection refused. Three regressions reproduce cold-start, timeout and
  split-output cases. Real mitmdump then showed that its console output remains
  buffered even while the port is bound, including with PYTHONUNBUFFERED.
  Running therefore requires a matching private response from the owned addon,
  with a bounded 30-second startup; timeout stops only the owned child and
  exposes a reason. Ready-looking logs, foreign replies and stale-generation
  replies cannot promote a process. Synchronous spawn failure can retry.
  Actual localhost responses and the addon methods verify that no probe token
  is sent in the request and no evidence/user-proof report is emitted.
  Focused core/readiness: 37 PASS.

## Clarify

Spec 006 retired legacy-hook migration before release. This implementation
adds no compatibility banner or alias. Commands requiring privileges and
absent package-manager prerequisites remain explicit operator actions.

## Checklist

The local implementation covers the preparation, independent proof, skip and
recovery behavior in FR-001–FR-011. A successful tool check is not a captured
event; a successful install process is not tool availability.

## Analyze

Typecheck, Spec Kit, architecture, i18n, build and packaged-resource gates PASS.
Evidence distinguishes mocked IPC UX checks from real isolated dependency
installation, actual packaged recording, and native clean-host acceptance.

## Converge

The observed install→unavailable loop is fixed and tested. No timeline layout,
case-management feature, compatibility shim or new framework was added.

## Remaining native acceptance

Windows portable/native WSL and Kali desktop installers; downloaded macOS
quarantine/Gatekeeper, Dock launch and notarization. The isolated macOS
dependency installation is real, but it is not a wholly clean OS image.
T010 remains unchecked; the spec is Implemented, not Verified.

Windows NSIS is now verified for bae0415: clean-runner install, own-profile
first launch, native PowerShell, HTTP/HTTPS, loopback projection verification,
no unexpected skips and uninstall all PASS in
[run 38580377642](https://github.com/guan4tou2/REDLOG/actions/runs/38580377642).
This supersedes the earlier pending Windows NSIS status, not the remaining
portable/WSL or full native matrix. See docs/PACKAGED-SMOKE.md for exact counts.

Final owned-probe candidate: 27 installed journeys PASS (4.2 minutes), all direct
UI launchers checked app.isPackaged. Actual 100-command capture took 48,796ms.
Full regression: 354 files PASS / 4 SKIP; 3,593 tests PASS / 24 SKIP.
The missing-tool installation and real HTTP/HTTPS/bundle flows pass with
buffered mitmdump output; probe traffic remains outside evidence/user proof.
