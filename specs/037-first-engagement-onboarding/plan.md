# Implementation Plan: First-Engagement Onboarding

## Canonical module interfaces

- `renderer/lib/scopeInput.ts`: parse and validate pasted scope lists via
  `matchPattern` (no second grammar).
- `core/config.ts`: `mergeInitialConfig(config, projectId, initial)` used by
  `project:create`.
- `renderer/lib/terminalActivation.ts`: `missingDependencies`, nonce,
  `isActivationEvent`, `shellLabel`.
- `RecordTerminalFlow.tsx`, `HttpCaptureStep.tsx`, `FirstRunView.tsx`.
- `renderer/lib/captureReadiness.ts`: `onboardingComplete`; restricted
  `nextStep`.

## Constitution Check

- **Surface Truthfulness**: "recorded" is shown only after the nonce event
  arrives; a failed attempt names why.
- **Explicit Failure**: invalid scope entries are shown, not dropped; install
  failures show their reason in place.
- **Architectural Restraint**: no new IPC — the live event stream and
  existing hook/preflight/HTTP calls suffice; one merge function replaces a
  renderer-side read-modify-write.
- **VIII**: every behaviour change started as a failing test (see verification).

## Delivery

Built by two supervised Orca workers (W3 project scope, W6 first run) on the
036 branch, integrated here; the coordinator moved the personal-domain append
into `project:create` and updated the docs.
