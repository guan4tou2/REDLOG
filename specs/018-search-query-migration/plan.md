# Implementation Plan: Search on the Shared Query Contract

## Technical Context

- Spec 017 defines the parse, the intersecting FTS/predicate evaluation, the
  identifier conditions and their per-field resolution semantics.
- Spec 008's `searchEventsPage` already applies the shared predicates before its
  limit across both tiers; what moves is the interpretation of the query string.
- Search carries state distinctions from the search-integrity work — query
  failure, partial cast failure, not-yet-indexed — that must survive unchanged.

## Constitution Check

- **Canonical Domain Semantics**: after this feature there is one query
  interpretation in the product. This is the principle the migration completes.
- **Evidence Integrity**: a change in what a query selects is a change in what
  the operator concludes from an absence, so any such change is recorded and
  accepted deliberately rather than shipped as a side effect.
- **Explicit Failure**: Search's four states stay distinct.
- **Surface Truthfulness**: the parse is shown on Search as it is on the
  Transcript.
- **Risk-Based Test-First Verification**: the non-regression corpus is written
  and failing-or-passing against the current implementation before the
  interpretation is replaced.
- **Architectural Restraint**: this feature removes an implementation rather
  than adding one.

## Design

1. Capture a non-regression corpus from the current Search implementation:
   query text, shared filter, and the event set selected.
2. Identify queries whose meaning the contract would change — principally text
   that now parses as a condition — and decide each one explicitly.
3. Replace Search's private query interpretation with the contract.
4. Surface the parse in Search.
5. Verify the corpus and the cross-surface equivalence.
6. Record the supersession in Spec 008.

## Gate

The non-regression corpus, cross-surface equivalence, Search's state
distinctions, typecheck, the full suite, build, and the Search desktop journey
must pass before Verified.
