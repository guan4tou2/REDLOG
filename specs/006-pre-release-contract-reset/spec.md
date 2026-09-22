# Feature Specification: Pre-release Contract Reset

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-21
**Status**: Verified
**Input**: Remove all compatibility retained solely for unreleased historical versions and move every active caller to the current canonical contract.

## User Scenarios & Testing

### User Story 1 - One current contract (Priority: P1)

As an operator, I need every current UI, CLI, hook, plugin and export path to
use the same current names and semantics so behavior does not depend on an
unreleased historical interface.

**Why this priority**: Parallel contracts allow semantic drift in capture and export.

**Independent Test**: Scan executable source and exercise public journeys; only current interfaces are accepted and every current journey succeeds.

**Acceptance Scenarios**:

1. **Given** a current caller, **when** it records, reads or exports evidence, **then** it uses the canonical interface without an alias or shim.
2. **Given** an unreleased historical route, command, capability or file path, **when** it is used, **then** it is rejected or absent rather than translated.

### User Story 2 - One current data shape (Priority: P1)

As a developer working before first release, I need fixtures and local projects
to use only the current event, signature, configuration and projection shapes.

**Why this priority**: Compatibility branches hide defects in the format that will actually ship.

**Independent Test**: A fresh project records, verifies, searches, displays and exports current evidence while legacy-only fixtures are absent.

**Acceptance Scenarios**:

1. **Given** a fresh project, **when** evidence is recorded and verified, **then** only the current hash, signature and event fields are accepted.
2. **Given** current UI state and configuration, **when** they are loaded, **then** no legacy key migration or previous-name fallback runs.

### User Story 3 - Honest specifications (Priority: P2)

As a maintainer, I need specifications and verification records to describe the
current contract and actual completed gates.

**Independent Test**: Spec, plan, tasks and verification agree with source and tests, with no unchecked readiness checklist on a Verified feature.

**Acceptance Scenarios**:

1. **Given** a feature marked Verified, **when** its artifacts are analyzed, **then** requirements map to completed tasks and current verification evidence.

### Edge Cases

- Operational fallbacks for unavailable networks, damaged optional manifests,
  and unknown current data remain; they are resilience behavior, not version compatibility.
- Historical names may appear in changelogs and audit documents as facts, but
  must not remain executable or be presented as supported.
- Test helpers may exist in test-only modules but must not expand the production API.

## Requirements

### Functional Requirements

- **FR-001**: Executable source MUST expose only current API, CLI, IPC, plugin and hook names.
- **FR-002**: Active callers MUST consume canonical interfaces directly rather than compatibility wrappers or re-exports.
- **FR-003**: Fresh persisted data MUST use only the current event, hash, signature, tier and configuration shapes.
- **FR-004**: Renderer state MUST use only project-scoped current storage keys and current event fields.
- **FR-005**: Export UI and execution MUST use the current ExportPlan contract without legacy execution handlers.
- **FR-006**: Production modules MUST NOT export helpers solely for old tests.
- **FR-007**: Resilience fallbacks MUST remain when they address runtime failure rather than historical versions.
- **FR-008**: Spec Kit artifacts MUST record current requirements, task coverage, RED evidence and final verification accurately.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Source inventory finds zero executable historical aliases, migrations, shims or compatibility re-exports.
- **SC-002**: All active callers compile against one current contract.
- **SC-003**: Current capture, search, timeline, bookmark, plugin and export journeys pass their relevant automated tests.
- **SC-004**: Typecheck, build and affected Electron journeys pass before status becomes Verified.
- **SC-005**: Every functional requirement maps to at least one explicit completed task and verification result.

## Assumptions

- RedLog has not made a public compatibility commitment and local development data may be recreated.
- Changelog and audit history remain truthful historical records.
- Runtime failure recovery and safe parser defaults are outside removal unless they explicitly accept an older contract.
