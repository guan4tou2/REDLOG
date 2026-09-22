# Implementation Plan: Shared Event Query Language

## Technical Context

- Spec 007 established `EventFilter` and `toEventFilter` as the one shared
  predicate mapping for target, type, time and scope.
- Spec 008 gave Search `searchEventsPage(opts: EventFilter & { query, limit,
  cursor })`, applying the shared predicates before its limit over the chained
  and logged tiers. It interprets the query string privately.
- Spec 009 gave the Transcript per-bucket cursors, `hasMore` and visible
  complete / recent-subset / failed states, with its text box filtering loaded
  blocks.
- Identifier storage differs per field, and so does the cost of querying it:
  `id` is the primary key; `session_id` and `transcript_uuid` are columns, and
  `transcript_uuid` already has `idx_events_transcript_uuid`; `tool_use_id`
  lives inside the `data` JSON with no index.
- `TranscriptView.buildBlocks` already keys tool pairing on
  `${session_id}:${tool_use_id}` — the composite is existing domain knowledge,
  not a new rule this feature invents.
- `timestamp` (source occurrence, with `ts_source` recording its provenance) and
  `created_at` (RedLog receipt) are both stored; only the projection drops one.
- `events_fts` / `events_logged_fts` index `data` as a single blob.

## Constitution Check

- **Canonical Domain Semantics**: the language and its evaluation get one
  implementation, defined independently of the surface calling it. This is the
  principle the feature exists to satisfy.
- **Query Completeness**: evaluation stays at the persistence layer beneath the
  caller's limit; per-bucket `hasMore` and cursors survive unchanged.
- **Surface Truthfulness**: the parse is shown, not assumed; a session-scoped
  tool resolution names its session; the completeness indicator describes the
  queried dataset.
- **Explicit Failure**: unparsable, failed, no-match and not-yet-indexed are
  four states, not one empty list.
- **Evidence Provenance**: a retrieved counterpart cites the composite key that
  found it; source and receipt time stay distinguishable; an unretrievable
  counterpart is disclosed.
- **Risk-Based Test-First Verification**: parser counterexamples, identifier
  resolution including the cross-session tool-use case, and batched pair
  completion begin as tests that fail for the intended reason.
- **Architectural Restraint**: the present variation is concrete — two surfaces
  interpreting typed text differently, and four identifier conditions neither
  can express. The seam is a query contract over the existing SQLite path, not
  a new store or engine, and not a language beyond the fields named in the spec.

## Design

1. Define the parse: recognised conditions plus residual free text, with
   unrecognised prefixes staying text.
2. Evaluate conditions and terms on **two paths that intersect**, not one. Free
   text goes to FTS; a condition resolves against its stored field as a SQL
   predicate. FTS indexes `data` as a blob, so an identifier is findable there
   as a token — satisfying a condition that way would be the substring match
   FR-007 forbids, and would match an ID mentioned inside unrelated output.
3. Index what the conditions need: `session_id`, and an expression index for
   `tool_use_id` within `data`. `id` and `transcript_uuid` are already served.
4. Resolve a bare tool-use condition to one session and report that session;
   a query carrying both conditions resolves within the given session.
5. Evaluate beneath the caller's own filter, limit and cursor, so the
   Transcript keeps its per-bucket pagination shape.
6. Return the parse alongside results so the surface can display it.
7. Complete absent tool counterparts **per page, in one batched lookup** keyed
   by the composite pairs the page is missing; mark pairs that stay unresolved.
8. Carry source and receipt time separately through the block projection.
9. Restart cursors on query and filter change; restore the unqueried view when
   the query is cleared.
10. Record the supersession in Spec 009 and add the query-language terms to the
    domain glossary.

## Gate

Parser counterexamples, identifier resolution including the cross-session
tool-use case, batched pair completion with a lookup count that does not grow
per unpaired record, the four failure states, typecheck, the full suite, build,
and the Transcript desktop journey must pass before Verified.
