# Feature Specification: Every Search on the Query Contract

**Feature Branch**: `feat/one-search-path`
**Created**: 2026-09-23
**Status**: Verified
**Input**: Finish what Spec 018 set out to do — one query text, one meaning — for the two search entry points it missed: the ⌘K command palette and the local API.

Spec 018 moved Search and the Transcript onto the query contract, so a query
learned in one means the same in the other. Two more places start an
investigation and still searched the old way, through `searchEvents`:

- **The ⌘K palette.** `session:S1` there was a full-text search for two words.
  A failed search was caught and shown as "no matches".
- **The local API** (`/api/events/search`), where scripts and external tools
  search. `session:API-S1` returned an empty list — not even the owning event.
  `session:` was searched for as text. A database error returned
  `{count: 0, events: []}`, indistinguishable from "nothing matched".

`searchEventsPage`, Search's pre-contract paged query, had no caller left but
two test files, and returned an empty page when its statement threw.

## User Scenarios & Testing

### User Story 1 - The palette speaks the same language (Priority: P1)

As an operator, I need a query I use in Search or the Transcript to mean the
same thing in the palette, and a failed palette search to say so.

**Independent Test**: An identifier typed in the palette reaches the store as a
condition; a rejected query shows a failure, not "no matches"; a half-typed
condition is not run.

### User Story 2 - Scripts get the same answers (Priority: P1)

As an operator scripting against the local API, I need the same query language
and an error when the query is malformed or the search fails.

**Independent Test**: `session:<id>` returns exactly that session's events; a
half-typed condition returns 400 with its reason.

### Edge Cases

- A query with neither text nor conditions — including a parsed `""` — answers
  nothing rather than returning an unfiltered page as "results".
- A conditions-only query remains valid.
- The palette's two-character minimum and debounce are unchanged.

## Requirements

- **FR-001**: The palette MUST search through the query contract.
- **FR-002**: The palette MUST distinguish a failed search and an unparsable
  query from no matches.
- **FR-003**: `/api/events/search` MUST search through the query contract,
  return 400 with the parse reason for an unparsable query, and 500 for a
  failed search.
- **FR-004**: A query with no text and no conditions MUST return an empty page.
- **FR-005**: `searchEventsPage` and the `events:search` channel MUST be
  removed; the pagination and body-search assertions written against the
  former MUST run unchanged against the contract.

## Success Criteria

- **SC-001**: No renderer or API search path calls `searchEvents`.
- **SC-002**: The ported pagination and body-search assertions pass unchanged.
- **SC-003**: A failed search is visibly distinct from no matches in the
  palette and in the API response.

## Assumptions

- The plugin host's `searchEvents` service is left to Spec 027, which removes
  the host; `searchEvents` loses its last caller there.
- Pre-release (Spec 006): API semantics change without a compatibility path.
