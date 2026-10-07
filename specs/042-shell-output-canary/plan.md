# Implementation Plan: Shell Output Canary

## Canonical module interfaces

- `src/renderer/src/lib/outputCanary.ts`: builds the canary and classifies an
  arriving event (output, metadata only, unrelated).
- `RecordTerminalFlow.tsx`: the output check in the verified phase.
- `hooks/redlog-session.py`: nested refusal; window size set in the child
  before exec.
- `docs/RELEASE-SMOKE-TEST.md`: output-check, tmux, ssh/nc, Ctrl-C, restart,
  pause and cap steps.

## Constitution Check

- **II. Surface Truthfulness**: "output recorded" is shown only on output.
- **I. Evidence Integrity**: no double recording of the same bytes.
- **IX**: no new IPC; the live event stream already carries both rows.
