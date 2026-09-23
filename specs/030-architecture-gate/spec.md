# Feature Specification: Architecture Gate — Every Export Reachable

**Feature Branch**: `chore/verify-architecture-v2`
**Created**: 2026-09-23
**Status**: Verified
**Input**: The audit's gates were prose. Make "no dead or test-only code" a CI gate, and act on what it finds.

Constitution III (canonical modules) and the no-shims rule (Spec 006) were
enforced by review. Dead exports accumulated, and — worse — tests kept passing
against code production no longer ran: in three places production had grown
its own copy of the logic, so the tested function and the shipped one differed.

## Clarifications

### Session 2026-09-23

- Q: What counts as dead? → A: an export referenced by no other source file,
  not used inside its own file, and not used by tests (**unused**); or used only
  by tests (**test-only**).
- Q: How are real test seams allowed? → A: a `_` prefix; anything else needs an
  allowlist entry with a reason, and a stale entry fails the gate.
- Q: How is a reference found? → A: identifier names across every file's AST.
  A shared name can hide a finding (a miss) but cannot invent one, so the gate
  cannot flake.
- Q: What about canonical-module rules? → A: they stay in their own tests
  (scope classifier, secret table, ingest boundary); this gate is reachability.
- Q: What does the gate do with findings that need a product call? → A:
  allowlist them, with the question as the reason, and list them in the PR.

## User Scenarios & Testing

### User Story 1 - Dead and test-only code fails CI (Priority: P1)

**Independent Test**: `npm run verify:architecture` exits non-zero on an
unused or test-only export, and on a stale allowlist entry.

### User Story 2 - Tests exercise what ships (Priority: P1)

**Independent Test**: The PowerShell follower, Search's marker folding and the
full chain verify run through the functions their tests cover.

### Edge Cases

- A found bug is fixed, not allowlisted: the raw store kept writing into the
  previous project after a project switch; its cache reset existed but only
  tests called it.

## Requirements

- **FR-001**: CI MUST run the gate; it MUST fail on an unused or test-only
  export not in the allowlist, and on an allowlist entry that no longer
  matches.
- **FR-002**: Every current finding MUST be removed, wired into production,
  renamed as a `_` seam, or allowlisted with a reason.
- **FR-003**: Where production duplicated a tested function, production MUST
  call the tested one.
- **FR-004**: The raw store MUST write into the project that is open.

## Success Criteria

- **SC-001**: The gate passes on main with 11 allowlisted entries, each with a
  reason; 6 of them are product questions listed for decision.
