# Feature Specification: One Scope Classifier

**Feature Branch**: `refactor/one-scope-classifier`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Give scope classification one implementation, so the investigation filter, export masking, scope recompute and the live scope alarm cannot disagree about where a target sits.

The constitution names Scope evaluation as a rule that must have one canonical
implementation. Two exist. `evaluateScope` in `scope-evaluator.ts` answers the
investigation filter. `classifyScopeTarget`, living inside
`alert/policies.ts`, answers export masking, scope recompute and the live
alarm — so export masking depends on the alert subsystem to decide what is in
scope. The two agree on the in/out/excluded verdict for ordinary input, and
that agreement is an accident of their current code rather than a guarantee.

They already disagree in three places, and two of them lose protection:

- The adjacency rungs judge the raw subject. `evaluateScope` normalises first;
  `classifyScopeTarget` does not. `sub.example.com` next to an in-scope
  `example.com` is `adjacent_domain` (a warning); `SUB.EXAMPLE.COM`,
  `sub.example.com:8443`, `sub.example.com.` and
  `https://sub.example.com/login` are all `unrelated` (a notice, never alarmed
  on). The shell target extractor preserves case, so `curl
  https://Dev.Target.com/admin` next to an in-scope `target.com` raises no
  scope warning today. The same holds for `10.0.0.99:22` beside an in-scope
  `10.0.0.5`.
- A project with exclusions but no allowlist: `evaluateScope` answers
  `no-scope`, `classifyScopeTarget` answers `unrelated`.
- Export masking returned "not out of scope" for any project without an
  allowlist before it checked exclusions. An exclude-only project therefore
  exported its explicitly excluded targets unmasked, although the masking
  interface documents that exclusions always count as out of scope.

## User Scenarios & Testing

### User Story 1 - A near miss is warned about however it is written (Priority: P1)

As an operator, when I reach a host adjacent to my authorised scope, I need the
same warning whether the command named it in capitals, with a port, as a URL or
with a trailing dot, because how I happened to type a host says nothing about
whether I was allowed to touch it.

**Independent Test**: Classify one adjacent host in each written form and
verify every form yields the same distance and severity.

### User Story 2 - Every surface agrees about scope (Priority: P1)

As an operator, I need the investigation filter, export masking, scope
recompute and the live alarm to reach the same answer for the same target, so
an event I saw as in scope is not masked as out of scope on export, and a
recompute does not flag what the live path accepted.

**Independent Test**: Over a corpus of subjects and scope configurations,
verify the filter status and the distance classification never disagree.

### User Story 3 - Scope rules do not depend on alerting (Priority: P2)

As a maintainer, I need export masking to decide scope without importing the
alert subsystem, so changing or removing an alert policy cannot change what an
export masks.

**Independent Test**: Verify no scope classification is exported outside
`scope-evaluator.ts` and export masking does not import from `core/alert`.

### Edge Cases

- A project with no scope configured: every target is in scope, with unknown
  authority; the filter reports `no-scope`.
- A project with exclusions only: a non-excluded target is treated like
  `no-scope`, never as `unrelated`.
- An empty or unparsable subject remains out of scope.
- IPv6 and bracketed IPv6 with a port normalise to the bare address.
- A scope entry written in capitals matches a lowercase subject.
- Recompute over stored rows now classifies mixed-case, URL and port-bearing
  targets as the live path does after this change — which is to say it may
  flag rows the old classifier missed. That is the correction, not a
  regression.

## Requirements

- **FR-001**: Scope classification MUST have one decision procedure, in
  `scope-evaluator.ts`. The filter status and the distance MUST both derive
  from it.
- **FR-002**: The subject MUST be normalised once, before every rung —
  exclusion, allowlist and both adjacency rungs — and scope entries MUST be
  compared in the same normalised form.
- **FR-003**: A target that is not excluded, in a project with no allowlist,
  MUST be in scope with unknown authority in the distance view and `no-scope`
  in the filter view.
- **FR-004**: Authority and severity are alert semantics. They MAY be mapped
  from a distance inside the alert subsystem, but the alert subsystem MUST NOT
  decide the distance itself.
- **FR-005**: Export masking and any other non-alert module MUST NOT import
  scope classification from `core/alert`.
- **FR-006**: The live alarm and recompute MUST continue to produce the same
  verdict for the same stored row.
- **FR-007**: `ScopeSnapshot` MUST be declared once.
- **FR-008**: A guard test MUST fail if a second scope classifier is exported
  or if a non-alert module reaches into `core/alert` for scope.
- **FR-009**: `docs/domain/SPEC-scope-evaluation.md` MUST name the one
  classifier and its two views.
- **FR-010**: Export masking MUST mask an explicitly excluded target whether or
  not the project has an allowlist.

## Success Criteria

- **SC-001**: One adjacent host in bare, uppercase, trailing-dot, port and URL
  form yields one distance and one severity.
- **SC-002**: Over the test corpus, the filter status and the distance never
  disagree.
- **SC-003**: `curl https://Dev.Target.com/admin` beside an in-scope
  `target.com` produces a warning-severity scope verdict.
- **SC-004**: Export masking imports nothing from `core/alert`.
- **SC-005**: In an exclude-only project, an excluded target is masked on
  export and a non-excluded one is not.

## Assumptions

- Pre-release: per Spec 006 there is no compatibility shim; every caller moves.
- The alert floor, which distances are reportable, stays an alert decision.
