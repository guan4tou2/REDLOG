# Feature Specification: Trustworthy Export Preview and Execution

**Feature Branch**: `001-export-plan-consistency`

**Created**: 2026-09-19

**Status**: Verified

**Input**: Ensure every export preview describes the same selected evidence,
policy, attachments, and dataset boundary that execution will produce.

**Domain References**:

- `docs/domain/glossary.md`
- `docs/domain/SPEC-export-event-selection.md`
- `.specify/memory/constitution.md` principles I, II, V, VI, and VII

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Confirm the Actual Delivery Set (Priority: P1)

As an operator preparing evidence for a client or blue team, I can review an
export preview whose counts and policies describe the artifact that will be
created when I confirm.

**Why this priority**: A mismatch can disclose excluded data or omit evidence
after the operator has approved a different delivery set.

**Independent Test**: Prepare a project containing in-scope, out-of-scope,
personal, do-not-export, sanitized, attachment-bearing, chained, and logged
events. Preview and execute each supported export, then compare the preview,
artifact contents, and final manifest.

**Acceptance Scenarios**:

1. **Given** a selected export format and policies, **When** the operator opens
   its preview and confirms without changing data, **Then** every displayed
   included, excluded, masked, and attachment count matches the artifact.
2. **Given** an export is limited to a visible time or target subset, **When**
   it is previewed, **Then** the preview counts only that subset.
3. **Given** both evidence tiers contain eligible events, **When** an export
   format promises complete event coverage, **Then** preview and execution
   include eligible events from both tiers.

---

### User Story 2 - Understand Every Applied Policy (Priority: P1)

As an operator, I can see which scope, sharing, exclusion, sanitization, and
attachment policies will apply before confirming an export.

**Why this priority**: A single toggle must not imply protection that the
selected export format does not actually implement.

**Independent Test**: Configure each policy independently and in combination,
then verify that preview labels, output contents, and the final manifest agree.

**Acceptance Scenarios**:

1. **Given** sharing protections are enabled, **When** a format does not
   support one of those protections, **Then** confirmation is blocked or the
   unsupported policy is explicitly identified before execution.
2. **Given** an attachment cannot be safely filtered by target, **When** it is
   included, **Then** the preview and manifest identify it as unattributed or
   unfiltered rather than claiming it is in scope.
3. **Given** an event is marked personal or do-not-export, **When** any
   delivery export is produced, **Then** its exclusion is counted and recorded.

---

### User Story 3 - Detect Dataset Changes (Priority: P2)

As an operator, I am not allowed to unknowingly approve one dataset and receive
an artifact generated from a materially different dataset.

**Why this priority**: RedLog records live activity, so new Events may arrive
between preview and confirmation.

**Independent Test**: Open a preview, add or amend eligible evidence, confirm
the export, and observe either snapshot-consistent output or an explicit change
notice with refreshed counts.

**Acceptance Scenarios**:

1. **Given** the underlying eligible dataset changes after preview, **When**
   the operator confirms, **Then** RedLog either exports the previewed snapshot
   or requires acknowledgement of the newly resolved selection.
2. **Given** only unrelated data changes, **When** the selected export is
   confirmed, **Then** RedLog does not claim that the selected dataset changed.
3. **Given** the export can no longer be resolved, **When** confirmation is
   attempted, **Then** RedLog reports failure and produces no success state.

### Edge Cases

- The selection is empty after all exclusion policies are applied.
- An event references a missing or unreadable Evidence attachment.
- A selected Event is amended, deleted by retention, or becomes unavailable
  between preview and execution.
- Scope is unconfigured, changes after preview, or contains explicit excludes.
- A single attachment relates to multiple targets with different scope status.
- Events share timestamps across chained and logged tiers.
- Export fails after some files are written but before the artifact is complete.
- The project receives high-volume events continuously during preview.

### Format Contract Matrix

| Format | Selection contract | Empty selection | Attachments |
|---|---|---|---|
| JSON | Complete eligible Events from both tiers at the approved snapshot | Confirmation is disabled; no artifact | Not included and disclosed as unsupported |
| NDJSON | Complete eligible Events from both tiers at the approved snapshot | Confirmation is disabled; no artifact | Not included and disclosed as unsupported |
| Evidence Bundle | Complete eligible Events from both tiers plus resolved Evidence files | Confirmation is disabled; no bundle directory | Included, missing and unattributed files counted separately |
| HAR | Logged-tier HTTP flows inside the approved time/target bounds | Confirmation is disabled; no HAR | Not applicable |
| Timeline slice | Events and amendments inside the approved time/target bounds | Confirmation is disabled; no slice | Not included and disclosed as unsupported |

“Same resolved selection” means the preview, execution result and manifest use
the same sorted Event IDs, two-tier row bounds, scope snapshot, policy outcomes,
attachment inventory and plan fingerprint. Event counts and Evidence attachment
counts are compared independently.

Masking changes exported field values while retaining the Event; sanitization
uses an approved replacement; exclusion removes an Event or Evidence item;
unsupported means the selected format cannot apply or carry that behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every export action MUST resolve an explicit selection of Events,
  Evidence attachments, and applicable policies before confirmation.
- **FR-002**: Preview and execution MUST use the same resolved selection and
  policy semantics.
- **FR-003**: A preview MUST identify the export format, selected subset,
  dataset boundary, scope state, sharing state, exclusion policies,
  sanitization policies, and attachment policies.
