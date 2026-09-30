# Feature Specification: Capture Browser Silence

**Feature Branch**: `claude/review-issue-8gg2w7` (PR #232, PR #233)
**Created**: 2026-09-30
**Status**: Verified
**Input**: #182. RedLog's own capture-browser profile sent Google requests with
nothing open, and they were recorded in the logged tier as if the operator had
sent them.

> Written after the change merged. The behaviour, tests and code already existed; the RED record below re-ran this feature's tests against the commit before it on 2026-09-30.

Domain contract: `docs/domain/SPEC-capture-source-lifecycle.md`.

## User Scenarios & Testing

### User Story 1 - An idle capture browser records nothing (Priority: P1)

**Independent Test**: Launch the capture browser with the real argument list
on `about:blank` behind a logging proxy for 60 s: zero requests. A loopback
page load is still captured.

## Requirements

- **FR-001**: The capture profile MUST NOT send background requests the
  operator did not cause: search prefetch and preconnect, the omnibox AI Mode
  eligibility check, Gaia account reconciliation, GCM check-in.
- **FR-002**: Requests with no off switch MUST be pointed at a reserved
  `.invalid` host that bypasses the proxy, so they never reach it.
- **FR-003**: The reserved suffix MUST NOT match `redlog.verify.invalid`,
  which the HTTP check needs to reach the proxy.
- **FR-004**: The operator's own pages and omnibox search MUST be unaffected.

## Success Criteria

- **SC-001**: The argument tests fail before the change; the 60 s idle probe
  records zero requests after it.
