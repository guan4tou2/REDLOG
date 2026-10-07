# Feature Specification: Session Target Binding (withdrawn)

**Status**: Withdrawn

The operator withdrew the per-session target layer on 2026-10-01. The
reasoning that retired it:

- It adds no fact the log did not already hold. A pane's events share a
  `terminalId` and are ordered, so `ssh user@10.10.11.7` followed by `whoami`
  already says which host the second command ran on — a reader recovers it by
  reading. The same is true of a reverse shell: `nc -lvnp 4444` prints the
  peer address into captured output.
- It does not protect scope. `scopeSignalFor` judges `data.detectedTarget`,
  the extractor's observation, and deliberately never `target_id` — so a wrong
  binding cannot hide an out-of-scope command, and a right one cannot catch
  one (`src/core/alert/scope-signal.ts`).
- What it actually served was per-target grouping in reports, which is a
  derivation and should be computed from the pane's own sequence at read time
  rather than declared at write time by an operator who has to remember.
- It was never uniformly available: external shells had only a static
  `REDLOG_TARGET` exported once at shell start. A mechanism load-bearing for
  record integrity would not be optional on a first-class capture path.

Removed: `src/core/session-targets.ts`, the `targetContext:getSession` /
`targetContext:bindSession` IPC and its preload bridge, `SessionTargetControl`
and its `terminal.sessionTarget*` strings, support for `REDLOG_TARGET` /
`data.session_target`, and the `system.session_target_changed` event. No
compatibility shim. Historical commits preserve the implementation.

Attribution precedence is now: explicit producer target > observed/enriched
target > active-target fallback > null. Read-time derivation of a pane's
target is a separate design and is not part of this withdrawal.

Domain contract: `docs/domain/SPEC-target-identity.md`.
