# Feature Specification: Shared Event Filter

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified
**Input**: Make target, event type, time range and in-scope filters authoritative across investigation surfaces before pagination or result limits are applied.

## User Scenarios & Testing

### User Story 1 - Trust filtered search results (Priority: P1)

As an operator, I need Search to apply every shared filter to the complete
matching dataset so a short page cannot hide valid results behind excluded rows.

**Independent Test**: Insert more excluded matches than one page followed by
in-scope matches; the first returned page contains the in-scope matches and its
cursor continues the same filtered dataset.

### User Story 2 - Consistent investigation surfaces (Priority: P1)

As an operator, I need Transcript and HTTP History to use the same target,
event-type, time and scope meanings as Search.

**Independent Test**: Apply one shared filter and verify each applicable
surface requests a bounded backend dataset rather than filtering a capped
unfiltered result.

### User Story 3 - Stable pagination (Priority: P2)

As an operator, I need changing a filter to restart the dataset while loading
more continues the exact same filter.

**Independent Test**: Change any shared filter after page one and verify page
one reloads; load-more uses the unchanged filter and has no duplicates.

### Edge Cases

- Events without a target remain visible when scope filtering is enabled.
- An empty scope does not hide any event.
- Exclusions override included targets.
- A shared event type that cannot appear on a specialized surface yields an
  honest empty dataset without issuing a broader query.

## Requirements

- **FR-001**: One shared filter contract MUST define target, event type, lower
  and upper time bounds, and the in-scope-only choice.
- **FR-002**: Supported predicates MUST be applied before limits and cursors.
- **FR-003**: Scope decisions MUST use the canonical project scope and exclude
  rules rather than a renderer-owned interpretation.
- **FR-004**: Search MUST pass target and scope filters to its paged query.
- **FR-005**: Transcript and HTTP History MUST pass applicable shared filters
  to their backend reads before their existing projection logic.
- **FR-006**: Filter changes MUST restart pagination; load-more MUST preserve
  the filter that produced the current cursor.
- **FR-007**: Existing local content and presentation filters MAY remain local
  when they are not part of the shared event filter.

## Success Criteria

- **SC-001**: A first page contains all qualifying rows up to its page size even
  when more than one page of non-qualifying rows is newer.
- **SC-002**: All three affected surfaces apply the same target, time and scope
  predicate meanings to the evidence types each surface supports.
- **SC-003**: Automated contract, pagination, renderer and integration tests pass.

## Assumptions

- Transcript block pagination and HTTP flow projection pagination remain
  separate bounded features; this change makes their input event selection
  truthful without redesigning either projection.
