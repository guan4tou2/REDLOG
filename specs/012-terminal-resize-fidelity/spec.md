# Feature Specification: Terminal Resize Fidelity

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified

## User Scenarios & Testing

### User Story 1 - Replay the terminal at its recorded size (Priority: P1)

As an operator reviewing a terminal recording, I need size changes captured in
the recording so full-screen tools, wrapped output and wide tables replay with
the geometry that existed during the engagement.

### User Story 2 - Preserve recording boundaries (Priority: P2)

Resize frames must obey the same pause, truncation and byte-limit rules as
terminal output, without interrupting the live terminal.

## Requirements

- **FR-001**: A successful live PTY resize MUST append an asciicast v2 resize frame.
- **FR-002**: Resize frames MUST contain elapsed session time and `colsxrows` geometry.
- **FR-003**: Invalid or unchanged geometry MUST NOT append misleading frames.
- **FR-004**: Paused, unavailable or truncated recordings MUST NOT append resize frames.
- **FR-005**: Resize frames MUST count toward the configured cast byte limit.
- **FR-006**: Failure to append a frame MUST NOT prevent the live PTY resize.

## Success Criteria

- **SC-001**: A real terminal session resized from 80x24 to 120x40 contains one
  valid `[time, "r", "120x40"]` frame.
- **SC-002**: Existing output capture, byte-range replay and terminal lifecycle tests pass.
- **SC-003**: Recorded byte counts include resize-frame bytes.

## Assumptions

- Asciicast v2 resize frames use event type `r` and `COLSxROWS` data.
- Replayers that ignore resize frames continue to consume output frames unchanged.
