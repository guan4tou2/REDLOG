# Research: Timeline on the Shared Filter

Every decision below is taken against the code as it stands on
`spec/033-timeline-shared-filter`. Where a decision corrects the spec, the spec
was edited in the same change.

## R1. The Timeline pages through the shared-filter page query

- **Decision**: The Timeline loads with `events:queryPage` (`queryEventsPage`):
  the shared filter, `excludeHousekeeping`, 200 rows a page, and the canonical
  keyset `(timestamp, rowid, tier)`. It stops using `events:query`.
- **Rationale**: `queryEventsPage` already applies every shared-filter predicate
  inside each tier's SQL, before the limit (`appendEventFilter`), and returns
  `hasMore` and `nextCursor` (FR-001, FR-002, Constitution IV). `events:query`
  applies none of them for the Timeline and pages on `created_at`, without a
  cursor or `hasMore`.
- **Keyset change**: `created_at` was chosen (v0.6.87 A1) so that a pager
  anchored on `min(timestamp)` did not skip a late row with an older timestamp.
  A keyset cursor pages strictly past its last row, so no row older than the
  cursor is skipped. A row that lands inside the drawn range arrives on
  `events:new-batch` and is added if it matches (R10).
- **Alternatives**:
  - Add filter options to `queryEvents`. Rejected: that makes a second paged
    implementation of the shared filter, with no cursor.
  - Filter loaded rows in the renderer, as today. Rejected: Constitution IV.

## R2. Tier is a shared-filter predicate, applied per tier arm

- **Decision**: Add `EventFilter.tier?: 'chained'`; absent means both tiers.
  `appendEventFilter` takes the arm it is building (`'chained' | 'logged'`) as
  a required argument. For the logged arm under `tier: 'chained'`, it emits a
  predicate that is always false. `SharedFilter.tier: 'all' | 'chained'` maps to
  it in `toEventFilter`.
- **Rationale**: every query that takes the shared filter honours it:
  `queryEventsPage`, `executeEventQuery` (Search, the Transcript, the Timeline's
  text), `queryHttpFlowPage` and Loot's `queryPage`. A required arm argument
  makes a caller that forgets it fail to compile, instead of ignoring the tier
  in silence (FR-011, Constitution III).
- **HTTP History** reads only `events_logged`. Under "Chained only" it shows a
  notice that the logged-tier flows are excluded, and an empty list. The chip is
  still lit, because the condition is applied, not ignored (US4 scenario 3,
  FR-012).
- **Not persisted**: `FilterProvider` mounts with the project, so the tier starts
  at "All tiers" on every open, like the other conditions. The Timeline's
  `redlog-timeline-auditor-view:<project>` key is no longer read (FR-011).
- **Alternatives**:
  - A per-function `tier` option, as `queryEvents` has. Rejected: the shared
    filter would then travel in two shapes.
  - A `'logged'` value. Rejected: the spec offers "All tiers" and
    "Chained only".

## R3. One case-insensitive target predicate

- **Decision**: one helper, `targetPredicate(column)` →
  `column = ? COLLATE NOCASE`. `appendEventFilter`, `queryEvents` (the Targets
  detail) and `queryHttpFlowPage` all use it in place of their own
  `target_id = ?`. A NOCASE index is added only if the 100k-row measurement
  (R13) needs it.
- **Rationale**: `aggregateTargets` groups `LOWER(target)`, and every filter
  compares case-sensitively. So a target recorded as both `Example.COM` and
  `example.com` breaks the documented invariant: the aggregate count equals the
  detail count ([SPEC-target-identity](../../docs/domain/SPEC-target-identity.md),
  Normalization: "compared lowercased"). SC-002 needs the invariant to hold.
- **Alternatives**:
  - Lowercase `target_id` at ingest. Rejected: chained rows hash `target_id`,
    and stored evidence must not change (Constitution I).
  - `LOWER(col) = LOWER(?)`. Same semantics for ASCII, but it cannot use an
    index.
- **Scope**: NOCASE folds ASCII only. Hostnames reach RedLog as ASCII
  (IDN as punycode), and IP addresses have no case, except IPv6 hex digits,
  which NOCASE folds correctly.
- **Export**: the `queryEvents` target branch is also the export resolver's
  (`src/main/ipc/data-export.ts`). So a time-range export limited to a target,
  such as HTTP History's HAR, now selects every casing: the same rows the view
  shows. Preview and execute both resolve through that one plan, so they stay
  equal (Constitution V). SPEC-export-event-selection records the change.

## R4. The Targets page sets the shared target

