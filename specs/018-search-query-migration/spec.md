# Feature Specification: Search on the Shared Query Contract

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Verified
**Depends on**: Spec 017 (Verified)
**Input**: Move Search onto the query contract Spec 017 defined, so one query text means one thing on both surfaces, without changing the events any currently valid Search query selects.

Spec 008 gave Search a paged full-text query that interprets its query string
privately. Spec 017 defined a shared query language and proved it on the
Transcript. Until Search adopts it, an operator who learns a query on one
surface cannot carry it to the other, and the identifier conditions exist on
only one of the two places an investigation starts.

This feature has one risk and it is not a feature risk: Search's behaviour is
already Verified, and operators rely on it. Non-regression is therefore the
first phase of work, not the closing check.

## User Scenarios & Testing

### User Story 1 - Carry a query between surfaces (Priority: P1)

As an operator, I need a query I wrote on one surface to select the same
evidence on the other, so an investigation moves without being rewritten.

**Independent Test**: Run the same query text on Search and the Transcript under
the same shared filter and verify each reaches the same underlying events,
differing only in that surface's presentation and balance rules.

### User Story 2 - Keep the queries I already use (Priority: P1)

As an operator, I need the queries I run today to keep returning what they
return today, so adopting the language costs me nothing I already have.

**Independent Test**: Replay a corpus of queries valid before this change and
verify each selects the same event set after it.

### User Story 3 - Reach an identifier from Search (Priority: P2)

As an operator starting from Search, I need the same identifier conditions the
Transcript has, so the entry point does not decide what I can ask.

**Independent Test**: Resolve each identifier condition from Search and verify
it matches what the Transcript resolves for the same input.

### Edge Cases

- A query that was plain text before and now parses as a condition is identified
  during migration and its change of meaning is decided deliberately, not
  discovered by an operator.
- Search's own result presentation and cast search remain unchanged.
- A saved or recently used query, if any exists, keeps working.

## Requirements

- **FR-001**: Search MUST evaluate queries through the Spec 017 contract, with
  no private text-matching path remaining.
- **FR-002**: Every query valid before this change MUST select the same event
  set after it, or its changed meaning MUST be explicitly recorded and accepted.
- **FR-003**: Search MUST support every condition the contract defines, with the
  same resolution semantics as the Transcript, including session scoping for
  tool-use IDs.
- **FR-004**: Search MUST show which parts of the query were read as conditions
  and which as text.
- **FR-005**: Search MUST preserve its existing completeness, failure, partial
  and not-yet-indexed states from Specs 008 and the search-integrity work.
- **FR-006**: The same query text and shared filter MUST select the same events
  on both surfaces.

## Success Criteria

- **SC-001**: A recorded corpus of pre-migration queries selects identical event
  sets post-migration.
- **SC-002**: The same query text on both surfaces selects the same events.
- **SC-003**: Every identifier condition resolves identically on both surfaces.
- **SC-004**: Search's existing state distinctions remain observable.

## Assumptions

- Spec 017 is Verified before this work begins; this feature adds no conditions
  to the language.
- Search's result rendering, cast search and shared-filter behaviour are out of
  scope except where the contract requires them to change.
