# IPC Contract: Export Plan

## Resolve preview

`data:resolveExportPlan(request: ExportRequest) -> ExportPlanResponse`

Success returns `{ ok: true, plan }`. Failure returns `{ ok: false, error }`.
It never opens a save dialog or writes an export artifact.

Error codes: `no-active-project`, `invalid-request`,
`unsupported-policy`, `selection-failed`.

## Execute approved plan

`data:executeExportPlan({ planId }) -> ExportResult`

The main process verifies project, expiry, status and fingerprint before
delegating to the format adapter. It accepts no policy toggles or subset changes.

Error codes: `plan-not-found`, `plan-expired`, `project-changed`,
`plan-already-used`, `source-unavailable`, `write-failed`.

## Invariants

1. Preview is a projection of the returned plan.
2. Execution reads the same normalized request, policy snapshot and row bounds.
3. Renderer input cannot widen selection at execution.
4. Resolve failure disables confirmation.
5. Execute failure never produces a success state.
6. Capability gaps are plan data, not hidden UI knowledge.

Legacy handlers remain only during migration and must not claim this contract.