- **Decision**: "Open in Timeline" on the Targets page calls the shared
  filter's `setTargetId(target)` and then navigates. The following are removed:
  - App's `focusTarget`
  - the Timeline's `targetFocus` and its badge
  - `computeTargetMatches`, which matched seven fields
- **Rationale**: FR-005 and FR-006, and SC-002: the Targets count, the Timeline
  and the chip use one predicate.
- **Consequence**: the target stays set when the operator changes view, shown
  as the FilterBar chip, until cleared. App cleared its `focusTarget` on every
  navigation so it could not "silently narrow a later visit". A chip on every
  filtered view is not silent.

## R5. `/` text goes through the contract; drawn events are matched by id

- **Decision**: The Timeline parses its text with `parseQuery`, and shows the
  same read-out as Search (R9). Three states replace the substring search:
  - **Empty text**: no text condition. This is a Timeline rule, recorded in the
    domain contract (FR-008).
  - **Unparsable**: the read-out says so, and nothing is drawn as matched.
  - **Parsed**: the Timeline asks which drawn events match
    (`events:matchIds` → `matchEventIds`), counts the matches older than the
    drawn range (`events:count` with the Timeline's page cursor), and fetches
    the nearest earlier match (`events:runQuery`, `limit: 1`, same cursor).
    A failure in any of the three shows as a failure with retry.
- **Rationale**: one meaning per query text (FR-007, Constitution III). Matching
  by id avoids comparing positions across two orderings. It also bounds the
  work to what is drawn, and it covers live rows (R10). Counting from the
  Timeline's own cursor makes "earlier" exact, even for timestamps tied at the
  boundary.
- **Folded rows**:
  - A match on a row the Timeline hides counts as a match on the row that
    stands for it. A command start stands for its end. A collapsed agent turn
    stands for the session row it is collapsed under, when that row is drawn.
  - An amendment is drawn as its own row. A match on it also lights its marker,
    since the marker's shown title comes from the amendment.
  - A match with no drawn row to stand for it still counts, for example a turn
    in a session whose closing row has not arrived. The count line says it is
    hidden by the collapse.
  The fold index the Timeline already builds provides the mapping (FR-015,
  edge case).
- **A referenced row outside the filter**: `resolveReferencedEvent`, which
  follows an amendment to its marker, today inserts the fetched marker into the
  drawn rows. It first checks admission with `matchEventIds`. An excluded
  marker opens in the detail panel with the "outside the current filter" note,
  and is not drawn.
- **Counting**: the earlier-match count counts rows, housekeeping excluded. A
  marker and its amendment that both match count twice; the notice says
  "events".
- **Alternatives**:
  - Page the query over the drawn time window (`since` = oldest drawn
    timestamp). Rejected: rows tied on the boundary timestamp fall on both
    sides.
  - Reimplement FTS phrase semantics over loaded rows. Rejected: a second
    implementation of text matching.

## R6. Loading back to an event keeps the one contiguous range

- **Decision**: `loadBackTo(eventId)` pages back with the shared filter, 1,000
  rows a request, until the event is drawn. It shows progress, Esc cancels it,
  and it stops at the end of the data. Two things use it:
  - the earlier-match notice (US3 scenario 5)
  - "Open in Timeline" for an event older than the drawn range (edge case)
  Before loading, `matchEventIds([id], filter)` checks that the filter admits
  the event. If it does not, the Timeline says the event is outside the filter
  and loads nothing.
- **Rationale**: the axis, minimap and session bands all assume one contiguous
  range, newest drawn to oldest drawn. A windowed range would need newer-first
  paging, which the contract does not offer, and a way back to now.
  Constitution IX: no new model without measured need.
- **Known limit**: a match 100,000 admitted events back loads that many rows,
  as scrolling back does today. Narrowing the shared filter is the operator's
  lever, and the progress line says how far it has come.
- **Alternatives**:
  - A windowed jump. Rejected for now, for the reasons above.
  - Loading every match automatically. The operator rejected this in
    Clarify.

## R7. An `operator:` condition

- **Decision**: add `operator` to `QUERY_FIELDS`, evaluated as
  `e.operator_id = ?`. The palette's operator pick sets the Timeline text to
  `operator:<id>`. Its host pick sets `"<host>"`, which is quoted and so always
  text.
- **Rationale**: FR-009. The recorded operator id is the identity; names can be
  changed. FTS does not index `operator_id`, so an operator name as text
  matched only by accident of the old substring bag.
- **Alternatives**:
  - Match operator names as text. Rejected: unindexed, and names change.
  - A Timeline-only operator filter. Rejected: a second filter axis.

## R8. One display zone, owned by `lib/time`

- **Decision**:
  - `lib/time` holds the zone: `getDisplayZone`, `setDisplayZone` and
    `useDisplayZone`, `'local' | 'utc'`, stored per machine in `localStorage`
    as `redlog-display-zone`.
  - The first read migrates `redlog-timeline-tz`: `'utc'` stays UTC, and
    anything else becomes Local.
  - `formatTime`, `formatDate` and `formatDateTime` print in the zone, and
    suffix `Z` in UTC.
  - `formatTs` and `TzMode` are removed; their callers use those three: the
    axis ticks, the Timeline, MarkerDetail.
  - The Local/UTC choice moves from the Timeline's ⋯ menu to Settings ▸
    General.
  - A `storage` event keeps the HUD window in step.
- **Rationale**: FR-013, FR-014 and SC-005. Every event time is already printed
  through `lib/time`. The other `toLocaleString` calls format counts, not times.
- **Spec correction**: "a time printed without a date MUST say which zone"
  would have put a marker on every local time. The rule is now the one
  `formatTs` already followed: a UTC time carries `Z`, and a local time is
  unmarked.
- **`formatTs('full')`** printed the locale-ordered date that `lib/time`'s
  header rules out. `formatDateTime` replaces it.
- **Alternatives**:
  - Store it in `config.yaml`. Rejected: it is a viewing preference, and
    exports stay ISO 8601 whatever it is.
  - Keep `formatTs` beside the others. Rejected: two formatters is "the
    dangerous state" `lib/time`'s own header describes.

## R9. One query read-out component

- **Decision**: extract `QueryReadout` from Search's and the Transcript's copies.
  It shows the tokens read as conditions and as text, and the unparsable state.
  The Timeline uses it too.
- **Rationale**: a third copy of one disclosure (Constitution III). The query
  contract's Parsing rule 6 requires every surface to show how it parsed.

## R10. Live rows are admitted by the persistence layer

- **Decision**: every `events:new-batch` batch goes through `events:matchIds`,
  in chunks of ≤1,000, with `excludeHousekeeping`. It asks which new rows the
  filter admits and which of those match the box. This holds whether or not a
  filter is set. Each admitted live row adds one to the total M, so N never
  exceeds M. The Timeline's renderer `isHousekeeping` checks go:
  `HOUSEKEEPING_SQL` is the one rule.
- **Rationale**: one implementation of the filter and of housekeeping
  (Constitution III), and the live-row edge case. Batches are coalesced per
  frame, so the cost is one round trip per frame of new rows.
- **Alternatives**:
  - A client-side mirror of `appendEventFilter`. Rejected.
  - Keeping `isHousekeeping` for the no-filter path. Rejected: it keeps two
    housekeeping rules, synced by hand.

## R11. The Timeline's time-range export

- **Decision**: export selection is unchanged, except that a target subset
  matches every casing (R3). While a shared filter is set, the Timeline's
  contributed export is labelled "Visible time range, filter not applied", and
  it contributes no `count`, since its drawn rows are not what the plan exports
  (FR-016).
- **Rationale**: [SPEC-export-event-selection](../../docs/domain/SPEC-export-event-selection.md)
  exports the whole persisted population in the range. The export menu shows
  the plan resolver's counts, so preview and execute already agree
  (Constitution V). Only the label could be misread.
- **Alternative**: carry the shared filter into `ExportSubset`. Rejected for this
  feature: it changes the export-selection contract and the manifest, which is
  a separate product decision.

## R12. Counts the Timeline states

- **Decision**: `countEvents({ parsed?, filter, cursor?, excludeHousekeeping })`
  sums per-tier `COUNT(*)`. It uses the same `WHERE` builder that
  `executeEventQuery` and `queryEventsPage` use, extracted as
  `buildTierWhere`. The Timeline states:
  - "N of M events" while not everything admitted is drawn
  - with text, the drawn matches and "K earlier matches"
- **Rationale**: FR-003 and FR-004 need a total. One builder means the count and
  the page cannot disagree on a predicate.

## R13. Performance budget and measurement

- **Budget**: on a 100,000-event fixture (50/50 tiers, 200 targets, mixed case),
  each of the following takes under 200 ms:
  - `queryEventsPage` for each filter kind
  - `countEvents`
  - `matchEventIds` for 1,000 ids
  - `executeEventQuery` with a cursor and `limit: 1`
  The first page and total together are SC-006. An end-to-end redraw time is
  not claimed, because nothing measures it.
- **Measure first**: add the NOCASE target indexes (R3) only if the target
  queries miss the budget.
