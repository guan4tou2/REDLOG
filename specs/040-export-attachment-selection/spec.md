# Feature Specification: Export Attachment Selection

**Feature Branch**: `claude/review-issue-8gg2w7` (PR #232)
**Created**: 2026-09-30
**Status**: Verified
**Input**: #222. The evidence-bundle preview gave counts only. The operator
could not see which cast or screenshot was about to leave, or drop the
recording that held another target's session.

> Written after the change merged. The behaviour, tests and code already existed; the RED record below re-ran this feature's tests against the commit before it on 2026-09-30.

Domain contract: `docs/domain/SPEC-export-event-selection.md`, section
"Evidence Bundle attachments".

## User Scenarios & Testing

### User Story 1 - See every file the bundle will carry (Priority: P1)

**Independent Test**: Resolve a bundle plan for a project with screenshots,
a cast that touched targets A and B, and an HTTP body. The preview lists one
row per file with its kind, size, targets and attribution; the A/B cast reads
as cross-target.

### User Story 2 - Leave a file out (Priority: P1)

**Independent Test**: Untick the A/B cast. The plan resolves again and its
fingerprint changes. The executed bundle does not contain the cast, the
manifest records it as excluded by the operator, and the file on disk is
unchanged.

### Edge Cases

- A missing file or one dropped by scope masking is listed but cannot be
  ticked.
- An exclusion naming something that is not a bundle path is ignored, not
  trusted.

## Requirements

- **FR-001**: The bundle preview MUST list every attachment file with its
  kind, size, targets and attribution (`target`, `cross-target`,
  `unattributed`).
- **FR-002**: A cast MUST NOT be trimmed or labelled by the export's scope; a
  cast that touched several targets MUST read as cross-target.
- **FR-003**: The operator's exclusions MUST be part of the export request, so
  the plan fingerprint covers them, and execution MUST re-check the counts
  with them applied.
- **FR-004**: The manifest MUST record how many files the operator excluded
  and, for each included cast, its targets and attribution.
- **FR-005**: Export MUST NOT modify any source file.

## Success Criteria

- **SC-001**: The listing rules, request normalisation, an IPC round trip
  excluding the A/B cast, and the preview UI are each covered by a test that
  failed before the change.
