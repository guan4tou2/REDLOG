# Verification: Capture Setup Wizard

Date: 2026-10-14 · main@9f8bf28 + local fix/recording-closeout-opencode
Status: Implemented locally; not merged, not fully Verified.

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
- Current local DMG SHA-256: 61e175daa81fed2077ce2d9f5a417d3f3864f8e2e86be6421106ef14cbac5875.
  Installed via read-only mount and copy to an isolated directory.

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

Windows PowerShell/WSL and Kali desktop installers; downloaded macOS
quarantine/Gatekeeper, Dock launch and notarization. The isolated macOS
dependency installation is real, but it is not a wholly clean OS image.
T010 remains unchecked; the spec is Implemented, not Verified.
