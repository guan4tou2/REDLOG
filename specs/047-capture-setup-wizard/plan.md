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

Risks: remediation may require privileges or a prerequisite package manager;
these remain explicit operator actions. Installed tools do not prove capture.
Native Windows/WSL and macOS quarantine verification needs matching hosts.
