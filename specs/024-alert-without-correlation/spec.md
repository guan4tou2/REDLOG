# Feature Specification: Alerts Without Correlation

**Feature Branch**: `refactor/alert-without-correlation`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Remove the two derived alert policies, CombinedPolicy and BurstPolicy, and the verdict-recursion machinery in the alert bus that exists only for them.

RedLog's alarms protect the operator: the IP alarm says the real address may be
exposed, the scope alarm says a target is outside or next to what is
authorised. Both stay. Two further policies read those alarms' output and
write their own events: Combined (an IP verdict and a scope verdict close
together) and Burst (N scope verdicts of one distance inside a window).

The product boundary rules out alert correlation. Beyond that, the evidence
against these two is specific:

- Nothing presents them. No surface other than the chain handles a `combined`
  or `burst` verdict, and no renderer code titles, filters or displays the
  `combined_alert` or `burst_alert` events they write.
- They add events and never withhold any. Burst is described in code as a rate
  limiter, but its `ingest` returns an extra verdict and leaves every scope
  verdict it saw untouched, so removing it cannot let anything through that
  was held back.
- The events they write carry no source references. A `scope_violation` event
  cites the event that caused it; `combined_alert` and `burst_alert` cite
  nothing, and `combined_alert`'s own description tells the reader to "see
  linked events for detail" when there are none. That is an interpretation
  placed in the tamper-evident record without its provenance.
- The bus routes verdicts back through a second class of policy, with a
  recursion guard, solely to support these two.

## User Scenarios & Testing

### User Story 1 - The record holds observations, not unsourced interpretations (Priority: P1)

As an operator handing over an engagement record, I need every alarm event in
the chain to point at what it is about, so a reviewer can verify it rather than
take it on trust.

**Independent Test**: Drive IP and scope signals that would previously have
produced combined and burst verdicts, and verify only `ip_verdict` and
`scope_violation` events are written, each with its source where it has one.

### User Story 2 - The alarms I rely on are unchanged (Priority: P1)

As an operator, I need the IP exposure alarm, the scope alarm, the status
badge, adherence counts and the violation log to behave exactly as before.

**Independent Test**: The existing IP, scope, badge, adherence and violation
tests pass unchanged.

### Edge Cases

- Projects already holding `combined_alert` or `burst_alert` events keep them;
  they remain chained evidence and display as they do today.
- A policy that throws must still not silence the others or any surface.
- Resetting policies on project switch still clears IP and scope state.

## Requirements

- **FR-001**: CombinedPolicy and BurstPolicy, their verdict types and their
  chain event formats MUST be removed.
- **FR-002**: The bus MUST route each signal through the signal policies and
  each verdict to every surface, with no second policy class consuming
  verdicts.
- **FR-003**: IP, scope, badge, adherence and violation-log behaviour MUST be
  unchanged.
- **FR-004**: Stored `combined_alert` and `burst_alert` events MUST remain
  readable and chained.
- **FR-005**: Comments describing surfaces or policies that no longer exist —
  the webhook, Combined, Burst — MUST be corrected.

## Success Criteria

- **SC-001**: No code path can write a `combined_alert` or `burst_alert` event.
- **SC-002**: Every existing IP, scope, badge, adherence and violation test
  passes without modification.
- **SC-003**: The bus has one policy list and no recursion guard.

## Assumptions

- Pre-release (Spec 006): no compatibility path for the removed policies.
- Alert correlation, if it is ever wanted, is a separate product decision and
  would need to cite its sources.
