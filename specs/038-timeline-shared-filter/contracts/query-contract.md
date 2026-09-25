# Contract delta: Search Query Semantics and Target Identity

These are the changes this feature makes to the living domain contracts.
The tasks update [SPEC-search-query-semantics](../../../docs/domain/SPEC-search-query-semantics.md),
[SPEC-target-identity](../../../docs/domain/SPEC-target-identity.md) and
[SPEC-export-event-selection](../../../docs/domain/SPEC-export-event-selection.md)
to say this. This file is the review copy. Once T049–T051 land, the domain
documents are authoritative and this file is history.

## Search Query Semantics

### Parsing

- Rule 2: `operator` joins the recognised fields: `event`, `session`,
  `transcript`, `tool`, `operator`.

### Evaluation

- Rule 2: `operator:` is the recorded operator id (`operator_id`), never a
  display name, and never text.
- Rule 9 gains the tier: `tier: 'chained'` excludes the logged tier. It is a
  shared-filter condition like scope and personal traffic, applied inside each
  tier's SQL before the limit. Rule 7 ("Both tiers, always") now reads "both
  tiers unless the shared filter asks for chained only".
- New rule, *Counting*: `countEvents` counts with the same predicates as the
  page it describes, including the cursor, so "N earlier" and the page cannot
  disagree.
- New rule, *Matching given rows*: `matchEventIds` evaluates the same predicates
  restricted to given ids. It serves surfaces that must dim or admit rows they
  already hold.
- Rule 13: the Timeline pages with `hasMore`, states "N of M", and states how
  many text matches lie past what it has drawn.

### Coverage

- The Timeline joins Search, the Transcript, the ⌘K palette and
  `/api/events/search` on the contract. The palette and the API still apply no
  shared filter.

### The Timeline's empty text (FR-008)

The Timeline's filter box with no text is a browse, not a query: it shows every
event the shared filter admits. Rule 5 ("nothing asked, nothing answered")
still holds for every query. The Timeline sends no query when its text is
empty.

### Housekeeping

`excludeHousekeeping` drops RedLog's own plumbing rows (`HOUSEKEEPING_SQL`).
The Timeline sets it on its page, count, match and nearest-match requests.
Search does not.

## Target Identity

- Every target predicate compares case-insensitively (`COLLATE NOCASE`), through
  one helper. The invariant

  ```
  aggregateTargets().find(t => t.target ≈ T).eventCount == queryEvents({ targetId: T }).length
  ```

  now holds for a target recorded in two casings. `≈` is the case-insensitive
  match the aggregate already grouped by.
- The Timeline no longer matches a target on `data.host`, `remote_addr`,
  `dest_ip`, `dest_host`, `detectedTarget` or `target`. Its target is the shared
  filter's, and the shared filter's is `target_id`.
- Scenario 3 (case-insensitive grouping) gains its filtering half. Scenario 5
  (`hostCausalChain`) was removed with the function in #143.

## Export Event Selection

- A `time-range` subset with `targetId` selects every casing of that target:
  the export resolver reads through the one target predicate. Preview and
  execute resolve through the same plan, so they still agree (Constitution V).
  Nothing else about selection changes.
