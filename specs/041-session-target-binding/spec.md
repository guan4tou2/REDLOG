# Feature Specification: Session Target Binding

**Feature Branch**: `claude/review-issue-8gg2w7` (PR #232)
**Created**: 2026-09-30
**Status**: Verified
**Input**: #219. The current target was one global value. With parallel panes
on different hosts, switching it for one pane re-attributed what the others
recorded next: a command with no host in it, a marker, a late `command_end`.

> Written after the change merged. The behaviour, tests and code already existed; the RED record below re-ran this feature's tests against the commit before it on 2026-09-30.

Domain contract: `docs/domain/SPEC-target-identity.md` (precedence and
session target).

## User Scenarios & Testing

### User Story 1 - Bind a terminal tab to a target (Priority: P1)

**Independent Test**: Two built-in panes. Pane 1 is bound to A. The global
target switches to B while pane 1's command runs; pane 1's late `command_end`
is attributed to A and stamped `target_source=session`.

### User Story 2 - An external shell declares its own target (Priority: P2)

**Independent Test**: A hooked shell with `REDLOG_TARGET=A` while the global
target is B records its commands against A.

### Edge Cases

- A host named in the command still wins over the session target.
- Unbinding returns the pane to the global target.
- Bindings are cleared when the project closes.

## Requirements

- **FR-001**: Ingest MUST resolve a target in this order: the event's own
  target, an enriched host, the session target, the global target.
- **FR-002**: The session target MUST apply only to the row types the global
  fallback applies to (shell, marker, screenshot).
- **FR-003**: Binding or unbinding MUST append `system.session_target_changed`
  and MUST NOT re-attribute earlier rows.
- **FR-004**: Each built-in terminal tab MUST show whether it follows the
  current target or which target it is bound to, and let the operator change it.

## Success Criteria

- **SC-001**: The two-pane race, `REDLOG_TARGET`, enrichment precedence,
  unbinding and the tab control each have a test that failed before the change.
