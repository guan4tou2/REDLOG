# Feature Specification: Export the complete filtered evidence selection

**Feature Branch**: `codex/evidence-workflow-completion`
**Created**: 2026-09-28
**Status**: Draft
**Input**: Continue F05 from the app audit: export must carry the investigation's actual filters, including HTTP method/status/text, without treating loaded pages or their timestamp envelope as the full result.

## User Scenarios & Testing

### User Story 1 - Hand over the investigation selection (Priority: P1)

The operator chooses between the entire project and the current investigation
selection before preview. The preview names the applied conditions and counts
all matching recorded events, including those not loaded on screen.

**Why this priority**: A handoff that silently widens or truncates the reviewed
selection can disclose unrelated work or omit evidence the recipient requested.

**Independent Test**: With matches beyond the loaded page, exporting the current
selection includes all eligible matches and no non-matches; exporting the whole
project deliberately uses the broader population.

**Acceptance Scenarios**:
1. Given target, type, time, scope, personal-traffic and tier conditions, choosing
   the current selection carries each condition into preview and execution.
2. Given multiple pages of matches, exporting without loading further pages
   includes the same eligible population as exporting after loading every page.
3. Given a supported typed query, matching exported events follow the same query
   meaning as investigation; an incomplete query prevents confirmation.
4. Given a control that changes only presentation (sorting, collapsing, lane
   visibility or highlighting), export does not silently interpret it as a
   selection. Its effect or non-effect is stated before confirmation.

### User Story 2 - Export exactly the selected HTTP exchanges (Priority: P1)

After filtering HTTP traffic, the operator can export the matching exchanges,
including request and response pairs, rather than all traffic between the
oldest and newest loaded row.

**Why this priority**: The current timestamp envelope loses method, status and
text predicates, admits unrelated traffic and excludes unloaded matches.

**Independent Test**: Seed matching exchanges beyond the first page and
non-matching exchanges inside the displayed time interval. Only matching
exchanges and their eligible request/response records appear in the artifact.

**Acceptance Scenarios**:
1. Given a method, status prefix, host and text filter, all four predicates are
   applied before the result is counted or paginated.
2. Given a selected request whose response arrives after the selected time
   interval, the exchange includes that response if it exists at preview time.
3. Given an unfinished or response-only exchange, export follows the same
   grouping and filter semantics as the HTTP view and does not invent data.
4. Given a non-matching shared type or chained-only view, export does not widen
   it into logged HTTP traffic.

### User Story 3 - Trust the preview and understand evidence limits (Priority: P1)

The operator reviews the selection, exclusions and attachment choices, then
gets the artifact represented by that preview. A subset is explicitly labelled
as a projection; it is never described as the complete original evidence chain.

**Independent Test**: After preview, insert matching records and change an
included attachment. New records are excluded by the preview boundary; the
changed attachment blocks execution instead of producing a different package.

**Acceptance Scenarios**:
1. New matching records after preview do not silently join the approved export.
2. Selection/read failure is distinct from a valid selection containing zero events.
3. A filtered evidence bundle records that it is a projection and preserves
   source identities; its verification instructions explain omitted chain rows.
4. A selected cast spanning multiple targets remains explicitly disclosed as
   an entire recording. Event filters do not imply that its bytes were trimmed.
5. Changing the current UI filters after preview does not alter the approved plan.

### Edge Cases

- Empty selection; unsupported format/policy; invalid query, interval or cursor.
- Same timestamp on distinct events, mixed target casing, unset scope and exclude-only scope.
- Matching response whose request lies outside the interval, or vice versa.
- A response-only exchange; malformed or absent flow identity; repeated flow updates.
- A raw value matches but sharing redaction removes its text: selection semantics
  and delivered redaction remain distinct and disclosed.
- Policy, project, evidence or attachment changes after preview.
- Large populations, duplicate source references, do-not-export and personal-domain exclusions.

## Requirements

