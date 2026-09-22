# Specification Quality Checklist: External-Shell Output Capture

**Purpose**: Review whether output-capture requirements are honest, bounded and observable
**Created**: 2026-09-21
**Feature**: [spec.md](../spec.md)

**Review Ownership**: Mark `[x]` only when a reviewer determines the requirements-quality criterion is satisfied.

## Completeness and Clarity

- [ ] CHK001 Is metadata-only capture clearly separated from explicit output capture? [Clarity, Spec §FR-001, §FR-005]
- [ ] CHK002 Are live terminal behavior, stored payload behavior and fallback behavior all specified independently? [Completeness, Spec §FR-002–FR-004]
- [ ] CHK003 Is the 100 KB cap defined per stream without implying full-output preservation? [Clarity, Spec §FR-003]

## Scenario Coverage

- [ ] CHK004 Are early output, empty streams, stderr separation, non-zero exits and recorder unavailability covered? [Coverage, Spec §Acceptance Scenarios, §Failure and Edge Cases]
- [ ] CHK005 Are interactive TUI and session-wide recording explicitly excluded? [Boundary, Spec §Out of Scope]
- [ ] CHK006 Can each success criterion be observed through a named automated gate? [Measurability, Spec §SC-001–SC-004]

## Notes

- `$speckit-implement` reads checklist state but does not modify markers.