- **FR-004**: Preview MUST distinguish included, excluded, masked,
  unattributed, missing, and unsupported items.
- **FR-005**: Complete-event formats MUST evaluate both Chained Events and
  Logged Events unless the format explicitly documents a narrower contract.
- **FR-006**: View-specific exports MUST preview the same bounded view that
  execution uses, including all applicable time, target, and format filters.
- **FR-007**: If the selected dataset or policy changes after preview, RedLog
  MUST preserve the previewed dataset or require explicit acknowledgement of a
  newly resolved preview before execution.
- **FR-008**: An empty resolved selection MUST be shown before confirmation and
  MUST NOT produce a misleading successful evidence artifact.
- **FR-009**: Unsupported protection or attachment behavior MUST be disclosed
  before confirmation and MUST NOT be represented as applied.
- **FR-010**: Execution failure MUST be distinct from an empty export and MUST
  include an actionable reason without reporting success.
- **FR-011**: The final artifact or adjacent manifest MUST record the actual
  selection boundary and actual counts for inclusion, exclusion, masking,
  attachments, missing evidence, and policy exceptions.
- **FR-012**: Preview failure MUST block confirmation; it MUST NOT fall back to
  an unreviewed export action.
- **FR-013**: Existing source Events and Evidence MUST remain unchanged by
  preview and export.
- **FR-014**: All export formats exposed by the application MUST either comply
  with this contract or explicitly declare their narrower selection semantics.
- **FR-015**: A resolved plan MUST be single-use, bound to the active project,
  kept only in main-process memory, expire 15 minutes after resolution, and be
  invalid after application restart. Expiry, restart, project switching, or a
  second execution attempt MUST require a new preview.
- **FR-016**: The confirmation surface MUST trap focus while open, support
  keyboard navigation, close or return one level on Escape, expose loading via
  an accessible busy state, expose failures as alerts, and keep confirmation
  disabled while loading, after failure, or for an empty selection.
- **FR-017**: If execution fails after creating part of an output, RedLog MUST
  not return that path as a completed artifact or display success. Any partial
  path that cannot be removed MUST be visibly marked incomplete and excluded
  from the result manifest.
- **FR-018**: Dataset mutations after preview have these outcomes: later inserts
  are excluded by the approved row bounds; disappearance or mutation of a
  selected Event or Evidence file rejects execution; project or policy/scope
  changes reject execution unless the plan already contains the complete frozen
  policy input needed by that adapter; amendments follow the same approved
  selection rule as their source view.
- **FR-019**: Legacy export handlers MAY remain for callers not yet migrated,
  but only `data:resolveExportPlan` followed by `data:executeExportPlan` may be
  labelled or presented as an approved-preview export.

### Key Entities

- **Export Request**: The operator's chosen format, subset, and policies before
  resolution.
- **Resolved Export Selection**: The immutable description of eligible Events,
  attachments, policy outcomes, and dataset boundary approved by the operator.
- **Export Preview**: A human-readable projection of the resolved selection.
- **Export Result**: The artifact outcome, actual counts, failures, and policy
  exceptions produced from an approved selection.
- **Dataset Boundary**: The point or immutable criterion that separates the
  approved data from later project changes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every supported export format, preview included count equals
  the number of exported Events when the selected dataset is unchanged.
- **SC-002**: Every excluded, masked, missing, unattributed, or unsupported item
  is represented in both preview and final result with no silent category.
- **SC-003**: In automated change-between-preview scenarios, 100% of exports
  either preserve the approved dataset or require a refreshed acknowledgement.
- **SC-004**: A failed preview or failed execution produces zero false success
  notifications in automated UI and integration tests.
- **SC-005**: Operators can determine the selected subset and all active
  delivery protections from the confirmation screen without consulting source
  code or external documentation.
- **SC-006**: Existing JSON, NDJSON, HAR, Evidence Bundle, and Timeline slice
  exports retain their documented valid use cases after migration.
- **SC-007**: Resolving a preview over 100,000 Events completes without sending
  full Event payloads to the renderer; the renderer receives only counts,
  policy metadata, boundaries and an opaque plan identifier.
- **SC-008**: Keyboard-only tests can open the export menu, select a format,
  observe loading or an error, return with Escape, and keep focus within the
  open surface.

## Assumptions

- This feature changes export selection and trust semantics, not the contents
  of the immutable source database.
- Existing domain contracts remain authoritative unless this feature records an
  explicit, reviewed amendment.
- Formats may have different capabilities, but capability differences must be
  explicit before confirmation.
- A bounded snapshot may be represented by stable selection criteria rather
  than duplicating all selected data, provided execution cannot silently widen
  or narrow the approved result.
- The feature does not add cloud delivery, case management, report authoring,
  or a new export format.

## Authority and Lifecycle

`docs/domain/SPEC-export-event-selection.md` is authoritative for Event and
Evidence eligibility semantics. This feature owns only resolution lifecycle,
preview projection, execution binding and result reporting. If the two differ,
the domain specification must be amended first and this feature must reference
that reviewed amendment.

From the operator's perspective, approval begins when preview resolution
succeeds and ends on the first execution attempt, after 15 minutes, when the
active project changes, or when the application restarts. A failed or consumed
plan is never silently retried; the UI returns the operator to a fresh preview.
