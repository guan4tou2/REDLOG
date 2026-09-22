# Feature Specification: Scope and Spool Isolation

**Status**: Verified
**Created**: 2026-09-20

## Goal

Finish the existing project identity and scope workflows without adding case
management or changing RedLog's record-first model.

## Requirements

- **FR-001**: A spool item carrying another engagement ID MUST never be written
  to the active project's database. It MUST remain recoverable and be replayed
  when its owning engagement is active.
- **FR-002**: Target, HTTP and shared view filters MUST evaluate scope through
  the same targets-plus-excludes rule. An explicit exclude always wins.
- **FR-003**: Advanced project creation MUST accept exclude targets and persist
  them in the initial project configuration.
- **FR-004**: The shared “in scope” filter MUST hide explicitly excluded and
  otherwise out-of-scope targeted Events without deleting them. Untargeted
  ambient Events remain visible.
- **FR-005**: `engagement.id` MUST be read-only after project creation. The
  project display name remains editable.
- **FR-006**: A spool item without both engagement and operator identity MUST
  be quarantined for inspection and MUST NOT inherit the active project.
- **FR-007**: A spool file MUST be removed only after its event write is
  accepted. Pause or write refusal leaves the original file pending.

## Acceptance Scenarios

1. A spool file for project A is encountered while B is active: B receives no
   row, the file remains recoverable, and opening A replays and removes it.
2. A target matches the allow CIDR and an explicit exclude: Target and Timeline
   both classify it out of scope.
3. Excludes entered during project creation are sent to `project:create` and
   saved in `config.scope.excludeTargets`.
4. Enabling the shared in-scope filter hides excluded targeted Events while
   retaining ambient Events.
5. Settings renders engagement ID as read-only and never sends an ID mutation.
6. An identity-free spool payload is renamed `.unattributed`, writes no event,
   and remains available for manual inspection.
7. A replay callback that refuses a write leaves the original `.json` pending.

## Out of Scope

Producer migration to `ingest()`, stdout capture defaults, and a built-in HTTP
proxy are separate changes.
