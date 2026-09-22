# Feature Specification: Command Artifact Linking

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

## User Scenarios & Testing

### User Story 1 - Trace a watched file to its command (Priority: P1)

As an operator, when a recorded command overlaps a file create or modify below
its working directory, I can see that command as a clearly labelled candidate.

### User Story 2 - Avoid invented attribution (Priority: P1)

When RedLog cannot identify exactly one active command, the file remains
recorded without a command link rather than receiving a guessed provenance.

## Requirements

- **FR-001**: A command start MUST carry its working directory when the shell exposes it.
- **FR-002**: A watched file create or modify event MAY record candidate commands when its path is inside their working directory.
- **FR-003**: A cwd/time correlation MUST NOT be written as `_causes`; it MUST state its method and uncertainty.
- **FR-004**: Deleted files, directories, and paths outside the working directory MUST remain unassociated.
- **FR-005**: A bounded post-command grace period MAY preserve a candidate for delayed filesystem notification, and MUST identify it as post-command correlation.
- **FR-006**: Ending a command while capture is paused MUST still clear or transition its runtime lifecycle state.
- **FR-007**: Multiple matching commands MUST remain visible as multiple candidates rather than being guessed into one cause.
- **FR-008**: Runtime correlation state MUST be cleared across project changes.
- **FR-009**: Existing explicit causes MUST be preserved and deduplicated.
- **FR-010**: The stored file event MUST remain the evidence record; correlation metadata is not a replacement event.

## Success Criteria

- **SC-001**: A watched file written during or immediately after a command lists that command as a candidate with its correlation method.
- **SC-002**: Ambiguous candidates remain distinguishable and produce no false causal relationship.
- **SC-003**: Bash, zsh, and structured PowerShell command starts include a working directory.

## Assumptions

- This feature links observed filesystem activity; it does not infer files solely from command text.
- Candidate correlation helps investigation but does not assert which process wrote a file.
