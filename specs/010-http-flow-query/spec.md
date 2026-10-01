# Feature Specification: HTTP Flow Query

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

## User Scenarios & Testing

### User Story 1 - Browse complete HTTP flows (Priority: P1)

As an operator, I need request and response records to remain together when
HTTP History is paged so a response is never hidden by an event-row limit.

### User Story 2 - Load the whole record without a click (Priority: P1)

HTTP History must auto-follow its cursor to completion, so an ordinary session
loads whole without the operator asking page by page. A bounded cap is the only
reason it stops short: past it the view rests in a recent-subset state and lets
the operator continue from an opaque cursor, so a runaway brute force cannot
freeze the panel pulling every half into the renderer.

### User Story 3 - Preserve evidence on failure (Priority: P2)

A failed next-page request must retain loaded flows, cursor and retry context.

## Requirements

- **FR-001**: Pagination MUST select complete `flow_id` units before fetching rows.
- **FR-002**: Shared target, time and scope predicates MUST apply before the flow limit.
- **FR-003**: Request and response rows for a selected flow MUST return together.
- **FR-004**: HTTP History MUST expose complete, partial, loading and failed states. The partial (recent-subset) state is a backstop reached only at the auto-load cap, not the resting state of an uncapped session.
- **FR-005**: Filter changes and live refresh MUST invalidate obsolete cursors.
- **FR-006**: HTTP History MUST present the loaded flows as a single flat per-request log (Burp HTTP-history shape), one row per flow. Grouping traffic under the command that produced it is the Timeline's responsibility, not this panel's.
- **FR-007**: HTTP History MUST auto-follow its cursor to completion up to a bounded flow cap, fetching one page at a time, and MUST stop auto-following on a page failure so the retry surfaces rather than looping.

## Success Criteria

- **SC-001**: Paging returns every qualifying flow exactly once with all captured halves.
- **SC-002**: No fixed event-row cap is used by HTTP History; the flow-level auto-load cap stops paging, never truncates a flow.
- **SC-003**: The flat per-request log and desktop journeys pass.

## Assumptions

- Flow time is request time, falling back to the earliest captured row.
- Local text, method, status and host controls continue filtering loaded flows.
