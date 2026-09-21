# Feature Specification: Usable External-Shell Output Capture

**Status**: Verified
**Created**: 2026-09-21

## Goal

An operator using an external POSIX shell can intentionally capture a command's
stdout and stderr without losing live terminal feedback, and RedLog states
clearly when the ordinary shell hook records command metadata only.

## User Story

As a penetration tester working in my own terminal, I need output capture to
remain usable for slow and verbose commands, and I need the UI to tell me which
capture level is active before I rely on the resulting log.

### Acceptance Scenarios

1. **Given** the shell hook is installed, **when** the operator reviews capture
   sources, **then** the shell-hook row states that ordinary commands record
   command metadata and that `redlog-run` adds stdout/stderr.
2. **Given** `redlog-run` wraps a command, **when** stdout or stderr is emitted
   before the command exits, **then** the bytes remain visible in the terminal
   while the command is running.
3. **Given** the wrapped command finishes, **when** RedLog receives its
   `command_end`, **then** stdout/stderr, byte counts, truncation flags, exit
   code, duration and `captured_by=redlog-run` retain the existing contract.
4. **Given** RedLog is unavailable, **when** `redlog-run` is used, **then** the
   command still runs and returns its exit code without becoming dependent on
   the recorder.

## Requirements

- **FR-001**: The product MUST distinguish command-metadata capture from
  command-output capture wherever the shell-hook capability is presented.
- **FR-002**: POSIX `redlog-run` MUST stream stdout and stderr to their original
  terminal streams while also capturing them for the event.
- **FR-003**: The wrapper MUST preserve exit code and the established structured
  output fields and 100 KB per-stream event cap.
- **FR-004**: Failure to reach RedLog or create capture resources MUST fall back
  to transparent command execution.
- **FR-005**: The normal shell hook MUST remain metadata-only; the UI and docs
  MUST NOT describe it as transparent output capture.

## Failure and Edge Cases

- Empty streams remain valid captured streams with zero byte counts.
- stdout and stderr stay separate and are replayed to their matching terminal
  file descriptors.
- Temporary resources are removed after success or command failure.
- TUI/full-session capture is outside this wrapper's contract; operators must
  use the built-in terminal for PTY recording.

## Success Criteria

- **SC-001**: An automated POSIX integration test observes an early stdout
  marker before a delayed wrapped command exits.
- **SC-002**: The same test observes separate stdout/stderr payloads and the
  wrapped exit code in the resulting event.
- **SC-003**: Capture Health renders the shell-hook capability limitation and
  the `redlog-run` path in both supported languages.
- **SC-004**: Typecheck, build and the affected Dashboard desktop journey pass.

## Domain References

- `.specify/memory/constitution.md`: Surface Truthfulness, Evidence Integrity,
  Explicit Failure and Architectural Restraint.
- `docs/timeline-io-visibility.md`: external-shell constraint and G1.

## Out of Scope

Transparent interception of every external-shell command, TUI/session PTY
recording, per-shell adapter extraction and fish/Nushell support, Windows
PowerShell streaming, unified I/O sidecars, and proxy setup.
