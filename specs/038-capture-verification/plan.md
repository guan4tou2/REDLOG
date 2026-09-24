# Implementation Plan: Capture Verification Contract

## Canonical module interfaces

- `renderer/lib/httpVerification.ts`: `isHttpCaptureEvent`,
  `httpTimeoutReasons`.
- `RecordTerminalFlow.tsx`: `VerifiedScope` for the verified phase.
- `HttpCaptureStep.tsx`: listen on `events.onNewBatch` while running; 60 s
  reasons.

## Constitution Check

- **Surface Truthfulness**: "verified" now means an event arrived, and the
  shell state says what it does not record.
- **Architectural Restraint**: no new IPC, no hook change; the live stream
  already carries HTTP events (as `HttpHistoryPanel` uses it).
- **VIII**: tests written first (see verification).
