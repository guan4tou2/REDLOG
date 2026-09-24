# Implementation Plan: Install and Upgrade Readiness

## Canonical module interfaces

- `core/runtime-preflight.ts`: `runPreflight()`, `findLegacyHookReferences()`,
  `migrateLegacyHook(ref)`, `RETIRED_HOOK_FILES`.
- `core/hooks-manager.ts`: `requiresAll`; `installMethod: 'powershell-profile'`.
- `main/login-path.ts`: `applyLoginPath()`; `loginPathReady` gates preflight
  and the managed proxy.
- IPC `runtime:preflight`, `hooks:migrateLegacy`.

## Constitution Check

- **Surface Truthfulness**: "available" now means the hook can send events;
  missing tools are named, not guessed after a 10 s timeout.
- **Explicit Failure**: migration returns a result with the backup path or the
  reason; PATH resolution failure leaves PATH unchanged.
- **Architectural Restraint**: no shim for retired hooks; no self-removal of
  quarantine; checksums instead of an installer UI.
- **VIII**: every behaviour change started as a failing test (see verification).

## Delivery

Built by four supervised Orca workers (W1 core, W5 renderer, W2 release/docs,
W2b login PATH) on two branches, integrated here; the coordinator wired
preflight to await the login PATH.