### Functional Requirements

- **FR-001**: The operator MUST distinguish entire-project export from current-selection export before confirmation. Neither choice may be silently substituted.
- **FR-002**: Current-selection export MUST use all supported investigation predicates over the complete persisted population at preview time, across applicable event tiers, independently of loaded pages.
- **FR-003**: Typed query, target identity, time boundary, scope, personal-traffic and tier semantics MUST match the corresponding investigation contract.
- **FR-004**: HTTP method, status, host and text filtering MUST use one definition for both investigation and export. Exchange selection MUST precede pagination; selected pairs MUST preserve eligible request/response provenance.
- **FR-005**: The preview MUST identify the selection and applied conditions, exclusions, exact eligible event count and attachment choices. It MUST distinguish event counts from exchange counts.
- **FR-006**: Execution MUST use the approved selection, dataset boundary, policy and attachment identities. Later UI or data changes MUST NOT silently widen or narrow it.
- **FR-007**: JSON, NDJSON, Timeline and HAR MUST either support the requested selection or explicitly refuse it. A filtered evidence bundle MUST not claim full-chain completeness; verification guidance MUST correctly describe omitted records.
- **FR-008**: Existing privacy/redaction policies and attachment protections MUST continue to apply after selection. Casts MUST retain whole-session disclosure and per-file exclusion; this feature MUST NOT trim or rewrite source evidence.
- **FR-009**: Failed reads, invalid queries and unsupported combinations MUST be visible and retryable, distinct from a successful empty selection. No error may fall back to whole-project export.
- **FR-010**: Presentation-only controls MUST NOT silently become export predicates. Where a surface does not expose a complete exportable selection, the menu MUST state the limitation rather than infer selected IDs from loaded rows.
- **FR-011**: Export controls and selection summaries MUST be keyboard accessible, localized in English and Traditional Chinese, and usable at supported compact desktop widths.

### Key Entities

- Investigation selection: named event predicates, optional typed query and an explicit projection kind.
- HTTP exchange selection: shared predicates plus method, status prefix, host and text, applied to grouped exchanges.
- Approved export plan: resolved event identities, data boundary, policy, attachment inventory, count and fingerprint.
- Evidence projection: a declared subset retaining original record identities without claiming a complete source chain.

## Success Criteria

- **SC-001**: Every seeded predicate-combination case exports exactly its eligible selection, including matches beyond the initial page and excluding interleaved non-matches.
- **SC-002**: Loading more visible pages changes neither preview identity nor count when the source population and selection are unchanged.
- **SC-003**: For each supported format, the approved selection equals the delivered eligible event population; HTTP exchanges have no accidental half-pair loss at the selected time boundary.
- **SC-004**: Previewed exports reject evidence/attachment changes and never admit later matching rows without a fresh preview.
- **SC-005**: Desktop journeys cover whole-project/current-selection choice, zero results, failed preview and confirmation in both locales; compact layouts do not hide critical controls or conditions.

## Assumptions

- Existing export privacy and scope policies remain authoritative; a view filter
  cannot override do-not-export or personal-domain protection.
- A Timeline viewport is an explicit time selection. Its typed highlight box
  remains a presentation aid unless the operator explicitly chooses matching
  query results. Hidden lanes and collapse state are not evidence exclusion.
- Sorting affects reading order, not membership. Format-defined artifact order
  remains unchanged and is not promised to mirror the visible sort.
- Preserve the current local-first architecture and source evidence. No case
  management, automatic reporting, packet-capture engine or compatibility shim.
- Domain references: `docs/domain/SPEC-export-event-selection.md`,
  `docs/domain/SPEC-target-identity.md`, `docs/domain/glossary.md`, and Specs
  017/038 for query and shared-filter meaning. Any conflict is resolved in those
  contracts before implementation.
- Implementation must explicitly settle filtered-bundle verifier semantics
  before enabling that capability; a passing preview alone is insufficient.
