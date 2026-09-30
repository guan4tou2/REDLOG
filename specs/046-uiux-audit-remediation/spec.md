# Feature Specification: UI/UX Audit Remediation

**Feature Branch**: `claude/review-issue-8gg2w7` (PRs #234, #235, #236)
**Created**: 2026-09-30
**Status**: Verified
**Input**: A UI/UX audit of the renderer (findings F1 to F24). The worst:
failed reads shown as safe, failed saves that said nothing, screenshots of
RedLog instead of the target, colours outside the theme.

> Written after the change merged. The behaviour, tests and code already existed; the RED record below re-ran this feature's tests against the commit before it on 2026-09-30.

## User Scenarios & Testing

### User Story 1 - A failure is reported, and a failed read is never safe (Priority: P1)

**Independent Test**: A marker save that fails keeps the dialog and draft and
says so. Scope that cannot be read shows "unknown" with a retry, never "scope
OK" or "in scope". Targets and Screenshots show an error and a retry.

### User Story 2 - A screenshot shows the target, not RedLog (Priority: P1)

**Independent Test**: ⌘⇧M in another app holds the frame before RedLog comes
forward; the marker uses it. In-app captures hide RedLog's windows for the
grab. The display under the cursor is captured.

### User Story 3 - Consistent, accessible surfaces (Priority: P2)

**Independent Test**: Dialogs trap focus and close on Escape; icon-only
buttons have names; every colour class uses a theme shade; zh-TW uses the
glossary terms and names settings pages that exist.

### Edge Cases

- A held frame nobody claims writes nothing, and a token works once.
- Toasts: an error is not pushed off by a batch of successes.
- A plugin consent dialog is not dismissed by a stray click.

## Requirements

- **FR-001**: A failed read MUST render as unknown or failed, with a retry.
- **FR-002**: A failed write MUST keep the operator's input and say it failed.
- **FR-003**: A shortcut screenshot MUST use the frame taken when it fired;
  in-app captures MUST hide RedLog's windows.
- **FR-004**: Modal dialogs MUST trap focus and close on Escape, except where
  a decision must be explicit.
- **FR-005**: Every colour class MUST name a shade the theme defines; inline
  hex colours only where a class cannot be used.
- **FR-006**: Every icon-only button MUST have an accessible name.
- **FR-007**: zh-TW MUST use the glossary terms and name only existing
  settings pages.

## Out of Scope

- Splitting the Timeline toolbar and lanes out of `Timeline.tsx` (the event
  log and inspector moved; the rest is follow-up work).
- Moving every raw `<button>` to shared components; FR-006 is guarded, the
  styling migration is not.

## Success Criteria

- **SC-001**: Each FR has a guard test that failed before its PR.
