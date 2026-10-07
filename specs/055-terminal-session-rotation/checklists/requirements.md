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

- [ ] No [NEEDS CLARIFICATION] markers remain
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

Two clarifications are open, both in Edge Cases, and both change scope rather
than detail:

1. **A command in flight at the moment of the switch.** Its start is in the
   outgoing project and its completion will arrive while the incoming one is
   open. Either the switch waits for the prompt to return, or the crossing is
   recorded as what it is. Waiting makes the switch's duration a function of
   whatever the operator happens to be running, which can be unbounded.

2. **Leaving a project to the picker, where there is no incoming project.**
   Either panes stay alive and visibly unrecorded until a project is opened,
   or that path keeps today's behaviour and only project-to-project switching
   rotates. The first is the better experience and the one that risks a pane
   that looks live while nothing is being written; FR-007 exists for exactly
   that case, which is what makes it survivable.

The "Problems" section cites the implementation it was verified against, which
is this repository's house style for a spec and not a leak of implementation
into requirements: no FR, acceptance scenario or success criterion names a
file, function or data structure.
