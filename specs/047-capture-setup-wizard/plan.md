# Implementation Plan: Capture Setup Wizard

Date: 2026-10-14 · baseline main@9f8bf28

Use the existing Electron IPC, runtime preflight, dependency installer and
FirstRunView. No new dependency, persisted completion flag, or compatibility
layer is introduced.

1. FirstRunView starts with preparation. A successful preflight with no missing
   selected dependencies automatically advances to the existing independent
   Commands/HTTP proof cards. Skipping never marks either card verified.
2. CapturePreparation owns all dependency installation actions. Each row uses
   runtime.install; failures preserve the exact reason, preflight command,
   prerequisite link and retry. Successful installation rechecks preflight.
   A failed preflight is a separate retryable state.
3. Missing-tool actions in the proof cards return to preparation. Capture
   Health opens the same view in recorded projects without resetting evidence,
   scope, project identity, enrollment or terminal sessions.
4. Verify UI transitions, real terminal output, installed package resources
   and export integrity. Keep native installer acceptance distinct from mocked
   IPC, container shell runs and a local DMG-copy test.
5. Managed proxy readiness uses the reserved local verification host and a
   per-start secret delivered only in the owned child's environment. The
   request carries no secret; the addon must return the matching value.
   Process liveness, foreign listeners and buffered console text cannot prove
   readiness. Probe traffic produces neither evidence nor a user-verification
   report. Startup is bounded to 30 seconds; stop/restart cancels old attempts
   and ignores their late responses. HTTP/HTTPS client proof remains separate.

Risks: remediation may require privileges or a prerequisite package manager;
these remain explicit operator actions. Installed tools do not prove capture.
Native Windows/WSL and macOS quarantine verification needs matching hosts.

## 2026-10-15 cold-download recovery

Actual public downloads exceeded eight minutes while the app killed installs
at three. The single runtime installer now allows up to fifteen minutes with
elapsed waiting time, explicit cancellation and retry. No synthetic percentage
or capture-ready state is shown. Leaving preparation or quitting cancels the
owned install, including its private POSIX process group/Windows child tree.
Only one install per dependency may run; cancellation while login PATH is
pending must prevent spawning. Abort listeners/timers and retained output are
bounded. Cancellation and failure remain different UI states. A fresh private
tool/cache installation must pass through the real UI before T011 is complete.

## First-command startup integrity

The builtin PTY receives its hook source line synchronously before spawn IPC
returns. Later operator input follows it in the same ordered PTY stream; a
600ms timer must not expose a usable prompt before capture enrollment. Keep
the first-command package test free of startup sleeps and require both its
end event/exit code and the output line in the actual cast. Preserve the
installed Bash RED trace separately from the corrected candidate.
