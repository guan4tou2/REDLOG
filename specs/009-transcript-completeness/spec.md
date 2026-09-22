# Feature Specification: Transcript Completeness

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified
**Input**: Make Transcript disclose when it is showing a recent subset and let the operator load older evidence without losing filters or paired presentation.

## User Scenarios & Testing

### User Story 1 - Know whether the transcript is complete (Priority: P1)

As an operator, I need Transcript to say whether older matching evidence exists
so I do not copy a recent subset as though it were the complete engagement.

**Independent Test**: Seed more rows than one bucket page and verify the view
shows a recent-subset state and an action to load older evidence.

### User Story 2 - Continue through older evidence (Priority: P1)

As an operator, I need Load Older to continue every applicable event bucket
from its own cursor and merge the result without duplicates.

**Independent Test**: Page through rows with equal timestamps across both tiers
and verify every row appears exactly once in canonical order.

### User Story 3 - Preserve truthful failure state (Priority: P2)

As an operator, I need a failed initial or older-page load to remain distinct
from an empty or complete transcript.

**Independent Test**: Reject a page request and verify the view retains its
previous evidence, still reports incompleteness, and offers retry.

### Edge Cases

- A shared event type unsupported by Transcript produces an honest empty set.
- Filter changes restart all bucket cursors.
- New captured events refresh the first page and discard obsolete cursors.
- Local text and kind filters do not claim the underlying dataset is complete.

## Requirements

- **FR-001**: Transcript queries MUST return `hasMore` and an opaque cursor.
- **FR-002**: Every supported event bucket MUST maintain its own cursor.
- **FR-003**: The view MUST distinguish complete, recent-subset, loading, empty,
  and failed states.
- **FR-004**: Loading older evidence MUST re-project all loaded events so pairs
  spanning a page boundary can converge.
- **FR-005**: Page failure MUST retain loaded evidence and retry context.
- **FR-006**: Copy as Markdown MUST disclose when the loaded dataset is partial.

## Success Criteria

- **SC-001**: Pagination tests return all qualifying rows exactly once.
- **SC-002**: Operators can visibly distinguish a recent subset from a complete
  transcript before copying it.
- **SC-003**: Filter changes restart pagination with no rows from the prior set.

## Assumptions

- Balanced per-type bucket sizes remain in place to prevent high-volume HTTP
  evidence from starving shell or agent evidence.
- Local content filters operate over loaded evidence and are labeled accordingly.
