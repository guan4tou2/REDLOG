# Feature Specification: Event Causal Chain

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

## User Scenarios & Testing

### User Story 1 - Trace an event beyond the loaded page (Priority: P1)

As an operator or responder, I can focus an event and see its available causes
and effects even when those events are older, newer, or stored in another tier.

### User Story 2 - Trust incomplete-chain indicators (Priority: P1)

When a referenced event is unavailable or a safety bound truncates traversal,
the interface states that condition without calling a merely unloaded event broken.

## Requirements

- **FR-001**: Causal traversal MUST start from an event ID and follow valid `_causes` links upstream and downstream.
- **FR-002**: Traversal MUST query both evidence tiers and MUST NOT depend on the current Timeline page.
- **FR-003**: Each event and edge MUST appear at most once, including cyclic graphs.
- **FR-004**: Traversal MUST have explicit depth and event-count bounds.
- **FR-005**: Results MUST report unavailable referenced IDs and whether traversal was truncated.
- **FR-006**: Timeline focus mode MUST use the canonical traversal and add returned events to the existing view.
- **FR-007**: A query failure MUST remain distinguishable from an empty or single-event chain.
- **FR-008**: Existing event rows MUST remain unchanged.

## Success Criteria

- **SC-001**: A chain spanning both tiers and events outside the initial Timeline page is available from one focus action.
- **SC-002**: Cycles terminate and return unique events and edges.
- **SC-003**: Missing references and bounded results are visibly distinguishable from complete results.

## Assumptions

- A missing referenced ID is described as unavailable; absence alone cannot prove whether it was pruned or never written.
- Causal focus is forensic navigation and therefore does not apply list filters that would silently remove context.
