# Feature Specification: Loot Rule Time Bound

**Feature Branch**: `feat/loot-regex-time-bound`
**Created**: 2026-09-23
**Status**: Verified
**Input**: A loot rule declared by a plugin must not be able to freeze RedLog. This is the prerequisite for letting operators type their own rules.

Loot rules run on the ingest path in the main process. JavaScript cannot
interrupt a running regex, and a catastrophically backtracking pattern —
`(a+)+$` against a long run of `a` — runs for minutes. One such plugin rule
therefore stopped capture, the API and the UI together, with no indication of
which rule was responsible.

## Clarifications

### Session 2026-09-23

- Q: Which rules are bounded? → A: Plugin rules (and, later, project rules).
  Built-in rules are reviewed with the code and keep running in-process.
- Q: What is the bound? → A: 250 ms for all running plugin rules together on
  one scanned text; worker startup does not count.
- Q: What happens to a rule that overruns? → A: It is stopped until its plugin
  is reloaded; the other rules are run again without it.
- Q: How does the operator find out? → A: The rule is marked in Settings ▸
  Capture ▸ Loot detection, and the main process logs it.
- Q: Does a stopped rule still mask? → A: No — it cannot finish, so it cannot
  mask. The mark in Settings says so.

## User Scenarios & Testing

### User Story 1 - A bad plugin rule cannot freeze the app (Priority: P1)

As an operator who installed a plugin, I need capture to keep working if one of
its loot patterns backtracks catastrophically.

**Independent Test**: With a `(a+)+$` plugin rule and a hostile input, a scan
returns within seconds with every other rule's matches.

### User Story 2 - I can see which rule was stopped (Priority: P1)

**Independent Test**: The stopped rule is reported by the rule list and marked
in Settings; it is not run again.

### User Story 3 - Fixing the plugin restarts the rule (Priority: P2)

**Independent Test**: Unregistering and re-registering the plugin clears the
stop.

### Edge Cases

- A worker that starts slowly on a loaded machine must not be read as a rule
  timeout.
- If several rules would overrun, each is stopped in turn; the loop ends when
  none remain.

## Requirements

- **FR-001**: Plugin loot rules MUST run under a time bound that the main
  process enforces without waiting for the regex to finish.
- **FR-002**: The rule running when the bound is hit MUST be stopped and the
  remaining rules' results MUST still be returned.
- **FR-003**: A stopped rule MUST be reported by `listLootRules()` and marked in
  Settings, including that it no longer masks.
- **FR-004**: Re-registering a plugin's rules MUST clear their stops.
- **FR-005**: Worker startup MUST NOT count against the bound.
- **FR-006**: Built-in rules' behaviour MUST be unchanged.

## Success Criteria

- **SC-001**: `test/loot-regex-time-bound.test.ts` passes; its RED run hung.
- **SC-002**: Existing loot suites pass unchanged, with plugin rules now in the
  worker.

## Assumptions

- A false stop under extreme load is possible and visible; it is recovered by
  reloading the plugin.
