# Implementation Plan: Session Target Binding

## Canonical module interfaces

- `src/core/session-targets.ts`: `bindSessionTarget`, `sessionTargetFor`,
  `clearSessionTargets`; the only place the precedence below the event's own
  target is decided.
- `src/core/ingest.ts`: calls `sessionTargetFor` before the active-target
  fallback.
- `src/main/ipc/target-context.ts`: `targetContext:getSession` / `bindSession`.
- Shell hook: sends `REDLOG_TARGET` as `data.session_target`.
- `SessionTargetControl.tsx`: the per-tab chip.

## Constitution Check

- **III. Canonical Domain Semantics**: one precedence, one module; the domain
  contract names it (T004).
- **I. Evidence Integrity**: a binding change is recorded; no row is rewritten.
- **IX. Architectural Restraint**: bindings live in memory; no schema change.
