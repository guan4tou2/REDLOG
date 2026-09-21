# Specification Quality Checklist: Shell Adapter Boundaries

**Purpose**: Review whether shell support remains small, canonical and migration-safe
**Created**: 2026-09-21
**Feature**: [spec.md](../spec.md)

**Review Ownership**: Mark `[x]` only after reviewing requirements quality.

## Completeness and Boundaries

- [ ] CHK001 Are lifecycle, transport, installation and compatibility responsibilities assigned to one owner each? [Completeness, Spec §FR-001–FR-005]
- [ ] CHK002 Are the three supported shells named without implying fish, Nushell or cmd support? [Boundary, Spec §FR-006, §Out of Scope]
- [ ] CHK003 Is PowerShell parity defined at the event contract rather than shared implementation level? [Clarity, Spec §FR-006]

## Failure and Migration Coverage

- [ ] CHK004 Are missing runtime, wrong shell, legacy entry points and shared-file removal addressed? [Coverage, Spec §Failure and Edge Cases]
- [ ] CHK005 Can adapter thinness and manifest parity be objectively guarded? [Measurability, Spec §SC-001–SC-003]

## Notes

- `$speckit-implement` reads checklist state but does not modify markers.
