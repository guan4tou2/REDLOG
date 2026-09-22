# Implementation Plan: Shared Event Query Language

## Technical Context

- Spec 007 established `EventFilter` and `toEventFilter` as the one shared
  predicate mapping for target, type, time and scope.
- Spec 008 gave Search `searchEventsPage(opts: EventFilter & { query, limit,
  cursor })`, which applies the shared predicates before its limit over the
  chained and logged tiers. The query string itself is handled privately there.
- Spec 009 gave the Transcript per-bucket cursors, `hasMore` and visible
  complete / recent-subset / failed states, with its text box left filtering
  loaded blocks.
- Tool call/result pairing is currently a projection over the loaded set.
- The chip filter and the typed query are different inputs to the same
  selection and must compose, not compete.

## Constitution Check

- **Canonical Domain Semantics**: the query language and its evaluation get one
  implementation that both surfaces consume. This is the principle the feature
  exists to satisfy; today Search and the Transcript interpret typed text
  independently.
- **Query Completeness**: evaluation stays at the persistence layer beneath each
  surface's limit; per-bucket `hasMore` and cursors survive unchanged.
- **Surface Truthfulness**: the parse is shown, not assumed — the operator sees
  which tokens became conditions; the completeness indicator describes the
  queried dataset.
- **Explicit Failure**: unparsable, failed, no-match and not-yet-indexed are
  four states, not one empty list.
- **Evidence Provenance**: a retrieved counterpart cites the tool-use ID that
  found it; source and receipt time stay distinguishable; an unretrievable
  counterpart is disclosed.
- **Risk-Based Test-First Verification**: parser counterexamples, identifier
  resolution, cross-page pairing and Search non-regression begin as tests that
  fail for the intended reason.
- **Architectural Restraint**: a new module seam needs a present variation. The
  variation is concrete: two surfaces evaluating typed text differently, plus
  three identifier conditions that neither can express today. The seam is a
  query contract over the existing SQLite path — not a new store, engine or
  framework, and not a language beyond the fields named in the spec.

## Design

1. Define the query contract: parse text into recognised conditions plus
   residual free text, with unrecognised prefixes staying text.
2. Evaluate the contract at the persistence layer beneath each caller's own
   filter, limit and cursor, so both surfaces keep their pagination shape.
3. Move Search onto the contract without changing the event set its existing
   queries select.
4. Move the Transcript's text box onto the contract, once per bucket, keeping
   balance, `hasMore` and cursor.
5. Return the parse alongside results so each surface can show how the query
   was read.
6. Complete absent tool counterparts by tool-use ID; mark pairs that stay
   unresolved.
7. Keep source and receipt time separate through the block projection.
8. Restart cursors on query and filter change; restore the unqueried view when
   the query is cleared.
9. Record the supersession in Specs 008 and 009 and update the domain glossary
   with the query-language terms.

## Gate

Parser counterexamples, identifier resolution, cross-page pairing, the four
failure states, Search non-regression, typecheck, the full suite, build, and
the Search and Transcript desktop journeys must pass before Verified.
