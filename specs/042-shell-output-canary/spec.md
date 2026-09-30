# Feature Specification: Shell Output Canary

**Feature Branch**: `claude/review-issue-8gg2w7` (PR #232)
**Created**: 2026-09-30
**Status**: Verified
**Input**: #218. A verified shell hook proves commands arrive, not output.
Spec 039 made the connected state say so; this gives the operator a way to
check whether output is recorded, and stops `redlog-session` storing the same
bytes twice.

> Written after the change merged. The behaviour, tests and code already existed; the RED record below re-ran this feature's tests against the commit before it on 2026-09-30.

Builds on `specs/039-capture-verification`.

## User Scenarios & Testing

### User Story 1 - Check that output is recorded (Priority: P1)

**Independent Test**: The connected-shell screen shows
`printf '%s-%s\n' redlog-out <nonce>`. When stdout carrying `redlog-out-<nonce>`
arrives, it says output is recorded and by which recorder. When only the
`command_end` carrying the nonce arrives, it says only the command was.

### User Story 2 - No recorder inside a recorder (Priority: P2)

**Independent Test**: `redlog-session` started inside another exits 2 with an
explanation; `--nested` overrides it.

### Edge Cases

- A later metadata-only row never downgrades a verified output.
- A command starting at once inside `redlog-session` sees the outer terminal
  size, not 0x0.

## Requirements

- **FR-001**: The canary's output MUST contain text its command line does not,
  so output and metadata are told apart.
- **FR-002**: The screen MUST name the recorder that carried the output
  (`redlog-run` or `redlog-session`).
- **FR-003**: `redlog-session` MUST refuse to start when
  `REDLOG_EXTERNAL_SESSION=1`, unless `--nested`.
- **FR-004**: `redlog-session` MUST size the inner PTY before the command runs.

## Success Criteria

- **SC-001**: The canary predicate, the first-run screen, the nested refusal
  and the PTY size each have a test that failed before the change.
