# Feature Specification: Capture Verification Contract

**Feature Branch**: `feat/038-capture-verification`
**Created**: 2026-09-24
**Status**: Verified
**Input**: After v0.17.0, "connected" still overpromised in two places: a verified shell did not say that output is not recorded, and HTTP counted as working once mitmdump was listening.

## Problems (verified on main `3bcba5f`)

1. The verified shell state read only "✓ Zsh 已連線". The hook records
   command metadata, not output; `redlog-session` existed only as a shell
   function and one Settings label.
2. `HttpCaptureStep` treated `status.state === 'running'` as success. A
   listening proxy says nothing about traffic reaching RedLog.

## Clarifications

### Session 2026-09-24

- Q: Make `redlog-session` the default for external shells? → A: No — it
  changes the hook (a PTY wrapper). Name it in the verified state; decide a
  default after dogfooding.
- Q: What verifies HTTP? → A: The first `scanner` event with subtype
  `http_request_start` or `http_response` on the live stream while the proxy
  runs.
- Q: What does PowerShell show? → A: No `redlog-session` there; point at the
  built-in terminal or the Windows terminal output pack.

## User Scenarios & Testing

### User Story 1 - Know what a connected shell records (Priority: P1)

**Independent Test**: The verified Zsh state lists command, exit code,
duration and cwd, says output is not included, and offers `redlog-session`.

### User Story 2 - HTTP is verified by traffic (Priority: P1)

**Independent Test**: With the proxy running, the card waits; a shell or
network event does not verify it; an HTTP request event does; after 60 s it
names the applicable reasons and a late request still verifies.

## Requirements

- **FR-001**: The shell verified state MUST state recorded fields and that
  output is excluded, with `redlog-session` for POSIX adapters (host and WSL)
  and the built-in terminal / Windows output pack for PowerShell.
- **FR-002**: The HTTP card MUST listen only while the proxy runs and MUST
  show verified only on an HTTP request/response event.
- **FR-003**: After 60 s without one it MUST list the browser reason always,
  the CA reason when the certificate is not ready, and the terminal-routing
  reason matching the switch; it MUST keep listening.

## Success Criteria

- **SC-001**: New tests, full suite, first-run e2e, gates and build pass.
