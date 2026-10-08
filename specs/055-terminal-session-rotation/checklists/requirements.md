# Specification Quality Checklist: Terminal Session Rotation Across a Project Switch

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

All items pass. Both clarifications were resolved in session 2026-10-07 and
both widened the feature:

1. **A command in flight at the switch** is recorded as crossing, not waited
   for (FR-013 to FR-015). Waiting would have made the switch's duration a
   function of whatever the operator happened to be running.
2. **Leaving to the picker keeps the panes** (FR-016 to FR-019, User Story 5),
   alive and explicitly unrecorded until a project is opened. This is the
   choice that depends most on FR-007 and FR-017 being built properly: a pane
   that looks live while nothing is written is the worst outcome in this
   feature, worse than today's behaviour, because the operator keeps working
   in it.

The "Problems" section cites the implementation it was verified against, which
is this repository's house style for a spec and not a leak of implementation
into requirements: no FR, acceptance scenario or success criterion names a
file, function or data structure.

The second decision puts this feature on Constitution II in a way the first
draft did not, and it is worth saying out loud at planning time: FR-017 is not
a nicety attached to the picker case, it is the condition on which that case
is allowed to exist.
