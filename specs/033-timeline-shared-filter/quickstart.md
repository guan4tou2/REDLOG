# Quickstart: validating the Timeline on the Shared Filter

## Prerequisites

- `npm ci` on the branch. On Windows, unit tests use the Node build of
  better-sqlite3. The e2e journeys need the Electron build; see the repo's
  Windows verification notes.
- A scratch project. Nothing here touches a real engagement's data.

## Automated checks

```bash
npx vitest run test/shared-filter-tier.test.ts test/target-identity-case.test.ts test/event-query-builder.test.ts test/query-operator-condition.test.ts
```

```bash
npx vitest run test/timeline-shared-filter.test.tsx test/timeline-text-query.test.tsx test/display-zone.test.ts test/filter-bar-tier.test.tsx
```

```bash
npx tsc -p tsconfig.check.json && npm run build && npm run verify:specs
```

The file names are the ones tasks.md creates. Each maps to the scenarios below.

## Scenarios

| # | Do | Expect | Covers |
|---|----|--------|--------|
| 1 | Seed 1,000+ events over 3 hours, the newest 200 all `shell`. Set Type `dns` and Time = the oldest hour. | The Timeline draws only those DNS events, including rows older than the first page. "N of M" appears until they are all drawn. | US1, SC-001 |
| 2 | Record `Example.COM` and `example.com` as targets, plus a `host`-only mention. Open the target from Targets. | The chip shows the target. The Timeline count equals the Targets count, both spellings included and the `host`-only row excluded. | US2, SC-002 |
| 3 | Type `10.0.0.5`, then `session:S1`, then `"a phrase"`, then `session:`. | `10.0.0.50` is not lit. The read-out shows condition and text tokens. `session:` reads as unparsable. Non-matches are dimmed, not removed. | US3, SC-003 |
| 4 | Type text whose matches are only older than the drawn range. | "K earlier matches" appears. Clicking it loads back and selects the nearest one. | US3 scenario 5 |
| 5 | Turn on "Chained only" and visit each view. | No logged row anywhere. HTTP History says the condition leaves it nothing. Reopening the project starts at "All tiers". | US4, SC-007 |
| 6 | Pick UTC in Settings ▸ General. | The Timeline, the event detail, Search, the Transcript and the FilterBar time chip print the same `…Z` time for one event. A prior Timeline choice of UTC was kept. | US5, SC-005 |
| 7 | With a filter set, open the export menu on the Timeline. | "Visible time range, filter not applied". The plan preview counts every event in the range. | FR-016 |
| 8 | Simulate a failing query (close the DB under test). | The Timeline shows a failure with retry, never an empty or unfiltered view. | FR-010 |

## Performance check (R13)

With a 100,000-event fixture, time each of these:
- `queryEventsPage` for each filter kind
- `countEvents`
- `matchEventIds` for 1,000 ids
- `executeEventQuery` with a cursor and `limit: 1`

Each must stay under 200 ms. The first page and total for each condition kind
are SC-006. Add the NOCASE target indexes only if the target cases miss.
