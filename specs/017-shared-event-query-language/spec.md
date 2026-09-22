# Feature Specification: Shared Event Query Language

**Feature Branch**: `feat/option-d-export-presets`
**Created**: 2026-09-22
**Status**: Draft
**Input**: Define one event query language of structured conditions plus free text, evaluate it at the persistence layer, and make the Transcript its first consumer — including identifier lookup and completion of a tool pair whose halves sit on different pages.

Spec 007 unified the shared filter chips. Spec 008 gave Search a paged
full-text query whose query string it interprets privately. Spec 009 paginated
the Transcript and closed with a deliberate exception: its text box filters
loaded blocks, so it cannot answer "did this happen at all". Neither surface can
express "this session", "this tool call", or "this transcript".

This feature defines the language and proves it on the Transcript, which has no
existing backend query behaviour to regress. Spec 018 then moves Search onto it.

## User Scenarios & Testing

### User Story 1 - Prove a term is absent from the engagement (Priority: P1)

As an operator, when I type a term in the Transcript and see nothing, I need
that to mean the term is absent from the whole filtered dataset — not absent
from the pages I happen to have loaded.

**Independent Test**: Seed a matching event older than the first page of every
bucket, type the term without pressing Load Older, and verify it is found.

### User Story 2 - Follow an identifier to its evidence (Priority: P1)

As an operator holding an event ID, session ID, tool-use ID or transcript UUID
from elsewhere in RedLog, I need a written condition that reaches exactly that
evidence, wherever it sits, without a near match being substituted for it.

**Independent Test**: Query each identifier for a record outside the first page
and verify the exact match is returned and nothing adjacent is.

### User Story 3 - Resolve a tool-use ID that is not globally unique (Priority: P1)

As an operator pasting a tool-use ID, I need the result to be one unambiguous
tool exchange, and I need to see which session it was resolved within, because
the same tool-use ID can occur in more than one session.

**Independent Test**: Seed the same tool-use ID in two sessions, query it, and
verify one exchange is shown with its session stated rather than two exchanges
silently merged.

### User Story 4 - See a whole tool pair (Priority: P1)

As an operator, when a query hits one half of a tool call/result pair, I need
the other half fetched so I read the exchange, not a fragment.

**Independent Test**: Place a call and its result in different pages, match the
result, and verify the call is retrieved and shown as one pair.

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

- The same tool-use ID occurring in two sessions resolves to one exchange with
  its session disclosed, never to a merged or arbitrary one.
- A tool-use condition written together with a session condition resolves
  within that session, using the agent session both share.
- RedLog's internal capture session is not addressable by any condition; a
  session condition never resolves against it.
- Pasted text containing a colon, such as a URL, is matched literally and is
  not mistaken for a condition.
- An unrecognised field prefix is matched as text and reported as such.
- A tool counterpart that genuinely does not exist is stated as unpaired rather
  than left looking like a truncation.
- An identifier condition that matches nothing is distinct from one that could
  not be parsed.
- Clearing the query restores the unqueried paged view with no stale rows.
- A query change and a shared-filter change both restart pagination.
- Events arriving during a query do not reorder or duplicate loaded results.
- A term matching only evidence excluded by the shared filter stays unmatched.
- A query with only conditions and no terms is valid.

## Requirements

- **FR-001**: A Transcript query MUST be evaluated at the persistence layer
  across the whole shared-filter dataset, not over loaded blocks.
- **FR-002**: The query language and its evaluation MUST be defined as one
  contract independent of the calling surface, so a second surface can adopt it
  without changing what existing queries mean.
- **FR-003**: Event ID, session ID and transcript UUID MUST resolve as exact,
  project-wide conditions. A session condition MUST resolve the agent session
  recorded on the event, not RedLog's per-process capture session — the two are
  different identifiers that share a name, and only the first is what an
  operator holds.
- **FR-004**: A tool-use ID MUST resolve within a single session, because it is
  unique only within one. When no session is given, the surface MUST resolve one
  session and state which; it MUST NOT merge occurrences from several sessions
  or choose one silently.
- **FR-005**: A token whose prefix is not a recognised field MUST be matched as
  literal text, so ordinary pasted content keeps working.
- **FR-006**: Each surface MUST show which parts of the query were read as
  conditions and which as text.
- **FR-007**: Structured conditions and free text in one query MUST all apply
  together. A condition MUST resolve against the stored field; it MUST NOT be
  satisfied by a text match on that value appearing anywhere in the record.
- **FR-008**: A query MUST preserve the Transcript's per-bucket balance and MUST
  expose `hasMore` and a cursor per bucket exactly as the unqueried view does.
- **FR-009**: When matched tool calls or results have counterparts outside the
  loaded set, those counterparts MUST be retrieved for the page as a whole
  rather than one lookup per unpaired record.
- **FR-010**: A pair whose counterpart cannot be retrieved MUST be shown as
  explicitly incomplete; one half MUST NOT be presented as a whole exchange.
- **FR-011**: Every displayed result MUST keep the source occurrence time and
  the RedLog receipt time distinguishable.
- **FR-012**: Query failure, no match, unparsable query and not-yet-indexed
  MUST remain distinct states, each carrying its recovery action.
- **FR-013**: Clearing the query MUST restore the unqueried first page without
  rows from the query result set.
- **FR-014**: The completeness indicator MUST describe the dataset the current
  query actually covers.
- **FR-015**: A filter that still operates only over loaded evidence MUST say
  so where it is offered.

## Success Criteria

- **SC-001**: A term present only in evidence older than every bucket's first
  page is found without loading older pages first.
- **SC-002**: Each identifier condition returns the exact record for evidence
  outside the first page.
- **SC-003**: A tool-use ID present in two sessions yields one exchange with its
  session visible.
- **SC-004**: A tool-use condition returns both call and result when they sit on
  different pages.
- **SC-005**: A page completes its pairs in a bounded number of lookups that
  does not grow with the number of unpaired records.
- **SC-006**: A pasted URL is matched literally and produces no condition.
- **SC-007**: Matched-nothing, failed, and unparsable are distinguishable on
  screen without reading logs.
- **SC-008**: Clearing the query yields exactly the pre-query first page.
- **SC-009**: Transcript results stay balanced across buckets; one high-volume
  type cannot starve the others.

## Assumptions

- The Transcript is the contract's first consumer because it has no backend
  query behaviour to regress. Search moves onto the same contract in Spec 018;
  this feature does not change Search.
- Flow ID is not a condition here. Its natural entry point is HTTP History, and
  the language must admit it later without changing existing query meanings.
- Kind filters remain local to loaded evidence and are labeled accordingly;
  text and identifier conditions move to the persistence layer.
- This feature supersedes the local-text-filter exception recorded in Spec 009.
