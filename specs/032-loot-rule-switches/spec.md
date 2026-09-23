# Feature Specification: Loot Rule Switches

**Feature Branch**: `feat/loot-rule-switches`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Let operators switch off individual loot rules, and ship the two noisiest built-ins off, without letting "don't record it" become "don't mask it".

Plugin loot rules could be removed only by disabling their whole plugin; the
built-in rules could not be switched off at all. Two built-ins produce most of
the noise in a real engagement: `jwt` matches every bearer header in proxied
HTTP traffic, and `generic_api_key` matches `password=` and `token:` in help
text, error messages and command-line flags.

## User Scenarios & Testing

### User Story 1 - Switch off a noisy rule (Priority: P1)

As an operator, I need to turn off one loot rule — built-in or from a plugin —
so the Loot page lists findings, not noise.

**Independent Test**: Settings ▸ Capture shows one switch per rule; a switched
off rule writes no loot row.

### User Story 2 - Switching a rule off never unmasks it (Priority: P1)

As an operator handing over evidence, I need a secret that no longer counts as
loot to stay masked.

**Independent Test**: With `jwt` off, a command output containing a JWT has no
loot row and still carries a redaction span.

### User Story 3 - Quieter by default (Priority: P2)

**Independent Test**: A new project's config has
`loot.disabledRules = ['jwt', 'generic_api_key']`.

### Edge Cases

- A plugin rule's id is `pluginId:patternName`; an unnamed plugin rule's
  name is `${type}#${index}`, so its id changes if the plugin reorders rules.
- Rules the operator has not seen (a newly installed plugin) are on.
- If the rule list cannot be loaded, Settings says so instead of showing none.

## Requirements

- **FR-001**: Every rule MUST have a stable id: the built-in's `type`, or
  `pluginId:patternName`.
- **FR-002**: `loot.disabledRules` MUST stop a rule's matches being recorded or
  reported as loot (`scan`, `emit`, clipboard loot types, `/api/loot/scan`).
- **FR-003**: A switched-off rule MUST still match for redaction.
- **FR-004**: The default MUST be `['jwt', 'generic_api_key']`.
- **FR-005**: The setting MUST apply on project open and on config save.

## Success Criteria

- **SC-001**: `loot-rule-switches` and `loot-rules-group` pass.

## Assumptions

- Project custom rules are out of scope: they need a time bound on regex
  execution first (see Spec 031 research).
- Confidence semantics are unchanged: a `medium` match of a rule that is on is
  still recorded.
