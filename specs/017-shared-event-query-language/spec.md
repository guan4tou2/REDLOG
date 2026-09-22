# Feature Specification: Shared Event Query Language

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Draft
**Input**: Give Search and the Transcript one query language with structured identifier conditions, evaluate it at the persistence layer for both, and complete a tool pair whose halves sit on different pages.

Spec 007 unified the shared filter chips. Spec 008 gave Search a paged
full-text query. Spec 009 paginated the Transcript and closed with a deliberate
exception: its text box filters loaded blocks. Two surfaces now ask the same
question in two vocabularies, and one of them cannot answer "did this happen at
all". This feature makes the question one question.

## User Scenarios & Testing

### User Story 1 - Prove a term is absent from the engagement (Priority: P1)

As an operator, when I type a term in the Transcript and see nothing, I need
that to mean the term is absent from the whole filtered dataset — not absent
from the pages I happen to have loaded.

**Independent Test**: Seed a matching event older than the first page of every
bucket, type the term without pressing Load Older, and verify it is found.

### User Story 2 - Ask one question in one vocabulary (Priority: P1)

As an operator, I need a query I learned on one surface to mean the same thing
on the other, so I can carry an investigation between Search and the Transcript
without rewriting it.

**Independent Test**: Run the same query text on both surfaces over the same
shared filter and verify each returns the same underlying event set, differing
only in that surface's presentation and balance rules.

### User Story 3 - Follow an identifier to its evidence (Priority: P1)

As an operator holding an event ID, session ID or tool-use ID from elsewhere in
RedLog, I need a written condition that reaches exactly that evidence, wherever
it sits, without a near match being substituted for it.

**Independent Test**: Query each identifier for a record outside the first page
and verify the exact match is returned and nothing adjacent is.

### User Story 4 - See a whole tool pair (Priority: P1)

As an operator, when a query hits one half of a tool call/result pair, I need
the other half fetched so I read the exchange, not a fragment.

**Independent Test**: Place a call and its result in different pages, match the
result, and verify the call is retrieved by tool-use ID and shown as one pair.

### User Story 5 - See how my query was read (Priority: P2)

As an operator, I need to see which parts of what I typed became conditions and
which stayed plain text, so a mistyped field is visible rather than silently
demoted into a search term that matches nothing.

**Independent Test**: Enter a mistyped field prefix and verify the surface shows
it was read as text, not as a condition.

### User Story 6 - Tell a failure from an absence (Priority: P2)

As an operator, I need a failed query to stay distinct from a query that matched
nothing, because the two license opposite conclusions.

**Independent Test**: Reject the query and verify a failure with retry rather
than an empty result.

### Edge Cases

- Pasted text containing a colon, such as a URL, is matched literally and is
  not mistaken for a condition.
- An unrecognised field prefix is matched as text and reported as such.
- A tool-use counterpart that genuinely does not exist is stated as unpaired
  rather than left looking like a truncation.
- An identifier condition that matches nothing is distinct from one that could
  not be parsed.
- Clearing the query restores the unqueried paged view with no stale rows.
- A query change and a shared-filter change both restart pagination.
- Events arriving during a query do not reorder or duplicate loaded results.
- A term matching only evidence excluded by the shared filter stays unmatched.
- A query with only conditions and no terms is valid.

## Requirements

- **FR-001**: Search and the Transcript MUST accept the same query text and
  derive the same event selection from it under the same shared filter.
- **FR-002**: A query MUST be evaluated at the persistence layer across the
  whole shared-filter dataset, on both surfaces.
- **FR-003**: The language MUST support event ID, session ID and tool-use ID as
  exact conditions, and MUST remain extensible to further fields without
  changing the meaning of existing queries.
- **FR-004**: A token whose prefix is not a recognised field MUST be matched as
  literal text, so ordinary pasted content keeps working.
- **FR-005**: Each surface MUST show which parts of the query were read as
  conditions and which as text.
- **FR-006**: Structured conditions and free text in one query MUST all apply
  together; a condition MUST NOT be weakened into a substring match.
- **FR-007**: A query MUST preserve each surface's existing completeness
  contract, including the Transcript's per-bucket balance, `hasMore` and cursor.
- **FR-008**: When a matched tool call or result has a counterpart outside the
  loaded set, that counterpart MUST be retrieved by tool-use ID and presented
  as one pair.
- **FR-009**: A pair whose counterpart cannot be retrieved MUST be shown as
  explicitly incomplete; one half MUST NOT be presented as a whole exchange.
- **FR-010**: Every displayed result MUST keep the source occurrence time and
  the RedLog receipt time distinguishable.
- **FR-011**: Query failure, no match, unparsable query and not-yet-indexed
  MUST remain distinct states, each carrying its recovery action.
- **FR-012**: Clearing the query MUST restore the unqueried first page without
  rows from the query result set.
- **FR-013**: The completeness indicator MUST describe the dataset the current
  query actually covers.
- **FR-014**: A filter that still operates only over loaded evidence MUST say
  so where it is offered.
- **FR-015**: Queries that were valid on Search before this feature MUST keep
  returning the same event set.

## Success Criteria

- **SC-001**: A term present only in evidence older than every bucket's first
  page is found without loading older pages first.
- **SC-002**: The same query text on Search and on the Transcript selects the
  same underlying events under the same shared filter.
- **SC-003**: A tool-use ID condition returns both call and result when they
  sit on different pages.
- **SC-004**: A pasted URL is matched literally and produces no condition.
- **SC-005**: Matched-nothing, failed, and unparsable are distinguishable on
  screen without reading logs.
- **SC-006**: Clearing the query yields exactly the pre-query first page.
- **SC-007**: Transcript results stay balanced across buckets; one high-volume
  type cannot starve the others.

## Assumptions

- One canonical query implementation serves both surfaces. Neither surface
  keeps a private text-matching path.
- Flow ID and transcript UUID are not conditions in this feature. The language
  must accommodate them later without changing existing query meanings.
- Kind filters remain local to loaded evidence and are labeled accordingly;
  text and identifier conditions move to the persistence layer.
- This feature supersedes the local-text-filter exception recorded in Spec 009
  and replaces Search's private query handling from Spec 008.
