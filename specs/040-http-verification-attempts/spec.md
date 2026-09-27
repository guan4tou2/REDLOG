# Feature Specification: Verify the selected HTTP client and protocol

**Feature Branch**: `codex/evidence-workflow-completion`
**Created**: 2026-09-27
**Status**: Verified
**Input**: Continue issue #220: ordinary traffic must not verify a newly configured client, HTTP must not imply HTTPS, and a CA file must not imply system trust.

## User Scenarios & Testing

### User Story 1 - Verify my chosen client (Priority: P1)

An operator selects browser or external terminal and enters an authorized,
read-only test URL. RedLog supplies a fresh test address for that attempt.
The operator opens it in the selected browser or runs the supplied command in
the intended terminal. Success applies only to that client and protocol.

**Independent Test**: Unrelated HTTP traffic and a prior attempt never verify
the current attempt. The matching completed response does.

**Acceptance Scenarios**:
1. Given a running proxy and no test, receiving ordinary traffic does not show verified.
2. Given a browser HTTPS attempt, a different address or HTTP response does not verify it.
3. Given the matching completed response, only browser HTTPS is verified; terminal and HTTP remain unverified.
4. Given a retry, the previous attempt's late response cannot verify the new one.

### User Story 2 - Understand failure and trust limits (Priority: P1)

The operator can retry a timed-out test and knows whether RedLog observed a
complete response. A browser configured to bypass certificate checks must not
be advertised as proof that the OS, curl or another tool trusts the CA.

**Independent Test**: Request-only, timeout, proxy restart and CA-present
states cannot report verified capture or installed system trust.

**Acceptance Scenarios**:
1. After 60 seconds without the matching response, show troubleshooting and retry.
2. After proxy stop or listener change, prior verification is invalidated.
3. Show CA file existence separately from client verification and untested system trust.
4. An observed HTTP error response still proves capture; clearly show the
   actual status without claiming the application request succeeded.

### Edge Cases

- Invalid URL, non-HTTP scheme, URL credentials, fragments and existing query.
- Same URL tested in two clients; repeated attempts while an earlier request is in flight.
- Out-of-order request/response, duplicated responses, late response after timeout.
- Config/status read failures, proxy start failure and routing save rejection.
- View unmount/remount: verification is session-local and resets rather than implying continued health.

## Requirements

### Functional Requirements

- **FR-001**: A test MUST bind a fresh unpredictable identifier to the selected client, URL and protocol.
- **FR-002**: Only a complete matching HTTP response observed while the proxy is running MUST verify an attempt. A mere request or unrelated event MUST NOT.
- **FR-003**: Browser/terminal and HTTP/HTTPS outcomes MUST remain distinct. Selecting another client or protocol MUST show that selection's state.
- **FR-004**: Retry MUST replace the attempt; a proxy lifecycle change MUST invalidate current verification. Timeout MUST expose recovery without reporting success.
- **FR-005**: The operator MUST choose an authorized read-only URL; testing MUST not send traffic automatically, alter CA trust, or inject commands into existing terminals.
- **FR-006**: Terminal commands MUST preserve the chosen URL safely and test the explicitly shown proxy route. They MUST NOT disable TLS certificate verification.
- **FR-007**: The UI MUST distinguish CA file availability, observed HTTPS capture and system trust. A configured certificate bypass MUST be disclosed.
- **FR-008**: Status/config/start/save failures MUST be visible and retryable. They MUST NOT masquerade as stopped/ready/verified states.

- **FR-009**: Controls MUST be labelled, keyboard accessible, localized in English/Traditional Chinese and usable in the narrow first-run panel. Loading disables attempt creation; validation errors retain entered values.

### Key Entities

- Verification attempt: client, protocol, fresh identifier, test URL, start time, timeout, captured response reference/status.
- Client result: not tested, waiting, timed out or verified for one client/protocol and proxy instance.

## Success Criteria

- **SC-001**: All negative cases (wrong identifier/client/protocol, request-only, previous attempt, stopped proxy) remain unverified in automated behavioral checks.
- **SC-002**: A matching response updates only the selected result within one event-batch delivery.
- **SC-003**: An operator can generate, copy and retry a test from the first-run HTTP panel without leaving it or typing into an existing interactive session.
- **SC-004**: Interface tests prove errors and CA trust limitations are visible, including a real desktop journey for the control flow.

## Assumptions

- This is a cooperative local capture check, not adversarial client attestation;
  the operator runs the test in the named client. It does not prove all tools
  honor proxy environment variables or capture non-HTTP protocols.
- Use existing captured response fields and the current managed proxy.
  No new remote service, packet capture engine or automatic root installation.
- Current GET test traffic remains recorded with the existing event provenance.
- Supersedes Spec 039 FR-002's broad first-HTTP-event verification only;
  the shell coverage disclosure remains in effect.
- Canonical evidence and truthfulness: ../../.specify/memory/constitution.md
  and ../../docs/domain/glossary.md.
