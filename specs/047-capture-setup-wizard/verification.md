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

Windows portable/native WSL, published Kali x64 and full manual first-enrollment
timing; downloaded macOS
quarantine/Gatekeeper, Dock launch and notarization. The isolated macOS
dependency installation is real, but it is not a wholly clean OS image.
T010 remains unchecked; the spec is Implemented, not Verified.

Windows NSIS is now verified for bae0415: clean-runner install, own-profile
first launch, native PowerShell, HTTP/HTTPS, loopback projection verification,
no unexpected skips and uninstall all PASS in
[run 38580377642](https://github.com/guan4tou2/REDLOG/actions/runs/38580377642).
This supersedes the earlier pending Windows NSIS status, not the remaining
portable/WSL or full native matrix. See docs/PACKAGED-SMOKE.md for exact counts.

Historical owned-probe candidate (1606a2c): 27 installed journeys PASS (4.2 minutes), all direct
UI launchers checked app.isPackaged. Actual 100-command capture took 48,796ms.
Full regression: 354 files PASS / 4 SKIP; 3,593 tests PASS / 24 SKIP.
The missing-tool installation and real HTTP/HTTPS/bundle flows pass with
buffered mitmdump output; probe traffic remains outside evidence/user proof.

The replacement sealed macOS DMG passes 26 journeys with the dependency-install
case skipped in that group. Its two explicit cold-install follow-ups time out
after 180 seconds; diagnostics preserve the visible Retry/manual remedy.
The same public Linux tool download takes over eight minutes separately, so
the earlier install success does not prove this environment's cold download.
An installed experimental Kali ARM64 DEB now passes five native recording,
HTTP/HTTPS, export/verifier and restart journeys. A JSON-reported HTTP/bundle
follow-up has no skipped steps or not-exercised annotations. Guest tools were
separately prepared, not installed by the offline guest UI. Spec status remains
Implemented; docs/PACKAGED-SMOKE.md records exact artifacts and limits.

## 2026-10-15 cold-install/cancellation follow-up

The measured three-minute false timeout has an observable RED regression:
a healthy eight-minute install was killed. With a shared fifteen-minute
bound it completes; a hung install still times out. Cancellation before spawn
does not spawn, and a cancelled attempt cannot be promoted by a late exit 0.
The cancelled state is neutral and retryable, separate from install failure
and from capture verification.

The signed installed app actually cancels its controlled installer tree,
preserves a separate unrelated process, and cancels on navigation away. Its
renderer-reload check first leaves the tree alive (RED), motivating sender
lifecycle cancellation in the main process; that failure is retained.

A separate opt-in test starts with no mitmdump and a fresh private uv tool,
cache and Python-install directory. Actual public installation takes 79,217ms,
then the owned proxy and real HTTP/HTTPS nonce checks pass without changing
system trust. This network was faster than the earlier eight-minute download;
it is not evidence that raising the timeout made downloads faster.

The final owner-lifecycle candidate passes all twelve installed journeys:
controlled child/grandchild cancellation, leave and renderer reload with an
unrelated process preserved; ten setup/recovery journeys; and a new actual
private tool/cache/Python install taking 119,834ms followed by real HTTP and
HTTPS proof. The setup/recovery cases use mocked IPC outcomes; the installer,
process-lifecycle and HTTP/HTTPS journeys use the installed application and
actual processes. DMG SHA-256:
`86431a33ac5a73dc5b57b6bf98796ba152a5fe0bb123681e7640ed549fdf97a8`.
Its strict resource signature check passes; publisher signing/notarization
remain absent. The earlier renderer-reload failure is retained. Installer
success/cancel/skip alone never verifies capture. T011 is complete; T010 and
the overall native matrix remain open.
