# Feature Specification: First-Engagement Onboarding

**Feature Branch**: `feat/037-first-engagement-onboarding`
**Created**: 2026-09-24
**Status**: Verified
**Input**: Spec 036 made the machine ready. This spec covers the next ten minutes: create the engagement with its scope, record the operator's own terminal, optionally start HTTP capture — without AI or host monitors pretending to be required.

> **Superseded HTTP decision (#217):** HTTP(S) is no longer optional on first
> run. Commands and HTTP(S) are both core capture and are shown side by side
> from the first frame; neither waits on the other, a missing shell dependency
> blocks only Commands, and the HTTP card cannot be dismissed. "Core capture
> ready" means both are verified by an arriving event; the operator may leave
> before that, and the Dashboard keeps naming the unfinished one. This replaces
> the clarification on HTTP and onboarding completion and User Story 4 below;
> the rest of this spec stands.

## Problems (verified on the 036 branch before this spec)

1. **Scope was hidden.** Scope and excluded targets lived under Advanced Setup
   and were added one entry at a time; a rules-of-engagement list could not be
   pasted, and invalid entries were accepted silently.
2. **The operator's own traffic polluted deliverables** unless they knew to
   add their IP to personal domains in Settings.
3. **First run stopped at the built-in terminal.** Its CTA opened the
   timeline; connecting the terminal the operator actually uses was a Dashboard
   detour with no proof that it worked.
4. **Readiness pointed at AI.** `nextStep` could be the agent tailer, making an
   optional integration look like the next required step.
5. **`project:create` merged `scope` shallowly**, so passing
   `personalDomains` at creation would have replaced the loopback defaults.

## Clarifications

### Session 2026-09-24

- Q: Is empty scope allowed? → A: Yes, with a note that out-of-scope cannot be
  judged. Recording never depends on scope.
- Q: How is "the terminal is recorded" proven? → A: A per-attempt nonce
  (`echo redlog-ok-<nonce>`) must arrive as a non-built-in shell event; 60 s
  without it shows the concrete reasons (new tab, missing python3/curl, legacy
  hook line).
- Q: Is HTTP capture part of onboarding completion? → A: No. It is an optional,
  dismissable card; completion is built-in terminal OR shell hook active.
- Q: How is the local IP added without replacing defaults? → A:
  `mergeInitialConfig` appends `personalDomains` to the defaults on
  `project:create`; no post-create config save.

## User Scenarios & Testing

### User Story 1 - Paste the scope when creating the engagement (Priority: P1)

**Independent Test**: Pasting `10.10.11.0/24, *.corp.local` and one invalid
entry into the create card creates the project with the two valid entries and
flags the invalid one inline.

### User Story 2 - Record my own terminal, with proof (Priority: P1)

**Independent Test**: After the built-in command appears, "記我的 Zsh 終端"
installs the hook and shows success only when the nonce command arrives from a
non-built-in shell; missing python3 is named before installing.

### User Story 3 - Keep my own traffic out (Priority: P2)

**Independent Test**: Ticking "ignore this machine's traffic" creates the
project with the local IP appended to `personalDomains`, defaults kept.

### User Story 4 - HTTP is optional (Priority: P3)

**Independent Test**: The HTTP card can be skipped; readiness never names the
agent tailer or HTTP as the next step.

## Requirements

- **FR-001**: The create card MUST accept scope and exclude lists separated by
  newline, comma or space, validate each entry against the scope evaluator, and
  show invalid entries inline; Advanced Setup no longer holds them.
- **FR-002**: `project:create` MUST merge initial config per section and append
  `scope.personalDomains` to the defaults.
- **FR-003**: First run MUST offer recording the detected shell (and WSL on
  Windows), gate installation on preflight, and verify with a nonce event.
- **FR-004**: Verification failure MUST list concrete reasons after 60 s and
  allow a retry with a new nonce.
- **FR-005**: `nextStep` MUST be only shell-hook or built-in terminal, and null
  once onboarding is complete.
- **FR-006**: README and user guide MUST describe the paste-on-create and
  record-my-terminal flow.

## Success Criteria

- **SC-001**: New suites, the full suite, the first-run e2e, both gates and the
  build pass.

## Assumptions

- WSL install targets the default distro only (one button).
- PowerShell verification on real Windows hardware is not part of this spec.
